import { describe, expect, test } from '@jest/globals';
import { CliOptionsType } from '../src/index.js';
import EsriQuery from '../src/readers/esriQuery';
import { Writable } from 'stream';


// Pass stdout to a write stream instead of stdout
const writeStream: Writable = new Writable;
writeStream._write = () => { };
process.stdout.write = writeStream.write.bind(writeStream);

// Define a helper function to test the EsriQuery class with different options and capabilities
const testFeatures = (options: CliOptionsType, capabilities: string, geometryType: string = 'esriGeometryPoint') => {
  // Use describe to group tests for the getSourceInfo method
  describe('getSourceInfo', () => {
    // Use test to define a single test case for getSourceInfo
    test('should get source info and return the Esri Feature Layer', async () => {
      // Create a new EsriQuery instance with the specified options
      const query = new EsriQuery(options);
      // Call the getSourceInfo method and await the result
      const sourceInfo = await query.getSourceInfo();
      // Use expect to define assertions about the result
      expect(sourceInfo).toBeTruthy();
      expect(sourceInfo.fields).toBeTruthy();
      expect(sourceInfo.maxRecordCount).toEqual(1000);
      expect(sourceInfo.geometryType).toEqual(geometryType);
      expect(sourceInfo.capabilities).toEqual(capabilities);
    });
  });

  // Use describe to group tests for the start method
  describe('start', () => {
    // Use test to define a single test case for start
    test('should start querying and return runtime parameters', async () => {
      // Create a new EsriQuery instance with the specified options
      const query = new EsriQuery(options);
      // Call the start method and await the result
      const runtimeParams = await query.start();
      const totalFeatureCount = query.totalFeatureCount;
      // Use expect to define assertions about the result
      expect(runtimeParams.status).toBe('done');
      expect(runtimeParams.featureCount).toBeLessThanOrEqual(totalFeatureCount);
    });
  });
}

// Define a test suite for the EsriQuery class using a MapServer data source (using the Esri JSON format)
describe('EsriQuery Test MapServer (Esri JSON)', () => {
  // Define options for the MapServer data source
  const options: CliOptionsType = {
    url: 'https://sampleserver6.arcgisonline.com/arcgis/rest/services/USA/MapServer/0',
    where: 'OBJECTID <= 50',
    'feature-count': 5,
    format: 'geojson',
    pretty: false,
  };
  // Call the testFeatures helper function with the options and expected capabilities
  testFeatures(options, 'Map,Query,Data');
});

// Define a test suite for the EsriQuery class using a FeatureServer data source (in the Esri PBF format)
describe('EsriQuery Test FeatureServer (PBF)', () => {
  // Define options for the FeatureServer data source
  const options: CliOptionsType = {
    url: 'https://sampleserver6.arcgisonline.com/arcgis/rest/services/LocalGovernment/Recreation/FeatureServer/0',
    where: 'objectid >= 2460650',
    'feature-count': 7,
    format: 'geojson',
    pretty: true,
  };
  // Call the testFeatures helper function with the options and expected capabilities
  testFeatures(options, 'Query,Create,Update,Delete,Uploads,Editing');
});

// Define a test suite for the EsriQuery class using a FeatureServer data source (in the Esri PBF format)
describe('EsriQuery Test FeatureServer (PBF) With A Linestring', () => {
  // Define options for the FeatureServer data source
  const options: CliOptionsType = {
    url: 'https://sampleserver6.arcgisonline.com/arcgis/rest/services/LocalGovernment/Recreation/FeatureServer/1',
    where: 'objectid = 1481047',
    'feature-count': 3,
    format: 'geojson',
    pretty: true,
  };
  // Call the testFeatures helper function with the options and expected capabilities
  testFeatures(options, 'Query,Create,Update,Delete,Uploads,Editing', 'esriGeometryPolyline');
});