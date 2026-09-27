class_name MeshUtil
extends RefCounted
## Procedural mesh helpers for the course (ground polygons, painted lines,
## kerbs). Everything is emitted through SurfaceTool with explicit normals;
## triangle winding is fixed per triangle so the caller never has to care
## about polygon orientation (Godot treats clockwise as front-facing).

const UP := Vector3.UP


## Adds a triangle whose front face points along `normal`.
static func tri(st: SurfaceTool, a: Vector3, b: Vector3, c: Vector3, normal: Vector3, uv_scale: float,
		color := Color.WHITE) -> void:
	if (b - a).cross(c - a).dot(normal) > 0.0:
		var t := b
		b = c
		c = t
	for v in [a, b, c]:
		st.set_normal(normal)
		st.set_color(color)
		st.set_uv(Vector2(v.x, v.z) / uv_scale)
		st.add_vertex(v)


## Triangle with an arbitrary UV mapping per vertex (walls).
static func tri_uv(st: SurfaceTool, a: Vector3, b: Vector3, c: Vector3, ua: Vector2, ub: Vector2, uc: Vector2,
		normal: Vector3) -> void:
	if (b - a).cross(c - a).dot(normal) > 0.0:
		var t := b
		b = c
		c = t
		var tu := ub
		ub = uc
		uc = tu
	for pair in [[a, ua], [b, ub], [c, uc]]:
		st.set_normal(normal)
		st.set_color(Color.WHITE)
		st.set_uv(pair[1])
		st.add_vertex(pair[0])


static func signed_area(poly: PackedVector2Array) -> float:
	var a := 0.0
	for i in poly.size():
		var p := poly[i]
		var q := poly[(i + 1) % poly.size()]
		a += p.x * q.y - q.x * p.y
	return a * 0.5


## Removes consecutive duplicates / near-collinear points that upset the triangulator.
static func clean(poly: PackedVector2Array, eps := 0.02) -> PackedVector2Array:
	var out := PackedVector2Array()
	for p in poly:
		if out.is_empty() or out[out.size() - 1].distance_to(p) > eps:
			out.append(p)
	if out.size() > 2 and out[0].distance_to(out[out.size() - 1]) <= eps:
		out.remove_at(out.size() - 1)
	return out


## Flat polygon at height y, facing up.
static func add_polygon(st: SurfaceTool, poly: PackedVector2Array, y: float, uv_scale: float,
		color := Color.WHITE) -> bool:
	poly = clean(poly)
	if poly.size() < 3:
		return false
	var idx := Geometry2D.triangulate_polygon(poly)
	if idx.is_empty():
		# Self-touching outlines: fall back to convex decomposition.
		var ok := false
		for part in Geometry2D.decompose_polygon_in_convex(poly):
			var pi := Geometry2D.triangulate_polygon(part)
			for i in range(0, pi.size(), 3):
				tri(st, _v(part[pi[i]], y), _v(part[pi[i + 1]], y), _v(part[pi[i + 2]], y), UP, uv_scale, color)
				ok = true
		return ok
	for i in range(0, idx.size(), 3):
		tri(st, _v(poly[idx[i]], y), _v(poly[idx[i + 1]], y), _v(poly[idx[i + 2]], y), UP, uv_scale, color)
	return true


static func _v(p: Vector2, y: float) -> Vector3:
	return Vector3(p.x, y, p.y)


## Offsets each vertex of a polyline sideways by `d` (positive = left of the
## direction of travel in the X/Z plane, i.e. towards -X when heading -Z).
## Miter joins, limited so sharp corners do not spike.
static func offset_polyline(pts: PackedVector2Array, d: float, closed: bool) -> PackedVector2Array:
	var n := pts.size()
	var out := PackedVector2Array()
	out.resize(n)
	for i in n:
		var prev: Vector2
		var next: Vector2
		if closed:
			prev = pts[(i - 1 + n) % n]
			next = pts[(i + 1) % n]
		else:
			prev = pts[max(i - 1, 0)]
			next = pts[min(i + 1, n - 1)]
		var d0 := (pts[i] - prev).normalized() if pts[i] != prev else (next - pts[i]).normalized()
		var d1 := (next - pts[i]).normalized() if next != pts[i] else d0
		var n0 := Vector2(d0.y, -d0.x)
		var n1 := Vector2(d1.y, -d1.x)
		var m := (n0 + n1)
		if m.length_squared() < 1e-6:
			m = n1
		m = m.normalized()
		var cosang := m.dot(n1)
		var scale := 1.0 / maxf(cosang, 0.35)
		out[i] = pts[i] + m * d * scale
	return out


## Flat strip of width `w` centred on a polyline (road paint).
static func add_ribbon(st: SurfaceTool, pts: PackedVector2Array, w: float, y: float, closed: bool,
		uv_scale := 1.0, color := Color.WHITE) -> void:
	if pts.size() < 2:
		return
	var left := offset_polyline(pts, w * 0.5, closed)
	var right := offset_polyline(pts, -w * 0.5, closed)
	var n := pts.size()
	var count := n if closed else n - 1
	for i in count:
		var j := (i + 1) % n
		var a := _v(left[i], y)
		var b := _v(right[i], y)
		var c := _v(left[j], y)
		var d := _v(right[j], y)
		tri(st, a, b, c, UP, uv_scale, color)
		tri(st, b, d, c, UP, uv_scale, color)


## Dashed version of add_ribbon: `on` metres painted, `off` metres gap.
static func add_dashed(st: SurfaceTool, pts: PackedVector2Array, w: float, y: float, on: float, off: float,
		color := Color.WHITE) -> void:
	var pos := 0.0
	var painting := true
	var cur := PackedVector2Array([pts[0]])
	var remaining := on
	for i in range(1, pts.size()):
		var a := pts[i - 1]
		var b := pts[i]
		var seg := a.distance_to(b)
		var t := 0.0
		while seg - t > remaining:
			t += remaining
			var p := a.lerp(b, t / seg)
			if painting:
				cur.append(p)
				add_ribbon(st, cur, w, y, false, 1.0, color)
			cur = PackedVector2Array([p])
			painting = not painting
			remaining = on if painting else off
		remaining -= seg - t
		if painting:
			cur.append(b)
		else:
			cur = PackedVector2Array([b])
	# A leftover stub shorter than 0.3 m at the end of the line reads as a stray dot.
	if painting and cur.size() > 1 and on - remaining > 0.3:
		add_ribbon(st, cur, w, y, false, 1.0, color)


## Vertical wall along a polyline from y0 to y1; `outward` picks the facing side
## (+1 = the right-hand side of travel direction... resolved per segment by
## `face_point`: the wall faces away from that point).
static func add_wall(st: SurfaceTool, pts: PackedVector2Array, y0: float, y1: float, closed: bool,
		inside_test: Callable, uv_scale := 1.0) -> void:
	var n := pts.size()
	var count := n if closed else n - 1
	var u := 0.0
	for i in count:
		var p := pts[i]
		var q := pts[(i + 1) % n]
		var seg := p.distance_to(q)
		if seg < 1e-4:
			continue
		var dir := (q - p) / seg
		var nrm := Vector2(dir.y, -dir.x)
		var mid := (p + q) * 0.5
		if inside_test.call(mid + nrm * 0.05):
			nrm = -nrm
		var normal := Vector3(nrm.x, 0.0, nrm.y)
		var a := Vector3(p.x, y0, p.y)
		var b := Vector3(q.x, y0, q.y)
		var c := Vector3(p.x, y1, p.y)
		var d := Vector3(q.x, y1, q.y)
		var ua := Vector2(u, y0) / uv_scale
		var ub := Vector2(u + seg, y0) / uv_scale
		var uc := Vector2(u, y1) / uv_scale
		var ud := Vector2(u + seg, y1) / uv_scale
		tri_uv(st, a, b, c, ua, ub, uc, normal)
		tri_uv(st, b, d, c, ub, ud, uc, normal)
		u += seg


static func commit(st: SurfaceTool, material: Material) -> ArrayMesh:
	st.set_material(material)
	st.index()
	return st.commit()
