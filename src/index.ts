import EsriQuery from './readers/esriQuery.js';

// Tools to create the Command Line Interface
import { default as commandLineArgs } from 'command-line-args';
import { default as commandLineUsage } from 'command-line-usage';
import { default as optionDefinitions } from './options.js';

export type CliBaseOptionsType = {
  help: Boolean,
  url: string,
  where: string,
  output: string,
  method: 'geographic' | 'default',
  'feature-count': number,
  json: boolean,
  progress: boolean,
  'no-bbox': boolean
};

export type CliGeoJsonOptionsType = {
  format: 'geojson' | 'geojsonseq',
  pretty: boolean,
};

export type CliSqlOptionsType = {
  format: 'gpkg',
  output: string,
  'layer-name': string
};

export type CliOptionsType = Partial<CliBaseOptionsType & (CliGeoJsonOptionsType | CliSqlOptionsType)>;

const sections = [
  {
    header: 'esri-query',
    content: 'Extract data from ESRI REST Endpoints to GeoJSON or GPKG'
  },
  {
    header: 'ESRI Rest Options',
    optionList: optionDefinitions,
    group: ['base']
  },
  {
    header: 'GeoJSON Options',
    optionList: optionDefinitions,
    group: 'geojson'
  },
  {
    header: 'GeoPackage Options',
    optionList: optionDefinitions,
    group: 'gpkg'
  }
]

let options: CliOptionsType = {};
const usage = commandLineUsage(sections);

try {
  options = commandLineArgs(optionDefinitions)._all as CliOptionsType;
} catch (e) {
  options.help = true;
  let [_, __, ...args] = process.argv;
  console.log('Unknown CLI Usage: ', ...args);
}

// If the user selects `help`, print the usage and exit the application
if (options.help) {
  console.log(usage);
  process.exit();
} else {
  // Otherwise, create a new instance of `EsriQuery` with the specified options.
  const Query = new EsriQuery(options);

  // Start the query and wait for the result.
  Query.start()
    .then((result: EsriQuery['runtimeParams']) => {
      // If the `progress` option is specified, report the progress (feature count and total run time) to stderr.
      if (options.progress) {
        console.error(`Complete with: ${result.featureCount} features in ${result.runTime} seconds`);
      }
    })
    // If there's an error, write it out to stderr
    .catch(console.error);
}