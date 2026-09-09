#!/usr/bin/env python3
"""Bake a 1-bit equirectangular land mask from Natural Earth 110m."""

import json
from pathlib import Path
from urllib.request import urlopen

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
NE = Path("/tmp/ne110")
NE_BASE = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson"
W, H = 200, 100


def source_path(name):
    path = NE / name
    if not path.exists():
        NE.mkdir(parents=True, exist_ok=True)
        with urlopen(f"{NE_BASE}/{name}") as response:
            path.write_bytes(response.read())
    return path


def load(name):
    return json.loads(source_path(name).read_text())["features"]


def rings(geom):
    t, c = geom["type"], geom["coordinates"]
    if t == "Polygon":
        yield c
    elif t == "MultiPolygon":
        yield from c


def raster(features, fill=1, base=None):
    im = base or Image.new("L", (W, H), 0)
    draw = ImageDraw.Draw(im)
    for feat in features:
        for poly in rings(feat["geometry"]):
            ext = [((lon + 180) / 360 * W, (90 - lat) / 180 * H) for lon, lat in poly[0]]
            if len(ext) >= 3:
                draw.polygon(ext, fill=fill)
            for hole in poly[1:]:
                pts = [((lon + 180) / 360 * W, (90 - lat) / 180 * H) for lon, lat in hole]
                if len(pts) >= 3:
                    draw.polygon(pts, fill=0)
    return im


def pack(im):
    pix = im.load()
    buf = bytearray((W * H + 7) // 8)
    for y in range(H):
        for x in range(W):
            if pix[x, y]:
                i = y * W + x
                buf[i >> 3] |= 1 << (i & 7)
    return buf


def nibble(code):
    return code - 48 if code < 58 else code - 87


def main():
    land = raster(load("ne_110m_land.geojson"))
    raster(load("ne_110m_lakes.geojson"), fill=0, base=land)
    packed = pack(land)
    hexstr = packed.hex()
    out = ROOT / "src" / "embeddedjs" / "worldmask.js"
    out.write_text(
        f"""// 1-bit equirectangular land mask {W}x{H} from Natural Earth 110m (public domain).
export const MASK_W = {W};
export const MASK_H = {H};
const HEX = "{hexstr}";
export const MASK = new Uint8Array(HEX.length >> 1);
for (let i = 0; i < MASK.length; i++) {{
	const hi = HEX.charCodeAt(i << 1);
	const lo = HEX.charCodeAt((i << 1) + 1);
	MASK[i] = ((hi < 58 ? hi - 48 : hi - 87) << 4) | (lo < 58 ? lo - 48 : lo - 87);
}}
"""
    )
    print("wrote", out, out.stat().st_size, "bytes", "land", sum(1 for p in land.getdata() if p))


if __name__ == "__main__":
    main()
