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
});
