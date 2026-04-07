import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from './cli.js';

describe('CLI main', () => {
  const logs: string[] = [];
  let logSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    logs.length = 0;
    process.exitCode = undefined;
    logSpy = jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(arg => String(arg)).join(' '));
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    process.exitCode = undefined;
  });

  it('prints grouped help output', async () => {
    await main(['--help']);

    expect(process.exitCode).toBe(0);
    expect(logs.join('\n')).toContain('Usage: esri-query [options]');
    expect(logs.join('\n')).toContain('General Options:');
  });

  it('resolves YAML config jobs during dry-run with JSON output', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'esri-query-cli-'));
    const configPath = join(tempDir, 'config.yaml');

    writeFileSync(configPath, [
      'options:',
      '  progress: true',
      '  on-invalid: keep',
      '  outFields: [name, type]',
      'jobs:',
      '  - name: sample',
      '    url: https://example.com/arcgis/rest/services/Sample/FeatureServer/0',
      '    where: 1=1',
      '    bbox: [-123.5, 47.5, -122.8, 48.0]',
      '    format: geojsonseq',
      '    output: out.geojsonl',
      '',
    ].join('\n'));

    try {
      await main(['--dry-run', '--print-format', 'json', '--config', configPath]);
      const payload = JSON.parse(logs.join('\n'));

      expect(process.exitCode).toBe(0);
      expect(payload.jobs).toHaveLength(1);
      expect(payload.jobs[0].name).toBe('sample');
      expect(payload.jobs[0].bbox).toEqual([-123.5, 47.5, -122.8, 48]);
      expect(payload.jobs[0].progress).toBe(true);
      expect(payload.jobs[0]['on-invalid']).toBe('keep');
      expect(payload.jobs[0].outFields).toEqual(['name', 'type']);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('accepts --out-fields via CLI options', async () => {
    await main([
      '--dry-run',
      '--print-format', 'json',
      '--url', 'https://example.com/arcgis/rest/services/Sample/FeatureServer/0',
      '--where', '1=1',
      '--out-fields', 'name,type',
    ]);

    const payload = JSON.parse(logs.join('\n'));
    expect(process.exitCode).toBe(0);
    expect(payload.jobs).toHaveLength(1);
    expect(payload.jobs[0]['out-fields']).toBe('name,type');
  });
});
