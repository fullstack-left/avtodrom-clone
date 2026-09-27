class_name ProcGeo
extends RefCounted
## Small solid-shape builders for props (traffic lights).
## Everything goes through a SurfaceTool with explicit normals and vertex
## colours, so a whole prop is one mesh with one material (one draw call).
## Winding is fixed per triangle from the normals (Godot: clockwise = front).


## Triangle with per-vertex normals; `uv` is optional (one UV per vertex).
static func tri(st: SurfaceTool, a: Vector3, b: Vector3, c: Vector3, na: Vector3, nb: Vector3, nc: Vector3,
		col: Color, uv := PackedVector2Array()) -> void:
	var verts := [a, b, c]
	var norms := [na, nb, nc]
	var uvs := [Vector2.ZERO, Vector2.ZERO, Vector2.ZERO]
	if uv.size() == 3:
		uvs = [uv[0], uv[1], uv[2]]
	if (b - a).cross(c - a).dot(na + nb + nc) > 0.0:
		verts = [a, c, b]
		norms = [na, nc, nb]
		uvs = [uvs[0], uvs[2], uvs[1]]
	for i in 3:
		st.set_normal(norms[i])
		st.set_color(col)
		st.set_uv(uvs[i])
		st.add_vertex(verts[i])


## Flat quad a-b-c-d (in order around the edge).
static func quad(st: SurfaceTool, a: Vector3, b: Vector3, c: Vector3, d: Vector3, n: Vector3, col: Color,
		uv := PackedVector2Array()) -> void:
	if uv.size() == 4:
		tri(st, a, b, c, n, n, n, col, PackedVector2Array([uv[0], uv[1], uv[2]]))
		tri(st, a, c, d, n, n, n, col, PackedVector2Array([uv[0], uv[2], uv[3]]))
	else:
		tri(st, a, b, c, n, n, n, col)
		tri(st, a, c, d, n, n, n, col)


## Cylinder / cone frustum along +y from `base`, smooth sides, optional caps.
static func cylinder(st: SurfaceTool, xf: Transform3D, base: Vector3, r0: float, r1: float, h: float, seg: int,
		col: Color, top_cap := true, bottom_cap := false) -> void:
	var slope := (r0 - r1) / h
	for i in seg:
		var a0 := TAU * i / seg
		var a1 := TAU * (i + 1) / seg
		var d0 := Vector3(cos(a0), 0, sin(a0))
		var d1 := Vector3(cos(a1), 0, sin(a1))
		var n0 := xf.basis * (d0 + Vector3(0, slope, 0)).normalized()
		var n1 := xf.basis * (d1 + Vector3(0, slope, 0)).normalized()
		var b0 := xf * (base + d0 * r0)
		var b1 := xf * (base + d1 * r0)
		var t0 := xf * (base + d0 * r1 + Vector3(0, h, 0))
		var t1 := xf * (base + d1 * r1 + Vector3(0, h, 0))
		tri(st, b0, b1, t1, n0, n1, n1, col)
		if r1 > 0.0001:
			tri(st, b0, t1, t0, n0, n1, n0, col)
		if top_cap and r1 > 0.0001:
			var up := (xf.basis * Vector3.UP).normalized()
			tri(st, xf * (base + Vector3(0, h, 0)), t0, t1, up, up, up, col)
		if bottom_cap:
			var dn := (xf.basis * Vector3.DOWN).normalized()
			tri(st, xf * base, b1, b0, dn, dn, dn, col)


## Rounded-corner rectangle outline in the xy plane, centred on the origin,
## counter-clockwise, with its outward normals (for the side walls).
static func rounded_rect(w: float, h: float, r: float, seg: int) -> Array:
	var pts := PackedVector2Array()
	var nrm := PackedVector2Array()
	var centres := [Vector2(w * 0.5 - r, h * 0.5 - r), Vector2(-w * 0.5 + r, h * 0.5 - r),
			Vector2(-w * 0.5 + r, -h * 0.5 + r), Vector2(w * 0.5 - r, -h * 0.5 + r)]
	for c in 4:
		for k in seg + 1:
			var a := PI * 0.5 * (c + float(k) / seg)
			var d := Vector2(cos(a), sin(a))
			pts.append(centres[c] + d * r)
			nrm.append(d)
	return [pts, nrm]


## Slab with a rounded-rectangle face: front face at z = z1 (+z normal), back
## at z0, smooth rounded side walls.
static func rounded_slab(st: SurfaceTool, xf: Transform3D, centre: Vector3, w: float, h: float, r: float,
		z0: float, z1: float, seg: int, col: Color, back_face := true) -> void:
	var rr := rounded_rect(w, h, r, seg)
	var pts: PackedVector2Array = rr[0]
	var nrm: PackedVector2Array = rr[1]
	var fwd := (xf.basis * Vector3.BACK).normalized()
	var c1 := xf * (centre + Vector3(0, 0, z1))
	var c0 := xf * (centre + Vector3(0, 0, z0))
	var n := pts.size()
	for i in n:
		var j := (i + 1) % n
		var a := centre + Vector3(pts[i].x, pts[i].y, 0)
		var b := centre + Vector3(pts[j].x, pts[j].y, 0)
		tri(st, c1, xf * (a + Vector3(0, 0, z1)), xf * (b + Vector3(0, 0, z1)), fwd, fwd, fwd, col)
		if back_face:
			tri(st, c0, xf * (b + Vector3(0, 0, z0)), xf * (a + Vector3(0, 0, z0)), -fwd, -fwd, -fwd, col)
		var na := (xf.basis * Vector3(nrm[i].x, nrm[i].y, 0)).normalized()
		var nb := (xf.basis * Vector3(nrm[j].x, nrm[j].y, 0)).normalized()
		var a0 := xf * (a + Vector3(0, 0, z0))
		var a1 := xf * (a + Vector3(0, 0, z1))
		var b0 := xf * (b + Vector3(0, 0, z0))
		var b1 := xf * (b + Vector3(0, 0, z1))
		tri(st, a0, b0, b1, na, nb, nb, col)
		tri(st, a0, b1, a1, na, nb, na, col)


## Flat ring (annulus) in the xy plane facing +z.
static func ring(st: SurfaceTool, xf: Transform3D, centre: Vector3, r_in: float, r_out: float, seg: int,
		col: Color) -> void:
	var fwd := (xf.basis * Vector3.BACK).normalized()
	for i in seg:
		var a0 := TAU * i / seg
		var a1 := TAU * (i + 1) / seg
		var d0 := Vector3(cos(a0), sin(a0), 0)
		var d1 := Vector3(cos(a1), sin(a1), 0)
		quad(st, xf * (centre + d0 * r_in), xf * (centre + d0 * r_out), xf * (centre + d1 * r_out),
				xf * (centre + d1 * r_in), fwd, col)


## Lamp visor: the upper part of a tube around the lens axis (+z), from angle
## a0 to a1 (radians, 0 = +x, PI/2 = up), open at the front and bottom.
## Both the outside and the inside are built so it reads from any angle.
static func visor(st: SurfaceTool, xf: Transform3D, centre: Vector3, r: float, thick: float, length: float,
		a0: float, a1: float, seg: int, col: Color, inner_col: Color) -> void:
	for i in seg:
		var t0 := lerpf(a0, a1, float(i) / seg)
		var t1 := lerpf(a0, a1, float(i + 1) / seg)
		var d0 := Vector3(cos(t0), sin(t0), 0)
		var d1 := Vector3(cos(t1), sin(t1), 0)
		# The visor is a little shorter at the sides than on top.
		var l0 := length * (0.55 + 0.45 * sin(t0))
		var l1 := length * (0.55 + 0.45 * sin(t1))
		var ro := r + thick
		var n0 := (xf.basis * d0).normalized()
		var n1 := (xf.basis * d1).normalized()
		var o0 := xf * (centre + d0 * ro)
		var o1 := xf * (centre + d1 * ro)
		var o0f := xf * (centre + d0 * ro + Vector3(0, 0, l0))
		var o1f := xf * (centre + d1 * ro + Vector3(0, 0, l1))
		tri(st, o0, o1, o1f, n0, n1, n1, col)
		tri(st, o0, o1f, o0f, n0, n1, n0, col)
		var i0 := xf * (centre + d0 * r)
		var i1 := xf * (centre + d1 * r)
		var i0f := xf * (centre + d0 * r + Vector3(0, 0, l0))
		var i1f := xf * (centre + d1 * r + Vector3(0, 0, l1))
		tri(st, i0, i1f, i1, -n0, -n1, -n1, inner_col)
		tri(st, i0, i0f, i1f, -n0, -n0, -n1, inner_col)
		# Front lip.
		var f := (xf.basis * Vector3.BACK).normalized()
		quad(st, i0f, o0f, o1f, i1f, f, col)
