import Gpkg from './Gpkg';
import { describe, expect, test, beforeAll, afterAll } from '@jest/globals';
import { CliBaseOptionsType, CliSqlOptionsType, CliGeoJsonOptionsType } from '..';
import { EsriFeatureLayerType } from '../helpers/esri-rest-types';

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

    beforeAll(() => {
        // Create an instance of the SqliteDb class before running the tests
        gpkg = new Gpkg(options, sourceInfo);
    });

    afterAll(() => {
        // Close the database connection and delete the test database file after running the tests
        gpkg.close();
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

    test('should open and close without errors', () => {
        const gpkg = new Gpkg(options, sourceInfo);

        expect(gpkg.db.open).toEqual(true);
        gpkg.close();
        expect(gpkg.db.open).toEqual(false);
    });

    test('should contain required tables', () => {
        const gpkg = new Gpkg(options, sourceInfo);
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
        ]

        const hasTableStatement = gpkg.db.prepare(`SELECT count(*) FROM sqlite_master WHERE type='table' AND name=@tableName;`);
        requiredTables.forEach(tableName => {
            const hasTable = hasTableStatement.get({ tableName });
            expect(hasTable).toEqual({ 'count(*)': 1 });
        });
    });
});
