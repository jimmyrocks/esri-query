var esriRest = require('./esri-rest');

esriRest('https://mapservices.nps.gov/arcgis/rest/services/NPS_Public_Trails/FeatureServer/0', {'WHERE': 'REGIONCODE=\'IMR\'', 'outSR': '4326'}, null, null, {'asGeoJSON': true}).then(function(d){
  console.log('done---------------------------------------');
  console.log(d.length);
  console.log('done---------------------------------------');
}).catch(function(e) {
  console.log('error---------------------------------------');
  console.log(e);
  console.log('error---------------------------------------');
});
