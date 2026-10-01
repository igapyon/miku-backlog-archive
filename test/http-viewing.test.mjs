import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import test from 'node:test';
import { inflateSync } from 'node:zlib';

import { renderArchive } from '../src/archive/render.mjs';
import { createViewingFixture } from './helpers/viewing-fixture.mjs';
import { startStaticServer } from './helpers/static-server.mjs';

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function assertFixturePng(bytes) {
  assert.deepEqual(bytes.subarray(0, 8), Buffer.from('89504e470d0a1a0a', 'hex'));
  const chunks = [];
  const imageData = [];
  let offset = 8;
  while (offset < bytes.length) {
    assert.ok(offset + 12 <= bytes.length, 'Incomplete PNG chunk');
    const size = bytes.readUInt32BE(offset);
    const end = offset + 8 + size;
    assert.ok(end + 4 <= bytes.length, 'PNG chunk length exceeds file');
    const type = bytes.subarray(offset + 4, offset + 8).toString('ascii');
    assert.equal(crc32(bytes.subarray(offset + 4, end)), bytes.readUInt32BE(end), `${type} CRC mismatch`);
    if (type === 'IHDR') {
      assert.deepEqual(bytes.subarray(offset + 8, end), Buffer.from('00000001000000010802000000', 'hex'));
    }
    if (type === 'IDAT') imageData.push(bytes.subarray(offset + 8, end));
    chunks.push(type);
    offset = end + 4;
  }
  assert.deepEqual(chunks, ['IHDR', 'IDAT', 'IEND']);
  assert.deepEqual(inflateSync(Buffer.concat(imageData)), Buffer.from([0, 255, 0, 0]));
}

test('viewing fixture PNG has valid chunks and a decodable red pixel', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'miku-backlog-archive-png-test-'));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const { paths } = await createViewingFixture(join(directory, 'archive'));
  const png = await readFile(join(paths.assets, 'issues', '101', '401-issue.png'));
  assertFixturePng(png);
  const invalid = Buffer.from(png);
  invalid[36] += 1; // Reproduce the previous invalid IDAT length (12 -> 13).
  assert.throws(() => assertFixturePng(invalid), /CRC mismatch/u);
});

function decodeHtmlAttribute(value) {
  return value
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'")
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&amp;/gu, '&');
}

function localReferences(html) {
  const references = [];
  for (const match of html.matchAll(/\b(href|src)="([^"]*)"/gu)) {
    const [, attribute, encodedValue] = match;
    const value = decodeHtmlAttribute(encodedValue);
    if (/^(?:https?:|mailto:)/iu.test(value)) {
      assert.equal(attribute, 'href', 'Generated pages must not load external resources.');
      continue;
    }
    references.push({ attribute, value });
  }
  return references;
}

async function listHtmlFiles(directory, prefix = '') {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = join(directory, entry.name);
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      result.push(...await listHtmlFiles(child, relativePath));
    } else if (entry.isFile() && entry.name.endsWith('.html')) {
      result.push(relativePath.split(sep).join('/'));
    }
  }
  return result.sort();
}

async function getOkay(url, expectedType) {
  const response = await fetch(url);
  assert.equal(response.status, 200, `${url} returned HTTP ${response.status}`);
  if (expectedType) {
    assert.match(response.headers.get('content-type') ?? '', new RegExp(expectedType, 'u'));
  }
  const body = Buffer.from(await response.arrayBuffer());
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    assert.equal(Number(contentLength), body.byteLength, `${url} Content-Length mismatch`);
  }
  return { response, body };
}

async function rawStatus(origin, path) {
  const url = new URL(origin);
  return new Promise((resolveStatus, rejectStatus) => {
    const request = httpRequest({
      hostname: url.hostname,
      port: Number(url.port),
      method: 'GET',
      path,
    }, (response) => {
      response.resume();
      response.once('end', () => resolveStatus(response.statusCode));
    });
    request.once('error', rejectStatus);
    request.end();
  });
}

test('serves every local archive reference from the archive-root HTTP route', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'miku-backlog-archive-http-test-'));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const output = join(directory, 'archive');
  const { paths, imageBytes } = await createViewingFixture(output);
  await renderArchive({ output });
  const { origin } = await startStaticServer({ root: output, t });

  const pages = await listHtmlFiles(paths.site);
  assert.ok(pages.includes('index.html'));
  assert.ok(pages.includes('issues/101.html'));
  assert.ok(pages.includes('wikis/201.html'));
  assert.ok(pages.includes('files/index.html'));
  for (const relativePage of pages) {
    const pageUrl = new URL(`/site/${relativePage}`, origin);
    const { response, body } = await getOkay(pageUrl, 'text/html');
    assert.equal(new URL(response.url).pathname, `/site/${relativePage}`);
    const html = body.toString('utf8');
    const ids = new Set(Array.from(html.matchAll(/\bid="([^"]+)"/gu), (match) => match[1]));

    for (const { attribute, value } of localReferences(html)) {
      const target = new URL(value, pageUrl);
      assert.equal(target.origin, origin, `${pageUrl} escaped the local server: ${value}`);
      if (target.hash && target.pathname === pageUrl.pathname) {
        assert.ok(ids.has(target.hash.slice(1)), `${pageUrl} is missing ${target.hash}`);
        continue;
      }

      const expectedType = target.pathname.endsWith('.css') ? 'text/css' : undefined;
      const fetched = await getOkay(target, expectedType);
      if (/\/assets\/(?:issues|wikis)\//u.test(target.pathname)) {
        assert.deepEqual(fetched.body, imageBytes, `${target} changed image bytes`);
        assert.match(fetched.response.headers.get('content-type') ?? '', /image\/png/u);
      } else if (/\/assets\/shared\//u.test(target.pathname)) {
        assert.deepEqual(fetched.body, Buffer.from('shared file'), `${target} changed shared-file bytes`);
      } else if (attribute === 'src') {
        assert.fail(`Unexpected local resource reference: ${target}`);
      }
    }
  }
});

test('serving only site reproduces the documented attachment 404', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'miku-backlog-archive-site-root-test-'));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const output = join(directory, 'archive');
  await createViewingFixture(output);
  await renderArchive({ output });
  const { origin } = await startStaticServer({ root: join(output, 'site'), t });

  await getOkay(new URL('/index.html', origin), 'text/html');
  await getOkay(new URL('/assets/style.css', origin), 'text/css');
  const issueHtml = await getOkay(new URL('/issues/101.html', origin), 'text/html');
  const sharedReference = localReferences(issueHtml.body.toString('utf8'))
    .find(({ value }) => value.includes('/assets/shared/'));
  assert.ok(sharedReference, 'Issue page should contain a shared-file reference.');
  const missingAsset = new URL(sharedReference.value, new URL('/issues/101.html', origin));
  assert.equal((await fetch(missingAsset)).status, 404);

  assert.equal(await rawStatus(origin, '/%2e%2e/%2e%2e/etc/passwd'), 403);
});
