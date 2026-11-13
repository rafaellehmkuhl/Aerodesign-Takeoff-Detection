// Núcleo do controle externo do simulador: sessão de configuração, controle das interfaces abertas,
// render de quadros e execução de simulações completas. Usado pelas rotas HTTP (sim/server.mjs) e pelas
// ferramentas MCP (sim/mcp_tools.mjs).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, loadConfig } from './config.mjs';
import { documentedParams, resolvePath, getPath, setPath } from './web/params.js';

const clone = (v) => structuredClone(v);
const RUNS = path.join(ROOT, 'runs');
const NAME_RE = /^[A-Za-z0-9_.-]{1,80}$/;

export class ApiError extends Error {
  constructor(status, message, details) { super(message); this.status = status; this.details = details; }
}

export function createApi() {
  const session = { scenario: null, cfg: loadConfig(null), defaults: null, version: 1 };
  session.defaults = clone(session.cfg);
  let uiState = null;                       // último estado relatado por uma interface aberta
  const listeners = new Set();              // assinantes de eventos (SSE)
  const jobs = new Map();                   // simulações iniciadas por este servidor

  const emit = (type, data) => { for (const fn of listeners) { try { fn(type, data); } catch { /* conexão caída */ } } };
  const configEvent = (source) => emit('config', { version: session.version, cfg: session.cfg, defaults: session.defaults, scenario: session.scenario, source });

  // ---------------------------------------------------------------- parâmetros
  function params() {
    return documentedParams(session.cfg).map((p) => ({ ...p, value: getPath(session.cfg, p.path), default: getPath(session.defaults, p.path) }));
  }

  function validate(real, value, spec) {
    const cur = getPath(session.cfg, real);
    if (spec?.nullable && value === null) return null;
    if (spec?.options) {
      if (!spec.options.some((o) => JSON.stringify(o.value) === JSON.stringify(value))) return `valor fora das opções: ${spec.options.map((o) => JSON.stringify(o.value)).join(', ')}`;
      return null;
    }
    if (cur === null && !spec?.nullable) return null;   // campo opcional sem valor: aceita qualquer tipo
    if (typeof cur === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'esperado um número';
      if (spec?.min != null && (value < spec.min - 1e-12 || value > spec.max + 1e-12)) return `fora da faixa [${spec.min}, ${spec.max}]`;
    } else if (typeof cur === 'boolean') { if (typeof value !== 'boolean') return 'esperado true ou false'; }
    else if (typeof cur === 'string') { if (typeof value !== 'string') return 'esperado um texto'; }
    else if (Array.isArray(cur)) {
      if (!Array.isArray(value)) return 'esperada uma lista';
      if (cur.length && typeof cur[0] !== 'object' && value.length !== cur.length) return `esperada uma lista de ${cur.length} elementos`;
    } else if (cur && typeof cur === 'object' && (typeof value !== 'object' || value === null || Array.isArray(value))) return 'esperado um objeto';
    return null;
  }

  // changes: { caminho: valor } ou [{ path, value }]. Tudo ou nada: com qualquer erro, nada é aplicado.
  function setParameters(changes, source = 'api') {
    const list = Array.isArray(changes) ? changes : Object.entries(changes ?? {}).map(([p, v]) => ({ path: p, value: v }));
    if (!list.length) throw new ApiError(400, 'nenhuma alteração enviada');
    const specs = new Map(documentedParams(session.cfg).map((p) => [p.path, p]));
    const errors = [], plan = [];
    for (const { path: p, value } of list) {
      const real = resolvePath(session.cfg, p);
      if (real == null) { errors.push({ path: p, error: 'caminho inexistente no cenário (veja GET /api/params ou GET /api/session)' }); continue; }
      const err = validate(real, value, specs.get(real));
      if (err) errors.push({ path: p, error: err }); else plan.push([real, value]);
    }
    if (errors.length) throw new ApiError(400, 'alterações rejeitadas', errors);
    for (const [real, value] of plan) setPath(session.cfg, real, clone(value));
    session.version++;
    configEvent(source);
    return { version: session.version, applied: plan.map(([p, v]) => ({ path: p, value: v })) };
  }

  function resetParameters(paths, source = 'api') {
    if (!paths?.length) session.cfg = clone(session.defaults);
    else for (const p of paths) {
      const real = resolvePath(session.defaults, p);
      if (real == null) throw new ApiError(400, `caminho inexistente: ${p}`);
      setPath(session.cfg, real, clone(getPath(session.defaults, real)));
    }
    session.version++; configEvent(source);
    return { version: session.version };
  }

  function listScenarios() {
    return fs.readdirSync(path.join(ROOT, 'scenarios')).filter((f) => f.endsWith('.yaml')).map((f) => {
      const first = fs.readFileSync(path.join(ROOT, 'scenarios', f), 'utf8').split('\n').filter((l) => l.startsWith('#')).map((l) => l.replace(/^#\s?/, '')).join(' ');
      return { name: f.replace(/\.yaml$/, ''), description: first };
    });
  }
  function loadScenario(name, source = 'api') {
    const file = path.join(ROOT, 'scenarios', `${path.basename(String(name)).replace(/\.yaml$/, '')}.yaml`);
    if (!fs.existsSync(file)) throw new ApiError(404, `cenário não encontrado: ${name}`);
    session.cfg = loadConfig(file); session.defaults = clone(session.cfg); session.scenario = path.basename(file, '.yaml'); session.version++;
    configEvent(source);
    return { version: session.version, scenario: session.scenario };
  }
  function getSession() { return { version: session.version, scenario: session.scenario, cfg: session.cfg, defaults: session.defaults }; }
  function getConfig(p) {
    if (!p) return session.cfg;
    const real = resolvePath(session.cfg, p);
    if (real == null) throw new ApiError(404, `caminho inexistente: ${p}`);
    return { path: real, value: getPath(session.cfg, real), default: getPath(session.defaults, real) };
  }

  // ---------------------------------------------------------------- interface aberta
  const PLAYBACK = ['play', 'pause', 'toggle', 'seek', 'seek_relative_to_crossing', 'step', 'speed', 'loop', 'select_camera', 'previews', 'frustums'];
  function playback(action, value) {
    if (!PLAYBACK.includes(action)) throw new ApiError(400, `ação desconhecida: ${action}. Ações: ${PLAYBACK.join(', ')}`);
    if (['seek', 'seek_relative_to_crossing', 'step', 'speed'].includes(action) && !Number.isFinite(value)) throw new ApiError(400, `${action} precisa de um valor numérico`);
    if (action === 'speed' && !(value > 0 && value <= 4)) throw new ApiError(400, 'velocidade deve estar em (0, 4]');
    if (action === 'select_camera' && typeof value !== 'string') throw new ApiError(400, 'select_camera precisa do nome da câmera (free, chase ou uma câmera do cenário)');
    const n = [...listeners].length;
    emit('command', { action, value });
    return { delivered_to: n, note: n ? undefined : 'nenhuma interface aberta: abra a UI no navegador para que o comando tenha efeito' };
  }
  function reportUiState(s) { uiState = { ...s, received_at: new Date().toISOString() }; emit('ui-state', uiState); return { ok: true }; }
  function getState() {
    const fresh = uiState && Date.now() - Date.parse(uiState.received_at) < 5000;
    return { session_version: session.version, scenario: session.scenario, ui_connected: !!fresh, ui: uiState };
  }
  function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }

  // ---------------------------------------------------------------- render de quadros (headless)
  function writeTmpConfig(cfg) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'takeoffsim-'));
    const file = path.join(dir, 'config.json'); fs.writeFileSync(file, JSON.stringify(cfg));
    return { dir, file };
  }
  function runNode(args, { timeoutMs = 600000, env = {} } = {}) {
    return new Promise((resolve, reject) => {
      const p = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...env } });
      let log = ''; p.stdout.on('data', (d) => { log += d; }); p.stderr.on('data', (d) => { log += d; });
      const to = setTimeout(() => { p.kill(); reject(new ApiError(504, 'render excedeu o tempo')); }, timeoutMs);
      p.on('close', (code) => { clearTimeout(to); code === 0 ? resolve(log) : reject(new ApiError(500, `render falhou (código ${code})`, log.slice(-2000))); });
    });
  }
  async function renderFrame({ camera = 'chase', t, t_from_crossing, gpu = process.platform === 'darwin' } = {}) {
    const names = ['free', 'chase', ...session.cfg.cameras.map((c) => c.name)];
    if (!names.includes(camera)) throw new ApiError(400, `câmera desconhecida: ${camera}. Câmeras: ${names.join(', ')}`);
    const { dir, file } = writeTmpConfig(session.cfg);
    const args = [path.join(ROOT, 'sim', 'render.mjs'), '--config', file, '--out', dir, '--cameras', camera];
    if (Number.isFinite(t)) args.push('--at', String(t)); else args.push('--stills', String(Number.isFinite(t_from_crossing) ? t_from_crossing : 0));
    await runNode(args, { env: gpu ? { SIM_GPU: '1' } : {} });
    const img = fs.readFileSync(path.join(dir, `still_${camera}.jpg`));
    const truth = JSON.parse(fs.readFileSync(path.join(dir, 'ground_truth.json'), 'utf8'));
    fs.rmSync(dir, { recursive: true, force: true });
    return { image: img, mime: 'image/jpeg', events: truth.events, clearance_m: truth.clearance_m, verdict: truth.verdict };
  }

  // ---------------------------------------------------------------- simulações completas
  function runDir(name) { if (!NAME_RE.test(name)) throw new ApiError(400, 'nome inválido (use letras, números, ponto, hífen e sublinhado)'); return path.join(RUNS, name); }
  function startRun({ name, video = true, gpu = process.platform === 'darwin' } = {}) {
    name = name || `api_${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`;
    const dir = runDir(name);
    if (jobs.get(name)?.status === 'running') throw new ApiError(409, `já existe uma simulação "${name}" em andamento`);
    fs.mkdirSync(dir, { recursive: true });
    const input = path.join(dir, 'session.json');
    fs.writeFileSync(input, JSON.stringify(session.cfg, null, 1));
    const py = fs.existsSync(path.join(ROOT, '.venv', 'bin', 'python')) ? path.join(ROOT, '.venv', 'bin', 'python') : 'python3';
    const args = [path.join(ROOT, 'run.py'), input, '--name', name, ...(video ? [] : ['--no-video'])];
    const logFile = path.join(dir, 'api.log'), log = fs.createWriteStream(logFile);
    const p = spawn(py, args, { cwd: ROOT, env: { ...process.env, ...(gpu ? { SIM_GPU: '1' } : {}), TAKEOFFSIM_NO_VENV: '1' } });
    const job = { name, status: 'running', started_at: new Date().toISOString(), video, session_version: session.version, step: null, progress: null, pid: p.pid };
    const onData = (d) => {
      log.write(d);
      for (const line of String(d).split(/[\r\n]+/)) {
        const m = line.match(/^\[(\d)\/4\]\s*(.*)$/); if (m) job.step = `${m[1]}/4 ${m[2]}`;
        const q = line.match(/^\s*(\S+): (\d+)\/(\d+) quadros/); if (q) job.progress = `${q[1]} ${q[2]}/${q[3]} quadros`;
      }
    };
    p.stdout.on('data', onData); p.stderr.on('data', onData);
    p.on('close', (code) => {
      log.end(); job.status = code === 0 ? 'done' : 'failed'; job.exit_code = code; job.finished_at = new Date().toISOString();
      emit('run', { name, status: job.status });
    });
    jobs.set(name, job);
    emit('run', { name, status: 'running' });
    return job;
  }
  function getRun(name) {
    const dir = runDir(name);
    if (!fs.existsSync(dir)) throw new ApiError(404, `simulação não encontrada: ${name}`);
    const job = jobs.get(name);
    const read = (f) => (fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), 'utf8') : null);
    const results = read('results.json');
    const files = fs.readdirSync(dir).filter((f) => !f.endsWith('.pkl')).map((f) => ({ name: f, bytes: fs.statSync(path.join(dir, f)).size, url: `/api/runs/${name}/files/${f}` }));
    let status = job?.status ?? (results ? 'done' : 'unknown');
    let summary = null;
    if (results) {
      const r = JSON.parse(results);
      summary = { truth: r.ground_truth, algorithms: Object.fromEntries(Object.entries(r.algorithms).map(([k, a]) => [k, { label: a.label, verdict: a.verdict, clearance_m: a.clearance_m, clearance_error_m: a.clearance_error_m, correct: a.correct, pose_error: a.pose_error, stats: a.stats }])) };
    }
    const logTail = read('api.log')?.split(/[\r\n]+/).filter((l) => l && !/quadros \(/.test(l)).slice(-15);
    return { name, status, job, summary, report: read('report.md'), files, log_tail: logTail };
  }
  function listRuns() {
    if (!fs.existsSync(RUNS)) return [];
    return fs.readdirSync(RUNS, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => {
      const dir = path.join(RUNS, d.name), res = path.join(dir, 'results.json');
      const r = fs.existsSync(res) ? JSON.parse(fs.readFileSync(res, 'utf8')) : null;
      return {
        name: d.name, status: jobs.get(d.name)?.status ?? (r ? 'done' : 'incomplete'), modified: fs.statSync(dir).mtime.toISOString(),
        truth: r ? { verdict: r.ground_truth.verdict, clearance_m: r.ground_truth.clearance_m } : null,
        has_video: fs.existsSync(path.join(dir, 'final.mp4')),
      };
    }).sort((a, b) => b.modified.localeCompare(a.modified));
  }
  function runFile(name, file) {
    const dir = runDir(name), p = path.join(dir, path.basename(file));
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) throw new ApiError(404, 'arquivo não encontrado');
    return p;
  }

  return { getSession, getConfig, params, setParameters, resetParameters, listScenarios, loadScenario, playback, reportUiState, getState, subscribe, renderFrame, startRun, getRun, listRuns, runFile, PLAYBACK };
}
