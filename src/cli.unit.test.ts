import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from './cli.js';
import EsriQuery from './readers/esriQuery.js';

describe('CLI main', () => {
  const logs: string[] = [];
  const stderr: string[] = [];
  let logSpy: ReturnType<typeof jest.spyOn>;
  let stderrSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    logs.length = 0;
    stderr.length = 0;
    process.exitCode = undefined;
    logSpy = jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(arg => String(arg)).join(' '));
    });
    stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(((chunk: any) => {
      stderr.push(String(chunk));
      return true;
    }) as any);
  });

  afterEach(() => {
    logSpy.mockRestore();
    stderrSpy.mockRestore();
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

  it('normalizes repeatable --header flags into a headers object during dry-run', async () => {
    await main([
      '--dry-run',
      '--print-format', 'json',
      '--url', 'https://example.com/arcgis/rest/services/Sample/FeatureServer/0',
      '--where', '1=1',
      '--header', 'Cookie: SESSION=abc123',
      '--header', 'X-Test: value:with:colon',
    ]);

    const payload = JSON.parse(logs.join('\n'));
    expect(process.exitCode).toBe(0);
    expect(payload.jobs).toHaveLength(1);
    expect(payload.jobs[0].headers).toEqual({
      Cookie: 'SESSION=abc123',
      'X-Test': 'value:with:colon',
    });
    expect(payload.jobs[0].header).toBeUndefined();
  });

  it('accepts --max-file-bytes for geojsonseq dry-runs', async () => {
    await main([
      '--dry-run',
      '--print-format', 'json',
      '--url', 'https://example.com/arcgis/rest/services/Sample/FeatureServer/0',
      '--where', '1=1',
      '--format', 'geojsonseq',
      '--max-file-bytes', '500000000',
    ]);

    const payload = JSON.parse(logs.join('\n'));
    expect(process.exitCode).toBe(0);
    expect(payload.jobs[0]['max-file-bytes']).toBe(500000000);
  });

  it('accepts --fetch-log for dry-runs', async () => {
    await main([
      '--dry-run',
      '--print-format', 'json',
      '--url', 'https://example.com/arcgis/rest/services/Sample/FeatureServer/0',
      '--where', '1=1',
      '--fetch-log', 'fetch.jsonl',
    ]);

    const payload = JSON.parse(logs.join('\n'));
    expect(process.exitCode).toBe(0);
    expect(payload.jobs[0]['fetch-log']).toBe('fetch.jsonl');
  });

  it('prints resume checkpoint details when a resumable job fails', async () => {
    const originalStart = EsriQuery.prototype.start;
    const originalSnapshot = EsriQuery.prototype.getProgressSnapshot;

    EsriQuery.prototype.start = async function () {
      (this as any).runtimeParams.featureCount = 37;
      throw new Error('Error preforming query operation');
    };
    EsriQuery.prototype.getProgressSnapshot = function () {
      return {
        featureCount: 37,
        lastCompletedOid: 12345,
        checkpointRecordsWritten: 10037,
        resumeStatePath: 'out.resume.json',
      } as any;
    };

    try {
      await main([
        '--url', 'https://example.com/arcgis/rest/services/Sample/FeatureServer/0',
        '--where', '1=1',
        '--format', 'geojsonseq',
        '--output', 'out.geojsonl',
        '--resume-state', 'out.resume.json',
        '--progress',
      ]);
    } finally {
      EsriQuery.prototype.start = originalStart;
      EsriQuery.prototype.getProgressSnapshot = originalSnapshot;
    }

    const text = stderr.join('');
    expect(process.exitCode).toBe(1);
    expect(text).toContain('[1/1] Error: Error preforming query operation');
    expect(text).toContain('Resume checkpoint: last completed OID 12345; committed this run 37; checkpoint total 10037; state out.resume.json');
    expect(text).toContain('Run ended with errors. Committed features: 37.');
    expect(text).not.toContain('All jobs finished.');
  });
});
