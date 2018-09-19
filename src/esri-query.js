/* eslint-env node */
/* eslint-env es6 */
/* ArcGIS Source:
 */

var superagent = require('superagent');
var terraformer = require('terraformer-arcgis-parser');
var runList = require('./recursive-tasklist');
var sqlite3 = require('sqlite3');
var crypto = require('crypto');
var splitBbox = require('./split-bbox');
var TaskQueue = require('./task-queue');

var startQuery = function (sourceUrl, origQueryObj, primaryKeys, sourceInfo, db, options) {
  if (sourceInfo) {
    return runQuery(sourceUrl, origQueryObj, primaryKeys, sourceInfo, options, db);
  } else {
    return postAsync(sourceUrl, {
      'f': 'json'
    }).then(function (source) {
      var fields = source.fields.map(function (field) {
        return field.name;
      });
      return runQuery(sourceUrl, origQueryObj, primaryKeys || fields, source, options, db);
    }).catch(function (e) {
      return new Promise(function (f, r) {
        r(e);
      });
    });
  }
};

var expandBbox = function (newBox, origBox) {
  origBox = origBox || [Infinity, Infinity, -Infinity, -Infinity];
  origBox[0] = origBox[0] > newBox[0] ? newBox[0] : origBox[0];
  origBox[1] = origBox[1] > newBox[1] ? newBox[1] : origBox[1];
  origBox[2] = origBox[2] < newBox[2] ? newBox[2] : origBox[2];
  origBox[3] = origBox[3] < newBox[3] ? newBox[3] : origBox[3];
  return origBox;
};

var runQuery = function (sourceUrl, origQueryObj, primaryKeys, sourceInfo, options, db) {
  // Returns the ESRI Output JSON
  var taskList = [];
  var results = [];
  var bbox;
  var queue = new TaskQueue();

  var reduceQuery = function (sourceUrl, queryObj, primaryKeys, extent) {
    var newExtents = splitBbox(extent);
    // console.log('-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-');
    // console.log('Splitting: ', extent);
    // console.log('To: ', newExtents);
    // console.log('-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-');
    newExtents.forEach(function (newExtent) {
      taskList.push({
        'name': 'Query ' + JSON.stringify(newExtent),
        'description': 'Partial Extent Query',
        'task': queryServer,
        'params': [sourceUrl, queryObj, primaryKeys, newExtent]
      });
    });
  };

  var queryServer = function (sourceUrl, queryObj, primaryKeys, extent) {
    var newQueryObj = JSON.parse(JSON.stringify(queryObj));
    // Add bounding box query
    newQueryObj.inSR = (extent && extent.spatialReference && extent.spatialReference.wkid) || newQueryObj.inSR || null;
    newQueryObj.geometry = extent ? [extent.xmin, extent.ymin, extent.xmax, extent.ymax].join(',') : null;
    newQueryObj.geometryType = 'esriGeometryEnvelope';
    newQueryObj.spatialRel = 'esriSpatialRelIntersects';
    newQueryObj.f = 'json';

    // Check to see if we're going to go over the max limit
    newQueryObj.outFields = primaryKeys ? primaryKeys[0] : '';
    newQueryObj.returnGeometry = false;

    // Make it a query URL if it isn' already one
    sourceUrl = sourceUrl.replace(/query\??$/ig, '');
    sourceUrl = sourceUrl + (sourceUrl.substr(sourceUrl.length - 1) === '/' ? '' : '/') + 'query';

    // Get URL
    console.log('getting url', sourceUrl, newQueryObj);
    return postAsync(sourceUrl, newQueryObj).then(function (data) {
      return new Promise(function (resolve, reject) {
        console.log('prequery finished');
        if (data.exceededTransferLimit) {
          console.log('EXCEEDED', extent);
          reduceQuery(sourceUrl, newQueryObj, primaryKeys, extent);
          resolve(null);
        } else if (data.features && data.features.length === 0) {
          console.log('NO FEATURES LEFT');
          // No features in this query
          resolve(null);
        } else if (data.features) {
          console.log('Found Features', data && data.features && data.features.length);
          newQueryObj.outFields = origQueryObj.outFields || '*';
          newQueryObj.returnGeometry = origQueryObj.returnGeometry;
          // TODO: Add a parameter to set a max features that is less than the limit
          // if (data.features.length > 5000) {
          //   reduceQuery(sourceUrl, newQueryObj, primaryKeys, extent);
          //   resolve(null);
          // }
          return postAsync(sourceUrl, newQueryObj).then(function (data) {
            // We got the data!
            if (data && data.error) {
              console.log('* ERROR getting features **********************************');
              console.log(data.error);
              console.log('* ERROR ************************************');
              reduceQuery(sourceUrl, newQueryObj, primaryKeys, extent);
              resolve(null);
            } else {
              resolve(data); // TODO: transform it?
            }
          }).catch(function (e) {
            // There was some kind of error, check it, and maybe split bbox?
            reduceQuery(sourceUrl, newQueryObj, primaryKeys, extent);
            resolve(null);
          });
        } else if (data.error) {
          console.log('* ERROR with prequery  **********************************');
          console.log(data.error);
          console.log('* ERROR ************************************');
          newQueryObj.outFields = origQueryObj.outFields || '*';
          newQueryObj.returnGeometry = origQueryObj.returnGeometry;

          reduceQuery(sourceUrl, newQueryObj, primaryKeys, extent);
          resolve(null);
        } else {
          // Not much else we can do? error? null?
          console.log('???????????????????????????');
          process.exit();
          resolve(null);
        }
      });
    }).catch(function (e) {
      return new Promise(function (resolve, reject) {
        // TODO, actually fail on 404s
        console.log('Error with request');
        console.log(e);
        if (e.code === 'ECONNRESET') {
          reduceQuery(sourceUrl, newQueryObj, primaryKeys, extent);
          resolve(null);
        } else {
          reject(e);
        }
      });
    });
  };

  taskList.push({
    'name': 'First Query',
    'description': 'Starts off the query',
    'task': queryServer,
    'params': [sourceUrl, origQueryObj, primaryKeys, sourceInfo.extent]
  });

  return runList(taskList, results).then(function (data) {
    db.parallelize(function () {
      for (var i = 0; i < data.length; i++) {
        var result = data[i];
        var esriOptions = {
          'sr': (result && result.spatialReference && (result.spatialReference.latestWkid || result.spatialReference.wkid)) || null
        };
        if (result && result.features) {
          result.features.forEach(function (feature) {
            feature = feature || {};
            var geometry = null;
            try {
              if (feature.geometry) {
                geometry = terraformer.parse(esriOptions.asGeoJSON ? feature : feature.geometry, esriOptions);
              }
            } catch (e) {
              console.log('error with geometry', e);
            }

            // Successfully parsed the geometry!
            var dbGeometry = JSON.stringify(geometry);
            var dbProperties = JSON.stringify(feature.attributes);
            bbox = expandBbox(geometry.bbox(), bbox);
            var dbHash = crypto.createHash('md5').update(dbGeometry + dbProperties).digest('hex');

            queue.add();
            db.run('INSERT INTO cache VALUES (?, ?, ?)', [dbGeometry, dbProperties, dbHash], function () {
              queue.remove();
            });
          });
        }
      }
    });
    queue.remove();
    return queue.promise.then(function () {
      return new Promise(function (res) {
        res({
          'db': db,
          'bbox': bbox
        });
      });
    });
  });
};

var postAsync = function (url, query) {
  return new Promise(function (resolve, reject) {
    superagent.post(url)
      .set('Accept', 'application/json')
      .send(superagent.serialize['application/x-www-form-urlencoded'](query))
      .end(function (err, res) {
        var body;
        try {
          body = JSON.parse(res.text);
        } catch (e) {
          err = err || e;
        }
        if (err) {
          reject(err);
        } else {
          resolve(body);
        }
      });
  });
};

module.exports = function (url, whereObj, primaryKeys, sourceInfo, options) {
  /* Valid Options
   * 'sr': output SR
   */

  options = options || {};
  var db = new sqlite3.Database(':memory:');
  db.serialize(function () {
    db.run('CREATE TABLE cache (geometry TEXT, properties TEXT, hash TEXT)');
  });
  return startQuery(url, whereObj, primaryKeys, sourceInfo, db, options);
};
