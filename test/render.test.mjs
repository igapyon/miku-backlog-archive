import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { renderArchive } from '../src/archive/render.mjs';
import { renderCollectionReport } from '../src/archive/report.mjs';
import { initializeArchive } from '../src/archive/session.mjs';
import { formatJstTimestamp } from '../src/archive/time.mjs';

test('formats UTC timestamps in JST and keeps invalid values readable', () => {
  assert.equal(formatJstTimestamp('2022-08-23T04:38:51Z'), '2022-08-23 13:38:51 JST');
  assert.equal(formatJstTimestamp('not-a-timestamp'), 'not-a-timestamp');
  assert.equal(formatJstTimestamp(null), '—');
});

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function addWiki(output, id, name, content = '') {
  const wikiIndexPath = join(output, 'data', 'wikis', 'index.json');
  const wikiIndex = JSON.parse(await readFile(wikiIndexPath, 'utf8'));
  wikiIndex.wikis.push({ id, projectId: 8, name });
  await writeJson(wikiIndexPath, wikiIndex);
  await writeJson(join(output, 'data', 'wikis', `${id}.json`), {
    schemaVersion: 'miku-backlog-archive/wiki/v1',
    wiki: {
      id,
      projectId: 8,
      name,
      content,
      attachments: [],
      sharedFiles: [],
    },
  });
}

async function assertFileReferences(pagePath) {
  const html = await readFile(pagePath, 'utf8');
  const referencePattern = /\b(href|src)="([^"]+)"/gu;
  for (const match of html.matchAll(referencePattern)) {
    const [, attribute, reference] = match;
    if (/^(?:https?|mailto):/iu.test(reference)) {
      assert.equal(attribute, 'href', `${pagePath} must not load an external resource.`);
      continue;
    }
    const target = new URL(reference, pathToFileURL(pagePath));
    assert.equal(target.protocol, 'file:', `${pagePath} has a non-file local reference: ${reference}`);
    await access(fileURLToPath(target));
  }
}

async function preparedArchive(t) {
  const directory = await mkdtemp(join(tmpdir(), 'miku-backlog-archive-render-test-'));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const output = join(directory, 'archive');
  const { paths } = await initializeArchive({
    output,
    domain: 'example.backlog.com',
    projectKey: 'DEMO',
    now: new Date('2026-09-08T00:00:00.000Z'),
  });
  const manifest = JSON.parse(await readFile(paths.manifest, 'utf8'));
  manifest.source.project.id = 8;
  manifest.collection.status = 'completed';
  manifest.collection.startedAt = '2026-09-08T00:00:00.000Z';
  manifest.collection.completedAt = '2026-09-08T00:01:00.000Z';
  manifest.collection.counts = { issues: 2, wikis: 1, sharedFiles: 1, assets: 6 };
  await writeJson(paths.manifest, manifest);
  const progress = JSON.parse(await readFile(paths.progress, 'utf8'));
  progress.phase = 'completed';
  await writeJson(paths.progress, progress);

  await writeJson(join(paths.data, 'project.json'), {
    schemaVersion: 'miku-backlog-archive/project/v1',
    project: {
      id: 8,
      projectKey: 'DEMO',
      name: 'Demo',
      description: 'Project description',
    },
  });
  await writeJson(join(paths.data, 'issues', 'index.json'), {
    schemaVersion: 'miku-backlog-archive/issue-index/v1',
    issues: [
      { id: 101, projectId: 8, issueKey: 'DEMO-1', summary: 'First issue' },
      { id: 102, projectId: 8, issueKey: 'DEMO-2', summary: 'Child issue' },
    ],
  });
  await writeJson(join(paths.data, 'issues', '101.json'), {
    schemaVersion: 'miku-backlog-archive/issue/v1',
    issue: {
      id: 101,
      projectId: 8,
      issueKey: 'DEMO-1',
      summary: 'First issue',
      description: '# 見出し\n\n- DEMO-1\n- #image(401)\n\n> 引用\n\n```\n#image(401)\n```\n\n<script>alert(1)</script> See DEMO-1, #image(401), #thumbnail(issue.png), #attach(issue.png:401), ![inline][issue.png], #image(資料 & <.png), #image(duplicate.png), #image(999), ![external](https://example.test/remote.png), and https://user:secret@example.test/path. See https://example.backlog.com/view/DEMO-1#comment-500 and https://example.backlog.com/view/DEMO-2, [child issue](https://example.backlog.com/view/DEMO-2), [shared manual](https://example.backlog.com/downloadSharedFile/DEMO/601/file.txt), [uncollected shared](https://example.backlog.com/downloadSharedFile/DEMO/602/missing.txt), [other project shared](https://example.backlog.com/downloadSharedFile/OTHER/601/file.txt), and [outside guide](https://example.test/guide), but retain https://example.backlog.com/view/DEMO-2?keep=1 and https://other.backlog.com/view/DEMO-2.',
      attachments: [
        { id: 401, name: 'issue.png', size: 3 },
        { id: 403, name: '資料 & <.png', size: 4 },
        { id: 404, name: 'duplicate.png', size: 5 },
        { id: 405, name: 'duplicate.png', size: 6 },
      ],
      sharedFiles: [{ id: 601, name: 'file.txt', size: 5 }],
      issueType: { name: '課題' },
      status: { name: 'Open' },
      priority: { name: '高' },
      category: [{ name: '運用' }],
      versions: [{ name: '1.0' }],
      milestone: [],
      customFields: [{ id: 1, name: '安全な値', value: '<untrusted>' }],
      updated: '2026-09-08T00:01:00Z',
      createdUser: { id: 1, userId: 'owner', name: 'Owner' },
      updatedUser: { id: 2, userId: 'editor', name: 'Editor' },
      assignee: null,
    },
    comments: [{
      id: 500,
      issueId: 101,
      projectId: 8,
      content: 'Do not activate javascript:alert(1). See #comment-500 and [comment file](/downloadSharedFile/DEMO/601/file.txt).',
      changeLog: [{ field: 'status', newValue: 'Open' }],
      createdUser: { id: 1, userId: 'owner', name: 'Owner' },
      created: '2026-09-08T00:00:00Z',
      updated: '2026-09-08T00:03:00Z',
    }],
    participants: [{ id: 1, userId: 'owner', name: 'Owner' }],
    relatedIssues: [],
  });
  await writeJson(join(paths.data, 'issues', '102.json'), {
    schemaVersion: 'miku-backlog-archive/issue/v1',
    issue: {
      id: 102,
      projectId: 8,
      issueKey: 'DEMO-2',
      summary: 'Child issue',
      parentIssueId: 101,
      attachments: [],
      sharedFiles: [],
      customFields: [],
    },
    comments: [],
    participants: [],
    relatedIssues: [],
  });
  await writeJson(join(paths.data, 'wikis', 'index.json'), {
    schemaVersion: 'miku-backlog-archive/wiki-index/v1',
    wikis: [{ id: 201, projectId: 8, name: 'Overview' }],
  });
  await writeJson(join(paths.data, 'wikis', '201.json'), {
    schemaVersion: 'miku-backlog-archive/wiki/v1',
    wiki: {
      id: 201,
      projectId: 8,
      name: 'Overview',
      content: 'Wiki body; see DEMO-1, #image(402), and https://example.backlog.com/wiki/DEMO/Overview?pageId=201. Shared file: https://example.backlog.com/downloadSharedFile/DEMO/601/file.txt.',
      tags: [{ id: 12, name: 'guide' }, { id: 13, name: 'safe & <tag>' }],
      updated: '2026-09-08T00:02:00Z',
      createdUser: { id: 1, userId: 'owner', name: 'Owner' },
      updatedUser: { id: 2, userId: 'editor', name: 'Editor' },
      attachments: [{ id: 402, name: 'wiki.png', size: 4 }],
      sharedFiles: [{ id: 601, name: 'file.txt', size: 5 }],
    },
  });
  await writeJson(join(paths.data, 'files', 'index.json'), {
    schemaVersion: 'miku-backlog-archive/shared-file-index/v1',
    directories: [
      { path: '/', parentPath: null, name: '/' },
      { path: '/nested/', parentPath: '/', name: 'nested' },
    ],
    files: [{ id: 601, parentPath: '/nested/', path: '/nested/file.txt', name: 'file.txt', size: 5 }],
  });
  await writeJson(join(paths.data, 'assets', 'index.json'), {
    schemaVersion: 'miku-backlog-archive/asset-index/v1',
    issueAttachments: [
      { issueId: 101, attachmentId: 401, localPath: 'assets/issues/101/401-issue.png' },
      { issueId: 101, attachmentId: 403, localPath: 'assets/issues/101/403-special.png' },
      { issueId: 101, attachmentId: 404, localPath: 'assets/issues/101/404-first.png' },
      { issueId: 101, attachmentId: 405, localPath: 'assets/issues/101/405-second.png' },
    ],
    wikiAttachments: [{
      wikiId: 201, attachmentId: 402, localPath: 'assets/wikis/201/402-wiki.png',
    }],
    sharedFiles: [{ sharedFileId: 601, localPath: 'assets/shared/601-file.txt' }],
  });
  await Promise.all([
    mkdir(join(paths.assets, 'issues', '101'), { recursive: true }),
    mkdir(join(paths.assets, 'wikis', '201'), { recursive: true }),
    mkdir(join(paths.assets, 'shared'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(paths.assets, 'issues', '101', '401-issue.png'), 'issue image'),
    writeFile(join(paths.assets, 'issues', '101', '403-special.png'), 'special image'),
    writeFile(join(paths.assets, 'issues', '101', '404-first.png'), 'first duplicate image'),
    writeFile(join(paths.assets, 'issues', '101', '405-second.png'), 'second duplicate image'),
    writeFile(join(paths.assets, 'wikis', '201', '402-wiki.png'), 'wiki image'),
    writeFile(join(paths.assets, 'shared', '601-file.txt'), 'shared file'),
  ]);
  return output;
}

test('renders a safe offline site from completed collected data', async (t) => {
  const output = await preparedArchive(t);
  assert.deepEqual(await renderArchive({ output }), {
    issueCount: 2,
    wikiCount: 1,
    sharedFileCount: 1,
  });

  const issueHtml = await readFile(join(output, 'site', 'issues', '101.html'), 'utf8');
  assert.match(issueHtml, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(issueHtml, /<script>alert/);
  assert.match(issueHtml, /<h1>見出し<\/h1>/);
  assert.match(issueHtml, /<ul><li><a href="101\.html">DEMO-1<\/a><\/li>/);
  assert.match(issueHtml, /<blockquote><p>引用<\/p><\/blockquote>/);
  assert.match(issueHtml, /<pre><code>#image\(401\)<\/code><\/pre>/);
  assert.match(issueHtml, /href="https:\/\/example\.test\/path"/);
  assert.doesNotMatch(issueHtml, /secret/);
  assert.match(issueHtml, /href="101\.html">DEMO-1<\/a>/);
  assert.match(issueHtml, /href="101\.html#comment-500">https:\/\/example\.backlog\.com\/view\/DEMO-1#comment-500<\/a>/);
  assert.match(issueHtml, /href="102\.html">https:\/\/example\.backlog\.com\/view\/DEMO-2<\/a>/);
  assert.match(issueHtml, /href="102\.html">child issue<\/a>/);
  assert.match(issueHtml, /href="https:\/\/example\.test\/guide" target="_blank" rel="noopener noreferrer">outside guide<\/a>/);
  assert.match(issueHtml, /href="\.\.\/\.\.\/assets\/shared\/601-file\.txt">shared manual<\/a>/);
  assert.match(issueHtml, /href="https:\/\/example\.backlog\.com\/downloadSharedFile\/DEMO\/602\/missing\.txt" target="_blank" rel="noopener noreferrer">uncollected shared<\/a>/);
  assert.match(issueHtml, /href="https:\/\/example\.backlog\.com\/downloadSharedFile\/OTHER\/601\/file\.txt" target="_blank" rel="noopener noreferrer">other project shared<\/a>/);
  assert.match(issueHtml, /href="https:\/\/example\.backlog\.com\/view\/DEMO-2\?keep=1" target="_blank"/);
  assert.match(issueHtml, /href="https:\/\/other\.backlog\.com\/view\/DEMO-2" target="_blank"/);
  assert.match(issueHtml, /<a href="\.\.\/\.\.\/assets\/issues\/101\/401-issue\.png"><img class="inline-image" src="\.\.\/\.\.\/assets\/issues\/101\/401-issue\.png" alt="issue\.png" loading="lazy"><\/a>/);
  assert.match(issueHtml, /class="inline-image thumbnail"/);
  assert.match(issueHtml, /src="\.\.\/\.\.\/assets\/issues\/101\/403-special\.png" alt="資料 &amp; &lt;\.png"/);
  assert.match(issueHtml, /#image\(duplicate\.png\)/);
  assert.match(issueHtml, /#image\(999\)/);
  assert.match(issueHtml, /href="https:\/\/example\.test\/remote\.png" target="_blank"/);
  assert.doesNotMatch(issueHtml, /src="https:\/\/example\.test\/remote\.png"/);
  assert.match(issueHtml, /<dt>種別<\/dt><dd>課題<\/dd>/);
  assert.match(issueHtml, /2026-09-08 09:01:00 JST Editor/);
  assert.match(issueHtml, /<li>Owner<\/li>/);
  assert.match(issueHtml, /&lt;untrusted&gt;/);
  assert.match(issueHtml, /変更記録/);
  assert.match(issueHtml, /href="#comment-500">#500<\/a> Owner/);
  assert.match(issueHtml, /href="#comment-500">#comment-500<\/a>/);
  assert.match(issueHtml, /href="\.\.\/\.\.\/assets\/shared\/601-file\.txt">comment file<\/a>/);
  assert.match(issueHtml, /更新 2026-09-08 09:03:00 JST/);
  assert.match(issueHtml, /href="102\.html">DEMO-2<\/a>: Child issue/);
  const childIssueHtml = await readFile(join(output, 'site', 'issues', '102.html'), 'utf8');
  assert.match(childIssueHtml, /href="101\.html">DEMO-1<\/a>/);
  assert.match(issueHtml, /href="\.\.\/\.\.\/assets\/issues\/101\/401-issue\.png"/);
  assert.match(issueHtml, /<img class="attachment-preview" src="\.\.\/\.\.\/assets\/issues\/101\/401-issue\.png" alt="issue\.png" loading="lazy">/);
  assert.match(issueHtml, /<h2>共有ファイル<\/h2>/);
  assert.match(issueHtml, /href="\.\.\/\.\.\/assets\/shared\/601-file\.txt">file\.txt<\/a>/);
  assert.doesNotMatch(issueHtml, /href="javascript:/);
  assert.match(issueHtml, /href="\.\.\/collection-status\.html">収集状況<\/a>/);

  const wikiHtml = await readFile(join(output, 'site', 'wikis', '201.html'), 'utf8');
  assert.match(wikiHtml, /href="\.\.\/\.\.\/assets\/wikis\/201\/402-wiki\.png"/);
  assert.match(wikiHtml, /<img class="attachment-preview" src="\.\.\/\.\.\/assets\/wikis\/201\/402-wiki\.png" alt="wiki\.png" loading="lazy">/);
  assert.match(wikiHtml, /href="\.\.\/\.\.\/assets\/shared\/601-file\.txt">file\.txt<\/a>/);
  assert.match(wikiHtml, /href="\.\.\/issues\/101\.html">DEMO-1<\/a>/);
  assert.match(wikiHtml, /href="\.\.\/\.\.\/assets\/shared\/601-file\.txt">https:\/\/example\.backlog\.com\/downloadSharedFile\/DEMO\/601\/file\.txt<\/a>\./);
  assert.match(wikiHtml, /href="201\.html">https:\/\/example\.backlog\.com\/wiki\/DEMO\/Overview\?pageId=201<\/a>/);
  assert.match(wikiHtml, /<a href="\.\.\/\.\.\/assets\/wikis\/201\/402-wiki\.png"><img class="inline-image" src="\.\.\/\.\.\/assets\/wikis\/201\/402-wiki\.png" alt="wiki\.png" loading="lazy"><\/a>/);
  assert.match(wikiHtml, /<dt>タグ<\/dt><dd>guide, safe &amp; &lt;tag&gt;<\/dd>/);
  assert.match(wikiHtml, /2026-09-08 09:02:00 JST Editor/);
  const fileHtml = await readFile(join(output, 'site', 'files', 'index.html'), 'utf8');
  assert.match(fileHtml, /href="\.\.\/\.\.\/assets\/shared\/601-file\.txt"/);
  assert.match(fileHtml, /id="directory-%2Fnested%2F"/);
  assert.match(fileHtml, /href="#directory-%2Fnested%2F">nested<\/a>/);
  const homeHtml = await readFile(join(output, 'site', 'index.html'), 'utf8');
  assert.match(homeHtml, /href="issues\/index\.html"/);
  assert.match(homeHtml, /href="collection-status\.html">収集状況<\/a>/);
  assert.match(homeHtml, /<dt>取得元<\/dt><dd>example\.backlog\.com<\/dd>/);
  assert.match(homeHtml, /2026-09-08 09:01:00 JST/);
  assert.match(homeHtml, /<dt>保存ファイル<\/dt><dd>6<\/dd>/);
  const issueIndexHtml = await readFile(join(output, 'site', 'issues', 'index.html'), 'utf8');
  assert.match(issueIndexHtml, /<th>状態<\/th><th>担当者<\/th><th>更新<\/th>/);
  assert.match(issueIndexHtml, /<td>Open<\/td><td>—<\/td><td>2026-09-08 09:01:00 JST<\/td>/);
  const wikiIndexHtml = await readFile(join(output, 'site', 'wikis', 'index.html'), 'utf8');
  assert.match(wikiIndexHtml, /<th>タグ<\/th>/);
  assert.match(wikiIndexHtml, /guide, safe &amp; &lt;tag&gt;/);
  for (const relativePath of [
    'index.html',
    'issues/index.html',
    'issues/101.html',
    'issues/102.html',
    'wikis/index.html',
    'wikis/201.html',
    'files/index.html',
    'collection-status.html',
  ]) {
    await assertFileReferences(join(output, 'site', relativePath));
  }
});

test('resolves unique Wiki page names in the project, issue descriptions and comments, and Wiki bodies', async (t) => {
  const output = await preparedArchive(t);
  const projectPath = join(output, 'data', 'project.json');
  const project = JSON.parse(await readFile(projectPath, 'utf8'));
  project.project.description = '[[Overview]] and [[Safe & <Rules>]]';
  await writeJson(projectPath, project);

  const issuePath = join(output, 'data', 'issues', '101.json');
  const issue = JSON.parse(await readFile(issuePath, 'utf8'));
  issue.issue.description = [
    '[[Overview]] [[DEMO-1]] [[NotCollected DEMO-1]]',
    '',
    '[[[[Overview]]',
    '',
    '```text',
    '[[Overview]]',
    '```',
    '',
    '[[Overview',
  ].join('\n');
  issue.comments[0].content = '[[Overview]] #comment-500';
  issue.comments.push({ id: 501, content: 'Again [[Overview]] #comment-501' });
  await writeJson(issuePath, issue);

  const wikiIndexPath = join(output, 'data', 'wikis', 'index.json');
  const wikiIndex = JSON.parse(await readFile(wikiIndexPath, 'utf8'));
  wikiIndex.wikis.push({ id: 202, projectId: 8, name: 'Safe & <Rules>' });
  await writeJson(wikiIndexPath, wikiIndex);
  const targetWikiPath = join(output, 'data', 'wikis', '202.json');
  await writeJson(targetWikiPath, {
    schemaVersion: 'miku-backlog-archive/wiki/v1',
    wiki: {
      id: 202,
      projectId: 8,
      name: 'Safe & <Rules>',
      content: '[[Overview]]',
      attachments: [],
      sharedFiles: [],
    },
  });
  const sourceWikiPath = join(output, 'data', 'wikis', '201.json');
  const sourceWiki = JSON.parse(await readFile(sourceWikiPath, 'utf8'));
  sourceWiki.wiki.content = '[[Overview]] and [[Safe & <Rules>]] and [[NotCollected]].';
  await writeJson(sourceWikiPath, sourceWiki);

  await renderArchive({ output });

  const homeHtml = await readFile(join(output, 'site', 'index.html'), 'utf8');
  assert.match(homeHtml, /<a href="wikis\/201\.html">Overview<\/a>/);
  assert.match(homeHtml, /<a href="wikis\/202\.html">Safe &amp; &lt;Rules&gt;<\/a>/);

  const issueHtml = await readFile(join(output, 'site', 'issues', '101.html'), 'utf8');
  assert.equal((issueHtml.match(/<a href="\.\.\/wikis\/201\.html">Overview<\/a>/g) ?? []).length, 3);
  assert.match(issueHtml, /\[\[<a href="101\.html">DEMO-1<\/a>\]\]/);
  assert.match(issueHtml, /\[\[NotCollected DEMO-1\]\]/);
  assert.match(issueHtml, /\[\[\[\[Overview\]\]/);
  assert.match(issueHtml, /<pre><code>\[\[Overview\]\]<\/code><\/pre>/);
  assert.match(issueHtml, /<p>\[\[Overview<\/p>/);
  assert.match(issueHtml, /id="comment-500"/);
  assert.match(issueHtml, /id="comment-501"/);
  assert.match(issueHtml, /<a href="\.\.\/wikis\/201\.html">Overview<\/a> <a href="#comment-500">#comment-500<\/a>/);
  assert.match(issueHtml, /<a href="\.\.\/wikis\/201\.html">Overview<\/a> <a href="#comment-501">#comment-501<\/a>/);

  const wikiHtml = await readFile(join(output, 'site', 'wikis', '201.html'), 'utf8');
  assert.match(wikiHtml, /<a href="201\.html">Overview<\/a> and <a href="202\.html">Safe &amp; &lt;Rules&gt;<\/a>/);
  assert.match(wikiHtml, /\[\[NotCollected\]\]/);
  const targetWikiHtml = await readFile(join(output, 'site', 'wikis', '202.html'), 'utf8');
  assert.match(targetWikiHtml, /<a href="201\.html">Overview<\/a>/);

  for (const relativePath of ['index.html', 'issues/101.html', 'wikis/201.html', 'wikis/202.html']) {
    await assertFileReferences(join(output, 'site', relativePath));
  }

  wikiIndex.wikis.push({ id: 203, projectId: 8, name: 'Overview' });
  await writeJson(wikiIndexPath, wikiIndex);
  await writeJson(join(output, 'data', 'wikis', '203.json'), {
    schemaVersion: 'miku-backlog-archive/wiki/v1',
    wiki: {
      id: 203,
      projectId: 8,
      name: 'Overview',
      content: 'duplicate title',
      attachments: [],
      sharedFiles: [],
    },
  });
  await renderArchive({ output });
  const ambiguousIssueHtml = await readFile(join(output, 'site', 'issues', '101.html'), 'utf8');
  assert.match(ambiguousIssueHtml, /\[\[Overview\]\]/);
  assert.doesNotMatch(ambiguousIssueHtml, /<a href="\.\.\/wikis\/(?:201|203)\.html">Overview<\/a>/);
});

test('continues rendering independent references after malformed Wiki brackets in every body location', async (t) => {
  const output = await preparedArchive(t);
  const projectPath = join(output, 'data', 'project.json');
  const project = JSON.parse(await readFile(projectPath, 'utf8'));
  project.project.description = '[[]] DEMO-2 [[Overview]]\n\n[[unfinished; DEMO-2 [[Overview]]';
  await writeJson(projectPath, project);

  const issuePath = join(output, 'data', 'issues', '101.json');
  const issueData = JSON.parse(await readFile(issuePath, 'utf8'));
  issueData.issue.description = [
    '[[]] DEMO-2 [[Overview]] #image(401)',
    '[[unfinished; DEMO-2 #image(401) [[Overview]]',
    '[[[[Overview]] DEMO-2 [[Overview]]',
    '[[[[unfinished; DEMO-2 #image(401)',
    '[[unfinished\n[[Overview]]',
    '[[Uncollected DEMO-2]]',
  ].join('\n\n');
  issueData.comments[0].content = '[[]] DEMO-2 [[Overview]] #comment-500 #image(401)';
  issueData.comments.push({
    id: 501,
    issueId: 101,
    projectId: 8,
    content: '[[unfinished; DEMO-2 [[Overview]] #comment-501 #image(401)',
  });
  await writeJson(issuePath, issueData);

  const wikiPath = join(output, 'data', 'wikis', '201.json');
  const wikiData = JSON.parse(await readFile(wikiPath, 'utf8'));
  wikiData.wiki.content = '[[]] DEMO-2 [[Overview]] #image(402)\n\n[[unfinished; DEMO-2 #image(402) [[Overview]]';
  await writeJson(wikiPath, wikiData);

  await renderArchive({ output });

  const homeHtml = await readFile(join(output, 'site', 'index.html'), 'utf8');
  assert.match(homeHtml, /<p>\[\[\]\] <a href="issues\/102\.html">DEMO-2<\/a> <a href="wikis\/201\.html">Overview<\/a><br><br>\[\[unfinished; <a href="issues\/102\.html">DEMO-2<\/a> <a href="wikis\/201\.html">Overview<\/a><\/p>/);

  const issueHtml = await readFile(join(output, 'site', 'issues', '101.html'), 'utf8');
  assert.match(issueHtml, /<p>\[\[\]\] <a href="102\.html">DEMO-2<\/a> <a href="\.\.\/wikis\/201\.html">Overview<\/a> <a href="\.\.\/\.\.\/assets\/issues\/101\/401-issue\.png"><img class="inline-image" src="\.\.\/\.\.\/assets\/issues\/101\/401-issue\.png" alt="issue\.png" loading="lazy"><\/a><\/p>/);
  assert.match(issueHtml, /<p>\[\[unfinished; <a href="102\.html">DEMO-2<\/a> <a href="\.\.\/\.\.\/assets\/issues\/101\/401-issue\.png"><img class="inline-image" src="\.\.\/\.\.\/assets\/issues\/101\/401-issue\.png" alt="issue\.png" loading="lazy"><\/a> <a href="\.\.\/wikis\/201\.html">Overview<\/a><\/p>/);
  assert.match(issueHtml, /<p>\[\[\[\[Overview\]\] <a href="102\.html">DEMO-2<\/a> <a href="\.\.\/wikis\/201\.html">Overview<\/a><\/p>/);
  assert.match(issueHtml, /<p>\[\[\[\[unfinished; <a href="102\.html">DEMO-2<\/a> <a href="\.\.\/\.\.\/assets\/issues\/101\/401-issue\.png"><img class="inline-image" src="\.\.\/\.\.\/assets\/issues\/101\/401-issue\.png" alt="issue\.png" loading="lazy"><\/a><\/p>/);
  assert.match(issueHtml, /<p>\[\[unfinished<br><a href="\.\.\/wikis\/201\.html">Overview<\/a><\/p>/);
  assert.match(issueHtml, /<p>\[\[Uncollected DEMO-2\]\]<\/p>/);
  assert.match(issueHtml, /id="comment-500"/);
  assert.match(issueHtml, /id="comment-501"/);
  assert.match(issueHtml, /<a href="#comment-500">#comment-500<\/a>/);
  assert.match(issueHtml, /<a href="#comment-501">#comment-501<\/a>/);
  assert.match(issueHtml, /<a href="\.\.\/wikis\/201\.html">Overview<\/a> <a href="#comment-501">#comment-501<\/a>/);

  const wikiHtml = await readFile(join(output, 'site', 'wikis', '201.html'), 'utf8');
  assert.match(wikiHtml, /<p>\[\[\]\] <a href="\.\.\/issues\/102\.html">DEMO-2<\/a> <a href="201\.html">Overview<\/a> <a href="\.\.\/\.\.\/assets\/wikis\/201\/402-wiki\.png"><img class="inline-image" src="\.\.\/\.\.\/assets\/wikis\/201\/402-wiki\.png" alt="wiki\.png" loading="lazy"><\/a><\/p>/);
  assert.match(wikiHtml, /<p>\[\[unfinished; <a href="\.\.\/issues\/102\.html">DEMO-2<\/a> <a href="\.\.\/\.\.\/assets\/wikis\/201\/402-wiki\.png"><img class="inline-image" src="\.\.\/\.\.\/assets\/wikis\/201\/402-wiki\.png" alt="wiki\.png" loading="lazy"><\/a> <a href="201\.html">Overview<\/a><\/p>/);
});

test('treats URL-bearing Wiki names atomically and preserves separate URL and Markdown links', async (t) => {
  const previousFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error('Archive rendering must not make a network request.');
  };
  t.after(() => {
    globalThis.fetch = previousFetch;
  });

  const output = await preparedArchive(t);
  const wikiName = 'Guide https://example.test/docs';
  await addWiki(output, 202, wikiName, 'target page');

  const description = [
    '[[Guide https://example.test/docs]] [[Unknown https://example.test/missing]]',
    'https://example.test/outside [manual](https://example.test/manual)',
    '[[https://user:secret@example.test/direct]] [[DEMO-1]] #comment-500',
  ].join('\n\n');
  const projectPath = join(output, 'data', 'project.json');
  const project = JSON.parse(await readFile(projectPath, 'utf8'));
  project.project.description = description;
  await writeJson(projectPath, project);

  const issuePath = join(output, 'data', 'issues', '101.json');
  const issueData = JSON.parse(await readFile(issuePath, 'utf8'));
  issueData.issue.description = description;
  issueData.comments[0].content = description;
  issueData.comments.push({ id: 501, issueId: 101, projectId: 8, content: description });
  await writeJson(issuePath, issueData);

  const wikiPath = join(output, 'data', 'wikis', '201.json');
  const wikiData = JSON.parse(await readFile(wikiPath, 'utf8'));
  wikiData.wiki.content = description;
  await writeJson(wikiPath, wikiData);

  await renderArchive({ output });

  const outputs = [
    [await readFile(join(output, 'site', 'index.html'), 'utf8'), 'wikis/202.html', 'issues/101.html', false],
    [await readFile(join(output, 'site', 'issues', '101.html'), 'utf8'), '../wikis/202.html', '101.html', true],
    [await readFile(join(output, 'site', 'wikis', '201.html'), 'utf8'), '202.html', '../issues/101.html', false],
  ];
  outputs.forEach(([html, wikiHref, issueHref, commentLink]) => {
    assert.ok(html.includes(`<a href="${wikiHref}">Guide https://example.test/docs</a>`));
    assert.ok(html.includes('[[Unknown https://example.test/missing]]'));
    assert.ok(html.includes('href="https://example.test/outside" target="_blank"'));
    assert.ok(html.includes('href="https://example.test/manual" target="_blank" rel="noopener noreferrer">manual</a>'));
    assert.ok(html.includes('[[<a href="https://example.test/direct" target="_blank" rel="noopener noreferrer">https://example.test/direct</a>]]'));
    assert.ok(html.includes(`<a href="${issueHref}">DEMO-1</a>`));
    assert.ok(html.includes(commentLink
      ? '<a href="#comment-500">#comment-500</a>'
      : '#comment-500'));
    assert.doesNotMatch(html, /href="https:\/\/example\.test\/(?:docs|missing)\]\]"/);
    assert.doesNotMatch(html, /href="\.\.\/wikis\/202\.html">Unknown/);
  });

  const issueHtml = await readFile(join(output, 'site', 'issues', '101.html'), 'utf8');
  assert.match(issueHtml, /id="comment-500"/);
  assert.match(issueHtml, /id="comment-501"/);
  assert.equal((issueHtml.match(/<a href="\.\.\/wikis\/202\.html">Guide https:\/\/example\.test\/docs<\/a>/g) ?? []).length, 3);

  await addWiki(output, 203, wikiName, 'duplicate target');
  await renderArchive({ output });
  for (const relativePath of ['index.html', 'issues/101.html', 'wikis/201.html']) {
    const html = await readFile(join(output, 'site', relativePath), 'utf8');
    assert.ok(html.includes('[[Guide https://example.test/docs]]'));
    assert.doesNotMatch(html, /href="(?:\.\.\/)?wikis\/(?:202|203)\.html">Guide https:\/\/example\.test\/docs<\/a>/);
    assert.doesNotMatch(html, /href="https:\/\/example\.test\/docs\]\]"/);
  }
  assert.equal(fetchCalls, 0);
});

test('does not report a successful render when the collection report cannot be written', async (t) => {
  const output = await preparedArchive(t);
  await mkdir(join(output, 'site', 'collection-status.html'));

  await assert.rejects(renderArchive({ output }));
});

test('reconciles navigation when report is generated before or after the archive pages', async (t) => {
  const output = await preparedArchive(t);

  await renderCollectionReport({ output });
  const standaloneReport = await readFile(join(output, 'site', 'collection-status.html'), 'utf8');
  assert.match(standaloneReport, /<span class="app-header__brand">DEMO<\/span>/);
  assert.doesNotMatch(standaloneReport, /href="index\.html"/);

  await renderArchive({ output });
  const homeHtml = await readFile(join(output, 'site', 'index.html'), 'utf8');
  assert.match(homeHtml, /href="collection-status\.html">収集状況<\/a>/);
  const reportHtml = await readFile(join(output, 'site', 'collection-status.html'), 'utf8');
  assert.match(reportHtml, /<a class="app-header__brand" href="index\.html">DEMO<\/a>/);
  assert.match(reportHtml, /href="issues\/index\.html">課題<\/a>/);

  await renderCollectionReport({ output });
  await renderArchive({ output });
  const regeneratedReport = await readFile(join(output, 'site', 'collection-status.html'), 'utf8');
  assert.equal((regeneratedReport.match(/href="collection-status\.html" aria-current="page">収集状況<\/a>/g) ?? []).length, 1);
});

test('encodes every asset path segment for file URLs', async (t) => {
  const output = await preparedArchive(t);
  const paths = {
    issue: 'assets/issues/101/401-hash#100%20 spaces & 日本.png',
    wiki: 'assets/wikis/201/402-wiki#100%20 space & 日本.png',
    shared: 'assets/shared/601-shared#100%20 file & 日本.txt',
  };

  const issueDataPath = join(output, 'data', 'issues', '101.json');
  const issueData = JSON.parse(await readFile(issueDataPath, 'utf8'));
  issueData.issue.attachments.find((attachment) => attachment.id === 401).name = 'hash#100%20 spaces & 日本.png';
  await writeJson(issueDataPath, issueData);
  const wikiDataPath = join(output, 'data', 'wikis', '201.json');
  const wikiData = JSON.parse(await readFile(wikiDataPath, 'utf8'));
  wikiData.wiki.attachments[0].name = 'wiki#100%20 space & 日本.png';
  await writeJson(wikiDataPath, wikiData);
  const sharedIndexPath = join(output, 'data', 'files', 'index.json');
  const sharedIndex = JSON.parse(await readFile(sharedIndexPath, 'utf8'));
  sharedIndex.files[0].name = 'shared#100%20 file & 日本.txt';
  await writeJson(sharedIndexPath, sharedIndex);

  const assetIndexPath = join(output, 'data', 'assets', 'index.json');
  const assetIndex = JSON.parse(await readFile(assetIndexPath, 'utf8'));
  assetIndex.issueAttachments.find((asset) => asset.attachmentId === 401).localPath = paths.issue;
  assetIndex.wikiAttachments.find((asset) => asset.attachmentId === 402).localPath = paths.wiki;
  assetIndex.sharedFiles.find((asset) => asset.sharedFileId === 601).localPath = paths.shared;
  await writeJson(assetIndexPath, assetIndex);
  await Promise.all([
    writeFile(join(output, paths.issue), 'issue special'),
    writeFile(join(output, paths.wiki), 'wiki special'),
    writeFile(join(output, paths.shared), 'shared special'),
  ]);

  await renderArchive({ output });
  const issuePage = join(output, 'site', 'issues', '101.html');
  const wikiPage = join(output, 'site', 'wikis', '201.html');
  const filePage = join(output, 'site', 'files', 'index.html');
  const [issueHtml, wikiHtml, fileHtml] = await Promise.all([
    readFile(issuePage, 'utf8'),
    readFile(wikiPage, 'utf8'),
    readFile(filePage, 'utf8'),
  ]);
  assert.match(issueHtml, /assets\/issues\/101\/401-hash%23100%2520%20spaces%20%26%20%E6%97%A5%E6%9C%AC\.png/);
  assert.match(wikiHtml, /assets\/wikis\/201\/402-wiki%23100%2520%20space%20%26%20%E6%97%A5%E6%9C%AC\.png/);
  assert.match(fileHtml, /assets\/shared\/601-shared%23100%2520%20file%20%26%20%E6%97%A5%E6%9C%AC\.txt/);
  await Promise.all([issuePage, wikiPage, filePage].map(assertFileReferences));

  const expectedPaths = [paths.issue, paths.wiki, paths.shared].map((path) => join(output, path));
  const actualPaths = [issuePage, wikiPage, filePage].flatMap((pagePath, index) => {
    const html = [issueHtml, wikiHtml, fileHtml][index];
    return [...html.matchAll(/\b(?:href|src)="([^"]+)"/gu)]
      .map(([, href]) => href.startsWith('http:') || href.startsWith('https:') || href.startsWith('mailto:')
        ? null
        : fileURLToPath(new URL(href, pathToFileURL(pagePath))))
      .filter(Boolean)
      .filter((path) => expectedPaths.includes(path));
  });
  for (const expectedPath of expectedPaths) {
    assert.ok(actualPaths.includes(expectedPath), `generated pages must reference ${expectedPath}`);
  }
});

test('treats empty Markdown list and heading markers as plain text without stalling', async (t) => {
  const output = await preparedArchive(t);
  const issuePath = join(output, 'data', 'issues', '101.json');
  const issue = JSON.parse(await readFile(issuePath, 'utf8'));
  issue.issue.description = '- \n1. \n# \nbody';
  await writeJson(issuePath, issue);

  await renderArchive({ output });

  const html = await readFile(join(output, 'site', 'issues', '101.html'), 'utf8');
  assert.match(html, /<p>- <br>1\. <br># <br>body<\/p>/);
});
