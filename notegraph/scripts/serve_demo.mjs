// Serves the built renderer plus demo/graph-data.json for browser-only
// verification of the graph view (no Electron needed).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const port = Number(process.env.PORT ?? 5173);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const candidates = [
    join(root, 'dist/renderer', normalize(pathname).replace(/^([.][.][/\\])+/, '')),
    join(root, 'demo', normalize(pathname).replace(/^([.][.][/\\])+/, '')),
  ];
  for (const file of candidates) {
    if (!file.startsWith(root)) continue;
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
      res.end(body);
      return;
    } catch {
      // try next candidate
    }
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});

server.listen(port, () => {
  console.log(`notegraph demo at http://localhost:${port}/`);
});
