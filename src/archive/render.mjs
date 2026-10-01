import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { writeFileAtomically } from './atomic-write.mjs';
import { ArchiveFormatError } from './format.mjs';
import { verifyArchive } from './session.mjs';
import { formatJstTimestamp } from './time.mjs';
import { renderCollectionReport } from './report.mjs';
import { writeUiAssets } from '../ui/assets.mjs';
import { escapeHtml as importedEscapeHtml, renderPage } from '../ui/page.mjs';

const PROJECT_SCHEMA = 'miku-backlog-archive/project/v1';
const ISSUE_INDEX_SCHEMA = 'miku-backlog-archive/issue-index/v1';
const ISSUE_SCHEMA = 'miku-backlog-archive/issue/v1';
const WIKI_INDEX_SCHEMA = 'miku-backlog-archive/wiki-index/v1';
const WIKI_SCHEMA = 'miku-backlog-archive/wiki/v1';
const SHARED_FILE_INDEX_SCHEMA = 'miku-backlog-archive/shared-file-index/v1';
const ASSET_INDEX_SCHEMA = 'miku-backlog-archive/asset-index/v1';
const EXTERNAL_IMAGE_PATTERN = /!\[[^\]\r\n]*\]\((https?:\/\/[^\s<>"')]+|mailto:[^\s<>"')]+|\/downloadSharedFile\/[^\s<>"')]+)\)/uy;
const MARKDOWN_LINK_PATTERN = /(?<!!)\[([^\]\r\n]+)\]\((https?:\/\/[^\s<>"')]+|mailto:[^\s<>"')]+|\/downloadSharedFile\/[^\s<>"')]+)\)/uy;
const ATTACHMENT_PATTERN = /#(image|thumbnail)\(([^()\r\n]+)\)|#attach\(([^():\r\n]+)(?::(\d+))?\)|!\[([^\]\r\n]*)\]\[([^\]\r\n]+)\]/uy;
const URL_PATTERN = /(https?:\/\/[^\s<>"']+|mailto:[^\s<>"']+|\/downloadSharedFile\/[^\s<>"']+)/uy;
const BRACKETED_URL_PATTERN = /^(?:https?:\/\/|mailto:|\/downloadSharedFile\/)[^\s<>"']+$/u;

export class ArchiveRenderError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ArchiveRenderError';
  }
}

function escapeHtml(value) {
  return importedEscapeHtml(value);
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
    url = value.startsWith('/downloadSharedFile/')
      ? new URL(value, `https://${links.sourceDomain}`)
      : new URL(value);
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

  const sharedFileMatch = /^\/downloadSharedFile\/([^/]+)\/(\d+)\/([^/]+)$/u.exec(url.pathname);
  if (sharedFileMatch && url.search === '' && url.hash === '') {
    let sharedFileProjectKey;
    try {
      sharedFileProjectKey = decodeURIComponent(sharedFileMatch[1]);
    } catch {
      return null;
    }
    const sharedFileId = Number(sharedFileMatch[2]);
    if (
      sharedFileProjectKey === links.projectKey
      && Number.isSafeInteger(sharedFileId)
      && sharedFileId > 0
    ) {
      return assetHref(
        links.sharedFileAssetsById?.get(sharedFileId),
        links.assetDepth,
      );
    }
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
  const localHref = allowLocalArchiveLink ? localArchiveHref(href ?? value, links) : null;
  const content = escapeHtml(label ?? href ?? value);
  if (!href && !localHref) {
    return null;
  }
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

function renderWikiReference(pageName, reference, links) {
  if (links?.issueKeys?.has(pageName)) {
    return renderInternalReferences(reference, links);
  }
  if (BRACKETED_URL_PATTERN.test(pageName)) {
    const link = renderExternalLink(pageName, links);
    return link ? `[[${link}]]` : escapeHtml(reference);
  }
  const wikiIds = links?.wikiNameIds?.get(pageName);
  if (!Array.isArray(wikiIds) || wikiIds.length !== 1) {
    return escapeHtml(reference);
  }
  const href = links.wikiIds?.get(wikiIds[0]);
  return href
    ? `<a href="${escapeHtml(href)}">${escapeHtml(pageName)}</a>`
    : escapeHtml(reference);
}

function bracketLiteral(value, start, end) {
  return { kind: 'literal', raw: value.slice(start, end), end };
}

function readBracketReference(value, start) {
  const contentStart = start + 2;

  if (value.startsWith('[[', contentStart)) {
    let position = contentStart + 2;
    while (position < value.length && value[position] !== '\r' && value[position] !== '\n') {
      if (value.startsWith(']]', position)) {
        return bracketLiteral(value, start, position + 2);
      }
      position += 1;
    }
    let end = start;
    while (value[end] === '[') end += 1;
    return bracketLiteral(value, start, end);
  }

  let hasInnerBracket = false;
  let position = contentStart;
  while (position < value.length && value[position] !== '\r' && value[position] !== '\n') {
    if (value.startsWith(']]', position)) {
      const name = value.slice(contentStart, position);
      if (name === '' || hasInnerBracket) {
        return bracketLiteral(value, start, position + 2);
      }
      const end = position + 2;
      return {
        kind: 'reference',
        raw: value.slice(start, end),
        name,
        end,
      };
    }
    if (value.startsWith('[[', position)) {
      return bracketLiteral(value, start, contentStart);
    }
    if (value[position] === '[' || value[position] === ']') {
      hasInnerBracket = true;
    }
    position += 1;
  }
  return bracketLiteral(value, start, contentStart);
}

function matchAt(pattern, value, position) {
  pattern.lastIndex = position;
  return pattern.exec(value);
}

function readInlineTokenAt(value, position, links, attachmentLinks) {
  if (value.startsWith('[[', position)) {
    const bracket = readBracketReference(value, position);
    const html = bracket.kind === 'reference'
      ? renderWikiReference(bracket.name, bracket.raw, links)
      : escapeHtml(bracket.raw);
    return { html, end: bracket.end };
  }

  const externalImage = matchAt(EXTERNAL_IMAGE_PATTERN, value, position);
  if (externalImage) {
    return {
      html: renderExternalLink(externalImage[1], links) ?? escapeHtml(externalImage[0]),
      end: position + externalImage[0].length,
    };
  }

  const markdownLink = matchAt(MARKDOWN_LINK_PATTERN, value, position);
  if (markdownLink) {
    return {
      html: renderExternalLink(markdownLink[2], links, true, markdownLink[1])
        ?? escapeHtml(markdownLink[0]),
      end: position + markdownLink[0].length,
    };
  }

  const attachment = matchAt(ATTACHMENT_PATTERN, value, position);
  if (attachment) {
    return {
      html: renderAttachmentMacro(attachment, attachmentLinks) ?? escapeHtml(attachment[0]),
      end: position + attachment[0].length,
    };
  }

  const url = matchAt(URL_PATTERN, value, position);
  if (!url) {
    return null;
  }
  const { url: valueWithoutPunctuation, suffix } = splitTrailingUrlPunctuation(url[0]);
  const link = renderExternalLink(valueWithoutPunctuation, links) ?? escapeHtml(valueWithoutPunctuation);
  return {
    html: `${link}${escapeHtml(suffix)}`,
    end: position + url[0].length,
  };
}

function renderText(value, links, attachmentLinks) {
  if (typeof value !== 'string' || value === '') {
    return '<span class="muted">—</span>';
  }
  let result = '';
  let position = 0;
  let plainStart = 0;
  while (position < value.length) {
    const token = readInlineTokenAt(value, position, links, attachmentLinks);
    if (!token) {
      position += 1;
      continue;
    }
    result += renderInternalReferences(value.slice(plainStart, position), links);
    result += token.html;
    position = token.end;
    plainStart = position;
  }
  return `${result}${renderInternalReferences(value.slice(plainStart), links)}`;
}

function blockType(line) {
  if (/^```/u.test(line)) return 'code';
  if (/^#{1,6}\s+.+$/u.test(line)) return 'heading';
  if (/^>\s?/u.test(line)) return 'quote';
  if (/^[-*+]\s+.+$/u.test(line)) return 'unordered-list';
  if (/^\d+\.\s+.+$/u.test(line)) return 'ordered-list';
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

function page(title, depth, body, options = {}) {
  return renderPage(title, depth, body, options);
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
  const encodedPath = segments.map((segment) => encodeURIComponent(segment)).join('/');
  return `${'../'.repeat(depth + 1)}${encodedPath}`;
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
  pageContext,
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
      <dt>作成</dt><dd>${escapeHtml(formatJstTimestamp(issue.created))} ${escapeHtml(personName(issue.createdUser))}</dd>
      <dt>更新</dt><dd>${escapeHtml(formatJstTimestamp(issue.updated))} ${escapeHtml(personName(issue.updatedUser))}</dd>
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
        <h3 id="comment-${requirePositiveId(comment.id, 'comment')}"><a href="#comment-${comment.id}">#${comment.id}</a> ${escapeHtml(personName(comment.createdUser))} <span class="muted">${escapeHtml(formatJstTimestamp(comment.created))}${comment.updated && comment.updated !== comment.created ? ` / 更新 ${escapeHtml(formatJstTimestamp(comment.updated))}` : ''}</span></h3>
        <div class="body">${renderBody(comment.content, bodyLinks, attachmentLinks)}</div>
        ${comment.changeLog === null || comment.changeLog === undefined ? '' : `<details><summary>変更記録</summary>${renderJson(comment.changeLog)}</details>`}
      </section>`).join('')}
  `, { ...pageContext, activeSection: 'issues', currentIsPage: false });
}

function wikiPage(wikiData, wikiAssets, sharedAssetsByFileId, textLinks, pageContext) {
  const wiki = wikiData.wiki;
  const wikiId = requirePositiveId(wiki.id, 'wiki');
  const attachments = requireArray(wiki.attachments, 'wiki attachments');
  const attachmentLinks = attachmentReferenceMap(attachments, wikiAssets, 1);
  return page(display(wiki.name, `Wiki ${wikiId}`), 1, `
    <dl class="meta">
      <dt>タグ</dt><dd>${escapeHtml(displayNames(wiki.tags))}</dd>
      <dt>作成</dt><dd>${escapeHtml(formatJstTimestamp(wiki.created))} ${escapeHtml(personName(wiki.createdUser))}</dd>
      <dt>更新</dt><dd>${escapeHtml(formatJstTimestamp(wiki.updated))} ${escapeHtml(personName(wiki.updatedUser))}</dd>
    </dl>
    <h2>本文</h2>
    <div class="body">${renderBody(wiki.content, textLinks, attachmentLinks)}</div>
    <h2>添付ファイル</h2>
    ${attachmentList(attachments, wikiAssets, 1)}
    <h2>共有ファイル</h2>
    ${sharedFileList(requireArray(wiki.sharedFiles, 'wiki shared files'), sharedAssetsByFileId, 1)}
  `, { ...pageContext, activeSection: 'wikis', currentIsPage: false });
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
  const renderNode = (node, headingLevel = 2) => {
    const path = node.directory.path;
    const children = [...node.children].sort((left, right) => left.directory.path.localeCompare(right.directory.path));
    const filesInDirectory = [...node.files].sort((left, right) => String(left.path).localeCompare(String(right.path)));
    return `<section id="${escapeHtml(sharedDirectoryId(path))}">
      <h${headingLevel}>${escapeHtml(path)}</h${headingLevel}>
      ${children.length === 0 && filesInDirectory.length === 0 ? '<p class="muted">このフォルダは空です。</p>' : ''}
      ${children.length === 0 ? '' : `<h3>フォルダ</h3><ul>${children.map((child) => `<li><a href="#${escapeHtml(sharedDirectoryId(child.directory.path))}">${escapeHtml(display(child.directory.name, child.directory.path))}</a></li>`).join('')}</ul>`}
      ${filesInDirectory.length === 0 ? '' : `<h3>ファイル</h3><ul class="attachments">${filesInDirectory.map((file) => renderSharedFileEntry(file, assetsByFileId)).join('')}</ul>`}
      ${children.map((child) => renderNode(child, Math.min(headingLevel + 1, 6))).join('')}
    </section>`;
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
  const sharedFileAssetsById = new Map(sharedFiles
    .filter((file) => Number.isSafeInteger(file.id) && file.id > 0)
    .map((file) => [file.id, sharedAssetsByFileId.get(file.id)])
    .filter(([, asset]) => asset));

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

  const wikiNameIds = new Map();
  for (const { wiki } of wikis) {
    if (typeof wiki.name !== 'string' || wiki.name === '') {
      continue;
    }
    const ids = wikiNameIds.get(wiki.name) ?? [];
    if (!ids.includes(wiki.id)) {
      ids.push(wiki.id);
    }
    wikiNameIds.set(wiki.name, ids);
  }

  await writeUiAssets(paths.site);
  const pageContext = {
    projectName: display(projectData.project.name, 'Backlog アーカイブ'),
    completedAt: manifest.collection?.completedAt,
  };
  const issueIds = new Set(issues.map(({ issue }) => issue.id));
  const commentIdsByIssueKey = new Map(
    issues.map(({ issue, comments }) => [issue.issueKey, new Set(comments.map((comment) => comment.id))]),
  );
  const makeTextLinks = (issueHref, wikiHref, assetDepth) => ({
    sourceDomain: manifest.source.domain,
    projectKey: projectData.project.projectKey,
    issueKeys: new Map(issues.map(({ issue }) => [issue.issueKey, issueHref(issue)])),
    wikiIds: new Map(wikis.map(({ wiki }) => [wiki.id, wikiHref(wiki)])),
    wikiNameIds,
    commentIdsByIssueKey,
    sharedFileAssetsById,
    assetDepth,
  });
  const textLinksFromHome = makeTextLinks(
    (issue) => `issues/${issue.id}.html`,
    (wiki) => `wikis/${wiki.id}.html`,
    0,
  );
  const textLinksFromIssue = makeTextLinks(
    (issue) => `${issue.id}.html`,
    (wiki) => `../wikis/${wiki.id}.html`,
    1,
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
    1,
  );
  await writeFileAtomically(join(paths.site, 'index.html'), page(projectData.project.name, 0, `
    <p>${renderText(projectData.project.description, textLinksFromHome)}</p>
    <nav class="summary-cards" aria-label="保存内容へのリンク">
      <a class="summary-card" href="issues/index.html"><span class="summary-card__value">${issues.length}</span><span class="summary-card__label">課題を見る</span></a>
      <a class="summary-card" href="wikis/index.html"><span class="summary-card__value">${wikis.length}</span><span class="summary-card__label">Wiki を見る</span></a>
      <a class="summary-card" href="files/index.html"><span class="summary-card__value">${sharedFiles.length}</span><span class="summary-card__label">共有ファイルを見る</span></a>
    </nav>
    <h2>アーカイブ情報</h2>
    <dl class="meta">
      <dt>プロジェクト</dt><dd>${escapeHtml(display(projectData.project.projectKey))}</dd>
      <dt>取得元</dt><dd>${escapeHtml(display(manifest.source?.domain))}</dd>
      <dt>取得開始</dt><dd>${escapeHtml(formatJstTimestamp(manifest.collection?.startedAt))}</dd>
      <dt>取得完了</dt><dd>${escapeHtml(formatJstTimestamp(manifest.collection?.completedAt))}</dd>
      <dt>保存ファイル</dt><dd>${escapeHtml(display(manifest.collection?.counts?.assets, issueAssets.length + wikiAssets.length + sharedAssets.length))}</dd>
    </dl>
  `, { ...pageContext, activeSection: 'home' }));
  await writeFileAtomically(join(paths.site, 'issues', 'index.html'), page('課題', 1, `
    <div class="table-scroll" role="region" aria-label="課題一覧" tabindex="0"><table><caption>課題一覧（${issues.length}件）</caption><thead><tr><th>キー</th><th>件名</th><th>状態</th><th>担当者</th><th>更新</th></tr></thead><tbody>
      ${issues.map(({ issue }) => `<tr><td><a href="${issue.id}.html">${escapeHtml(display(issue.issueKey))}</a></td><td>${escapeHtml(display(issue.summary))}</td><td>${escapeHtml(displayName(issue.status))}</td><td>${escapeHtml(personName(issue.assignee))}</td><td>${escapeHtml(formatJstTimestamp(issue.updated))}</td></tr>`).join('')}
    </tbody></table></div>
  `, { ...pageContext, activeSection: 'issues' }));
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
        pageContext,
      ),
    );
  }
  await writeFileAtomically(join(paths.site, 'wikis', 'index.html'), page('Wiki', 1, `
    <div class="table-scroll" role="region" aria-label="Wiki 一覧" tabindex="0"><table><caption>Wiki 一覧（${wikis.length}件）</caption><thead><tr><th>題名</th><th>タグ</th><th>更新</th></tr></thead><tbody>
      ${wikis.map(({ wiki }) => `<tr><td><a href="${wiki.id}.html">${escapeHtml(display(wiki.name))}</a></td><td>${escapeHtml(displayNames(wiki.tags))}</td><td>${escapeHtml(formatJstTimestamp(wiki.updated))}</td></tr>`).join('')}
    </tbody></table></div>
  `, { ...pageContext, activeSection: 'wikis' }));
  for (const wikiData of wikis) {
    const assets = wikiAssets.filter((asset) => asset.wikiId === wikiData.wiki.id);
    await writeFileAtomically(
      join(paths.site, 'wikis', `${wikiData.wiki.id}.html`),
      wikiPage(wikiData, assets, sharedAssetsByFileId, textLinksFromWiki, pageContext),
    );
  }
  await writeFileAtomically(join(paths.site, 'files', 'index.html'), page('ファイル', 1, `
    <p><a class="button-link" href="#${sharedDirectoryId('/')}">ルートフォルダへ</a></p>
    ${renderSharedDirectoryTree(sharedDirectories, sharedFiles, sharedAssetsByFileId)}
  `, { ...pageContext, activeSection: 'files' }));

  await renderCollectionReport({ output: paths.root });

  return { issueCount: issues.length, wikiCount: wikis.length, sharedFileCount: sharedFiles.length };
}
