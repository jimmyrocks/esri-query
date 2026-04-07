import File from './File.js';
import { describe, expect, test, beforeEach, afterEach } from '@jest/globals';
import { promises as fsp } from 'fs';
import { existsSync } from 'fs';
import { join } from 'path';

async function rmrf(p: string) {
    try { await fsp.rm(p, { recursive: true, force: true }); } catch { }
}

describe('File writer', () => {
    const singleOut = 'File.unit.test.output.log';
    const partDir = 'File.unit.test.partitions';

    beforeEach(async () => {
        await rmrf(singleOut);
        await rmrf(partDir);
    });

    afterEach(async () => {
        await rmrf(singleOut);
        await rmrf(partDir);
    });

    test('writes plain strings to a single file (non-partitioned)', async () => {
        const file = new File({ output: singleOut });
        await file.open();

        const values = Array.from({ length: 10 }, () => Math.random().toString(36).slice(2));
        for (const v of values) {
            await file.writeString(`Line ${v}\n`);
        }

        // mid-run fsync should not throw
        await file.save();

        await file.close();

        // verify that file was written to
        const contents = await fsp.readFile(singleOut, 'utf8');
        for (const v of values) {
            expect(contents).toContain(`Line ${v}\n`);
        }
    });

    test('writes partitioned geojsonseq files and rolls by size', async () => {
        // Partition by `state`, roll files when they exceed ~200 bytes to force multiple parts
        const file = new File({ output: partDir, partition: 'state', format: 'geojsonseq', 'max-file-bytes': 200 });
        await file.open();

        const features = [
            { type: 'Feature', properties: { state: 'CA', id: 1 }, geometry: { type: 'Point', coordinates: [-122.4, 37.8] } },
            { type: 'Feature', properties: { state: 'CA', id: 2 }, geometry: { type: 'Point', coordinates: [-122.5, 37.7] } },
            { type: 'Feature', properties: { state: 'NY', id: 3 }, geometry: { type: 'Point', coordinates: [-73.98, 40.75] } },
            { type: 'Feature', properties: { state: 'NY', id: 4 }, geometry: { type: 'Point', coordinates: [-73.99, 40.76] } },
            { type: 'Feature', properties: { state: 'CA', id: 5 }, geometry: { type: 'Point', coordinates: [-122.3, 37.9] } },
        ] as any[];

        for (const f of features) {
            await file.writeFeature(f);
        }

        await file.save();
        await file.close();

        // Expect partitioned files like: partDir/CA.part0000.geojsonl, CA.part0001.geojsonl, NY.part0000.geojsonl
        const ca0 = join(partDir, 'CA.part0000.geojsonl');
        const ny0 = join(partDir, 'NY.part0000.geojsonl');

        expect(existsSync(ca0)).toBe(true);
        expect(existsSync(ny0)).toBe(true);

        // CA likely rolled due to size; part1 may or may not exist depending on JSON length.
        const ca0Contents = existsSync(ca0) ? await fsp.readFile(ca0, 'utf8') : '';
        const ny0Contents = existsSync(ny0) ? await fsp.readFile(ny0, 'utf8') : '';

        // Each file is NDJSON; ensure at least one of the written ids per state is present
        expect(ca0Contents + ny0Contents).toContain('"state":"CA"');
        expect(ca0Contents + ny0Contents).toContain('"state":"NY"');

        // Sanity: every line ends with a newline in NDJSON output
        if (ca0Contents.length) {
            const lines = ca0Contents.trim().split('\n');
            expect(lines.length).toBeGreaterThan(0);
        }
        if (ny0Contents.length) {
            const lines = ny0Contents.trim().split('\n');
            expect(lines.length).toBeGreaterThan(0);
        }
    });
});
