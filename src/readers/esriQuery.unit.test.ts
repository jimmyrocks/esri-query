import { describe, expect, test, jest } from '@jest/globals';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

  test('uses oid-field override when source metadata lacks objectIdField', async () => {
    const query = new EsriQuery({
      url: 'https://example.com/arcgis/rest/services/Foo/FeatureServer/0',
      where: '1=1',
      'out-fields': 'name',
      'oid-field': 'MY_OID',
    } as any);
    query.totalFeatureCount = 10;
    query.sourceInfo = { geometryType: 'esriGeometryPoint' } as any;

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
    expect(captured[0].oidField).toBe('MY_OID');
    expect(captured[0].queryObjectBase.outFields).toBe('name,MY_OID');
  });

  test('serializes batch writes even when parallel fetches emit data back-to-back', async () => {
    const query = new EsriQuery({
      url: 'https://example.com/arcgis/rest/services/Foo/FeatureServer/0',
      where: '1=1',
    } as any);
    query.totalFeatureCount = 10;
    query.sourceInfo = { geometryType: 'esriGeometryPoint' } as any;
    query.fields = {} as any;

    const started: number[] = [];
    const completed: number[] = [];
    let activeWrites = 0;
    let maxConcurrentWrites = 0;
    let releaseFirstWrite!: () => void;

    (query as any).writeBatchFromArcgis = async (batch: Array<{ attributes?: Record<string, unknown> }>) => {
      const id = Number(batch[0]?.attributes?.id);
      started.push(id);
      activeWrites += 1;
      maxConcurrentWrites = Math.max(maxConcurrentWrites, activeWrites);
      try {
        if (id === 1) {
          await new Promise<void>((resolve) => {
            releaseFirstWrite = resolve;
          });
        }
        completed.push(id);
        return 1;
      } finally {
        activeWrites -= 1;
      }
    };

    const originalRunQuery = OidChunkQueryTool.prototype.runQuery;
    OidChunkQueryTool.prototype.runQuery = async function () {
      this.emit('data', [{ attributes: { id: 1 } }] as any);
      this.emit('data', [{ attributes: { id: 2 } }] as any);
    };

    try {
      await query.startQuery();
      await Promise.resolve();

      expect(started).toEqual([1]);
      expect(completed).toEqual([]);
      expect(maxConcurrentWrites).toBe(1);

      releaseFirstWrite();
      await (query as any)._lastWrite;
    } finally {
      OidChunkQueryTool.prototype.runQuery = originalRunQuery;
    }

    expect(started).toEqual([1, 2]);
    expect(completed).toEqual([1, 2]);
    expect(maxConcurrentWrites).toBe(1);
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
    expect(state.outputMode).toBe('single-file');
    expect(state.outputBytes).toBe(0);
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
    const state = JSON.parse(readFileSync(resumePath, 'utf8'));
    expect(state.outputBytes).toBeGreaterThan(0);
  });

  test('allows resume mode with oid-field override when metadata is missing the object ID field', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'esri-query-resume-'));
    const outputPath = join(tempDir, 'out.geojsonl');
    const resumePath = join(tempDir, 'out.resume.json');
    const query = new EsriQuery({
      url: 'https://example.com/arcgis/rest/services/Foo/FeatureServer/0',
      where: '1=1',
      format: 'geojsonseq',
      output: outputPath,
      'resume-state': resumePath,
      'oid-field': 'MY_OID',
    } as any);
    query.totalFeatureCount = 10;
    query.sourceInfo = { geometryType: 'esriGeometryPoint' } as any;
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
    expect(captured[0].oidField).toBe('MY_OID');
    expect(state.oidField).toBe('MY_OID');
  });

  test('creates segmented resume state when max-file-bytes is enabled', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'esri-query-resume-'));
    const outputPath = join(tempDir, 'rolled.geojsonl');
    const resumePath = join(tempDir, 'rolled.resume.json');
    const query = new EsriQuery({
      url: 'https://example.com/arcgis/rest/services/Foo/FeatureServer/0',
      where: '1=1',
      format: 'geojsonseq',
      output: outputPath,
      'resume-state': resumePath,
      'max-file-bytes': 256,
    } as any);
    query.totalFeatureCount = 10;
    query.sourceInfo = { objectIdFieldName: 'OBJECTID', geometryType: 'esriGeometryPoint' } as any;
    query.fields = {} as any;

    const originalRunQuery = OidChunkQueryTool.prototype.runQuery;
    OidChunkQueryTool.prototype.runQuery = async function () {};

    try {
      await query.start();
    } finally {
      OidChunkQueryTool.prototype.runQuery = originalRunQuery;
    }

    const state = JSON.parse(readFileSync(resumePath, 'utf8'));
    expect(state.outputMode).toBe('segmented');
    expect(state.segmentIndex).toBe(0);
    expect(state.maxFileBytes).toBe(256);
  });

  test('migrates old single-file resume state into rolled segment files', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'esri-query-resume-'));
    const outputPath = join(tempDir, 'out.geojsonl');
    const firstLine = '{"type":"Feature","properties":{"OBJECTID":1},"geometry":null}\n';
    const secondLine = '{"type":"Feature","properties":{"OBJECTID":2},"geometry":null}\n';
    const resumePath = join(tempDir, 'out.resume.json');
    writeFileSync(outputPath, firstLine + secondLine);
    writeFileSync(resumePath, JSON.stringify({
      version: 1,
      mode: 'geojsonseq-oid',
      url: 'https://example.com/arcgis/rest/services/Foo/FeatureServer/0',
      queryUrl: 'https://example.com/arcgis/rest/services/Foo/FeatureServer/0/query',
      where: '1=1',
      output: outputPath,
      format: 'geojsonseq',
      oidField: 'OBJECTID',
      lastCompletedOid: 1,
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
      'max-file-bytes': 256,
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
    const migratedPath = join(tempDir, 'out.part0000.geojsonl');
    expect(captured).toHaveLength(1);
    expect(captured[0].resumeAfterOid).toBe(1);
    expect(state.outputMode).toBe('segmented');
    expect(state.segmentIndex).toBe(1);
    expect(state.outputBytes).toBe(0);
    expect(existsSync(outputPath)).toBe(false);
    expect(existsSync(migratedPath)).toBe(true);
    expect(readFileSync(migratedPath, 'utf8')).toBe(firstLine);
  });

  test('does not mark resume state completed when the run stops early', async () => {
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

    const originalStartQuery = query.startQuery;
    query.startQuery = async function () {
      (this as any).requestStop('max-records');
    };

    try {
      await query.start();
    } finally {
      query.startQuery = originalStartQuery;
    }

    const state = JSON.parse(readFileSync(resumePath, 'utf8'));
    expect(state.completed).toBe(false);
  });

  test('fails loudly when a run writes some records but still ends far short of total count', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'esri-query-shortfall-'));
    const outputPath = join(tempDir, 'out.geojsonl');
    const query = new EsriQuery({
      url: 'https://example.com/arcgis/rest/services/Foo/FeatureServer/0',
      where: '1=1',
      format: 'geojsonseq',
      output: outputPath,
    } as any);
    query.totalFeatureCount = 10;
    query.sourceInfo = { objectIdFieldName: 'OBJECTID', geometryType: 'esriGeometryPoint' } as any;
    query.fields = {} as any;

    const originalStartQuery = query.startQuery;
    query.startQuery = async function () {
      await (this as any).writeBatchFromArcgis([{ attributes: { OBJECTID: 1 }, geometry: null }] as any);
    };

    try {
      await expect(query.start()).rejects.toThrow('Export stopped short without a terminal fetch error');
    } finally {
      query.startQuery = originalStartQuery;
    }
  });

  test('warns once when dedupe tracking crosses the configured threshold', async () => {
    const query = new EsriQuery({
      url: 'https://example.com/arcgis/rest/services/Foo/FeatureServer/0',
      where: '1=1',
      dedupe: true,
      'dedupe-warn-entries': 1,
      'dedupe-max-entries': 10,
    } as any);

    const stderr: string[] = [];
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(((chunk: any) => {
      stderr.push(String(chunk));
      return true;
    }) as any);
    query.writer = {
      status: {},
      writeBatch: async (items: AsyncIterable<GeoJSON.Feature>) => {
        let accepted = 0;
        for await (const _ of items) accepted += 1;
        return accepted;
      },
    } as any;

    try {
      await (query as any).writeBatchFromArcgis([{ attributes: { OBJECTID: 1 }, geometry: null }] as any);
      await (query as any).writeBatchFromArcgis([{ attributes: { OBJECTID: 2 }, geometry: null }] as any);
    } finally {
      stderrSpy.mockRestore();
    }

    const text = stderr.join('');
    expect(text).toContain('--dedupe is tracking');
    expect(text.match(/--dedupe is tracking/g)).toHaveLength(1);
    expect(query.runtimeParams.dedupeHashCount).toBe(2);
  });

  test('fails before writing a batch when dedupe would exceed the configured max entries', async () => {
    const query = new EsriQuery({
      url: 'https://example.com/arcgis/rest/services/Foo/FeatureServer/0',
      where: '1=1',
      dedupe: true,
      'dedupe-max-entries': 1,
      'dedupe-warn-entries': 1,
    } as any);

    const writeBatch = jest.fn(async (items: AsyncIterable<GeoJSON.Feature>) => {
      let accepted = 0;
      for await (const _ of items) accepted += 1;
      return accepted;
    });
    query.writer = {
      status: {},
      writeBatch,
    } as any;

    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation((() => true) as any);
    try {
      await (query as any).writeBatchFromArcgis([{ attributes: { OBJECTID: 1 }, geometry: null }] as any);
      expect(query.runtimeParams.dedupeHashCount).toBe(1);
      expect(writeBatch).toHaveBeenCalledTimes(1);

      await expect(
        (query as any).writeBatchFromArcgis([{ attributes: { OBJECTID: 2 }, geometry: null }] as any)
      ).rejects.toThrow('--dedupe exceeded the in-memory guardrail');

      expect(query.runtimeParams.dedupeHashCount).toBe(1);
      expect(writeBatch).toHaveBeenCalledTimes(1);
    } finally {
      stderrSpy.mockRestore();
    }
  });
});
