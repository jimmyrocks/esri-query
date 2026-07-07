import Database from 'better-sqlite3';
import { existsSync, unlinkSync } from 'fs';
import path from 'path';
import os from 'os';
import { parseS3Url, uploadFileToS3 } from '../helpers/s3.js';
// Safe quoting for SQLite identifiers
function qid(name: string): string { return '"' + String(name ?? '').replace(/"/g, '""') + '"'; }
function rtreeName(table: string, geomCol: string): string { return `rtree_${table}_${geomCol}`; }

import { default as wkx } from 'wkx';
import { EsriFeatureLayerType } from '../helpers/esri-rest-types.js';
import { CliBaseOptionsType, CliGeoJsonOptionsType, CliSqlOptionsType } from '../cli.js';
import Writer from './Writer.js';

type GpkgDatabase = InstanceType<typeof Database>;
type GpkgStatement = ReturnType<GpkgDatabase['prepare']>;
type RunResult = ReturnType<GpkgStatement['run']>;

export type GpkgResumeCheckpoint = {
  lastCompletedOid?: number;
  recordsWritten: number;
  bbox?: [number, number, number, number];
};

const RESUME_TABLE = 'esri_query_resume';

// (Removed unused BatchWriter; batched inserts are handled in onFlushBatch)

export default class GpkgInterface extends Writer {
  db: GpkgDatabase;
  columns: {
    [key: string]: 'NULL' | 'INTEGER' | 'REAL' | 'TEXT' | 'BLOB' | 'GEOMETRY'
  };
  _commandBacklog: Array<{
    cmd: string,
    params: Array<string | number>
  }> = [];
  geometryColumnName: string = 'the_geom'; //TODO option
  targetSrid: number = 4326; // We export in EPSG:4326 only; metadata should match outSR
  declare options: CliBaseOptionsType & CliSqlOptionsType;
  private s3Target: { bucket: string; key: string } | null = null;
  private dbPath: string; // actual local path for SQLite
  private hasGeometry: boolean = true;
  // Resume support: when --resume-state is set, a single-row checkpoint table is
  // updated inside the same transaction as each batch insert, so the checkpoint
  // can never disagree with the data on disk.
  private resumeEnabled: boolean = false;
  private resumeAppend: boolean = false;
  private resumeOidField?: string;
  private checkpointRecords: number = 0;
  private lastCompletedOid?: number;

  constructor(options: CliBaseOptionsType & (CliSqlOptionsType | CliGeoJsonOptionsType), sourceInfo: EsriFeatureLayerType & { totalFeatureCount?: number }) {
    super(options, sourceInfo);
    // GPKG does not emit text framing; let the base class skip GeoJSON/NDJSON framing
    this.setEmissionMode('none');
    // Default to safe batched inserts; can be overridden by CLI options
    const opt: any = this.options || {};
    this.enableDebouncedBatching({
      debounceMs: Math.max(0, Number(opt.batchDebounceMs ?? 0)),
      maxBatch: Math.max(1, Number(opt.batchMax ?? 5000)),
      maxBufferBytes: Math.max(1024, Number(opt.batchMaxBytes ?? (8 << 20))),
    });
    if (!this.options.output) throw new Error('Output filename required for GPKG format.');
    if (!this.options['layer-name']) {
      // If no layer-name comes in, pull it from the filename
      this.options['layer-name'] = path.basename(this.options.output, path.extname(this.options.output));
    }
    this.setSourceInfo(sourceInfo);
    this.hasGeometry = Boolean((this.sourceInfo as any)?.geometryType && (this.sourceInfo as any)?.geometryType !== 'esriGeometryNull');
    // Ensure our declared target SRID matches the query outSR; we only support 4326 in GPKG
    this.targetSrid = 4326;

    // Resume support flags (set by the reader when --resume-state is active)
    this.resumeEnabled = Boolean((options as any)['resume-state']);
    this.resumeAppend = Boolean((options as any)['gpkg-resume-append']);
    this.resumeOidField = (options as any)['resume-oid-field'] ?? (sourceInfo as any)?.objectIdFieldName;

    // Determine whether we target S3
    const s3 = parseS3Url(this.options.output);
    if (s3) {
      if (this.resumeEnabled) {
        throw new Error('--resume-state does not support s3:// GPKG outputs; write to a local file and upload separately.');
      }
      this.s3Target = { bucket: s3.bucket, key: s3.key || `${this.options['layer-name']}.gpkg` };
      const tmp = path.join(os.tmpdir(), `esri-query-${Date.now()}-${Math.random().toString(36).slice(2,8)}.gpkg`);
      this.dbPath = tmp;
    } else {
      this.dbPath = this.options.output;
      if (this.resumeAppend) {
        if (!existsSync(this.dbPath)) {
          throw new Error(`Cannot resume: GPKG output is missing: ${this.dbPath}`);
        }
      } else {
        // Overwrite handling for local path
        try {
          if (existsSync(this.dbPath)) {
            if ((options as any).overwrite) {
              try { unlinkSync(this.dbPath); } catch {}
            } else {
              throw new Error(`Output already exists: ${this.dbPath}. Use --overwrite to replace it.`);
            }
          }
        } catch {}
      }
    }

    if (this.resumeAppend) {
      // Reopen the existing database instead of initializing a new GeoPackage
      this.db = new Database(this.dbPath);
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('foreign_keys = ON');
    } else {
      // Create the database
      this.db = GpkgInterface.createGpkg(this.dbPath);
    }
    // Tune for bulk ingest
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('cache_size = -16000'); // ~16MB
    this.db.pragma('temp_store = MEMORY');
    this.db.pragma('locking_mode = EXCLUSIVE');

    if (this.resumeAppend) {
      this.loadExistingLayerColumns(this.options['layer-name']);
    } else {
      this.addLayer(this.options['layer-name'], this.columns);
    }

    if (this.resumeEnabled) {
      this.initResumeCheckpoint();
    }
  }

  /**
   * On resume, the table on disk is the authority for which columns exist
   * (later batches may have added columns the source schema did not declare).
   */
  private loadExistingLayerColumns(layerName: string): void {
    const hasTable = this.db.prepare(`SELECT count(*) AS c FROM sqlite_master WHERE type='table' AND name=?`).get(layerName) as { c: number };
    if (!hasTable || hasTable.c !== 1) {
      throw new Error(`Cannot resume: layer table "${layerName}" not found in ${this.dbPath}`);
    }
    const info = this.db.prepare(`PRAGMA table_info(${qid(layerName)})`).all() as Array<{ name: string; type: string }>;
    const columns: GpkgInterface['columns'] = {};
    for (const col of info) {
      if (col.name === this.geometryColumnName) continue;
      const declared = String(col.type || '').toUpperCase();
      columns[col.name] = (['NULL', 'INTEGER', 'REAL', 'TEXT', 'BLOB'].includes(declared) ? declared : 'TEXT') as GpkgInterface['columns'][string];
    }
    this.columns = columns;
  }

  /**
   * Creates the checkpoint table if needed and rehydrates cumulative counters
   * and the running bbox from a previous run.
   */
  private initResumeCheckpoint(): void {
    this.db.prepare(`CREATE TABLE IF NOT EXISTS ${qid(RESUME_TABLE)} (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_completed_oid INTEGER,
      records_written INTEGER NOT NULL DEFAULT 0,
      min_x DOUBLE, min_y DOUBLE, max_x DOUBLE, max_y DOUBLE,
      updated_at TEXT NOT NULL
    )`).run();
    this.db.prepare(`INSERT OR IGNORE INTO ${qid(RESUME_TABLE)} (id, records_written, updated_at) VALUES (1, 0, ?)`).run(new Date().toISOString());

    if (this.resumeAppend) {
      const row = this.db.prepare(`SELECT last_completed_oid, records_written, min_x, min_y, max_x, max_y FROM ${qid(RESUME_TABLE)} WHERE id = 1`).get() as any;
      if (row) {
        this.checkpointRecords = Math.max(0, Number(row.records_written ?? 0));
        this.lastCompletedOid = Number.isFinite(Number(row.last_completed_oid)) ? Number(row.last_completed_oid) : undefined;
        this.status.records = this.checkpointRecords;
        const bbox = [row.min_x, row.min_y, row.max_x, row.max_y].map(Number);
        if (bbox.every(Number.isFinite)) {
          this.status.bbox = bbox as [number, number, number, number];
        }
      }
    }
  }

  /** Last durably committed checkpoint (updated transactionally with each batch). */
  getResumeCheckpoint(): GpkgResumeCheckpoint {
    return { lastCompletedOid: this.lastCompletedOid, recordsWritten: this.checkpointRecords };
  }

  /**
   * Reads the checkpoint from an existing GPKG without holding the file open.
   * Returns undefined when the file or checkpoint table does not exist.
   */
  static readResumeCheckpoint(dbPath: string): GpkgResumeCheckpoint | undefined {
    if (!existsSync(dbPath)) return undefined;
    let db: GpkgDatabase | undefined;
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true });
      const hasTable = db.prepare(`SELECT count(*) AS c FROM sqlite_master WHERE type='table' AND name=?`).get(RESUME_TABLE) as { c: number };
      if (!hasTable || hasTable.c !== 1) return undefined;
      const row = db.prepare(`SELECT last_completed_oid, records_written, min_x, min_y, max_x, max_y FROM ${qid(RESUME_TABLE)} WHERE id = 1`).get() as any;
      if (!row) return undefined;
      const bbox = [row.min_x, row.min_y, row.max_x, row.max_y].map(Number);
      return {
        lastCompletedOid: Number.isFinite(Number(row.last_completed_oid)) ? Number(row.last_completed_oid) : undefined,
        recordsWritten: Math.max(0, Number(row.records_written ?? 0)),
        bbox: bbox.every(Number.isFinite) ? bbox as [number, number, number, number] : undefined,
      };
    } finally {
      try { db?.close(); } catch {}
    }
  }

  private findBatchMaxOid(features: GeoJSON.Feature[]): number | undefined {
    const oidField = this.resumeOidField;
    if (!oidField) return undefined;
    let maxOid: number | undefined;
    for (const feat of features) {
      const props = (feat.properties ?? {}) as Record<string, unknown>;
      let raw = props[oidField];
      if (raw == null) {
        const key = Object.keys(props).find(k => k.toLowerCase() === oidField.toLowerCase());
        if (key) raw = props[key];
      }
      const oid = Number(raw);
      if (!Number.isFinite(oid)) continue;
      maxOid = maxOid == null ? oid : Math.max(maxOid, oid);
    }
    return maxOid;
  }

  async open(): Promise<void> {
    // DB is already created and layer initialized in the constructor.
    await this.onOpen();
  }

  protected async sinkWrite(_payload: string): Promise<void> {
    // No string sink for GPKG; inserts happen in onFlushBatch()
  }

  static createGpkg(outputFilename: string): GpkgDatabase {
    const db = new Database(outputFilename);
    db.pragma('page_size = 4096');
    db.pragma('journal_mode = WAL');
    const cmds = initializeGeoPackageCommands.split(';').filter(v => v.trim().length > 0).map(v => v + ';');
    db.transaction((cmds: string[]) =>
      cmds.map(cmd => db.prepare(cmd).run())
    )(cmds);
    db.pragma('foreign_keys = ON');
    return db;
  }

  async writeFeature(feature: GeoJSON.Feature): Promise<GeoJSON.Feature> {
    // Let the base class validate, count, and compute per-feature bbox
    let geojson: GeoJSON.Feature;
    try {
      geojson = await super.writeFeature(feature);
    } catch (e: any) {
      if (e && e.code === 'SKIP_FEATURE') {
        this.status.skipped += 1;
        return feature; // skip emitting
      }
      throw e;
    }

    // Queue for batched insert handled by onFlushBatch()
    await this.emitFeature(geojson);
    return geojson;
  }

  protected async onFlushBatch(features: GeoJSON.Feature[]): Promise<void> {
    if (!features.length) return;

    const layer = this.options['layer-name'];
    const geomCol = this.geometryColumnName;
    const hasGeometry = this.hasGeometry;

    // Union columns across batch to minimize DDL/prepare overhead
    const unionCols = new Set<string>();
    for (const feat of features) {
      const props = (feat.properties || {}) as Record<string, any>;
      for (const k of Object.keys(props)) unionCols.add(k);
    }

    // Ensure columns exist once for this union
    for (const col of unionCols) {
      if (!this.columns[col]) {
        this.columns[col] = 'TEXT';
        this.addColumn(layer, col, this.columns[col]);
      }
    }

    const colList = Array.from(unionCols);
    const insertColumns: string[] = [...colList];
    if (hasGeometry) insertColumns.push(geomCol);
    const placeholders = insertColumns.map(() => '?').join(',');
    const insertSQL = `INSERT INTO ${qid(layer)} (${insertColumns.map(c => qid(c)).join(', ')}) VALUES (${placeholders})`;
    const insertStmt = this.db.prepare(insertSQL);
    const rtreeSQL = hasGeometry ? `INSERT OR REPLACE INTO ${qid(rtreeName(layer, geomCol))} (id, minx, maxx, miny, maxy) VALUES ((SELECT last_insert_rowid()), ?, ?, ?, ?)` : null;
    const rtreeStmt = rtreeSQL ? this.db.prepare(rtreeSQL) : null;

    // Compute the checkpoint values this flush will commit. Instance fields are
    // only advanced after the transaction succeeds, so a failed flush leaves the
    // in-memory checkpoint aligned with the database.
    const batchMaxOid = this.resumeEnabled ? this.findBatchMaxOid(features) : undefined;
    const nextRecords = this.checkpointRecords + features.length;
    const nextOid = batchMaxOid != null && (this.lastCompletedOid == null || batchMaxOid > this.lastCompletedOid)
      ? batchMaxOid
      : this.lastCompletedOid;
    const checkpointStmt = this.resumeEnabled
      ? this.db.prepare(`UPDATE ${qid(RESUME_TABLE)} SET last_completed_oid = ?, records_written = ?, min_x = ?, min_y = ?, max_x = ?, max_y = ?, updated_at = ? WHERE id = 1`)
      : null;

    // Execute in a single transaction
    const trx = this.db.transaction((batch: GeoJSON.Feature[]) => {
      for (const feat of batch) {
        const props = (feat.properties || {}) as Record<string, any>;
        const rowVals: Array<string | number | Buffer | null> = [];
        for (const c of colList) {
          const v = (props as any)[c];
          rowVals.push(v == null ? null : (typeof v === 'object' ? JSON.stringify(v) : v));
        }
        let geometryBlob: Buffer | null = null;
        if (hasGeometry) {
          geometryBlob = this._geojsonToGpkg(feat);
          rowVals.push(geometryBlob.length ? geometryBlob : null);
        }
        insertStmt.run(rowVals as any);

        if (hasGeometry && feat.bbox && geometryBlob && geometryBlob.length && rtreeStmt) {
          const [minX, minY, maxX, maxY] = feat.bbox as [number, number, number, number];
          rtreeStmt.run(minX, maxX, minY, maxY);
        }
      }
      if (checkpointStmt) {
        const [minX, minY, maxX, maxY] = this.status.bbox;
        checkpointStmt.run(
          nextOid ?? null,
          nextRecords,
          Number.isFinite(minX) ? minX : null,
          Number.isFinite(minY) ? minY : null,
          Number.isFinite(maxX) ? maxX : null,
          Number.isFinite(maxY) ? maxY : null,
          new Date().toISOString(),
        );
      }
    });

    trx(features);

    this.checkpointRecords = nextRecords;
    if (nextOid != null) this.lastCompletedOid = nextOid;
  }

  async save(): Promise<void> {
    await super.save();
  }

  async close(): Promise<void> {
    // Ensure any remaining batched inserts are flushed by base onClose()
    try {
      // Update feature count and contents bbox before closing
      const { records, bbox } = this.getSummary();
      const layer = this.options['layer-name'];

      const trx = this.db.transaction(() => {
        this.db.prepare(`UPDATE gpkg_ogr_contents SET feature_count = ? WHERE table_name = ?`).run(records, layer);
        if (this.hasGeometry) {
          const [minX, minY, maxX, maxY] = bbox;
          if (isFinite(minX) && isFinite(minY) && isFinite(maxX) && isFinite(maxY)) {
            this.db.prepare(`UPDATE gpkg_contents SET min_x = ?, min_y = ?, max_x = ?, max_y = ? WHERE table_name = ?`).run(minX, minY, maxX, maxY, layer);
          }
        } else {
          this.db.prepare(`UPDATE gpkg_contents SET min_x = NULL, min_y = NULL, max_x = NULL, max_y = NULL, srs_id = NULL WHERE table_name = ?`).run(layer);
        }
      });
      trx();
    } catch {}

    await this.onClose();
    this.db.close();

    // If S3 target, upload and clean up temp
    if (this.s3Target) {
      try {
        const p = (this.s3Target && parseS3Url(`s3://${this.s3Target.bucket}/${this.s3Target.key}`)?.params) || {};
        await uploadFileToS3({
          bucket: this.s3Target.bucket,
          key: this.s3Target.key,
          filePath: this.dbPath,
          contentType: 'application/geopackage+sqlite3',
          acl: (this.options as any)['s3-acl'] ?? (p as any).acl,
          storageClass: (this.options as any)['s3-storage-class'] ?? (p as any).storageClass,
          sse: (this.options as any)['s3-sse'] ?? (p as any).sse,
          ssekmsKeyId: (this.options as any)['s3-ssekms-key-id'] ?? (p as any).ssekmsKeyId ?? (p as any).sseKmsKeyId ?? (p as any).kmsKeyId,
        });
        if ((this.options as any).progress) {
          process.stderr.write(`[s3] Uploaded GeoPackage to s3://${this.s3Target.bucket}/${this.s3Target.key}\n`);
        }
      } catch (e: any) {
        throw new Error(`GPKG: S3 upload failed to s3://${this.s3Target.bucket}/${this.s3Target.key}: ${e?.message || e}`);
      } finally {
        try { unlinkSync(this.dbPath); } catch {}
      }
    }
  }

  setSourceInfo(sourceInfo: EsriFeatureLayerType) {
    this.sourceInfo = sourceInfo;
    // Convert these fields to columns
    // 'NULL' | 'INTEGER' | 'REAL' | 'TEXT' | 'BLOB'
      const typesToSqlite = {
        esriFieldTypeInteger: 'INTEGER',
        esriFieldTypeSmallInteger: 'INTEGER',
        esriFieldTypeDouble: 'REAL',
        esriFieldTypeSingle: 'REAL',
        esriFieldTypeString: 'TEXT',
        esriFieldTypeDate: 'TEXT',
        esriFieldTypeGeometry: 'TEXT',
        esriFieldTypeOID: 'TEXT',
        esriFieldTypeBlob: 'BLOB',
        esriFieldTypeGlobalID: 'TEXT',
        esriFieldTypeRaster: 'TEXT',
        esriFieldTypeGUID: 'TEXT',
        esriFieldTypeXML: 'TEXT'
      }

    this.columns = sourceInfo.fields
      .filter(field => field.type !== 'esriFieldTypeGeometry') // Filter out the geometry field
      .map(field => (
        {
          name: field.name,
          type: typesToSqlite[field.type]
        }
      )).reduce((a, c) => ({ ...a, ...{ [c.name]: c.type } }), {});
  };

  addColumn(layerName: string, columnName: string, columnType: 'NULL' | 'INTEGER' | 'REAL' | 'TEXT' | 'BLOB' | 'GEOMETRY'): RunResult {
    return this.db.prepare(`ALTER TABLE ${qid(layerName)} ADD ${qid(columnName)} ${columnType}`).run();
  };

  addLayer(layerName: string, columns: { [key: string]: 'NULL' | 'INTEGER' | 'REAL' | 'TEXT' | 'BLOB' | 'GEOMETRY' }): RunResult[] {
    const { name: sourceName, description: sourceDescription, geometryType, totalFeatureCount, drawingInfo } = this.sourceInfo;
    const srid = this.targetSrid; // force 4326 in GPKG metadata
    const geometryColumnName = this.geometryColumnName;
    const hasGeometry = this.hasGeometry;
    const sourceDrawingInfo = drawingInfo ? JSON.stringify(drawingInfo) : '{}';

    const commands: Array<{ cmd: string, params: Array<string | number> | { [key: string]: string | number } }> = [];

    // SRID sanity check
    try {
      const row = this.db.prepare('SELECT 1 FROM gpkg_spatial_ref_sys WHERE srs_id = ?').get(srid);
      if (!row) console.warn(`[gpkg] SRID ${srid} not present in gpkg_spatial_ref_sys (expected 4326).`);
    } catch {}

    //GPKG Layer Statement
    const gpkgContents = {
      cmd: `INSERT INTO "gpkg_contents" (
        table_name,
        data_type,
        identifier,
        description,
        min_x,
        min_y,
        max_x,
        max_y,
        srs_id
      ) VALUES (@tableName, @dataType, @identifier, @description, @minX, @minY, @maxX, @maxY, @srsId);`,
      params: {
        tableName: layerName,
        dataType: hasGeometry ? 'features' : 'attributes',
        identifier: sourceName,
        description: sourceDescription,
        minX: hasGeometry ? -180 : null,
        minY: hasGeometry ? -90 : null,
        maxX: hasGeometry ? 180 : null,
        maxY: hasGeometry ? 90 : null,
        srsId: hasGeometry ? srid : null
      }
    };
    commands.push(gpkgContents);

    const gpkgOgrContents = {
      cmd: `INSERT INTO "gpkg_ogr_contents" (
        table_name,
        feature_count
        ) VALUES (@tableName, @totalFeatureCount);
        `,
      params: { tableName: layerName, totalFeatureCount }
    };
    commands.push(gpkgOgrContents);

    // Create the table for the new dataset
    const tableColumns = hasGeometry ? { ...columns, [geometryColumnName]: 'BLOB' } : columns;
    const createColumns = Object.entries(tableColumns)
      .map(([name, type]) => `${qid(name)} ${type}`)
      .join(', ');
    const createDatasetTable = { 'cmd': `CREATE TABLE ${qid(layerName)} (${createColumns})`, params: {} };
    commands.push(createDatasetTable);

    // Create RTREE for fast spatial search and register extension
    if (hasGeometry) {
      const rtreeTbl = rtreeName(layerName, geometryColumnName);
      commands.push({ cmd: `CREATE VIRTUAL TABLE IF NOT EXISTS ${qid(rtreeTbl)} USING rtree(id, minx, maxx, miny, maxy);`, params: {} });
      commands.push({ cmd: `INSERT OR IGNORE INTO gpkg_extensions (table_name, column_name, extension_name, definition, scope) VALUES (?, ?, 'gpkg_rtree_index', 'http://www.geopackage.org/spec/#extension_rtree', 'read-write');`, params: [layerName, geometryColumnName] });
    }

    // Set up the geometry columns // TODO elsewhere
    if (hasGeometry) {
      const geometryTypeLookup = {
        esriGeometryPoint: 'POINT',
        esriGeometryMultipoint: 'MULTIPOINT',
        esriGeometryPolyline: 'MULTILINESTRING',
        esriGeometryPolygon: 'MULTIPOLYGON',
        esriGeometryEnvelope: 'GEOMETRY'
      };
      const gpkgGeometryColumns = {
        cmd: 'INSERT INTO "gpkg_geometry_columns" (table_name, column_name, geometry_type_name, srs_id, z, m) VALUES (?,?,?,?,?,?);',
        params: [layerName, geometryColumnName, geometryTypeLookup[geometryType], srid, 0, 0]
      };
      commands.push(gpkgGeometryColumns);

      // Add the style in
      const layerStyles = {
        cmd: 'INSERT INTO "layer_styles" (id, useAsDefault, f_table_name, f_geometry_column, styleName, description, styleESRI, styleMapBox) VALUES (1,1,?,?,?,?,?,?);',
        params: [
          layerName, geometryColumnName, sourceName, sourceDescription, sourceDrawingInfo, null
        ]
      };
      commands.push(layerStyles);
    }

    const results: RunResult[] = [];
    const txn = this.db.transaction(() => {
      for (const { cmd, params } of commands) {
        try {
          const stmt = this.db.prepare(cmd);
          const res = stmt.run(params as any);
          results.push(res);
        } catch (err: any) {
          console.error('[gpkg] SQL failed:', cmd.trim().slice(0, 200) + (cmd.length > 200 ? '…' : ''));
          console.error('[gpkg] params:', params);
          try {
            const fk = this.db.pragma('foreign_key_check', { simple: false }) as any[];
            if (Array.isArray(fk) && fk.length) console.error('[gpkg] foreign_key_check:', fk);
          } catch {}
          throw err;
        }
      }
    });
    txn();
    return results;
  }

  /**
  *  Converts a GeoJSON feature into a GeoPackage binary format buffer.
  *  @param feature - The GeoJSON feature to convert.
  *  @returns A buffer containing the GeoPackage binary format representation of the feature.
  */
  _geojsonToGpkg(feature: GeoJSON.Feature): Buffer {
    //https://www.geopackage.org/spec/#gpb_format
    /**
     * GeoPackageBinaryHeader {
     *   byte[2] magic = 0x4750; //'GP' in ASCII
     *   byte version; // 8-bit unsigned integer, 0 = version 1
     *   byte flags; //  	see bit layout of GeoPackageBinary flags byte (https://www.geopackage.org/spec/#flags_layout)
     *   int32 srs_id; //  	the SRS ID, with the endianness specified by the byte order flag
     *   double[] envelope; // see envelope contents indicator code below, with the endianness specified by the byte order flag
     * }
     * 
     * 
     * StandardGeoPackageBinary {
     *   GeoPackageBinaryHeader header; // The header above
     *   WKBGeometry geometry; // 
     * }
     */

    // SRID
    const srid = this.targetSrid; // always write EPSG:4326 in GPKG header

    // Create the well known binary version of the GeoJSON Feature Geometry
    let geom: wkx.Geometry | null = null;
    try {
      if (feature.geometry) {
        geom = wkx.Geometry.parseGeoJSON(feature.geometry);
        const expected = (this.sourceInfo as any)?.geometryType as string | undefined;
        if (expected) {
          const name = geom.constructor.name;
          if (expected.includes('Polygon') && name === 'Polygon') geom = new wkx.MultiPolygon([geom as wkx.Polygon]);
          if (expected.includes('Polyline') && name === 'LineString') geom = new wkx.MultiLineString([geom as wkx.LineString]);
          if (expected.includes('Multipoint') && name === 'Point') geom = new wkx.MultiPoint([geom as wkx.Point]);
        }
      }
    } catch (e) {
      console.error('Error parsing geometry; writing NULL geometry');
      geom = null;
    }

    // Header Buffer
    /////////////////////////////////////////
    const headerBuffer = Buffer.alloc(8);
    headerBuffer.writeUInt16BE(0x4750, 0); //'GP' in ASCII
    headerBuffer.writeUInt8(0, 2);

    // Generate the flags and envelope
    let flags = 0;
    flags |= 1; // little endian
    const hasXYEnvelope = Array.isArray(feature.bbox) && feature.bbox.length === 4;
    if (hasXYEnvelope) flags |= (1 << 1); // envelope indicator = 1 (XY)
    headerBuffer.writeUInt8(flags, 3);

    // SRID
    headerBuffer.writeUInt32LE(Number(srid) || 4326, 4);

    // Envelope (XY): [minX, minY, maxX, maxY]
    const envelopeBuffer = hasXYEnvelope ? Buffer.alloc(32) : Buffer.alloc(0);
    if (hasXYEnvelope) {
      const [minX, minY, maxX, maxY] = feature.bbox as [number, number, number, number];
      envelopeBuffer.writeDoubleLE(minX, 0);
      envelopeBuffer.writeDoubleLE(minY, 8);
      envelopeBuffer.writeDoubleLE(maxX, 16);
      envelopeBuffer.writeDoubleLE(maxY, 24);
    }

    if (!geom) {
      // No geometry
      return Buffer.alloc(0);
    }
    const standardGeoPackageBinary = [headerBuffer, envelopeBuffer, geom.toWkb()];
    return Buffer.concat(standardGeoPackageBinary);
  };

};
// These are taken from the empty geopackage template
// http://www.geopackage.org/data/empty.gpkg

// I added some fields to the layer_styles, they _may_ cause issues
// https://gis.stackexchange.com/questions/341720/write-layer-style-qml-as-predefined-within-a-gpkg-using-r
const initializeGeoPackageCommands = `
    PRAGMA foreign_keys = OFF;
    PRAGMA application_id = 1196444487;
    PRAGMA user_version = 10200;
    CREATE TABLE gpkg_spatial_ref_sys(srs_name TEXT NOT NULL, srs_id INTEGER NOT NULL PRIMARY KEY, organization TEXT NOT NULL, organization_coordsys_id INTEGER NOT NULL, definition  TEXT NOT NULL, description TEXT);
    INSERT INTO gpkg_spatial_ref_sys VALUES('Undefined cartesian SRS', -1, 'NONE', -1, 'undefined', 'undefined cartesian coordinate reference system');
    INSERT INTO gpkg_spatial_ref_sys VALUES('Undefined geographic SRS', 0, 'NONE', 0, 'undefined', 'undefined geographic coordinate reference system');
    INSERT INTO gpkg_spatial_ref_sys VALUES('WGS 84 geodetic', 4326, 'EPSG', 4326, 'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563,AUTHORITY["EPSG","7030"]],AUTHORITY["EPSG","6326"]],PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]],AUTHORITY["EPSG","4326"]]', 'longitude/latitude coordinates in decimal degrees on the WGS 84 spheroid');
    CREATE TABLE gpkg_contents(
        table_name TEXT NOT NULL PRIMARY KEY,
        data_type TEXT NOT NULL,
        identifier TEXT UNIQUE,
        description TEXT DEFAULT '',
        last_change DATETIME NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        min_x DOUBLE,
        min_y DOUBLE,
        max_x DOUBLE,
        max_y DOUBLE,
        srs_id INTEGER,
        CONSTRAINT fk_gc_r_srs_id FOREIGN KEY(srs_id) REFERENCES gpkg_spatial_ref_sys(srs_id)
    );
    CREATE TABLE gpkg_ogr_contents (table_name text, feature_count int);
    CREATE TABLE gpkg_geometry_columns(table_name TEXT NOT NULL, column_name TEXT NOT NULL, geometry_type_name TEXT NOT NULL, srs_id INTEGER NOT NULL, z TINYINT NOT NULL, m TINYINT NOT NULL, CONSTRAINT pk_geom_cols PRIMARY KEY(table_name, column_name), CONSTRAINT fk_gc_tn FOREIGN KEY(table_name) REFERENCES gpkg_contents(table_name), CONSTRAINT fk_gc_srs FOREIGN KEY(srs_id) REFERENCES gpkg_spatial_ref_sys(srs_id));
    CREATE TABLE gpkg_tile_matrix_set(table_name TEXT NOT NULL PRIMARY KEY, srs_id INTEGER NOT NULL, min_x DOUBLE NOT NULL, min_y DOUBLE NOT NULL, max_x DOUBLE NOT NULL, max_y DOUBLE NOT NULL, CONSTRAINT fk_gtms_table_name FOREIGN KEY(table_name) REFERENCES gpkg_contents(table_name), CONSTRAINT fk_gtms_srs FOREIGN KEY(srs_id) REFERENCES gpkg_spatial_ref_sys(srs_id));
    CREATE TABLE gpkg_tile_matrix(table_name TEXT NOT NULL, zoom_level INTEGER NOT NULL, matrix_width INTEGER NOT NULL, matrix_height INTEGER NOT NULL, tile_width INTEGER NOT NULL, tile_height INTEGER NOT NULL, pixel_x_size DOUBLE NOT NULL, pixel_y_size DOUBLE NOT NULL, CONSTRAINT pk_ttm PRIMARY KEY(table_name, zoom_level), CONSTRAINT fk_tmm_table_name FOREIGN KEY(table_name) REFERENCES gpkg_contents(table_name));
    CREATE TABLE gpkg_extensions(table_name TEXT, column_name TEXT, extension_name TEXT NOT NULL, definition TEXT NOT NULL, scope TEXT NOT NULL, CONSTRAINT ge_tce UNIQUE(table_name, column_name, extension_name));
    CREATE TABLE layer_styles (
      id INTEGER NOT NULL PRIMARY KEY,
      f_table_catalog TEXT(256),
      f_table_schema TEXT(256),
      f_table_name TEXT(256),
      f_geometry_column TEXT(256),
      styleName TEXT(30),
      styleQML TEXT,
      styleSLD TEXT,
      styleMapbox TEXT,
      styleESRI TEXT,
      originalStyle TEXT,
      useAsDefault BOOLEAN,
      description TEXT,
      owner TEXT(30),
      ui TEXT(30),
      update_time DATETIME NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
`;
