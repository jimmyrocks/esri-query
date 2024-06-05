import Writer from './Writer'; // Update the path accordingly
import { Geometry, Feature } from "geojson";

describe('Writer', () => {
    let writer: Writer;

    beforeEach(() => {
        writer = new Writer({ 'no-bbox': false }); // Passing options that you use in your Writer class
    });

    it('should correctly create a bounding box from GeoJSON geometry', () => {
        const geometry: Geometry = { type: 'Point', coordinates: [125.6, 10.1] };

        const bbox = writer.generateBbox(geometry);

        expect(bbox).toEqual([125.6, 10.1, 125.6, 10.1]); // Checking case with point, bbox should be same as the point itself
        expect(writer.status.bbox).toEqual([125.6, 10.1, 125.6, 10.1]); // It should also update the status' bbox after calculating new bbox
    });

    // Test with type: Point
    it('should correctly generate bbox for Point', () => {
        const geometry: Geometry = { type: 'Point', coordinates: [10, 20] };

        const bbox = writer.generateBbox(geometry);

        expect(bbox).toEqual([10, 20, 10, 20]);
    });

    // Test with type: MultiPoint
    it('should correctly generate bbox for MultiPoint', () => {
        const geometry: Geometry = { type: 'MultiPoint', coordinates: [[10, 20], [30, 40]] };

        const bbox = writer.generateBbox(geometry);

        expect(bbox).toEqual([10, 20, 30, 40]);
    });

    // Test with type: LineString
    it('should correctly generate bbox for LineString', () => {
        const geometry: Geometry = { type: 'LineString', coordinates: [[10, 20], [30, 40]] };

        const bbox = writer.generateBbox(geometry);

        expect(bbox).toEqual([10, 20, 30, 40]);
    });

    // Test with type: MultiLineString
    it('should correctly generate bbox for MultiLineString', () => {
        const geometry: Geometry = { type: 'MultiLineString', coordinates: [[[10, 20], [30, 40]], [[-10, -20], [-30, -40]]] };

        const bbox = writer.generateBbox(geometry);

        expect(bbox).toEqual([-30, -40, 30, 40]);
    });

    // Test with type: Polygon
    it('should correctly generate bbox for Polygon', () => {
        const geometry: Geometry = { type: 'Polygon', coordinates: [[[10, 20], [30, 40], [10, 40], [10, 20]]] };

        const bbox = writer.generateBbox(geometry);

        expect(bbox).toEqual([10, 20, 30, 40]);
    });

    // Test with type: MultiPolygon
    it('should correctly generate bbox for MultiPolygon', () => {
        const geometry: Geometry = { type: 'MultiPolygon', coordinates: [[[[10, 20], [30, 40], [10, 40], [10, 20]]], [[[-10, -20], [-30, -40], [-10, -40], [-10, -20]]]] };

        const bbox = writer.generateBbox(geometry);

        expect(bbox).toEqual([-30, -40, 30, 40]);
    });

    it('should add bbox to feature and increment records if canWrite is true', () => {
        writer.open(); // Setting canWrite to true

        const feature: Feature = {
            type: 'Feature',
            geometry: {
                type: 'Point',
                coordinates: [125.6, 10.1]
            },
            properties: {}
        };

        const resultingFeature = writer.writeFeature(feature);

        expect(resultingFeature.bbox).toEqual([125.6, 10.1, 125.6, 10.1]); // Bbox should be added to the feature
        expect(writer.status.records).toEqual(1); // records should be incremented
    });

    it('should throw an error if canWrite is false', () => {
        writer.close(); // Setting canWrite to false

        const feature: Feature = {
            type: 'Feature',
            geometry: {
                type: 'Point',
                coordinates: [125.6, 10.1]
            },
            properties: {}
        };

        expect(() => writer.writeFeature(feature)).toThrow('Feature cannot be written'); // It should throw an error
    });
});