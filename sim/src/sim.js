// Monta a simulação completa: mundo + aeronave + trajetória + câmeras.
import * as THREE from 'three';
import { buildWorld, buildMast } from './world.js';
import { buildAircraft, poseMatrix } from './aircraft.js';
import { simulateTakeoff, clearanceFromPoses } from './physics.js';
import { buildCamera, idealCamera, CameraRenderer } from './cameras.js';

THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

export async function createSim(cfg, { canvas, cameraRenderer, baseUrl = location.href, assetsUrl = '/assets/' } = {}) {
  const world = buildWorld(cfg);
  const { scene } = world;
  const ac = await buildAircraft(cfg, baseUrl, assetsUrl);
  scene.add(ac.group);
  ac.group.matrixAutoUpdate = false;

  const L = cfg.runway.length_m, hObs = cfg.obstacle.height_m;
  const verts = Float64Array.from(ac.mesh.vertices);

  // --- Trajetória ---
  const makePoseAt = (traj) => {
    const s = traj.samples, dt = traj.dt, tmp = { x: 0, y: 0, z: 0, roll: 0, pitch: 0, yaw: 0 }, m = new THREE.Matrix4();
    return (t) => {
      const f = Math.min(Math.max(t / dt, 0), s.length - 1.0001), i = Math.floor(f), a = f - i, p = s[i], q = s[i + 1];
      for (const k of ['x', 'y', 'z', 'roll', 'pitch', 'yaw']) tmp[k] = p[k] + a * (q[k] - p[k]);
      poseMatrix(tmp, m);
      return { ...tmp, V: p.V, airborne: p.airborne, matrix: m.elements, m };
    };
  };
  const clearanceOf = (traj, step = 1 / 1000) => {
    const tc = traj.events.t_cross;
    return clearanceFromPoses(makePoseAt(traj), tc - 0.6, Math.min(tc + 0.6, traj.samples.at(-1).t), verts, L, hObs, step);
  };
  const traj = simulateTakeoff(cfg, (tr) => clearanceOf(tr).clearance);
  const poseAt = makePoseAt(traj);
  const tCross = traj.events.t_cross, tEnd = traj.samples.at(-1).t;
  const truthClearance = clearanceOf(traj, 1 / 4000);

  // --- Câmeras ---
  const cams = cfg.cameras.map((spec, i) => buildCamera(spec, cfg, i));
  for (const c of cams) {
    const w = c.spec.record_window_s, n = Math.max(1, Math.round((w[1] - w[0]) * c.spec.fps));
    c.times = Array.from({ length: n }, (_, k) => tCross + w[0] + k / c.spec.fps).filter((t) => t >= 0 && t <= tEnd);
    // Motion blur: nº de sub-amostras conforme o borrão esperado em pixels no obstáculo.
    const dist = Math.hypot(c.spec.position[0] - L, c.spec.position[1], c.spec.position[2] - hObs);
    const blurPx = (poseAt(tCross).V * c.spec.exposure_s * c.fx) / dist;
    c.blurPx = blurPx;
    c.blurN = c.spec.blur_samples === 'auto' || c.spec.blur_samples == null ? Math.min(8, Math.max(1, Math.ceil(blurPx / 1.5))) : c.spec.blur_samples;
    if (c.spec.mast && cfg.environment.scenery) scene.add(buildMast(c.spec.position));
  }
  const chase = idealCamera('chase', cfg.chase.resolution, cfg.chase.hfov_deg);
  const free = idealCamera('free', [1280, 720], 50);
  free.cam.position.set(L - 17, -21, 9); free.cam.lookAt(L - 2, 0, 1);

  // --- Fantasmas (poses estimadas pelos algoritmos, para o replay 3D) ---
  const ghosts = [];
  const ghostGeo = new THREE.BufferGeometry();
  ghostGeo.setAttribute('position', new THREE.Float32BufferAttribute(ac.mesh.vertices, 3));
  ghostGeo.setIndex(ac.mesh.faces); ghostGeo.computeVertexNormals();
  const ghostEdges = new THREE.EdgesGeometry(ghostGeo, 30);
  const setGhosts = (list) => {
    for (const g of ghosts) scene.remove(g.mesh);
    ghosts.length = 0;
    for (const g of list) {
      const mesh = new THREE.LineSegments(ghostEdges, new THREE.LineBasicMaterial({ color: g.color, transparent: true, opacity: 0.9 }));
      mesh.matrixAutoUpdate = false; mesh.visible = false; scene.add(mesh);
      ghosts.push({ ...g, mesh });
    }
  };
  const _p0 = new THREE.Vector3(), _p1 = new THREE.Vector3(), _q0 = new THREE.Quaternion(), _q1 = new THREE.Quaternion(), _one = new THREE.Vector3(1, 1, 1);
  const updateGhosts = (t) => {
    for (const g of ghosts) {
      const P = g.poses;
      if (!P.length || t < P[0].t || t > P.at(-1).t) { g.mesh.visible = false; continue; }
      let i = 0; while (i < P.length - 2 && P[i + 1].t < t) i++;
      const a = P[i], b = P[i + 1] ?? a, f = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
      _p0.fromArray(a.p).lerp(_p1.fromArray(b.p), f); _q0.fromArray(a.q).slerp(_q1.fromArray(b.q), f);
      g.mesh.matrix.compose(_p0, _q0, _one); g.mesh.visible = true;
    }
  };

  const _pos = new THREE.Vector3();
  const setTime = (t) => {
    const p = poseAt(t);
    ac.group.matrix.copy(p.m); ac.group.matrixWorldNeedsUpdate = true;
    if (ac.group.userData.prop) ac.group.userData.prop.rotation.x = ((cfg.aircraft.prop_rpm * 2 * Math.PI) / 60) * t;
    world.focusShadow(_pos.set(p.x, p.y, 0));
    updateGhosts(t);
    return p;
  };
  const aimChase = (t) => {
    const p = poseAt(t), k = Math.min(Math.max((p.x - (L - 14)) / 14, 0), 1);
    // Acompanha a corrida de lado/trás e fecha o enquadramento perto do obstáculo.
    chase.cam.position.set(p.x - 5.5 + 5.0 * k, p.y - 7.5 + 1.5 * k, 1.9 + 0.5 * p.z);
    chase.cam.lookAt(p.x + 0.8, p.y, p.z + 0.1);
  };

  const cr = cameraRenderer ?? (canvas ? new CameraRenderer(canvas, { msaa: cfg.render?.msaa ?? 4 }) : null);
  const byName = Object.fromEntries([...cams, chase, free].map((c) => [c.name, c]));
  const render = (name, t, frameIndex = 0) => {
    const c = byName[name];
    if (name === 'chase') aimChase(t);
    cr.render(scene, c, t, setTime, frameIndex);
  };

  const quat = (t) => {
    const q = new THREE.Quaternion().setFromRotationMatrix(poseAt(t).m);
    return [q.x, q.y, q.z, q.w];
  };
  const metadata = () => ({
    world: { runway_length_m: L, obstacle_x_m: L, obstacle_height_m: hObs, obstacle_width_m: cfg.obstacle.width_m },
    aircraft: { vertices: ac.mesh.vertices.map((v) => +v.toFixed(5)), faces: ac.mesh.faces, markers: ac.markers, aruco_dictionary: 'DICT_4X4_50' },
    calibration: cams.map((c) => c.calibration),
    frames: Object.fromEntries(cams.map((c) => [c.name, c.times])),
    ground_truth: {
      events: traj.events, t_end: tEnd,
      clearance_m: truthClearance.clearance, clearance_t: truthClearance.t, clearance_y_m: truthClearance.y,
      verdict: truthClearance.clearance > 0 ? 'PASS' : 'FAIL',
      poses: (() => {
        const out = [];
        for (let t = Math.max(0, tCross - 2.0); t <= tEnd; t += 1 / 500) { const p = poseAt(t); out.push({ t, p: [p.x, p.y, p.z], q: quat(t), V: p.V }); }
        return out;
      })(),
      run: (() => { const out = []; for (let t = 0; t <= tEnd; t += 0.05) { const p = poseAt(t); out.push({ t, x: p.x, y: p.y, z: p.z, V: p.V, pitch: p.pitch }); } return out; })(),
      cameras: Object.fromEntries(cams.map((c) => [c.name, c.times.map((t) => c.truth(t))])),
    },
  });

  // Espera as texturas (marcadores) carregarem.
  await new Promise((res) => {
    const mgr = THREE.DefaultLoadingManager; let pending = false;
    mgr.onStart = () => { pending = true; }; mgr.onLoad = () => res();
    setTimeout(() => { if (!pending) res(); }, 300);
    setTimeout(res, 5000);
  });

  return { cfg, scene, world, aircraft: ac, traj, poseAt, cams, chase, free, byName, setTime, render, renderer: cr, metadata, setGhosts, tCross, tEnd, truthClearance };
}
