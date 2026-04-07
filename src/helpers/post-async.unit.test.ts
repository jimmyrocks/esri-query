import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const postMock = jest.fn();
const getMock = jest.fn();

jest.unstable_mockModule('ky', () => ({
  default: {
    post: postMock,
    get: getMock,
  },
}));

const { default: postAsync } = await import('./post-async.js');

describe('post-async pbf/json fallback behavior', () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    postMock.mockReset();
    getMock.mockReset();
  });

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('accepts valid JSON payloads on pbf requests without GET fallback', async () => {
    postMock.mockResolvedValueOnce(new Response(
      JSON.stringify({ features: [{ attributes: { OBJECTID: 1 } }] }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      },
    ));

    const out: any = await postAsync('https://example.com/FeatureServer/0/query', {
      f: 'pbf',
      where: '1=1',
      outFields: '*',
      returnGeometry: true,
    } as any);

    expect(Array.isArray(out.features)).toBe(true);
    expect(out.features.length).toBe(1);
    expect(postMock).toHaveBeenCalledTimes(1);
    expect(getMock).not.toHaveBeenCalled();
  });

  test('returns FORMAT_UNSUPPORTED from json error without extra GET fallback', async () => {
    postMock.mockResolvedValueOnce(new Response(
      JSON.stringify({ error: { message: 'Output format not supported.' } }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      },
    ));

    await expect(postAsync('https://example.com/FeatureServer/0/query', {
      f: 'pbf',
      where: '1=1',
      outFields: '*',
      returnGeometry: true,
    } as any)).rejects.toMatchObject({ code: 'FORMAT_UNSUPPORTED' });

    expect(postMock).toHaveBeenCalledTimes(1);
    expect(getMock).not.toHaveBeenCalled();
  });

  test('forwards custom request headers to POST and GET fallback requests', async () => {
    postMock.mockResolvedValueOnce(new Response('', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }));
    getMock.mockResolvedValueOnce(new Response(
      JSON.stringify({ features: [{ attributes: { OBJECTID: 2 } }] }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      },
    ));

    const out: any = await postAsync('https://example.com/FeatureServer/0/query', {
      f: 'json',
      where: '1=1',
      outFields: '*',
      returnGeometry: true,
    } as any, {
      headers: {
        Cookie: 'SESSION=abc123',
        'X-Test': 'present',
      },
    });

    expect(Array.isArray(out.features)).toBe(true);
    expect(postMock).toHaveBeenCalledWith(
      'https://example.com/FeatureServer/0/query',
      expect.objectContaining({
        headers: expect.objectContaining({
          Cookie: 'SESSION=abc123',
          'X-Test': 'present',
        }),
      }),
    );
    expect(getMock).toHaveBeenCalledWith(
      expect.stringContaining('https://example.com/FeatureServer/0/query?'),
      expect.objectContaining({
        headers: expect.objectContaining({
          Cookie: 'SESSION=abc123',
          'X-Test': 'present',
        }),
      }),
    );
  });

  test('writes fetch-log records with ArcGIS error details from success envelopes', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'esri-query-fetch-log-'));
    tempDirs.push(tempDir);
    const fetchLogPath = join(tempDir, 'fetch.jsonl');

    postMock.mockResolvedValueOnce(new Response(
      JSON.stringify({ error: { code: 498, message: 'Invalid token.', details: ['Token Required'] } }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      },
    ));

    await expect(postAsync('https://example.com/FeatureServer/0/query', {
      f: 'json',
      where: '1=1',
      outFields: '*',
      returnGeometry: true,
    } as any, {
      fetchLogPath,
    })).rejects.toThrow('Invalid token. | Token Required');

    const lines = readFileSync(fetchLogPath, 'utf8').trim().split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    const entry = JSON.parse(lines[lines.length - 1]);
    expect(entry.url).toBe('https://example.com/FeatureServer/0/query');
    expect(entry.transport).toBe('post');
    expect(entry.outcome).toBe('arcgis-error');
    expect(entry.arcgisErrorCode).toBe(498);
    expect(entry.arcgisErrorMessage).toBe('Invalid token.');
    expect(entry.arcgisErrorDetails).toEqual(['Token Required']);
  });
});
