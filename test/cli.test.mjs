import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ArchiveFormatError } from '../src/archive/format.mjs';
import { main, parseCommand } from '../src/cli.mjs';

function bufferedOutput() {
  let contents = '';
  return {
    output: { write(value) { contents += value; } },
    get value() { return contents; },
  };
}

test('parses archive initialization arguments', () => {
  assert.deepEqual(
    parseCommand([
      'init',
      '--output',
      'output',
      '--source-domain',
      'example.backlog.com',
      '--project-key',
      'DEMO',
    ]),
    {
      type: 'init',
      output: 'output',
      domain: 'example.backlog.com',
      projectKey: 'DEMO',
    },
  );
});

test('parses fixed Runtime verification arguments', () => {
  assert.deepEqual(
    parseCommand(['runtime', 'verify', '--runtime', 'miku-backlog-api-runtime-0.7.10.mjs']),
    { type: 'runtime-verify', runtimePath: 'miku-backlog-api-runtime-0.7.10.mjs' },
  );
});

test('parses collection arguments', () => {
  assert.deepEqual(
    parseCommand(['collect', '--archive', 'output', '--runtime', 'runtime.mjs']),
    { type: 'collect', output: 'output', runtimePath: 'runtime.mjs' },
  );
});

test('parses render arguments', () => {
  assert.deepEqual(
    parseCommand(['render', '--archive', 'output']),
    { type: 'render', output: 'output' },
  );
});

test('parses report arguments', () => {
  assert.deepEqual(
    parseCommand(['report', '--archive', 'output']),
    { type: 'report', output: 'output' },
  );
});

test('requires initialization identity options', () => {
  assert.throws(
    () => parseCommand(['init', '--output', 'output']),
    ArchiveFormatError,
  );
});

test('rejects unknown commands and options', () => {
  assert.throws(() => parseCommand(['publish']), /Unknown command/);
  assert.throws(
    () => parseCommand(['verify', '--output', 'output', '--force']),
    /Unknown option/,
  );
});

test('initializes and verifies an archive through the CLI entry point', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'miku-backlog-archive-cli-test-'));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const output = join(directory, 'archive');
  const stdout = bufferedOutput();
  const stderr = bufferedOutput();

  assert.equal(
    await main(
      [
        'init',
        '--output',
        output,
        '--source-domain',
        'example.backlog.com',
        '--project-key',
        'DEMO',
      ],
      { stdout: stdout.output, stderr: stderr.output },
    ),
    0,
  );
  assert.match(stdout.value, /Initialized archive for DEMO/);
  assert.equal(stderr.value, '');

  const verified = bufferedOutput();
  assert.equal(
    await main(['verify', '--output', output], { stdout: verified.output, stderr: stderr.output }),
    0,
  );
  assert.match(verified.value, /Archive is valid: DEMO/);

  const reported = bufferedOutput();
  assert.equal(
    await main(['report', '--archive', output], { stdout: reported.output, stderr: stderr.output }),
    0,
  );
  assert.match(reported.value, /Rendered collection report: status=initialized/);
});
