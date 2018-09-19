/*eslint-env es6*/
/*eslint-env node*/

const fs = require('fs');

var writeGeoJson = function (data, outFileId) {
  var geojsonDoc = '{\n' +
    '"type": "FeatureCollection",\n' +
    '"features": [';
  fs.writeSync(outFileId, geojsonDoc);

  var features = 0;
  data.db.each('SELECT max("geometry") AS "geometry", max("properties") AS "properties" FROM cache GROUP BY "hash"', function (error, row) {
  // data.db.each('SELECT * FROM cache', function (error, row) {
    var record = `{"type": "Feature", "properties": ${row.properties}, "geometry": ${row.geometry}}`;
    if (!error) {
      geojsonDoc = (features > 0 ? ',\n' : '') + record;
      features++;
      fs.writeSync(outFileId, geojsonDoc);
    }
  },
  function () {
    geojsonDoc = '],\n"bbox": ' + JSON.stringify(data.bbox) + '}';
    fs.writeSync(outFileId, geojsonDoc);
    fs.closeSync(outFileId);
    data.db.close();

    // console.log(geojsonDoc);
    console.log('Features written: ' + features);
    //TODO maybe return a promise here?

  });
};

module.exports = writeGeoJson;
