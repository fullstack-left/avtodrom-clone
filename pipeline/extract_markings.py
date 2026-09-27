"""
Sxemadagi oq yo'l chiziqlarini (bo'yoq) vektor ko'rinishga o'tkazadi.

Natija: game/data/markings_auto.json
  lines — ingichka chiziqlar (chekka, o'q, uzuq chiziqlar, yozuvlar):
          {"w": kenglik_m, "p": [[x, z], ...]}
  polys — qalin shakllar (zebra, strelkalar, to'xtash chiziqlari):
          [[x, z], ...] (soat mili bo'yicha emas — Godot o'zi uchburchaklaydi)

Bordyurlar (o't orollari atrofidagi oq halqa) bo'yoq emas — ular 3D model
sifatida quriladi, shuning uchun o't yaqinidagi oq piksellar chiqarib tashlanadi.

Ishlatish:  python pipeline/extract_markings.py [--debug]
"""
import json
import sys
from pathlib import Path

import cv2
import numpy as np
from skimage.morphology import skeletonize

sys.path.insert(0, str(Path(__file__).resolve().parent))
from extract_layout import CX, CY, FENCE_PX, PX_PER_M, ROOT, SRC, remove_icons  # noqa: E402

OUT = ROOT / "game" / "data" / "markings_auto.json"


def world(x, y):
    return [round((float(x) - CX) / PX_PER_M, 3), round((float(y) - CY) / PX_PER_M, 3)]


def trace_skeleton(sk):
    """1 piksellik skeletni tarmoqlanish nuqtalarida bo'lingan polilinyalarga ajratadi."""
    ys, xs = np.nonzero(sk)
    pts = set(zip(xs.tolist(), ys.tolist()))
    nb = [(-1, -1), (0, -1), (1, -1), (-1, 0), (1, 0), (-1, 1), (0, 1), (1, 1)]

    def neigh(p):
        return [(p[0] + dx, p[1] + dy) for dx, dy in nb if (p[0] + dx, p[1] + dy) in pts]

    deg = {p: len(neigh(p)) for p in pts}
    visited_edges = set()
    lines = []

    def walk(a, b):
        path = [a, b]
        visited_edges.add((a, b))
        visited_edges.add((b, a))
        prev, cur = a, b
        while deg[cur] == 2:
            nxt = [n for n in neigh(cur) if n != prev]
            if not nxt:
                break
            n = nxt[0]
            if (cur, n) in visited_edges:
                break
            visited_edges.add((cur, n))
            visited_edges.add((n, cur))
            path.append(n)
            prev, cur = cur, n
        return path

    nodes = [p for p in pts if deg[p] != 2]
    for a in nodes:
        for b in neigh(a):
            if (a, b) not in visited_edges:
                lines.append(walk(a, b))
    # Faqat 2-darajali nuqtalardan iborat yopiq halqalar.
    for p in pts:
        if deg[p] == 2:
            for b in neigh(p):
                if (p, b) not in visited_edges:
                    path = walk(p, b)
                    path.append(p)
                    lines.append(path)
    return lines


def simplify(path, eps):
    arr = np.array(path, np.float32).reshape(-1, 1, 2)
    closed = len(path) > 3 and path[0] == path[-1]
    ap = cv2.approxPolyDP(arr, eps, closed)[:, 0, :]
    return ap.tolist(), closed


def chaikin(pts, closed, iters=1):
    p = np.array(pts, np.float64)
    for _ in range(iters):
        if len(p) < 3:
            break
        q = []
        rng = range(len(p)) if closed else range(len(p) - 1)
        if not closed:
            q.append(p[0])
        for i in rng:
            a, b = p[i], p[(i + 1) % len(p)]
            q.append(0.75 * a + 0.25 * b)
            q.append(0.25 * a + 0.75 * b)
        if not closed:
            q.append(p[-1])
        p = np.array(q)
    return p.tolist()


def main(debug=False):
    img = cv2.imread(str(SRC))
    clean = remove_icons(img)
    hsv = cv2.cvtColor(clean, cv2.COLOR_BGR2HSV).astype(np.int32)
    h, s, v = hsv[..., 0], hsv[..., 1], hsv[..., 2]
    grass = ((h >= 25) & (h <= 55) & (s >= 70)).astype(np.uint8)
    grass = cv2.morphologyEx(grass, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    near_grass = cv2.dilate(grass, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (15, 15))).astype(bool)

    white = (s < 50) & (v >= 195)
    x0, y0, x1, y1 = [int(round(t)) for t in FENCE_PX]
    inside = np.zeros(white.shape, bool)
    inside[y0 + 7 : y1 - 6, x0 + 7 : x1 - 6] = True
    paint = (white & inside & ~near_grass).astype(np.uint8)

    n, lab, stats, _ = cv2.connectedComponentsWithStats(paint, connectivity=8)
    lines, polys = [], []
    dbg = img.copy() if debug else None
    for i in range(1, n):
        x, y, w, hh, area = stats[i]
        if area < 8:
            continue
        comp = (lab[y : y + hh, x : x + w] == i)
        sk = skeletonize(comp)
        sk_len = max(int(sk.sum()), 1)
        mean_w = area / sk_len
        if mean_w <= 3.4 and max(w, hh) >= 8:
            for path in trace_skeleton(sk):
                if len(path) < 4:
                    continue
                pts, closed = simplify([(px + x, py + y) for px, py in path], 0.8)
                if len(pts) < 2:
                    continue
                sm = chaikin(pts, closed, 1)
                lines.append({"w": round(float(np.clip(mean_w / PX_PER_M * 0.8, 0.10, 0.25)), 3),
                              "p": [world(px, py) for px, py in sm]})
                if debug:
                    cv2.polylines(dbg, [np.array(sm, np.int32)], closed, (255, 0, 0), 1)
        else:
            cnts, _ = cv2.findContours(comp.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
            for c in cnts:
                if cv2.contourArea(c) < 6:
                    continue
                ap = cv2.approxPolyDP(c.astype(np.float32), 0.7, True)[:, 0, :] + np.array([x, y], np.float32)
                if len(ap) < 3:
                    continue
                polys.append([world(px, py) for px, py in ap])
                if debug:
                    cv2.polylines(dbg, [ap.astype(np.int32)], True, (0, 0, 255), 1)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"lines": lines, "polys": polys}, separators=(",", ":")), encoding="utf-8")
    print(f"lines={len(lines)} polys={len(polys)} -> {OUT} ({OUT.stat().st_size // 1024} KB)")
    if debug:
        cv2.imwrite(str(ROOT / "reference" / "debug_markings.png"), dbg)


if __name__ == "__main__":
    main("--debug" in sys.argv)
