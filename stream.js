/* eslint-env node, es6 */

const esriQuery = require('./src/esri-query');
const GeoJsonWriter = require('./src/fileWriter');

var url = process.argv[2];
var whereObj = {
  'where': '1=1',
  'returnGeometry': true,
  'outFields': '*',
  'outSR': '4326'
};
var returnFields = null; // [];
var sourceInfo = null;
var outFile = process.argv[3];
var options = {
  'asGeoJSON': true
};

var writer = new GeoJsonWriter(outFile);

esriQuery(url, whereObj, returnFields, sourceInfo, options, writer)
  .then(function () {
    writer.close();
  })
  .catch(function (e) {
    console.error(e);
    throw new Error(e);
  });
