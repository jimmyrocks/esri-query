import { describe, expect, test } from '@jest/globals';
import { deZigZag, longToString, messageToJson } from './esri-pbf';
import { default as Long } from 'long';
import { Long as LongType } from 'protobufjs';
import { ArcGISJsonRestType, FeatureCollectionType, FieldTypeEnum, GeometryTypeEnum } from './esri-pbf-types';
import { Geometry } from 'arcgis-rest-api';
import { Writable } from 'stream';

// Pass stderr to a write stream instead of stderr
const writeStream: Writable = new Writable;
writeStream._write = () => { };
console.error = writeStream.write.bind(writeStream);

describe('longToString', () => {
    test('should return null for undefined input', () => {
        expect(longToString(undefined)).toBeNull();
    });

    test('should return the string value of a Long object', () => {
        const longValue = Long.fromString('1234567890123456789');
        expect(longToString(longValue)).toEqual('1234567890123456789');
    });

    test('should return the input value for non-Long input', () => {
        console.log('42?', longToString(42), typeof longToString(42));
        expect(longToString(42)).toEqual(42);
        expect(longToString('hello')).toEqual('hello');
    });
});

describe('deZigZag', () => {
    test('should de-zigzag the input values correctly', () => {
        // Define test inputs
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

        // Define expected output
        const expectedOutput = [
            [-5, -15],
            [-2, -10]
        ];

        // Call the function and check the output
        const output = deZigZag(values, splits, scale, initialOffset, upperLeftOrigin);
        expect(output).toEqual(expectedOutput);
    });
});

describe('deZigZag', () => {
    test('should correctly de-zigzag values with different scale and offset', () => {
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
            { low: 0, high: 0, unsigned: false }
        ];
        const splits = [3, 5, 3];
        const scale = 10;
        const initialOffset = 5;
        const upperLeftOrigin = true;
        const expectedValues = [
            [0, -50, -110],
            [-60, -90, -90, -90, -120],
            [-60, -110, -110]
        ];

        expect(deZigZag(values, splits, scale, initialOffset, upperLeftOrigin)).toEqual(expectedValues);
    });
});

describe('messageToJson', () => {
    const message: FeatureCollectionType = {
        queryResult: {
            featureResult: {
                transform: {
                    scale: {
                        "xScale": 1e-9,
                        "yScale": 1e-9,
                        "mScale": 0.0001,
                        "zScale": 0.0001
                    },
                    translate: {
                        "xTranslate": -400,
                        "yTranslate": -400,
                        "mTranslate": -100000,
                        "zTranslate": -100000
                    },
                    quantizeOriginPostion: 0
                },
                geometryType: GeometryTypeEnum.esriGeometryTypePolygon,
                features: [{
                    geometry: ({
                        "lengths": [17],
                        "coords": [
                            "277102867404", "-447077143779",
                            "-514984", "496843",
                            "-472069", "672206",
                            "257492", "1052167",
                            "-2102852", "-321498",
                            "-729561", "-789122",
                            "85831", "409173",
                            "85831", "350722",
                            "214576", "584542",
                            "1115799", "0",
                            "1201630", "29227",
                            "1459122", "-233817",
                            "686645", "526091",
                            "643730", "350730",
                            "-171661", "1169118",
                            "643730", "-438422",
                            "85831", "-175368"
                        ].map(s => Long.fromString(s))
                    }),
                    attributes: [
                        { value: 'bar' },
                        { value: 248 }
                    ],
                    length: 0,
                    compressed_geometry: 'none'
                }],
                fields: [
                    { name: 'foo', fieldType: FieldTypeEnum.esriFieldTypeString, alias: 'foo alias', length: 5 },
                    { name: 'num', fieldType: FieldTypeEnum.esriFieldTypeInteger, alias: 'num alias' }
                ],
                values: [],
                exceededTransferLimit: false,
                objectIdFieldName: 'objectid',
                globalIdFieldName: 'globalid',
                spatialReference: { wkid: 4326, latestWkid: 4326 },
                hasZ: false,
                hasM: false
            }
        }
    };

    test('should convert FeatureCollectionType to ArcGISJsonRestType', () => {
        const expected: ArcGISJsonRestType = {
            features: [{
                attributes: {
                    foo: 'bar',
                    num: 248
                },
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
                        [-122.89464350600001, 47.073461187]
                    ]]
                } as Geometry
            }],
            fields: [
                { name: 'foo', fieldType: FieldTypeEnum.esriFieldTypeString, alias: 'foo alias', length: 5 },
                { name: 'num', fieldType: FieldTypeEnum.esriFieldTypeInteger, alias: 'num alias' }
            ],
            exceededTransferLimit: false,
            objectIdFieldName: 'objectid',
            globalIdFieldName: 'globalid',
            geometryType: 'esriGeometryTypePolygon',
            spatialReference: { wkid: 4326, latestWkid: 4326 },
            hasZ: false,
            hasM: false
        };
        const actual = messageToJson(message);
        expect(actual).toEqual(expected);
    });

    test('should return empty features array when queryResult is null', () => {
        const emptyMessage: FeatureCollectionType = { queryResult: null };
        const expected: ArcGISJsonRestType = {
            features: [],
            fields: [],
            exceededTransferLimit: false
        };
        const actual = messageToJson(emptyMessage);
        expect(actual).toEqual(expected);
    });
});