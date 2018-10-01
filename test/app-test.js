/* eslint-env node, es6 */

var App = require('../');

var test = function() {
  var reader = new App();
  var stream = reader.stream;

  stream.on('data', (chunk) => {
    process.stdout.write(chunk);
  });
  stream.on('end', (chunk) => {
    console.error('done');
  });

  reader.query('http://maps.pasda.psu.edu/arcgis/rest/services/pasda/CityPhillyWatersheds/MapServer/3', 'OBJECTID<=50').then(function() {
    console.log('----');
  }).catch(function(e) {
    console.log('Error', e);
  });

};

test();
