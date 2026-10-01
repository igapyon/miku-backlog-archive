const SAFE_OPERATIONS = new Set([
  'get_project',
  'get_project_users',
  'get_project_statuses',
  'get_categories',
  'get_custom_fields',
  'get_issue_types',
  'get_version_milestone_list',
  'get_issues',
  'get_issue',
  'get_issue_comments',
  'get_issue_participants',
  'get_related_issues',
  'get_wiki_pages',
  'get_wiki',
  'get_wiki_attachments',
  'get_shared_files',
  'download_issue_attachment',
  'download_wiki_attachment',
  'download_shared_file',
]);

const SAFE_CODES = new Set([
  'UPSTREAM_ERROR',
  'RUNTIME_ERROR',
  'LOCAL_ERROR',
  'NOT_FOUND',
  'CONFIGURATION_ERROR',
  'INVALID_INPUT',
  'INVALID_FIELDS',
  'INVALID_ARGUMENT',
  'UNKNOWN_OPERATION',
  'ORGANIZATION_ERROR',
]);

const TARGET_KEYS = [
  'projectId', 'projectKey', 'issueId', 'issueKey', 'wikiId',
  'attachmentId', 'sharedFileId', 'offset', 'minId',
];

function safeInteger(value, minimum) {
  return Number.isSafeInteger(value) && value >= minimum;
}

function normalizeTarget(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const target = {};
  for (const key of TARGET_KEYS) {
    const value = input[key];
    if (key === 'projectId' && Array.isArray(value)
      && value.length > 0 && value.length <= 100
      && value.every((item) => safeInteger(item, 1))) {
      target[key] = [...value];
    } else if (key === 'offset' && safeInteger(value, 0)) {
      target[key] = value;
    } else if (key === 'minId' && safeInteger(value, 1)) {
      target[key] = value;
    } else if (['projectId', 'issueId', 'wikiId', 'attachmentId', 'sharedFileId'].includes(key)
      && safeInteger(value, 1)) {
      target[key] = value;
    } else if (key === 'projectKey' && typeof value === 'string'
      && value.length <= 128 && /^[A-Za-z0-9_]+$/u.test(value)) {
      target[key] = value;
    } else if (key === 'issueKey' && typeof value === 'string'
      && value.length <= 160 && /^[A-Za-z0-9_]+-[1-9][0-9]*$/u.test(value)) {
      target[key] = value;
    }
  }
  return target;
}

/**
 * Return a new diagnostic containing only stable, non-sensitive fields.
 * Runtime messages, URLs, headers, bodies, stacks, and causes are never read.
 *
 * @param {unknown} value
 */
export function normalizeFailure(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const operation = typeof input.operation === 'string' && SAFE_OPERATIONS.has(input.operation)
    ? input.operation
    : input.operation === 'local' ? 'local' : 'unknown';
  const code = typeof input.code === 'string' && SAFE_CODES.has(input.code)
    ? input.code
    : 'UNKNOWN_ERROR';
  const failure = {
    operation,
    target: normalizeTarget(input.target),
    code,
  };
  if (Number.isSafeInteger(input.httpStatus) && input.httpStatus >= 100 && input.httpStatus <= 599) {
    failure.httpStatus = input.httpStatus;
  }
  if (safeInteger(input.requestAttempts, 1)) failure.requestAttempts = input.requestAttempts;
  if (typeof input.retryable === 'boolean') failure.retryable = input.retryable;
  if (typeof input.at === 'string' && input.at.length <= 40
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(input.at)
    && Number.isFinite(Date.parse(input.at))) {
    failure.at = input.at;
  }
  failure.hint = failureHint(failure);
  return failure;
}

/** @param {unknown} value */
export function safeTaskLabel(value) {
  if (typeof value !== 'string') return 'unknown';
  if (['project', 'issue-list', 'wiki-list', 'shared-directory'].includes(value)) return value;
  const patterns = [
    [/^issue:([1-9][0-9]*)$/u, 'issue'],
    [/^wiki:([1-9][0-9]*)$/u, 'wiki'],
    [/^wiki-attachment-list:([1-9][0-9]*)$/u, 'wiki-attachment-list'],
    [/^shared-file:([1-9][0-9]*)$/u, 'shared-file'],
  ];
  for (const [pattern, label] of patterns) {
    const match = pattern.exec(value);
    if (match && safeInteger(Number(match[1]), 1)) return `${label}:${Number(match[1])}`;
  }
  for (const [pattern, label] of [
    [/^issue-attachment:([1-9][0-9]*):([1-9][0-9]*)$/u, 'issue-attachment'],
    [/^wiki-attachment:([1-9][0-9]*):([1-9][0-9]*)$/u, 'wiki-attachment'],
  ]) {
    const match = pattern.exec(value);
    if (match && safeInteger(Number(match[1]), 1) && safeInteger(Number(match[2]), 1)) {
      return `${label}:${Number(match[1])}:${Number(match[2])}`;
    }
  }
  if (/^shared-directory:/u.test(value)) return 'shared-directory';
  return 'unknown';
}

/** @param {Record<string, unknown>} failure */
export function failureHint(failure) {
  const status = failure.httpStatus;
  if (status === 401) return '認証エラーの可能性があります。実行時のAPIキー設定と有効性を確認してください。';
  if (status === 403) return 'アクセスが拒否されました。プロジェクトの閲覧権限やアクセス制限を確認してください。';
  if (status === 404) return '対象不在、参照先の不一致、または閲覧できない対象の可能性があります。対象ID・キー・権限を確認してください。';
  if (status === 408) return '要求がタイムアウトしました。接続状態を確認してください。';
  if (status === 429) return 'Backlogの利用枠が制限されています。保存済みの待機情報を確認し、待機後に同じアーカイブで再開してください。';
  if (status >= 500 && status <= 599) return 'サーバーまたは中継側のエラーの可能性があります。時間を置いた再実行を検討してください。';

  switch (failure.code) {
    case 'CONFIGURATION_ERROR':
      return 'Runtimeの接続設定を確認してください。認証情報そのものは表示していません。';
    case 'INVALID_INPUT':
    case 'INVALID_FIELDS':
    case 'INVALID_ARGUMENT':
      return '操作の入力仕様とarchiveからRuntimeへ渡す引数を確認してください。';
    case 'UNKNOWN_OPERATION':
      return '固定Runtimeの互換性と操作名を確認してください。';
    case 'ORGANIZATION_ERROR':
      return 'Runtimeの結果処理で失敗しました。対象操作とRuntimeの仕様を確認してください。接続原因は特定できていません。';
    case 'LOCAL_ERROR':
      return 'ローカル保存または処理の失敗として確認してください。接続失敗とは断定できません。';
    case 'UPSTREAM_ERROR':
    case 'RUNTIME_ERROR':
      if (Number.isInteger(status) && status >= 100 && status <= 599) {
        return 'HTTP状態は取得済みですが、原因は未特定です。対象・操作の入力仕様・収集状況レポートを確認してください。';
      }
      return 'HTTP状態を取得できず、原因は未特定です。ネットワーク許可、ドメイン、DNS、プロキシ、TLSなどの接続設定を確認してください。';
    default:
      return '原因は未特定です。操作・コード・収集状況レポートを確認してください。';
  }
}

/**
 * Summarize only tasks that are failed now. Historical failure events are not
 * treated as outstanding work.
 *
 * @param {unknown} progress
 * @param {{ limit?: number }} [options]
 */
export function summarizeCurrentFailures(progress, options = {}) {
  const tasks = progress && typeof progress === 'object' && progress.tasks
    && typeof progress.tasks === 'object' && !Array.isArray(progress.tasks)
    ? progress.tasks
    : {};
  const failed = Object.entries(tasks)
    .filter(([, task]) => task && typeof task === 'object' && task.state === 'failed')
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  const limit = safeInteger(options.limit, 1) ? options.limit : 5;
  const failures = failed.slice(0, limit).map(([key, task]) => ({
    task: safeTaskLabel(key),
    ...normalizeFailure(task.failure),
  }));
  return {
    failedTaskCount: failed.length,
    failures,
    omittedFailureCount: Math.max(0, failed.length - failures.length),
  };
}

/** @param {unknown} value */
export function formatFailure(failure) {
  const safe = normalizeFailure(failure);
  const taskLabel = safeTaskLabel(failure?.task);
  const taskPrefix = taskLabel === 'unknown' ? '' : `task=${taskLabel}, `;
  const status = safe.httpStatus === undefined ? '未取得' : String(safe.httpStatus);
  const attempts = safe.requestAttempts === undefined ? '不明' : String(safe.requestAttempts);
  const target = JSON.stringify(safe.target);
  return [
    `${taskPrefix}operation=${safe.operation}, target=${target}, code=${safe.code}, HTTP=${status}, API試行回数=${attempts}`,
    safe.hint,
  ];
}

/** @param {unknown} error */
export function formatCollectionError(error) {
  const value = error && typeof error === 'object' ? error : {};
  const summary = value.collectionDiagnostics
    && typeof value.collectionDiagnostics === 'object'
    ? value.collectionDiagnostics
    : null;
  const failedTaskCount = safeInteger(summary?.failedTaskCount, 0) ? summary.failedTaskCount : 0;
  const failures = Array.isArray(summary?.failures)
    ? summary.failures.slice(0, 5).map(formatFailure)
    : [];
  const omitted = Math.max(
    safeInteger(summary?.omittedFailureCount, 0) ? summary.omittedFailureCount : 0,
    failedTaskCount - failures.length,
    0,
  );
  const lines = [`Collection is incomplete (failed tasks: ${failedTaskCount}).`, ...failures.flat()];
  if (omitted > 0) lines.push(`ほか${omitted}件。`);
  lines.push(
    '確認: node src/cli.mjs report --archive <directory>',
    '設定を確認した後に、同じアーカイブでcollectを再実行してください。',
  );
  return lines.join('\n');
}
