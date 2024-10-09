import { CliOptionsType } from '..';
import { EsriFeatureLayerType } from '../helpers/esri-rest-types.js';
import { Feature, Geometry } from 'geojson';

type GeometryExceptCollection = Exclude<Geometry, GeoJSON.GeometryCollection>;

export default class Writer {
    options: CliOptionsType;
    sourceInfo: EsriFeatureLayerType & { totalFeatureCount?: number };
    status = {
        canWrite: false,
        records: 0,
        bbox: [Infinity, Infinity, -Infinity, -Infinity]
    };
    strings: { [key: string]: string }


    constructor(options: CliOptionsType, sourceInfo?: EsriFeatureLayerType & { totalFeatureCount?: number }) {
        this.options = options;
        this.sourceInfo = sourceInfo;
    }

    open() {
        this.status.canWrite = true;
    }
    close() {
        this.status.canWrite = false;
    }
    save() { }

    writeFeature(line: Feature) {
        if (this.status.canWrite) {
            // Add the bbox, if it's requested
            if (!this.options['no-bbox'] && line.geometry.type && line.geometry.type !== 'GeometryCollection') {
                line.bbox = this.generateBbox(line.geometry);
            }
            this.status.records++;
            return line;
        } else {
            throw new Error('Feature cannot be written');
        }
    }

    /**
     * This optimized function generates a bounding box (bbox) in a single pass through
     * the GeoJSON coordinates, thereby significantly improving performance.
     * @param {geometry} GeometryExceptCollection - The GeoJSON geometry object
     * @returns {[number, number, number, number]} - The minimum and maximum lat, lon values `bbox` in the form [min lon, min lat, max lon, max lat]
     */
    generateBbox = (geometry: GeometryExceptCollection): [number, number, number, number] => {
        // Initialize bbox with extreme values.
        let bbox: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];

        // Recursive helper function to traverse coordinates.
        const traverseCoords = (coords: any) => {
            if (typeof coords[0] === 'number') { // Coords is a Position
                bbox = [
                    Math.min(bbox[0], coords[0]),
                    Math.min(bbox[1], coords[1]),
                    Math.max(bbox[2], coords[0]),
                    Math.max(bbox[3], coords[1]),
                ];
            } else { // Coords is an array of Positions or deeper
                coords.forEach(traverseCoords);
            }
        };

        // Start traversal
        try {
            traverseCoords(geometry.coordinates);
        } catch (e) {
            throw new Error('Invalid GeoJSON geometry!');
        }

        // Update this.status.bbox with either the smaller or larger boundary of the new bbox
        this.status.bbox = [
            Math.min(bbox[0], this.status.bbox[0]),
            Math.min(bbox[1], this.status.bbox[1]),
            Math.max(bbox[2], this.status.bbox[2]),
            Math.max(bbox[3], this.status.bbox[3])
        ];

        return bbox;
    }

};
