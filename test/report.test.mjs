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
  assert.match(html, /issue:101/);
  assert.match(html, /get_issue&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&quot;issueId&quot;: 101/);
  assert.doesNotMatch(html, /must-not-render/);
  assert.match(html, /API 試行回数<\/th>/);
  assert.match(html, /<td>3<\/td>/);
  assert.doesNotMatch(html, /https?:\/\//);
});
