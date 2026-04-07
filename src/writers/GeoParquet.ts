import Writer from './Writer.js';
import * as wkx from 'wkx';
import { ParquetWriter, ParquetSchema } from '@dsnp/parquetjs';
import { createWriteStream, existsSync } from 'fs';
import { dirname, extname } from 'path';
import { mkdir } from 'fs/promises';
import type { Feature, Geometry } from 'geojson';
import type { CliOptionsType } from '../cli.js';
import { parseS3Url, startS3UploadStream } from '../helpers/s3.js';

/**
 * GeoParquet writer: streams rows to a Parquet file with GeoParquet metadata.
 * - Geometry stored as WKB in a `geometry` column (EPSG:4326 assumed).
 * - Properties flattened into primitive columns based on the first feature.
 * - Extra properties (not in the first feature) are serialized into a
 *   `properties` JSON column so we don't lose data once the schema is fixed.
 * - Uses base Writer's debounced batching; tune via options:
 *   parquetBatchSize, parquetDebounceMs, parquetMaxBufferBytes, parquetCompression.
 */
export default class GeoParquet extends Writer {
    private outputPath!: string;
    private schema?: ParquetSchema;
    private writer?: ParquetWriter;
    private initialized = false;
    private closed = false;
    private _s3Done: Promise<any> | null = null;
    private _s3Url: string | null = null;

    // knobs (fed from CLI via options)
    private parquetBatchSize = 10_000;               // maps to Writer's debounced batching maxBatch
    private parquetDebounceMs = 100;                 // maps to Writer's debounceMs
    private parquetMaxBufferBytes = 32 << 20;        // safety cap for queued features, ~32MB
    private schemaLookaheadRows = 1000;              // inspect up to N rows for better type inference
    public onInvalid: 'throw' | 'skip' | 'keep' = 'throw';
    private parquetCompression: 'SNAPPY' | 'GZIP' | 'UNCOMPRESSED' = 'SNAPPY';
    // bbox only (no tile-based coverings)
    private geoMetaBase: any | null = null;
    private geomTypesSeen: Set<string> = new Set();
    private geometryColumnName = 'geometry';
    private bboxIncludeZ = false;
    private _overflowColumnsWarned: Set<string> = new Set();

    constructor(options: CliOptionsType, sourceInfo?: any) {
        super(options, sourceInfo);
        if (!options.output) throw new Error('Output path is required for GeoParquet');
        this.outputPath = options.output;

        // Optional knobs from CLI/config
        const opt: any = options;
        if (typeof opt.parquetBatchSize === 'number' && opt.parquetBatchSize > 0) this.parquetBatchSize = opt.parquetBatchSize;
        if (typeof opt.parquetDebounceMs === 'number' && opt.parquetDebounceMs >= 0) this.parquetDebounceMs = opt.parquetDebounceMs;
        if (typeof opt.parquetMaxBufferBytes === 'number' && opt.parquetMaxBufferBytes > 0) this.parquetMaxBufferBytes = opt.parquetMaxBufferBytes;
        const onInvalid = typeof opt.onInvalid === 'string' ? opt.onInvalid : opt['on-invalid'];
        if (onInvalid === 'throw' || onInvalid === 'keep' || onInvalid === 'skip') this.onInvalid = onInvalid;
        if (typeof opt.parquetCompression === 'string' && ['SNAPPY','GZIP','UNCOMPRESSED'].includes(opt.parquetCompression)) {
          this.parquetCompression = opt.parquetCompression;
        }
        if (typeof opt.parquetScanRows === 'number' && opt.parquetScanRows > 0) this.schemaLookaheadRows = opt.parquetScanRows;
        if (typeof opt['geometry-column-name'] === 'string' && opt['geometry-column-name'].trim()) {
          const name = opt['geometry-column-name'].trim();
          if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) this.geometryColumnName = name;
        }
        // No quadkeys/H3 options

        // Enforce extension sanity (won't block, just warn)
        if (extname(this.outputPath).toLowerCase() !== '.parquet') {
            console.warn(`[warn] GeoParquet output usually uses .parquet (got ${this.outputPath}).`);
        }
    }

    protected async sinkWrite(_payload: string): Promise<void> {
      // GeoParquet writes binary Parquet rows, not line-delimited text.
      // This is a no-op to satisfy the base Writer contract.
      return;
    }

    async open(): Promise<void> {
        if (this.initialized) return;
        await mkdir(dirname(this.outputPath), { recursive: true });
        if (existsSync(this.outputPath) && !(this.options as any).overwrite) {
          throw new Error(`Output already exists: ${this.outputPath}. Use --overwrite to replace it.`);
        }
        await this.onOpen();

        // Enable base-class debounced batching (no-op if writer subclasses still write per-feature)
        this.enableDebouncedBatching({
          debounceMs: this.parquetDebounceMs,
          maxBatch: this.parquetBatchSize,
          maxBufferBytes: this.parquetMaxBufferBytes,
        });

        this.initialized = true;
    }

    /** Infer a Parquet schema from a sample of features' properties. */
    private buildSchemaFromSample(sample: Feature[]): ParquetSchema {
        const fields: Record<string, any> = {};

        const isIsoDate = (s: string) => {
          if (!s || typeof s !== 'string' || s.length < 8) return false;
          const t = Date.parse(s);
          return Number.isFinite(t);
        };
        const isEpochMs = (n: number) => Number.isFinite(n) && Math.abs(n) > 10_000_000_000;

        const cols: Record<string, { num: number; int: number; dbl: number; bool: number; str: number; iso: number; epoch: number; obj: number; arr: number; nulls: number }>
          = {} as any;

        for (const f of sample) {
          const props = (f.properties || {}) as Record<string, any>;
          for (const [k, v] of Object.entries(props)) {
            cols[k] = cols[k] || { num:0,int:0,dbl:0,bool:0,str:0,iso:0,epoch:0,obj:0,arr:0,nulls:0 };
            if (v === null || v === undefined) { cols[k].nulls++; continue; }
            if (typeof v === 'number') { cols[k].num++; (Number.isInteger(v) ? cols[k].int++ : cols[k].dbl++); if (isEpochMs(v)) cols[k].epoch++; continue; }
            if (typeof v === 'boolean') { cols[k].bool++; continue; }
            if (typeof v === 'string') { cols[k].str++; if (isIsoDate(v)) cols[k].iso++; continue; }
            if (Array.isArray(v)) { cols[k].arr++; continue; }
            if (typeof v === 'object') { cols[k].obj++; continue; }
          }
        }

        // Geometry column (dynamic name)
        fields[this.geometryColumnName] = { type: 'BYTE_ARRAY', optional: true };

        const disableBbox = Boolean((this.options as any)['no-bbox']);

        // Detect Z in sample if present; allow forcing via --bbox-3d
        const hasZInSample = (() => {
          for (const f of sample) {
            const g: any = f?.geometry as any;
            if (!g || g.coordinates == null) continue;
            const stack: any[] = [g.coordinates];
            while (stack.length) {
              const node = stack.pop();
              if (!Array.isArray(node)) continue;
              if (node.length > 0 && typeof node[0] === 'number') {
                if (Number.isFinite(Number(node[2]))) return true;
              } else {
                for (let i = 0; i < node.length; i++) stack.push(node[i]);
              }
            }
          }
          return false;
        })();
        this.bboxIncludeZ = Boolean((this.options as any)['bbox-3d']) || hasZInSample;

        // Per-feature bbox column as a Parquet group per GeoParquet covering spec
        if (!disableBbox) {
          if (this.bboxIncludeZ) {
            (fields as any).bbox = {
              optional: true,
              fields: {
                xmin: { type: 'DOUBLE' },
                ymin: { type: 'DOUBLE' },
                zmin: { type: 'DOUBLE', optional: true },
                xmax: { type: 'DOUBLE' },
                ymax: { type: 'DOUBLE' },
                zmax: { type: 'DOUBLE', optional: true },
              },
            };
          } else {
            (fields as any).bbox = {
              optional: true,
              fields: {
                xmin: { type: 'DOUBLE' },
                ymin: { type: 'DOUBLE' },
                xmax: { type: 'DOUBLE' },
                ymax: { type: 'DOUBLE' },
              },
            };
          }
        }
        // No quadkeys/H3 columns

        for (const [k, c] of Object.entries(cols)) {
          if (c.epoch > 0 && c.str === 0 && c.obj === 0 && c.arr === 0) {
            fields[k] = { type: 'INT64', optional: true, originalType: 'TIMESTAMP_MILLIS' };
            continue;
          }
          if (c.iso > 0 && c.num === 0 && c.obj === 0 && c.arr === 0) {
            fields[k] = { type: 'INT64', optional: true, originalType: 'TIMESTAMP_MILLIS' };
            continue;
          }
          if (c.num > 0 && c.str === 0 && c.obj === 0 && c.arr === 0) {
            fields[k] = (c.dbl > 0) ? { type: 'DOUBLE', optional: true } : { type: 'INT64', optional: true };
            continue;
          }
          if (c.bool > 0 && c.num === 0 && c.str === 0 && c.obj === 0 && c.arr === 0) {
            fields[k] = { type: 'BOOLEAN', optional: true };
            continue;
          }
          fields[k] = { type: 'UTF8', optional: true };
        }

        fields.properties = { type: 'UTF8', optional: true };
        return new ParquetSchema(fields as any);
    }

    private async ensureWriterFromSample(sample: Feature[]): Promise<void> {
      if (this.writer) return;
      const cap = Math.min(this.schemaLookaheadRows, Array.isArray(sample) ? sample.length : 0);
      const use = cap > 0 ? sample.slice(0, cap) : sample.slice(0,1);
      this.schema = this.buildSchemaFromSample(use);

      // Choose output stream: local FS or S3 multipart upload
      const s3 = parseS3Url(this.outputPath);
      let stream: any;
      if (s3) {
        const p = s3.params || {};
        const opt: any = this.options || {};
        const acl = opt['s3-acl'] ?? p.acl;
        const storageClass = opt['s3-storage-class'] ?? p.storageClass;
        const sse = opt['s3-sse'] ?? p.sse;
        const ssekmsKeyId = opt['s3-ssekms-key-id'] ?? p.ssekmsKeyId ?? p.sseKmsKeyId ?? p.kmsKeyId;
        const up = await startS3UploadStream({
          bucket: s3.bucket,
          key: s3.key || `${Date.now()}.parquet`,
          contentType: 'application/vnd.apache.parquet',
          acl,
          storageClass,
          sse,
          ssekmsKeyId,
        });
        stream = up.stream;
        this._s3Done = up.done;
        this._s3Url = `s3://${s3.bucket}/${s3.key || ''}`;
      } else {
        stream = createWriteStream(this.outputPath);
      }

        // Note: @dsnp/parquetjs supports column compression via schema metadata in recent versions.
        // We'll try to set compression on all columns when available; otherwise the writer option suffices.
        try {
          const s: any = this.schema as any;
          for (const k of Object.keys(s.schema)) {
            s.schema[k].compression = this.parquetCompression;
          }
        } catch { /* best effort */ }

        this.writer = await ParquetWriter.openStream(this.schema, stream, {
          useDataPageV2: true,
        } as any);

        // Optional row group size tuning
        try {
          const rgs = Number((this.options as any).parquetRowGroupSize);
          if (Number.isFinite(rgs) && rgs > 0) (this.writer as any).setRowGroupSize?.(Math.floor(rgs));
        } catch {}

        // Ensure file footer key-value metadata is initialized even if not provided by the library
        // (older parquetjs variants sometimes require a write before metadata takes effect).
        (this.writer as any).setMetadata?.('created_by', 'esri-query');

        // GeoParquet metadata per spec (v1.0.0+). Use PROJJSON for CRS (OGC:CRS84).
        const CRS84_PROJJSON = {
          $schema: 'https://proj.org/schemas/v0.5/projjson.schema.json',
          type: 'GeographicCRS',
          name: 'WGS 84 longitude-latitude',
          datum: {
            type: 'GeodeticReferenceFrame',
            name: 'World Geodetic System 1984',
            ellipsoid: {
              name: 'WGS 84',
              semi_major_axis: 6378137,
              inverse_flattening: 298.257223563,
            },
          },
          coordinate_system: {
            subtype: 'ellipsoidal',
            axis: [
              { name: 'Geodetic longitude', abbreviation: 'Lon', direction: 'east', unit: 'degree' },
              { name: 'Geodetic latitude', abbreviation: 'Lat', direction: 'north', unit: 'degree' },
            ],
          },
          id: { authority: 'OGC', code: 'CRS84' },
        } as const;

        const disableBbox = Boolean((this.options as any)['no-bbox']);

        const geoMeta: any = {
          version: '1.1.0',
          primary_column: this.geometryColumnName,
          columns: {
            [this.geometryColumnName]: {
              encoding: 'WKB',
              geometry_types: [],
              edges: 'planar',
              crs: CRS84_PROJJSON,
              // Advertise bbox covering only when bbox column is written
              ...(disableBbox ? {} : {
                covering: {
                  bbox: {
                    xmin: ['bbox', 'xmin'],
                    ymin: ['bbox', 'ymin'],
                    ...(this.bboxIncludeZ ? { zmin: ['bbox','zmin'] } : {}),
                    xmax: ['bbox', 'xmax'],
                    ymax: ['bbox', 'ymax'],
                    ...(this.bboxIncludeZ ? { zmax: ['bbox','zmax'] } : {}),
                  },
                },
              }),
            },
          },
        };
        this.geoMetaBase = geoMeta;
        (this.writer as any).setMetadata?.('geo', JSON.stringify(geoMeta));
    }

    private geometryToWkb(geom: Geometry | null | undefined): Buffer | null {
        if (!geom) return null;
        try {
            return wkx.Geometry.parseGeoJSON(geom).toWkb();
        } catch (e) {
            if (this.onInvalid === 'throw') throw e;
            return null; // keep/skip handled by caller
        }
    }

    protected async onFlushBatch(features: Feature[]): Promise<void> {
      if (!features.length) return;
      if (!this.writer) await this.ensureWriterFromSample(features);

      // Cache schema field list once
      const schemaObj: any = (this.schema as any).schema;
      const schemaFields = Object.keys(schemaObj);

      const coerce = (val: any, type: string, colDef?: any) => {
        if (val === undefined) return undefined;
        if (val === null) return null;
        const t = String(type || '').toUpperCase();
        switch (t) {
          case 'UTF8':
          case 'BYTE_ARRAY':
            // Ensure strings for UTF8 columns
            try { return typeof val === 'string' ? val : JSON.stringify(val); } catch { return String(val); }
          case 'BOOLEAN':
            if (typeof val === 'boolean') return val;
            if (typeof val === 'string') return /^true$/i.test(val.trim());
            return Boolean(val);
          case 'INT64':
            // If declared as TIMESTAMP_MILLIS, accept ISO strings and epoch (string/number)
            if (colDef && (colDef.originalType === 'TIMESTAMP_MILLIS' || colDef.logicalType === 'TIMESTAMP_MILLIS')) {
              if (typeof val === 'number' && Number.isFinite(val)) {
                return Number.isInteger(val) ? val : undefined;
              }
              if (typeof val === 'string') {
                const n = Number(val);
                if (Number.isFinite(n)) return Number.isInteger(n) ? n : undefined;
                const t = Date.parse(val);
                return Number.isFinite(t) ? t : undefined;
              }
              return undefined;
            }
            // fallthrough to numeric
          case 'INT32':
          case 'INT96':
          case 'DOUBLE':
          case 'FLOAT':
            if (typeof val === 'number' && Number.isFinite(val)) {
              if (t === 'INT64' || t === 'INT32' || t === 'INT96') {
                if (Number.isInteger(val)) return val;
                return undefined;
              }
              return val;
            }
            if (typeof val === 'string') {
              const n = Number(val);
              if (!Number.isFinite(n)) return undefined;
              if (t === 'INT64' || t === 'INT32' || t === 'INT96') {
                return Number.isInteger(n) ? n : undefined;
              }
              return n;
            }
            return undefined;
          default:
            return val;
        }
      };

      // Helpers for bbox only
      const computeBbox = (geom: Geometry | null | undefined): [number, number, number, number] | null => {
        if (!geom || (geom as any).coordinates == null) return null;
        let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
        const stack: any[] = [(geom as any).coordinates];
        while (stack.length) {
          const node = stack.pop();
          if (!Array.isArray(node)) continue;
          if (node.length > 0 && typeof node[0] === 'number') {
            const x = Number(node[0]);
            const y = Number(node[1]);
            if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
            if (x < minx) minx = x;
            if (y < miny) miny = y;
            if (x > maxx) maxx = x;
            if (y > maxy) maxy = y;
          } else {
            for (let i = 0; i < node.length; i++) stack.push(node[i]);
          }
        }
        if (!(minx <= maxx && miny <= maxy && Number.isFinite(minx) && Number.isFinite(miny) && Number.isFinite(maxx) && Number.isFinite(maxy))) return null;
        return [minx, miny, maxx, maxy];
      };

      const hasZ = (geom: Geometry | null | undefined): boolean => {
        if (!geom || (geom as any).coordinates == null) return false;
        const stack: any[] = [(geom as any).coordinates];
        while (stack.length) {
          const node = stack.pop();
          if (!Array.isArray(node)) continue;
          if (node.length > 0 && typeof node[0] === 'number') {
            const z = Number(node[2]);
            if (Number.isFinite(z)) return true;
          } else {
            for (let i = 0; i < node.length; i++) stack.push(node[i]);
          }
        }
        return false;
      };

      const computeBboxWithZ = (geom: Geometry | null | undefined): { xmin: number; ymin: number; xmax: number; ymax: number; zmin?: number; zmax?: number } | null => {
        if (!geom || (geom as any).coordinates == null) return null;
        let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
        let zmin = Infinity, zmax = -Infinity;
        let sawZ = false;
        const stack: any[] = [(geom as any).coordinates];
        while (stack.length) {
          const node = stack.pop();
          if (!Array.isArray(node)) continue;
          if (node.length > 0 && typeof node[0] === 'number') {
            const x = Number(node[0]);
            const y = Number(node[1]);
            const z = Number(node[2]);
            if (Number.isFinite(x) && Number.isFinite(y)) {
              if (x < minx) minx = x;
              if (y < miny) miny = y;
              if (x > maxx) maxx = x;
              if (y > maxy) maxy = y;
            }
            if (Number.isFinite(z)) {
              sawZ = true;
              if (z < zmin) zmin = z;
              if (z > zmax) zmax = z;
            }
          } else {
            for (let i = 0; i < node.length; i++) stack.push(node[i]);
          }
        }
        if (!(minx <= maxx && miny <= maxy && Number.isFinite(minx) && Number.isFinite(miny) && Number.isFinite(maxx) && Number.isFinite(maxy))) return null;
        const out: any = { xmin: minx, ymin: miny, xmax: maxx, ymax: maxy };
        if (sawZ) { out.zmin = zmin; out.zmax = zmax; }
        return out;
      };

      const disableBbox = Boolean((this.options as any)['no-bbox']);

      for (const feat of features) {
        // Prepare row
        const row: Record<string, any> = {};
        try {
          const wkb = this.geometryToWkb(feat.geometry as any);
          if (!wkb && this.onInvalid === 'skip') continue; // skip row
          row[this.geometryColumnName] = wkb; // may be null
          // Track geometry types when valid
          if (wkb && feat.geometry && (feat.geometry as any).type) {
            let t = String((feat.geometry as any).type);
            if (hasZ(feat.geometry as any)) t = `${t} Z`;
            this.geomTypesSeen.add(t);
          }
        } catch (err) {
          if (this.onInvalid === 'skip') continue;
          if (this.onInvalid === 'keep') row[this.geometryColumnName] = null; else throw err;
        }

        // Flatten properties for known columns; unknown go to `properties` JSON
        const props = (feat.properties || {}) as Record<string, unknown>;
        const extra: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(props)) {
          if (k === this.geometryColumnName) continue;
          if (schemaFields.includes(k)) {
            const def = schemaObj[k] || {};
            const expectedType = def.type || def.primitiveType || '';
            const coerced = coerce(v as any, expectedType, def);
            if (coerced !== undefined) row[k] = coerced; else extra[k] = v;
          } else {
            extra[k] = v;
          }
        }
        if (Object.keys(extra).length) {
          const newKeys = Object.keys(extra).filter(k => !this._overflowColumnsWarned.has(k));
          if (newKeys.length) {
            for (const k of newKeys) this._overflowColumnsWarned.add(k);
            process.stderr.write(
              `[warn] GeoParquet: ${newKeys.length} column(s) not in schema will be serialized into the "properties" JSON column: ${newKeys.join(', ')}. ` +
              `Increase --parquetScanRows to include more lookahead rows.\n`
            );
          }
          row.properties = JSON.stringify(extra);
        }

        // Per-feature bbox columns (honor disable flags)
        // Only attach bbox when a geometry value exists in this row
        const hasGeometry = row[this.geometryColumnName] != null;
        const fbbox = hasGeometry ? (feat as any).bbox as [number, number, number, number] | undefined : undefined;
        const bbox = hasGeometry && fbbox && Array.isArray(fbbox) && fbbox.length === 4 ? fbbox
                    : (hasGeometry ? computeBbox(feat.geometry as any) : null);
        const bbox3d = hasGeometry ? computeBboxWithZ(feat.geometry as any) : null;
        if (hasGeometry && (bbox || bbox3d)) {
          if (!disableBbox) {
            if (this.bboxIncludeZ) {
              const b = bbox3d || (bbox ? { xmin: bbox[0], ymin: bbox[1], xmax: bbox[2], ymax: bbox[3] } as any : null);
              if (b) {
                row.bbox = {
                  xmin: b.xmin,
                  ymin: b.ymin,
                  zmin: b.zmin ?? null,
                  xmax: b.xmax,
                  ymax: b.ymax,
                  zmax: b.zmax ?? null,
                };
              }
            } else if (bbox) {
              row.bbox = { xmin: bbox[0], ymin: bbox[1], xmax: bbox[2], ymax: bbox[3] };
            }
          }

          // No quadkeys/H3 columns
        }

        await (this.writer as ParquetWriter).appendRow(row);
      }
    }

    async writeFeature(feature: Feature): Promise<Feature> {
      if (this.closed) throw new Error('Cannot write after close');
      if (!this.status.canWrite) this._markOpen();

      const processed = await super.writeFeature(feature);

      // Queue for debounced batch flush
      await this.enqueueForBatch(processed);
      return processed;
    }

    async close(): Promise<void> {
      if (this.closed) return;
      try {
        await this.flushBatchNow();
        if (this.writer) {
          // Update GeoParquet metadata with file-level bbox (column metadata) and geometry types if available
          try {
            const [minx, miny, maxx, maxy] = this.status.bbox;
            const disableBbox = Boolean((this.options as any)['no-bbox']);
            if (isFinite(minx) && isFinite(miny) && isFinite(maxx) && isFinite(maxy)) {
              const current = this.geoMetaBase ? { ...this.geoMetaBase } : { columns: { [this.geometryColumnName]: {} } } as any;
              if (!current.columns) current.columns = {};
              if (!current.columns[this.geometryColumnName]) current.columns[this.geometryColumnName] = {};
              if (!disableBbox) {
                current.columns[this.geometryColumnName].bbox = [minx, miny, maxx, maxy];
              }
              try {
                const types = Array.from(this.geomTypesSeen);
                if (Array.isArray(types)) {
                  current.columns[this.geometryColumnName].geometry_types = types;
                }
              } catch {}
              (this.writer as any).setMetadata?.('geo', JSON.stringify(current));
              this.geoMetaBase = current;
            }
          } catch {}
          await this.writer.close();
          if (this._s3Done) {
            try {
              await this._s3Done;
              if ((this.options as any).progress && this._s3Url) {
                process.stderr.write(`[s3] Uploaded GeoParquet to ${this._s3Url}\n`);
              }
            } catch (e) {
              const msg = (e as any)?.message || String(e);
              const where = this._s3Url ? ` to ${this._s3Url}` : '';
              throw new Error(`GeoParquet S3 upload failed${where}: ${msg}`);
            } finally { this._s3Done = null; }
          }
        }
        // Let the base Writer finalize (marks closed, handles footer modes if any)
        await this.onClose();
      } finally {
        this.closed = true;
      }
    }
}
