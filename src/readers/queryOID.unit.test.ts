import { afterEach, describe, expect, test } from '@jest/globals';
import QueryToolBase, { QueryOptions } from './queryOID.js';

class TestQueryTool extends QueryToolBase {}

function makeTool(overrides: Partial<QueryOptions> = {}) {
  return new TestQueryTool({
    maxErrors: 3,
    maxFeaturesPerRequest: 1000,
    queryObjectBase: {
      where: '1=1',
      outFields: '*',
      returnGeometry: true,
      f: 'json',
    } as any,
    baseUrl: new URL('https://example.com/arcgis/rest/services/Foo/FeatureServer/0'),
    ...overrides,
  } as QueryOptions);
}

describe('QueryToolBase rate limiter configuration', () => {
  const originalRateBurst = process.env.ESRIQ_RATE_BURST;
  const originalRatePerSec = process.env.ESRIQ_RATE_PER_SEC;

  afterEach(() => {
    if (originalRateBurst == null) delete process.env.ESRIQ_RATE_BURST;
    else process.env.ESRIQ_RATE_BURST = originalRateBurst;

    if (originalRatePerSec == null) delete process.env.ESRIQ_RATE_PER_SEC;
    else process.env.ESRIQ_RATE_PER_SEC = originalRatePerSec;
  });

  test('falls back to environment rate settings when per-job options are absent', () => {
    process.env.ESRIQ_RATE_BURST = '11';
    process.env.ESRIQ_RATE_PER_SEC = '7';

    const tool = makeTool();
    const limiter = (tool as any)._limiter;
    const opts = limiter._store.storeOptions;

    expect(opts.reservoir).toBe(11);
    expect(opts.reservoirRefreshAmount).toBe(7);
  });

  test('honors per-job rate settings ahead of environment defaults', () => {
    process.env.ESRIQ_RATE_BURST = '11';
    process.env.ESRIQ_RATE_PER_SEC = '7';

    const tool = makeTool({ rateBurst: 3, rateCapacityPerSec: 2 });
    const limiter = (tool as any)._limiter;
    const opts = limiter._store.storeOptions;

    expect(opts.reservoir).toBe(3);
    expect(opts.reservoirRefreshAmount).toBe(2);
  });

  test('shares a limiter only when the host and effective rate profile match', () => {
    const first = makeTool({ rateBurst: 5, rateCapacityPerSec: 4 });
    const second = makeTool({ rateBurst: 5, rateCapacityPerSec: 4 });
    const third = makeTool({ rateBurst: 9, rateCapacityPerSec: 8 });

    expect((first as any)._limiter).toBe((second as any)._limiter);
    expect((first as any)._limiter).not.toBe((third as any)._limiter);
  });
});
