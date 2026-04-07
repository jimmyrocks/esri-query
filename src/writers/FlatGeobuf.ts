/**
 * FlatGeobuf writer (robust, low-RAM) integrated with Writer's debounced batching.
 *
 * Behavior
 *  - Accumulates features via the base-class batch queue (debounced / size-capped).
 *  - On each batch flush, serializes a FeatureCollection to FlatGeobuf and writes
 *    a standalone `.fgb` *part* file:
 *      - If output is a directory:   <dir>/<name>.part{N}.fgb
 *      - If output is a file .fgb:   <dir>/<fileBase>.part{N}.fgb
 *
 * Notes
 *  - Memory stays bounded by batch thresholds (feature count and approximate bytes).
 *  - Each part is independently valid and crash-safe.
 *  - This writer intentionally sets emission mode to 'none' (doesn't use text framing).
 */

import type { Feature, Geometry } from 'geojson';
import Writer from './Writer.js';
import { stat as fsStat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { parseS3Url, putS3Object } from '../helpers/s3.js';

export type FlatGeobufOptions = {
  /** File path ending with .fgb OR a directory path */
  output: string;
  /** Max features per part (default 100_000). Mapped to Writer's batch max. */
  fgbMaxFeatures?: number;
  /** Approximate JSON-bytes buffer cap per part (default ~64MB). Mapped to Writer's batch bytes. */
  fgbMaxBytes?: number;
  /** Optional override for SRID; otherwise taken from sourceInfo. */
  srid?: number;
  /** Logical layer name used in filenames when output is a directory. */
  name?: string;
};

export default class FlatGeobufWriter extends Writer {
  private partIndex = 0;
  private basePath: string;
  private s3Target: { bucket: string; keyPrefix: string } | null = null;
  private sridOverride?: number;
  private isDirectory = false;
  private baseName = 'part';

  constructor(options: any & FlatGeobufOptions, sourceInfo?: any) {
    super(options, sourceInfo);

    this.basePath = options.output;
    this.sridOverride = options.srid;
    if (typeof options.name === 'string' && options.name.trim()) {
      this.baseName = options.name.trim();
    }

    // This sink doesn't use text framing.
    this.setEmissionMode('none');

    // Hook up debounced batching via the base class.
    // - fgbMaxFeatures => batch count cap (default 100k)
    // - fgbMaxBytes    => approximate JSON size (default ~64MB)
    const maxBatch = Math.max(1, Number(options.fgbMaxFeatures ?? 100_000));
    const maxBytes = Math.max(1024, Number(options.fgbMaxBytes ?? (64 << 20))); // ~64MB
    this.enableDebouncedBatching({
      debounceMs: 250,
      maxBatch,
      maxBufferBytes: maxBytes,
    });
  }

  /** We don't use string writes in this sink. */
  protected async sinkWrite(_payload: string): Promise<void> {
    // No-op. If this is ever called, it's a bug in a subclass or mode choice.
    return;
  }

  async open(): Promise<void> {
    const { mkdir, stat } = await import('node:fs/promises');
    const { dirname, extname } = await import('node:path');

    // Decide whether output is a file (ends with .fgb) or a directory
    const s3 = parseS3Url(this.basePath);
    if (s3) {
      // For s3, treat outputs that end with .fgb as single object; otherwise as a prefix (directory)
      this.s3Target = { bucket: s3.bucket, keyPrefix: s3.key };
      this.isDirectory = !this.basePath.endsWith('.fgb');
    } else {
      const ext = extname(this.basePath);
      this.isDirectory = ext !== '.fgb';
    }

    if (!this.s3Target) {
      try {
        const st = await stat(this.basePath).catch((): null => null);
        if (!st) {
          if (this.isDirectory) {
            await mkdir(this.basePath, { recursive: true });
          } else {
            await mkdir(dirname(this.basePath), { recursive: true });
          }
        }
      } catch (err: any) {
        throw new Error(
          `FlatGeobufWriter: unable to prepare output path '${this.basePath}': ${err?.message || err}`
        );
      }

      // If single-file .fgb and it exists, respect --overwrite flag
      if (!this.isDirectory && existsSync(this.basePath) && !(this.options as any).overwrite) {
        throw new Error(`Output already exists: ${this.basePath}. Use --overwrite to replace it.`);
      }
    }

    // Mark as open using the base helper.
    await this.onOpen();
  }

  async close(): Promise<void> {
    // Ensure any queued features are flushed by the base helper (calls onFlushBatch).
    await this.onClose();
  }

  /** Compute the SRID to embed in FGB. */
  private pickSrid(): number {
    const candidates = [
      this.sridOverride,
      (this.sourceInfo as any)?.outputWkid,
      (this.options as any)?.outSR,
      (this.options as any)?.['outSR'],
      (this.sourceInfo as any)?.spatialReference?.wkid,
      (this.sourceInfo as any)?.extent?.spatialReference?.wkid,
      (this.sourceInfo as any)?.extent?.SpatialReference?.wkid,
      4326,
    ];
    for (const c of candidates) {
      const srid = Number(c);
      if (Number.isFinite(srid) && srid > 0) return srid;
    }
    return 4326;
  }

  /** Where to write the next part. */
  private async computeOutPath(): Promise<string> {
    const { join, dirname, basename, extname } = await import('node:path');
    if (this.s3Target) {
      const keyPrefix = this.s3Target.keyPrefix?.replace(/\/*$/, '') || '';
      if (this.isDirectory) {
        const base = this.baseName;
        return `s3://${this.s3Target.bucket}/${keyPrefix ? keyPrefix + '/' : ''}${base}.part${this.partIndex}.fgb`;
      } else {
        const base = basename(this.basePath, extname(this.basePath) || '.fgb');
        const keyBase = keyPrefix ? keyPrefix : base + `.part${this.partIndex}.fgb`;
        // For single-file target, still emit .partN objects next to the target key's prefix
        return `s3://${this.s3Target.bucket}/${keyPrefix ? dirname(keyPrefix) + '/' : ''}${base}.part${this.partIndex}.fgb`;
      }
    } else {
      if (this.isDirectory) {
        // directory/ -> directory/<baseName>.partN.fgb
        return join(this.basePath, `${this.baseName}.part${this.partIndex}.fgb`);
      }
      // file.fgb -> file.partN.fgb in same dir
      const dir = dirname(this.basePath);
      const base = basename(this.basePath, extname(this.basePath) || '.fgb');
      return join(dir, `${base}.part${this.partIndex}.fgb`);
    }
  }

  /**
   * Called by the base writer whenever a debounced batch flushes
   * (or when close/save forces a flush). We serialize and write an entire
   * part as a standalone .fgb.
   */
  protected async onFlushBatch(features: Feature[]): Promise<void> {
    if (!features.length) return;

    // Build FeatureCollection for this batch
    const collection = { type: 'FeatureCollection', features } as any;

    // Serialize to FlatGeobuf
    let bytes: Uint8Array;
    try {
      const { geojson } = await import('flatgeobuf');
      bytes = geojson.serialize(collection, this.pickSrid());
    } catch (err: any) {
      throw new Error(
        `FlatGeobufWriter: serialize failed on part ${this.partIndex}: ${err?.message || err}`
      );
    }

    // Write to FS or S3
    const outPath = await this.computeOutPath();
    const s3 = parseS3Url(outPath);
    if (s3) {
      try {
        const p = s3.params || {};
        await putS3Object({
          bucket: s3.bucket,
          key: s3.key,
          bytes,
          contentType: 'application/octet-stream',
          acl: (this.options as any)['s3-acl'] ?? p.acl,
          storageClass: (this.options as any)['s3-storage-class'] ?? p.storageClass,
          sse: (this.options as any)['s3-sse'] ?? p.sse,
          ssekmsKeyId: (this.options as any)['s3-ssekms-key-id'] ?? p.ssekmsKeyId ?? p.sseKmsKeyId ?? p.kmsKeyId,
        });
        if ((this.options as any).progress) {
          process.stderr.write(`[s3] Uploaded FGB part to s3://${s3.bucket}/${s3.key}\n`);
        }
      } catch (err: any) {
        throw new Error(`FlatGeobufWriter: S3 upload failed for '${outPath}': ${err?.message || err}`);
      }
    } else {
      try {
        const { writeFile } = await import('node:fs/promises');
        await writeFile(outPath, bytes);
      } catch (err: any) {
        throw new Error(
          `FlatGeobufWriter: write failed for '${outPath}': ${err?.message || err}`
        );
      }
    }

    this.partIndex += 1;
  }
}
