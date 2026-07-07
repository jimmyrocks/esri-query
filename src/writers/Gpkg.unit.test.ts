import Gpkg from './Gpkg.js';
import { describe, expect, test, beforeAll, afterAll } from '@jest/globals';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { CliBaseOptionsType, CliSqlOptionsType, CliGeoJsonOptionsType } from '../cli.js';
import type { EsriFeatureLayerType } from '../helpers/esri-rest-types.js';

const options = {
    output: ':memory:',
    'layer-name': 'test'
} as CliBaseOptionsType & (CliSqlOptionsType | CliGeoJsonOptionsType);
const sourceInfo = {
    'fields': [{
        name: 'oid',
        type: 'esriFieldTypeString'
    }],
    geometryType: 'esriGeometryPoint'
} as any as EsriFeatureLayerType;

describe('SqliteDb', () => {
    let gpkg: Gpkg;

    beforeAll(async () => {
        gpkg = new Gpkg(options, sourceInfo);
        await gpkg.open();
    });

    afterAll(async () => {
        await gpkg.close();
    });

    test('should load the database', () => {
        expect(gpkg.db.open).toBe(true);
    });

    test('should run SQL statements', () => {
        const cmdsString = `
        CREATE TABLE test_table (
          id INTEGER PRIMARY KEY,
          name TEXT
        );
        INSERT INTO test_table (name) VALUES ('test1');
        INSERT INTO test_table (name) VALUES ('test2');
        INSERT INTO test_table (name) VALUES ('test3');
        INSERT INTO test_table (name) VALUES ('test4');
        INSERT INTO test_table (name) VALUES ('test5');
      `;
        const cmds = cmdsString.split(';').filter(v => v.trim().length > 0).map(v => v + ';');
        gpkg.db.transaction((cmds: string[]) =>
            cmds.map(cmd => gpkg.db.prepare(cmd).run())
        )(cmds);

        const result = gpkg.db.prepare('SELECT * FROM test_table;').all();
        expect(result).toEqual([
            { id: 1, name: 'test1' }, { id: 2, name: 'test2' }, { id: 3, name: 'test3' }, { id: 4, name: 'test4' }, { id: 5, name: 'test5' }
        ]);
    });

    test('should already have the GPKG tables loaded', () => {
        // Make sure we have ESPG:4326
        const result = gpkg.db.prepare(('SELECT srs_name , srs_id, organization, organization_coordsys_id FROM gpkg_spatial_ref_sys WHERE srs_id = 4326;')).all();
        expect(result).toEqual([{ srs_name: 'WGS 84 geodetic', 'srs_id': 4326, 'organization': 'EPSG', 'organization_coordsys_id': 4326 }]);

        // test contents table fields
        const contentsTable = gpkg.db.prepare(('pragma table_info(\'gpkg_contents\');')).all();
        expect(contentsTable.length).toEqual(10);

        // test contents table fields
        const layersTable = gpkg.db.prepare(('pragma table_info(\'layer_styles\');')).all();
        expect(layersTable.length).toEqual(16);
    });
});

describe('Gpkg', () => {

    test('should open and close without errors', async () => {
        const gpkg = new Gpkg(options, sourceInfo);
        await gpkg.open();
        expect(gpkg.db.open).toEqual(true);
        await gpkg.close();
        expect(gpkg.db.open).toEqual(false);
    });

    test('should contain required tables', async () => {
        const gpkg = new Gpkg(options, sourceInfo);
        await gpkg.open();
        expect(gpkg.db.open).toEqual(true);

        const requiredTables = [
            'gpkg_spatial_ref_sys',
            'gpkg_ogr_contents',
            'gpkg_geometry_columns',
            'gpkg_tile_matrix_set',
            'gpkg_tile_matrix',
            'gpkg_extensions',
            'gpkg_contents',
            'layer_styles',
            (options as any)['layer-name']
        ];

        const hasTableStatement = gpkg.db.prepare(`SELECT count(*) AS c FROM sqlite_master WHERE type='table' AND name=@tableName;`);
        requiredTables.forEach(tableName => {
            const row = hasTableStatement.get({ tableName });
            expect(row).toEqual({ c: 1 });
        });

        await gpkg.close();
    });

    test('should not create a resume checkpoint table without resume-state', async () => {
        const gpkg = new Gpkg(options, sourceInfo);
        await gpkg.open();
        const row = gpkg.db.prepare(`SELECT count(*) AS c FROM sqlite_master WHERE type='table' AND name='esri_query_resume'`).get();
        expect(row).toEqual({ c: 0 });
        await gpkg.close();
    });
});

describe('Gpkg resume', () => {
    let tempDir: string;

    const resumeSourceInfo = {
        fields: [
            { name: 'OBJECTID', type: 'esriFieldTypeOID' },
            { name: 'name', type: 'esriFieldTypeString' },
        ],
        geometryType: 'esriGeometryPoint',
        objectIdFieldName: 'OBJECTID',
    } as any as EsriFeatureLayerType;

    const makeOptions = (dbPath: string, extra: Record<string, unknown> = {}) => ({
        output: dbPath,
        'layer-name': 'test',
        'resume-state': join(tempDir, 'test.resume.json'),
        'resume-oid-field': 'OBJECTID',
        ...extra,
    } as any as CliBaseOptionsType & CliSqlOptionsType);

    const makeFeature = (oid: number): GeoJSON.Feature => ({
        type: 'Feature',
        properties: { OBJECTID: oid, name: `feature-${oid}` },
        geometry: { type: 'Point', coordinates: [oid, oid + 1] },
    });

    beforeAll(() => {
        tempDir = mkdtempSync(join(tmpdir(), 'esri-query-gpkg-resume-'));
    });

    afterAll(() => {
        rmSync(tempDir, { recursive: true, force: true });
    });

    test('checkpoints the max committed OID in the same transaction as the batch', async () => {
        const dbPath = join(tempDir, 'checkpoint.gpkg');
        const gpkg = new Gpkg(makeOptions(dbPath), resumeSourceInfo);
        await gpkg.open();

        await gpkg.writeFeature(makeFeature(1));
        await gpkg.writeFeature(makeFeature(2));
        await gpkg.save(); // flushes the batch + checkpoint in one transaction

        const row = gpkg.db.prepare(`SELECT last_completed_oid, records_written FROM esri_query_resume WHERE id = 1`).get() as any;
        expect(row.last_completed_oid).toBe(2);
        expect(row.records_written).toBe(2);
        expect(gpkg.getResumeCheckpoint()).toEqual({ lastCompletedOid: 2, recordsWritten: 2 });

        await gpkg.close();

        const checkpoint = Gpkg.readResumeCheckpoint(dbPath);
        expect(checkpoint?.lastCompletedOid).toBe(2);
        expect(checkpoint?.recordsWritten).toBe(2);
        expect(checkpoint?.bbox).toEqual([1, 2, 2, 3]);
    });

    test('reopens in append mode, rehydrates counters, and continues the checkpoint', async () => {
        const dbPath = join(tempDir, 'append.gpkg');

        const first = new Gpkg(makeOptions(dbPath), resumeSourceInfo);
        await first.open();
        await first.writeFeature(makeFeature(10));
        await first.writeFeature(makeFeature(11));
        await first.save();
        await first.close();

        const second = new Gpkg(makeOptions(dbPath, { 'gpkg-resume-append': true }), resumeSourceInfo);
        await second.open();
        expect(second.getResumeCheckpoint()).toEqual({ lastCompletedOid: 11, recordsWritten: 2 });
        expect(second.status.records).toBe(2);

        await second.writeFeature(makeFeature(12));
        await second.save();
        await second.close();

        const checkpoint = Gpkg.readResumeCheckpoint(dbPath);
        expect(checkpoint?.lastCompletedOid).toBe(12);
        expect(checkpoint?.recordsWritten).toBe(3);

        // No duplicate rows, and metadata reflects the cumulative count
        const verify = new Gpkg(makeOptions(dbPath, { 'gpkg-resume-append': true }), resumeSourceInfo);
        const rows = verify.db.prepare(`SELECT count(*) AS c FROM "test"`).get() as any;
        expect(rows.c).toBe(3);
        const contents = verify.db.prepare(`SELECT feature_count FROM gpkg_ogr_contents WHERE table_name = 'test'`).get() as any;
        expect(contents.feature_count).toBe(3);
        await verify.close();
    });

    test('append mode loads columns added after the initial schema', async () => {
        const dbPath = join(tempDir, 'columns.gpkg');

        const first = new Gpkg(makeOptions(dbPath), resumeSourceInfo);
        await first.open();
        const lateColumn: GeoJSON.Feature = {
            type: 'Feature',
            properties: { OBJECTID: 1, name: 'a', late_col: 'extra' },
            geometry: { type: 'Point', coordinates: [0, 0] },
        };
        await first.writeFeature(lateColumn);
        await first.save();
        await first.close();

        const second = new Gpkg(makeOptions(dbPath, { 'gpkg-resume-append': true }), resumeSourceInfo);
        expect(Object.keys(second.columns)).toContain('late_col');
        // Writing another feature with the late column must not attempt duplicate DDL
        await second.open();
        await second.writeFeature({
            type: 'Feature',
            properties: { OBJECTID: 2, name: 'b', late_col: 'more' },
            geometry: { type: 'Point', coordinates: [1, 1] },
        });
        await second.save();
        await second.close();

        expect(Gpkg.readResumeCheckpoint(dbPath)?.recordsWritten).toBe(2);
    });

    test('append mode requires the output file to exist', () => {
        const dbPath = join(tempDir, 'missing.gpkg');
        expect(() => new Gpkg(makeOptions(dbPath, { 'gpkg-resume-append': true }), resumeSourceInfo))
            .toThrow(/missing/i);
    });

    test('readResumeCheckpoint returns undefined for non-resume files', async () => {
        const dbPath = join(tempDir, 'plain.gpkg');
        const gpkg = new Gpkg({ output: dbPath, 'layer-name': 'test' } as any, resumeSourceInfo);
        await gpkg.open();
        await gpkg.close();
        expect(Gpkg.readResumeCheckpoint(dbPath)).toBeUndefined();
        expect(Gpkg.readResumeCheckpoint(join(tempDir, 'does-not-exist.gpkg'))).toBeUndefined();
    });

    test('rejects s3 outputs when resume is enabled', () => {
        expect(() => new Gpkg(makeOptions('s3://bucket/key.gpkg'), resumeSourceInfo))
            .toThrow(/s3/i);
    });
});
