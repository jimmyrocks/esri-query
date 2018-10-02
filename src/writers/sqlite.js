/* eslint-env node, es6 */
const sqlite3 = require('sqlite3');
const wkx = require('wkx');

var sqlite = function (options) {
  // Function level variables
  var db; // The database object
  var backlog = []; // Keeps track of all the commands that were requested to be run
  var backlogRunning = 0; // Makes sure that we don't run the backlog too frequently
  var buffer = ''; // Used to take partial json objects and build them into bigger ones
  var closing = false; // Once the close function is called, this goes into closing mode
  var columns = {}; // Keeps track of the columns in the database
  var callPromise = {}; // Allows us to call back when this function is all done

  // Defaults and options
  var tableName = options.tableName || 'geojson';
  var geomColumn = options.geomColumn || 'the_geom';
  var geomFormat = options.geomFormat ? 'to' + options.geomFormat : 'toWkt';
  var outFile = options.output || ':memory:';
  columns[geomColumn] = 'STRING';

  // Allow us to resolve and reject this function
  var promise = new Promise(function (resolve, reject) {
    callPromise.res = resolve;
    callPromise.rej = reject;
  });

  // Add a command to the queue
  var addCommand = function (cmd, params) {
    backlog.push({
      'cmd': cmd,
      'params': params || []
    });
  };

  // Recursively run the backlog of commands
  var runBacklog = function () {
    if (backlogRunning < 1 && backlog.length > 0) {
      var thisCommand = backlog.shift();
      backlogRunning++;
      // console.error(thisCommand);
      db.run(thisCommand.cmd, thisCommand.params, function (e) {
        backlogRunning--;
        if (e) {
          callPromise.rej(e);
          throw new Error(e);
        } else {
          runBacklog();
        }
      });
    } else {
      if (closing) {
        db.close();
        callPromise.res(db);
      }
    }
  };

  var open = function () {
    //TODO support extra tables for GeoPackage: http://www.geopackage.org/guidance/getting-started.html
    var initCommands;
    var createTableStatement = '';
    for (var column in columns) {
      createTableStatement += createTableStatement.length > 0 ? ', ' : '';
      createTableStatement += '"' + column + '" ' + columns[column];
    }
    createTableStatement = 'CREATE TABLE "' + tableName + '" (' + createTableStatement + ')';
    initCommands = [
      createTableStatement,
      'BEGIN TRANSACTION'
    ];

    db = new sqlite3.Database(outFile);
    // Run the init commands (generally make tables)
    initCommands.forEach(function (cmd) {
      addCommand(cmd);
    });
    runBacklog();
  };

  var save = function () {
    addCommand('COMMIT');
    addCommand('BEGIN TRANSACTION');
    if (!backlogRunning) {
      runBacklog();
    }
  };

  var close = function () {
    addCommand('COMMIT');
    closing = true;
    if (!backlogRunning) {
      runBacklog();
    }
  };

  var write = function (line) {
    var geojson;
    buffer += line;
    try {
      geojson = JSON.parse(buffer);
      buffer = '';
    } catch (e) {
      return e;
    }

    var geometry = wkx.Geometry.parseGeoJSON(geojson.geometry);
    var properties = geojson.properties;
    var insertValues = [];
    var insertColumns = [];
    for (var property in properties) {
      if (!columns[property]) {
        columns[property] = 'STRING';
        addCommand('ALTER TABLE "' + tableName + '" ADD "' + property + '" ' + columns[property]);
      }
      insertColumns.push(property);
      insertValues.push(properties[property]);
    }
    insertColumns.push(geomColumn);
    insertValues.push(geometry[geomFormat]().toString());
    var insertStatement = 'INSERT INTO "' + tableName + '" ("' + insertColumns.join('", "') + '") VALUES (';
    insertStatement += insertValues.map(function () {
      return '?';
    }).join(',');
    insertStatement += ')';
    addCommand(insertStatement, insertValues);
    if (!backlogRunning) {
      runBacklog();
    }
  };


  return {
    'open': open,
    'close': close,
    'write': write,
    'save': save,
    'stream': db,
    'promise': promise
  };
};

module.exports = sqlite;
