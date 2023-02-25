import Gpkg, { SqliteDb } from './Gpkg';
import { describe, expect, test, beforeAll, afterAll } from '@jest/globals';
import { CliBaseOptionsType, CliSqlOptionsType, CliGeoJsonOptionsType } from '..';
import { EsriFeatureLayerType } from '../helpers/esri-rest-types';
import { unlinkSync } from 'fs';


describe('SqliteDb', () => {
    const dbFilename = ':memory:';
    let db: SqliteDb;

    beforeAll(async () => {
        // Create an instance of the SqliteDb class before running the tests
        db = new SqliteDb(dbFilename);
    });

    afterAll(() => {
        // Close the database connection and delete the test database file after running the tests
        db.close();
    });

    test('should load the database', (done) => {
        // Test that the database is loaded by checking that the "loaded" property is set to true
        db.events.on('load', () => {
            expect(db.loaded).toBe(true);
            done();
        });
    });

    test('should run SQL statements', async () => {
        // Test that the runList method executes the SQL statements passed to it
        await db.runList(`
      CREATE TABLE test_table (
        id INTEGER PRIMARY KEY,
        name TEXT
      );
      INSERT INTO test_table (name) VALUES ('test1');
      INSERT INTO test_table (name) VALUES ('test2');
      INSERT INTO test_table (name) VALUES ('test3');
      INSERT INTO test_table (name) VALUES ('test4');
      INSERT INTO test_table (name) VALUES ('test5');

    `);
        const result = await db.get('SELECT * FROM test_table;');
        expect(result).toEqual([
            { id: 1, name: 'test1' }, { id: 2, name: 'test2' }, { id: 3, name: 'test3' }, { id: 4, name: 'test4' }, { id: 5, name: 'test5' }
        ]);
    });

    test('should already have the GPKG tables loaded', async () => {
        // Make sure we have ESPG:4326
        const result = await db.get('SELECT srs_name , srs_id, organization, organization_coordsys_id FROM gpkg_spatial_ref_sys WHERE srs_id = 4326;');
        expect(result).toEqual([{ srs_name: 'WGS 84 geodetic', 'srs_id': 4326, 'organization': 'EPSG', 'organization_coordsys_id': 4326 }]);

        // test contents table fields
        const contentsTable = await db.get('pragma table_info(\'gpkg_contents\');');
        expect(contentsTable.length).toEqual(10);

        // test contents table fields
        const layersTable = await db.get('pragma table_info(\'layer_styles\');');
        expect(layersTable.length).toEqual(16);
    });
});

describe('Gpkg', () => {

    const options = {
        output: 'Gpkg.unit.test.gpkg',
        'layer-name': 'test'
    } as CliBaseOptionsType & (CliSqlOptionsType | CliGeoJsonOptionsType);

    afterAll(() => {
        // Close the database connection and delete the test database file after running the tests
        unlinkSync(options.output);
    });

    test('should open and close without errors', async () => {

        const gpkg = new Gpkg(options, {
            'fields': [{
                name: 'oid',
                type: 'esriFieldTypeString'
            }],
            geometryType: 'esriGeometryPoint'
        } as any as EsriFeatureLayerType);
        gpkg.open();
        await new Promise(res => gpkg.db.events.once('load', res));
        expect(gpkg.dbStatus).toEqual('running');
        gpkg.close();
        await new Promise(res => gpkg.db.events.once('close', res));
        expect(gpkg.dbStatus).toEqual('idle');
    });
});
