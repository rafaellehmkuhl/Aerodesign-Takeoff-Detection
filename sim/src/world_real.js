// Cenário realista: iluminação por HDRI (céu real), solo PBR escaneado com variação de macro-escala,
// grama 3D e árvores com folhagem que se movem com o vento. Requer tools/fetch_assets.py.
import * as THREE from 'three';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';
import { makeRng, deg } from './util.js';
import { buildObstacle } from './world.js';

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

  // Fundo distante pré-renderizado no Blender (tools/bake_backdrop.py): morros, cidade e mata num panorama.
  // Sem o arquivo, a cena monta o fundo procedural de antes.
  const BD = { center: [54, -9, 4], latMin: -4, latMax: 14, radius: 1500 };   // igual a tools/bake_backdrop.py
  let backdrop = null;
  if (env.backdrop ?? true) {
    try { backdrop = await new EXRLoader().setDataType(THREE.HalfFloatType).loadAsync('/assets/backdrop/' + (env.backdrop_file ?? 'backdrop.exr')); }
    catch { console.warn('[fundo] backdrop.exr não encontrado: usando o fundo procedural (rode tools/bake_backdrop.py)'); }
  }

  // --- Céu / iluminação baseada em imagem ---
  const hdr = await new RGBELoader().setDataType(THREE.FloatType).loadAsync(assets + (env.sky_hdri ?? 'sky_cloudy_4k.hdr'));
  // O HDRI já contém o sol. Para ter sombras, o sol direto vem de uma luz direcional; por isso o disco solar é
  // limitado aqui (senão a luz do sol entraria duas vezes, uma delas sem sombra), e a energia cortada vira a
  // intensidade da luz direcional. A posição do sol é o pixel mais brilhante do arquivo.
  const HDRI_SUN = { u: 0.5, elevation_deg: 45 };
  let sunIrr = 0;
  {
    const d = hdr.image.data, W = hdr.image.width, H = hdr.image.height, lim = env.sky_clamp ?? 6, ch = d.length / (W * H);
    let best = -1, bi = 0;
    for (let i = 0; i < W * H; i++) { const l = d[i * ch] + d[i * ch + 1] + d[i * ch + 2]; if (l > best) { best = l; bi = i; } }
    HDRI_SUN.u = (bi % W + 0.5) / W; HDRI_SUN.elevation_deg = 90 - ((Math.floor(bi / W) + 0.5) / H) * 180;
    for (let i = 0; i < W * H; i++) {
      const lat = Math.PI / 2 - ((Math.floor(i / W) + 0.5) / H) * Math.PI, dOmega = (2 * Math.PI / W) * (Math.PI / H) * Math.cos(lat);
      let over = 0; for (let c = 0; c < 3; c++) { const k = i * ch + c; if (d[k] > lim) { over += (d[k] - lim) / 3; d[k] = lim; } }
      sunIrr += over * dOmega;
    }
    hdr.needsUpdate = true;
  }
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
  // Névoa clara (perspectiva aérea): prédios e morros a quilômetros ficam lavados e azul-acinzentados.
  scene.fog = new THREE.FogExp2(0xffffff, env.haze ?? 0.00032); scene.fog.color.setRGB(...(env.haze_color ?? [0.62, 0.68, 0.76]));

  const sunI = env.sun_intensity === 'auto' || env.sun_intensity == null ? sunIrr * (env.sun_scale ?? 1) : env.sun_intensity;
  console.log(`[céu] sol no HDRI: u=${HDRI_SUN.u.toFixed(3)}, elevação ${HDRI_SUN.elevation_deg.toFixed(1)}°, irradiância cortada ${sunIrr.toFixed(2)} → luz direcional ${sunI.toFixed(2)}`);
  const sun = new THREE.DirectionalLight(0xfff1de, sunI);
  sun.castShadow = !cfg.render?.no_shadows;
  sun.shadow.mapSize.set(4096, 4096);
  // Meia-largura da área de sombra: 18 m em 4096 texels ≈ 9 mm, o bastante para as pernas do tripé.
  const sc = sun.shadow.camera, R = env.shadow_extent_m ?? 18; sc.left = -R; sc.right = R; sc.top = R; sc.bottom = -R; sc.near = 5; sc.far = 220;
  sun.shadow.bias = -0.0003; sun.shadow.normalBias = 0.02; sun.shadow.radius = env.shadow_softness ?? 4;
  // Região de sombra fixa em torno do obstáculo: sombras estáveis de um quadro para o outro.
  const focus = new THREE.Vector3(L - 6, 0, 0);
  sun.target.position.copy(focus); sun.position.copy(focus).addScaledVector(sunDir, 110);
  scene.add(sun, sun.target);

  // --- Solo ---
  const P = assets;
  const grassMat = addMacro(new THREE.MeshStandardMaterial({
    map: tex(P + 'grass_diff.jpg', { srgb: true, repeat: 4000 / 2.6 }), normalMap: tex(P + 'grass_nor.jpg', { repeat: 4000 / 2.6 }),
    roughnessMap: tex(P + 'grass_rough.jpg', { repeat: 4000 / 2.6 }), roughness: 1, normalScale: new THREE.Vector2(1.3, 1.3), envMapIntensity: 0.6,
  }), tex(P + 'grass_macro_diff.jpg', { srgb: true }), { scale: 55, strength: 0.45, tint: env.grass_tint ?? [0.42, 0.68, 0.36], mono: true });
  const groundR = backdrop ? BD.radius - 100 : 2000;
  if (backdrop) for (const k of ['map', 'normalMap', 'roughnessMap']) grassMat[k].repeat.set((2 * groundR) / 2.6, (2 * groundR) / 2.6);
  const grass = new THREE.Mesh(backdrop ? new THREE.CircleGeometry(groundR, 256) : new THREE.PlaneGeometry(4000, 4000, 200, 200), grassMat);
  if (backdrop) grass.position.x = L / 2;
  grass.position.z = -0.02; grass.receiveShadow = true; scene.add(grass);

  const total = L + cfg.runway.overrun_m + 12, layer = (f, u) => ({ polygonOffset: true, polygonOffsetFactor: f, polygonOffsetUnits: u });
  // Pista de concreto (como a de São José dos Campos): placas com juntas escuras, desgaste e manchas.
  const concrete = (env.pavement ?? 'concreto') === 'concreto';
  const pv = concrete ? 'concrete' : 'asphalt';
  const asphaltMat = addMacro(new THREE.MeshStandardMaterial({
    map: tex(P + pv + '_diff.jpg', { srgb: true }), normalMap: tex(P + pv + '_nor.jpg'), roughnessMap: tex(P + pv + '_rough.jpg'),
    roughness: 1, normalScale: new THREE.Vector2(1.2, 1.2), envMapIntensity: 0.7, ...layer(-2, -6),
  }), tex(P + 'asphalt_macro_diff.jpg', { srgb: true }), concrete ? { scale: 37, strength: 0.3, tint: [1.0, 1.0, 1.0], mono: true } : { scale: 31, strength: 0.85, tint: [0.78, 0.78, 0.8] });
  if (concrete) {
    const slab = env.slab_m ?? [5, 4.5];
    const prev = asphaltMat.onBeforeCompile;
    asphaltMat.onBeforeCompile = (sh, r) => {
      prev(sh, r);
      sh.fragmentShader = sh.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
        vec2 sj = vMacroPos / vec2(${slab[0].toFixed(2)}, ${slab[1].toFixed(2)});
        vec2 dj = abs(fract(sj) - 0.5) * vec2(${slab[0].toFixed(2)}, ${slab[1].toFixed(2)});
        float edge = min(${(slab[0] / 2).toFixed(2)} - dj.x, ${(slab[1] / 2).toFixed(2)} - dj.y);
        diffuseColor.rgb *= mix(0.42, 1.0, smoothstep(0.006, 0.02, edge));          // junta selada
        diffuseColor.rgb *= mix(0.9, 1.0, smoothstep(0.02, 0.12, edge));            // borda da placa mais suja
        diffuseColor.rgb *= 0.94 + 0.12 * fract(sin(dot(floor(sj), vec2(12.9898, 78.233))) * 43758.5453);   // cada placa com um tom
        diffuseColor.rgb = mix(vec3(dot(diffuseColor.rgb, vec3(0.3333))), diffuseColor.rgb, 0.25) * vec3(0.97, 0.99, 1.04);   // cinza neutro, levemente frio`);
    };
  }
  if (concrete) asphaltMat.color.setScalar(env.concrete_albedo ?? 1.87);   // concreto claro, quase branco, como o pátio real
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
  // Marcas laterais a cada 10 m e, como no regulamento, marcas auxiliares de 40 m até o obstáculo a cada 5 m.
  const marks = new Set(); for (let x = 10; x < L - 15; x += 10) marks.add(x); for (let x = L - 15; x < L - 0.1; x += 5) marks.add(x);
  for (const x of marks) { stripe(x, Wd / 2 - 0.6, 0.12, 0.9); stripe(x, -Wd / 2 + 0.6, 0.12, 0.9); }
  // Linha amarela curva de pista de táxi, saindo da lateral da pista depois do obstáculo (como nas fotos).
  {
    const R0 = 9, g = new THREE.RingGeometry(R0 - 0.06, R0 + 0.06, 64, 1, -Math.PI / 2, Math.PI / 2);
    const m = new THREE.Mesh(g, yellow); m.position.set(L + 3, Wd / 2 - 0.4 - R0, 0.003); m.receiveShadow = true; scene.add(m);
  }
  // Marcas de borracha/óleo ao longo do eixo.
  const stain = new THREE.MeshStandardMaterial({ color: '#0c0c0d', roughness: 0.55, transparent: true, opacity: 0.1, alphaMap: alphaNoise(128, rng, { base: 0.35, contrast: 1.6, cells: 10 }), ...layer(-3, -9) });
  for (let i = 0; i < 16; i++) {
    const lx = 3 + 9 * rng.uniform(), m = new THREE.Mesh(new THREE.PlaneGeometry(lx, 0.12 + 0.25 * rng.uniform()), stain);
    m.position.set(2 + (L + 30) * rng.uniform(), (rng.uniform() - 0.5) * 2.4, 0.002); m.rotation.z = (rng.uniform() - 0.5) * 0.05; scene.add(m);
  }

  // --- Gramado 3D denso nas laterais da pista (touceiras instanciadas, com vento) ---
  if (env.grass_3d ?? true) {
    const blades = 10, pos = [], uv = [], idx = [], nor = [];
    for (let b = 0; b < blades; b++) {
      // Cada lâmina: um quadrilátero + ponta, curvada para fora da touceira.
      const a = rng.uniform() * Math.PI * 2, r = 0.045 * Math.sqrt(rng.uniform()), w = 0.003 + 0.0025 * rng.uniform(), h = 0.035 + 0.045 * rng.uniform();
      const lean = 0.25 + 0.6 * rng.uniform(), ca = Math.cos(a), sa = Math.sin(a), cx = r * ca, cy = r * sa, tx = -sa * w, ty = ca * w, base = pos.length / 3;
      const at = (f, k) => [cx + ca * lean * h * f * f + tx * k, cy + sa * lean * h * f * f + ty * k, h * f];
      pos.push(...at(0, -1), ...at(0, 1), ...at(0.55, -0.75), ...at(0.55, 0.75), ...at(1, 0));
      uv.push(0, 0, 1, 0, 0, 0.55, 1, 0.55, 0.5, 1);
      // Normais quase verticais, inclinadas para fora: sombreamento macio de gramado.
      for (let k = 0; k < 5; k++) { const n = new THREE.Vector3(ca * 0.35, sa * 0.35, 1).normalize(); nor.push(n.x, n.y, n.z); }
      idx.push(base, base + 1, base + 2, base + 2, base + 1, base + 3, base + 2, base + 3, base + 4);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3)); g.setIndex(idx);
    // A grama fica parada por padrão: o movimento não muda nada relevante para as câmeras (environment.grass_wind liga).
    const base = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.7, side: THREE.DoubleSide, envMapIntensity: 0.7 });
    const mat = env.grass_wind ? addWind(base, time, wind, { amp: 0.004, freq: 2.2, heightExpr: 'uv.y', scale: 1.4 }) : base;
    const prev = mat.onBeforeCompile;
    mat.onBeforeCompile = (sh, r) => {
      prev?.(sh, r);
      // Base escura (oclusão entre lâminas), ponta clara e amarelada.
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\n#define USE_UV\n')
        .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= mix(vec3(0.28, 0.34, 0.26), vec3(1.25, 1.2, 0.85), smoothstep(0.0, 1.0, vUv.y));');
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\n#define USE_UV\n');
    };
    const dens = env.grass_density_per_m2 ?? 55, x0 = L - 36, x1 = L + 28, y0 = Wd / 2 + 0.42, core = 7, tail = 18;
    const n = Math.round(dens * (x1 - x0) * 2 * (core + tail * 0.4));
    const inst = new THREE.InstancedMesh(g, mat, n);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), col = new THREE.Color(), up = new THREE.Vector3(0, 0, 1), pCore = core / (core + tail * 0.4);
    for (let i = 0; i < n; i++) {
      const side = i % 2 ? 1 : -1, d = rng.uniform() < pCore ? core * rng.uniform() : core + tail * (1 - Math.sqrt(rng.uniform()));
      const s = 0.45 + 0.35 * rng.uniform() ** 2;
      m4.compose(new THREE.Vector3(x0 + (x1 - x0) * rng.uniform(), side * (y0 + d), -0.02), q.setFromAxisAngle(up, rng.uniform() * 6.28), new THREE.Vector3(s, s, s * (0.8 + 0.5 * rng.uniform())));
      inst.setMatrixAt(i, m4);
      inst.setColorAt(i, col.setHSL(0.22 + 0.04 * rng.uniform(), 0.33 + 0.1 * rng.uniform(), 0.26 + 0.08 * rng.uniform()));
    }
    inst.receiveShadow = true; inst.frustumCulled = false; scene.add(inst);
  }

  // --- Árvores: tronco + copa de cartões de folhagem (textura real), com balanço de vento ---
  if (env.scenery) {
    if (!backdrop) {
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
    // Textura de mata vista de longe (copas que se fundem), usada nos cinturões de árvores e nos morros.
    const forest = (() => {
      const c = document.createElement('canvas'); c.width = 512; c.height = 128; const x = c.getContext('2d'), r2 = makeRng(cfg.seed + 77);
      x.fillStyle = '#3e4a2e'; x.fillRect(0, 0, 512, 128);
      for (let k = 0; k < 2600; k++) {   // copas: manchas de vários verdes, mais claras no topo de cada uma
        const px = r2.uniform() * 512, py = r2.uniform() * 128, rr = 2 + 5 * r2.uniform(), g = 0.75 + 0.5 * r2.uniform();
        x.fillStyle = `rgb(${Math.round(80 * g)},${Math.round(92 * g)},${Math.round(54 * g)})`; x.beginPath(); x.arc(px, py, rr, 0, 6.28); x.fill();
      }
      const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
      return t;
    })();
    // Cinturões contínuos de mata além do campo (como nas fotos): faixa de copas que se fundem, topo irregular.
    for (const [yb, x0b, x1b, sd] of [[380, L / 2 - 1300, L / 2 + 1300, 11], [-300, L / 2 - 1300, L / 2 + 1300, 12]]) {
      const segs = Math.round((x1b - x0b) / 3), g = new THREE.PlaneGeometry(x1b - x0b, 1, segs, 3); g.rotateX(Math.PI / 2);
      const r4 = makeRng(cfg.seed + sd), nz = Array.from({ length: segs + 1 }, () => r4.uniform());
      const gp = g.attributes.position, uvB = g.attributes.uv;
      for (let i = 0; i < gp.count; i++) {
        const c = i % (segs + 1), row = Math.floor(i / (segs + 1)), f = 1 - row / 3, xx = c / segs;
        const top = 9 + 5 * Math.sin(xx * 40 + sd) + 3 * Math.sin(xx * 157 + 2 * sd) + 4 * (nz[c] + nz[(c + 1) % segs]) / 2;
        gp.setZ(i, f * top - 0.5); gp.setY(i, (r4.uniform() - 0.5) * 6);
        uvB.setXY(i, xx * (x1b - x0b) / 30, f * top / 30);
      }
      g.computeVertexNormals();
      const belt = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ map: forest, roughness: 1, side: THREE.DoubleSide, envMapIntensity: 0.7 }));
      belt.position.set((x0b + x1b) / 2, yb, 0); scene.add(belt);
    }
    const N = 200, variants = [makeCanopy(300), makeCanopy(240), makeCanopy(360)];
    const trunkG = new THREE.CylinderGeometry(0.5, 0.8, 1, 8, 1, true); trunkG.rotateX(Math.PI / 2);
    const canopies = variants.map((g) => new THREE.InstancedMesh(g, leafMat, N * 3));
    const trunks = new THREE.InstancedMesh(trunkG, barkMat, N);
    const counts = variants.map(() => 0), m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), col = new THREE.Color(), up = new THREE.Vector3(0, 0, 1);
    for (let i = 0; i < N; i++) {
      // Faixas de árvores além do campo aberto: na frente da cidade (lado oposto às câmeras) e atrás do público.
      // aglomerados (capões) espalhados, não uma fileira contínua
      const far = i % 3 !== 0, cl = Math.floor(rng.uniform() * 16), cx = L / 2 + (cl / 15 - 0.5) * 1700 + 40 * Math.sin(cl * 7.1);   // maciços de dezenas de copas que se sobrepõem
      const x = cx + rng.gauss() * 42, y = far ? 355 + rng.gauss() * 10 : -(275 + rng.gauss() * 10);   // na frente do cinturão
      const h = 6 + 12 * rng.uniform(), rad = 3.0 + 3.0 * rng.uniform();
      const hue = 0.21 + 0.06 * rng.uniform(), sat = 0.28 + 0.17 * rng.uniform(), lit = 0.30 + 0.14 * rng.uniform(), lobes = 3 + Math.floor(3 * rng.uniform());
      for (let k = 0; k < lobes; k++) {
        // copa = lóbulo central + lóbulos menores deslocados (silhueta irregular)
        const v = (i + k) % variants.length, a = rng.uniform() * 6.28, off = k ? rad * (0.55 + 0.5 * rng.uniform()) : 0, sc = k ? rad * (0.5 + 0.35 * rng.uniform()) : rad;
        m4.compose(new THREE.Vector3(x + off * Math.cos(a), y + off * Math.sin(a), h * 0.62 + rad * 0.5 + (k ? rad * (rng.uniform() - 0.35) * 0.9 : 0)),
          q.setFromAxisAngle(up, rng.uniform() * 6.28), new THREE.Vector3(sc, sc, sc * (0.85 + 0.35 * rng.uniform())));
        canopies[v].setMatrixAt(counts[v], m4);
        canopies[v].setColorAt(counts[v]++, col.setHSL(hue + 0.02 * (rng.uniform() - 0.5), sat, lit * (0.85 + 0.3 * rng.uniform())));
      }
      m4.compose(new THREE.Vector3(x, y, h * 0.34), q.identity(), new THREE.Vector3(0.4 + 0.06 * rad, 0.4 + 0.06 * rad, h * 0.68));
      trunks.setMatrixAt(i, m4);
    }
    canopies.forEach((c, v) => { c.count = counts[v]; c.frustumCulled = false; scene.add(c); });
    trunks.frustumCulled = false; scene.add(trunks);

    for (const [rad, hMin, hMax, seed, rep] of [[2400, 40, 170, 1, 60], [4800, 80, 360, 2, 90], [9000, 150, 600, 3, 120]]) {
      const segs = 720, g = new THREE.CylinderGeometry(rad, rad, 1, segs, 6, true); g.rotateX(Math.PI / 2);
      const r3 = makeRng(cfg.seed + 900 + seed), noise = Array.from({ length: segs + 1 }, () => r3.uniform());
      const prof = (i) => {   // perfil irregular: soma de senoides + ruído suavizado
        const a = (i / segs) * Math.PI * 2, n = (noise[i % segs] + noise[(i + 1) % segs] + noise[(i + segs - 1) % segs]) / 3;
        const v = 0.5 + 0.3 * Math.sin(a * 3 + seed) + 0.2 * Math.sin(a * 7.3 + 2 * seed) + 0.15 * Math.sin(a * 17.1 + seed * 5) + 0.25 * (n - 0.5);
        return hMin + (hMax - hMin) * Math.max(0, Math.min(1, v));
      };
      const gp = g.attributes.position, uvA = g.attributes.uv;
      for (let i = 0; i < gp.count; i++) {
        const col = i % (segs + 1), row = Math.floor(i / (segs + 1)), f = 1 - row / 6;   // f: 1 no topo, 0 na base
        gp.setZ(i, f > 0 ? prof(col) * Math.pow(f, 0.7) : -2);
        uvA.setXY(i, (col / segs) * rep, f * 1.0);
      }
      g.computeVertexNormals();
      const m = new THREE.MeshStandardMaterial({ map: forest, roughness: 1, side: THREE.BackSide, envMapIntensity: 0.8 });
      const hill = new THREE.Mesh(g, m); hill.position.set(L / 2, 0, 0); scene.add(hill);
    }

    const facade = (seed) => {
      // Fachada de prédio residencial: um andar a cada 3 m, janelas, faixas de sacada e tons creme/bege/cinza.
      const c = document.createElement('canvas'); c.width = 256; c.height = 256; const x = c.getContext('2d'), r2 = makeRng(seed);
      const base = ['#c9c2b5', '#e0dad0', '#9aa0a6', '#d6cfc2', '#b8b2a6', '#e8e4dc'][seed % 6];
      x.fillStyle = base; x.fillRect(0, 0, 256, 256);
      const fl = 16;   // pixels por andar (3 m)
      for (let fy = 0; fy < 256; fy += fl) {
        x.fillStyle = 'rgba(255,255,255,0.18)'; x.fillRect(0, fy + fl - 3, 256, 3);              // laje / sacada
        for (let fx = 4; fx < 256; fx += 21) {
          const d = 78 + 30 * r2.uniform();
          x.fillStyle = `rgb(${d - 8},${d},${d + 10})`; x.fillRect(fx, fy + 3, 14, 10);          // vidro (reflete o céu)
        }
      }
      const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
      return t;
    };
    const facades = Array.from({ length: 6 }, (_, k) => new THREE.MeshStandardMaterial({ map: facade(cfg.seed + k), roughness: 0.8, envMapIntensity: 0.6 }));
    const roofMat = new THREE.MeshStandardMaterial({ color: '#8c8a85', roughness: 0.9 });
    // A cidade fica a 2–4 km, em bairros de prédios agrupados (não espalhados por igual).
    for (let blk = 0; blk < 14; blk++) {
      const bx = L / 2 + (blk / 13 - 0.5) * 5600 + (rng.uniform() - 0.5) * 300, by = 1100 + 650 * rng.uniform(), nb = 14 + Math.floor(16 * rng.uniform());
      for (let i = 0; i < nb; i++) {
        const w = 18 + 14 * rng.uniform(), dpt = 16 + 10 * rng.uniform(), hgt = 40 + 80 * rng.uniform() ** 1.3;
        const g = new THREE.BoxGeometry(w, dpt, hgt);
        const uv = g.attributes.uv; for (let k = 0; k < uv.count; k++) uv.setXY(k, uv.getX(k) * (w / 40), uv.getY(k) * (hgt / 48));
        const b = new THREE.Mesh(g, [facades[(blk + i) % 6], facades[(blk + i) % 6], facades[(blk + i) % 6], facades[(blk + i) % 6], roofMat, roofMat]);
        const px = bx + (rng.uniform() - 0.5) * 420, py = by + (rng.uniform() - 0.5) * 300;
        b.position.set(px, py, hgt / 2); b.rotation.z = (rng.uniform() - 0.5) * 0.4; scene.add(b);
        const tank = new THREE.Mesh(new THREE.BoxGeometry(w * 0.35, dpt * 0.35, 4), roofMat); tank.position.set(px, py, hgt + 2); tank.rotation.z = b.rotation.z; scene.add(tank);
      }
    }

    }
    const metal = new THREE.MeshStandardMaterial({ color: '#c9ccd1', metalness: 0.9, roughness: 0.35 });
    const white = new THREE.MeshStandardMaterial({ color: '#f1f1ee', roughness: 0.6 });
    // Instrumentos meteorológicos do aeroporto espalhados pelo campo (caixas brancas sobre suportes).
    for (let i = 0; i < 9; i++) {
      const g = new THREE.Group(), hp2 = 1.0 + 1.2 * rng.uniform();
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, hp2, 8), metal); leg.rotation.x = Math.PI / 2; leg.position.z = hp2 / 2;
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.35 + 0.3 * rng.uniform(), 0.3, 0.4 + 0.3 * rng.uniform()), white); box.position.z = hp2 + 0.2;
      leg.castShadow = box.castShadow = true; g.add(leg, box);
      if (i % 3 === 0) { const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.025, 3.5, 6), metal); mast.rotation.x = Math.PI / 2; mast.position.set(0.5, 0, 1.75); g.add(mast); }
      g.position.set(-40 + 160 * rng.uniform(), 45 + 70 * rng.uniform(), 0); scene.add(g);
    }
    // Placa de pista de táxi ("B →"), amarela com faixa preta, sobre pés curtos, no gramado além da pista.
    {
      const c = document.createElement('canvas'); c.width = 512; c.height = 192; const x = c.getContext('2d');
      x.fillStyle = '#e8b51a'; x.fillRect(0, 0, 512, 192); x.fillStyle = '#111'; x.fillRect(0, 0, 70, 192);
      x.font = 'bold 150px sans-serif'; x.textBaseline = 'middle'; x.fillText('B', 150, 104); x.fillText('→', 300, 96);
      const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
      const face = new THREE.MeshStandardMaterial({ map: t, roughness: 0.6 }), box = new THREE.MeshStandardMaterial({ color: '#2a2b2d', roughness: 0.7 });
      const sign = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.12, 0.42), [box, box, box, face, box, box]);
      sign.position.set(L - 6, Wd / 2 + 9, 0.5); sign.castShadow = true; scene.add(sign);
      for (const dx of [-0.4, 0.4]) { const leg = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.3), box); leg.position.set(L - 6 + dx, Wd / 2 + 9, 0.15); scene.add(leg); }
    }
    // Torre treliçada de antena.
    {
      const H = 22, g = new THREE.Group(), strut = new THREE.MeshStandardMaterial({ color: '#8d9298', metalness: 0.7, roughness: 0.5 });
      const bar = (a, b, r) => { const v = b.clone().sub(a), m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, v.length(), 5), strut); m.position.copy(a).add(b).multiplyScalar(0.5); m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), v.normalize()); g.add(m); };
      const w = (z) => 0.9 - 0.5 * (z / H), V = (x, y, z) => new THREE.Vector3(x, y, z);
      for (const [sx, sy] of [[1, 1], [1, -1], [-1, -1], [-1, 1]]) bar(V(sx * w(0), sy * w(0), 0), V(sx * w(H), sy * w(H), H), 0.04);
      for (let z = 0; z < H; z += 1.5) for (const [a, b] of [[[1, 1], [1, -1]], [[1, -1], [-1, -1]], [[-1, -1], [-1, 1]], [[-1, 1], [1, 1]]]) bar(V(a[0] * w(z), a[1] * w(z), z), V(b[0] * w(z + 1.5), b[1] * w(z + 1.5), z + 1.5), 0.015);
      bar(V(0, 0, H), V(0, 0, H + 5), 0.03);
      g.traverse((o) => { o.castShadow = true; }); g.position.set(L - 70, 120, 0); scene.add(g);
    }
    // Biruta.
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 4, 8), metal); pole.rotation.x = Math.PI / 2; pole.position.set(20, -16, 2); pole.castShadow = true; scene.add(pole);
    const sock = new THREE.Mesh(new THREE.ConeGeometry(0.22, 1.3, 12, 1, true), new THREE.MeshStandardMaterial({ color: '#ff5a1f', side: THREE.DoubleSide, roughness: 0.8 }));
    sock.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(wind.x, wind.y, -0.25 - 0.5 / (1 + wind.speed)).normalize());
    sock.position.set(20 + 0.6 * wind.x, -16 + 0.6 * wind.y, 3.85); scene.add(sock);
  }

  if (backdrop) {
    // Faixa de esfera ao redor do ponto de vista do panorama; u = 0,5 − azimute/360°, v da latitude.
    const na = 1024, nl = 24, pos = [], uv = [], idx = [], c = BD.center;
    for (let j = 0; j <= nl; j++) {
      const lat = deg(BD.latMin + (BD.latMax - BD.latMin) * (j / nl));
      for (let i = 0; i <= na; i++) {
        const az = Math.PI - (2 * Math.PI * i) / na;
        pos.push(c[0] + BD.radius * Math.cos(lat) * Math.cos(az), c[1] + BD.radius * Math.cos(lat) * Math.sin(az), c[2] + BD.radius * Math.sin(lat));
        uv.push(i / na, j / nl);
      }
    }
    for (let j = 0; j < nl; j++) for (let i = 0; i < na; i++) { const a = j * (na + 1) + i, b = a + na + 1; idx.push(a, a + 1, b, a + 1, b + 1, b); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx);
    backdrop.colorSpace = THREE.LinearSRGBColorSpace; backdrop.minFilter = THREE.LinearFilter; backdrop.generateMipmaps = false;
    const gain = env.backdrop_gain ?? 1;
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ map: backdrop, color: new THREE.Color(gain, gain, gain), transparent: true, depthWrite: false, fog: false, side: THREE.DoubleSide }));
    m.renderOrder = -1; m.frustumCulled = false; scene.add(m);
    console.log(`[fundo] panorama ${backdrop.image.width}×${backdrop.image.height} do Blender`);
  }

  const obstacle = buildObstacle(cfg); scene.add(obstacle);
  return { scene, sunDir, focusShadow: () => {}, obstacle, update: (t) => { time.value = t; }, real: true };
}
