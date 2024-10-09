import { arcgisToGeoJSON } from '@terraformer/arcgis';
import crypto from 'crypto';
import { CliOptionsType } from '..';
import post from '../helpers/post-async.js';
import * as ArcGIS from 'arcgis-rest-api';
import { EsriFeatureLayerType, EsriQueryObjectType } from '../helpers/esri-rest-types.js';

import Stdout from '../writers/Stdout.js';
import Gpkg from '../writers/Gpkg.js';
import File from '../writers/File.js';
import Writer from '../writers/Writer.js';
import GeographicQueryTool from './QueryMethods/GeographicQuery.js';
import PaginatedQueryTool from './QueryMethods/PaginatedQuery.js';

const MAX_ALLOWED_ERRORS = 10; //TODO: This should be a parameter

export type EsriFeatureType = {
  'geometry'?: ArcGIS.Geometry,
  'attributes'?: { [key: string]: string }
};

export default class EsriQuery {
  url: string;
  queryUrl: string;
  whereObj: EsriQueryObjectType;
  fields?: {
    [key: string]:
    EsriFeatureLayerType['fields'][0] &
    {
      sortable: boolean
    }
  };
  options: CliOptionsType;
  sourceInfo?: EsriFeatureLayerType;
  totalFeatureCount: number;
  runtimeParams: {
    hashList: Record<string, boolean>;
    featureCount: number;
    runTime: number;
  } = {
      featureCount: 0,
      hashList: {},
      runTime: 0
    };

  writer: Writer;

  constructor(options: CliOptionsType) {
    this.options = options;
    // Assign the url and queryUrl from 'options' to the current object (this)
    this.url = options.url;
    this.queryUrl = options.url.replace(/\/$/g, '') + '/query';

    // Create a 'whereObj' which is the Esri Rest params defined as EsriQueryObjectType
    this.whereObj = {
      'where': options.where,
      'returnGeometry': true,
      'outFields': '*',
      'outSR': '4326',
      'f': 'json'
    };
  }

  /**
   * Gets the source info for an Esri feature or map service
   * @returns A promise containing the Esri Feature Layer
   */
  async getSourceInfo() {
    // Fetch source info and feature count in parallel
    const [source, countResult] = await Promise.all([
      post(this.options.url, { f: 'json' }) as Promise<EsriFeatureLayerType>,
      post(this.queryUrl, { ...this.whereObj, returnCountOnly: true })
    ]);

    // Process fields
    this.fields = source.fields.reduce((acc, field) => {
      const sortable = field.type !== 'esriFieldTypeGeometry' && !field.name.includes('()');
      return { ...acc, [field.name]: { ...field, sortable } };
    }, {});

    // Update feature count
    this.options['feature-count'] = typeof this.options['feature-count'] === 'number'
      ? Math.min(this.options['feature-count'], source.maxRecordCount)
      : source.maxRecordCount;

    // Determine query format
    const jsonFormats = ['esriGeometryPoint', 'esriGeometryMultipoint'];
    const usePBF = source.supportedQueryFormats.includes('PBF') &&
      !jsonFormats.includes(source.geometryType);
    this.whereObj.f = this.options.json ? 'json' : (usePBF ? 'pbf' : 'json');

    // Set source info and total feature count
    this.sourceInfo = source;
    this.totalFeatureCount = (countResult as { count: number }).count;

    return this.sourceInfo;
  };

  /**
   * Initiates the querying process for the given data source and writes the results to a file or stdout.
   * @returns Promise that resolves to an object containing runtime parameters after the querying process is complete.
   * @throws Error if there is an issue reading source information.
   */
  async start(): Promise<typeof this.runtimeParams> {
    // Ensure necessary source information and fields are available
    if (!this.sourceInfo || !this.fields) {
      try {
        await this.getSourceInfo();
      } catch (e) {
        throw new Error(`Cannot read source info: ${this.url}\n${e.toString()}`);
      }
    }

    // Determine the appropriate writer type based on the output format
    let writerType: typeof Writer;
    if (!this.options.format) {
      this.options.format = (this.options.output && this.options.output.match(/\.gpkg$/))
        ? 'gpkg'
        : 'geojson';
    }

    switch (this.options.format) {
      case 'esrijson':
      case 'geojson':
      case 'geojsonseq':
        writerType = this.options.output ? File : Stdout;
        this.options['no-bbox'] = true;
        break;
      case 'gpkg':
        writerType = Gpkg;
        break;
      default:
        throw new Error(`Unsupported format: ${this.options}`);
    }

    // Create the writer instance and start the queries
    this.writer = new writerType(this.options, { ...this.sourceInfo, totalFeatureCount: this.totalFeatureCount });

    // Update runtime parameters and track the process time
    const startTime = new Date();

    try {
      this.writer.open();
      if (this.options.format === 'esrijson') {
        (this.writer as Stdout | File).writeString(JSON.stringify({
          "displayFieldName": this.sourceInfo.displayField,
          "geometryType": this.sourceInfo.geometryType,
          "spatialReference": {
            "wkid": 4326,
            "latestWkid": 4326
          },
          "fields": this.sourceInfo.fields,
          "features": []
        }).replace(/\]\}$/g, ''));
      }
      await this.startQuery();
    } finally {
      this.writer.close();
    }

    // Update runtime parameters to indicate the process is complete
    const endTime = new Date();
    const runTime = (endTime.valueOf() - startTime.valueOf()) / 1000;
    this.runtimeParams.runTime = runTime;
    this.options.progress && process.stderr.write(`\ntotalFeatureCount ${this.totalFeatureCount}\n`);

    return this.runtimeParams;
  }

  async write(
    features: Array<EsriFeatureType> | undefined,
  ): Promise<void> {
    const { options, writer, totalFeatureCount, runtimeParams } = this;
    if (!features) return;

    const convertGeometry = async (geometry: any): Promise<GeoJSON.Geometry | null> => {
      if (!geometry) return null;
      try {
        return arcgisToGeoJSON(geometry) as GeoJSON.Geometry;
      } catch (e) {
        console.error('Error converting geometry:', e);
        return null;
      }
    };

    const calculateHash = (geojson: GeoJSON.Feature): string => {
      return crypto.createHash('sha1').update(JSON.stringify(geojson)).digest('hex');
    };

    const isNewFeature = (hash: string): boolean => {
      if (runtimeParams.hashList[hash]) return false;
      runtimeParams.hashList[hash] = true;
      return true;
    };

    const writeFeature = (geojson: GeoJSON.Feature): void => {
      writer.writeFeature(geojson);
      runtimeParams.featureCount++;
    };

    const showProgress = (): void => {
      if (!options.progress) return;

      const { featureCount } = runtimeParams;
      const dotSplits = new Array(98).fill(0).map((_, i) => (i + 1) * Math.floor(this.totalFeatureCount / 100));
      const numSplits = new Array(9).fill(0).map((_, i) => (i + 1) * Math.floor(this.totalFeatureCount / 10));

      if (featureCount === 1) process.stderr.write('[0');
      if (dotSplits.indexOf(featureCount) > -1) process.stderr.write('.');
      if (numSplits.indexOf(featureCount) > -1) process.stderr.write((numSplits.indexOf(featureCount) + 1).toString());
      if (featureCount === this.totalFeatureCount) process.stderr.write('10]\n');
    };

    const convertAndWriteFeature = async (feature: EsriFeatureType): Promise<void> => {
      const geometry = await convertGeometry(feature.geometry);
      if (!geometry) return;

      const geojson: GeoJSON.Feature = {
        type: "Feature",
        properties: feature.attributes,
        geometry: geometry
      };

      const dbHash = calculateHash(geojson);
      if (isNewFeature(dbHash)) {
        writeFeature(geojson);
        showProgress();
      }
    };

    if (options.format === 'esrijson') {
      (writer as Stdout | File).writeString(JSON.stringify(features));
    } else {
      const conversionPromises = features.map(feature => convertAndWriteFeature(feature));
      await Promise.all(conversionPromises);
    }

    writer.save();
  }

  startQuery() {
    const getQueryToolClass = () => {
      switch (this.options.method) {
        case 'geographic': return GeographicQueryTool;
        default: return PaginatedQueryTool;
      }
    };

    const QueryTool = getQueryToolClass();

    return new Promise<void>((resolve, reject) => {
      const queryTool = new QueryTool({
        maxErrors: MAX_ALLOWED_ERRORS,
        maxFeaturesPerRequest: this.options['feature-count'],
        queryObjectBase: this.whereObj,
        baseUrl: new URL(this.url),
      });

      queryTool.on('data', (data: ArcGIS.Feature[]) => {
        this.write(data);
      });

      queryTool.on('message', (message: string | string[]) => {
        const formattedMessage = Array.isArray(message) ? message.join(' ') : message;
        if (this.options.progress) {
          process.stderr.write(formattedMessage);
        }
      });

      queryTool.on('done', resolve);
      queryTool.on('error', reject);

      queryTool.runQuery();
    });
  }
}