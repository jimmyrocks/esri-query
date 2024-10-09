import { OptionDefinition } from "command-line-args";

const optionDefinitions: OptionDefinition[] = [
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
        description: '[gpkg, geojson, geojsonseq, esrijson]',
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
    {
        name: 'method',
        alias: 'm',
        type: String,
        description: 'Pagination method: Either geographic or default',
        defaultValue: 'default',
        group: 'base'
    },
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

export default optionDefinitions;