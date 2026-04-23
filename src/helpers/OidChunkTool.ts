import QueryToolBase from '../readers/queryOID.js';
import type { EsriQueryObjectType } from './esri-rest-types.js';
import { getHeapStatistics } from 'node:v8';

// Simple feature shape if helpers don't export a stricter one
type EsriFeatureType = { attributes: Record<string, unknown>; geometry?: unknown };

const DEFAULT_ID_LIST_THRESHOLD = 200000;
const ESTIMATED_BYTES_PER_OID = 32;
const MIN_ID_LIST_MEMORY_BUDGET = 64 * 1024 * 1024;
const MAX_ID_LIST_HEAP_SHARE = 0.25;

/**
 * OID-chunk query strategy implemented as a standalone tool so it can be
 * reused from different readers if needed. It uses the same retry/timeout
 * policies provided by QueryToolBase (Cockatiel) and respects the
 * _forceJson flag so we don't try PBF for ID lists or objectId requests.
 */
export default class OidChunkQueryTool extends QueryToolBase {
  private _rangeScanStarted = false;
  private _currentOidMode?: 'range' | 'objectIds';
  private _currentWindowSize?: number;
  private _currentChunkSize?: number;

  private emitAdaptiveMetrics(extra?: Record<string, unknown>) {
    this.emitMetrics({
      oidMode: this._currentOidMode,
      currentWindowSize: this._currentWindowSize,
      currentChunkSize: this._currentChunkSize,
      ...(extra ?? {}),
    });
  }

  private isExceededTransferLimitError(err: any): boolean {
    const code = String(err?.code ?? '');
    const message = String(err?.message ?? '').toLowerCase();
    return code === 'EXCEEDED_TRANSFER_LIMIT' || message.includes('exceeded transfer limit');
  }

  private isRangeTimeoutError(err: any): boolean {
    const code = String(err?.code ?? '');
    const name = String(err?.name ?? '');
    const message = String(err?.message ?? '').toLowerCase();
    return code === 'ABORT' ||
      code === 'ETIMEDOUT' ||
      code === 'ESOCKETTIMEDOUT' ||
      code === 'RETRY' ||
      name === 'TimeoutError' ||
      message.includes('fetch failed') ||
      message.includes('timed out') ||
      message.includes('timeout');
  }

  private isBisectCandidateError(err: any): boolean {
    if (this.isExceededTransferLimitError(err) || this.isRangeTimeoutError(err)) return true;
    const status = Number(err?.status ?? err?.statusCode ?? err?.code ?? 0);
    const message = String(err?.message ?? '').toLowerCase();
    return status === 500 ||
      status === 502 ||
      status === 503 ||
      status === 504 ||
      message.includes('error performing query operation') ||
      message.includes('unable to complete operation');
  }

  private async fetchObjectIdResponse(params: EsriQueryObjectType): Promise<{ objectIds: number[]; exceededTransferLimit?: boolean }> {
    const data = await (this as any)._wrappedPolicy.execute(async ({ signal }: { signal: AbortSignal }) => {
      const response = await this.postAsync(this._baseUrl, params as any, signal);
      if (!response || !Array.isArray((response as any).objectIds)) {
        const e: any = new Error('Failed to obtain objectIds');
        e.code = 'ESRI ERROR';
        e.body = response;
        throw e;
      }
      return response as { objectIds: number[]; exceededTransferLimit?: boolean };
    });
    return data as { objectIds: number[]; exceededTransferLimit?: boolean };
  }

  private async getObjectIdsForRange(oidField: string, a: number, b: number): Promise<number[]> {
    const whereBase = this.queryObjectBase.where ?? '1=1';
    const params: EsriQueryObjectType = {
      ...(this.queryObjectBase as any),
      where: `${whereBase} AND ${oidField} BETWEEN ${a} AND ${b}` as any,
      returnIdsOnly: true as any,
      returnGeometry: false as any,
      f: 'json',
    } as any;
    delete (params as any).outFields;
    delete (params as any).outSR;
    delete (params as any).outStatistics;
    delete (params as any).objectIds;

    const response = await this.fetchObjectIdResponse(params);
    if (Boolean(response?.exceededTransferLimit)) {
      const err: any = new Error('Range objectId probe exceeded transfer limit');
      err.code = 'EXCEEDED_TRANSFER_LIMIT';
      throw err;
    }

    return response.objectIds
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value))
      .sort((left, right) => left - right);
  }

  private async tryDrainRangeByObjectIds(oidField: string, a: number, b: number): Promise<boolean> {
    try {
      const ids = await this.getObjectIdsForRange(oidField, a, b);
      if (ids.length === 0) {
        this.log(`[oid] range ${oidField} BETWEEN ${a} AND ${b} returned no objectIds during fallback`);
        return true;
      }

      const desired = this.options.maxFeaturesPerRequest || 1000;
      const fallbackChunk = Math.max(1, Math.min(Math.min(desired, 5000), 50, ids.length));
      this.log(`[oid] range ${oidField} BETWEEN ${a} AND ${b} falling back to objectIds (${ids.length} ids, chunkStart=${fallbackChunk}, concurrency=1)`);
      await this._runSlicesParallel(ids, 0, { concurrency: 1, startChunk: fallbackChunk });
      return true;
    } catch (err: any) {
      this.log(`[oid] range ${oidField} BETWEEN ${a} AND ${b} objectIds fallback failed: ${String(err?.message || err || 'error')}`);
      return false;
    }
  }

  private async tryFetchSingleOidViaWhere(oid: number): Promise<boolean> {
    const oidField = String((this.options as any).oidField ?? '').trim();
    if (!oidField || !Number.isFinite(oid)) return false;

    const whereBase = this.queryObjectBase.where ?? '1=1';
    const q: EsriQueryObjectType = {
      ...this.queryObjectBase,
      where: `${whereBase} AND ${oidField} = ${Math.floor(oid)}` as any,
      objectIds: undefined as any,
      outFields: this.queryObjectBase.outFields ?? '*',
      returnGeometry: this.queryObjectBase.returnGeometry ?? true,
      returnZ: false as any,
      returnM: false as any,
      cacheHint: true as any,
      f: 'json',
    } as any;

    const features = await this.fetchFeatures(q);
    if (features.length) this.emit('data', features as EsriFeatureType[]);
    this.log(`[oid] salvaged single objectId ${oid} via WHERE fallback`);
    return true;
  }

  private async getRangeBounds(oidField: string): Promise<{ minOid: number; maxOid: number }> {
    const whereBase = this.queryObjectBase.where ?? '1=1';
    const statsBase: EsriQueryObjectType = {
      ...(this.queryObjectBase as any),
      where: whereBase,
      outStatistics: [
        { statisticType: 'min', onStatisticField: oidField, outStatisticFieldName: 'min' },
        { statisticType: 'max', onStatisticField: oidField, outStatisticFieldName: 'max' },
      ] as any,
      returnGeometry: false as any,
      f: 'json',
    } as any;
    delete (statsBase as any).outFields;
    delete (statsBase as any).outSR;
    delete (statsBase as any).objectIds;

    try {
      const stats = await this.postAsync(this._baseUrl, statsBase as any);
      const rec = Array.isArray(stats?.statistics) ? stats.statistics[0] : (stats as any)?.features?.[0]?.attributes;
      const minOid = Number(rec?.min ?? rec?.MIN);
      const maxOid = Number(rec?.max ?? rec?.MAX);
      if (Number.isFinite(minOid) && Number.isFinite(maxOid) && minOid <= maxOid) {
        return { minOid, maxOid };
      }
      throw new Error('Invalid OID min/max from statistics');
    } catch (statsErr: any) {
      this.log(`[oid] stats probe failed; trying ordered min/max (${statsErr?.message || statsErr})`);
    }

    const baseProbe: EsriQueryObjectType = {
      ...(this.queryObjectBase as any),
      where: whereBase,
      outFields: oidField,
      returnGeometry: false as any,
      resultRecordCount: 1 as any,
      returnZ: false as any,
      returnM: false as any,
      f: 'json',
    } as any;
    delete (baseProbe as any).outStatistics;
    delete (baseProbe as any).outSR;
    delete (baseProbe as any).objectIds;

    const [minResp, maxResp] = await Promise.all([
      this.postAsync(this._baseUrl, {
        ...baseProbe,
        orderByFields: `${oidField} ASC` as any,
      } as any),
      this.postAsync(this._baseUrl, {
        ...baseProbe,
        orderByFields: `${oidField} DESC` as any,
      } as any),
    ]);

    const minOid = Number((minResp as any)?.features?.[0]?.attributes?.[oidField]);
    const maxOid = Number((maxResp as any)?.features?.[0]?.attributes?.[oidField]);
    if (!Number.isFinite(minOid) || !Number.isFinite(maxOid) || minOid > maxOid) {
      throw new Error('Invalid OID min/max from ordered probe');
    }
    return { minOid, maxOid };
  }

  private emitFailure(scope: 'objectIds' | 'range', context: string, err: any, attempts: number) {
    const payload = {
      scope,
      context,
      attempts,
      code: err?.code,
      status: err?.status,
      retryAfterMs: err?.retryAfterMs,
      hint: err?.debug?.hint,
      oidMode: this._currentOidMode,
      currentWindowSize: this._currentWindowSize,
      currentChunkSize: this._currentChunkSize,
      message: String(err?.message || err || 'unknown error'),
    };
    this.emit('failure', payload);
    const meta = [
      payload.code ? `code=${payload.code}` : '',
      payload.status ? `status=${payload.status}` : '',
      payload.retryAfterMs != null ? `retryAfter=${Math.round(Number(payload.retryAfterMs))}ms` : '',
      payload.hint ? `hint=${payload.hint}` : '',
      payload.currentWindowSize != null ? `window=${payload.currentWindowSize}` : '',
      payload.currentChunkSize != null ? `chunk=${payload.currentChunkSize}` : '',
    ].filter(Boolean).join(' ');
    this.log(`[oid] ${scope} ${context} failed after ${attempts} attempt(s): ${payload.message}${meta ? ` [${meta}]` : ''}`);
  }

  protected getApproxAvailableHeapBytes(): number | undefined {
    try {
      const heapLimit = Number(getHeapStatistics().heap_size_limit || 0);
      const heapUsed = Number(process.memoryUsage().heapUsed || 0);
      if (!(heapLimit > 0) || !(heapUsed >= 0)) return undefined;
      return Math.max(0, heapLimit - heapUsed);
    } catch {
      return undefined;
    }
  }

  private getIdListThreshold(): number {
    const configured = Number((this.options as any).idListThreshold ?? process.env.ESRIQ_ID_LIST_THRESHOLD ?? DEFAULT_ID_LIST_THRESHOLD);
    return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_ID_LIST_THRESHOLD;
  }

  private shouldPreferRangeScan(total: number): boolean {
    if (!(total > 0)) return false;
    if (total >= this.getIdListThreshold()) return true;

    const oidField = String((this.options as any).oidField ?? '').trim();
    if (!oidField) return false;

    const available = this.getApproxAvailableHeapBytes();
    if (!(typeof available === 'number' && available > 0)) return false;

    const estimatedBytes = total * ESTIMATED_BYTES_PER_OID;
    const budget = Math.max(MIN_ID_LIST_MEMORY_BUDGET, Math.floor(available * MAX_ID_LIST_HEAP_SHARE));
    if (estimatedBytes >= budget) {
      this.log(`[oid] preferring range scan: estimated objectId list ${Math.round(estimatedBytes / (1024 * 1024))}MB exceeds budget ${Math.round(budget / (1024 * 1024))}MB`);
      return true;
    }

    return false;
  }

  private upperBound(sorted: number[], value: number): number {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = lo + Math.floor((hi - lo) / 2);
      if (Number(sorted[mid]) <= value) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private isAbortError(err: any): boolean {
    if (!this.isCancelled()) return false;
    const code = String(err?.code ?? '');
    const name = String(err?.name ?? '');
    return code === 'ABORT' || code === 'EABORT' || name === 'AbortError';
  }

  async runQuery(): Promise<void> {
    try {
      // Massive layers: prefer OID range scanning without materializing IDs
      const total = Number((this.options as any).totalCount || 0);
      if (this.shouldPreferRangeScan(total)) {
        this._rangeScanStarted = false;
        try {
          await this._rangeScanByOid();
          this.emit('done');
          return;
        } catch (err: any) {
          if (this._rangeScanStarted) throw err;
          this.log(`[oid] range scan unavailable; falling back to objectId list (${err?.message || err})`);
        }
      }

      // Normal path: fetch object IDs once via JSON, then run slices in parallel
      const idsResp = await this.fetchObjectIdResponse({
        ...this.queryObjectBase,
        where: this.queryObjectBase.where ?? '1=1',
        returnIdsOnly: true as any,
        returnGeometry: false as any,
        f: 'json',
      } as any);
      const objectIds = idsResp.objectIds;
      if ((this.options as any).stableOidOrder || Number.isFinite(Number((this.options as any).resumeAfterOid))) {
        objectIds.sort((a: number, b: number) => Number(a) - Number(b));
      }
      const resumeAfterOid = Number((this.options as any).resumeAfterOid);
      const startIndex = Number.isFinite(resumeAfterOid)
        ? this.upperBound(objectIds, resumeAfterOid)
        : 0;
      this.log(`[oid] objectIds=${objectIds.length}, startIndex=${startIndex}, chunk=${START_CHUNK_HINT(this.options.maxFeaturesPerRequest, this.options as any)}`);
      if (Number.isFinite(resumeAfterOid)) {
        this.log(`[oid] skipping ${startIndex} objectIds at or below resume checkpoint ${resumeAfterOid}`);
      }
      const exceededTransferLimit = Boolean((idsResp as any)?.exceededTransferLimit);
      if (exceededTransferLimit) {
        throw new Error('objectId list response exceeded transfer limit; aborting to avoid partial export');
      }
      if (total > 0 && objectIds.length > 0 && objectIds.length < total) {
        throw new Error(`objectId list response returned ${objectIds.length} IDs, expected ${total}; aborting to avoid partial export`);
      }
      if (startIndex >= objectIds.length) { this.emit('done'); return; }
      await this._runSlicesParallel(objectIds, startIndex);
      this.emit('done');
    } catch (err: any) {
      if (this.isAbortError(err)) {
        this.emit('done');
        return;
      }
      throw err;
    }
  }

  private async _runSlicesParallel(objectIds: number[], startIndex = 0, overrides?: { concurrency?: number; startChunk?: number }): Promise<void> {
    const desired = this.options.maxFeaturesPerRequest || 1000;
    const MAX_CHUNK = Math.max(1, Math.min(desired, 5000));
    const MIN_CHUNK = 1;
    const startChunk = overrides?.startChunk ?? Number((this.options as any).oidStart ?? process.env.ESRIQ_OID_START ?? 250);
    const START_CHUNK = Math.max(MIN_CHUNK, Math.min(startChunk, MAX_CHUNK));
    const GROW_STREAK = 3;
    const GROW_FACTOR = 1.5;
    const SHRINK_FACTOR = 0.5;
    const LOCAL_RETRIES = 2;
    const CONCURRENCY = Math.max(1, Number(overrides?.concurrency ?? (this.options as any).oidConcurrency ?? process.env.ESRIQ_OID_CONCURRENCY ?? 2));
    this._currentOidMode = 'objectIds';
    this._currentChunkSize = START_CHUNK;
    this._currentWindowSize = undefined;
    this.emitAdaptiveMetrics();
    this.log(`[oid] mode=objectIds total=${objectIds.length} startIndex=${startIndex} chunkStart=${START_CHUNK} concurrency=${CONCURRENCY}`);

    let idx = Math.max(0, startIndex);
    let current = START_CHUNK;
    let fullStreak = 0;
    const pending: Array<{ start: number; size: number }> = [];

    const nextSlice = (): { start: number; size: number } | null => {
      const queued = pending.shift();
      if (queued) return queued;
      if (idx >= objectIds.length) return null;
      const size = Math.max(MIN_CHUNK, Math.min(current, MAX_CHUNK, objectIds.length - idx));
      const start = idx; idx += size; return { start, size };
    };
    const onSuccess = (size: number) => {
      if (size === current) {
        fullStreak += 1;
        if (fullStreak >= GROW_STREAK && current < MAX_CHUNK) {
          current = Math.min(MAX_CHUNK, Math.max(current + 1, Math.floor(current * GROW_FACTOR)));
          fullStreak = 0;
          this._currentChunkSize = current;
          this.emitAdaptiveMetrics();
          this.log(`[oid] increased chunk to ${current}`);
        }
      } else { fullStreak = 0; }
    };
    const onFailure = () => {
      const shrunk = Math.max(MIN_CHUNK, Math.floor(current * SHRINK_FACTOR));
      if (shrunk !== current) {
        current = shrunk;
        fullStreak = 0;
        this._currentChunkSize = current;
        this.emitAdaptiveMetrics();
        this.log(`[oid] decreased chunk to ${current}`);
      }
    };

    const worker = async () => {
      while (true) {
        if (this.isCancelled()) return;
        const s = nextSlice(); if (!s) return;
        const ids = objectIds.slice(s.start, s.start + s.size);
        const q: EsriQueryObjectType = {
          ...this.queryObjectBase,
          where: undefined as any,
          objectIds: ids.join(','),
          outFields: this.queryObjectBase.outFields ?? '*',
          returnGeometry: this.queryObjectBase.returnGeometry ?? true,
          returnZ: false as any,
          returnM: false as any,
          cacheHint: true as any,
          f: 'json',
        } as any;
        let tries = 0; let ok = false;
        let lastErr: any;
        while (tries <= LOCAL_RETRIES && !ok) {
          try {
            const features = await this.fetchFeatures(q);
            if (this.isCancelled()) return;
            if (features.length) this.emit('data', features as EsriFeatureType[]);
            ok = true; onSuccess(s.size);
          } catch (err: any) {
            if (this.isAbortError(err)) return;
            lastErr = err;
            if (this.isBisectCandidateError(err) && s.size > 1) {
              const leftSize = Math.max(1, Math.floor(s.size / 2));
              const rightSize = s.size - leftSize;
              onFailure();
              if (rightSize > 0) pending.unshift({ start: s.start + leftSize, size: rightSize });
              pending.unshift({ start: s.start, size: leftSize });
              this.log(`[oid] split objectIds ${ids[0]}..${ids[ids.length - 1]} -> ${objectIds[s.start]}..${objectIds[s.start + leftSize - 1]}${rightSize > 0 ? `, ${objectIds[s.start + leftSize]}..${objectIds[s.start + s.size - 1]}` : ''}`);
              ok = true;
              break;
            }
            const attempt = tries + 1;
            const meta = [
              err?.code ? `code=${err.code}` : '',
              err?.status ? `status=${err.status}` : '',
              err?.retryAfterMs != null ? `retryAfter=${Math.round(Number(err.retryAfterMs))}ms` : '',
              err?.debug?.hint ? `hint=${err.debug.hint}` : '',
            ].filter(Boolean).join(' ');
            this.log(`[oid] objectIds ${ids[0]}..${ids[ids.length - 1]} attempt ${attempt}/${LOCAL_RETRIES + 1} failed: ${String(err?.message || err || 'error')}${meta ? ` [${meta}]` : ''}`);
            tries += 1; this.errorCount++; onFailure();
            if (this.errorCount > this.options.maxErrors) { this.emitFailure('objectIds', `${ids[0]}..${ids[ids.length - 1]}`, err, attempt); throw err; }
            if (tries > LOCAL_RETRIES) break;
          }
        }
        if (!ok) {
          if (s.size === 1) {
            try {
              const salvaged = await this.tryFetchSingleOidViaWhere(ids[0]);
              if (salvaged) {
                ok = true;
                continue;
              }
            } catch (err: any) {
              lastErr = err;
            }
          }
          const err = lastErr instanceof Error ? lastErr : new Error(String(lastErr || 'OID slice failed after retries'));
          err.message = `${err.message} (objectIds ${ids[0]}..${ids[ids.length - 1]})`;
          this.emitFailure('objectIds', `${ids[0]}..${ids[ids.length - 1]}`, err, tries);
          throw err;
        }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  }

  private async _rangeScanByOid(): Promise<void> {
    if (this.isCancelled()) return;
    this._rangeScanStarted = false;
    const oidField = String((this.options as any).oidField ?? '').trim();
    if (!oidField) throw new Error('Could not determine OID field for range scan');
    if (this.isCancelled()) return;
    const { minOid, maxOid } = await this.getRangeBounds(oidField);

    const desired = this.options.maxFeaturesPerRequest || 1000;
    const MAX_WINDOW = Math.max(1, Math.min(desired * 5, 20000));
    const MIN_WINDOW = 100;
    let window = Math.max(MIN_WINDOW, Math.min(Number((this.options as any).oidWindow ?? process.env.ESRIQ_OID_WINDOW ?? 1000), MAX_WINDOW));
    const GROW_STREAK = 3; let fullStreak = 0;
    const LOCAL_RETRIES = 2;
    const CONCURRENCY = Math.max(1, Number((this.options as any).oidConcurrency ?? process.env.ESRIQ_OID_CONCURRENCY ?? 2));
    const resumeAfterOid = Number((this.options as any).resumeAfterOid);
    let start = Number.isFinite(resumeAfterOid) ? Math.max(minOid, Math.floor(resumeAfterOid) + 1) : minOid;
    const pending: Array<{ a: number; b: number }> = [];
    this._rangeScanStarted = true;
    this._currentOidMode = 'range';
    this._currentWindowSize = window;
    this._currentChunkSize = undefined;
    this.emitAdaptiveMetrics();
    this.log(`[oid] mode=range oidField=${oidField} min=${minOid} max=${maxOid} start=${start} windowStart=${window} concurrency=${CONCURRENCY}`);
    const nextRange = (): { a: number; b: number } | null => {
      const queued = pending.shift();
      if (queued) return queued;
      if (start > maxOid) return null;
      const a = start;
      const b = Math.min(maxOid, a + window - 1);
      start = b + 1;
      return { a, b };
    };
    const onSuccess = () => {
      fullStreak += 1;
      if (fullStreak >= GROW_STREAK) {
        window = Math.min(MAX_WINDOW, Math.floor(window * 1.5));
        fullStreak = 0;
        this._currentWindowSize = window;
        this.emitAdaptiveMetrics();
        this.log(`[oid] increased window to ${window}`);
      }
    };
    const onFailure = () => {
      const shrunk = Math.max(MIN_WINDOW, Math.floor(window * 0.5));
      if (shrunk !== window) {
        window = shrunk;
        this._currentWindowSize = window;
        this.emitAdaptiveMetrics();
      }
      fullStreak = 0;
      this.log(`[oid] decreased window to ${window}`);
    };
    const worker = async () => {
      while (true) {
        if (this.isCancelled()) return;
        const r = nextRange(); if (!r) return;
        const whereBase = this.queryObjectBase.where ?? '1=1';
        const q: EsriQueryObjectType = {
          ...this.queryObjectBase,
          where: `${whereBase} AND ${oidField} BETWEEN ${r.a} AND ${r.b}` as any,
          objectIds: undefined as any,
          outFields: this.queryObjectBase.outFields ?? '*',
          returnGeometry: this.queryObjectBase.returnGeometry ?? true,
          returnZ: false as any,
          returnM: false as any,
          cacheHint: true as any,
          f: 'json',
        } as any;
        let tries = 0; let ok = false;
        let lastErr: any;
        while (tries <= LOCAL_RETRIES && !ok) {
          try {
            const features = await this.fetchFeatures(q);
            if (features.length) this.emit('data', features as EsriFeatureType[]);
            ok = true;
            onSuccess();
          }
          catch (err: any) {
            if (this.isAbortError(err)) return;
            lastErr = err;
            if (this.isBisectCandidateError(err) && r.a < r.b) {
              const mid = r.a + Math.floor((r.b - r.a) / 2);
              onFailure();
              pending.unshift({ a: mid + 1, b: r.b });
              pending.unshift({ a: r.a, b: mid });
              const why = this.isExceededTransferLimitError(err)
                ? 'transfer limit'
                : (this.isRangeTimeoutError(err) ? 'timeout' : 'server error');
              this.log(`[oid] split range ${oidField} BETWEEN ${r.a} AND ${r.b} after ${why} -> ${r.a}..${mid}, ${mid + 1}..${r.b}`);
              ok = true;
              break;
            }
            const attempt = tries + 1;
            const meta = [
              err?.code ? `code=${err.code}` : '',
              err?.status ? `status=${err.status}` : '',
              err?.retryAfterMs != null ? `retryAfter=${Math.round(Number(err.retryAfterMs))}ms` : '',
              err?.debug?.hint ? `hint=${err.debug.hint}` : '',
            ].filter(Boolean).join(' ');
            this.log(`[oid] range ${oidField} BETWEEN ${r.a} AND ${r.b} attempt ${attempt}/${LOCAL_RETRIES + 1} failed: ${String(err?.message || err || 'error')}${meta ? ` [${meta}]` : ''}`);
            tries += 1;
            this.errorCount++;
            onFailure();
            if (this.errorCount > this.options.maxErrors) { this.emitFailure('range', `${oidField} BETWEEN ${r.a} AND ${r.b}`, err, attempt); throw err; }
            if (tries > LOCAL_RETRIES) break;
          }
        }
        if (!ok) {
          const salvaged = await this.tryDrainRangeByObjectIds(oidField, r.a, r.b);
          if (salvaged) {
            ok = true;
            continue;
          }
          const err = lastErr instanceof Error ? lastErr : new Error(String(lastErr || 'OID range failed after retries'));
          err.message = `${err.message} (${oidField} BETWEEN ${r.a} AND ${r.b})`;
          this.emitFailure('range', `${oidField} BETWEEN ${r.a} AND ${r.b}`, err, tries);
          throw err;
        }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  }
}

function START_CHUNK_HINT(maxFeaturesPerRequest: number | undefined, options: { oidStart?: number } | any): number {
  const desired = maxFeaturesPerRequest || 1000;
  const MAX_CHUNK = Math.max(1, Math.min(desired, 5000));
  const MIN_CHUNK = 1;
  return Math.max(MIN_CHUNK, Math.min(Number((options as any).oidStart ?? process.env.ESRIQ_OID_START ?? 250), MAX_CHUNK));
}
