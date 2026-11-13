#!/usr/bin/env python3
"""Baixa os assets CC0 do Poly Haven (polyhaven.com) usados pela cena realista.

    python3 tools/fetch_assets.py            # ~45 MB em sim/assets/polyhaven/ (fora do git)

Sem eles o simulador cai no cenário procedural simples (environment.quality: basic).
"""
import json
import os
import sys
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "sim", "assets", "polyhaven")
UA = {"User-Agent": "takeoff-sim-asset-fetch"}

# (asset, mapa na API, resolução, formato, nome local)
ASSETS = [
    ("kloofendal_48d_partly_cloudy_puresky", "hdri", "4k", "hdr", "sky_4k.hdr"),
    ("kloppenheim_03_puresky", "hdri", "4k", "hdr", "sky_cloudy_4k.hdr"),   # padrão: céu com muitas nuvens, como nas fotos da competição
    ("asphalt_02", "Diffuse", "2k", "jpg", "asphalt_diff.jpg"),
    ("asphalt_02", "nor_gl", "2k", "jpg", "asphalt_nor.jpg"),
    ("asphalt_02", "Rough", "2k", "jpg", "asphalt_rough.jpg"),
    ("aerial_asphalt_01", "Diffuse", "2k", "jpg", "asphalt_macro_diff.jpg"),
    ("dirty_concrete", "Diffuse", "2k", "jpg", "concrete_diff.jpg"),
    ("dirty_concrete", "nor_gl", "2k", "jpg", "concrete_nor.jpg"),
    ("dirty_concrete", "Rough", "2k", "jpg", "concrete_rough.jpg"),
    ("leafy_grass", "Diffuse", "2k", "jpg", "grass_diff.jpg"),
    ("leafy_grass", "nor_gl", "2k", "jpg", "grass_nor.jpg"),
    ("leafy_grass", "Rough", "2k", "jpg", "grass_rough.jpg"),
    ("aerial_grass_rock", "Diffuse", "2k", "jpg", "grass_macro_diff.jpg"),
    ("jacaranda_tree", "leaves_diff", "1k", "jpg", "leaves_diff.jpg"),
    ("jacaranda_tree", "leaves_alpha", "1k", "png", "leaves_alpha.png"),
    ("jacaranda_tree", "trunk_diff", "1k", "jpg", "bark_diff.jpg"),
]


def get(url):
    return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120).read()


def main():
    os.makedirs(OUT, exist_ok=True)
    cache = {}
    for asset, kind, res, fmt, name in ASSETS:
        dst = os.path.join(OUT, name)
        if os.path.exists(dst) and os.path.getsize(dst) > 0:
            continue
        files = cache.setdefault(asset, json.loads(get(f"https://api.polyhaven.com/files/{asset}")))
        try:
            entry = files[kind][res][fmt]
        except KeyError:
            print(f"  ! {asset}: {kind}/{res}/{fmt} não existe; opções: {list(files.get(kind, {}).get(res, {}))}", file=sys.stderr)
            continue
        print(f"  {name:28s} {entry['size'] / 1e6:6.1f} MB")
        with open(dst, "wb") as f:
            f.write(get(entry["url"]))
    print("ok ->", OUT)


if __name__ == "__main__":
    main()
