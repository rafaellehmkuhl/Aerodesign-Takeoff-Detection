// Servidor estático mínimo (UI interativa e página headless) + /api/config.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, loadConfig } from './config.mjs';

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.css': 'text/css', '.glb': 'model/gltf-binary', '.yaml': 'text/plain' };
const MOUNTS = [
  ['/vendor/three/', path.join(ROOT, 'node_modules/three/')],
  ['/vendor/lil-gui/', path.join(ROOT, 'node_modules/lil-gui/dist/')],
  ['/src/', path.join(ROOT, 'sim/src/')],
  ['/assets/', path.join(ROOT, 'sim/assets/')],
  ['/models/', path.join(ROOT, 'models/')],
  ['/', path.join(ROOT, 'sim/web/')],
];

export function startServer({ port = 0, config = null } = {}) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (url.pathname === '/api/config') {
        const sc = url.searchParams.get('scenario');
        const cfg = config ?? loadConfig(sc ? path.join(ROOT, 'scenarios', path.basename(sc)) : null);
        res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(cfg));
      }
      if (url.pathname === '/api/scenarios') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(fs.readdirSync(path.join(ROOT, 'scenarios')).filter((f) => f.endsWith('.yaml'))));
      }
      let p = decodeURIComponent(url.pathname); if (p === '/') p = '/index.html';
      for (const [prefix, dir] of MOUNTS) if (p.startsWith(prefix)) {
        const file = path.join(dir, p.slice(prefix.length));
        if (file.startsWith(dir) && fs.existsSync(file) && fs.statSync(file).isFile()) {
          res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
          return fs.createReadStream(file).pipe(res);
        }
      }
      res.writeHead(404); res.end('not found');
    } catch (e) { res.writeHead(500); res.end(String(e)); }
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

if (process.argv[1] && process.argv[1].endsWith('server.mjs')) {
  const { port } = await startServer({ port: Number(process.env.PORT ?? 5173) });
  console.log(`Simulador: http://localhost:${port}/`);
}
