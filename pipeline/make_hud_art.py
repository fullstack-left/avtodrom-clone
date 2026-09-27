"""Renders the HUD's raster art (supersampled 4x, then filtered down):

  game/assets/ui/steering_wheel.png  512x512  three-spoke wheel, straight ahead
  game/assets/ui/button_round.png    256x256  glossy round button face

    python pipeline/make_hud_art.py
"""
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "game" / "assets" / "ui"
SS = 4  # supersampling
LIGHT = np.array([-0.35, -0.65, 0.68])  # from the upper left, towards the viewer
LIGHT /= np.linalg.norm(LIGHT)


def rgba(arr):
    return Image.fromarray(np.clip(arr * 255.0, 0, 255).astype(np.uint8), "RGBA")


def grid(n):
    y, x = np.mgrid[0:n, 0:n].astype(np.float64) + 0.5
    return x, y


def shade(nx, ny, nz, base, spec_power=24.0, spec=0.35, amb=0.35):
    d = np.clip(nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2], 0.0, 1.0)
    # Blinn-Phong with the viewer on +z.
    h = LIGHT + np.array([0.0, 0.0, 1.0])
    h /= np.linalg.norm(h)
    s = np.clip(nx * h[0] + ny * h[1] + nz * h[2], 0.0, 1.0) ** spec_power
    col = base[None, None, :] * (amb + (1.0 - amb) * d[..., None]) + spec * s[..., None]
    return np.clip(col, 0.0, 1.0)


def mask_image(n, draw_fn):
    m = Image.new("L", (n, n), 0)
    draw_fn(ImageDraw.Draw(m))
    return np.asarray(m, dtype=np.float64) / 255.0


def over(dst, src):
    """Alpha-composite float RGBA src over dst (straight alpha)."""
    a = src[..., 3:4]
    out_a = a + dst[..., 3:4] * (1.0 - a)
    out_rgb = (src[..., :3] * a + dst[..., :3] * dst[..., 3:4] * (1.0 - a)) / np.maximum(out_a, 1e-6)
    return np.concatenate([out_rgb, out_a], axis=-1)


def layer(n, rgb, alpha):
    out = np.zeros((n, n, 4))
    out[..., :3] = rgb
    out[..., 3] = alpha
    return out


def steering_wheel(size=512):
    n = size * SS
    c = n / 2.0
    x, y = grid(n)
    dx, dy = x - c, y - c
    r = np.hypot(dx, dy)
    ang = np.arctan2(dx, -dy)  # 0 at 12 o'clock, clockwise positive
    img = np.zeros((n, n, 4))

    r_mid = 0.415 * n
    half_w = 0.043 * n
    # Thumb grips at 3 and 9 o'clock: the rim swells a little there.
    grip = np.exp(-((np.abs(ang) - np.pi / 2) / 0.30) ** 2)
    hw = half_w * (1.0 + 0.16 * grip)
    t = (r - r_mid) / hw  # -1 inner edge .. 1 outer edge

    # Spokes and hub (drawn first: the rim sits on top of them).
    def spokes(d):
        # Side spokes dip slightly below the centre, as on most cars.
        for side in (-1, 1):
            pts = [(c + side * 0.13 * n, c - 0.045 * n), (c + side * 0.385 * n, c - 0.02 * n),
                   (c + side * 0.385 * n, c + 0.085 * n), (c + side * 0.13 * n, c + 0.10 * n)]
            d.polygon(pts, fill=255)
        d.polygon([(c - 0.085 * n, c + 0.08 * n), (c + 0.085 * n, c + 0.08 * n),
                   (c + 0.055 * n, c + 0.385 * n), (c - 0.055 * n, c + 0.385 * n)], fill=255)
        d.rounded_rectangle([c - 0.17 * n, c - 0.135 * n, c + 0.17 * n, c + 0.15 * n], radius=0.075 * n, fill=255)

    spoke_m = mask_image(n, spokes)
    # Soft shadow of the whole wheel under it.
    rim_m = ((r > r_mid - hw) & (r < r_mid + hw)).astype(np.float64)
    shadow = Image.fromarray((np.maximum(spoke_m, rim_m) * 255).astype(np.uint8), "L")
    shadow = shadow.filter(ImageFilter.GaussianBlur(0.018 * n))
    sh = np.roll(np.asarray(shadow, dtype=np.float64) / 255.0, int(0.014 * n), axis=0)
    img = over(img, layer(n, np.zeros(3), sh * 0.55))

    # Spokes: satin dark metal, lighter at the top, with a bevel along the edges.
    grad = 0.20 - 0.08 * (y - (c - 0.14 * n)) / (0.53 * n)
    spoke_rgb = np.stack([grad * 0.95, grad, grad * 1.08], axis=-1)
    edge = spoke_m - np.asarray(Image.fromarray((spoke_m * 255).astype(np.uint8)).filter(
        ImageFilter.MinFilter(int(0.012 * n) | 1)), dtype=np.float64) / 255.0
    spoke_rgb = spoke_rgb + edge[..., None] * np.where(dy[..., None] < 0, 0.16, -0.05)
    img = over(img, layer(n, np.clip(spoke_rgb, 0, 1), spoke_m))
    # Brushed-aluminium trim on the side spokes.
    trim_m = mask_image(n, lambda d: [d.polygon([(c + s * 0.19 * n, c + 0.005 * n), (c + s * 0.36 * n, c + 0.022 * n),
                                                 (c + s * 0.36 * n, c + 0.04 * n), (c + s * 0.19 * n, c + 0.03 * n)],
                                                fill=255) for s in (-1, 1)])
    brush = 0.62 + 0.18 * np.sin(y * 0.9) * 0.2 + 0.2 * (1.0 - (y - (c - 0.0 * n)) / (0.06 * n)).clip(0, 1)
    img = over(img, layer(n, np.stack([brush, brush, brush * 1.03], -1).clip(0, 1), trim_m))

    # Hub / airbag cover: a soft cushion with a highlight, and an emblem.
    hub_m = mask_image(n, lambda d: d.rounded_rectangle(
        [c - 0.15 * n, c - 0.118 * n, c + 0.15 * n, c + 0.132 * n], radius=0.07 * n, fill=255))
    hx = dx / (0.15 * n)
    hy = (dy - 0.007 * n) / (0.125 * n)
    hz = np.sqrt(np.clip(1.0 - 0.55 * (hx ** 2 + hy ** 2), 0.05, 1.0))
    hub_rgb = shade(hx * 0.5, hy * 0.5, hz, np.array([0.13, 0.135, 0.15]), spec_power=18, spec=0.22, amb=0.45)
    img = over(img, layer(n, hub_rgb, hub_m))
    ring = ((np.hypot(dx / 0.062, (dy - 0.004 * n) / 0.042) > n) & (np.hypot(dx / 0.062, (dy - 0.004 * n) / 0.042) < 1.2 * n))
    ring_rgb = shade(np.zeros_like(r), np.clip(dy / (0.05 * n), -1, 1) * 0.7, np.full_like(r, 0.7),
                     np.array([0.78, 0.8, 0.84]), spec_power=12, spec=0.5, amb=0.5)
    img = over(img, layer(n, ring_rgb, ring.astype(np.float64)))

    # Rim: a leather tube lit from the upper left.
    inside = np.abs(t) < 1.0
    tt = np.clip(t, -1.0, 1.0)
    nz = np.sqrt(np.clip(1.0 - tt ** 2, 0.0, 1.0))
    ux, uy = dx / np.maximum(r, 1e-6), dy / np.maximum(r, 1e-6)
    leather = np.array([0.105, 0.105, 0.115])
    rng = np.random.default_rng(7)
    grain = np.asarray(Image.fromarray((rng.random((n // 8, n // 8)) * 255).astype(np.uint8)).resize(
        (n, n), Image.BILINEAR), dtype=np.float64) / 255.0
    rim_rgb = shade(tt * ux, tt * uy, nz, leather, spec_power=10, spec=0.16, amb=0.42)
    rim_rgb *= (0.93 + 0.14 * grain)[..., None]
    # Perforated grips.
    holes = (np.sin(x * 0.075) * np.sin(y * 0.075) > 0.85) & (grip > 0.55) & (np.abs(tt) < 0.72)
    rim_rgb[holes] *= 0.55
    # Top-centre marker.
    marker = (np.abs(ang) < 0.055) & inside
    mark_rgb = shade(tt * ux, tt * uy, nz, np.array([0.98, 0.58, 0.10]), spec_power=14, spec=0.25, amb=0.5)
    rim_rgb[marker] = mark_rgb[marker]
    # Stitching along the grips' edges.
    for edge_t in (-0.82, 0.82):
        on_line = (np.abs(tt - edge_t) < 0.07) & (grip > 0.5) & inside
        dash = (np.sin(ang * 260.0) > 0.2)
        rim_rgb[on_line & dash] = np.array([0.55, 0.56, 0.58])
    # A faint light line round the outside keeps the dark rim readable over
    # asphalt and in shadow.
    rim_rgb += (np.clip((tt - 0.80) / 0.12, 0.0, 1.0) * (1.0 - np.clip((tt - 0.93) / 0.07, 0.0, 1.0)) * 0.10)[..., None]
    edge_aa = np.clip((1.0 - np.abs(t)) * hw / (0.004 * n), 0.0, 1.0)
    img = over(img, layer(n, rim_rgb, edge_aa * inside))

    out = rgba(img).resize((size, size), Image.LANCZOS)
    out.save(OUT / "steering_wheel.png")
    print("steering_wheel.png", out.size)


def button_round(size=256):
    n = size * SS
    c = n / 2.0
    x, y = grid(n)
    dx, dy = x - c, y - c
    r = np.hypot(dx, dy)
    R = 0.44 * n
    img = np.zeros((n, n, 4))
    disc = (r < R).astype(np.float64)
    sh = Image.fromarray((disc * 255).astype(np.uint8), "L").filter(ImageFilter.GaussianBlur(0.035 * n))
    sh = np.roll(np.asarray(sh, dtype=np.float64) / 255.0, int(0.025 * n), axis=0)
    img = over(img, layer(n, np.zeros(3), sh * 0.5))
    # Face: a slightly domed dark disc, lit from above.
    k = np.clip(r / R, 0, 1)
    nz = np.sqrt(np.clip(1.0 - 0.35 * k ** 2, 0.0, 1.0))
    face = shade(dx / R * 0.35, dy / R * 0.35, nz, np.array([0.16, 0.17, 0.19]), spec_power=30, spec=0.10, amb=0.55)
    aa = np.clip((R - r) / (0.006 * n), 0, 1)
    img = over(img, layer(n, face, aa))
    # Bevel: light along the top of the rim, dark along the bottom.
    ring = np.clip(1.0 - np.abs(r - (R - 0.02 * n)) / (0.018 * n), 0, 1)
    top = np.clip(-dy / R, -1, 1)
    bevel = np.where(top[..., None] > 0, np.array([1.0, 1.0, 1.0]), np.array([0.0, 0.0, 0.0]))
    img = over(img, layer(n, bevel, ring * np.abs(top) * 0.28))
    out = rgba(img).resize((size, size), Image.LANCZOS)
    out.save(OUT / "button_round.png")
    print("button_round.png", out.size)


TEXT_PX_PER_EM = 256  # course_builder.gd reads the same scale


def road_texts():
    """The words painted on the road (course.json markings.texts), as white-on-
    transparent images: a fixed texture, where a Label3D's live glyph atlas
    made them vanish for single frames on phones."""
    import hashlib
    import json

    from PIL import ImageFont
    course = json.loads((ROOT / "game" / "data" / "course.json").read_text(encoding="utf-8"))
    out_dir = ROOT / "game" / "assets" / "textures"
    font = ImageFont.truetype(str(ROOT / "game" / "assets" / "fonts" / "Inter.ttf"), TEXT_PX_PER_EM)
    try:
        font.set_variation_by_axes([700])
    except (OSError, ValueError):
        pass
    for t in course["markings"]["texts"]:
        text = t["text"]
        left, top, right, bottom = font.getbbox(text)
        pad = 12
        im = Image.new("RGBA", (right - left + 2 * pad, bottom - top + 2 * pad), (255, 255, 255, 0))
        ImageDraw.Draw(im).text((pad - left, pad - top), text, font=font, fill=(255, 255, 255, 255))
        name = "road_text_%s.png" % hashlib.md5(text.encode("utf-8")).hexdigest()[:8]
        im.save(out_dir / name)
        print(name, im.size)


if __name__ == "__main__":
    steering_wheel()
    button_round()
    road_texts()
