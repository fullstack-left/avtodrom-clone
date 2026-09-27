"""
Blender (headless) asset build for the Chevrolet Cobalt exam car (automatic).

    blender -b --python pipeline/blender/build_cobalt.py -- <chevrolet_cobalt_ltz.glb> <out.glb>

The source is a converted game-mod model: every wheel exists four times, the
materials are flat colours named after unrelated parts (one glossy black is
used for glass, trim and interior alike), and its proportions are a little
off (wheelbase/length 0.61 against the real car's 0.585). This script:
  * keeps one wheel set, drops the collision proxy;
  * maps the body onto the real dimensions: length 4479 mm and wheelbase
    2620 mm exactly (the cabin section is compressed smoothly, the wheel
    arches and overhangs keep one uniform scale), width/height scaled 0.87;
  * rescales the wheels to 185/75 R14 (radius 316.5 mm) and splits them into
    Wheel_XX (pivot at the hub) -> Spin_XX;
  * assigns semantic materials per part (paint, trim_black, chrome, window,
    lamp_glass, interior, ...) that the game replaces with its own PBR set;
  * separates the lamps (the source marks them with the classic
    left/right front/rear light colour codes), the steering wheel under a
    SteeringPivot (local Z = column axis), and adds MirrorEyeL/R empties at
    the door-mirror glass for the reversing mirror views;
  * decimates to a mobile budget and adds a convex CollisionHull.
Prints the wheel centres and the body footprint used by car.gd / the C++ preset.
"""
import math
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector

argv = sys.argv[sys.argv.index("--") + 1:]
SRC, OUT = argv[0], argv[1]

REAL_LENGTH = 4.479
REAL_WHEELBASE = 2.620
XZ_SCALE = 0.87
TYRE_RADIUS = 0.3165
# Wheel sets kept per corner (the others are duplicates, some offset inwards).
WHEEL_SETS = {"FR": "roda.002_", "RR": "roda.004_", "RL": "roda.008_", "FL": "roda.012_"}

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC)
scene = bpy.context.scene
collection = scene.collection


def meshes():
    return [o for o in scene.objects if o.type == "MESH"]


# --- 1. Flatten hierarchy, bake transforms ---------------------------------------------
for o in meshes():
    mw = o.matrix_world.copy()
    o.parent = None
    o.matrix_world = mw
for o in list(scene.objects):
    if o.type != "MESH":
        bpy.data.objects.remove(o, do_unlink=True)
for o in meshes():
    o.data = o.data.copy()
    m = o.matrix_world.copy()
    o.data.transform(m)
    if m.determinant() < 0.0:
        o.data.flip_normals()
    o.matrix_world = Matrix.Identity(4)

# --- 2. Drop the collision proxy and the duplicate wheels ------------------------------------
keep_wheels = tuple(WHEEL_SETS.values())
for o in list(meshes()):
    n = o.name
    drop = n.startswith("sentinel") or (n.startswith("roda") and not n.startswith(keep_wheels))
    if drop:
        bpy.data.objects.remove(o, do_unlink=True)


def bounds(objs):
    mn = Vector((1e9, 1e9, 1e9))
    mx = Vector((-1e9, -1e9, -1e9))
    for o in objs:
        for v in o.data.vertices:
            mn = Vector(map(min, mn, v.co))
            mx = Vector(map(max, mx, v.co))
    return mn, mx


# --- 3. Wheels: identify parts and centres (source units) ---------------------------------
wheel_parts = {}
wheel_centre = {}
for corner, prefix in WHEEL_SETS.items():
    parts = [o for o in meshes() if o.name.startswith(prefix)]
    wheel_parts[corner] = parts
    # The tyre is the part with the largest diameter.
    tyre = max(parts, key=lambda o: (bounds([o])[1].z - bounds([o])[0].z))
    tmn, tmx = bounds([tyre])
    wheel_centre[corner] = ((tmn + tmx) / 2, (tmx.z - tmn.z) / 2, tyre)

y_front = (wheel_centre["FL"][0].y + wheel_centre["FR"][0].y) / 2
y_rear = (wheel_centre["RL"][0].y + wheel_centre["RR"][0].y) / 2
z_axle = sum(c.z for c, _, _ in wheel_centre.values()) / 4
src_radius = sum(r for _, r, _ in wheel_centre.values()) / 4
body_objs = [o for o in meshes() if not o.name.startswith(keep_wheels)]
bmn, bmx = bounds(body_objs)
print(f"source: axles y {y_front:.3f} / {y_rear:.3f}, body y {bmn.y:.3f}..{bmx.y:.3f}, tyre r {src_radius:.3f}")

# --- 4. Longitudinal map y -> y' --------------------------------------------------------------
# Local scale g(y) = b outside the cabin core, a inside it, blended with a
# smoothstep; the core stops short of the wheel arches so they stay round.
ARCH_MARGIN = 0.45
BLEND = 0.35
core_lo = y_rear + ARCH_MARGIN
core_hi = y_front - ARCH_MARGIN


def smooth(t):
    t = min(max(t, 0.0), 1.0)
    return t * t * (3.0 - 2.0 * t)


def core_weight(y):
    return smooth((y - core_lo) / BLEND) * smooth((core_hi - y) / BLEND)


N = 6000
y0 = bmn.y - 0.2
y1 = bmx.y + 0.2
dy = (y1 - y0) / N
W = [0.0]
for i in range(N):
    ym = y0 + (i + 0.5) * dy
    W.append(W[-1] + core_weight(ym) * dy)


def W_at(y):
    t = (y - y0) / dy
    i = int(min(max(math.floor(t), 0), N - 1))
    f = t - i
    return W[i] * (1 - f) + W[i + 1] * f


wc = W_at(y_front) - W_at(y_rear)
overhangs = (bmx.y - bmn.y) - (y_front - y_rear)
b = (REAL_LENGTH - REAL_WHEELBASE) / overhangs
a_minus_b = (REAL_WHEELBASE - b * (y_front - y_rear)) / wc
a = b + a_minus_b
print(f"longitudinal scale: arches/overhangs {b:.4f}, cabin core {a:.4f}")


def fy_raw(y):
    return b * (y - y0) + a_minus_b * W_at(y)


y_mid = (fy_raw(y_front) + fy_raw(y_rear)) / 2


def fy(y):
    return fy_raw(y) - y_mid


def map_point(p):
    # x and z about the car centre line / axle height; wheel centre ends at TYRE_RADIUS
    return Vector((p.x * XZ_SCALE, fy(p.y), (p.z - z_axle) * XZ_SCALE + TYRE_RADIUS))


for o in body_objs:
    for v in o.data.vertices:
        v.co = map_point(v.co)
    o.data.update()

# Wheels: uniform scale about their own centre to the true tyre radius, then
# moved to the mapped hub position.
wheel_scale = TYRE_RADIUS / src_radius
wheel_report = {}
for corner, parts in wheel_parts.items():
    c, _, _ = wheel_centre[corner]
    target = map_point(c)
    for o in parts:
        for v in o.data.vertices:
            v.co = (v.co - c) * wheel_scale + target
        o.data.update()
    wheel_report[corner] = target

# --- 5. Semantic materials --------------------------------------------------------------------
SEMANTIC = ["paint", "trim_black", "chrome", "rim", "rubber", "metal", "brake_disc", "window", "lamp_glass",
            "lamp_orange", "lamp_red", "lamp_white", "interior", "interior_light", "plate", "mirror"]
sem = {}
for name in SEMANTIC:
    m = bpy.data.materials.new(name)
    sem[name] = m


def assign(o, rule):
    """rule: callable(source material name) -> semantic name"""
    for slot in o.material_slots:
        src = slot.material.name if slot.material else ""
        slot.material = sem[rule(src)]


def base(name):
    return name.split(".")[0]


def body_rule(src):
    s = base(src)
    if s == "primary":
        return "paint"
    if s in ("escape", "bancos"):
        return "chrome"
    if s == "painel":
        return "trim_black"
    if "light" in s:
        return "lamp_glass"
    return "trim_black"


def by_name(prefix):
    return [o for o in meshes() if o.name.startswith(prefix)]


def one(name):
    objs = [o for o in meshes() if o.name == name]
    return objs[0] if objs else None


def join(objs, name):
    objs = [o for o in objs if o is not None]
    if not objs:
        return None
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    if len(objs) > 1:
        bpy.ops.object.join()
    res = bpy.context.view_layer.objects.active
    res.name = name
    res.data.name = name
    return res


def split_by_x(obj, keep_outer_than, outer_name):
    """Moves the faces with |x| > keep_outer_than into a new object."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    inner = [f for f in bm.faces if abs(f.calc_center_median().x) <= keep_outer_than]
    bmesh.ops.delete(bm, geom=inner, context="FACES")
    outer_mesh = bpy.data.meshes.new(outer_name)
    bm.to_mesh(outer_mesh)
    bm.free()
    for mat in obj.data.materials:
        outer_mesh.materials.append(mat)
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    outer = [f for f in bm.faces if abs(f.calc_center_median().x) > keep_outer_than]
    bmesh.ops.delete(bm, geom=outer, context="FACES")
    bm.to_mesh(obj.data)
    bm.free()
    r = bpy.data.objects.new(outer_name, outer_mesh)
    collection.objects.link(r)
    return r


def split_by_side(obj, left_name, right_name):
    r = split_by_x_sign(obj, right_name)
    obj.name = left_name
    obj.data.name = left_name
    return obj, r


def split_by_x_sign(obj, right_name):
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    left = [f for f in bm.faces if f.calc_center_median().x < 0]
    bmesh.ops.delete(bm, geom=left, context="FACES")
    right_mesh = bpy.data.meshes.new(right_name)
    bm.to_mesh(right_mesh)
    bm.free()
    for mat in obj.data.materials:
        right_mesh.materials.append(mat)
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    right = [f for f in bm.faces if f.calc_center_median().x >= 0]
    bmesh.ops.delete(bm, geom=right, context="FACES")
    bm.to_mesh(obj.data)
    bm.free()
    r = bpy.data.objects.new(right_name, right_mesh)
    collection.objects.link(r)
    return r


# Wheels.
def wheel_rule_for(o, tyre):
    def rule(src):
        if o == tyre:
            return "rubber"
        s = base(src)
        if s == "roda":
            return "rim" if src != "roda.043" else "metal"
        if s == "escape":
            return "chrome"
        return "brake_disc"
    return rule


def new_empty(name, loc, rot_matrix=None):
    e = bpy.data.objects.new(name, None)
    collection.objects.link(e)
    m = Matrix.Translation(loc)
    if rot_matrix is not None:
        m = m @ rot_matrix.to_4x4()
    e.matrix_world = m
    return e


def set_origin(obj, point):
    obj.data.transform(Matrix.Translation(-point))
    obj.matrix_world = Matrix.Translation(point)


for corner, parts in wheel_parts.items():
    tyre = wheel_centre[corner][2]
    for o in parts:
        assign(o, wheel_rule_for(o, tyre))
    centre = wheel_report[corner]
    pivot = new_empty("Wheel_" + corner, centre)
    s = join(parts, "Spin_" + corner)
    set_origin(s, centre)
    s.parent = pivot
    s.matrix_parent_inverse = pivot.matrix_world.inverted()

# Lamps. Colour codes of the source: left/right front light = headlamps,
# left/right rear light = rear clusters.
head = join([one("fara_left front light_0"), one("fara_right front light_0")], "Lamp_Head")
assign(head, lambda s: "lamp_white")
turn_f = split_by_x(head, 0.72, "Lamp_TurnF")
assign(turn_f, lambda s: "lamp_orange")
split_by_side(turn_f, "Lamp_TurnFL", "Lamp_TurnFR")

fog = join([one("bump_front_ok.003_left front light_0"), one("bump_front_ok.003_right front light_0")], "Lamp_Fog")
assign(fog, lambda s: "lamp_white")

tail = join([one("ascende_left rear light_0"), one("ascende_right rear light.001_0")], "Lamp_Tail")
assign(tail, lambda s: "lamp_red")
turn_r = split_by_x(tail, 0.70, "Lamp_TurnR")
assign(turn_r, lambda s: "lamp_orange")
split_by_side(turn_r, "Lamp_TurnRL", "Lamp_TurnRR")

brake = join([one("luzdefreio_right rear light.001_0")], "Lamp_Brake")
assign(brake, lambda s: "lamp_red")

rev = join([one("lamp_bump_front_ok.0_0")], "Lamp_Reverse")
if rev:
    assign(rev, lambda s: "lamp_white")

side = join([one("lamp_02_bump_front_ok.0_0")], "Lamp_Side")
assign(side, lambda s: "lamp_orange")
split_by_side(side, "Lamp_TurnSL", "Lamp_TurnSR")

# Steering wheel.
sw_parts = by_name("steering_ok_")
ring = one("steering_ok_steering_ok.0_0")
verts = [v.co.copy() for v in ring.data.vertices]
c = sum(verts, Vector()) / len(verts)
cov = [[0.0] * 3 for _ in range(3)]
for v in verts:
    d = v - c
    for i in range(3):
        for j in range(3):
            cov[i][j] += d[i] * d[j]
m = Matrix(cov)
tr = m[0][0] + m[1][1] + m[2][2]
inv = Matrix(((tr, 0, 0), (0, tr, 0), (0, 0, tr))) - m
axis = Vector((0.0, -1.0, 0.3)).normalized()
for _ in range(64):
    axis = (inv @ axis).normalized()
if axis.y > 0:
    axis = -axis
for o in sw_parts:
    assign(o, lambda s: "interior_light" if base(s) == "painel" else "trim_black")
sw = join(sw_parts, "SteeringWheel")
z = axis
x = Vector((1, 0, 0))
x = (x - z * x.dot(z)).normalized()
y = z.cross(x)
rotm = Matrix((x, y, z)).transposed()
spivot = new_empty("SteeringPivot", c, rot_matrix=rotm)
sw.data.transform(Matrix.Translation(-c))
sw.data.transform(rotm.inverted().to_4x4())
sw.matrix_world = spivot.matrix_world
sw.parent = spivot
sw.matrix_parent_inverse = spivot.matrix_world.inverted()
print("steering centre", tuple(round(v, 3) for v in c), "axis", tuple(round(v, 3) for v in axis))

# Glass.
windows = [o for o in meshes() if o.name.startswith("windscreen_ok_glass") or
           (o.name.startswith("door_") and "_glass" in o.name)]
for o in windows:
    assign(o, lambda s: "window")
join(windows, "Glass")

lamp_covers = [one("lanterna_glass.002_0"), one("Fender_l75_glass.003_0"), one("bump_front_ok.004_glass.001_0"),
               one("fara_fara.4_0")]
lamp_covers = [o for o in lamp_covers if o]
for o in lamp_covers:
    assign(o, lambda s: "lamp_glass")
join(lamp_covers, "LampGlass")

# Interior.
interior = [o for o in meshes() if o.name.startswith(("interior", "painel", "pedais", "bancos"))]
for o in interior:
    assign(o, lambda s: "interior_light" if base(s) in ("painel", "bancos") else "interior")
join(interior, "Interior")

# Number plates (the game shows plain plates).
for n in ("bump_front_ok.005_bump_front_ok.1_0", "bump_rear_ok.001_bump_front_ok.1_0"):
    o = one(n)
    if o:
        assign(o, lambda s: "plate")

# Mirror eyes: the door mirrors are the parts of the front doors beyond the body side.
mirror_eyes = {}
for side_name, door in (("L", "door_lf_ok_primary_0"), ("R", "door_rf_ok_primary_0")):
    o = one(door)
    pts = [v.co for v in o.data.vertices if abs(v.co.x) > 0.89]
    if pts:
        mn = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
        mx = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
        eye = Vector(((mn.x + mx.x) / 2, mn.y - 0.02, (mn.z + mx.z) / 2))
        mirror_eyes[side_name] = (eye, mn, mx)
        new_empty("MirrorEye" + side_name, eye)
        print(f"mirror {side_name}: housing {tuple(round(v, 3) for v in mn)} .. {tuple(round(v, 3) for v in mx)}")

# Everything else is the body.
rest = [o for o in meshes() if not o.name.startswith(("Spin_", "Lamp_", "SteeringWheel", "Glass", "LampGlass",
                                                      "Interior"))]
for o in rest:
    if o.name.startswith(("bump_front_ok.005_bump_front_ok.1", "bump_rear_ok.001_bump_front_ok.1")):
        continue
    assign(o, body_rule)
body = join(rest, "Body")

# --- 6. Decimation -----------------------------------------------------------------------------


def tri_count(o):
    return sum(len(p.vertices) - 2 for p in o.data.polygons)


def decimate(o, target):
    n = tri_count(o)
    if n <= target:
        return
    mod = o.modifiers.new("dec", "DECIMATE")
    mod.ratio = max(target / n, 0.01)
    mod.use_collapse_triangulate = True
    bpy.context.view_layer.objects.active = o
    bpy.ops.object.select_all(action="DESELECT")
    o.select_set(True)
    bpy.ops.object.modifier_apply(modifier=mod.name)


budgets = {
    "Body": 60000, "Glass": 4000, "LampGlass": 4000, "Interior": 12000, "SteeringWheel": 2000,
    "Lamp_Head": 1200, "Lamp_Fog": 600, "Lamp_Tail": 1600, "Lamp_Brake": 400, "Lamp_Reverse": 600,
}
for o in meshes():
    if o.name.startswith("Spin_"):
        decimate(o, 5200)
    elif o.name.startswith("Lamp_Turn"):
        decimate(o, 600)
    elif o.name in budgets:
        decimate(o, budgets[o.name])

for o in meshes():
    for p in o.data.polygons:
        p.use_smooth = True
    try:
        bpy.context.view_layer.objects.active = o
        bpy.ops.object.select_all(action="DESELECT")
        o.select_set(True)
        bpy.ops.object.shade_smooth_by_angle(angle=math.radians(38))
    except Exception as exc:
        print("smooth-by-angle unavailable:", exc)

# --- 7. Collision hull ----------------------------------------------------------------------------
src_bm = bmesh.new()
src_bm.from_mesh(body.data)
ret = bmesh.ops.convex_hull(src_bm, input=src_bm.verts, use_existing_faces=False)
hull_faces = [g for g in ret["geom"] if isinstance(g, bmesh.types.BMFace)]
hull_bm = bmesh.new()
vmap = {}
for f in hull_faces:
    vs = []
    for v in f.verts:
        if v not in vmap:
            vmap[v] = hull_bm.verts.new(v.co)
        vs.append(vmap[v])
    try:
        hull_bm.faces.new(vs)
    except ValueError:
        pass
src_bm.free()
hull_mesh = bpy.data.meshes.new("CollisionHull")
hull_bm.to_mesh(hull_mesh)
hull_bm.free()
hull_obj = bpy.data.objects.new("CollisionHull", hull_mesh)
collection.objects.link(hull_obj)
decimate(hull_obj, 160)

# Unused source materials would only bloat the file.
for mat in list(bpy.data.materials):
    if mat.users == 0:
        bpy.data.materials.remove(mat)

# --- 8. Report + export --------------------------------------------------------------------------
total = 0
for o in sorted(meshes(), key=lambda o: o.name):
    n = tri_count(o)
    total += n
    print(f"  {o.name:18s} {n:7d} tris  mats={[m.name for m in o.data.materials]}")
print("TOTAL TRIS", total)
for corner, c in wheel_report.items():
    print(f"WHEEL {corner} blender=({c.x:.4f},{c.y:.4f},{c.z:.4f})  godot=({c.x:.4f},{c.z:.4f},{-c.y:.4f})")
bmn, bmx = bounds([body])
side_x = max(abs(v.co.x) for v in body.data.vertices if -1.2 < v.co.y < -0.6)  # rear door, no mirror
print(f"FOOTPRINT front={bmx.y:.3f} rear={-bmn.y:.3f} half_width={side_x:.3f} height={bmx.z:.3f}")
for s, (eye, _, _) in mirror_eyes.items():
    print(f"MIRROR_EYE {s} godot=({eye.x:.3f},{eye.z:.3f},{-eye.y:.3f})")

bpy.ops.export_scene.gltf(
    filepath=OUT,
    export_format="GLB",
    export_apply=True,
    export_yup=True,
    export_normals=True,
    export_tangents=False,
    export_materials="EXPORT",
    export_animations=False,
    export_extras=False,
)
print("exported", OUT)
