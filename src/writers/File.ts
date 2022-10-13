/* eslint-env node, es6 */
import { openSync, closeSync, writeSync } from 'fs';
import Stdout from './Stdout.js';

export default class File extends Stdout {
    fileId: number;

    open() {
        this.fileId = openSync(this.options.output, 'a');
        if (!this.headerStatus.hasHeader) {
            this.writeHeader();
        }
    };

    close() {
        this.writeFooter();
        closeSync(this.fileId);
    };

    writeString(line: string) {
        return writeSync(this.fileId, line);
    };

    save() {
        // We'll close the file and open it again as a way of "saving"
        closeSync(this.fileId);
        this.open();
    };

};

