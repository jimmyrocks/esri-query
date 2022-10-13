import EsriQuery from './readers/esriQuery.js';

// CLI
import { default as commandLineArgs } from 'command-line-args';
import { default as commandLineUsage } from 'command-line-usage';

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

export type CliOptionsType = CliBaseOptionsType & (CliGeoJsonOptionsType | CliSqlOptionsType)

const optionDefinitions = [
  {
    name: 'help',
    alias: 'h',
    type: Boolean,
    description: 'Display this usage guide.',
    group: 'base'
  },
  {
    name: 'url',
    alias: 'u',
    type: String,
    multiple: false,
    description: 'The URL of the ESRI Rest Endpoint. (ex. https://.../FeatureServer/0)',
    typeLabel: '<url>',
    defaultOption: true,
    group: 'base'
  },
  {
    name: 'where',
    alias: 'w',
    type: String,
    description: 'ESRI Style Where',
    defaultValue: '1=1',
    group: 'base'
  },
  {
    name: 'format',
    alias: 'f',
    type: String,
    description: '[gpkg, geojson, geojsonseq]',
    group: 'base'
  },
  {
    name: 'output',
    alias: 'o',
    type: String,
    description: 'The output file. If not specified, and type is Geojson, it will go to stdout',
    group: 'base'
  },
  {
    name: 'pretty',
    alias: 'y',
    type: Boolean,
    description: 'Pretty Print JSON (line-delimited will override this)',
    defaultValue: false,
    group: 'geojson'
  },
  /*{
    name: 'method',
    alias: 'm',
    type: String,
    description: 'Pagination method: Either geographic or default',
    defaultValue: 'default',
    group: 'base'
  },*/
  {
    name: 'feature-count',
    alias: 'c',
    type: Number,
    description: 'Features per query (Default is server default)',
    group: 'base'//,
    //defaultValue: null
  },
  {
    name: 'json',
    alias: 'j',
    type: Boolean,
    description: 'Use ESRI json to download data (otherwise it will try to use the esri PBF format)',
    defaultValue: false,
    group: 'base'
  },
  {
    name: 'progress',
    alias: 'p',
    type: Boolean,
    description: 'Show progress during the process',
    defaultValue: false,
    group: 'base'
  },
  {
    name: 'layer-name',
    alias: 'l',
    type: String,
    description: 'For GPKG files, specifies the layer-name, if unset, it will use the filename',
    defaultValue: false,
    group: 'gpkg'
  },
  {
    name: 'no-bbox',
    alias: 'b',
    type: Boolean,
    description: 'Does not calculate a bbox for each feature. (Bboxs are slower to generate, but may speed up calculations on the resulting file)',
    defaultValue: false,
    group: 'base'
  }
].sort((a, b) => a.alias.localeCompare(b.alias));

const sections = [
  {
    'header': 'esri-query',
    'content': 'Extract data from ESRI REST Endpoints to GeoJSON or GPKG'
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

const options = commandLineArgs(optionDefinitions)._all as CliOptionsType;
const usage = commandLineUsage(sections);

if (options.help) {
  console.log(usage);
  process.exit();
} else {
  const Query = new EsriQuery(options);
  Query.start()
    .then((result: EsriQuery['runtimeParams']) => {
      if (options.progress) {
        console.error(`Complete with: ${result.featureCount} features in ${result.runTime} seconds`);
      }
    })
    .catch(console.error);
}
