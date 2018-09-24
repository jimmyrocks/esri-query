/* eslint-env node */
/* eslint-env es6 */
/* ArcGIS Source:
 */

const terraformer = require('terraformer-arcgis-parser');
const runList = require('./recursive-tasklist');
const crypto = require('crypto');
const splitBbox = require('./split-bbox');
const post = require('./post-async');

var startQuery = function (sourceUrl, origQueryObj, primaryKeys, sourceInfo, outFileID, options) {
  if (sourceInfo) {
    return runQuery(sourceUrl, origQueryObj, primaryKeys, sourceInfo, options, outFileID);
  } else {
    return post(sourceUrl, {
      'f': 'json'
    }).then(function (source) {
      var fields = source.fields.map(function (field) {
        return field.name;
      });
      return runQuery(sourceUrl, origQueryObj, primaryKeys || fields, source, options, outFileID);
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

var runQuery = function (sourceUrl, origQueryObj, primaryKeys, sourceInfo, options, outFileID) {
  // Returns the ESRI Output JSON
  var taskList = [];
  var bbox;
  var hashList = {};
  var first = true;

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
    return post(sourceUrl, newQueryObj).then(function (data) {
      return new Promise(function (resolve) {
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
          return post(sourceUrl, newQueryObj).then(function (data) {
            // We got the data!
            if (data && data.error) {
              console.log('* ERROR getting features **********************************');
              console.log(data.error);
              console.log('* ERROR ************************************');
              reduceQuery(sourceUrl, newQueryObj, primaryKeys, extent);
              resolve(null);
            } else {
              writeOut(data); // TODO: transform it?
              resolve(null);
            }
          }).catch(function () {
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

  var writeOut = function (result) {
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
        var geojsonDoc = `{"type": "Feature", "properties": ${dbProperties}, "geometry": ${dbGeometry}}`;
        var dbHash = crypto.createHash('md5').update(geojsonDoc).digest('hex');

        if (!hashList[dbHash]) {
          hashList[dbHash] = true;
          // add a comma before it unless it's the first one
          fs.writeSync(outFileID, (first ? '' : ', ') + geojsonDoc);
          first = false;
        }
      });
    }
  };

  taskList.push({
    'name': 'First Query',
    'description': 'Starts off the query',
    'task': queryServer,
    'params': [sourceUrl, origQueryObj, primaryKeys, sourceInfo.extent]
  });

  return runList(taskList).then(function () {
    var geojsonDoc = '],\n"bbox": ' + JSON.stringify(bbox) + '}';
    fs.writeSync(outFileID, geojsonDoc);
  });
};


module.exports = function (url, whereObj, primaryKeys, sourceInfo, options, outFileID) {
  /* Valid Options
   * 'sr': output SR
   */

  options = options || {};
  var geojsonHeader = '{"type": "FeatureCollection", "features": [';
  fs.writeSync(outFileID, geojsonHeader);
  return startQuery(url, whereObj, primaryKeys, sourceInfo, outFileID, options);
};
