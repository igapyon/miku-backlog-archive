import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { renderCollectionReport } from '../src/archive/report.mjs';
import { archivePaths, initializeArchive } from '../src/archive/session.mjs';

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

test('renders an older progress file without rate-limit fields', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'miku-backlog-archive-report-test-'));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const output = join(directory, 'archive');
  await initializeArchive({
    output,
    domain: 'example.backlog.com',
    projectKey: 'DEMO',
    now: new Date('2026-09-12T00:00:00.000Z'),
  });
  const paths = archivePaths(output);
  const progress = JSON.parse(await readFile(paths.progress, 'utf8'));
  delete progress.waiting;
  delete progress.rateLimit;
  await writeJson(paths.progress, progress);

  assert.equal((await renderCollectionReport({ output })).failedTaskCount, 0);
  const html = await readFile(join(paths.site, 'collection-status.html'), 'utf8');
  assert.match(html, /API待機<\/dt><dd>待機なし<\/dd>/);
  assert.doesNotMatch(html, /429の待機/);
  assert.match(html, /<span class="app-header__brand">DEMO<\/span>/);
  assert.doesNotMatch(html, /href="index\.html"/);
  assert.match(html, /href="collection-status\.html" aria-current="page">収集状況<\/a>/);
  assert.doesNotMatch(html, /href="issues\/index\.html"/);
});

test('renders an offline, sanitized report for an incomplete collection', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'miku-backlog-archive-report-test-'));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const output = join(directory, 'archive');
  await initializeArchive({
    output,
    domain: 'example.backlog.com',
    projectKey: 'DEMO',
    now: new Date('2026-09-12T00:00:00.000Z'),
  });
  const paths = archivePaths(output);
  const manifest = JSON.parse(await readFile(paths.manifest, 'utf8'));
  manifest.collection.status = 'incomplete';
  manifest.collection.startedAt = '2026-09-12T00:00:00.000Z';
  await writeJson(paths.manifest, manifest);
  const progress = JSON.parse(await readFile(paths.progress, 'utf8'));
  progress.phase = 'incomplete';
  progress.updatedAt = '2026-09-12T00:01:00.000Z';
  progress.waiting = {
    category: 'read',
    reason: 'rate-limit',
    startedAt: '2026-09-12T00:01:00.000Z',
    retryAt: '2026-09-12T00:02:00.000Z',
    delayMs: 60_000,
  };
  progress.tasks = {
    'issue:101': {
      state: 'failed',
      failure: {
        operation: 'get_issue<script>',
        target: { issueId: 101, apiKey: 'must-not-render' },
        code: 'UPSTREAM_ERROR',
        httpStatus: 429,
        retryable: true,
        requestAttempts: 3,
        at: '2026-09-12T00:01:00.000Z',
      },
    },
    'wiki:201': { state: 'completed' },
  };
  progress.failures = [progress.tasks['issue:101'].failure];
  await writeJson(paths.progress, progress);

  assert.deepEqual(await renderCollectionReport({ output }), {
    path: join(paths.site, 'collection-status.html'),
    collectionStatus: 'incomplete',
    phase: 'incomplete',
    failedTaskCount: 1,
  });
  const html = await readFile(join(paths.site, 'collection-status.html'), 'utf8');
  assert.match(html, /収集状態<\/dt><dd>incomplete<\/dd>/);
  assert.match(html, /進捗フェーズ<\/dt><dd>incomplete<\/dd>/);
  assert.match(html, /進捗更新<\/dt><dd>2026-09-12 09:01:00 JST<\/dd>/);
  assert.match(html, /API待機<\/dt><dd>read枠、429の待機、2026-09-12 09:02:00 JST以降に再開<\/dd>/);
  assert.match(html, /issue:101/);
  assert.match(html, /get_issue&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&quot;issueId&quot;: 101/);
  assert.doesNotMatch(html, /must-not-render/);
  assert.match(html, /API 試行回数<\/th>/);
  assert.match(html, /<td>3<\/td>/);
  assert.match(html, /<td>2026-09-12 09:01:00 JST<\/td>/);
  assert.doesNotMatch(html, /https?:\/\//);
});

test('links a completed standalone report only to archive pages that exist', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'miku-backlog-archive-report-test-'));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const output = join(directory, 'archive');
  const { paths } = await initializeArchive({
    output,
    domain: 'example.backlog.com',
    projectKey: 'DEMO',
    now: new Date('2026-09-12T00:00:00.000Z'),
  });
  const manifest = JSON.parse(await readFile(paths.manifest, 'utf8'));
  manifest.collection.status = 'completed';
  manifest.collection.completedAt = '2026-09-12T00:01:00.000Z';
  await writeJson(paths.manifest, manifest);
  const progress = JSON.parse(await readFile(paths.progress, 'utf8'));
  progress.phase = 'completed';
  await writeJson(paths.progress, progress);
  await writeFile(join(paths.site, 'index.html'), 'home');

  await renderCollectionReport({ output });
  await renderCollectionReport({ output });

  const html = await readFile(join(paths.site, 'collection-status.html'), 'utf8');
  assert.match(html, /<a class="app-header__brand" href="index\.html">DEMO<\/a>/);
  assert.match(html, /href="index\.html">ホーム<\/a>/);
  assert.equal((html.match(/href="collection-status\.html" aria-current="page">収集状況<\/a>/g) ?? []).length, 1);
  assert.doesNotMatch(html, /href="issues\/index\.html"|href="wikis\/index\.html"|href="files\/index\.html"/);
});
