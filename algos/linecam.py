"""Algoritmo 1 — câmera de linha (photo-finish).

Câmera rápida na altura da faixa, olhando ao longo dela. O plano do obstáculo vira (quase)
uma coluna da imagem e a faixa vira (quase) um ponto. Para cada quadro amostramos a máscara
de movimento ao longo dessa coluna e montamos uma imagem "slit-scan" (tempo x altura).
A folga é a altura do ponto mais baixo da aeronave nessa imagem menos a altura da faixa.

Dois modos são calculados:
  * coluna: só a coluna do plano (o photo-finish clássico; sub-amostra a aeronave em x);
  * banda:  a coluna alargada pelo deslocamento da aeronave entre quadros, de modo que
            nenhuma fatia da aeronave fique sem ser vista (compensa FPS limitado).
"""
from __future__ import annotations

import cv2
import numpy as np

from .common import Scene, Segmenter, main_blob


def run(scene: Scene, frames=None):
    cam = scene.line()
    if cam is None:
        return None
    opt = scene.cfg["algorithms"]["linecam"]
    frames = frames if frames is not None else scene.video(cam.name)
    times = scene.frames[cam.name][: len(frames)]
    seg = Segmenter(frames, opt["diff_threshold"], opt["shadow_suppression"], opt.get("stabilize", True), cam=cam)
    H, W = frames[0].shape[:2]

    # Amostras de altura ao longo do plano do obstáculo, na profundidade assumida (eixo da pista).
    z = np.arange(0.0, 3.2, 0.002)
    pts = np.c_[np.full_like(z, scene.x_obs), np.full_like(z, opt["assumed_y_m"]), z]
    uv = cam.project(pts)
    inside = (uv[:, 0] >= 0) & (uv[:, 0] < W - 1) & (uv[:, 1] >= 0) & (uv[:, 1] < H - 1)
    ui, vi = np.round(uv[inside, 0]).astype(int), np.round(uv[inside, 1]).astype(int)
    zin = z[inside]
    bar_px = cam.project(np.array([[scene.x_obs, opt["assumed_y_m"], scene.h_obs]]))[0]
    masks, cents, shifts = [], [], []
    for f in frames:
        m, _, sh = seg.mask(f)
        # Só o corpo principal em movimento conta como aeronave (descarta ruído e restos de sombra isolados).
        blob = main_blob(m, min_area=200, merge_px=45, min_part=40)
        masks.append(blob["mask"] if blob else np.zeros_like(m))
        cents.append(blob["centroid"][0] if blob else np.nan)
        shifts.append(sh)
    cents = np.array(cents)

    # Velocidade na imagem (px/quadro), pela mediana do deslocamento do centroide.
    d = np.diff(cents)
    d = d[np.isfinite(d)]
    px_per_frame = float(np.median(np.abs(d))) if len(d) else 0.0
    half = int(np.ceil(px_per_frame / 2)) + 1

    def slit_scan(band):
        S = np.zeros((len(frames), len(zin)), np.uint8)
        k = np.ones((1, 2 * half + 1), np.uint8)
        for i, m in enumerate(masks):
            mm = cv2.dilate(m, k) if band else m
            S[i] = mm[vi, ui]
        # Remove ciscos (bordas do fundo que piscam com a vibração): exige um trecho contínuo de altura mínima.
        n = max(3, int(round(opt.get("min_run_m", 0.016) / 0.002)))
        S = cv2.morphologyEx(S, cv2.MORPH_OPEN, np.ones((1, n), np.uint8))
        # No slit-scan (tempo x altura), descarta componentes pequenos demais para serem uma peça da aeronave.
        k, lab, stats, _ = cv2.connectedComponentsWithStats(S, 8)
        small = [j for j in range(1, k) if stats[j, cv2.CC_STAT_WIDTH] < 2 * n or stats[j, cv2.CC_STAT_AREA] < 3 * n]
        S[np.isin(lab, small)] = 0
        return S

    def analyse(S):
        rows = np.nonzero(S.any(axis=1))[0]
        if len(rows) == 0:
            return {"verdict": "SEM_DADOS", "clearance_m": None}
        lowest = np.array([zin[np.nonzero(S[i])[0][0]] if S[i].any() else np.nan for i in range(len(S))])
        i = int(np.nanargmin(lowest))
        zl = float(lowest[i])
        hit = bool(S[:, np.argmin(np.abs(zin - scene.h_obs))].any())
        return {"verdict": "PASS" if zl > scene.h_obs else "FAIL", "clearance_m": zl - scene.h_obs, "t_cross": float(times[i]),
                "frame": i, "lowest_z_m": zl, "covers_bar_point": hit,
                "frames_with_aircraft": int(len(rows)), "lowest_per_frame": [None if np.isnan(v) else float(v) for v in lowest]}

    S_col, S_band = slit_scan(False), slit_scan(True)
    res_col, res_band = analyse(S_col), analyse(S_band)
    mm_per_px = float(np.median(np.abs(np.diff(zin)) / np.maximum(np.hypot(np.diff(uv[inside, 0]), np.diff(uv[inside, 1])), 1e-6)) * 1000)
    depth = float(cam.depth(np.array([[scene.x_obs, opt["assumed_y_m"], scene.h_obs]]))[0])
    return {
        "camera": cam.name, "column": res_col, "band": res_band, "primary": "band",
        "px_per_frame": px_per_frame, "band_half_px": half, "mm_per_px": mm_per_px,
        "mm_between_frames": px_per_frame * mm_per_px, "shift_rms_px": float(np.sqrt(np.mean(np.square(shifts)))),
        "viz": {"slit_uv": [uv[inside][0].tolist(), uv[inside][-1].tolist()], "bar_px": bar_px.tolist(), "depth_m": depth,
                "z": zin, "S_col": S_col, "S_band": S_band},
    }
