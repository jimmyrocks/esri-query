var esriQuery = require('./src/esri-query');
var fs = require('fs');
var crypto = require('crypto');

var url = 'https://mapservices.nps.gov/arcgis/rest/services/NPS_Public_Trails_Geographic/FeatureServer/0';
// var url = 'http://maps.pasda.psu.edu/arcgis/rest/services/pasda/CityPhillyWatersheds/MapServer/8';
var whereObj = {
  'where': '1=1',
  'returnGeometry': true,
  'outFields': '*',
  'outSRS': '4326'
};
var returnFields = null; // [];
var sourceInfo = null;
var outFile = './trails2.json';
// var outFile = './test.json';
var options = {
  'asGeoJSON': true
};

var outFileId = fs.openSync(outFile, 'a');

esriQuery(url, whereObj, returnFields, sourceInfo, options)
  .then(function (data) {
    var geojsonDoc = '{\n' +
      '"type": "FeatureCollection",\n' +
      '"features": [';
    fs.writeSync(outFileId, geojsonDoc);

    var bbox;
    var row, r;
    var hashes = {};
    var hash;

    for (var i = 0; i < data.length; i++) {
      r = JSON.stringify(data[i]);
      row = JSON.parse(r);
      hash = crypto.createHash('md5').update(r).digest('hex');
      if (!hashes[hash]) {
        hashes[hash] = true;
        if (bbox) {
          bbox[0] = bbox[0] > row.bbox[0] ? row.bbox[0] : bbox[0];
          bbox[1] = bbox[1] > row.bbox[1] ? row.bbox[1] : bbox[1];
          bbox[2] = bbox[2] < row.bbox[2] ? row.bbox[2] : bbox[2];
          bbox[3] = bbox[3] < row.bbox[3] ? row.bbox[3] : bbox[3];
        } else {
          bbox = row.bbox;
        }

        delete row.bbox;
        if (row.geometry) {
          delete row.geometry.bbox;
        }

        row = JSON.stringify(row);
        /*
         */
        geojsonDoc = row + (i < (data.length - 1) ? ',\n' : '');
        fs.writeSync(outFileId, geojsonDoc);
      }
      // console.log('add row ' + i + ' of ' + data.length);
      // geojsonDoc.features.push(row);
      // console.log('row', row);
    }
    geojsonDoc = '],\n"bbox": ' + JSON.stringify(bbox) + '}';
    fs.writeSync(outFileId, geojsonDoc);
    fs.closeSync(outFileId);

    // fs.writeFileSync(outFile, geojsonDoc);
    // console.log(geojsonDoc);
    console.log('Features written: ' + data.length);
  })
  .catch(function (e) {
    console.log(e);
    throw new Error(e);
  });
