import { spawn } from 'child_process';
import { describe, expect, test } from '@jest/globals';

// Since this is using ESM
import path from 'path';
const __dirname = path.dirname(new URL(import.meta.url).pathname);


describe('CLI program', () => {
    test('should output expected result', done => {
    // Spawn the CLI program
    const cli = spawn('node', [__dirname + '/../dist/index.js', '-h']);

    // Listen for data on stdout
    let stdout = '';
    cli.stdout.on('data', data => {
      stdout += data.toString();
    });

    // If there's an error report it
    cli.stderr.on('data', data => {
      console.error(data.toString());
    });

    // Listen for the process to exit
    cli.on('exit', code => {
      // Assert that the output is as expected
      expect(stdout).toContain('ESRI Rest Options');
      done();
    });
  });
});
