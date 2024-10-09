import EventEmitter from 'events';
import type { EsriQueryObjectType } from '../../helpers/esri-rest-types.js';
import postAsync from '../../helpers/post-async.js';
import type { EsriFeatureType } from '../esriQuery.js';

interface QueryOptions {
    maxErrors: number;
    maxFeaturesPerRequest: number;
    queryObjectBase: EsriQueryObjectType;
    baseUrl: URL;
}

export default abstract class QueryTool extends EventEmitter {
    protected options: QueryOptions;
    protected errorCount: number = 0;
    protected _queryObjectBase: EsriQueryObjectType;
    protected _baseUrl: URL;

    constructor(options: QueryOptions) {
        super();
        this.options = options;
        this._queryObjectBase = options.queryObjectBase;
        this._baseUrl = options.baseUrl;
        this._baseUrl.pathname = this._baseUrl.pathname.replace(/\/$/g, '') + '/query';
    }

    get queryObjectBase() {
        return JSON.parse(JSON.stringify(this._queryObjectBase));
    }

    abstract runQuery(): Promise<void>;

    protected async fetchFeatures(params: EsriQueryObjectType): Promise<Array<EsriFeatureType>> {
        try {
            const data = await postAsync(this._baseUrl, params) as { features?: Array<EsriFeatureType>, error?: string };

            if (data.features) {
                return data.features;
            }

            if (data.error) {
                const e = new Error(data.error, { cause: 'ESRI ERROR' });
                (e as any).code = 'ESRI ERROR';
                throw e;
            }
        } catch (e) {
            if (
                e.code === 'ESRI ERROR' ||
                e.code === 'ECONNRESET' ||
                e.message === 'index out of range: 3 + 101 > 80' ||
                e.message === 'index out of range: 3 + 101 > 75' ||
                e.status === 502 ||
                e.status === 504
            ) {
                const cleanError = new Error(e.message, { cause: e.code });
                (cleanError as any).code = 'RETRY';
                (cleanError as any).originalCode = e.code;
                (cleanError as any).status = e.status;
                throw cleanError;
            } else {
                console.error('Error with request:', params);
                console.error('------------------');
                console.error(e, null, 2);
                console.error('------------------');
                console.error(e.status, e.code, e);
                throw e instanceof Error ? e : new Error(e);
            }
        }
    }

    protected delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    log = (msg: string) => {
        this.emit('log', msg);
    }

    postAsync = postAsync;
}