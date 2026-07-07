## Overview

esri-query is a lean, resilient extractor for ArcGIS REST Feature/Map Services. It favors a robust OID-chunk strategy (with automatic range scan fallback) and streams results to common geospatial formats:

- GeoJSON / GeoJSONSeq (NDJSON)
- GeoPackage (GPKG)
- FlatGeobuf (FGB)
- GeoParquet

Under the hood it uses proven libraries for flow control and resilience (Bottleneck, Cockatiel), and a custom PBF decoder focused on correctness and speed.

Highlights:
- OID-chunk by default (fast, duplicate-free, order independent)
- Parallel slice fetching with adaptive sizing
- Optional PBF with robust fallback to JSON
- Streaming writers with backpressure
- Token support for secured services
- Custom request headers, including `Cookie`

## Install

Build and run from source:

```
npm install
npm run build
```

Runtime requirements:
- Node.js 22 or newer.

Use the CLI directly:

```
node ./dist/cli.js --help
```

Or link globally during development:

```
npm link
esri-query --help
```

## Quick Start

Export to GeoJSONSeq (NDJSON):

```
esri-query -u <layer-url> -W "1=1" -t geojsonseq -o out.geojsonl -p
```

Write a GeoPackage:

```
esri-query -u <layer-url> -W "1=1" -t gpkg -o data.gpkg -p
```

Force JSON (disable PBF) when debugging:

```
esri-query -u <layer-url> -W "1=1" --json -t gpkg -o data.gpkg
```

Use a token for secured services:

```
esri-query -u <layer-url> -W "1=1" --token "$ARCGIS_TOKEN" -t geoparquet -o data.parquet
```

Use a session cookie or other custom header:

```
esri-query -u <layer-url> -W "1=1" --header "Cookie: SESSION=abc123" -t geojson -o out.geojson
```

If your service is secured by cookies, pass the cookie back as a `Cookie` request header.

Resume a long-running NDJSON/geojsonseq export after refreshing an expiring cookie:

```bash
esri-query \
  -u <layer-url> \
  -W "1=1" \
  -t geojsonseq \
  -o out.geojsonl \
  --resume-state out.resume.json \
  --header "Cookie: SESSION=abc123"
```

If the cookie expires mid-run, update the `Cookie` header and rerun the same command. `esri-query` will read `out.resume.json`, trim the active output back to the last saved checkpoint if needed, and continue after the last committed OID.

Resume also works for GeoPackage exports:

```bash
esri-query \
  -u <layer-url> \
  -W "1=1" \
  -t gpkg \
  -o out.gpkg \
  --resume-state out.resume.json
```

GPKG resume keeps a checkpoint table (`esri_query_resume`) inside the output file itself, updated in the same SQLite transaction as each batch of features. That means the checkpoint can never disagree with the data on disk — even a hard kill (`kill -9`, power loss, OOM) leaves the file resumable with no duplicate or torn rows. On rerun, the in-file checkpoint is the authority; the sidecar JSON is kept for identity validation (URL, where clause, bbox, fields) and operator visibility. `--max-file-bytes` and `s3://` outputs are not supported with GPKG resume.

### Riding out server outages automatically

Add `--wait-for-server` and the job stops needing a human to rerun it. When the server goes out mid-run (or is already down at startup), the job checkpoints, polls the service with capped exponential backoff (30s up to 15min), and re-enters the resume path once the server answers again:

```bash
esri-query \
  -u <layer-url> \
  -W "1=1" \
  -t gpkg \
  -o out.gpkg \
  --resume-state out.resume.json \
  --wait-for-server
```

Details worth knowing:

- Requires `--resume-state` — waiting is only an availability convenience; durability always comes from the checkpoint. Killing the process while it waits loses nothing.
- Only fetch-phase failures are retried. Configuration and validation errors (bad resume state, unsupported options, writer errors like a full disk) fail immediately.
- While waiting, the sidecar JSON gets `waitingSince` and `lastError` fields so anything watching the state file can see why the job is idle.
- `--wait-max-seconds N` caps cumulative waiting without forward progress (default: wait forever). `--wait-max-attempts N` gives up after N consecutive resume attempts that fail against a *responsive* server without committing anything new (default 20) — that pattern usually means the problem is not an outage.
- Any forward progress resets both budgets, so a flaky server that keeps dropping mid-run can still grind through a large export overnight.

If you do not want one giant NDJSON file, add `--max-file-bytes` to roll output into `out.part0000.geojsonl`, `out.part0001.geojsonl`, and so on:

```bash
esri-query \
  -u <layer-url> \
  -W "1=1" \
  -t geojsonseq \
  -o out.geojsonl \
  --max-file-bytes 500000000 \
  --resume-state out.resume.json \
  --header "Cookie: SESSION=abc123"
```

In rolled-output mode, resume will continue in the current `.partNNNN` file or the next one as needed, and it will truncate the active part back to the checkpointed byte count before appending. That avoids duplicate NDJSON rows after crashes.

If you already have an older single-file `resume.json`, turning on `--max-file-bytes` will migrate the checkpointed portion of `out.geojsonl` into `out.part0000.geojsonl` and continue from there.

If resume mode says the object ID field is unavailable, supply it explicitly with `--oid-field`:

```bash
esri-query \
  -u <layer-url> \
  -W "1=1" \
  -t geojsonseq \
  -o out.geojsonl \
  --resume-state out.resume.json \
  --oid-field OBJECTID \
  --header "Cookie: SESSION=abc123"
```

After a failure:
1. Do not delete the existing output file(s) or `out.resume.json`.
2. If the session expired, replace the cookie value in `--header "Cookie: ..."` or in your YAML `headers.Cookie`.
3. Rerun the same job with the same `--output` and `--resume-state` paths.
4. Check the error output for the resume checkpoint line. It prints the last committed OID and the checkpoint file path.

Example rerun with a new cookie:

```bash
esri-query \
  -u <layer-url> \
  -W "1=1" \
  -t geojsonseq \
  -o out.geojsonl \
  --resume-state out.resume.json \
  --header "Cookie: SESSION=new-cookie-value"
```

S3 output (GeoParquet, FlatGeobuf):

```
esri-query -u <layer-url> -W "1=1" -t geoparquet -o s3://my-bucket/path/data.parquet -p
```

Notes:
- Install AWS SDK deps: `npm i @aws-sdk/client-s3 @aws-sdk/lib-storage`.
- Configure AWS via env (`AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`).
- For S3-compatible endpoints (MinIO, etc.), set `AWS_S3_ENDPOINT` and `AWS_S3_FORCE_PATH_STYLE=1`.
- FlatGeobuf writes partitioned parts; `-o s3://bucket/prefix/` uploads part objects to that prefix.
- Optional flags: `--s3-acl` (private, public-read, bucket-owner-full-control), `--s3-storage-class` (STANDARD, INTELLIGENT_TIERING, GLACIER, etc.), `--s3-sse` (AES256 or aws:kms), `--s3-ssekms-key-id` (when using KMS).
 - URL params also work to keep the CLI small:
   - `s3://bucket/key.parquet?acl=public-read&storageClass=INTELLIGENT_TIERING&sse=AES256`
   - CLI flags override URL params when both are provided.

You can also set these in YAML using the equivalent option keys (e.g., `s3-acl: private`).
 - To avoid many flags, you can encode S3 options in the URL query:
   - `s3://bucket/key.parquet?acl=public-read&storageClass=INTELLIGENT_TIERING&sse=AES256`
   - `s3://bucket/key.gpkg?sse=aws:kms&ssekmsKeyId=arn:aws:kms:...`
   URL params take effect unless overridden by CLI flags.
 - You can also put these options in a YAML config via `--config` to keep CLI short.

## Options Reference (CLI and YAML)

All options are available on the command line and in YAML/JSON config files. CLI flags map 1:1 to YAML keys (kebab-case stays kebab-case).

Required:
- `--url, -u` (string): ArcGIS layer URL.
- `--where, -W` (string): Where clause (e.g., `1=1`).

 Output:
- `--format, -t` (geojson | esrijson | geojsonseq | gpkg | flatgeobuf | geoparquet)
- `--output, -o` (path or s3 URL like `s3://bucket/key`)
- `--overwrite, -y` (bool): Overwrite existing files.

Query behavior:
- `--json` (bool): Force JSON; disables PBF.
- `--token` (string): ArcGIS token for secured services.
- `--header, -H` (string, repeatable): Extra request header in `Name: value` form. Use `Cookie: ...` for cookie-authenticated services.
- `--max-file-bytes` (number): For `geojsonseq`, roll output into `name.partNNNN.geojsonl` files after this many bytes.
- `--oid-field` (string): Object ID field override when the service metadata is missing or wrong.
- `--resume-state` (string): JSON checkpoint file for resumable `geojsonseq` exports.
- `--bbox, -x` (minX,minY,maxX,maxY) and `--bbox-wkid, -K` (WKID) for optional geometry filter.
- `--out-fields, -F` (string): Comma-separated attribute fields to request (defaults to `*`).
- `--progress, -p` (bool): Show progress, ETA, retries/backoff.
- `--heartbeat-seconds` (number): With `--progress`, emit a long-run heartbeat every N seconds (default 30; `0` disables).
- `--stall-seconds` (number): With `--progress`, warn after N seconds without a successful fetch/write (default 180; `0` disables).
- `--progress-every, -P` (number): Emit progress tick every N accepted features.
- `--max-records, -R` (number): Soft cap on accepted features.
- `--on-invalid, -I` (throw | keep | skip): Handling for malformed geometry.
- `--strict-geometry, -G` (bool): If false, tolerate malformed geometries.
- `--antimeridian-aware, -A` (bool): Enable dateline-aware bbox when WKID 4326.
- `--dedupe, -D` (bool): De-duplicate by hashing (memory heavy; off by default). The reader now warns and fails safe before the hash set grows without bound.
- `--dedupe-warn-entries` (number): Dedupe warning threshold for unique hashes held in memory.
- `--dedupe-max-entries` (number): Dedupe guardrail; fail safe after this many unique hashes are held in memory.

OID strategy knobs:
- `--oid-start` (number): Starting slice size (default 250).
- `--oid-concurrency` (number): Parallel slice workers (default 2).
- `--id-list-threshold` (number): Switch to OID range scan when total exceeds this (default 500000).
- `--oid-window` (number): Initial OID range scan window size (default 1000).

GeoParquet:
- `--parquetScanRows, -S` (number): Schema lookahead rows (default 1000).
- `--no-bbox` (bool): Disable per-feature bbox columns and file-level bbox metadata.
- `--geometry-column-name` (string): Geometry column name (default `geometry`).
- `--bbox-3d` (bool): Include `zmin`/`zmax` fields in the `bbox` group when 3D is detected (or force on).
- `--parquetRowGroupSize` (number): Target row group size in rows (improves page/row-group stats and pruning).

Config files:
- `--config, -C` (path[, path...]): One or more YAML/JSON files; merged with CLI options.

YAML example:

```
options:
  progress: true
  json: false
  token: ${ARCGIS_TOKEN}
  headers:
    Cookie: SESSION=abc123
    X-Requested-With: esri-query
  max-file-bytes: 500000000
  resume-state: out.resume.json
  oid-start: 250
  oid-concurrency: 2
  id-list-threshold: 500000
  oid-window: 1000
jobs:
  - name: parcels
    url: https://example.com/FeatureServer/0
    where: 1=1
    format: gpkg
    output: out.gpkg
```

## How It Works

- OID-chunk by default: fetch objectIds, then fetch features in adaptive slices; small parallelism (default 2) for speed without overwhelming servers.
- Range scan fallback: for massive layers, skip the ID list; iterate OID ranges by min/max with adaptive window size.
- Flow control & resilience: Bottleneck per-host limiter; Cockatiel retry policy + circuit breaker; timeout and backoff with jitter.
- PBF or JSON: PBF is used when reliable; JSON is available via `--json`. The PBF decoder supports dictionary-encoded attributes and camelCase oneofs.
- Writers: stream with backpressure; GeoParquet infers schema (lookahead) and stores geometry as WKB.

## Examples

FlatGeobuf:

```
esri-query -u <layer-url> -W "1=1" -t flatgeobuf -o out.fgb -p
```

GeoParquet:

```
esri-query -u <layer-url> -W "1=1" -t geoparquet -o out.parquet -p
```

BBox filter:

```
esri-query -u <layer-url> -W "1=1" -x "-123.5,47.5,-122.8,48.0" -K 4326 -t geojsonseq -o out.geojsonl
```

## Debugging

- `DEBUG_ESRI_QUERY=1`: verbose request/retry logs.
- `DEBUG_ESRI_QUERY_HEADERS=1`: log headers.
- `--fetch-log fetch.jsonl`: write one JSON record per HTTP attempt with URL, status, ArcGIS error payload, and fallback path.
- `DEBUG_ESRI_PBF=1`: one-time PBF field/palette/attribute sample.
- `ESRIQ_PBF_FORCE_GC=1`: opt-in manual GC after a full PBF decode when running with `node --expose-gc`; intended for debugging or constrained-memory runs, not normal throughput.

## Notes & Tips

- Keep `outFields` narrow when possible (set `--out-fields` or YAML `outFields` / `out-fields`). The OID field is auto-included when a narrow list is used.
- For heavy layers, increase `--oid-concurrency` cautiously; respect server limits.
- Use `--json` on finicky hosts; you can also force JSON via env for specific hosts if needed.
- Use `--dry-run` with `--print-format json` to validate configs before long exports.

## New Options & Behavior

- `--json`: Force JSON responses (disables PBF). Useful for debugging or services that misreport PBF support.
- `--fetch-log`: Persist per-request JSONL diagnostics including ArcGIS error messages and fallback behavior.
- `--overwrite` (`-y`): Overwrite existing output files. Applies to GPKG, GeoParquet, FlatGeobuf, and text writers.
- `--parquetScanRows`: GeoParquet schema lookahead rows (default 1000) to infer column types (numbers/booleans/timestamps).
- `--dedupe`: Opt-in feature de-duplication by hashing. Beware of memory on very large layers.
- `--dedupe-warn-entries` / `--dedupe-max-entries`: Tune the in-memory dedupe guardrails when `--dedupe` is enabled.
- `--token`: ArcGIS token for secured services (added to all requests).
- `--header`, `-H`: Add repeatable custom request headers such as `Cookie: SESSION=abc123`.
- `--max-file-bytes`: For `geojsonseq`, roll output into `name.partNNNN.geojsonl` files instead of one large NDJSON file.
- `--resume-state`: Persist resumable-export progress in a sidecar JSON file. Supported for `geojsonseq` and `gpkg`. Reruns continue from the last checkpointed OID; geojsonseq trims the active output file or part before appending, while gpkg uses an in-file checkpoint table committed transactionally with each batch.
- `--wait-for-server`: Ride out server outages without human intervention: checkpoint, poll the service with capped backoff, and resume automatically. Requires `--resume-state`.
- `--wait-max-seconds`: Give up waiting after this many cumulative seconds without forward progress (default: wait forever).
- `--wait-max-attempts`: Give up after this many consecutive resume attempts that make no progress against a responsive server (default 20).
- `--out-fields` (`-F`): Request only selected attributes (`name,type,status`) instead of `*`.
- `--oid-start`: Starting slice size for OID chunking (default 250). Accepts YAML/JSON config.
- `--oid-concurrency`: Number of parallel OID slice workers (default 2). Accepts YAML/JSON config.
- `--id-list-threshold`: If `totalCount` exceeds this, switch to OID range scanning (default 500000). Accepts YAML/JSON config.
- `--oid-window`: Initial OID range scan window (default 1000). Accepts YAML/JSON config.

Other improvements:
- PBF decoding handles dictionary-encoded attributes and protobufjs camelCase oneofs (e.g., `uintValue`).
- Uses OID-chunk strategy by default (most reliable). Offset/geographic pagination support has been removed.
- Enhanced `--progress` shows periodic rate, ETA, retry/backoff snapshots, and long-run heartbeat/stall diagnostics.

Debugging:
- `DEBUG_ESRI_QUERY=1` for verbose request/retry info.
- `DEBUG_ESRI_PBF=1` to print one-time PBF field/palette/attribute samples.
- `ESRIQ_PBF_FORCE_GC=1` to opt into a single post-decode manual GC when running with `--expose-gc`.

## FlatGeobuf Example

Specify `--format flatgeobuf` with an output file ending in `.fgb` to output partitioned FlatGeobuf files (e.g., `.part0.fgb`, `.part1.fgb`, etc.). If the output path is a directory, files will be written there.

```bash
npm run start -- \
--url "https://sampleserver6.arcgisonline.com/arcgis/rest/services/LocalGovernment/Recreation/FeatureServer/2" \
--format flatgeobuf \
--output ./output.fgb
```

Note that `.buf` is treated as a directory unless `.fgb` is used.

## GeoParquet Example

Specify `--format geoparquet` with an output file ending in `.parquet` to output GeoParquet files. If the output path is a directory, partitioned `.parquet` files will be written there (e.g., `.part0.parquet`, `.part1.parquet`).

```bash
npm run start -- \
--url "https://sampleserver6.arcgisonline.com/arcgis/rest/services/LocalGovernment/Recreation/FeatureServer/2" \
--format geoparquet \
--output ./output.parquet
```

Note that `.parquet` is required as the file extension for GeoParquet output.

## Bounding Box Filter Example

Query features within a bounding box and specify spatial reference:

```bash
npm run start -- \
--url "https://sampleserver6.arcgisonline.com/arcgis/rest/services/LocalGovernment/Recreation/FeatureServer/2" \
--bbox -123.5,47.5,-122.8,48.0 \
--bbox-wkid 4326
```

## Environment Variables

The tool supports the following environment variables for debugging and troubleshooting:

- `DEBUG_ESRI_QUERY`: Prints verbose debug information for requests, retries, headers, and more.
- `DEBUG_ESRI_QUERY_HEADERS`: Logs request and response headers.
- `ESRIQ_PBF_FORCE_GC`: Opts into a single post-decode manual GC for PBF decoding when `global.gc()` is exposed.
- `NODE_DEBUG=esri-query`: An alternate Node debug namespace for low-level logging.

These can be combined with `npm run start` or `node` commands to help diagnose issues.

Example usage with `DEBUG_ESRI_QUERY` enabled:

```bash
DEBUG_ESRI_QUERY=1 npm run start -- --url "https://sampleserver6.arcgisonline.com/arcgis/rest/services/LocalGovernment/Recreation/FeatureServer/2"
```
