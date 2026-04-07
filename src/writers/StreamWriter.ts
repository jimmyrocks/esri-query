import { once } from 'events';
import { Writable } from 'stream';
import Writer from './Writer.js';

/**
 * StreamWriter: minimal adapter that implements sinkWrite() for any Writable.
 * Subclasses must set `this.stream` in open() before calling `onOpen()`.
 */
export default abstract class StreamWriter extends Writer {
  protected stream: Writable | null = null;

  /** Use the configured Writable as the sink for framed payloads. */
  protected async sinkWrite(payload: string): Promise<void> {
    if (!this.status.canWrite) return;
    if (!this.stream) throw new Error('Stream not initialized');
    try {
      const ok = this.stream.write(payload);
      if (ok === false) {
        await once(this.stream, 'drain');
      }
    } catch (err: any) {
      // Tolerate broken pipe for stdout-like streams
      if (err && (err.code === 'EPIPE' || err.code === 'ERR_STREAM_WRITE_AFTER_END')) {
        this._markClosed();
        return;
      }
      throw err;
    }
  }
}

