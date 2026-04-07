import { afterEach, describe, expect, test } from '@jest/globals';
import { existsSync, rmSync, statSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import FlatGeobufWriter from './FlatGeobuf.js';

describe('FlatGeobufWriter', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('writes a part file for valid features', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'esri-query-fgb-'));
    tempDirs.push(tempDir);
    const outputPath = join(tempDir, 'output.fgb');
    const writer = new FlatGeobufWriter({ output: outputPath, overwrite: true } as any, { outputWkid: 4326 } as any);

    await writer.open();
    await writer.writeFeature({
      type: 'Feature',
      properties: { OBJECTID: 1 },
      geometry: { type: 'Point', coordinates: [-118.2, 34.1] },
    } as any);
    await writer.close();

    const partPath = join(tempDir, 'output.part0.fgb');
    expect(existsSync(partPath)).toBe(true);
    expect(statSync(partPath).size).toBeGreaterThan(0);
    expect(writer.status.records).toBe(1);
  });

  test('keeps degenerate geometries by normalizing them before serialization', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'esri-query-fgb-'));
    tempDirs.push(tempDir);
    const outputPath = join(tempDir, 'output.fgb');
    const writer = new FlatGeobufWriter({ output: outputPath, overwrite: true } as any, { outputWkid: 4326 } as any);

    await writer.open();
    await expect(writer.writeFeature({
      type: 'Feature',
      properties: { OBJECTID: 1 },
      geometry: null,
    } as any)).resolves.toBeDefined();
    await expect(writer.writeFeature({
      type: 'Feature',
      properties: { OBJECTID: 2 },
      geometry: { type: 'Point' },
    } as any)).resolves.toBeDefined();
    await writer.close();

    const partPath = join(tempDir, 'output.part0.fgb');
    expect(existsSync(partPath)).toBe(true);
    expect(statSync(partPath).size).toBeGreaterThan(0);
    expect(writer.status.records).toBe(2);
    expect(writer.status.invalid).toBe(1);
  });
});
