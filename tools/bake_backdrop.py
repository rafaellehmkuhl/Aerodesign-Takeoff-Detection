"""Fundo distante pré-renderizado no Blender (Cycles): morros com mata, cidade, casas e cinturões de árvores.

    /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup -P tools/bake_backdrop.py -- [--preview]

Gera sim/assets/backdrop/backdrop.exr: um panorama equiretangular RGBA (radiância linear, céu transparente)
da faixa do horizonte, visto do ponto CENTER. O simulador o desenha numa esfera ao redor da cena e mantém em
tempo real só o que fica perto (pista, obstáculo, torres, aeronave). Iluminação do mesmo HDRI do simulador,
com luz rebatida e sombras do Cycles; a névoa (perspectiva aérea) é a mesma do three.js (FogExp2), aplicada
no shader de cada material.

O panorama: coluna u = 0,5 − azimute/360° (centro = +x do mundo, crescendo para a esquerda);
linha v de LAT_MAX (topo) a LAT_MIN (base).
"""
import math
import os
import random
import sys

import bmesh
import bpy
from mathutils import Vector, noise

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ARGS = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
PREVIEW = "--preview" in ARGS
OUT = os.path.join(ROOT, "sim", "assets", "backdrop", "backdrop_preview.exr" if PREVIEW else "backdrop.exr")

# Precisam bater com config/default.yaml e sim/src/world_real.js.
L = 55.0                                # runway.length_m (obstáculo)
CENTER = (54.0, -9.0, 4.0)              # ponto de vista do panorama (meio das câmeras)
SUN_AZ = 215.0                          # environment.sun_azimuth_deg
HAZE = 0.00016                          # environment.haze
HAZE_COLOR = (0.72, 0.76, 0.82)         # environment.haze_color
HDRI = os.path.join(ROOT, "sim", "assets", "polyhaven", "sky_cloudy_4k.hdr")
LAT_MIN, LAT_MAX = -4.0, 14.0
DEG_PER_PX = 360.0 / 16384
rng = random.Random(7)


def clear():
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o)


def link(name, me):
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    return o


# ------------------------------------------------------------------ materiais (com névoa do three.js)
def material(name, build):
    """build(nt) devolve o socket do shader de superfície; aqui ele é misturado à névoa pela distância."""
    m = bpy.data.materials.new(name)
    nt = m.node_tree if m.node_tree else None
    if nt is None:
        m.use_nodes = True
        nt = m.node_tree
    nt.nodes.clear()
    N = nt.nodes.new
    surf = build(nt)
    cam = N("ShaderNodeCameraData")
    # f = 1 − exp(−(k·d)²): igual ao THREE.FogExp2
    kd = N("ShaderNodeMath"); kd.operation = "MULTIPLY"; kd.inputs[1].default_value = HAZE
    nt.links.new(cam.outputs["View Distance"], kd.inputs[0])
    sq = N("ShaderNodeMath"); sq.operation = "POWER"; sq.inputs[1].default_value = 2.0
    nt.links.new(kd.outputs[0], sq.inputs[0])
    ng = N("ShaderNodeMath"); ng.operation = "MULTIPLY"; ng.inputs[1].default_value = -1.0
    nt.links.new(sq.outputs[0], ng.inputs[0])
    ex = N("ShaderNodeMath"); ex.operation = "EXPONENT"
    nt.links.new(ng.outputs[0], ex.inputs[0])
    f = N("ShaderNodeMath"); f.operation = "SUBTRACT"; f.inputs[0].default_value = 1.0
    nt.links.new(ex.outputs[0], f.inputs[1])
    fog = N("ShaderNodeEmission"); fog.inputs[0].default_value = (*HAZE_COLOR, 1); fog.inputs[1].default_value = 1.0
    mix = N("ShaderNodeMixShader")
    nt.links.new(f.outputs[0], mix.inputs[0]); nt.links.new(surf, mix.inputs[1]); nt.links.new(fog.outputs[0], mix.inputs[2])
    out = N("ShaderNodeOutputMaterial")
    nt.links.new(mix.outputs[0], out.inputs[0])
    return m


def principled(nt, color_socket=None, color=(0.5, 0.5, 0.5), rough=0.8, bump=None, spec=0.3):
    p = nt.nodes.new("ShaderNodeBsdfPrincipled")
    if color_socket is not None:
        nt.links.new(color_socket, p.inputs["Base Color"])
    else:
        p.inputs["Base Color"].default_value = (*color, 1)
    p.inputs["Roughness"].default_value = rough
    if "Specular IOR Level" in p.inputs:
        p.inputs["Specular IOR Level"].default_value = spec
    if bump is not None:
        b = nt.nodes.new("ShaderNodeBump"); b.inputs["Strength"].default_value = bump[1]; b.inputs["Distance"].default_value = bump[2]
        nt.links.new(bump[0], b.inputs["Height"]); nt.links.new(b.outputs[0], p.inputs["Normal"])
    return p.outputs[0]


def noise_ramp(nt, scale, stops, detail=6.0, coord="Object", rough=0.6):
    tc = nt.nodes.new("ShaderNodeTexCoord")
    n = nt.nodes.new("ShaderNodeTexNoise"); n.inputs["Scale"].default_value = scale; n.inputs["Detail"].default_value = detail
    n.inputs["Roughness"].default_value = rough
    nt.links.new(tc.outputs[coord], n.inputs["Vector"])
    r = nt.nodes.new("ShaderNodeValToRGB")
    r.color_ramp.elements[0].position, r.color_ramp.elements[0].color = stops[0][0], (*stops[0][1], 1)
    r.color_ramp.elements[1].position, r.color_ramp.elements[1].color = stops[-1][0], (*stops[-1][1], 1)
    for pos, col in stops[1:-1]:
        e = r.color_ramp.elements.new(pos); e.color = (*col, 1)
    nt.links.new(n.outputs["Fac"], r.inputs[0])
    return r.outputs[0], n.outputs["Fac"]


def srgb(h):
    h = h.lstrip("#"); c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c)


def mat_grass():
    def b(nt):
        col, fac = noise_ramp(nt, 0.004, [(0.3, srgb("#5f7034")), (0.5, srgb("#6f8240")), (0.7, srgb("#80904a"))], coord="Object")
        return principled(nt, col, rough=0.95, spec=0.2)
    return material("grama", b)


def mat_forest():
    def b(nt):
        # copas: Voronoi dá os "tufos" de árvore, ruído dá a variação de verde
        tc = nt.nodes.new("ShaderNodeTexCoord")
        vo = nt.nodes.new("ShaderNodeTexVoronoi"); vo.inputs["Scale"].default_value = 0.12
        nt.links.new(tc.outputs["Object"], vo.inputs["Vector"])
        col, fac = noise_ramp(nt, 0.01, [(0.25, srgb("#34432a")), (0.5, srgb("#46582f")), (0.75, srgb("#5d6c3b"))])
        inv = nt.nodes.new("ShaderNodeMath"); inv.operation = "SUBTRACT"; inv.inputs[0].default_value = 1.0
        nt.links.new(vo.outputs["Distance"], inv.inputs[1])
        return principled(nt, col, rough=0.9, bump=(inv.outputs[0], 0.8, 4.0), spec=0.15)
    return material("mata", b)


def mat_leaves(seed):
    def b(nt):
        tc = nt.nodes.new("ShaderNodeTexCoord")
        vo = nt.nodes.new("ShaderNodeTexVoronoi"); vo.inputs["Scale"].default_value = 2.2
        nt.links.new(tc.outputs["Object"], vo.inputs["Vector"])
        base = [srgb("#344127"), srgb("#3f4d2b"), srgb("#4a5a31"), srgb("#55622f")][seed % 4]
        col, fac = noise_ramp(nt, 0.6, [(0.3, tuple(c * 0.7 for c in base)), (0.55, base), (0.8, tuple(min(1, c * 1.35) for c in base))])
        inv = nt.nodes.new("ShaderNodeMath"); inv.operation = "SUBTRACT"; inv.inputs[0].default_value = 1.0
        nt.links.new(vo.outputs["Distance"], inv.inputs[1])
        return principled(nt, col, rough=0.85, bump=(inv.outputs[0], 1.0, 0.4), spec=0.2)
    return material(f"folhas{seed}", b)


def mat_facade(base_hex, glass_hex="#56606a"):
    def b(nt):
        # Grade de janelas: a "argamassa" do Brick é a parede, os "tijolos" são o vidro (um andar a cada 3 m).
        tc = nt.nodes.new("ShaderNodeTexCoord")
        sep = nt.nodes.new("ShaderNodeSeparateXYZ"); nt.links.new(tc.outputs["Object"], sep.inputs[0])
        add = nt.nodes.new("ShaderNodeMath"); add.operation = "ADD"
        nt.links.new(sep.outputs[0], add.inputs[0]); nt.links.new(sep.outputs[1], add.inputs[1])
        comb = nt.nodes.new("ShaderNodeCombineXYZ")
        nt.links.new(add.outputs[0], comb.inputs[0]); nt.links.new(sep.outputs[2], comb.inputs[1])
        br = nt.nodes.new("ShaderNodeTexBrick")
        br.inputs["Scale"].default_value = 1.0
        br.inputs["Mortar Size"].default_value = 0.55
        br.inputs["Brick Width"].default_value = 2.6
        br.inputs["Row Height"].default_value = 3.0
        br.offset = 0.0
        br.inputs["Color1"].default_value = (*srgb(glass_hex), 1); br.inputs["Color2"].default_value = (*srgb(glass_hex), 1)
        br.inputs["Mortar"].default_value = (*srgb(base_hex), 1)
        nt.links.new(comb.outputs[0], br.inputs["Vector"])
        # vidro mais liso (reflete o céu), parede fosca
        rr = nt.nodes.new("ShaderNodeMapRange"); rr.inputs["To Min"].default_value = 0.15; rr.inputs["To Max"].default_value = 0.85
        nt.links.new(br.outputs["Fac"], rr.inputs["Value"])
        p = nt.nodes.new("ShaderNodeBsdfPrincipled")
        nt.links.new(br.outputs["Color"], p.inputs["Base Color"]); nt.links.new(rr.outputs[0], p.inputs["Roughness"])
        return p.outputs[0]
    return material(f"fachada_{base_hex}", b)


def mat_flat(name, hex_, rough=0.8):
    return material(name, lambda nt: principled(nt, color=srgb(hex_), rough=rough))


# ------------------------------------------------------------------ geometria
def terrain():
    """Disco de chão até 14 km; além de ~2,3 km ele sobe em morros de mata (três faixas de serra)."""
    bm = bmesh.new()
    na, rings = 1440, 70
    radii = [0] + [200 * (1.075 ** i) for i in range(rings)]
    radii = [r for r in radii if r < 15000]
    grid = []
    for ri, r in enumerate(radii):
        row = []
        for a in range(na if r > 0 else 1):
            th = 2 * math.pi * a / na
            x, y = L / 2 + r * math.cos(th), r * math.sin(th)
            row.append(bm.verts.new((x, y, height(x, y, r, th))))
        grid.append(row)
    for ri in range(1, len(grid)):
        a_, b_ = grid[ri - 1], grid[ri]
        for a in range(na):
            if len(a_) == 1:
                bm.faces.new((a_[0], b_[a], b_[(a + 1) % na]))
            else:
                bm.faces.new((a_[a], a_[(a + 1) % na], b_[(a + 1) % na], b_[a]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    for f in bm.faces:
        if f.normal.z < 0:
            f.normal_flip()
    me = bpy.data.meshes.new("terreno"); bm.to_mesh(me); bm.free()
    for p in me.polygons:
        p.use_smooth = True
    o = link("terreno", me)
    # chão perto = grama, morros = mata: atribui pela altura
    o.data.materials.append(mat_grass()); o.data.materials.append(mat_forest())
    for p in me.polygons:
        p.material_index = 1 if p.center.z > 6 else 0
    return o


def height(x, y, r, th):
    if r < 1900:
        return 0.0
    t = min(1.0, (r - 1900) / 1800)           # sobe de 1,9 a 3,7 km
    v = Vector((x / 2600, y / 2600, 0.3))
    ridge = 1 - abs(noise.noise(v * 1.0))     # cristas
    hills = 0.55 * ridge + 0.35 * (noise.noise(v * 2.7) * 0.5 + 0.5) + 0.12 * (noise.noise(v * 9.0) * 0.5 + 0.5)
    band = 0.35 + 0.65 * (0.5 + 0.5 * math.sin(th * 3 + 1.0)) * (0.6 + 0.4 * math.sin(th * 7.3 + 2))
    hmax = 220 + 600 * min(1.0, (r - 1900) / 6000)
    return max(0.0, t * t * band * hills * hmax)


def box(bm, cx, cy, z0, w, d, h, rot=0.0):
    c, s = math.cos(rot), math.sin(rot)
    pts = []
    for zz in (z0, z0 + h):
        for dx, dy in ((-w / 2, -d / 2), (w / 2, -d / 2), (w / 2, d / 2), (-w / 2, d / 2)):
            pts.append(bm.verts.new((cx + dx * c - dy * s, cy + dx * s + dy * c, zz)))
    f = [(0, 1, 2, 3), (4, 7, 6, 5), (0, 4, 5, 1), (1, 5, 6, 2), (2, 6, 7, 3), (3, 7, 4, 0)]
    return [bm.faces.new([pts[i] for i in q]) for q in f]


def city():
    """Bairros de prédios residenciais (40–110 m) a 1,1–2,2 km, com sacadas e caixas-d'água; casas na frente."""
    facades = ["#d6cfc2", "#c9c2b5", "#e0dad0", "#9aa0a6", "#b8b2a6", "#e8e4dc", "#c4b8a4", "#a9a49c"]
    groups = {h: bmesh.new() for h in facades}
    slab_bm, roof_bm = bmesh.new(), bmesh.new()
    for blk in range(18):
        bx = L / 2 + (blk / 17 - 0.5) * 6000 + rng.uniform(-200, 200)
        by = rng.uniform(1150, 2100)
        for i in range(rng.randint(10, 26)):
            w, d, h = rng.uniform(16, 30), rng.uniform(14, 24), 40 + 70 * rng.random() ** 1.3
            x, y, rot = bx + rng.uniform(-260, 260), by + rng.uniform(-180, 180), rng.uniform(-0.3, 0.3)
            fac = rng.choice(facades)
            box(groups[fac], x, y, 0, w, d, h, rot)
            for z in range(3, int(h) - 1, 3):          # lajes/sacadas a cada andar
                box(slab_bm, x, y, z - 0.15, w + 0.9, d + 0.9, 0.18, rot)
            box(roof_bm, x, y, h, w * 0.35, d * 0.3, 4.5, rot)          # caixa-d'água
            box(roof_bm, x + w * 0.25, y, h, w * 0.2, d * 0.2, 2.5, rot)
    for hex_, bm in groups.items():
        me = bpy.data.meshes.new("predios"); bm.to_mesh(me); bm.free(); o = link("predios", me); o.data.materials.append(mat_facade(hex_))
    for name, bm, hx in (("lajes", slab_bm, "#ece9e2"), ("telhados", roof_bm, "#8c8a85")):
        me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free(); o = link(name, me); o.data.materials.append(mat_flat(name, hx))
    # Casas e galpões baixos entre a mata e os prédios.
    walls, roofs = bmesh.new(), bmesh.new()
    for i in range(900):
        x, y = L / 2 + rng.uniform(-3200, 3200), rng.uniform(650, 1200)
        w, d, rot = rng.uniform(7, 14), rng.uniform(7, 12), rng.uniform(-0.4, 0.4)
        box(walls, x, y, 0, w, d, 3.0, rot)
        box(roofs, x, y, 3.0, w + 0.6, d + 0.6, 1.2, rot)
    me = bpy.data.meshes.new("casas"); walls.to_mesh(me); walls.free(); o = link("casas", me); o.data.materials.append(mat_flat("reboco", "#d9d2c3"))
    me = bpy.data.meshes.new("telhas"); roofs.to_mesh(me); roofs.free(); o = link("telhas", me); o.data.materials.append(mat_flat("telha", "#9a5a3c"))


def trees():
    """Cinturões de mata (copas que se fundem) e capões, como nas fotos. Geometria montada em numpy a partir de
    uma icosfera-molde (milhares de copas em segundos)."""
    import numpy as np
    bm = bmesh.new(); bmesh.ops.create_icosphere(bm, subdivisions=2, radius=1.0)
    tv = np.array([v.co[:] for v in bm.verts], dtype=np.float32)
    tf = np.array([[v.index for v in f.verts] for f in bm.faces], dtype=np.int32); bm.free()
    mats = [mat_leaves(k) for k in range(4)]
    lobes = [[] for _ in mats]                    # por material: (centro, escala xyz, fase do ruído)
    trunks = []

    def tree(x, y, h):
        r = h * rng.uniform(0.28, 0.42)
        k_mat = rng.randrange(len(mats))
        for k in range(rng.randint(2, 4)):     # copa = 2–4 lóbulos
            ox, oy = (rng.uniform(-0.5, 0.5) * r, rng.uniform(-0.5, 0.5) * r) if k else (0, 0)
            sc = r * (rng.uniform(0.6, 0.9) if k else 1.0)
            cz = h - r + rng.uniform(-0.3, 0.2) * r
            lobes[k_mat].append((x + ox, y + oy, cz, sc, sc, sc * 0.85, rng.uniform(0, 100)))
        trunks.append((x, y, h - r))

    for yb, n in ((380, 2200), (-300, 1800)):      # cinturões contínuos além do campo, com falhas
        for i in range(n):
            x = L / 2 + rng.uniform(-1400, 1400)
            if noise.noise(Vector((x / 180, yb / 180, 0.5))) < -0.45:
                continue
            tree(x, yb + rng.gauss(0, 14), rng.uniform(7, 19))
    for c in range(30):                               # capões no campo e mata entre as casas
        cx, cy = L / 2 + rng.uniform(-1800, 1800), rng.choice([rng.uniform(430, 1300), -rng.uniform(340, 1200)])
        for i in range(rng.randint(8, 40)):
            tree(cx + rng.gauss(0, 25), cy + rng.gauss(0, 15), rng.uniform(6, 17))

    nv = len(tv)
    for lob, m in zip(lobes, mats):
        P = np.array(lob, dtype=np.float32)
        # copa irregular: deformação suave por senos com fase própria de cada lóbulo
        ph = P[:, 6:7, None]
        d = 1 + 0.22 * np.sin(tv[None, :, 0:1] * 2.3 + ph) * np.cos(tv[None, :, 1:2] * 1.9 + 0.7 * ph) + 0.12 * np.sin(tv[None, :, 2:3] * 3.1 + 1.3 * ph)
        V = tv[None] * d * P[:, None, 3:6] + P[:, None, 0:3]
        F = (tf[None] + (np.arange(len(P)) * nv)[:, None, None]).reshape(-1, 3)
        me = bpy.data.meshes.new("arvores")
        me.vertices.add(len(P) * nv); me.vertices.foreach_set("co", V.reshape(-1).astype(np.float32))
        me.loops.add(F.size); me.loops.foreach_set("vertex_index", F.reshape(-1))
        me.polygons.add(len(F)); me.polygons.foreach_set("loop_start", np.arange(0, F.size, 3, dtype=np.int32))
        me.update(); me.polygons.foreach_set("use_smooth", np.ones(len(F), dtype=bool))
        o = link("arvores", me); o.data.materials.append(m)
    tb = bmesh.new()
    for x, y, h in trunks:
        box(tb, x, y, 0, 0.5, 0.5, h, 0)
    me = bpy.data.meshes.new("troncos"); tb.to_mesh(me); tb.free(); o = link("troncos", me); o.data.materials.append(mat_flat("tronco", "#4a3b2c", 0.95))


def world_and_camera():
    sc = bpy.context.scene
    w = bpy.data.worlds.new("ceu"); sc.world = w
    nt = w.node_tree if w.node_tree else None
    if nt is None:
        w.use_nodes = True; nt = w.node_tree
    nt.nodes.clear()
    img = bpy.data.images.load(HDRI)
    # Posição do sol no HDRI (pixel mais brilhante), para girar o céu e pôr o sol no azimute do simulador.
    import numpy as np
    W, H = img.size
    px = np.empty(W * H * 4, dtype=np.float32); img.pixels.foreach_get(px)
    bi = int(np.argmax(px.reshape(-1, 4)[:, :3].sum(1)))
    u_sun = ((bi % W) + 0.5) / W
    # Blender: azimute de uma direção no mapa = (u − 0,5)·360° medido de −x... rotação z que leva o sol a SUN_AZ:
    a = (u_sun - 0.5) * 2 * math.pi
    rot = math.pi - math.radians(SUN_AZ) - a
    tc = nt.nodes.new("ShaderNodeTexCoord"); mp = nt.nodes.new("ShaderNodeMapping"); mp.inputs["Rotation"].default_value[2] = rot
    env = nt.nodes.new("ShaderNodeTexEnvironment"); env.image = img
    bg = nt.nodes.new("ShaderNodeBackground"); out = nt.nodes.new("ShaderNodeOutputWorld")
    nt.links.new(tc.outputs["Generated"], mp.inputs["Vector"]); nt.links.new(mp.outputs[0], env.inputs["Vector"])
    nt.links.new(env.outputs[0], bg.inputs[0]); nt.links.new(bg.outputs[0], out.inputs[0])
    print(f"sol no HDRI u={u_sun:.3f}; céu girado {math.degrees(rot):.1f}°")

    cam = bpy.data.cameras.new("pano"); cam.type = "PANO"; cam.panorama_type = "EQUIRECTANGULAR"
    cam.latitude_min, cam.latitude_max = math.radians(LAT_MIN), math.radians(LAT_MAX)
    cam.clip_start, cam.clip_end = 1.0, 30000
    co = link("camera", cam); sc.camera = co
    co.location = CENTER; co.rotation_euler = (math.radians(90), 0, math.radians(-90))   # olha para +x
    r = sc.render
    r.engine = "CYCLES"; r.film_transparent = True
    r.resolution_x = 4096 if PREVIEW else 16384
    r.resolution_y = round((LAT_MAX - LAT_MIN) / (360.0 / r.resolution_x))
    r.resolution_percentage = 100
    r.image_settings.file_format = "OPEN_EXR"; r.image_settings.color_mode = "RGBA"; r.image_settings.exr_codec = "DWAA"
    if hasattr(r.image_settings, "color_depth"):
        r.image_settings.color_depth = "16"
    r.filepath = OUT
    cy = sc.cycles
    cy.samples = 32 if PREVIEW else 128
    cy.use_denoising = True
    cy.max_bounces = 6
    try:
        prefs = bpy.context.preferences.addons["cycles"].preferences
        prefs.compute_device_type = "METAL"
        prefs.refresh_devices() if hasattr(prefs, "refresh_devices") else prefs.get_devices()
        for d in prefs.devices:
            d.use = d.type != "CPU"
        print("dispositivos:", [(d.name, d.type, d.use) for d in prefs.devices], flush=True)
        cy.device = "GPU"
    except Exception as e:  # sem GPU: CPU
        print("GPU indisponível:", e)
    sc.view_settings.view_transform = "Standard"   # radiância linear sem curva: o three.js aplica o tone mapping


import time
T0 = time.time()
def step(f):
    f(); print(f"{f.__name__}: {time.time() - T0:.0f} s", flush=True)
clear()
step(world_and_camera)
step(terrain)
step(city)
step(trees)
os.makedirs(os.path.dirname(OUT), exist_ok=True)
bpy.ops.render.render(write_still=True)
print("salvo:", OUT, bpy.context.scene.render.resolution_x, "x", bpy.context.scene.render.resolution_y)
