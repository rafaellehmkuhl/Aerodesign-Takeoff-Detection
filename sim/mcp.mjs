#!/usr/bin/env node
// Servidor MCP por stdio, para clientes como Claude Code, Claude Desktop ou Cursor.
// Ele fala com o servidor do simulador pela API HTTP; se não houver um rodando, sobe um no próprio processo.
//
//   claude mcp add takeoff-sim -- node /caminho/aerodesign-takeoff-detection/sim/mcp.mjs
//   SIM_URL=http://127.0.0.1:5173 node sim/mcp.mjs
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './mcp_tools.mjs';

const BASE = (process.env.SIM_URL ?? 'http://127.0.0.1:5173').replace(/\/$/, '');

async function call(method, p, body, { raw = false } = {}) {
  const r = await fetch(BASE + p, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) {
    const j = await r.json().catch(() => ({ error: r.statusText }));
    throw Object.assign(new Error(j.error ?? `HTTP ${r.status}`), { details: j.details });
  }
  return raw ? r : r.json();
}

async function ensureServer() {
  try { await call('GET', '/api/session'); return; } catch { /* sem servidor: sobe um aqui */ }
  const { startServer } = await import('./server.mjs');
  const url = new URL(BASE);
  await startServer({ port: Number(url.port || 5173), api: true });
  process.stderr.write(`takeoff-sim: servidor iniciado em ${BASE}\n`);
}

const http = {
  params: () => call('GET', '/api/params'),
  getConfig: (p) => call('GET', `/api/config${p ? `?path=${encodeURIComponent(p)}` : '?full=1'}`),
  setParameters: (changes, source) => call('PATCH', '/api/session', { changes, source }),
  resetParameters: (paths, source) => call('POST', '/api/session/reset', { paths, source }),
  listScenarios: () => call('GET', '/api/scenarios?details=1'),
  loadScenario: (name, source) => call('POST', '/api/session/scenario', { name, source }),
  playback: (action, value) => call('POST', '/api/playback', { action, value }),
  getState: () => call('GET', '/api/state'),
  renderFrame: async (args) => {
    const r = await call('POST', '/api/render', args, { raw: true });
    const meta = JSON.parse(r.headers.get('x-sim-meta') ?? '{}');
    return { image: Buffer.from(await r.arrayBuffer()), mime: r.headers.get('content-type'), ...meta };
  },
  startRun: (args) => call('POST', '/api/runs', args),
  getRun: (name) => call('GET', `/api/runs/${encodeURIComponent(name)}`),
  listRuns: () => call('GET', '/api/runs'),
};

await ensureServer();
await createMcpServer(http).connect(new StdioServerTransport());
