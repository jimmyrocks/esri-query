import { arcgisToGeoJSON as terraformer } from '@terraformer/arcgis';
import { default as crypto } from 'crypto';
import { CliOptionsType } from '..';
import post from '../helpers/post-async.js';
import * as ArcGIS from 'arcgis-rest-api';
import { EsriFeatureLayerType, EsriQueryObjectType } from '../helpers/esri-rest-types.js';

import Stdout from '../writers/Stdout.js';
import Gpkg from '../writers/Gpkg.js';
import File from '../writers/File.js';

type EsriFeatureType = {
  'geometry'?: ArcGIS.Geometry,
  'attributes'?: { [key: string]: string }
};

type TaskListType = {
  'name': string,
  'description': string,
  'task': Function,
  'params': Array<any>
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
    status: 'running' | 'done' | 'not started',
    taskList: Array<TaskListType>,
    errorCount: number,
    hashList: { [key: string]: boolean },
    featureCount: number,
    runTime: number
  };

  writer: Stdout | File | Gpkg;

  constructor(options: CliOptionsType) {
    this.options = options;
    this.url = options.url;
    this.queryUrl = options.url.replace(/\/$/g, '') + '/query';

    this.whereObj = {
      'where': options.where,
      'returnGeometry': true,
      'outFields': '*',
      'outSR': '4326',
      'f': 'json'
    };

    this.runtimeParams = {
      status: 'not started',
      taskList: [],
      errorCount: 0,
      hashList: {},
      featureCount: 0,
      runTime: 0
    }
  }

  async getSourceInfo() {
    const source = await post(this.options.url, {
      f: 'json'
    }) as EsriFeatureLayerType;

    const countQuery = JSON.parse(JSON.stringify(this.whereObj));
    countQuery.returnCountOnly = true;
    const countJsonPromise = post(this.queryUrl, countQuery);

    // Get all fields that aren't the geometry type
    this.fields = (source.fields)
      .map((field: typeof this.fields[0]) => {
        field.sortable = field.type !== 'esriFieldTypeGeometry' && field.name.indexOf('()') === -1;
        return field;
      }).reduce((a, c) => ({ ...a, ...{ [c.name]: c } }), {});

    // Update the feature count for whichever is less
    this.options['feature-count'] = (typeof this.options['feature-count'] === 'number') ?
      Math.min(this.options['feature-count'] || source.maxRecordCount) :
      source.maxRecordCount;

    // Use JSON if the user requests it, or if PBF is not available
    this.whereObj.f = this.options.json ? 'json' : (source.supportedQueryFormats.match('PBF') ? 'pbf' : 'json');

    // Move this source into the sourceInfo variable
    this.sourceInfo = source;
    this.totalFeatureCount = ((await countJsonPromise) as { 'count': number }).count;

    return this.sourceInfo;

  };

  async start() {
    if (!this.sourceInfo || !this.fields) {
      // First we need to get information about this source, so we need to post to it
      try {
        await this.getSourceInfo();
      } catch (e) {
        throw new Error(`Cannot read source info: ${this.url}
        ${e.toString()}`);
      }
    }

    let writerType;
    // If there's no format specifed, assume Geojson, unless the output file ends in .gpkg
    if (!this.options.format) {
      this.options.format = (this.options.output && this.options.output.match(/\.gpkg$/))
        ? 'gpkg'
        : 'geojson';
    }

    if (this.options.format === 'geojson' || this.options.format === 'geojsonseq') {
      writerType = this.options.output ? File : Stdout;
    } else if (this.options.format === 'gpkg') {
      writerType = Gpkg;
    }

    this.writer = new writerType(this.options, this.sourceInfo);

    this.nextQuery(0, false);
    this.runtimeParams.status = 'running';
    const startTime = new Date();
    this.writer.open();
    await this.runList();
    this.writer.close();
    this.runtimeParams.status = 'done';
    const endTime = new Date();
    this.runtimeParams.runTime = (endTime.valueOf() - startTime.valueOf()) / 1000;
    return this.runtimeParams;
  }


  write(result?: { features?: Array<EsriFeatureType> }) {
    if (result && result.features) {
      result.features.forEach((feature => {
        feature = feature || {};
        let geometry = null;
        try {
          if (feature.geometry) {
            geometry = terraformer(feature.geometry) as GeoJSON.Geometry;
          }
        } catch (e) {
          console.error('error with geometry', e);
        }

        // Successfully parsed the geometry!
        if (geometry) {

          const geojson = {
            type: "Feature",
            properties: feature.attributes,
            geometry: geometry
          } as GeoJSON.Feature;

          var dbHash = crypto.createHash('sha1').update(JSON.stringify(geojson)).digest('hex');

          if (!this.runtimeParams.hashList[dbHash]) {
            this.runtimeParams.hashList[dbHash] = true;
            this.writer.writeFeature(geojson);
            this.runtimeParams.featureCount++;

            // Write out the progress
            if (this.options.progress) {
              const featureCount = this.runtimeParams.featureCount;
              const dotSplits = new Array(98).fill(0).map((_, i) => (i + 1) * Math.floor(this.totalFeatureCount / 100));
              const numSplits = new Array(9).fill(0).map((_, i) => (i + 1) * Math.floor(this.totalFeatureCount / 10));

              if (featureCount === 1) process.stderr.write('[0');
              if (dotSplits.indexOf(featureCount) > -1) process.stderr.write('.');
              if (numSplits.indexOf(featureCount) > -1) process.stderr.write((numSplits.indexOf(featureCount) + 1).toString());
              if (featureCount === this.totalFeatureCount) process.stderr.write('10]\n');
            }
          }
        }
      }));
      this.writer.save();
    }
  }

  async paginatedQuery(extent: { min: number, max: number, goNext: boolean }): Promise<void> {

    const newQueryObj = JSON.parse(JSON.stringify(this.whereObj)) as EsriQueryObjectType;

    newQueryObj.outFields = Object.keys(this.fields).filter(name => this.fields[name].sortable).join(',');
    newQueryObj.orderByFields = newQueryObj.outFields;
    newQueryObj.returnGeometry = true;
    newQueryObj.resultRecordCount = (extent.max - extent.min);
    newQueryObj.resultOffset = extent.min;

    try {
      const data = await post(this.queryUrl, newQueryObj) as { features?: Array<EsriFeatureType>, error: string };

      if (data.features && data.features.length === 0) {
        //console.error('NO FEATURES LEFT');
        // No features in this query
        return null;
      } else if (data.features) {
        //console.error('features!', data.features.length);
        // Get next
        if (extent.goNext) {
          this.nextQuery(newQueryObj.resultOffset + data.features.length, false);
        }
        this.runtimeParams.errorCount--;
        this.write(data); // TODO: transform it?
        return null;
      } else if (data.error) {
        console.error('* ERROR with query  **********************************');
        console.error(data.error);
        console.error('* ERROR ************************************');
        this.runtimeParams.errorCount--;
        this.nextQuery(newQueryObj.resultOffset, true);
        return null;
      } else {
        // Not much else we can do? error? null?
        console.error('???????????????????????????');
        //process.exit();
        throw new Error('No features and no error');
      }

    } catch (e) {
      // TODO, actually fail on 404s
      console.error('Error with request');
      console.error(e.status, e.code, e);
      if (e.code === 'ECONNRESET') {
        this.nextQuery(newQueryObj.resultOffset, true);
        return null;
      } else if (e.status === 502 || e.status === 504) {
        // If we're getting a 502, wait
        this.runtimeParams.errorCount = this.runtimeParams.errorCount <= 0 ? 0 : this.runtimeParams.errorCount;
        this.runtimeParams.errorCount++;
        if (this.runtimeParams.errorCount > 10) {
          console.error('Too many errors');
          console.error(e.status, e.code);
          throw new Error(e);
        }

        setTimeout(function () {
          this.nextQuery(newQueryObj.resultOffset, true);
          return null;
        }, 1500 * this.runtimeParams.errorCount);

      } else {
        console.error('ending with error', e);
        if (e instanceof Error) {
          throw e;
        } else {
          throw new Error(e);
        }
      }
    };
  };

  nextQuery(offset: number, split: boolean = false) {
    const newQuerys = [];
    const featureCount = this.options['feature-count'];
    if (!split) {
      newQuerys.push({
        'min': offset,
        'max': offset + featureCount,
        'goNext': true
      });
    } else {
      // Cut the request in half
      console.error('splitting');
      newQuerys.push({
        'min': offset,
        'max': offset + Math.floor(featureCount / 2),
        'goNext': false
      });
      newQuerys.push({
        'min': offset + Math.floor(featureCount / 2),
        'max': offset + featureCount,
        'goNext': true
      });
    }

    newQuerys.forEach(range => {
      this.runtimeParams.taskList.push({
        'name': 'Query ' + JSON.stringify(range),
        'description': 'Partial Extent Query',
        'task': this.paginatedQuery.bind(this),
        'params': [range]
      });
    });
  }

  async runList(): Promise<void> {
    const nextTask = this.runtimeParams.taskList.shift();
    try {
      await nextTask.task.apply(this, nextTask.params);
      if (this.runtimeParams.taskList.length) {
        return await this.runList();
      } else {
        return null;
      }
    } catch (e) {
      if (e instanceof Error) {
        throw e;
      } else {
        throw new Error(e);
      }
    }
  };
}
