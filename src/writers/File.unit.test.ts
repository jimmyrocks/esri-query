import File from './File';
import { describe, expect, test } from '@jest/globals';
import { readFileSync, unlinkSync } from 'fs';

describe('File', () => {
    const outputFile = 'File.unit.test.output.log';

    test('should write to file', () => {
        const file = new File({ output: outputFile });
        file.open();
        const values = new Array(10)
            .fill('')
            .map(v => Math.random().toString(36).substring(2))
        values.forEach(v => file.writeString(`Line ${v}\n`));
        file.close();

        // verify that file was written to
        // read the contents of the file and check for the expected strings
        const contents = readFileSync(outputFile, 'utf8');
        values.forEach(v => expect(contents).toContain(`Line ${v}\n`));

        // remove output file after test
        unlinkSync(outputFile);
    });
});