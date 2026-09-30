import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { renderArchive } from '../src/archive/render.mjs';
import { initializeArchive } from '../src/archive/session.mjs';

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
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
      description: '# 見出し\n\n- DEMO-1\n- #image(401)\n\n> 引用\n\n```\n#image(401)\n```\n\n<script>alert(1)</script> See DEMO-1, #image(401), #thumbnail(issue.png), #attach(issue.png:401), ![inline][issue.png], #image(資料 & <.png), #image(duplicate.png), #image(999), ![external](https://example.test/remote.png), and https://user:secret@example.test/path. See https://example.backlog.com/view/DEMO-1#comment-500 and https://example.backlog.com/view/DEMO-2, [child issue](https://example.backlog.com/view/DEMO-2), and [outside guide](https://example.test/guide), but retain https://example.backlog.com/view/DEMO-2?keep=1 and https://other.backlog.com/view/DEMO-2.',
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
      content: 'Do not activate javascript:alert(1). See #comment-500.',
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
      content: 'Wiki body; see DEMO-1, #image(402), and https://example.backlog.com/wiki/DEMO/Overview?pageId=201.',
      tags: ['guide', 'safe'],
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
  assert.match(issueHtml, /2026-09-08T00:01:00Z Editor/);
  assert.match(issueHtml, /<li>Owner<\/li>/);
  assert.match(issueHtml, /&lt;untrusted&gt;/);
  assert.match(issueHtml, /変更記録/);
  assert.match(issueHtml, /href="#comment-500">#500<\/a> Owner/);
  assert.match(issueHtml, /href="#comment-500">#comment-500<\/a>/);
  assert.match(issueHtml, /更新 2026-09-08T00:03:00Z/);
  assert.match(issueHtml, /href="102\.html">DEMO-2<\/a>: Child issue/);
  const childIssueHtml = await readFile(join(output, 'site', 'issues', '102.html'), 'utf8');
  assert.match(childIssueHtml, /href="101\.html">DEMO-1<\/a>/);
  assert.match(issueHtml, /href="\.\.\/\.\.\/assets\/issues\/101\/401-issue\.png"/);
  assert.match(issueHtml, /<img class="attachment-preview" src="\.\.\/\.\.\/assets\/issues\/101\/401-issue\.png" alt="issue\.png" loading="lazy">/);
  assert.match(issueHtml, /<h2>共有ファイル<\/h2>/);
  assert.match(issueHtml, /href="\.\.\/\.\.\/assets\/shared\/601-file\.txt">file\.txt<\/a>/);
  assert.doesNotMatch(issueHtml, /href="javascript:/);

  const wikiHtml = await readFile(join(output, 'site', 'wikis', '201.html'), 'utf8');
  assert.match(wikiHtml, /href="\.\.\/\.\.\/assets\/wikis\/201\/402-wiki\.png"/);
  assert.match(wikiHtml, /<img class="attachment-preview" src="\.\.\/\.\.\/assets\/wikis\/201\/402-wiki\.png" alt="wiki\.png" loading="lazy">/);
  assert.match(wikiHtml, /href="\.\.\/\.\.\/assets\/shared\/601-file\.txt">file\.txt<\/a>/);
  assert.match(wikiHtml, /href="\.\.\/issues\/101\.html">DEMO-1<\/a>/);
  assert.match(wikiHtml, /href="201\.html">https:\/\/example\.backlog\.com\/wiki\/DEMO\/Overview\?pageId=201<\/a>/);
  assert.match(wikiHtml, /<a href="\.\.\/\.\.\/assets\/wikis\/201\/402-wiki\.png"><img class="inline-image" src="\.\.\/\.\.\/assets\/wikis\/201\/402-wiki\.png" alt="wiki\.png" loading="lazy"><\/a>/);
  assert.match(wikiHtml, /<dt>タグ<\/dt><dd>guide, safe<\/dd>/);
  assert.match(wikiHtml, /2026-09-08T00:02:00Z Editor/);
  const fileHtml = await readFile(join(output, 'site', 'files', 'index.html'), 'utf8');
  assert.match(fileHtml, /href="\.\.\/\.\.\/assets\/shared\/601-file\.txt"/);
  assert.match(fileHtml, /id="directory-%2Fnested%2F"/);
  assert.match(fileHtml, /href="#directory-%2Fnested%2F">nested<\/a>/);
  const homeHtml = await readFile(join(output, 'site', 'index.html'), 'utf8');
  assert.match(homeHtml, /href="issues\/index\.html"/);
  assert.match(homeHtml, /<dt>取得元<\/dt><dd>example\.backlog\.com<\/dd>/);
  assert.match(homeHtml, /2026-09-08T00:01:00.000Z/);
  assert.match(homeHtml, /<dt>保存ファイル<\/dt><dd>6<\/dd>/);
  const issueIndexHtml = await readFile(join(output, 'site', 'issues', 'index.html'), 'utf8');
  assert.match(issueIndexHtml, /<th>状態<\/th><th>担当者<\/th><th>更新<\/th>/);
  assert.match(issueIndexHtml, /<td>Open<\/td><td>—<\/td><td>2026-09-08T00:01:00Z<\/td>/);
  const wikiIndexHtml = await readFile(join(output, 'site', 'wikis', 'index.html'), 'utf8');
  assert.match(wikiIndexHtml, /<th>タグ<\/th>/);
  assert.match(wikiIndexHtml, /guide, safe/);
  for (const relativePath of [
    'index.html',
    'issues/index.html',
    'issues/101.html',
    'issues/102.html',
    'wikis/index.html',
    'wikis/201.html',
    'files/index.html',
  ]) {
    await assertFileReferences(join(output, 'site', relativePath));
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
