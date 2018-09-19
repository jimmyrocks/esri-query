var fs = require('fs');

var writeGeoJson = function (data, outFileId) {
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
};

module.exports = writeGeoJson;
