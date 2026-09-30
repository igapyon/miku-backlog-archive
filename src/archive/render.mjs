import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { writeFileAtomically } from './atomic-write.mjs';
import { ArchiveFormatError } from './format.mjs';
import { verifyArchive } from './session.mjs';

const PROJECT_SCHEMA = 'miku-backlog-archive/project/v1';
const ISSUE_INDEX_SCHEMA = 'miku-backlog-archive/issue-index/v1';
const ISSUE_SCHEMA = 'miku-backlog-archive/issue/v1';
const WIKI_INDEX_SCHEMA = 'miku-backlog-archive/wiki-index/v1';
const WIKI_SCHEMA = 'miku-backlog-archive/wiki/v1';
const SHARED_FILE_INDEX_SCHEMA = 'miku-backlog-archive/shared-file-index/v1';
const ASSET_INDEX_SCHEMA = 'miku-backlog-archive/asset-index/v1';

export class ArchiveRenderError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ArchiveRenderError';
  }
}

const STYLE = `:root {
  color-scheme: light dark;
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  line-height: 1.55;
}
body { margin: 0; background: Canvas; color: CanvasText; }
header, main { max-width: 72rem; margin: auto; padding: 1rem 1.25rem; }
header { border-bottom: 1px solid color-mix(in srgb, CanvasText 20%, transparent); }
h1 { margin: 0; font-size: 1.45rem; }
h2 { margin-top: 2rem; }
nav { display: flex; flex-wrap: wrap; gap: .8rem; margin-top: .75rem; }
a { color: LinkText; }
table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
th, td { border: 1px solid color-mix(in srgb, CanvasText 20%, transparent); padding: .45rem .6rem; text-align: left; vertical-align: top; }
th { background: color-mix(in srgb, CanvasText 8%, transparent); }
.body { white-space: normal; overflow-wrap: anywhere; }
.muted { color: color-mix(in srgb, CanvasText 65%, Canvas); }
.meta { display: grid; grid-template-columns: max-content 1fr; gap: .35rem .8rem; }
.meta dt { font-weight: 600; }
.attachments { padding-left: 1.25rem; }
.attachment-preview { display: block; max-width: min(100%, 48rem); max-height: 32rem; margin: .5rem 0 1rem; border: 1px solid color-mix(in srgb, CanvasText 20%, transparent); }
.inline-image { display: block; max-width: min(100%, 48rem); max-height: 32rem; margin: .5rem 0; border: 1px solid color-mix(in srgb, CanvasText 20%, transparent); }
.thumbnail { max-width: 12rem; max-height: 8rem; }
pre { overflow: auto; padding: .75rem; background: color-mix(in srgb, CanvasText 7%, transparent); }
blockquote { margin: 1rem 0; padding: .1rem 1rem; border-inline-start: .25rem solid color-mix(in srgb, CanvasText 35%, transparent); background: color-mix(in srgb, CanvasText 5%, transparent); }
`;

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

function safeExternalHref(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) {
      return null;
    }
    if (url.protocol !== 'mailto:') {
      url.username = '';
      url.password = '';
    }
    return url.href;
  } catch {
    return null;
  }
}

function renderInternalReferences(value, links) {
  const pieces = value.split(/([A-Za-z][A-Za-z0-9_]*-\d+|#comment-\d+)/gu);
  return pieces.map((piece, index) => {
    if (index % 2 === 0) {
      return escapeHtml(piece).replace(/\r?\n/gu, '<br>');
    }
    if (piece.startsWith('#comment-')) {
      const commentId = Number(piece.slice('#comment-'.length));
      const href = links?.commentIds?.has(commentId) ? piece : null;
      return href
        ? `<a href="${escapeHtml(href)}">${escapeHtml(piece)}</a>`
        : escapeHtml(piece);
    }
    const href = links?.issueKeys?.get(piece);
    return href
      ? `<a href="${escapeHtml(href)}">${escapeHtml(piece)}</a>`
      : escapeHtml(piece);
  }).join('');
}

function localCommentFragment(hash, commentIds) {
  const match = /^#comment-(\d+)$/u.exec(hash);
  if (!match) {
    return null;
  }
  const commentId = Number(match[1]);
  return commentIds?.has(commentId) ? `#comment-${commentId}` : null;
}

function localArchiveHref(value, links) {
  if (!links?.sourceDomain || !links?.projectKey) {
    return null;
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    !['http:', 'https:'].includes(url.protocol)
    || url.hostname !== links.sourceDomain
    || url.port !== ''
  ) {
    return null;
  }

  const issueMatch = /^\/view\/([A-Za-z][A-Za-z0-9_]*-\d+)\/?$/u.exec(url.pathname);
  if (issueMatch) {
    const issueKey = issueMatch[1];
    const issueHref = links.issueKeys?.get(issueKey);
    if (!issueHref || url.search !== '') {
      return null;
    }
    if (url.hash === '') {
      return issueHref;
    }
    const commentHref = localCommentFragment(url.hash, links.commentIdsByIssueKey?.get(issueKey));
    return commentHref ? `${issueHref}${commentHref}` : null;
  }

  const wikiPrefix = `/wiki/${encodeURIComponent(links.projectKey)}`;
  const isProjectWiki = url.pathname === wikiPrefix || url.pathname.startsWith(`${wikiPrefix}/`);
  const pageId = Number(url.searchParams.get('pageId'));
  if (
    isProjectWiki
    && Number.isSafeInteger(pageId)
    && pageId > 0
    && url.hash === ''
    && [...url.searchParams.keys()].every((key) => key === 'pageId')
  ) {
    return links.wikiIds?.get(pageId) ?? null;
  }
  return null;
}

function splitTrailingUrlPunctuation(value) {
  let url = value;
  let suffix = '';
  while (/[.,;:!?]$/u.test(url)) {
    suffix = `${url.at(-1)}${suffix}`;
    url = url.slice(0, -1);
  }
  while (url.endsWith(')')) {
    const opened = (url.match(/\(/gu) ?? []).length;
    const closed = (url.match(/\)/gu) ?? []).length;
    if (closed <= opened) {
      break;
    }
    suffix = `)${suffix}`;
    url = url.slice(0, -1);
  }
  return { url, suffix };
}

function renderExternalLink(value, links, allowLocalArchiveLink = true, label = null) {
  const href = safeExternalHref(value);
  if (!href) {
    return null;
  }
  const localHref = allowLocalArchiveLink ? localArchiveHref(href, links) : null;
  const content = escapeHtml(label ?? href);
  return localHref
    ? `<a href="${escapeHtml(localHref)}">${content}</a>`
    : `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${content}</a>`;
}

function findAttachmentReference(reference, attachmentLinks) {
  if (!attachmentLinks || typeof reference !== 'string') {
    return null;
  }
  if (/^\d+$/u.test(reference)) {
    return attachmentLinks.byId.get(Number(reference)) ?? null;
  }
  return attachmentLinks.byName.get(reference) ?? null;
}

function renderAttachmentMacro(match, attachmentLinks) {
  const imageType = match[1];
  const imageReference = match[2];
  const attachName = match[3];
  const attachId = match[4];
  const markdownAlt = match[5];
  const markdownReference = match[6];
  const reference = imageType
    ? findAttachmentReference(imageReference, attachmentLinks)
    : attachName !== undefined
      ? findAttachmentReference(attachId ?? attachName, attachmentLinks)
      : findAttachmentReference(markdownReference, attachmentLinks);
  if (!reference) {
    return null;
  }
  if (imageType || markdownReference !== undefined) {
    if (!reference.image) {
      return null;
    }
    const alt = escapeHtml(markdownAlt || reference.name);
    const classes = imageType === 'thumbnail' ? 'inline-image thumbnail' : 'inline-image';
    return `<a href="${escapeHtml(reference.href)}"><img class="${classes}" src="${escapeHtml(reference.href)}" alt="${alt}" loading="lazy"></a>`;
  }
  return `<a href="${escapeHtml(reference.href)}">${escapeHtml(reference.name)}</a>`;
}

function renderInlineText(value, links, attachmentLinks) {
  const pattern = /#(image|thumbnail)\(([^()\r\n]+)\)|#attach\(([^():\r\n]+)(?::(\d+))?\)|!\[([^\]\r\n]*)\]\[([^\]\r\n]+)\]/gu;
  let result = '';
  let position = 0;
  for (const match of value.matchAll(pattern)) {
    result += renderInternalReferences(value.slice(position, match.index), links);
    result += renderAttachmentMacro(match, attachmentLinks) ?? escapeHtml(match[0]);
    position = match.index + match[0].length;
  }
  return `${result}${renderInternalReferences(value.slice(position), links)}`;
}

function renderText(value, links, attachmentLinks) {
  if (typeof value !== 'string' || value === '') {
    return '<span class="muted">—</span>';
  }
  const pattern = /!\[[^\]\r\n]*\]\((https?:\/\/[^\s<>"')]+|mailto:[^\s<>"')]+)\)|(?<!!)\[([^\]\r\n]+)\]\((https?:\/\/[^\s<>"')]+|mailto:[^\s<>"')]+)\)|(https?:\/\/[^\s<>"']+|mailto:[^\s<>"']+)/gu;
  let result = '';
  let position = 0;
  for (const match of value.matchAll(pattern)) {
    result += renderInlineText(value.slice(position, match.index), links, attachmentLinks);
    if (match[1] !== undefined) {
      const externalImage = renderExternalLink(match[1], links, false);
      result += externalImage ?? escapeHtml(match[0]);
    } else if (match[3] !== undefined) {
      const markdownLink = renderExternalLink(match[3], links, true, match[2]);
      result += markdownLink ?? escapeHtml(match[0]);
    } else {
      const { url, suffix } = splitTrailingUrlPunctuation(match[4]);
      result += renderExternalLink(url, links) ?? escapeHtml(url);
      result += escapeHtml(suffix);
    }
    position = match.index + match[0].length;
  }
  return `${result}${renderInlineText(value.slice(position), links, attachmentLinks)}`;
}

function blockType(line) {
  if (/^```/u.test(line)) return 'code';
  if (/^#{1,6}\s+/u.test(line)) return 'heading';
  if (/^>\s?/u.test(line)) return 'quote';
  if (/^[-*+]\s+/u.test(line)) return 'unordered-list';
  if (/^\d+\.\s+/u.test(line)) return 'ordered-list';
  return null;
}

function renderBody(value, links, attachmentLinks) {
  if (typeof value !== 'string' || value === '') {
    return '<p class="muted">—</p>';
  }
  const lines = value.replace(/\r\n?/gu, '\n').split('\n');
  const blocks = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line.trim() === '') {
      index += 1;
      continue;
    }
    const type = blockType(line);
    if (type === 'code') {
      const code = [];
      index += 1;
      while (index < lines.length && !/^```/u.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }
    if (type === 'heading') {
      const match = /^(#{1,6})\s+(.+)$/u.exec(line);
      const level = match[1].length;
      blocks.push(`<h${level}>${renderText(match[2], links, attachmentLinks)}</h${level}>`);
      index += 1;
      continue;
    }
    if (type === 'quote') {
      const quoteLines = [];
      while (index < lines.length && /^>\s?/u.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^>\s?/u, ''));
        index += 1;
      }
      blocks.push(`<blockquote><p>${renderText(quoteLines.join('\n'), links, attachmentLinks)}</p></blockquote>`);
      continue;
    }
    if (type === 'unordered-list' || type === 'ordered-list') {
      const pattern = type === 'unordered-list' ? /^[-*+]\s+(.+)$/u : /^\d+\.\s+(.+)$/u;
      const items = [];
      while (index < lines.length) {
        const match = pattern.exec(lines[index]);
        if (!match) break;
        items.push(`<li>${renderText(match[1], links, attachmentLinks)}</li>`);
        index += 1;
      }
      const tag = type === 'unordered-list' ? 'ul' : 'ol';
      blocks.push(`<${tag}>${items.join('')}</${tag}>`);
      continue;
    }
    const paragraph = [line];
    index += 1;
    while (index < lines.length && lines[index].trim() !== '' && blockType(lines[index]) === null) {
      paragraph.push(lines[index]);
      index += 1;
    }
    blocks.push(`<p>${renderText(paragraph.join('\n'), links, attachmentLinks)}</p>`);
  }
  return blocks.join('\n');
}

function page(title, depth, body) {
  const prefix = depth === 0 ? '' : '../'.repeat(depth);
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} | miku-backlog-archive</title>
  <link rel="stylesheet" href="${prefix}assets/style.css">
</head>
<body>
  <header>
    <h1>${escapeHtml(title)}</h1>
    <nav aria-label="アーカイブ内メニュー">
      <a href="${prefix}index.html">ホーム</a>
      <a href="${prefix}issues/index.html">課題</a>
      <a href="${prefix}wikis/index.html">Wiki</a>
      <a href="${prefix}files/index.html">ファイル</a>
    </nav>
  </header>
  <main>${body}</main>
</body>
</html>
`;
}

async function readJson(path, label) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new ArchiveRenderError(`Required collected ${label} is missing.`);
    }
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ArchiveRenderError(`Collected ${label} is not valid JSON.`);
  }
}

function requireArray(value, label) {
  if (!Array.isArray(value)) {
    throw new ArchiveRenderError(`Collected ${label} has an unsupported format.`);
  }
  return value;
}

function requirePositiveId(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ArchiveRenderError(`Collected ${label} has an invalid id.`);
  }
  return value;
}

function assetHref(asset, depth) {
  if (!asset || typeof asset.localPath !== 'string' || !asset.localPath.startsWith('assets/')) {
    return null;
  }
  const segments = asset.localPath.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return null;
  }
  return `${'../'.repeat(depth + 1)}${asset.localPath}`;
}

function isPreviewableImage(name) {
  return typeof name === 'string' && /\.(?:avif|bmp|gif|jpe?g|png|webp)$/iu.test(name);
}

function attachmentReferenceMap(attachments, assets, depth) {
  const assetsById = new Map(assets.map((asset) => [asset.attachmentId, asset]));
  const byId = new Map();
  const byName = new Map();
  for (const attachment of attachments) {
    const href = assetHref(assetsById.get(attachment.id), depth);
    if (!href) {
      continue;
    }
    const reference = {
      href,
      name: display(attachment.name, `添付 ${attachment.id}`),
      image: isPreviewableImage(attachment.name),
    };
    byId.set(attachment.id, reference);
    if (typeof attachment.name === 'string' && attachment.name !== '') {
      byName.set(attachment.name, byName.has(attachment.name) ? null : reference);
    }
  }
  return { byId, byName };
}

function attachmentList(attachments, assets, depth) {
  if (attachments.length === 0) {
    return '<p class="muted">添付ファイルはありません。</p>';
  }
  const byId = new Map(assets.map((asset) => [asset.attachmentId, asset]));
  return `<ul class="attachments">${attachments.map((attachment) => {
    const asset = byId.get(attachment.id);
    const href = assetHref(asset, depth);
    const name = escapeHtml(display(attachment.name, `添付 ${attachment.id}`));
    const link = href ? `<a href="${escapeHtml(href)}">${name}</a>` : name;
    const preview = href && isPreviewableImage(attachment.name)
      ? `<img class="attachment-preview" src="${escapeHtml(href)}" alt="${name}" loading="lazy">`
      : '';
    return `<li>${link} <span class="muted">(${escapeHtml(display(attachment.size))})</span>${preview}</li>`;
  }).join('')}</ul>`;
}

function sharedFileList(files, assetsByFileId, depth) {
  if (files.length === 0) {
    return '<p class="muted">共有ファイルはありません。</p>';
  }
  return `<ul class="attachments">${files.map((file) => {
    const href = assetHref(assetsByFileId.get(file.id), depth);
    const name = escapeHtml(display(file.name, `共有ファイル ${file.id}`));
    return `<li>${href ? `<a href="${escapeHtml(href)}">${name}</a>` : name} <span class="muted">(${escapeHtml(display(file.size))})</span></li>`;
  }).join('')}</ul>`;
}

function personName(person) {
  return person && typeof person === 'object' ? display(person.name) : '—';
}

function displayName(value) {
  if (typeof value === 'string' || typeof value === 'number') {
    return display(value);
  }
  return value && typeof value === 'object' ? display(value.name) : '—';
}

function displayNames(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return '—';
  }
  return values.map(displayName).join(', ');
}

function renderJson(value) {
  if (value === null || value === undefined) {
    return '<span class="muted">—</span>';
  }
  try {
    return `<pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre>`;
  } catch {
    return '<span class="muted">表示できない値です。</span>';
  }
}

function issuePage(
  issueData,
  issueAssets,
  sharedAssetsByFileId,
  issueIds,
  textLinks,
  issueLinksById,
  childIssues,
) {
  const issue = issueData.issue;
  const comments = requireArray(issueData.comments, 'issue comments');
  const attachments = requireArray(issue.attachments, 'issue attachments');
  const participants = requireArray(issueData.participants, 'issue participants');
  const relatedIssues = requireArray(issueData.relatedIssues, 'related issues');
  const issueId = requirePositiveId(issue.id, 'issue');
  const related = relatedIssues.length === 0
    ? '<p class="muted">関連課題はありません。</p>'
    : `<ul>${relatedIssues.map((relatedIssue) => {
      const targetId = Number.isSafeInteger(relatedIssue.id) && issueIds.has(relatedIssue.id)
        ? `<a href="${relatedIssue.id}.html">${escapeHtml(display(relatedIssue.issueKey, relatedIssue.id))}</a>`
        : escapeHtml(display(relatedIssue.issueKey, relatedIssue.id));
      return `<li>${targetId}: ${escapeHtml(display(relatedIssue.summary))}</li>`;
    }).join('')}</ul>`;
  const parentIssueId = Number.isSafeInteger(issue.parentIssueId) && issueIds.has(issue.parentIssueId)
    ? issue.parentIssueId
    : null;
  const children = childIssues.get(issue.id) ?? [];
  const attachmentLinks = attachmentReferenceMap(attachments, issueAssets, 1);
  const bodyLinks = { ...textLinks, commentIds: new Set(comments.map((comment) => comment.id)) };
  return page(`${display(issue.issueKey, issueId)}: ${display(issue.summary)}`, 1, `
    <dl class="meta">
      <dt>状態</dt><dd>${escapeHtml(display(issue.status?.name))}</dd>
      <dt>種別</dt><dd>${escapeHtml(displayName(issue.issueType))}</dd>
      <dt>優先度</dt><dd>${escapeHtml(displayName(issue.priority))}</dd>
      <dt>完了理由</dt><dd>${escapeHtml(displayName(issue.resolution))}</dd>
      <dt>担当者</dt><dd>${escapeHtml(personName(issue.assignee))}</dd>
      <dt>カテゴリー</dt><dd>${escapeHtml(displayNames(issue.category))}</dd>
      <dt>バージョン</dt><dd>${escapeHtml(displayNames(issue.versions))}</dd>
      <dt>マイルストーン</dt><dd>${escapeHtml(displayNames(issue.milestone))}</dd>
      <dt>開始日</dt><dd>${escapeHtml(display(issue.startDate))}</dd>
      <dt>期限日</dt><dd>${escapeHtml(display(issue.dueDate))}</dd>
      <dt>見積時間</dt><dd>${escapeHtml(display(issue.estimatedHours))}</dd>
      <dt>実績時間</dt><dd>${escapeHtml(display(issue.actualHours))}</dd>
      <dt>作成</dt><dd>${escapeHtml(display(issue.created))} ${escapeHtml(personName(issue.createdUser))}</dd>
      <dt>更新</dt><dd>${escapeHtml(display(issue.updated))} ${escapeHtml(personName(issue.updatedUser))}</dd>
    </dl>
    <h2>説明</h2>
    <div class="body">${renderBody(issue.description, bodyLinks, attachmentLinks)}</div>
    <h2>添付ファイル</h2>
    ${attachmentList(attachments, issueAssets, 1)}
    <h2>共有ファイル</h2>
    ${sharedFileList(requireArray(issue.sharedFiles, 'issue shared files'), sharedAssetsByFileId, 1)}
    <h2>参加者</h2>
    ${participants.length === 0 ? '<p class="muted">参加者はいません。</p>' : `<ul>${participants.map((participant) => `<li>${escapeHtml(personName(participant))}</li>`).join('')}</ul>`}
    <h2>カスタム項目</h2>
    ${renderJson(requireArray(issue.customFields, 'issue custom fields'))}
    <h2>親子課題</h2>
    <dl class="meta">
      <dt>親課題</dt><dd>${parentIssueId === null ? '—' : `<a href="${parentIssueId}.html">${escapeHtml(display(issueLinksById.get(issue.parentIssueId)))}</a>`}</dd>
    </dl>
    ${children.length === 0 ? '<p class="muted">子課題はありません。</p>' : `<h3>子課題</h3><ul>${children.map((child) => `<li><a href="${child.id}.html">${escapeHtml(display(child.issueKey, child.id))}</a>: ${escapeHtml(display(child.summary))}</li>`).join('')}</ul>`}
    <h2>関連課題</h2>
    ${related}
    <h2>コメント</h2>
    ${comments.length === 0 ? '<p class="muted">コメントはありません。</p>' : comments.map((comment) => `
      <section>
        <h3 id="comment-${requirePositiveId(comment.id, 'comment')}"><a href="#comment-${comment.id}">#${comment.id}</a> ${escapeHtml(personName(comment.createdUser))} <span class="muted">${escapeHtml(display(comment.created))}${comment.updated && comment.updated !== comment.created ? ` / 更新 ${escapeHtml(comment.updated)}` : ''}</span></h3>
        <div class="body">${renderBody(comment.content, bodyLinks, attachmentLinks)}</div>
        ${comment.changeLog === null || comment.changeLog === undefined ? '' : `<details><summary>変更記録</summary>${renderJson(comment.changeLog)}</details>`}
      </section>`).join('')}
  `);
}

function wikiPage(wikiData, wikiAssets, sharedAssetsByFileId, textLinks) {
  const wiki = wikiData.wiki;
  const wikiId = requirePositiveId(wiki.id, 'wiki');
  const attachments = requireArray(wiki.attachments, 'wiki attachments');
  const attachmentLinks = attachmentReferenceMap(attachments, wikiAssets, 1);
  return page(display(wiki.name, `Wiki ${wikiId}`), 1, `
    <dl class="meta">
      <dt>タグ</dt><dd>${escapeHtml(displayNames(wiki.tags))}</dd>
      <dt>作成</dt><dd>${escapeHtml(display(wiki.created))} ${escapeHtml(personName(wiki.createdUser))}</dd>
      <dt>更新</dt><dd>${escapeHtml(display(wiki.updated))} ${escapeHtml(personName(wiki.updatedUser))}</dd>
    </dl>
    <h2>本文</h2>
    <div class="body">${renderBody(wiki.content, textLinks, attachmentLinks)}</div>
    <h2>添付ファイル</h2>
    ${attachmentList(attachments, wikiAssets, 1)}
    <h2>共有ファイル</h2>
    ${sharedFileList(requireArray(wiki.sharedFiles, 'wiki shared files'), sharedAssetsByFileId, 1)}
  `);
}

function sharedDirectoryId(path) {
  return `directory-${encodeURIComponent(path)}`;
}

function validSharedDirectory(directory) {
  return directory && typeof directory.path === 'string'
    && typeof directory.parentPath === 'string';
}

function renderSharedFileEntry(file, assetsByFileId) {
  const href = assetHref(assetsByFileId.get(file.id), 1);
  const name = escapeHtml(display(file.name, file.path));
  return `<li>${href ? `<a href="${escapeHtml(href)}">${name}</a>` : name} <span class="muted">(${escapeHtml(display(file.size))})</span></li>`;
}

function renderSharedDirectoryTree(directories, files, assetsByFileId) {
  const nodes = new Map([['/', { directory: { path: '/', name: '/' }, children: [], files: [] }]]);
  for (const directory of directories) {
    if (validSharedDirectory(directory) && directory.path !== '/') {
      nodes.set(directory.path, { directory, children: [], files: [] });
    }
  }
  for (const node of nodes.values()) {
    const parentPath = node.directory.parentPath;
    if (node.directory.path !== '/' && nodes.has(parentPath)) {
      nodes.get(parentPath).children.push(node);
    }
  }
  for (const file of files) {
    if (typeof file?.parentPath === 'string' && nodes.has(file.parentPath)) {
      nodes.get(file.parentPath).files.push(file);
    } else {
      nodes.get('/').files.push(file);
    }
  }
  const renderNode = (node) => {
    const path = node.directory.path;
    const children = [...node.children].sort((left, right) => left.directory.path.localeCompare(right.directory.path));
    const filesInDirectory = [...node.files].sort((left, right) => String(left.path).localeCompare(String(right.path)));
    return `<section id="${escapeHtml(sharedDirectoryId(path))}">
      <h2>${escapeHtml(path)}</h2>
      ${children.length === 0 && filesInDirectory.length === 0 ? '<p class="muted">このフォルダは空です。</p>' : ''}
      ${children.length === 0 ? '' : `<h3>フォルダ</h3><ul>${children.map((child) => `<li><a href="#${escapeHtml(sharedDirectoryId(child.directory.path))}">${escapeHtml(display(child.directory.name, child.directory.path))}</a></li>`).join('')}</ul>`}
      ${filesInDirectory.length === 0 ? '' : `<h3>ファイル</h3><ul class="attachments">${filesInDirectory.map((file) => renderSharedFileEntry(file, assetsByFileId)).join('')}</ul>`}
    </section>${children.map(renderNode).join('')}`;
  };
  return renderNode(nodes.get('/'));
}

/**
 * Render an offline, safe-by-default HTML view using only an already collected
 * archive. This function never contacts Backlog.
 *
 * @param {{ output: string }} input
 */
export async function renderArchive(input) {
  const { paths, manifest } = await verifyArchive(input.output);
  if (manifest.collection?.status !== 'completed') {
    throw new ArchiveFormatError('The archive collection must be completed before rendering.');
  }

  const projectData = await readJson(join(paths.data, 'project.json'), 'project');
  if (!projectData || projectData.schemaVersion !== PROJECT_SCHEMA || !projectData.project) {
    throw new ArchiveRenderError('Collected project has an unsupported format.');
  }
  const issueIndex = await readJson(join(paths.data, 'issues', 'index.json'), 'issue index');
  const issueSummaries = issueIndex?.schemaVersion === ISSUE_INDEX_SCHEMA
    ? requireArray(issueIndex.issues, 'issue index')
    : (() => { throw new ArchiveRenderError('Collected issue index has an unsupported format.'); })();
  const wikiIndex = await readJson(join(paths.data, 'wikis', 'index.json'), 'wiki index');
  const wikiSummaries = wikiIndex?.schemaVersion === WIKI_INDEX_SCHEMA
    ? requireArray(wikiIndex.wikis, 'wiki index')
    : (() => { throw new ArchiveRenderError('Collected wiki index has an unsupported format.'); })();
  const sharedIndex = await readJson(join(paths.data, 'files', 'index.json'), 'shared-file index');
  if (!sharedIndex || sharedIndex.schemaVersion !== SHARED_FILE_INDEX_SCHEMA) {
    throw new ArchiveRenderError('Collected shared-file index has an unsupported format.');
  }
  const sharedDirectories = requireArray(sharedIndex.directories, 'shared-file directories');
  const sharedFiles = requireArray(sharedIndex.files, 'shared files');
  const assetIndex = await readJson(join(paths.data, 'assets', 'index.json'), 'asset index');
  if (!assetIndex || assetIndex.schemaVersion !== ASSET_INDEX_SCHEMA) {
    throw new ArchiveRenderError('Collected asset index has an unsupported format.');
  }
  const issueAssets = requireArray(assetIndex.issueAttachments, 'issue assets');
  const wikiAssets = requireArray(assetIndex.wikiAttachments, 'wiki assets');
  const sharedAssets = requireArray(assetIndex.sharedFiles, 'shared assets');
  const sharedAssetsByFileId = new Map(sharedAssets.map((asset) => [asset.sharedFileId, asset]));

  const issues = [];
  for (const summary of issueSummaries) {
    const id = requirePositiveId(summary.id, 'issue index');
    const data = await readJson(join(paths.data, 'issues', `${id}.json`), `issue ${id}`);
    if (!data || data.schemaVersion !== ISSUE_SCHEMA || !data.issue || data.issue.id !== id) {
      throw new ArchiveRenderError(`Collected issue ${id} has an unsupported format.`);
    }
    issues.push(data);
  }
  const wikis = [];
  for (const summary of wikiSummaries) {
    const id = requirePositiveId(summary.id, 'wiki index');
    const data = await readJson(join(paths.data, 'wikis', `${id}.json`), `wiki ${id}`);
    if (!data || data.schemaVersion !== WIKI_SCHEMA || !data.wiki || data.wiki.id !== id) {
      throw new ArchiveRenderError(`Collected wiki ${id} has an unsupported format.`);
    }
    wikis.push(data);
  }

  await writeFileAtomically(join(paths.site, 'assets', 'style.css'), STYLE);
  const issueIds = new Set(issues.map(({ issue }) => issue.id));
  const commentIdsByIssueKey = new Map(
    issues.map(({ issue, comments }) => [issue.issueKey, new Set(comments.map((comment) => comment.id))]),
  );
  const makeTextLinks = (issueHref, wikiHref) => ({
    sourceDomain: manifest.source.domain,
    projectKey: projectData.project.projectKey,
    issueKeys: new Map(issues.map(({ issue }) => [issue.issueKey, issueHref(issue)])),
    wikiIds: new Map(wikis.map(({ wiki }) => [wiki.id, wikiHref(wiki)])),
    commentIdsByIssueKey,
  });
  const textLinksFromHome = makeTextLinks(
    (issue) => `issues/${issue.id}.html`,
    (wiki) => `wikis/${wiki.id}.html`,
  );
  const textLinksFromIssue = makeTextLinks(
    (issue) => `${issue.id}.html`,
    (wiki) => `../wikis/${wiki.id}.html`,
  );
  const issueLinksById = new Map(
    issues.map(({ issue }) => [issue.id, issue.issueKey]),
  );
  const childIssues = new Map();
  for (const { issue } of issues) {
    if (Number.isSafeInteger(issue.parentIssueId) && issueIds.has(issue.parentIssueId)) {
      childIssues.set(issue.parentIssueId, [
        ...(childIssues.get(issue.parentIssueId) ?? []),
        issue,
      ]);
    }
  }
  const textLinksFromWiki = makeTextLinks(
    (issue) => `../issues/${issue.id}.html`,
    (wiki) => `${wiki.id}.html`,
  );
  await writeFileAtomically(join(paths.site, 'index.html'), page(projectData.project.name, 0, `
    <p>${renderText(projectData.project.description, textLinksFromHome)}</p>
    <dl class="meta">
      <dt>プロジェクト</dt><dd>${escapeHtml(display(projectData.project.projectKey))}</dd>
      <dt>取得元</dt><dd>${escapeHtml(display(manifest.source?.domain))}</dd>
      <dt>取得開始</dt><dd>${escapeHtml(display(manifest.collection?.startedAt))}</dd>
      <dt>取得完了</dt><dd>${escapeHtml(display(manifest.collection?.completedAt))}</dd>
      <dt>課題</dt><dd>${issues.length}</dd>
      <dt>Wiki</dt><dd>${wikis.length}</dd>
      <dt>共有ファイル</dt><dd>${sharedFiles.length}</dd>
      <dt>保存ファイル</dt><dd>${escapeHtml(display(manifest.collection?.counts?.assets, issueAssets.length + wikiAssets.length + sharedAssets.length))}</dd>
    </dl>
  `));
  await writeFileAtomically(join(paths.site, 'issues', 'index.html'), page('課題', 1, `
    <table><thead><tr><th>キー</th><th>件名</th><th>状態</th><th>担当者</th><th>更新</th></tr></thead><tbody>
      ${issues.map(({ issue }) => `<tr><td><a href="${issue.id}.html">${escapeHtml(display(issue.issueKey))}</a></td><td>${escapeHtml(display(issue.summary))}</td><td>${escapeHtml(displayName(issue.status))}</td><td>${escapeHtml(personName(issue.assignee))}</td><td>${escapeHtml(display(issue.updated))}</td></tr>`).join('')}
    </tbody></table>
  `));
  for (const issueData of issues) {
    const assets = issueAssets.filter((asset) => asset.issueId === issueData.issue.id);
    await writeFileAtomically(
      join(paths.site, 'issues', `${issueData.issue.id}.html`),
      issuePage(
        issueData,
        assets,
        sharedAssetsByFileId,
        issueIds,
        textLinksFromIssue,
        issueLinksById,
        childIssues,
      ),
    );
  }
  await writeFileAtomically(join(paths.site, 'wikis', 'index.html'), page('Wiki', 1, `
    <table><thead><tr><th>題名</th><th>タグ</th><th>更新</th></tr></thead><tbody>
      ${wikis.map(({ wiki }) => `<tr><td><a href="${wiki.id}.html">${escapeHtml(display(wiki.name))}</a></td><td>${escapeHtml(displayNames(wiki.tags))}</td><td>${escapeHtml(display(wiki.updated))}</td></tr>`).join('')}
    </tbody></table>
  `));
  for (const wikiData of wikis) {
    const assets = wikiAssets.filter((asset) => asset.wikiId === wikiData.wiki.id);
    await writeFileAtomically(
      join(paths.site, 'wikis', `${wikiData.wiki.id}.html`),
      wikiPage(wikiData, assets, sharedAssetsByFileId, textLinksFromWiki),
    );
  }
  await writeFileAtomically(join(paths.site, 'files', 'index.html'), page('ファイル', 1, `
    <p><a href="#${sharedDirectoryId('/')}">ルートフォルダへ</a></p>
    ${renderSharedDirectoryTree(sharedDirectories, sharedFiles, sharedAssetsByFileId)}
  `));

  return { issueCount: issues.length, wikiCount: wikis.length, sharedFileCount: sharedFiles.length };
}
