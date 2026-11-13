"""Figuras "como o algoritmo enxerga" para o relatório: python tools/report_figures.py runs/sjc runs/relatorio/img"""
import json
import os
import pickle
import sys

import cv2
import numpy as np
from scipy.spatial.transform import Rotation as Rot

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from algos.aruco_mv import make_detector  # noqa: E402
from algos.common import Camera, Scene, Segmenter, main_blob, read_video  # noqa: E402
from algos.compose import Outline, pose_lookup  # noqa: E402

run, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
sc = Scene(run)
gt = json.load(open(os.path.join(run, "ground_truth.json")))
res = json.load(open(os.path.join(run, "results.json")))["algorithms"]
viz = pickle.load(open(os.path.join(run, "viz.pkl"), "rb"))
outline = Outline(sc)

# Paleta do relatório (BGR)
AMBER, BLUE, GREEN, RED, WHITE = (61, 163, 232), (213, 123, 58), (115, 178, 59), (60, 60, 214), (245, 245, 245)
gts, gR, gP = np.array([p["t"] for p in gt["poses"]]), Rot.from_quat([p["q"] for p in gt["poses"]]).as_matrix(), np.array([p["p"] for p in gt["poses"]])


def truth(t):
    i = int(np.argmin(np.abs(gts - t)))
    return gR[i], gP[i]


def true_cam(name, i):
    c = sc.cams[name]
    d = gt["cameras"][name][min(i, len(gt["cameras"][name]) - 1)]
    tc = Camera.__new__(Camera)
    tc.__dict__.update(c.__dict__)
    tc.K, tc.dist, tc.R, tc.t = (np.array(d[k], float) for k in ("K", "dist", "R", "t"))
    return tc


def crop(img, c, w, h):
    H, W = img.shape[:2]
    x0 = int(np.clip(c[0] - w / 2, 0, W - w)); y0 = int(np.clip(c[1] - h / 2, 0, H - h))
    return img[y0:y0 + h, x0:x0 + w].copy(), (x0, y0)


def tint(img, mask, color, a=0.55):
    o = img.copy()
    o[mask > 0] = (o[mask > 0] * (1 - a) + np.array(color) * a).astype(np.uint8)
    return o


def save(name, img, scale=1):
    if scale != 1:
        img = cv2.resize(img, None, fx=scale, fy=scale, interpolation=cv2.INTER_NEAREST if scale > 1 else cv2.INTER_AREA)
    cv2.imwrite(os.path.join(out, name), img, [cv2.IMWRITE_JPEG_QUALITY, 92])


# ----------------------------------------------------------------- câmera de linha
lc = sc.line()
lv = read_video(os.path.join(run, "linecam.mp4"))
seg = Segmenter(lv, sc.cfg["algorithms"]["linecam"]["diff_threshold"], True, True, cam=lc)
band = res["linecam_band"]
i = band["frame"]
m, f, _ = seg.mask(lv[i])
blob = main_blob(m, min_area=200, merge_px=45, min_part=40)
mk = blob["mask"] if blob else m
(u0, v0), (u1, v1) = viz["linecam"]["slit_uv"]
bar = viz["linecam"]["bar_px"]
cx = (u0 + u1) / 2
W, H = 760, 560
cyy = bar[1] - 60
raw, o = crop(f, (cx, cyy), W, H)
bg, _ = crop(seg.bg.astype(np.uint8), (cx, cyy), W, H)
diff = np.abs(f.astype(np.float32) - seg.bg).max(axis=2)
heat = cv2.applyColorMap(np.clip(diff * 3, 0, 255).astype(np.uint8), cv2.COLORMAP_INFERNO)
heat, _ = crop(heat, (cx, cyy), W, H)
mk_c, _ = crop(mk, (cx, cyy), W, H)
over = tint(raw, mk_c, AMBER)
half = band["band_half_px"]
p0, p1 = (int(u0 - o[0]), int(v0 - o[1])), (int(u1 - o[0]), int(v1 - o[1]))
ov = over.copy()
cv2.rectangle(ov, (p0[0] - half, 0), (p0[0] + half, H), BLUE, -1)
over = cv2.addWeighted(ov, 0.25, over, 0.75, 0)
cv2.line(over, p0, p1, BLUE, 2, cv2.LINE_AA)
b = (int(bar[0] - o[0]), int(bar[1] - o[1]))
cv2.line(over, (b[0] - 40, b[1]), (b[0] + 40, b[1]), RED, 2, cv2.LINE_AA)
zl = band["lowest_z_m"]
lp = lc.project(np.array([[sc.x_obs, sc.cfg["algorithms"]["linecam"]["assumed_y_m"], zl]]))[0] - o
cv2.circle(over, (int(lp[0]), int(lp[1])), 7, WHITE, 2, cv2.LINE_AA)
for n, img in (("lc_1_quadro.jpg", raw), ("lc_2_fundo.jpg", bg), ("lc_3_diferenca.jpg", heat), ("lc_4_mascara.jpg", over)):
    save(n, img)

# Sequência de quadros da câmera de linha em torno do cruzamento, com a máscara
strip = []
for k in range(i - 6, i + 7, 3):
    m2, f2, _ = seg.mask(lv[k])
    b2 = main_blob(m2, min_area=200, merge_px=45, min_part=40)
    img = tint(f2, b2["mask"], AMBER, 0.45) if b2 else f2
    c2, oo = crop(img, (cx, cyy), 420, 560)
    cv2.line(c2, (int(u0 - oo[0]), int(v0 - oo[1])), (int(u1 - oo[0]), int(v1 - oo[1])), BLUE, 2, cv2.LINE_AA)
    strip.append(c2)
gap = np.full((560, 8, 3), 255, np.uint8)
save("lc_sequencia.jpg", np.hstack(sum([[s, gap] for s in strip], [])[:-1]))

# ----------------------------------------------------------------- rastreamento: segmentação e silhueta
tcl = gt["clearance_t"]
est = pose_lookup(res["markerless"]["poses"])
names = [c.name for c in sc.tracking()]
for name in names:
    cam = sc.cams[name]
    v = read_video(os.path.join(run, f"{name}.mp4"))
    ts = sc.frames[name][: len(v)]
    k = int(np.argmin(np.abs(ts - tcl)))
    sg = Segmenter(v, sc.cfg["algorithms"]["markerless"]["diff_threshold"], cam=cam)
    m, f, _ = sg.mask(v[k])
    bl = main_blob(m, min_area=150)
    R, p = truth(ts[k])
    ctr = cam.project(p[None])[0]
    cw, ch = 560, 380
    layers = []
    if bl:
        cs, _ = cv2.findContours(bl["mask"], cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
        L = np.zeros(m.shape, np.uint8); cv2.drawContours(L, cs, -1, 255, 1); layers.append((L, AMBER))
    L = np.zeros(m.shape, np.uint8); outline.draw(L, true_cam(name, k), R, p, 255, 1); layers.append((L, GREEN))
    e = est(ts[k])
    if e is not None:
        L = np.zeros(m.shape, np.uint8); outline.draw(L, cam, e[0], e[1], 255, 1); layers.append((L, BLUE))
    c, oo = crop(f, ctr, cw, ch)
    c = cv2.resize(c, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC)
    for L, col in layers:
        l2 = cv2.resize(L[oo[1]:oo[1] + ch, oo[0]:oo[0] + cw], None, fx=2, fy=2, interpolation=cv2.INTER_NEAREST)
        c[cv2.dilate(l2, np.ones((3, 3), np.uint8)) > 0] = col
    save(f"ml_{name}.jpg", c)
    if name == "track_b":
        raw, _ = crop(f, ctr, cw, ch)
        mm, _ = crop(bl["mask"] if bl else m, ctr, cw, ch)
        # sombra removida: pixels que mudaram mas foram classificados como sombra
        fl = f.astype(np.float32)
        changed = (np.abs(fl - sg.bg).max(axis=2) / 255.0) > (sg.thr + sg.edge)
        sh, _ = crop(((changed & (m == 0)) * 255).astype(np.uint8), ctr, cw, ch)
        seg_img = tint(tint(raw, mm, AMBER, 0.6), sh, BLUE, 0.55)
        save("seg_track_b_quadro.jpg", raw, 2)
        save("seg_track_b_mascara.jpg", seg_img, 2)

# ----------------------------------------------------------------- ArUco: o que o detector encontra
name = "track_b"
cam = sc.cams[name]
v = read_video(os.path.join(run, f"{name}.mp4"))
ts = sc.frames[name][: len(v)]
det = make_detector()
body = {mm_["id"]: np.array(mm_["corners"], float) for mm_ in sc.markers}
best = None
for k in range(len(v)):
    R, p = truth(ts[k])
    tc = true_cam(name, k)
    for mid, corners in body.items():
        uv = tc.project(corners @ R.T + p)
        if uv.min() < 20 or uv[:, 0].max() > cam.width - 20 or uv[:, 1].max() > cam.height - 20:
            continue
        side = np.linalg.norm(np.diff(np.vstack([uv, uv[:1]]), axis=0), axis=1).mean()
        if best is None or side > best[0]:
            best = (side, k, mid, uv)
side, k, mid, uv = best
c = uv.mean(0)
s = int(side * 2.2)
x0, y0 = int(c[0] - s / 2), int(c[1] - s / 2)
gray = cv2.cvtColor(v[k][y0:y0 + s, x0:x0 + s], cv2.COLOR_BGR2GRAY)
up = 3
big = cv2.resize(gray, None, fx=up, fy=up, interpolation=cv2.INTER_CUBIC)
corners, ids, rejected = det.detectMarkers(big)
Z = 8  # ampliação para a figura
view = cv2.resize(cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR), None, fx=Z, fy=Z, interpolation=cv2.INTER_NEAREST)
thr = cv2.adaptiveThreshold(big, 255, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY, 2 * (int(side * up / 5) // 2) + 1, 7)
thr = cv2.resize(cv2.cvtColor(thr, cv2.COLOR_GRAY2BGR), view.shape[1::-1], interpolation=cv2.INTER_NEAREST)
cand = view.copy()
mk_area = cv2.contourArea(((uv - [x0, y0]) * up).astype(np.float32))
for q in rejected:
    if cv2.contourArea(q.reshape(4, 2)) < 0.04 * mk_area:
        continue
    pts = ((q.reshape(4, 2) + 0.5) / up - 0.5 + 0.5) * Z
    cv2.polylines(cand, [np.round(pts).astype(np.int32)], True, RED, 2, cv2.LINE_AA)
for q in (corners or []):
    pts = ((q.reshape(4, 2) + 0.5) / up) * Z
    cv2.polylines(cand, [np.round(pts).astype(np.int32)], True, GREEN, 3, cv2.LINE_AA)
for pt in (uv - [x0, y0] + 0.5) * Z:
    cv2.circle(cand, (int(pt[0]), int(pt[1])), 6, GREEN, -1, cv2.LINE_AA)
save("aruco_1_recorte.jpg", view)
save("aruco_2_limiar.jpg", thr)
save("aruco_3_candidatos.jpg", cand)
ctx = v[k].copy()
cv2.rectangle(ctx, (x0, y0), (x0 + s, y0 + s), AMBER, 2)
cc, _ = crop(ctx, c, 700, 420)
save("aruco_0_contexto.jpg", cc)
print(json.dumps({"linecam_frame": i, "aruco_frame": k, "marker": mid, "side_px": round(float(side), 1),
                  "rejected": len(rejected), "detected": 0 if ids is None else len(ids)}))
