import { join } from 'node:path';

import { writeFileAtomically } from './atomic-write.mjs';
import { verifyArchive } from './session.mjs';
import { formatJstTimestamp } from './time.mjs';
import { writeUiAssets } from '../ui/assets.mjs';
import { existingArchiveNavigation, renderPage } from '../ui/page.mjs';

const REPORT_PATH = 'collection-status.html';
const SAFE_TARGET_KEYS = new Set([
  'projectId', 'projectKey', 'issueId', 'issueKey', 'wikiId', 'attachmentId',
  'sharedFileId', 'offset', 'minId',
]);

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;');
}

function display(value, fallback = '—') {
  return value === null || value === undefined || value === '' ? fallback : String(value);
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function safeTarget(value) {
  const target = record(value);
  const result = {};
  for (const [key, item] of Object.entries(target)) {
    if (!SAFE_TARGET_KEYS.has(key)) {
      continue;
    }
    if (typeof item === 'string' || typeof item === 'number') {
      result[key] = item;
    } else if (Array.isArray(item) && item.every((entry) => typeof entry === 'number')) {
      result[key] = item;
    }
  }
  return result;
}

function renderTarget(value) {
  const target = safeTarget(value);
  return Object.keys(target).length === 0
    ? '<span class="muted">—</span>'
    : `<pre>${escapeHtml(JSON.stringify(target, null, 2))}</pre>`;
}

function failedTasks(progress) {
  const tasks = record(progress.tasks);
  return Object.entries(tasks)
    .filter(([, value]) => record(value).state === 'failed')
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => ({ key, task: record(value), failure: record(record(value).failure) }));
}

function rateLimitWait(progress) {
  const waiting = record(progress.waiting);
  if (waiting.category === 'read' || waiting.category === 'search') {
    const reason = waiting.reason === 'rate-limit'
      ? '429の待機'
      : waiting.reason === 'quota' ? '残り枠の待機' : '送信間隔の調整';
    return `${waiting.category}枠、${reason}、${formatJstTimestamp(waiting.retryAt)}以降に再開`;
  }
  const rateLimit = record(progress.rateLimit);
  for (const category of ['read', 'search']) {
    const bucket = record(rateLimit[category]);
    const blockedUntil = bucket.blockedUntil;
    const blockedAt = typeof blockedUntil === 'string' ? Date.parse(blockedUntil) : NaN;
    if (Number.isFinite(blockedAt) && blockedAt > Date.now()) {
      const reason = bucket.blockedReason === 'quota' ? '残り枠の待機' : '429の待機';
      return `${category}枠、${reason}、${formatJstTimestamp(blockedUntil)}以降に再開`;
    }
  }
  return null;
}

/**
 * Generate a local, safe status report without contacting Backlog. Unlike the
 * archive renderer, this report is also available for incomplete collections.
 *
 * @param {{ output: string }} input
 */
export async function renderCollectionReport(input) {
  const { paths, manifest, progress } = await verifyArchive(input.output);
  const failures = failedTasks(progress);
  const waitStatus = rateLimitWait(progress);
  const reportPath = join(paths.site, REPORT_PATH);
  await writeUiAssets(paths.site);
  const navigation = manifest.collection?.status === 'completed'
    ? (await existingArchiveNavigation(paths.site)).filter((item) => item.id !== 'report')
    : [];
  navigation.push({ id: 'report', label: '収集状況', href: REPORT_PATH });
  const rows = failures.map(({ key, failure }) => `
      <tr>
        <td>${escapeHtml(key)}</td>
        <td>${escapeHtml(display(failure.operation))}</td>
        <td>${renderTarget(failure.target)}</td>
        <td>${escapeHtml(display(failure.code))}</td>
        <td>${escapeHtml(display(failure.httpStatus))}</td>
        <td>${failure.retryable === true ? 'はい' : failure.retryable === false ? 'いいえ' : '—'}</td>
        <td>${escapeHtml(display(failure.requestAttempts))}</td>
        <td>${escapeHtml(formatJstTimestamp(failure.at))}</td>
      </tr>`).join('');
  await writeFileAtomically(reportPath, renderPage('収集状況', 0, `
    <p>このページは保存済みの manifest と進捗記録から生成します。Backlog へは接続しません。</p>
    <dl class="meta">
      <dt>プロジェクト</dt><dd>${escapeHtml(display(manifest.source?.project?.key))}</dd>
      <dt>取得元</dt><dd>${escapeHtml(display(manifest.source?.domain))}</dd>
      <dt>収集状態</dt><dd>${escapeHtml(display(manifest.collection?.status))}</dd>
      <dt>進捗フェーズ</dt><dd>${escapeHtml(display(progress.phase))}</dd>
      <dt>進捗更新</dt><dd>${escapeHtml(formatJstTimestamp(progress.updatedAt))}</dd>
      <dt>API待機</dt><dd>${escapeHtml(display(waitStatus, '待機なし'))}</dd>
      <dt>再開が必要なタスク</dt><dd>${failures.length}</dd>
    </dl>
    <h2>失敗タスク</h2>
    ${failures.length === 0 ? '<p class="muted">再開が必要な失敗タスクはありません。</p>' : `
      <div class="table-scroll" role="region" aria-label="失敗タスク一覧" tabindex="0"><table>
        <caption>失敗タスク（${failures.length}件）</caption>
        <thead><tr><th>タスク</th><th>操作</th><th>対象</th><th>コード</th><th>HTTP</th><th>再試行可</th><th>API 試行回数</th><th>記録時刻</th></tr></thead>
        <tbody>${rows}
        </tbody>
      </table></div>`}
  `, {
    projectName: manifest.source?.project?.name ?? manifest.source?.project?.key ?? 'Backlog アーカイブ',
    completedAt: manifest.collection?.completedAt,
    activeSection: 'report',
    navigation,
  }));
  return {
    path: reportPath,
    collectionStatus: manifest.collection?.status ?? null,
    phase: progress.phase,
    failedTaskCount: failures.length,
  };
}
