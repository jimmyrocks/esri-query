import QueryMethodBase from './index.js';
import splitExtent from '../../helpers/splitExtent.js';
import type { EsriFeatureLayerType, EsriQueryObjectType } from '../../helpers/esri-rest-types.js';
type Extent = EsriFeatureLayerType['extent'];

export default class  GeographicQueryTool extends QueryMethodBase {
    async runQuery(): Promise<void> {
        const extentPromises: Promise<void>[] = [];

        const result = await this.postAsync(this._baseUrl, { ...this.queryObjectBase, returnExtentOnly: true, f: 'json' }) as { extent: Extent };
        const queue: Extent[] = [result.extent];

        const queryObj = {
            ...this.queryObjectBase,
            geometry: result.extent,
            geometryType: 'esriGeometryEnvelope',
            spatialRel: 'esriSpatialRelIntersects',
            inSR: result.extent.spatialReference.wkid
        };

        const CONCURRENCY = 2;
        while (true) {
            if (queue.length > 0 && extentPromises.length < CONCURRENCY) {
                const currentExtent = queue.shift()!;
                const extentPromise = this.processGeographicExtent(queryObj, currentExtent, queue)
                    .then(() => {
                        const index = extentPromises.indexOf(extentPromise);
                        if (index > -1) extentPromises.splice(index, 1);
                    });
                extentPromises.push(extentPromise);
            } else {
                await Promise.all(extentPromises);
                if (queue.length === 0) {
                    this.emit('done');
                    return;
                }
            }

            if (this.errorCount > this.options.maxErrors) {
                this.emit('error', new Error('Max errors exceeded'));
                return;
            }
        }
    }

    private async processGeographicExtent(queryObj: EsriQueryObjectType, extent: Extent, queue: Extent[]): Promise<void> {
        queryObj = { ...queryObj, geometry: JSON.stringify(extent) } as any;
        try {
            const result = await this.postAsync(this._baseUrl, { ...queryObj, returnCountOnly: true, returnGeometry: false, f: 'json' }) as { count: number };

            if (result.count > this.options.maxFeaturesPerRequest) {
                queue.push(...splitExtent(extent));
            } else {
                const features = await this.fetchFeatures(queryObj);
                if (features.length > 0) {
                    this.emit('data', features);
                }
                return;
            }

        } catch (error) {
            if (error.code === 'RETRY') {
                this.errorCount++;
                this.log('[split]');
                queue.push(...splitExtent(extent));
            } else {
                throw error;
            }
        }
    }
}