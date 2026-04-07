# esri-query:

### version 1.6.1
Added
- GeoPackage writer now detects geometry-less layers, allowing ArcGIS REST tables to export cleanly (RTREE, bbox, and style metadata skipped automatically).
- Added optional `--out-fields` (`-F`) / YAML `outFields` to request narrower attribute sets; OID field is auto-included for chunk/range safety.
Fixed
- GeoJSON/ESRI JSON/FlatGeobuf writers using the file sink now emit features again when not partitioned (regression from the writer refactor).

### version 1.6.0
Added
- GeoParquet: upgrade to GeoParquet metadata v1.1.0 and align with spec.
  - Geometry column is configurable via `--geometry-column-name` and is set in `primary_column`.
  - File-level `geometry_types` recorded (including `" Z"` when 3D present).
  - Root `bbox` group column (DOUBLE) with optional `zmin`/`zmax` via `--bbox-3d`.
  - `covering.bbox` metadata advertises bbox column paths.
  - Note: tile-based coverings (quadkeys/H3) are postponed to keep outputs lean and spec-focused.
  - Row group size control via `--parquetRowGroupSize`.
- S3 output support:
  - GeoParquet: streaming multipart upload directly to `s3://bucket/key.parquet`.
  - FlatGeobuf: uploads each part to S3 when output is an S3 URL.
  - GeoPackage: writes to local temp and uploads to S3 on close.
  - S3 options via CLI flags (`--s3-acl`, `--s3-storage-class`, `--s3-sse`, `--s3-ssekms-key-id`) or URL params (`?acl=...&storageClass=...&sse=...`).
  - Progress logs print S3 upload successes/failures when `--progress` is used.
Changed
- Removed STAC output (keeps tool focused and spec-tight for GeoParquet).
Docs
- README expanded with S3 usage, URL params, and new GeoParquet options.

Migration notes
- Quadkeys column is now a Parquet LIST<UTF8> (was previously a JSON string in early prototypes). Update consumers accordingly:
  - DuckDB/SQL: `SELECT * FROM parquet_scan('file.parquet') WHERE list_contains(quadkeys, '1203...');`
  - Spark/Arrow: treat `quadkeys` as an array of strings (no JSON parse).
- GeoParquet bbox is a root group column `bbox` with fields (`xmin`,`ymin`,`xmax`,`ymax`[,`zmin`,`zmax`]). Update any readers that previously expected flat `bbox_minx`/`bbox_miny` columns.
- Optional H3 covering requires `h3-js` at runtime (`npm i h3-js`) if enabled via `--h3`/`--h3-res`.
- S3 output requires AWS SDK packages when targeting `s3://` outputs: `npm i @aws-sdk/client-s3 @aws-sdk/lib-storage`.
  - GeoPackage uploads use a local temp file before publishing to S3; ensure available disk space for the full file.

Upgrade tips
- Prefer URL params for S3 options to keep CLI short (e.g., `s3://bucket/key.parquet?storageClass=INTELLIGENT_TIERING`). CLI flags override URL params.
- Use `--parquetRowGroupSize` to improve pruning/statistics on large GeoParquet files (e.g., 65536 rows).
- Use `--bbox-3d` when 3D coordinates are present to include `zmin`/`zmax` in the bbox group for better pruning.

### version 1.5.0
* Major refactor of CLI with Zod schema validation, grouped help output, and YAML/JSON config support.
* Added robust retry logic using Cockatiel (exponential backoff, circuit breaker).
* Integrated Bottleneck for per-host rate limiting.
* New writer system with File, Stdout, GeoPackage (better-sqlite3 + RTree), FlatGeobuf.
* Partitioned NDJSON/GeoJSONSeq output with `--partition` and `--max-file-bytes`.
* Added bbox filtering, `strict-geometry`, and antimeridian-aware options.
* Improved test coverage with Jest and added unit tests for Writer, Stdout, File, and GPKG.
* Updated protobuf schema handling for ESRI PBF format.
* General code cleanup and improved TypeScript typings.

### version 1.3.0
* Add geographic queries
* Allow Garbage Collector for very large queries
* Code cleanup
* Update packages
  * better-sqlite3             11.0.0  →   11.3.0    
  * command-line-args          ^5.2.1  →   ^6.0.0     
  * command-line-usage         ^7.0.1  →   ^7.0.3     
  * protobufjs                 ^7.3.0  →   ^7.4.0     
  * @types/better-sqlite3     ^7.6.10  →  ^7.6.11     
  * ts-jest                   ^29.1.4  →  ^29.2.5     
  * typedoc                  ^0.25.13  →  ^0.26.8   
  * typedoc-plugin-markdown    ^4.0.3  →   ^4.2.9
  * protobufjs                 ^7.3.2  →    ^7.4.0     
  * @types/jest              ^29.5.12  →  ^29.5.13     

### version 1.2.2
* Code cleanup
* Update packages
  * better-sqlite3              9.4.5  →    11.0.0
  * protobufjs                 ^7.2.6  →    ^7.3.0
  * @types/better-sqlite3      ^7.6.9  →   ^7.6.10
  * ts-jest                   ^29.1.2  →   ^29.1.4
  * typedoc                  ^0.25.12  →  ^0.25.13
  * typedoc-plugin-markdown   ^3.17.1  →    ^4.0.3

### version: 1.2.1
* include new documentation

### version: 1.2.0
* Replace sqlite3 with better-sqlite3 and remove a lot of the unneeded async cpde
* Update packages
  * typedoc
  * ts-jest
  * @types/jest
  * protobuf
* Fix scoping issue with setTimeout in esriQuery that caused some skipped features to throw an error
* Fix issue with NULL geometries in GeoJSON (traverseCoords(geometry.coordinates)
* Fix issue with NULL geometries in GPKG (geom = wkx.Geometry.parseGeoJSON(feature.geometry)
