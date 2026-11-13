// Renderização headless (Chromium via Playwright) dos vídeos de cada câmera.
//
//   node sim/render.mjs --config <resolved.json|scenario.yaml> --out <dir> [--cameras a,b] [--only-meta]
//   node sim/render.mjs --config <resolved.json> --out <dir> --timeline <timeline.json>   (passo do chase/replay)
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { loadConfig } from './config.mjs';
import { startServer } from './server.mjs';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/node-tools/node_modules/playwright')); }

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith('--') ? [...a, [v.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] == null ? true : all[i + 1]]] : a), []));
const out = path.resolve(args.out ?? 'runs/tmp');
fs.mkdirSync(out, { recursive: true });
const cfg = args.config.endsWith('.json') ? JSON.parse(fs.readFileSync(args.config, 'utf8')) : loadConfig(args.config);
fs.writeFileSync(path.join(out, 'config.resolved.json'), JSON.stringify(cfg, null, 1));

const { server, port } = await startServer({ config: cfg });
// Sem GPU (CI, contêiner) o WebGL roda em software (SwiftShader). Com GPU: SIM_GPU=1.
const gl = process.env.SIM_GPU ? ['--ignore-gpu-blocklist', '--enable-gpu', '--use-angle=' + (process.platform === 'darwin' ? 'metal' : 'default')] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
// Navegador: o Chromium do Playwright, se instalado (npx playwright install chromium); senão o Chrome do sistema.
let browser;
try { browser = await chromium.launch({ args: [...gl, '--enable-webgl'] }); }
catch (e) { browser = await chromium.launch({ channel: 'chrome', args: [...gl, '--enable-webgl'] }); }
const page = await browser.newPage();
page.on('console', (m) => { if (m.type() === 'error') console.error('[page]', m.text()); });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.goto(`http://127.0.0.1:${port}/headless.html`);
await page.waitForFunction('window.ready === true', null, { timeout: 120000 });

function encoder(file, fps, quality) {
  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(quality), '-pix_fmt', 'yuv420p', file], { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise((res, rej) => ff.on('close', (c) => (c === 0 ? res() : rej(new Error(`ffmpeg ${c}`)))));
  return { write: (buf) => new Promise((r) => (ff.stdin.write(buf) ? r() : ff.stdin.once('drain', r))), end: () => { ff.stdin.end(); return done; } };
}

async function renderVideo(name, times, fps, file, quality = 0.93) {
  const enc = encoder(file, fps, 14);
  const t0 = Date.now();
  for (let i = 0; i < times.length; i++) {
    const b64 = await page.evaluate(([n, t, k, q]) => window.renderFrame(n, t, k, q), [name, times[i], i, quality]);
    await enc.write(Buffer.from(b64, 'base64'));
    if (i % 25 === 0 || i === times.length - 1) process.stdout.write(`\r  ${name}: ${i + 1}/${times.length} quadros (${((Date.now() - t0) / (i + 1)).toFixed(0)} ms/quadro)   `);
  }
  await enc.end();
  process.stdout.write('\n');
}

if (args.timeline) {
  // Segundo passo: câmera chase seguindo a linha do tempo do vídeo final, com os fantasmas das estimativas.
  const tl = JSON.parse(fs.readFileSync(args.timeline, 'utf8'));
  await page.evaluate((g) => window.sim.setGhosts(g), tl.ghosts ?? []);
  await renderVideo('chase', tl.times, tl.fps, path.join(out, 'chase.mp4'), 0.9);
} else {
  const meta = await page.evaluate(() => window.sim.metadata());
  const { ground_truth: gt, ...pub } = meta;
  // O que os algoritmos podem ver (calibração acreditada, modelo, obstáculo)...
  fs.writeFileSync(path.join(out, 'scene.json'), JSON.stringify(pub));
  // ...e a verdade, usada só na avaliação.
  fs.writeFileSync(path.join(out, 'ground_truth.json'), JSON.stringify(gt));
  console.log(`Trajetória: massa ${gt.events.mass_kg.toFixed(2)} kg, Vestol ${gt.events.v_stall.toFixed(1)} m/s, rotação t=${gt.events.t_rotate?.toFixed(2)} s, ` +
    `decolou t=${gt.events.t_liftoff?.toFixed(2) ?? '—'} s, cruzou t=${gt.events.t_cross.toFixed(2)} s; folga real ${(gt.clearance_m * 100).toFixed(1)} cm (${gt.verdict})`);
  if (args.stills || args.at != null) {
    // Um quadro por câmera, no instante --at (absoluto) ou --stills (relativo ao cruzamento do obstáculo).
    const t = args.at != null && args.at !== true ? Number(args.at) : gt.events.t_cross + Number(args.stills === true ? 0 : args.stills);
    for (const name of [...cfg.cameras.map((c) => c.name), 'chase', 'free']) {
      if (typeof args.cameras === 'string' && !args.cameras.split(',').includes(name)) continue;
      const t0 = Date.now();
      const b64 = await page.evaluate(([n, tt]) => window.renderFrame(n, tt, 0, 0.93), [name, t]);
      fs.writeFileSync(path.join(out, `still_${name}.jpg`), Buffer.from(b64, 'base64'));
      console.log(`  still ${name}: ${Date.now() - t0} ms`);
    }
  } else if (!args['only-meta']) {
    const only = typeof args.cameras === 'string' ? args.cameras.split(',') : null;
    for (const c of cfg.cameras) {
      if (only && !only.includes(c.name)) continue;
      const tms = args['max-frames'] ? meta.frames[c.name].filter((_, i, a) => i % Math.ceil(a.length / Number(args['max-frames'])) === 0) : meta.frames[c.name];
      await renderVideo(c.name, tms, c.fps, path.join(out, `${c.name}.mp4`), c.jpeg_quality);
    }
  }
}
await browser.close();
server.close();
