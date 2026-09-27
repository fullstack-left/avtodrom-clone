"""
Blender (headless): a light, single-mesh version of a game car for the
parked cars around the avtodrom.

    blender -b --python pipeline/blender/build_car_lod.py -- <game car.glb> <out_lod.glb> [tris]

Input is the processed game model (game/assets/cars/*/*.glb). The interior,
steering wheel and collision hull are dropped, everything else is joined into
one mesh, decimated to the budget (default 2500 triangles) and reduced to five
materials: paint (white — the game tints each parked car), glass, dark,
bright metal and red lamps.
"""
import sys

import bpy

argv = sys.argv[sys.argv.index("--") + 1:]
SRC, OUT = argv[0], argv[1]
BUDGET = int(argv[2]) if len(argv) > 2 else 2500

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC)
scene = bpy.context.scene

for o in list(scene.objects):
    if o.type == "MESH" and (o.name.startswith(("Interior", "SteeringWheel", "CollisionHull"))):
        bpy.data.objects.remove(o, do_unlink=True)

meshes = [o for o in scene.objects if o.type == "MESH"]
# Bake the hierarchy (wheel pivots etc.) into the vertices.
for o in meshes:
    mw = o.matrix_world.copy()
    o.parent = None
    o.matrix_world = mw
for o in list(scene.objects):
    if o.type != "MESH":
        bpy.data.objects.remove(o, do_unlink=True)

GROUPS = {
    "paint": ["paint"],
    "glass": ["window", "lamp_glass", "mirror"],
    "bright": ["chrome", "rim", "metal", "lamp_white", "plate", "brake_disc"],
    "red": ["lamp_red", "lamp_orange"],
}
targets = {}
for name in ["paint", "glass", "dark", "bright", "red"]:
    targets[name] = bpy.data.materials.new("lod_" + name)


def group_of(mat_name):
    base = mat_name.split(".")[0]
    for g, names in GROUPS.items():
        if base in names:
            return g
    return "dark"


for o in meshes:
    for slot in o.material_slots:
        slot.material = targets[group_of(slot.material.name if slot.material else "")]

bpy.ops.object.select_all(action="DESELECT")
for o in meshes:
    o.select_set(True)
bpy.context.view_layer.objects.active = meshes[0]
bpy.ops.object.join()
car = bpy.context.view_layer.objects.active
car.name = "CarLOD"
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

# Merge the duplicate slots the join left behind.
bpy.ops.object.material_slot_remove_unused()


def tris(o):
    return sum(len(p.vertices) - 2 for p in o.data.polygons)


n = tris(car)
if n > BUDGET:
    mod = car.modifiers.new("dec", "DECIMATE")
    mod.ratio = BUDGET / n
    mod.use_collapse_triangulate = True
    bpy.ops.object.modifier_apply(modifier=mod.name)
for p in car.data.polygons:
    p.use_smooth = False
print(f"LOD {SRC}: {n} -> {tris(car)} tris, materials {[m.name for m in car.data.materials]}")

bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", export_apply=True, export_yup=True,
                          export_normals=True, export_tangents=False, export_materials="EXPORT",
                          export_animations=False)
