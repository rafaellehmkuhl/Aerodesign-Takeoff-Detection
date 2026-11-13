// Servidor do simulador: interface web, página headless do renderizador, API HTTP de controle externo
// (/api/...) e servidor MCP por HTTP (/mcp). A documentação da API está em docs/API.md e em GET /api.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, loadConfig } from './config.mjs';

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.mp4': 'video/mp4', '.css': 'text/css', '.glb': 'model/gltf-binary', '.yaml': 'text/plain', '.md': 'text/markdown; charset=utf-8', '.log': 'text/plain; charset=utf-8' };
const MOUNTS = [
  ['/vendor/three/', path.join(ROOT, 'node_modules/three/')],
  ['/src/', path.join(ROOT, 'sim/src/')],
  ['/assets/', path.join(ROOT, 'sim/assets/')],
  ['/models/', path.join(ROOT, 'models/')],
  ['/', path.join(ROOT, 'sim/web/')],
];

const ENDPOINTS = {
  'GET /api': 'este índice',
  'GET /api/session': 'cenário da sessão, padrões, versão e cenário de origem',
  'GET /api/config?path=…': 'um valor do cenário (caminho com pontos; câmeras por nome ou índice). Sem path: o cenário inteiro',
  'PATCH /api/session': 'altera valores: {"changes": {"caminho": valor, …}} — tudo ou nada, com validação',
  'POST /api/session/reset': 'restaura padrões: {"paths": [...]} ou {} para tudo',
  'POST /api/session/scenario': 'carrega um cenário pronto: {"name": "rapido"}',
  'GET /api/params': 'parâmetros documentados: caminho, rótulo, unidade, faixa, opções, valor e padrão',
  'GET /api/scenarios?details=1': 'cenários prontos',
  'GET /api/state': 'estado relatado pela interface aberta (tempo, câmera, folga, eventos, fps)',
  'POST /api/playback': 'comando para a interface: {"action": "play|pause|toggle|seek|seek_relative_to_crossing|step|speed|loop|select_camera|previews|frustums", "value": …}',
  'GET /api/events': 'eventos ao vivo (Server-Sent Events): config, command, ui-state, run',
  'POST /api/render': 'renderiza um quadro: {"camera": "linecam", "t_from_crossing": -0.1} ou {"t": 7.5} → image/jpeg (metadados no cabeçalho X-Sim-Meta)',
  'GET /api/runs': 'simulações em runs/',
  'POST /api/runs': 'roda a simulação completa com a sessão: {"name": "teste", "video": false}',
  'GET /api/runs/{nome}': 'status, resumo dos resultados, relatório e arquivos',
  'GET /api/runs/{nome}/files/{arquivo}': 'baixa um arquivo da simulação (final.mp4, results.json…)',
  'POST /mcp': 'servidor MCP (Streamable HTTP, sem sessão) com as mesmas operações',
};

const send = (res, status, obj, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers }); res.end(JSON.stringify(obj)); return true; };
const readBody = (req) => new Promise((resolve, reject) => {
  let b = ''; req.on('data', (d) => { b += d; if (b.length > 5e6) reject(new Error('corpo grande demais')); });
  req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { reject(Object.assign(new Error('JSON inválido'), { status: 400 })); } });
});

export async function startServer({ port = 0, config = null, api = config == null } = {}) {
  // `config` fixo = servidor efêmero do renderizador headless (sem API). Sem ele, a API de controle fica ativa.
  const core = api ? (await import('./api.mjs')).createApi() : null;
  const mcp = api ? await import('./mcp_tools.mjs') : null;
  const { StreamableHTTPServerTransport } = api ? await import('@modelcontextprotocol/sdk/server/streamableHttp.js') : {};

  async function route(req, res, url) {
    const m = req.method, p = url.pathname;
    if (p === '/api' && m === 'GET') return send(res, 200, { endpoints: ENDPOINTS, docs: 'docs/API.md' });
    if (p === '/api/config' && m === 'GET') {
      if (config) return send(res, 200, config);
      const sc = url.searchParams.get('scenario');
      if (sc) return send(res, 200, loadConfig(path.join(ROOT, 'scenarios', path.basename(sc))));
      const q = url.searchParams.get('path');
      return send(res, 200, q ? core.getConfig(q) : core.getSession().cfg);
    }
    if (p === '/api/scenarios' && m === 'GET') {
      if (url.searchParams.get('details') && core) return send(res, 200, core.listScenarios());
      return send(res, 200, fs.readdirSync(path.join(ROOT, 'scenarios')).filter((f) => f.endsWith('.yaml')));
    }
    if (!core) return false;
    if (p === '/api/session' && m === 'GET') return send(res, 200, core.getSession());
    if (p === '/api/session' && (m === 'PATCH' || m === 'POST')) { const b = await readBody(req); return send(res, 200, core.setParameters(b.changes, b.source ?? 'http')); }
    if (p === '/api/session/reset' && m === 'POST') { const b = await readBody(req); return send(res, 200, core.resetParameters(b.paths, b.source ?? 'http')); }
    if (p === '/api/session/scenario' && m === 'POST') { const b = await readBody(req); return send(res, 200, core.loadScenario(b.name, b.source ?? 'http')); }
    if (p === '/api/params' && m === 'GET') return send(res, 200, core.params());
    if (p === '/api/state' && m === 'GET') return send(res, 200, core.getState());
    if (p === '/api/ui-state' && m === 'POST') return send(res, 200, core.reportUiState(await readBody(req)));
    if (p === '/api/playback' && m === 'POST') { const b = await readBody(req); return send(res, 200, core.playback(b.action, b.value)); }
    if (p === '/api/events' && m === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(`event: hello\ndata: ${JSON.stringify({ version: core.getSession().version })}\n\n`);
      const off = core.subscribe((type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`));
      const ping = setInterval(() => res.write(': ping\n\n'), 15000);
      req.on('close', () => { off(); clearInterval(ping); });
      return true;
    }
    if (p === '/api/render' && m === 'POST') {
      const r = await core.renderFrame(await readBody(req));
      res.writeHead(200, { 'content-type': r.mime, 'x-sim-meta': JSON.stringify({ verdict: r.verdict, clearance_m: r.clearance_m, events: r.events }) });
      res.end(r.image); return true;
    }
    if (p === '/api/runs' && m === 'GET') return send(res, 200, core.listRuns());
    if (p === '/api/runs' && m === 'POST') return send(res, 202, core.startRun(await readBody(req)));
    let mm = p.match(/^\/api\/runs\/([^/]+)$/);
    if (mm && m === 'GET') return send(res, 200, core.getRun(decodeURIComponent(mm[1])));
    mm = p.match(/^\/api\/runs\/([^/]+)\/files\/([^/]+)$/);
    if (mm && m === 'GET') {
      const f = core.runFile(decodeURIComponent(mm[1]), decodeURIComponent(mm[2]));
      res.writeHead(200, { 'content-type': MIME[path.extname(f)] ?? 'application/octet-stream', 'content-length': fs.statSync(f).size });
      fs.createReadStream(f).pipe(res); return true;
    }
    if (p === '/mcp') {
      if (m !== 'POST') return send(res, 405, { error: 'use POST (MCP Streamable HTTP, sem sessão)' });
      const server = mcp.createMcpServer(core);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => { transport.close(); server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, await readBody(req));
      return true;
    }
    if (p.startsWith('/api/')) return send(res, 404, { error: 'rota desconhecida', endpoints: ENDPOINTS });
    return false;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (await route(req, res, url)) return;
      let p = decodeURIComponent(url.pathname); if (p === '/') p = '/index.html';
      for (const [prefix, dir] of MOUNTS) if (p.startsWith(prefix)) {
        const file = path.join(dir, p.slice(prefix.length));
        if (file.startsWith(dir) && fs.existsSync(file) && fs.statSync(file).isFile()) {
          res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
          return fs.createReadStream(file).pipe(res);
        }
      }
      res.writeHead(404); res.end('not found');
    } catch (e) {
      if (res.headersSent) { res.end(); return; }
      send(res, e.status ?? 500, { error: e.message, details: e.details });
    }
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port, api: core })));
}

if (process.argv[1] && process.argv[1].endsWith('server.mjs')) {
  const { port } = await startServer({ port: Number(process.env.PORT ?? 5173) });
  console.log(`Simulador: http://127.0.0.1:${port}/   API: http://127.0.0.1:${port}/api   MCP: http://127.0.0.1:${port}/mcp`);
}
