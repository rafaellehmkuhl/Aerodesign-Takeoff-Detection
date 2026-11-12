"""Roda os três algoritmos sobre uma pasta de execução e compara com a verdade.

    python -m algos.evaluate runs/<nome>
"""
from __future__ import annotations

import json
import os
import pickle
import sys
import time

import numpy as np

from . import aruco_mv, linecam, markerless
from .common import Scene, decide, summarize_errors


class NpEncoder(json.JSONEncoder):
    def default(self, o):
        if isinstance(o, np.generic):
            return o.item()
        if isinstance(o, np.ndarray):
            return o.tolist()
        return super().default(o)


def evaluate(run_dir, log=print):
    scene = Scene(run_dir)
    gt = json.load(open(os.path.join(run_dir, "ground_truth.json")))
    win = scene.cfg["algorithms"]["smoothing_window_s"]
    results = {"ground_truth": {"verdict": gt["verdict"], "clearance_m": gt["clearance_m"], "t_cross": gt["clearance_t"],
                                "y_m": gt["clearance_y_m"], "events": gt["events"]}, "algorithms": {}}
    viz = {}

    def finish(name, label, decision, extra, dt):
        d = dict(decision)
        if d.get("clearance_m") is not None:
            d["clearance_error_m"] = d["clearance_m"] - gt["clearance_m"]
        d["correct"] = d.get("verdict") == gt["verdict"]
        results["algorithms"][name] = {"label": label, **d, **extra, "runtime_s": dt}
        c = d.get("clearance_m")
        log(f"  {label:<34} {d.get('verdict', '—'):<9} folga {'—' if c is None else f'{c * 100:+7.1f} cm'}"
            f"   erro {'—' if c is None else f'{d['clearance_error_m'] * 1000:+7.1f} mm'}   ({dt:.1f} s)")

    log(f"  {'VERDADE':<34} {gt['verdict']:<9} folga {gt['clearance_m'] * 100:+7.1f} cm")

    t0 = time.time()
    lc = linecam.run(scene)
    if lc:
        viz["linecam"] = lc.pop("viz")
        for mode, label in (("band", "Câmera de linha (banda)"), ("column", "Câmera de linha (coluna)")):
            extra = {k: lc[k] for k in ("px_per_frame", "mm_per_px", "mm_between_frames", "band_half_px")}
            finish(f"linecam_{mode}", label, lc[mode], extra, time.time() - t0)

    videos = {c.name: scene.video(c.name) for c in scene.tracking()}
    for name, label, mod in (("aruco", "3 câmeras + ArUco", aruco_mv), ("markerless", "3 câmeras sem marcador", markerless)):
        t0 = time.time()
        out = mod.run(scene, videos)
        if out is None:
            continue
        traj = out.pop("trajectory")
        viz[name] = {**out, "trajectory": traj}
        if traj is None:
            finish(name, label, {"verdict": "SEM_DADOS", "clearance_m": None}, {"stats": out["stats"]}, time.time() - t0)
            continue
        extra = {"stats": out["stats"], "pose_error": summarize_errors(traj, gt), "poses": traj.to_json()}
        finish(name, label, decide(traj, scene, win), extra, time.time() - t0)
        pe = extra["pose_error"]
        log(f"      poses em {pe['frames']}/{out['stats']['frames']} quadros; erro de posição mediano {pe['pos_median_m'] * 1000:.1f} mm "
            f"(z rmse {pe['z_rmse_m'] * 1000:.1f} mm), orientação mediana {pe['rot_median_deg']:.2f}°")

    with open(os.path.join(run_dir, "results.json"), "w") as f:
        json.dump(results, f, cls=NpEncoder, indent=1)
    with open(os.path.join(run_dir, "viz.pkl"), "wb") as f:
        pickle.dump(viz, f)
    return results, viz


if __name__ == "__main__":
    evaluate(sys.argv[1])
