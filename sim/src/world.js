// Cenário: céu, sol, grama, pista, obstáculo, cenário de fundo.
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { makeRng, deg } from './util.js';

function noiseTexture(size, base, variation, rng, { speckle = 0, repeat = 1, stripes = false } = {}) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  // Ruído em duas escalas (grão fino + manchas suaves).
  const coarseN = 16, coarse = new Float32Array(coarseN * coarseN).map(() => rng.uniform());
  const cs = (u, v) => {
    const x = u * coarseN, y = v * coarseN, x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    const g = (i, j) => coarse[((j + coarseN) % coarseN) * coarseN + ((i + coarseN) % coarseN)];
    return (g(x0, y0) * (1 - fx) + g(x0 + 1, y0) * fx) * (1 - fy) + (g(x0, y0 + 1) * (1 - fx) + g(x0 + 1, y0 + 1) * fx) * fy;
  };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let k = 1 + variation * (rng.uniform() - 0.5) * 2 + variation * 1.2 * (cs(x / size, y / size) - 0.5);
    if (speckle && rng.uniform() < speckle) k *= 1.35;
    if (stripes) k *= 1 + 0.05 * Math.sin((y / size) * Math.PI * 2 * 6);
    const i = 4 * (y * size + x);
    img.data[i] = Math.min(255, base[0] * k); img.data[i + 1] = Math.min(255, base[1] * k); img.data[i + 2] = Math.min(255, base[2] * k); img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat, repeat);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}

// Postes, faixa física opcional e painel de contraste.
export function buildObstacle(cfg) {
  const env = cfg.environment, L = cfg.runway.length_m, Wd = cfg.runway.width_m;
  const ob = cfg.obstacle, hw = ob.width_m / 2;
  const h = ob.tape ? ob.height_m : (ob.post_height_m ?? ob.height_m);   // com faixa física os postes têm a altura dela
  const orange = new THREE.MeshStandardMaterial({ color: '#f06a12', roughness: 0.6 });
  const white = new THREE.MeshStandardMaterial({ color: '#f2f2f2', roughness: 0.6 });
  const obstacle = new THREE.Group();
  if (ob.posts) for (const s of [-1, 1]) {
    const base = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.32, 0.03), orange); base.position.set(L, s * hw, 0.025);
    const cone = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.09, h, 14), orange);
    cone.rotation.x = Math.PI / 2; cone.position.set(L, s * hw, h / 2 + 0.03);
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.047, 0.06, h * 0.22, 14), white);
    band.rotation.x = Math.PI / 2; band.position.set(L, s * hw, h * 0.62);
    for (const m of [base, cone, band]) { m.castShadow = true; m.receiveShadow = true; obstacle.add(m); }
  }
  if (ob.tape) {
    const bow = ob.tape_bow_m_per_ms * env.wind.speed_ms * -Math.cos(deg(env.wind.direction_deg)) * -1;
    const pts = [];
    for (let i = 0; i <= 24; i++) { const s = i / 24, y = -hw + 2 * hw * s; pts.push(new THREE.Vector3(L + bow * 4 * s * (1 - s), y, h - 0.03 * 4 * s * (1 - s))); }
    const geo = new THREE.BufferGeometry(); const pos = [], idx = [];
    pts.forEach((p, i) => { pos.push(p.x, p.y, p.z + 0.02, p.x, p.y, p.z - 0.02); if (i) { const a = 2 * i; idx.push(a - 2, a - 1, a, a - 1, a + 1, a); } });
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); geo.setIndex(idx); geo.computeVertexNormals();
    const tape = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: '#ffe14a', emissive: '#554400', side: THREE.DoubleSide, roughness: 0.3 }));
    tape.castShadow = true; obstacle.add(tape);
  }
  if (ob.backdrop) {
    const line = (cfg.cameras ?? []).find((c) => c.role === 'line');
    const side = line && line.position[1] > 0 ? -1 : 1;
    const bd = new THREE.Mesh(new THREE.BoxGeometry(5, 0.04, 2.4), new THREE.MeshStandardMaterial({ color: ob.backdrop_color, roughness: 0.95 }));
    bd.position.set(L, side * (Wd / 2 + 1.5), 1.2); bd.castShadow = bd.receiveShadow = true; obstacle.add(bd);
  }
  return obstacle;
}

export function buildWorld(cfg) {
  const scene = new THREE.Scene();
  const rng = makeRng(cfg.seed + 4242);
  const env = cfg.environment, L = cfg.runway.length_m, Wd = cfg.runway.width_m;

  // --- Céu e sol ---
  const sunDir = new THREE.Vector3(
    Math.cos(deg(env.sun_elevation_deg)) * Math.cos(deg(env.sun_azimuth_deg)),
    Math.cos(deg(env.sun_elevation_deg)) * Math.sin(deg(env.sun_azimuth_deg)),
    Math.sin(deg(env.sun_elevation_deg)));
  const sky = new Sky();
  sky.scale.setScalar(4000);
  const u = sky.material.uniforms;
  u.up.value.set(0, 0, 1); u.sunPosition.value.copy(sunDir);
  u.turbidity.value = env.turbidity; u.rayleigh.value = 1.6; u.mieCoefficient.value = 0.004; u.mieDirectionalG.value = 0.8;
  scene.add(sky);
  scene.fog = new THREE.Fog(0xc4d6e6, 250, 1800);

  const hemi = new THREE.HemisphereLight(0xcfe3ff, 0x6a7a4a, 1.15);
  hemi.position.set(0, 0, 1); scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff3df, 3.4);
  sun.castShadow = !cfg.render?.no_shadows;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera; sc.left = -7; sc.right = 7; sc.top = 7; sc.bottom = -7; sc.near = 1; sc.far = 90;
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.01;
  scene.add(sun, sun.target);
  // A sombra de alta resolução acompanha um ponto de interesse (a aeronave).
  const focusShadow = (p) => {
    sun.target.position.copy(p); sun.position.copy(p).addScaledVector(sunDir, 45);
    sun.target.updateMatrixWorld();
  };
  focusShadow(new THREE.Vector3(L, 0, 0));

  // --- Solo ---
  const grassTex = noiseTexture(256, [86, 122, 52], 0.22, rng, { repeat: 500 });
  const grass = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000, 200, 200), new THREE.MeshStandardMaterial({ map: grassTex, roughness: 1 }));
  // Triângulos gigantes perdem precisão de profundidade no rasterizador: o solo é tesselado e fica 2 cm abaixo do asfalto.
  grass.position.z = -0.02; grass.receiveShadow = true; scene.add(grass);
  // Segunda camada de variação de cor em grande escala (evita aparência "azulejada").
  const patchTex = noiseTexture(128, [120, 130, 90], 0.5, rng, { repeat: 9 });
  const patches = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000, 200, 200), new THREE.MeshStandardMaterial({ map: patchTex, roughness: 1, transparent: true, opacity: 0.28, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }));
  patches.position.z = -0.015; if (!cfg.render?.no_patches) scene.add(patches);

  const total = L + cfg.runway.overrun_m + 12;
  const asphaltTex = noiseTexture(512, [74, 74, 78], 0.16, rng, { speckle: 0.03 });
  asphaltTex.repeat.set(total / 2.5, Wd / 2.5);
  const asphalt = new THREE.Mesh(new THREE.PlaneGeometry(total, Wd, Math.ceil(total / 2), 4), new THREE.MeshStandardMaterial({ map: asphaltTex, roughness: 0.95, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -6 }));
  asphalt.position.set(total / 2 - 12, 0, 0); asphalt.receiveShadow = true; scene.add(asphalt);

  const layer = { polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -12 };
  const paint = new THREE.MeshStandardMaterial({ color: '#e9e6da', roughness: 0.9, ...layer });
  const yellow = new THREE.MeshStandardMaterial({ color: '#e3b51c', roughness: 0.9, ...layer });
  const stripe = (x, y, lx, ly, mat = paint) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(lx, ly, Math.ceil(lx / 2), 1), mat);
    m.position.set(x, y, 0.003); m.receiveShadow = true; scene.add(m);
  };
  stripe(total / 2 - 12, Wd / 2 - 0.2, total, 0.12); stripe(total / 2 - 12, -Wd / 2 + 0.2, total, 0.12);
  for (let x = 2; x < L + cfg.runway.overrun_m - 2; x += 5) stripe(x + 1, 0, 2, 0.1);
  stripe(0, 0, 0.25, Wd - 0.6);                     // linha de largada
  stripe(L, 0, 0.12, Wd - 0.6, yellow);             // linha do obstáculo no asfalto
  for (let x = 10; x < L; x += 10) { stripe(x, Wd / 2 - 0.6, 0.08, 0.6); stripe(x, -Wd / 2 + 0.6, 0.08, 0.6); }

  const obstacle = buildObstacle(cfg);
  scene.add(obstacle);

  // --- Cenário de fundo ---
  if (env.scenery) {
    const trunkM = new THREE.MeshStandardMaterial({ color: '#4a3a28', roughness: 1 });
    const crown = new THREE.IcosahedronGeometry(1, 1), trunk = new THREE.CylinderGeometry(0.12, 0.16, 1, 6);
    const N = 420;
    const crowns = new THREE.InstancedMesh(crown, new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 1, flatShading: true }), N);
    const trunks = new THREE.InstancedMesh(trunk, trunkM, N);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), col = new THREE.Color();
    const qUp = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
    for (let i = 0; i < N; i++) {
      const ang = rng.uniform() * 2 * Math.PI, r = 95 + 160 * rng.uniform() ** 1.5;
      const x = L / 2 + r * Math.cos(ang) * 1.5, y = r * Math.sin(ang);
      const hgt = 5 + 7 * rng.uniform(), rad = 2 + 2.5 * rng.uniform();
      m4.compose(new THREE.Vector3(x, y, hgt * 0.5 + rad * 0.6), q.identity(), new THREE.Vector3(rad, rad, rad * (0.9 + 0.5 * rng.uniform())));
      crowns.setMatrixAt(i, m4);
      crowns.setColorAt(i, col.setHSL(0.26 + 0.07 * rng.uniform(), 0.38 + 0.2 * rng.uniform(), 0.16 + 0.1 * rng.uniform()));
      m4.compose(new THREE.Vector3(x, y, hgt * 0.25), qUp, new THREE.Vector3(1.6, hgt * 0.5, 1.6));
      trunks.setMatrixAt(i, m4);
    }
    scene.add(crowns, trunks);
    // Tendas das equipes ao lado da pista.
    const tentCols = ['#f0f0f0', '#2f62c8', '#d83a3a', '#f0f0f0', '#e8b923'];
    for (let i = 0; i < 7; i++) {
      const g = new THREE.Group(), s = 3;
      const roof = new THREE.Mesh(new THREE.ConeGeometry(s * 0.75, 1.1, 4), new THREE.MeshStandardMaterial({ color: tentCols[i % tentCols.length], roughness: 0.8 }));
      roof.rotation.set(Math.PI / 2, Math.PI / 4, 0); roof.position.z = 2.75; roof.castShadow = true; g.add(roof);
      for (const [a, b] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 2.2, 6), new THREE.MeshStandardMaterial({ color: '#cccccc' }));
        leg.rotation.x = Math.PI / 2; leg.position.set((a * s) / 2, (b * s) / 2, 1.1); g.add(leg);
      }
      g.position.set(-6 + i * 9.5, 24 + 3 * rng.uniform(), 0); scene.add(g);
    }
    // Biruta.
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 4, 8), white); pole.rotation.x = Math.PI / 2; pole.position.set(20, -16, 2); scene.add(pole);
    const sock = new THREE.Mesh(new THREE.ConeGeometry(0.22, 1.3, 10, 1, true), new THREE.MeshStandardMaterial({ color: '#ff5a1f', side: THREE.DoubleSide }));
    const wd = deg(env.wind.direction_deg);
    sock.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(Math.cos(wd), Math.sin(wd), -0.25 - 0.5 / (1 + env.wind.speed_ms)).normalize());
    sock.position.set(20 + 0.6 * Math.cos(wd), -16 + 0.6 * Math.sin(wd), 3.85); scene.add(sock);
  }

  return { scene, sunDir, focusShadow, obstacle };
}

// Mastro/tripé desenhado na posição de uma câmera.
export function buildMast(position) {
  const g = new THREE.Group();
  const dark = new THREE.MeshStandardMaterial({ color: '#2b2d31', roughness: 0.6, metalness: 0.4 });
  const [x, y, z] = position;
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.035, Math.max(z - 0.12, 0.05), 8), dark);
  pole.rotation.x = Math.PI / 2; pole.position.set(x, y, (z - 0.12) / 2); pole.castShadow = true; g.add(pole);
  for (let i = 0; i < 3; i++) {
    const a = (i * 2 * Math.PI) / 3 + 0.5, len = Math.min(0.9, z);
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, len * 1.25, 6), dark);
    const p0 = new THREE.Vector3(x, y, len * 0.9), p1 = new THREE.Vector3(x + 0.6 * len * Math.cos(a), y + 0.6 * len * Math.sin(a), 0);
    leg.position.copy(p0).add(p1).multiplyScalar(0.5);
    leg.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), p1.clone().sub(p0).normalize()); g.add(leg);
  }
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.08), dark);
  body.position.set(x, y, z - 0.09); g.add(body);
  return g;
}
