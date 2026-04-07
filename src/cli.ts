#!/usr/bin/env node
// CLI entrypoint for esri-query
import EsriQuery, {EsriQueryOptions} from './index.js';
import commandLineArgs from 'command-line-args';
import { readFileSync } from 'node:fs';
import { extname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { optionDefinitions as sharedOptionDefinitions, jobSchema, parseExtraHeaders, renderHelp } from './cli-options.js';

// ---- CLI-only types
export type CliBaseOptionsType = {
  help: boolean,
  url: string,
  where: string,
  output: string,
  method: 'geographic' | 'default',
  'feature-count': number,
  json: boolean,
  progress: boolean,
  'no-bbox': boolean,
  'dry-run': boolean,
  'print-format'?: 'yaml' | 'json',
  config?: string | string[],
  bbox?: [number, number, number, number] | string | number[];
  partition?: string;
  'max-file-bytes'?: number;
};

export type CliGeoJsonOptionsType = {
  format: 'geojson' | 'geojsonseq' | 'esrijson' | 'flatgeobuf',
  pretty: boolean,
};

export type CliSqlOptionsType = {
  format: 'gpkg',
  output: string,
  'layer-name': string
};

export type CliParquetOptionsType = {
  format: 'geoparquet',
  output: string
};

export type ExtractJob = Partial<CliBaseOptionsType & (CliGeoJsonOptionsType | CliSqlOptionsType | CliParquetOptionsType)> & {
  name?: string;
};

export type CliOptionsType = Partial<CliBaseOptionsType & (CliGeoJsonOptionsType | CliSqlOptionsType | CliParquetOptionsType)>;

// ---- Helpers (CLI-local) ----
function parseConfigFile(filePath: string): unknown {
  const read = (p: string) => readFileSync(p === '-' ? 0 : p, 'utf8');
  const raw = read(filePath);
  const ext = extname(filePath).toLowerCase();
  if (ext === '.yaml' || ext === '.yml' || filePath === '-') return YAML.parse(raw);
  if (ext === '.json') return JSON.parse(raw);
  try { return YAML.parse(raw); } catch {}
  return JSON.parse(raw);
}

function normalizeJobs(doc: unknown): ExtractJob[] {
  if (!doc) return [];
  if (Array.isArray(doc)) return doc as ExtractJob[];
  if (typeof doc === 'object') {
    const o = doc as Record<string, unknown>;
    const sharedOptions = (o.options && typeof o.options === 'object' && !Array.isArray(o.options))
      ? o.options as Record<string, unknown>
      : undefined;
    const mergeSharedOptions = (jobs: unknown[]) => jobs.map(job => ({
      ...(sharedOptions ?? {}),
      ...(job as Record<string, unknown>)
    })) as ExtractJob[];
    if (Array.isArray(o.sources)) return mergeSharedOptions(o.sources);
    if (Array.isArray(o.jobs)) return mergeSharedOptions(o.jobs);
    return [o as ExtractJob];
  }
  return [];
}

function coerceArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function resolveJobsFromOptionsAndFiles(options: CliOptionsType): ExtractJob[] {
  const configPaths = coerceArray(options.config as any);
  const jobsFromFiles: ExtractJob[] = [];
  for (const p of configPaths) {
    try {
      const parsed = parseConfigFile(p);
      const jobs = normalizeJobs(parsed);
      jobs.forEach(j => jobsFromFiles.push(j));
    } catch (e) {
      throw new Error(`Failed to read config "${p}": ${(e as Error).message}`);
    }
  }
  if (jobsFromFiles.length) {
    return jobsFromFiles as ExtractJob[];
  } else {
    const single: ExtractJob = { ...(options as Record<string, unknown>) } as ExtractJob;
    return [single];
  }
}

function validateJobKeys(job: Record<string, unknown>, knownKeys: Set<string>, jobLabel: string): void {
  // Keep support for documented config-only aliases that are not CLI flags.
  const allowedMetaKeys = new Set(['name', 'outFields']);
  const keys = Object.keys(job);
  const unknown = keys.filter(k => !knownKeys.has(k) && !allowedMetaKeys.has(k));
  if (unknown.length) {
    process.stderr.write(`[warn] ${jobLabel}: unknown option key(s): ${unknown.join(', ')}\n`);
  }
}

function printResolvedJobs(resolved: Array<Record<string, unknown>>, format: 'yaml' | 'json' = 'yaml') {
  if (format === 'json') {
    console.log(JSON.stringify({ jobs: resolved }, null, 2));
    return;
  }
  try {
    const doc = YAML.stringify({ jobs: resolved });
    console.log(doc);
  } catch {
    console.log(JSON.stringify({ jobs: resolved }, null, 2));
  }
}

function parseBboxString(s: string): [number, number, number, number] | null {
  const parts = s.split(',').map(v => Number(v.trim()));
  if (parts.length !== 4 || parts.some(n => !Number.isFinite(n))) return null;
  const [xmin, ymin, xmax, ymax] = parts;
  return [xmin, ymin, xmax, ymax];
}

function normalizeBbox(v: unknown): [number, number, number, number] | undefined {
  if (v == null) return undefined;
  if (typeof v === 'string') return parseBboxString(v) ?? undefined;
  if (Array.isArray(v) && v.length === 4) {
    const nums = v.map(n => Number(n));
    if (nums.every(Number.isFinite)) return nums as [number, number, number, number];
  }
  return undefined;
}

const optionDefinitions = sharedOptionDefinitions as any[];

function validateJob(merged: Record<string, unknown>, label: string) {
  const res = jobSchema.safeParse(merged);
  if (!res.success) {
    const issues = res.error.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new Error(`${label}: ${issues}`);
  }
  return res.data as Record<string, unknown>;
}

function normalizeHeadersOption(job: Record<string, unknown>, label: string): Record<string, unknown> {
  const normalized = { ...job };
  const combined = [normalized.header, normalized.headers].filter(v => v != null);
  if (!combined.length) return normalized;
  try {
    const headers = parseExtraHeaders(combined);
    delete normalized.header;
    if (headers) normalized.headers = headers;
    else delete normalized.headers;
    return normalized;
  } catch (e) {
    throw new Error(`${label}: ${(e as Error).message}`);
  }
}

// ---- Run CLI ----
export async function main(argv = process.argv.slice(2)) {
  let options: CliOptionsType = {};

  try {
    const parsed = (commandLineArgs as any)(optionDefinitions, { argv });
    options = (parsed?._all ?? parsed) as CliOptionsType;
  } catch {
    // Show full, grouped help immediately so users see the new aliases (-t, -W, etc.)
    console.log(renderHelp());
    process.exitCode = 2;
    return;
  }

  if ((options as any).help) {
    console.log(renderHelp());
    process.exitCode = 0;
    return;
  }

  let jobs: ExtractJob[];
  try {
    jobs = resolveJobsFromOptionsAndFiles(options);
  } catch (e) {
    process.stderr.write(String((e as Error).message) + '\n');
    process.exitCode = 1;
    return;
  }

  if ((options as any)['dry-run']) {
    const resolved = jobs.map((job: ExtractJob, idx: number) => {
      const merged: CliOptionsType = {
        ...(job as Record<string, unknown>),
        ...(options as Record<string, unknown>)
      } as CliOptionsType;
      delete (merged as any).config;
      const name = (job as ExtractJob).name ?? `job-${idx + 1}`;
      validateJobKeys(merged as Record<string, unknown>, new Set(optionDefinitions.map(o => String(o.name))), name);
      // Coerce/validate with Zod
      const validated = validateJob(normalizeHeadersOption(merged as Record<string, unknown>, name), name);
      return { name, ...validated };
    });
    const fmt: 'yaml' | 'json' = ((options as any)['print-format'] === 'json') ? 'json' : 'yaml';
    printResolvedJobs(resolved, fmt);
    process.exitCode = 0;
    return;
  }

  let totalFeatures = 0;
  const started = Date.now();
  let hadErrors = false;

  for (let idx = 0; idx < jobs.length; idx++) {
    const job: ExtractJob = jobs[idx] as ExtractJob;
    const merged: CliOptionsType = {
      ...(job as Record<string, unknown>),
      ...(options as Record<string, unknown>)
    } as CliOptionsType;
    delete (merged as any).config;
    merged.where = (merged.where ?? '1=1')?.trim() || '1=1';
    const label = (merged as any).output ?? (merged as any).url ?? (merged as any)['layer-name'] ?? (merged as any).where ?? `job-${idx + 1}`;
    if ((options as any).progress) {
      process.stderr.write(`\n[${idx + 1}/${jobs.length}] Starting: ${(job as ExtractJob).name ?? String(label)}\n`);
    }
    // DEBUG removed
    validateJobKeys(merged as Record<string, unknown>, new Set(optionDefinitions.map(o => String(o.name))), String(label));
    // Normalize bbox if provided via CLI string
    if ((merged as any).bbox && typeof (merged as any).bbox === 'string') {
      const parsed = normalizeBbox((merged as any).bbox);
      if (parsed) (merged as any).bbox = parsed;
    }
    // DEBUG removed
    const validatedMerged = validateJob(normalizeHeadersOption(merged as Record<string, unknown>, String(label)), String(label));
    // Early validations
    const fmt = (validatedMerged as any).format;
    const out = (validatedMerged as any).output;
    if ((fmt === 'geoparquet' || fmt === 'gpkg' || fmt === 'flatgeobuf') && !out) {
      throw new Error(`${label}: --output is required for format '${fmt}'.`);
    }
    if ((validatedMerged as any).partition && fmt !== 'geojsonseq') {
      throw new Error(`${label}: --partition requires --format geojsonseq (NDJSON).`);
    }
    if ((validatedMerged as any)['max-file-bytes'] && fmt !== 'geojsonseq') {
      throw new Error(`${label}: --max-file-bytes requires --format geojsonseq (NDJSON).`);
    }
    if (validatedMerged.format === 'flatgeobuf' && typeof validatedMerged.output === 'string' && !validatedMerged.output.endsWith('.fgb')) {
      process.stderr.write(`[warn] ${label}: output extension should be ".fgb" for flatgeobuf format (got "${validatedMerged.output}")\n`);
    }
    if (validatedMerged.format === 'geoparquet' && typeof validatedMerged.output === 'string' &&
        !(validatedMerged.output.endsWith('.parquet') || validatedMerged.output.endsWith('.gpq'))) {
      process.stderr.write(`[warn] ${label}: output extension should be ".parquet" or ".gpq" for geoparquet format (got "${validatedMerged.output}")\n`);
    }
    let Query: EsriQuery | undefined;
    try {
      Query = new EsriQuery(validatedMerged as EsriQueryOptions);
      const result = await Query.start() as any;
      totalFeatures += (result?.featureCount ?? 0);
      if ((options as any).progress) {
        process.stderr.write(
          `[${idx + 1}/${jobs.length}] Completed: ${result?.featureCount ?? 0} features in ${result?.runTime ?? '?'} seconds\n`
        );
      }
    } catch (error) {
      hadErrors = true;
      process.stderr.write(`[${idx + 1}/${jobs.length}] Error: ${(error as Error).message}\n`);
      const snapshot = Query?.getProgressSnapshot?.();
      const committedThisRun = Number(snapshot?.featureCount ?? 0);
      if (committedThisRun > 0) {
        totalFeatures += committedThisRun;
      }
      if (snapshot?.lastCompletedOid != null) {
        const cumulative = Number(snapshot?.checkpointRecordsWritten ?? committedThisRun);
        const statePath = snapshot?.resumeStatePath ?? '(unknown state file)';
        process.stderr.write(
          `[${idx + 1}/${jobs.length}] Resume checkpoint: last completed OID ${snapshot.lastCompletedOid}; committed this run ${committedThisRun}; checkpoint total ${cumulative}; state ${statePath}\n`
        );
      } else if (committedThisRun > 0) {
        process.stderr.write(`[${idx + 1}/${jobs.length}] Partial progress: committed ${committedThisRun} feature(s) before failure\n`);
      }
      process.exitCode = 1;
    }
  }

  if ((options as any).progress) {
    const secs = Math.round((Date.now() - started) / 1000);
    if (hadErrors) {
      process.stderr.write(`\nRun ended with errors. Committed features: ${totalFeatures}. Elapsed: ${secs}s\n`);
    } else {
      process.stderr.write(`\nAll jobs finished. Committed features: ${totalFeatures}. Elapsed: ${secs}s\n`);
    }
  }
  if (process.exitCode === undefined) process.exitCode = 0;
}

const isDirectExecution = Boolean(process.argv[1]) && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  main().catch(err => {
    process.stderr.write(String(err?.message ?? err) + '\n');
    process.exitCode = 1;
  });
}

export default optionDefinitions;
