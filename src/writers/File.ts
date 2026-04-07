import { createWriteStream, WriteStream, fsyncSync, existsSync } from 'fs';
import { mkdir } from 'fs/promises';
import { dirname, basename, extname, join } from 'path';
import { once } from 'events';
import StreamWriter from './StreamWriter.js';
import Writer from './Writer.js';

/**
 * Async file writer that reuses Stdout framing for single-file output, and
 * optionally supports **partitioned NDJSON/geojsonseq** output when `--partition`
 * is provided. Partitioning writes one file per key and **rolls files** when
 * `--max-file-bytes` is reached, all with proper backpressure.
 */
export default class File extends StreamWriter {
    private isPartitioned = false;
    private partitionAttr: string | null = null;
    private maxFileBytes = 256 * 1024 * 1024; // 256 MB default
    private basePath: string | null = null;     // for partitioned mode, this is a directory
    private fileExt: string = '.geojsonl';

    private partitions: Map<string, { stream: WriteStream; fd: number | null; bytes: number; count: number; partIndex: number }> = new Map();
    private fd: number | null = null;

    private sanitizeKey(key: string): string {
        return key.replace(/[^A-Za-z0-9._-]/g, '_');
    }

    private async openPartitionStream(key: string): Promise<{ stream: WriteStream; fd: number | null; count: number; bytes: number; partIndex: number }> {
        const entry = this.partitions.get(key);
        if (entry) return entry;

        // Ensure directory exists
        await mkdir(this.basePath!, { recursive: true });

        const safe = this.sanitizeKey(key || 'default');
        const filename = join(this.basePath!, `${safe}.part0000${this.fileExt}`);
        const stream = createWriteStream(filename, { flags: 'w', highWaterMark: 1 << 20 });
        let fd: number | null = null;
        stream.once('open', (nfd: number) => { fd = nfd; });
        if (!stream.writable) await once(stream, 'open');

        const state = { stream, fd, bytes: 0, count: 0, partIndex: 0 };
        this.partitions.set(key, state);
        return state;
    }

    private async rollPartition(key: string, state: { stream: WriteStream; fd: number | null; bytes: number; count: number; partIndex: number }) {
        // fsync before closing current
        if (typeof state.fd === 'number') {
            try {
                fsyncSync(state.fd);
            } catch { }
        }
        // close current
        await new Promise<void>((resolve, reject) => {
            state.stream.end((err: any) => (err ? reject(err) : resolve()));
        });
        // open next part
        const safe = this.sanitizeKey(key || 'default');
        state.partIndex += 1;
        const partStr = String(state.partIndex).padStart(4, '0');
        const filename = join(this.basePath!, `${safe}.part${partStr}${this.fileExt}`);
        state.stream = createWriteStream(filename, { flags: 'w', highWaterMark: 1 << 20 });
        state.fd = null;
        state.bytes = 0;
        state.count = 0;
        state.stream.once('open', (nfd: number) => { state.fd = nfd; });
        if (!state.stream.writable) await once(state.stream, 'open');
    }

    /** Open the file for writing and call the parent class's `open`. */
    override async open() {
        const append = Boolean((this as any).options?.append);
        const mode: number | undefined = (this as any).options?.mode; // e.g., 0o644
        const outPath = (this as any).options?.output as string;
        if (!outPath) throw new Error('No output path provided');

        // Partitioning options
        this.partitionAttr = (this as any).options?.partition ?? null;
        const mfb = (this as any).options?.['max-file-bytes'];
        if (typeof mfb === 'number' && isFinite(mfb) && mfb > 0) this.maxFileBytes = mfb;

        // Partitioned output only makes sense for NDJSON/geojsonseq
        const fmt = (this as any).options?.format;
        if (this.partitionAttr && fmt !== 'geojsonseq') {
          throw new Error('Partitioned output (--partition) requires --format geojsonseq (NDJSON).');
        }

        // Determine extension (helps when naming rolled/partitioned files)
        if (this.partitionAttr) {
            // Partitioned mode: treat output as a directory
            this.isPartitioned = true;
            this.basePath = outPath;
            await mkdir(this.basePath, { recursive: true });
            // No single stream opened here; per-partition streams open lazily
            await this.onOpen(); // mark open via base framing
            return;
        }

        const ext = extname(outPath);
        if (ext) this.fileExt = ext;

        // Non-partitioned: create a single stream like before
        await mkdir(dirname(outPath), { recursive: true });
        // If the output exists and we're not appending, honor --overwrite
        if (!append && existsSync(outPath) && !(this as any).options?.overwrite) {
            throw new Error(`Output already exists: ${outPath}. Use --overwrite or --append.`);
        }
        this.stream = createWriteStream(outPath, {
            flags: append ? 'a' : 'w',
            mode,
            highWaterMark: 1 << 20,
        });

        (this.stream as WriteStream).once('open', (fd: number) => { this.fd = fd; });
        if (!(this.stream as any).writable) await once(this.stream as any, 'open');

        await this.onOpen();
    }

    override async writeFeature(feature: any): Promise<any> {
        // In partitioned mode we bypass Stdout.writeFeature() because it manages a single-file delimiter.
        if (this.isPartitioned) {
            // Call base Writer.writeFeature() directly to update counts/bbox and enforce skip/strict policies
            const baseWrite = (Writer as any).prototype.writeFeature.bind(this);
            try {
                feature = await baseWrite(feature);
            } catch (e: any) {
                if (e && e.code === 'SKIP_FEATURE') { this.status.skipped += 1; return feature; }
                throw e;
            }

            const props = feature?.properties || {};
            const keyRaw = this.partitionAttr ? String(props[this.partitionAttr] ?? 'default') : 'default';
            const key = this.sanitizeKey(keyRaw);

            const state = await this.openPartitionStream(key);

            // Serialize line; always line-delimited JSON for geojsonseq/NDJSON
            const lineStr = JSON.stringify(feature, null, (this as any).options?.pretty ? 2 : 0) + '\n';
            try {
                const ok = state.stream.write(lineStr);
                if (!ok) await once(state.stream, 'drain');
            } catch (err: any) {
                throw new Error(`Failed to write partition ${key}: ${err?.message || err}`);
            }

            state.count += 1;
            state.bytes += Buffer.byteLength(lineStr);
            if (state.bytes >= this.maxFileBytes) {
                await this.rollPartition(key, state);
            }
            return feature;
        }

        // Non-partitioned path: reuse base Writer batching/framing
        try {
            feature = await (super.writeFeature as any).call(this, feature);
        } catch (e: any) {
            if (e && e.code === 'SKIP_FEATURE') { this.status.skipped += 1; return feature; }
            throw e;
        }

        await this.emitFeature(feature);
        return feature;
    }

    /** Write a string to the file, respecting backpressure. */
    override async writeString(line: string) {
        if (this.isPartitioned) {
            // Internal guard: writeString should not be called in partitioned mode; silently no-op.
            return;
        }
        if (!this.stream) throw new Error('File is not open');
        if (!this.status.canWrite) return; // prevent "write after end" when upper layers have closed the writer
        try {
            const ok = this.stream.write(line);
            if (!ok) await once(this.stream, 'drain');
        } catch (err: any) {
            throw new Error(`Failed to write to output file: ${(this as any).options?.output}. ${err?.message || err}`);
        }
    }

    /** Sink for Writer/Stdout framing: route to file when not partitioned. */
    protected override async sinkWrite(payload: string): Promise<void> {
        if (this.isPartitioned) {
            // Partitioned mode does not use text framing from the base class.
            return;
        }
        if (!this.stream) throw new Error('File is not open');
        if (!this.status.canWrite) return;
        try {
            const ok = this.stream.write(payload);
            if (!ok) await once(this.stream, 'drain');
        } catch (err: any) {
            throw new Error(`Failed to write to output file: ${(this as any).options?.output}. ${err?.message || err}`);
        }
    }

    /** Flush file contents to disk without closing. */
    override async save() {
        if (this.isPartitioned) {
            for (const { fd } of this.partitions.values()) {
                try { if (typeof fd === 'number') fsyncSync(fd); } catch { }
            }
            return;
        }
        if (!this.stream) return;
        try { if (typeof this.fd === 'number') fsyncSync(this.fd); } catch (err: any) {
            console.error(`[warn] fsync failed for ${(this as any).options?.output}:`, err?.message || err);
        }
    }

    /** Close the stream after writing any footer, then fsync. */
    override async close() {
        if (this.isPartitioned) {
            // Base close first (footer if any)
            try { await this.onClose(); } catch (err) { console.error('[warn] error during base close():', err); }
            await Promise.all([...this.partitions.values()].map(s => new Promise<void>((resolve, reject) => {
                // fsync before closing
                if (typeof s.fd === 'number') {
                    try {
                        fsyncSync(s.fd);
                    } catch { }
                }
                s.stream.end((err: any) => err ? reject(err) : resolve());
            })));
            this.partitions.clear();
            this.stream = null;
            this.fd = null;
            return;
        }

        if (!this.stream) return;
        try { await this.onClose(); } catch (err) { console.error('[warn] error during base close():', err); }
        await new Promise<void>((resolve, reject) => {
            const s = this.stream!;
            try {
                if (typeof this.fd === 'number') fsyncSync(this.fd);
            } catch { }
            s.end(() => resolve());
            s.once('error', reject);
        });
        this.stream = null;
        this.fd = null;
    }
}
