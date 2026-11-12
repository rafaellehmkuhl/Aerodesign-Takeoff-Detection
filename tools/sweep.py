#!/usr/bin/env python3
"""Varre folgas-alvo (e sementes) e tabela o acerto de cada algoritmo.

    tools/sweep.py scenarios/rapido.yaml --clearances -0.10,-0.02,0.02,0.10 --seeds 1,2

Gera runs/sweep_<cenário>/summary.md e summary.csv. Não gera vídeo final (use run.py para isso).
"""
import argparse, csv, json, os, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ap = argparse.ArgumentParser()
ap.add_argument("scenario")
ap.add_argument("--clearances", default="-0.10,-0.02,0.02,0.10")
ap.add_argument("--seeds", default="1")
ap.add_argument("--set", action="append", default=[])
ap.add_argument("--skip-render", action="store_true", help="reaproveita os vídeos e só roda os algoritmos de novo")
a = ap.parse_args()
base = os.path.splitext(os.path.basename(a.scenario))[0]
rows = []
for seed in a.seeds.split(","):
    for c in a.clearances.split(","):
        name = f"sweep_{base}/s{seed}_c{float(c) * 100:+.0f}cm"
        cmd = [os.path.join(ROOT, "run.py"), a.scenario, "--name", name, "--no-video", "--set", f"dynamics.target_clearance_m={c}", "--set", f"seed={seed}"]
        for s in a.set:
            cmd += ["--set", s]
        if a.skip_render:
            cmd.append("--skip-render")
        subprocess.run(cmd, check=True)
        r = json.load(open(os.path.join(ROOT, "runs", name, "results.json")))
        for k, alg in r["algorithms"].items():
            rows.append({"seed": seed, "truth_cm": round(r["ground_truth"]["clearance_m"] * 100, 2), "truth": r["ground_truth"]["verdict"], "algorithm": alg["label"],
                         "verdict": alg.get("verdict"), "clearance_cm": None if alg.get("clearance_m") is None else round(alg["clearance_m"] * 100, 2),
                         "error_mm": None if alg.get("clearance_error_m") is None else round(alg["clearance_error_m"] * 1000, 1), "correct": alg["correct"]})
out = os.path.join(ROOT, "runs", f"sweep_{base}")
with open(os.path.join(out, "summary.csv"), "w", newline="") as f:
    w = csv.DictWriter(f, fieldnames=list(rows[0])); w.writeheader(); w.writerows(rows)
algs = list(dict.fromkeys(r["algorithm"] for r in rows))
cases = list(dict.fromkeys((r["seed"], r["truth_cm"], r["truth"]) for r in rows))
md = ["| semente | folga real | verdade | " + " | ".join(algs) + " |", "|---|---|---|" + "---|" * len(algs)]
for seed, tc, tv in cases:
    cells = []
    for al in algs:
        r = next(x for x in rows if x["algorithm"] == al and x["seed"] == seed and x["truth_cm"] == tc)
        cells.append("sem dados" if r["error_mm"] is None else f"{'✔' if r['correct'] else '✘'} {r['error_mm']:+.0f} mm")
    md.append(f"| {seed} | {tc:+.1f} cm | {tv} | " + " | ".join(cells) + " |")
md += ["", "Acertos de veredito: " + ", ".join(f"{al}: {sum(r['correct'] for r in rows if r['algorithm'] == al)}/{len(cases)}" for al in algs)]
open(os.path.join(out, "summary.md"), "w").write("\n".join(md) + "\n")
print("\n".join(md))
