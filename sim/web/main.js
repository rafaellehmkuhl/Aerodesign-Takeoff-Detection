// Interface interativa: monta a cena, mostra a visão livre + a imagem de cada câmera (com
// vibração, distorção, ruído e motion blur) e deixa editar o cenário ao vivo.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import GUI from 'lil-gui';
import { createSim } from '/src/sim.js';
import { CameraRenderer } from '/src/cameras.js';

const $ = (id) => document.getElementById(id);
const glCanvas = $('gl'), view = $('view'), vctx = view.getContext('2d');
const cameraRenderer = new CameraRenderer(glCanvas);
const params = new URLSearchParams(location.search);
let cfg = await (await fetch('/api/config' + (params.get('scenario') ? `?scenario=${params.get('scenario')}` : ''))).json();
let sim = null, controls = null, selected = 'free', thumbs = {}, helpers = [];
const state = { t: 0, playing: true, speed: 1, loop: true, previews: true };

function frustumHelper(c) {
  const d = 10, hx = (c.W / 2 / c.fx) * d, hy = (c.H / 2 / c.fx) * d;
  const p = [[0, 0, 0], [hx, hy, -d], [-hx, hy, -d], [-hx, -hy, -d], [hx, -hy, -d]];
  const seg = [0, 1, 0, 2, 0, 3, 0, 4, 1, 2, 2, 3, 3, 4, 4, 1].flatMap((i) => p[i]);
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(seg, 3));
  const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: c.spec.role === 'line' ? 0x28dcff : 0xffd028 }));
  l.matrixAutoUpdate = false; c.truePoseAt(0, l.matrix); l.layers.set(1);
  return l;
}

async function rebuild() {
  $('busy').style.display = 'grid';
  await new Promise((r) => setTimeout(r, 20));
  const keep = sim ? { pos: sim.free.cam.position.clone(), target: controls.target.clone() } : null;
  sim = await createSim(cfg, { cameraRenderer });
  window.sim = sim;
  for (const c of sim.cams) { const h = frustumHelper(c); sim.scene.add(h); }
  sim.free.cam.layers.enable(1);
  if (controls) controls.dispose();
  controls = new OrbitControls(sim.free.cam, view);
  controls.target.set(cfg.runway.length_m - 2, 0, 1);
  if (keep) { sim.free.cam.position.copy(keep.pos); controls.target.copy(keep.target); }
  controls.update();

  const strip = $('strip'); strip.innerHTML = ''; thumbs = {};
  for (const c of [sim.free, sim.chase, ...sim.cams]) {
    const d = document.createElement('div'); d.className = 'thumb' + (c.name === selected ? ' sel' : '');
    const cv = document.createElement('canvas'); cv.width = 480; cv.height = Math.round((480 * c.H) / c.W);
    const s = document.createElement('span'); s.textContent = c.name === 'free' ? 'visão livre' : c.name + (c.spec.fps ? ` · ${c.W}×${c.H} @ ${c.spec.fps} fps` : '');
    d.append(cv, s); strip.append(d);
    d.onclick = () => { selected = c.name; for (const k in thumbs) thumbs[k].el.classList.toggle('sel', k === selected); $('mainLabel').textContent = c.name === 'free' ? 'visão livre (arraste para orbitar)' : s.textContent; };
    thumbs[c.name] = { el: d, ctx: cv.getContext('2d'), cv };
  }
  if (!thumbs[selected]) selected = 'free';
  const ev = sim.traj.events, cl = sim.truthClearance.clearance;
  $('sM').textContent = ev.mass_kg.toFixed(2); $('sVs').textContent = ev.v_stall.toFixed(1);
  $('sC').textContent = `${(cl * 100).toFixed(1)} cm`;
  $('verdict').textContent = cl > 0 ? 'VÁLIDA' : 'INVÁLIDA'; $('verdict').style.color = cl > 0 ? 'var(--ok)' : 'var(--bad)';
  state.t = Math.max(0, sim.tCross - 2.5);
  timeCtl?.max(sim.tEnd).updateDisplay();
  $('busy').style.display = 'none';
}

// ------------------------------------------------------------------ painel
const gui = new GUI({ container: $('side'), title: 'Cenário' });
let timeCtl = null;
const debounce = (fn, ms = 350) => { let h; return () => { clearTimeout(h); h = setTimeout(fn, ms); }; };
const apply = debounce(rebuild);

function buildGui() {
  gui.children.slice().forEach((c) => c.destroy());
  const play = gui.addFolder('Reprodução');
  play.add(state, 'playing').name('tocar');
  play.add(state, 'speed', { '1×': 1, '0.25×': 0.25, '0.1×': 0.1, '0.02×': 0.02 }).name('velocidade');
  timeCtl = play.add(state, 't', 0, 10, 0.001).name('tempo (s)').listen();
  play.add(state, 'previews').name('prévia das câmeras');
  play.add({ f: () => { state.t = sim.tCross - 0.5; } }, 'f').name('ir para o obstáculo');

  const env = gui.addFolder('Vento e ambiente');
  env.add(cfg.environment.wind, 'speed_ms', 0, 12, 0.1).name('vento (m/s)').onChange(apply);
  env.add(cfg.environment.wind, 'direction_deg', 0, 360, 5).name('direção (180 = proa)').onChange(apply);
  env.add(cfg.environment.wind, 'turbulence', 0, 0.6, 0.01).name('rajada (fração)').onChange(apply);
  env.add(cfg.environment, 'sun_elevation_deg', 5, 85, 1).name('sol: elevação').onChange(apply);
  env.add(cfg.environment, 'sun_azimuth_deg', 0, 360, 5).name('sol: azimute').onChange(apply);
  env.add(cfg, 'seed', 1, 999, 1).name('semente').onChange(apply);
  env.close();

  const dyn = gui.addFolder('Aeronave e decolagem');
  const tc = { on: cfg.dynamics.target_clearance_m != null, v: cfg.dynamics.target_clearance_m ?? 0.05 };
  const setTc = () => { cfg.dynamics.target_clearance_m = tc.on ? tc.v : null; apply(); };
  dyn.add(tc, 'on').name('fixar folga real').onChange(setTc);
  dyn.add(tc, 'v', -0.6, 1.5, 0.005).name('folga alvo (m)').onChange(setTc);
  dyn.add(cfg.dynamics, 'mass_kg', 4, 25, 0.1).name('massa (kg)').onChange(apply);
  dyn.add(cfg.dynamics, 'static_thrust_n', 15, 80, 1).name('tração estática (N)').onChange(apply);
  dyn.add(cfg.dynamics, 'lateral_offset_m', -2.5, 2.5, 0.05).name('desvio lateral (m)').onChange(apply);
  dyn.add(cfg.dynamics, 'roll_sigma_deg', 0, 10, 0.5).name('rolamento σ (°)').onChange(apply);
  dyn.add(cfg.aircraft, 'wingspan_m', 1.2, 3.5, 0.05).name('envergadura (m)').onChange(apply);
  dyn.add(cfg.obstacle, 'height_m', 0.3, 1.5, 0.01).name('altura do obstáculo').onChange(apply);
  dyn.add(cfg.obstacle, 'tape').name('faixa física').onChange(apply);
  dyn.add(cfg.obstacle, 'backdrop').name('painel de contraste').onChange(apply);
  dyn.close();

  const cams = gui.addFolder('Câmeras');
  for (const c of cfg.cameras) {
    const f = cams.addFolder(`${c.name} (${c.role === 'line' ? 'linha' : 'rastreamento'})`);
    const P = { x: c.position[0], y: c.position[1], z: c.position[2], ax: c.look_at[0], ay: c.look_at[1], az: c.look_at[2], w: c.resolution[0], h: c.resolution[1] };
    const sync = () => { c.position = [P.x, P.y, P.z]; c.look_at = [P.ax, P.ay, P.az]; c.resolution = [P.w, P.h]; apply(); };
    f.add(P, 'x', -10, 130, 0.05).name('posição x').onChange(sync);
    f.add(P, 'y', -30, 30, 0.05).name('posição y').onChange(sync);
    f.add(P, 'z', 0.1, 15, 0.01).name('altura z').onChange(sync);
    f.add(P, 'ax', -10, 130, 0.05).name('mira x').onChange(sync);
    f.add(P, 'ay', -30, 30, 0.05).name('mira y').onChange(sync);
    f.add(P, 'az', 0, 10, 0.01).name('mira z').onChange(sync);
    f.add(c, 'hfov_deg', 5, 120, 1).name('FOV horizontal (°)').onChange(apply);
    f.add(P, 'w', [640, 1280, 1920, 2560, 3840]).name('largura (px)').onChange(() => { P.h = Math.round((P.w * 9) / 16); sync(); });
    f.add(c, 'fps', [30, 60, 120, 240, 480, 960]).name('fps').onChange(apply);
    f.add(c, 'exposure_s', 0.00005, 0.02, 0.00005).name('exposição (s)').onChange(apply);
    f.add(c, 'noise_sigma', 0, 0.08, 0.001).name('ruído do sensor').onChange(apply);
    f.add(c.distortion, 'k1', -0.4, 0.4, 0.005).name('distorção k1').onChange(apply);
    f.add(c.vibration, 'rms_deg', 0, 0.3, 0.002).name('vibração rms (°)').onChange(apply);
    f.add(c.vibration, 'sway_deg_per_ms', 0, 0.1, 0.001).name('balanço (°/(m/s))').onChange(apply);
    f.add(c.calibration_error, 'rotation_sigma_deg', 0, 1, 0.005).name('erro calib. rot σ (°)').onChange(apply);
    f.add(c.calibration_error, 'position_sigma_m', 0, 0.3, 0.002).name('erro calib. pos σ (m)').onChange(apply);
    f.close();
  }

  gui.add({ f: () => {
    const blob = new Blob([JSON.stringify(cfg, null, 2)], { type: 'text/yaml' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'meu_cenario.yaml'; a.click();
  } }, 'f').name('⬇ exportar cenário (.yaml)');
}

buildGui();
await rebuild();

// ------------------------------------------------------------------ laço
let last = performance.now(), rr = 0;
function blit(ctx, cv) { ctx.drawImage(glCanvas, 0, 0, cv.width, cv.height); }
function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.1); last = now;
  if (sim && $('busy').style.display === 'none') {
    if (state.playing) { state.t += dt * state.speed; if (state.t > sim.tEnd) state.t = Math.max(0, sim.tCross - 2.5); }
    const p = sim.poseAt(state.t);
    $('sT').textContent = state.t.toFixed(2); $('sX').textContent = p.x.toFixed(1); $('sV').textContent = p.V.toFixed(1);
    controls.enabled = selected === 'free';
    const c = sim.byName[selected];
    sim.render(selected, state.t, Math.round(state.t * 1000));
    if (view.width !== c.W || view.height !== c.H) { view.width = c.W; view.height = c.H; }
    vctx.drawImage(glCanvas, 0, 0);
    if (state.previews) {
      // Uma prévia por quadro (rodízio), para não pesar.
      const names = Object.keys(thumbs); const n = names[rr++ % names.length];
      if (n !== selected) { sim.render(n, state.t, Math.round(state.t * 1000)); blit(thumbs[n].ctx, thumbs[n].cv); }
      else thumbs[n].ctx.drawImage(view, 0, 0, thumbs[n].cv.width, thumbs[n].cv.height);
    }
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
