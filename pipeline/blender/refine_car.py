"""
Blender (headless) clean-up pass over a built car (output of build_nexia.py /
build_cobalt.py):

    python3 -c "import bpy"  # or: blender -b --python ...
    blender -b --python pipeline/blender/refine_car.py -- <car.glb> <out.glb> nexia2|cobalt_at

The heavy decimation in the build scripts leaves two kinds of damage that
show in the game, and this pass repairs both:
  * body: the decimated panels carry custom split normals that no longer fit
    the faces (dark smears across doors, boot and bumpers). The glTF split
    vertices are welded (the car has no textures, so the UV seams mean
    nothing), the custom normals dropped and recomputed smooth-by-angle with
    face-area weighting, so flat panels shade flat and creases stay sharp;
  * dashboard: the decimated dash is a lumpy blob (Nexia) or a faceted,
    holed mess (Cobalt). It is cut out of the Interior mesh and replaced by
    a simple modelled one: dash top up to the windscreen, instrument hood,
    centre stack with vents and radio, steering column shroud, and two
    gauge faces (GaugeSpeed, GaugeRpm; unit-square UVs) that the game draws
    with live needles.
It also lowers the wheel/hub budgets (they are seen small) and re-exports
with the same node names the game looks up.
"""
import math
import sys

import bpy  # before bmesh: needed when run through the bpy pip module
import bmesh
from mathutils import Matrix, Vector

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:]
SRC, OUT, CAR = argv[0], argv[1], argv[2]

# Per car: body triangle budget and dashboard geometry, in Blender
# coordinates (x right, y forward, z up; origin on the ground midway between
# the axles). y_back/z_top: rear top edge of the dash; the windscreen base
# comes from the Glass mesh.
SPEC = {
    "nexia2": {
        "half_width": 0.72, "y_back": 0.43, "z_top": 0.95, "z_knee": 0.60, "z_floor": 0.47,
        "cut_z": 0.50, "cut_keep_x": 0.64, "hood_w": 0.36, "gauge_r": 0.058, "gauge_z": 0.895,
        "body_tris": 34000,
        "tunnel": True,  # the decimated gear-lever tunnel is spiky: rebuilt with a manual lever
        "seats": None,  # the Nexia's own seats survived the decimation
    },
    "cobalt_at": {
        "half_width": 0.76, "y_back": 0.72, "z_top": 0.95, "z_knee": 0.58, "z_floor": 0.45,
        "cut_z": 0.50, "cut_keep_x": 0.66, "hood_w": 0.38, "gauge_r": 0.060, "gauge_z": 0.895,
        "body_tris": 40000,  # below this the bonnet edge creases
        "tunnel": False,  # keeps the model's own console and selector
        # The decimated seats are crumpled: replaced by simple modelled ones.
        # Front seat centre |x|, cushion/back/headrest y and z; rear bench y/z.
        "seats": {"front_x": 0.35, "front_w": 0.48, "cushion": (0.32, 0.40), "back": (-0.01, 0.64),
                  "head": (-0.13, 1.02), "rear_cushion": (-0.70, 0.45), "rear_back": (-1.08, 0.68),
                  "rear_head": (-1.2, 0.99), "rear_w": 1.2},
    },
}[CAR]

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC)
scene = bpy.context.scene
collection = scene.collection
obj = {o.name: o for o in scene.objects}


def material(name, rgb):
    m = bpy.data.materials.get(name)
    if m is None:
        m = bpy.data.materials.new(name)
        m.diffuse_color = (*rgb, 1.0)
    return m


def tri_count(o):
    return sum(len(p.vertices) - 2 for p in o.data.polygons)


def activate(o):
    bpy.ops.object.select_all(action="DESELECT")
    o.select_set(True)
    bpy.context.view_layer.objects.active = o


def decimate(o, target):
    n = tri_count(o)
    if n <= target:
        return
    activate(o)
    mod = o.modifiers.new("dec", "DECIMATE")
    mod.ratio = max(target / n, 0.01)
    mod.use_collapse_triangulate = True
    bpy.ops.object.modifier_apply(modifier=mod.name)


def clean_normals(o, angle_deg=34.0, weld=True):
    """Welds split vertices and rebuilds normals: smooth by angle, then
    face-area weighted so big flat panels are not bent by thin slivers."""
    me = o.data
    if weld:
        while me.uv_layers:
            me.uv_layers.remove(me.uv_layers[0])
        bm = bmesh.new()
        bm.from_mesh(me)
        bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
        bm.to_mesh(me)
        bm.free()
    activate(o)
    if me.has_custom_normals:
        bpy.ops.mesh.customdata_custom_splitnormals_clear()
    bpy.ops.object.shade_smooth_by_angle(angle=math.radians(angle_deg))
    mod = o.modifiers.new("wn", "WEIGHTED_NORMAL")
    mod.mode = "FACE_AREA"
    mod.weight = 50
    mod.keep_sharp = True
    # Blender 4.1+: the WN modifier needs smooth-by-angle applied first,
    # which shade_smooth_by_angle already did (sharp edges are marked).
    for m in list(o.modifiers):
        bpy.ops.object.modifier_apply(modifier=m.name)


# --- 1. Body and other hard-surface parts -------------------------------------------------
for name in ("Body", "Glass", "LampGlass", "Interior"):
    if name in obj:
        if name == "Body":
            decimate(obj[name], SPEC["body_tris"])
        clean_normals(obj[name])

# Wheels are seen small (and blurred by motion); hubs sit behind the rims.
for o in list(scene.objects):
    if o.type != "MESH":
        continue
    if o.name.startswith("Spin_"):
        decimate(o, 3000)
    elif o.name.startswith("Hub_"):
        decimate(o, 400)

# --- 2. Cut the old dashboard out of the interior ---------------------------------------------
interior = obj["Interior"]
glass = obj["Glass"]
win = [glass.matrix_world @ glass.data.vertices[i].co
       for p in glass.data.polygons if glass.data.materials[p.material_index].name == "window"
       for i in p.vertices]
screen = [v for v in win if v.y > 0.2 and abs(v.x) < 0.66]  # windscreen, not the door glass
screen_base_z = min(v.z for v in screen if abs(v.x) < 0.4)
screen_base_y = max(v.y for v in screen if abs(v.x) < 0.4 and v.z < screen_base_z + 0.02)
# The windscreen's lower edge curves back towards the A-pillars: fit it as
# y = base_y - k x^2 through the glass vertices on that edge.
edge = [v for v in screen if v.z < screen_base_z + 0.012 and abs(v.x) > 0.2]
edge_k = sum((screen_base_y - v.y) * v.x * v.x for v in edge) / max(sum(v.x ** 4 for v in edge), 1e-6)
edge_k = min(max(edge_k, 0.0), 0.5)
print(f"windscreen base y={screen_base_y:.3f} z={screen_base_z:.3f} curve k={edge_k:.3f}")


def screen_base(x):
    """(y, z) of the windscreen's lower edge at x."""
    return screen_base_y - edge_k * x * x, screen_base_z


y_back = SPEC["y_back"]
bm = bmesh.new()
bm.from_mesh(interior.data)
bm.transform(interior.matrix_world)
dead = []
for f in bm.faces:
    c = f.calc_center_median()
    in_dash = c.z > SPEC["cut_z"] and abs(c.x) < SPEC["cut_keep_x"]
    in_console = c.z > SPEC["cut_z"] - 0.2 and abs(c.x) < 0.14
    in_tunnel = SPEC["tunnel"] and abs(c.x) < 0.13 and y_back - 0.5 < c.y and 0.3 < c.z < 0.75
    seats = SPEC["seats"]
    in_seat = bool(seats) and (
        (0.09 < abs(c.x) < 0.64 and -0.22 < c.y < 0.58 and 0.3 < c.z < 1.16)
        or (abs(c.x) < 0.66 and -1.33 < c.y < -0.46 and 0.36 < c.z < 1.12))
    if (c.y > y_back - 0.06 and (in_dash or in_console)) or in_tunnel or in_seat:
        dead.append(f)
bmesh.ops.delete(bm, geom=dead, context="FACES")
loose = [v for v in bm.verts if not v.link_faces]
bmesh.ops.delete(bm, geom=loose, context="VERTS")
bm.transform(interior.matrix_world.inverted())
bm.to_mesh(interior.data)
bm.free()
print("removed", len(dead), "old dashboard faces")

# --- 3. New dashboard ---------------------------------------------------------------------------
mat_dash = material("dash", (0.06, 0.06, 0.065))
mat_panel = material("dash_panel", (0.015, 0.015, 0.017))
mat_trim = material("dash_trim", (0.1, 0.1, 0.11))
mat_gauge = material("gauge", (0.02, 0.02, 0.02))

dash_me = bpy.data.meshes.new("Dash")
dash_me.materials.append(mat_dash)
dash_me.materials.append(mat_panel)
dash_me.materials.append(mat_trim)
bm = bmesh.new()

hw = SPEC["half_width"]
zt, zk, zf = SPEC["z_top"], SPEC["z_knee"], SPEC["z_floor"]


def dash_profile(x):
    """Side profile (y, z) at x, closed, going round: rear top edge, down the
    face to the knees, under the dash, up the firewall and back along the
    top from just under the windscreen's lower edge."""
    yw, zw = screen_base(x)
    yw, zw = yw - 0.03, zw + 0.012  # just behind the glass: no gap to see the cowl through
    return [
        (y_back, zt), (y_back - 0.012, zt - 0.03), (y_back - 0.02, zt - 0.10),
        (y_back - 0.01, zk + 0.06), (y_back + 0.03, zk), (y_back + 0.14, zf),
        (yw - 0.05, zf), (yw + 0.02, zw - 0.04), (yw, zw),
        (y_back + 0.55 * (yw - y_back), zt - 0.25 * (zt - zw)), (y_back + 0.18 * (yw - y_back), zt + 0.004),
    ]


def loft(prof_fn, x0, x1, mat_idx, segments=1):
    """Extrudes a closed (y, z) profile from x0 to x1; prof_fn(x) may vary
    the profile across the width."""
    rings = []
    for k in range(segments + 1):
        x = x0 + (x1 - x0) * k / segments
        rings.append([bm.verts.new((x, y, z)) for y, z in prof_fn(x)])
    n = len(rings[0])
    for a, b in zip(rings, rings[1:]):
        for i in range(n):
            j = (i + 1) % n
            bm.faces.new((a[i], a[j], b[j], b[i])).material_index = mat_idx
    bm.faces.new(list(reversed(rings[0]))).material_index = mat_idx
    bm.faces.new(rings[-1]).material_index = mat_idx


loft(dash_profile, -hw, hw, 0, segments=16)

# Centre console under the stack, down to the floor tunnel.
y_mid = y_back + 0.25
console = [(y_back - 0.02, zk + 0.07), (y_back - 0.005, zf - 0.17), (y_mid, zf - 0.19), (y_mid, zk + 0.07)]
loft(lambda x: console, -0.13, 0.13, 0)
if SPEC["tunnel"]:
    t_back = y_back - 0.48
    tunnel = [(y_back, zf - 0.19), (y_back, zf - 0.04), (t_back + 0.02, zf - 0.07), (t_back, zf - 0.1),
              (t_back, zf - 0.19)]
    loft(lambda x: tunnel, -0.1, 0.1, 0)
    # Gear lever: boot, rod and knob.
    lever_base = Vector((0.0, y_back - 0.2, zf - 0.055))
    lever_top = lever_base + Vector((0.0, -0.05, 0.19))
    def prism(p0, p1, r0, r1, sides, mat_idx):
        ax = (p1 - p0).normalized()
        u = ax.cross(Vector((1, 0, 0))).normalized()
        w = ax.cross(u)
        rings = [[bm.verts.new(p + (u * math.cos(k / sides * math.tau) + w * math.sin(k / sides * math.tau)) * r)
                  for k in range(sides)] for p, r in ((p0, r0), (p1, r1))]
        for k in range(sides):
            j = (k + 1) % sides
            bm.faces.new((rings[0][k], rings[0][j], rings[1][j], rings[1][k])).material_index = mat_idx
        bm.faces.new(rings[1]).material_index = mat_idx
    prism(lever_base, lever_base + (lever_top - lever_base) * 0.3, 0.06, 0.018, 8, 1)
    prism(lever_base, lever_top, 0.009, 0.009, 6, 2)
    prism(lever_top - Vector((0, 0, 0.012)), lever_top + Vector((0, -0.005, 0.035)), 0.022, 0.018, 8, 1)

spivot = obj["SteeringPivot"]
driver_x = spivot.matrix_world.translation.x
col_axis = (spivot.matrix_world.to_3x3() @ Vector((0, 0, 1))).normalized()  # towards the driver
wheel_c = spivot.matrix_world.translation

# Instrument hood: a raised brow over the gauges in front of the driver.
hood_w = SPEC["hood_w"]
hood = [(y_back - 0.035, zt + 0.045), (y_back - 0.03, zt - 0.005), (y_back + 0.16, zt - 0.005),
        (y_back + 0.14, zt + 0.02), (y_back + 0.06, zt + 0.055), (y_back - 0.01, zt + 0.06)]
loft(lambda x: hood, driver_x - hood_w / 2, driver_x + hood_w / 2, 0)


def quad(cx, cz, w, h, y, mat_idx, tilt=0.0, uv=False):
    """A rectangle facing the driver (-Y) on the dash face, leaning back by tilt."""
    hx, hz = w / 2, h / 2
    pts = []
    for dx, dz in ((-hx, -hz), (hx, -hz), (hx, hz), (-hx, hz)):
        pts.append(bm.verts.new((cx + dx, y + dz * tilt, cz + dz)))
    f = bm.faces.new((pts[0], pts[1], pts[2], pts[3]))
    f.material_index = mat_idx
    return f


face_tilt = 0.16  # the dash face leans back ~9 degrees
# Cluster plate behind the gauges, centre stack, vents, radio.
gz = SPEC["gauge_z"]
quad(driver_x, gz, hood_w - 0.04, 0.13, y_back - 0.022, 1, face_tilt)
quad(0.0, zk + 0.16, 0.2, 0.28, y_back - 0.02, 1, face_tilt)   # centre stack
for vx in (-0.055, 0.055):
    quad(vx, zt - 0.06, 0.085, 0.05, y_back - 0.024, 1, face_tilt)  # centre vents
quad(0.0, zk + 0.19, 0.16, 0.05, y_back - 0.024, 2, face_tilt)       # radio face
for kx in (-0.05, 0.0, 0.05):
    quad(kx, zk + 0.08, 0.03, 0.03, y_back - 0.024, 2, face_tilt)    # climate knobs
for side in (-1, 1):
    quad(side * (hw - 0.09), zt - 0.055, 0.08, 0.055, y_back - 0.02, 1, face_tilt)  # outer vents
quad(-driver_x, zk + 0.13, 0.34, 0.012, y_back - 0.017, 1, face_tilt)             # glovebox seam

# Steering column shroud from the wheel hub into the dash.
col_len = 0.30
start = wheel_c - col_axis * 0.05
ring0, ring1 = [], []
up = Vector((0, 0, 1))
side_v = col_axis.cross(up).normalized()
up_v = side_v.cross(col_axis).normalized()
for k in range(8):
    a = k / 8 * math.tau
    off = side_v * math.cos(a) * 0.05 + up_v * math.sin(a) * 0.04
    ring0.append(bm.verts.new(start + off))
    ring1.append(bm.verts.new(start - col_axis * col_len + off * 1.3))
for k in range(8):
    j = (k + 1) % 8
    bm.faces.new((ring0[k], ring0[j], ring1[j], ring1[k])).material_index = 0
bm.faces.new(ring0).material_index = 0

# Every visible face of the dash faces the driver: orient them all that way.
eye = wheel_c + Vector((-0.01, -0.52, 0.34))
bm.normal_update()
flip = [f for f in bm.faces if f.normal.dot(eye - f.calc_center_median()) < 0]
bmesh.ops.reverse_faces(bm, faces=flip)
bm.to_mesh(dash_me)
bm.free()
dash = bpy.data.objects.new("Dash", dash_me)
collection.objects.link(dash)
for p in dash_me.polygons:
    p.use_smooth = False


# --- 3b. Simple seats (rounded boxes) --------------------------------------------------------
seat_parts = []
if SPEC["seats"]:
    st = SPEC["seats"]
    seat_me = bpy.data.meshes.new("Seats")
    seat_me.materials.append(bpy.data.materials["interior"])
    bm = bmesh.new()

    def rounded_box(centre, size, tilt_deg=0.0, radius=0.035):
        """A box with rounded edges; tilt leans its top rearwards (about x)."""
        geom = bmesh.ops.create_cube(bm, size=1.0)["verts"]
        m = (Matrix.Translation(Vector(centre)) @ Matrix.Rotation(math.radians(tilt_deg), 4, "X")
             @ Matrix.Diagonal((*size, 1.0)))
        bmesh.ops.transform(bm, matrix=m, verts=geom)
        edges = list({e for v in geom for e in v.link_edges})
        bmesh.ops.bevel(bm, geom=edges, offset=radius, segments=2, affect="EDGES", profile=0.5)

    fw = st["front_w"]
    for side in (-1, 1):
        cx = side * st["front_x"]
        rounded_box((cx, st["cushion"][0], st["cushion"][1]), (fw, 0.5, 0.12), 4.0)
        rounded_box((cx, st["back"][0], st["back"][1]), (fw, 0.13, 0.56), 14.0)
        rounded_box((cx, st["head"][0], st["head"][1]), (0.26, 0.08, 0.16), 8.0, 0.03)
        # side bolsters on the backrest
        for b in (-1, 1):
            rounded_box((cx + b * (fw / 2 - 0.03), st["back"][0] + 0.04, st["back"][1] - 0.02),
                        (0.07, 0.1, 0.46), 14.0, 0.025)
    rw = st["rear_w"]
    rounded_box((0.0, st["rear_cushion"][0], st["rear_cushion"][1]), (rw, 0.46, 0.13), 4.0)
    rounded_box((0.0, st["rear_back"][0], st["rear_back"][1]), (rw, 0.12, 0.52), 16.0)
    for hx in (-0.36, 0.36):
        rounded_box((hx, st["rear_head"][0], st["rear_head"][1]), (0.24, 0.07, 0.13), 10.0, 0.025)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(seat_me)
    bm.free()
    seat_obj = bpy.data.objects.new("Seats", seat_me)
    collection.objects.link(seat_obj)
    activate(seat_obj)
    bpy.ops.object.shade_smooth_by_angle(angle=math.radians(40))
    seat_parts.append(seat_obj)

# Join the dashboard (and seats) into Interior (one draw per material).
activate(interior)
dash.select_set(True)
for o in seat_parts:
    o.select_set(True)
bpy.ops.object.join()
interior = bpy.context.view_layer.objects.active
interior.name = "Interior"


# --- 4. Gauge faces --------------------------------------------------------------------------
def gauge(name, cx):
    r = SPEC["gauge_r"]
    y = y_back - 0.028
    me = bpy.data.meshes.new(name)
    bm2 = bmesh.new()
    uv = bm2.loops.layers.uv.new()
    vs = [bm2.verts.new((cx + dx * r, y + dz * r * face_tilt, gz + dz * r)) for dx, dz in
          ((-1, -1), (1, -1), (1, 1), (-1, 1))]
    f = bm2.faces.new(vs)
    for loop, (u, v) in zip(f.loops, ((0, 0), (1, 0), (1, 1), (0, 1))):  # Blender V is up
        loop[uv].uv = (u, v)
    bm2.to_mesh(me)
    bm2.free()
    me.materials.append(mat_gauge)
    o = bpy.data.objects.new(name, me)
    collection.objects.link(o)


gauge("GaugeSpeed", driver_x - 0.07)
gauge("GaugeRpm", driver_x + 0.07)

# The steering wheel and cabin get their own dark material so they can differ
# from the exterior black trim (they do not receive the sun's shadow maps).
wheel = obj["SteeringWheel"]
for i, m in enumerate(wheel.data.materials):
    if m and m.name == "trim_black":
        wheel.data.materials[i] = material("interior_black", (0.03, 0.03, 0.03))
    elif m and m.name == "interior_light":  # Cobalt spokes: dark plastic, not light grey
        wheel.data.materials[i] = bpy.data.materials["interior"]
for i, m in enumerate(interior.data.materials):
    if m and m.name == "trim_black":
        interior.data.materials[i] = material("interior_black", (0.03, 0.03, 0.03))

# --- 5. Report + export -----------------------------------------------------------------------
total = 0
for o in sorted((o for o in scene.objects if o.type == "MESH"), key=lambda o: o.name):
    if o.name == "CollisionHull":
        continue
    n = tri_count(o)
    total += n
    print(f"  {o.name:18s} {n:7d} tris  mats={[m.name for m in o.data.materials]}")
print("TOTAL TRIS", total)

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
    export_texcoords=True,
)
print("exported", OUT)
