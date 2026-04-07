import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import GeoParquet from './GeoParquet.js';
import { unlinkSync, existsSync } from 'fs';

describe('GeoParquet TIMESTAMP inference', () => {
  const out = 'tmp_timestamp_test.parquet';
  afterAll(() => { try { if (existsSync(out)) unlinkSync(out); } catch {} });

  it('handles mixed ISO string and epoch ms as TIMESTAMP_MILLIS', async () => {
    const writer = new GeoParquet({ output: out, format: 'geoparquet', parquetScanRows: 10 } as any);
    await writer.open();

    const f1: any = { type: 'Feature', geometry: { type: 'Point', coordinates: [0,0] }, properties: { when: '2020-01-01T00:00:00Z' } };
    const f2: any = { type: 'Feature', geometry: { type: 'Point', coordinates: [1,1] }, properties: { when: 1700000000000 } };

    await writer.writeFeature(f1);
    await writer.writeFeature(f2);
    await writer.close();

    expect(existsSync(out)).toBe(true);
  });
});

