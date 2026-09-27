"""
Downloads the CC0 surface textures from Poly Haven and prepares them for the game.

    python pipeline/prepare_textures.py

Output: game/assets/textures/<surface>/{albedo,normal,arm}.jpg  (1k, tileable)
  asphalt  <- asphalt_pit_lane   (colour pulled towards neutral grey)
  concrete <- asphalt_04         (light concrete of the exercise pads and kerbs)
  grass    <- leafy_grass        (re-coloured to a watered green lawn)
and game/assets/sky/sky_1k.hdr   <- kloofendal_48d_partly_cloudy_puresky

All sources are CC0 (https://polyhaven.com/license).
"""
import json
import shutil
import time
import urllib.request
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
TEX = ROOT / "game" / "assets" / "textures"
SKY = ROOT / "game" / "assets" / "sky"
API = "https://api.polyhaven.com/files/"
HEADERS = {"User-Agent": "avtodrom-asset-pipeline/1.0"}

SURFACES = {
    "asphalt": "asphalt_pit_lane",
    "concrete": "asphalt_04",
    "grass": "leafy_grass",
}
MAPS = {"albedo": "Diffuse", "normal": "nor_gl", "arm": "arm"}


def fetch(url: str, dest: Path) -> None:
    for attempt in range(6):
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=60) as r, open(dest, "wb") as f:
                shutil.copyfileobj(r, f)
            return
        except Exception as exc:  # flaky TLS on some networks: retry
            print(f"  retry {attempt + 1}: {exc}")
            time.sleep(2)
    raise RuntimeError(f"download failed: {url}")


def files(asset: str) -> dict:
    with urllib.request.urlopen(urllib.request.Request(API + asset, headers=HEADERS), timeout=60) as r:
        return json.load(r)


def neutralise(path: Path, saturation: float, value: float, hue_shift: float = 0.0) -> None:
    im = cv2.imread(str(path))
    hsv = cv2.cvtColor(im, cv2.COLOR_BGR2HSV).astype(np.float32)
    hsv[..., 0] = (hsv[..., 0] + hue_shift) % 180
    hsv[..., 1] *= saturation
    hsv[..., 2] = np.clip(hsv[..., 2] * value, 0, 255)
    cv2.imwrite(str(path), cv2.cvtColor(hsv.astype(np.uint8), cv2.COLOR_HSV2BGR), [cv2.IMWRITE_JPEG_QUALITY, 92])


def lawnify(path: Path) -> None:
    im = cv2.imread(str(path))
    hsv = cv2.cvtColor(im, cv2.COLOR_BGR2HSV).astype(np.float32)
    h = hsv[..., 0]
    hsv[..., 0] = np.clip(h - np.median(h) + 42.0, 30, 64)
    hsv[..., 1] = np.clip(hsv[..., 1] * 1.25 + 22, 0, 255)
    hsv[..., 2] = np.clip(hsv[..., 2] * 0.88, 0, 255)
    cv2.imwrite(str(path), cv2.cvtColor(hsv.astype(np.uint8), cv2.COLOR_HSV2BGR), [cv2.IMWRITE_JPEG_QUALITY, 92])


def main() -> None:
    for surface, asset in SURFACES.items():
        out = TEX / surface
        out.mkdir(parents=True, exist_ok=True)
        meta = files(asset)
        for name, key in MAPS.items():
            url = meta[key]["1k"]["jpg"]["url"]
            print(f"{surface}/{name}.jpg <- {url}")
            fetch(url, out / f"{name}.jpg")
        (out / "SOURCE.txt").write_text(f"Poly Haven '{asset}' (CC0) https://polyhaven.com/a/{asset}\n", encoding="utf-8")
    neutralise(TEX / "asphalt" / "albedo.jpg", saturation=0.35, value=0.95, hue_shift=0.0)
    neutralise(TEX / "concrete" / "albedo.jpg", saturation=0.6, value=1.08)
    lawnify(TEX / "grass" / "albedo.jpg")

    SKY.mkdir(parents=True, exist_ok=True)
    sky = files("kloofendal_48d_partly_cloudy_puresky")["hdri"]["1k"]["hdr"]["url"]
    print("sky <-", sky)
    fetch(sky, SKY / "sky_1k.hdr")
    (SKY / "SOURCE.txt").write_text(
        "Poly Haven 'kloofendal_48d_partly_cloudy_puresky' (CC0) "
        "https://polyhaven.com/a/kloofendal_48d_partly_cloudy_puresky\n", encoding="utf-8")


if __name__ == "__main__":
    main()
