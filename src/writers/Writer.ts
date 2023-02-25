/* eslint-env node, es6 */
import { CliOptionsType } from '..';
import { EsriFeatureLayerType } from '../helpers/esri-rest-types.js';

export default class Writer {
    options: CliOptionsType;
    sourceInfo: EsriFeatureLayerType;
    status = {
        canWrite: false,
        records: 0,
        bbox: [Infinity, Infinity, -Infinity, -Infinity]
    };
    strings: { [key: string]: string }


    constructor(options: CliOptionsType, sourceInfo?: EsriFeatureLayerType) {
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

    writeFeature(line: GeoJSON.Feature) {
        if (this.status.canWrite) {
            // Add the bbox, if it's requested
            if (!this.options['no-bbox']) {
                line.bbox = this.generateBbox(line);
            }
            this.status.records++;
            return line;
        } else {
            throw new Error('Feature cannot be written');
        }
    }

    generateBbox = (geojson: GeoJSON.Feature) => {

        let coordList: GeoJSON.Position[] = [];
        if (geojson.geometry.type === 'Point') coordList = [geojson.geometry.coordinates];
        if (geojson.geometry.type === 'MultiPoint' || geojson.geometry.type === 'LineString') coordList = [...geojson.geometry.coordinates];
        if (geojson.geometry.type === 'MultiLineString' || geojson.geometry.type === 'Polygon') coordList = [...geojson.geometry.coordinates.reduce((a, c) => [...a, ...c], [])];
        if (geojson.geometry.type === 'MultiPolygon') coordList = [...geojson.geometry.coordinates.reduce((a, c) => [...a, ...c], []).reduce((a, c) => [...a, ...c], [])];

        const bbox = [
            Math.min(...coordList.map(pos => pos[0])), //Min lon
            Math.min(...coordList.map(pos => pos[1])), //Min lat
            Math.max(...coordList.map(pos => pos[0])), //Max lon
            Math.max(...coordList.map(pos => pos[1])), //Max lat
        ];

        this.status.bbox = [
            bbox[0] < this.status.bbox[0] ? bbox[0] : this.status.bbox[0],
            bbox[1] < this.status.bbox[1] ? bbox[1] : this.status.bbox[1],
            bbox[0] > this.status.bbox[0] ? bbox[0] : this.status.bbox[0],
            bbox[1] > this.status.bbox[1] ? bbox[1] : this.status.bbox[1]
        ];

        return bbox as [number, number, number, number];
    }

};
