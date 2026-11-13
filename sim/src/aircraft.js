// Aeronave: geometria paramétrica (ou GLB), marcadores ArUco e exportação da malha
// no referencial do corpo (x para frente, y para a esquerda, z para cima, origem no CG).
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const std = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.0, ...o });

function airfoilShape(chord, xLE, thickness = 0.13, camber = 0.05) {
  // Perfil espesso e arqueado (estilo alta sustentação), em coordenadas (x corpo, z).
  const up = [], lo = [];
  const n = 14;
  for (let i = 0; i <= n; i++) {
    const s = 0.5 * (1 - Math.cos((Math.PI * i) / n)); // 0 (BA) .. 1 (BF)
    const yt = 5 * thickness * (0.2969 * Math.sqrt(s) - 0.126 * s - 0.3516 * s * s + 0.2843 * s ** 3 - 0.1036 * s ** 4);
    const yc = camber * 4 * s * (1 - s);
    up.push([xLE - s * chord, (yc + yt) * chord]);
    lo.push([xLE - s * chord, (yc - yt) * chord]);
  }
  const shape = new THREE.Shape();
  shape.moveTo(up[0][0], up[0][1]);
  for (let i = 1; i <= n; i++) shape.lineTo(up[i][0], up[i][1]);
  for (let i = n - 1; i >= 0; i--) shape.lineTo(lo[i][0], lo[i][1]);
  return shape;
}

function wingSegment(shape, y0, y1, z, mat) {
  const g = new THREE.ExtrudeGeometry(shape, { depth: y1 - y0, bevelEnabled: false, steps: 1 });
  g.rotateX(Math.PI / 2);      // (X, Y, Z) -> (X, -Z, Y): extrusão vai para -y
  g.translate(0, y1, z);
  const m = new THREE.Mesh(g, mat);
  m.castShadow = m.receiveShadow = true;
  return m;
}

function box(w, d, h, mat, x, y, z) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, d, h), mat);
  m.position.set(x, y, z); m.castShadow = m.receiveShadow = true;
  return m;
}

function buildParametric(a) {
  const g = new THREE.Group();
  const c = a.colors;
  const mWing = std(c.wing), mTip = std(c.wing_tip), mFus = std(c.fuselage), mTail = std(c.tail);
  const mDark = std('#15171a', { roughness: 0.9 }), mAcc = std(c.accent), mMetal = std('#b9bcc2', { metalness: 0.6, roughness: 0.35 });

  // Asa (alta), 1/4 de corda próximo do CG.
  const b = a.wingspan_m, ch = a.chord_m, xLE = 0.02 + 0.27 * ch;
  const shape = airfoilShape(ch, xLE);
  const tip = 0.16 * b;
  g.add(wingSegment(shape, -b / 2, -b / 2 + tip, a.wing_z_m, mTip));
  g.add(wingSegment(shape, -b / 2 + tip, b / 2 - tip, a.wing_z_m, mWing));
  g.add(wingSegment(shape, b / 2 - tip, b / 2, a.wing_z_m, mTip));
  // Faixa de acabamento no intradorso/centro (dá textura à asa).
  g.add(box(ch * 0.9, 0.05, 0.004, mAcc, xLE - ch * 0.5, 0.33 * b, a.wing_z_m + 0.062 * ch + 0.02));
  g.add(box(ch * 0.9, 0.05, 0.004, mAcc, xLE - ch * 0.5, -0.33 * b, a.wing_z_m + 0.062 * ch + 0.02));

  // Fuselagem (compartimento de carga) + nariz + cone de cauda + tubo.
  const fl = a.fuselage_length_m, fw = a.fuselage_width_m, fh = a.fuselage_height_m;
  const xF = 0.42 * fl, xB = xF - fl, zF = a.wing_z_m - fh / 2 + 0.01;
  g.add(box(fl, fw, fh, mFus, (xF + xB) / 2, 0, zF));
  const nose = new THREE.Mesh(new THREE.CylinderGeometry(0.045, fw * 0.7, 0.14, 4, 1), mFus);
  nose.rotation.set(0, Math.PI / 4, 0); nose.rotateOnWorldAxis(new THREE.Vector3(0, 0, 1), -Math.PI / 2);
  nose.scale.set(1, 1, fh / fw); nose.position.set(xF + 0.07, 0, zF); nose.castShadow = true; g.add(nose);
  const motor = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.06, 16), mMetal);
  motor.rotation.z = Math.PI / 2; motor.position.set(xF + 0.16, 0, zF); g.add(motor);
  const tcone = new THREE.Mesh(new THREE.CylinderGeometry(fw * 0.7, 0.025, 0.3, 4, 1), mFus);
  tcone.rotation.set(0, Math.PI / 4, 0); tcone.rotateOnWorldAxis(new THREE.Vector3(0, 0, 1), -Math.PI / 2);
  tcone.scale.set(1, 1, fh / fw); tcone.position.set(xB - 0.15, 0, zF); tcone.castShadow = true; g.add(tcone);
  const xT = -a.tail_arm_m;
  const boom = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, Math.abs(xT - xB) + 0.1, 10), mDark);
  boom.rotation.z = Math.PI / 2; boom.position.set((xT + xB) / 2 - 0.02, 0, zF); boom.castShadow = true; g.add(boom);

  // Empenagem.
  g.add(box(a.htail_chord_m, a.htail_span_m, 0.012, mTail, xT, 0, zF + 0.012));
  g.add(box(a.htail_chord_m * 0.9, 0.01, a.vtail_height_m, mTip, xT - 0.01, 0, zF + a.vtail_height_m / 2));

  // Trem de pouso triciclo.
  const r = a.wheel_diameter_m / 2, zW = -a.gear_height_m + r;
  const wheel = (x, y) => {
    const w = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.024, 20), mDark);
    w.position.set(x, y, zW); w.castShadow = true; g.add(w);
  };
  const strut = (x0, y0, z0, x1, y1, z1) => {
    const p0 = new THREE.Vector3(x0, y0, z0), p1 = new THREE.Vector3(x1, y1, z1);
    const s = new THREE.Mesh(new THREE.CylinderGeometry(0.007, 0.007, p0.distanceTo(p1), 6), mMetal);
    s.position.copy(p0).add(p1).multiplyScalar(0.5);
    s.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), p1.clone().sub(p0).normalize());
    s.castShadow = true; g.add(s);
  };
  const zBot = zF - fh / 2;
  for (const s of [-1, 1]) {
    wheel(a.main_gear_x_m, (s * a.gear_track_m) / 2);
    strut(a.main_gear_x_m, s * fw * 0.4, zBot, a.main_gear_x_m, (s * a.gear_track_m) / 2 - s * 0.016, zW);
  }
  wheel(a.nose_gear_x_m, 0);
  strut(a.nose_gear_x_m - 0.03, 0.016, zBot, a.nose_gear_x_m, 0.016, zW);

  // Hélice (gira; não entra na malha exportada).
  const prop = new THREE.Group();
  prop.position.set(xF + 0.2, 0, zF);
  const blade = new THREE.Mesh(new THREE.BoxGeometry(0.008, a.prop_diameter_m, 0.03), std('#2a2a2a'));
  blade.castShadow = true; prop.add(blade);
  const spin = new THREE.Mesh(new THREE.ConeGeometry(0.024, 0.05, 14), mAcc);
  spin.rotation.z = -Math.PI / 2; spin.position.x = 0.02; prop.add(spin);
  prop.traverse((o) => { o.userData.noExport = true; });
  g.add(prop);
  g.userData.prop = prop;
  return g;
}

// Filme termo-retrátil transparente: quase invisível de frente, mais opaco/reflexivo em ângulo rasante.
function filmMaterial(src) {
  const m = new THREE.MeshPhysicalMaterial({ color: src.color ?? 0xe8ecf2, roughness: 0.08, metalness: 0, ior: 1.5, transparent: true, depthWrite: false, side: THREE.DoubleSide, envMapIntensity: 1.2 });
  m.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace('#include <opaque_fragment>', `
      float fres = pow(1.0 - abs(dot(normalize(vViewPosition), normal)), 2.5);
      float filmA = mix(0.10, 0.55, fres) + min(dot(totalSpecular, vec3(0.3333)), 1.0);
      outgoingLight = min(outgoingLight, vec3(2.5));
      gl_FragColor = vec4(outgoingLight, clamp(filmA, 0.0, 1.0));`);
  };
  return m;
}

async function buildFromGLB(a, baseUrl) {
  const gltf = await new GLTFLoader().loadAsync(new URL(a.model, baseUrl).href);
  const g = new THREE.Group();
  const inner = gltf.scene;
  inner.scale.setScalar(a.model_scale ?? 1);
  const [rx, ry, rz] = (a.model_rotation_deg ?? [0, 0, 0]).map((d) => (d * Math.PI) / 180);
  inner.rotation.set(rx, ry, rz, 'ZYX');
  // `model_origin_m`: onde fica o CG nas coordenadas do modelo (já em x-frente, y-esquerda, z-cima).
  const o = a.model_origin_m ?? [0, 0, 0];
  inner.position.set(-o[0], -o[1], -o[2]);
  g.add(inner);
  g.updateMatrixWorld(true);
  const films = new Map();
  let prop = null;
  inner.traverse((n) => {
    if (!n.isMesh) return;
    n.castShadow = n.receiveShadow = true;
    const name = n.name.toLowerCase(), mat = n.material;
    if (/adesivo|decal|sticker/.test(name)) { n.userData.noExport = true; n.castShadow = false; mat.polygonOffset = true; mat.polygonOffsetFactor = -2; mat.polygonOffsetUnits = -4; }
    if (mat && /film|filme/i.test(mat.name)) {
      if (!films.has(mat)) films.set(mat, filmMaterial(mat));
      n.material = films.get(mat); n.castShadow = false; n.renderOrder = 2; n.userData.film = true;
    } else if (mat) {
      mat.envMapIntensity = 1.0;
      // Metal polido em tubos finos estoura em branco puro (reflexo do sol sem área): trata como alumínio escovado.
      if (mat.metalness > 0.5 && !mat.userData.tuned) { mat.roughness = Math.max(mat.roughness, 0.55); mat.metalness = 0.7; mat.color.multiplyScalar(0.55); mat.userData.tuned = true; }
    }
    if (/^(helice|propeller|prop)\b/.test(name)) prop = n;
  });
  if (prop) {
    // A hélice gira em torno do eixo x do corpo, passando pelo centro dela.
    const c = new THREE.Box3().setFromObject(prop).getCenter(new THREE.Vector3());
    const pivot = new THREE.Group(); pivot.position.copy(c); g.add(pivot); pivot.updateMatrixWorld(true);
    pivot.attach(prop); prop.userData.noExport = true;
    g.userData.prop = pivot;
  }
  return g;
}

// Adesivos ArUco colados no extradorso. Cada adesivo é uma malha que acompanha a superfície da asa:
// ao longo da direção "cima" do marcador (normalmente a corda) as posições são medidas em comprimento de
// arco sobre o perfil, como um vinil que dobra sem esticar; na outra direção a asa é praticamente reta.
async function addMarkers(g, a, assetsUrl) {
  if (a.markers_enabled === false || !(a.markers ?? []).length) return [];
  g.updateMatrixWorld(true);
  const all = [];
  g.traverse((o) => { if (o.isMesh && !o.userData.noExport) all.push(o); });
  const ray = new THREE.Raycaster(), down = new THREE.Vector3(0, 0, -1), org = new THREE.Vector3();
  const loader = new THREE.ImageLoader();
  const margin = a.marker_margin ?? 0.12, out = [];
  for (const mk of a.markers) {
    const h = mk.size_m / 2, F = mk.size_m * (1 + 2 * margin), half = F / 2;
    const yaw = ((mk.yaw_deg ?? 0) * Math.PI) / 180, d = [Math.cos(yaw), Math.sin(yaw)], p = [-Math.sin(yaw), Math.cos(yaw)];
    const [cx, cy] = mk.position;
    // Só as malhas cuja caixa cobre a região do adesivo (o modelo inteiro tem dezenas de milhares de triângulos).
    const reg = new THREE.Box3(new THREE.Vector3(cx - F, cy - F, -10), new THREE.Vector3(cx + F, cy + F, 10));
    // O adesivo vai na pele externa: o filme da asa, quando o modelo tem um (senão, a superfície mais alta).
    // `marker_surface` (regex de nome de objeto) escolhe outra superfície.
    const near = all.filter((o) => new THREE.Box3().setFromObject(o).intersectsBox(reg));
    // O adesivo assenta no envelope externo da asa (filme e estrutura logo abaixo dele, como a caixa de
    // torção que no modelo aflora um pouco acima do filme). `marker_surface` (regex de nome) restringe.
    const pick = a.marker_surface ? near.filter((o) => new RegExp(a.marker_surface, 'i').test(o.name)) : near;
    const targets = pick.length ? pick : near;
    // Vinil esticado: segue o perfil onde ele é convexo e passa reto por cima de degraus e frestas
    // (envoltória convexa superior dos pontos do perfil).
    const upperHull = (xs, zs) => {
      const h = [];
      for (let k = 0; k < xs.length; k++) {
        while (h.length >= 2) {
          const [i, j] = [h[h.length - 2], h[h.length - 1]];
          if ((xs[j] - xs[i]) * (zs[k] - zs[i]) - (zs[j] - zs[i]) * (xs[k] - xs[i]) >= 0) h.pop(); else break;
        }
        h.push(k);
      }
      return xs.map((x) => { let m = 1; while (m < h.length - 1 && xs[h[m]] < x) m++; const i = h[m - 1], j = h[m]; return zs[i] + ((zs[j] - zs[i]) * (x - xs[i])) / (xs[j] - xs[i] || 1); });
    };
    // Um raio exatamente sobre a costura entre duas malhas (ex.: a borda do aileron) passa pela fresta:
    // nesse caso tenta posições vizinhas a até 2 mm.
    const JIT = [[0, 0], [0, 0.0012], [0, -0.0012], [0.0012, 0], [-0.0012, 0], [0, 0.002], [0, -0.002]];
    const topAt = (x, y) => {
      for (const [jx, jy] of JIT) { org.set(x + jx, y + jy, 20); ray.set(org, down); const hit = ray.intersectObjects(targets, false)[0]; if (hit) return hit.point.z; }
      return null;
    };
    // Perfil ao longo de "cima" para cada linha, parametrizado por comprimento de arco a partir do centro.
    const NB = 9, NA = 28, step = 0.003, reach = half * 1.6, grid = [];
    for (let jb = 0; jb < NB; jb++) {
      const b = -half + (F * jb) / (NB - 1);            // coordenada "direita" do marcador
      const bx = cx - p[0] * b, by = cy - p[1] * b;      // direita = -p
      const xs = [], zs = [];
      for (let u = -reach; u <= reach + 1e-9; u += step) { const z = topAt(bx + d[0] * u, by + d[1] * u); if (z != null) { xs.push(u); zs.push(z); } }
      if (xs.length < 4) throw new Error(`adesivo ${mk.id}: a asa não está sob o ponto (${cx}, ${cy})`);
      zs.splice(0, zs.length, ...upperHull(xs, zs));
      const arc = [0]; for (let k = 1; k < xs.length; k++) arc.push(arc[k - 1] + Math.hypot(xs[k] - xs[k - 1], zs[k] - zs[k - 1]));
      const k0 = xs.reduce((m, u, k) => (Math.abs(u) < Math.abs(xs[m]) ? k : m), 0), a0 = arc[k0] - xs[k0];   // arco no centro (u = 0)
      const at = (s) => {                                    // posição (u, z) e inclinação no arco s (relativo ao centro)
        const t = s + a0; let k = 1; while (k < arc.length - 1 && arc[k] < t) k++;
        const f = Math.min(Math.max((t - arc[k - 1]) / (arc[k] - arc[k - 1] || 1), 0), 1);
        return { u: xs[k - 1] + f * (xs[k] - xs[k - 1]), z: zs[k - 1] + f * (zs[k] - zs[k - 1]), du: xs[k] - xs[k - 1], dz: zs[k] - zs[k - 1] };
      };
      grid.push({ b, bx, by, at });
    }
    const lift = 0.0006;                                     // espessura do vinil + folga contra z-fighting
    let zFlat = -Infinity;
    // Montagem: 'adesivo' cola na pele e curva com ela; 'placa' é o mesmo marcador numa placa rígida plana
    // apoiada no ponto mais alto da asa sob ela (2 mm de espessura).
    const plate = (a.marker_mount ?? 'adesivo') === 'placa';
    if (plate) for (const row of grid) for (let k = 0; k <= 20; k++) zFlat = Math.max(zFlat, row.at(-half + (F * k) / 20).z);
    const point = (row, s) => {
      if (plate) return new THREE.Vector3(row.bx + d[0] * s, row.by + d[1] * s, zFlat + 0.002);
      const q = row.at(s), n = Math.hypot(q.du, q.dz) || 1;  // normal no plano (direção cima, z)
      const un = -q.dz / n, zn = q.du / n;
      return new THREE.Vector3(row.bx + d[0] * (q.u + un * lift), row.by + d[1] * (q.u + un * lift), q.z + zn * lift);
    };
    const pos = [], uv = [], idx = [];
    for (let jb = 0; jb < NB; jb++) for (let ia = 0; ia < NA; ia++) {
      const s = -half + (F * ia) / (NA - 1), v = point(grid[jb], s);
      pos.push(v.x, v.y, v.z); uv.push(jb / (NB - 1), ia / (NA - 1));
    }
    for (let jb = 0; jb < NB - 1; jb++) for (let ia = 0; ia < NA - 1; ia++) {
      const i0 = jb * NA + ia, i1 = i0 + 1, j0 = i0 + NA, j1 = j0 + 1;
      idx.push(i0, j0, i1, i1, j0, j1);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx); geo.computeVertexNormals();
    if (geo.attributes.normal.getZ(0) < 0) { const ix = geo.index.array; for (let k = 0; k < ix.length; k += 3) [ix[k + 1], ix[k + 2]] = [ix[k + 2], ix[k + 1]]; geo.computeVertexNormals(); }
    // Arte do adesivo: borda branca + código, numa textura só.
    const img = await loader.loadAsync(`${assetsUrl}aruco/4x4_50_id${mk.id}.png`);
    const R = 1024, cv = document.createElement('canvas'); cv.width = cv.height = R;
    const ctx = cv.getContext('2d'); ctx.fillStyle = '#f4f4f1'; ctx.fillRect(0, 0, R, R);
    ctx.imageSmoothingEnabled = false; const m = Math.round((R * margin * mk.size_m) / F); ctx.drawImage(img, m, m, R - 2 * m, R - 2 * m);
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 16;
    const sticker = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: tex, roughness: a.marker_roughness ?? 0.7, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }));
    sticker.name = `aruco_${mk.id}`; sticker.receiveShadow = true; sticker.userData.noExport = true; sticker.userData.marker = true;
    g.add(sticker);
    // Cantos na ordem do OpenCV (sup-esq, sup-dir, inf-dir, inf-esq da imagem): cima = +s, direita = +b.
    const rowAt = (b) => {                                   // linha exata em b (os cantos não caem na grade)
      const bx = cx - p[0] * b, by = cy - p[1] * b, xs = [], zs = [];
      for (let u = -reach; u <= reach + 1e-9; u += step / 3) { const z = topAt(bx + d[0] * u, by + d[1] * u); if (z != null) { xs.push(u); zs.push(z); } }
      zs.splice(0, zs.length, ...upperHull(xs, zs));
      const arc = [0]; for (let k = 1; k < xs.length; k++) arc.push(arc[k - 1] + Math.hypot(xs[k] - xs[k - 1], zs[k] - zs[k - 1]));
      const k0 = xs.reduce((mm, u, k) => (Math.abs(u) < Math.abs(xs[mm]) ? k : mm), 0), a0 = arc[k0] - xs[k0];
      return { bx, by, at: (s) => { const t = s + a0; let k = 1; while (k < arc.length - 1 && arc[k] < t) k++; const f = Math.min(Math.max((t - arc[k - 1]) / (arc[k] - arc[k - 1] || 1), 0), 1); return { u: xs[k - 1] + f * (xs[k] - xs[k - 1]), z: zs[k - 1] + f * (zs[k] - zs[k - 1]), du: xs[k] - xs[k - 1], dz: zs[k] - zs[k - 1] }; } };
    };
    const corners = [[h, -h], [h, h], [-h, h], [-h, -h]].map(([s, b]) => { const v = point(rowAt(b), s); return [v.x, v.y, v.z]; });
    out.push({ id: mk.id, size_m: mk.size_m, corners });
  }
  return out;
}

export function exportMesh(g) {
  g.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(g.matrixWorld).invert();
  const verts = [], faces = [];
  const v = new THREE.Vector3(), m = new THREE.Matrix4();
  g.traverse((o) => {
    if (!o.isMesh || o.userData.noExport) return;
    m.multiplyMatrices(inv, o.matrixWorld);
    const pos = o.geometry.attributes.position, idx = o.geometry.index, base = verts.length / 3;
    for (let i = 0; i < pos.count; i++) { v.fromBufferAttribute(pos, i).applyMatrix4(m); verts.push(v.x, v.y, v.z); }
    const n = idx ? idx.count : pos.count;
    for (let i = 0; i < n; i += 3) {
      faces.push(base + (idx ? idx.getX(i) : i), base + (idx ? idx.getX(i + 1) : i + 1), base + (idx ? idx.getX(i + 2) : i + 2));
    }
  });
  return { vertices: verts, faces };
}

export async function buildAircraft(cfg, baseUrl, assetsUrl) {
  const a = cfg.aircraft;
  const g = a.model === 'parametric' || !a.model ? buildParametric(a) : await buildFromGLB(a, baseUrl);
  const markers = await addMarkers(g, a, assetsUrl);
  const mesh = exportMesh(g);
  return { group: g, markers, mesh };
}

// Pose do corpo -> matriz (convenção: yaw em z, arfagem nariz-para-cima, rolamento asa direita para baixo).
const _e = new THREE.Euler();
export function poseMatrix(s, target = new THREE.Matrix4()) {
  _e.set(s.roll, -s.pitch, s.yaw, 'ZYX');
  target.makeRotationFromEuler(_e);
  target.setPosition(s.x, s.y, s.z);
  return target;
}
