import { describe, expect, test, beforeEach, afterEach } from '@jest/globals';
import { jest } from '@jest/globals';
import type { Feature, Point } from 'geojson';
import type { CliOptionsType } from '../cli.js';
import Stdout from './Stdout.js';
import { Writable } from 'stream';

const options: CliOptionsType = {
  format: 'geojson',
  'no-bbox': true,
};

// Keep a reference to the original write so we can restore it
const originalWrite = process.stdout.write.bind(process.stdout);

// We'll stub a writable to capture output and emulate backpressure-friendly writes
class CaptureWritable extends Writable {
  public chunks: string[] = [];
  _write(chunk: any, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    this.chunks.push(typeof chunk === 'string' ? chunk : String(chunk));
    callback();
  }
}

describe('Stdout', () => {
  let capture: CaptureWritable;
  let writeSpy: jest.SpiedFunction<typeof process.stdout.write>;
  let stdout: Stdout;

  beforeEach(() => {
    capture = new CaptureWritable();
    writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(capture.write.bind(capture) as any);
    stdout = new Stdout(options);
  });

  afterEach(() => {
    writeSpy.mockRestore();
    // Ensure we restore the original write just in case
    (process.stdout.write as any) = originalWrite;
  });

  test('writes a GeoJSON FeatureCollection header on open()', async () => {
    await stdout.open();
    const out = capture.chunks.join('');
    expect(out).toContain('{"type": "FeatureCollection", "features": [');
  });

  test('writes compact GeoJSON features (no pretty) and uses delimiter between features', async () => {
    await stdout.open();

    const feature1: Feature<Point, { [name: string]: any }> = {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [0, 0] },
      properties: { name: 'one' },
    };
    const feature2: Feature<Point, { [name: string]: any }> = {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [1, 1] },
      properties: { name: 'two' },
    };

    await stdout.writeFeature(feature1);
    await stdout.writeFeature(feature2);

    const out = capture.chunks.join('');
    // Should contain the first feature JSON
    expect(out).toContain('{"type":"Feature","geometry":{"type":"Point","coordinates":[0,0]},"properties":{"name":"one"}}');
    // Should contain a comma delimiter between features
    expect(out).toContain('},{"type":"Feature","geometry":{"type":"Point","coordinates":[1,1]},"properties":{"name":"two"}}');
  });

  test('writes a FeatureCollection footer on close()', async () => {
    await stdout.open();
    await stdout.close();
    const out = capture.chunks.join('');
    expect(out.endsWith(']}')).toBe(true);
  });
});
