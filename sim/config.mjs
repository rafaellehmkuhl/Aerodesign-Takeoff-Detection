// Carrega config/default.yaml + cenário e resolve os padrões das câmeras.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

export function deepMerge(a, b) {
  if (!isObj(a) || !isObj(b)) return b === undefined ? a : structuredClone(b);
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = isObj(v) && isObj(a[k]) ? deepMerge(a[k], v) : structuredClone(v);
  return out;
}

export function loadConfig(scenarioPath, overrides = {}) {
  const base = YAML.parse(fs.readFileSync(path.join(ROOT, 'config/default.yaml'), 'utf8'));
  // `extends: outro.yaml` (relativo ao próprio arquivo) permite herdar de outro cenário.
  const read = (p) => {
    const d = YAML.parse(fs.readFileSync(p, 'utf8')) ?? {};
    if (!d.extends) return d;
    const parent = read(path.resolve(path.dirname(p), d.extends));
    const cams = new Map((parent.cameras ?? []).map((c) => [c.name, c]));
    for (const c of d.cameras ?? []) cams.set(c.name, deepMerge(cams.get(c.name) ?? {}, c));
    const out = deepMerge(parent, { ...d, cameras: undefined, extends: undefined });
    out.cameras = [...cams.values()];
    return out;
  };
  const sc = scenarioPath ? read(scenarioPath) : {};
  let cfg = deepMerge(base, { ...sc, cameras: undefined });
  cfg = deepMerge(cfg, { ...overrides, cameras: undefined });
  // Câmeras: mescla por nome; `remove: true` exclui uma câmera do padrão.
  const cams = new Map(base.cameras.map((c) => [c.name, c]));
  for (const list of [sc.cameras, overrides.cameras]) for (const c of list ?? []) {
    if (c.remove) cams.delete(c.name); else cams.set(c.name, deepMerge(cams.get(c.name) ?? {}, c));
  }
  cfg.cameras = [...cams.values()].map((c) => deepMerge(deepMerge(cfg.camera_defaults, c.role === 'line' ? {} : {}), c));
  return cfg;
}
