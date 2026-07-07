import { arcgisToGeoJSON } from '@terraformer/arcgis';
import crypto from 'crypto';
import post from '../helpers/post-async.js';
import * as ArcGIS from 'arcgis-rest-api';
import { EsriFeatureLayerType, EsriQueryObjectType } from '../helpers/esri-rest-types.js';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, open, readFile, rename, rm, truncate, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';
import { getHeapStatistics } from 'node:v8';

import Stdout from '../writers/Stdout.js';
import Gpkg from '../writers/Gpkg.js';
import File from '../writers/File.js';
import FlatGeobuf from '../writers/FlatGeobuf.js';
import GeoParquet from '../writers/GeoParquet.js';
import Writer from '../writers/Writer.js';
// Only OID-chunk strategy is supported now
import OidChunkQueryTool from '../helpers/OidChunkTool.js';
import { parseExtraHeaders } from '../cli-options.js';
import { parseS3Url } from '../helpers/s3.js';

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
  'fetch-log'?: string;
  fetchLog?: string;
  'resume-state'?: string;
  'wait-for-server'?: boolean;
  'wait-max-seconds'?: number;
  'wait-max-attempts'?: number;
  'oid-field'?: string;
  oidField?: string;
  'max-file-bytes'?: number;
  'heartbeat-seconds'?: number;
  heartbeatSeconds?: number;
  'stall-seconds'?: number;
  stallSeconds?: number;
  'dedupe-warn-entries'?: number;
  'dedupe-max-entries'?: number;
};

type ResumeOutputMode = 'single-file' | 'segmented';
type StopReason = 'max-records' | 'write-error' | 'signal';

type ResumeState = {
  version: 1 | 2;
  mode: 'geojsonseq-oid' | 'gpkg-oid';
  url: string;
  queryUrl: string;
  where: string;
  output: string;                 // logical base output path from the CLI
  checkpointPath?: string;        // actual on-disk file currently being resumed/written
  format: 'geojsonseq' | 'gpkg';
  oidField: string;
  outFields?: string;
  bbox?: string;
  totalFeatureCount?: number;
  lastCompletedOid?: number;
  recordsWritten?: number;
  outputMode?: ResumeOutputMode;
  outputBytes?: number;
  segmentIndex?: number;
  maxFileBytes?: number;
  oidMode?: 'range' | 'objectIds';
  lastWindowSize?: number;
  lastChunkSize?: number;
  completed?: boolean;
  updatedAt: string;
  // Set while --wait-for-server is idling between resume attempts; cleared on the next attempt.
  waitingSince?: string;
  lastError?: string;
};

export type EsriQueryProgressSnapshot = {
  featureCount: number;
  totalFeatureCount?: number;
  resumeStatePath?: string;
  lastCompletedOid?: number;
  checkpointRecordsWritten?: number;
  completed?: boolean;
  stopRequested?: boolean;
  stopReason?: StopReason;
};

const MAX_ALLOWED_ERRORS = 10; //TODO: This should be a parameter
const DEFAULT_DEDUPE_WARN_ENTRIES = 250000;
const DEFAULT_DEDUPE_MAX_ENTRIES = 1000000;
const DEDUPE_ENTRY_ESTIMATED_BYTES = 128;
const DEDUPE_HEAP_SHARE = 0.25;
const MIN_DEDUPE_MAX_ENTRIES = 50000;

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
    dedupeHashCount: number;
    featureCount: number;
    runTime: number;
  } = {
      featureCount: 0,
      dedupeHashCount: 0,
      runTime: 0
    };

  private dotSplits: number[] = [];
  private numSplits: number[] = [];

  writer: Writer;
  private _lastWrite: Promise<void> = Promise.resolve();
  private _writeError: Error | null = null;
  private _activeTool: OidChunkQueryTool | null = null;
  private _stopRequested = false;
  private _stopReason: StopReason | null = null;
  extraHeaders?: Record<string, string>;
  private resumeStatePath?: string;
  private resumeState?: ResumeState;
  private _fetchPhaseReached: boolean = false;
  private _sourceInfoFailed: boolean = false;
  private resumeLockPath?: string;
  private resumeLockHandle?: FileHandle;
  private resumeAfterOid?: number;
  private resumeOidField?: string;
  private adaptiveOidMetrics?: { oidMode?: 'range' | 'objectIds'; lastWindowSize?: number; lastChunkSize?: number };
  private dedupeSeenHashes = new Set<string>();
  private dedupeWarned = false;
  private lastWriteAt = 0;

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

  private resolveOidField(source?: Partial<EsriFeatureLayerType> | Record<string, unknown>): string | undefined {
    const configured = String((this.options as any)['oid-field'] ?? (this.options as any).oidField ?? '').trim();
    if (configured) return configured;
    const inferred = String(
      (source as any)?.objectIdFieldName ??
      (source as any)?.objectIdField ??
      ''
    ).trim();
    return inferred || undefined;
  }

  private getConfiguredMaxFileBytes(): number | undefined {
    const raw = Number((this.options as any)['max-file-bytes']);
    return Number.isFinite(raw) && raw > 0 ? raw : undefined;
  }

  private getPositiveSeconds(kebabName: string, camelName: string, fallback: number): number {
    const raw = (this.options as any)[kebabName] ?? (this.options as any)[camelName];
    const parsed = Number(raw);
    if (raw == null || raw === '') return fallback;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }

  private formatElapsed(ms: number): string {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds % 60;
    return minutes > 0 ? `${minutes}m${String(remainder).padStart(2, '0')}s` : `${remainder}s`;
  }

  private isProcessAlive(pid: number): boolean {
    if (!Number.isFinite(pid) || pid <= 0) return false;
    if (pid === process.pid) return true;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err: any) {
      return err?.code === 'EPERM';
    }
  }

  private async acquireResumeLock(): Promise<void> {
    if (!this.resumeStatePath || this.resumeLockHandle) return;
    const lockPath = `${this.resumeStatePath}.lock`;
    await mkdir(dirname(lockPath), { recursive: true });

    const metadata = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      url: this.url,
      output: this.options.output,
      resumeState: this.resumeStatePath,
    };

    const createLock = async () => {
      const handle = await open(lockPath, 'wx');
      try {
        await handle.writeFile(JSON.stringify(metadata, null, 2) + '\n', 'utf8');
      } catch (err) {
        try { await handle.close(); } catch {}
        try { await rm(lockPath, { force: true }); } catch {}
        throw err;
      }
      this.resumeLockPath = lockPath;
      this.resumeLockHandle = handle;
    };

    try {
      await createLock();
      return;
    } catch (err: any) {
      if (err?.code !== 'EEXIST') throw err;
    }

    let lockDetails = '';
    let stalePid: number | undefined;
    try {
      const raw = await readFile(lockPath, 'utf8');
      lockDetails = raw.trim();
      const parsed = JSON.parse(raw) as { pid?: unknown };
      const pid = Number(parsed?.pid);
      if (Number.isFinite(pid) && pid > 0 && !this.isProcessAlive(pid)) {
        stalePid = pid;
      }
    } catch {}

    if (stalePid != null) {
      await rm(lockPath, { force: true });
      await createLock();
      if (this.options.progress) {
        process.stderr.write(`[resume] removed stale lock from pid ${stalePid}: ${lockPath}\n`);
      }
      return;
    }

    throw new Error(
      `Resume lock exists: ${lockPath}. Another export may be using this resume state. ` +
      `Stop that process or remove the lock only after confirming no export is running.` +
      (lockDetails ? ` Lock details: ${lockDetails}` : '')
    );
  }

  private async releaseResumeLock(): Promise<void> {
    const lockPath = this.resumeLockPath;
    const handle = this.resumeLockHandle;
    this.resumeLockPath = undefined;
    this.resumeLockHandle = undefined;
    if (handle) {
      try { await handle.close(); } catch {}
    }
    if (lockPath) {
      try { await rm(lockPath, { force: true }); } catch {}
    }
  }

  private getApproxAvailableHeapBytes(): number | undefined {
    try {
      const heapLimit = Number(getHeapStatistics().heap_size_limit || 0);
      const heapUsed = Number(process.memoryUsage().heapUsed || 0);
      if (!(heapLimit > 0) || !(heapUsed >= 0)) return undefined;
      return Math.max(0, heapLimit - heapUsed);
    } catch {
      return undefined;
    }
  }

  private getDedupeMaxEntries(): number {
    const configured = Number((this.options as any)['dedupe-max-entries'] ?? process.env.ESRIQ_DEDUPE_MAX_ENTRIES);
    if (Number.isFinite(configured) && configured > 0) return Math.floor(configured);

    const available = this.getApproxAvailableHeapBytes();
    if (typeof available === 'number' && available > 0) {
      const derived = Math.floor((available * DEDUPE_HEAP_SHARE) / DEDUPE_ENTRY_ESTIMATED_BYTES);
      return Math.max(MIN_DEDUPE_MAX_ENTRIES, Math.min(DEFAULT_DEDUPE_MAX_ENTRIES, derived));
    }

    return DEFAULT_DEDUPE_MAX_ENTRIES;
  }

  private getDedupeWarnEntries(maxEntries: number): number {
    const configured = Number((this.options as any)['dedupe-warn-entries'] ?? process.env.ESRIQ_DEDUPE_WARN_ENTRIES);
    if (Number.isFinite(configured) && configured > 0) {
      return Math.min(maxEntries, Math.floor(configured));
    }
    return Math.min(maxEntries, Math.max(DEFAULT_DEDUPE_WARN_ENTRIES, Math.floor(maxEntries / 2)));
  }

  private ensureDedupeCapacity(additionalUniqueHashes: number): void {
    if (additionalUniqueHashes <= 0) return;

    const maxEntries = this.getDedupeMaxEntries();
    const warnEntries = this.getDedupeWarnEntries(maxEntries);
    const nextCount = this.dedupeSeenHashes.size + additionalUniqueHashes;

    if (!this.dedupeWarned && nextCount >= warnEntries) {
      this.dedupeWarned = true;
      process.stderr.write(
        `[warn] --dedupe is tracking ${nextCount} unique feature hashes in memory; guardrail is ${maxEntries}. ` +
        `Increase --dedupe-max-entries if this is intentional, or rerun without --dedupe for very large jobs.\n`
      );
    }

    if (nextCount > maxEntries) {
      throw new Error(
        `--dedupe exceeded the in-memory guardrail (${maxEntries} unique feature hashes). ` +
        `Refusing to continue before exhausting memory. Increase --dedupe-max-entries or rerun without --dedupe.`
      );
    }
  }

  private markDedupeHashSeen(hash: string): boolean {
    if (this.dedupeSeenHashes.has(hash)) return false;
    this.dedupeSeenHashes.add(hash);
    this.runtimeParams.dedupeHashCount = this.dedupeSeenHashes.size;
    return true;
  }

  private getResumeOutputMode(state?: Partial<ResumeState>): ResumeOutputMode {
    if (state) {
      if (state.outputMode === 'segmented') return 'segmented';
      if ((state.segmentIndex != null && Number.isFinite(Number(state.segmentIndex))) ||
          (state.maxFileBytes != null && Number.isFinite(Number(state.maxFileBytes)))) {
        return 'segmented';
      }
      return 'single-file';
    }
    return this.getConfiguredMaxFileBytes() ? 'segmented' : 'single-file';
  }

  private serializeBbox(): string | undefined {
    const rawBbox = (this.options as any).bbox;
    if (!rawBbox) return undefined;
    const parts = Array.isArray(rawBbox)
      ? rawBbox.map(Number)
      : String(rawBbox).split(',').map((x: string) => Number(x.trim()));
    if (parts.length !== 4 || !parts.every(Number.isFinite)) return undefined;
    return parts.join(',');
  }


  private getResumeFormat(): 'geojsonseq' | 'gpkg' {
    return this.options.format === 'gpkg' ? 'gpkg' : 'geojsonseq';
  }

  private buildResumeState(oidField: string, base?: Partial<ResumeState>): ResumeState {
    const format = this.getResumeFormat();
    if (format === 'gpkg') {
      return {
        version: 2,
        mode: 'gpkg-oid',
        url: this.url,
        queryUrl: this.queryUrl,
        where: this.options.where,
        output: String(this.options.output),
        checkpointPath: String(this.options.output),
        format: 'gpkg',
        oidField,
        outFields: this.whereObj.outFields ?? undefined,
        bbox: this.serializeBbox(),
        totalFeatureCount: this.totalFeatureCount,
        lastCompletedOid: base?.lastCompletedOid,
        recordsWritten: base?.recordsWritten ?? 0,
        oidMode: base?.oidMode,
        lastWindowSize: Number.isFinite(Number(base?.lastWindowSize)) ? Math.max(1, Number(base?.lastWindowSize)) : undefined,
        lastChunkSize: Number.isFinite(Number(base?.lastChunkSize)) ? Math.max(1, Number(base?.lastChunkSize)) : undefined,
        completed: base?.completed ?? false,
        updatedAt: new Date().toISOString(),
      };
    }
    const outputMode = this.getResumeOutputMode(base);
    const outputBytes = Number.isFinite(Number(base?.outputBytes)) ? Math.max(0, Number(base?.outputBytes)) : 0;
    const maxFileBytes = outputMode === 'segmented'
      ? (Number.isFinite(Number(base?.maxFileBytes)) ? Number(base?.maxFileBytes) : this.getConfiguredMaxFileBytes())
      : undefined;
    const segmentIndex = outputMode === 'segmented'
      ? (Number.isFinite(Number(base?.segmentIndex)) ? Math.max(0, Number(base?.segmentIndex)) : 0)
      : undefined;
    const checkpointPath = outputMode === 'segmented'
      ? String(base?.checkpointPath ?? File.segmentPathFromOutput(String(this.options.output), segmentIndex ?? 0))
      : String(base?.checkpointPath ?? this.options.output);
    return {
      version: 2,
      mode: 'geojsonseq-oid',
      url: this.url,
      queryUrl: this.queryUrl,
      where: this.options.where,
      output: String(this.options.output),
      checkpointPath,
      format: 'geojsonseq',
      oidField,
      outFields: this.whereObj.outFields ?? undefined,
      bbox: this.serializeBbox(),
      totalFeatureCount: this.totalFeatureCount,
      lastCompletedOid: base?.lastCompletedOid,
      recordsWritten: base?.recordsWritten ?? 0,
      outputMode,
      outputBytes,
      ...(outputMode === 'segmented' ? { segmentIndex, maxFileBytes } : {}),
      oidMode: base?.oidMode,
      lastWindowSize: Number.isFinite(Number(base?.lastWindowSize)) ? Math.max(1, Number(base?.lastWindowSize)) : undefined,
      lastChunkSize: Number.isFinite(Number(base?.lastChunkSize)) ? Math.max(1, Number(base?.lastChunkSize)) : undefined,
      completed: base?.completed ?? false,
      updatedAt: new Date().toISOString(),
    };
  }

  private applyAdaptiveOidMetrics(metrics?: { oidMode?: unknown; currentWindowSize?: unknown; currentChunkSize?: unknown }): void {
    if (!metrics) return;
    const oidMode = metrics.oidMode === 'range' || metrics.oidMode === 'objectIds'
      ? metrics.oidMode
      : this.adaptiveOidMetrics?.oidMode;
    const lastWindowSize = Number.isFinite(Number(metrics.currentWindowSize))
      ? Math.max(1, Number(metrics.currentWindowSize))
      : this.adaptiveOidMetrics?.lastWindowSize;
    const lastChunkSize = Number.isFinite(Number(metrics.currentChunkSize))
      ? Math.max(1, Number(metrics.currentChunkSize))
      : this.adaptiveOidMetrics?.lastChunkSize;
    this.adaptiveOidMetrics = { oidMode, lastWindowSize, lastChunkSize };
    if (!this.resumeState) return;
    this.resumeState = this.buildResumeState(this.resumeState.oidField, {
      ...this.resumeState,
      oidMode,
      lastWindowSize,
      lastChunkSize,
    });
  }

  private async findNdjsonCheckpointBytes(outputPath: string, recordsWritten: number): Promise<number> {
    if (recordsWritten <= 0) return 0;

    return await new Promise<number>((resolve, reject) => {
      let remaining = recordsWritten;
      let offset = 0;
      let settled = false;
      const stream = createReadStream(outputPath, { highWaterMark: 1 << 20 });

      const finish = (value: number) => {
        if (settled) return;
        settled = true;
        stream.destroy();
        resolve(value);
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };

      stream.on('data', (chunk: Buffer) => {
        for (let i = 0; i < chunk.length; i += 1) {
          if (chunk[i] !== 0x0A) continue;
          remaining -= 1;
          if (remaining === 0) {
            finish(offset + i + 1);
            return;
          }
        }
        offset += chunk.length;
      });
      stream.on('error', (err: any) => {
        fail(err instanceof Error ? err : new Error(String(err)));
      });
      stream.on('close', () => {
        if (!settled) {
          fail(new Error(`Output does not contain ${recordsWritten} newline-delimited features: ${outputPath}`));
        }
      });
    });
  }

  private async resolveSingleFileResumeBytes(state: ResumeState): Promise<number> {
    const savedBytes = Number(state.outputBytes);
    if (Number.isFinite(savedBytes) && savedBytes >= 0) return savedBytes;
    const outputPath = String(this.options.output);
    const recordsWritten = Math.max(0, Number(state.recordsWritten ?? 0));
    if (recordsWritten === 0) return 0;
    return await this.findNdjsonCheckpointBytes(outputPath, recordsWritten);
  }

  private async migrateSingleFileResumeToSegments(state: ResumeState, maxFileBytes: number): Promise<ResumeState> {
    const outputPath = String(this.options.output);
    const checkpointBytes = Math.max(0, Number(state.outputBytes ?? 0));
    const firstSegmentPath = File.segmentPathFromOutput(outputPath, 0);

    if (existsSync(firstSegmentPath)) {
      throw new Error(`Cannot migrate resume output: ${firstSegmentPath} already exists.`);
    }

    if (checkpointBytes > 0) {
      if (!existsSync(outputPath)) {
        throw new Error(`Cannot migrate resume output: missing source file ${outputPath}`);
      }
      await truncate(outputPath, checkpointBytes);
      await mkdir(dirname(firstSegmentPath), { recursive: true });
      await rename(outputPath, firstSegmentPath);
      if (this.options.progress) {
        process.stderr.write(`[resume] migrated checkpointed output to ${firstSegmentPath}\n`);
      }
      return {
        ...state,
        outputMode: 'segmented',
        outputBytes: 0,
        segmentIndex: 1,
        maxFileBytes,
      };
    }

    if (existsSync(outputPath)) {
      await truncate(outputPath, 0);
      await rm(outputPath, { force: true });
    }

    return {
      ...state,
      outputMode: 'segmented',
      outputBytes: 0,
      segmentIndex: 0,
      maxFileBytes,
    };
  }

  private applyResumeWriterOptions(state: ResumeState): void {
    (this.options as any).append = true;
    (this.options as any)['resume-output-bytes'] = Math.max(0, Number(state.outputBytes ?? 0));
    if (this.getResumeOutputMode(state) === 'segmented') {
      const maxFileBytes = Number(state.maxFileBytes ?? this.getConfiguredMaxFileBytes());
      if (!Number.isFinite(maxFileBytes) || maxFileBytes <= 0) {
        throw new Error('Resume state is missing a valid max-file-bytes value for segmented output.');
      }
      (this.options as any)['max-file-bytes'] = maxFileBytes;
      (this.options as any)['resume-segment-index'] = Math.max(0, Number(state.segmentIndex ?? 0));
    } else {
      delete (this.options as any)['resume-segment-index'];
    }
  }

  private getWriterResumeStatePatch(): Partial<ResumeState> {
    if (this.writer instanceof Gpkg) {
      const checkpoint = this.writer.getResumeCheckpoint();
      return {
        checkpointPath: String(this.options.output),
        lastCompletedOid: checkpoint.lastCompletedOid,
        recordsWritten: checkpoint.recordsWritten,
      };
    }
    if (!(this.writer instanceof File)) return {};
    const checkpoint = this.writer.getResumeCheckpoint();
    if (checkpoint.outputMode === 'segmented') {
      return {
        outputMode: 'segmented',
        outputBytes: checkpoint.outputBytes,
        segmentIndex: checkpoint.segmentIndex,
        maxFileBytes: checkpoint.maxFileBytes,
        checkpointPath: checkpoint.path,
      };
    }
    return {
      outputMode: 'single-file',
      outputBytes: checkpoint.outputBytes,
      checkpointPath: checkpoint.path,
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
    if (this.options.format !== 'geojsonseq' && this.options.format !== 'gpkg') {
      throw new Error('--resume-state currently supports --format geojsonseq or gpkg only.');
    }
    if (!this.options.output) {
      throw new Error('--resume-state requires --output.');
    }
    if ((this.options as any).partition) {
      throw new Error('--resume-state does not support partitioned output.');
    }
    const resumeFormat = this.getResumeFormat();
    if (resumeFormat === 'gpkg') {
      if (this.getConfiguredMaxFileBytes() != null) {
        throw new Error('--resume-state with --format gpkg does not support --max-file-bytes.');
      }
      if (parseS3Url(String(this.options.output))) {
        throw new Error('--resume-state does not support s3:// GPKG outputs; write to a local file and upload separately.');
      }
    }

    await this.acquireResumeLock();

    const oidField = this.resolveOidField(this.sourceInfo);
    if (!oidField) {
      throw new Error('Cannot enable resume mode: object ID field is unavailable. Pass --oid-field FIELDNAME.');
    }
    this.resumeOidField = oidField;
    if (resumeFormat === 'gpkg') {
      // Lets the Gpkg writer checkpoint the max committed OID inside each batch transaction.
      (this.options as any)['resume-oid-field'] = oidField;
    }

    const overwrite = Boolean((this.options as any).overwrite);
    let loadedState: ResumeState | undefined;

    if (!overwrite) {
      try {
        loadedState = JSON.parse(await readFile(this.resumeStatePath, 'utf8')) as ResumeState;
      } catch (e: any) {
        if (e?.code !== 'ENOENT') throw e;
      }
    }

    if (!overwrite && loadedState) {
      const currentBbox = this.serializeBbox();
      const currentOutFields = this.whereObj.outFields ?? undefined;
      const expectedMode = resumeFormat === 'gpkg' ? 'gpkg-oid' : 'geojsonseq-oid';
      const mismatches = [
        loadedState.mode !== expectedMode ? 'mode' : null,
        loadedState.url !== this.url ? 'url' : null,
        loadedState.queryUrl !== this.queryUrl ? 'queryUrl' : null,
        loadedState.where !== this.options.where ? 'where' : null,
        loadedState.output !== String(this.options.output) ? 'output' : null,
        loadedState.format !== resumeFormat ? 'format' : null,
        loadedState.oidField !== oidField ? 'oidField' : null,
        // Only check outFields/bbox when the state has them (old state files won't, and that's fine)
        (loadedState.outFields != null && loadedState.outFields !== currentOutFields) ? 'outFields' : null,
        (loadedState.bbox != null && loadedState.bbox !== currentBbox) ? 'bbox' : null,
      ].filter(Boolean);
      if (mismatches.length) {
        throw new Error(`Resume state does not match this job (${mismatches.join(', ')}). Use --overwrite to start fresh or point to the correct state file.`);
      }

      if (loadedState.completed) {
        throw new Error(
          `Resume state at ${this.resumeStatePath} shows a completed export ` +
          `(${loadedState.recordsWritten ?? 0} features written). Use --overwrite to start fresh.`
        );
      }

      let normalizedState: ResumeState = { ...loadedState };
      if (resumeFormat === 'gpkg') {
        const outputPath = String(this.options.output);
        const sidecarOid = Number.isFinite(Number(loadedState.lastCompletedOid)) ? Number(loadedState.lastCompletedOid) : undefined;
        const checkpointExpected = Math.max(0, Number(loadedState.recordsWritten ?? 0)) > 0 || sidecarOid != null;
        if (!existsSync(outputPath)) {
          if (checkpointExpected) {
            throw new Error(
              `Resume state exists at ${this.resumeStatePath}, but GPKG output is missing: ${outputPath}. ` +
              `Use --overwrite to start fresh.`
            );
          }
          // Nothing was committed last run; recreate the output from scratch.
          normalizedState.lastCompletedOid = undefined;
          normalizedState.recordsWritten = 0;
        } else {
          // The in-database checkpoint is updated in the same transaction as each
          // batch insert, so it is the authority; the sidecar can lag behind it
          // if the process died between a commit and the sidecar write.
          const dbCheckpoint = Gpkg.readResumeCheckpoint(outputPath);
          if (!dbCheckpoint) {
            throw new Error(
              `Cannot resume: ${outputPath} has no resume checkpoint table ` +
              `(it was not created by a --resume-state run). Use --overwrite to start fresh.`
            );
          }
          if (sidecarOid != null && dbCheckpoint.lastCompletedOid !== sidecarOid && this.options.progress) {
            process.stderr.write(`[resume] GPKG checkpoint (OID ${dbCheckpoint.lastCompletedOid ?? 'none'}) supersedes sidecar (OID ${sidecarOid})\n`);
          }
          normalizedState.lastCompletedOid = dbCheckpoint.lastCompletedOid;
          normalizedState.recordsWritten = dbCheckpoint.recordsWritten;
          (this.options as any)['gpkg-resume-append'] = true;
        }
      } else {
        const loadedMode = this.getResumeOutputMode(loadedState);
        const checkpointPath = loadedMode === 'segmented'
          ? String(loadedState.checkpointPath ?? File.segmentPathFromOutput(String(this.options.output), Math.max(0, Number(loadedState.segmentIndex ?? 0))))
          : String(this.options.output);
        const checkpointExpected = Math.max(0, Number(loadedState.recordsWritten ?? 0)) > 0 || Math.max(0, Number(loadedState.outputBytes ?? 0)) > 0;
        const outputExists = existsSync(checkpointPath);
        if (!outputExists) {
          if (checkpointExpected) {
            throw new Error(
              `Resume state exists at ${this.resumeStatePath}, but checkpoint output is missing: ${checkpointPath}. ` +
              `Use --overwrite to start fresh.`
            );
          }
        }

        const loadedMaxFileBytes = Number(normalizedState.maxFileBytes);
        const configuredMaxFileBytes = this.getConfiguredMaxFileBytes();
        if (loadedMode === 'segmented') {
          if (!Number.isFinite(loadedMaxFileBytes) || loadedMaxFileBytes <= 0) {
            throw new Error('Resume state is missing a valid max-file-bytes value for segmented output.');
          }
          if (configuredMaxFileBytes == null) {
            (this.options as any)['max-file-bytes'] = loadedMaxFileBytes;
          } else if (configuredMaxFileBytes !== loadedMaxFileBytes) {
            throw new Error(`Resume state expects --max-file-bytes ${loadedMaxFileBytes}, got ${configuredMaxFileBytes}.`);
          }
        }

        if (loadedMode === 'single-file') {
          normalizedState.outputBytes = await this.resolveSingleFileResumeBytes(normalizedState);
          const desiredMaxFileBytes = this.getConfiguredMaxFileBytes();
          if (desiredMaxFileBytes != null) {
            normalizedState = await this.migrateSingleFileResumeToSegments(normalizedState, desiredMaxFileBytes);
          }
        }
      }

      this.resumeState = this.buildResumeState(oidField, normalizedState);
      this.adaptiveOidMetrics = {
        oidMode: this.resumeState.oidMode,
        lastWindowSize: this.resumeState.lastWindowSize,
        lastChunkSize: this.resumeState.lastChunkSize,
      };
      this.resumeAfterOid = Number.isFinite(Number(normalizedState.lastCompletedOid)) ? Number(normalizedState.lastCompletedOid) : undefined;
      if (resumeFormat !== 'gpkg') {
        this.applyResumeWriterOptions(this.resumeState);
      }
      if ((this.options as any)['oid-concurrency'] && Number((this.options as any)['oid-concurrency']) !== 1 && this.options.progress) {
        process.stderr.write('[resume] forcing oid-concurrency=1 for deterministic resume\n');
      }
      (this.options as any)['oid-concurrency'] = 1;
      await this.saveResumeState();
      if (this.options.progress) {
        process.stderr.write(`[resume] resuming after OID ${this.resumeAfterOid ?? 0}\n`);
      }
    } else {
      (this.options as any)['oid-concurrency'] = 1;
      this.resumeAfterOid = undefined;
      this.resumeState = this.buildResumeState(oidField, {
        outputMode: this.getConfiguredMaxFileBytes() ? 'segmented' : 'single-file',
        outputBytes: 0,
        segmentIndex: this.getConfiguredMaxFileBytes() ? 0 : undefined,
        maxFileBytes: this.getConfiguredMaxFileBytes(),
      });
      this.adaptiveOidMetrics = {
        oidMode: this.resumeState.oidMode,
        lastWindowSize: this.resumeState.lastWindowSize,
        lastChunkSize: this.resumeState.lastChunkSize,
      };
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
      ...this.getWriterResumeStatePatch(),
      oidMode: this.adaptiveOidMetrics?.oidMode ?? this.resumeState.oidMode,
      lastWindowSize: this.adaptiveOidMetrics?.lastWindowSize ?? this.resumeState.lastWindowSize,
      lastChunkSize: this.adaptiveOidMetrics?.lastChunkSize ?? this.resumeState.lastChunkSize,
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
      stopRequested: this._stopRequested,
      stopReason: this._stopReason ?? undefined,
    };
  }

  private requestStop(reason: StopReason) {
    if (this._stopRequested) return;
    this._stopRequested = true;
    this._stopReason = reason;
    try { this._activeTool?.cancel(); } catch {}
  }

  requestGracefulStop(signal?: NodeJS.Signals | string): void {
    const alreadyStopping = this._stopRequested;
    this.requestStop('signal');
    if (!alreadyStopping && this.options.progress) {
      process.stderr.write(`\n[signal] ${signal ?? 'interrupt'} received; stopping after current write/checkpoint\n`);
    }
  }

  /**
   * Gets the source info for an Esri feature or map service
   * @returns A promise containing the Esri Feature Layer
   */
  async getSourceInfo() {
    const fetchLogPath = (this.options as any)['fetch-log'] ?? (this.options as any).fetchLog;
    // Fetch source info and feature count in parallel
    const [source, countResult] = await Promise.all([
      post(this.options.url, { f: 'json' }, { headers: this.extraHeaders, fetchLogPath }) as Promise<EsriFeatureLayerType>,
      post(this.queryUrl, { ...this.whereObj, returnCountOnly: true }, { headers: this.extraHeaders, fetchLogPath })
    ]);

    // Process fields
    this.fields = source.fields.reduce((acc, field) => {
      const sortable = field.type !== 'esriFieldTypeGeometry' && !field.name.includes('()');
      return { ...acc, [field.name]: { ...field, sortable } };
    }, {});

    // Keep OID available even when users narrow outFields.
    const objectIdField = this.resolveOidField(source);
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
   * With --wait-for-server, rides out server outages by checkpointing, waiting with
   * backoff until the service responds again, and re-entering the resume path.
   * @returns Promise that resolves to an object containing runtime parameters after the querying process is complete.
   * @throws Error if there is an issue reading source information.
   */
  async start(): Promise<typeof this.runtimeParams> {
    if (!this.options['wait-for-server']) return await this.runOnce();
    if (!this.resumeStatePath) {
      throw new Error('--wait-for-server requires --resume-state so interrupted runs can resume without duplicating output.');
    }

    const maxWaitSeconds = Number(this.options['wait-max-seconds']) > 0 ? Number(this.options['wait-max-seconds']) : Infinity;
    const maxAttempts = Number(this.options['wait-max-attempts']) > 0 ? Number(this.options['wait-max-attempts']) : 20;
    // Test hook: shrink the schedule without exposing a CLI flag
    const backoffBase = Number((this.options as any)['wait-backoff-seconds']) > 0 ? Number((this.options as any)['wait-backoff-seconds']) : 30;
    const backoffSchedule = [1, 2, 4, 10, 20, 30].map(mult => backoffBase * mult);

    let attemptsWithoutProgress = 0;
    let waitedSecondsWithoutProgress = 0;

    for (;;) {
      const prevOid = this.resumeAfterOid;
      const prevRecords = Number(this.resumeState?.recordsWritten ?? 0);
      let lastError: Error;
      try {
        return await this.runOnce();
      } catch (err: any) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const retryable = (this._sourceInfoFailed || this._fetchPhaseReached)
          && !this._writeError
          && this._stopReason !== 'signal';
        if (!retryable) throw lastError;
      }

      const currentOid = this.resumeAfterOid ?? this.resumeState?.lastCompletedOid;
      const currentRecords = Number(this.resumeState?.recordsWritten ?? 0);
      const madeProgress = (currentOid != null && currentOid !== prevOid) || currentRecords > prevRecords;
      if (madeProgress) {
        attemptsWithoutProgress = 0;
        waitedSecondsWithoutProgress = 0;
      }
      attemptsWithoutProgress += 1;
      if (attemptsWithoutProgress > maxAttempts) {
        throw new Error(`--wait-for-server gave up after ${maxAttempts} consecutive attempts without progress. Last error: ${lastError.message}`);
      }

      await this.noteWaitingInResumeState(lastError);

      // Poll the service until it responds again, backing off between probes.
      let probeIndex = 0;
      for (;;) {
        const delaySeconds = backoffSchedule[Math.min(probeIndex, backoffSchedule.length - 1)];
        waitedSecondsWithoutProgress += delaySeconds;
        if (waitedSecondsWithoutProgress > maxWaitSeconds) {
          throw new Error(`--wait-for-server exceeded --wait-max-seconds ${maxWaitSeconds} without progress. Last error: ${lastError.message}`);
        }
        if (this.options.progress) {
          process.stderr.write(`[wait] attempt ${attemptsWithoutProgress}/${maxAttempts} failed (${lastError.message.split('\n')[0]}); probing server in ${delaySeconds}s (checkpoint OID ${this.resumeAfterOid ?? this.resumeState?.lastCompletedOid ?? 'none'})\n`);
        }
        await this.interruptibleSleep(delaySeconds);
        if (await this.probeServer()) break;
        probeIndex += 1;
      }
      if (this.options.progress) {
        process.stderr.write(`[wait] server responded; resuming export\n`);
      }
      // A previous run's --overwrite must not wipe checkpointed progress on retry.
      delete (this.options as any).overwrite;
    }
  }

  /** Writes waiting metadata into the sidecar so operators can see why the job is idle. */
  private async noteWaitingInResumeState(error: Error): Promise<void> {
    if (!this.resumeState || !this.resumeStatePath) return;
    try {
      this.resumeState = {
        ...this.resumeState,
        waitingSince: this.resumeState.waitingSince ?? new Date().toISOString(),
        lastError: error.message.split('\n')[0].slice(0, 500),
      };
      await this.saveResumeState();
    } catch {}
  }

  /** Sleeps in short ticks so a SIGINT/SIGTERM during the wait exits promptly. */
  private async interruptibleSleep(seconds: number): Promise<void> {
    const deadline = Date.now() + seconds * 1000;
    while (Date.now() < deadline) {
      if (this._stopRequested) {
        throw new Error('Interrupted by signal while waiting for server; resume checkpoint saved.');
      }
      const remainingMs = Math.min(1000, deadline - Date.now());
      await new Promise(resolve => setTimeout(resolve, remainingMs));
    }
    if (this._stopRequested) {
      throw new Error('Interrupted by signal while waiting for server; resume checkpoint saved.');
    }
  }

  /** Returns true when the service answers a metadata request again. */
  private async probeServer(): Promise<boolean> {
    try {
      const fetchLogPath = (this.options as any)['fetch-log'] ?? (this.options as any).fetchLog;
      await post(this.options.url, { f: 'json' }, { headers: this.extraHeaders, fetchLogPath });
      return true;
    } catch {
      return false;
    }
  }

  private async runOnce(): Promise<typeof this.runtimeParams> {
    this._lastWrite = Promise.resolve();
    this._writeError = null;
    this._activeTool = null;
    this._stopRequested = false;
    this._stopReason = null;
    this._fetchPhaseReached = false;
    this._sourceInfoFailed = false;
    this.dedupeSeenHashes = new Set<string>();
    this.dedupeWarned = false;
    this.runtimeParams.dedupeHashCount = 0;
    this.lastWriteAt = Date.now();

    // Ensure necessary source information and fields are available
    if (!this.sourceInfo || !this.fields) {
      try {
        await this.getSourceInfo();
      } catch (e) {
        this._sourceInfoFailed = true;
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

    // Update runtime parameters and track the process time
    const startTime = new Date();

    try {
      await this.prepareResumeSupport();
      const outWkid = Number(this.whereObj.outSR);
      this.writer = new writerType(this.options as any, {
        ...this.sourceInfo,
        totalFeatureCount: this.totalFeatureCount,
        outputWkid: Number.isFinite(outWkid) ? outWkid : undefined,
      });

      try {
        await this.writer.open();
        if (this.options.progress) {
          const total = this.totalFeatureCount || 0;
          const resumedRecords = Number(this.resumeState?.recordsWritten ?? 0);
          if (resumedRecords > 0) {
            this.writer.status.records = resumedRecords;
            process.stderr.write(`[resume] checkpoint ${resumedRecords}${total ? `/${total}` : ''}\n`);
          }
          this.writer.progressEvery = Math.max(1, Math.floor(Math.max(1, total) / 100));
          const t0 = Date.now();
          let lastStatus = t0;
          const showCompactProgress = resumedRecords === 0;
          this.writer.onProgress = ({ records, invalid, skipped }) => {
            // Compact [0....10] style progress
            if (showCompactProgress) {
              if (records === 1) process.stderr.write('[0');
              if (this.dotSplits.includes(records)) process.stderr.write('.');
              const tenIndex = this.numSplits.indexOf(records);
              if (tenIndex > -1) process.stderr.write(String(tenIndex + 1));
              if (total && records === total) process.stderr.write('10]\n');
            }

            // Periodic status line with rates and ETA (every ~5s)
            const now = Date.now();
            if (now - lastStatus >= 5000) {
              const elapsed = (now - t0) / 1000;
              const runRecords = Math.max(0, records - resumedRecords);
              const rate = elapsed > 0 ? (runRecords / elapsed) : 0;
              const remaining = total > 0 ? Math.max(0, total - records) : 0;
              const etaSec = rate > 0 && remaining > 0 ? Math.round(remaining / rate) : 0;
              const fmt = (s: number) => {
                const m = Math.floor(s / 60); const ss = s % 60; return m > 0 ? `${m}m${String(ss).padStart(2, '0')}s` : `${ss}s`;
              };
              const pct = total > 0 ? Math.floor((records / total) * 100) : 0;
              process.stderr.write(`\n[progress] ${records}${total ? `/${total}` : ''} ${total ? `(${pct}%)` : ''}, +${runRecords} this run @ ${rate.toFixed(1)}/s, eta ${etaSec ? fmt(etaSec) : '—'}, invalid=${invalid}, skipped=${skipped}\n`);
              lastStatus = now;
            }
          };

          // Status handled below; metrics handled in startQuery() scope
        }

        try {
          // From here on, failures are fetch-phase failures (server outages,
          // exhausted retries) that --wait-for-server may safely retry from checkpoint.
          this._fetchPhaseReached = true;
          await this.startQuery();
        } finally {
          // Drain in-flight writes whether startQuery succeeded or failed, so the
          // checkpoint always reflects what is actually on disk before we close.
          await this._lastWrite.catch(() => {});
        }
        if (this._writeError) throw this._writeError;
        if (this._stopRequested && this._stopReason === 'signal') {
          throw new Error('Interrupted by signal; resume checkpoint saved if --resume-state is set.');
        }
        const summary = this.writer.getSummary();
        const dedupeEnabled = Boolean((this.options as any).dedupe);
        const onInvalid = (this.options as any)['on-invalid'] ?? (this.options as any).onInvalid;
        const shortfall = Math.max(0, Number(this.totalFeatureCount || 0) - Number(summary.records || 0));
        if (!this._stopRequested && this.totalFeatureCount > 0 && shortfall > 0 && this.runtimeParams.featureCount > 0 && !dedupeEnabled && onInvalid !== 'skip') {
          const detail = [
            `records=${summary.records}/${this.totalFeatureCount}`,
            `invalid=${summary.invalid}`,
            `skipped=${summary.skipped}`,
            `lastCompletedOid=${this.resumeAfterOid ?? 'n/a'}`,
            `resumeState=${this.resumeStatePath ?? 'n/a'}`,
          ].join(', ');
          throw new Error(`Export stopped short without a terminal fetch error: ${detail}. Rerun with DEBUG_ESRI_QUERY=1 for raw request diagnostics.`);
        }
        if (this.resumeState && !this._stopRequested) {
          this.resumeState = this.buildResumeState(this.resumeState.oidField, {
            ...this.resumeState,
            ...this.getWriterResumeStatePatch(),
            oidMode: this.adaptiveOidMetrics?.oidMode ?? this.resumeState.oidMode,
            lastWindowSize: this.adaptiveOidMetrics?.lastWindowSize ?? this.resumeState.lastWindowSize,
            lastChunkSize: this.adaptiveOidMetrics?.lastChunkSize ?? this.resumeState.lastChunkSize,
            completed: true,
            recordsWritten: this.resumeState.recordsWritten,
            lastCompletedOid: this.resumeAfterOid ?? this.resumeState.lastCompletedOid,
          });
          await this.saveResumeState();
        }
      } catch (err) {
        if (this.resumeState) {
          this.resumeState = this.buildResumeState(this.resumeState.oidField, {
            ...this.resumeState,
            ...this.getWriterResumeStatePatch(),
            oidMode: this.adaptiveOidMetrics?.oidMode ?? this.resumeState.oidMode,
            lastWindowSize: this.adaptiveOidMetrics?.lastWindowSize ?? this.resumeState.lastWindowSize,
            lastChunkSize: this.adaptiveOidMetrics?.lastChunkSize ?? this.resumeState.lastChunkSize,
            completed: false,
            lastCompletedOid: this.resumeAfterOid ?? this.resumeState.lastCompletedOid,
          });
          await this.saveResumeState();
        }
        throw err;
      } finally {
        await this.writer.close();
      }
    } finally {
      await this.releaseResumeLock();
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

    // (no-op progress helper removed; using writer.onProgress in start())

    const dedupe = Boolean((options as any).dedupe);
    const prepared = features.map((feature) => {
      const geometry = convertGeometry(feature.geometry);
      const geojson: GeoJSON.Feature = {
        type: 'Feature',
        properties: feature.attributes,
        geometry: geometry ?? null,
      };
      return {
        geojson,
        hash: dedupe ? calculateHash(geojson) : undefined,
      };
    });

    if (dedupe) {
      const projectedNewHashes = new Set<string>();
      for (const entry of prepared) {
        const hash = String(entry.hash);
        if (this.dedupeSeenHashes.has(hash) || projectedNewHashes.has(hash)) continue;
        projectedNewHashes.add(hash);
      }
      this.ensureDedupeCapacity(projectedNewHashes.size);
    }

    // Build an async iterable that yields only new (de-duplicated when enabled) features
    const self = this;
    async function* items(): AsyncIterable<GeoJSON.Feature> {
      for (const entry of prepared) {
        if (dedupe) {
          if (self.markDedupeHashSeen(String(entry.hash))) yield entry.geojson;
        } else {
          yield entry.geojson;
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
    const oidField = this.resolveOidField(this.sourceInfo);
    this.whereObj.outFields = ensureRequiredOutField(this.whereObj.outFields, oidField);
    const makeOptions = () => ({
      maxErrors: MAX_ALLOWED_ERRORS,
      maxFeaturesPerRequest: this.options['feature-count'],
      queryObjectBase: this.whereObj,
      baseUrl: new URL(this.url),
      progress: this.options.progress,
      totalCount: this.totalFeatureCount,
      oidStart: (this.options as any)['oid-start'] ?? this.resumeState?.lastChunkSize,
      oidConcurrency: (this.options as any)['oid-concurrency'],
      idListThreshold: (this.options as any)['id-list-threshold'],
      oidWindow: (this.options as any)['oid-window'] ?? this.resumeState?.lastWindowSize,
      oidField,
      bbox,
      bboxWkid,
      extraHeaders: this.extraHeaders,
      resumeAfterOid: this.resumeAfterOid,
      stableOidOrder: Boolean(this.resumeStatePath),
      fetchLog: (this.options as any)['fetch-log'] ?? (this.options as any).fetchLog,
    });

    let latestMetrics: Record<string, any> = {};
    let heartbeatTimer: NodeJS.Timeout | undefined;
    let lastStallWarningAt = 0;
    const queryStartedAt = Date.now();
    const heartbeatSeconds = this.getPositiveSeconds('heartbeat-seconds', 'heartbeatSeconds', 30);
    const heartbeatMs = heartbeatSeconds > 0 ? Math.max(1000, heartbeatSeconds * 1000) : 0;
    const stallMs = this.getPositiveSeconds('stall-seconds', 'stallSeconds', 180) * 1000;
    const startHeartbeat = () => {
      if (!this.options.progress || heartbeatTimer || heartbeatMs <= 0) return;
      const emitStatus = () => {
        const now = Date.now();
        const records = Number((this.writer as any)?.status?.records ?? this.runtimeParams.featureCount ?? 0);
        const total = Number(this.totalFeatureCount || 0);
        const inFlight = Number(latestMetrics.inFlightRequests ?? 0);
        const totalRequests = Number(latestMetrics.totalRequests ?? 0);
        const retries = Number(latestMetrics.totalRetries ?? 0);
        const backoffMs = Number(latestMetrics.totalBackoffMs ?? 0);
        const lastRequestAt = Number(latestMetrics.lastRequestStartedAt || 0);
        const lastSuccessAt = Number(latestMetrics.lastSuccessAt || 0);
        const lastFailureAt = Number(latestMetrics.lastFailureAt || 0);
        const pct = total > 0 ? ` (${Math.floor((records / total) * 100)}%)` : '';
        const parts = [
          `[heartbeat] records=${records}${total ? `/${total}` : ''}${pct}`,
          `inflight=${Number.isFinite(inFlight) ? inFlight : 0}`,
          `requests=${Number.isFinite(totalRequests) ? totalRequests : 0}`,
          `retries=${Number.isFinite(retries) ? retries : 0}`,
          Number.isFinite(backoffMs) && backoffMs > 0 ? `backoff=${this.formatElapsed(backoffMs)}` : '',
          lastRequestAt ? `lastRequest=${this.formatElapsed(now - lastRequestAt)} ago` : 'lastRequest=never',
          lastSuccessAt ? `lastFetch=${this.formatElapsed(now - lastSuccessAt)} ago` : 'lastFetch=never',
          this.lastWriteAt ? `lastWrite=${this.formatElapsed(now - this.lastWriteAt)} ago` : 'lastWrite=never',
          latestMetrics.oidMode ? `mode=${latestMetrics.oidMode}` : '',
          latestMetrics.currentWindowSize != null ? `window=${latestMetrics.currentWindowSize}` : '',
          latestMetrics.currentChunkSize != null ? `chunk=${latestMetrics.currentChunkSize}` : '',
          `checkpointOid=${this.resumeAfterOid ?? this.resumeState?.lastCompletedOid ?? 'n/a'}`,
        ].filter(Boolean);
        process.stderr.write(parts.join(' ') + '\n');

        const lastUsefulActivityAt = Math.max(lastSuccessAt, this.lastWriteAt, queryStartedAt);
        if (stallMs > 0 && now - lastUsefulActivityAt >= stallMs && now - lastStallWarningAt >= stallMs) {
          lastStallWarningAt = now;
          const failureAge = lastFailureAt ? ` lastFailure=${this.formatElapsed(now - lastFailureAt)} ago` : '';
          const code = latestMetrics.lastCode ? ` code=${latestMetrics.lastCode}` : '';
          const status = latestMetrics.lastStatus ? ` status=${latestMetrics.lastStatus}` : '';
          const message = latestMetrics.lastErrorMessage ? ` message=${String(latestMetrics.lastErrorMessage)}` : '';
          process.stderr.write(
            `[stall] no successful fetch/write for ${this.formatElapsed(now - lastUsefulActivityAt)}; ` +
            `inflight=${Number.isFinite(inFlight) ? inFlight : 0} requests=${Number.isFinite(totalRequests) ? totalRequests : 0}` +
            ` retries=${Number.isFinite(retries) ? retries : 0}${failureAge}${code}${status}${message}\n`
          );
        }
      };
      heartbeatTimer = setInterval(emitStatus, heartbeatMs);
      (heartbeatTimer as any).unref?.();
    };

    let lastRetriesPrinted = 0;
    const wire = (tool: any) => {
      try {
        tool.on('metrics', (m: any) => {
          latestMetrics = { ...latestMetrics, ...(m ?? {}) };
          this.applyAdaptiveOidMetrics(m);
          if (!this.options.progress) return;
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
      if (this.options.progress) {
        try {
          tool.on('failure', (evt: any) => {
            const parts = [
              `[fetch-fail] ${evt?.scope || 'request'} ${evt?.context || ''}`.trim(),
              evt?.attempts ? `attempts=${evt.attempts}` : '',
              evt?.code ? `code=${evt.code}` : '',
              evt?.status ? `status=${evt.status}` : '',
              evt?.retryAfterMs != null ? `retryAfter=${Math.round(Number(evt.retryAfterMs))}ms` : '',
              evt?.hint ? `hint=${evt.hint}` : '',
              evt?.oidMode ? `mode=${evt.oidMode}` : '',
              evt?.currentWindowSize != null ? `window=${evt.currentWindowSize}` : '',
              evt?.currentChunkSize != null ? `chunk=${evt.currentChunkSize}` : '',
              evt?.message ? `message=${evt.message}` : '',
              `checkpointOid=${this.resumeAfterOid ?? 'n/a'}`,
            ].filter(Boolean);
            process.stderr.write(parts.join(' ') + '\n');
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
          this.lastWriteAt = Date.now();
          if (batchMaxOid != null) {
            await this.writer.save();
            this.resumeAfterOid = batchMaxOid;
            await this.recordResumeProgress(batchMaxOid, accepted ?? 0);
            this.lastWriteAt = Date.now();
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
      startHeartbeat();
      try {
        await oids.runQuery();
      } catch (err) {
        if (this._writeError) throw this._writeError;
        if (this._stopRequested && this._stopReason === 'max-records') return;
        if (this._stopRequested && this._stopReason === 'signal') return;
        throw err;
      } finally {
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = undefined;
        }
        this._activeTool = null;
      }
      return;
    };

    return new Promise<void>((resolve, reject) => {
      runTool().then(() => resolve()).catch(reject);
    });
  }
}
