"""Blender (headless): import a car .glb and print its structure + bounds."""
import sys
import bpy
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:]
path = argv[0]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=path)
bpy.context.view_layer.update()

def world_bounds(objs):
    mn = Vector((1e9, 1e9, 1e9)); mx = Vector((-1e9, -1e9, -1e9))
    for o in objs:
        if o.type != 'MESH':
            continue
        for c in o.bound_box:
            w = o.matrix_world @ Vector(c)
            mn = Vector(map(min, mn, w)); mx = Vector(map(max, mx, w))
    return mn, mx

meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
mn, mx = world_bounds(meshes)
print("TOTAL bounds min", tuple(round(v, 3) for v in mn), "max", tuple(round(v, 3) for v in mx), "size", tuple(round(v, 3) for v in (mx - mn)))
tris = 0
for o in meshes:
    n = sum(len(p.vertices) - 2 for p in o.data.polygons)
    tris += n
    bmn, bmx = world_bounds([o])
    c = (bmn + bmx) / 2
    print(f"{o.name:55s} tris={n:7d} center=({c.x:.3f},{c.y:.3f},{c.z:.3f}) size=({(bmx-bmn).x:.3f},{(bmx-bmn).y:.3f},{(bmx-bmn).z:.3f}) mats={[m.name for m in o.data.materials]}")
print("TOTAL TRIS", tris)
for m in bpy.data.materials:
    bsdf = m.node_tree.nodes.get("Principled BSDF") if m.use_nodes else None
    if bsdf:
        bc = bsdf.inputs["Base Color"].default_value
        print("MAT", m.name, "base", tuple(round(v, 3) for v in bc), "metal", round(bsdf.inputs["Metallic"].default_value, 2), "rough", round(bsdf.inputs["Roughness"].default_value, 2), "alpha", round(bsdf.inputs["Alpha"].default_value, 2), "blend", m.blend_method if hasattr(m, 'blend_method') else '')
