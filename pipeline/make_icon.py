"""App icon: a steering wheel over the zmeyka, drawn at 2x and downsampled."""
import math
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
S = 2048  # supersampled canvas


def gradient(d):
    for y in range(S):
        t = y / S
        d.line([(0, y), (S, y)], fill=(int(12 + 8 * t), int(38 - 14 * t), int(48 - 10 * t), 255))


def stroke(d, pts, width, color):
    r = width / 2
    for i in range(len(pts) - 1):
        (x0, y0), (x1, y1) = pts[i], pts[i + 1]
        n = max(1, int(math.hypot(x1 - x0, y1 - y0) / (r * 0.25)))
        for k in range(n):
            t = k / n
            x, y = x0 + (x1 - x0) * t, y0 + (y1 - y0) * t
            d.ellipse([x - r, y - r, x + r, y + r], fill=color)


def art(background=True):
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if background:
        gradient(d)
    pts = [(S * 0.5 + S * 0.26 * math.sin(t / 399 * math.pi * 2.0), S * (1.05 - 1.1 * t / 399)) for t in range(400)]
    stroke(d, pts, S * 0.2, (58, 66, 74, 255))
    stroke(d, pts, S * 0.012, (238, 240, 242, 255))
    for k in range(0, 400, 26):
        stroke(d, pts[k:k + 12], S * 0.02, (244, 180, 0, 255))
    cx, cy, r = S / 2, S / 2, S * 0.3
    w = S * 0.06
    d.ellipse([cx - r - w / 2, cy - r - w / 2, cx + r + w / 2, cy + r + w / 2], fill=(255, 255, 255, 255))
    d.ellipse([cx - r + w / 2, cy - r + w / 2, cx + r - w / 2, cy + r - w / 2], fill=(0, 0, 0, 0))
    # Re-draw what the inner cut removed (road + background) inside the rim.
    inner = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    idr = ImageDraw.Draw(inner)
    if background:
        gradient(idr)
    stroke(idr, pts, S * 0.2, (58, 66, 74, 255))
    stroke(idr, pts, S * 0.012, (238, 240, 242, 255))
    for k in range(0, 400, 26):
        stroke(idr, pts[k:k + 12], S * 0.02, (244, 180, 0, 255))
    m = Image.new("L", (S, S), 0)
    ImageDraw.Draw(m).ellipse([cx - r + w / 2, cy - r + w / 2, cx + r - w / 2, cy + r - w / 2], fill=255)
    img.paste(inner, (0, 0), m)
    d = ImageDraw.Draw(img)
    for ang in (0, 180, 90):
        a = math.radians(ang)
        stroke(d, [(cx + math.cos(a) * r * 0.2, cy + math.sin(a) * r * 0.2),
                   (cx + math.cos(a) * (r - w * 0.3), cy + math.sin(a) * (r - w * 0.3))], S * 0.05, (255, 255, 255, 255))
    d.ellipse([cx - r * 0.24, cy - r * 0.24, cx + r * 0.24, cy + r * 0.24], fill=(47, 182, 107, 255))
    return img


def main():
    out = ROOT / "game" / "assets" / "ui"
    out.mkdir(parents=True, exist_ok=True)
    full = art(True)
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.22), fill=255)
    rounded = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    rounded.paste(full, (0, 0), mask)
    icon = rounded.resize((1024, 1024), Image.LANCZOS)
    icon.save(ROOT / "game" / "icon.png")
    icon.save(out / "icon_1024.png")
    icon.resize((192, 192), Image.LANCZOS).save(out / "icon_192.png")
    icon.resize((256, 256), Image.LANCZOS).save(out / "icon.ico",
                                               sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)])
    bg = Image.new("RGBA", (S, S))
    gradient(ImageDraw.Draw(bg))
    bg.resize((432, 432), Image.LANCZOS).save(out / "icon_adaptive_bg.png")
    fg = art(False)
    safe = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    safe.alpha_composite(fg.resize((int(S * 0.66), int(S * 0.66)), Image.LANCZOS), (int(S * 0.17), int(S * 0.17)))
    safe.resize((432, 432), Image.LANCZOS).save(out / "icon_adaptive_fg.png")
    print("icons ->", out)


if __name__ == "__main__":
    main()
