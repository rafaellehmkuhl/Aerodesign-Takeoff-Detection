"""Gráficos do relatório: python tools/report_charts.py runs/relatorio/img"""
import json
import os
import pickle
import sys

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
from matplotlib import font_manager  # noqa: E402
from scipy.spatial.transform import Rotation as Rot  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, ROOT)
out = sys.argv[1]
for f in ("/System/Library/Fonts/Avenir Next.ttc",):
    if os.path.exists(f):
        font_manager.fontManager.addfont(f)
INK, MUTED, RULE = "#1d1d1f", "#6e6e73", "#e4e4e7"
C = {"band": "#c97a1e", "col": "#ecc48a", "aruco": "#4d9a6b", "ml": "#3a7bd5", "truth": INK, "tape": "#c0392b"}
plt.rcParams.update({
    "font.family": ["Avenir Next", "Helvetica Neue", "DejaVu Sans"], "font.size": 9, "text.color": INK,
    "axes.edgecolor": RULE, "axes.labelcolor": MUTED, "axes.spines.top": False, "axes.spines.right": False,
    "axes.grid": True, "axes.grid.axis": "y", "grid.color": RULE, "grid.linewidth": 0.6, "axes.axisbelow": True,
    "xtick.color": MUTED, "ytick.color": MUTED, "xtick.major.size": 0, "ytick.major.size": 0,
    "legend.frameon": False, "savefig.dpi": 220, "savefig.bbox": "tight", "savefig.pad_inches": 0.04,
})


def save(fig, name):
    fig.savefig(os.path.join(out, name), facecolor="white")
    plt.close(fig)


# ---------------------------------------------------------------- erro de folga por simulação
runs = [("relatorio_final", "Cenário final"), ("relatorio_fita_deitada", "Fita deitada"), ("relatorio_dois_lados", "Câmera do\noutro lado"), ("relatorio_invalida", "Decolagem\ninválida")]
algs = [("linecam_band", "Câmera de linha · banda", C["band"]), ("linecam_column", "Câmera de linha · coluna", C["col"]),
        ("aruco", "3 câmeras + ArUco", C["aruco"]), ("markerless", "3 câmeras sem marcador", C["ml"])]
fig, ax = plt.subplots(figsize=(6.2, 2.9))
w = 0.19
for j, (k, lab, col) in enumerate(algs):
    for i, (r, _) in enumerate(runs):
        a = json.load(open(os.path.join(ROOT, "runs", r, "results.json")))["algorithms"][k]
        x = i + (j - 1.5) * w
        e = a.get("clearance_error_m")
        if e is None:
            ax.text(x, 1.5, "sem\ndados", ha="center", va="bottom", fontsize=6.5, color=C["aruco"], linespacing=0.95)
            continue
        ax.bar(x, e * 1000, w * 0.92, color=col, label=lab if i == 0 else None)
        ok = a.get("correct")
        lbl = f"{e*1000:+.0f}".replace("-", "−") + ("" if ok else " ✗")
        ax.text(x, e * 1000 + (1 if e >= 0 else -1), lbl, ha="center", va="bottom" if e >= 0 else "top", fontsize=7, color=INK if ok else C["tape"])
def truth_cm(r):
    g = json.load(open(os.path.join(ROOT, "runs", r, "results.json")))["ground_truth"]["clearance_m"] * 100
    return f"{g:+.1f}".replace("-", "−").replace(".", ",")
ax.set_xticks(range(len(runs)), [f"{n}\nfolga real {truth_cm(r)} cm" for r, n in runs], fontsize=8)
ax.tick_params(axis="x", colors=INK)
ax.set_ylabel("erro na folga medida (mm)")
ax.set_ylim(-32, 62); ax.axhline(0, color=MUTED, lw=0.6)
ax.bar([0], [0], 0, color=C["aruco"], label="3 câmeras + ArUco")
ax.legend(ncol=4, loc="upper center", bbox_to_anchor=(0.5, -0.24), fontsize=7.3, handlelength=0.9, columnspacing=1.0)
save(fig, "grafico_erros.png")

# ---------------------------------------------------------------- versão anterior (marcador plano)
truths = [-10, -2, 2.1, 9.9]
old = {"linecam_band": [14, 20, 21, 25], "linecam_column": [14, 108, 105, 25], "aruco": [-1, 2, 0, -3], "markerless": [-1, -4, -7, -8]}
wrong = {("linecam_band", 1), ("linecam_column", 1)}
fig, ax = plt.subplots(figsize=(6.2, 2.6))
for j, (k, lab, col) in enumerate(algs):
    for i, e in enumerate(old[k]):
        x = i + (j - 1.5) * w
        ax.bar(x, e, w * 0.92, color=col, label=lab if i == 0 else None)
        ax.text(x, e + (2 if e >= 0 else -2), f"{e:+d}".replace("-", "−"), ha="center", va="bottom" if e >= 0 else "top", fontsize=6.8)
        if (k, i) in wrong:
            ax.text(x, e + 12, "✗", ha="center", va="bottom", fontsize=10, color=C["tape"], fontweight="bold")
ax.axhline(0, color=MUTED, lw=0.6)
ax.set_xticks(range(4), [f"folga real {t:+.1f} cm".replace("-", "−").replace(".", ",") for t in truths], fontsize=8)
ax.tick_params(axis="x", colors=INK)
ax.set_ylabel("erro (mm)")
ax.set_ylim(-20, 130)
ax.legend(ncol=4, loc="upper center", bbox_to_anchor=(0.5, -0.16), fontsize=7.3, handlelength=0.9, columnspacing=1.0)
save(fig, "grafico_versao_anterior.png")

# ---------------------------------------------------------------- trajetória do ponto mais baixo
run = os.path.join(ROOT, "runs", "relatorio_final")
scene = json.load(open(os.path.join(run, "scene.json")))
P = np.array(scene["aircraft"].get("collision_points", scene["aircraft"]["vertices"]), float).reshape(-1, 3)
gt = json.load(open(os.path.join(run, "ground_truth.json")))
res = json.load(open(os.path.join(run, "results.json")))["algorithms"]
x_obs, h_obs = scene["world"]["obstacle_x_m"], scene["world"]["obstacle_height_m"]


def lowest(poses):
    xs, zs = [], []
    for p in poses:
        w_ = P @ Rot.from_quat(p["q"]).as_matrix().T + p["p"]
        i = np.argmin(w_[:, 2])
        xs.append(w_[i, 0]); zs.append(w_[i, 2])
    return np.array(xs), np.array(zs)


tx, tz = lowest([p for p in gt["poses"] if 48 < p["p"][0] < 60])
mx, mz = lowest(res["markerless"]["poses"])
sel = (mx > 48) & (mx < 60)
fig, ax = plt.subplots(figsize=(6.2, 2.7))
ax.plot(tx, tz * 100, color=C["truth"], lw=1.6, label="verdade")
ax.plot(mx[sel], mz[sel] * 100, "o", ms=3.2, color=C["ml"], label="3 câmeras sem marcador (pose por quadro)")
ax.plot([x_obs], [res["linecam_band"]["lowest_z_m"] * 100], "D", ms=6, color=C["band"], label="câmera de linha (banda)")
ax.plot([x_obs - 0.25, x_obs + 0.25], [h_obs * 100] * 2, color=C["tape"], lw=3, solid_capstyle="butt")
ax.axvline(x_obs, color=C["tape"], lw=0.7, ls=(0, (3, 3)))
ax.text(x_obs + 0.3, h_obs * 100 - 3, "fita, 90 cm", color=C["tape"], fontsize=7.5, va="top")
ax.set_xlim(48.5, 59.5); ax.set_ylim(55, 112)
ax.set_xlabel("posição ao longo da pista (m)"); ax.set_ylabel("altura do ponto mais baixo (cm)")
ax.legend(loc="lower right", fontsize=7.5)
save(fig, "grafico_trajetoria.png")

# ---------------------------------------------------------------- slit-scan
viz = pickle.load(open(os.path.join(run, "viz.pkl"), "rb"))["linecam"]
S, z = viz["S_band"], viz["z"]
fig, ax = plt.subplots(figsize=(6.2, 2.2))
ax.grid(False)
ax.imshow(S.T, origin="lower", aspect="auto", cmap="Greys", extent=[0, S.shape[0], z[0] * 100, z[-1] * 100], interpolation="nearest")
ax.axhline(h_obs * 100, color=C["tape"], lw=1)
b = res["linecam_band"]
ax.plot([b["frame"] + 0.5], [b["lowest_z_m"] * 100], "o", mfc="none", mec=C["band"], ms=9, mew=1.6)
ax.annotate(f"ponto mais baixo: {b['lowest_z_m']*100:.1f} cm".replace('.', ','), (b["frame"] + 0.5, b["lowest_z_m"] * 100), (b["frame"] - 30, b["lowest_z_m"] * 100 - 28),
            fontsize=7.5, color=INK, arrowprops=dict(arrowstyle="-", color=MUTED, lw=0.6))
ax.text(2, h_obs * 100 - 4, "fita, 90 cm", color=C["tape"], fontsize=7.5, va="top")
ax.set_ylim(40, 160)
ax.set_xlabel("quadro da câmera de linha (240 quadros/s)"); ax.set_ylabel("altura no plano (cm)")
save(fig, "slitscan.png")
print("ok")
