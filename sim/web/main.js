// Interface interativa: monta a cena, mostra a câmera selecionada e as prévias de todas (com vibração,
// distorção, ruído e motion blur), e deixa editar o cenário ao vivo.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createSim } from '/src/sim.js';
import { CameraRenderer } from '/src/cameras.js';

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids.filter((k) => k != null)); return e; };
const fmt = (v, d) => Number(v).toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d });

const glCanvas = $('gl'), view = $('view'), vctx = view.getContext('2d');
const cameraRenderer = new CameraRenderer(glCanvas);
const params = new URLSearchParams(location.search);
let cfg = await (await fetch('/api/config' + (params.get('scenario') ? `?scenario=${params.get('scenario')}` : ''))).json();
const defaults = structuredClone(cfg);
let sim = null, controls = null, selected = 'free', thumbs = {};
let camIndex = 0, activeTab = 'cena';
const state = { t: 0, playing: true, speed: 1, loop: true, previews: true, frustums: true };

// ------------------------------------------------------------------ caminhos no cenário
const get = (o, path) => path.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
const set = (o, path, v) => { const ks = path.split('.'), last = ks.pop(); ks.reduce((a, k) => a[k], o)[last] = v; };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ------------------------------------------------------------------ simulação
function frustumHelper(c) {
  const d = 10, hx = (c.W / 2 / c.fx) * d, hy = (c.H / 2 / c.fx) * d;
  const p = [[0, 0, 0], [hx, hy, -d], [-hx, hy, -d], [-hx, -hy, -d], [hx, -hy, -d]];
  const seg = [0, 1, 0, 2, 0, 3, 0, 4, 1, 2, 2, 3, 3, 4, 4, 1].flatMap((i) => p[i]);
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(seg, 3));
  const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: c.spec.role === 'line' ? 0x28dcff : 0xffd028 }));
  l.matrixAutoUpdate = false; c.truePoseAt(0, l.matrix); l.layers.set(1);
  return l;
}

const busy = (msg) => { $('busy').textContent = msg || ''; };
let building = null, pending = false;
async function rebuild() {
  if (building) { pending = true; return building; }
  busy('Recalculando…');
  building = (async () => {
    await new Promise((r) => setTimeout(r, 20));
    const keep = sim ? { pos: sim.free.cam.position.clone(), target: controls.target.clone(), t: state.t } : null;
    try {
      sim = await createSim(cfg, { cameraRenderer });
    } catch (e) {
      busy(`Erro ao montar a cena: ${e.message}. Ajuste o valor alterado ou use “Restaurar tudo”.`);
      console.error(e); building = null; return;
    }
    for (const c of sim.cams) sim.scene.add(frustumHelper(c));
    if (state.frustums) sim.free.cam.layers.enable(1);
    if (controls) controls.dispose();
    controls = new OrbitControls(sim.free.cam, view);
    controls.target.set(cfg.runway.length_m - 2, 0, 1);
    if (keep) { sim.free.cam.position.copy(keep.pos); controls.target.copy(keep.target); }
    controls.update();
    buildStrip();
    const ev = sim.traj.events, cl = sim.truthClearance.clearance;
    $('sM').textContent = fmt(ev.mass_kg, 2); $('sVs').textContent = fmt(ev.v_stall, 1);
    $('sC').textContent = `${fmt(cl * 100, 1)} cm`;
    const v = $('verdict'); v.textContent = cl > 0 ? 'Válida' : 'Inválida'; v.className = 'verdict ' + (cl > 0 ? 'ok' : 'bad');
    const time = $('time'); time.max = sim.tEnd;
    state.t = keep ? Math.min(keep.t, sim.tEnd) : Math.max(0, sim.tCross - 2.5);
    buildMarks();
    busy('');
    building = null;
    if (pending) { pending = false; rebuild(); }
  })();
  return building;
}
const debounce = (fn, ms) => { let h; return () => { clearTimeout(h); h = setTimeout(fn, ms); }; };
const apply = debounce(rebuild, 350);

// ------------------------------------------------------------------ player
const SPEEDS = [0.05, 0.1, 0.25, 0.5, 1];
const FRAME = 1 / 240;
function setPlaying(on) {
  state.playing = on;
  const b = $('bPlay'); b.dataset.state = on ? 'playing' : 'paused'; b.setAttribute('aria-label', on ? 'Pausar' : 'Tocar');
}
function seek(t) { if (sim) state.t = Math.min(Math.max(t, 0), sim.tEnd); }
function setSpeed(s) {
  state.speed = s;
  for (const b of $('speed').children) { const on = Number(b.dataset.v) === s; b.setAttribute('aria-checked', on); b.tabIndex = on ? 0 : -1; }
}
for (const s of SPEEDS) {
  const b = el('button', { type: 'button', textContent: `${fmt(s, s < 0.1 ? 2 : s < 1 ? (s * 10 % 1 ? 2 : 1) : 0)}×` });
  b.dataset.v = s; b.setAttribute('role', 'radio');
  b.onclick = () => setSpeed(s);
  b.onkeydown = (e) => {
    const i = SPEEDS.indexOf(state.speed), n = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0;
    if (!n) return; e.preventDefault(); const s2 = SPEEDS[Math.min(Math.max(i + n, 0), SPEEDS.length - 1)]; setSpeed(s2); $('speed').querySelector(`[data-v="${s2}"]`).focus();
  };
  $('speed').append(b);
}
setSpeed(1);
$('bPlay').onclick = () => setPlaying(!state.playing);
$('bStart').onclick = () => { seek(0); };
$('bBack').onclick = (e) => { setPlaying(false); seek(state.t - (e.shiftKey ? 0.1 : FRAME)); };
$('bFwd').onclick = (e) => { setPlaying(false); seek(state.t + (e.shiftKey ? 0.1 : FRAME)); };
$('bObs').onclick = () => { if (sim) seek(sim.tCross - 0.5); };
$('loop').onchange = (e) => { state.loop = e.target.checked; };
{
  const time = $('time'); let resume = false;
  time.addEventListener('pointerdown', () => { resume = state.playing; setPlaying(false); });
  time.addEventListener('pointerup', () => { if (resume) setPlaying(true); });
  time.addEventListener('input', () => seek(Number(time.value)));
}
document.addEventListener('keydown', (e) => {
  const tg = e.target instanceof Element ? e.target : document.body;
  if (tg.closest('input, select, textarea') && tg.type !== 'range' && tg.type !== 'checkbox') return;
  if (tg.id === 'time' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return;   // o próprio controle trata
  const inWidget = tg.closest('[role="radiogroup"], [role="tablist"]');
  if (e.key === ' ' && !tg.closest('button')) { e.preventDefault(); setPlaying(!state.playing); }
  else if (e.key === 'ArrowLeft' && !inWidget) { e.preventDefault(); setPlaying(false); seek(state.t - (e.shiftKey ? 0.1 : FRAME)); }
  else if (e.key === 'ArrowRight' && !inWidget) { e.preventDefault(); setPlaying(false); seek(state.t + (e.shiftKey ? 0.1 : FRAME)); }
  else if (e.key === 'Home') { seek(0); }
  else if (e.key === 'o' || e.key === 'O') { $('bObs').click(); }
});
function buildMarks() {
  const m = $('marks'); m.innerHTML = '';
  const ev = sim.traj.events;
  let prev = null;
  for (const [t, label, cls] of [[ev.t_rotate, 'rotação', ''], [ev.t_liftoff, 'decolagem', ''], [ev.t_cross, 'obstáculo', 'obs']]) {
    if (t == null) continue;
    const f = t / sim.tEnd, mark = el('div', { className: `mark ${cls}`, style: `left: calc(9px + (100% - 18px) * ${f})` }, el('span', { textContent: label }));
    // Eventos próximos: o rótulo anterior encosta à esquerda do traço e o atual à direita.
    if (prev && f - prev.f < 0.12) { prev.mark.classList.add('to-left'); mark.classList.add('to-right'); }
    m.append(mark); prev = { f, mark };
  }
}

// ------------------------------------------------------------------ miniaturas
function camCaption(c) {
  if (c.name === 'free') return ['Visão livre', 'arraste para orbitar'];
  if (c.name === 'chase') return ['Acompanhamento', 'câmera que segue a aeronave'];
  return [c.name, `${c.W}×${c.H} · ${c.spec.fps} fps · ${c.spec.role === 'line' ? 'linha' : 'rastreamento'}`];
}
function selectCam(name) {
  selected = name;
  for (const k in thumbs) thumbs[k].el.setAttribute('aria-pressed', k === selected);
  const [t, s] = camCaption(sim.byName[name]);
  $('mainLabel').textContent = name === 'free' || name === 'chase' ? t : `${t} · ${s}`;
  $('mainHint').hidden = name !== 'free';
  // A aba Câmeras acompanha a câmera escolhida na tira de miniaturas.
  const i = cfg.cameras.findIndex((c) => c.name === name);
  if (i >= 0 && i !== camIndex) { camIndex = i; if (activeTab === 'cams') renderPanels(); }
}
function buildStrip() {
  const strip = $('strip'); strip.innerHTML = ''; thumbs = {};
  for (const c of [sim.free, sim.chase, ...sim.cams]) {
    const cv = el('canvas', { width: 320, height: Math.round((320 * c.H) / c.W) }); cv.setAttribute('aria-hidden', 'true');
    const [t, s] = camCaption(c);
    const b = el('button', { type: 'button', className: 'thumb' }, cv, el('span', { className: 'cap' }, t, el('small', { textContent: s })));
    b.setAttribute('aria-pressed', c.name === selected);
    b.onclick = () => selectCam(c.name);
    strip.append(b);
    thumbs[c.name] = { el: b, ctx: cv.getContext('2d'), cv };
  }
  if (!thumbs[selected]) selected = 'free';
  selectCam(selected);
}

// ------------------------------------------------------------------ painel de configuração
// Cada campo aponta para um caminho no cenário. `scale` converte a unidade guardada para a exibida.
const RESOLUTIONS = [[1280, 720], [1920, 1080], [2560, 1440], [3840, 2160]];
const camFields = (i) => [
  { group: 'Posição e mira', note: 'x ao longo da pista (largada em 0, obstáculo em 50), y para a esquerda, z para cima.', fields: [
    { kind: 'vec3', path: `cameras.${i}.position`, label: 'Posição da câmera', unit: 'm', step: 0.05 },
    { kind: 'vec3', path: `cameras.${i}.look_at`, label: 'Ponto para onde ela aponta', unit: 'm', step: 0.05 },
  ] },
  { group: 'Lente e sensor', fields: [
    { kind: 'range', path: `cameras.${i}.hfov_deg`, label: 'Campo de visão horizontal', unit: '°', min: 5, max: 120, step: 1 },
    { kind: 'select', path: `cameras.${i}.resolution`, label: 'Resolução', options: RESOLUTIONS.map((r) => [`${r[0]} × ${r[1]}`, r]) },
    { kind: 'select', path: `cameras.${i}.fps`, label: 'Quadros por segundo', options: [30, 60, 120, 240, 480, 960].map((f) => [`${f} fps`, f]) },
    { kind: 'range', path: `cameras.${i}.exposure_s`, label: 'Tempo de exposição', help: 'Mais tempo = mais borrão de movimento.', unit: 'ms', scale: 1000, min: 0.05, max: 10, step: 0.05, digits: 2 },
    { kind: 'range', path: `cameras.${i}.noise_sigma`, label: 'Ruído do sensor', unit: '%', scale: 100, min: 0, max: 8, step: 0.1, digits: 1 },
    { kind: 'range', path: `cameras.${i}.distortion.k1`, label: 'Distorção radial (k1)', help: 'Negativo = barril, positivo = almofada.', min: -0.4, max: 0.4, step: 0.005, digits: 3 },
  ] },
  { group: 'Imperfeições', fields: [
    { kind: 'range', path: `cameras.${i}.vibration.rms_deg`, label: 'Vibração (rms)', unit: '°', min: 0, max: 0.3, step: 0.002, digits: 3 },
    { kind: 'range', path: `cameras.${i}.vibration.sway_deg_per_ms`, label: 'Balanço do mastro com o vento', unit: '°/(m/s)', min: 0, max: 0.1, step: 0.001, digits: 3 },
    { kind: 'range', path: `cameras.${i}.calibration_error.rotation_sigma_deg`, label: 'Erro de calibração · rotação (σ)', unit: '°', min: 0, max: 1, step: 0.005, digits: 3 },
    { kind: 'range', path: `cameras.${i}.calibration_error.position_sigma_m`, label: 'Erro de calibração · posição (σ)', unit: 'cm', scale: 100, min: 0, max: 30, step: 0.1, digits: 1 },
  ] },
];
const TABS = [
  { id: 'cena', label: 'Cenário', groups: [
    { group: 'Vento', fields: [
      { kind: 'range', path: 'environment.wind.speed_ms', label: 'Velocidade média', unit: 'm/s', min: 0, max: 12, step: 0.1, digits: 1 },
      { kind: 'range', path: 'environment.wind.direction_deg', label: 'Para onde sopra', help: '180° = de frente para a aeronave (vento de proa).', unit: '°', min: 0, max: 360, step: 5 },
      { kind: 'range', path: 'environment.wind.turbulence', label: 'Rajadas', help: 'Variação em torno da média.', unit: '%', scale: 100, min: 0, max: 60, step: 1 },
    ] },
    { group: 'Sol', fields: [
      { kind: 'range', path: 'environment.sun_azimuth_deg', label: 'Direção do sol', unit: '°', min: 0, max: 360, step: 5 },
    ] },
    { group: 'Obstáculo', fields: [
      { kind: 'range', path: 'obstacle.height_m', label: 'Altura da faixa', unit: 'cm', scale: 100, min: 30, max: 150, step: 1 },
      { kind: 'switch', path: 'obstacle.tape', label: 'Faixa física entre os postes' },
      { kind: 'switch', path: 'obstacle.backdrop', label: 'Painel de contraste atrás do obstáculo' },
    ] },
    { group: 'Aleatoriedade', fields: [
      { kind: 'range', path: 'seed', label: 'Semente', help: 'Muda rajadas, vibração e erros sorteados.', min: 1, max: 999, step: 1, shuffle: true },
    ] },
  ] },
  { id: 'aero', label: 'Aeronave', groups: [
    { group: 'Decolagem', fields: [
      { kind: 'nullable', path: 'dynamics.target_clearance_m', label: 'Fixar a folga real', help: 'Ajusta a massa para a aeronave passar exatamente com esta folga.', unit: 'cm', scale: 100, min: -60, max: 150, step: 0.5, digits: 1, fallback: 0.05 },
      { kind: 'range', path: 'dynamics.mass_kg', label: 'Massa total', unit: 'kg', min: 4, max: 30, step: 0.1, digits: 1 },
      { kind: 'range', path: 'dynamics.static_thrust_n', label: 'Tração estática', unit: 'N', min: 15, max: 120, step: 1 },
      { kind: 'range', path: 'dynamics.lateral_offset_m', label: 'Desvio lateral', unit: 'm', min: -2.5, max: 2.5, step: 0.05, digits: 2 },
      { kind: 'range', path: 'dynamics.roll_sigma_deg', label: 'Rolamento em voo (σ)', unit: '°', min: 0, max: 10, step: 0.5, digits: 1 },
    ] },
    { group: 'Marcadores ArUco', fields: [
      { kind: 'switch', path: 'aircraft.markers_enabled', label: 'Adesivos ArUco na asa' },
      { kind: 'range', path: 'aircraft.marker_margin', label: 'Borda branca', help: 'Em relação ao tamanho do código.', unit: '%', scale: 100, min: 5, max: 30, step: 1 },
    ] },
  ] },
  { id: 'cams', label: 'Câmeras', cameras: true },
  { id: 'vis', label: 'Exibição', groups: [
    { group: 'Visualização', local: true, fields: [
      { kind: 'switch', local: 'previews', label: 'Atualizar as miniaturas das câmeras', help: 'Desligue para ganhar fps na visão principal.' },
      { kind: 'switch', local: 'frustums', label: 'Mostrar o campo de visão das câmeras na visão livre' },
    ] },
  ] },
];

const ICON_RESET = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7M3 4v5h5"/></svg>';
let uid = 0;
const fieldRefreshers = [];

function makeField(f) {
  const id = `f${uid++}`, wrap = el('div', { className: 'field' });
  const scale = f.scale ?? 1, digits = f.digits ?? 0;
  const read = () => (f.local ? state[f.local] : get(cfg, f.path));
  const def = () => (f.local ? undefined : get(defaults, f.path));
  const reset = el('button', { type: 'button', className: 'reset', innerHTML: ICON_RESET, title: 'Restaurar o padrão' });
  reset.setAttribute('aria-label', `Restaurar o padrão de ${f.label}`);
  const write = (v) => {
    if (f.local) { state[f.local] = v; if (f.local === 'frustums' && sim) sim.free.cam.layers[v ? 'enable' : 'disable'](1); }
    else { set(cfg, f.path, v); apply(); }
    refresh();
  };
  reset.onclick = () => write(structuredClone(def()));
  const help = f.help ? el('span', { className: 'field-help', id: `${id}-h`, textContent: f.help }) : null;
  let refresh;

  if (f.kind === 'switch') {
    const input = el('input', { type: 'checkbox', id });
    input.onchange = () => write(input.checked);
    if (help) input.setAttribute('aria-describedby', `${id}-h`);
    wrap.append(el('label', { className: 'switch-row', htmlFor: id }, el('span', { className: 'txt' }, f.label, help), el('span', { className: 'switch' }, input, el('span', { className: 'knob' })), f.local ? null : reset));
    refresh = () => { input.checked = !!read(); };
  } else if (f.kind === 'select') {
    const sel = el('select', { id, className: 'input' });
    f.options.forEach(([t], k) => sel.append(el('option', { value: k, textContent: t })));
    sel.onchange = () => write(structuredClone(f.options[Number(sel.value)][1]));
    if (help) sel.setAttribute('aria-describedby', `${id}-h`);
    wrap.append(el('div', { className: 'field-top' }, el('label', { htmlFor: id }, f.label, help), sel, reset));
    refresh = () => { const k = f.options.findIndex(([, v]) => same(v, read())); sel.value = k < 0 ? '' : k; };
  } else if (f.kind === 'vec3') {
    const ins = ['x', 'y', 'z'].map((ax, k) => {
      const input = el('input', { type: 'number', step: f.step, id: `${id}-${ax}` });
      input.onchange = () => { const v = structuredClone(read()); v[k] = Number(input.value); write(v); };
      return el('label', { htmlFor: `${id}-${ax}` }, `${ax} (${f.unit})`, input);
    });
    wrap.append(el('div', { className: 'field-top' }, el('span', { className: 'lbl' }, f.label), reset), el('div', { className: 'vec' }, ...ins));
    refresh = () => { const v = read(); ins.forEach((l, k) => { l.querySelector('input').value = +Number(v[k]).toFixed(3); }); };
  } else {
    // range e nullable: controle deslizante + número digitável, na unidade exibida.
    const range = el('input', { type: 'range', min: f.min, max: f.max, step: f.step, id: `${id}-r` });
    const num = el('input', { type: 'number', min: f.min, max: f.max, step: f.step, id });
    range.setAttribute('aria-labelledby', `${id}-l`); if (help) { range.setAttribute('aria-describedby', `${id}-h`); num.setAttribute('aria-describedby', `${id}-h`); }
    const toStore = (x) => Math.round((Number(x) / scale) * 1e9) / 1e9;
    range.oninput = () => { num.value = fmtIn(range.value); set(cfg, f.path, toStore(range.value)); paint(); apply(); };
    num.onchange = () => { const x = Math.min(Math.max(Number(num.value), f.min), f.max); write(toStore(x)); };
    const fmtIn = (x) => Number(x).toFixed(digits);
    const label = el('label', { htmlFor: id, id: `${id}-l` }, f.label, help);
    const edit = el('div', { className: 'field-edit' }, num, el('span', { className: 'unit', textContent: f.unit ?? '' }));
    let toggle = null;
    if (f.kind === 'nullable') {
      toggle = el('input', { type: 'checkbox', id: `${id}-t` });
      toggle.setAttribute('aria-label', `Ativar: ${f.label}`);
      toggle.onchange = () => write(toggle.checked ? (get(cfg, f.path) ?? f.fallback) : null);
      label.prepend(el('span', { className: 'switch inline' }, toggle, el('span', { className: 'knob' })));
    }
    const extra = f.shuffle ? el('button', { type: 'button', className: 'btn ghost small', textContent: 'Sortear' }) : null;
    if (extra) extra.onclick = () => write(1 + Math.floor(Math.random() * 999));
    wrap.append(el('div', { className: 'field-top' }, label, edit, extra, reset), range);
    const paint = () => { range.style.setProperty('--p', `${((range.value - f.min) / (f.max - f.min)) * 100}%`); };
    refresh = () => {
      const v = read(), on = v != null;
      if (toggle) { toggle.checked = on; range.disabled = num.disabled = !on; }
      const shown = on ? v * scale : (f.fallback ?? 0) * scale;
      range.value = shown; num.value = fmtIn(shown); paint();
    };
  }
  const inner = refresh;
  const refreshAll = () => { inner(); const changed = !f.local && !same(read(), def()); reset.hidden = !changed; wrap.classList.toggle('changed', changed); };
  refresh = refreshAll; fieldRefreshers.push(refreshAll);
  refreshAll();
  wrap._fieldDef = f;
  return wrap;
}

function makeGroup(g) {
  const sec = el('section', { className: 'group' });
  const fields = g.fields.map(makeField);
  const head = el('div', { className: 'group-head' }, el('h2', { textContent: g.group }));
  if (!g.local) {
    const r = el('button', { type: 'button', className: 'btn ghost small', textContent: 'Restaurar seção' });
    r.onclick = () => { for (const f of g.fields) if (f.path) set(cfg, f.path, structuredClone(get(defaults, f.path))); refreshFields(); apply(); };
    head.append(r);
  }
  sec.append(head, ...(g.note ? [el('p', { className: 'group-note', textContent: g.note })] : []), ...fields);
  return sec;
}
const refreshFields = () => fieldRefreshers.forEach((f) => f());

function renderCamerasTab(panel) {
  panel.innerHTML = ''; fieldRefreshers.length = 0;
  const picker = el('div', { className: 'cam-picker', role: 'group' });
  picker.setAttribute('aria-label', 'Câmera a configurar');
  cfg.cameras.forEach((c, i) => {
    const b = el('button', { type: 'button', className: 'chip', textContent: c.name });
    b.setAttribute('aria-pressed', i === camIndex);
    b.onclick = () => { camIndex = i; renderPanels(); };
    picker.append(b);
  });
  const c = cfg.cameras[camIndex];
  panel.append(picker, el('p', { className: 'cam-meta', textContent: c.role === 'line' ? 'Câmera de linha: alinhada com a faixa, mede a altura no plano do obstáculo.' : 'Câmera de rastreamento: reconstrói a pose 3D da aeronave junto com as outras.' }));
  for (const g of camFields(camIndex)) panel.append(makeGroup(g));
}

function renderPanels() {
  const tabs = $('tabs'), panels = $('tabpanels');
  tabs.innerHTML = ''; panels.innerHTML = ''; fieldRefreshers.length = 0;
  for (const t of TABS) {
    const on = t.id === activeTab;
    const b = el('button', { type: 'button', className: 'tab', id: `tab-${t.id}`, textContent: t.label });
    b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', on); b.setAttribute('aria-controls', `panel-${t.id}`); b.tabIndex = on ? 0 : -1;
    b.onclick = () => { activeTab = t.id; renderPanels(); $(`tab-${t.id}`).focus(); };
    b.onkeydown = (e) => {
      const i = TABS.findIndex((x) => x.id === activeTab), n = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!n) return; e.preventDefault(); activeTab = TABS[(i + n + TABS.length) % TABS.length].id; renderPanels(); $(`tab-${activeTab}`).focus();
    };
    tabs.append(b);
  }
  const t = TABS.find((x) => x.id === activeTab);
  const panel = el('div', { className: 'tabpanel', id: `panel-${t.id}` });
  panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', `tab-${t.id}`);
  panels.append(panel);
  if (t.cameras) renderCamerasTab(panel);
  else for (const g of t.groups) panel.append(makeGroup(g));
}
renderPanels();

$('bResetAll').onclick = () => {
  if (!confirm('Restaurar todos os parâmetros para os valores do cenário carregado?')) return;
  cfg = structuredClone(defaults); renderPanels(); rebuild();
};
$('bExport').onclick = () => {
  const blob = new Blob([JSON.stringify(cfg, null, 2)], { type: 'text/yaml' });   // JSON é YAML válido
  const a = el('a', { href: URL.createObjectURL(blob), download: 'meu_cenario.yaml' }); a.click();
};

await rebuild();
// Acesso pelo console/automação: window.ui.state, window.ui.controls, window.ui.sim.
window.ui = { state, get controls() { return controls; }, get sim() { return sim; }, setPlaying, seek, selectCam };

// ------------------------------------------------------------------ laço
let last = performance.now(), rr = 0, fpsAvg = 0, fpsShown = 0;
{
  // Mostra qual GPU está renderizando (SwiftShader/llvmpipe = render por software, não é tempo real).
  const gl = cameraRenderer.renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
  const name = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'GPU desconhecida';
  const soft = /swiftshader|llvmpipe|software/i.test(name);
  $('sGpu').textContent = soft ? 'render por software (sem GPU)' : name.replace(/^ANGLE \((.*)\)$/, '$1').replace(/, Unspecified Version$/, '');
  $('perf').classList.toggle('soft', soft);
}
function frame(now) {
  const raw = (now - last) / 1000, dt = Math.min(raw, 0.1); last = now;
  if (raw > 0) fpsAvg = fpsAvg ? 0.9 * fpsAvg + 0.1 / raw : 1 / raw;
  if (now - fpsShown > 500) { $('sFps').textContent = fmt(fpsAvg, 0); fpsShown = now; }
  if (sim && !building) {
    if (state.playing) {
      state.t += dt * state.speed;
      if (state.t > sim.tEnd) { if (state.loop) state.t = Math.max(0, sim.tCross - 2.5); else { state.t = sim.tEnd; setPlaying(false); } }
    }
    const p = sim.poseAt(state.t);
    $('sT').textContent = fmt(state.t, 2); $('sX').textContent = fmt(p.x, 1); $('sV').textContent = fmt(p.V, 1);
    const time = $('time');
    if (document.activeElement !== time || state.playing) time.value = state.t;
    time.style.setProperty('--p', `${(state.t / sim.tEnd) * 100}%`);
    $('clock').textContent = `${fmt(state.t, 3)} / ${fmt(sim.tEnd, 1)} s`;
    controls.enabled = selected === 'free';
    const c = sim.byName[selected];
    sim.render(selected, state.t, Math.round(state.t * 1000));
    if (view.width !== c.W || view.height !== c.H) { view.width = c.W; view.height = c.H; }
    vctx.drawImage(glCanvas, 0, 0);
    if (state.previews) {
      // Uma miniatura por quadro (rodízio), para não pesar.
      const names = Object.keys(thumbs), n = names[rr++ % names.length];
      if (n !== selected) { sim.render(n, state.t, Math.round(state.t * 1000)); thumbs[n].ctx.drawImage(glCanvas, 0, 0, thumbs[n].cv.width, thumbs[n].cv.height); }
      else thumbs[n].ctx.drawImage(view, 0, 0, thumbs[n].cv.width, thumbs[n].cv.height);
    }
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
