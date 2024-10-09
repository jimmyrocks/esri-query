import QueryToolBase from "./index.js";

export default class PaginatedQueryTool extends QueryToolBase {
    async runQuery(): Promise<void> {
        let pageSize = this.options.maxFeaturesPerRequest;
        let currentPage = 0;

        while (this.errorCount <= this.options.maxErrors) {
            if (this.errorCount > 0) {
                await this.delay(1500 * this.errorCount);
            }

            const finished = await this.processPaginatedPage(currentPage, pageSize);

            if (finished) {
                this.emit('done');
                return;
            } else {
                currentPage += pageSize;
            }

            if (this.errorCount > this.options.maxErrors) {
                this.emit('error', new Error('Max errors exceeded'));
                return;
            }
        }
    }

    private async processPaginatedPage(page: number, pageSize: number): Promise<boolean> {
        const queryObj = {
            ...this.queryObjectBase,
            resultOffset: page,
            resultRecordCount: pageSize,
        };

        try {
            const features = await this.fetchFeatures(queryObj);
            if (features.length > 0) {
                this.emit('data', features);
            }

            return (features.length < pageSize);

        } catch (error) {
            this.errorCount++;
            const newPageSize = Math.floor(pageSize / 2);
            if (newPageSize < 1) {
                throw new Error('Page size reduced to less than 1');
            }
            if (error.code === 'RETRY') {
                this.log('[split]');
                await this.processPaginatedPage(page, newPageSize);
                await this.processPaginatedPage(page + newPageSize, newPageSize);
            } else {
                throw error;
            }
        }
    }
}