/* eslint-env node, es6 */

const esriQuery = require('./src/readers/esriRest');
const GeoJsonWriter = require('./src/geojsonWriter');

// CLI
const commandLineArgs = require('command-line-args');
const commandLineUsage = require('command-line-usage');

const optionDefinitions = [{
  name: 'help',
  alias: 'h',
  type: Boolean,
  description: 'Display this usage guide.'
},
{
  name: 'url',
  alias: 'u',
  type: String,
  multiple: false,
  description: 'The URL of the ESRI Rest Endpoint. (ex. https://.../FeatureServer/0)',
  typeLabel: '<url>',
  defaultOption: true
},
{
  name: 'query',
  alias: 'q',
  type: String,
  description: 'ESRI Style Where',
  defaultValue: '1=1'
},
{
  name: 'type',
  alias: 't',
  type: String,
  description: '[file, stdout]',
  defaultValue: 'stdout'
},
{
  name: 'output',
  alias: 'o',
  type: String,
  description: 'The file to write out (if set, type becomes file)'
},
{
  name: 'line-delimited',
  alias: 'l',
  type: Boolean,
  description: 'Drop the header and delimit each line with a newline (for streaming)',
  defaultValue: false
},
{
  name: 'pretty',
  alias: 'p',
  type: Boolean,
  description: 'Pretty Print JSON (line-delimited will override this)',
  defaultValue: false
},
{
  name: 'include-bbox',
  alias: 'b',
  type: Boolean,
  description: 'Add a bbox for each entry',
  defaultValue: false
},
{
  name: 'connection-string',
  alias: 'c',
  type: String,
  description: 'The database connection string (ex. postgresql://dbuser:secretpassword@database.server.com:3211/mydb)',
  defaultValue: null
}


];

const options = commandLineArgs(optionDefinitions);
const usage = commandLineUsage([{
  'header': 'esri-dump stream',
  'content': 'Stream ESRI REST Endpoints to GeoJSON'
}, {
  'header': 'Options',
  'optionList': optionDefinitions
}]);

if (options.help) {
  console.log(usage);
  process.exit();
}

var whereObj = {
  'where': options.query,
  'returnGeometry': true,
  'outFields': '*',
  'outSR': '4326'
};

// Not sure if we're going to do anything with these
var returnFields = null; // [];
var sourceInfo = null;

var queryOptions = {
  'asGeoJSON': true,
  'pretty':  options['pretty'] && !options['line-delimited'] // Can't have a pretty line delimited file
};

var writer = new GeoJsonWriter(options);

esriQuery(options.url, whereObj, returnFields, sourceInfo, queryOptions, writer)
  .then(function () {
    writer.close();
    writer.promise.then(function(){
      //Done()
    });
  })
  .catch(function (e) {
    console.error('error:', e);
  });
