import { describe, it, expect, beforeEach } from '@jest/globals';
import type { Geometry, Feature } from 'geojson';
import Writer from './Writer.js';

/**
 * Minimal concrete writer for testing the abstract base class.
 */
class TestWriter extends Writer {
    async open(): Promise<void> { this._markOpen(); }
    async close(): Promise<void> { this._markClosed(); }
    async writeString(_line: string): Promise<void> { /* no-op */ }

    // Expose protected bbox generator for unit testing
    public bboxOf(g: any) {
        // @ts-ignore accessing protected for test purposes
        return this.generateBbox(g);
    }

    async sinkWrite(payload: string): Promise<void> { }

}

describe('Writer', () => {
    let writer: TestWriter;

    beforeEach(() => {
        writer = new TestWriter({ 'no-bbox': false } as any);
    });

    it('correctly creates a bbox from GeoJSON geometry and updates running bbox', async () => {
        const geometry: Geometry = { type: 'Point', coordinates: [125.6, 10.1] };

        const bbox = writer.bboxOf(geometry);

        expect(bbox).toEqual([125.6, 10.1, 125.6, 10.1]);
        expect(writer.status.bbox).toEqual([125.6, 10.1, 125.6, 10.1]);
    });

    it('generates bbox for multiple geometry types', async () => {
        expect(writer.bboxOf({ type: 'Point', coordinates: [10, 20] } as Geometry)).toEqual([10, 20, 10, 20]);
        expect(writer.bboxOf({ type: 'MultiPoint', coordinates: [[10, 20], [30, 40]] } as Geometry)).toEqual([10, 20, 30, 40]);
        expect(writer.bboxOf({ type: 'LineString', coordinates: [[10, 20], [30, 40]] } as Geometry)).toEqual([10, 20, 30, 40]);
        expect(writer.bboxOf({ type: 'MultiLineString', coordinates: [[[10, 20], [30, 40]], [[-10, -20], [-30, -40]]] } as Geometry)).toEqual([-30, -40, 30, 40]);
        expect(writer.bboxOf({ type: 'Polygon', coordinates: [[[10, 20], [30, 40], [10, 40], [10, 20]]] } as Geometry)).toEqual([10, 20, 30, 40]);
        expect(writer.bboxOf({ type: 'MultiPolygon', coordinates: [[[[10, 20], [30, 40], [10, 40], [10, 20]]], [[[-10, -20], [-30, -40], [-10, -40], [-10, -20]]]] } as Geometry)).toEqual([-30, -40, 30, 40]);
    });

    it('adds bbox to feature and increments records when open', async () => {
        await writer.open();

        const feature: Feature = {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [125.6, 10.1] },
            properties: {},
        };

        const resultingFeature = await writer.writeFeature(feature);

        expect(resultingFeature.bbox).toEqual([125.6, 10.1, 125.6, 10.1]);
        expect(writer.status.records).toBe(1);
    });

    it('throws when writing while closed', async () => {
        await writer.close();

        const feature: Feature = {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [125.6, 10.1] },
            properties: {},
        };

        await expect(writer.writeFeature(feature)).rejects.toThrow('Writer is closed: cannot write feature');
    });

    it('honors kebab-case CLI/config option names', () => {
        const configured = new TestWriter({
            'antimeridian-aware': false,
            'max-records': 2,
            'on-invalid': 'keep',
            'progress-every': 5,
            'strict-geometry': false,
        } as any);

        expect(configured.antimeridianAware).toBe(false);
        expect(configured.maxRecords).toBe(2);
        expect(configured.onInvalid).toBe('keep');
        expect(configured.progressEvery).toBe(5);
        expect(configured.strictGeometry).toBe(false);
    });
});
