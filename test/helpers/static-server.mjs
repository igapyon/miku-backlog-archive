import { createServer } from 'node:http';
import { realpath, stat } from 'node:fs/promises';
import { extname, relative, resolve, sep } from 'node:path';

const CONTENT_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
]);

/** @param {{ root: string, t: import('node:test').TestContext }} input */
export async function startStaticServer({ root, t }) {
  const realRoot = await realpath(root);
  const server = createServer((request, response) => {
    void (async () => {
      if (!['GET', 'HEAD'].includes(request.method ?? '')) {
        response.writeHead(405, { Allow: 'GET, HEAD' }).end();
        return;
      }

      let relativeUrlPath;
      try {
        const rawPath = (request.url ?? '/').split(/[?#]/u, 1)[0];
        const decodedPath = decodeURIComponent(rawPath);
        if (decodedPath.split('/').includes('..')) {
          response.writeHead(403).end();
          return;
        }
        relativeUrlPath = decodedPath.replace(/^\/+/, '');
      } catch {
        response.writeHead(400).end();
        return;
      }

      const candidate = resolve(realRoot, relativeUrlPath);
      const lexicalRelative = relative(realRoot, candidate);
      if (lexicalRelative.startsWith(`..${sep}`) || lexicalRelative === '..') {
        response.writeHead(403).end();
        return;
      }

      try {
        const actualPath = await realpath(candidate);
        const actualRelative = relative(realRoot, actualPath);
        if (actualRelative.startsWith(`..${sep}`) || actualRelative === '..') {
          response.writeHead(403).end();
          return;
        }
        const file = await stat(actualPath);
        if (!file.isFile()) {
          response.writeHead(404).end();
          return;
        }
        const headers = {
          'Content-Length': String(file.size),
          'Content-Type': CONTENT_TYPES.get(extname(actualPath).toLowerCase()) ?? 'application/octet-stream',
        };
        response.writeHead(200, headers);
        if (request.method === 'HEAD') {
          response.end();
          return;
        }
        const { createReadStream } = await import('node:fs');
        createReadStream(actualPath).pipe(response);
      } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
          response.writeHead(404).end();
        } else {
          response.writeHead(500).end();
        }
      }
    })().catch(() => {
      if (!response.headersSent) {
        response.writeHead(500);
      }
      response.end();
    });
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', rejectListen);
      resolveListen();
    });
  });

  t.after(() => new Promise((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
    server.closeAllConnections();
  }));

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Test server did not bind a TCP port.');
  }
  return { origin: `http://127.0.0.1:${address.port}`, server };
}
