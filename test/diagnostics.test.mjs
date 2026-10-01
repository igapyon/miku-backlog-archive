import assert from 'node:assert/strict';
import test from 'node:test';

import {
  failureHint,
  formatCollectionError,
  formatFailure,
  normalizeFailure,
  safeTaskLabel,
  summarizeCurrentFailures,
} from '../src/archive/diagnostics.mjs';

test('normalizes failure diagnostics to fixed safe fields and order', () => {
  const failure = normalizeFailure({
    operation: 'get_project',
    target: {
      issueKey: 'DEMO-12',
      projectKey: 'DEMO',
      issueId: 12,
      secret: 'sensitive',
    },
    code: 'UPSTREAM_ERROR',
    httpStatus: 503,
    requestAttempts: 3,
    retryable: true,
    message: 'api-key-must-never-appear',
  });
  assert.deepEqual(failure, {
    operation: 'get_project',
    target: { projectKey: 'DEMO', issueId: 12, issueKey: 'DEMO-12' },
    code: 'UPSTREAM_ERROR',
    httpStatus: 503,
    requestAttempts: 3,
    retryable: true,
    hint: 'サーバーまたは中継側のエラーの可能性があります。時間を置いた再実行を検討してください。',
  });
});

test('drops malformed, unknown, oversized, and control-character diagnostic values', () => {
  assert.deepEqual(normalizeFailure({
    operation: 'get_project?api-key=bad',
    target: {
      projectKey: 'DEMO\napi-key',
      issueKey: 'DEMO-1\rsecret',
      issueId: Number.MAX_SAFE_INTEGER + 1,
      offset: -1,
      attachmentId: 0,
    },
    code: 'UPSTREAM_ERROR\napi-key',
    httpStatus: 999,
    requestAttempts: 0,
    retryable: 'true',
  }), {
    operation: 'unknown',
    target: {},
    code: 'UNKNOWN_ERROR',
    hint: '原因は未特定です。操作・コード・収集状況レポートを確認してください。',
  });
});

test('uses HTTP status before generic code hints and distinguishes no status', () => {
  assert.match(failureHint({ code: 'UPSTREAM_ERROR', httpStatus: 401 }), /APIキー設定/u);
  assert.match(failureHint({ code: 'UPSTREAM_ERROR' }), /HTTP状態を取得できず、原因は未特定/u);
  assert.match(failureHint({ code: 'LOCAL_ERROR' }), /ローカル保存/u);
  assert.match(failureHint({ code: 'INVALID_ARGUMENT' }), /入力仕様/u);
  for (const httpStatus of [400, 409, 422, 302]) {
    const hint = normalizeFailure({ code: 'UPSTREAM_ERROR', httpStatus }).hint;
    assert.match(hint, /HTTP状態は取得済み/u);
    assert.doesNotMatch(hint, /HTTP状態を取得できず/u);
  }
});

test('preserves sanitized shared-directory labels and rejects unsafe task IDs', () => {
  const summary = summarizeCurrentFailures({ tasks: {
    'shared-directory:%2Fprivate-folder': {
      state: 'failed', failure: { operation: 'get_shared_files', code: 'UPSTREAM_ERROR' },
    },
  } });
  assert.equal(safeTaskLabel(summary.failures[0].task), 'shared-directory');
  const text = formatCollectionError({ collectionDiagnostics: summary });
  assert.match(text, /task=shared-directory/u);
  assert.doesNotMatch(text, /private-folder/u);
  assert.equal(safeTaskLabel('issue:9007199254740993'), 'unknown');
  assert.equal(safeTaskLabel('wiki-attachment:201:9007199254740993'), 'unknown');
});

test('accepts only positive project ID filters and validates arrays', () => {
  assert.deepEqual(normalizeFailure({
    operation: 'get_issues',
    target: { projectId: [1, 2], offset: 0, minId: 3 },
    code: 'NOT_FOUND',
  }).target, { projectId: [1, 2], offset: 0, minId: 3 });
  assert.deepEqual(normalizeFailure({
    operation: 'get_issues',
    target: { projectId: [1, -1, 2] },
    code: 'NOT_FOUND',
  }).target, {});
});

test('summarizes only currently failed tasks in stable order with a bounded list', () => {
  const tasks = {};
  for (let index = 5; index >= 0; index -= 1) {
    tasks[`issue:${index}`] = {
      state: 'failed',
      failure: { operation: 'get_issue', target: { issueId: index + 1 }, code: 'UPSTREAM_ERROR' },
    };
  }
  tasks['issue:99'] = { state: 'completed', failure: { operation: 'get_issue', code: 'NOT_FOUND' } };
  const result = summarizeCurrentFailures({ tasks, failures: [{ code: 'NOT_FOUND' }] });
  assert.equal(result.failedTaskCount, 6);
  assert.equal(result.failures.length, 5);
  assert.equal(result.omittedFailureCount, 1);
  assert.deepEqual(result.failures.map(({ target }) => target.issueId), [1, 2, 3, 4, 5]);
});

test('formats diagnostics without runtime messages, headers, URLs, stacks, or causes', () => {
  const secret = 'test-api-key-do-not-print';
  const text = formatCollectionError({
    message: secret,
    stack: secret,
    cause: { message: secret },
    collectionDiagnostics: {
      failedTaskCount: 1,
      failures: [{
        operation: 'get_project',
        target: { projectKey: 'DEMO' },
        code: 'UPSTREAM_ERROR',
        requestAttempts: 3,
        diagnostics: [{ message: secret, url: `https://example.test/?key=${secret}`, headers: { Authorization: secret } }],
      }],
    },
  });
  assert.match(text, /operation=get_project/u);
  assert.match(text, /API試行回数=3/u);
  assert.doesNotMatch(text, new RegExp(secret, 'u'));
  assert.doesNotMatch(text, /example\.test|Authorization|stack/u);
});

test('formats an empty collection failure without exposing arbitrary error text', () => {
  assert.equal(formatFailure({ message: 'private' })[0],
    'operation=unknown, target={}, code=UNKNOWN_ERROR, HTTP=未取得, API試行回数=不明');
  assert.match(formatCollectionError({ message: 'private' }), /failed tasks: 0/u);
  assert.doesNotMatch(formatCollectionError({ message: 'private' }), /private/u);
});
