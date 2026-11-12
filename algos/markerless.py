"""Algoritmo 3 — pose 6DoF multi-câmera SEM marcadores (alinhamento de silhueta com o modelo 3D).

Baseline clássico da família "region/contour-based" (RBOT, SRT3D, ICG/M3T): conhecendo a malha
da aeronave e a calibração das câmeras, procura a pose cuja silhueta projetada coincide com a
silhueta observada (segmentação de movimento) em todas as câmeras ao mesmo tempo.

Custo por câmera (ambos em pixels, suaves em relação à pose):
  A) pontos da superfície do modelo projetados devem cair DENTRO da silhueta observada
     (distância com sinal à máscara, recortada em >= 0);
  B) pontos do contorno observado devem estar PERTO de algum ponto projetado do modelo.
A pose é rastreada quadro a quadro (previsão de velocidade constante + refinamento robusto).
"""
from __future__ import annotations

import cv2
import numpy as np
from scipy.optimize import least_squares
from scipy.spatial.transform import Rotation as Rot

from .common import Scene, Segmenter, Trajectory, main_blob, triangulate


def surface_samples(vertices, faces, n=700, seed=0):
    """Pontos na superfície da malha: amostragem por área + vértices extremos."""
    rng = np.random.default_rng(seed)
    a, b, c = vertices[faces[:, 0]], vertices[faces[:, 1]], vertices[faces[:, 2]]
    area = 0.5 * np.linalg.norm(np.cross(b - a, c - a), axis=1)
    # Peso com raiz da área: peças finas (trem, tubo de cauda) não somem da amostragem.
    w = np.sqrt(area + 1e-9)
    idx = rng.choice(len(faces), n, p=w / w.sum())
    u, v = rng.random(n), rng.random(n)
    flip = u + v > 1
    u[flip], v[flip] = 1 - u[flip], 1 - v[flip]
    pts = a[idx] + u[:, None] * (b[idx] - a[idx]) + v[:, None] * (c[idx] - a[idx])
    ext = [vertices[np.argmax(vertices @ d)] for d in np.vstack([np.eye(3), -np.eye(3)])]
    return np.vstack([pts, ext])


def make_sdf(mask):
    out = cv2.distanceTransform(255 - mask, cv2.DIST_L2, 5)
    inn = cv2.distanceTransform(mask, cv2.DIST_L2, 5)
    return (out - inn).astype(np.float32)  # > 0 fora da silhueta


def sample(img, pts):
    h, w = img.shape
    x = np.clip(pts[:, 0], 0, w - 1.001)
    y = np.clip(pts[:, 1], 0, h - 1.001)
    x0, y0 = x.astype(int), y.astype(int)
    fx, fy = x - x0, y - y0
    v = (img[y0, x0] * (1 - fx) + img[y0, x0 + 1] * fx) * (1 - fy) + (img[y0 + 1, x0] * (1 - fx) + img[y0 + 1, x0 + 1] * fx) * fy
    return v + np.hypot(pts[:, 0] - x, pts[:, 1] - y)


def contour_points(mask, m):
    cs, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    pts = np.concatenate([c.reshape(-1, 2) for c in cs if len(c) >= 8] or [np.zeros((0, 2))]).astype(float)
    if len(pts) == 0:
        return pts
    return pts[np.linspace(0, len(pts) - 1, m).astype(int)]


def observe(cam, frame, seg, near, pad=70):
    blob = main_blob(seg.mask(frame)[0], min_area=150, near=near)
    if blob is None:
        return None
    x0, y0, x1, y1 = blob["bbox"]
    H, W = frame.shape[:2]
    touches = x0 <= 2 or y0 <= 2 or x1 >= W - 2 or y1 >= H - 2
    rx0, ry0, rx1, ry1 = max(x0 - pad, 0), max(y0 - pad, 0), min(x1 + pad, W), min(y1 + pad, H)
    roi = blob["mask"][ry0:ry1, rx0:rx1]
    return {"cam": cam, "origin": np.array([rx0, ry0], float), "sdf": make_sdf(roi), "centroid": blob["centroid"],
            "bbox": blob["bbox"], "touches": touches, "mask": blob["mask"]}


def residuals(x, R0, t0, obs, samples):
    R = R0 @ Rot.from_rotvec(x[:3]).as_matrix()
    world = samples @ R.T + (t0 + x[3:])
    res = []
    for o in obs:
        uv = o["cam"].project(world)
        a = np.maximum(sample(o["sdf"], uv - o["origin"]), 0.0)                   # modelo dentro do observado
        d = np.linalg.norm(o["contour"][:, None, :] - uv[None, :, :], axis=2)     # observado coberto pelo modelo
        res.append(a * o["wa"])
        res.append(d.min(axis=1) * o["wb"])
    return np.concatenate(res)


def refine(R0, t0, obs, samples, max_nfev):
    r = least_squares(residuals, np.zeros(6), args=(R0, t0, obs, samples), loss="soft_l1", f_scale=2.0,
                      x_scale=[0.02] * 3 + [0.02] * 3, diff_step=2e-3, max_nfev=max_nfev, xtol=1e-4, ftol=1e-5)
    res = residuals(r.x, R0, t0, obs, samples)
    return R0 @ Rot.from_rotvec(r.x[:3]).as_matrix(), t0 + r.x[3:], float(np.median(np.abs(res))), float(r.cost)


def run(scene: Scene, videos=None):
    cams = scene.tracking()
    if len(cams) < 2:
        return None
    opt = scene.cfg["algorithms"]["markerless"]
    videos = videos or {c.name: scene.video(c.name) for c in cams}
    n = min(len(videos[c.name]) for c in cams)
    times = scene.frames[cams[0].name][:n]
    segs = {c.name: Segmenter(videos[c.name], opt["diff_threshold"], cam=c) for c in cams}
    samples = surface_samples(scene.vertices, scene.faces)
    M = opt["contour_points"]

    ts, Rs, ps, quality, masks = [], [], [], [], []
    prev, prev2 = None, None
    near = {c.name: None for c in cams}
    for k in range(n):
        obs = []
        mk = {}
        for c in cams:
            o = observe(c, videos[c.name][k], segs[c.name], near[c.name])
            if o is None:
                continue
            near[c.name] = o["centroid"]
            mk[c.name] = o["bbox"]
            if o["touches"]:
                continue
            o["contour"] = contour_points(o["mask"], M)
            if len(o["contour"]) == 0:
                continue
            # Normaliza para que cada termo de cada câmera pese igual, independente do nº de pontos.
            o["wa"] = 1.0 / np.sqrt(len(samples))
            o["wb"] = 1.0 / np.sqrt(M)
            del o["mask"]
            obs.append(o)
        masks.append(mk)
        if len(obs) < 2:
            prev, prev2 = None, None
            continue

        if prev is not None:
            Rp, pp, tp = prev
            if prev2 is not None:  # previsão de velocidade constante
                dt, dt0 = times[k] - tp, tp - prev2[2]
                f = dt / dt0 if dt0 > 0 else 0.0
                p_init = pp + (pp - prev2[1]) * f
                R_init = Rp @ Rot.from_rotvec((Rot.from_matrix(prev2[0].T @ Rp)).as_rotvec() * f).as_matrix()
            else:
                R_init, p_init = Rp, pp
            hyps = [(R_init, p_init)]
        else:
            # Inicialização: triangula os centroides; hipóteses de arfagem com a proa ao longo da pista.
            c0 = triangulate([o["cam"] for o in obs], [o["centroid"] for o in obs])
            hyps = [(Rot.from_euler("ZYX", [0, -pitch, 0], degrees=True).as_matrix(), c0) for pitch in (0, 7, 14)]

        best = None
        for R0, p0 in hyps:
            R, p, med, cost = refine(R0, p0, obs, samples, opt["max_nfev"] * (1 if prev is not None else 2))
            if best is None or cost < best[3]:
                best = (R, p, med, cost)
        R, p, med, cost = best
        if med > 6.0 or not np.isfinite(p).all():
            prev, prev2 = None, None
            continue
        ts.append(times[k]); Rs.append(R); ps.append(p)
        quality.append({"cameras": len(obs), "median_residual_px": med})
        prev2, prev = prev, (R, p, times[k])

    if not ts:
        return {"trajectory": None, "times": times, "masks": masks, "stats": {"frames": int(n), "frames_with_pose": 0}}
    traj = Trajectory(ts, Rs, ps, quality)
    return {"trajectory": traj, "times": times, "masks": masks,
            "stats": {"frames": int(n), "frames_with_pose": int(len(ts)),
                      "mean_cameras": float(np.mean([q["cameras"] for q in traj.quality])),
                      "median_residual_px": float(np.median([q["median_residual_px"] for q in traj.quality]))}}
