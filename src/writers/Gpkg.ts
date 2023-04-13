
import Writer from './Writer.js';
import { default as sqlite } from 'sqlite3';
import { EventEmitter } from 'events';
import path from 'path';

import { default as wkx } from 'wkx';
import { EsriFeatureLayerType } from '../helpers/esri-rest-types.js';
import { CliBaseOptionsType, CliGeoJsonOptionsType, CliSqlOptionsType } from '..';

/**
 * A wrapper class for the `sqlite3` package, providing a simplified API for working with an SQLite database.
 */
export class SqliteDb {
  /** The `sqlite3` database object. */
  db: sqlite.Database;
  /** The event emitter instance used to emit and listen to events. */
  events: EventEmitter = new EventEmitter();
  /** Whether the database has finished loading. */
  loaded: boolean = false;

  /**
   * Creates a new `SqliteDb` instance.
   * @param filename The filename of the SQLite database to open.
   */
  constructor(filename: string) {
    // Listen for error events on the event emitter and log them to the console
    this.events.on('error', console.error);
    // Create a new `sqlite3` database instance and run the `initializeGeoPackageCommands()` to create a GeoPackage database
    this.db = new sqlite.Database(filename, (e: Error) => {
      if (e) {
        this.events.emit('error', e);
      } else {
        // TODO check if it's already a geopackage
        this.runList(initializeGeoPackageCommands()).then(() => {
          // Mark the database as loaded and emit a "load" event
          this.loaded = true;
          this.events.emit('load', this);
        }).catch(e => this.events.emit('error', e))
      }
    })
  }

  /**
   * Runs a list of SQL statements against the database.
   * @param sql The SQL statements to run, separated by semicolons.
   * @returns A promise that resolves when all the SQL statements have finished executing.
   */
  async runList(sql: string): Promise<void> {
    // Split the SQL statements by semicolons, filter out any empty statements, and add the semicolon back to each statement
    const cmds = sql.split(';').filter(v => v.trim().length > 0).map(v => v + ';');
    // Run each SQL statement in sequence, waiting for each one to finish before running the next one
    for (const cmd of cmds) {
      await this.run(cmd);
    }
    return;
  }

  /**
   * Runs a single SQL statement against the database.
   * @param sql The SQL statement to run.
   * @param params Optional parameters to substitute into the SQL statement.
   * @returns A promise that resolves with the result of the SQL statement.
   */
  run(sql: string, params: Array<string | number> = []): Promise<unknown> {
    return new Promise((res, rej) =>
      this.db.run(sql, params, (e: Error, r: unknown) =>
        e ? rej(e) : res(r)
      ));
  }

  get(sql: string, params: Array<string | number> = []): Promise<Array<{ [key: string]: any }>> {
    return new Promise((res, rej) =>
      this.db.all(sql, params, (e: Error, r: Array<{ [key: string]: any }>) =>
        e ? rej(e) : res(r)
      ));
  }

  /**
   * Closes the database connection.
   * @returns A promise that resolves when the connection has been closed.
   */
  close(): Promise<void> {
    return new Promise((res, rej) =>
      this.db.close((e: Error) => {
        // Emit a "close" event when the database has been closed
        this.events.emit('close', this);
        e ? rej(e) : res();
      }));
  }

}

export default class Gpkg extends Writer {
  db?: SqliteDb;
  columns: {
    [key: string]: 'NULL' | 'INTEGER' | 'REAL' | 'TEXT' | 'BLOB' | 'GEOMETRY'
  };
  _commandBacklog: Array<{
    cmd: string,
    params: Array<string | number>
  }> = [];
  dbStatus: 'new' | 'idle' | 'running' | 'closed' = 'new';
  runningCommands: number = 0;
  closing: boolean = false;
  buffer: string = '';
  layerName: string;
  geometryColumnName: string = 'the_geom'; //TODO option
  declare options: CliBaseOptionsType & CliSqlOptionsType;

  constructor(options: CliBaseOptionsType & (CliSqlOptionsType | CliGeoJsonOptionsType), sourceInfo: EsriFeatureLayerType) {
    super(options, sourceInfo);
    if (!this.options.output) throw new Error('Output filename required for GPKG format.');
    if (!this.options['layer-name']) {
      this.options['layer-name'] = path.basename(this.options.output, path.extname(this.options.output));
    }
    this.setSourceInfo(sourceInfo);
  }

  open() {
    let createTableStatement = '';
    this.layerName = this.options['layer-name'];

    //GPKG setup
    const gpkgContent = `INSERT INTO "gpkg_contents" (
      table_name,
      data_type,
      identifier,
      description,
      min_x,
      min_y,
      max_x,
      max_y,
      srs_id
    ) VALUES (?,?,?,?,?,?,?,?,?);`;
    const gpkgParams = [this.options['layer-name'], 'features', this.sourceInfo.name, this.sourceInfo.description, -180, -90, 180, 90, '4326'];
    const geometryTypeLookup = {
      esriGeometryPoint: 'POINT',
      esriGeometryMultipoint: 'MULTIPOINT',
      esriGeometryPolyline: 'MULTILINESTRING',
      esriGeometryPolygon: 'MULTIPOLYGON',
      esriGeometryEnvelope: 'GEOMETRY'
    };

    const gpkgOgrContents = `INSERT INTO "gpkg_ogr_contents" (
      table_name,
      feature_count
      ) VALUES (?,?)
      `;
    const gpkgOgrParams = [this.options['layer-name'], this.status.records];


    // Create the table for the new dataset
    const createColumns = Object.keys(this.columns)
      .map(name => '"' + name + '" ' + this.columns[name])
      .join(', ');

    createTableStatement = 'CREATE TABLE "' + this.layerName + '" (' + createColumns + ', "' + this.geometryColumnName + '" GEOMETRY) ';

    this.addCommand(createTableStatement);
    this.addCommand(gpkgContent, gpkgParams);
    this.addCommand(gpkgOgrContents, gpkgOgrParams);

    // Set up the geometry columns
    this.addCommand('INSERT INTO "gpkg_geometry_columns" (table_name, column_name, geometry_type_name, srs_id, z, m) VALUES (?,?,?,?,?,?);', [
      this.options['layer-name'], this.geometryColumnName, geometryTypeLookup[this.sourceInfo.geometryType], 4326, 0, 0
    ])

    // Add the style in
    this.addCommand('INSERT INTO "layer_styles" (id, useAsDefault, f_table_name, f_geometry_column, styleName, description, styleESRI, styleMapBox) VALUES (1,1,?,?,?,?,?,?);', [
      this.options['layer-name'], this.geometryColumnName, this.sourceInfo.name, this.sourceInfo.description, JSON.stringify(this.sourceInfo.drawingInfo), null
    ]);

    this.addCommand('BEGIN TRANSACTION');

    this.db = new SqliteDb(this.options.output);
    this.db.events.on('load', () => this.runBacklog());
    this.status.canWrite = true;
  };

  close() {
    this.addCommand('COMMIT');
    if (!this.options['no-bbox']) {
      // If the bbox was requested, update it
      this.addCommand(
        `UPDATE "gpkg_contents" SET min_x = ?, min_y = ?, max_x = ?, max_y = ? WHERE "table_name" = ?;`,
        [...this.status.bbox, this.options['layer-name']]
      );
    }
    // Write out the ogr contents
    this.addCommand(
      `UPDATE "gpkg_ogr_contents" SET feature_count = ? WHERE "table_name" = ?;`,
      [this.status.records, this.options['layer-name']]
    );
    this.closing = true;
    this.runBacklog();
    this.status.canWrite = false;
  };

  writeFeature(feature: GeoJSON.Feature) {
    const geojson = super.writeFeature(feature);
    const geometry = this._geojsonToGpkg(geojson);

    const properties = geojson.properties;

    const insertValues: Array<typeof geojson.properties.feature[0]> = [];
    const insertColumns: Array<string> = [];

    Object.keys(properties).map(property => {
      // Add an extra column if one comes up (it shouldn't)
      if (!this.columns[property]) {
        this.columns[property] = 'TEXT';
        this.addCommand('ALTER TABLE "' + this.layerName + '" ADD "' + property + '" ' + this.columns[property]);
      }
      insertColumns.push(property);
      insertValues.push(properties[property]);
    });

    // Add the geometry
    insertColumns.push(this.geometryColumnName);
    insertValues.push(geometry);

    // Add the values and the parameters
    let insertStatement = 'INSERT INTO "' + this.layerName + '" ("' + insertColumns.join('", "') + '") VALUES (';
    insertStatement += insertValues.map(() => '?').join(',');
    insertStatement += ')';

    this.addCommand(insertStatement, insertValues);
    this.runBacklog();
    return geojson;
  };

  save() {
    this.addCommand('COMMIT');
    this.addCommand('BEGIN TRANSACTION');
    this.runBacklog();
  };

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

    this.columns = this.sourceInfo.fields
      .filter(field => field.type !== 'esriFieldTypeGeometry') // Filter out the geometry field
      .map(field => (
        {
          name: field.name,
          type: typesToSqlite[field.type]
        }
      )).reduce((a, c) => ({ ...a, ...{ [c.name]: c.type } }), {});
  };

  addCommand(cmd: string, params?: Array<string | number>) {
    this._commandBacklog.push({
      'cmd': cmd,
      'params': params || []
    });
  };


  async runBacklog() {
    if (this.runningCommands === 0 && this._commandBacklog.length > 0) {
      const thisCommand = this._commandBacklog.shift();

      this.runningCommands++;
      this.dbStatus = 'running';
      try {
        await this.db.run(thisCommand.cmd, thisCommand.params);
      } catch (e) {
        console.error('SQLITE ERROR', e);
      }
      this.runningCommands--;
      this.dbStatus = 'idle';
      this.runBacklog();
    } else if (this.runningCommands === 0 && this.closing) {
      await this.db.close();
      this.dbStatus = 'closed';
    }
  };

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
    const generateBuffer = (size: number, cmd: (buffer: Buffer) => void) => {
      // Runs commands on a buffer and returns that buffer
      const b = Buffer.alloc(size);
      cmd(b);
      return b;
    };

    // Create the well known binary version of the GeoJSON Feature Geometry
    const geom = wkx.Geometry.parseGeoJSON(feature.geometry);

    // Create the standard Geo Package Binary
    const standardGeoPackageBinary = [
      generateBuffer(8, b => {
        b.write('GP');
        b.writeUInt8(0, 2);

        // Generate the flags
        let flags = 0;
        flags += 1; // Use little endian, since WKX outputs LE and the spec says it should be consistent
        if (feature.bbox) flags += 1 << 1; // 1: envelope is [minx, maxx, miny, maxy], 32 bytes
        b.writeUInt8(flags, 3); // write the flags 

        // Write out the EPSG (Always 4326 (TODO allow others?))
        b.writeUInt32LE(4326, 4);
      }),
      generateBuffer(feature.bbox ? 32 : 0, b => {
        // TODO Is this useful? We could generate a bbox from the GeoJSON as well
        if (feature.bbox) {
          b.writeDoubleLE(feature.bbox[0], 0); // minx
          b.writeDoubleLE(feature.bbox[2], 8); // maxx
          b.writeDoubleLE(feature.bbox[1], 16); // miny
          b.writeDoubleLE(feature.bbox[3], 24); // maxy
        }
      }), // see envelope contents indicator code below, with the endianness specified by the byte order flag // send nothing
      geom.toWkb()
    ];

    return Buffer.concat(standardGeoPackageBinary);
  };

};
// These are taken from the empty geopackage template
// http://www.geopackage.org/data/empty.gpkg

// I added some fields to the layer_styles, they _may_ cause issues
// https://gis.stackexchange.com/questions/341720/write-layer-style-qml-as-predefined-within-a-gpkg-using-r
const initializeGeoPackageCommands = () => `
    PRAGMA foreign_keys = OFF;
    PRAGMA application_id = 1196444487;
    PRAGMA user_version = 10200;
    BEGIN TRANSACTION;
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
    COMMIT;
`;