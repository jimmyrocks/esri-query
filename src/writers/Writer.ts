import { CliOptionsType } from '../cli.js';
import type { EsriFeatureLayerType } from '../helpers/esri-rest-types.js';
import type { Feature, Geometry } from 'geojson';

export class SkipFeatureError extends Error { constructor(msg = 'skip feature') { super(msg); this.name = 'SkipFeatureError'; (this as any).code = 'SKIP_FEATURE'; } }

function firstDefined<T>(...values: Array<T | undefined>): T | undefined {
    return values.find((value): value is T => value !== undefined);
}

// Exclude GeometryCollection for bbox generation (handled by caller)
type GeometryExceptCollection = Exclude<Geometry, GeoJSON.GeometryCollection>;

export interface SourceInfo extends EsriFeatureLayerType {
    totalFeatureCount?: number;
}

export interface WriterStatus {
    canWrite: boolean;
    records: number;
    invalid: number; // features with invalid/malformed geometry
    skipped: number; // features deliberately skipped by higher layers
    // Running overall bbox across all written features
    bbox: [number, number, number, number];
    antimeridianUsed?: boolean; // true if a wrapped span would be tighter (WKID 4326)
    terminated?: boolean;       // set when maxRecords reached
}

/**
 * Base writer with minimal state and no buffering. Subclasses should stream
 * directly to their sinks and must respect backpressure (see Stdout/File).
 */
export default abstract class Writer {
    public options: CliOptionsType;
    public sourceInfo?: SourceInfo;

    public status: WriterStatus = {
        canWrite: false,
        records: 0,
        invalid: 0,
        skipped: 0,
        bbox: [Infinity, Infinity, -Infinity, -Infinity],
    };

    /**
     * Optional string fragments used by some writers (e.g., GeoJSON headers).
     * Writers like GeoJSONSeq or ESRI JSON may set some entries to null.
     */
    public strings?: { [key: string]: string | null };

    /** Config knobs */
    public antimeridianAware = true;               // heuristic for WKID 4326
    public onInvalid: 'throw' | 'keep' | 'skip' = 'throw';
    public maxRecords: number | null = null;       // soft cap; null = unlimited
    public progressEvery: number | null = null;    // emit progress every N records
    public onProgress?: (summary: { records: number; invalid: number; skipped: number; bbox: [number, number, number, number] }) => void;

    /** If true (default), invalid geometries throw; if false, we continue without per-feature bbox */
    public strictGeometry = true;

    /** Emission/framing mode for base writer */
    private _mode: 'none' | 'ndjson' | 'geojson' = 'none';

    /** GeoJSON framing strings when _mode === 'geojson' */
    protected _strings: { header: string | null; footer: string | null; bboxFooter: string | null; delimiter: string } = {
        header: '{"type": "FeatureCollection", "features": [',
        footer: ']}',
        bboxFooter: '], "bbox":{bbox}}',
        delimiter: ',',
    };

    /** Framing status */
    private _headerEmitted = false;
    private _footerEmitted = false;
    private _emittedCount = 0; // number of features actually emitted downstream

    /** Debounced batch config/state (opt-in from subclasses). */
    private _debounceEnabled = false;
    private _debounceMs = 0;
    private _batchMax = 0;
    _batchMaxBytes = 0;
    private _batchQueue: Feature[] = [];
    private _batchBytes = 0;
    private _batchTimer: NodeJS.Timeout | null = null;

    constructor(options: CliOptionsType, sourceInfo?: SourceInfo) {
        this.options = options;
        this.sourceInfo = sourceInfo;
        // Allow CLI/config to disable strict geometry handling via `strictGeometry: false`
        const opt: any = this.options || {};
        const strictGeometry = firstDefined(opt.strictGeometry, opt['strict-geometry']);
        if (strictGeometry === false) {
            this.strictGeometry = false;
        }
        // Optional knobs from options/config
        const antimeridianAware = firstDefined(opt.antimeridianAware, opt['antimeridian-aware']);
        const maxRecords = firstDefined(opt.maxRecords, opt['max-records']);
        const progressEvery = firstDefined(opt.progressEvery, opt['progress-every']);
        const onInvalid = firstDefined(opt.onInvalid, opt['on-invalid']);

        if (typeof antimeridianAware === 'boolean') this.antimeridianAware = antimeridianAware;
        if (typeof maxRecords === 'number' && isFinite(maxRecords) && maxRecords > 0) this.maxRecords = maxRecords;
        if (typeof progressEvery === 'number' && isFinite(progressEvery) && progressEvery > 0) this.progressEvery = progressEvery;
        if (onInvalid === 'throw' || onInvalid === 'keep' || onInvalid === 'skip') this.onInvalid = onInvalid;
        if (this.strictGeometry === false && this.onInvalid === 'throw') this.onInvalid = 'keep';

        // Choose base emission mode from options.format when available
        try {
            const fmt = (opt?.format ?? '').toLowerCase();
            if (fmt === 'geojsonseq' || fmt === 'ndjson') {
                this._mode = 'ndjson';
            } else if (fmt === 'geojson' || fmt === 'esrijson') {
                this._mode = 'geojson';
                if (fmt === 'esrijson') {
                    // For ESRI JSON, higher layers may override serialization,
                    // but we still use generic GeoJSON collection framing when asked.
                }
            } else {
                this._mode = 'none';
            }
        } catch {}

        if (this._mode === 'ndjson') {
            this._strings.header = null;
            this._strings.footer = null;
            this._strings.bboxFooter = null;
            this._strings.delimiter = '\n';
        }
    }

    /** Open the writer (subclasses should allocate handles/streams). */
    abstract open(): Promise<void>;
    /** Close the writer (flush and release resources).
     * Subclasses using debounced batching should call `await this.flushBatchNow()` before finalizing streams.
     */
    abstract close(): Promise<void>;
    /** Persist any buffered state without closing (optional; no-op by default). */
    async save(): Promise<void> {
        // Default no-op + flush any pending debounced batch if enabled
        await this.flushBatchNow();
    }

    /** Call from subclass open() after sink is ready */
    protected async onOpen(): Promise<void> {
        this._markOpen();
        if (this._mode === 'geojson' && !this._headerEmitted && this._strings.header) {
            await this.sinkWrite(this._strings.header);
            this._headerEmitted = true;
        }
    }

    /** Call from subclass close() before tearing down sink */
    protected async onClose(): Promise<void> {
        // make sure pending batches go out
        await this.flushBatchNow();

        if (this._mode === 'geojson' && !this._footerEmitted) {
            const { footer, bboxFooter } = this._strings;
            if (footer !== null && bboxFooter !== null) {
                const bboxJson = JSON.stringify(this.status.bbox);
                const tail = (this.options['no-bbox'] || !bboxFooter) ? footer : bboxFooter.replace('{bbox}', bboxJson);
                await this.sinkWrite(tail);
            }
            this._footerEmitted = true;
        }
        this._markClosed();
    }

    /**
     * Write a feature through the writer, updating counters and (optionally)
     * attaching a per-feature bbox if configured. Subclasses should call this
     * first (via `await super.writeFeature(feature)`) to keep status accurate
     * and then perform their own serialization/output.
     */
    async writeFeature(line: Feature): Promise<Feature> {
        if (!this.status.canWrite) {
            throw new Error('Writer is closed: cannot write feature');
        }
        if (this.maxRecords != null && this.status.records >= this.maxRecords) {
            this.status.terminated = true;
            this._markClosed();
            throw new Error('MAX_RECORDS_REACHED');
        }

        // Compute and attach per-feature bbox unless disabled or geometry missing
        if (!this.options['no-bbox'] && line.geometry && line.geometry.type && line.geometry.type !== 'GeometryCollection') {
            try {
                line.bbox = this.generateBbox(line.geometry as GeometryExceptCollection);
            } catch (e) {
                this.status.invalid += 1;
                if (this.onInvalid === 'throw') throw e;
                if (this.onInvalid === 'skip') throw new SkipFeatureError();
                // 'keep' -> continue without per-feature bbox
            }
        }

        // Increment after bbox (so records reflects successfully processed lines)
        this.status.records += 1;

        // Telemetry: emit progress every N
        if (this.progressEvery && this.onProgress && (this.status.records % this.progressEvery === 0)) {
            this.onProgress(this.getSummary());
        }

        return line;
    }

    /**
     * Queue a feature for base-class-managed emission, using the current mode.
     * Subclasses can call this instead of performing their own per-feature writes.
     */
    protected async emitFeature(feature: Feature): Promise<void> {
        await this.enqueueForBatch(feature);
    }

    /**
     * Low-level sink write. Subclasses must implement this to actually emit strings
     * to stdout, files, sockets, etc. It must respect backpressure.
     */
    protected abstract sinkWrite(payload: string): Promise<void>;

    /** Enable subsequent writes (subclasses should also call this in open()). */
    protected _markOpen() { this.status.canWrite = true; }
    /** Disable subsequent writes (subclasses should also call this in close()). */
    protected _markClosed() { this.status.canWrite = false; }

    /**
     * Non-recursive bbox generator to avoid deep call stacks and reduce overhead.
     * Accepts any non-collection geometry and returns [xmin, ymin, xmax, ymax].
     */
    protected generateBbox(geometry: GeometryExceptCollection): [number, number, number, number] {
        // Fast path: invalid or missing coordinates
        if (!geometry || (geometry as any).coordinates == null) {
            throw new Error('Invalid GeoJSON geometry: missing coordinates');
        }

        let bbox: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];

        // Use an explicit stack to avoid recursion for massive coordinate arrays
        const stack: any[] = [(geometry as any).coordinates];
        while (stack.length) {
            const node = stack.pop();
            if (!Array.isArray(node)) continue;

            // A Position is [x, y, ...]
            if (node.length > 0 && typeof node[0] === 'number') {
                const x = Number(node[0]);
                const y = Number(node[1]);
                if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
                if (x < bbox[0]) bbox[0] = x;
                if (y < bbox[1]) bbox[1] = y;
                if (x > bbox[2]) bbox[2] = x;
                if (y > bbox[3]) bbox[3] = y;
            } else {
                // Not a Position; push children
                for (let i = 0; i < node.length; i++) stack.push(node[i]);
            }
        }

        if (!(bbox[0] <= bbox[2] && bbox[1] <= bbox[3])) {
            // No valid positions found
            throw new Error('Invalid GeoJSON geometry: could not compute bbox');
        }

        // Antimeridian heuristic: if WKID 4326, check whether a wrapped span is tighter
        try {
            const wkid = (this.sourceInfo as any)?.spatialReference?.wkid ?? (this.sourceInfo as any)?.extent?.SpatialReference?.wkid;
            if (this.antimeridianAware && wkid === 4326) {
                // Compute normal span width in lon
                const width = bbox[2] - bbox[0];
                // Compute wrapped width by shifting negative longitudes by +360
                let wmin = Infinity, wmax = -Infinity;
                const stack2: any[] = [(geometry as any).coordinates];
                while (stack2.length) {
                    const node2 = stack2.pop();
                    if (!Array.isArray(node2)) continue;
                    if (node2.length > 0 && typeof node2[0] === 'number') {
                        let lx = Number(node2[0]);
                        const ly = Number(node2[1]);
                        if (!Number.isFinite(lx) || !Number.isFinite(ly)) continue;
                        if (lx < 0) lx += 360; // shift west longitudes into [0,360)
                        if (lx < wmin) wmin = lx;
                        if (lx > wmax) wmax = lx;
                    } else {
                        for (let i = 0; i < node2.length; i++) stack2.push(node2[i]);
                    }
                }
                const wrappedWidth = wmax - wmin;
                if (isFinite(wrappedWidth) && wrappedWidth < width) {
                    this.status.antimeridianUsed = true;
                }
            }
        } catch { }

        // Merge into running overall bbox
        const s = this.status.bbox;
        this.status.bbox = [
            Math.min(bbox[0], s[0]),
            Math.min(bbox[1], s[1]),
            Math.max(bbox[2], s[2]),
            Math.max(bbox[3], s[3]),
        ];

        return bbox;
    }

    /** Optional helper used by some legacy subclasses; unrelated to sinkWrite() */
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async writeString(_line: string): Promise<void> { /* optional in subclasses */ }

    /** Reset counters/bbox; useful for tests or multi-file segments. */
    resetStatus() {
        this.status.canWrite = false;
        this.status.records = 0;
        this.status.invalid = 0;
        this.status.skipped = 0;
        this.status.bbox = [Infinity, Infinity, -Infinity, -Infinity];
    }

    /** Lightweight summary for footers/logs. */
    getSummary() {
        const { records, invalid, skipped, bbox } = this.status;
        return { records, invalid, skipped, bbox };
    }

    /**
     * Hook invoked when the internal debounced batch flushes.
     * Subclasses opting into debounced batching **must override** this to perform
     * the actual output for a batch of features (e.g., write to stdout/file/Parquet).
     * Default throws to avoid silent loss if enabled without override.
     */
    protected async onFlushBatch(features: Feature[]): Promise<void> {
        if (this._mode === 'none') {
            // No built-in serialization; subclasses are responsible
            return;
        }

        if (this._mode === 'ndjson') {
            // One JSON per line
            const parts: string[] = new Array(features.length);
            const pretty = (this as any).options?.pretty ? 2 : 0;
            for (let i = 0; i < features.length; i++) {
                parts[i] = JSON.stringify(features[i], null, pretty) + '\n';
            }
            await this.sinkWrite(parts.join(''));
            this._emittedCount += features.length;
            return;
        }

        // GeoJSON collection body: comma-delimited features between header/footer
        const pretty = (this as any).options?.pretty ? 2 : 0;
        const bufs: string[] = [];
        for (let i = 0; i < features.length; i++) {
            if (this._emittedCount > 0 || i > 0) bufs.push(this._strings.delimiter);
            bufs.push(JSON.stringify(features[i], null, pretty));
        }
        if (bufs.length) await this.sinkWrite(bufs.join(''));
        this._emittedCount += features.length;
    }

    /**
     * Enable debounced batching. Safe to call multiple times (reconfigures).
     * Pass debounceMs=0 to flush synchronously when thresholds are hit.
     */
    public enableDebouncedBatching(opts: { debounceMs?: number; maxBatch?: number; maxBufferBytes?: number }): void {
        this._debounceEnabled = true;
        this._debounceMs = Math.max(0, opts?.debounceMs ?? 250);
        this._batchMax = Math.max(1, opts?.maxBatch ?? 10_000);
        this._batchMaxBytes = Math.max(1024, opts?.maxBufferBytes ?? (16 << 20)); // ~16MB
    }

    /** Estimate bytes for rough memory cap; cheap and conservative. */
    protected _estimateFeatureBytes(f: Feature): number {
        let n = 128; // cushion
        try { n += Buffer.byteLength(JSON.stringify(f.properties ?? {})); } catch {}
        try { if (f.geometry) n += Buffer.byteLength(JSON.stringify(f.geometry)); } catch {}
        return n;
    }

    /** Enqueue a feature for debounced batch output. Subclasses call this instead of writing immediately. */
    protected async enqueueForBatch(feature: Feature): Promise<void> {
        if (!this._debounceEnabled) {
            // If not enabled, just call immediate single-item batch to reuse the hook for consistency.
            return this.onFlushBatch([feature]);
        }
        this._batchQueue.push(feature);
        this._batchBytes += this._estimateFeatureBytes(feature);

        // Threshold flush (size or count)
        if (this._batchQueue.length >= this._batchMax || this._batchBytes >= this._batchMaxBytes) {
            await this.flushBatchNow();
            return;
        }

        // Debounce timer
        if (!this._batchTimer) {
            if (this._debounceMs === 0) {
                await this.flushBatchNow();
            } else {
                this._batchTimer = setTimeout(() => {
                    this._batchTimer = null;
                    void this.flushBatchNow();
                }, this._debounceMs);
                // Don't keep the event loop alive just for the timer
                (this._batchTimer as any).unref?.();
            }
        }
    }

    /** Cancel any scheduled flush without emitting. */
    protected _cancelBatchTimer(): void {
        if (this._batchTimer) {
            clearTimeout(this._batchTimer);
            this._batchTimer = null;
        }
    }

    /** Force immediate flush of any queued features. Safe to call often. */
    public async flushBatchNow(): Promise<void> {
        this._cancelBatchTimer();
        if (!this._debounceEnabled && this._batchQueue.length === 0) return;
        const local = this._batchQueue;
        if (local.length === 0) return;
        this._batchQueue = [];
        this._batchBytes = 0;
        await this.onFlushBatch(local);
    }

    protected setEmissionMode(mode: 'none' | 'ndjson' | 'geojson') {
        this._mode = mode;
    }
    protected getEmissionMode(): 'none' | 'ndjson' | 'geojson' {
        return this._mode;
    }

    /**
     * Convenience helper: consume an (async) iterable of GeoJSON Features and
     * feed them through writeFeature(). Returns the count of accepted features
     * (i.e., not skipped by higher layers). Writers that override writeFeature
     * can leverage base-class batching and framing as usual.
     */
    public async writeBatch(items: AsyncIterable<Feature> | Iterable<Feature>): Promise<number> {
        let accepted = 0;
        const isAsync = typeof (items as any)[Symbol.asyncIterator] === 'function';

        const iter = isAsync ? (items as AsyncIterable<Feature>)[Symbol.asyncIterator]()
                             : (items as Iterable<Feature>)[Symbol.iterator]();

        while (true) {
            let step: IteratorResult<Feature> | Promise<IteratorResult<Feature>>;
            try {
                step = (iter as any).next();
                step = isAsync ? await (step as Promise<IteratorResult<Feature>>) : (step as IteratorResult<Feature>);
            } catch (e) {
                throw e instanceof Error ? e : new Error(String(e));
            }
            if ((step as IteratorResult<Feature>).done) break;
            const feat = (step as IteratorResult<Feature>).value;
            try {
                await this.writeFeature(feat);
                accepted += 1;
            } catch (e: any) {
                if (e && (e.code === 'SKIP_FEATURE')) {
                    // Higher layer requested to skip this feature; reflect in status
                    this.status.skipped += 1;
                    continue;
                }
                if (e && String(e.message) === 'MAX_RECORDS_REACHED') {
                    // Soft cap reached; stop consuming further
                    break;
                }
                throw e;
            }
        }

        return accepted;
    }
}
