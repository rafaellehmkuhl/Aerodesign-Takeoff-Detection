// Utilidades determinísticas: RNG com semente e ruído de banda limitada.

export function makeRng(seed) {
  let a = (seed >>> 0) || 1;
  const uniform = () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const gauss = () => {
    const u = Math.max(uniform(), 1e-12), v = uniform();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  return { uniform, gauss, fork: () => makeRng(Math.floor(uniform() * 2 ** 31) + 1) };
}

// Ruído suave com rms unitário: soma de senoides com fases/frequências aleatórias em [fmin, fmax].
// É uma função pura do tempo, então pode ser avaliada em qualquer instante (sub-quadros inclusive).
export function bandNoise(rng, fmin, fmax, n = 10) {
  const comps = [];
  for (let i = 0; i < n; i++) {
    comps.push({
      w: 2 * Math.PI * (fmin + (fmax - fmin) * rng.uniform()),
      ph: 2 * Math.PI * rng.uniform(),
      a: 0.6 + 0.8 * rng.uniform(),
    });
  }
  const norm = Math.sqrt(comps.reduce((s, c) => s + 0.5 * c.a * c.a, 0));
  return (t) => {
    let s = 0;
    for (const c of comps) s += c.a * Math.sin(c.w * t + c.ph);
    return s / norm;
  };
}

export const deg = (d) => (d * Math.PI) / 180;
export const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
export const smoothstep = (x) => { const c = clamp(x, 0, 1); return c * c * (3 - 2 * c); };
