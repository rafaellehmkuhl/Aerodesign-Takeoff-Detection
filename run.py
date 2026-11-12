#!/usr/bin/env python3
"""Simulação + validação de decolagem de AeroDesign, de ponta a ponta.

    ./run.py scenarios/padrao.yaml                 # simula, roda os algoritmos e gera runs/padrao/final.mp4
    ./run.py scenarios/padrao.yaml --set dynamics.target_clearance_m=0.02 --name limite
    ./run.py scenarios/padrao.yaml --skip-render   # reaproveita os vídeos já renderizados
    ./run.py scenarios/padrao.yaml --no-video      # só resultados (sem chase/vídeo final)

Etapas: (1) render das câmeras [Node + three.js headless]  (2) algoritmos [Python + OpenCV]
        (3) render do chase com a réplica 3D das estimativas  (4) composição do vídeo final.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.abspath(__file__))
VENV_PY = os.path.join(ROOT, ".venv", "bin", "python")
if os.path.exists(VENV_PY) and os.path.realpath(sys.prefix) != os.path.join(ROOT, ".venv") and not os.environ.get("TAKEOFFSIM_NO_VENV"):
    os.execv(VENV_PY, [VENV_PY, os.path.abspath(__file__), *sys.argv[1:]])

sys.path.insert(0, ROOT)


def parse_value(v):
    try:
        return json.loads(v)
    except json.JSONDecodeError:
        return v


def set_path(d, path, value):
    keys = path.split(".")
    for k in keys[:-1]:
        d = d.setdefault(k, {})
    d[keys[-1]] = value


def node(*args):
    subprocess.run(["node", os.path.join(ROOT, "sim", "render.mjs"), *args], check=True, cwd=ROOT)


def report(run_dir, results, scene_cfg):
    g = results["ground_truth"]
    ev = g["events"]
    v = {"PASS": "VÁLIDA", "FAIL": "INVÁLIDA"}
    lines = [f"# Relatório — {os.path.basename(run_dir)}", "",
             f"- Massa {ev['mass_kg']:.2f} kg · V estol {ev['v_stall']:.1f} m/s · V rotação {ev['v_rotate']:.1f} m/s",
             f"- Rotação em t={ev['t_rotate']:.2f} s · saiu do chão em " + (f"t={ev['t_liftoff']:.2f} s" if ev.get("t_liftoff") else "— (não decolou)") + f" · cruzou o obstáculo em t={ev['t_cross']:.2f} s",
             f"- **Verdade: decolagem {v[g['verdict']]}, folga {g['clearance_m'] * 100:+.1f} cm** (y = {g['y_m']:+.2f} m)", "",
             "| Algoritmo | Veredito | Folga | Erro de folga | Acertou | Tempo |", "|---|---|---|---|---|---|"]
    for a in results["algorithms"].values():
        c, e = a.get("clearance_m"), a.get("clearance_error_m")
        lines.append(f"| {a['label']} | {v.get(a.get('verdict'), 'sem dados')} | {'—' if c is None else f'{c * 100:+.1f} cm'} | "
                     f"{'—' if e is None else f'{e * 1000:+.0f} mm'} | {'sim' if a['correct'] else '**NÃO**'} | {a['runtime_s']:.0f} s |")
    lines.append("")
    for name in ("aruco", "markerless"):
        a = results["algorithms"].get(name)
        if a and a.get("pose_error"):
            pe, st = a["pose_error"], a["stats"]
            lines.append(f"- **{a['label']}**: pose em {pe['frames']}/{st['frames']} quadros; erro de posição mediano {pe['pos_median_m'] * 1000:.0f} mm "
                         f"(máx {pe['pos_max_m'] * 1000:.0f} mm; z: viés {pe['z_bias_m'] * 1000:+.0f} mm, rmse {pe['z_rmse_m'] * 1000:.0f} mm); "
                         f"orientação mediana {pe['rot_median_deg']:.2f}° (máx {pe['rot_max_deg']:.1f}°).")
    lc = results["algorithms"].get("linecam_band")
    if lc:
        lines.append(f"- **Câmera de linha**: {lc['mm_per_px']:.1f} mm/px no eixo da pista; a aeronave anda {lc['mm_between_frames']:.0f} mm entre quadros "
                     f"({lc['px_per_frame']:.1f} px).")
    open(os.path.join(run_dir, "report.md"), "w").write("\n".join(lines) + "\n")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("scenario", nargs="?", default=None, help="arquivo YAML do cenário (padrão: só config/default.yaml)")
    ap.add_argument("--name", help="nome da pasta em runs/ (padrão: nome do cenário)")
    ap.add_argument("--set", action="append", default=[], metavar="chave.sub=valor", help="sobrescreve um parâmetro (pode repetir)")
    ap.add_argument("--skip-render", action="store_true", help="não renderiza de novo as câmeras")
    ap.add_argument("--no-video", action="store_true", help="não gera o chase nem o vídeo final")
    args = ap.parse_args()

    name = args.name or (os.path.splitext(os.path.basename(args.scenario))[0] if args.scenario else "default")
    run_dir = os.path.join(ROOT, "runs", name)
    os.makedirs(run_dir, exist_ok=True)
    t0 = time.time()

    if not args.skip_render:
        # Resolve a configuração (default + cenário + --set) com o mesmo código do simulador.
        over = {}
        for s in args.set:
            k, v = s.split("=", 1)
            set_path(over, k, parse_value(v))
        js = ("import { loadConfig } from './sim/config.mjs'; "
              f"process.stdout.write(JSON.stringify(loadConfig({json.dumps(os.path.abspath(args.scenario)) if args.scenario else 'null'}, {json.dumps(over)})));")
        cfg = subprocess.run(["node", "--input-type=module", "-e", js], check=True, cwd=ROOT, capture_output=True, text=True).stdout
        cfg_path = os.path.join(run_dir, "config.input.json")
        open(cfg_path, "w").write(cfg)
        print(f"[1/4] Renderizando as câmeras → {run_dir}")
        node("--config", cfg_path, "--out", run_dir)

    from algos import compose, evaluate

    print("[2/4] Rodando os algoritmos")
    results, _ = evaluate.evaluate(run_dir)
    scene = compose.Scene(run_dir)
    report(run_dir, results, scene.cfg)

    if not args.no_video:
        gt = json.load(open(os.path.join(run_dir, "ground_truth.json")))
        tl = compose.timeline(scene, gt, results)
        tl["ghosts"] = compose.ghosts(results)
        json.dump(tl, open(os.path.join(run_dir, "timeline.json"), "w"))
        print("[3/4] Renderizando a câmera chase com a réplica 3D")
        node("--config", os.path.join(run_dir, "config.resolved.json"), "--out", run_dir, "--timeline", os.path.join(run_dir, "timeline.json"))
        print("[4/4] Compondo o vídeo final")
        compose.compose(run_dir)
    print(f"Pronto em {time.time() - t0:.0f} s. Relatório: {os.path.join(run_dir, 'report.md')}")


if __name__ == "__main__":
    main()
