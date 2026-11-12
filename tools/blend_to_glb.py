"""Converte um .blend de aeronave para o .glb que o simulador carrega.

    pip install bpy        (num ambiente separado; ~1 GB)
    python tools/blend_to_glb.py models/drone_advanced.blend models/drone_advanced.glb

Aplica modificadores, remove chão/câmeras/luzes e troca materiais procedurais (que o glTF não
representa) por cores equivalentes. Os nomes dos objetos são preservados: o simulador usa
"Helice"/"Spinner" para girar a hélice e o material "Film" para o filme transparente da asa.
"""
import sys
import bpy

src, dst = sys.argv[-2], sys.argv[-1]
bpy.ops.wm.open_mainfile(filepath=src)

for o in list(bpy.data.objects):
    if o.type in {"CAMERA", "LIGHT"} or o.name.lower() in {"chao", "ground", "floor"}:
        bpy.data.objects.remove(o, do_unlink=True)

# Materiais procedurais -> valores fixos (cor, rugosidade, metal).
FALLBACK = {
    "Balsa": ((0.74, 0.60, 0.40, 1), 0.65, 0.0),
    "Carbono": ((0.035, 0.037, 0.04, 1), 0.30, 0.0),
    "Helice": ((0.03, 0.03, 0.032, 1), 0.35, 0.0),
    "Borracha": ((0.02, 0.02, 0.02, 1), 0.85, 0.0),
    "MDF": ((0.40, 0.27, 0.16, 1), 0.80, 0.0),
}
for m in bpy.data.materials:
    if not m.node_tree:
        continue
    nt = m.node_tree
    out = next((n for n in nt.nodes if n.type == "OUTPUT_MATERIAL"), None)
    bsdf = next((n for n in nt.nodes if n.type == "BSDF_PRINCIPLED"), None)
    if bsdf is None or out is None:
        continue
    if m.name in FALLBACK:
        col, rough, metal = FALLBACK[m.name]
        for name in ("Base Color", "Roughness", "Normal"):
            for l in list(bsdf.inputs[name].links):
                nt.links.remove(l)
        bsdf.inputs["Base Color"].default_value = col
        bsdf.inputs["Roughness"].default_value = rough
        bsdf.inputs["Metallic"].default_value = metal
    # Garante que a saída é o Principled (ex.: "Film" mistura com Transparent no Blender).
    for l in list(out.inputs["Surface"].links):
        nt.links.remove(l)
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])

bpy.ops.object.select_all(action="SELECT")
bpy.ops.export_scene.gltf(filepath=dst, export_format="GLB", export_apply=True, export_yup=True,
                          export_cameras=False, export_lights=False, export_animations=False,
                          export_image_format="AUTO", export_materials="EXPORT")
print("ok ->", dst)
