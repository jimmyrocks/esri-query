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
    if (this.isCancelled()) return true;
    const code = String(err?.code ?? '');
    const name = String(err?.name ?? '');
    return code === 'ABORT' || code === 'EABORT' || name === 'AbortError';
  }

  async runQuery(): Promise<void> {
    try {
      // Massive layers: prefer OID range scanning without materializing IDs
      const total = Number((this.options as any).totalCount || 0);
      if (this.shouldPreferRangeScan(total)) {
        try {
          await this._rangeScanByOid();
          this.emit('done');
          return;
        } catch (err: any) {
          this.log(`[oid] range scan unavailable; falling back to objectId list (${err?.message || err})`);
        }
      }

      // Normal path: fetch object IDs once via JSON, then run slices in parallel
      const idsResp = await (this as any)._wrappedPolicy.execute(async ({ signal }: { signal: AbortSignal }) => {
        const params: any = {
          ...this.queryObjectBase,
          where: this.queryObjectBase.where ?? '1=1',
          returnIdsOnly: true,
          returnGeometry: false,
          f: 'json',
        };
        const data = await this.postAsync(this._baseUrl, params, signal);
        if (!data || !Array.isArray(data.objectIds)) {
          const e: any = new Error('Failed to obtain objectIds');
          e.code = 'ESRI ERROR'; e.body = data; throw e;
        }
        return data as { objectIds: number[] };
      });
      const objectIds = idsResp.objectIds;
      if ((this.options as any).stableOidOrder || Number.isFinite(Number((this.options as any).resumeAfterOid))) {
        objectIds.sort((a: number, b: number) => Number(a) - Number(b));
      }
      const resumeAfterOid = Number((this.options as any).resumeAfterOid);
      const startIndex = Number.isFinite(resumeAfterOid)
        ? this.upperBound(objectIds, resumeAfterOid)
        : 0;
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

  private async _runSlicesParallel(objectIds: number[], startIndex = 0): Promise<void> {
    const desired = this.options.maxFeaturesPerRequest || 1000;
    const MAX_CHUNK = Math.max(1, Math.min(desired, 5000));
    const MIN_CHUNK = 1;
    const START_CHUNK = Math.max(MIN_CHUNK, Math.min(Number((this.options as any).oidStart ?? process.env.ESRIQ_OID_START ?? 250), MAX_CHUNK));
    const GROW_STREAK = 3;
    const GROW_FACTOR = 1.5;
    const SHRINK_FACTOR = 0.5;
    const LOCAL_RETRIES = 2;
    const CONCURRENCY = Math.max(1, Number((this.options as any).oidConcurrency ?? process.env.ESRIQ_OID_CONCURRENCY ?? 2));

    let idx = Math.max(0, startIndex);
    let current = START_CHUNK;
    let fullStreak = 0;

    const nextSlice = (): { start: number; size: number } | null => {
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
          this.log(`[oid] increased chunk to ${current}`);
        }
      } else { fullStreak = 0; }
    };
    const onFailure = () => {
      const shrunk = Math.max(MIN_CHUNK, Math.floor(current * SHRINK_FACTOR));
      if (shrunk !== current) { current = shrunk; fullStreak = 0; this.log(`[oid] decreased chunk to ${current}`); }
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
        while (tries <= LOCAL_RETRIES && !ok) {
          try {
            const features = await this.fetchFeatures(q);
            if (this.isCancelled()) return;
            if (features.length) this.emit('data', features as EsriFeatureType[]);
            ok = true; onSuccess(s.size);
          } catch (err: any) {
            if (this.isAbortError(err)) return;
            tries += 1; this.errorCount++; onFailure();
            if (this.errorCount > this.options.maxErrors) { this.emit('error', err); return; }
            if (tries > LOCAL_RETRIES) break;
          }
        }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  }

  private async _rangeScanByOid(): Promise<void> {
    if (this.isCancelled()) return;
    const oidField = String((this.options as any).oidField ?? '').trim();
    if (!oidField) throw new Error('Could not determine OID field for range scan');
    if (this.isCancelled()) return;
    const statsBase: EsriQueryObjectType = {
      ...(this.queryObjectBase as any),
      where: this.queryObjectBase.where ?? '1=1',
      outStatistics: [
        { statisticType: 'min', onStatisticField: oidField, outStatisticFieldName: 'min' },
        { statisticType: 'max', onStatisticField: oidField, outStatisticFieldName: 'max' },
      ] as any,
      returnGeometry: false as any,
      f: 'json',
    } as any;
    // Statistics queries should not inherit feature-return params like outFields/outSR.
    delete (statsBase as any).outFields;
    delete (statsBase as any).outSR;
    delete (statsBase as any).objectIds;

    const stats = await this.postAsync(this._baseUrl, statsBase as any);
    const rec = Array.isArray(stats?.statistics) ? stats.statistics[0] : (stats as any)?.features?.[0]?.attributes;
    const minOid = Number(rec?.min ?? rec?.MIN); const maxOid = Number(rec?.max ?? rec?.MAX);
    if (!Number.isFinite(minOid) || !Number.isFinite(maxOid) || minOid > maxOid) throw new Error('Invalid OID min/max for range scan');

    const desired = this.options.maxFeaturesPerRequest || 1000;
    const MAX_WINDOW = Math.max(1, Math.min(desired * 5, 20000));
    const MIN_WINDOW = 100;
    let window = Math.max(MIN_WINDOW, Math.min(Number((this.options as any).oidWindow ?? process.env.ESRIQ_OID_WINDOW ?? 5000), MAX_WINDOW));
    const GROW_STREAK = 3; let fullStreak = 0;
    const LOCAL_RETRIES = 2;
    const CONCURRENCY = Math.max(1, Number((this.options as any).oidConcurrency ?? process.env.ESRIQ_OID_CONCURRENCY ?? 2));
    const resumeAfterOid = Number((this.options as any).resumeAfterOid);
    let start = Number.isFinite(resumeAfterOid) ? Math.max(minOid, Math.floor(resumeAfterOid) + 1) : minOid;
    const nextRange = (): { a: number; b: number } | null => {
      if (start > maxOid) return null; const a = start; const b = Math.min(maxOid, a + window - 1); start = b + 1; return { a, b };
    };
    const onSuccess = () => { fullStreak += 1; if (fullStreak >= GROW_STREAK) { window = Math.min(MAX_WINDOW, Math.floor(window * 1.5)); fullStreak = 0; this.log(`[oid] increased window to ${window}`); } };
    const onFailure = () => { window = Math.max(MIN_WINDOW, Math.floor(window * 0.5)); fullStreak = 0; this.log(`[oid] decreased window to ${window}`); };
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
        while (tries <= LOCAL_RETRIES && !ok) {
          try { const features = await this.fetchFeatures(q); if (features.length) this.emit('data', features as EsriFeatureType[]); ok = true; onSuccess(); }
          catch (err: any) {
            if (this.isAbortError(err)) return;
            tries += 1;
            this.errorCount++;
            onFailure();
            if (this.errorCount > this.options.maxErrors) { this.emit('error', err); return; }
            if (tries > LOCAL_RETRIES) break;
          }
        }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  }
}
