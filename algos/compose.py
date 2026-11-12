"""Monta o vídeo final: chase 3D + todas as câmeras + overlays dos algoritmos + painel de resultados."""
from __future__ import annotations

import json
import os
import pickle
import subprocess

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont
from scipy.spatial.transform import Rotation as Rot

from .common import Scene, read_video

GREEN, MAGENTA, CYAN, RED, YELLOW, WHITE, GREY = (110, 230, 60), (255, 70, 235), (255, 220, 40), (60, 60, 255), (40, 220, 255), (255, 255, 255), (170, 170, 170)
COL = {"aruco": GREEN, "markerless": MAGENTA, "linecam_band": CYAN, "linecam_column": (255, 170, 90)}
SHORT = {"linecam_band": "Câmera de linha · banda", "linecam_column": "Câmera de linha · coluna", "aruco": "3 câmeras + ArUco", "markerless": "3 câmeras sem marcador"}


def _font(size, bold=False):
    for p in (f"/usr/share/fonts/opentype/inter/Inter-{'SemiBold' if bold else 'Regular'}.otf",
              f"/usr/share/fonts/truetype/dejavu/DejaVuSans{'-Bold' if bold else ''}.ttf"):
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


_FONTS = {}


def text(img, items):
    """items: [(x, y, texto, tamanho, cor BGR, negrito, âncora)] desenhados com fonte TrueType (acentos ok)."""
    pil = Image.fromarray(img)
    d = ImageDraw.Draw(pil)
    for x, y, s, size, col, bold, anchor in items:
        f = _FONTS.setdefault((size, bold), _font(size, bold))
        d.text((x + 1, y + 1), s, font=f, fill=(0, 0, 0), anchor=anchor)
        d.text((x, y), s, font=f, fill=tuple(col), anchor=anchor)
    img[:] = np.asarray(pil)


def T(x, y, s, size=16, col=WHITE, bold=False, anchor="la"):
    return (x, y, s, size, col, bold, anchor)


def timeline(scene, gt, results):
    """Tempo de simulação para cada quadro do vídeo final: tempo real -> câmera lenta na janela das câmeras."""
    out = scene.cfg["output"]
    fps, slow = out["fps"], out["slowmo_factor"]
    w0 = min(v[0] for v in scene.frames.values())
    w1 = max(v[-1] for v in scene.frames.values())
    t_start = max(0.0, w0 - out.get("lead_in_s", 3.5))
    times = list(np.arange(t_start, w0, 1 / fps)) + list(np.arange(w0, w1, slow / fps))
    return {"fps": fps, "times": [float(t) for t in times], "hold": int(out["hold_end_s"] * fps), "slow_from": float(w0)}


def ghosts(results):
    g = []
    for name, col in (("aruco", "#3ce66e"), ("markerless", "#eb46ff")):
        a = results["algorithms"].get(name)
        if a and a.get("poses"):
            g.append({"name": name, "color": col, "poses": a["poses"]})
    return g


class Outline:
    """Contorno da silhueta do modelo projetada numa câmera, para uma pose."""

    def __init__(self, scene):
        self.v, self.f = scene.vertices, scene.faces

    def draw(self, img, cam, R, p, color, thick=1):
        uv = cam.project(self.v @ R.T + p)
        lo, hi = np.floor(uv.min(0)).astype(int) - 2, np.ceil(uv.max(0)).astype(int) + 2
        if (hi - lo).max() > 4000 or (hi - lo).min() <= 0:
            return
        m = np.zeros((hi[1] - lo[1], hi[0] - lo[0]), np.uint8)
        cv2.fillPoly(m, np.round((uv - lo)[self.f] * 8).astype(np.int32), 255, shift=3)
        cs, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
        cv2.drawContours(img, cs, -1, color, thick, offset=(int(lo[0]), int(lo[1])))


def pose_lookup(poses):
    if not poses:
        return lambda t: None
    ts = np.array([p["t"] for p in poses])
    P = np.array([p["p"] for p in poses])
    R = Rot.from_quat(np.array([p["q"] for p in poses])).as_matrix()
    dt = np.median(np.diff(ts)) if len(ts) > 1 else 1.0

    def at(t):
        i = int(np.argmin(np.abs(ts - t)))
        return (R[i], P[i]) if abs(ts[i] - t) < 0.6 * dt else None

    return at


def side_plot(w, h, scene, gt, results, t_now):
    """Vista lateral (x-z) perto do obstáculo: ponto mais baixo da aeronave ao longo de x."""
    img = np.full((h, w, 3), 24, np.uint8)
    x0, x1, z0, z1 = scene.x_obs - 7.0, scene.x_obs + 3.0, 0.0, 2.6
    X = lambda x: int(40 + (x - x0) / (x1 - x0) * (w - 56))
    Z = lambda z: int(h - 26 - (z - z0) / (z1 - z0) * (h - 44))
    for z in np.arange(0, z1, 0.5):
        cv2.line(img, (X(x0), Z(z)), (X(x1), Z(z)), (52, 52, 52), 1)
    cv2.line(img, (X(x0), Z(0)), (X(x1), Z(0)), (120, 120, 120), 2)
    cv2.line(img, (X(scene.x_obs), Z(0)), (X(scene.x_obs), Z(scene.h_obs)), (40, 120, 255), 3)
    cv2.circle(img, (X(scene.x_obs), Z(scene.h_obs)), 5, RED, -1)
    low_v = scene.vertices[np.argsort(scene.vertices[:, 2])[:40]]  # vértices mais baixos (rodas)

    def curve(poses, col, thick):
        pts = []
        for s in poses:
            if s["t"] > t_now:
                break
            w_ = low_v @ Rot.from_quat(s["q"]).as_matrix().T + np.array(s["p"])
            k = np.argmin(w_[:, 2])
            if x0 <= w_[k, 0] <= x1:
                pts.append((X(w_[k, 0]), Z(w_[k, 2])))
        if len(pts) > 1:
            cv2.polylines(img, [np.array(pts, np.int32)], False, col, thick, cv2.LINE_AA)

    curve(gt["poses"][::5], WHITE, 2)
    for name in ("aruco", "markerless"):
        a = results["algorithms"].get(name)
        if a and a.get("poses"):
            curve(a["poses"], COL[name], 1)
    lc = results["algorithms"].get("linecam_band")
    if lc and lc.get("lowest_z_m") is not None and t_now >= lc["t_cross"]:
        cv2.drawMarker(img, (X(scene.x_obs), Z(lc["lowest_z_m"])), COL["linecam_band"], cv2.MARKER_TILTED_CROSS, 12, 2)
    text(img, [T(8, 4, "Vista lateral · ponto mais baixo da aeronave (m)", 13, GREY), T(X(scene.x_obs) + 8, Z(scene.h_obs) - 8, f"obstáculo {scene.h_obs:.2f} m", 12, (120, 170, 255)),
               *[T(6, Z(z) - 7, f"{z:.1f}", 11, GREY) for z in (0.5, 1.0, 1.5, 2.0)]])
    return img


def compose(run_dir, log=print):
    scene = Scene(run_dir)
    gt = json.load(open(os.path.join(run_dir, "ground_truth.json")))
    results = json.load(open(os.path.join(run_dir, "results.json")))
    viz = pickle.load(open(os.path.join(run_dir, "viz.pkl"), "rb"))
    tl = json.load(open(os.path.join(run_dir, "timeline.json")))
    W, H = scene.cfg["output"]["resolution"]
    sx, sy = W / 1920, H / 1080
    chase = read_video(os.path.join(run_dir, "chase.mp4"))
    vids = {n: read_video(os.path.join(run_dir, f"{n}.mp4")) for n in scene.cams}
    outline = Outline(scene)
    est = {n: pose_lookup(results["algorithms"].get(n, {}).get("poses")) for n in ("aruco", "markerless")}
    lc = viz.get("linecam")
    lcr = results["algorithms"].get("linecam_band")
    tcross = gt["clearance_t"]
    track = [c.name for c in scene.tracking()]
    line = scene.line()
    cache = {}

    def cam_state(name, t):
        ts = scene.frames[name]
        if t < ts[0]:
            return 0, "aguardando gatilho"
        if t > ts[-1] + 1 / scene.cams[name].fps:
            return len(vids[name]) - 1, "fim da gravação"
        return min(int(np.searchsorted(ts, t, side="right")) - 1, len(vids[name]) - 1), None

    def track_panel(name, i, pw, ph):
        key = (name, i)
        if key in cache:
            return cache[key]
        cam = scene.cams[name]
        f = vids[name][i].copy()
        t = scene.frames[name][i]
        centre = None
        for alg in ("markerless", "aruco"):
            pose = est[alg](t)
            if pose is not None:
                outline.draw(f, cam, pose[0], pose[1], COL[alg], 2 if alg == "aruco" else 1)
                centre = cam.project(pose[1][None])[0]
        dets = viz.get("aruco", {}).get("detections")
        if dets and i < len(dets):
            for corners in dets[i].get(name, {}).values():
                cv2.polylines(f, [np.round(np.array(corners)).astype(np.int32)], True, YELLOW, 1, cv2.LINE_AA)
        if centre is None:
            bb = viz.get("markerless", {}).get("masks")
            if bb and i < len(bb) and name in bb[i]:
                b = bb[i][name]
                centre = np.array([(b[0] + b[2]) / 2, (b[1] + b[3]) / 2])
        panel = cv2.resize(f, (pw, ph), interpolation=cv2.INTER_AREA)
        if centre is not None:
            cw, chh = int(cam.width * 0.2), int(cam.height * 0.2)
            cx = int(np.clip(centre[0] - cw / 2, 0, cam.width - cw)); cy = int(np.clip(centre[1] - chh / 2, 0, cam.height - chh))
            iw, ih = int(pw * 0.42), int(ph * 0.42)
            inset = cv2.resize(f[cy:cy + chh, cx:cx + cw], (iw, ih), interpolation=cv2.INTER_CUBIC)
            panel[ph - ih - 6:ph - 6, pw - iw - 6:pw - 6] = inset
            cv2.rectangle(panel, (pw - iw - 6, ph - ih - 6), (pw - 6, ph - 6), WHITE, 1)
            k = pw / cam.width
            cv2.rectangle(panel, (int(cx * k), int(cy * k)), (int((cx + cw) * k), int((cy + chh) * k)), WHITE, 1)
        cache[key] = panel
        return panel

    def line_panel(i, pw, ph):
        key = ("line", i)
        if key in cache:
            return cache[key]
        f = vids[line.name][i].copy()
        if lc is not None:
            (u0, v0), (u1, v1) = lc["slit_uv"]
            cv2.line(f, (int(u0), int(v0)), (int(u1), int(v1)), CYAN, 1, cv2.LINE_AA)
            bx, by = lc["bar_px"]
            cv2.drawMarker(f, (int(round(bx)), int(round(by))), RED, cv2.MARKER_CROSS, 40, 2)
            cv2.circle(f, (int(round(bx)), int(round(by))), 9, RED, 2, cv2.LINE_AA)
            low = lcr.get("lowest_per_frame") if lcr else None
            if low and i < len(low) and low[i] is not None:
                uv = line.project(np.array([[scene.x_obs, scene.cfg["algorithms"]["linecam"]["assumed_y_m"], low[i]]]))[0]
                cv2.line(f, (int(uv[0]) - 26, int(uv[1])), (int(uv[0]) + 26, int(uv[1])), YELLOW, 2)
        panel = cv2.resize(f, (pw, ph), interpolation=cv2.INTER_AREA)
        if lc is not None:
            # Slit-scan (tempo -> x, altura -> y) revelado até o quadro atual.
            S = lc["S_band"][: i + 1]
            z = lc["z"]
            zmax = min(2.2, z[-1])
            sel = z <= zmax
            iw, ih = int(pw * 0.34), int(ph * 0.62)
            img = np.zeros((sel.sum(), len(lc["S_band"]), 3), np.uint8) + 30
            img[:, : len(S)][S[:, sel].T > 0] = (235, 235, 235)
            img = cv2.resize(img[::-1], (iw, ih), interpolation=cv2.INTER_AREA)
            yb = int(ih * (1 - scene.h_obs / zmax))
            cv2.line(img, (0, yb), (iw, yb), RED, 1)
            panel[8:8 + ih, pw - iw - 8:pw - 8] = img
            cv2.rectangle(panel, (pw - iw - 8, 8), (pw - 8, 8 + ih), WHITE, 1)
            text(panel, [T(pw - iw - 4, 10, "slit-scan (tempo → · altura ↑)", 11, GREY)])
        cache[key] = panel
        return panel

    def results_panel(pw, ph, t, final):
        img = np.full((ph, pw, 3), 18, np.uint8)
        items = [T(14, 10, "RESULTADO", 20, WHITE, True)]
        show = final or t > tcross + 0.12
        y = 44
        g = results["ground_truth"]
        rows = [("VERDADE (simulação)", g["verdict"], g["clearance_m"], None, WHITE)]
        for name in ("linecam_band", "linecam_column", "aruco", "markerless"):
            a = results["algorithms"].get(name)
            if a:
                rows.append((SHORT[name], a.get("verdict"), a.get("clearance_m"), a.get("clearance_error_m"), COL[name]))
        for label, verdict, c, err, col in rows:
            cv2.rectangle(img, (14, y + 5), (22, y + 17), col, -1)
            items.append(T(30, y, label, 16, WHITE))
            if show:
                ok = verdict == "PASS"
                vtxt = {"PASS": "VÁLIDA", "FAIL": "INVÁLIDA"}.get(verdict, "sem dados")
                items.append(T(pw * 0.50, y, vtxt, 16, GREEN if ok else (RED if verdict == "FAIL" else GREY), True))
                if c is not None:
                    items.append(T(pw * 0.80, y, f"{c * 100:+.1f} cm", 16, WHITE, False, "ra"))
                if err is not None:
                    items.append(T(pw - 12, y, f"erro {err * 1000:+.0f} mm", 13, YELLOW if abs(err) < 0.02 else (90, 150, 255), False, "ra"))
            else:
                items.append(T(pw * 0.50, y, "analisando…", 15, GREY))
            y += 26
        items.append(T(pw * 0.80, 30, "folga", 11, GREY, False, "ra"))
        plot = side_plot(pw - 16, ph - y - 10, scene, gt, results, t if not final else 1e9)
        img[y + 4:y + 4 + plot.shape[0], 8:8 + plot.shape[1]] = plot
        text(img, items)
        return img

    Wc, Hc = int(1280 * sx), int(720 * sy)
    pw, ph = W - Wc, H // 3
    lw = Wc // 2
    out_path = os.path.join(run_dir, "final.mp4")
    ff = subprocess.Popen(["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{W}x{H}", "-r", str(tl["fps"]), "-i", "-",
                           "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out_path], stdin=subprocess.PIPE)
    n = len(tl["times"])
    gtp = gt["poses"]
    gtt = np.array([s["t"] for s in gtp])
    run = gt["run"]
    runt = np.array([s["t"] for s in run])
    frame = None
    for k in range(n + tl["hold"]):
        final = k >= n
        t = tl["times"][min(k, n - 1)]
        frame = np.zeros((H, W, 3), np.uint8)
        frame[:Hc, :Wc] = cv2.resize(chase[min(k, len(chase) - 1)], (Wc, Hc))
        items = []
        V = run[int(np.argmin(np.abs(runt - t)))]
        slow = t >= tl["slow_from"]
        items += [T(18, 14, "AeroDesign · validação automática de decolagem", 22, WHITE, True),
                  T(18, 44, f"t = {t:6.3f} s   x = {V['x']:5.1f} m   V solo = {V['V']:4.1f} m/s   altura CG = {V['z']:4.2f} m", 16, WHITE),
                  T(18, Hc - 30, "réplica 3D:  ■ ArUco", 14, GREEN), T(170, Hc - 30, "■ sem marcador", 14, MAGENTA)]
        if slow:
            items.append(T(Wc - 18, 14, f"CÂMERA LENTA {scene.cfg['output']['slowmo_factor']:.2f}×", 18, YELLOW, True, "ra"))
        if final or t > tcross + 0.12:
            ok = gt["verdict"] == "PASS"
            cv2.rectangle(frame, (Wc // 2 - 250, 78), (Wc // 2 + 250, 132), (30, 110, 30) if ok else (30, 30, 150), -1)
            items.append(T(Wc // 2, 105, f"VERDADE: DECOLAGEM {'VÁLIDA' if ok else 'INVÁLIDA'}  ({gt['clearance_m'] * 100:+.1f} cm)", 22, WHITE, True, "mm"))
        for j, name in enumerate(track[:3]):
            i, st = cam_state(name, t)
            p = track_panel(name, i, pw, ph).copy()
            if st:
                p = (p * 0.45).astype(np.uint8)
                items.append(T(Wc + pw // 2, j * ph + ph // 2, st, 18, WHITE, True, "mm"))
            frame[j * ph:(j + 1) * ph, Wc:] = p
            c = scene.cams[name]
            items.append(T(Wc + 10, j * ph + 8, f"{name}  ·  {c.width}×{c.height} @ {c.fps:g} fps  ·  quadro {i + 1}/{len(vids[name])}", 14, WHITE, True))
        if line is not None:
            i, st = cam_state(line.name, t)
            p = line_panel(i, lw, H - Hc).copy()
            if st:
                p = (p * 0.45).astype(np.uint8)
                items.append(T(lw // 2, Hc + (H - Hc) // 2, st, 18, WHITE, True, "mm"))
            frame[Hc:, :lw] = p
            items.append(T(10, Hc + 8, f"{line.name}  ·  {line.width}×{line.height} @ {line.fps:g} fps  ·  quadro {i + 1}/{len(vids[line.name])}", 14, WHITE, True))
        frame[Hc:, lw:Wc] = results_panel(Wc - lw, H - Hc, t, final)
        cv2.line(frame, (Wc, 0), (Wc, H), (0, 0, 0), 2); cv2.line(frame, (0, Hc), (Wc, Hc), (0, 0, 0), 2); cv2.line(frame, (lw, Hc), (lw, H), (0, 0, 0), 2)
        text(frame, items)
        ff.stdin.write(frame.tobytes())
        # limita o cache de painéis
        if len(cache) > 400:
            cache.clear()
    ff.stdin.close()
    ff.wait()
    if frame is not None:
        cv2.imwrite(os.path.join(run_dir, "final_poster.jpg"), frame)
    log(f"  vídeo final: {out_path}")
    return out_path
