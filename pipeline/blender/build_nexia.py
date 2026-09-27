"""
Blender (headless) asset build for the Nexia 2 exam car.

    blender -b --python pipeline/blender/build_nexia.py -- <source.glb> <out.glb>

What it does, so the game can drive the car without guessing:
  * true scale (4482 mm long), front facing Blender +Y (= Godot -Z after glTF),
    body origin on the ground midway between the axles at static ride height;
  * wheels rescaled to the real 185/60 R14 radius (288.8 mm) and split into
    Wheel_XX (pivot at the hub) -> Spin (rotates) + Hub (caliper, stays put);
  * every lamp as its own object (Lamp_Head, Lamp_TurnFL, Lamp_Brake, ...) so
    the game can light them independently;
  * steering wheel under a SteeringPivot whose local Z is the column axis;
  * 906k triangles decimated to a mobile budget, and a convex CollisionHull;
  * material names normalised (paint, glass, rubber, chrome, ...).
Prints the final wheel centres; the C++ preset uses exactly those numbers.
"""
import math
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector

argv = sys.argv[sys.argv.index("--") + 1:]
SRC, OUT = argv[0], argv[1]

REAL_LENGTH = 4.482
TYRE_RADIUS = 0.2888

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC)
scene = bpy.context.scene


def meshes():
    return [o for o in scene.objects if o.type == "MESH"]


# --- 1. Flatten hierarchy, bake transforms -------------------------------------------
for o in meshes():
    mw = o.matrix_world.copy()
    o.parent = None
    o.matrix_world = mw
for o in list(scene.objects):
    if o.type != "MESH":
        bpy.data.objects.remove(o, do_unlink=True)
for o in meshes():
    o.data = o.data.copy()  # make single-user before applying
    o.data.transform(o.matrix_world)
    o.matrix_world = Matrix.Identity(4)


def bounds(objs):
    mn = Vector((1e9, 1e9, 1e9))
    mx = Vector((-1e9, -1e9, -1e9))
    for o in objs:
        for v in o.data.vertices:
            mn = Vector(map(min, mn, v.co))
            mx = Vector(map(max, mx, v.co))
    return mn, mx


# --- 2. Orient (front -> +Y) and scale to true length -----------------------------------
mn, mx = bounds(meshes())
scale = REAL_LENGTH / (mx.y - mn.y)
rot = Matrix.Rotation(math.pi, 4, "Z")
for o in meshes():
    o.data.transform(rot @ Matrix.Scale(scale, 4))
print(f"scale factor {scale:.4f}")

by_name = {o.name: o for o in meshes()}


def pick(prefix):
    return [o for n, o in by_name.items() if n.startswith(prefix)]


# --- 3. Wheels -------------------------------------------------------------------------
corner_names = {
    "FL": "wheel_front_left",
    "FR": "wheel_front_right",
    "RL": "wheel_rear_left",
    "RR": "wheel_rear_right",
}
spin_parts = ("_rim", "_tire", "_tire_nuts", "_tire_parts", "_brakedisk")
hub_parts = ("_caliper_brakedisk", "_support")

wheel_centres = {}
for corner, prefix in corner_names.items():
    tyre = pick(prefix + "_tire_tire")[0]
    tmn, tmx = bounds([tyre])
    centre = (tmn + tmx) / 2
    radius = (tmx.z - tmn.z) / 2
    wheel_centres[corner] = (centre, radius)

# Ground the car: lowest tyre point -> z = 0 after the wheel rescale.
ref_centre_z = sum(c.z for c, _ in wheel_centres.values()) / 4
ref_radius = sum(r for _, r in wheel_centres.values()) / 4
wheel_scale = TYRE_RADIUS / ref_radius
axle_front_y = (wheel_centres["FL"][0].y + wheel_centres["FR"][0].y) / 2
axle_rear_y = (wheel_centres["RL"][0].y + wheel_centres["RR"][0].y) / 2
mid_y = (axle_front_y + axle_rear_y) / 2
shift = Vector((0.0, -mid_y, TYRE_RADIUS - ref_centre_z))
for o in meshes():
    o.data.transform(Matrix.Translation(shift))
for k in list(wheel_centres):
    c, r = wheel_centres[k]
    wheel_centres[k] = (c + shift, r)

collection = scene.collection


def new_empty(name, loc, parent=None, rot_matrix=None):
    e = bpy.data.objects.new(name, None)
    collection.objects.link(e)
    m = Matrix.Translation(loc)
    if rot_matrix is not None:
        m = m @ rot_matrix.to_4x4()
    e.matrix_world = m
    if parent is not None:
        e.parent = parent
        e.matrix_parent_inverse = parent.matrix_world.inverted()
    return e


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


def set_origin(obj, point):
    obj.data.transform(Matrix.Translation(-point))
    obj.matrix_world = Matrix.Translation(point)


wheel_report = {}
for corner, prefix in corner_names.items():
    centre, radius = wheel_centres[corner]
    spin = [o for p in spin_parts for o in pick(prefix + p)]
    hub = [o for p in hub_parts for o in pick(prefix + p)]
    for o in spin + hub:
        o.data.transform(Matrix.Translation(-centre))
        o.data.transform(Matrix.Scale(wheel_scale, 4))
        o.data.transform(Matrix.Translation(centre))
        by_name.pop(o.name, None)
    pivot = new_empty("Wheel_" + corner, centre)
    s = join(spin, "Spin_" + corner)
    set_origin(s, centre)
    s.parent = pivot
    s.matrix_parent_inverse = pivot.matrix_world.inverted()
    h = join(hub, "Hub_" + corner)
    if h:
        set_origin(h, centre)
        h.parent = pivot
        h.matrix_parent_inverse = pivot.matrix_world.inverted()
    wheel_report[corner] = centre

# --- 4. Lamps ----------------------------------------------------------------------------


def split_by_side(obj, left_name, right_name):
    """Separates a mirrored mesh into its x<0 (left) and x>0 (right) halves."""
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
    obj.name = left_name
    obj.data.name = left_name
    r = bpy.data.objects.new(right_name, right_mesh)
    collection.objects.link(r)
    return obj, r


def take(name):
    return by_name.pop(name, None)


lamps = {
    "Lamp_Head": [take("light_front_lamp_xenon_clearglass_0"), take("light_front_lamp_clearglass_0")],
    "Lamp_Fog": [take("light_front_down_lamp_clearglass_0")],
    "Lamp_Tail": [take("light_rear_lamp_red_redglass_0")],
    "Lamp_Brake": [take("light_stop_lamp_redglass_0"), take("light_stop_cover_redglass_0")],
    "Lamp_Reverse": [take("light_rear_lamp_clearglass_0")],
}
for name, objs in lamps.items():
    join(objs, name)

for src, front in (("light_front_lamp_orange_orangeglass_0", "F"), ("light_rear_lamp_orange_orangeglass_0", "R")):
    o = take(src)
    split_by_side(o, "Lamp_Turn%sL" % front, "Lamp_Turn%sR" % front)
side = take("light_side_lamp_orangeglass_0")
side_cover = take("light_side_cover_orangeglass_0")
side = join([side, side_cover], "Lamp_Side")
split_by_side(side, "Lamp_TurnSL", "Lamp_TurnSR")

# --- 5. Steering wheel --------------------------------------------------------------------
sw = take("interior_control_wheel_black_0")
verts = [v.co.copy() for v in sw.data.vertices]
c = sum(verts, Vector()) / len(verts)
# Principal axes: the ring's normal has the least variance.
cov = [[0.0] * 3 for _ in range(3)]
for v in verts:
    d = v - c
    for i in range(3):
        for j in range(3):
            cov[i][j] += d[i] * d[j]
m = Matrix(cov)
# Power iteration on (trace*I - cov) finds the smallest-variance axis.
tr = m[0][0] + m[1][1] + m[2][2]
inv = Matrix(((tr, 0, 0), (0, tr, 0), (0, 0, tr))) - m
axis = Vector((0.0, -1.0, 0.3)).normalized()
for _ in range(64):
    axis = (inv @ axis).normalized()
if axis.y > 0:  # point from the wheel towards the driver (rearwards = -Y)
    axis = -axis
z = axis
x = Vector((1, 0, 0))
x = (x - z * x.dot(z)).normalized()
y = z.cross(x)
rotm = Matrix((x, y, z)).transposed()
pivot = new_empty("SteeringPivot", c, rot_matrix=rotm)
sw.data.transform(Matrix.Translation(-c))
sw.data.transform(rotm.inverted().to_4x4())
sw.matrix_world = pivot.matrix_world
sw.parent = pivot
sw.matrix_parent_inverse = pivot.matrix_world.inverted()
sw.name = "SteeringWheel"
print("steering centre", tuple(round(v, 3) for v in c), "axis", tuple(round(v, 3) for v in axis))

# --- 6. Body, glass, interior -------------------------------------------------------------
glass = [o for n, o in list(by_name.items()) if "glass" in n and "light" not in n]
glass += [o for n, o in list(by_name.items()) if n.startswith("light_") and "clearglass" in n]
for o in glass:
    by_name.pop(o.name, None)
join(glass, "Glass")

interior = [o for n, o in list(by_name.items()) if n.startswith("interior")]
for o in interior:
    by_name.pop(o.name, None)
join(interior, "Interior")

mirror_glass = take("side_backward_mirror_mirror_0")
if mirror_glass:
    mirror_glass.name = "MirrorGlass"

# Tiny parts nobody will ever see from the driver's seat.
for n in ("detail_lock_part_mattemetal_0", "detail_lock_black_0"):
    o = take(n)
    if o:
        bpy.data.objects.remove(o, do_unlink=True)

body_parts = list(by_name.values())
body = join(body_parts, "Body")

# --- 7. Decimation ------------------------------------------------------------------------


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
    "Body": 52000, "Glass": 6000, "Interior": 9000, "SteeringWheel": 1800, "MirrorGlass": 400,
    "Lamp_Head": 1500, "Lamp_Fog": 600, "Lamp_Tail": 1600, "Lamp_Brake": 600, "Lamp_Reverse": 800,
}
for o in meshes():
    if o.name.startswith("Spin_"):
        decimate(o, 5200)
    elif o.name.startswith("Hub_"):
        decimate(o, 900)
    elif o.name.startswith("Lamp_Turn"):
        decimate(o, 700)
    elif o.name in budgets:
        decimate(o, budgets[o.name])

# Smooth shading with sharp creases kept (angle-based normals).
for o in meshes():
    for p in o.data.polygons:
        p.use_smooth = True
    try:
        bpy.context.view_layer.objects.active = o
        bpy.ops.object.select_all(action="DESELECT")
        o.select_set(True)
        bpy.ops.object.shade_smooth_by_angle(angle=math.radians(38))
    except Exception as exc:  # older API
        print("smooth-by-angle unavailable:", exc)

# --- 8. Collision hull ---------------------------------------------------------------------
# Convex hull of the body, then simplified: Jolt only needs a rough shell
# (the wheels, not the hull, carry the car).
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

# --- 9. Materials ----------------------------------------------------------------------------
rename = {
    "carpaint": "paint", "black": "trim_black", "material": "rim", "tire": "rubber",
    "mattemetal": "metal", "brakedisk": "brake_disc", "clearglass": "lamp_glass",
    "orangeglass": "lamp_orange", "chrome": "chrome", "redglass": "lamp_red",
    "windowglass": "window", "interior": "interior", "mirror": "mirror",
}
for mat in bpy.data.materials:
    if mat.name in rename:
        mat.name = rename[mat.name]

# --- 10. Report + export -----------------------------------------------------------------------
total = 0
for o in sorted(meshes(), key=lambda o: o.name):
    n = tri_count(o)
    total += n
    print(f"  {o.name:18s} {n:7d} tris  mats={[m.name for m in o.data.materials]}")
print("TOTAL TRIS", total)
for corner, c in wheel_report.items():
    print(f"WHEEL {corner} blender=({c.x:.4f},{c.y:.4f},{c.z:.4f})  godot=({c.x:.4f},{c.z:.4f},{-c.y:.4f})")
mn, mx = bounds(meshes())
print("BOUNDS", tuple(round(v, 3) for v in mn), tuple(round(v, 3) for v in mx))

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
