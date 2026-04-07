import { createWriteStream, WriteStream, fsyncSync, existsSync } from 'fs';
import { mkdir, readdir, rm, stat, truncate } from 'fs/promises';
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
    private isSegmented = false;
    private partitionAttr: string | null = null;
    private maxFileBytes = 256 * 1024 * 1024; // 256 MB default
    private basePath: string | null = null;     // for partitioned mode, this is a directory
    private fileExt: string = '.geojsonl';

    private partitions: Map<string, { stream: WriteStream; fd: number | null; bytes: number; count: number; partIndex: number }> = new Map();
    private fd: number | null = null;
    private outputBytes = 0;
    private segmentIndex = 0;
    private segmentBytes = 0;
    private segmentPath: string | null = null;

    static segmentPathFromOutput(outputPath: string, index: number): string {
        const ext = extname(outputPath) || '.geojsonl';
        const stem = basename(outputPath, ext);
        return join(dirname(outputPath), `${stem}.part${String(index).padStart(4, '0')}${ext}`);
    }

    private static segmentMatcher(outputPath: string): { dir: string; regex: RegExp } {
        const ext = extname(outputPath) || '.geojsonl';
        const stem = basename(outputPath, ext).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const escapedExt = ext.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return {
            dir: dirname(outputPath),
            regex: new RegExp(`^${stem}\\.part(\\d{4})${escapedExt}$`),
        };
    }

    private sanitizeKey(key: string): string {
        return key.replace(/[^A-Za-z0-9._-]/g, '_');
    }

    private async listSegmentFiles(outputPath: string): Promise<Array<{ index: number; path: string }>> {
        const { dir, regex } = File.segmentMatcher(outputPath);
        try {
            const names = await readdir(dir);
            return names
                .map((name) => {
                    const match = regex.exec(name);
                    if (!match) return null;
                    return {
                        index: Number(match[1]),
                        path: join(dir, name),
                    };
                })
                .filter((entry): entry is { index: number; path: string } => Boolean(entry))
                .sort((a, b) => a.index - b.index);
        } catch (err: any) {
            if (err?.code === 'ENOENT') return [];
            throw err;
        }
    }

    private async removeSegmentFiles(outputPath: string, predicate?: (index: number) => boolean): Promise<void> {
        const existing = await this.listSegmentFiles(outputPath);
        await Promise.all(existing
            .filter((entry) => predicate ? predicate(entry.index) : true)
            .map((entry) => rm(entry.path, { force: true })));
    }

    private async reconcileSingleFileResume(outPath: string, checkpointBytes: number): Promise<void> {
        try {
            const current = await stat(outPath);
            // Clamp checkpointBytes to actual file size: if the OS crashed between the
            // kernel write buffer flush and the state-file save, the state may record
            // more bytes than are actually on disk.  Truncating past EOF would pad with
            // null bytes and corrupt the output.
            const safeBytes = Math.min(checkpointBytes, current.size);
            if (safeBytes !== current.size) {
                await truncate(outPath, safeBytes);
            }
        } catch (err: any) {
            if (err?.code === 'ENOENT' && checkpointBytes === 0) return;
            if (err?.code === 'ENOENT') {
                throw new Error(`Output is missing but resume state expects ${checkpointBytes} written bytes: ${outPath}`);
            }
            throw err;
        }
    }

    private async openSegmentStream(outputPath: string, index: number, checkpointBytes: number): Promise<void> {
        const filename = File.segmentPathFromOutput(outputPath, index);
        await mkdir(dirname(filename), { recursive: true });

        try {
            const current = await stat(filename);
            if (current.size < checkpointBytes) {
                throw new Error(`Segment ${basename(filename)} is smaller than the saved checkpoint (${current.size} < ${checkpointBytes}).`);
            }
            if (current.size !== checkpointBytes) {
                await truncate(filename, checkpointBytes);
            }
        } catch (err: any) {
            if (err?.code !== 'ENOENT') throw err;
            if (checkpointBytes > 0) {
                throw new Error(`Segment is missing but resume state expects ${checkpointBytes} written bytes: ${filename}`);
            }
        }

        this.stream = createWriteStream(filename, { flags: 'a', highWaterMark: 1 << 20 });
        this.segmentPath = filename;
        this.segmentIndex = index;
        this.segmentBytes = checkpointBytes;
        this.fd = null;
        (this.stream as WriteStream).once('open', (nfd: number) => { this.fd = nfd; });
        if (!(this.stream as any).writable) await once(this.stream as any, 'open');
    }

    private async rollSegment() {
        if (!this.isSegmented) return;
        if (!this.stream) throw new Error('Segment stream is not open');

        const current = this.stream as WriteStream;
        if (typeof this.fd === 'number') {
            try {
                fsyncSync(this.fd);
            } catch { }
        }
        await new Promise<void>((resolve, reject) => {
            current.end((err: any) => err ? reject(err) : resolve());
        });

        const outPath = (this as any).options?.output as string;
        this.stream = null;
        this.fd = null;
        this.segmentPath = null;
        this.segmentIndex += 1;
        this.segmentBytes = 0;
        await this.openSegmentStream(outPath, this.segmentIndex, 0);
    }

    private async writeSegmentPayload(payload: string): Promise<void> {
        if (!this.stream) throw new Error('File is not open');
        if (!this.status.canWrite) return;
        try {
            const ok = this.stream.write(payload);
            if (!ok) await once(this.stream, 'drain');
        } catch (err: any) {
            const target = this.segmentPath ?? (this as any).options?.output;
            throw new Error(`Failed to write to output file: ${target}. ${err?.message || err}`);
        }
        this.segmentBytes += Buffer.byteLength(payload);
        if (this.segmentBytes >= this.maxFileBytes) {
            await this.rollSegment();
        }
    }

    getResumeCheckpoint(): {
        outputMode: 'single-file' | 'segmented';
        outputBytes: number;
        segmentIndex?: number;
        maxFileBytes?: number;
        path: string;
    } {
        if (this.isSegmented) {
            return {
                outputMode: 'segmented',
                outputBytes: this.segmentBytes,
                segmentIndex: this.segmentIndex,
                maxFileBytes: this.maxFileBytes,
                path: this.segmentPath ?? File.segmentPathFromOutput(String((this as any).options?.output), this.segmentIndex),
            };
        }
        return {
            outputMode: 'single-file',
            outputBytes: this.outputBytes,
            path: String((this as any).options?.output ?? ''),
        };
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
        const segmented = !this.partitionAttr && fmt === 'geojsonseq' && typeof mfb === 'number' && isFinite(mfb) && mfb > 0;
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

        if (segmented) {
            this.isSegmented = true;
            const overwrite = Boolean((this as any).options?.overwrite);
            const resumeIndexRaw = (this as any).options?.['resume-segment-index'];
            const resumeBytesRaw = (this as any).options?.['resume-output-bytes'];
            const resumeIndex = Number.isFinite(Number(resumeIndexRaw)) ? Math.max(0, Number(resumeIndexRaw)) : 0;
            const resumeBytes = Number.isFinite(Number(resumeBytesRaw)) ? Math.max(0, Number(resumeBytesRaw)) : 0;
            const resuming = append || resumeIndex > 0 || resumeBytes > 0;

            await mkdir(dirname(outPath), { recursive: true });
            if (resuming) {
                await this.removeSegmentFiles(outPath, (index) => index > resumeIndex);
            } else {
                const existingSegments = await this.listSegmentFiles(outPath);
                if (existingSegments.length) {
                    if (!overwrite) {
                        throw new Error(`Output already exists: ${outPath} (segment files present). Use --overwrite.`);
                    }
                    await this.removeSegmentFiles(outPath);
                }
                if (existsSync(outPath)) {
                    if (!overwrite) {
                        throw new Error(`Output already exists: ${outPath}. Use --overwrite.`);
                    }
                    await rm(outPath, { force: true });
                }
            }

            await this.openSegmentStream(outPath, resumeIndex, resuming ? resumeBytes : 0);
            await this.onOpen();
            return;
        }

        // Non-partitioned: create a single stream like before
        await mkdir(dirname(outPath), { recursive: true });
        const resumeBytesRaw = (this as any).options?.['resume-output-bytes'];
        const resumeBytes = Number.isFinite(Number(resumeBytesRaw)) ? Math.max(0, Number(resumeBytesRaw)) : undefined;
        if (append && resumeBytes != null) {
            await this.reconcileSingleFileResume(outPath, resumeBytes);
            this.outputBytes = resumeBytes;
        } else {
            this.outputBytes = 0;
        }
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
        if (this.isSegmented) {
            await this.writeSegmentPayload(line);
            return;
        }
        if (!this.stream) throw new Error('File is not open');
        if (!this.status.canWrite) return; // prevent "write after end" when upper layers have closed the writer
        try {
            const ok = this.stream.write(line);
            if (!ok) await once(this.stream, 'drain');
            this.outputBytes += Buffer.byteLength(line);
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
        if (this.isSegmented) {
            await this.writeSegmentPayload(payload);
            return;
        }
        if (!this.stream) throw new Error('File is not open');
        if (!this.status.canWrite) return;
        try {
            const ok = this.stream.write(payload);
            if (!ok) await once(this.stream, 'drain');
            this.outputBytes += Buffer.byteLength(payload);
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
        if (this.isSegmented) {
            if (!this.stream) return;
            try { if (typeof this.fd === 'number') fsyncSync(this.fd); } catch (err: any) {
                console.error(`[warn] fsync failed for ${this.segmentPath ?? (this as any).options?.output}:`, err?.message || err);
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

        if (this.isSegmented) {
            if (!this.stream) return;
            try { await this.onClose(); } catch (err) { console.error('[warn] error during base close():', err); }
            const current = this.stream as WriteStream;
            const currentPath = this.segmentPath;
            await new Promise<void>((resolve, reject) => {
                try {
                    if (typeof this.fd === 'number') fsyncSync(this.fd);
                } catch { }
                current.end((err: any) => err ? reject(err) : resolve());
            });
            this.stream = null;
            this.fd = null;
            if (currentPath && this.segmentBytes === 0) {
                await rm(currentPath, { force: true });
            }
            this.segmentPath = null;
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
