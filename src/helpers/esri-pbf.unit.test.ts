import { describe, expect, test } from '@jest/globals';
import { deZigZag, longToString, messageToJson } from './esri-pbf.js';
import esriPbf from './esri-pbf.js';
import { default as Long } from 'long';
import { Long as LongType } from 'protobufjs';
import { ArcGISJsonRestType, FeatureCollectionType, FieldTypeEnum, GeometryTypeEnum } from './esri-pbf-types.js';
import { Geometry } from 'arcgis-rest-api';
import { Writable } from 'stream';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Silence stderr noise in tests
const writeStream: Writable = new Writable();
writeStream._write = () => {};
// @ts-ignore
console.error = writeStream.write.bind(writeStream);

// ----------------------
// longToString
// ----------------------

describe('longToString', () => {
  test('returns null for undefined', () => {
    expect(longToString(undefined)).toBeNull();
  });

  test('converts Long to string', () => {
    const longValue = Long.fromString('1234567890123456789');
    expect(longToString(longValue)).toEqual('1234567890123456789');
  });

  test('passes through primitives', () => {
    expect(longToString(42)).toEqual(42);
    expect(longToString('hello')).toEqual('hello');
  });
});

// ----------------------
// deZigZag
// ----------------------

describe('deZigZag', () => {
  test('basic decode with upper-left origin', () => {
    const values: Array<LongType> = [
      { low: 5, high: 0, unsigned: false },
      { low: 10, high: 0, unsigned: false },
      { low: 2, high: 0, unsigned: false },
      { low: 8, high: 0, unsigned: false },
    ];
    const splits: Array<number> = [2, 2];
    const scale = 1;
    const initialOffset = 0;
    const upperLeftOrigin = true;
    const expected = [
      [-5, -15],
      [-2, -10],
    ];
    expect(deZigZag(values, splits, scale, initialOffset, upperLeftOrigin)).toEqual(expected);
  });

  test('different scale and offset', () => {
    const values: LongType[] = [
      { low: 0, high: 0, unsigned: false },
      { low: 5, high: 0, unsigned: false },
      { low: 6, high: 0, unsigned: false },
      { low: 6, high: 0, unsigned: false },
      { low: 3, high: 0, unsigned: false },
      { low: 0, high: 0, unsigned: false },
      { low: 0, high: 0, unsigned: false },
      { low: 3, high: 0, unsigned: false },
      { low: 6, high: 0, unsigned: false },
      { low: 5, high: 0, unsigned: false },
      { low: 0, high: 0, unsigned: false },
    ];
    const splits = [3, 5, 3];
    const scale = 10;
    const initialOffset = 5;
    const upperLeftOrigin = true;
    const expected = [
      [0, -50, -110],
      [-60, -90, -90, -90, -120],
      [-60, -110, -110],
    ];
    expect(deZigZag(values, splits, scale, initialOffset, upperLeftOrigin)).toEqual(expected);
  });
});

// ----------------------
// messageToJson (core translation)
// ----------------------

describe('messageToJson', () => {
  test('converts FeatureCollectionType (polygon) to ArcGISJsonRestType', () => {
    const message: FeatureCollectionType = {
      queryResult: {
        featureResult: {
          transform: {
            scale: { xScale: 1e-9, yScale: 1e-9, mScale: 1e-4, zScale: 1e-4 },
            translate: { xTranslate: -400, yTranslate: -400, mTranslate: -100000, zTranslate: -100000 },
            quantizeOriginPostion: 0,
          },
          geometryType: GeometryTypeEnum.esriGeometryTypePolygon,
          features: [
            {
              geometry: {
                lengths: [17],
                coords: [
                  '277102867404', '-447077143779',
                  '-514984', '496843',
                  '-472069', '672206',
                  '257492', '1052167',
                  '-2102852', '-321498',
                  '-729561', '-789122',
                  '85831', '409173',
                  '85831', '350722',
                  '214576', '584542',
                  '1115799', '0',
                  '1201630', '29227',
                  '1459122', '-233817',
                  '686645', '526091',
                  '643730', '350730',
                  '-171661', '1169118',
                  '643730', '-438422',
                  '85831', '-175368',
                ].map((s) => Long.fromString(s)),
              },
              attributes: [
                { string_value: 'bar', index: 0 },
                { sint_value: 248, index: 1 },
              ],
            } as any,
          ],
          fields: [
            { name: 'foo', fieldType: FieldTypeEnum.esriFieldTypeString, alias: 'foo alias', length: 5 },
            { name: 'num', fieldType: FieldTypeEnum.esriFieldTypeInteger, alias: 'num alias' },
          ],
          exceededTransferLimit: false,
          objectIdFieldName: 'objectid',
          globalIdFieldName: 'globalid',
          spatialReference: { wkid: 4326, latestWkid: 4326 },
          hasZ: false,
          hasM: false,
        },
      },
    } as any;

    const expected: ArcGISJsonRestType = {
      features: [
        {
          attributes: { foo: 'bar', num: 248 },
          geometry: {
            rings: [[
              [-122.897132596, 47.077143779000004],
              [-122.89764758000001, 47.076646936],
              [-122.89811964900001, 47.075974730000006],
              [-122.897862157, 47.074922563],
              [-122.89996500900001, 47.07524406100001],
              [-122.90069457000001, 47.076033183],
              [-122.900608739, 47.075624010000006],
              [-122.90052290800001, 47.075273288000005],
              [-122.90030833200001, 47.074688746],
              [-122.899192533, 47.074688746],
              [-122.89799090300001, 47.074659519],
              [-122.89653178100001, 47.074893336],
              [-122.895845136, 47.074367245000005],
              [-122.89520140600001, 47.074016515000004],
              [-122.89537306700001, 47.072847397000004],
              [-122.894729337, 47.073285819000006],
              [-122.89464350600001, 47.073461187],
            ]],
          } as Geometry,
        },
      ],
      fields: [
        { name: 'foo', fieldType: FieldTypeEnum.esriFieldTypeString, alias: 'foo alias', length: 5 },
        { name: 'num', fieldType: FieldTypeEnum.esriFieldTypeInteger, alias: 'num alias' },
      ],
      exceededTransferLimit: false,
      objectIdFieldName: 'objectid',
      globalIdFieldName: 'globalid',
      geometryType: 'esriGeometryTypePolygon',
      spatialReference: { wkid: 4326, latestWkid: 4326 },
      hasZ: false,
      hasM: false,
    };

    const actual = messageToJson(message);
    expect(actual).toEqual(expected);
  });

  test('maps attributes using Value.index (out-of-order)', () => {
    const msg: FeatureCollectionType = {
      queryResult: {
        featureResult: {
          transform: { scale: { xScale: 1, yScale: 1, mScale: 1, zScale: 1 }, translate: { xTranslate: 0, yTranslate: 0, mTranslate: 0, zTranslate: 0 }, quantizeOriginPostion: 0 },
          geometryType: GeometryTypeEnum.esriGeometryTypePoint,
          features: [
            { geometry: { lengths: [1], coords: [Long.fromInt(0), Long.fromInt(0)] }, attributes: [ { string_value: 'val2', index: 1 }, { string_value: 'val1', index: 0 } ] } as any,
          ],
          fields: [ { name: 'a', fieldType: FieldTypeEnum.esriFieldTypeString }, { name: 'b', fieldType: FieldTypeEnum.esriFieldTypeString } ],
          exceededTransferLimit: false,
        },
      },
    } as any;

    const out = messageToJson(msg);
    expect(out.features[0].attributes).toEqual({ a: 'val1', b: 'val2' });
  });

  test('honors null_value in Value', () => {
    const msg: FeatureCollectionType = {
      queryResult: {
        featureResult: {
          transform: { scale: { xScale: 1, yScale: 1, mScale: 1, zScale: 1 }, translate: { xTranslate: 0, yTranslate: 0, mTranslate: 0, zTranslate: 0 }, quantizeOriginPostion: 0 },
          geometryType: GeometryTypeEnum.esriGeometryTypePoint,
          features: [
            { geometry: { lengths: [1], coords: [Long.fromInt(0), Long.fromInt(0)] }, attributes: [ { null_value: true, index: 0 } ] } as any,
          ],
          fields: [ { name: 'a', fieldType: FieldTypeEnum.esriFieldTypeString } ],
          exceededTransferLimit: false,
        },
      },
    } as any;

    const out = messageToJson(msg);
    expect(out.features[0].attributes).toEqual({ a: null });
  });

  test('maps camelCase oneof (e.g., uintValue) for PBF attributes', () => {
    const msg: FeatureCollectionType = {
      queryResult: {
        featureResult: {
          transform: { scale: { xScale: 1, yScale: 1, mScale: 1, zScale: 1 }, translate: { xTranslate: 0, yTranslate: 0, mTranslate: 0, zTranslate: 0 }, quantizeOriginPostion: 0 },
          geometryType: GeometryTypeEnum.esriGeometryTypePoint,
          features: [
            { geometry: { lengths: [1], coords: [Long.fromInt(0), Long.fromInt(0)] }, attributes: [ { uintValue: 123, index: 0 } ] } as any,
          ],
          fields: [ { name: 'OBJECTID', fieldType: FieldTypeEnum.esriFieldTypeInteger } ],
          exceededTransferLimit: false,
        },
      },
    } as any;

    const out = messageToJson(msg);
    expect(out.features[0].attributes).toEqual({ OBJECTID: 123 });
  });

  test('envelope-only feature produces polygon ring', () => {
    const msg: FeatureCollectionType = {
      queryResult: {
        featureResult: {
          transform: { scale: { xScale: 1, yScale: 1, mScale: 1, zScale: 1 }, translate: { xTranslate: 0, yTranslate: 0, mTranslate: 0, zTranslate: 0 }, quantizeOriginPostion: 0 },
          geometryType: GeometryTypeEnum.esriGeometryTypeEnvelope,
          features: [
            { attributes: [], envelope: { XMin: 1, YMin: 2, XMax: 3, YMax: 4 } } as any,
          ],
          fields: [],
          exceededTransferLimit: false,
        },
      },
    } as any;

    const out = messageToJson(msg);
    expect((out.features[0].geometry as any).rings[0]).toEqual([[1,2],[3,2],[3,4],[1,4],[1,2]]);
  });

  test('curveGeometry falls back to envelope when present, else attributes-only', () => {
    // With envelope
    const withEnv: FeatureCollectionType = {
      queryResult: {
        featureResult: {
          transform: { scale: { xScale: 1, yScale: 1, mScale: 1, zScale: 1 }, translate: { xTranslate: 0, yTranslate: 0, mTranslate: 0, zTranslate: 0 }, quantizeOriginPostion: 0 },
          geometryType: GeometryTypeEnum.esriGeometryTypePolyline,
          features: [
            { attributes: [ { string_value: 'x', index: 0 } ], curveGeometry: { geometryType: GeometryTypeEnum.esriGeometryTypePolyline, parts: [2], segmentSets: [], coords: [] }, envelope: { XMin: 0, YMin: 0, XMax: 1, YMax: 1 } } as any,
          ],
          fields: [ { name: 'foo', fieldType: FieldTypeEnum.esriFieldTypeString } ],
          exceededTransferLimit: false,
        },
      },
    } as any;
    const out1 = messageToJson(withEnv);
    expect((out1.features[0].geometry as any).rings).toBeDefined();
    expect(out1.features[0].attributes).toEqual({ foo: 'x' });

    // Without envelope => attributes-only
    const noEnv: FeatureCollectionType = {
      queryResult: {
        featureResult: {
          transform: { scale: { xScale: 1, yScale: 1, mScale: 1, zScale: 1 }, translate: { xTranslate: 0, yTranslate: 0, mTranslate: 0, zTranslate: 0 }, quantizeOriginPostion: 0 },
          geometryType: GeometryTypeEnum.esriGeometryTypePolyline,
          features: [
            { attributes: [ { string_value: 'y', index: 0 } ], curveGeometry: { geometryType: GeometryTypeEnum.esriGeometryTypePolyline, parts: [2], segmentSets: [], coords: [] } } as any,
          ],
          fields: [ { name: 'foo', fieldType: FieldTypeEnum.esriFieldTypeString } ],
          exceededTransferLimit: false,
        },
      },
    } as any;
    const out2 = messageToJson(noEnv);
    expect(out2.features[0].geometry).toBeUndefined();
    expect(out2.features[0].attributes).toEqual({ foo: 'y' });
  });

  test('returns empty structure when queryResult is null', () => {
    const emptyMessage: FeatureCollectionType = { queryResult: null } as any;
    const expected: ArcGISJsonRestType = { features: [], fields: [], exceededTransferLimit: false };
    expect(messageToJson(emptyMessage)).toEqual(expected);
  });
});

describe('esriPbf fixture regressions', () => {
  const protoPath = join(process.cwd(), 'EsriFeatureCollection.proto');
  const encodedRoot = join(process.cwd(), 'reference', 'arcgis-pbf-parser', 'test', 'encoded');
  const decodedRoot = join(process.cwd(), 'reference', 'arcgis-pbf-parser', 'test', 'decoded');

  const decodeFixture = async (filename: string) => {
    const bytes = new Uint8Array(readFileSync(join(encodedRoot, filename)));
    return await esriPbf(bytes, protoPath);
  };

  test('decodes point fixtures where lengths are omitted', async () => {
    const actual = await decodeFixture('pbf-points.pbf');
    const expected = JSON.parse(readFileSync(join(decodedRoot, 'pbf-points.json'), 'utf8'));
    const expectedCoords = expected.featureCollection.features.slice(0, 3).map((f: any) => f.geometry.coordinates);

    expect(actual.features.length).toBe(expected.featureCollection.features.length);
    for (let i = 0; i < expectedCoords.length; i++) {
      const geom = actual.features[i].geometry as any;
      expect(Number.isFinite(geom?.x)).toBe(true);
      expect(Number.isFinite(geom?.y)).toBe(true);
      expect(geom.x).toBeCloseTo(expectedCoords[i][0], 6);
      expect(geom.y).toBeCloseTo(expectedCoords[i][1], 6);
    }
  });

  test('matches core fixture counts and geometry envelopes', async () => {
    const lines = await decodeFixture('pbf-lines-quantization.pbf');
    expect(lines.features.length).toBe(2);
    expect((lines.features[0].geometry as any).paths.length).toBe(1);
    expect((lines.features[0].geometry as any).paths[0].length).toBeGreaterThan(2);

    const multi = await decodeFixture('pbf-multilinestring.pbf');
    expect(multi.features.length).toBe(1);
    expect((multi.features[0].geometry as any).paths.length).toBeGreaterThan(1);

    const quant = await decodeFixture('pbf-quantization.pbf');
    expect(quant.features.length).toBe(100);
    expect((quant.features[0].geometry as any).rings.length).toBe(1);
    expect((quant.features[0].geometry as any).rings[0].length).toBeGreaterThan(10);
  });

  test('preserves null attributes from fixture payloads', async () => {
    const out = await decodeFixture('pbf-null-handling.pbf');
    expect(out.features.length).toBe(277);
    const hasNull = out.features.some((f: any) =>
      Object.values(f.attributes || {}).some((v) => v === null)
    );
    expect(hasNull).toBe(true);
  });
});
