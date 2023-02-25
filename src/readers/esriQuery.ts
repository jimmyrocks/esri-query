import { arcgisToGeoJSON as terraformer } from '@terraformer/arcgis';
import crypto from 'crypto';
import { CliOptionsType } from '..';
import post from '../helpers/post-async.js';
import * as ArcGIS from 'arcgis-rest-api';
import { EsriFeatureLayerType, EsriQueryObjectType } from '../helpers/esri-rest-types.js';

import Stdout from '../writers/Stdout.js';
import Gpkg from '../writers/Gpkg.js';
import File from '../writers/File.js';
import Writer from '../writers/Writer.js';

type EsriFeatureType = {
  'geometry'?: ArcGIS.Geometry,
  'attributes'?: { [key: string]: string }
};

interface QueryRange {
  min: number;
  max: number;
  goNext: boolean;
}

interface TaskListItem {
  name: string;
  description: string;
  task: () => Promise<void>;
  params: any[];
}

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
    taskList: Array<TaskListItem>,
    errorCount: number,
    hashList: { [key: string]: boolean },
    featureCount: number,
    runTime: number
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

    // Create runtime Params for this query so we can keep track of various tasks
    this.runtimeParams = {
      status: 'not started',
      taskList: [],
      errorCount: 0,
      hashList: {},
      featureCount: 0,
      runTime: 0
    }
  }

  /**
   * Gets the source info for an Esri feature or map service
   * @returns A promise containing the Esri Feature Layer
   */
  async getSourceInfo() {
    // Make a post request for the source info
    const source = await post(this.options.url, {
      f: 'json'
    }) as EsriFeatureLayerType;

    // Make a second request for the feature count
    const countQuery = JSON.parse(JSON.stringify(this.whereObj));
    countQuery.returnCountOnly = true;
    const countJsonPromise = post(this.queryUrl, countQuery);

    // Get all fields that aren't the geometry type
    // Add a "sortable" property, since some fields (geometries) are not sortable
    // Reduce the array into key/value pairs
    this.fields = (source.fields)
      .map((field: typeof this.fields[0]) => {
        field.sortable = field.type !== 'esriFieldTypeGeometry' && field.name.indexOf('()') === -1;
        return field;
      }).reduce((a, c) => ({ ...a, ...{ [c.name]: c } }), {});

    // Update the feature count for whichever is less, the user specified value or the maxRecordCount
    this.options['feature-count'] = (typeof this.options['feature-count'] === 'number') ?
      Math.min(this.options['feature-count'] || source.maxRecordCount) :
      source.maxRecordCount;

    // Use JSON if the user requests it, or if PBF is not available
    this.whereObj.f = this.options.json ? 'json' : (source.supportedQueryFormats.match('PBF') ? 'pbf' : 'json');

    // Move this source into the sourceInfo variable
    this.sourceInfo = source;

    // Wait for the countJsonPromise to complete and get the feature count
    this.totalFeatureCount = ((await countJsonPromise) as { 'count': number }).count;

    return this.sourceInfo;

  };

  /**
   * Initiates the querying process for the given data source and writes the results to a file or stdout.
   * @returns Promise that resolves to an object containing runtime parameters after the querying process is complete.
   * @throws Error if there is an issue reading source information.
   */
  async start(): Promise<EsriQuery['runtimeParams']> {
    // Make sure we have necessary source information and fields
    // If now we need to fetch them
    if (!this.sourceInfo || !this.fields) {
      try {
        await this.getSourceInfo();
      } catch (e) {
        throw new Error(`Cannot read source info: ${this.url}
        ${e.toString()}`);
      }
    }

    let writerType: typeof Writer;
    // Determine the appropriate writer type based on output format
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

    // Create the writer instance and start the queries
    this.writer = new writerType(this.options, this.sourceInfo);

    this.nextQuery(0, false); // Start the queries (at offset 0)
    this.runtimeParams.status = 'running';
    const startTime = new Date();
    this.writer.open();
    await this.runTaskList();
    this.writer.close();

    // Update the runtimeParams to say that this process is done
    this.runtimeParams.status = 'done';
    const endTime = new Date();
    this.runtimeParams.runTime = (endTime.valueOf() - startTime.valueOf()) / 1000;
    return this.runtimeParams;
  }

  /**
   * Writes features to a GeoJSON file.
   *
   * @param result - The result to write to the file.
   * @returns void.
   */
  write(result?: { features?: Array<EsriFeatureType> }): void {
    if (result && result.features) {
      result.features.forEach((feature => {
        feature = feature || {};
        let geometry = null;
        try {
          // Convert Esri geometry to GeoJSON geometry
          if (feature.geometry) {
            geometry = terraformer(feature.geometry) as GeoJSON.Geometry;
          }
        } catch (e) {
          console.error('error with geometry', e);
        }

        // Successfully parsed the geometry!
        if (geometry) {

          // Create a GeoJSON feature
          const geojson = {
            type: "Feature",
            properties: feature.attributes,
            geometry: geometry
          } as GeoJSON.Feature;

          // Calculate the SHA1 hash of the GeoJSON feature
          // This is used to prevent duplicates
          var dbHash = crypto.createHash('sha1').update(JSON.stringify(geojson)).digest('hex');

          // If the hash has not been used before, write the feature to file
          if (!this.runtimeParams.hashList[dbHash]) {
            this.runtimeParams.hashList[dbHash] = true;
            this.writer.writeFeature(geojson);
            this.runtimeParams.featureCount++;

            // Write out the progress to stderr if the progress option is selectedd
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

      // Save the GeoJSON file  
      this.writer.save();
    }
  }

  async paginatedQuery(records: { min: number, max: number, goNext: boolean }): Promise<void> {

    // Create a copy of the original `whereObj`, this allows us to make changes without changing the original obj
    const newQueryObj = JSON.parse(JSON.stringify(this.whereObj)) as EsriQueryObjectType;

    // 
    newQueryObj.outFields = Object.keys(this.fields).filter(name => this.fields[name].sortable).join(',');
    // Order by every field that is sortable (this is a workaround where some version of ArcGIS will produce a different order for each page)
    newQueryObj.orderByFields = newQueryObj.outFields;
    // We are interested in the geometry!
    newQueryObj.returnGeometry = true;
    // 
    newQueryObj.resultRecordCount = (records.max - records.min);
    newQueryObj.resultOffset = records.min;

    try {
      const data = await post(this.queryUrl, newQueryObj) as { features?: Array<EsriFeatureType>, error: string };

      if (data.features && data.features.length === 0) {
        // No features returned by this query
        return null;
      } else if (data.features) {
        // We found some features

        // Get the next page if requested (we don't request the next page for split queries)
        if (records.goNext) {
          this.nextQuery(newQueryObj.resultOffset + data.features.length, false);
        }

        // This did not return an error, so subtract the errors from the error list
        this.runtimeParams.errorCount--;

        // Use the writer to write data
        this.write(data);
        return null;
      } else if (data.error) {

        // The server returned an error, this is different than a server error, so we still substract the errors
        this.runtimeParams.errorCount--;

        // Split the result into multiple requests and try again
        this.nextQuery(newQueryObj.resultOffset, true);
        return null;
      } else {
        throw new Error('No features and no error');
      }

    } catch (e) {
      console.error('Error with request: ', newQueryObj);
      console.error(e.status, e.code, e);

      // If the connection was reset, we can just try again
      if (e.code === 'ECONNRESET') {
        this.nextQuery(newQueryObj.resultOffset, true);
        return null;
      } else if (e.status === 502 || e.status === 504) {
        // If we're getting a 502 (Bad Gateway) or a 504(Gateway Timeout) error from the server
        // that (probably) means that the server is too busy for our request
        // So increment the amount of errors and wait for the server to free up
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
        // There was some other error
        console.error('Process ending with error', e);
        if (e instanceof Error) {
          throw e;
        } else {
          throw new Error(e);
        }
      }
    };
  };

  /**
  * Splits the query into multiple partial extent queries based on the feature - count option.
  * @param { number } offset - Offset value for the query.
  * @param { boolean } split - Flag to indicate if the query should be split into multiple queries.
  * @returns { void}
  */
  nextQuery(offset: number, split: boolean = false): void {
    const newQueries: QueryRange[] = [];
    const featureCount = this.options['feature-count'];

    if (!split) {
      newQueries.push({
        'min': offset,
        'max': offset + featureCount,
        'goNext': true
      });
    } else {
      // Split the request in half
      console.error('splitting');
      newQueries.push({
        'min': offset,
        'max': offset + Math.floor(featureCount / 2),
        'goNext': false
      });
      newQueries.push({
        'min': offset + Math.floor(featureCount / 2),
        'max': offset + featureCount,
        'goNext': true
      });
    }

    newQueries.forEach(range => {
      this.runtimeParams.taskList.push({
        'name': 'Query ' + JSON.stringify(range),
        'description': 'Partial Extent Query',
        'task': this.paginatedQuery.bind(this),
        'params': [range]
      } as TaskListItem);
    });
  }

  /**
   * Runs the list of tasks in the task list sequentially, by:
   * 1. shifting the next task from the list,
   * 2. running it
   * 3. calling itself recursively until the list is empty.
   * @returns A Promise that resolves to void.
   */
  async runTaskList(): Promise<void> {
    // Get the next task in the list
    const nextTask = this.runtimeParams.taskList.shift();
    try {
      // Apply the task function with the `this` object and its parameters
      await nextTask.task.apply(this, nextTask.params);
      // If there are more tasks in the list, call this function recursively
      if (this.runtimeParams.taskList.length) {
        return await this.runTaskList();
      } else {
        return null;
      }
    } catch (e) {
      // Detect if the error is of an error type, and throw it
      if (e instanceof Error) {
        throw e;
      } else {
        throw new Error(e);
      }
    }
  };
}