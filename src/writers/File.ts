import { openSync, closeSync, writeSync } from 'fs';
import Stdout from './Stdout.js';

export default class File extends Stdout {
    fileId: number;

    /**
     * Open the file for writing and call the parent class's `open` method.
     */
    open() {
        this.fileId = openSync(this.options.output, 'a');
        super.open();
    };

    /**
   * Close the file and write the footer.
   */
    close() {
        this.writeFooter();
        closeSync(this.fileId);
    };

    /**
     * Write a string to the file.
     * 
     * @param line - the string to write
     * @returns the number of bytes written
     */
    writeString(line: string) {
        return writeSync(this.fileId, line);
    };

    /**
    * Close and reopen the file as a way of "saving" it.
    */
    save() {
        closeSync(this.fileId);
        this.open();
    };

};