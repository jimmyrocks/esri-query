import { describe, expect, test } from '@jest/globals';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  test('forwards extra request headers to OID query options', async () => {
    const query = new EsriQuery({
      url: 'https://example.com/arcgis/rest/services/Foo/FeatureServer/0',
      where: '1=1',
      header: ['Cookie: SESSION=abc123', 'X-Test: present'],
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
    expect(captured[0].extraHeaders).toEqual({
      Cookie: 'SESSION=abc123',
      'X-Test': 'present',
    });
  });

  test('creates a resume state file and forces deterministic OID mode for geojsonseq', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'esri-query-resume-'));
    const outputPath = join(tempDir, 'out.geojsonl');
    const resumePath = join(tempDir, 'out.resume.json');
    const query = new EsriQuery({
      url: 'https://example.com/arcgis/rest/services/Foo/FeatureServer/0',
      where: '1=1',
      format: 'geojsonseq',
      output: outputPath,
      'resume-state': resumePath,
    } as any);
    query.totalFeatureCount = 10;
    query.sourceInfo = { objectIdFieldName: 'OBJECTID', geometryType: 'esriGeometryPoint' } as any;
    query.fields = {} as any;

    const captured: any[] = [];
    const originalRunQuery = OidChunkQueryTool.prototype.runQuery;
    OidChunkQueryTool.prototype.runQuery = async function () {
      captured.push((this as any).options);
    };

    try {
      await query.start();
    } finally {
      OidChunkQueryTool.prototype.runQuery = originalRunQuery;
    }

    const state = JSON.parse(readFileSync(resumePath, 'utf8'));
    expect(captured).toHaveLength(1);
    expect(captured[0].oidConcurrency).toBe(1);
    expect(captured[0].stableOidOrder).toBe(true);
    expect(state.output).toBe(outputPath);
    expect(state.format).toBe('geojsonseq');
    expect(state.oidField).toBe('OBJECTID');
  });

  test('loads prior resume state and passes resumeAfterOid into OID query options', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'esri-query-resume-'));
    const outputPath = join(tempDir, 'out.geojsonl');
    const resumePath = join(tempDir, 'out.resume.json');
    writeFileSync(outputPath, '{"type":"Feature","properties":{"OBJECTID":1},"geometry":null}\n');
    writeFileSync(resumePath, JSON.stringify({
      version: 1,
      mode: 'geojsonseq-oid',
      url: 'https://example.com/arcgis/rest/services/Foo/FeatureServer/0',
      queryUrl: 'https://example.com/arcgis/rest/services/Foo/FeatureServer/0/query',
      where: '1=1',
      output: outputPath,
      format: 'geojsonseq',
      oidField: 'OBJECTID',
      lastCompletedOid: 123,
      recordsWritten: 1,
      completed: false,
      updatedAt: new Date().toISOString(),
    }, null, 2));

    const query = new EsriQuery({
      url: 'https://example.com/arcgis/rest/services/Foo/FeatureServer/0',
      where: '1=1',
      format: 'geojsonseq',
      output: outputPath,
      'resume-state': resumePath,
    } as any);
    query.totalFeatureCount = 10;
    query.sourceInfo = { objectIdFieldName: 'OBJECTID', geometryType: 'esriGeometryPoint' } as any;
    query.fields = {} as any;

    const captured: any[] = [];
    const originalRunQuery = OidChunkQueryTool.prototype.runQuery;
    OidChunkQueryTool.prototype.runQuery = async function () {
      captured.push((this as any).options);
    };

    try {
      await query.start();
    } finally {
      OidChunkQueryTool.prototype.runQuery = originalRunQuery;
    }

    expect(captured).toHaveLength(1);
    expect(captured[0].resumeAfterOid).toBe(123);
    expect(captured[0].oidConcurrency).toBe(1);
  });
});
