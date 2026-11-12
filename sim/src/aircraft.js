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
      float filmA = mix(0.10, 0.55, fres) + dot(totalSpecular, vec3(0.3333));
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
    } else if (mat) mat.envMapIntensity = 1.0;
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

function addMarkers(g, a, assetsUrl) {
  g.updateMatrixWorld(true);
  const targets = [];
  g.traverse((o) => { if (o.isMesh && !o.userData.noExport) targets.push(o); });
  const ray = new THREE.Raycaster();
  const topAt = (x, y) => {
    ray.set(new THREE.Vector3(x, y, 20), new THREE.Vector3(0, 0, -1));
    const hit = ray.intersectObjects(targets, false)[0];
    return hit ? hit.point.z : null;
  };
  const loader = new THREE.TextureLoader();
  const out = [];
  for (const mk of a.markers ?? []) {
    const [x, y] = mk.position, h = mk.size_m / 2;
    let z = mk.position[2];
    if (z == null) {
      // O adesivo é plano e a asa é curva: apoia no ponto mais alto da asa sob toda a área (com a borda branca).
      const e = h * (1 + 2 * (a.marker_margin ?? 0.15)), zs = [];
      for (let i = -6; i <= 6; i++) for (let j = -6; j <= 6; j++) { const v = topAt(x + (i / 6) * e, y + (j / 6) * e); if (v != null) zs.push(v); }
      z = (zs.length ? Math.max(...zs) : 0) + 0.003;
    }
    const tex = loader.load(`${assetsUrl}aruco/4x4_50_id${mk.id}.png`);
    tex.magFilter = THREE.NearestFilter; tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
    const group = new THREE.Group();
    group.position.set(x, y, z);
    group.rotation.z = ((mk.yaw_deg ?? 0) * Math.PI) / 180;
    const full = mk.size_m * (1 + 2 * (a.marker_margin ?? 0.15));
    const white = new THREE.Mesh(new THREE.PlaneGeometry(full, full), new THREE.MeshStandardMaterial({ color: '#f7f7f7', roughness: 0.8 }));
    const code = new THREE.Mesh(new THREE.PlaneGeometry(mk.size_m, mk.size_m), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.8 }));
    code.position.z = 0.0008;
    // A imagem do marcador tem "cima" = +x do corpo: gira o plano para alinhar +v da textura com +x.
    white.rotation.z = code.rotation.z = -Math.PI / 2;
    white.receiveShadow = code.receiveShadow = true;
    white.userData.noExport = code.userData.noExport = true;
    group.add(white, code); g.add(group);
    // Cantos na ordem do OpenCV (sup-esq, sup-dir, inf-dir, inf-esq da imagem do marcador).
    // Imagem: cima = +x corpo, direita = -y corpo.
    group.updateMatrix();
    const corners = [[h, h, 0], [h, -h, 0], [-h, -h, 0], [-h, h, 0]].map(([cx, cy, cz]) => {
      const v = new THREE.Vector3(cx, cy, cz).applyMatrix4(group.matrix);
      return [v.x, v.y, v.z];
    });
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
  const markers = addMarkers(g, a, assetsUrl);
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
