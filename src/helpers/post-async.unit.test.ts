import { beforeEach, describe, expect, jest, test } from '@jest/globals';

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
  beforeEach(() => {
    postMock.mockReset();
    getMock.mockReset();
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
});
