var crypto = require('crypto');
var esriQuery = require('./src/esri-query');
var fs = require('fs');
var writeGeoJson = require('./src/write-geojson');

var url = process.argv[2];
// var url = 'https://mapservices.nps.gov/arcgis/rest/services/NPS_Public_POIs/FeatureServer/0';
// var url = 'http://maps.pasda.psu.edu/arcgis/rest/services/pasda/CityPhillyWatersheds/MapServer/8';
var whereObj = {
  'where': '1=1',
  'returnGeometry': true,
  'outFields': '*',
  'outSR': '4326'
};
var returnFields = null; // [];
var sourceInfo = null;
var outFile = process.argv[3];
// var outFile = './pois.json';
// var outFile = './test.json';
var options = {
  'asGeoJSON': true
};

var outFileId = fs.openSync(outFile, 'a');

esriQuery(url, whereObj, returnFields, sourceInfo, options)
  .then(function (data) {
    writeGeoJson(data, outFileId);
  })
  .catch(function (e) {
    console.log(e);
    throw new Error(e);
  });
