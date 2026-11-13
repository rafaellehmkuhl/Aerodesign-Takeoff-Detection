// Modelo de câmera: intrínsecos, pose real (com vibração) x pose calibrada (com erro),
// e o renderizador com motion blur por acumulação, distorção radial e ruído de sensor.
import * as THREE from 'three';
import { makeRng, bandNoise, deg } from './util.js';

// Antisserrilhado de brilhos: um reflexo especular minúsculo com radiância enorme domina a média das
// amostras do MSAA e vira um pixel branco serrilhado. Limitar a radiância de saída dos materiais (bem acima
// do branco difuso ao sol) resolve isso sem mudar a imagem depois do tone mapping.
THREE.ShaderChunk.opaque_fragment = 'outgoingLight = min(outgoingLight, vec3(2.5));\n' + THREE.ShaderChunk.opaque_fragment;

const D_CV = new THREE.Matrix4().makeScale(1, -1, -1); // eixos three (x dir, y cima, z trás) -> OpenCV

function smallRot(rx, ry, rz) {
  // Vetor de rotação dado em eixos OpenCV (x direita, y baixo, z frente), aplicado no referencial local three.
  const v = new THREE.Vector3(rx, -ry, -rz), a = v.length();
  return new THREE.Matrix4().makeRotationAxis(a > 0 ? v.normalize() : new THREE.Vector3(1, 0, 0), a);
}

function cvExtrinsics(matrixWorld) {
  const m = new THREE.Matrix4().multiplyMatrices(matrixWorld, D_CV); // câmera(cv) -> mundo
  const inv = m.clone().invert().elements;
  return {
    R: [[inv[0], inv[4], inv[8]], [inv[1], inv[5], inv[9]], [inv[2], inv[6], inv[10]]],
    t: [inv[12], inv[13], inv[14]],
  };
}

export function buildCamera(spec, cfg, index) {
  const rng = makeRng(cfg.seed * 1009 + 97 * (index + 1));
  const [W, H] = spec.resolution;
  const fx = W / 2 / Math.tan(deg(spec.hfov_deg) / 2);
  const dist = { k1: spec.distortion?.k1 ?? 0, k2: spec.distortion?.k2 ?? 0 };

  // Pose real nominal.
  const base = new THREE.Object3D();
  base.up.set(0, 0, 1);
  base.position.fromArray(spec.position);
  base.lookAt(new THREE.Vector3().fromArray(spec.look_at));
  // Object3D.lookAt aponta +z para o alvo; a câmera olha por -z.
  base.rotateY(Math.PI);
  base.rotateZ(deg(spec.roll_deg ?? 0));
  base.updateMatrix();
  const baseRot = new THREE.Matrix4().extractRotation(base.matrix);
  const pos = base.position.clone();

  // Vibração: alta frequência (rms) + balanço lento proporcional ao vento.
  const vb = spec.vibration ?? {};
  const wind = cfg.environment.wind.speed_ms;
  const hf = [0, 1, 2].map(() => bandNoise(rng.fork(), vb.band_hz?.[0] ?? 12, vb.band_hz?.[1] ?? 45, 8));
  const lf = [0, 1, 2].map(() => bandNoise(rng.fork(), 0.6 * (vb.sway_hz ?? 1.3), 1.4 * (vb.sway_hz ?? 1.3), 4));
  const aHf = deg(vb.rms_deg ?? 0), aLf = deg((vb.sway_deg_per_ms ?? 0) * wind);
  const vibAngles = (t) => [0, 1, 2].map((i) => aHf * hf[i](t) + aLf * lf[i](t) * (i === 2 ? 0.4 : 1));

  const truePoseAt = (t, target = new THREE.Matrix4()) => {
    const [rx, ry, rz] = vibAngles(t);
    target.multiplyMatrices(baseRot, smallRot(rx, ry, rz));
    target.setPosition(pos);
    return target;
  };

  // Calibração "acreditada" pelos algoritmos.
  const ce = spec.calibration_error ?? {};
  const g = () => rng.gauss();
  const pe = (ce.position_m ?? [0, 0, 0]).map((v) => v + (ce.position_sigma_m ?? 0) * g());
  const re = (ce.rotation_deg ?? [0, 0, 0]).map((v) => deg(v + (ce.rotation_sigma_deg ?? 0) * g()));
  const fErr = 1 + ((ce.focal_sigma_pct ?? 0) * g()) / 100;
  const believed = new THREE.Matrix4().multiplyMatrices(baseRot, smallRot(re[0], re[1], re[2]));
  believed.setPosition(pos.clone().add(new THREE.Vector3(pe[0], pe[1], pe[2])));
  const ext = cvExtrinsics(believed);
  const calibration = {
    name: spec.name, role: spec.role, width: W, height: H, fps: spec.fps,
    K: [[fx * fErr, 0, W / 2 - 0.5], [0, fx * fErr, H / 2 - 0.5], [0, 0, 1]],
    dist: [dist.k1 + (ce.distortion_sigma ?? 0) * g(), dist.k2 + 0.3 * (ce.distortion_sigma ?? 0) * g(), 0, 0, 0],
    R: ext.R, t: ext.t,
  };
  const truth = (t) => {
    const e = cvExtrinsics(truePoseAt(t));
    return { K: [[fx, 0, W / 2 - 0.5], [0, fx, H / 2 - 0.5], [0, 0, 1]], dist: [dist.k1, dist.k2, 0, 0, 0], R: e.R, t: e.t };
  };

  // Margem de renderização para cobrir os raios que a distorção puxa de fora do quadro.
  let scale = 1;
  for (const [u, v] of [[1, 1], [1, 0], [0, 1], [0.7, 0.7]]) {
    const xd = (u * W) / 2 / fx, yd = (v * H) / 2 / fx;
    let xu = xd, yu = yd;
    for (let i = 0; i < 12; i++) { const r2 = xu * xu + yu * yu, k = 1 + dist.k1 * r2 + dist.k2 * r2 * r2; xu = xd / k; yu = yd / k; }
    if (xd > 0) scale = Math.max(scale, xu / xd); if (yd > 0) scale = Math.max(scale, yu / yd);
  }
  scale *= 1.01;
  const cam = new THREE.PerspectiveCamera(2 * Math.atan((scale * H) / 2 / fx) * (180 / Math.PI), W / H, 0.3, 5000);
  cam.matrixAutoUpdate = false;

  return { spec, name: spec.name, W, H, fx, dist, scale, cam, truePoseAt, calibration, truth, seed: index + 1 };
}

// Câmera sem erros (chase / visão livre).
export function idealCamera(name, resolution, hfov) {
  const [W, H] = resolution, fx = W / 2 / Math.tan(deg(hfov) / 2);
  const cam = new THREE.PerspectiveCamera(2 * Math.atan(H / 2 / fx) * (180 / Math.PI), W / H, 0.1, 5000);
  cam.up.set(0, 0, 1);
  return { name, W, H, fx, dist: { k1: 0, k2: 0 }, scale: 1, cam, ideal: true, spec: { blur_samples: 1, exposure_s: 0, noise_sigma: 0, bloom: 0.25, saturation: 1.12, vignette: 0.35, ambient_occlusion: 1.0 }, seed: 99 };
}

const POST_FS = /* glsl */`
uniform sampler2D tAccum, tBloom; uniform vec2 f, px; uniform float k1, k2, scale, weight, noise, seed, ca, vignette, bloom, sat, fxaa;
// FXAA sobre a imagem HDR: as cores são comprimidas (c / (1 + luma)) antes de misturar, para que um vizinho
// muito claro não domine, e expandidas de volta depois.
vec3 cmp(vec2 u) { vec3 c = texture2D(tAccum, u).rgb * weight; return c / (1. + dot(c, vec3(.299, .587, .114))); }
float lum(vec3 c) { return dot(c, vec3(.299, .587, .114)); }
vec3 aa(vec2 u) {
  vec3 m = cmp(u);
  if (fxaa < 0.5) return m / max(1. - lum(m), 1e-3);
  float lNW = lum(cmp(u + vec2(-1., -1.) * px)), lNE = lum(cmp(u + vec2(1., -1.) * px)), lSW = lum(cmp(u + vec2(-1., 1.) * px)), lSE = lum(cmp(u + vec2(1., 1.) * px)), lM = lum(m);
  float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE))), lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
  vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), (lNW + lSW) - (lNE + lSE));
  float red = max((lNW + lNE + lSW + lSE) * 0.03125, 1. / 128.);
  dir = clamp(dir / (min(abs(dir.x), abs(dir.y)) + red), -8., 8.) * px;
  vec3 a = 0.5 * (cmp(u + dir * (1. / 3. - 0.5)) + cmp(u + dir * (2. / 3. - 0.5)));
  vec3 b = a * 0.5 + 0.25 * (cmp(u - dir * 0.5) + cmp(u + dir * 0.5));
  float lB = lum(b);
  vec3 r = (lB < lMin || lB > lMax) ? a : b;
  return r / max(1. - lum(r), 1e-3);
}
varying vec2 vUv;
float hash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
void main() {
  vec2 xd = (vUv - 0.5) / f, xu = xd;
  for (int i = 0; i < 7; i++) { float r2 = dot(xu, xu); xu = xd / (1. + k1 * r2 + k2 * r2 * r2); }
  vec2 uv = 0.5 + xu * f / scale;
  // Aberração cromática lateral leve e vinheta (lente real).
  vec2 dc = (uv - 0.5);
  float r2c = dot(xd, xd);
  vec3 col = aa(uv);
  if (ca > 0.) { vec3 c0 = texture2D(tAccum, uv).rgb; col.r += (texture2D(tAccum, uv + dc * ca).r - c0.r) * weight; col.b += (texture2D(tAccum, uv - dc * ca).b - c0.b) * weight; }
  if (!(col.r + col.g + col.b < 1e6)) col = vec3(0.);
  col += texture2D(tBloom, uv).rgb * bloom;      // brilho difuso da lente em torno de áreas muito claras
  col *= 1.0 - vignette * r2c;
  gl_FragColor = vec4(col, 1.);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  gl_FragColor.rgb = mix(vec3(dot(gl_FragColor.rgb, vec3(0.2126, 0.7152, 0.0722))), gl_FragColor.rgb, sat);
  vec2 p = gl_FragCoord.xy + seed * vec2(37.1, 91.7);
  float n = hash(p) + hash(p + 17.3) + hash(p + 41.9) + hash(p + 77.7) - 2.;   // ~gaussiano, sigma 0.577
  vec3 chroma = vec3(hash(p + 3.1), hash(p + 5.7), hash(p + 9.3)) - .5;
  gl_FragColor.rgb = clamp(gl_FragColor.rgb + noise * (1.73 * n + 0.8 * chroma), 0., 1.);
}`;
const QUAD_VS = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }`;

export class CameraRenderer {
  constructor(canvas, { msaa = 4 } = {}) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(1);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;   // PCF com raio (shadow.radius): penumbra ajustável
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.6;   // ajustado por createSim conforme o cenário
    this.msaa = msaa;
    this.targets = new Map();
    this.quadScene = new THREE.Scene();
    this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.addMat = new THREE.ShaderMaterial({
      uniforms: { t: { value: null }, tAO: { value: null }, ao: { value: 0 } }, vertexShader: QUAD_VS,
      fragmentShader: `uniform sampler2D t, tAO; uniform float ao; varying vec2 vUv;
        void main(){ vec3 c = texture2D(t, vUv).rgb;
          // a oclusão pertence à luz ambiente: some nos pixels fortemente iluminados pelo sol
          float l = dot(c, vec3(.299, .587, .114)), k = ao * (1. - smoothstep(0.25, 1.1, l));
          gl_FragColor = vec4(c * mix(1., texture2D(tAO, vUv).r, k), 1.); }`,
      blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, toneMapped: false,
    });
    this.postMat = new THREE.ShaderMaterial({
      uniforms: { tAccum: { value: null }, f: { value: new THREE.Vector2() }, k1: { value: 0 }, k2: { value: 0 }, scale: { value: 1 }, weight: { value: 1 }, noise: { value: 0 }, seed: { value: 0 }, ca: { value: 0 }, vignette: { value: 0 }, tBloom: { value: null }, bloom: { value: 0 }, sat: { value: 1 }, px: { value: new THREE.Vector2() }, fxaa: { value: 1 } },
      vertexShader: QUAD_VS, fragmentShader: POST_FS, depthTest: false, depthWrite: false,
    });
    // Bloom: passa-alta em 1/4 da resolução + desfoque separável.
    this.brightMat = new THREE.ShaderMaterial({
      uniforms: { t: { value: null }, weight: { value: 1 }, thr: { value: 2.2 } }, vertexShader: QUAD_VS, depthTest: false, depthWrite: false, toneMapped: false,
      fragmentShader: 'uniform sampler2D t; uniform float weight, thr; varying vec2 vUv; void main(){ vec3 c = texture2D(t, vUv).rgb * weight; float l = max(c.r, max(c.g, c.b)); if (!(l >= 0. && l < 1e5)) { c = vec3(0.); l = 0.; } c = min(c, vec3(24.)); l = min(l, 24.); gl_FragColor = vec4(c * max(l - thr, 0.) / max(l, 1e-4), 1.); }',
    });
    this.blurMat = new THREE.ShaderMaterial({
      uniforms: { t: { value: null }, d: { value: new THREE.Vector2() } }, vertexShader: QUAD_VS, depthTest: false, depthWrite: false, toneMapped: false,
      fragmentShader: `uniform sampler2D t; uniform vec2 d; varying vec2 vUv;
        void main(){ vec3 c = texture2D(t, vUv).rgb * 0.1964; 
          c += (texture2D(t, vUv + d * 1.41).rgb + texture2D(t, vUv - d * 1.41).rgb) * 0.2969;
          c += (texture2D(t, vUv + d * 3.29).rgb + texture2D(t, vUv - d * 3.29).rgb) * 0.0945;
          c += (texture2D(t, vUv + d * 5.18).rgb + texture2D(t, vUv - d * 5.18).rgb) * 0.0104;
          gl_FragColor = vec4(c, 1.); }`,
    });
    // Oclusão de ambiente em espaço de tela (meia resolução), a partir do depth buffer.
    this.aoMat = new THREE.ShaderMaterial({
      uniforms: { tDepth: { value: null }, proj: { value: new THREE.Matrix4() }, projInv: { value: new THREE.Matrix4() }, texel: { value: new THREE.Vector2() }, radius: { value: 0.35 } },
      vertexShader: QUAD_VS, depthTest: false, depthWrite: false, toneMapped: false,
      fragmentShader: `uniform sampler2D tDepth; uniform mat4 proj, projInv; uniform vec2 texel; uniform float radius; varying vec2 vUv;
        vec3 vp(vec2 u) { vec4 p = projInv * vec4(u * 2. - 1., texture2D(tDepth, u).x * 2. - 1., 1.); return p.xyz / p.w; }
        float hash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
        void main() {
          if (texture2D(tDepth, vUv).x >= 0.99999) { gl_FragColor = vec4(1.); return; }
          vec3 p = vp(vUv), n = normalize(cross(vp(vUv + vec2(texel.x, 0.)) - p, vp(vUv + vec2(0., texel.y)) - p));
          if (dot(n, p) > 0.) n = -n;
          float a0 = hash(gl_FragCoord.xy) * 6.2832, occ = 0.;
          for (int i = 0; i < 10; i++) {
            float fi = float(i), r = radius * (0.2 + 0.8 * fract(fi * 0.618 + 0.37)), a = a0 + fi * 2.39996;
            vec4 c = proj * vec4(p + vec3(cos(a), sin(a), 0.) * r + n * radius * 0.1, 1.);
            vec3 v = vp(c.xy / c.w * 0.5 + 0.5) - p;
            float d2 = dot(v, v);
            occ += max(dot(n, v) - 0.015, 0.) / (d2 + 0.004) * step(d2, radius * radius * 4.);
          }
          gl_FragColor = vec4(vec3(clamp(1. - occ * 0.045, 0., 1.)), 1.);
        }`,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.addMat);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
  }

  _targets(w, h) {
    const key = `${w}x${h}`;
    if (!this.targets.has(key)) {
      const opts = { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter };
      this.targets.set(key, {
        scene: new THREE.WebGLRenderTarget(w, h, { ...opts, samples: this.msaa, depthBuffer: true, depthTexture: new THREE.DepthTexture(w, h) }),
        accum: new THREE.WebGLRenderTarget(w, h, { ...opts, depthBuffer: false }),
        ao1: new THREE.WebGLRenderTarget(Math.ceil(w / 2), Math.ceil(h / 2), { ...opts, depthBuffer: false }),
        ao2: new THREE.WebGLRenderTarget(Math.ceil(w / 2), Math.ceil(h / 2), { ...opts, depthBuffer: false }),
        b1: new THREE.WebGLRenderTarget(Math.ceil(w / 4), Math.ceil(h / 4), { ...opts, depthBuffer: false }),
        b2: new THREE.WebGLRenderTarget(Math.ceil(w / 4), Math.ceil(h / 4), { ...opts, depthBuffer: false }),
      });
    }
    return this.targets.get(key);
  }

  // Renderiza um quadro da câmera `c` centrado no instante t. `setTime(t)` atualiza a cena.
  render(scene, c, t, setTime, frameIndex = 0) {
    const r = this.renderer;
    if (r.domElement.width !== c.W || r.domElement.height !== c.H) r.setSize(c.W, c.H, false);
    const n = Math.max(1, c.spec.exposure_s > 0 ? (c.blurN ?? c.spec.blur_samples ?? 1) : 1);
    const tg = this._targets(Math.ceil(c.W * c.scale), Math.ceil(c.H * c.scale));
    r.setRenderTarget(tg.accum); r.setClearColor(0x000000, 1); r.clear();
    for (let i = 0; i < n; i++) {
      const ts = n === 1 ? t : t + c.spec.exposure_s * ((i + 0.5) / n - 0.5);
      setTime(ts);
      if (c.truePoseAt) { c.truePoseAt(ts, c.cam.matrix); c.cam.matrixWorld.copy(c.cam.matrix); c.cam.matrixWorldInverse.copy(c.cam.matrix).invert(); }
      else c.cam.updateMatrixWorld(true);
      r.setRenderTarget(tg.scene); r.render(scene, c.cam);
      const aoK = c.spec.ambient_occlusion ?? 0;
      if (aoK > 0) {
        const m = this.aoMat.uniforms; m.tDepth.value = tg.scene.depthTexture; m.proj.value.copy(c.cam.projectionMatrix); m.projInv.value.copy(c.cam.projectionMatrixInverse);
        m.texel.value.set(1 / tg.scene.width, 1 / tg.scene.height);
        this.quad.material = this.aoMat; r.setRenderTarget(tg.ao1); r.render(this.quadScene, this.quadCam);
        this.quad.material = this.blurMat;
        this.blurMat.uniforms.t.value = tg.ao1.texture; this.blurMat.uniforms.d.value.set(1 / tg.ao1.width, 0); r.setRenderTarget(tg.ao2); r.render(this.quadScene, this.quadCam);
        this.blurMat.uniforms.t.value = tg.ao2.texture; this.blurMat.uniforms.d.value.set(0, 1 / tg.ao1.height); r.setRenderTarget(tg.ao1); r.render(this.quadScene, this.quadCam);
      }
      this.addMat.uniforms.tAO.value = tg.ao1.texture; this.addMat.uniforms.ao.value = aoK;
      this.quad.material = this.addMat; this.addMat.uniforms.t.value = tg.scene.texture;
      r.setRenderTarget(tg.accum); r.autoClear = false; r.render(this.quadScene, this.quadCam); r.autoClear = true;
    }
    const u = this.postMat.uniforms;
    const bloom = c.spec.bloom ?? 0;
    if (bloom > 0) {
      const bw = tg.b1.width, bh = tg.b1.height;
      this.quad.material = this.brightMat; this.brightMat.uniforms.t.value = tg.accum.texture; this.brightMat.uniforms.weight.value = 1 / n;
      r.setRenderTarget(tg.b1); r.render(this.quadScene, this.quadCam);
      this.quad.material = this.blurMat;
      for (let k = 0; k < 2; k++) {
        this.blurMat.uniforms.t.value = tg.b1.texture; this.blurMat.uniforms.d.value.set((1 + k) / bw, 0); r.setRenderTarget(tg.b2); r.render(this.quadScene, this.quadCam);
        this.blurMat.uniforms.t.value = tg.b2.texture; this.blurMat.uniforms.d.value.set(0, (1 + k) / bh); r.setRenderTarget(tg.b1); r.render(this.quadScene, this.quadCam);
      }
    }
    u.tBloom.value = tg.b1.texture; u.bloom.value = bloom; u.sat.value = c.spec.saturation ?? 1;
    u.px.value.set(1 / tg.accum.width, 1 / tg.accum.height); u.fxaa.value = (c.spec.fxaa ?? true) ? 1 : 0;
    u.tAccum.value = tg.accum.texture; u.f.value.set(c.fx / c.W, c.fx / c.H);
    u.k1.value = c.dist.k1; u.k2.value = c.dist.k2; u.scale.value = c.scale; u.weight.value = 1 / n;
    u.noise.value = c.spec.noise_sigma ?? 0; u.ca.value = c.spec.chromatic_aberration ?? 0; u.vignette.value = c.spec.vignette ?? 0; u.seed.value = (frameIndex * 7 + c.seed * 131) % 1000;
    this.quad.material = this.postMat;
    r.setRenderTarget(null); r.render(this.quadScene, this.quadCam);
  }
}
