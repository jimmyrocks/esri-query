import { describe, expect, test } from '@jest/globals';
import EsriQuery from './esriQuery.js';
import OidChunkQueryTool from '../helpers/OidChunkTool.js';

describe('EsriQuery.startQuery', () => {
  test('forwards bbox and bbox-wkid to OID query options', async () => {
    const query = new EsriQuery({
      url: 'https://example.com/arcgis/rest/services/Foo/FeatureServer/0',
      where: '1=1',
      bbox: [-123.5, 47.5, -122.8, 48.0],
      'bbox-wkid': 4326,
    } as any);
    query.totalFeatureCount = 10;

    const captured: any[] = [];
    const originalRunQuery = OidChunkQueryTool.prototype.runQuery;
    OidChunkQueryTool.prototype.runQuery = async function () {
      captured.push((this as any).options);
    };

    try {
      await query.startQuery();
    } finally {
      OidChunkQueryTool.prototype.runQuery = originalRunQuery;
    }

    expect(captured).toHaveLength(1);
    expect(captured[0].bbox).toEqual([-123.5, 47.5, -122.8, 48.0]);
    expect(captured[0].bboxWkid).toBe(4326);
  });

  test('parses string bbox values when called programmatically', async () => {
    const query = new EsriQuery({
      url: 'https://example.com/arcgis/rest/services/Foo/FeatureServer/0',
      where: '1=1',
      bbox: '-100.0,10.0,-90.0,20.0' as any,
      bboxWkid: 3857,
    } as any);
    query.totalFeatureCount = 10;

    const captured: any[] = [];
    const originalRunQuery = OidChunkQueryTool.prototype.runQuery;
    OidChunkQueryTool.prototype.runQuery = async function () {
      captured.push((this as any).options);
    };

    try {
      await query.startQuery();
    } finally {
      OidChunkQueryTool.prototype.runQuery = originalRunQuery;
    }

    expect(captured).toHaveLength(1);
    expect(captured[0].bbox).toEqual([-100, 10, -90, 20]);
    expect(captured[0].bboxWkid).toBe(3857);
  });

  test('forwards narrowed out-fields and appends oid field', async () => {
    const query = new EsriQuery({
      url: 'https://example.com/arcgis/rest/services/Foo/FeatureServer/0',
      where: '1=1',
      'out-fields': 'name, type',
    } as any);
    query.totalFeatureCount = 10;
    query.sourceInfo = { objectIdFieldName: 'OBJECTID' } as any;

    const captured: any[] = [];
    const originalRunQuery = OidChunkQueryTool.prototype.runQuery;
    OidChunkQueryTool.prototype.runQuery = async function () {
      captured.push((this as any).options);
    };

    try {
      await query.startQuery();
    } finally {
      OidChunkQueryTool.prototype.runQuery = originalRunQuery;
    }

    expect(captured).toHaveLength(1);
    expect(captured[0].queryObjectBase.outFields).toBe('name,type,OBJECTID');
  });

  test('keeps wildcard out-fields when oid field is known', async () => {
    const query = new EsriQuery({
      url: 'https://example.com/arcgis/rest/services/Foo/FeatureServer/0',
      where: '1=1',
      outFields: '*',
    } as any);
    query.totalFeatureCount = 10;
    query.sourceInfo = { objectIdFieldName: 'OBJECTID' } as any;

    const captured: any[] = [];
    const originalRunQuery = OidChunkQueryTool.prototype.runQuery;
    OidChunkQueryTool.prototype.runQuery = async function () {
      captured.push((this as any).options);
    };

    try {
      await query.startQuery();
    } finally {
      OidChunkQueryTool.prototype.runQuery = originalRunQuery;
    }

    expect(captured).toHaveLength(1);
    expect(captured[0].queryObjectBase.outFields).toBe('*');
  });
});
