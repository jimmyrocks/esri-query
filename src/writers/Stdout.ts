import type { Feature, Geometry } from 'geojson';
import type { CliGeoJsonOptionsType, CliBaseOptionsType } from '../cli.js';
import StreamWriter from './StreamWriter.js';

/**
 * Stdout writer: emits to process.stdout.
 * Batching and framing (GeoJSON vs NDJSON) are handled by the base Writer.
 */
export default class Stdout extends StreamWriter {
  declare options: CliBaseOptionsType & CliGeoJsonOptionsType;

  async open(): Promise<void> {
    // Let CLI/config tune base-class debounced batching if desired.
    // (Defaults are set in Writer; override here if options provided.)
    const anyOpts: any = this.options || {};
    if (anyOpts.batch || anyOpts.batchDebounceMs != null || anyOpts.batchMax != null || anyOpts.batchMaxBytes != null) {
      this.enableDebouncedBatching({
        debounceMs: Number.isFinite(anyOpts.batchDebounceMs) ? anyOpts.batchDebounceMs : undefined,
        maxBatch: Number.isFinite(anyOpts.batchMax) ? anyOpts.batchMax : undefined,
        maxBufferBytes: Number.isFinite(anyOpts.batchMaxBytes) ? anyOpts.batchMaxBytes : undefined,
      });
    }

    // Ensure emission mode matches the CLI format
    const fmt = (anyOpts?.format ?? '').toLowerCase();
    if (fmt === 'geojsonseq' || fmt === 'ndjson') {
      this.setEmissionMode('ndjson');
    } else {
      this.setEmissionMode('geojson');
    }

    // Bind to stdout stream
    this.stream = process.stdout as any;
    // Mark open and emit header if needed.
    await this.onOpen();
  }

  async close(): Promise<void> {
    // Base will flush any pending debounced batch and emit footer if needed.
    await this.onClose();
  }

  /**
   * Process one feature: base class updates counters/bbox.
   * Then use base-class emission (which will batch/debounce as configured).
   */
  async writeFeature(line: Feature<Geometry, { [name: string]: any }>): Promise<Feature<Geometry, { [name: string]: any }>> {
    try {
      line = await super.writeFeature(line);
    } catch (e: any) {
      if (e && e.code === 'SKIP_FEATURE') {
        this.status.skipped += 1;
        return line;
      }
      throw e;
    }

    await this.emitFeature(line);
    return line;
  }

  // sinkWrite is provided by StreamWriter
}
