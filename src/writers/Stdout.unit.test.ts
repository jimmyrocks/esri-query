import { describe, expect, test, jest } from '@jest/globals';
import { Feature, Point } from 'geojson';
import { CliOptionsType } from '..';
import Stdout from './Stdout';
import { Writable } from 'stream';

const options: CliOptionsType = {
    format: 'geojson',
    'no-bbox': true
};

describe('Stdout', () => {
    const stdout = new Stdout(options);

    // Mock the writer
    const writeMock: jest.Mock = jest.fn();
    const writeStream: Writable = new Writable;
    writeStream.write = writeMock as any;
    process.stdout.write = writeStream.write.bind(writeStream);

    describe('open and writeHeader', () => {
        test('should write a GeoJSON FeatureCollection header to stdout', () => {
            stdout.open();
            expect(writeStream.write).toHaveBeenCalledWith(expect.stringContaining('{"type": "FeatureCollection", "features": ['));
        });
    });

    describe('writeFeature', () => {
        test('should write a GeoJSON feature to stdout', () => {
            const feature: Feature<Point, { [name: string]: any }> = {
                type: 'Feature',
                geometry: {
                    type: 'Point',
                    coordinates: [0, 0]
                },
                properties: {
                    name: 'test'
                }
            };
            stdout.writeFeature(feature);
            expect(writeStream.write).toHaveBeenCalledWith('{"type":"Feature","geometry":{"type":"Point","coordinates":[0,0]},"properties":{"name":"test"}}');
        });
    });

    describe('close and write footer', () => {
        test('should write a GeoJSON FeatureCollection footer to stdout', () => {
            stdout.close();
            expect(writeStream.write).toHaveBeenCalledWith(']}');
        });
    });

});
