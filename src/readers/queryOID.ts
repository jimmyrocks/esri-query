import { EventEmitter } from 'events';
import postAsyncHelper from '../helpers/post-async.js';
import Bottleneck from 'bottleneck';
import { ensureQueryUrl } from '../helpers/url.js';
import { ConsecutiveBreaker, circuitBreaker, retry, handleWhen, handleAll, wrap, ExponentialBackoff, timeout, TimeoutStrategy, fullJitterGenerator, noJitterGenerator } from 'cockatiel';
// (Type-only) for narrow checks on error.code from post-async
// (no extra import needed; we'll just use string literals in guards)
import type { EsriQueryObjectType } from '../helpers/esri-rest-types.js';

// Minimal feature shape fallback if not provided by helpers
type EsriFeatureType = { attributes: Record<string, unknown>; geometry?: unknown };

// -------------------------------
// Per-host limiter (shared bucket)
// -------------------------------
const limiterByHost: Map<string, Bottleneck> = new Map();
function getLimiterForHost(host: string): Bottleneck {
  const existing = limiterByHost.get(host);
  if (existing) return existing;
  const reservoir = Number(process.env.ESRIQ_RATE_BURST ?? 8);
  const perSec = Number(process.env.ESRIQ_RATE_PER_SEC ?? 8);
  const limiter = new Bottleneck({
    reservoir,
    reservoirRefreshAmount: perSec,
    reservoirRefreshInterval: 1000
  });
  limiterByHost.set(host, limiter);
  return limiter;
}



// -------------------------------
// Options passed to query tools
// -------------------------------
export interface QueryOptions {
  maxErrors: number;
  maxFeaturesPerRequest: number;
  queryObjectBase: EsriQueryObjectType;
  baseUrl: URL;
  progress?: boolean;
  totalCount?: number;          // optional known total features (optimizes pagination)
  // OID tuning knobs (optional; fall back to env when absent)
  oidStart?: number;            // starting slice size (default 250)
  oidConcurrency?: number;      // parallel slice workers (default 2)
  idListThreshold?: number;     // when to switch to range-scan (default 500000)
  oidWindow?: number;           // initial OID range scan window (default 5000)
  oidField?: string;            // object id field name from layer metadata

  // Robustness controls (optional)
  retryAttempts?: number;         // total attempts per request (default 6)
  retryBaseMs?: number;           // base backoff (default 300)
  retryMaxMs?: number;            // cap backoff (default 8000)
  retryJitter?: boolean;          // +/- jitter (default true)
  requestTimeoutMs?: number;      // per-request timeout (default 15000)
  retryStatusCodes?: number[];    // HTTP codes to retry (default [429, 500, 502, 503, 504, 520, 522, 524])

  // Rate limiting / Circuit breaker
  rateCapacityPerSec?: number;    // tokens per second (default 8)
  rateBurst?: number;             // bucket size (default 8)
  circuitThreshold?: number;      // consecutive failures to open (default 4)
  circuitCooldownMs?: number;     // open-state cooldown (default 15000)

  // Optional geometry filter
  bbox?: [number, number, number, number];   // [xmin, ymin, xmax, ymax]
  bboxWkid?: number;                         // optional spatial reference for bbox
  extraHeaders?: Record<string, string>;
}

// -------------------------------
// Base class for query methods
// -------------------------------
export default abstract class QueryToolBase extends EventEmitter {
  protected options: QueryOptions;
  protected _baseUrl: URL;
  protected errorCount = 0;
  private _limiter: Bottleneck;

  // retry & timeout settings
  private _retryAttempts: number;
  private _retryBaseMs: number;
  private _retryMaxMs: number;
  private _retryJitter: boolean;
  private _requestTimeoutMs: number;
  private _retryStatusCodes: Set<number>;
  private _bbox?: [number, number, number, number];
  private _bboxWkid?: number;

  // rate limiting & breaker
  private _cbreaker: ConsecutiveBreaker;
  private _breaker: ReturnType<typeof circuitBreaker>;
  private _retryPolicy!: ReturnType<typeof retry>;
  private _timeoutPolicy!: ReturnType<typeof timeout>;
  private _wrappedPolicy!: ReturnType<typeof wrap>;
  private _metrics = { totalRetries: 0, totalBackoffMs: 0 };
  private _abort = new AbortController();
  private _forceJson = false;

  constructor(options: QueryOptions) {
    super();
    this.options = options;
    this._baseUrl = new URL(ensureQueryUrl(options.baseUrl));

    this._retryAttempts = Math.max(1, options.retryAttempts ?? 6);
    this._retryBaseMs = Math.max(50, options.retryBaseMs ?? 300);
    this._retryMaxMs = Math.max(this._retryBaseMs, options.retryMaxMs ?? 8000);
    this._retryJitter = options.retryJitter ?? true;
    this._requestTimeoutMs = Math.max(1000, options.requestTimeoutMs ?? 15000);
    const defaultStatuses = [429, 500, 502, 503, 504, 520, 522, 524];
    this._retryStatusCodes = new Set([...(options.retryStatusCodes ?? defaultStatuses)]);

    // Optional bbox filter
    this._bbox = options.bbox;
    this._bboxWkid = options.bboxWkid;

    // Per-host limiter
    this._limiter = getLimiterForHost(this._baseUrl.host);

    // Circuit breaker
    this._cbreaker = new ConsecutiveBreaker(options.circuitThreshold ?? 4);
    this._breaker = circuitBreaker(handleAll, {
      halfOpenAfter: options.circuitCooldownMs ?? 15000,
      breaker: this._cbreaker,
    });
    this._breaker.onBreak?.(() => this.log('[circuit] open'));
    this._breaker.onReset?.(() => this.log('[circuit] closed'));
    this._breaker.onHalfOpen?.(() => this.log('[circuit] half-open'));

    // Retry policy: only when our predicate says retryable
    const initialDelay = this._retryBaseMs;
    const maxDelay = this._retryMaxMs;
    const maxAttempts = this._retryAttempts; // cockatiel counts attempts
    const useJitter = this._retryJitter;

    this._retryPolicy = retry(handleWhen((e: any) => this._isRetryableError(e)), {
      maxAttempts,
      backoff: new ExponentialBackoff({
        initialDelay,
        maxDelay,
        generator: useJitter ? fullJitterGenerator : noJitterGenerator,
      }),
    });

    // Metrics & logs for retries
    (this._retryPolicy as any).onRetry?.((evt: any) => {
      const attempt = Math.min(evt.attemptNumber ?? 1, maxAttempts);
      const delay = evt.delay ?? 0;
      this._metrics.totalRetries += 1;
      this._metrics.totalBackoffMs += delay;
      this.emit('retry', {
        attempt,
        max: maxAttempts,
        waitMs: Math.round(delay),
        status: evt.error?.status ?? 0,
        code: evt.error?.code ?? 'RETRY',
      });
      this.log('failed request:', String(evt.error?.message || evt.error || '').trim());
      this.log(`[retry x${attempt}/${maxAttempts}] waiting ${Math.round(delay)}ms (${evt.error?.code || evt.error?.status || 'error'})`);
    });

    // Timeout policy replaces manual _withTimeout
    this._timeoutPolicy = timeout(this._requestTimeoutMs, TimeoutStrategy.Cooperative);

    // Wrap retry + breaker + timeout together
    this._wrappedPolicy = wrap(this._retryPolicy, this._breaker, this._timeoutPolicy);
  }

  public cancel() { try { this._abort.abort(); } catch {} }
  protected isCancelled(): boolean { return this._abort.signal.aborted; }

  protected get queryObjectBase(): EsriQueryObjectType {
    const base = this.options.queryObjectBase || {} as EsriQueryObjectType;
    if (!this._bbox) return base;

    const [xmin, ymin, xmax, ymax] = this._bbox;
    const geometry: any = { xmin, ymin, xmax, ymax };
    if (this._bboxWkid && Number.isFinite(this._bboxWkid)) {
      geometry.spatialReference = { wkid: this._bboxWkid };
    }

    // Don't clobber user-provided geometry params if already present
    const merged: EsriQueryObjectType = {
      ...base,
      geometry: base.geometry ?? geometry,
      geometryType: base.geometryType ?? 'esriGeometryEnvelope',
      spatialRel: base.spatialRel ?? 'esriSpatialRelIntersects',
      // inSR optional; ArcGIS will assume layer SR if omitted
    } as EsriQueryObjectType;

    return merged;
  }

  protected log(...args: any[]) { try { if (this.options?.progress) process.stderr.write(args.join(' ') + '\n'); } catch {} }
  protected delay(ms: number) { return new Promise<void>(r => setTimeout(r, ms)); }

  // -------------------------------
  // Core HTTP call (via shared postAsyncHelper + limiter)
  // -------------------------------
  protected async postAsync(baseUrl: URL, params: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
    const url = ensureQueryUrl(baseUrl);
    // Respect prior PBF fallback decision
    const q: any = { ...(params || {}) };
    if (this._forceJson) q.f = 'json';

    const combined = this._combineSignals(signal, this._abort.signal);
    // Keep per-host rate limiting; delegate HTTP + parsing to shared helper
    return this._limiter.schedule(async () => {
      if (process.env.DEBUG_ESRI_QUERY) {
        // eslint-disable-next-line no-console
        console.error('[query] POST', url, JSON.stringify(q).slice(0, 200) + (JSON.stringify(q).length > 200 ? '…' : ''));
      }
      return await postAsyncHelper(url, q as any, { signal: combined, headers: this.options.extraHeaders });
    });
  }

  // -------------------------------
  // Retry helpers
  // -------------------------------
  private _isRetryableError(e: any): boolean {
    const code = (e && (e.code || e.name)) || '';
    const msg = (e && e.message) || '';
    const status = e && (e.status ?? e.statusCode);
    // Do not retry authentication/token failures
    if (e?.code === 'AUTH' || status === 498 || status === 499) return false;
    // If protobuf is unsupported, treat as retryable so callers can flip to JSON
    if (e?.code === 'FORMAT_UNSUPPORTED') return true;
    // If the circuit is open, allow the retry policy to backoff until halfOpenAfter
    if (e?.isBrokenCircuitError || e?.name === 'BrokenCircuitError') return true;
    if (typeof status === 'number' && this._retryStatusCodes.has(status)) return true;
    const hdr = (e && (e.headers || e.response?.headers)) as any;
    const ra = hdr && (hdr['retry-after'] || hdr['Retry-After']);
    if (ra) return true;
    const netCodes = new Set(['RETRY', 'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'ECONNREFUSED', 'AbortError', 'TimeoutError']);
    if (netCodes.has(String(code))) return true;
    const knownMsgs = [
      'index out of range',
      'timeout',
      'timed out',
      'socket hang up',
      'too many requests',
      'gateway timeout',
      'service unavailable',
      'output format not supported',
      'invalid or unsupported f',
      'unknown output format',
      'pbf not supported',
      'protobuf'
    ];
    if (knownMsgs.some(k => msg && msg.toLowerCase().includes(k.toLowerCase()))) return true;
    return false;
  }

  private _combineSignals(a?: AbortSignal, b?: AbortSignal): AbortSignal | undefined {
    if (!a && !b) return undefined;
    if (a && !b) return a;
    if (!a && b) return b;
    const ctl = new AbortController();
    const onAbortA = () => ctl.abort(a!.reason);
    const onAbortB = () => ctl.abort(b!.reason);
    a!.aborted ? ctl.abort(a!.reason) : a!.addEventListener('abort', onAbortA, { once: true });
    b!.aborted ? ctl.abort(b!.reason) : b!.addEventListener('abort', onAbortB, { once: true });
    return ctl.signal;
  }

  // -------------------------------
  // Core fetch via wrapped policies
  // -------------------------------
  protected async fetchFeatures(params: EsriQueryObjectType): Promise<Array<EsriFeatureType>> {
    // Use a local copy so we can mutate `f` safely when we detect bad PBF support
    const baseParams = { ...(params as any) } as any;
    if (this._forceJson) {
      baseParams.f = 'json';
    }

    const exec = async ({ signal }: { signal: AbortSignal }) => {
      const combined = this._combineSignals(signal, this._abort.signal);
      let data: any;
      try {
        data = await this.postAsync(this._baseUrl, baseParams, combined);
      } catch (err: any) {
        if (err?.code === 'FORMAT_UNSUPPORTED') {
          this._forceJson = true;
          this.log('[format] PBF rejected by server, falling back to JSON');
          const re: any = new Error('Retrying with JSON');
          re.code = 'RETRY';
          throw re; // trigger retry; next attempt will set f=json
        }
        throw err;
      }

      if (data && Array.isArray(data.features)) {
        this.emit('metrics', { ...this._metrics });
        return data.features as Array<EsriFeatureType>;
      }

      if (data && (data as any).error) {
        const errObj: any = (data as any).error;
        const message: string = String(errObj?.message || errObj || 'Error');

        // Force JSON if PBF was requested and server returned an ArcGIS error payload
        const requestedPbf = String(baseParams.f || '').toLowerCase() === 'pbf';
        const msg = message.toLowerCase();
        const pbfUnsupported = requestedPbf && (
          msg.includes('unsupported') ||
          msg.includes('not supported') ||
          msg.includes('unknown output format') ||
          msg.includes('invalid or unsupported f') ||
          msg.includes('protobuf') ||
          msg.includes('pbf')
        );
        if (requestedPbf) {
          // If we asked for PBF and *any* ArcGIS error arrived, be conservative: flip to JSON
          this._forceJson = true;
          this.log('[format] PBF rejected by server, falling back to JSON');
          const re: any = new Error(pbfUnsupported ? 'Server does not support PBF; retrying with JSON.' : 'ArcGIS error with PBF; retrying with JSON.');
          re.code = 'RETRY';
          throw re; // trigger retry; next attempt will set f=json
        }

        const e: any = new Error(message);
        e.code = 'ESRI ERROR';
        e.message = message;
        if (typeof errObj?.code === 'number') e.status = errObj.code;
        throw e; // retry policy will decide based on predicate
      }

      const err: any = new Error('Empty response or unexpected payload');
      err.code = 'RETRY';
      throw err;
    };

    try {
      return await (this._wrappedPolicy.execute as any)(exec) as Array<EsriFeatureType>;
    } catch (e: any) {
      if (process.env.DEBUG_ESRI_QUERY) {
        // eslint-disable-next-line no-console
        console.error('Error with request:', baseParams);
        // eslint-disable-next-line no-console
        console.error('------------------');
        // eslint-disable-next-line no-console
        console.error(e);
        // eslint-disable-next-line no-console
        console.error('------------------');
        if (e && (e.status || e.code)) {
          // eslint-disable-next-line no-console
          console.error('status:', e.status, 'code:', e.code);
        }
      }
      // When the breaker is open, briefly pause to align with halfOpenAfter
      if (e?.isBrokenCircuitError || e?.name === 'BrokenCircuitError') {
        const cool = Math.max(500, (this.options.circuitCooldownMs ?? 15000) / 2);
        await this.delay(cool);
      }
      throw (e instanceof Error) ? e : new Error(String(e));
    }
  }

  // Subclasses implement their own strategy
  abstract runQuery(): Promise<void>;
}
