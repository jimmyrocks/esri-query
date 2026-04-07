import { describe, expect, test, jest } from '@jest/globals';
import OidChunkQueryTool from './OidChunkTool.js';

function makeTool(overrides: Record<string, unknown> = {}) {
  return new OidChunkQueryTool({
    maxErrors: 3,
    maxFeaturesPerRequest: 1000,
    queryObjectBase: {
      where: '1=1',
      outFields: '*',
      returnGeometry: true,
      f: 'json',
    } as any,
    baseUrl: new URL('https://example.com/arcgis/rest/services/Foo/FeatureServer/0'),
    totalCount: 10,
    idListThreshold: 1,
    oidWindow: 5000,
    oidConcurrency: 1,
    ...overrides,
  } as any);
}

describe('OidChunkQueryTool range scan', () => {
  test('uses provided oidField and skips extra metadata fetch', async () => {
    const tool = makeTool({ oidField: 'OBJECTID' });
    const postAsyncMock = jest.fn(async (_url: URL, params: Record<string, unknown>) => {
      if ((params as any).outStatistics) return { statistics: [{ min: 1, max: 3 }] };
      throw new Error(`Unexpected postAsync call: ${JSON.stringify(params)}`);
    });
    const fetchFeaturesMock = jest.fn(async () => []);

    (tool as any).postAsync = postAsyncMock;
    (tool as any).fetchFeatures = fetchFeaturesMock;

    await tool.runQuery();

    expect(postAsyncMock).toHaveBeenCalledTimes(1);
    expect((postAsyncMock.mock.calls[0][1] as any).outStatistics).toBeDefined();
    expect(fetchFeaturesMock).toHaveBeenCalledTimes(1);
    const where = String((fetchFeaturesMock.mock.calls[0][0] as any).where || '');
    expect(where).toContain('OBJECTID BETWEEN 1 AND 3');
  });

  test('falls back to objectIds when oidField is missing in range-scan mode', async () => {
    const tool = makeTool({ oidField: undefined, totalCount: 3 });
    const postAsyncMock = jest.fn(async (_url: URL, params: Record<string, unknown>) => {
      if ((params as any).returnIdsOnly) {
        return { objectIds: [1, 2, 3] };
      }
      throw new Error('Unexpected range-scan probe');
    });
    const fetchFeaturesMock = jest.fn(async () => []);

    (tool as any).postAsync = postAsyncMock;
    (tool as any).fetchFeatures = fetchFeaturesMock;

    await tool.runQuery();

    expect(postAsyncMock).toHaveBeenCalledTimes(1);
    expect((postAsyncMock.mock.calls[0][1] as any).returnIdsOnly).toBe(true);
    expect(fetchFeaturesMock).toHaveBeenCalledTimes(1);
  });

  test('falls back to objectIds when range-scan probe fails', async () => {
    const tool = makeTool({ oidField: 'OBJECTID', totalCount: 3 });
    const postAsyncMock = jest.fn(async (_url: URL, params: Record<string, unknown>) => {
      if ((params as any).outStatistics) {
        throw new Error('Unable to perform query. Please check your parameters.');
      }
      if ((params as any).returnIdsOnly) {
        return { objectIds: [1, 2, 3] };
      }
      throw new Error(`Unexpected postAsync call: ${JSON.stringify(params)}`);
    });
    const fetchFeaturesMock = jest.fn(async () => []);

    (tool as any).postAsync = postAsyncMock;
    (tool as any).fetchFeatures = fetchFeaturesMock;

    await tool.runQuery();

    expect(postAsyncMock).toHaveBeenCalledTimes(2);
    expect((postAsyncMock.mock.calls[0][1] as any).outStatistics).toBeDefined();
    expect((postAsyncMock.mock.calls[1][1] as any).returnIdsOnly).toBe(true);
    expect(fetchFeaturesMock).toHaveBeenCalledTimes(1);
    expect(String((fetchFeaturesMock.mock.calls[0][0] as any).objectIds || '')).toBe('1,2,3');
  });

  test('fails fast when objectId fallback returns fewer ids than the known total', async () => {
    const tool = makeTool({ oidField: 'OBJECTID', totalCount: 10 });
    const postAsyncMock = jest.fn(async (_url: URL, params: Record<string, unknown>) => {
      if ((params as any).outStatistics) {
        throw new Error('Unable to perform query. Please check your parameters.');
      }
      if ((params as any).returnIdsOnly) {
        return { objectIds: [1, 2, 3] };
      }
      throw new Error(`Unexpected postAsync call: ${JSON.stringify(params)}`);
    });
    const fetchFeaturesMock = jest.fn(async () => []);

    (tool as any).postAsync = postAsyncMock;
    (tool as any).fetchFeatures = fetchFeaturesMock;

    await expect(tool.runQuery()).rejects.toThrow('objectId list response returned 3 IDs, expected 10');
    expect(fetchFeaturesMock).not.toHaveBeenCalled();
  });

  test('fails fast when objectId fallback reports exceeded transfer limit', async () => {
    const tool = makeTool({ oidField: 'OBJECTID', totalCount: 10 });
    const postAsyncMock = jest.fn(async (_url: URL, params: Record<string, unknown>) => {
      if ((params as any).outStatistics) {
        throw new Error('Unable to perform query. Please check your parameters.');
      }
      if ((params as any).returnIdsOnly) {
        return { objectIds: [1, 2, 3], exceededTransferLimit: true };
      }
      throw new Error(`Unexpected postAsync call: ${JSON.stringify(params)}`);
    });

    (tool as any).postAsync = postAsyncMock;

    await expect(tool.runQuery()).rejects.toThrow('objectId list response exceeded transfer limit');
  });

  test('sorts and filters objectIds when resumeAfterOid is provided', async () => {
    const tool = makeTool({ oidField: undefined, totalCount: 5, resumeAfterOid: 4, stableOidOrder: true, idListThreshold: 999999 });
    const postAsyncMock = jest.fn(async (_url: URL, params: Record<string, unknown>) => {
      if ((params as any).returnIdsOnly) {
        return { objectIds: [9, 3, 7, 1, 5] };
      }
      throw new Error(`Unexpected postAsync call: ${JSON.stringify(params)}`);
    });
    const fetchFeaturesMock = jest.fn(async () => []);

    (tool as any).postAsync = postAsyncMock;
    (tool as any).fetchFeatures = fetchFeaturesMock;

    await tool.runQuery();

    expect(fetchFeaturesMock).toHaveBeenCalledTimes(1);
    expect(String((fetchFeaturesMock.mock.calls[0][0] as any).objectIds || '')).toBe('5,7,9');
  });

  test('prefers range scan early when the estimated objectId list would exceed the heap budget', async () => {
    const tool = makeTool({ oidField: 'OBJECTID', totalCount: 3000000, idListThreshold: 999999999 });
    const postAsyncMock = jest.fn(async (_url: URL, params: Record<string, unknown>) => {
      if ((params as any).outStatistics) return { statistics: [{ min: 1, max: 3 }] };
      throw new Error(`Unexpected postAsync call: ${JSON.stringify(params)}`);
    });
    const fetchFeaturesMock = jest.fn(async () => []);

    (tool as any).postAsync = postAsyncMock;
    (tool as any).fetchFeatures = fetchFeaturesMock;
    (tool as any).getApproxAvailableHeapBytes = () => 32 * 1024 * 1024;

    await tool.runQuery();

    expect(postAsyncMock).toHaveBeenCalledTimes(1);
    expect((postAsyncMock.mock.calls[0][1] as any).outStatistics).toBeDefined();
    expect(fetchFeaturesMock).toHaveBeenCalledTimes(1);
  });

  test('respects resumeAfterOid during range scan without falling back to objectIds', async () => {
    const tool = makeTool({ oidField: 'OBJECTID', totalCount: 10, resumeAfterOid: 5 });
    const postAsyncMock = jest.fn(async (_url: URL, params: Record<string, unknown>) => {
      if ((params as any).outStatistics) return { statistics: [{ min: 1, max: 10 }] };
      throw new Error(`Unexpected postAsync call: ${JSON.stringify(params)}`);
    });
    const fetchFeaturesMock = jest.fn(async () => []);

    (tool as any).postAsync = postAsyncMock;
    (tool as any).fetchFeatures = fetchFeaturesMock;

    await tool.runQuery();

    expect(postAsyncMock).toHaveBeenCalledTimes(1);
    expect(fetchFeaturesMock).toHaveBeenCalledTimes(1);
    const where = String((fetchFeaturesMock.mock.calls[0][0] as any).where || '');
    expect(where).toContain('OBJECTID BETWEEN 6 AND 10');
  });

  test('aborts objectId mode when a slice exhausts local retries instead of silently skipping it', async () => {
    const tool = makeTool({ oidField: undefined, totalCount: 4, idListThreshold: 999999, oidStart: 2, maxFeaturesPerRequest: 2 });
    const postAsyncMock = jest.fn(async (_url: URL, params: Record<string, unknown>) => {
      if ((params as any).returnIdsOnly) {
        return { objectIds: [1, 2, 3, 4] };
      }
      throw new Error(`Unexpected postAsync call: ${JSON.stringify(params)}`);
    });
    const fetchFeaturesMock = jest.fn(async () => {
      throw new Error('slice failed');
    });

    (tool as any).postAsync = postAsyncMock;
    (tool as any).fetchFeatures = fetchFeaturesMock;

    await expect(tool.runQuery()).rejects.toThrow('slice failed (objectIds 1..2)');
    expect(fetchFeaturesMock).toHaveBeenCalledTimes(3);
  });

  test('treats timeout-style abort errors as hard failures unless the tool was explicitly cancelled', async () => {
    const tool = makeTool({ oidField: undefined, totalCount: 2, idListThreshold: 999999, oidStart: 2, maxFeaturesPerRequest: 2 });
    const postAsyncMock = jest.fn(async (_url: URL, params: Record<string, unknown>) => {
      if ((params as any).returnIdsOnly) {
        return { objectIds: [1, 2] };
      }
      throw new Error(`Unexpected postAsync call: ${JSON.stringify(params)}`);
    });
    const fetchFeaturesMock = jest.fn(async () => {
      const err: any = new Error('request aborted');
      err.code = 'ABORT';
      throw err;
    });

    (tool as any).postAsync = postAsyncMock;
    (tool as any).fetchFeatures = fetchFeaturesMock;

    await expect(tool.runQuery()).rejects.toThrow('request aborted (objectIds 1..2)');
    expect(fetchFeaturesMock).toHaveBeenCalledTimes(3);
  });

  test('still exits quietly on explicit cancellation', async () => {
    const tool = makeTool({ oidField: undefined, totalCount: 2, idListThreshold: 999999, oidStart: 2, maxFeaturesPerRequest: 2 });
    const postAsyncMock = jest.fn(async (_url: URL, params: Record<string, unknown>) => {
      if ((params as any).returnIdsOnly) {
        return { objectIds: [1, 2] };
      }
      throw new Error(`Unexpected postAsync call: ${JSON.stringify(params)}`);
    });
    const fetchFeaturesMock = jest.fn(async () => {
      tool.cancel();
      const err: any = new Error('request aborted');
      err.code = 'ABORT';
      throw err;
    });

    (tool as any).postAsync = postAsyncMock;
    (tool as any).fetchFeatures = fetchFeaturesMock;

    await expect(tool.runQuery()).resolves.toBeUndefined();
    expect(fetchFeaturesMock).toHaveBeenCalledTimes(1);
  });

  test('aborts range scan when a range exhausts local retries instead of silently skipping it', async () => {
    const tool = makeTool({ oidField: 'OBJECTID', totalCount: 10, oidWindow: 5, maxFeaturesPerRequest: 5 });
    const postAsyncMock = jest.fn(async (_url: URL, params: Record<string, unknown>) => {
      if ((params as any).outStatistics) return { statistics: [{ min: 1, max: 10 }] };
      throw new Error(`Unexpected postAsync call: ${JSON.stringify(params)}`);
    });
    const fetchFeaturesMock = jest.fn(async () => {
      throw new Error('range failed');
    });

    (tool as any).postAsync = postAsyncMock;
    (tool as any).fetchFeatures = fetchFeaturesMock;

    await expect(tool.runQuery()).rejects.toThrow('range failed (OBJECTID BETWEEN 1 AND 10)');
    expect(fetchFeaturesMock).toHaveBeenCalledTimes(3);
  });
});
