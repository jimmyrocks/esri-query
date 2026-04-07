import type { EsriQueryObjectType } from './esri-rest-types.js';
import esriPbf from './esri-pbf.js';
import ky from 'ky';

import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { appendFile, mkdir } from 'fs/promises';
import { dirname, resolve as resolvePath } from 'path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Shared constants
const JSON_CTYPE_RE = /application\/(json|x-?json|pjson)/i;
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_AUTO_GET_FALLBACK_URL_LENGTH = 1800;
// Note: ArcGIS 498/499 handling has special codes below (for maintainers)


function dlog(...args: any[]) {
  if (process.env.DEBUG_ESRI_QUERY) console.error('[post-async]', ...args);
}

function truncateForLog(value: string, max = 500): string {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function extractArcgisError(payload: any): { code?: string | number; message?: string; details?: string[] } | undefined {
  const error = payload?.error ?? payload;
  if (!error || typeof error !== 'object') return undefined;
  const message = typeof error.message === 'string' && error.message.trim() ? error.message.trim() : undefined;
  const details = Array.isArray(error.details)
    ? error.details.map((entry: unknown) => String(entry)).filter(Boolean)
    : undefined;
  const code = error.code;
  if (message == null && !details?.length && code == null) return undefined;
  return { code, message, details };
}

function formatArcgisErrorMessage(payload: any, fallback: string): string {
  const info = extractArcgisError(payload);
  if (!info) return fallback;
  const parts = [info.message || fallback, ...(info.details ?? [])].filter(Boolean);
  return parts.join(' | ');
}

function summarizeQuery(query: Record<string, unknown>): Record<string, unknown> {
  const objectIdsRaw = String(query.objectIds ?? '').trim();
  const objectIds = objectIdsRaw ? objectIdsRaw.split(',').map((id) => id.trim()).filter(Boolean) : [];
  const where = typeof query.where === 'string' && query.where.trim() ? truncateForLog(query.where.trim(), 240) : undefined;
  return {
    f: query.f,
    where,
    returnIdsOnly: Boolean(query.returnIdsOnly),
    returnCountOnly: Boolean(query.returnCountOnly),
    objectIdsCount: objectIds.length || undefined,
    objectIdsPreview: objectIds.length ? truncateForLog(objectIds.slice(0, 8).join(','), 160) : undefined,
    outFields: typeof query.outFields === 'string' ? truncateForLog(query.outFields, 160) : undefined,
    outStatisticsCount: Array.isArray(query.outStatistics) ? query.outStatistics.length : undefined,
  };
}

function buildQueryStringPreview(params: URLSearchParams): string {
  const clone = new URLSearchParams(params);
  if (clone.has('token')) clone.set('token', '[redacted]');
  if (clone.has('objectIds')) {
    const ids = String(clone.get('objectIds') || '').split(',').filter(Boolean);
    if (ids.length > 8) clone.set('objectIds', `${ids.slice(0, 8).join(',')},...(${ids.length} ids)`);
  }
  return truncateForLog(clone.toString(), 500);
}

function redactUrlForLog(value: string | URL): string {
  try {
    const url = new URL(String(value));
    if (url.searchParams.has('token')) url.searchParams.set('token', '[redacted]');
    return truncateForLog(url.toString(), 500);
  } catch {
    return truncateForLog(String(value).replace(/([?&]token=)[^&]*/i, '$1[redacted]'), 500);
  }
}

function shouldTryAutoGetFallback(url: string | URL, params: URLSearchParams): boolean {
  try {
    const u = new URL(String(url));
    const sp = new URLSearchParams(params);
    if (!sp.has('get')) sp.set('get', '1');
    u.search = sp.toString();
    return u.toString().length <= MAX_AUTO_GET_FALLBACK_URL_LENGTH;
  } catch {
    return false;
  }
}

async function writeFetchLog(fetchLogPath: string | undefined, record: Record<string, unknown>): Promise<void> {
  if (!fetchLogPath) return;
  try {
    await mkdir(dirname(fetchLogPath), { recursive: true });
    await appendFile(fetchLogPath, JSON.stringify({
      ts: new Date().toISOString(),
      ...record,
    }) + '\n', 'utf8');
  } catch (err) {
    dlog('fetch-log write failed', err);
  }
}

class EsriHttpError extends Error {
  status?: number;
  code?: string | number;
  headers?: Record<string, string>;
  body?: unknown;
  retryAfterMs?: number;
  constructor(message: string) { super(message); this.name = 'EsriHttpError'; }
}

/** Dump response headers when DEBUG_ESRI_QUERY_HEADERS is set */
function debugLogHeaders(res: Response) {
  if (!process.env.DEBUG_ESRI_QUERY_HEADERS) return;
  const hdrs: Record<string, string> = {};
  res.headers.forEach((v, k) => { hdrs[k] = v; });
  // eslint-disable-next-line no-console
  console.error('[post-async] headers', JSON.stringify(hdrs, null, 2));
}

/**
 * Known ArcGIS query keys that want CSV lists rather than JSON strings.
 * e.g. objectIds=1,2,3 not objectIds=[1,2,3]
 */
const CSV_KEYS = new Set([
  'objectIds',
  'outFields',
  'orderByFields',
  'groupByFieldsForStatistics',
  // Note: outStatistics expects JSON, so it's intentionally NOT here
]);

/** Serialize an ArcGIS query object into URLSearchParams. */
function toSearchParams(obj: Record<string, unknown>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(obj || {})) {
    if (v === undefined || v === null) continue;

    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      params.set(k, String(v));
      continue;
    }

    if (Array.isArray(v)) {
      if (CSV_KEYS.has(k)) {
        params.set(k, v.map(x => String(x)).join(','));
      } else {
        params.set(k, JSON.stringify(v));
      }
      continue;
    }

    // geometry, outStatistics, quantizationParameters, etc.
    params.set(k, JSON.stringify(v));
  }
  return params;
}

/** Parse Retry-After header (seconds or HTTP date) → ms; undefined if absent/invalid */
function parseRetryAfter(headers: Headers): number | undefined {
  const ra = headers.get('retry-after');
  if (!ra) return undefined;
  const secs = Number(ra);
  if (Number.isFinite(secs)) return Math.max(0, Math.floor(secs * 1000));
  const when = Date.parse(ra);
  if (Number.isFinite(when)) return Math.max(0, when - Date.now());
  return undefined;
}

function buildHeaders(format: string | undefined, extraHeaders?: Record<string, string>): Record<string, string> {
  return {
    Accept: format === 'pbf' ? 'application/x-protobuf, application/json' : 'application/json',
    'Content-Type': 'application/x-www-form-urlencoded',
    'User-Agent': 'esri-query/1.x (+https://github.com/jimmyrocks/esri-query)',
    ...(extraHeaders ?? {}),
  };
}

/** Heuristic: does this payload look like JSON (for when servers ignore pbf)? */
function looksLikeJson(bytes: Uint8Array): boolean {
  if (!bytes || bytes.length === 0) return false;
  // skip UTF-8 BOM
  let i = 0;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) i = 3;
  const first = String.fromCharCode(bytes[i] || 0);
  return first === '{' || first === '[';
}

/** Strip UTF-8 BOM and trim */
function stripBom(s: string): string {
  return s ? s.replace(/^\ufeff/, '') : s;
}

/** True if a text body is clearly an HTML page */
function looksLikeHtml(s: string): boolean {
  const t = s.trimStart();
  return t.startsWith('<') && /<html/i.test(t);
}

/** One-shot GET fallback for servers that dislike POST. */
async function tryGetFallback(
  url: string | URL,
  params: URLSearchParams,
  headers?: Record<string, string>,
  signal?: AbortSignal,
  fetchLogPath?: string,
  logBase?: Record<string, unknown>,
): Promise<any | undefined> {
  try {
    const u = new URL(String(url));
    const sp = new URLSearchParams(params);
    // mark as GET fallback to avoid loops upstream
    if (!sp.has('get')) sp.set('get', '1');
    u.search = sp.toString();
    if (process.env.DEBUG_ESRI_QUERY) {
      // eslint-disable-next-line no-console
      console.error('[post-async] GET fallback', u.toString().slice(0, 400));
    }
    const getRes = await ky.get(u.toString(), { throwHttpErrors: false, headers, signal, retry: 0, timeout: 60000 });
    debugLogHeaders(getRes);
    const getStatus = getRes.status;
    const getCtype = getRes.headers.get('content-type') || '';
    const getIsJson = JSON_CTYPE_RE.test(getCtype) || /text\/plain/i.test(getCtype);
    const raw = await getRes.text();
    const text = stripBom(raw);
    const getParsed = getIsJson
      ? (() => { try { return JSON.parse(text); } catch { return undefined; } })()
      : undefined;
    await writeFetchLog(fetchLogPath, {
      ...logBase,
      transport: 'get-fallback',
      method: 'GET',
      requestUrl: redactUrlForLog(u),
      status: getStatus,
      contentType: getCtype,
      queryStringPreview: truncateForLog(u.search.slice(1), 500),
      outcome: getStatus >= 200 && getStatus < 300 ? 'response' : 'http-error',
      arcgisErrorCode: extractArcgisError(getParsed)?.code,
      arcgisErrorMessage: extractArcgisError(getParsed)?.message,
      arcgisErrorDetails: extractArcgisError(getParsed)?.details,
    });

    if (getStatus >= 200 && getStatus < 300 && getIsJson && !looksLikeHtml(text)) {
      try { return JSON.parse(text); } catch { /* fall through */ }
    }

    // If server dislikes json but likes pjson, try that once
    if ((!raw || looksLikeHtml(raw)) && params.get('f') === 'json') {
      const sp2 = new URLSearchParams(params);
      sp2.set('f', 'pjson');
      u.search = sp2.toString();
      dlog('GET fallback (pjson)', u.toString().slice(0, 400));
      const r2 = await ky.get(u.toString(), { throwHttpErrors: false, headers, signal, retry: 0, timeout: 60000 });
      debugLogHeaders(r2);
      const t2 = stripBom(await r2.text());
      const ct2 = r2.headers.get('content-type') || '';
      const parsed = (/json|x-?json|pjson|text\/plain/i.test(ct2) && !looksLikeHtml(t2))
        ? (() => { try { return JSON.parse(t2); } catch { return undefined; } })()
        : undefined;
      await writeFetchLog(fetchLogPath, {
        ...logBase,
        transport: 'get-fallback-pjson',
        method: 'GET',
        requestUrl: redactUrlForLog(u),
        status: r2.status,
        contentType: ct2,
        queryStringPreview: truncateForLog(u.search.slice(1), 500),
        outcome: r2.status >= 200 && r2.status < 300 ? 'response' : 'http-error',
        arcgisErrorCode: extractArcgisError(parsed)?.code,
        arcgisErrorMessage: extractArcgisError(parsed)?.message,
        arcgisErrorDetails: extractArcgisError(parsed)?.details,
      });
      const j2 = /json|x-?json|pjson|text\/plain/i.test(ct2) && !looksLikeHtml(t2) ? JSON.parse(t2) : undefined;
      if (r2.status >= 200 && r2.status < 300 && j2 !== undefined) return j2;
      try { if (j2 !== undefined) return j2; } catch {}
    }

    // If non-2xx JSON error, pass it back to original path to raise a better message
    if (getIsJson) {
      try { return JSON.parse(text); } catch { /* ignore */ }
    }
  } catch (gfErr) {
    await writeFetchLog(fetchLogPath, {
      ...logBase,
      transport: 'get-fallback',
      method: 'GET',
      requestUrl: redactUrlForLog(url),
      outcome: 'network-error',
      errorMessage: String((gfErr as Error)?.message || gfErr),
    });
    if (process.env.DEBUG_ESRI_QUERY) {
      // eslint-disable-next-line no-console
      console.error('[post-async] GET fallback failed', gfErr);
    }
  }
  return undefined;
}

/**
 * POST to an ArcGIS REST endpoint with robust response handling.
 * - Always POST (bigger payloads than GET)
 * - If f=pbf → parse with protobuf decoder; if server returns JSON anyway, surface JSON error
 * - Else → parse JSON (tolerate text/plain JSON, BOMs, and HTML masquerading)
 * - If POST returns empty/HTML/unexpected payload, do a single GET fallback with same params.
 */
export default async function postAsync(
  url: string | URL,
  query: EsriQueryObjectType,
  options?: { signal?: AbortSignal; headers?: Record<string, string>; fetchLogPath?: string }
): Promise<unknown> {
  const normalizedUrl = String(url);
  const format = (query as any).f;
  const signal = options?.signal;
  const fetchLogPath = options?.fetchLogPath ?? process.env.ESRIQ_FETCH_LOG;

  if (signal?.aborted) {
    const err = new EsriHttpError('Aborted');
    err.code = 'ABORT';
    throw err;
  }

  const headers = buildHeaders(format, options?.headers);
  const body = toSearchParams(query as unknown as Record<string, unknown>);
  const querySummary = summarizeQuery(query as unknown as Record<string, unknown>);
  const logBase = {
    url: redactUrlForLog(normalizedUrl),
    requestUrl: redactUrlForLog(normalizedUrl),
    format,
    query: querySummary,
    queryStringPreview: buildQueryStringPreview(body),
  };

  if (process.env.ESRI_QUERY_GET_FIRST === '1') {
    const early = await tryGetFallback(normalizedUrl, body, headers, signal, fetchLogPath, logBase);
    if (early !== undefined) {
      dlog('GET-first succeeded');
      return early;
    }
    dlog('GET-first produced no usable body; continuing with POST');
  }

  let res: Response;
  try {
    if (process.env.DEBUG_ESRI_QUERY) {
      const bodyPreview = body.toString();
      dlog('POST', normalizedUrl, `${bodyPreview.slice(0, 200)}${bodyPreview.length > 200 ? '…' : ''}`, `len=${bodyPreview.length}`);
    }
    
    res = await ky.post(normalizedUrl, {
      throwHttpErrors: false, // inspect status/headers ourselves
      headers,
      body,
      signal,
      retry: 0,
      timeout: 60000,
    });
    if (process.env.DEBUG_ESRI_QUERY) {
      // eslint-disable-next-line no-console
      console.error('[post-async] RES', res.status, res.statusText);
    }
    dlog('RES headers content-type:', res.headers.get('content-type'));
    debugLogHeaders(res);
  } catch (e: any) {
    const err = new EsriHttpError(e?.message || String(e));
    (err as any).status = (e?.response?.status ?? 0);
    err.code = (signal?.aborted ? 'ABORT' : (e?.name === 'TimeoutError' ? 'RETRY' : (e?.code || 'RETRY')));
    await writeFetchLog(fetchLogPath, {
      ...logBase,
      transport: 'post',
      method: 'POST',
      outcome: 'network-error',
      status: (e?.response?.status ?? 0),
      errorCode: err.code,
      errorMessage: err.message,
    });
    if (!signal?.aborted && shouldTryAutoGetFallback(normalizedUrl, body)) {
      const getAttempt = await tryGetFallback(normalizedUrl, body, headers, signal, fetchLogPath, logBase);
      if (getAttempt !== undefined) {
        dlog('POST network error recovered via GET fallback');
        return getAttempt;
      }
    }
    throw err;
  }

  const status = res.status;
  const headersObj = Object.fromEntries(res.headers.entries());
  const retryAfterMs = parseRetryAfter(res.headers);

  // 204 No Content → return empty object
  if (status === 204) {
    await writeFetchLog(fetchLogPath, {
      ...logBase,
      transport: 'post',
      method: 'POST',
      status,
      contentType: res.headers.get('content-type') || '',
      outcome: 'no-content',
    });
    return {};
  }

  if (format === 'pbf') {
    // Read raw bytes
    const arrayBuffer = await res.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);

    const ctype = res.headers.get('content-type') || '';
    const isJsonCtype = JSON_CTYPE_RE.test(ctype) || /text\/plain/i.test(ctype);

    if (status >= 200 && status < 300) {
      // Some servers ignore f=pbf and send JSON. Accept valid JSON payloads
      // directly to avoid extra round trips.
      if (isJsonCtype || looksLikeJson(bytes)) {
        let j: any = undefined;
        try { j = JSON.parse(Buffer.from(bytes).toString('utf8')); } catch {}
        if (j !== undefined) {
          if (j?.error) {
            const err = new EsriHttpError(formatArcgisErrorMessage(j, 'Output format not supported.'));
            err.status = status; err.headers = headersObj; err.body = j; err.code = 'FORMAT_UNSUPPORTED';
            (err as any).debug = { url: normalizedUrl, format, hint: 'pbf POST JSON error' };
            await writeFetchLog(fetchLogPath, {
              ...logBase,
              transport: 'post',
              method: 'POST',
              status,
              contentType: ctype,
              outcome: 'arcgis-error',
              errorCode: err.code,
              errorMessage: err.message,
              arcgisErrorCode: extractArcgisError(j)?.code,
              arcgisErrorMessage: extractArcgisError(j)?.message,
              arcgisErrorDetails: extractArcgisError(j)?.details,
              hint: (err as any).debug?.hint,
            });
            throw err;
          }
          await writeFetchLog(fetchLogPath, {
            ...logBase,
            transport: 'post',
            method: 'POST',
            status,
            contentType: ctype,
            outcome: 'success-json-on-pbf',
          });
          return j;
        }
      }

      // Locate the protobuf schema. When running from dist/helpers, the repo root
      // is two levels up. Fall back to a few nearby locations if needed.
      const candidates = [
        resolvePath(__dirname, '../../EsriFeatureCollection.proto'),
        resolvePath(__dirname, '../../../EsriFeatureCollection.proto'),
        resolvePath(process.cwd(), 'EsriFeatureCollection.proto')
      ];
      const protoPath = candidates.find(p => {
        try { return existsSync(p); } catch { return false; }
      }) || candidates[0];
      try {
        const decoded = await esriPbf(bytes, protoPath);
        await writeFetchLog(fetchLogPath, {
          ...logBase,
          transport: 'post',
          method: 'POST',
          status,
          contentType: ctype,
          outcome: 'success-pbf',
          featuresReturned: Array.isArray((decoded as any)?.features) ? (decoded as any).features.length : undefined,
        });
        return decoded;
      } catch (e: any) {
        // If protobuf parsing fails, expose a friendly hint and mark format unsupported
        const err = e instanceof Error ? new EsriHttpError(e.message) : new EsriHttpError(String(e));
        err.status = status; err.headers = headersObj; err.code = 'FORMAT_UNSUPPORTED';
        (err as any).debug = { url: normalizedUrl, format, hint: 'pbf parse failure' };
        // Also try GET fallback once (some servers only cooperate with GET)
        const getAttempt = await tryGetFallback(normalizedUrl, body, headers, signal, fetchLogPath, logBase);
        if (getAttempt && (getAttempt.error || getAttempt.features || getAttempt.results)) {
          // Still JSON-ish → signal the caller to flip to JSON
          try {
            const p = new URL(normalizedUrl).pathname;
            if (/\/(MapServer|FeatureServer)(?:\/\d+)?\/?$/i.test(p) && !/\/query\/?$/i.test(p)) {
              err.message += ' (hint: missing /query)';
            }
          } catch {}
          await writeFetchLog(fetchLogPath, {
            ...logBase,
            transport: 'post',
            method: 'POST',
            status,
            contentType: ctype,
            outcome: 'pbf-parse-error',
            errorCode: err.code,
            errorMessage: err.message,
            hint: (err as any).debug?.hint,
          });
          throw err;
        }
        await writeFetchLog(fetchLogPath, {
          ...logBase,
          transport: 'post',
          method: 'POST',
          status,
          contentType: ctype,
          outcome: 'pbf-parse-error',
          errorCode: err.code,
          errorMessage: err.message,
          hint: (err as any).debug?.hint,
        });
        throw err;
      }
    }

    // Non-2xx: try to parse JSON error body if present for context
    let bodyJson: any = undefined;
    if (isJsonCtype || looksLikeJson(bytes)) {
      try { bodyJson = JSON.parse(Buffer.from(bytes).toString('utf8')); } catch {}
    }
    const perr = new EsriHttpError(formatArcgisErrorMessage(bodyJson, `HTTP ${status}`));
    perr.status = status; perr.headers = headersObj; perr.body = bodyJson ?? { length: bytes.byteLength };
    if (RETRYABLE_STATUSES.has(status)) perr.code = 'RETRY';
    // ArcGIS-specific auth codes
    if (status === 498 || status === 499) perr.code = 'AUTH';
    if (status === 403 && (bodyJson?.error?.message || '').toLowerCase().includes('token')) perr.code = 'AUTH';
    if (retryAfterMs != null) perr.retryAfterMs = retryAfterMs;
    await writeFetchLog(fetchLogPath, {
      ...logBase,
      transport: 'post',
      method: 'POST',
      status,
      contentType: ctype,
      outcome: 'http-error',
      errorCode: perr.code,
      errorMessage: perr.message,
      retryAfterMs,
      arcgisErrorCode: extractArcgisError(bodyJson)?.code,
      arcgisErrorMessage: extractArcgisError(bodyJson)?.message,
      arcgisErrorDetails: extractArcgisError(bodyJson)?.details,
    });
    throw perr;
  }

  // JSON path (be tolerant of text/plain JSON and HTML masquerading)
  const raw = await res.text();
  const text = stripBom(raw);
  const ctype = res.headers.get('content-type') || '';
  const isJson = JSON_CTYPE_RE.test(ctype) || /text\/plain/i.test(ctype) || (text && (text.trimStart().startsWith('{') || text.trimStart().startsWith('[')));

  let json: any;
  if (isJson && !looksLikeHtml(text)) {
    try {
      json = text && text.length ? JSON.parse(text) : {};
    } catch {
      // Try a GET fallback before declaring invalid JSON
      const getAttempt = await tryGetFallback(normalizedUrl, body, headers, signal, fetchLogPath, logBase);
      if (getAttempt !== undefined) {
        json = getAttempt;
      } else {
        const jerr = new EsriHttpError('Invalid JSON from server');
        jerr.code = 'EINVALIDJSON';
        jerr.status = status; jerr.headers = headersObj; jerr.body = text;
        (jerr as any).debug = { url: normalizedUrl, format, hint: 'json-invalid; tried GET fallback' };
        await writeFetchLog(fetchLogPath, {
          ...logBase,
          transport: 'post',
          method: 'POST',
          status,
          contentType: ctype,
          outcome: 'invalid-json',
          errorCode: jerr.code,
          errorMessage: jerr.message,
          hint: (jerr as any).debug?.hint,
        });
        throw jerr;
      }
    }
  } else {
    // Unexpected content type; attempt POST-with-pjson once before GET fallback if 2xx and body empty or html
    if (status >= 200 && status < 300 && (!text || looksLikeHtml(text)) && (body.get('f') === 'json')) {
      const spPjson = new URLSearchParams(body);
      spPjson.set('f', 'pjson');
      dlog('POST retry as pjson');
      try {
        const res2 = await ky.post(normalizedUrl, { throwHttpErrors: false, headers, body: spPjson, signal, retry: 0, timeout: 60000 });
        debugLogHeaders(res2);
        const t2 = stripBom(await res2.text());
        const ct2 = res2.headers.get('content-type') || '';
        const parsed = (res2.status >= 200 && res2.status < 300 && (/json|x-?json|pjson|text\/plain/i.test(ct2)) && !looksLikeHtml(t2))
          ? (() => { try { return JSON.parse(t2); } catch { return undefined; } })()
          : undefined;
        await writeFetchLog(fetchLogPath, {
          ...logBase,
          transport: 'post-pjson',
          method: 'POST',
          status: res2.status,
          contentType: ct2,
          outcome: res2.status >= 200 && res2.status < 300 ? 'response' : 'http-error',
          arcgisErrorCode: extractArcgisError(parsed)?.code,
          arcgisErrorMessage: extractArcgisError(parsed)?.message,
          arcgisErrorDetails: extractArcgisError(parsed)?.details,
        });
        if (res2.status >= 200 && res2.status < 300 && (/json|x-?json|pjson|text\/plain/i.test(ct2)) && !looksLikeHtml(t2)) {
          try { json = JSON.parse(t2); } catch {}
        }
      } catch (e) { dlog('POST pjson retry failed', e); }
    }

    // Unexpected content type; attempt GET fallback once
    if (json === undefined) {
      const getAttempt = await tryGetFallback(normalizedUrl, body, headers, signal, fetchLogPath, logBase);
      if (getAttempt !== undefined) return getAttempt;

      if (status >= 200 && status < 300) {
        await writeFetchLog(fetchLogPath, {
          ...logBase,
          transport: 'post',
          method: 'POST',
          status,
          contentType: ctype,
          outcome: 'unexpected-success-payload',
          bodyPreview: truncateForLog(text, 240),
        });
        return { body: text, contentType: ctype };
      }
      const herr = new EsriHttpError(`HTTP ${status}`);
      herr.status = status; herr.headers = headersObj; herr.body = text;
      if (RETRYABLE_STATUSES.has(status)) herr.code = 'RETRY';
      // ArcGIS-specific auth codes
      if (status === 498 || status === 499) herr.code = 'AUTH';
      if (status === 403 && (json?.error?.message || '').toLowerCase().includes('token')) herr.code = 'AUTH';
      (herr as any).debug = { url: normalizedUrl, format, hint: 'unexpected content-type, no GET fallback' };
      if (retryAfterMs != null) herr.retryAfterMs = retryAfterMs;
      await writeFetchLog(fetchLogPath, {
        ...logBase,
        transport: 'post',
        method: 'POST',
        status,
        contentType: ctype,
        outcome: 'http-error',
        errorCode: herr.code,
        errorMessage: herr.message,
        hint: (herr as any).debug?.hint,
        bodyPreview: truncateForLog(text, 240),
      });
      throw herr;
    }
  }

  // Even on 2xx, ArcGIS may include an error envelope
  if (status >= 200 && status < 300) {
    if (json?.error) {
      const aerr = new EsriHttpError(formatArcgisErrorMessage(json, 'ArcGIS error in success response'));
      aerr.status = status; aerr.headers = headersObj; aerr.body = json; aerr.code = json?.error?.code || 'ARCGIS_ERROR';
      (aerr as any).debug = { url: normalizedUrl, format, hint: 'ArcGIS error in success response' };
      const emsg = String(json?.error?.message || '').toLowerCase();
      if (json?.error?.code === 498 || json?.error?.code === 499 || emsg.includes('token')) {
        aerr.code = 'AUTH';
      }
      await writeFetchLog(fetchLogPath, {
        ...logBase,
        transport: 'post',
        method: 'POST',
        status,
        contentType: ctype,
        outcome: 'arcgis-error',
        errorCode: aerr.code,
        errorMessage: aerr.message,
        arcgisErrorCode: extractArcgisError(json)?.code,
        arcgisErrorMessage: extractArcgisError(json)?.message,
        arcgisErrorDetails: extractArcgisError(json)?.details,
        hint: (aerr as any).debug?.hint,
      });
      throw aerr;
    }
    await writeFetchLog(fetchLogPath, {
      ...logBase,
      transport: 'post',
      method: 'POST',
      status,
      contentType: ctype,
      outcome: 'success-json',
      featuresReturned: Array.isArray(json?.features) ? json.features.length : undefined,
    });
    return json;
  }

  // Non-2xx JSON
  const err = new EsriHttpError(formatArcgisErrorMessage(json, json?.message || `HTTP ${status}`));
  err.status = status; err.code = json?.error?.code || status; err.headers = headersObj; err.body = json;
  (err as any).debug = { url: normalizedUrl, format, hint: 'non-2xx JSON error' };
  if (RETRYABLE_STATUSES.has(status)) err.code = 'RETRY';
  // ArcGIS-specific auth codes
  if (status === 498 || status === 499) err.code = 'AUTH';
  if (status === 403 && (json?.error?.message || '').toLowerCase().includes('token')) err.code = 'AUTH';
  if (retryAfterMs != null) err.retryAfterMs = retryAfterMs;
  await writeFetchLog(fetchLogPath, {
    ...logBase,
    transport: 'post',
    method: 'POST',
    status,
    contentType: ctype,
    outcome: 'http-error',
    errorCode: err.code,
    errorMessage: err.message,
    retryAfterMs,
    arcgisErrorCode: extractArcgisError(json)?.code,
    arcgisErrorMessage: extractArcgisError(json)?.message,
    arcgisErrorDetails: extractArcgisError(json)?.details,
    hint: (err as any).debug?.hint,
  });
  throw err;

  // Defensive fallback (unreachable):
  // eslint-disable-next-line no-unreachable
  return {} as unknown;
}
