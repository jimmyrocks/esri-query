/* eslint-env node, es6 */

const esriQuery = require('./src/esri-query');
const GeoJsonWriter = require('./src/fileWriter');

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
  name: 'output',
  alias: 'o',
  type: String,
  description: 'The file to write to'
},
{
  name: 'stdout',
  alias: 's',
  type: Boolean,
  description: 'Write to stdout (overrides dest)',
  defaultValue: false
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

var writer = new GeoJsonWriter(options.stdout ? undefined : options.output, {
  lineDelimited: options['line-delimited']
});

esriQuery(options.url, whereObj, returnFields, sourceInfo, queryOptions, writer)
  .then(function () {
    writer.close();
  })
  .catch(function (e) {
    console.error(e);
    throw new Error(e);
  });
