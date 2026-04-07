import { z } from 'zod';

function coerceOptionalPositiveInt(value: unknown): unknown {
  if (value === '' || value == null) return undefined;
  const coerced = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(coerced) ? coerced : value;
}

function coerceOptionalBoolean(value: unknown): unknown {
  if (value === '' || value == null) return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
  }
  return value;
}

export type OptionDef = {
  name: string;
  alias?: string;
  type: any;
  multiple?: boolean;
  description?: string;
  group?: string;
};

export const optionDefinitions: OptionDef[] = [
  { name: 'url', alias: 'u', type: String, description: 'Esri REST service URL', group: 'base' },
  { name: 'where', alias: 'W', type: String, description: 'Where clause', group: 'base' },
  { name: 'bbox', alias: 'x', type: String, description: 'Bounding box (minX,minY,maxX,maxY)', group: 'base' },
  { name: 'out-fields', alias: 'F', type: String, description: 'Comma-separated attribute fields to request (default "*")', group: 'base' },
  { name: 'output', alias: 'o', type: String, description: 'Output file', group: 'base' },
  { name: 'json', type: Boolean, description: 'Force JSON responses (disable PBF)', group: 'base' },
  { name: 'overwrite', alias: 'y', type: Boolean, description: 'Overwrite existing output file(s) when present', group: 'base' },
  { name: 'token', type: String, description: 'ArcGIS token for secured services', group: 'base' },
  { name: 'oid-start', type: Number, description: 'OID strategy: starting slice size (default 250)', group: 'base' },
  { name: 'oid-concurrency', type: Number, description: 'OID strategy: number of parallel slice workers (default 2)', group: 'base' },
  { name: 'oid-field', type: String, description: 'Object ID field override when service metadata is missing or wrong', group: 'base' },
  { name: 'id-list-threshold', type: Number, description: 'Switch to OID range scanning when total exceeds this (default 500000)', group: 'base' },
  { name: 'oid-window', type: Number, description: 'OID range scan initial window size (default 5000)', group: 'base' },
  { name: 'format', alias: 't', type: String, description: 'Output format (geojson, esrijson, geojsonseq, gpkg, flatgeobuf, geoparquet)', group: 'base' },
  { name: 'progress', alias: 'p', type: Boolean, description: 'Show progress', group: 'base' },
  { name: 'max-file-bytes', type: Number, description: 'GeoJSONSeq: roll output into .partNNNN files after this many bytes', group: 'base' },
  { name: 'resume-state', type: String, description: 'Path to a JSON checkpoint file for resumable geojsonseq exports', group: 'base' },
  { name: 'parquetScanRows', alias: 'S', type: Number, description: 'GeoParquet: lookahead rows for schema inference (default 1000)', group: 'base' },
  { name: 'no-bbox', type: Boolean, description: 'Disable per-feature bbox and file-level bbox output', group: 'geometry' },
  { name: 'geometry-column-name', type: String, description: 'GeoParquet: geometry column name (default "geometry")', group: 'geometry' },
  { name: 'bbox-3d', type: Boolean, description: 'GeoParquet: include zmin/zmax in bbox group when 3D is detected (or when forced)', group: 'geometry' },
  { name: 'parquetRowGroupSize', type: Number, description: 'GeoParquet: target row group size (rows) for writer buffering/statistics', group: 'base' },
  { name: 's3-acl', type: String, description: 'S3: canned ACL (e.g., private, public-read, bucket-owner-full-control)', group: 'base' },
  { name: 's3-storage-class', type: String, description: 'S3: storage class (e.g., STANDARD, INTELLIGENT_TIERING, GLACIER)', group: 'base' },
  { name: 's3-sse', type: String, description: 'S3: server-side encryption (AES256 or aws:kms)', group: 'base' },
  { name: 's3-ssekms-key-id', type: String, description: 'S3: KMS key id/arn when using aws:kms', group: 'base' },
  { name: 'dedupe', alias: 'D', type: Boolean, description: 'De-duplicate features by hashing properties+geometry (memory heavy).', group: 'base' },
  { name: 'dedupe-warn-entries', type: Number, description: 'Dedupe: warn when this many unique hashes are held in memory', group: 'base' },
  { name: 'dedupe-max-entries', type: Number, description: 'Dedupe: fail safe after this many unique hashes are held in memory', group: 'base' },
  { name: 'max-records', alias: 'R', type: Number, description: 'Soft cap on number of features to write before terminating', group: 'base' },
  { name: 'on-invalid', alias: 'I', type: String, description: "How to handle invalid/malformed geometries: 'throw' | 'keep' | 'skip'", group: 'base' },
  { name: 'progress-every', alias: 'P', type: Number, description: 'Emit a progress tick every N accepted features (stderr).', group: 'base' },
  { name: 'bbox-wkid', alias: 'K', type: Number, description: 'Spatial reference WKID for the provided --bbox envelope.', group: 'base' },
  { name: 'header', type: String, multiple: true, description: 'Extra request header, repeatable as "Name: value"', group: 'base' },
  { name: 'help', alias: 'h', type: Boolean, description: 'Show this help and exit.', group: 'general' },
  { name: 'config', alias: 'C', type: String, multiple: true, description: 'Path(s) to YAML/JSON config files merging in options and jobs.', group: 'general' },
  { name: 'dry-run', type: Boolean, description: 'Validate inputs and print resolved jobs without querying.', group: 'general' },
  { name: 'print-format', type: String, description: 'Format for --dry-run output (yaml or json).', group: 'general' },
  { name: 'strict-geometry', alias: 'G', type: Boolean, description: 'If false, tolerate malformed geometries instead of throwing.', group: 'geometry' },
  { name: 'antimeridian-aware', alias: 'A', type: Boolean, description: 'Enable dateline-aware bbox handling (WKID 4326).', group: 'geometry' },
].sort((a, b) => a.name.localeCompare(b.name));

export const jobSchema = z.object({
  url: z.string().url(),
  where: z.string(),
  bbox: z.union([
    z.string(),
    z.array(z.coerce.number()).length(4),
  ]).optional(),
  'out-fields': z.union([z.string(), z.array(z.string())]).optional(),
  outFields: z.union([z.string(), z.array(z.string())]).optional(),
  output: z.string().optional(),
  format: z.enum(['geojson', 'esrijson', 'geojsonseq', 'gpkg', 'flatgeobuf', 'geoparquet']).optional(),
  progress: z.boolean().optional(),
  'max-file-bytes': z.preprocess(coerceOptionalPositiveInt, z.number().int().positive().optional()),
  'resume-state': z.string().optional(),
  'max-records': z.preprocess(coerceOptionalPositiveInt, z.number().int().positive().optional()),
  'on-invalid': z.enum(['throw', 'keep', 'skip']).optional(),
  'progress-every': z.preprocess(coerceOptionalPositiveInt, z.number().int().positive().optional()),
  'bbox-wkid': z.preprocess(coerceOptionalPositiveInt, z.number().int().positive().optional()),
  'strict-geometry': z.preprocess(coerceOptionalBoolean, z.boolean().optional()),
  'antimeridian-aware': z.preprocess(coerceOptionalBoolean, z.boolean().optional()),
  dedupe: z.preprocess(coerceOptionalBoolean, z.boolean().optional()),
  'dedupe-warn-entries': z.preprocess(coerceOptionalPositiveInt, z.number().int().positive().optional()),
  'dedupe-max-entries': z.preprocess(coerceOptionalPositiveInt, z.number().int().positive().optional()),
  parquetScanRows: z.preprocess(coerceOptionalPositiveInt, z.number().int().positive().optional()),
  
  'no-bbox': z.preprocess(coerceOptionalBoolean, z.boolean().optional()),
  'geometry-column-name': z.string().optional(),
  'bbox-3d': z.preprocess(coerceOptionalBoolean, z.boolean().optional()),
  
  parquetRowGroupSize: z.preprocess(coerceOptionalPositiveInt, z.number().int().positive().optional()),
  's3-acl': z.string().optional(),
  's3-storage-class': z.string().optional(),
  's3-sse': z.string().optional(),
  's3-ssekms-key-id': z.string().optional(),
  json: z.preprocess(coerceOptionalBoolean, z.boolean().optional()),
  overwrite: z.preprocess(coerceOptionalBoolean, z.boolean().optional()),
  token: z.string().optional(),
  header: z.union([z.string(), z.array(z.string())]).optional(),
  headers: z.union([z.string(), z.array(z.string()), z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))]).optional(),
  'oid-field': z.string().optional(),
  oidField: z.string().optional(),
  'oid-start': z.preprocess(coerceOptionalPositiveInt, z.number().int().positive().optional()),
  'oid-concurrency': z.preprocess(coerceOptionalPositiveInt, z.number().int().positive().optional()),
  'id-list-threshold': z.preprocess(coerceOptionalPositiveInt, z.number().int().positive().optional()),
  'oid-window': z.preprocess(coerceOptionalPositiveInt, z.number().int().positive().optional()),
  config: z.union([z.string(), z.array(z.string())]).optional(),
  'dry-run': z.preprocess(coerceOptionalBoolean, z.boolean().optional()),
  'print-format': z.enum(['yaml', 'json']).optional(),
});

export type CliBaseOptionsType = {
  url: string;
  where: string;
  bbox?: string | [number, number, number, number];
  'out-fields'?: string | string[];
  outFields?: string | string[];
  output?: string;
  format?: 'geojson' | 'esrijson' | 'geojsonseq' | 'gpkg' | 'flatgeobuf' | 'geoparquet';
  progress?: boolean;
  'max-file-bytes'?: number;
  'resume-state'?: string;
  'max-records'?: number;
  'on-invalid'?: 'throw' | 'keep' | 'skip';
  'progress-every'?: number;
  'bbox-wkid'?: number;
  'oid-field'?: string;
  oidField?: string;
  help?: boolean;
  header?: string | string[];
  headers?: string | string[] | Record<string, string | number | boolean>;
  config?: string | string[];
  'dry-run'?: boolean;
  'print-format'?: 'yaml' | 'json';
  'strict-geometry'?: boolean;
  'antimeridian-aware'?: boolean;
  'dedupe-warn-entries'?: number;
  'dedupe-max-entries'?: number;
};

export function parseExtraHeaders(value: unknown): Record<string, string> | undefined {
  const parsed: Record<string, string> = {};

  const addEntry = (name: string, headerValue: unknown) => {
    const key = name.trim();
    if (!key) throw new Error('Header names must not be empty.');
    if (headerValue == null) throw new Error(`Header "${key}" is missing a value.`);
    parsed[key] = String(headerValue).trim();
  };

  const addStringHeader = (entry: string) => {
    const text = entry.trim();
    if (!text) return;
    const idx = text.indexOf(':');
    if (idx <= 0) {
      throw new Error(`Invalid header "${entry}". Expected "Name: value".`);
    }
    addEntry(text.slice(0, idx), text.slice(idx + 1));
  };

  const visit = (input: unknown) => {
    if (input == null || input === '') return;
    if (Array.isArray(input)) {
      for (const item of input) visit(item);
      return;
    }
    if (typeof input === 'string') {
      addStringHeader(input);
      return;
    }
    if (typeof input === 'object') {
      for (const [name, headerValue] of Object.entries(input as Record<string, unknown>)) {
        addEntry(name, headerValue);
      }
      return;
    }
    throw new Error(`Unsupported header value: ${String(input)}`);
  };

  visit(value);
  return Object.keys(parsed).length ? parsed : undefined;
}

export function renderHelp(): string {
  const groups: Record<string, { title: string; keys: string[] }> = {
    general: { title: 'General Options', keys: [] },
    base: { title: 'Query & Output', keys: [] },
    geometry: { title: 'Geometry Options', keys: [] },
  };

  for (const opt of optionDefinitions) {
    const g = (opt.group && (groups as any)[opt.group]) ? (opt.group as string) : 'base';
    groups[g].keys.push(opt.name);
  }

  const pad = (s: string, n: number) => s + ' '.repeat(Math.max(1, n - s.length));
  const lines: string[] = [];
  lines.push('Usage: esri-query [options]\n');

  const describe = (name: string) => optionDefinitions.find(o => o.name === name)!;
  const renderGroup = (id: keyof typeof groups) => {
    const { title, keys } = groups[id];
    if (!keys.length) return;
    lines.push(title + ':');
    const rows = keys
      .map(k => describe(k))
      .sort((a, b) => (a.alias || '').localeCompare(b.alias || ''))
      .map(o => {
        const flags = [o.alias ? `-${o.alias}` : null, `--${o.name}`].filter(Boolean).join(', ');
        return `  ${pad(flags, 22)} ${o.description || ''}`;
      });
    lines.push(...rows, '');
  };

  renderGroup('general');
  renderGroup('base');
  renderGroup('geometry');

  lines.push('Examples:');
  lines.push('  # Basic GeoJSONSeq export with bbox and progress');
  lines.push('  esri-query -u URL -W "1=1" -x "-123.5,47.5,-122.8,48.0" -K 4326 -t geojsonseq -o out.geojsonl -P 10000');
  lines.push('');
  lines.push('  # Robust run with skip policy and safety cap');
  lines.push('  esri-query -u URL -W "1=1" -t geojson -o layer.geojson -I skip -R 5000000');
  lines.push('');
  lines.push('  # Send a session cookie or any other custom header');
  lines.push('  esri-query -u URL -W "1=1" --header "Cookie: SESSION=abc123" -t geojson -o out.geojson');
  lines.push('');
  lines.push('  # Resume into rolled GeoJSONSeq parts instead of one giant file');
  lines.push('  esri-query -u URL -W "1=1" -t geojsonseq -o out.geojsonl --max-file-bytes 500000000 --resume-state out.resume.json');
  lines.push('');
  lines.push('  # Write GeoParquet (columnar) with required output path');
  lines.push('  esri-query -u URL -W "1=1" -t geoparquet -o data.parquet');
  lines.push('');
  lines.push('  # Validate config and print the resolved job set');
  lines.push('  esri-query --dry-run --print-format json -C config.yaml');
  lines.push('');
  lines.push('Config (YAML) example:');
  lines.push('  # config.yaml');
  lines.push('  options:');
  lines.push('    progress: true');
  lines.push('    on-invalid: skip');
  lines.push('    max-records: 5000000');
  lines.push('    progress-every: 10000');
  lines.push('    antimeridian-aware: true');
  lines.push('    strict-geometry: false');
  lines.push('  jobs:');
  lines.push('    - name: mylayer');
  lines.push('      url: https://example.com/FeatureServer/0');
  lines.push('      where: 1=1');
  lines.push('      bbox: [-123.5, 47.5, -122.8, 48.0]');
  lines.push('      bbox-wkid: 4326');
  lines.push('      format: geojsonseq');
  lines.push('      output: out.geojsonl');
  lines.push('');

  return lines.join('\n');
}
