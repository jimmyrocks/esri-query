/* eslint-env node */
/* eslint-env es6 */
/* ArcGIS Source:
 */

const terraformer = require('@terraformer/arcgis').arcgisToGeoJSON;
const runList = require('../helpers/recursive-tasklist');
const crypto = require('crypto');
const splitBbox = require('../helpers/esri-split-bbox');
const post = require('../helpers/post-async');

var startQuery = function(sourceUrl, origQueryObj, primaryKeys, sourceInfo, writer, options) {
  if (sourceInfo) {
    return runQuery(sourceUrl, origQueryObj, primaryKeys, sourceInfo, options, writer);
  } else {
    return post(sourceUrl, {
      'f': 'json'
    }).then(function(source) {
      var fields = source.fields.filter(field => field.type !== 'esriFieldTypeGeometry' && field.name.indexOf('()') === -1).map(field => field.name);
      options['feature-count'] = options['feature-count'] || source.maxRecordCount;
      origQueryObj['f'] = origQueryObj['f'] || ((source.supportedQueryFormats.match('PBF') && options.pbf) ? 'pbf' : 'json');
      return runQuery(sourceUrl, origQueryObj, primaryKeys || fields, source, options, writer);
    }).catch(function(e) {
      return new Promise(function(f, r) {
        r(e);
      });
    });
  }
};

var expandBbox = function(newBox, origBox) {
  origBox = origBox || [Infinity, Infinity, -Infinity, -Infinity];
  origBox[0] = origBox[0] > newBox[0] ? newBox[0] : origBox[0];
  origBox[1] = origBox[1] > newBox[1] ? newBox[1] : origBox[1];
  origBox[2] = origBox[2] < newBox[2] ? newBox[2] : origBox[2];
  origBox[3] = origBox[3] < newBox[3] ? newBox[3] : origBox[3];
  return origBox;
};

var runQuery = function(sourceUrl, origQueryObj, primaryKeys, sourceInfo, options, writer) {
  // Returns the ESRI Output JSON
  var taskList = [];
  var bbox;
  var hashList = {};
  var errorCount = 0;

  var reduceQuery = function(sourceUrl, queryObj, primaryKeys, extent) {
    var newExtents = splitBbox(extent);
    // console.error('-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-');
    // console.error('Splitting: ', extent);
    // console.error('To: ', newExtents);
    // console.error('-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-');
    newExtents.forEach(function(newExtent) {
      taskList.push({
        'name': 'Query ' + JSON.stringify(newExtent),
        'description': 'Partial Extent Query',
        'task': queryServer,
        'params': [sourceUrl, queryObj, primaryKeys, newExtent]
      });
    });
  };

  var nextQuery = function(sourceUrl, queryObj, primaryKeys, split) {
    var newQuerys = [];
    if (!split) {
      newQuerys.push({
        'min': queryObj.resultOffset + options['feature-count'],
        'max': queryObj.resultOffset + options['feature-count'] + options['feature-count']
      });
    } else {
      // Cut the request in half
      console.error('splitting');
      newQuerys.push({
        'min': queryObj.resultOffset + options['feature-count'],
        'max': queryObj.resultOffset + options['feature-count'] + Math.floor(options['feature-count'] / 2)
      });
      newQuerys.push({
        'min': queryObj.resultOffset + options['feature-count'] + Math.floor(options['feature-count'] / 2),
        'max': queryObj.resultOffset + options['feature-count'] + options['feature-count']
      });

    }
    newQuerys.forEach(function(range) {
      taskList.push({
        'name': 'Query ' + JSON.stringify(range),
        'description': 'Partial Extent Query',
        'task': queryServer,
        'params': [sourceUrl, queryObj, primaryKeys, range]
      });
    });
  };

  var queryServer = function(sourceUrl, queryObj, primaryKeys, extent) {
    var newQueryObj = JSON.parse(JSON.stringify(queryObj));
    // Make it a query URL if it isn' already one
    sourceUrl = sourceUrl.replace(/query\??$/ig, '');
    sourceUrl = sourceUrl + (sourceUrl.substr(sourceUrl.length - 1) === '/' ? '' : '/') + 'query';

    // Get URL
    console.error('getting url', sourceUrl, newQueryObj, options);
    return options.method === 'geographic' ?
      runGeometryQuery(sourceUrl, newQueryObj, extent, primaryKeys) :
      runPaginatedQuery(sourceUrl, newQueryObj, extent, primaryKeys);
  };

  var runPaginatedQuery = function(sourceUrl, newQueryObj, extent, primaryKeys) {
    extent.min = extent.min === undefined ? 0 : extent.min;
    extent.max = extent.max === undefined ? options['feature-count'] : extent.max;

    newQueryObj.outFields = primaryKeys.join(',');
    newQueryObj.orderByFields = newQueryObj.outFields;
    newQueryObj.returnGeometry = true;
    newQueryObj.resultRecordCount = (extent.max - extent.min);
    newQueryObj.resultOffset = extent.min;
    // console.error('Getting url', sourceUrl, newQueryObj);

    return post(sourceUrl, newQueryObj).then(function(data) {
      return new Promise(function(resolve) {
         console.error('Got url!');
        //
        if (data.features && data.features.length === 0) {
          console.error('NO FEATURES LEFT');
          // No features in this query
          resolve(null);
        } else if (data.features) {
           console.error('features!', data.features.length);
          // Get next
          nextQuery(sourceUrl, newQueryObj, primaryKeys, false);
          errorCount--;
          writeOut(data); // TODO: transform it?
          resolve(null);
        } else if (data.error) {
          console.error('* ERROR with query  **********************************');
          console.error(data.error);
          console.error('* ERROR ************************************');
          errorCount--;
          nextQuery(sourceUrl, newQueryObj, primaryKeys, true);
          resolve(null);
        } else {
          // Not much else we can do? error? null?
          console.error('???????????????????????????');
          process.exit();
          resolve(null);
        }
      });
    }).catch(e => {
      return new Promise(function(resolve, reject) {
        // TODO, actually fail on 404s
        console.error('Error with request');
        console.error(e.status, e.code);
        if (e.code === 'ECONNRESET') {
          nextQuery(sourceUrl, newQueryObj, primaryKeys, true);
          resolve(null);
        } else if (e.status === 502 || e.status === 504) {
          // If we're getting a 502, wait
          errorCount = errorCount <= 0 ? 0 : errorCount;
          errorCount++;
          if (errorCount > 10) {
            console.error('Too many errors');
            console.error(e.status, e.code);
            reject(e);
          }
          setTimeout(function() {
            nextQuery(sourceUrl, newQueryObj, primaryKeys, true);
            resolve(null);
          }, 1500 * errorCount);
        } else {
          console.error('ending');
          reject(e);
        }
      });
    });
  };

  var runGeometryQuery = function(sourceUrl, newQueryObj, extent, primaryKeys) {
    // Add bounding box query
    newQueryObj.inSR = (extent && extent.spatialReference && extent.spatialReference.wkid) || newQueryObj.inSR || null;
    newQueryObj.geometry = extent ? [extent.xmin, extent.ymin, extent.xmax, extent.ymax].join(',') : null;
    newQueryObj.geometryType = 'esriGeometryEnvelope';
    newQueryObj.spatialRel = 'esriSpatialRelIntersects';

    // Check to see if we're going to go over the max limit
    newQueryObj.outFields = primaryKeys ? primaryKeys[0] : '';
    newQueryObj.returnGeometry = false;

    return post(sourceUrl, newQueryObj).then(function(data) {
      return new Promise(function(resolve) {
        console.error('prequery finished');
        if (data.exceededTransferLimit) {
          console.error('EXCEEDED', extent);
          reduceQuery(sourceUrl, newQueryObj, primaryKeys, extent);
          resolve(null);
        } else if (data.features && data.features.length === 0) {
          console.error('NO FEATURES LEFT');
          // No features in this query
          errorCount--;
          resolve(null);
        } else if (data.features) {
          console.error('Found Features', data && data.features && data.features.length);
          newQueryObj.outFields = origQueryObj.outFields || '*';
          newQueryObj.returnGeometry = origQueryObj.returnGeometry;
          // TODO: Add a parameter to set a max features that is less than the limit
          // if (data.features.length > 5000) {
          //   reduceQuery(sourceUrl, newQueryObj, primaryKeys, extent);
          //   resolve(null);
          // }
          return post(sourceUrl, newQueryObj).then(function(data) {
            // We got the data!
            if (data && data.error) {
              console.error('* ERROR getting features **********************************');
              console.error(data.error);
              console.error('* ERROR ************************************');
              reduceQuery(sourceUrl, newQueryObj, primaryKeys, extent);
              resolve(null);
            } else {
              errorCount--;
              writeOut(data); // TODO: transform it?
              resolve(null);
            }
          }).catch(function() {
            // There was some kind of error, check it, and maybe split bbox?
            reduceQuery(sourceUrl, newQueryObj, primaryKeys, extent);
            resolve(null);
          });
        } else if (data.error) {
          console.error('* ERROR with prequery  **********************************');
          console.error(data.error);
          console.error('* ERROR ************************************');
          newQueryObj.outFields = origQueryObj.outFields || '*';
          newQueryObj.returnGeometry = origQueryObj.returnGeometry;

          reduceQuery(sourceUrl, newQueryObj, primaryKeys, extent);
          resolve(null);
        } else {
          // Not much else we can do? error? null?
          console.error('???????????????????????????');
          process.exit();
          resolve(null);
        }
      });
    }).catch(function(e) {
      return new Promise(function(resolve, reject) {
        // TODO, actually fail on 404s
        console.error('Error with request');
        console.error(e.status, e.code);
        if (e.code === 'ECONNRESET') {
          reduceQuery(sourceUrl, newQueryObj, primaryKeys, extent);
          resolve(null);
        } else if (e.status === 502) {
          // If we're getting a 502, wait
          errorCount = errorCount <= 0 ? 0 : errorCount;
          errorCount++;
          if (errorCount > 10) {
            console.error('Too many errors');
            console.error(e.status, e.code);
            reject(e);
          }
          setTimeout(function() {
            reduceQuery(sourceUrl, newQueryObj, primaryKeys, extent);
            resolve(null);
          }, 1500 * errorCount);
        } else {
          reject(e);
        }
      });
    });
  };

  var writeOut = function(result) {
    if (result && result.features) {
      result.features.forEach(function(feature) {
        feature = feature || {};
        var geometry = null;
        try {
          if (feature.geometry) {
            geometry = terraformer(feature.geometry);
          }
        } catch (e) {
          console.error('error with geometry', e);
        }

        // Successfully parsed the geometry!
        if (geometry) {
          //bbox = expandBbox(geometry.bbox(), bbox);
          //console.log(geometry);
          //var subGeometry = geometry.toJSON();
          //if (!options['include-bbox']) {
          //  delete subGeometry.bbox;
          //}
          var dbGeometry = JSON.stringify(geometry, null, options.pretty ? 2 : 0);
          var dbProperties = JSON.stringify(feature.attributes, null, options.pretty ? 2 : 0);
          var geojsonDoc = `{"type": "Feature", "properties": ${dbProperties}, "geometry": ${dbGeometry}}`;
          var dbHash = crypto.createHash('md5').update(geojsonDoc).digest('hex');

          if (!hashList[dbHash]) {
            hashList[dbHash] = true;
            writer.writeLine(geojsonDoc);
          }
        }
      });
      writer.save();
    }
  };

  taskList.push({
    'name': 'First Query',
    'description': 'Starts off the query',
    'task': queryServer,
    'params': [sourceUrl, origQueryObj, primaryKeys, sourceInfo.extent]
  });

  return runList(taskList).then(function() {
    writer.writeFooter(bbox);
  });
};


module.exports = function(url, whereObj, primaryKeys, sourceInfo, options, writer) {
  /* Valid Options
   * 'sr': output SR
   */

  options = options || {};
  writer.writeHeader();
  return startQuery(url, whereObj, primaryKeys, sourceInfo, writer, options);
};
