import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { collectArchive as collectArchiveOperation } from '../src/archive/collector.mjs';
import { normalizeWikiSummary } from '../src/archive/normalize.mjs';
import { initializeArchive } from '../src/archive/session.mjs';

const operationNames = [
  'get_project', 'get_project_users', 'get_project_statuses', 'get_categories',
  'get_custom_fields', 'get_issue_types', 'get_version_milestone_list',
  'get_issues', 'get_issue', 'get_issue_comments', 'get_issue_participants',
  'get_related_issues', 'get_wiki_pages', 'get_wiki', 'get_wiki_attachments', 'get_shared_files',
  'download_issue_attachment', 'download_wiki_attachment', 'download_shared_file',
];
const immediateWait = async () => {};

test('normalizes Backlog Wiki tag objects and keeps legacy string tags', () => {
  const summary = normalizeWikiSummary({
    id: 301,
    projectId: 8,
    name: 'Overview',
    tags: [
      { id: 12, name: '議事録', extra: 'discarded' },
      'legacy',
      { id: 0, name: 'invalid id' },
      { id: 14, name: '  ' },
      null,
      15,
      '',
    ],
  });
  assert.deepEqual(summary.tags, [
    { id: 12, name: '議事録' },
    'legacy',
  ]);
  assert.deepEqual(normalizeWikiSummary({
    id: 302,
    projectId: 8,
    name: 'No tags',
  }).tags, []);
});

function collectArchive(input) {
  return collectArchiveOperation({ wait: immediateWait, ...input });
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function temporaryArchive(t) {
  const directory = await mkdtemp(join(tmpdir(), 'miku-backlog-archive-collector-test-'));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const output = join(directory, 'archive');
  await initializeArchive({
    output,
    domain: 'example.backlog.com',
    projectKey: 'DEMO',
    now: new Date('2026-09-07T00:00:00.000Z'),
  });
  return output;
}

function fixtureRuntime(responses, calls, downloads = async (operation) => {
  throw new Error(`Unexpected download ${operation}`);
}) {
  return {
    product: { name: 'miku-backlog-api', version: '0.8.0' },
    listOperations() {
      return operationNames.map((name) => ({ name, mutationClass: 'read', requiredPermission: 'READ' }));
    },
    async runOperation(operation, input, options) {
      calls.push({ operation, input });
      options.onAccess?.({ phase: 'start', operation });
      const response = await responses(operation, input);
      if (response.success === false) {
        options.onAccess?.({
          phase: 'failure',
          operation,
          httpStatus: response.httpStatus,
          ...(response.rateLimit === undefined ? {} : { rateLimit: response.rateLimit }),
        });
        return { success: false, diagnostics: [{ code: response.code ?? 'UPSTREAM_ERROR' }] };
      }
      options.onAccess?.({
        phase: 'success',
        operation,
        ...(response.rateLimit === undefined ? {} : { rateLimit: response.rateLimit }),
      });
      return { success: true, result: response };
    },
    async openDownload(operation, input, options) {
      calls.push({ operation, input });
      options.onAccess?.({ phase: 'start', operation });
      const download = await downloads(operation, input);
      if (download.success === false) {
        options.onAccess?.({
          phase: 'failure',
          operation,
          httpStatus: download.httpStatus,
          ...(download.rateLimit === undefined ? {} : { rateLimit: download.rateLimit }),
        });
        return { success: false, diagnostics: [{ code: download.code ?? 'UPSTREAM_ERROR' }] };
      }
      const source = download.body.getReader();
      let accessSettled = false;
      let resolveCompleted;
      let rejectCompleted;
      const completed = new Promise((resolve, reject) => {
        resolveCompleted = resolve;
        rejectCompleted = reject;
      });
      void completed.catch(() => {});
      const succeed = () => {
        if (accessSettled) return;
        accessSettled = true;
        options.onAccess?.({
          phase: 'success',
          operation,
          ...(download.rateLimit === undefined ? {} : { rateLimit: download.rateLimit }),
        });
        resolveCompleted();
      };
      const fail = (error) => {
        if (accessSettled) return;
        accessSettled = true;
        options.onAccess?.({
          phase: 'failure',
          operation,
          ...(download.httpStatus === undefined ? {} : { httpStatus: download.httpStatus }),
          ...(download.rateLimit === undefined ? {} : { rateLimit: download.rateLimit }),
        });
        rejectCompleted(error);
      };
      const body = new ReadableStream({
        async pull(controller) {
          try {
            const chunk = await source.read();
            if (chunk.done) {
              try {
                await (download.completed ?? Promise.resolve());
                succeed();
                controller.close();
              } catch (error) {
                fail(error);
                controller.error(error);
              }
              return;
            }
            controller.enqueue(chunk.value);
          } catch (error) {
            fail(error);
            controller.error(error);
          }
        },
        async cancel(reason) {
          await source.cancel(reason).catch(() => {});
          fail(reason instanceof Error ? reason : new Error('Download transfer cancelled.'));
        },
      });
      return {
        success: true,
        transfer: {
          body,
          completed,
        },
      };
    },
  };
}

const project = {
  id: 8,
  projectKey: 'DEMO',
  name: 'Demo project',
  projectLeader: { id: 1, userId: 'owner', name: 'Owner', mailAddress: 'owner@example.test' },
};

const issue = {
  id: 101,
  projectId: 8,
  issueKey: 'DEMO-1',
  summary: 'First issue',
  description: 'Description',
  createdUser: { id: 1, userId: 'owner', name: 'Owner', mailAddress: 'owner@example.test' },
  updatedUser: { id: 2, userId: 'editor', name: 'Editor', mailAddress: 'editor@example.test' },
  customFields: [{ id: 2, name: 'Owner note', value: { mailAddress: 'hidden@example.test', text: 'keep' } }],
};

test('collects normalized issue data and skips completed tasks on resume', async (t) => {
  const output = await temporaryArchive(t);
  const calls = [];
  const runtime = fixtureRuntime(async (operation, input) => {
    if (operation === 'get_project') return project;
    if (operation === 'get_issues') return [{ id: 101, projectId: 8, issueKey: 'DEMO-1', summary: 'First issue' }];
    if (operation === 'get_issue') return issue;
    if (operation === 'get_issue_comments') return [{
      id: 500, issueId: 101, projectId: 8, content: 'Comment', changeLog: [],
      createdUser: { id: 2, userId: 'editor', name: 'Editor', mailAddress: 'editor@example.test' },
      created: '2026-09-07T00:00:00Z', updated: '2026-09-07T00:00:00Z',
    }];
    if (operation === 'get_issue_participants') return [
      { id: 1, userId: 'owner', name: 'Owner', mailAddress: 'owner@example.test', lastLoginTime: 'secret' },
    ];
    if (operation === 'get_related_issues') return [{ id: 102, issueKey: 'DEMO-2', summary: 'Related', type: 'Relates' }];
    if (operation === 'get_wiki_pages') return [];
    if (operation === 'get_shared_files') return [];
    throw new Error(`Unexpected operation ${operation} with ${JSON.stringify(input)}`);
  }, calls);

  const result = await collectArchive({
    output,
    runtime,
    env: { BACKLOG_DOMAIN: 'example.backlog.com', BACKLOG_API_KEY: 'not-saved' },
  });
  assert.deepEqual(result, {
    projectId: 8,
    issueCount: 1,
    collectedIssueCount: 1,
    wikiCount: 0,
    collectedWikiCount: 0,
    sharedFileCount: 0,
    assetCount: 0,
    collectedAssetCount: 0,
    runtime: { name: 'miku-backlog-api', version: '0.8.0' },
  });

  const savedIssue = JSON.parse(await readFile(join(output, 'data', 'issues', '101.json'), 'utf8'));
  assert.deepEqual(savedIssue.participants, [{ id: 1, userId: 'owner', name: 'Owner' }]);
  assert.equal(JSON.stringify(savedIssue).includes('owner@example.test'), false);
  assert.deepEqual(savedIssue.relatedIssues, [{ id: 102, issueKey: 'DEMO-2', summary: 'Related', type: 'Relates' }]);
  assert.equal(savedIssue.issue.customFields[0].value.mailAddress, undefined);
  const persistedText = await Promise.all([
    'manifest.json',
    'state/progress.json',
    'state/issue-details/101.json',
    'data/project.json',
    'data/issues/index.json',
    'data/issues/101.json',
    'data/wikis/index.json',
    'data/files/index.json',
    'data/assets/index.json',
  ].map((path) => readFile(join(output, path), 'utf8')));
  assert.equal(persistedText.some((text) => text.includes('not-saved')), false);

  calls.length = 0;
  const resumed = await collectArchive({
    output,
    runtime,
    env: { BACKLOG_DOMAIN: 'example.backlog.com', BACKLOG_API_KEY: 'not-saved' },
  });
  assert.equal(resumed.collectedIssueCount, 0);
  assert.deepEqual(calls, []);
});

test('reuses complete issue-list data and caches its normalized detail before collecting comments', async (t) => {
  const output = await temporaryArchive(t);
  const calls = [];
  const listIssue = {
    ...issue,
    keyId: 1,
    issueType: { id: 3, name: 'Task', displayOrder: 1 },
    status: { id: 1, name: 'Open', displayOrder: 1 },
    priority: { id: 3, name: 'Normal' },
    resolution: null,
    assignee: null,
    category: [],
    versions: [],
    milestone: [],
    startDate: null,
    dueDate: null,
    estimatedHours: null,
    actualHours: null,
    parentIssueId: null,
    created: '2026-09-07T00:00:00Z',
    updated: '2026-09-07T01:00:00Z',
    attachments: [{
      id: 402,
      name: 'evidence.txt',
      size: 4,
      createdUser: { id: 2, userId: 'editor', name: 'Editor', mailAddress: 'private@example.test' },
      created: '2026-09-07T01:00:00Z',
    }],
    sharedFiles: [],
  };
  const runtime = fixtureRuntime(async (operation) => {
    if (operation === 'get_project') return project;
    if (operation === 'get_issues') return [listIssue];
    if (operation === 'get_issue') throw new Error('Complete issue-list data should be reused.');
    if (operation === 'get_issue_comments' || operation === 'get_issue_participants'
      || operation === 'get_related_issues' || operation === 'get_wiki_pages'
      || operation === 'get_shared_files') return [];
    throw new Error(`Unexpected operation ${operation}`);
  }, calls, async () => ({ body: readableText('data') }));

  await collectArchive({
    output,
    runtime,
    env: { BACKLOG_DOMAIN: 'example.backlog.com', BACKLOG_API_KEY: 'not-saved' },
  });

  assert.equal(calls.some((call) => call.operation === 'get_issue'), false);
  const cache = JSON.parse(await readFile(join(output, 'state', 'issue-details', '101.json'), 'utf8'));
  assert.equal(cache.source, 'issue-list');
  assert.equal(cache.reusable, true);
  assert.equal(cache.issue.attachments[0].created, '2026-09-07T01:00:00Z');
  assert.deepEqual(cache.issue.attachments[0].createdUser, { id: 2, userId: 'editor', name: 'Editor' });
  assert.equal(JSON.stringify(cache).includes('private@example.test'), false);
  const savedIssue = JSON.parse(await readFile(join(output, 'data', 'issues', '101.json'), 'utf8'));
  assert.equal(savedIssue.issue.attachments[0].created, '2026-09-07T01:00:00Z');

  const detailOutput = await temporaryArchive(t);
  const detailCalls = [];
  const detailRuntime = fixtureRuntime(async (operation) => {
    if (operation === 'get_project') return project;
    if (operation === 'get_issues') return [{
      id: 101, projectId: 8, issueKey: 'DEMO-1', summary: 'First issue',
    }];
    if (operation === 'get_issue') return listIssue;
    if (operation === 'get_issue_comments' || operation === 'get_issue_participants'
      || operation === 'get_related_issues' || operation === 'get_wiki_pages'
      || operation === 'get_shared_files') return [];
    throw new Error(`Unexpected operation ${operation}`);
  }, detailCalls, async () => ({ body: readableText('data') }));
  await collectArchive({
    output: detailOutput,
    runtime: detailRuntime,
    env: { BACKLOG_DOMAIN: 'example.backlog.com', BACKLOG_API_KEY: 'not-saved' },
  });
  const detailSavedIssue = JSON.parse(await readFile(join(detailOutput, 'data', 'issues', '101.json'), 'utf8'));
  assert.deepEqual(savedIssue.issue, detailSavedIssue.issue);
});

test('reuses an old archive without an issue-detail cache by fetching the missing issue once', async (t) => {
  const output = await temporaryArchive(t);
  const calls = [];
  const runtime = fixtureRuntime(async (operation) => {
    if (operation === 'get_project') return project;
    if (operation === 'get_issues') return [{ id: 101, projectId: 8, issueKey: 'DEMO-1', summary: 'First issue' }];
    if (operation === 'get_issue') return issue;
    if (operation === 'get_issue_comments' || operation === 'get_issue_participants'
      || operation === 'get_related_issues' || operation === 'get_wiki_pages'
      || operation === 'get_shared_files') return [];
    throw new Error(`Unexpected operation ${operation}`);
  }, calls);
  const env = { BACKLOG_DOMAIN: 'example.backlog.com', BACKLOG_API_KEY: 'not-saved' };
  await collectArchive({ output, runtime, env });

  await rm(join(output, 'state', 'issue-details'), { recursive: true, force: true });
  const progressPath = join(output, 'state', 'progress.json');
  const progress = JSON.parse(await readFile(progressPath, 'utf8'));
  delete progress.rateLimit;
  delete progress.tasks['issue:101'];
  progress.phase = 'incomplete';
  await writeJson(progressPath, progress);
  const manifestPath = join(output, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.collection.status = 'incomplete';
  manifest.collection.completedAt = null;
  await writeJson(manifestPath, manifest);

  calls.length = 0;
  await collectArchive({ output, runtime, env });

  assert.equal(calls.filter((call) => call.operation === 'get_issues').length, 0);
  assert.equal(calls.filter((call) => call.operation === 'get_issue').length, 1);
  const cache = JSON.parse(await readFile(join(output, 'state', 'issue-details', '101.json'), 'utf8'));
  assert.equal(cache.source, 'issue-detail');
});

test('re-fetches the first issue page when a detail cache exists without its index checkpoint', async (t) => {
  const output = await temporaryArchive(t);
  const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'));
  await mkdir(join(output, 'state', 'issue-details'), { recursive: true });
  await writeJson(join(output, 'state', 'issue-details', '101.json'), {
    schemaVersion: 'miku-backlog-archive/issue-detail-cache/v1',
    archiveId: manifest.archive.id,
    projectId: 8,
    savedAt: '2026-09-07T00:00:00.000Z',
    source: 'issue-list',
    reusable: true,
    issue,
  });
  const calls = [];
  const runtime = fixtureRuntime(async (operation, input) => {
    if (operation === 'get_project') return project;
    if (operation === 'get_issues') return [{
      id: 101, projectId: 8, issueKey: 'DEMO-1', summary: 'First issue',
    }];
    if (operation === 'get_issue') return issue;
    if (operation === 'get_issue_comments' || operation === 'get_issue_participants'
      || operation === 'get_related_issues' || operation === 'get_wiki_pages'
      || operation === 'get_shared_files') return [];
    throw new Error(`Unexpected operation ${operation} with ${JSON.stringify(input)}`);
  }, calls);

  const result = await collectArchive({
    output,
    runtime,
    env: { BACKLOG_DOMAIN: 'example.backlog.com', BACKLOG_API_KEY: 'not-saved' },
  });

  assert.equal(result.issueCount, 1);
  assert.deepEqual(
    calls.filter((call) => call.operation === 'get_issues').map((call) => call.input.offset),
    [0],
  );
  const index = JSON.parse(await readFile(join(output, 'data', 'issues', 'index.json'), 'utf8'));
  assert.deepEqual(index.issues.map((entry) => entry.id), [101]);
});

test('rejects a cache belonging to another archive without overwriting the saved issue', async (t) => {
  const output = await temporaryArchive(t);
  const calls = [];
  const runtime = fixtureRuntime(async (operation) => {
    if (operation === 'get_project') return project;
    if (operation === 'get_issues') return [{ id: 101, projectId: 8, issueKey: 'DEMO-1', summary: 'First issue' }];
    if (operation === 'get_issue') return issue;
    if (operation === 'get_issue_comments' || operation === 'get_issue_participants'
      || operation === 'get_related_issues' || operation === 'get_wiki_pages'
      || operation === 'get_shared_files') return [];
    throw new Error(`Unexpected operation ${operation}`);
  }, calls);
  const env = { BACKLOG_DOMAIN: 'example.backlog.com', BACKLOG_API_KEY: 'not-saved' };
  await collectArchive({ output, runtime, env });

  const issuePath = join(output, 'data', 'issues', '101.json');
  const savedBefore = await readFile(issuePath, 'utf8');
  const cachePath = join(output, 'state', 'issue-details', '101.json');
  const cache = JSON.parse(await readFile(cachePath, 'utf8'));
  cache.archiveId = 'another-archive';
  await writeJson(cachePath, cache);
  const progressPath = join(output, 'state', 'progress.json');
  const progress = JSON.parse(await readFile(progressPath, 'utf8'));
  delete progress.tasks['issue:101'];
  progress.phase = 'incomplete';
  await writeJson(progressPath, progress);
  const manifestPath = join(output, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.collection.status = 'incomplete';
  manifest.collection.completedAt = null;
  await writeJson(manifestPath, manifest);

  calls.length = 0;
  await assert.rejects(collectArchive({ output, runtime, env }), /Collection is incomplete/);

  assert.equal(calls.some((call) => call.operation === 'get_issue'), false);
  assert.equal(await readFile(issuePath, 'utf8'), savedBefore);
  const failedProgress = JSON.parse(await readFile(progressPath, 'utf8'));
  assert.equal(failedProgress.tasks['issue:101'].state, 'failed');
  assert.match(failedProgress.tasks['issue:101'].failure.code, /LOCAL_ERROR/);
});

test('rejects corrupt or cross-project issue caches without overwriting completed issue data', async (t) => {
  for (const cacheMutation of [
    (cachePath) => writeFile(cachePath, '{broken json'),
    async (cachePath) => {
      const cache = JSON.parse(await readFile(cachePath, 'utf8'));
      cache.projectId = 999;
      await writeJson(cachePath, cache);
    },
  ]) {
    const output = await temporaryArchive(t);
    const calls = [];
    const runtime = fixtureRuntime(async (operation) => {
      if (operation === 'get_project') return project;
      if (operation === 'get_issues') return [{
        id: 101, projectId: 8, issueKey: 'DEMO-1', summary: 'First issue',
      }];
      if (operation === 'get_issue') return issue;
      if (operation === 'get_issue_comments' || operation === 'get_issue_participants'
        || operation === 'get_related_issues' || operation === 'get_wiki_pages'
        || operation === 'get_shared_files') return [];
      throw new Error(`Unexpected operation ${operation}`);
    }, calls);
    const env = { BACKLOG_DOMAIN: 'example.backlog.com', BACKLOG_API_KEY: 'not-saved' };
    await collectArchive({ output, runtime, env });

    const issuePath = join(output, 'data', 'issues', '101.json');
    const savedBefore = await readFile(issuePath, 'utf8');
    const cachePath = join(output, 'state', 'issue-details', '101.json');
    await cacheMutation(cachePath);
    const progressPath = join(output, 'state', 'progress.json');
    const progress = JSON.parse(await readFile(progressPath, 'utf8'));
    delete progress.tasks['issue:101'];
    progress.phase = 'incomplete';
    await writeJson(progressPath, progress);
    const manifestPath = join(output, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.collection.status = 'incomplete';
    manifest.collection.completedAt = null;
    await writeJson(manifestPath, manifest);

    calls.length = 0;
    await assert.rejects(collectArchive({ output, runtime, env }), /Collection is incomplete/);

    assert.equal(calls.some((call) => call.operation === 'get_issue'), false);
    assert.equal(await readFile(issuePath, 'utf8'), savedBefore);
    const failedProgress = JSON.parse(await readFile(progressPath, 'utf8'));
    assert.equal(failedProgress.tasks['issue:101'].failure.code, 'LOCAL_ERROR');
  }
});

test('retries transient server errors with bounded exponential waits', async (t) => {
  const output = await temporaryArchive(t);
  const calls = [];
  const waits = [];
  let projectAttempts = 0;
  const runtime = fixtureRuntime(async (operation) => {
    if (operation === 'get_project') {
      projectAttempts += 1;
      return projectAttempts < 3
        ? { success: false, code: 'UPSTREAM_ERROR', httpStatus: 500 }
        : project;
    }
    if (operation === 'get_issues' || operation === 'get_wiki_pages' || operation === 'get_shared_files') {
      return [];
    }
    throw new Error(`Unexpected operation ${operation}`);
  }, calls);

  const result = await collectArchive({
    output,
    runtime,
    env: { BACKLOG_DOMAIN: 'example.backlog.com', BACKLOG_API_KEY: 'not-saved' },
    wait: async (milliseconds) => { waits.push(milliseconds); },
  });
  assert.equal(result.projectId, 8);
  assert.equal(calls.filter((call) => call.operation === 'get_project').length, 3);
  assert.deepEqual(waits.slice(0, 2), [1_000, 2_000]);
});

test('stops after three 429s, persists the cooldown, and resumes only after waiting', async (t) => {
  const output = await temporaryArchive(t);
  const calls = [];
  const firstTime = new Date('2026-09-07T00:00:00.000Z');
  let projectAttempts = 0;
  const runtime = fixtureRuntime(async (operation) => {
    if (operation === 'get_project') {
      projectAttempts += 1;
      return projectAttempts <= 3
        ? {
          success: false,
          code: 'UPSTREAM_ERROR',
          httpStatus: 429,
          rateLimit: { limit: 60, remaining: 0, resetAt: '2026-09-06T23:59:00.000Z' },
        }
        : project;
    }
    if (operation === 'get_issues' || operation === 'get_wiki_pages' || operation === 'get_shared_files') {
      return [];
    }
    throw new Error(`Unexpected operation ${operation}`);
  }, calls);

  await assert.rejects(collectArchive({
    output,
    runtime,
    env: { BACKLOG_DOMAIN: 'example.backlog.com', BACKLOG_API_KEY: 'not-saved' },
    now: () => firstTime,
  }), /get_project/);

  assert.deepEqual(calls.map((call) => call.operation), ['get_project', 'get_project', 'get_project']);
  const failed = JSON.parse(await readFile(join(output, 'state', 'progress.json'), 'utf8'));
  assert.equal(failed.tasks.project.failure.requestAttempts, 3);
  assert.equal(failed.waiting, undefined);
  assert.equal(failed.rateLimit.read.blockedUntil, '2026-09-07T00:01:00.000Z');

  calls.length = 0;
  const currentTime = new Date(firstTime);
  const waits = [];
  const progressEvents = [];
  const resumed = await collectArchive({
    output,
    runtime,
    env: { BACKLOG_DOMAIN: 'example.backlog.com', BACKLOG_API_KEY: 'not-saved' },
    now: () => currentTime,
    wait: async (milliseconds) => {
      waits.push(milliseconds);
      currentTime.setTime(currentTime.valueOf() + milliseconds);
    },
    onProgress(event) { progressEvents.push(event); },
  });
  assert.equal(resumed.projectId, 8);
  assert.equal(waits[0], 60_000);
  assert.equal(progressEvents[0].phase, 'waiting');
  assert.equal(progressEvents[0].reason, 'rate-limit');
  assert.equal(calls[0].operation, 'get_project');
});

test('stops the entire collection after three download 429s without starting later tasks', async (t) => {
  const output = await temporaryArchive(t);
  const calls = [];
  const currentTime = new Date('2026-09-07T00:00:00.000Z');
  const runtime = fixtureRuntime(async (operation) => {
    if (operation === 'get_project') return project;
    if (operation === 'get_issues') return [{
      id: 101, projectId: 8, issueKey: 'DEMO-1', summary: 'First issue',
    }];
    if (operation === 'get_issue') return { ...issue, attachments: [{ id: 401, name: 'proof.png', size: 4 }] };
    if (operation === 'get_issue_comments' || operation === 'get_issue_participants'
      || operation === 'get_related_issues' || operation === 'get_wiki_pages'
      || operation === 'get_shared_files') return [];
    throw new Error(`Unexpected operation ${operation}`);
  }, calls, async (operation) => {
    assert.equal(operation, 'download_issue_attachment');
    return { success: false, code: 'UPSTREAM_ERROR', httpStatus: 429 };
  });

  await assert.rejects(collectArchive({
    output,
    runtime,
    env: { BACKLOG_DOMAIN: 'example.backlog.com', BACKLOG_API_KEY: 'not-saved' },
    now: () => currentTime,
    wait: immediateWait,
  }), /download_issue_attachment/);

  assert.equal(calls.filter((call) => call.operation === 'download_issue_attachment').length, 3);
  assert.equal(calls.some((call) => call.operation === 'get_wiki_pages'), false);
  assert.equal(calls.some((call) => call.operation === 'get_shared_files'), false);
  const progress = JSON.parse(await readFile(join(output, 'state', 'progress.json'), 'utf8'));
  assert.equal(progress.tasks['issue-attachment:101:401'].failure.httpStatus, 429);
  assert.equal(progress.tasks['issue-attachment:101:401'].failure.requestAttempts, 3);
  assert.equal(progress.rateLimit.read.blockedUntil, '2026-09-07T00:01:00.000Z');
});

test('deduplicates a resumed issue page and continues from its saved offset', async (t) => {
  const output = await temporaryArchive(t);
  const calls = [];
  let failSecondPage = true;
  const issueSummaries = Array.from({ length: 100 }, (_, index) => ({
    id: index + 1,
    projectId: 8,
    issueKey: `DEMO-${index + 1}`,
    summary: `Issue ${index + 1}`,
  }));
  const runtime = fixtureRuntime(async (operation, input) => {
    if (operation === 'get_project') return project;
    if (operation === 'get_issues' && input.offset === 0) return issueSummaries;
    if (operation === 'get_issues' && input.offset === 100) {
      return failSecondPage
        ? { success: false, code: 'UPSTREAM_ERROR', httpStatus: 429 }
        : [issueSummaries.at(-1), {
          id: 101, projectId: 8, issueKey: 'DEMO-101', summary: 'Issue 101',
        }];
    }
    if (operation === 'get_issue') {
      return {
        id: input.issueId,
        projectId: 8,
        issueKey: `DEMO-${input.issueId}`,
        summary: `Issue ${input.issueId}`,
        attachments: [],
      };
    }
    if (operation === 'get_issue_comments' || operation === 'get_issue_participants'
      || operation === 'get_related_issues' || operation === 'get_wiki_pages'
      || operation === 'get_shared_files') return [];
    throw new Error(`Unexpected operation ${operation} with ${JSON.stringify(input)}`);
  }, calls);

  await assert.rejects(
    collectArchive({
      output,
      runtime,
      env: { BACKLOG_DOMAIN: 'example.backlog.com', BACKLOG_API_KEY: 'not-saved' },
      wait: immediateWait,
    }),
    /get_issues/,
  );
  const interruptedIndex = JSON.parse(await readFile(join(output, 'data', 'issues', 'index.json'), 'utf8'));
  assert.equal(interruptedIndex.issues.length, 100);
  const interruptedProgress = JSON.parse(await readFile(join(output, 'state', 'progress.json'), 'utf8'));
  assert.equal(interruptedProgress.tasks['issue-list'].nextOffset, 100);
  assert.equal(interruptedProgress.tasks['issue-list'].state, 'failed');
  assert.equal(interruptedProgress.tasks['issue-list'].failure.requestAttempts, 3);

  // Simulate an interruption after writing the refreshed index but before the
  // matching offset checkpoint. The retry must merge this page by issue ID.
  interruptedIndex.issues.push({
    id: 101,
    projectId: 8,
    issueKey: 'DEMO-101',
    summary: 'Issue 101',
  });
  await writeJson(join(output, 'data', 'issues', 'index.json'), interruptedIndex);

  calls.length = 0;
  failSecondPage = false;
  const resumed = await collectArchive({
    output,
    runtime,
    env: { BACKLOG_DOMAIN: 'example.backlog.com', BACKLOG_API_KEY: 'not-saved' },
  });
  assert.equal(resumed.issueCount, 101);
  assert.equal(calls.some((call) => call.operation === 'get_project'), false);
  assert.deepEqual(
    calls.filter((call) => call.operation === 'get_issues').map((call) => call.input.offset),
    [100],
  );
  const completedIndex = JSON.parse(await readFile(join(output, 'data', 'issues', 'index.json'), 'utf8'));
  assert.deepEqual(completedIndex.issues.map((item) => item.id), Array.from({ length: 101 }, (_, index) => index + 1));
  const completedProgress = JSON.parse(await readFile(join(output, 'state', 'progress.json'), 'utf8'));
  assert.equal(completedProgress.tasks['issue-list'].attempts, 2);
  assert.equal(completedProgress.tasks['issue-list'].state, 'completed');
});

test('records a retryable failed issue task without discarding completed project data', async (t) => {
  const output = await temporaryArchive(t);
  const calls = [];
  let participantCallFails = true;
  const runtime = fixtureRuntime(async (operation) => {
    if (operation === 'get_project') return project;
    if (operation === 'get_issues') return [{ id: 101, projectId: 8, issueKey: 'DEMO-1', summary: 'First issue' }];
    if (operation === 'get_issue') return issue;
    if (operation === 'get_issue_comments') return [];
    if (operation === 'get_issue_participants') {
      return participantCallFails
        ? { success: false, code: 'UPSTREAM_ERROR', httpStatus: 429 }
        : [{ id: 1, userId: 'owner', name: 'Owner', mailAddress: 'owner@example.test' }];
    }
    if (operation === 'get_related_issues') return [];
    if (operation === 'get_wiki_pages') return [];
    if (operation === 'get_shared_files') return [];
    throw new Error(`Unexpected operation ${operation}`);
  }, calls);

  await assert.rejects(
    collectArchive({
      output,
      runtime,
      env: { BACKLOG_DOMAIN: 'example.backlog.com', BACKLOG_API_KEY: 'not-saved' },
      wait: immediateWait,
    }),
    /get_issue_participants/,
  );

  const progress = JSON.parse(await readFile(join(output, 'state', 'progress.json'), 'utf8'));
  assert.equal(progress.phase, 'incomplete');
  assert.equal(progress.tasks.project.state, 'completed');
  assert.equal(progress.tasks['issue:101'].state, 'failed');
  assert.equal(progress.tasks['issue:101'].failure.httpStatus, 429);
  assert.equal(progress.tasks['issue:101'].failure.retryable, true);
  assert.equal(progress.tasks['issue:101'].failure.requestAttempts, 3);
  assert.equal(calls.filter((call) => call.operation === 'get_issue_participants').length, 3);

  calls.length = 0;
  participantCallFails = false;
  const resumed = await collectArchive({
    output,
    runtime,
    env: { BACKLOG_DOMAIN: 'example.backlog.com', BACKLOG_API_KEY: 'not-saved' },
  });
  assert.equal(resumed.collectedIssueCount, 1);
  assert.equal(calls.some((call) => call.operation === 'get_project'), false);
  assert.equal(calls.some((call) => call.operation === 'get_issues'), false);
  assert.equal(calls.some((call) => call.operation === 'get_issue_participants'), true);
  assert.equal(calls.some((call) => call.operation === 'get_issue'), false);
  const resumedProgress = JSON.parse(await readFile(join(output, 'state', 'progress.json'), 'utf8'));
  assert.equal(resumedProgress.phase, 'completed');
  assert.equal(resumedProgress.tasks['issue:101'].attempts, 2);
  assert.equal(resumedProgress.waiting, undefined);
});

test('does not wait on an expired saved cooldown before the first API request', async (t) => {
  const output = await temporaryArchive(t);
  const progressPath = join(output, 'state', 'progress.json');
  const progress = JSON.parse(await readFile(progressPath, 'utf8'));
  progress.rateLimit = {
    read: { blockedUntil: '2026-09-06T23:59:00.000Z', blockedReason: 'rate-limit' },
  };
  await writeJson(progressPath, progress);
  const calls = [];
  const waits = [];
  const runtime = fixtureRuntime(async (operation) => {
    if (operation === 'get_project') return project;
    if (operation === 'get_issues' || operation === 'get_wiki_pages' || operation === 'get_shared_files') return [];
    throw new Error(`Unexpected operation ${operation}`);
  }, calls);

  await collectArchive({
    output,
    runtime,
    env: { BACKLOG_DOMAIN: 'example.backlog.com', BACKLOG_API_KEY: 'not-saved' },
    now: () => new Date('2026-09-07T00:00:00.000Z'),
    wait: async (milliseconds) => { waits.push(milliseconds); },
  });

  assert.equal(calls[0].operation, 'get_project');
  assert.equal(waits.some((milliseconds) => milliseconds >= 60_000), false);
});

test('records a 404 as a single non-retryable task failure', async (t) => {
  const output = await temporaryArchive(t);
  const calls = [];
  const runtime = fixtureRuntime(async (operation) => {
    if (operation === 'get_project') return project;
    if (operation === 'get_issues') return [{
      id: 101, projectId: 8, issueKey: 'DEMO-1', summary: 'First issue',
    }];
    if (operation === 'get_issue') {
      return { success: false, code: 'NOT_FOUND', httpStatus: 404 };
    }
    if (operation === 'get_issue_comments' || operation === 'get_issue_participants'
      || operation === 'get_related_issues' || operation === 'get_wiki_pages'
      || operation === 'get_shared_files') return [];
    throw new Error(`Unexpected operation ${operation}`);
  }, calls);

  await assert.rejects(collectArchive({
    output,
    runtime,
    env: { BACKLOG_DOMAIN: 'example.backlog.com', BACKLOG_API_KEY: 'not-saved' },
    wait: immediateWait,
  }), /Collection is incomplete/);

  assert.equal(calls.filter((call) => call.operation === 'get_issue').length, 1);
  const progress = JSON.parse(await readFile(join(output, 'state', 'progress.json'), 'utf8'));
  assert.equal(progress.tasks['issue:101'].failure.httpStatus, 404);
  assert.equal(progress.tasks['issue:101'].failure.retryable, false);
});

function readableText(value) {
  const bytes = new TextEncoder().encode(value);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function readableChunks(values) {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index >= values.length) {
        controller.close();
      } else {
        controller.enqueue(new TextEncoder().encode(values[index]));
        index += 1;
      }
    },
  });
}

test('collects current Wiki pages, recursive shared files, and safe streamed assets', async (t) => {
  const output = await temporaryArchive(t);
  const calls = [];
  const runtime = fixtureRuntime(async (operation, input) => {
    if (operation === 'get_project') return project;
    if (operation === 'get_issues') return [{
      id: 201, projectId: 8, issueKey: 'DEMO-2', summary: 'Issue with attachment',
    }];
    if (operation === 'get_issue') return {
      id: 201,
      projectId: 8,
      issueKey: 'DEMO-2',
      summary: 'Issue with attachment',
      attachments: [{ id: 402, name: 'issue image.png', size: 5 }],
    };
    if (operation === 'get_issue_comments') return [];
    if (operation === 'get_issue_participants') return [];
    if (operation === 'get_related_issues') return [];
    if (operation === 'get_wiki_pages') return [{
      id: 301,
      projectId: 8,
      name: 'Overview',
      tags: [{ id: 12, name: 'guide' }, { id: 13, name: '安全 & <確認>' }],
      createdUser: { id: 1, userId: 'owner', name: 'Owner', mailAddress: 'owner@example.test' },
      created: '2026-09-07T00:00:00Z',
      updatedUser: { id: 2, userId: 'editor', name: 'Editor', mailAddress: 'editor@example.test' },
      updated: '2026-09-07T01:00:00Z',
    }];
    if (operation === 'get_wiki') return {
      id: 301,
      projectId: 8,
      name: 'Overview',
      content: 'Current Wiki body',
      tags: [{ id: 12, name: '議事録' }, { id: 13, name: '安全 & <確認>' }],
      attachments: [{
        id: 401,
        name: '../diagram?.png',
        size: 3,
        createdUser: { id: 1, userId: 'owner', name: 'Owner', mailAddress: 'owner@example.test' },
      }],
    };
    if (operation === 'get_shared_files' && input.path === './') return [
      { id: 501, projectId: 8, type: 'directory', dir: '/', name: 'nested' },
      { id: 502, projectId: 8, type: 'file', dir: '/', name: 'shared?.txt', size: 6 },
    ];
    if (operation === 'get_shared_files' && input.path === 'nested/') return [
      { id: 503, projectId: 8, type: 'file', dir: '/nested/', name: 'inner.txt', size: 5 },
    ];
    throw new Error(`Unexpected operation ${operation} with ${JSON.stringify(input)}`);
  }, calls, async (operation, input) => {
    if (operation === 'download_wiki_attachment' && input.attachmentId === 401) {
      return { body: readableText('png') };
    }
    if (operation === 'download_issue_attachment' && input.attachmentId === 402) {
      return { body: readableText('issue') };
    }
    if (operation === 'download_shared_file' && input.sharedFileId === 502) {
      return { body: readableText('shared') };
    }
    if (operation === 'download_shared_file' && input.sharedFileId === 503) {
      return { body: readableText('inner') };
    }
    throw new Error(`Unexpected download ${operation} with ${JSON.stringify(input)}`);
  });

  const result = await collectArchive({
    output,
    runtime,
    env: { BACKLOG_DOMAIN: 'example.backlog.com', BACKLOG_API_KEY: 'not-saved' },
  });
  assert.deepEqual(result, {
    projectId: 8,
    issueCount: 1,
    collectedIssueCount: 1,
    wikiCount: 1,
    collectedWikiCount: 1,
    sharedFileCount: 2,
    assetCount: 4,
    collectedAssetCount: 4,
    runtime: { name: 'miku-backlog-api', version: '0.8.0' },
  });
  assert.deepEqual(
    calls.filter((call) => call.operation === 'get_shared_files').map((call) => call.input.path),
    ['./', 'nested/'],
  );

  const savedWiki = JSON.parse(await readFile(join(output, 'data', 'wikis', '301.json'), 'utf8'));
  assert.equal(savedWiki.wiki.createdUser, null);
  assert.deepEqual(savedWiki.wiki.tags, [
    { id: 12, name: '議事録' },
    { id: 13, name: '安全 & <確認>' },
  ]);
  const savedWikiIndex = JSON.parse(await readFile(join(output, 'data', 'wikis', 'index.json'), 'utf8'));
  assert.deepEqual(savedWikiIndex.wikis[0].tags, [
    { id: 12, name: 'guide' },
    { id: 13, name: '安全 & <確認>' },
  ]);
  assert.equal(JSON.stringify(savedWiki).includes('owner@example.test'), false);

  const sharedIndex = JSON.parse(await readFile(join(output, 'data', 'files', 'index.json'), 'utf8'));
  assert.equal(sharedIndex.directories.some((directory) => directory.path === '/nested/'), true);
  assert.deepEqual(sharedIndex.files.map((file) => file.path).sort(), ['/nested/inner.txt', '/shared?.txt']);

  const assets = JSON.parse(await readFile(join(output, 'data', 'assets', 'index.json'), 'utf8'));
  assert.equal(assets.issueAttachments.length, 1);
  assert.equal(assets.wikiAttachments.length, 1);
  assert.equal(assets.sharedFiles.length, 2);
  const allAssets = [...assets.issueAttachments, ...assets.wikiAttachments, ...assets.sharedFiles];
  assert.equal(allAssets.every((asset) => asset.localPath.startsWith('assets/')), true);
  assert.equal(allAssets.every((asset) => !asset.localPath.includes('..') && !asset.localPath.includes('?')), true);
  assert.equal(
    await readFile(join(output, ...assets.wikiAttachments[0].localPath.split('/')), 'utf8'),
    'png',
  );
  assert.equal(
    await readFile(join(output, ...assets.issueAttachments[0].localPath.split('/')), 'utf8'),
    'issue',
  );
  assert.equal(
    await readFile(join(output, ...assets.sharedFiles.find((file) => file.sharedFileId === 502).localPath.split('/')), 'utf8'),
    'shared',
  );
  assert.equal(
    await readFile(join(output, ...assets.sharedFiles.find((file) => file.sharedFileId === 503).localPath.split('/')), 'utf8'),
    'inner',
  );

  calls.length = 0;
  const resumed = await collectArchive({
    output,
    runtime,
    env: { BACKLOG_DOMAIN: 'example.backlog.com', BACKLOG_API_KEY: 'not-saved' },
  });
  assert.equal(resumed.collectedWikiCount, 0);
  assert.equal(resumed.collectedAssetCount, 0);
  assert.deepEqual(calls, []);
});

test('applies download quota events after stream completion and failure', async (t) => {
  const output = await temporaryArchive(t);
  const calls = [];
  let clock = Date.parse('2026-09-07T00:00:00.000Z');
  let firstResetAt;
  let finalResetAt;
  let interruptSecondDownload = true;
  const downloadStarts = [];
  const runtime = fixtureRuntime(async (operation, input) => {
    if (operation === 'get_project') return project;
    if (operation === 'get_issues' || operation === 'get_wiki_pages') return [];
    if (operation === 'get_shared_files' && input.path === './') return [601, 602, 603].map((id) => ({
      id,
      projectId: 8,
      type: 'file',
      dir: '/',
      name: `quota-${id}.txt`,
      size: 1,
    }));
    if (operation === 'get_shared_files') return [];
    throw new Error(`Unexpected operation ${operation}`);
  }, calls, async (operation, input) => {
    assert.equal(operation, 'download_shared_file');
    downloadStarts.push({ id: input.sharedFileId, at: clock });
    if (input.sharedFileId === 601) {
      firstResetAt = clock + 30_000;
      return {
        body: readableChunks(['a', 'b', 'c']),
        rateLimit: { limit: 60, remaining: 0, resetAt: new Date(firstResetAt).toISOString() },
      };
    }
    if (input.sharedFileId === 602) {
      if (!interruptSecondDownload) {
        return { body: readableChunks(['retried']) };
      }
      let sent = false;
      const body = new ReadableStream({
        pull(controller) {
          if (!sent) {
            sent = true;
            controller.enqueue(new TextEncoder().encode('partial'));
          } else {
            controller.error(new Error('stream interrupted'));
          }
        },
      });
      return {
        body,
        rateLimit: {
          limit: 60,
          remaining: 20,
          resetAt: new Date(clock + 60_000).toISOString(),
        },
      };
    }
    finalResetAt = clock + 20_000;
    return {
      body: readableChunks(['done']),
      rateLimit: { limit: 60, remaining: 1, resetAt: new Date(finalResetAt).toISOString() },
    };
  });

  await assert.rejects(collectArchive({
    output,
    runtime,
    env: { BACKLOG_DOMAIN: 'example.backlog.com', BACKLOG_API_KEY: 'not-saved' },
    now: () => new Date(clock),
    wait: async (milliseconds) => { clock += milliseconds; },
  }), /Collection is incomplete/);

  assert.equal(downloadStarts.length, 3);
  assert.equal(downloadStarts[1].at, firstResetAt + 1_000);
  assert.ok(downloadStarts[2].at - downloadStarts[1].at >= Math.ceil(60_000 / 19));
  const progress = JSON.parse(await readFile(join(output, 'state', 'progress.json'), 'utf8'));
  assert.equal(progress.tasks['shared-file:601'].state, 'completed');
  assert.equal(progress.tasks['shared-file:602'].state, 'failed');
  assert.equal(progress.tasks['shared-file:603'].state, 'completed');
  assert.equal(progress.rateLimit.read.remaining, 1);
  assert.equal(progress.rateLimit.read.blockedUntil, new Date(finalResetAt + 1_000).toISOString());
  assert.deepEqual(
    await readFile(join(output, 'assets', 'shared', '601-quota-601.txt'), 'utf8'),
    'abc',
  );

  interruptSecondDownload = false;
  const resumed = await collectArchive({
    output,
    runtime,
    env: { BACKLOG_DOMAIN: 'example.backlog.com', BACKLOG_API_KEY: 'not-saved' },
    now: () => new Date(clock),
    wait: async (milliseconds) => { clock += milliseconds; },
  });
  assert.equal(resumed.sharedFileCount, 3);
  assert.equal(downloadStarts.length, 4);
  assert.equal(downloadStarts[3].id, 602);
  assert.equal(downloadStarts[3].at, finalResetAt + 1_000);
  const resumedProgress = JSON.parse(await readFile(join(output, 'state', 'progress.json'), 'utf8'));
  assert.equal(resumedProgress.tasks['shared-file:602'].state, 'completed');
});

test('records a failed asset download and resumes only that download', async (t) => {
  const output = await temporaryArchive(t);
  const calls = [];
  let shouldFail = true;
  const runtime = fixtureRuntime(async (operation) => {
    if (operation === 'get_project') return project;
    if (operation === 'get_issues') return [];
    if (operation === 'get_wiki_pages') return [];
    if (operation === 'get_shared_files') return [
      { id: 601, projectId: 8, type: 'file', dir: '/', name: 'retry.txt', size: 5 },
    ];
    throw new Error(`Unexpected operation ${operation}`);
  }, calls, async (operation, input) => {
    assert.equal(operation, 'download_shared_file');
    assert.equal(input.sharedFileId, 601);
    return shouldFail
      ? { success: false, code: 'UPSTREAM_ERROR', httpStatus: 429 }
      : { body: readableText('retry') };
  });

  await assert.rejects(
    collectArchive({
      output,
      runtime,
      env: { BACKLOG_DOMAIN: 'example.backlog.com', BACKLOG_API_KEY: 'not-saved' },
      wait: immediateWait,
    }),
    /download_shared_file/,
  );
  const progress = JSON.parse(await readFile(join(output, 'state', 'progress.json'), 'utf8'));
  assert.equal(progress.tasks['shared-directory:%2F'].state, 'completed');
  assert.equal(progress.tasks['shared-file:601'].state, 'failed');
  assert.equal(progress.tasks['shared-file:601'].failure.httpStatus, 429);
  assert.equal(progress.tasks['shared-file:601'].failure.retryable, true);
  assert.equal(progress.tasks['shared-file:601'].failure.requestAttempts, 3);
  assert.equal(calls.filter((call) => call.operation === 'download_shared_file').length, 3);

  calls.length = 0;
  shouldFail = false;
  const resumed = await collectArchive({
    output,
    runtime,
    env: { BACKLOG_DOMAIN: 'example.backlog.com', BACKLOG_API_KEY: 'not-saved' },
  });
  assert.equal(resumed.collectedAssetCount, 1);
  assert.deepEqual(calls, [{
    operation: 'download_shared_file',
    input: { projectId: 8, sharedFileId: 601 },
  }]);
});

test('rejects credentials for a different Backlog domain before API access', async (t) => {
  const output = await temporaryArchive(t);
  const calls = [];
  const runtime = fixtureRuntime(async () => [], calls);

  await assert.rejects(
    collectArchive({
      output,
      runtime,
      env: { BACKLOG_DOMAIN: 'other.backlog.com', BACKLOG_API_KEY: 'not-saved' },
    }),
    /does not match/,
  );
  assert.deepEqual(calls, []);
});
