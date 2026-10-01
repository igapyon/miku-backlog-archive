import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { initializeArchive } from '../../src/archive/session.mjs';

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
  'base64',
);

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Create deterministic, offline viewing data without Backlog credentials.
 * The destination must be missing or empty; initializeArchive enforces this.
 *
 * @param {string} output
 */
export async function createViewingFixture(output) {
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
    project: { id: 8, projectKey: 'DEMO', name: 'Demo', description: 'Project description' },
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
      description: '# 見出し\n\n- DEMO-1\n- #image(401)\n\n> 引用\n\n```\n#image(401)\n```\n\n<script>alert(1)</script> See DEMO-1, #image(401), #thumbnail(issue.png), #attach(issue.png:401), ![inline][issue.png], #image(資料 #100% & <.png), #image(duplicate.png), #image(999), ![external](https://example.test/remote.png), and https://user:secret@example.test/path. See https://example.backlog.com/view/DEMO-1#comment-500 and https://example.backlog.com/view/DEMO-2, [child issue](https://example.backlog.com/view/DEMO-2), [shared manual](https://example.backlog.com/downloadSharedFile/DEMO/601/file.txt), [uncollected shared](https://example.backlog.com/downloadSharedFile/DEMO/602/missing.txt), [other project shared](https://example.backlog.com/downloadSharedFile/OTHER/601/file.txt), and [outside guide](https://example.test/guide), but retain https://example.backlog.com/view/DEMO-2?keep=1 and https://other.backlog.com/view/DEMO-2.',
      attachments: [
        { id: 401, name: 'issue.png', size: TINY_PNG.byteLength },
        { id: 403, name: '資料 #100% & <.png', size: TINY_PNG.byteLength },
        { id: 404, name: 'duplicate.png', size: TINY_PNG.byteLength },
        { id: 405, name: 'duplicate.png', size: TINY_PNG.byteLength },
      ],
      sharedFiles: [{ id: 601, name: 'file.txt', size: 11 }],
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
      attachments: [{ id: 402, name: 'wiki.png', size: TINY_PNG.byteLength }],
      sharedFiles: [{ id: 601, name: 'file.txt', size: 11 }],
    },
  });
  await writeJson(join(paths.data, 'files', 'index.json'), {
    schemaVersion: 'miku-backlog-archive/shared-file-index/v1',
    directories: [
      { path: '/', parentPath: null, name: '/' },
      { path: '/nested/', parentPath: '/', name: 'nested' },
    ],
    files: [{ id: 601, parentPath: '/nested/', path: '/nested/file.txt', name: 'file.txt', size: 11 }],
  });
  await writeJson(join(paths.data, 'assets', 'index.json'), {
    schemaVersion: 'miku-backlog-archive/asset-index/v1',
    issueAttachments: [
      { issueId: 101, attachmentId: 401, localPath: 'assets/issues/101/401-issue.png' },
      { issueId: 101, attachmentId: 403, localPath: 'assets/issues/101/403-資料 #100%-&.png' },
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
    writeFile(join(paths.assets, 'issues', '101', '401-issue.png'), TINY_PNG),
    writeFile(join(paths.assets, 'issues', '101', '403-資料 #100%-&.png'), TINY_PNG),
    writeFile(join(paths.assets, 'issues', '101', '404-first.png'), TINY_PNG),
    writeFile(join(paths.assets, 'issues', '101', '405-second.png'), TINY_PNG),
    writeFile(join(paths.assets, 'wikis', '201', '402-wiki.png'), TINY_PNG),
    writeFile(join(paths.assets, 'shared', '601-file.txt'), 'shared file'),
  ]);
  return { output, paths, imageBytes: TINY_PNG };
}
