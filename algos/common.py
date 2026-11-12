"""Blocos comuns aos algoritmos: câmeras, vídeo, segmentação de movimento, trajetória e decisão.

Os algoritmos só enxergam `scene.json` (calibração *acreditada*, malha da aeronave,
geometria do obstáculo) e os vídeos. `ground_truth.json` é usado apenas na avaliação.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass

import cv2
import numpy as np
from scipy.optimize import least_squares
from scipy.spatial.transform import Rotation as Rot, Slerp


# ----------------------------------------------------------------------------- câmera
@dataclass
class Camera:
    name: str
    role: str
    width: int
    height: int
    fps: float
    K: np.ndarray
    dist: np.ndarray
    R: np.ndarray  # mundo -> câmera
    t: np.ndarray

    @classmethod
    def from_dict(cls, d):
        return cls(d["name"], d.get("role", "tracking"), d.get("width", 0), d.get("height", 0), d.get("fps", 0),
                   np.array(d["K"], float), np.array(d["dist"], float), np.array(d["R"], float), np.array(d["t"], float))

    @property
    def center(self):
        return -self.R.T @ self.t

    def project(self, pts_world):
        """Pontos do mundo (N,3) -> pixels (N,2), com distorção."""
        rvec, _ = cv2.Rodrigues(self.R)
        uv, _ = cv2.projectPoints(np.asarray(pts_world, float).reshape(-1, 1, 3), rvec, self.t, self.K, self.dist)
        return uv.reshape(-1, 2)

    def depth(self, pts_world):
        return (np.asarray(pts_world) @ self.R.T + self.t)[:, 2]

    def rays(self, uv):
        """Pixels (N,2) -> direções unitárias no mundo (N,3), removendo a distorção."""
        n = cv2.undistortPoints(np.asarray(uv, float).reshape(-1, 1, 2), self.K, self.dist).reshape(-1, 2)
        d = np.c_[n, np.ones(len(n))] @ self.R  # R^T aplicado a vetores-linha
        return d / np.linalg.norm(d, axis=1, keepdims=True)


class Scene:
    def __init__(self, run_dir):
        self.dir = run_dir
        with open(os.path.join(run_dir, "scene.json")) as f:
            d = json.load(f)
        self.world = d["world"]
        self.cams = {c["name"]: Camera.from_dict(c) for c in d["calibration"]}
        self.frames = {k: np.array(v) for k, v in d["frames"].items()}
        self.vertices = np.array(d["aircraft"]["vertices"], float).reshape(-1, 3)
        self.faces = np.array(d["aircraft"]["faces"], int).reshape(-1, 3)
        # pontos usados no cálculo de folga (os mesmos da verdade); a malha completa serve às silhuetas
        self.collision = np.array(d["aircraft"].get("collision_points", d["aircraft"]["vertices"]), float).reshape(-1, 3)
        self.markers = d["aircraft"]["markers"]
        self.x_obs = self.world["obstacle_x_m"]
        self.h_obs = self.world["obstacle_height_m"]
        with open(os.path.join(run_dir, "config.resolved.json")) as f:
            self.cfg = json.load(f)

    def tracking(self):
        return [c for c in self.cams.values() if c.role == "tracking"]

    def line(self):
        return next((c for c in self.cams.values() if c.role == "line"), None)

    def video(self, name):
        return read_video(os.path.join(self.dir, f"{name}.mp4"))


def read_video(path):
    cap = cv2.VideoCapture(path)
    frames = []
    while True:
        ok, f = cap.read()
        if not ok:
            break
        frames.append(f)
    cap.release()
    if not frames:
        raise RuntimeError(f"vídeo vazio ou ilegível: {path}")
    return frames


# ----------------------------------------------------------------------------- segmentação
def background(frames, n=31):
    idx = np.linspace(0, len(frames) - 1, min(n, len(frames))).astype(int)
    return np.median(np.stack([frames[i] for i in idx]), axis=0).astype(np.float32)


class Segmenter:
    """Segmentação de movimento contra o fundo (mediana temporal), robusta a vibração da câmera:
    cada quadro é registrado ao fundo (translação sub-pixel por correlação de fase) e o limiar
    cresce onde o fundo tem bordas fortes. Sombras projetadas (mais escuras, mesma cor) são removidas."""

    def __init__(self, frames, thr=0.07, shadows=True, stabilize=True, edge_gain=1.2, cam=None, shadow_range_m=60.0):
        self.bg = background(frames)
        self.thr, self.shadows, self.stabilize = thr, shadows, stabilize
        # Sombra só pode cair no chão próximo: acima do horizonte (ou muito longe) nada é tratado como sombra.
        self.shadow_region = None
        if cam is not None and shadows:
            h, w = self.bg.shape[:2]
            gx, gy = np.meshgrid(np.arange(0, w, 8) + 4.0, np.arange(0, h, 8) + 4.0)
            d = cam.rays(np.c_[gx.ravel(), gy.ravel()])
            c = cam.center
            s_hit = np.where(d[:, 2] < -1e-6, -c[2] / np.minimum(d[:, 2], -1e-6), np.inf)
            near = (s_hit < shadow_range_m).reshape(gx.shape).astype(np.uint8)
            self.shadow_region = cv2.resize(near, (w, h), interpolation=cv2.INTER_NEAREST).astype(bool)
        g = cv2.cvtColor(self.bg.astype(np.uint8), cv2.COLOR_BGR2GRAY).astype(np.float32)
        self.bg_gray = g
        self.win = cv2.createHanningWindow((g.shape[1], g.shape[0]), cv2.CV_32F)
        gx, gy = cv2.Sobel(g, cv2.CV_32F, 1, 0, ksize=3) / 8, cv2.Sobel(g, cv2.CV_32F, 0, 1, ksize=3) / 8
        self.edge = cv2.dilate(np.hypot(gx, gy) / 255.0, np.ones((3, 3), np.uint8)) * edge_gain

    def register(self, frame):
        """Devolve o quadro alinhado ao fundo e o deslocamento estimado (px)."""
        if not self.stabilize:
            return frame, (0.0, 0.0)
        g = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY).astype(np.float32)
        # O objeto em movimento enviesa a correlação: onde o quadro difere muito do fundo, usa o próprio fundo.
        # (Só regiões grandes: as bordas finas que "piscam" com a vibração são justamente o sinal a medir.)
        rough = cv2.morphologyEx((np.abs(g - self.bg_gray) > 30).astype(np.uint8), cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
        moving = cv2.dilate(rough, np.ones((31, 31), np.uint8)).astype(bool)
        g[moving] = self.bg_gray[moving]
        # (cópias: o phaseCorrelate pode alterar os buffers de entrada)
        (dx, dy), _ = cv2.phaseCorrelate(self.bg_gray.copy(), g, self.win.copy())
        if abs(dx) > 8 or abs(dy) > 8:
            return frame, (0.0, 0.0)
        M = np.float32([[1, 0, -dx], [0, 1, -dy]])
        return cv2.warpAffine(frame, M, (frame.shape[1], frame.shape[0]), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE), (dx, dy)

    def mask(self, frame):
        frame, shift = self.register(frame)
        f = frame.astype(np.float32)
        diff = np.abs(f - self.bg).max(axis=2) / 255.0
        mask = diff > (self.thr + self.edge)
        if self.shadows:
            ratio = (f + 4.0) / (self.bg + 4.0)
            rmin, rmax = ratio.min(axis=2), ratio.max(axis=2)
            # Tolerância de cor maior onde o fundo é escuro (ruído/compressão dominam a razão).
            tol = 0.14 + 10.0 / (self.bg.mean(axis=2) + 8.0)
            shadow = (rmax < 0.97) & (rmin > 0.08) & ((rmax - rmin) < tol)
            if self.shadow_region is not None:
                shadow &= self.shadow_region
            mask &= ~shadow
        m = cv2.morphologyEx(mask.astype(np.uint8) * 255, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
        return m, frame, shift


def main_blob(mask, min_area=60, near=None, merge_px=40, min_part=20):
    """Mantém o maior componente (ou o mais próximo de `near`) e os componentes vizinhos a ele."""
    n, lab, stats, cent = cv2.connectedComponentsWithStats(mask, 8)
    if n <= 1:
        return None
    areas = stats[1:, cv2.CC_STAT_AREA]
    ok = np.where(areas >= min_area)[0] + 1
    if len(ok) == 0:
        return None
    if near is not None:
        score = areas[ok - 1] / (1.0 + (np.linalg.norm(cent[ok] - near, axis=1) / 80.0) ** 2)
        k = ok[np.argmax(score)]
    else:
        k = ok[np.argmax(areas[ok - 1])]
    x, y, w, h = stats[k, :4]
    merge_px = max(merge_px, 0.6 * max(w, h))  # peças soltas da aeronave (cauda, trem) ficam a até ~meio corpo de distância
    keep = np.zeros(n, bool)
    keep[k] = True
    for j in range(1, n):
        if j == k or stats[j, cv2.CC_STAT_AREA] < min_part:   # ciscos isolados não são peças da aeronave
            continue
        xj, yj, wj, hj = stats[j, :4]
        if xj < x + w + merge_px and xj + wj > x - merge_px and yj < y + h + merge_px and yj + hj > y - merge_px:
            keep[j] = True
    out = (keep[lab]).astype(np.uint8) * 255
    ys, xs = np.nonzero(out)
    return {"mask": out, "bbox": (xs.min(), ys.min(), xs.max() + 1, ys.max() + 1), "centroid": np.array([xs.mean(), ys.mean()]),
            "area": int(len(xs))}


def triangulate(cams, uvs):
    """Ponto 3D que minimiza a distância aos raios das câmeras."""
    A, b = np.zeros((3, 3)), np.zeros(3)
    for c, uv in zip(cams, uvs):
        d = c.rays(np.array([uv]))[0]
        P = np.eye(3) - np.outer(d, d)
        A += P
        b += P @ c.center
    return np.linalg.solve(A, b)


# ----------------------------------------------------------------------------- trajetória / decisão
class Trajectory:
    """Poses (corpo -> mundo) por quadro, com ajuste polinomial local robusto para suavizar e interpolar."""

    def __init__(self, times, rotations: list, positions, quality=None):
        o = np.argsort(times)
        self.t = np.asarray(times, float)[o]
        self.R = Rot.from_matrix(np.stack([rotations[i] for i in o]))
        self.p = np.asarray(positions, float)[o]
        self.quality = None if quality is None else np.asarray(quality)[o]

    def __len__(self):
        return len(self.t)

    def fit(self, t0, half_window, deg_p=2, deg_r=1):
        """Ajusta polinômios em torno de t0. Devolve função t -> (R (3x3), p (3,))."""
        sel = np.abs(self.t - t0) <= half_window
        if sel.sum() < 4:
            sel = np.argsort(np.abs(self.t - t0))[: min(len(self.t), 6)]
        tt, pp, rr = self.t[sel] - t0, self.p[sel], self.R[sel]
        deg_p = min(deg_p, len(tt) - 2)
        deg_r = min(deg_r, len(tt) - 2)
        Rref = rr[len(tt) // 2]
        rv = (Rref.inv() * rr).as_rotvec()

        def robust_poly(y, deg):
            V = np.vander(tt, deg + 1)
            c0 = np.linalg.lstsq(V, y, rcond=None)[0]
            scale = max(1.4826 * np.median(np.abs(V @ c0 - y)), 1e-4)
            return least_squares(lambda c: (V @ c - y) / scale, c0, loss="soft_l1").x

        cp = [robust_poly(pp[:, i], max(deg_p, 0)) for i in range(3)]
        cr = [robust_poly(rv[:, i], max(deg_r, 0)) for i in range(3)]

        def at(t):
            dt = np.atleast_1d(t) - t0
            p = np.stack([np.polyval(c, dt) for c in cp], axis=1)
            r = np.stack([np.polyval(c, dt) for c in cr], axis=1)
            return (Rref * Rot.from_rotvec(r)).as_matrix(), p

        return at

    def interp(self):
        slerp = Slerp(self.t, self.R) if len(self.t) > 1 else None

        def at(t):
            t = np.clip(np.atleast_1d(t), self.t[0], self.t[-1])
            p = np.stack([np.interp(t, self.t, self.p[:, i]) for i in range(3)], axis=1)
            return (slerp(t).as_matrix() if slerp else np.repeat(self.R.as_matrix(), len(t), 0)), p

        return at

    def to_json(self):
        q = self.R.as_quat()
        return [{"t": float(t), "p": p.tolist(), "q": qq.tolist()} for t, p, qq in zip(self.t, self.p, q)]


def clearance(pose_at, t0, t1, vertices, x_obs, h_obs, step=1 / 2000):
    """Menor (z - h_obs) entre os vértices da aeronave no instante em que cada um cruza o plano x = x_obs."""
    ts = np.arange(t0, t1, step)
    R, p = pose_at(ts)
    best = {"clearance_m": None, "t": None, "y_m": None, "vertex": None, "crossed_fraction": 0.0}
    # Processa em blocos de vértices para limitar memória.
    cross_z = np.full(len(vertices), np.nan)
    cross_t = np.full(len(vertices), np.nan)
    cross_y = np.full(len(vertices), np.nan)
    for s in range(0, len(vertices), 512):
        v = vertices[s:s + 512]
        w = np.einsum("tij,vj->tvi", R, v) + p[:, None, :]
        x = w[:, :, 0] - x_obs
        sign = (x[:-1] < 0) & (x[1:] >= 0)
        has = sign.any(axis=0)
        i = sign.argmax(axis=0)
        j = np.arange(len(v))
        f = np.where(has, -x[i, j] / np.where(has, x[i + 1, j] - x[i, j], 1.0), 0.0)
        cross_z[s:s + 512] = np.where(has, w[i, j, 2] + f * (w[i + 1, j, 2] - w[i, j, 2]), np.nan)
        cross_y[s:s + 512] = np.where(has, w[i, j, 1] + f * (w[i + 1, j, 1] - w[i, j, 1]), np.nan)
        cross_t[s:s + 512] = np.where(has, ts[i] + f * step, np.nan)
    ok = ~np.isnan(cross_z)
    best["crossed_fraction"] = float(ok.mean())
    if ok.any():
        k = np.nanargmin(cross_z)
        best.update(clearance_m=float(cross_z[k] - h_obs), t=float(cross_t[k]), y_m=float(cross_y[k]), vertex=int(k))
    return best


def decide(traj: Trajectory, scene: Scene, window_s):
    """Decisão a partir de uma trajetória 3D estimada."""
    if len(traj) < 4:
        return {"verdict": "SEM_DADOS", "clearance_m": None, "note": "poses insuficientes"}
    # Instante aproximado em que a origem do corpo cruza o plano do obstáculo.
    x = traj.p[:, 0]
    after = np.where(x >= scene.x_obs)[0]
    if len(after) and after[0] > 0:
        i = after[0]
        tc = traj.t[i - 1] + (scene.x_obs - x[i - 1]) / (x[i] - x[i - 1]) * (traj.t[i] - traj.t[i - 1])
        extrap = False
    else:
        # Rastreamento terminou antes do cruzamento: extrapola com velocidade constante.
        v = np.polyfit(traj.t[-6:], x[-6:], 1)
        tc = (scene.x_obs - v[1]) / v[0]
        extrap = True
    pose_at = traj.fit(tc, window_s)
    res = clearance(pose_at, tc - 0.25, tc + 0.25, scene.collision, scene.x_obs, scene.h_obs)
    if res["clearance_m"] is None:
        return {"verdict": "SEM_DADOS", "clearance_m": None, "note": "nenhum vértice cruzou o plano"}
    Rc, pc = pose_at(res["t"])
    e = Rot.from_matrix(Rc[0]).as_euler("ZYX", degrees=True)
    return {
        "verdict": "PASS" if res["clearance_m"] > 0 else "FAIL",
        "clearance_m": res["clearance_m"], "t_cross": res["t"], "y_m": res["y_m"], "vertex": res["vertex"],
        "extrapolated": extrap, "frames_used": int((np.abs(traj.t - tc) <= window_s).sum()),
        "attitude_deg": {"yaw": float(e[0]), "pitch": float(-e[1]), "roll": float(e[2])},
        "speed_ms": float(np.linalg.norm((pose_at(res["t"] + 0.01)[1] - pose_at(res["t"] - 0.01)[1])[0]) / 0.02),
    }


def pose_errors(traj: Trajectory, gt):
    """Erro de posição (m) e de orientação (graus) por quadro contra a verdade."""
    gt_t = np.array([s["t"] for s in gt["poses"]])
    gt_p = np.array([s["p"] for s in gt["poses"]])
    gt_R = Rot.from_quat(np.array([s["q"] for s in gt["poses"]]))
    slerp = Slerp(gt_t, gt_R)
    t = np.clip(traj.t, gt_t[0], gt_t[-1])
    p = np.stack([np.interp(t, gt_t, gt_p[:, i]) for i in range(3)], axis=1)
    dp = traj.p - p
    dr = np.degrees((slerp(t).inv() * traj.R).magnitude())
    return dp, dr


def summarize_errors(traj, gt):
    if len(traj) == 0:
        return None
    dp, dr = pose_errors(traj, gt)
    n = np.linalg.norm(dp, axis=1)
    return {"frames": int(len(traj)), "pos_rmse_m": float(np.sqrt((n ** 2).mean())), "pos_median_m": float(np.median(n)),
            "pos_max_m": float(n.max()), "z_rmse_m": float(np.sqrt((dp[:, 2] ** 2).mean())), "z_bias_m": float(dp[:, 2].mean()),
            "rot_median_deg": float(np.median(dr)), "rot_max_deg": float(dr.max())}
