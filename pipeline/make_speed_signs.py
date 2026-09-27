"""Derives the speed-limit variants the avtodrom needs (3.24 "20"/"40", 4.7 "20")
from the official 3.24 / 4.7 images by repainting the numerals."""
import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
SIGNS = ROOT / "game" / "assets" / "signs"
FONT = "C:/Windows/Fonts/arialbd.ttf"


def repaint(src_code: str, text: str, out_code: str, fill_rgb, text_rgb, clear: float = 0.30) -> None:
    im = Image.open(SIGNS / f"{src_code}.png").convert("RGBA")
    w, h = im.size
    d = ImageDraw.Draw(im)
    cx, cy = w / 2, h / 2
    r = w * clear  # clears the numerals, keeps the red/blue ring
    d.ellipse((cx - r, cy - r * 0.95, cx + r, cy + r * 0.95), fill=fill_rgb + (255,))
    size = int(h * 0.40)
    font = ImageFont.truetype(FONT, size)
    bbox = d.textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    d.text((cx - tw / 2 - bbox[0], cy - th / 2 - bbox[1]), text, font=font, fill=text_rgb + (255,))
    im.save(SIGNS / f"{out_code}.png", optimize=True)


def main() -> None:
    blue = Image.open(SIGNS / "4.7.png").convert("RGB").getpixel((40, 128))
    repaint("3.24", "20", "3.24-20", (255, 255, 255), (20, 20, 20))
    repaint("3.24", "40", "3.24-40", (255, 255, 255), (20, 20, 20))
    repaint("4.7", "20", "4.7-20", blue, (255, 255, 255), clear=0.41)
    meta = json.loads((SIGNS / "signs.json").read_text(encoding="utf-8"))
    for code, base in (("3.24-20", "3.24"), ("3.24-40", "3.24"), ("4.7-20", "4.7")):
        meta[code] = dict(meta[base], file=f"{code}.png")
    (SIGNS / "signs.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
    print("ok, blue =", blue)


if __name__ == "__main__":
    main()
