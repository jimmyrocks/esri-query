import Writer from './Writer.js';
import Database, { RunResult } from 'better-sqlite3';
import path from 'path';

import { default as wkx } from 'wkx';
import { EsriFeatureLayerType } from '../helpers/esri-rest-types.js';
import { CliBaseOptionsType, CliGeoJsonOptionsType, CliSqlOptionsType } from '..';

class BatchWriter {
  db: Database.Database;
  statements: Map<string, Database.Statement> = new Map();
  queue: Array<[Database.Statement, Array<string | number> | { [column: string]: string | number }]> = [];

  constructor(db: Database.Database, flushInterval?: number | undefined) {
    this.db = db;
  }

  stop() {
    this.flushQueue();
    return this.queue.length === 0;
  }

  queueStatement(sql: string, params: Array<string | number> | { [column: string]: string | number }) {
    let statement;
    if (this.statements.has(sql)) {
      statement = this.statements.get(sql);
    } else {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    this.queue.push([statement, params]);
  }

  flushQueue() {
    if (this.queue.length === 0) {
      return;
    }

    // Start a transaction
    const insertTransaction = this.db.transaction((count) => {
      for (let i = 0; i < count; i++) {
        const [statement, params] = this.queue.shift();
        statement.run(params);
      }
    });

    insertTransaction(this.queue.length);
  }
}

export default class GpkgInterface extends Writer {
  db: Database.Database;
  columns: {
    [key: string]: 'NULL' | 'INTEGER' | 'REAL' | 'TEXT' | 'BLOB' | 'GEOMETRY'
  };
  _commandBacklog: Array<{
    cmd: string,
    params: Array<string | number>
  }> = [];
  geometryColumnName: string = 'the_geom'; //TODO option
  batchWriter: BatchWriter;
  declare options: CliBaseOptionsType & CliSqlOptionsType;

  constructor(options: CliBaseOptionsType & (CliSqlOptionsType | CliGeoJsonOptionsType), sourceInfo: EsriFeatureLayerType & { totalFeatureCount?: number }) {
    super(options, sourceInfo);
    if (!this.options.output) throw new Error('Output filename required for GPKG format.');
    if (!this.options['layer-name']) {
      // If no layer-name comes in, pull it from the filename
      this.options['layer-name'] = path.basename(this.options.output, path.extname(this.options.output));
    }
    this.setSourceInfo(sourceInfo);

    // Create the database
    this.db = GpkgInterface.createGpkg(options.output);
    this.addLayer(this.options['layer-name'], this.columns);
    this.batchWriter = new BatchWriter(this.db);
  }

  static createGpkg(outputFilename: string): Database.Database {
    const db = new Database(outputFilename);
    db.pragma('journal_mode = WAL');
    const cmds = initializeGeoPackageCommands.split(';').filter(v => v.trim().length > 0).map(v => v + ';');
    db.transaction((cmds: string[]) =>
      cmds.map(cmd => db.prepare(cmd).run())
    )(cmds);
    return db;
  }

  writeFeature(feature: GeoJSON.Feature) {
    const geojson = super.writeFeature(feature);
    const geometry = this._geojsonToGpkg(geojson);

    const properties = geojson.properties;

    const insertValues: Array<typeof geojson.properties.feature[0]> = [];
    const insertColumns: Array<string> = [];

    Object.entries(properties).map(([column, value]) => {
      // Add an extra column if one comes up (it shouldn't)
      // TODO Gpkg should have a add column function
      if (!this.columns[column]) {
        this.columns[column] = 'TEXT';
        this.addColumn(this.options['layer-name'], column, this.columns[column]);
      }
      insertColumns.push(column);
      insertValues.push(value);
    });

    // Add the geometry
    insertColumns.push(this.geometryColumnName);
    insertValues.push(geometry);

    // Add the values and the parameters
    let insertStatement = `
      INSERT INTO "${this.options['layer-name']}" ("${insertColumns.join('", "')}")
      VALUES (${insertValues.map(() => '?').join(',')})`;

    this.batchWriter.queueStatement(insertStatement, insertValues);
    return geojson;
  };

  save(): void {
    this.batchWriter.flushQueue();
  }

  close(): void {
    this.batchWriter.stop();
    this.db.close();
    return super.close();
  }

  setSourceInfo(sourceInfo: EsriFeatureLayerType) {
    // Convert these fields to columns
    // 'NULL' | 'INTEGER' | 'REAL' | 'TEXT' | 'BLOB'
      const typesToSqlite = {
        esriFieldTypeInteger: 'INTEGER',
        esriFieldTypeSmallInteger: 'INTEGER',
        esriFieldTypeDouble: 'REAL',
        esriFieldTypeSingle: 'REAL',
        esriFieldTypeString: 'TEXT',
        esriFieldTypeDate: 'TEXT',
        esriFieldTypeGeometry: 'TEXT',
        esriFieldTypeOID: 'TEXT',
        esriFieldTypeBlob: 'BLOB',
        esriFieldTypeGlobalID: 'TEXT',
        esriFieldTypeRaster: 'TEXT',
        esriFieldTypeGUID: 'TEXT',
        esriFieldTypeXML: 'TEXT'
      }

    this.columns = sourceInfo.fields
      .filter(field => field.type !== 'esriFieldTypeGeometry') // Filter out the geometry field
      .map(field => (
        {
          name: field.name,
          type: typesToSqlite[field.type]
        }
      )).reduce((a, c) => ({ ...a, ...{ [c.name]: c.type } }), {});
  };

  addColumn(layerName: string, columnName: string, columnType: 'NULL' | 'INTEGER' | 'REAL' | 'TEXT' | 'BLOB' | 'GEOMETRY'): RunResult {
    return this.db.prepare(`ALTER TABLE "${layerName}" ADD "${columnName}" ${columnType}`).run();
  };

  addLayer(layerName: string, columns: { [key: string]: 'NULL' | 'INTEGER' | 'REAL' | 'TEXT' | 'BLOB' | 'GEOMETRY' }): RunResult[] {
    const { name: sourceName, description: sourceDescription, geometryType, totalFeatureCount, drawingInfo } = this.sourceInfo;
    const srid = 4326;
    const geometryColumnName = 'the_geom';
    const sourceDrawingInfo = drawingInfo ? JSON.stringify(drawingInfo) : '{}';

    const commands: Array<{ cmd: string, params: Array<string | number> | { [key: string]: string | number } }> = [];

    //GPKG Layer Statement
    const gpkgContents = {
      cmd: `INSERT INTO "gpkg_contents" (
        table_name,
        data_type,
        identifier,
        description,
        min_x,
        min_y,
        max_x,
        max_y,
        srs_id
      ) VALUES (@tableName, @dataType, @identifier, @description, @minX, @minY, @maxX, @maxY, @srsId);`,
      params: {
        tableName: layerName,
        dataType: 'features',
        identifier: sourceName,
        description: sourceDescription,
        minX: -180,
        minY: -90,
        maxX: 180,
        maxY: 90,
        srsId: srid.toString()
      }
    };
    commands.push(gpkgContents);

    const gpkgOgrContents = {
      cmd: `INSERT INTO "gpkg_ogr_contents" (
        table_name,
        feature_count
        ) VALUES (@tableName, @totalFeatureCount);
        `,
      params: { tableName: layerName, totalFeatureCount }
    };
    commands.push(gpkgOgrContents);

    // Create the table for the new dataset
    const createColumns = Object.entries({ ...columns, [geometryColumnName]: 'GEOMETRY' })
      .map(([name, type]) => '"' + name + '" ' + type)
      .join(', ');
    const createDatasetTable = { 'cmd': `CREATE TABLE "${layerName}" (${createColumns})`, params: {} };
    commands.push(createDatasetTable);

    // Set up the geometry columns // TODO elsewhere
    const geometryTypeLookup = {
      esriGeometryPoint: 'POINT',
      esriGeometryMultipoint: 'MULTIPOINT',
      esriGeometryPolyline: 'MULTILINESTRING',
      esriGeometryPolygon: 'MULTIPOLYGON',
      esriGeometryEnvelope: 'GEOMETRY'
    };
    const gpkgGeometryColumns = {
      cmd: 'INSERT INTO "gpkg_geometry_columns" (table_name, column_name, geometry_type_name, srs_id, z, m) VALUES (?,?,?,?,?,?);',
      params: [layerName, geometryColumnName, geometryTypeLookup[geometryType], srid, 0, 0
      ]
    };
    commands.push(gpkgGeometryColumns);

    // Add the style in
    const layerStyles = {
      cmd: 'INSERT INTO "layer_styles" (id, useAsDefault, f_table_name, f_geometry_column, styleName, description, styleESRI, styleMapBox) VALUES (1,1,?,?,?,?,?,?);',
      params: [
        layerName, geometryColumnName, sourceName, sourceDescription, sourceDrawingInfo, null
      ]
    };
    commands.push(layerStyles);

    const transaction = this.db.transaction(() => {
      return commands.map(({ cmd, params }) =>
        this.db.prepare(cmd).run(params)
      );
    });

    return transaction();
  }

  /**
  *  Converts a GeoJSON feature into a GeoPackage binary format buffer.
  *  @param feature - The GeoJSON feature to convert.
  *  @returns A buffer containing the GeoPackage binary format representation of the feature.
  */
  _geojsonToGpkg(feature: GeoJSON.Feature): Buffer {
    //https://www.geopackage.org/spec/#gpb_format
    /**
     * GeoPackageBinaryHeader {
     *   byte[2] magic = 0x4750; //'GP' in ASCII
     *   byte version; // 8-bit unsigned integer, 0 = version 1
     *   byte flags; //  	see bit layout of GeoPackageBinary flags byte (https://www.geopackage.org/spec/#flags_layout)
     *   int32 srs_id; //  	the SRS ID, with the endianness specified by the byte order flag
     *   double[] envelope; // see envelope contents indicator code below, with the endianness specified by the byte order flag
     * }
     * 
     * 
     * StandardGeoPackageBinary {
     *   GeoPackageBinaryHeader header; // The header above
     *   WKBGeometry geometry; // 
     * }
     */

    // Create the well known binary version of the GeoJSON Feature Geometry
    let geom: wkx.Geometry;
    try {
      geom = wkx.Geometry.parseGeoJSON(feature.geometry);
    } catch (e) {
      console.error('Error parsing geometry, using null geometry');
      return Buffer.alloc(0);
    }

    // Create the standard Geo Package Binary

    // Header Buffer
    /////////////////////////////////////////
    const headerBuffer = Buffer.alloc(8);
    headerBuffer.writeUInt16BE(0x4750, 0); //'GP' in ASCII
    headerBuffer.writeUInt8(0, 2);

    // Generate the flags
    let flags = 0;
    flags |= 1; // Use little endian, since WKX outputs LE and the spec says it should be consistent
    if (feature.bbox) flags |= 0b10; // 1: envelope is [minx, maxx, miny, maxy], 32 bytes
    headerBuffer.writeUInt8(flags, 3); // write the flags 

    // Write out the EPSG (Always 4326 (TODO allow others?))
    headerBuffer.writeUInt32LE(4326, 4);

    // Header Buffer
    /////////////////////////////////////////
    const envelopeBuffer = feature.bbox ? Buffer.alloc(32) : Buffer.alloc(0);
    if (feature.bbox) {
      envelopeBuffer.writeDoubleLE(feature.bbox[0], 0); // minx
      envelopeBuffer.writeDoubleLE(feature.bbox[2], 8); // maxx
      envelopeBuffer.writeDoubleLE(feature.bbox[1], 16); // miny
      envelopeBuffer.writeDoubleLE(feature.bbox[3], 24); // maxy
    }

    const standardGeoPackageBinary = [
      headerBuffer,
      envelopeBuffer,
      geom.toWkb()
    ];

    return Buffer.concat(standardGeoPackageBinary);
  };

};
// These are taken from the empty geopackage template
// http://www.geopackage.org/data/empty.gpkg

// I added some fields to the layer_styles, they _may_ cause issues
// https://gis.stackexchange.com/questions/341720/write-layer-style-qml-as-predefined-within-a-gpkg-using-r
const initializeGeoPackageCommands = `
    PRAGMA foreign_keys = OFF;
    PRAGMA application_id = 1196444487;
    PRAGMA user_version = 10200;
    CREATE TABLE gpkg_spatial_ref_sys(srs_name TEXT NOT NULL, srs_id INTEGER NOT NULL PRIMARY KEY, organization TEXT NOT NULL, organization_coordsys_id INTEGER NOT NULL, definition  TEXT NOT NULL, description TEXT);
    CREATE TABLE gpkg_ogr_contents (table_name text, feature_count int);
    INSERT INTO gpkg_spatial_ref_sys VALUES('Undefined cartesian SRS', -1, 'NONE', -1, 'undefined', 'undefined cartesian coordinate reference system');
    INSERT INTO gpkg_spatial_ref_sys VALUES('Undefined geographic SRS', 0, 'NONE', 0, 'undefined', 'undefined geographic coordinate reference system');
    INSERT INTO gpkg_spatial_ref_sys VALUES('WGS 84 geodetic', 4326, 'EPSG', 4326, 'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563,AUTHORITY["EPSG","7030"]],AUTHORITY["EPSG","6326"]],PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]],AUTHORITY["EPSG","4326"]]', 'longitude/latitude coordinates in decimal degrees on the WGS 84 spheroid');
    CREATE TABLE gpkg_geometry_columns(table_name TEXT NOT NULL, column_name TEXT NOT NULL, geometry_type_name TEXT NOT NULL, srs_id INTEGER NOT NULL, z TINYINT NOT NULL, m TINYINT NOT NULL, CONSTRAINT pk_geom_cols PRIMARY KEY(table_name, column_name), CONSTRAINT fk_gc_tn FOREIGN KEY(table_name) REFERENCES gpkg_contents(table_name), CONSTRAINT fk_gc_srs FOREIGN KEY(srs_id) REFERENCES gpkg_spatial_ref_sys(srs_id));
    CREATE TABLE gpkg_tile_matrix_set(table_name TEXT NOT NULL PRIMARY KEY, srs_id INTEGER NOT NULL, min_x DOUBLE NOT NULL, min_y DOUBLE NOT NULL, max_x DOUBLE NOT NULL, max_y DOUBLE NOT NULL, CONSTRAINT fk_gtms_table_name FOREIGN KEY(table_name) REFERENCES gpkg_contents(table_name), CONSTRAINT fk_gtms_srs FOREIGN KEY(srs_id) REFERENCES gpkg_spatial_ref_sys(srs_id));
    CREATE TABLE gpkg_tile_matrix(table_name TEXT NOT NULL, zoom_level INTEGER NOT NULL, matrix_width INTEGER NOT NULL, matrix_height INTEGER NOT NULL, tile_width INTEGER NOT NULL, tile_height INTEGER NOT NULL, pixel_x_size DOUBLE NOT NULL, pixel_y_size DOUBLE NOT NULL, CONSTRAINT pk_ttm PRIMARY KEY(table_name, zoom_level), CONSTRAINT fk_tmm_table_name FOREIGN KEY(table_name) REFERENCES gpkg_contents(table_name));
    CREATE TABLE gpkg_extensions(table_name TEXT, column_name TEXT, extension_name TEXT NOT NULL, definition TEXT NOT NULL, scope TEXT NOT NULL, CONSTRAINT ge_tce UNIQUE(table_name, column_name, extension_name));
    CREATE TABLE gpkg_contents(
        table_name TEXT NOT NULL PRIMARY KEY,
        data_type TEXT NOT NULL,
        identifier TEXT UNIQUE,
        description TEXT DEFAULT '',
        last_change DATETIME NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        min_x DOUBLE,
        min_y DOUBLE,
        max_x DOUBLE,
        max_y DOUBLE,
        srs_id INTEGER,
        CONSTRAINT fk_gc_r_srs_id FOREIGN KEY(srs_id) REFERENCES gpkg_spatial_ref_sys(srs_id)
    );
    CREATE TABLE layer_styles (
      id INTEGER NOT NULL PRIMARY KEY,
      f_table_catalog TEXT(256),
      f_table_schema TEXT(256),
      f_table_name TEXT(256),
      f_geometry_column TEXT(256),
      styleName TEXT(30),
      styleQML TEXT,
      styleSLD TEXT,
      styleMapbox TEXT,
      styleESRI TEXT,
      originalStyle TEXT,
      useAsDefault BOOLEAN,
      description TEXT,
      owner TEXT(30),
      ui TEXT(30),
      update_time DATETIME NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
`;