/* eslint-env node, es6 */

var App = require('../');

var test = function () {
  var writer = new App();
  var stream = writer.stream;

  stream.on('data', (chunk) => {
    process.stdout.write(chunk);
  });
  stream.on('end', () => {
    console.error('done');
  });

  writer.query('http://maps.pasda.psu.edu/arcgis/rest/services/pasda/CityPhillyWatersheds/MapServer/3', 'OBJECTID<=50').then(function () {
    console.error('----');
  }).catch(function (e) {
    console.error('Error', e);
  });
};

test();
