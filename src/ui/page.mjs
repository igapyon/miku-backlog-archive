import { access } from 'node:fs/promises';
import { join } from 'node:path';

import { formatJstTimestamp } from '../archive/time.mjs';

const NAVIGATION = [
  { id: 'home', label: 'ホーム', href: 'index.html' },
  { id: 'issues', label: '課題', href: 'issues/index.html' },
  { id: 'wikis', label: 'Wiki', href: 'wikis/index.html' },
  { id: 'files', label: 'ファイル', href: 'files/index.html' },
  { id: 'report', label: '収集状況', href: 'collection-status.html' },
];

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;');
}

function renderNavigation(items, activeSection, currentIsPage, depth) {
  if (!Array.isArray(items) || items.length === 0) {
    return '';
  }
  const prefix = depth === 0 ? '' : '../'.repeat(depth);
  return `<nav class="primary-navigation" aria-label="アーカイブ内メニュー"><ul>${items.map((item) => {
    const current = item.id === activeSection;
    const currentAttribute = current
      ? ` aria-current="${currentIsPage ? 'page' : 'location'}"`
      : '';
    return `<li><a href="${prefix}${escapeHtml(item.href)}"${currentAttribute}>${escapeHtml(item.label)}</a></li>`;
  }).join('')}</ul></nav>`;
}

function renderCompletedAt(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    return '';
  }
  return `<p class="archive-timestamp">取得完了 <time datetime="${escapeHtml(value)}">${escapeHtml(formatJstTimestamp(value))}</time></p>`;
}

/**
 * Render a complete static page shell with local styles and native navigation.
 *
 * @param {string} title
 * @param {number} depth
 * @param {string} body
 * @param {{ projectName?: string, completedAt?: string, activeSection?: string, currentIsPage?: boolean, navigation?: Array<{id:string,label:string,href:string}> }} [options]
 */
export function renderPage(title, depth, body, options = {}) {
  const prefix = depth === 0 ? '' : '../'.repeat(depth);
  const projectName = options.projectName || 'Backlog アーカイブ';
  const navigation = options.navigation ?? NAVIGATION;
  const home = navigation.find((item) => item.id === 'home');
  const brand = home
    ? `<a class="app-header__brand" href="${prefix}${escapeHtml(home.href)}">${escapeHtml(projectName)}</a>`
    : `<span class="app-header__brand">${escapeHtml(projectName)}</span>`;
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>${escapeHtml(title)} | ${escapeHtml(projectName)} | miku-backlog-archive</title>
  <link rel="stylesheet" href="${prefix}assets/style.css">
</head>
<body>
  <a class="skip-link" href="#main-content">本文へ移動</a>
  <header class="app-header">
    <div class="app-header__inner">
      <div class="app-header__identity">
        ${brand}
        <p>保存済みの読み取り用アーカイブ</p>
      </div>
      ${renderCompletedAt(options.completedAt)}
    </div>
      ${renderNavigation(navigation, options.activeSection, options.currentIsPage !== false, depth)}
  </header>
  <main id="main-content" class="main-content" tabindex="-1">
    <header class="page-heading"><h1>${escapeHtml(title)}</h1></header>
    <div class="page-content">${body}</div>
  </main>
</body>
</html>
`;
}

export async function existingArchiveNavigation(siteDirectory) {
  const available = await Promise.all(NAVIGATION.map(async (item) => {
    try {
      await access(join(siteDirectory, item.href));
      return item;
    } catch {
      return null;
    }
  }));
  return available.filter(Boolean).map((item) => ({ ...item }));
}
