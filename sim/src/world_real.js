// Cenário realista: iluminação por HDRI (céu real), solo PBR escaneado com variação de macro-escala,
// grama 3D e árvores com folhagem que se movem com o vento. Requer tools/fetch_assets.py.
import * as THREE from 'three';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { makeRng, deg } from './util.js';
import { buildObstacle } from './world.js';

// Posição do sol dentro do HDRI kloofendal_48d_partly_cloudy_puresky (medida no arquivo).
const HDRI_SUN = { u: 0.595, elevation_deg: 47.9 };

const tl = new THREE.TextureLoader();
function tex(url, { srgb = false, repeat = 1 } = {}) {
  const t = tl.load(url);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat, repeat); t.anisotropy = 16;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Quebra a repetição da textura: multiplica o albedo por uma textura de macro-escala amostrada em
// coordenadas de mundo e mistura uma segunda amostra do próprio mapa em outra escala.
function addMacro(mat, macro, { scale = 30, strength = 0.6, tint = [1, 1, 1], second = 0.31, mono = false } = {}) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uMacro = { value: macro }; sh.uniforms.uMacroTint = { value: new THREE.Vector3(...tint) };
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec2 vMacroPos;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvMacroPos = (modelMatrix * vec4(transformed, 1.0)).xy;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec2 vMacroPos; uniform sampler2D uMacro; uniform vec3 uMacroTint;')
      .replace('#include <map_fragment>', `#include <map_fragment>
        vec3 mc = texture2D(uMacro, vMacroPos / ${scale.toFixed(1)}).rgb;
        float ml = dot(mc, vec3(0.333));
        vec3 far = texture2D(map, vMapUv * ${second.toFixed(3)} + 0.37).rgb;
        diffuseColor.rgb = mix(diffuseColor.rgb, far, 0.35);
        diffuseColor.rgb *= uMacroTint * mix(vec3(1.0), ${mono ? 'vec3(1.0)' : 'mc / max(ml, 0.05)'} * (0.45 + 1.3 * ml), ${strength.toFixed(2)});`);
  };
  return mat;
}

function alphaNoise(size, rng, { base = 0.75, contrast = 0.6, cells = 24 } = {}) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const ctx = c.getContext('2d'), img = ctx.createImageData(size, size);
  const g = new Float32Array(cells * cells).map(() => rng.uniform());
  const at = (i, j) => g[((j % cells + cells) % cells) * cells + ((i % cells + cells) % cells)];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const fx = (x / size) * cells, fy = (y / size) * cells, x0 = Math.floor(fx), y0 = Math.floor(fy), a = fx - x0, b = fy - y0;
    const v = (at(x0, y0) * (1 - a) + at(x0 + 1, y0) * a) * (1 - b) + (at(x0, y0 + 1) * (1 - a) + at(x0 + 1, y0 + 1) * a) * b;
    const k = Math.max(0, Math.min(1, base + contrast * (v - 0.5) + 0.25 * (rng.uniform() - 0.5)));
    const i = 4 * (y * size + x); img.data[i] = img.data[i + 1] = img.data[i + 2] = 255 * k; img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8;
  return t;
}

// Vento: desloca os vértices em função da altura (atributo/uv) e do tempo. `uTime` é atualizado por update(t).
function addWind(mat, time, wind, { amp = 0.05, freq = 1.6, heightExpr = 'uv.y', scale = 0.35 } = {}) {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (sh, r) => {
    prev?.(sh, r);
    sh.uniforms.uTime = time; sh.uniforms.uWind = { value: new THREE.Vector3(wind.x, wind.y, wind.speed) };
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform float uTime; uniform vec3 uWind;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef USE_INSTANCING
          vec3 wpos = (modelMatrix * instanceMatrix * vec4(position, 1.0)).xyz;
        #else
          vec3 wpos = (modelMatrix * vec4(position, 1.0)).xyz;
        #endif
        float hh = ${heightExpr};
        float ph = dot(wpos.xy, vec2(0.21, 0.17)) * ${scale.toFixed(2)};
        float gust = sin(uTime * ${freq.toFixed(2)} + ph) + 0.5 * sin(uTime * ${(freq * 2.7).toFixed(2)} + ph * 3.1) + 0.3 * sin(uTime * ${(freq * 6.3).toFixed(2)} + wpos.x * 2.3 + wpos.y * 1.7);
        float bend = hh * hh * ${amp.toFixed(3)} * uWind.z * (0.55 + 0.45 * gust);
        transformed.xy += (vec4(uWind.xy, 0.0, 0.0)).xy * bend;`);
  };
  return mat;
}

export async function buildWorldReal(cfg, assets = '/assets/polyhaven/') {
  const scene = new THREE.Scene();
  const rng = makeRng(cfg.seed + 4242);
  const env = cfg.environment, L = cfg.runway.length_m, Wd = cfg.runway.width_m;
  const time = { value: 0 };
  const wdir = deg(env.wind.direction_deg);
  const wind = { x: Math.cos(wdir), y: Math.sin(wdir), speed: env.wind.speed_ms };

  // --- Céu / iluminação baseada em imagem ---
  const hdr = await new RGBELoader().setDataType(THREE.FloatType).loadAsync(assets + 'sky_4k.hdr');
  // O HDRI já contém o sol (≈ 70 % da irradiância). Para ter sombras, o sol direto vem de uma luz direcional;
  // por isso o disco solar é limitado aqui, senão a luz do sol entraria duas vezes (uma delas sem sombra).
  { const d = hdr.image.data, lim = env.sky_clamp ?? 6; for (let i = 0; i < d.length; i++) if (d[i] > lim) d[i] = lim; hdr.needsUpdate = true; }
  hdr.mapping = THREE.EquirectangularReflectionMapping;
  scene.background = hdr; scene.environment = hdr;
  // HDRI é Y-para-cima; o mundo é Z-para-cima. Gira para Z e depois em torno de Z para pôr o sol no azimute pedido.
  const sunAz = deg(env.sun_azimuth_deg), el = deg(HDRI_SUN.elevation_deg);
  // Direção de consulta no HDRI: d_env = Ry(beta) * Rx(-90 graus) * d_mundo, com beta levando o azimute do sol
  // do mundo ao azimute do sol no HDRI. (three aplica o Euler com os componentes negados.)
  const phi = (HDRI_SUN.u - 0.5) * 2 * Math.PI, beta = -sunAz - phi;
  const rot = new THREE.Euler(Math.PI / 2, -beta, 0, 'YXZ');
  scene.backgroundRotation.copy(rot); scene.environmentRotation.copy(rot);
  scene.environmentIntensity = env.ibl_intensity ?? 1.0; scene.backgroundIntensity = env.sky_intensity ?? 1.0;
  const sunDir = new THREE.Vector3(Math.cos(el) * Math.cos(sunAz), Math.cos(el) * Math.sin(sunAz), Math.sin(el));
  scene.fog = new THREE.FogExp2(0xffffff, 0.0011); scene.fog.color.setRGB(0.30, 0.35, 0.46);

  const sun = new THREE.DirectionalLight(0xfff1de, env.sun_intensity ?? 4.6);
  sun.castShadow = !cfg.render?.no_shadows;
  sun.shadow.mapSize.set(4096, 4096);
  const sc = sun.shadow.camera, R = 30; sc.left = -R; sc.right = R; sc.top = R; sc.bottom = -R; sc.near = 5; sc.far = 220;
  sun.shadow.bias = -0.0003; sun.shadow.normalBias = 0.02; sun.shadow.radius = 2.2;
  // Região de sombra fixa em torno do obstáculo: sombras estáveis de um quadro para o outro.
  const focus = new THREE.Vector3(L - 6, 0, 0);
  sun.target.position.copy(focus); sun.position.copy(focus).addScaledVector(sunDir, 110);
  scene.add(sun, sun.target);

  // --- Solo ---
  const P = assets;
  const grassMat = addMacro(new THREE.MeshStandardMaterial({
    map: tex(P + 'grass_diff.jpg', { srgb: true, repeat: 4000 / 2.6 }), normalMap: tex(P + 'grass_nor.jpg', { repeat: 4000 / 2.6 }),
    roughnessMap: tex(P + 'grass_rough.jpg', { repeat: 4000 / 2.6 }), roughness: 1, normalScale: new THREE.Vector2(1.3, 1.3), envMapIntensity: 0.6,
  }), tex(P + 'grass_macro_diff.jpg', { srgb: true }), { scale: 55, strength: 0.8, tint: [0.42, 0.78, 0.26], mono: true });
  const grass = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000, 200, 200), grassMat);
  grass.position.z = -0.02; grass.receiveShadow = true; scene.add(grass);

  const total = L + cfg.runway.overrun_m + 12, layer = (f, u) => ({ polygonOffset: true, polygonOffsetFactor: f, polygonOffsetUnits: u });
  const asphaltMat = addMacro(new THREE.MeshStandardMaterial({
    map: tex(P + 'asphalt_diff.jpg', { srgb: true }), normalMap: tex(P + 'asphalt_nor.jpg'), roughnessMap: tex(P + 'asphalt_rough.jpg'),
    roughness: 1, normalScale: new THREE.Vector2(1.6, 1.6), envMapIntensity: 0.7, ...layer(-2, -6),
  }), tex(P + 'asphalt_macro_diff.jpg', { srgb: true }), { scale: 31, strength: 0.85, tint: [0.78, 0.78, 0.8] });
  for (const k of ['map', 'normalMap', 'roughnessMap']) asphaltMat[k].repeat.set(total / 3, (Wd + 0.8) / 3);
  const asphalt = new THREE.Mesh(new THREE.PlaneGeometry(total, Wd + 0.8, Math.ceil(total / 2), 4), asphaltMat);
  asphalt.position.set(total / 2 - 12, 0, 0); asphalt.receiveShadow = true; scene.add(asphalt);

  // Pintura gasta: a transparência vem de um ruído, deixando o asfalto aparecer nas falhas.
  const wear = alphaNoise(256, rng, { base: 0.78, contrast: 0.9 });
  const paintMat = (color) => new THREE.MeshStandardMaterial({ color, roughness: 0.75, alphaMap: wear, transparent: true, normalMap: asphaltMat.normalMap, normalScale: new THREE.Vector2(0.8, 0.8), envMapIntensity: 0.6, ...layer(-4, -12) });
  const white = paintMat('#d9d6c8'), yellow = paintMat('#d2a516');
  const stripe = (x, y, lx, ly, mat = white) => {
    const g = new THREE.PlaneGeometry(lx, ly, Math.ceil(lx / 2), 1);
    const uv = g.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, (x + (uv.getX(i) - 0.5) * lx) / 1.7, (y + (uv.getY(i) - 0.5) * ly) / 1.7);
    const m = new THREE.Mesh(g, mat); m.position.set(x, y, 0.003); m.receiveShadow = true; scene.add(m);
  };
  stripe(total / 2 - 12, Wd / 2 - 0.2, total, 0.12); stripe(total / 2 - 12, -Wd / 2 + 0.2, total, 0.12);
  for (let x = 2; x < L + cfg.runway.overrun_m - 2; x += 5) stripe(x + 1, 0, 2, 0.1);
  stripe(0, 0, 0.25, Wd - 0.6); stripe(L, 0, 0.12, Wd - 0.6, yellow);
  for (let x = 10; x < L; x += 10) { stripe(x, Wd / 2 - 0.6, 0.08, 0.6); stripe(x, -Wd / 2 + 0.6, 0.08, 0.6); }
  // Marcas de borracha/óleo ao longo do eixo.
  const stain = new THREE.MeshStandardMaterial({ color: '#0c0c0d', roughness: 0.55, transparent: true, opacity: 0.4, alphaMap: alphaNoise(128, rng, { base: 0.35, contrast: 1.6, cells: 10 }), ...layer(-3, -9) });
  for (let i = 0; i < 16; i++) {
    const lx = 3 + 9 * rng.uniform(), m = new THREE.Mesh(new THREE.PlaneGeometry(lx, 0.12 + 0.25 * rng.uniform()), stain);
    m.position.set(2 + (L + 30) * rng.uniform(), (rng.uniform() - 0.5) * 2.4, 0.002); m.rotation.z = (rng.uniform() - 0.5) * 0.05; scene.add(m);
  }

  // --- Grama 3D (tufos) nas laterais da pista, perto da zona do obstáculo ---
  if (env.grass_3d ?? true) {
    const blades = 7, pos = [], uv = [], idx = [], nor = [];
    for (let b = 0; b < blades; b++) {
      const a = rng.uniform() * Math.PI * 2, r = 0.03 * rng.uniform(), w = 0.0025 + 0.002 * rng.uniform(), h = 0.06 + 0.06 * rng.uniform();
      const lean = 0.7 * (rng.uniform() - 0.5), cx = r * Math.cos(a), cy = r * Math.sin(a), dx = Math.cos(a + 1.3) * w, dy = Math.sin(a + 1.3) * w, base = pos.length / 3;
      pos.push(cx - dx, cy - dy, 0, cx + dx, cy + dy, 0, cx + lean * h * 0.4 * Math.cos(a) + dx * 0.5, cy + lean * h * 0.4 * Math.sin(a) + dy * 0.5, h * 0.6,
        cx + lean * h * Math.cos(a), cy + lean * h * Math.sin(a), h);
      uv.push(0, 0, 1, 0, 0.5, 0.6, 0.5, 1); for (let k = 0; k < 4; k++) nor.push(0, 0, 1);
      idx.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3)); g.setIndex(idx);
    const mat = addWind(new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.85, side: THREE.DoubleSide, envMapIntensity: 0.5 }), time, wind, { amp: 0.0035, freq: 2.2, heightExpr: 'uv.y', scale: 1.4 });
    const prev = mat.onBeforeCompile;
    mat.onBeforeCompile = (sh, r) => { prev(sh, r); sh.fragmentShader = sh.fragmentShader.replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= mix(0.55, 1.25, vUv.y);').replace('#include <common>', '#include <common>\n#define USE_UV\n'); sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\n#define USE_UV\n'); };
    const dens = env.grass_density_per_m2 ?? 45, x0 = L - 30, x1 = L + 24, yMax = Wd / 2 + 11;
    const n = Math.round(dens * (x1 - x0) * (yMax - Wd / 2 - 0.4) * 2);
    const inst = new THREE.InstancedMesh(g, mat, n);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), col = new THREE.Color(), up = new THREE.Vector3(0, 0, 1);
    for (let i = 0; i < n; i++) {
      const side = i % 2 ? 1 : -1, y = side * (Wd / 2 + 0.45 + (yMax - Wd / 2 - 0.45) * rng.uniform() ** 2.2), x = x0 + (x1 - x0) * (0.5 + 0.5 * Math.sign(rng.uniform() - 0.5) * rng.uniform() ** 0.6);
      const s = 0.7 + 0.9 * rng.uniform() ** 2;
      m4.compose(new THREE.Vector3(x, y, -0.02), q.setFromAxisAngle(up, rng.uniform() * 6.28), new THREE.Vector3(s, s, s));
      inst.setMatrixAt(i, m4);
      inst.setColorAt(i, col.setHSL(0.2 + 0.06 * rng.uniform(), 0.45 + 0.2 * rng.uniform(), 0.2 + 0.1 * rng.uniform()));
    }
    inst.receiveShadow = true; inst.frustumCulled = false; scene.add(inst);
  }

  // --- Árvores: tronco + copa de cartões de folhagem (textura real), com balanço de vento ---
  if (env.scenery) {
    const leafMap = tex(P + 'leaves_diff.jpg', { srgb: true }), leafAlpha = tex(P + 'leaves_alpha.png');
    const atlas = [[0.14, 0.50, 0.50, 0.98], [0.0, 0.36, 0.22, 0.66], [0.12, 0.02, 0.5, 0.36], [0.5, 0.02, 1.0, 0.36], [0.5, 0.5, 0.98, 0.98]];
    const makeCanopy = (cards) => {
      const pos = [], uv = [], nor = [], idx = [], hgt = [];
      for (let i = 0; i < cards; i++) {
        // ponto numa casca elipsoidal irregular
        const th = rng.uniform() * 2 * Math.PI, z = 2 * rng.uniform() - 1, rr = Math.sqrt(1 - z * z), rad = 0.55 + 0.45 * rng.uniform() ** 0.5;
        const c = new THREE.Vector3(rr * Math.cos(th) * rad, rr * Math.sin(th) * rad, z * rad * 0.8);
        const n = c.clone().normalize(), size = 0.34 + 0.22 * rng.uniform();
        const t1 = new THREE.Vector3(rng.gauss(), rng.gauss(), rng.gauss()).cross(n).normalize(), t2 = n.clone().cross(t1).applyAxisAngle(t1, (rng.uniform() - 0.5) * 1.6);
        const [u0, v0, u1, v1] = atlas[i % atlas.length], base = pos.length / 3;
        for (const [a, b, uu, vv] of [[-1, -1, u0, v0], [1, -1, u1, v0], [1, 1, u1, v1], [-1, 1, u0, v1]]) {
          const p = c.clone().addScaledVector(t1, a * size).addScaledVector(t2, b * size * 0.75);
          pos.push(p.x, p.y, p.z); uv.push(uu, vv);
          const nn = n.clone().multiplyScalar(0.8).add(new THREE.Vector3(0, 0, 0.45)).normalize(); nor.push(nn.x, nn.y, nn.z);   // normais "infladas": sombreamento volumétrico
          hgt.push(0.5 + 0.5 * p.z);
        }
        idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3)); g.setAttribute('aH', new THREE.Float32BufferAttribute(hgt, 1)); g.setIndex(idx);
      return g;
    };
    const leafMat = addWind(new THREE.MeshStandardMaterial({ map: leafMap, alphaMap: leafAlpha, alphaTest: 0.35, side: THREE.DoubleSide, roughness: 0.7, envMapIntensity: 0.55 }), time, wind, { amp: 0.012, freq: 1.1, heightExpr: '(0.4 + aH)', scale: 0.15 });
    const p0 = leafMat.onBeforeCompile;
    leafMat.onBeforeCompile = (sh, r) => { p0(sh, r); sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float aH;'); };
    const barkMat = new THREE.MeshStandardMaterial({ map: tex(P + 'bark_diff.jpg', { srgb: true }), roughness: 0.95, envMapIntensity: 0.4 });
    barkMat.map.repeat.set(1, 3);
    const N = 150, variants = [makeCanopy(900), makeCanopy(700), makeCanopy(1100)];
    const trunkG = new THREE.CylinderGeometry(0.5, 0.75, 1, 8, 1, true); trunkG.rotateX(Math.PI / 2);
    const canopies = variants.map((g) => new THREE.InstancedMesh(g, leafMat, Math.ceil(N / variants.length) + 1));
    const trunks = new THREE.InstancedMesh(trunkG, barkMat, N);
    const counts = variants.map(() => 0), m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), col = new THREE.Color(), up = new THREE.Vector3(0, 0, 1);
    for (let i = 0; i < N; i++) {
      const ang = rng.uniform() * 2 * Math.PI, r = 85 + 190 * rng.uniform() ** 1.4;
      const x = L / 2 + r * Math.cos(ang) * 1.5, y = r * Math.sin(ang), h = 6 + 8 * rng.uniform(), rad = 2.6 + 3.2 * rng.uniform(), v = i % variants.length;
      m4.compose(new THREE.Vector3(x, y, h * 0.55 + rad * 0.45), q.setFromAxisAngle(up, rng.uniform() * 6.28), new THREE.Vector3(rad, rad, rad * (0.95 + 0.4 * rng.uniform())));
      canopies[v].setMatrixAt(counts[v], m4);
      canopies[v].setColorAt(counts[v]++, col.setHSL(0.24 + 0.08 * rng.uniform(), 0.45 + 0.25 * rng.uniform(), 0.38 + 0.2 * rng.uniform()));
      m4.compose(new THREE.Vector3(x, y, h * 0.3), q.identity(), new THREE.Vector3(0.45 + 0.05 * rad, 0.45 + 0.05 * rad, h * 0.6));
      trunks.setMatrixAt(i, m4);
    }
    canopies.forEach((c, v) => { c.count = counts[v]; c.frustumCulled = false; scene.add(c); });
    trunks.frustumCulled = false; scene.add(trunks);

    // Morros distantes (silhueta do horizonte).
    const hillG = new THREE.CylinderGeometry(1500, 1500, 1, 96, 1, true); hillG.rotateX(Math.PI / 2);
    const hp = hillG.attributes.position, hn = Array.from({ length: 97 }, (_, i) => 7 + 16 * (0.5 + 0.5 * Math.sin(i * 0.41 + 1.3)) * (0.6 + 0.4 * Math.sin(i * 1.7)) + 4 * rng.uniform());
    for (let i = 0; i < hp.count; i++) if (hp.getZ(i) > 0) hp.setZ(i, hn[i % 97]); else hp.setZ(i, -2);
    const hills = new THREE.Mesh(hillG, new THREE.MeshStandardMaterial({ color: '#3d6a33', roughness: 1, side: THREE.BackSide, envMapIntensity: 0.5 }));
    hills.position.set(L / 2, 0, 0); scene.add(hills);

    // Tendas das equipes, mesas e faixas.
    const metal = new THREE.MeshStandardMaterial({ color: '#c9ccd1', metalness: 0.9, roughness: 0.35 });
    const cols = ['#eceae4', '#2456b8', '#c8322f', '#eceae4', '#e0ac1a', '#1f7a4a'];
    for (let i = 0; i < 8; i++) {
      const g = new THREE.Group(), s = 3, fabric = new THREE.MeshStandardMaterial({ color: cols[i % cols.length], roughness: 0.8, side: THREE.DoubleSide });
      const roof = new THREE.Mesh(new THREE.ConeGeometry(s * 0.74, 0.95, 4, 1, true), fabric); roof.rotation.set(Math.PI / 2, Math.PI / 4, 0); roof.position.z = 2.68;
      const skirt = new THREE.Mesh(new THREE.CylinderGeometry(s * 0.74, s * 0.74, 0.22, 4, 1, true), fabric); skirt.rotation.set(Math.PI / 2, Math.PI / 4, 0); skirt.position.z = 2.1;
      roof.castShadow = skirt.castShadow = true; g.add(roof, skirt);
      for (const [a, b] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) { const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 2.2, 8), metal); leg.rotation.x = Math.PI / 2; leg.position.set((a * s) / 2, (b * s) / 2, 1.1); leg.castShadow = true; g.add(leg); }
      const table = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.75, 0.04), new THREE.MeshStandardMaterial({ color: '#d8d4cb', roughness: 0.5 })); table.position.z = 0.75; table.castShadow = true; g.add(table);
      for (const [a, b] of [[0.8, 0.3], [0.8, -0.3], [-0.8, 0.3], [-0.8, -0.3]]) { const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.74, 6), metal); leg.rotation.x = Math.PI / 2; leg.position.set(a, b, 0.37); g.add(leg); }
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.4, 0.35), new THREE.MeshStandardMaterial({ color: ['#30333a', '#7a5a36', '#274a8a'][i % 3], roughness: 0.7 })); box.position.set(-0.3 + 0.6 * rng.uniform(), 0.9, 0.175); box.castShadow = true; g.add(box);
      g.position.set(-8 + i * 9.2, 25 + 2.5 * rng.uniform(), 0); g.rotation.z = (rng.uniform() - 0.5) * 0.15; scene.add(g);
    }
    // Biruta.
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 4, 8), metal); pole.rotation.x = Math.PI / 2; pole.position.set(20, -16, 2); pole.castShadow = true; scene.add(pole);
    const sock = new THREE.Mesh(new THREE.ConeGeometry(0.22, 1.3, 12, 1, true), new THREE.MeshStandardMaterial({ color: '#ff5a1f', side: THREE.DoubleSide, roughness: 0.8 }));
    sock.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(wind.x, wind.y, -0.25 - 0.5 / (1 + wind.speed)).normalize());
    sock.position.set(20 + 0.6 * wind.x, -16 + 0.6 * wind.y, 3.85); scene.add(sock);
  }

  const obstacle = buildObstacle(cfg); scene.add(obstacle);
  return { scene, sunDir, focusShadow: () => {}, obstacle, update: (t) => { time.value = t; }, real: true };
}
