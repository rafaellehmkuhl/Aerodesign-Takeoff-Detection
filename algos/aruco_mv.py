"""Algoritmo 2 — pose 6DoF multi-câmera com marcadores ArUco.

Por quadro sincronizado:
  1. detecta os marcadores em cada câmera (numa região ampliada em torno do movimento);
  2. inicializa a pose por PnP na câmera com mais cantos (ou a pose do quadro anterior);
  3. refina a pose minimizando o erro de reprojeção de TODOS os cantos em TODAS as câmeras
     (ajuste não linear robusto — "bundle adjustment" só da pose do objeto).
"""
from __future__ import annotations

import cv2
import numpy as np
from scipy.optimize import least_squares
from scipy.spatial.transform import Rotation as Rot

from .common import Scene, Segmenter, Trajectory, main_blob


def make_detector():
    d = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50)
    p = cv2.aruco.DetectorParameters()
    p.cornerRefinementMethod = cv2.aruco.CORNER_REFINE_SUBPIX
    p.cornerRefinementWinSize = 4
    p.adaptiveThreshWinSizeMin, p.adaptiveThreshWinSizeMax, p.adaptiveThreshWinSizeStep = 5, 45, 8
    p.minMarkerPerimeterRate = 0.02
    p.polygonalApproxAccuracyRate = 0.06
    p.perspectiveRemoveIgnoredMarginPerCell = 0.2
    p.errorCorrectionRate = 0.5
    return cv2.aruco.ArucoDetector(d, p)


def detect(detector, frame, roi, valid_ids, upscale=3):
    x0, y0, x1, y1 = roi
    crop = cv2.cvtColor(frame[y0:y1, x0:x1], cv2.COLOR_BGR2GRAY)
    if crop.size == 0:
        return {}
    big = cv2.resize(crop, None, fx=upscale, fy=upscale, interpolation=cv2.INTER_CUBIC)
    corners, ids, _ = detector.detectMarkers(big)
    out = {}
    if ids is not None:
        for c, i in zip(corners, ids.ravel()):
            if int(i) in valid_ids:
                # centro do pixel ampliado -> coordenadas do quadro original
                out[int(i)] = (c.reshape(4, 2) + 0.5) / upscale - 0.5 + np.array([x0, y0])
    return out


def residuals(x, R0, t0, obs):
    R = R0 @ Rot.from_rotvec(x[:3]).as_matrix()
    t = t0 + x[3:]
    res = []
    for cam, body, uv in obs:
        res.append((cam.project(body @ R.T + t) - uv).ravel())
    return np.concatenate(res)


def solve_pose(obs, init):
    best = None
    for R0, t0 in init:
        r = least_squares(residuals, np.zeros(6), args=(R0, t0, obs), loss="huber", f_scale=1.0, x_scale=[0.02] * 3 + [0.02] * 3)
        if best is None or r.cost < best[0]:
            best = (r.cost, R0 @ Rot.from_rotvec(r.x[:3]).as_matrix(), t0 + r.x[3:], r.fun)
    rms = float(np.sqrt(np.mean(best[3] ** 2)))
    return best[1], best[2], rms


def pnp_init(cam, body, uv):
    """Pose corpo->mundo por PnP numa única câmera."""
    ok, rvec, tvec = cv2.solvePnP(body.reshape(-1, 1, 3), uv.reshape(-1, 1, 2), cam.K, cam.dist, flags=cv2.SOLVEPNP_SQPNP)
    if not ok:
        return None
    Rbc, _ = cv2.Rodrigues(rvec)
    return cam.R.T @ Rbc, cam.R.T @ (tvec.ravel() - cam.t)


def run(scene: Scene, videos=None):
    cams = scene.tracking()
    if not cams or not scene.markers:
        return None
    opt = scene.cfg["algorithms"]["aruco"]
    videos = videos or {c.name: scene.video(c.name) for c in cams}
    n = min(len(videos[c.name]) for c in cams)
    times = scene.frames[cams[0].name][:n]
    segs = {c.name: Segmenter(videos[c.name], cam=c) for c in cams}
    body = {m["id"]: np.array(m["corners"], float) for m in scene.markers}
    det = make_detector()

    ts, Rs, ps, quality, detections = [], [], [], [], []
    prev = None
    for k in range(n):
        obs, dets_k = [], {}
        for c in cams:
            m, f, _ = segs[c.name].mask(videos[c.name][k])
            blob = main_blob(m, min_area=80)
            if blob is None:
                dets_k[c.name] = {}
                continue
            x0, y0, x1, y1 = blob["bbox"]
            pad = 30
            roi = (max(x0 - pad, 0), max(y0 - pad, 0), min(x1 + pad, f.shape[1]), min(y1 + pad, f.shape[0]))
            found = detect(det, f, roi, body.keys())
            dets_k[c.name] = {i: uv.tolist() for i, uv in found.items()}
            if found:
                obs.append((c, np.concatenate([body[i] for i in found]), np.concatenate([found[i] for i in found])))
        detections.append(dets_k)
        ncorn = sum(len(o[2]) for o in obs)
        if ncorn < opt["min_corners"]:
            continue
        init = []
        best_obs = max(obs, key=lambda o: len(o[2]))
        p0 = pnp_init(*best_obs)
        if p0 is not None:
            init.append(p0)
        if prev is not None:
            init.append(prev)
        if not init:
            continue
        R, p, rms = solve_pose(obs, init)
        # Rejeita soluções absurdas (ambiguidade planar com poucos cantos).
        if rms > 6.0 or not np.isfinite(p).all():
            continue
        ts.append(times[k]); Rs.append(R); ps.append(p)
        quality.append({"corners": ncorn, "cameras": len(obs), "reproj_rms_px": rms})
        prev = (R, p)

    traj = Trajectory(ts, Rs, ps, quality) if ts else None
    if traj is None:
        return {"trajectory": None, "detections": detections, "times": times, "stats": {"frames": int(n), "frames_with_pose": 0}}
    q = traj.quality
    return {
        "trajectory": traj, "detections": detections, "times": times,
        "stats": {"frames": int(n), "frames_with_pose": int(len(ts)),
                  "mean_corners": float(np.mean([a["corners"] for a in q])), "mean_cameras": float(np.mean([a["cameras"] for a in q])),
                  "reproj_rms_px": float(np.sqrt(np.mean([a["reproj_rms_px"] ** 2 for a in q])))},
    }
