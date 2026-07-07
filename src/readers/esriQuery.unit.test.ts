import { describe, expect, test, jest } from '@jest/globals';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EsriQuery from './esriQuery.js';
import OidChunkQueryTool from '../helpers/OidChunkTool.js';
import Gpkg from '../writers/Gpkg.js';
import Database from 'better-sqlite3';

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

  test('reuses adaptive window and chunk hints from resume state when explicit values are absent', async () => {
    const query = new EsriQuery({
      url: 'https://example.com/arcgis/rest/services/Foo/FeatureServer/0',
      where: '1=1',
    } as any);
    query.totalFeatureCount = 10;
    query.sourceInfo = { objectIdFieldName: 'OBJECTID' } as any;
    (query as any).resumeStatePath = '/tmp/out.resume.json';
    (query as any).resumeState = {
      version: 2,
      mode: 'geojsonseq-oid',
      url: 'https://example.com/arcgis/rest/services/Foo/FeatureServer/0',
      queryUrl: 'https://example.com/arcgis/rest/services/Foo/FeatureServer/0/query',
      where: '1=1',
      output: '/tmp/out.geojsonl',
      checkpointPath: '/tmp/out.geojsonl',
      format: 'geojsonseq',
      oidField: 'OBJECTID',
      lastWindowSize: 321,
      lastChunkSize: 23,
      completed: false,
      updatedAt: new Date().toISOString(),
    };

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
    expect(captured[0].oidWindow).toBe(321);
    expect(captured[0].oidStart).toBe(23);
  });

  test('prefers explicit oid window and chunk settings over resume hints', async () => {
    const query = new EsriQuery({
      url: 'https://example.com/arcgis/rest/services/Foo/FeatureServer/0',
      where: '1=1',
      'oid-window': 900,
      'oid-start': 77,
    } as any);
    query.totalFeatureCount = 10;
    query.sourceInfo = { objectIdFieldName: 'OBJECTID' } as any;
    (query as any).resumeStatePath = '/tmp/out.resume.json';
    (query as any).resumeState = {
      version: 2,
      mode: 'geojsonseq-oid',
      url: 'https://example.com/arcgis/rest/services/Foo/FeatureServer/0',
      queryUrl: 'https://example.com/arcgis/rest/services/Foo/FeatureServer/0/query',
      where: '1=1',
      output: '/tmp/out.geojsonl',
      checkpointPath: '/tmp/out.geojsonl',
      format: 'geojsonseq',
      oidField: 'OBJECTID',
      lastWindowSize: 321,
      lastChunkSize: 23,
      completed: false,
      updatedAt: new Date().toISOString(),
    };

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
    expect(captured[0].oidWindow).toBe(900);
    expect(captured[0].oidStart).toBe(77);
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
    expect(state.checkpointPath).toBe(outputPath);
    expect(state.format).toBe('geojsonseq');
    expect(state.oidField).toBe('OBJECTID');
    expect(state.outputMode).toBe('single-file');
    expect(state.outputBytes).toBe(0);
  });

  test('refuses to use a resume state file while a live lock exists', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'esri-query-resume-lock-'));
    const outputPath = join(tempDir, 'out.geojsonl');
    const resumePath = join(tempDir, 'out.resume.json');
    writeFileSync(`${resumePath}.lock`, JSON.stringify({
      pid: process.pid,
      output: outputPath,
      resumeState: resumePath,
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

    await expect(query.start()).rejects.toThrow('Resume lock exists');
    expect(existsSync(`${resumePath}.lock`)).toBe(true);
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
    expect(state.checkpointPath).toBe(join(tempDir, 'rolled.part0000.geojsonl'));
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
    expect(state.checkpointPath).toBe(join(tempDir, 'out.part0001.geojsonl'));
    expect(existsSync(outputPath)).toBe(false);
    expect(existsSync(migratedPath)).toBe(true);
    expect(readFileSync(migratedPath, 'utf8')).toBe(firstLine);
  });

  test('resumes segmented output using the active part file even when the base output path does not exist', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'esri-query-resume-'));
    const outputPath = join(tempDir, 'out.geojsonl');
    const resumePath = join(tempDir, 'out.resume.json');
    const segmentPath = join(tempDir, 'out.part0000.geojsonl');
    const line = '{"type":"Feature","properties":{"OBJECTID":1},"geometry":null}\n';
    writeFileSync(segmentPath, line);
    writeFileSync(resumePath, JSON.stringify({
      version: 2,
      mode: 'geojsonseq-oid',
      url: 'https://example.com/arcgis/rest/services/Foo/FeatureServer/0',
      queryUrl: 'https://example.com/arcgis/rest/services/Foo/FeatureServer/0/query',
      where: '1=1',
      output: outputPath,
      checkpointPath: segmentPath,
      format: 'geojsonseq',
      oidField: 'OBJECTID',
      outputMode: 'segmented',
      outputBytes: Buffer.byteLength(line),
      segmentIndex: 0,
      maxFileBytes: 256,
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
    expect(captured[0].resumeAfterOid).toBe(1);
    const state = JSON.parse(readFileSync(resumePath, 'utf8'));
    expect(state.checkpointPath).toBe(segmentPath);
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

  test('does not mark resume state completed when interrupted gracefully', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'esri-query-resume-signal-'));
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
      (this as any).requestGracefulStop('SIGINT');
    };

    try {
      await expect(query.start()).rejects.toThrow('Interrupted by signal');
    } finally {
      query.startQuery = originalStartQuery;
    }

    const state = JSON.parse(readFileSync(resumePath, 'utf8'));
    expect(state.completed).toBe(false);
    expect(existsSync(`${resumePath}.lock`)).toBe(false);
  });

  test('persists the latest adaptive window metrics to resume state on failure', async () => {
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

    const originalRunQuery = OidChunkQueryTool.prototype.runQuery;
    OidChunkQueryTool.prototype.runQuery = async function () {
      this.emit('metrics', { oidMode: 'range', currentWindowSize: 125 });
      throw new Error('boom');
    };

    try {
      await expect(query.start()).rejects.toThrow('boom');
    } finally {
      OidChunkQueryTool.prototype.runQuery = originalRunQuery;
    }

    const state = JSON.parse(readFileSync(resumePath, 'utf8'));
    expect(state.completed).toBe(false);
    expect(state.oidMode).toBe('range');
    expect(state.lastWindowSize).toBe(125);
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

describe('EsriQuery GPKG resume', () => {
  const gpkgSourceInfo = {
    objectIdFieldName: 'OBJECTID',
    geometryType: 'esriGeometryPoint',
    fields: [
      { name: 'OBJECTID', type: 'esriFieldTypeOID' },
      { name: 'name', type: 'esriFieldTypeString' },
    ],
  } as any;

  const makeQuery = (outputPath: string, resumePath: string, extra: Record<string, unknown> = {}) => {
    const query = new EsriQuery({
      url: 'https://example.com/arcgis/rest/services/Foo/FeatureServer/0',
      where: '1=1',
      format: 'gpkg',
      output: outputPath,
      'resume-state': resumePath,
      ...extra,
    } as any);
    query.sourceInfo = gpkgSourceInfo;
    query.fields = {} as any;
    return query;
  };

  const esriFeature = (oid: number) => ({
    attributes: { OBJECTID: oid, name: `feature-${oid}` },
    geometry: { x: oid, y: oid + 1 },
  });

  test('runs a full export/crash/resume cycle without duplicating rows', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'esri-query-gpkg-resume-'));
    const outputPath = join(tempDir, 'out.gpkg');
    const resumePath = join(tempDir, 'out.resume.json');

    // Run 1: exports OIDs 1 and 2 to completion.
    const first = makeQuery(outputPath, resumePath);
    first.totalFeatureCount = 2;

    const originalRunQuery = OidChunkQueryTool.prototype.runQuery;
    OidChunkQueryTool.prototype.runQuery = async function () {
      this.emit('data', [esriFeature(1), esriFeature(2)] as any);
    };
    try {
      await first.start();
    } finally {
      OidChunkQueryTool.prototype.runQuery = originalRunQuery;
    }

    let state = JSON.parse(readFileSync(resumePath, 'utf8'));
    expect(state.mode).toBe('gpkg-oid');
    expect(state.format).toBe('gpkg');
    expect(state.lastCompletedOid).toBe(2);
    expect(state.recordsWritten).toBe(2);
    expect(state.completed).toBe(true);

    // Simulate a crash where the sidecar lagged behind the database commit:
    // the sidecar claims OID 1 but the GPKG checkpoint says OID 2.
    writeFileSync(resumePath, JSON.stringify({
      ...state,
      completed: false,
      lastCompletedOid: 1,
      recordsWritten: 1,
    }, null, 2));

    // Run 2: must trust the in-database checkpoint (OID 2), not the sidecar.
    const second = makeQuery(outputPath, resumePath);
    second.totalFeatureCount = 3;

    const captured: any[] = [];
    OidChunkQueryTool.prototype.runQuery = async function () {
      captured.push((this as any).options);
      this.emit('data', [esriFeature(3)] as any);
    };
    try {
      await second.start();
    } finally {
      OidChunkQueryTool.prototype.runQuery = originalRunQuery;
    }

    expect(captured).toHaveLength(1);
    expect(captured[0].resumeAfterOid).toBe(2);
    expect(captured[0].oidConcurrency).toBe(1);

    state = JSON.parse(readFileSync(resumePath, 'utf8'));
    expect(state.completed).toBe(true);
    expect(state.lastCompletedOid).toBe(3);
    expect(state.recordsWritten).toBe(3);

    const checkpoint = Gpkg.readResumeCheckpoint(outputPath);
    expect(checkpoint?.lastCompletedOid).toBe(3);
    expect(checkpoint?.recordsWritten).toBe(3);

    const db = new Database(outputPath, { readonly: true });
    try {
      const rows = db.prepare('SELECT count(*) AS c, count(DISTINCT OBJECTID) AS d FROM "out"').get() as any;
      expect(rows.c).toBe(3);
      expect(rows.d).toBe(3);
    } finally {
      db.close();
    }
  });

  test('rejects --max-file-bytes with gpkg resume', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'esri-query-gpkg-resume-'));
    const query = makeQuery(join(tempDir, 'out.gpkg'), join(tempDir, 'out.resume.json'), { 'max-file-bytes': 256 });
    query.totalFeatureCount = 1;
    await expect(query.start()).rejects.toThrow(/max-file-bytes/);
  });

  test('refuses to resume into a gpkg that has no checkpoint table', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'esri-query-gpkg-resume-'));
    const outputPath = join(tempDir, 'plain.gpkg');
    const resumePath = join(tempDir, 'plain.resume.json');

    // A gpkg produced without --resume-state has no checkpoint table.
    const plain = new Gpkg({ output: outputPath, 'layer-name': 'plain' } as any, gpkgSourceInfo);
    await plain.open();
    await plain.close();

    const query = makeQuery(outputPath, resumePath);
    query.totalFeatureCount = 5;
    writeFileSync(resumePath, JSON.stringify({
      version: 2,
      mode: 'gpkg-oid',
      url: 'https://example.com/arcgis/rest/services/Foo/FeatureServer/0',
      queryUrl: 'https://example.com/arcgis/rest/services/Foo/FeatureServer/0/query',
      where: '1=1',
      output: outputPath,
      format: 'gpkg',
      oidField: 'OBJECTID',
      lastCompletedOid: 1,
      recordsWritten: 1,
      completed: false,
      updatedAt: new Date().toISOString(),
    }, null, 2));

    await expect(query.start()).rejects.toThrow(/no resume checkpoint table/);
  });
});

describe('EsriQuery wait-for-server', () => {
  const makeWaitQuery = (tempDir: string, extra: Record<string, unknown> = {}) => {
    const query = new EsriQuery({
      url: 'https://example.com/arcgis/rest/services/Foo/FeatureServer/0',
      where: '1=1',
      format: 'geojsonseq',
      output: join(tempDir, 'out.geojsonl'),
      'resume-state': join(tempDir, 'out.resume.json'),
      'wait-for-server': true,
      'wait-backoff-seconds': 0.01,
      ...extra,
    } as any);
    query.sourceInfo = { objectIdFieldName: 'OBJECTID', geometryType: 'esriGeometryPoint' } as any;
    query.fields = {} as any;
    return query;
  };

  test('requires --resume-state', async () => {
    const query = new EsriQuery({
      url: 'https://example.com/arcgis/rest/services/Foo/FeatureServer/0',
      where: '1=1',
      format: 'geojsonseq',
      output: '/tmp/nope.geojsonl',
      'wait-for-server': true,
    } as any);
    query.sourceInfo = { objectIdFieldName: 'OBJECTID', geometryType: 'esriGeometryPoint' } as any;
    query.fields = {} as any;
    await expect(query.start()).rejects.toThrow(/requires --resume-state/);
  });

  test('waits out a fetch failure, records it in the sidecar, and completes on retry', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'esri-query-wait-'));
    const query = makeWaitQuery(tempDir);
    query.totalFeatureCount = 1;

    // The probe fires while the job is idle, which is when the sidecar
    // should carry the waitingSince/lastError note.
    const waitingSnapshots: any[] = [];
    const probe = jest.fn(async () => {
      waitingSnapshots.push(JSON.parse(readFileSync(join(tempDir, 'out.resume.json'), 'utf8')));
      return true;
    });
    (query as any).probeServer = probe;

    let calls = 0;
    const originalRunQuery = OidChunkQueryTool.prototype.runQuery;
    OidChunkQueryTool.prototype.runQuery = async function () {
      calls += 1;
      if (calls === 1) throw new Error('socket hang up (server outage)');
      this.emit('data', [{ attributes: { OBJECTID: 1 }, geometry: null }] as any);
    };

    try {
      await query.start();
    } finally {
      OidChunkQueryTool.prototype.runQuery = originalRunQuery;
    }

    expect(calls).toBe(2);
    expect(probe).toHaveBeenCalled();
    expect(waitingSnapshots[0].waitingSince).toBeDefined();
    expect(waitingSnapshots[0].lastError).toMatch(/socket hang up/);

    const state = JSON.parse(readFileSync(join(tempDir, 'out.resume.json'), 'utf8'));
    expect(state.completed).toBe(true);
    expect(state.recordsWritten).toBe(1);
    expect(state.waitingSince).toBeUndefined();
    expect(state.lastError).toBeUndefined();
  });

  test('keeps polling while the server stays down, then resumes', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'esri-query-wait-'));
    const query = makeWaitQuery(tempDir);
    query.totalFeatureCount = 1;

    let probes = 0;
    (query as any).probeServer = jest.fn(async () => {
      probes += 1;
      return probes >= 3; // server answers on the third probe
    });

    let calls = 0;
    const originalRunQuery = OidChunkQueryTool.prototype.runQuery;
    OidChunkQueryTool.prototype.runQuery = async function () {
      calls += 1;
      if (calls === 1) throw new Error('ECONNREFUSED');
      this.emit('data', [{ attributes: { OBJECTID: 1 }, geometry: null }] as any);
    };

    try {
      await query.start();
    } finally {
      OidChunkQueryTool.prototype.runQuery = originalRunQuery;
    }

    expect(probes).toBe(3);
    expect(calls).toBe(2);
  });

  test('does not retry setup/validation errors', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'esri-query-wait-'));
    // partitioned output is rejected in prepareResumeSupport, before any fetch
    const query = makeWaitQuery(tempDir, { partition: true });
    query.totalFeatureCount = 1;

    const probe = jest.fn(async () => true);
    (query as any).probeServer = probe;

    let calls = 0;
    const originalRunQuery = OidChunkQueryTool.prototype.runQuery;
    OidChunkQueryTool.prototype.runQuery = async function () { calls += 1; };

    try {
      await expect(query.start()).rejects.toThrow(/partitioned/);
    } finally {
      OidChunkQueryTool.prototype.runQuery = originalRunQuery;
    }
    expect(calls).toBe(0);
    expect(probe).not.toHaveBeenCalled();
  });

  test('gives up after wait-max-attempts consecutive attempts without progress', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'esri-query-wait-'));
    const query = makeWaitQuery(tempDir, { 'wait-max-attempts': 2 });
    query.totalFeatureCount = 1;

    (query as any).probeServer = jest.fn(async () => true);

    let calls = 0;
    const originalRunQuery = OidChunkQueryTool.prototype.runQuery;
    OidChunkQueryTool.prototype.runQuery = async function () {
      calls += 1;
      throw new Error('persistent failure');
    };

    try {
      await expect(query.start()).rejects.toThrow(/gave up after 2 consecutive attempts.*persistent failure/);
    } finally {
      OidChunkQueryTool.prototype.runQuery = originalRunQuery;
    }
    expect(calls).toBe(3); // initial attempt + 2 retries
  });
});
