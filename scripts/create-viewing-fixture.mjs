#!/usr/bin/env node

import { readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderArchive } from '../src/archive/render.mjs';
import { createViewingFixture } from '../test/helpers/viewing-fixture.mjs';

function parseOutput(argv) {
  if (argv.length !== 2 || argv[0] !== '--output' || !argv[1] || argv[1].startsWith('-')) {
    throw new Error('Usage: node scripts/create-viewing-fixture.mjs --output <empty-directory>');
  }
  return argv[1];
}

async function requireEmptyOrMissing(path) {
  try {
    const info = await stat(path);
    if (!info.isDirectory() || (await readdir(path)).length > 0) {
      throw new Error('Fixture output must be an empty directory or a missing path.');
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function main(argv) {
  const output = resolve(parseOutput(argv));
  await requireEmptyOrMissing(output);
  await createViewingFixture(output);
  await renderArchive({ output });
  process.stdout.write(`Created offline viewing fixture: ${output}\n`);
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`create-viewing-fixture: ${error instanceof Error ? error.message : 'failed'}\n`);
    process.exitCode = 1;
  }
}
