import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { writeFileAtomically, writeWebStreamAtomically } from '../src/archive/atomic-write.mjs';
import { ArchiveFormatError } from '../src/archive/format.mjs';
import { archivePaths, initializeArchive, verifyArchive } from '../src/archive/session.mjs';

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'miku-backlog-archive-test-'));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('atomic write replaces a completed file and leaves no temporary file', async (t) => {
  const directory = await temporaryDirectory(t);
  const destination = join(directory, 'state.json');

  await writeFileAtomically(destination, 'first');
  await writeFileAtomically(destination, 'second');

  assert.equal(await readFile(destination, 'utf8'), 'second');
  const entries = await (await import('node:fs/promises')).readdir(directory);
  assert.deepEqual(entries, ['state.json']);
});

test('streamed file write preserves an existing file when the download fails', async (t) => {
  const directory = await temporaryDirectory(t);
  const destination = join(directory, 'attachment.bin');
  await writeFile(destination, 'previous file');

  const failedDownload = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('partial file'));
      controller.error(new Error('download interrupted'));
    },
  });

  await assert.rejects(writeWebStreamAtomically(destination, failedDownload), /download interrupted/);
  assert.equal(await readFile(destination, 'utf8'), 'previous file');
  const entries = await (await import('node:fs/promises')).readdir(directory);
  assert.deepEqual(entries, ['attachment.bin']);
});

test('streamed file write saves a complete download without buffering it', async (t) => {
  const directory = await temporaryDirectory(t);
  const destination = join(directory, 'attachment.bin');
  const download = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([0, 1]));
      controller.enqueue(new Uint8Array([2, 3]));
      controller.close();
    },
  });

  await writeWebStreamAtomically(destination, download);
  assert.deepEqual(await readFile(destination), Buffer.from([0, 1, 2, 3]));
});

test('initialization creates the versioned archive layout and verifies it', async (t) => {
  const directory = await temporaryDirectory(t);
  const output = join(directory, 'archive');
  const now = new Date('2026-09-07T00:00:00.000Z');

  const initialized = await initializeArchive({
    output,
    domain: 'Example.Backlog.com',
    projectKey: 'DEMO',
    now,
    toolVersion: 'test',
  });
  const verified = await verifyArchive(output);

  assert.equal(initialized.manifest.schemaVersion, 'miku-backlog-archive/manifest/v1');
  assert.equal(verified.manifest.source.domain, 'example.backlog.com');
  assert.equal(verified.manifest.source.project.key, 'DEMO');
  assert.equal(verified.progress.archiveId, verified.manifest.archive.id);
  assert.equal(verified.progress.phase, 'initialized');
  assert.equal((await readFile(archivePaths(output).manifest, 'utf8')).endsWith('\n'), true);
});

test('initialization refuses to write into a non-empty directory', async (t) => {
  const output = await temporaryDirectory(t);
  await writeFile(join(output, 'existing.txt'), 'keep');

  await assert.rejects(
    initializeArchive({ output, domain: 'example.backlog.com', projectKey: 'DEMO' }),
    ArchiveFormatError,
  );
  assert.equal(await readFile(join(output, 'existing.txt'), 'utf8'), 'keep');
});

test('verification rejects a progress file belonging to a different archive', async (t) => {
  const directory = await temporaryDirectory(t);
  const output = join(directory, 'archive');
  await initializeArchive({ output, domain: 'example.backlog.com', projectKey: 'DEMO' });
  const paths = archivePaths(output);
  const progress = JSON.parse(await readFile(paths.progress, 'utf8'));
  progress.archiveId = 'different-archive';
  await writeFile(paths.progress, `${JSON.stringify(progress)}\n`);

  await assert.rejects(verifyArchive(output), /different archive/);
});
