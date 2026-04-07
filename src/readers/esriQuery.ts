import { arcgisToGeoJSON } from '@terraformer/arcgis';
import crypto from 'crypto';
import post from '../helpers/post-async.js';
import * as ArcGIS from 'arcgis-rest-api';
import { EsriFeatureLayerType, EsriQueryObjectType } from '../helpers/esri-rest-types.js';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import Stdout from '../writers/Stdout.js';
import Gpkg from '../writers/Gpkg.js';
import File from '../writers/File.js';
import FlatGeobuf from '../writers/FlatGeobuf.js';
import GeoParquet from '../writers/GeoParquet.js';
import Writer from '../writers/Writer.js';
// Only OID-chunk strategy is supported now
import OidChunkQueryTool from '../helpers/OidChunkTool.js';
import { parseExtraHeaders } from '../cli-options.js';

function normalizeOutFields(value: unknown): string | undefined {
  if (value == null) return undefined;

  const raw: string[] = [];
  const push = (entry: unknown) => {
    if (entry == null) return;
    const text = String(entry);
    if (!text) return;
    for (const token of text.split(',')) {
      const trimmed = token.trim();
      if (trimmed) raw.push(trimmed);
    }
  };

  if (Array.isArray(value)) {
    for (const entry of value) push(entry);
  } else {
    push(value);
  }

  if (!raw.length) return undefined;
  if (raw.includes('*')) return '*';

  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const field of raw) {
    const key = field.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(field);
  }

  return deduped.length ? deduped.join(',') : undefined;
}

function ensureRequiredOutField(outFields: string | undefined, requiredField: string | undefined): string | undefined {
  const required = String(requiredField ?? '').trim();
  if (!required) return outFields;
  if (!outFields || outFields === '*') return outFields;
  return normalizeOutFields([outFields, required]);
}

export type EsriQueryOptions = {
  url: string;
  where: string;
  bbox?: [number, number, number, number];
  bboxWkid?: number;
  'bbox-wkid'?: number;
  outFields?: string | string[];
  'out-fields'?: string | string[];
  format?: 'esrijson' | 'geojson' | 'geojsonseq' | 'gpkg' | 'flatgeobuf' | 'geoparquet';
  output?: string;
  overwrite?: boolean;
  json?: boolean;
  progress?: boolean;
  append?: boolean;
  'feature-count'?: number;
  'no-bbox'?: boolean;
  'layer-name'?: string;
  dedupe?: boolean;
  token?: string;
  header?: string | string[];
  headers?: string | string[] | Record<string, string | number | boolean>;
  'resume-state'?: string;
};

type ResumeState = {
  version: 1;
  mode: 'geojsonseq-oid';
  url: string;
  queryUrl: string;
  where: string;
  output: string;
  format: 'geojsonseq';
  oidField: string;
  totalFeatureCount?: number;
  lastCompletedOid?: number;
  recordsWritten?: number;
  completed?: boolean;
  updatedAt: string;
};

export type EsriQueryProgressSnapshot = {
  featureCount: number;
  totalFeatureCount?: number;
  resumeStatePath?: string;
  lastCompletedOid?: number;
  checkpointRecordsWritten?: number;
  completed?: boolean;
};

const MAX_ALLOWED_ERRORS = 10; //TODO: This should be a parameter

export type EsriFeatureType = {
  'geometry'?: ArcGIS.Geometry,
  'attributes'?: { [key: string]: string }
};

export default class EsriQuery {
  url: string;
  queryUrl: string;
  whereObj: EsriQueryObjectType;
  fields?: {
    [key: string]:
    EsriFeatureLayerType['fields'][0] &
    {
      sortable: boolean
    }
  };
  options: EsriQueryOptions;
  sourceInfo?: EsriFeatureLayerType;
  totalFeatureCount: number;
  supportsPagination?: boolean; // retained for compatibility (unused)
  runtimeParams: {
    hashList: Record<string, boolean>;
    featureCount: number;
    runTime: number;
  } = {
      featureCount: 0,
      hashList: {},
      runTime: 0
    };

  private dotSplits: number[] = [];
  private numSplits: number[] = [];

  writer: Writer;
  private _lastWrite: Promise<void> = Promise.resolve();
  private _writeError: Error | null = null;
  private _activeTool: OidChunkQueryTool | null = null;
  private _stopRequested = false;
  private _stopReason: 'max-records' | 'write-error' | null = null;
  extraHeaders?: Record<string, string>;
  private resumeStatePath?: string;
  private resumeState?: ResumeState;
  private resumeAfterOid?: number;
  private resumeOidField?: string;

  constructor(options: EsriQueryOptions) {
    this.options = options;
    // Assign the url and normalized queryUrl from 'options' to the current object (this)
    this.url = options.url;
    const ensureQueryUrl = (u: string | URL): string => {
      const url = new URL(String(u));
      // If it already ends with /query, keep it
      if (/\/query\/?$/i.test(url.pathname)) return url.toString();
      // If it’s a MapServer/FeatureServer (optionally with layer id), append /query
      if (/\/(MapServer|FeatureServer)(?:\/\d+)?\/?$/i.test(url.pathname)) {
        url.pathname = url.pathname.replace(/\/?$/, '/query');
      }
      return url.toString();
    };
    this.queryUrl = ensureQueryUrl(options.url);

    const configuredOutFields = normalizeOutFields((options as any)['out-fields'] ?? (options as any).outFields);
    this.extraHeaders = parseExtraHeaders([(options as any).header, (options as any).headers]);
    this.resumeStatePath = (options as any)['resume-state'];

    // Create a 'whereObj' which is the Esri Rest params defined as EsriQueryObjectType
    this.whereObj = {
      'where': options.where,
      'returnGeometry': true,
      'outFields': configuredOutFields ?? '*',
      'outSR': '4326',
      'f': 'json',
      ...(options.token ? { token: options.token } : {}),
    };
  }

  private buildResumeState(oidField: string, base?: Partial<ResumeState>): ResumeState {
    return {
      version: 1,
      mode: 'geojsonseq-oid',
      url: this.url,
      queryUrl: this.queryUrl,
      where: this.options.where,
      output: String(this.options.output),
      format: 'geojsonseq',
      oidField,
      totalFeatureCount: this.totalFeatureCount,
      lastCompletedOid: base?.lastCompletedOid,
      recordsWritten: base?.recordsWritten ?? 0,
      completed: base?.completed ?? false,
      updatedAt: new Date().toISOString(),
    };
  }

  private async saveResumeState(): Promise<void> {
    if (!this.resumeStatePath || !this.resumeState) return;
    await mkdir(dirname(this.resumeStatePath), { recursive: true });
    const tmpPath = `${this.resumeStatePath}.tmp`;
    await writeFile(tmpPath, JSON.stringify({ ...this.resumeState, updatedAt: new Date().toISOString() }, null, 2) + '\n', 'utf8');
    await rename(tmpPath, this.resumeStatePath);
  }

  private async prepareResumeSupport(): Promise<void> {
    if (!this.resumeStatePath) return;
    if (this.options.format !== 'geojsonseq') {
      throw new Error('--resume-state currently supports --format geojsonseq only.');
    }
    if (!this.options.output) {
      throw new Error('--resume-state requires --output.');
    }
    if ((this.options as any).partition) {
      throw new Error('--resume-state does not support partitioned output.');
    }

    const oidField = String(
      (this.sourceInfo as any)?.objectIdFieldName ??
      (this.sourceInfo as any)?.objectIdField ??
      ''
    ).trim();
    if (!oidField) {
      throw new Error('Cannot enable resume mode: object ID field is unavailable.');
    }
    this.resumeOidField = oidField;

    const overwrite = Boolean((this.options as any).overwrite);
    const outputExists = existsSync(String(this.options.output));
    let loadedState: ResumeState | undefined;

    if (!overwrite) {
      try {
        loadedState = JSON.parse(await readFile(this.resumeStatePath, 'utf8')) as ResumeState;
      } catch (e: any) {
        if (e?.code !== 'ENOENT') throw e;
      }
    }

    if (!overwrite && loadedState) {
      const expected = this.buildResumeState(oidField, loadedState);
      const mismatches = [
        loadedState.mode !== 'geojsonseq-oid' ? 'mode' : null,
        loadedState.url !== expected.url ? 'url' : null,
        loadedState.queryUrl !== expected.queryUrl ? 'queryUrl' : null,
        loadedState.where !== expected.where ? 'where' : null,
        loadedState.output !== expected.output ? 'output' : null,
        loadedState.format !== expected.format ? 'format' : null,
        loadedState.oidField !== expected.oidField ? 'oidField' : null,
      ].filter(Boolean);
      if (mismatches.length) {
        throw new Error(`Resume state does not match this job (${mismatches.join(', ')}). Use --overwrite to start fresh or point to the correct state file.`);
      }
      if (!outputExists) {
        throw new Error(`Resume state exists at ${this.resumeStatePath}, but output is missing: ${this.options.output}`);
      }
      this.resumeState = this.buildResumeState(oidField, loadedState);
      this.resumeAfterOid = Number.isFinite(Number(loadedState.lastCompletedOid)) ? Number(loadedState.lastCompletedOid) : undefined;
      (this.options as any).append = true;
      if ((this.options as any)['oid-concurrency'] && Number((this.options as any)['oid-concurrency']) !== 1 && this.options.progress) {
        process.stderr.write('[resume] forcing oid-concurrency=1 for deterministic resume\n');
      }
      (this.options as any)['oid-concurrency'] = 1;
      (this.options as any)['id-list-threshold'] = Number.MAX_SAFE_INTEGER;
      if (this.options.progress) {
        process.stderr.write(`[resume] resuming after OID ${this.resumeAfterOid ?? 0}\n`);
      }
    } else {
      if (!overwrite && outputExists) {
        throw new Error(`Output already exists: ${this.options.output}. For resume mode, keep the matching state file or use --overwrite to start fresh.`);
      }
      (this.options as any)['oid-concurrency'] = 1;
      (this.options as any)['id-list-threshold'] = Number.MAX_SAFE_INTEGER;
      this.resumeAfterOid = undefined;
      this.resumeState = this.buildResumeState(oidField);
      await this.saveResumeState();
    }
  }

  private findBatchMaxOid(features: Array<EsriFeatureType>, oidField: string | undefined): number | undefined {
    if (!oidField || !features.length) return undefined;
    let maxOid: number | undefined;
    for (const feature of features) {
      const attrs = (feature?.attributes ?? {}) as Record<string, unknown>;
      let raw = attrs[oidField];
      if (raw == null) {
        const key = Object.keys(attrs).find(k => k.toLowerCase() === oidField.toLowerCase());
        if (key) raw = attrs[key];
      }
      const oid = Number(raw);
      if (!Number.isFinite(oid)) continue;
      maxOid = maxOid == null ? oid : Math.max(maxOid, oid);
    }
    return maxOid;
  }

  private async recordResumeProgress(lastCompletedOid: number | undefined, acceptedCount: number): Promise<void> {
    if (!this.resumeState || !this.resumeStatePath || lastCompletedOid == null) return;
    const nextRecordsWritten = Number(this.resumeState.recordsWritten ?? 0) + Math.max(0, acceptedCount);
    this.resumeState = this.buildResumeState(this.resumeState.oidField, {
      ...this.resumeState,
      lastCompletedOid,
      recordsWritten: nextRecordsWritten,
      completed: false,
    });
    await this.saveResumeState();
  }

  getProgressSnapshot(): EsriQueryProgressSnapshot {
    return {
      featureCount: Number(this.runtimeParams.featureCount || 0),
      totalFeatureCount: this.totalFeatureCount,
      resumeStatePath: this.resumeStatePath,
      lastCompletedOid: this.resumeAfterOid ?? this.resumeState?.lastCompletedOid,
      checkpointRecordsWritten: this.resumeState?.recordsWritten,
      completed: this.resumeState?.completed,
    };
  }

  private requestStop(reason: 'max-records' | 'write-error') {
    if (this._stopRequested) return;
    this._stopRequested = true;
    this._stopReason = reason;
    try { this._activeTool?.cancel(); } catch {}
  }

  /**
   * Gets the source info for an Esri feature or map service
   * @returns A promise containing the Esri Feature Layer
   */
  async getSourceInfo() {
    // Fetch source info and feature count in parallel
    const [source, countResult] = await Promise.all([
      post(this.options.url, { f: 'json' }, { headers: this.extraHeaders }) as Promise<EsriFeatureLayerType>,
      post(this.queryUrl, { ...this.whereObj, returnCountOnly: true }, { headers: this.extraHeaders })
    ]);

    // Process fields
    this.fields = source.fields.reduce((acc, field) => {
      const sortable = field.type !== 'esriFieldTypeGeometry' && !field.name.includes('()');
      return { ...acc, [field.name]: { ...field, sortable } };
    }, {});

    // Keep OID available even when users narrow outFields.
    const objectIdField = String((source as any).objectIdFieldName ?? (source as any).objectIdField ?? '').trim() || undefined;
    this.whereObj.outFields = ensureRequiredOutField(this.whereObj.outFields, objectIdField);

    // No-op: offset pagination removed; ordering hints are unnecessary now.

    // Capability hints
    this.supportsPagination = Boolean((source as any)?.advancedQueryCapabilities?.supportsPagination);

    // Update feature count/page size hint
    const requested = typeof this.options['feature-count'] === 'number' ? this.options['feature-count'] : undefined;
    const serverCap = Number(source.maxRecordCount) || 1000;
    this.options['feature-count'] = Math.max(1, Math.min(requested ?? serverCap, serverCap));

    // Determine query format
    const jsonFormats = ['esriGeometryPoint', 'esriGeometryMultipoint'];
    const supports = Array.isArray((source as any).supportedQueryFormats)
      ? (source as any).supportedQueryFormats as string[]
      : String((source as any).supportedQueryFormats || '').split(',').map(s => s.trim()).filter(Boolean);
    const usePBF = supports.includes('PBF') && !jsonFormats.includes(source.geometryType);
    this.whereObj.f = this.options.json ? 'json' : (usePBF ? 'pbf' : 'json');

    if (this.options.progress) process.stderr.write(`Using query format: ${this.whereObj.f} ${JSON.stringify(source.geometryType)} ${JSON.stringify(supports)}\n`);

    // Set source info and total feature count
    this.sourceInfo = source;
    this.totalFeatureCount = (countResult as { count: number }).count;
    if (this.options.progress) process.stderr.write(`Total features matching query: ${this.totalFeatureCount}\n`);

    // Precompute progress tick thresholds (avoids per-feature allocations)
    const ten = Math.max(1, Math.floor(this.totalFeatureCount / 10));
    const hundred = Math.max(1, Math.floor(this.totalFeatureCount / 100));
    this.numSplits = Array.from({ length: 9 }, (_, i) => (i + 1) * ten);
    this.dotSplits = Array.from({ length: 98 }, (_, i) => (i + 1) * hundred);

    return this.sourceInfo;
  };

  /**
   * Initiates the querying process for the given data source and writes the results to a file or stdout.
   * @returns Promise that resolves to an object containing runtime parameters after the querying process is complete.
   * @throws Error if there is an issue reading source information.
   */
  async start(): Promise<typeof this.runtimeParams> {
    this._lastWrite = Promise.resolve();
    this._writeError = null;
    this._activeTool = null;
    this._stopRequested = false;
    this._stopReason = null;

    // Ensure necessary source information and fields are available
    if (!this.sourceInfo || !this.fields) {
      try {
        await this.getSourceInfo();
      } catch (e) {
        throw new Error(`Cannot read source info: ${this.url}\n${e.toString()}`);
      }
    }

    // Determine the appropriate writer type based on the output format
    type WriterCtor = new (options: any, sourceInfo?: any) => Writer;
    let writerType: WriterCtor;
    if (!this.options.format) {
      const out = this.options.output || '';
      if (/\.gpkg$/i.test(out)) this.options.format = 'gpkg';
      else if (/\.fgb$/i.test(out)) this.options.format = 'flatgeobuf';
      else if (/\.(parquet|gpq)$/i.test(out)) this.options.format = 'geoparquet';
      else this.options.format = 'geojson';
    }

    switch (this.options.format) {
      case 'esrijson':
      case 'geojson':
      case 'geojsonseq':
        writerType = this.options.output ? File : Stdout;
        break;
      case 'gpkg':
        writerType = Gpkg;
        break;
      case 'flatgeobuf':
        writerType = FlatGeobuf;
        break;
      case 'geoparquet':
        writerType = GeoParquet;
        break;
      default:
        throw new Error(`Unsupported format: ${this.options}`);
    }

    // FlatGeobuf requires a file output path
    if (this.options.format === 'flatgeobuf') {
      if (!this.options.output) {
        throw new Error('FlatGeobuf requires --output pointing to a .fgb file or output directory');
      }
      if (!this.options.output.endsWith('.fgb')) {
        process.stderr.write(`[warn] output extension should be ".fgb" for flatgeobuf (got "${this.options.output}")\n`);
      }
    }

    if (this.options.format === 'geoparquet') {
      if (!this.options.output) {
        throw new Error('GeoParquet requires --output pointing to a .parquet file');
      }
      if (!/\.(parquet|gpq)$/i.test(this.options.output)) {
        process.stderr.write(`[warn] output extension should be ".parquet" (or ".gpq") for GeoParquet (got "${this.options.output}")\n`);
      }
    }

    // Create the writer instance and start the queries
    await this.prepareResumeSupport();
    const outWkid = Number(this.whereObj.outSR);
    this.writer = new writerType(this.options as any, {
      ...this.sourceInfo,
      totalFeatureCount: this.totalFeatureCount,
      outputWkid: Number.isFinite(outWkid) ? outWkid : undefined,
    });

    // Update runtime parameters and track the process time
    const startTime = new Date();

    try {
      await this.writer.open();
      if (this.options.progress) {
        const total = this.totalFeatureCount || 0;
        this.writer.progressEvery = Math.max(1, Math.floor(Math.max(1, total) / 100));
        const t0 = Date.now();
        let lastStatus = t0;
        this.writer.onProgress = ({ records, invalid, skipped }) => {
          // Compact [0....10] style progress
          if (records === 1) process.stderr.write('[0');
          if (this.dotSplits.includes(records)) process.stderr.write('.');
          const tenIndex = this.numSplits.indexOf(records);
          if (tenIndex > -1) process.stderr.write(String(tenIndex + 1));
          if (total && records === total) process.stderr.write('10]\n');

          // Periodic status line with rates and ETA (every ~5s)
          const now = Date.now();
          if (now - lastStatus >= 5000) {
            const elapsed = (now - t0) / 1000;
            const rate = elapsed > 0 ? (records / elapsed) : 0;
            const remaining = total > 0 ? Math.max(0, total - records) : 0;
            const etaSec = rate > 0 && remaining > 0 ? Math.round(remaining / rate) : 0;
            const fmt = (s: number) => {
              const m = Math.floor(s / 60); const ss = s % 60; return m > 0 ? `${m}m${String(ss).padStart(2, '0')}s` : `${ss}s`;
            };
            const pct = total > 0 ? Math.floor((records / total) * 100) : 0;
            process.stderr.write(`\n[progress] ${records}${total ? `/${total}` : ''} ${total ? `(${pct}%)` : ''} @ ${rate.toFixed(1)}/s, eta ${etaSec ? fmt(etaSec) : '—'}, invalid=${invalid}, skipped=${skipped}\n`);
            lastStatus = now;
          }
        };

        // Status handled below; metrics handled in startQuery() scope
      }

      await this.startQuery();

      // Ensure all in-flight writes are flushed before closing
      await this._lastWrite;
      if (this._writeError) throw this._writeError;
      if (this.resumeState) {
        this.resumeState = this.buildResumeState(this.resumeState.oidField, {
          ...this.resumeState,
          completed: true,
          recordsWritten: this.resumeState.recordsWritten,
          lastCompletedOid: this.resumeAfterOid ?? this.resumeState.lastCompletedOid,
        });
        await this.saveResumeState();
      }
    } finally {
      await this.writer.close();
    }

    // Update runtime parameters to indicate the process is complete
    const endTime = new Date();
    const runTime = (endTime.valueOf() - startTime.valueOf()) / 1000;
    this.runtimeParams.runTime = runTime;
    this.options.progress && process.stderr.write(`\ntotalFeatureCount ${this.totalFeatureCount}\n`);

    return this.runtimeParams;
  }

  async write(
    features: Array<EsriFeatureType> | undefined,
  ): Promise<number> {
    // Delegate to batching path to keep one implementation
    return await this.writeBatchFromArcgis(features);
  }

  /**
   * Batch-write using Writer.writeBatch with an (async) iterable of GeoJSON features.
   * Converts ArcGIS features, de-duplicates by hash, and updates progress based on
   * writer-accepted (non-skipped) features.
   */
  private async writeBatchFromArcgis(
    features: Array<EsriFeatureType> | undefined,
  ): Promise<number> {
    if (!features || !features.length) return 0;

    const { options, writer, runtimeParams } = this;

    const convertGeometry = (geometry: any): GeoJSON.Geometry | null => {
      if (!geometry) return null;
      try {
        return arcgisToGeoJSON(geometry) as GeoJSON.Geometry;
      } catch {
        return null;
      }
    };

    const calculateHash = (geojson: GeoJSON.Feature): string => {
      // Note: fast, order-sensitive; adequate for optional dedupe
      return crypto.createHash('sha1').update(JSON.stringify(geojson)).digest('hex');
    };

    const isNewFeature = (hash: string): boolean => {
      if (runtimeParams.hashList[hash]) return false;
      runtimeParams.hashList[hash] = true;
      return true;
    };

    // (no-op progress helper removed; using writer.onProgress in start())

    const dedupe = Boolean((options as any).dedupe);
    // Build an async iterable that yields only new (de-duplicated when enabled) features
    const self = this;
    async function* items(): AsyncIterable<GeoJSON.Feature> {
      for (const feature of features) {
        const geometry = convertGeometry(feature.geometry);
        const geojson: GeoJSON.Feature = {
          type: 'Feature',
          properties: feature.attributes,
          geometry: geometry ?? null,
        };
        if (dedupe) {
          const dbHash = calculateHash(geojson);
          if (isNewFeature(dbHash)) yield geojson;
        } else {
          yield geojson;
        }
      }
    }

    // Use writer.writeBatch so batch-capable writers can optimize buffering/flush
    const accepted = await writer.writeBatch(items());

    // Update our counters and progress for *accepted* features
    if (typeof accepted === 'number' && accepted > 0) {
      runtimeParams.featureCount += accepted;
    }
    if ((writer as any).status?.terminated) {
      this.requestStop('max-records');
    }
    return typeof accepted === 'number' ? accepted : 0;
  }

  startQuery() {
    const rawBbox = (this.options as any).bbox;
    const bbox = Array.isArray(rawBbox)
      ? (rawBbox as [number, number, number, number])
      : (typeof rawBbox === 'string'
        ? (() => {
            const parts = rawBbox.split(',').map((x: string) => Number(x.trim()));
            return (parts.length === 4 && parts.every(Number.isFinite)) ? parts as [number, number, number, number] : undefined;
          })()
        : undefined);
    const bboxWkidRaw = (this.options as any)['bbox-wkid'] ?? (this.options as any).bboxWkid;
    const bboxWkid = Number.isFinite(Number(bboxWkidRaw)) ? Number(bboxWkidRaw) : undefined;
    const oidField = String(
      (this.sourceInfo as any)?.objectIdFieldName ??
      (this.sourceInfo as any)?.objectIdField ??
      ''
    ).trim() || undefined;
    this.whereObj.outFields = ensureRequiredOutField(this.whereObj.outFields, oidField);
    const makeOptions = () => ({
      maxErrors: MAX_ALLOWED_ERRORS,
      maxFeaturesPerRequest: this.options['feature-count'],
      queryObjectBase: this.whereObj,
      baseUrl: new URL(this.url),
      progress: this.options.progress,
      totalCount: this.totalFeatureCount,
      oidStart: (this.options as any)['oid-start'],
      oidConcurrency: (this.options as any)['oid-concurrency'],
      idListThreshold: (this.options as any)['id-list-threshold'],
      oidWindow: (this.options as any)['oid-window'],
      oidField,
      bbox,
      bboxWkid,
      extraHeaders: this.extraHeaders,
      resumeAfterOid: this.resumeAfterOid,
      stableOidOrder: Boolean(this.resumeStatePath),
    });

    let lastRetriesPrinted = 0;
    const wire = (tool: any) => {
      if (this.options.progress) {
        try {
          tool.on('metrics', (m: any) => {
            try {
              const r = Number(m?.totalRetries || 0);
              if (r > lastRetriesPrinted) {
                lastRetriesPrinted = r;
                const b = Number(m?.totalBackoffMs || 0);
                process.stderr.write(`[net] retries=${r}, backoff≈${Math.round(b)}ms\n`);
              }
            } catch {}
          });
        } catch {}
      }
      tool.on('data', (data: ArcGIS.Feature[]) => {
        const batch = data as unknown as Array<EsriFeatureType>;
        const batchMaxOid = this.findBatchMaxOid(batch, this.resumeOidField ?? oidField);
        if (this._stopRequested || this._writeError) {
          try { tool.cancel(); } catch {}
          return;
        }
        // Chain sequentially to avoid overlapping writes and to advance resume state
        // only after the batch is durably written.
        this._lastWrite = this._lastWrite.then(async () => {
          const accepted = await this.writeBatchFromArcgis(batch as any);
          if (batchMaxOid != null) {
            this.resumeAfterOid = batchMaxOid;
            await this.recordResumeProgress(batchMaxOid, accepted ?? 0);
          }
        }).catch((err: any) => {
          this._writeError = err instanceof Error ? err : new Error(String(err));
          this.requestStop('write-error');
          throw this._writeError;
        });
      });
      tool.on('message', (message: string | string[]) => {
        const formattedMessage = Array.isArray(message) ? message.join(' ') : message;
        if (this.options.progress) process.stderr.write(formattedMessage);
      });
      // 'metrics' listener added when progress enabled
    };

    const runTool = async () => {
      // OID chunk strategy only
      const oids = new OidChunkQueryTool(makeOptions() as any);
      this._activeTool = oids;
      wire(oids);
      try {
        await oids.runQuery();
      } catch (err) {
        if (this._writeError) throw this._writeError;
        if (this._stopRequested && this._stopReason === 'max-records') return;
        throw err;
      } finally {
        this._activeTool = null;
      }
      return;
    };

    return new Promise<void>((resolve, reject) => {
      runTool().then(() => resolve()).catch(reject);
    });
  }
}
