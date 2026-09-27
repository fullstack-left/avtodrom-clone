"""
Avtodrom course definition -> game/data/course.json (+ surface/edge grids).

The geometry comes from the official Tashkent exam-centre scheme
(reference/scheme_landscape.jpg, 11 px = 1 m). Grass islands and concrete
pads are traced automatically (extract_layout.py); everything with a rule
attached to it — stop lines, start/finish, fixation lines, the route, the
exercise zones, signs and traffic lights — is authored here in scheme pixel
coordinates so it can be checked against the picture (--debug renders an
overlay to reference/debug_course.png).

World frame (metres): X = scheme right, Z = scheme down, Y up; origin at the
centre of the fence rectangle. A heading/yaw of 0 faces -Z (scheme "up").

    python pipeline/course_def.py [--debug]
"""
import json
import math
import sys
from pathlib import Path

import cv2
import numpy as np
from shapely.geometry import LineString, Point, Polygon, box
from shapely.ops import unary_union

sys.path.insert(0, str(Path(__file__).resolve().parent))
from extract_layout import CX, CY, FENCE_PX, PX_PER_M, ROOT  # noqa: E402

LAYOUT = ROOT / "game" / "data" / "layout_auto.json"
OUT = ROOT / "game" / "data" / "course.json"
GRID_DIR = ROOT / "game" / "data"
SCHEME = ROOT / "reference" / "scheme_landscape.jpg"

S = PX_PER_M
CAR_HALF_WIDTH_M = 0.85


# ----------------------------------------------------------------------------- helpers
def w(x, y):
    """Scheme pixel -> world metres [X, Z]."""
    return [round((x - CX) / S, 3), round((y - CY) / S, 3)]


def wl(pts):
    return [w(x, y) for x, y in pts]


def px_of(p):
    return ((p[0] * S) + CX, (p[1] * S) + CY)


def yaw_of(dx, dz):
    """Yaw (deg) of a direction in world X/Z (0 = facing -Z)."""
    return round(math.degrees(math.atan2(-dx, -dz)), 2)


HEAD = {"N": 0.0, "W": 90.0, "S": 180.0, "E": -90.0}


def seg(p0, p1):
    return {"a": w(*p0), "b": w(*p1)}


# ----------------------------------------------------------------------------- layout
layout = json.loads(LAYOUT.read_text(encoding="utf-8"))

# The scheme draws signs, plates and the estakada piers on top of the kerbs, so the
# traced outlines keep a few dents (V notches, waists) and bumps (a kerb bulging
# round an icon) there. Each fix is a point next to the defect: the dent is filled
# by a 2 m closing, the bump shaved by a 2 m opening, and only the part touching
# that point changes. The kerb corners at the pads are left alone.
DENT_FIX_PX = [(1795, 1014), (1849, 1003), (676, 987), (1230, 542), (1521, 520), (1969, 497),
               (1220, 455), (1862, 417), (750, 197), (559, 197), (943, 315)]
BUMP_FIX_PX = [(710, 1001), (685, 715), (1266, 994), (1220, 566), (945, 339), (940, 298),
               (1869, 411), (1855, 411)]
# Where an outline must be convex (a rounded island nose, the two thin gore islands
# necked by their signs, a straight kerb under a pier or a sign plate) the part inside the box is replaced by its convex hull.
HULL_BOX_PX = [(1738, 960, 1790, 1008), (1778, 1004, 1835, 1026), (240, 545, 300, 590), (490, 540, 560, 590), (915, 290, 962, 345), (735, 188, 765, 215), (545, 188, 575, 215), (1848, 405, 1876, 432)]
# The box island's grass runs on under the two direction signs at its NE corner,
# but the tracer splits it there: the islands this patch touches become one, with
# the straight top kerb and the rounded corner of the scheme.
ISLAND_JOIN_PX = [[(1700, 655), (1755, 655), (1766, 658), (1774, 665), (1779, 675), (1781, 686), (1700, 686)]]
# Behind each parallel-parking pocket the kerb steps down to the road and runs
# straight under the P sign and its plates: (x0, y0, x1, y1) is island, below y1 is road.
KERB_STEP_BOX_PX = [(1480, 495, 1550, 531), (1725, 495, 1800, 528), (1975, 495, 2030, 528)]
# Straight kerb faces where the tracer followed sign icons past the kerb.
ISLAND_CUT_PX = [(1781.8, 995, 1853.3, 1012.5), (2025, 488, 2045, 530), (1110, 470, 1129, 520), (1229, 533, 1262, 580),
                 [(1150, 680), (1137, 700), (1132, 720), (1131, 800), (1110, 800), (1110, 680)]]
ISLAND_FILL_PX = [[(1782, 1044.4), (1792, 1049), (1805, 1051), (1826, 1051.3), (1826, 1030), (1782, 1030)],
                  [(683, 725), (683, 703), (690, 691), (702, 682), (718, 675), (740, 667), (760, 662), (760, 725)],
                  (990, 452, 1015, 528), (1129, 470, 1150, 520), (1200, 530, 1229, 572),
                  [(1150, 680), (1137, 700), (1132, 720), (1131, 800), (1165, 800), (1165, 680)]]
# Parallel-parking pockets (outer box). The concrete inside is authored as
# pocket_px(); the island around it is squared into a kerb U with an open mouth.
POCKETS_PX = [(1335, 497, 1480, 530), (1590, 497, 1725, 530), (1840, 497, 1975, 530)]
POCKET_ROW_PX = (1229.4, 2024.6, 530)  # x from the intersection corner to the hatched end, kerb y


def _zone(r):
    return box(*r) if len(r) == 4 else Polygon(r)


def pocket_px(x0, y0, x1, y1):
    return box(x0 + 4, y0 + 3, x1 - 4, y1)

FIX_R_PX = 2.0 * S


def _parts(g):
    return list(g.geoms) if hasattr(g, "geoms") else ([g] if not g.is_empty else [])


def _near_fix(part, points):
    """A small piece (under 4 m2) lying next to one of the fix points."""
    return part.area < 4.0 * S * S and any(part.distance(Point(q)) < 1.5 * S for q in points)


def _round_chamfers(pts, keep_out, iters=3):
    """Corner-cutting on the shallow bends (4-60 deg) the tracer leaves as facets;
    sharp corners and vertices next to a pad keep their place."""
    for _ in range(iters):
        out = []
        n = len(pts)
        for i in range(n):
            a, b, c = np.array(pts[i - 1]), np.array(pts[i]), np.array(pts[(i + 1) % n])
            u, v = b - a, c - b
            lu, lv = np.linalg.norm(u), np.linalg.norm(v)
            if lu < 1e-6 or lv < 1e-6:
                continue
            ang = math.degrees(math.acos(np.clip(u @ v / lu / lv, -1, 1)))
            if 4 < ang < 60 and keep_out.distance(Point(b)) > 0.5 * S:
                out.append(tuple(b - u / lu * min(0.25 * lu, 1.5 * S)))
                out.append(tuple(b + v / lv * min(0.25 * lv, 1.5 * S)))
            else:
                out.append(tuple(b))
        pts = out
    return pts


SNAP_DEG = 6.0
SNAP_MIN_LEN_PX = 2.5 * S


def regularize(poly_px, square_corners, near=None):
    """The scheme is a slightly skewed render, so traced kerbs and pads that are
    straight on the ground run up to ~2 deg off the site axes. Every straight
    edge (>= 2.5 m) within 6 deg of an axis is snapped onto it, and a short
    chamfer (< 1.2 m) between two snapped perpendicular edges becomes a square
    corner: always for pads, and for islands only next to a pad (`near`)."""
    g = poly_px.simplify(0.1 * S)
    v = [np.array(c, float) for c in list(g.exterior.coords)[:-1]]
    n = len(v)
    # Runs of consecutive edges all within SNAP_DEG of the same axis (a straight
    # kerb the tracer split into pieces) snap together onto one line.
    cand = []
    for i in range(n):
        d = v[(i + 1) % n] - v[i]
        ang = math.degrees(math.atan2(d[1], d[0])) % 180
        cand.append("h" if min(ang, 180 - ang) <= SNAP_DEG else ("v" if abs(ang - 90) <= SNAP_DEG else None))
    axis = [None] * n  # per edge: ("h", y) or ("v", x)
    start = next((i for i in range(n) if cand[i] != cand[i - 1]), 0)
    i = 0
    while i < n:
        k0 = (start + i) % n
        run = [k0]
        while i + len(run) < n and cand[(start + i + len(run)) % n] == cand[k0]:
            run.append((start + i + len(run)) % n)
        i += len(run)
        if cand[k0] is None:
            continue
        c = 1 if cand[k0] == "h" else 0
        lens = [float(np.hypot(*(v[(e + 1) % n] - v[e]))) for e in run]
        if sum(lens) < SNAP_MIN_LEN_PX:
            continue
        val = sum(L * (v[e][c] + v[(e + 1) % n][c]) / 2 for L, e in zip(lens, run)) / sum(lens)
        for e in run:
            axis[e] = (cand[k0], val)
    out = []
    for j in range(n):
        xs = [ax[1] for ax in (axis[j - 1], axis[j]) if ax and ax[0] == "v"]
        ys = [ax[1] for ax in (axis[j - 1], axis[j]) if ax and ax[0] == "h"]
        out.append(np.array([np.mean(xs) if xs else v[j][0], np.mean(ys) if ys else v[j][1]]))
    # square the short chamfers between perpendicular snapped edges
    for j in range(n):
        if axis[j] is not None:
            continue
        pa, pb = axis[j - 1], axis[(j + 1) % n]
        if not pa or not pb or pa[0] == pb[0]:
            continue
        if np.hypot(*(out[(j + 1) % n] - out[j])) > 1.2 * S:
            continue
        corner = np.array([pa[1] if pa[0] == "v" else pb[1], pa[1] if pa[0] == "h" else pb[1]])
        if not square_corners and (near is None or near.distance(Point(corner)) > 0.8 * S):
            continue
        out[j] = corner
        out[(j + 1) % n] = corner
    q = Polygon([tuple(c) for c in out]).buffer(0)
    return max(_parts(q), key=lambda g2: g2.area)


def join_islands(polys_px):
    for patch in ISLAND_JOIN_PX:
        bridge = Polygon(patch)
        hit = [p for p in polys_px if p.intersects(bridge)]
        polys_px = [p for p in polys_px if p not in hit] + [unary_union(hit + [bridge])]
    return polys_px


def clean_island(P, pads_px):
    closed = P.buffer(FIX_R_PX, join_style=1).buffer(-FIX_R_PX, join_style=1)
    add = [c for c in _parts(closed.difference(P)) if _near_fix(c, DENT_FIX_PX)]
    P = unary_union([P] + add)
    opened = P.buffer(-FIX_R_PX, join_style=1).buffer(FIX_R_PX, join_style=1)
    cut = [c for c in _parts(P.difference(opened)) if _near_fix(c, BUMP_FIX_PX)]
    Q = P.difference(unary_union(cut)) if cut else P
    for x0, y0, x1, y1 in HULL_BOX_PX:
        piece = Q.intersection(box(x0, y0, x1, y1))
        if not piece.is_empty:
            Q = Q.union(piece.convex_hull)
    for x0, y0, x1, y1 in KERB_STEP_BOX_PX:
        if Q.intersects(box(x0, y0, x1, y0 + 2)):
            Q = Q.union(box(x0, y0, x1, y1)).difference(box(x0, y1, x1, y1 + 20))
    for r in ISLAND_FILL_PX:
        if Q.intersects(_zone(r).buffer(2)):
            Q = Q.union(_zone(r))
    Q = Q.difference(unary_union([_zone(r) for r in ISLAND_CUT_PX]))
    for x0, y0, x1, y1 in POCKETS_PX:
        if Q.intersects(box(x0, y0 - 5, x1, y0)):
            Q = Q.union(box(x0 - 2, y0 - 5, x1 + 2, y1)).difference(box(x0 + 4, y0 + 3, x1 - 4, y1 + 20))
            # One straight kerb face along the whole pocket row.
            xa, xb, y = POCKET_ROW_PX
            row = box(xa, y - 6, xb, y).difference(unary_union([pocket_px(*k) for k in POCKETS_PX]))
            Q = Q.union(row).difference(box(xa, y, xb, y + 15))
    Q = Q.difference(pads_px)
    Q = max(_parts(Q.buffer(0)), key=lambda g: g.area)
    Q = Polygon(_round_chamfers(list(Q.exterior.coords)[:-1], pads_px)).buffer(0)
    # A 0.15 m close + open removes the slivers and teeth left where pieces were joined.
    r = 0.15 * S
    Q = max(_parts(Q.buffer(r, join_style=1).buffer(-2 * r, join_style=1).buffer(r, join_style=1)),
            key=lambda g: g.area)
    Q = regularize(Q, False, pads_px)
    Q = max(_parts(Q.difference(pads_px)), key=lambda g: g.area).simplify(0.05 * S)
    return [w(x, y) for x, y in list(Q.exterior.coords)[:-1]]


_pads_px_reg = [regularize(Polygon([px_of(q) for q in p]).buffer(0), True) for p in layout["pads"]]


def _is_pocket(poly):
    return 480 < poly.bounds[1] and poly.bounds[3] < 540  # traced parking pockets, authored instead


_layout_pads_px = unary_union([p for p in _pads_px_reg if not _is_pocket(p)] +
                              [pocket_px(*k) for k in POCKETS_PX])
islands_w = [clean_island(p, _layout_pads_px) for p in
             join_islands([Polygon([px_of(q) for q in isl]).buffer(0) for isl in layout["islands"]])]
islands_px = [Polygon([px_of(p) for p in isl]).buffer(0) for isl in islands_w]
islands_union_px = unary_union(islands_px)

pads_out = []
for poly in _pads_px_reg:
    p = [w(x, y) for x, y in list(poly.exterior.coords)[:-1]]
    minx, miny, maxx, maxy = poly.bounds
    if miny < 160 and 1070 < minx < 1160:  # the top zebra, not a pad
        continue
    if _is_pocket(poly):
        continue
    pads_out.append(p)

for x0, y0, x1, y1 in POCKETS_PX:
    pads_out.append(wl([(x0 + 4, y0 + 3), (x1 - 4, y0 + 3), (x1 - 4, y1), (x0 + 4, y1)]))


def tuck_under_islands(pad_w):
    """Pads and islands are traced separately, so thin asphalt slivers can show
    between a pad and its kerb. Each pad grows up to 0.5 m, but only over the gap
    to a kerb and under the island, where the kerb and grass hide it, never
    past its own end onto the road."""
    P = Polygon([px_of(q) for q in pad_w]).buffer(0)
    # Only the gaps: a closing of pad + islands fills the narrow strips between
    # them but adds nothing where the pad simply ends at the road.
    r = 0.55 * S
    closed = P.union(islands_union_px).buffer(r, join_style=2).buffer(-r, join_style=2)
    grown = P.union(closed.difference(islands_union_px).intersection(P.buffer(0.5 * S, join_style=2)))
    grown = grown.union(P.buffer(0.5 * S, join_style=2).intersection(islands_union_px))
    grown = max(_parts(grown.buffer(0)), key=lambda g: g.area).simplify(0.03 * S)
    return [w(x, y) for x, y in list(grown.exterior.coords)[:-1]]


pads_out = [tuck_under_islands(p) for p in pads_out]


# ----------------------------------------------------------------------------- route
def fillet_path(corners):
    """corners: [(x, y, r)] px; r = fillet radius at that corner (ignored at the ends)."""
    pts = [np.array(c[:2], float) for c in corners]
    out = [pts[0]]
    for i in range(1, len(pts) - 1):
        p0, p1, p2 = pts[i - 1], pts[i], pts[i + 1]
        r = corners[i][2]
        d0 = (p0 - p1) / np.linalg.norm(p0 - p1)
        d1 = (p2 - p1) / np.linalg.norm(p2 - p1)
        cosang = np.clip(np.dot(d0, d1), -1, 1)
        ang = math.acos(cosang)
        if r <= 0 or ang > math.pi - 1e-3:
            out.append(p1)
            continue
        t = r / math.tan(ang / 2)
        t = min(t, 0.49 * np.linalg.norm(p0 - p1), 0.49 * np.linalg.norm(p2 - p1))
        r_eff = t * math.tan(ang / 2)
        a = p1 + d0 * t
        b = p1 + d1 * t
        bis = (d0 + d1) / np.linalg.norm(d0 + d1)
        c = p1 + bis * (r_eff / math.sin(ang / 2))
        a0 = math.atan2(a[1] - c[1], a[0] - c[0])
        a1 = math.atan2(b[1] - c[1], b[0] - c[0])
        da = (a1 - a0 + math.pi) % (2 * math.pi) - math.pi
        n = max(4, int(abs(da) * r_eff / 3))
        for k in range(n + 1):
            ang_k = a0 + da * k / n
            out.append(c + r_eff * np.array([math.cos(ang_k), math.sin(ang_k)]))
    out.append(pts[-1])
    return out


def resample(poly_px, step_px):
    ls = LineString(poly_px)
    n = max(2, int(ls.length / step_px) + 1)
    return [np.array(ls.interpolate(i * ls.length / (n - 1)).coords[0]) for i in range(n)]


def smooth_open(pts, iters=3):
    p = np.array(pts, float)
    for _ in range(iters):
        q = p.copy()
        q[1:-1] = 0.25 * p[:-2] + 0.5 * p[1:-1] + 0.25 * p[2:]
        p = q
    return p


def pad_centerline(pad_index, start_hint, end_hint):
    """Medial axis of a pad (skeleton), ordered from start_hint to end_hint (px)."""
    poly = Polygon([px_of(q) for q in layout["pads"][pad_index]])
    minx, miny, maxx, maxy = [int(v) for v in poly.bounds]
    pad = 6
    mask = np.zeros((maxy - miny + 2 * pad, maxx - minx + 2 * pad), np.uint8)
    pts = np.array([(x - minx + pad, y - miny + pad) for x, y in poly.exterior.coords], np.int32)
    cv2.fillPoly(mask, [pts], 1)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
    from skimage.morphology import skeletonize

    sk = skeletonize(mask.astype(bool))
    ys, xs = np.nonzero(sk)
    nodes = {(x, y) for x, y in zip(xs, ys)}
    # Longest path between the pixels nearest the two hints (BFS on the skeleton).
    def nearest(h):
        hx, hy = h[0] - minx + pad, h[1] - miny + pad
        return min(nodes, key=lambda q: (q[0] - hx) ** 2 + (q[1] - hy) ** 2)

    a, b = nearest(start_hint), nearest(end_hint)
    from collections import deque

    prev = {a: None}
    dq = deque([a])
    while dq:
        cur = dq.popleft()
        if cur == b:
            break
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                n = (cur[0] + dx, cur[1] + dy)
                if n in nodes and n not in prev:
                    prev[n] = cur
                    dq.append(n)
    path = []
    cur = b
    while cur is not None:
        path.append((cur[0] + minx - pad, cur[1] + miny - pad))
        cur = prev.get(cur)
    path.reverse()
    path = smooth_open(resample(path, 3.0), iters=12)
    return [tuple(p) for p in path]


# Pad indices (layout_auto order): 3 = zmeyka A (west), 4 = zmeyka B (east),
# 8 = 90° corridor (lower), 9 = 90° corridor (upper, used by the exam route).
ZMEYKA_B = pad_centerline(4, (885, 900), (650, 695))
ZMEYKA_A = pad_centerline(3, (600, 950), (240, 715))

route_parts = []


def add(points):
    route_parts.append([tuple(p) for p in points])


# 1. Start, pedestrian crossing, estakada, top-left corner, down the left road.
# 2. Left road -> left turn -> 90° corridor (upper pad): east, left (north), right (east).
add(fillet_path([
    (1454, 156, 0), (128, 156, 150), (128, 433, 60), (424, 433, 52), (424, 250, 52), (1049, 250, 75),
    (1049, 520, 0),
]))
# The four passes through the intersection follow the scheme's lane arrows, one
# approach each: north STRAIGHT, west STRAIGHT, south LEFT, east RIGHT. Nowhere
# does the route cross a hatched gore or leave a lane against its arrow.
# 3. Intersection pass 1: from the north, STRAIGHT (south) down the south leg; at
#    the bottom road right (west), as its arrow and gore channel it, then right
#    into zmeyka B.
add(fillet_path([
    (1049, 520, 0), (1049, 1068, 45), (860, 1068, 45), (860, 955, 0),
]))
# 4. Zmeyka B from its south entrance (through the middle of the funnel) to the
#    north exit, then right (east).
zb = ZMEYKA_B
add(fillet_path([(860, 955, 0), (zb[0][0], zb[0][1] + 12, 0)]))
add([p for p in zb])
add(fillet_path([
    (zb[-1][0], zb[-1][1], 0), (650, 640, 45), (938, 640, 0),
]))
# 5. Intersection pass 2: from the west, STRAIGHT (east); right into the box pad P1.
add(fillet_path([
    (938, 640, 0), (1441, 640, 52), (1441, 930, 0),
]))
# 6. The box manoeuvre happens inside P1; out of it north and right (east), right
#    down the right road (emergency stop), right along the bottom road, right up
#    the south leg; intersection pass 3: from the south, LEFT (west) -> left
#    between the gore and the lane line -> railway.
add(fillet_path([
    (1441, 930, 0), (1441, 640, 52), (2015, 640, 55), (2015, 1068, 55), (1101, 1068, 45), (1101, 598, 60),
    (80, 606, 120), (80, 760, 0),
]))
# 7. Railway, then left along the outer bottom lane (acceleration section), left up
#    the right road and left onto the parking road.
add(fillet_path([
    (80, 760, 0), (80, 1113, 45), (2066, 1113, 45), (2066, 553, 60), (1700, 553, 0),
]))
# Parallel parking uses the pocket on the north side; afterwards move over to the
# south lane — west of the stop line the north lane ends at the island corner.
add(fillet_path([
    (1700, 553, 0), (1560, 596, 0), (1226, 596, 0),
]))
# 8. Intersection pass 4: from the east, turn RIGHT (north) -> round the island onto the
#    finish road -> finish line -> park.
add(fillet_path([
    (1226, 596, 0), (1101, 596, 45), (1101, 385, 105), (1960, 385, 0),
]))


def join_parts(parts):
    pts = []
    for part in parts:
        for p in part:
            if pts and np.hypot(p[0] - pts[-1][0], p[1] - pts[-1][1]) < 0.5:
                continue
            pts.append(p)
    return pts


ROUTE_PX = [tuple(p) for p in resample(join_parts(route_parts), 0.5 * S)]
ROUTE_LS = LineString(ROUTE_PX)


def s_at(x, y):
    """Arc length (m) of the route point nearest to (x, y) px — first occurrence
    along the route within 25 px."""
    best = None
    acc = 0.0
    for i in range(1, len(ROUTE_PX)):
        a, b = np.array(ROUTE_PX[i - 1]), np.array(ROUTE_PX[i])
        d = b - a
        L = np.linalg.norm(d)
        t = np.clip(np.dot(np.array([x, y]) - a, d) / (L * L), 0, 1)
        q = a + d * t
        dist = np.linalg.norm(np.array([x, y]) - q)
        if dist < 25:
            return round((acc + t * L) / S, 2)
        if best is None or dist < best[0]:
            best = (dist, acc + t * L)
        acc += L
    return round(best[1] / S, 2)


def s_after(x, y, s_min):
    """Like s_at but only considers route points past s_min (m)."""
    acc = 0.0
    for i in range(1, len(ROUTE_PX)):
        a, b = np.array(ROUTE_PX[i - 1]), np.array(ROUTE_PX[i])
        d = b - a
        L = np.linalg.norm(d)
        if (acc + L) / S >= s_min:
            t = np.clip(np.dot(np.array([x, y]) - a, d) / (L * L), 0, 1)
            q = a + d * t
            if np.linalg.norm(np.array([x, y]) - q) < 25 and (acc + t * L) / S >= s_min:
                return round((acc + t * L) / S, 2)
        acc += L
    raise ValueError(f"point {(x, y)} not on the route after s={s_min}")


# ----------------------------------------------------------------------------- exercises
EX = []


def exercise(**kw):
    EX.append(kw)
    return kw


def line(p0, p1):
    return {"a": w(*p0), "b": w(*p1)}


def zone(*rects):
    polys = [box(*r) for r in rects]
    u = unary_union(polys)
    geoms = [u] if u.geom_type == "Polygon" else list(u.geoms)
    return [wl(list(g.exterior.coords)[:-1]) for g in geoms]


NAMES = {
    "start": {"uz_latn": "Start", "uz_cyrl": "Старт", "ru": "Старт"},
    "crosswalk": {"uz_latn": "Piyodalar o'tish joyi", "uz_cyrl": "Пиёдалар ўтиш жойи", "ru": "Пешеходный переход"},
    "hill": {"uz_latn": "Estakada", "uz_cyrl": "Эстакада", "ru": "Эстакада"},
    "turn90": {"uz_latn": "90° burilish", "uz_cyrl": "90° бурилиш", "ru": "Поворот на 90°"},
    "intersection": {"uz_latn": "Chorraha", "uz_cyrl": "Чорраҳа", "ru": "Перекрёсток"},
    "box": {"uz_latn": "Boksga kirish", "uz_cyrl": "Боксга кириш", "ru": "Въезд в бокс"},
    "zigzag": {"uz_latn": "Ilon izi", "uz_cyrl": "Илон изи", "ru": "Змейка"},
    "emergency": {"uz_latn": "Avariya to'xtash", "uz_cyrl": "Авария тўхташ", "ru": "Аварийная остановка"},
    "parallel": {"uz_latn": "Parallel to'xtash", "uz_cyrl": "Параллел тўхташ", "ru": "Параллельная парковка"},
    "railway": {"uz_latn": "Temir yo'l", "uz_cyrl": "Темир йўл", "ru": "Ж/д переезд"},
    "accel": {"uz_latn": "Tezlashish", "uz_cyrl": "Тезлашиш", "ru": "Разгон"},
    "finish": {"uz_latn": "Finish", "uz_cyrl": "Финиш", "ru": "Финиш"},
}

# 1. START — south lane of the top road, heading west.
START_LINE_X = 1419
exercise(
    id="start", type="start", name=NAMES["start"],
    start_line=line((START_LINE_X, 92), (START_LINE_X, 180)),
    signal_off_distance=10.0,
    s0=0.0, s1=s_at(START_LINE_X - 11 * 12, 156),
    spawn={"pos": w(1454, 156), "yaw": HEAD["W"]},
)
# 2. Pedestrian crossing: stop within 1 m of the stop line, wait 3 s.
exercise(
    id="crosswalk", type="stop_line", name=NAMES["crosswalk"],
    stop_line=line((1167, 92), (1167, 180)), heading=HEAD["W"],
    max_gap=1.0, min_wait=3.0,
    s0=s_at(1167 + 11 * 25, 156), s1=s_at(1167 - 11 * 8, 156),
)
# 3. Estakada: ramp rising westwards from x=946 to the crest at x=695.
HILL_STOP_X = 772
HILL_FIX_X = HILL_STOP_X + round((4.48 + 1.6) * S)
exercise(
    id="hill", type="hill", name=NAMES["hill"],
    stop_line=line((HILL_STOP_X, 92), (HILL_STOP_X, 180)),
    fixation_line=line((HILL_FIX_X, 92), (HILL_FIX_X, 180)),
    heading=HEAD["W"], max_rollback=0.3, min_wait=3.0, max_wait=30.0,
    s0=s_at(960, 156), s1=s_at(640, 156),
)
# 4. 90-degree turns through the upper corridor pad (left then right).
exercise(
    id="turn90", type="corridor", name=NAMES["turn90"],
    start_line=line((326, 404), (326, 463)), end_line=line((530, 214), (530, 285)),
    time_limit=120.0,
    zone=zone((300, 200, 545, 470)),
    s0=s_at(326, 433), s1=s_at(530, 250),
)
# 5. Intersection, four passes (N straight, W straight, S left, E right).
INTERSECTION = {
    "stop_lines": {
        "N": line((1020, 514), (1078, 514)),
        "W": line((938, 616), (938, 660)),
        "E": line((1226, 572), (1226, 617)),
        "S": line((1072, 722), (1134, 722)),
    },
    "box": wl([(1016, 514), (1226, 514), (1226, 722), (1016, 722)]),
}
s_int1 = s_at(1049, 505)
s_int2 = s_after(930, 640, s_int1 + 50)
s_int3 = s_after(1101, 735, s_int2 + 50)
s_int4 = s_after(1235, 596, s_int3 + 50)
for k, (s_app, approach, turn) in enumerate(
        [(s_int1, "N", "straight"), (s_int2, "W", "straight"), (s_int3, "S", "left"), (s_int4, "E", "right")]):
    exercise(
        id=f"intersection{k + 1}", type="intersection", name=NAMES["intersection"],
        approach=approach, turn=turn, stop_line=INTERSECTION["stop_lines"][approach],
        box=INTERSECTION["box"], max_gap=1.0, green_time_limit=30.0,
        s0=round(s_app - 22.0, 2), s1=round(s_app + 22.0, 2),
    )
def kerb_dist_px(p, d):
    """Distance from p (inside a pad) to the first kerb face along unit direction d."""
    ray = LineString([p, (p[0] + d[0] * 60 * S, p[1] + d[1] * 60 * S)])
    hit = ray.intersection(islands_union_px.boundary)
    pts = [hit] if hit.geom_type == "Point" else list(getattr(hit, "geoms", []))
    return min(Point(p).distance(q) for q in pts)


EDGE_OFFSET = 0.35  # kerb edge line: centre this far from the kerb face
EDGE_WIDTH = 0.12
# Fixation lines of the box and parallel parking: broad white bands with the
# exam's wheel sensors under them.
FIX_WIDTH = 0.40
# 6. Box (razvorot): drive down P1, reverse east into the side bay, drive out north.
# Painted as at the centre: the rear wheels stop on the white fixation band;
# beyond it, just short of the back kerb, a yellow limit line must not be run over.
_BAY_C = (1540, 870)
BOX_KERB_X = _BAY_C[0] + kerb_dist_px(_BAY_C, (1, 0))
BOX_Y0 = _BAY_C[1] - kerb_dist_px(_BAY_C, (0, -1))
BOX_Y1 = _BAY_C[1] + kerb_dist_px(_BAY_C, (0, 1))
BOX_FIX_X = BOX_KERB_X - 1.30 * S
BOX_LIMIT_X = BOX_KERB_X - EDGE_OFFSET * S
BOX_LIMIT_WIDTH = 0.15
# Both lines run between the bay's side edge lines.
_BY0 = BOX_Y0 + (EDGE_OFFSET + EDGE_WIDTH / 2) * S
_BY1 = BOX_Y1 - (EDGE_OFFSET + EDGE_WIDTH / 2) * S
exercise(
    id="box", type="box", name=NAMES["box"],
    entry_line=line((1394, 764), (1488, 764)),
    fixation_line=line((BOX_FIX_X, _BY0), (BOX_FIX_X, _BY1)), fixation_width=FIX_WIDTH,
    limit_line=line((BOX_LIMIT_X, _BY0), (BOX_LIMIT_X, _BY1)), limit_width=BOX_LIMIT_WIDTH,
    fixation_side="rear", bay_heading=HEAD["W"],
    # Past the kerb: backed in too far, the rear overhang hangs over the grass,
    # and that is a badly placed car (№17), not a skipped exercise.
    bay=wl([(1487, 830), (BOX_KERB_X + 1.5 * S, 830), (BOX_KERB_X + 1.5 * S, 910), (1487, 910)]),
    zone=zone((1385, 700, BOX_KERB_X + 2.0 * S, 1015)),
    s0=s_at(1441, 700), s1=s_after(1441, 700, s_at(1441, 900)),
)
# 7. Zmeyka (east pad).
exercise(
    id="zigzag", type="corridor", name=NAMES["zigzag"],
    start_line=line((ZMEYKA_B[0][0] - 45, ZMEYKA_B[0][1]), (ZMEYKA_B[0][0] + 45, ZMEYKA_B[0][1])),
    end_line=line((ZMEYKA_B[-1][0] - 45, ZMEYKA_B[-1][1]), (ZMEYKA_B[-1][0] + 45, ZMEYKA_B[-1][1])),
    time_limit=120.0,
    zone=zone((600, 680, 925, 1000)),
    s0=s_at(*ZMEYKA_B[0]), s1=s_at(*ZMEYKA_B[-1]),
)
# 8. Emergency stop somewhere on the right road (southbound, after the box).
exercise(
    id="emergency", type="emergency", name=NAMES["emergency"],
    stop_within=2.0, hazard_within=3.0, signal_hold=5.0,
    trigger_s0=s_after(2015, 710, s_int2), trigger_s1=s_after(2015, 850, s_int2),
    s0=s_after(2015, 690, s_int2), s1=s_after(2015, 1040, s_int2),
)
# 9. Parallel parking into the east pocket (north side of the westbound road).
PK = POCKETS_PX[2]
PK_FIX_Y = PK[1] + round(0.80 * S)
exercise(
    id="parallel", type="parallel", name=NAMES["parallel"],
    pocket=wl([(PK[0], PK[1]), (PK[2], PK[1]), (PK[2], PK[3]), (PK[0], PK[3])]),
    fixation_line=line((PK[0] + 6, PK_FIX_Y), (PK[2] - 6, PK_FIX_Y)), fixation_width=FIX_WIDTH,
    fixation_side="right", park_heading=HEAD["W"],
    zone=zone((1690, 490, 2035, 622)),
    s0=s_after(2040, 553, s_int2), s1=s_after(1690, 553, s_int2),
)
# 10. Railway crossing (left road, southbound).
exercise(
    id="railway", type="stop_line", name=NAMES["railway"],
    stop_line=line((54, 936), (106, 936)), heading=HEAD["S"],
    max_gap=1.0, min_wait=3.0, skip_penalty="railway",
    s0=s_after(80, 870, s_int3), s1=s_after(80, 1000, s_int3),
)
# 11. Acceleration section (bottom outer lane, eastbound), 40 up / 20 down.
exercise(
    id="accel", type="accel", name=NAMES["accel"],
    min_speed=20.0, max_speed=40.0, gear=2, exit_speed=20.0,
    s0=s_after(420, 1113, s_int3 + 30), s1=s_after(1325, 1113, s_int3 + 30),
)
# 12. Finish line on the finish road (eastbound).
exercise(
    id="finish", type="finish", name=NAMES["finish"],
    finish_line=line((1878, 330), (1878, 414)),
    s0=s_after(1700, 385, s_int4), s1=round(ROUTE_LS.length / S, 2),
)

EX.sort(key=lambda e: e["s0"])
ORDER = [e["id"] for e in EX]

# Where each turn signal is checked (route turns at junctions).
TURNS = []


def turn(x, y, direction, s_min=0.0):
    TURNS.append({"s": s_after(x, y, s_min) if s_min else s_at(x, y), "dir": direction})


turn(128, 380, "left")                # left road -> 90° corridor
turn(1049, 1060, "right", s_int1)     # south leg -> bottom road
turn(860, 1068, "right", s_int1)      # into the zmeyka
turn(700, 640, "right", s_int1 + 100)  # zmeyka exit
turn(1441, 700, "right", s_int2)      # into the box pad
turn(2015, 700, "right", s_int2)      # onto the right road
turn(2015, 1060, "right", s_int2)     # onto the bottom road
turn(1101, 1060, "right", s_int2)     # up the south leg
turn(1101, 640, "left", s_int3 - 5)   # intersection 3
turn(160, 610, "left", s_int3)        # the gore -> left road
turn(80, 1100, "left", s_int3)        # onto the bottom lane
turn(2066, 1100, "left", s_int3 + 100)  # up the right road
turn(2066, 560, "left", s_int3 + 100)   # onto the parking road
turn(1101, 560, "right", s_int4 - 5)  # intersection 4
TURNS.sort(key=lambda t: t["s"])

# ----------------------------------------------------------------------------- markings
lines = []
polys = []
texts = []


def add_line(pts_px, width=0.12, dash=None, color="white"):
    lines.append({"w": width, "p": wl(pts_px), "dash": dash, "color": color})


def add_rect_px(x0, y0, x1, y1):
    polys.append(wl([(x0, y0), (x1, y0), (x1, y1), (x0, y1)]))


def add_stop_line(l, width=0.40):
    a = np.array(px_of(l["a"]))
    b = np.array(px_of(l["b"]))
    d = (b - a) / np.linalg.norm(b - a)
    n = np.array([-d[1], d[0]]) * width * S / 2
    polys.append(wl([tuple(a + n), tuple(b + n), tuple(b - n), tuple(a - n)]))


def zebra(x0, y0, x1, y1, along, stripe=0.5, gap=0.55):
    """Stripes parallel to the traffic direction `along` ('x' or 'y') spread across the other axis."""
    if along == "x":
        span = (y1 - y0) / S
        n = int((span + gap) // (stripe + gap))
        off = (span - (n * stripe + (n - 1) * gap)) / 2
        for i in range(n):
            a = y0 + (off + i * (stripe + gap)) * S
            add_rect_px(x0, a, x1, a + stripe * S)
    else:
        span = (x1 - x0) / S
        n = int((span + gap) // (stripe + gap))
        off = (span - (n * stripe + (n - 1) * gap)) / 2
        for i in range(n):
            a = x0 + (off + i * (stripe + gap)) * S
            add_rect_px(a, y0, a + stripe * S, y1)


zebra(1083, 97, 1146, 177, "x", 0.42, 0.66)
zebra(1020, 524, 1128, 572, "y", 0.62, 0.84)
zebra(1024, 664, 1128, 710, "y", 0.62, 0.84)
zebra(952, 580, 1016, 658, "x", 0.45, 0.63)
zebra(1139, 578, 1203, 656, "x", 0.45, 0.63)

for e in EX:
    for key in ("stop_line", "finish_line"):
        if key in e:
            add_stop_line(e[key])
    if e["type"] == "start":
        add_stop_line(e["start_line"], 0.5)
    if e["id"] == "hill":
        add_stop_line(e["fixation_line"], 0.30)
    if e["type"] == "box":
        add_stop_line(e["fixation_line"], e["fixation_width"])
        add_line([px_of(e["limit_line"]["a"]), px_of(e["limit_line"]["b"])], e["limit_width"], color="yellow")
# Every parking pocket has its fixation band, the same distance from its kerb.
for _k in POCKETS_PX:
    _fy = _k[1] + round(0.80 * S)
    add_stop_line(line((_k[0] + 6, _fy), (_k[2] - 6, _fy)), FIX_WIDTH)
for l in INTERSECTION["stop_lines"].values():
    add_stop_line(l)

# Painted words are readable by the driver the marking addresses.
texts.append({"text": "СТАРТ", "pos": w(1448, 136), "yaw": HEAD["W"], "size": 2.1})
texts.append({"text": "ФИНИШ", "pos": w(1852, 367), "yaw": HEAD["E"], "size": 2.1})

# Start box and the stop-line lane box on the top road.
add_line([(1170, 95), (1419, 95)], 0.15)
# The parking lot north of the finish road: a solid outline that shares its top
# edge with the start box and ends in a rounded head at the east end.
LOT_HEAD_PX = [(1882, 178), (1922, 187), (1950, 205), (1966, 231), (1970, 254), (1968, 279),
               (1955, 300), (1930, 316), (1885, 328)]
add_line([(1157, 178)] + LOT_HEAD_PX + [(1138, 328)], 0.15)


def arc_px(cx, cy, rx, ry, a0, a1, n=10):
    return [(cx + rx * math.cos(math.radians(a0 + (a1 - a0) * i / n)),
             cy + ry * math.sin(math.radians(a0 + (a1 - a0) * i / n))) for i in range(n + 1)]


# Outer edge line, 0.45 m inside the fence; the scheme rounds it at the two
# west corners (top-left r ~ 6.5 m, bottom-left r ~ 4.8 m) and keeps the east
# corners square.
_FI = 0.45 * S
_FX0, _FY0, _FX1, _FY1 = FENCE_PX[0] + _FI, FENCE_PX[1] + _FI, FENCE_PX[2] - _FI, FENCE_PX[3] - _FI
FENCE_LINE_PX = ([(_FX1, _FY0), (_FX1, _FY1)] + arc_px(_FX0 + 58, _FY1 - 58, 58, 58, 90, 180) +
                 arc_px(_FX0 + 78, _FY0 + 78, 78, 78, 180, 270))


# Lane dividers.
add_line([(1172, 134), (1417, 134)], 0.12)                               # start box: solid
# Top road: a solid divider that bends round the top-left corner into the
# left road, where it turns dashed.
add_line([(1080, 134), (210, 134)] + arc_px(210, 239, 105, 105, 270, 180), 0.12)
add_line([(105, 250), (105, 427)], 0.12, dash=[3.0, 6.0])                # left road
add_line([(1180, 372), (1860, 372)], 0.12, dash=[3.0, 6.0])              # finish road
add_line([(1236, 574), (2030, 574)], 0.12, dash=[3.0, 6.0])              # parallel road
# North leg: the divider runs up from the stop line and splits into two curves,
# one to the nose of the island west of it, one to the corner of the parking lot.
add_line(arc_px(1138, 400, 60, 70, -90, -180) + [(1078, 512)], 0.12)
add_line([(955, 221)] + arc_px(1025, 295, 53, 74, -90, 0), 0.12)
add_line([(1078, 295), (1078, 400)], 0.12)
add_line([(1075, 724), (1075, 990)], 0.12)                                # south leg divider
# One solid line runs from the road north of the zmeyka, down the left road
# (between its two lanes) and along the bottom road, with rounded corners.
add_line([(938, 621), (186, 621)] + arc_px(186, 701, 80, 80, 270, 180) +
         arc_px(160, 1040, 53, 55, 180, 90) + [(1020, 1095)], 0.12)
# One solid line from the east approach of the intersection along the parallel
# road, down the right road and back along the bottom road, with rounded corners.
add_line([(1226, 617), (1975, 617)] + arc_px(1975, 682, 65, 65, 270, 360) +
         arc_px(1980, 1035, 60, 59, 0, 90) + [(1140, 1094)], 0.12)

# Hatched gore areas.


HATCH_POLYS = []


def hatch(poly_px, spacing_m=1.4, angle_deg=45, width=0.3):
    poly = Polygon(poly_px)
    HATCH_POLYS.append(poly)
    minx, miny, maxx, maxy = poly.bounds
    diag = math.hypot(maxx - minx, maxy - miny)
    cx, cy = (minx + maxx) / 2, (miny + maxy) / 2
    a = math.radians(angle_deg)
    d = np.array([math.cos(a), math.sin(a)])
    n = np.array([-d[1], d[0]])
    k = -diag / 2
    while k < diag / 2:
        c = np.array([cx, cy]) + n * k
        ls = LineString([tuple(c - d * diag), tuple(c + d * diag)]).intersection(poly)
        for g in ([ls] if ls.geom_type == "LineString" else getattr(ls, "geoms", [])):
            if g.length > 3:
                add_line(list(g.coords), width)
        k += spacing_m * S
    add_line(list(poly.exterior.coords), 0.15)


# West gore between the two curved lane lines (left road / zmeyka road).
hatch([(62, 501), (75, 512), (88, 521), (100, 527), (125, 535), (150, 541), (175, 545), (200, 547), (214, 549),
       (212, 567), (214, 585), (195, 586), (180, 587), (150, 590), (122, 595), (100, 602), (88, 609), (75, 622),
       (62, 640)], 1.4, -45)
# East end of the parallel-parking road: full lane width, next to the island.
hatch([(2033, 403), (2089, 403), (2089, 534), (2033, 534)], 0.9, 16)
# Bottom road: the south-leg divider splits into two curved lines.
hatch([(1080, 1040), (1090, 1051), (1100, 1062), (1110, 1072), (1120, 1081), (1135, 1090), (1150, 1095),
       (1005, 1095), (1030, 1086), (1050, 1078), (1062, 1066), (1070, 1056), (1076, 1047)], 0.9, 7)

# Parking slots: 8 angled bays at the top, fitted to the scheme (7.0 x 8.9 m,
# 7.3 m apart). The outline runs once more over its first side so every corner
# gets a mitred join.
BAY_TOP_LEFT_PX = (1250.5, 182.5)
BAY_TOP_PX = (75.8, 12.5)
BAY_SIDE_PX = (-34.2, 91.8)
BAY_PITCH_PX = 80.0
for k in range(8):
    ax, ay = BAY_TOP_LEFT_PX[0] + k * BAY_PITCH_PX, BAY_TOP_LEFT_PX[1]
    a = (ax, ay)
    b = (ax + BAY_TOP_PX[0], ay + BAY_TOP_PX[1])
    c = (b[0] + BAY_SIDE_PX[0], b[1] + BAY_SIDE_PX[1])
    d = (ax + BAY_SIDE_PX[0], ay + BAY_SIDE_PX[1])
    add_line([a, b, c, d, a, b], 0.12)

# Arrows: (x, y px, heading, kind). kind: S, L, R, SL, SR. Positions and kinds are
# the scheme's, and the exam route obeys every one of them.
ARROWS = [
    (1258, 115, "W", "S"), (1258, 156, "W", "S"),
    (238, 115, "W", "L"), (238, 156, "W", "L"),
    (132, 352, "S", "L"), (84, 468, "S", "L"),
    (212, 606, "W", "L"),
    (884, 250, "E", "R"), (890, 388, "E", "R"),
    (1049, 466, "S", "S"),
    (1200, 351, "E", "S"), (1616, 351, "E", "S"), (1201, 390, "E", "SR"), (1616, 390, "E", "S"),
    (1532, 553, "W", "SR"), (1536, 598, "W", "S"),
    (1278, 596, "W", "R"),
    (1294, 638, "E", "SR"), (1746, 638, "E", "SR"),
    (876, 640, "E", "S"),
    (730, 1068, "W", "R"), (967, 1064, "W", "SR"),
    (1205, 1064, "W", "R"),
    (1450, 1070, "W", "SR"), (1853, 1070, "W", "SR"),
    (372, 1116, "E", "S"), (1215, 1116, "E", "S"), (1920, 1112, "E", "L"),
    (2063, 725, "N", "L"), (2012, 945, "S", "R"),
    (1102, 760, "N", "L"),
    (1050, 966, "S", "R"),
    (82, 1058, "S", "L"),
]
arrows = [{"pos": w(x, y), "yaw": HEAD[h], "kind": k} for x, y, h, k in ARROWS]

# Railway rails (drawn as geometry in the game) across the left road.
railway = {"rails": [line((44, 965), (168, 965)), line((44, 987), (168, 987))], "gauge": 1.52}

# ----------------------------------------------------------------------------- estakada
# Deck spans the top road between x=946 (foot) and x=355 (foot), crest ~x=695.
EST = {
    "x_foot_east": w(946, 0)[0], "x_crest_east": w(725, 0)[0], "x_crest_west": w(665, 0)[0], "x_foot_west": w(355, 0)[0],
    "z_north": w(0, 90)[1], "z_south": w(0, 181)[1],
    "height": 1.8, "rail_height": 0.8,
}

# ----------------------------------------------------------------------------- signs
SIGNS = []


_ISLANDS_INSET = islands_union_px.buffer(-0.6 * S)


def sign(code, x, y, heading, plates=(), height=2.1, size=0.7):
    """heading: direction of the traffic the sign is for. A sign placed on the
    asphalt inside the fence is moved onto the nearest island (0.6 m in from
    the kerb) — poles never stand on the carriageway."""
    from shapely.ops import nearest_points

    p = Point(x, y)
    inside_fence = FENCE_PX[0] < x < FENCE_PX[2] and FENCE_PX[1] + 8 < y < FENCE_PX[3]
    if inside_fence and not islands_union_px.contains(p):
        q = nearest_points(_ISLANDS_INSET, p)[0]
        if q.distance(p) < 4.0 * S:
            x, y = q.x, q.y
    SIGNS.append({"code": code, "pos": w(x, y), "yaw": HEAD[heading], "plates": list(plates), "height": height,
                  "size": size})


# Top road (westbound): the right-hand side is the north fence line.
sign("3.24-20", 1425, 84, "W")                    # start: 20 km/h zone
sign("4.1.1", 1263, 84, "W")                      # start: straight on
sign("5.16.1", 1150, 84, "W")                     # pedestrian crossing
sign("2.5", 1176, 84, "W")
sign("1.14", 938, 84, "W")                        # steep ascent (estakada)
# STOP stands at the hill stop line, as in the exercise picture (the scheme draws it on the crest).
sign("2.5", HILL_STOP_X - 2, 91.5, "W")
sign("1.13", 616, 91.5, "W")                      # steep descent
# Scheme icons are drawn rotated so that the top of the sign points the way its
# traffic drives; a map arrow is read in that frame (down for southbound = straight).
sign("4.1.3", 38, 358, "S")                       # left road: left into the 90° corridor
sign("1.12.2", 224, 482, "E")                     # 90° corridor (upper): first turn left
sign("1.12.2", 523, 564, "E")                     # 90° corridor (lower): first turn left
sign("4.1.3", 266, 566, "W")                      # the gore: left onto the left road
sign("4.1.2", 892, 293, "E")                      # top loop: right
sign("3.19", 936, 317, "E")
sign("4.1.2", 934, 414, "E")                      # onto the north leg: right, yield
sign("2.4", 934, 430, "E")
sign("4.1.1", 1000, 440, "S")                     # north approach: straight (pass 1)
sign("5.15", 1202, 436, "E", plates=("7.6.4",))    # parking strip on the finish island
sign("4.1.1", 1277, 690, "E")                     # box island, north side: straight
sign("1.12.2", 910, 955, "N")                     # zmeyka B entrance (as on the scheme)
sign("1.12.2", 690, 955, "N")                     # zmeyka A entrance
sign("4.1.1", 696, 993, "N")
sign("2.4", 720, 695, "N")                        # zmeyka B exit: yield, keep right
sign("4.2.1", 703, 712, "N")
sign("2.4", 380, 700, "N")                        # zmeyka A exit: yield, keep right
sign("4.2.1", 362, 718, "N")
sign("3.18.1", 572, 672, "E")                     # no right turn into zmeyka A
sign("5.15", 1382, 760, "S")                      # boxes
sign("5.15", 1769, 753, "S")
sign("5.15", 1359, 994, "N")
sign("5.15", 1762, 991, "N")
sign("2.4", 1517, 700, "N")                       # box exits (north): yield, right only
sign("4.1.2", 1517, 718, "N")
sign("2.4", 1876, 716, "N")
sign("4.1.2", 1876, 734, "N")
sign("4.1.2", 1245, 980, "S")                     # box exits (south): right only, yield
sign("2.4", 1245, 997, "S")
sign("4.1.2", 1650, 1001, "S")
sign("2.4", 1650, 1018, "S")
sign("4.1.1", 1178, 1006, "N")                    # south leg, northbound
sign("4.1.3", 1148, 759, "N")                     # south approach: left
sign("4.1.2", 1943, 702, "E")
sign("5.15", 1990, 520, "W", plates=("7.6.4",))    # parallel pockets
sign("5.15", 1740, 520, "W", plates=("7.6.4",))
sign("5.15", 1490, 520, "W", plates=("7.6.4",))
sign("4.1.3", 2110, 554, "N")                     # right road: left onto the parking road
sign("1.3.1", 38, 900, "S")                       # railway (St Andrew's cross)
sign("2.5", 38, 925, "S")
sign("1.2", 38, 760, "S")
sign("4.1.3", 36, 1069, "S")                      # left road: left onto the bottom road
sign("3.24-40", 418, 1150, "E")                   # acceleration section
sign("4.7-20", 430, 1150, "E", height=1.35)
sign("3.24-20", 1325, 1150, "E")
sign("4.1.3", 2004, 1150, "E")                    # bottom road: left up the right road
sign("4.2.1", 1142, 474, "S")                     # on the nose of the finish-road island
sign("4.1.2", 1760, 690, "E")

# Mandatory-direction signs before the junction turns of the exam route that
# the scheme's own signs above leave uncovered (heading = the traffic they are
# for; placed on its right-hand side).
sign("4.1.2", 1380, 668, "E")                     # -> box pad P1 (right)
sign("4.1.2", 1995, 1010, "S")                    # right road -> inner bottom lane (right)
sign("4.1.2", 900, 1040, "W")                     # inner bottom lane -> zmeyka B (right)
sign("4.1.1", 880, 672, "E")                      # intersection, west approach: straight (pass 2)
sign("4.1.2", 1015, 1040, "S")                    # south leg -> inner bottom lane (right)
sign("4.1.2", 1180, 520, "W")                     # intersection, east approach: right (pass 4)

LIGHTS = [
    {"id": "N", "pos": w(998, 500), "yaw": HEAD["S"], "group": "NS"},
    {"id": "S", "pos": w(1148, 736), "yaw": HEAD["N"], "group": "NS"},
    {"id": "W", "pos": w(918, 676), "yaw": HEAD["E"], "group": "EW"},
    {"id": "E", "pos": w(1206, 520), "yaw": HEAD["W"], "group": "EW"},
]

# Lamp posts where the scheme shows them (the pole foot, next to the fence; the
# scheme is a perspective render, so the lamp heads lean away from its centre).
LAMP_POSTS = wl([(608, 50), (1350, 80), (2025, 80), (2110, 395), (2110, 888), (2021, 1145), (1346, 1145),
                 (670, 1142), (40, 1120), (45, 630), (45, 138)])


def check_street_furniture():
    """Poles must never stand in the car's way: at least 1.3 m from the route
    centre line, and on an island, on the estakada edge or outside the fence."""
    fence_poly = Polygon([(FENCE_PX[0], FENCE_PX[1]), (FENCE_PX[2], FENCE_PX[1]),
                          (FENCE_PX[2], FENCE_PX[3]), (FENCE_PX[0], FENCE_PX[3])])
    items = [("sign " + s_["code"], s_["pos"]) for s_ in SIGNS] + [("light " + l_["id"], l_["pos"]) for l_ in LIGHTS]
    problems = 0
    for label, pos in items:
        p = Point(*px_of(pos))
        d = ROUTE_LS.distance(p) / S
        on_island = islands_union_px.buffer(1.0).contains(p)
        outside = not fence_poly.contains(p) or p.y < FENCE_PX[1] + 8
        if d < 1.3 or not (on_island or outside):
            problems += 1
            print(f"WARNING: {label} at px {tuple(round(v) for v in px_of(pos))}: {d:.2f} m from the route, "
                  f"{'island' if on_island else ('outside' if outside else 'ON THE ROAD')}")
    return problems

# ----------------------------------------------------------------------------- grids
GRID_CELL = 0.1
fx0, fy0, fx1, fy1 = FENCE_PX
margin_m = 6.0
gx0 = (fx0 - CX) / S - margin_m
gz0 = (fy0 - CY) / S - margin_m
gw = int(((fx1 - fx0) / S + 2 * margin_m) / GRID_CELL)
gh = int(((fy1 - fy0) / S + 2 * margin_m) / GRID_CELL)


def grid_poly(poly_world):
    return np.array([[(x - gx0) / GRID_CELL, (z - gz0) / GRID_CELL] for x, z in poly_world], np.int32)


SURF = {"asphalt": 0, "concrete": 1, "curb": 2, "grass": 3, "outside": 4}
surface = np.full((gh, gw), SURF["outside"], np.uint8)
fence_w = [w(fx0, fy0), w(fx1, fy0), w(fx1, fy1), w(fx0, fy1)]
cv2.fillPoly(surface, [grid_poly(fence_w)], SURF["asphalt"])
for p in pads_out:
    cv2.fillPoly(surface, [grid_poly(p)], SURF["concrete"])
island_mask = np.zeros_like(surface)
for isl in islands_w:
    cv2.fillPoly(island_mask, [grid_poly(isl)], 1)
curb_cells = int(round(0.25 / GRID_CELL))
inner = cv2.erode(island_mask, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * curb_cells + 1, 2 * curb_cells + 1)))
surface[island_mask == 1] = SURF["curb"]
surface[inner == 1] = SURF["grass"]
import zlib  # noqa: E402

(GRID_DIR / "surface.bin").write_bytes(zlib.compress(surface.tobytes(), 9))

# Distance (cm, clamped 255) from every cell to the nearest island (kerb face):
# the control lines are painted 0.35 m off the kerbs.
dist = cv2.distanceTransform((1 - island_mask).astype(np.uint8), cv2.DIST_L2, 5) * GRID_CELL * 100.0
(GRID_DIR / "edge_distance.bin").write_bytes(zlib.compress(np.clip(dist, 0, 255).astype(np.uint8).tobytes(), 9))

# ----------------------------------------------------------------------------- output
route_w = [w(x, y) for x, y in ROUTE_PX]
data = {
    "version": 1,
    "source": "reference/scheme_landscape.jpg",
    "px_per_m": S,
    "fence": fence_w,
    "islands": islands_w,
    "pads": pads_out,
    "estakada": EST,
    "markings": {"lines": lines, "polys": polys, "texts": texts, "arrows": arrows,
                 "edge_offset": EDGE_OFFSET, "edge_width": EDGE_WIDTH, "fence_line": wl(FENCE_LINE_PX),
                 # As on the scheme, the kerb edge line stops at each parking pocket:
                 # none inside the pocket and none across its mouth. Across the back
                 # of the box the yellow limit line takes its place.
                 "edge_skip": [wl([(x0, y0), (x1 + 1, y0), (x1 + 1, y1 + 5), (x0, y1 + 5)])
                               for x0, y0, x1, y1 in POCKETS_PX] +
                              [wl([(BOX_LIMIT_X - 0.3 * S, _BY0), (BOX_KERB_X + 0.3 * S, _BY0),
                                   (BOX_KERB_X + 0.3 * S, _BY1), (BOX_LIMIT_X - 0.3 * S, _BY1)])]},
    "railway": railway,
    "signs": SIGNS,
    "lights": LIGHTS,
    "lamp_posts": LAMP_POSTS,
    "route": {"points": route_w, "step": 0.5, "length": round(ROUTE_LS.length / S, 2), "turns": TURNS},
    "exercises": EX,
    "order": ORDER,
    "intersection": INTERSECTION,
    "grids": {"origin": [round(gx0, 3), round(gz0, 3)], "cell": GRID_CELL, "width": gw, "height": gh,
              "surface": "res://data/surface.bin", "edge_distance": "res://data/edge_distance.bin",
              "surface_ids": SURF},
}
OUT.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
print(f"route {data['route']['length']:.0f} m, {len(EX)} exercises, {len(lines)} lines, {len(polys)} polys, "
      f"{len(arrows)} arrows, {len(SIGNS)} signs -> {OUT} ({OUT.stat().st_size // 1024} KB)")
print("order:", " -> ".join(ORDER))

# ----------------------------------------------------------------------------- validation
bad = []
for i, (x, y) in enumerate(ROUTE_PX):
    d = islands_union_px.distance(Point(x, y)) / S
    inside = islands_union_px.contains(Point(x, y))
    if inside or d < CAR_HALF_WIDTH_M:
        bad.append((i, round(x), round(y), round(d, 2)))
if bad:
    print(f"WARNING: {len(bad)} route samples closer than {CAR_HALF_WIDTH_M} m to an island, e.g. {bad[:12]}")
else:
    print("route clearance OK")
# A hatched gore is not to be driven on: the car body must stay off every one.
_gore_hits = [round(ROUTE_LS.distance(g) / S, 2) for g in HATCH_POLYS if ROUTE_LS.distance(g) < CAR_HALF_WIDTH_M * S]
if _gore_hits:
    print(f"WARNING: the route runs over a hatched gore (distances {_gore_hits} m)")
else:
    print("route clear of the hatched gores OK")
if check_street_furniture() == 0:
    print("signs and lights clear of the route OK")

if "--debug" in sys.argv:
    img = cv2.imread(str(SCHEME))
    for isl in islands_px:
        cv2.polylines(img, [np.array(isl.exterior.coords, np.int32)], True, (0, 0, 255), 1)
    cv2.polylines(img, [np.array(ROUTE_PX, np.int32)], False, (255, 0, 255), 2)
    for i in range(0, len(ROUTE_PX), 40):
        cv2.circle(img, (int(ROUTE_PX[i][0]), int(ROUTE_PX[i][1])), 2, (255, 255, 0), -1)
    for e in EX:
        for key in ("stop_line", "start_line", "end_line", "fixation_line", "finish_line", "entry_line"):
            if key in e:
                a, b = px_of(e[key]["a"]), px_of(e[key]["b"])
                cv2.line(img, (int(a[0]), int(a[1])), (int(b[0]), int(b[1])), (0, 255, 255), 2)
        p = ROUTE_PX[min(len(ROUTE_PX) - 1, int(e["s0"] / 0.5))]
        cv2.putText(img, e["id"], (int(p[0]) + 4, int(p[1]) - 4), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 0), 2)
        cv2.putText(img, e["id"], (int(p[0]) + 4, int(p[1]) - 4), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1)
    for t in TURNS:
        p = ROUTE_PX[min(len(ROUTE_PX) - 1, int(t["s"] / 0.5))]
        cv2.circle(img, (int(p[0]), int(p[1])), 5, (0, 200, 0) if t["dir"] == "left" else (200, 120, 0), -1)
    for i, b in enumerate(bad[:200]):
        cv2.circle(img, (b[1], b[2]), 4, (0, 0, 255), -1)
    for s_ in SIGNS:
        p = px_of(s_["pos"])
        cv2.rectangle(img, (int(p[0]) - 3, int(p[1]) - 3), (int(p[0]) + 3, int(p[1]) + 3), (255, 0, 0), -1)
    cv2.imwrite(str(ROOT / "reference" / "debug_course.png"), img)
    print("debug -> reference/debug_course.png")
