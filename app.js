/* eslint-env node, es6 */

const esriQuery = require('./src/esri-query');
const GeoJsonWriter = require('./src/geojsonWriter');

var streamRest = function (url, query, writer) {
  var whereObj = {
    'where': query || '1=1',
    'returnGeometry': true,
    'outFields': '*',
    'outSR': '4326'
  };
  var returnFields = null; // [];
  var sourceInfo = null;
  var options = {
    'asGeoJSON': true
  };

  return esriQuery(url, whereObj, returnFields, sourceInfo, options, writer)
    .then(function () {
      writer.close();
      return writer;
    })
    .catch(function (e) {
      writer.close();
      return e;
    });
};

module.exports = function () {
  var writer = new GeoJsonWriter({
    'type': 'stdout',
    'stream': true
  });


  return {
    'stream': writer.stream,
    'query': function (url, query) {
      return streamRest(url, query, writer);
    }
  };
};
