import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { collectArchive } from '../src/archive/collector.mjs';
import { initializeArchive } from '../src/archive/session.mjs';

const operationNames = [
  'get_project', 'get_project_users', 'get_project_statuses', 'get_categories',
  'get_custom_fields', 'get_issue_types', 'get_version_milestone_list',
  'get_issues', 'get_issue', 'get_issue_comments', 'get_issue_participants',
  'get_related_issues', 'get_wiki_pages', 'get_wiki', 'get_shared_files',
  'download_issue_attachment', 'download_wiki_attachment', 'download_shared_file',
];
const immediateWait = async () => {};

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
    product: { name: 'miku-backlog-api', version: '0.7.10' },
    listOperations() {
      return operationNames.map((name) => ({ name, mutationClass: 'read', requiredPermission: 'READ' }));
    },
    async runOperation(operation, input, options) {
      calls.push({ operation, input });
      options.onAccess?.({ phase: 'start', operation });
      const response = await responses(operation, input);
      if (response.success === false) {
        options.onAccess?.({ phase: 'failure', operation, httpStatus: response.httpStatus });
        return { success: false, diagnostics: [{ code: response.code ?? 'UPSTREAM_ERROR' }] };
      }
      options.onAccess?.({ phase: 'success', operation });
      return { success: true, result: response };
    },
    async openDownload(operation, input, options) {
      calls.push({ operation, input });
      options.onAccess?.({ phase: 'start', operation });
      const download = await downloads(operation, input);
      if (download.success === false) {
        options.onAccess?.({ phase: 'failure', operation, httpStatus: download.httpStatus });
        return { success: false, diagnostics: [{ code: download.code ?? 'UPSTREAM_ERROR' }] };
      }
      options.onAccess?.({ phase: 'success', operation });
      return {
        success: true,
        transfer: {
          body: download.body,
          completed: download.completed ?? Promise.resolve(),
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
    runtime: { name: 'miku-backlog-api', version: '0.7.10' },
  });

  const savedIssue = JSON.parse(await readFile(join(output, 'data', 'issues', '101.json'), 'utf8'));
  assert.deepEqual(savedIssue.participants, [{ id: 1, userId: 'owner', name: 'Owner' }]);
  assert.equal(JSON.stringify(savedIssue).includes('owner@example.test'), false);
  assert.deepEqual(savedIssue.relatedIssues, [{ id: 102, issueKey: 'DEMO-2', summary: 'Related', type: 'Relates' }]);
  assert.equal(savedIssue.issue.customFields[0].value.mailAddress, undefined);

  calls.length = 0;
  const resumed = await collectArchive({
    output,
    runtime,
    env: { BACKLOG_DOMAIN: 'example.backlog.com', BACKLOG_API_KEY: 'not-saved' },
  });
  assert.equal(resumed.collectedIssueCount, 0);
  assert.deepEqual(calls, []);
});

test('retries retryable reads with bounded exponential waits', async (t) => {
  const output = await temporaryArchive(t);
  const calls = [];
  const waits = [];
  let projectAttempts = 0;
  const runtime = fixtureRuntime(async (operation) => {
    if (operation === 'get_project') {
      projectAttempts += 1;
      return projectAttempts < 3
        ? { success: false, code: 'UPSTREAM_ERROR', httpStatus: 429 }
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
  assert.deepEqual(waits, [1_000, 2_000]);
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
    /Collection is incomplete/,
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
  const resumedProgress = JSON.parse(await readFile(join(output, 'state', 'progress.json'), 'utf8'));
  assert.equal(resumedProgress.phase, 'completed');
  assert.equal(resumedProgress.tasks['issue:101'].attempts, 2);
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
      tags: ['guide'],
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
      attachments: [{
        id: 401,
        name: '../diagram?.png',
        size: 3,
        createdUser: { id: 1, userId: 'owner', name: 'Owner', mailAddress: 'owner@example.test' },
      }],
    };
    if (operation === 'get_shared_files' && input.path === '/') return [
      { id: 501, projectId: 8, type: 'dir', dir: '/', name: 'nested' },
      { id: 502, projectId: 8, type: 'file', dir: '/', name: 'shared?.txt', size: 6 },
    ];
    if (operation === 'get_shared_files' && input.path === '/nested/') return [
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
    runtime: { name: 'miku-backlog-api', version: '0.7.10' },
  });

  const savedWiki = JSON.parse(await readFile(join(output, 'data', 'wikis', '301.json'), 'utf8'));
  assert.equal(savedWiki.wiki.createdUser, null);
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
    /Collection is incomplete/,
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
