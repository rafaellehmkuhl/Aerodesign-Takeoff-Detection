// Parâmetros documentados do cenário: rótulo, unidade, faixa e opções de cada um.
// Compartilhado pela interface (sim/web/main.js), pela API HTTP e pelo servidor MCP (sim/api.mjs).
// Sem dependências de DOM: roda no navegador e no Node.

// Cada campo aponta para um caminho no cenário. `scale` converte a unidade guardada para a exibida.
export const RESOLUTIONS = [[1280, 720], [1920, 1080], [2560, 1440], [3840, 2160]];
export const camFields = (i) => [
  { group: 'Posição e mira', note: 'x ao longo da pista (largada em 0, obstáculo em 55), y para a esquerda, z para cima.', fields: [
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
export const TABS = [
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
      { kind: 'range', path: 'obstacle.height_m', label: 'Altura da fita', help: 'Regulamento 2026: 90 cm.', unit: 'cm', scale: 100, min: 30, max: 150, step: 1 },
      { kind: 'switch', path: 'obstacle.tape', label: 'Fita zebrada entre as hastes' },
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


// ------------------------------------------------------------------ caminhos
// Um caminho é "a.b.c". Dentro de listas aceita o índice ou o `name` do item: cameras.linecam.fps = cameras.0.fps.
export function resolvePath(obj, path) {
  const keys = String(path).split('.').filter((k) => k !== '');
  const out = [];
  let o = obj;
  for (const k of keys) {
    if (Array.isArray(o) && !/^\d+$/.test(k)) {
      const i = o.findIndex((it) => it && it.name === k);
      if (i < 0) return null;
      out.push(String(i)); o = o[i];
    } else {
      if (o == null || typeof o !== 'object' || !(k in o)) return null;
      out.push(k); o = o[k];
    }
  }
  return out.join('.');
}
export const getPath = (o, path) => String(path).split('.').filter((k) => k !== '').reduce((a, k) => (a == null ? a : a[k]), o);
export function setPath(o, path, v) { const ks = String(path).split('.'), last = ks.pop(); ks.reduce((a, k) => a[k], o)[last] = v; }

// Lista plana de todos os parâmetros documentados, com o caminho real (câmeras expandidas por índice e nome).
export function documentedParams(cfg) {
  const out = [];
  const push = (f, tab, group, cam) => {
    if (f.local || !f.path) return;
    const scale = f.scale ?? 1;
    const p = { path: f.path, alias: cam ? f.path.replace(/^cameras\.\d+\./, `cameras.${cam}.`) : undefined, tab, group, label: f.label, help: f.help, kind: f.kind, unit_display: f.unit, scale };
    if (f.min != null) { p.min = f.min / scale; p.max = f.max / scale; p.step = f.step / scale; }
    if (f.options) p.options = f.options.map(([label, value]) => ({ label, value }));
    if (f.kind === 'nullable') p.nullable = true;
    out.push(p);
  };
  for (const t of TABS) {
    if (t.cameras) (cfg.cameras ?? []).forEach((c, i) => camFields(i).forEach((g) => g.fields.forEach((f) => push(f, t.label, `${c.name} · ${g.group}`, c.name))));
    else for (const g of t.groups) for (const f of g.fields) push(f, t.label, g.group);
  }
  return out;
}
