class_name CourseBuilder
extends Node3D
## Builds the avtodrom scene from CourseData: ground, concrete pads, grass
## islands with kerbs, the estakada, all road paint, the railway crossing,
## signs, traffic lights, lamp posts, fence, trees and collision.
##
## Static geometry is merged by material (a handful of draw calls for the
## whole site) so it stays cheap on phones.

const LAYER_GROUND := 1
const LAYER_OBSTACLE := 4

const KERB_HEIGHT := 0.15
const KERB_WIDTH := 0.20
const GRASS_HEIGHT := 0.12
# Visual layers over the asphalt (collision is the y = 0 plane). A centimetre
# apart: closer, a phone's 24-bit depth buffer cannot keep them apart in the
# distance and they flicker through each other.
const PAD_Y := 0.01
const PAINT_Y := 0.02
const TEXT_PX_PER_EM := 256.0 # painted-word textures (pipeline/make_hud_art.py)
const TILE_ASPHALT := 4.0
const TILE_CONCRETE := 3.0
const TILE_GRASS := 2.5
const BAKED_PATH := "res://data/course_baked.scn"

var data: CourseData
var quality := 2
var traffic: TrafficController
var mat := {}
var _collision_faces := PackedVector3Array()
var _est: Dictionary
var _rng := RandomNumberGenerator.new()


## Loads the pre-built course (tests/bake_course.gd) or, if it is missing,
## builds it on the spot. Returns the course root, already configured.
static func load_or_build(p_data: CourseData, p_quality: int) -> CourseBuilder:
	if ResourceLoader.exists(BAKED_PATH):
		var scene: PackedScene = load(BAKED_PATH)
		var baked := scene.instantiate() as CourseBuilder
		if baked:
			baked.attach(p_data, p_quality)
			return baked
	var fresh := CourseBuilder.new()
	fresh.name = "Course"
	fresh.build(p_data, p_quality)
	return fresh


## Re-links runtime state after the baked scene is instantiated.
func attach(p_data: CourseData, p_quality: int) -> void:
	data = p_data
	quality = p_quality
	_est = data.raw["estakada"]
	traffic = get_node_or_null("TrafficController") as TrafficController
	_rebuild_lost_surroundings()
	if p_quality <= 1:
		# Small casters are not worth a shadow pass on medium and low.
		for n in ["FencePosts", "LampPostMesh", "GuardRailPosts", "Surroundings/ParkTreeCrowns",
				"Surroundings/ParkTreeTrunks", "Surroundings/PoplarCrowns", "Surroundings/PoplarTrunks"]:
			var gi := get_node_or_null(n) as GeometryInstance3D
			if gi:
				gi.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	if p_quality == 0:
		# Low-end phones: half the trees and city blocks, no tree shadows.
		for n in ["ParkTreeCrowns", "ParkTreeTrunks", "City", "ParkedCars0", "ParkedCars1"]:
			var mmi := get_node_or_null("Surroundings/" + n) as MultiMeshInstance3D
			if mmi:
				mmi.multimesh.visible_instance_count = mmi.multimesh.instance_count / 2
		for n in ["ParkTreeCrowns", "ParkTreeTrunks", "PoplarCrowns", "PoplarTrunks", "ParkedCars0", "ParkedCars1"]:
			var gi := get_node_or_null("Surroundings/" + n) as GeometryInstance3D
			if gi:
				gi.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF


## The course is baked headless (tests/bake_course.gd), and the headless
## renderer keeps no MultiMesh instance data, so the baked trees, city blocks
## and parked cars load with every transform zeroed and never show. When
## that is the case, build the surroundings again here (deterministic, a
## few ms) instead of using the baked copy.
func _rebuild_lost_surroundings() -> void:
	var old := get_node_or_null("Surroundings")
	if old == null or not _has_empty_multimesh(old):
		return
	remove_child(old)
	old.free()
	_make_materials()
	var around := Surroundings.new()
	add_child(around)
	around.build(_fence_rect(), quality, mat)


static func _has_empty_multimesh(node: Node) -> bool:
	for child in node.get_children():
		var mmi := child as MultiMeshInstance3D
		if mmi and mmi.multimesh and mmi.multimesh.instance_count > 0:
			var t := mmi.multimesh.get_instance_transform(0)
			if t.basis.determinant() == 0.0:
				return true
	return false


func build(p_data: CourseData, p_quality: int) -> void:
	data = p_data
	quality = p_quality
	_est = data.raw["estakada"]
	_rng.seed = 20260923
	_make_materials()
	_build_ground()
	_build_pads()
	_build_islands()
	_build_estakada()
	_build_markings()
	_build_railway()
	_build_signs()
	_build_traffic_lights()
	_build_lamp_posts()
	_build_fence()
	var around := Surroundings.new()
	add_child(around)
	around.build(_fence_rect(), quality, mat)
	_build_collision()


# --------------------------------------------------------------------------- materials
func _ground_material(dir: String, tint: Color, normal_strength: float, macro: float) -> ShaderMaterial:
	var m := ShaderMaterial.new()
	m.shader = load("res://assets/shaders/ground.gdshader")
	m.set_shader_parameter("albedo_tex", load("res://assets/textures/%s/albedo.jpg" % dir))
	m.set_shader_parameter("normal_tex", load("res://assets/textures/%s/normal.jpg" % dir))
	m.set_shader_parameter("arm_tex", load("res://assets/textures/%s/arm.jpg" % dir))
	m.set_shader_parameter("tint", tint)
	m.set_shader_parameter("normal_strength", normal_strength)
	m.set_shader_parameter("macro_strength", macro)
	return m


func _make_materials() -> void:
	mat["asphalt"] = _ground_material("asphalt", Color(0.78, 0.8, 0.84), 0.8, 0.30)
	mat["concrete"] = _ground_material("concrete", Color(1.05, 1.05, 1.05), 0.7, 0.20)
	mat["kerb"] = _ground_material("concrete", Color(1.25, 1.25, 1.22), 0.5, 0.10)
	var grass := ShaderMaterial.new()
	grass.shader = load("res://assets/shaders/grass.gdshader")
	grass.set_shader_parameter("albedo_tex", load("res://assets/textures/grass/albedo.jpg"))
	grass.set_shader_parameter("normal_tex", load("res://assets/textures/grass/normal.jpg"))
	mat["grass"] = grass
	var paint := ShaderMaterial.new()
	paint.shader = load("res://assets/shaders/marking.gdshader")
	paint.set_shader_parameter("wear_tex", load("res://assets/textures/asphalt/albedo.jpg"))
	mat["paint"] = paint
	var metal := StandardMaterial3D.new()
	metal.albedo_color = Color(0.7, 0.72, 0.74)
	metal.metallic = 0.8
	metal.roughness = 0.35
	mat["metal"] = metal
	var dark := StandardMaterial3D.new()
	dark.albedo_color = Color(0.12, 0.12, 0.13)
	dark.roughness = 0.8
	mat["rubber"] = dark
	var steel := StandardMaterial3D.new()
	steel.albedo_color = Color(0.45, 0.44, 0.42)
	steel.metallic = 0.9
	steel.roughness = 0.3
	mat["steel"] = steel


func _mesh_instance(mesh: Mesh, node_name: String, shadows := true) -> MeshInstance3D:
	var mi := MeshInstance3D.new()
	mi.name = node_name
	mi.mesh = mesh
	mi.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_ON if shadows \
			else GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	add_child(mi)
	return mi


func _begin() -> SurfaceTool:
	var st := SurfaceTool.new()
	st.begin(Mesh.PRIMITIVE_TRIANGLES)
	return st


func _finish(st: SurfaceTool, material: Material, tangents := true) -> ArrayMesh:
	st.index()
	if tangents:
		st.generate_tangents()
	st.set_material(material)
	return st.commit()


# --------------------------------------------------------------------------- ground
func _fence_rect() -> Rect2:
	var r := Rect2(data.fence[0], Vector2.ZERO)
	for p in data.fence:
		r = r.expand(p)
	return r


func _build_ground() -> void:
	var r := _fence_rect()
	var st := _begin()
	MeshUtil.add_polygon(st, PackedVector2Array([r.position, Vector2(r.end.x, r.position.y), r.end,
			Vector2(r.position.x, r.end.y)]), 0.0, TILE_ASPHALT)
	_mesh_instance(_finish(st, mat["asphalt"]), "Asphalt", false)

	# Lawn around the fenced area (a frame, so it never overlaps the asphalt),
	# out to where the fog hides the edge.
	var big := r.grow(650.0)
	var g := _begin()
	var y := -0.002
	for q in [
		Rect2(big.position.x, big.position.y, big.size.x, r.position.y - big.position.y),
		Rect2(big.position.x, r.end.y, big.size.x, big.end.y - r.end.y),
		Rect2(big.position.x, r.position.y, r.position.x - big.position.x, r.size.y),
		Rect2(r.end.x, r.position.y, big.end.x - r.end.x, r.size.y),
	]:
		MeshUtil.add_polygon(g, PackedVector2Array([q.position, Vector2(q.end.x, q.position.y), q.end,
				Vector2(q.position.x, q.end.y)]), y, TILE_GRASS * 2.0)
	_mesh_instance(_finish(g, mat["grass"]), "Lawn", false)


func _build_pads() -> void:
	var st := _begin()
	for p in data.pads:
		MeshUtil.add_polygon(st, p, PAD_Y, TILE_CONCRETE)
	_mesh_instance(_finish(st, mat["concrete"]), "Pads", false)


# --------------------------------------------------------------------------- islands
func _inward_offset(poly: PackedVector2Array, d: float) -> PackedVector2Array:
	var a := MeshUtil.offset_polyline(poly, d, true)
	var inside := 0
	for p in a:
		if Geometry2D.is_point_in_polygon(p, poly):
			inside += 1
	if inside * 2 >= a.size():
		return a
	return MeshUtil.offset_polyline(poly, -d, true)


func _build_islands() -> void:
	var kerb := _begin()
	var grass := _begin()
	for raw_poly in data.islands:
		var poly := MeshUtil.clean(raw_poly, 0.05)
		if poly.size() < 3:
			continue
		var inside := func(p: Vector2) -> bool: return Geometry2D.is_point_in_polygon(p, poly)
		MeshUtil.add_wall(kerb, poly, 0.0, KERB_HEIGHT, true, inside, 1.0)
		var inner := _inward_offset(poly, KERB_WIDTH)
		var n := poly.size()
		for i in n:
			var j := (i + 1) % n
			var a := Vector3(poly[i].x, KERB_HEIGHT, poly[i].y)
			var b := Vector3(poly[j].x, KERB_HEIGHT, poly[j].y)
			var c := Vector3(inner[i].x, KERB_HEIGHT, inner[i].y)
			var d := Vector3(inner[j].x, KERB_HEIGHT, inner[j].y)
			MeshUtil.tri(kerb, a, b, c, Vector3.UP, 1.0)
			MeshUtil.tri(kerb, b, d, c, Vector3.UP, 1.0)
		var inner_inside := func(p: Vector2) -> bool: return not Geometry2D.is_point_in_polygon(p, inner)
		MeshUtil.add_wall(kerb, inner, GRASS_HEIGHT, KERB_HEIGHT, true, inner_inside, 1.0)
		# Grass top: Clipper inset is robust against the rare self-touching outline.
		var tops := Geometry2D.offset_polygon(poly, -KERB_WIDTH, Geometry2D.JOIN_MITER)
		for top in tops:
			MeshUtil.add_polygon(grass, top, GRASS_HEIGHT, TILE_GRASS)
	var kerb_mesh := _finish(kerb, mat["kerb"])
	var grass_mesh := _finish(grass, mat["grass"])
	_mesh_instance(kerb_mesh, "Kerbs", false)
	_mesh_instance(grass_mesh, "IslandGrass", false)
	_collision_faces.append_array(kerb_mesh.get_faces())
	_collision_faces.append_array(grass_mesh.get_faces())


# --------------------------------------------------------------------------- estakada
func estakada_height(x: float, z: float) -> float:
	if _est.is_empty():
		return 0.0
	if z < float(_est["z_north"]) - 0.05 or z > float(_est["z_south"]) + 0.05:
		return 0.0
	var xe0 := float(_est["x_foot_east"])
	var xe1 := float(_est["x_crest_east"])
	var xw1 := float(_est["x_crest_west"])
	var xw0 := float(_est["x_foot_west"])
	var h := float(_est["height"])
	if x >= xe0 or x <= xw0:
		return 0.0
	if x >= xe1:
		return h * smoothstep(xe0, xe1, x)
	if x >= xw1:
		return h
	return h * smoothstep(xw0, xw1, x)


func _build_estakada() -> void:
	if _est.is_empty():
		return
	var xw0 := float(_est["x_foot_west"])
	var xe0 := float(_est["x_foot_east"])
	var zn := float(_est["z_north"])
	var zs := float(_est["z_south"])
	var lift := PAD_Y
	var deck := _begin()
	var walls := _begin()
	var step := 0.5
	var x := xw0
	while x < xe0 - 1e-3:
		var x1 := minf(x + step, xe0)
		var h0 := estakada_height(x, (zn + zs) * 0.5) + lift
		var h1 := estakada_height(x1, (zn + zs) * 0.5) + lift
		var slope := (h1 - h0) / (x1 - x)
		var n := Vector3(-slope, 1.0, 0.0).normalized()
		MeshUtil.tri(deck, Vector3(x, h0, zn), Vector3(x1, h1, zn), Vector3(x, h0, zs), n, TILE_ASPHALT)
		MeshUtil.tri(deck, Vector3(x1, h1, zn), Vector3(x1, h1, zs), Vector3(x, h0, zs), n, TILE_ASPHALT)
		if h0 > lift + 0.01 or h1 > lift + 0.01:
			for zz in [zn, zs]:
				var out := Vector3(0, 0, -1) if zz == zn else Vector3(0, 0, 1)
				MeshUtil.tri_uv(walls, Vector3(x, 0, zz), Vector3(x1, 0, zz), Vector3(x, h0, zz),
						Vector2(x, 0) / 2.0, Vector2(x1, 0) / 2.0, Vector2(x, h0) / 2.0, out)
				MeshUtil.tri_uv(walls, Vector3(x1, 0, zz), Vector3(x1, h1, zz), Vector3(x, h0, zz),
						Vector2(x1, 0) / 2.0, Vector2(x1, h1) / 2.0, Vector2(x, h0) / 2.0, out)
		x = x1
	var deck_mesh := _finish(deck, mat["asphalt"])
	var wall_mesh := _finish(walls, mat["kerb"])
	_mesh_instance(deck_mesh, "EstakadaDeck", false)
	_mesh_instance(wall_mesh, "EstakadaWalls")
	_collision_faces.append_array(deck_mesh.get_faces())
	_collision_faces.append_array(wall_mesh.get_faces())
	_build_guard_rails(xw0, xe0, zn, zs)


func _build_guard_rails(xw0: float, xe0: float, zn: float, zs: float) -> void:
	var rail := _begin()
	var posts := _begin()
	var post := BoxMesh.new()
	post.size = Vector3(0.08, 0.8, 0.08)
	var rail_faces := PackedVector3Array()
	for side in [zn + 0.25, zs - 0.25]:
		var pts := PackedVector2Array()
		var x := xw0
		while x <= xe0:
			if estakada_height(x, (zn + zs) * 0.5) > 0.15:
				pts.append(Vector2(x, side))
			x += 1.0
		if pts.size() < 2:
			continue
		for i in pts.size():
			var p := pts[i]
			var h := estakada_height(p.x, (zn + zs) * 0.5)
			if i % 2 == 0:
				posts.append_from(post, 0, Transform3D(Basis(), Vector3(p.x, h + 0.4, p.y)))
			if i + 1 < pts.size():
				var q := pts[i + 1]
				var hq := estakada_height(q.x, (zn + zs) * 0.5)
				for face_dir in [-1.0, 1.0]:
					var nrm := Vector3(0, 0, face_dir)
					var a := Vector3(p.x, h + 0.45, p.y + face_dir * 0.03)
					var b := Vector3(q.x, hq + 0.45, q.y + face_dir * 0.03)
					var c := Vector3(p.x, h + 0.78, p.y + face_dir * 0.03)
					var d := Vector3(q.x, hq + 0.78, q.y + face_dir * 0.03)
					MeshUtil.tri(rail, a, b, c, nrm, 1.0)
					MeshUtil.tri(rail, b, d, c, nrm, 1.0)
				# Collision: a thin wall from the deck to above the rail.
				var ca := Vector3(p.x, h, p.y)
				var cb := Vector3(q.x, hq, q.y)
				var cc := Vector3(p.x, h + 0.85, p.y)
				var cd := Vector3(q.x, hq + 0.85, q.y)
				rail_faces.append_array([ca, cb, cc, cb, cd, cc, ca, cc, cb, cb, cc, cd])
	_mesh_instance(_finish(rail, mat["metal"], false), "GuardRails")
	_mesh_instance(_finish(posts, mat["metal"], false), "GuardRailPosts")
	_collision_faces.append_array(rail_faces)


# --------------------------------------------------------------------------- markings
func _densify(pts: PackedVector2Array, max_len: float, closed: bool) -> PackedVector2Array:
	var out := PackedVector2Array()
	var n := pts.size()
	var count := n if closed else n - 1
	for i in count:
		var a := pts[i]
		var b := pts[(i + 1) % n]
		out.append(a)
		var L := a.distance_to(b)
		var k := int(L / max_len)
		for j in range(1, k + 1):
			out.append(a.lerp(b, float(j) / float(k + 1)))
	if not closed:
		out.append(pts[n - 1])
	return out


func _build_markings() -> void:
	var m: Dictionary = data.raw["markings"]
	var st := _begin()
	var white := Color.WHITE
	var yellow := Color(1.0, 0.78, 0.2)
	for l in m["lines"]:
		var pts := _densify(CourseData.poly(l["p"]), 1.0, false)
		var color: Color = yellow if l.get("color", "white") == "yellow" else white
		var dash: Variant = l.get("dash")
		if dash is Array and dash.size() == 2:
			MeshUtil.add_dashed(st, pts, float(l["w"]), PAINT_Y, float(dash[0]), float(dash[1]), color)
		else:
			MeshUtil.add_ribbon(st, pts, float(l["w"]), PAINT_Y, false, 1.0, color)
	for p in m["polys"]:
		MeshUtil.add_polygon(st, CourseData.poly(p), PAINT_Y, 1.0)
	# Edge lines hugging every kerb (also the control lines of the exercises).
	var offset := float(m.get("edge_offset", 0.35))
	var ew := float(m.get("edge_width", 0.12))
	var skip: Array = []
	for q in m.get("edge_skip", []):
		skip.append(CourseData.poly(q))
	for isl in data.islands:
		for loop in Geometry2D.offset_polygon(MeshUtil.clean(isl, 0.05), offset, Geometry2D.JOIN_ROUND):
			if skip.is_empty():
				MeshUtil.add_ribbon(st, _densify(loop, 1.0, true), ew, PAINT_Y, true)
				continue
			# Cut the loop where it runs through a skip zone (parking pockets).
			var open := loop.duplicate()
			open.append(loop[0])
			var parts: Array = [open]
			for zone in skip:
				var next: Array = []
				for part in parts:
					next.append_array(Geometry2D.clip_polyline_with_polygon(part, zone))
				parts = next
			for part in parts:
				MeshUtil.add_ribbon(st, _densify(part, 1.0, false), ew, PAINT_Y, false)
	# Outer edge line along the fence: authored (rounded where the scheme rounds
	# it) or, without one, the fence rectangle inset.
	var outer := CourseData.poly(m["fence_line"]) if m.has("fence_line") else PackedVector2Array()
	if outer.is_empty():
		var r := _fence_rect().grow(-float(m.get("fence_inset", 0.45)))
		outer = PackedVector2Array([r.position, Vector2(r.end.x, r.position.y), r.end, Vector2(r.position.x, r.end.y)])
	MeshUtil.add_ribbon(st, _densify(outer, 1.0, true), 0.15, PAINT_Y, true)
	for a in m["arrows"]:
		_add_arrow(st, CourseData.v2(a["pos"]), float(a["yaw"]), str(a["kind"]))
	st.index()
	var mesh := st.commit()
	# Paint follows the estakada deck.
	var arrays := mesh.surface_get_arrays(0)
	var verts: PackedVector3Array = arrays[Mesh.ARRAY_VERTEX]
	for i in verts.size():
		verts[i].y += estakada_height(verts[i].x, verts[i].z)
	arrays[Mesh.ARRAY_VERTEX] = verts
	var final := ArrayMesh.new()
	final.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, arrays)
	final.surface_set_material(0, mat["paint"])
	_mesh_instance(final, "Markings", false)
	for t in m["texts"]:
		_add_text(str(t["text"]), CourseData.v2(t["pos"]), float(t["yaw"]), float(t["size"]))


## A painted word: a flat quad with the word pre-rendered by
## pipeline/make_hud_art.py (a Label3D's live glyph atlas made it vanish for
## single frames on phones). `size` is the font's em in metres / 0.9.
func _add_text(text: String, pos: Vector2, yaw_deg: float, size: float) -> void:
	var path := "res://assets/textures/road_text_%s.png" % text.md5_text().substr(0, 8)
	if not ResourceLoader.exists(path):
		push_warning("Painted word '%s' has no texture (%s): run pipeline/make_hud_art.py" % [text, path])
		return
	var tex: Texture2D = load(path)
	var k := size * 0.9 / TEXT_PX_PER_EM
	var quad := QuadMesh.new()
	quad.size = Vector2(tex.get_width(), tex.get_height()) * k
	var m := StandardMaterial3D.new()
	m.albedo_texture = tex
	m.albedo_color = Color(0.93, 0.93, 0.9)
	m.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	m.texture_filter = BaseMaterial3D.TEXTURE_FILTER_LINEAR_WITH_MIPMAPS_ANISOTROPIC
	m.roughness = 0.8
	var mi := MeshInstance3D.new()
	mi.name = "Text"
	mi.mesh = quad
	mi.material_override = m
	mi.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	mi.position = Vector3(pos.x, PAINT_Y + 0.004 + estakada_height(pos.x, pos.y), pos.y)
	mi.rotation_order = EULER_ORDER_YXZ
	mi.rotation = Vector3(-PI * 0.5, deg_to_rad(yaw_deg), 0)
	add_child(mi)


## Road arrows (~4.6 m long): a painted shaft plus a triangular head. `pos` is
## the middle of the painted footprint, so a one-way turn arrow has its shaft
## off-centre, away from the turn, and stays inside its lane.
## Local frame: +y = direction of travel, +x = to the driver's right.
func _add_arrow(st: SurfaceTool, pos: Vector2, yaw_deg: float, kind: String) -> void:
	var yaw := deg_to_rad(yaw_deg)
	var fwd := Vector2(-sin(yaw), -cos(yaw))
	var right := Vector2(cos(yaw), -sin(yaw))
	var shift := 0.0
	if kind.contains("L") != kind.contains("R"):
		shift = 0.85 if kind.contains("L") else -0.85
	var shapes: Array = [] # [shaft points, head direction, head length]
	if kind.contains("S"):
		shapes.append([PackedVector2Array([Vector2(0, -2.4), Vector2(0, 1.2)]), Vector2(0, 1), 1.0])
	for turn in ["L", "R"]:
		if not kind.contains(turn):
			continue
		var s := -1.0 if turn == "L" else 1.0
		var y0 := -1.0 if kind.contains("S") else -0.2
		var pts := PackedVector2Array()
		if not kind.contains("S"):
			pts.append(Vector2(0, -2.4))
		for k in 9:
			var a := k / 8.0 * PI * 0.5
			pts.append(Vector2(s * (0.9 - 0.9 * cos(a)), y0 + 0.9 * sin(a)))
		shapes.append([pts, Vector2(s, 0), 0.8])
	for sh in shapes:
		var line: PackedVector2Array = sh[0]
		var dir: Vector2 = sh[1]
		var world := PackedVector2Array()
		for q in line:
			world.append(pos + right * (q.x + shift) + fwd * q.y)
		MeshUtil.add_ribbon(st, world, 0.18, PAINT_Y, false)
		var end_pt: Vector2 = line[line.size() - 1]
		var side := Vector2(-dir.y, dir.x) * 0.36
		var head := PackedVector2Array()
		for q in [end_pt + side, end_pt + dir * float(sh[2]), end_pt - side]:
			head.append(pos + right * (q.x + shift) + fwd * q.y)
		MeshUtil.add_polygon(st, head, PAINT_Y, 1.0)


# --------------------------------------------------------------------------- railway
func _build_railway() -> void:
	var rw: Dictionary = data.raw.get("railway", {})
	if rw.is_empty():
		return
	var panels := _begin()
	var rails := _begin()
	var rail_list: Array = rw["rails"]
	if rail_list.size() < 2:
		return
	var a0 := CourseData.v2(rail_list[0]["a"])
	var b0 := CourseData.v2(rail_list[0]["b"])
	var a1 := CourseData.v2(rail_list[1]["a"])
	var z0 := minf(a0.y, a1.y) - 0.9
	var z1 := maxf(a0.y, a1.y) + 0.9
	MeshUtil.add_polygon(panels, PackedVector2Array([Vector2(a0.x, z0), Vector2(b0.x, z0), Vector2(b0.x, z1),
			Vector2(a0.x, z1)]), PAINT_Y - 0.002, 1.0)
	for rr in rail_list:
		var a := CourseData.v2(rr["a"])
		var b := CourseData.v2(rr["b"])
		for off in [-0.76, 0.76]:
			var p0 := Vector2(a.x, a.y + off)
			var p1 := Vector2(b.x, b.y + off)
			MeshUtil.add_ribbon(rails, PackedVector2Array([p0, p1]), 0.075, PAINT_Y + 0.01, false)
	_mesh_instance(_finish(panels, mat["rubber"], false), "RailwayPanels", false)
	_mesh_instance(_finish(rails, mat["steel"], false), "Rails", false)


# --------------------------------------------------------------------------- signs / lights
func _build_signs() -> void:
	var holder := Node3D.new()
	holder.name = "Signs"
	add_child(holder)
	for s in data.raw["signs"]:
		var node := SignFactory.make(str(s["code"]), float(s.get("height", 2.1)), float(s.get("size", 0.7)),
				s.get("plates", []))
		var p := CourseData.v2(s["pos"])
		node.position = Vector3(p.x, estakada_height(p.x, p.y), p.y)
		node.rotation.y = deg_to_rad(float(s["yaw"]))
		holder.add_child(node)
	_merge_sign_meshes(holder)


## Every sign is a pole plus one or more plates, i.e. two or three draw calls
## each. Merge all poles into one mesh and the plates into one mesh per face
## texture; the per-sign bodies keep only their collision shapes.
func _merge_sign_meshes(holder: Node3D) -> void:
	var groups := {} # material -> SurfaceTool
	for sign in holder.get_children():
		for child in sign.get_children():
			var mi := child as MeshInstance3D
			if mi == null:
				continue
			var m: Material = mi.material_override if mi.material_override else mi.mesh.surface_get_material(0)
			if not groups.has(m):
				groups[m] = _begin()
			var xf: Transform3D = (sign as Node3D).transform * mi.transform
			(groups[m] as SurfaceTool).append_from(mi.mesh, 0, xf)
			sign.remove_child(mi)
			mi.free()
	var k := 0
	for m in groups:
		var st: SurfaceTool = groups[m]
		st.index()
		var mesh := st.commit()
		mesh.surface_set_material(0, m)
		var mi := MeshInstance3D.new()
		mi.name = "SignMesh%d" % k
		mi.mesh = mesh
		holder.add_child(mi)
		k += 1


func _build_traffic_lights() -> void:
	traffic = TrafficController.new()
	traffic.name = "TrafficController"
	for l in data.raw["lights"]:
		var tl := TrafficLight.new()
		tl.setup(str(l["id"]), str(l["group"]))
		var p := CourseData.v2(l["pos"])
		tl.position = Vector3(p.x, 0.0, p.y)
		tl.rotation.y = deg_to_rad(float(l["yaw"]))
		add_child(tl)
		traffic.lights.append(tl)
	add_child(traffic)


func _build_lamp_posts() -> void:
	var r := _fence_rect()
	var centre := r.get_center()
	var st := _begin()
	var pole := CylinderMesh.new()
	pole.top_radius = 0.07
	pole.bottom_radius = 0.11
	pole.height = 9.0
	pole.radial_segments = 8
	var arm := BoxMesh.new()
	arm.size = Vector3(0.08, 0.08, 2.2)
	var head := BoxMesh.new()
	head.size = Vector3(0.35, 0.12, 0.7)
	var holder := Node3D.new()
	holder.name = "LampPosts"
	add_child(holder)
	for p in data.raw["lamp_posts"]:
		var pos := CourseData.v2(p)
		var dir := (centre - pos).normalized()
		var yaw := atan2(-dir.x, -dir.y)
		var basis := Basis(Vector3.UP, yaw)
		var base := Vector3(pos.x, 0, pos.y)
		st.append_from(pole, 0, Transform3D(Basis(), base + Vector3(0, 4.5, 0)))
		st.append_from(arm, 0, Transform3D(basis, base + Vector3(0, 8.9, 0) + basis * Vector3(0, 0, -1.0)))
		st.append_from(head, 0, Transform3D(basis, base + Vector3(0, 8.85, 0) + basis * Vector3(0, 0, -2.1)))
		var body := StaticBody3D.new()
		body.collision_layer = LAYER_OBSTACLE
		body.collision_mask = 0
		body.add_to_group("obstacle", true)
		var cs := CollisionShape3D.new()
		var cyl := CylinderShape3D.new()
		cyl.radius = 0.14
		cyl.height = 9.0
		cs.shape = cyl
		cs.position = Vector3(0, 4.5, 0)
		body.add_child(cs)
		body.position = base
		holder.add_child(body)
	_mesh_instance(_finish(st, mat["metal"], false), "LampPostMesh")


func _chainlink_texture() -> ImageTexture:
	var size := 64
	var img := Image.create(size, size, true, Image.FORMAT_RGBA8)
	img.fill(Color(0, 0, 0, 0))
	var wire := Color(0.72, 0.75, 0.73, 1.0)
	for i in size:
		for t in [-1, 0, 1]:
			var x1 := posmod(i + t, size)
			var x2 := posmod(size - 1 - i + t, size)
			img.set_pixel(x1, i, wire)
			img.set_pixel(x2, i, wire)
	img.generate_mipmaps()
	return ImageTexture.create_from_image(img)


func _build_fence() -> void:
	var r := _fence_rect().grow(1.6)
	var corners := [r.position, Vector2(r.end.x, r.position.y), r.end, Vector2(r.position.x, r.end.y)]
	var height := 2.0
	var mesh_st := _begin()
	var post_st := _begin()
	var post := CylinderMesh.new()
	post.top_radius = 0.035
	post.bottom_radius = 0.035
	post.height = height + 0.1
	post.radial_segments = 5
	post.rings = 0
	var fence_body := StaticBody3D.new()
	fence_body.name = "FenceBody"
	fence_body.collision_layer = LAYER_OBSTACLE
	fence_body.collision_mask = 0
	fence_body.add_to_group("obstacle", true)
	add_child(fence_body)
	for i in 4:
		var a: Vector2 = corners[i]
		var b: Vector2 = corners[(i + 1) % 4]
		var L := a.distance_to(b)
		var n := int(ceil(L / 3.0))
		for k in n + 1:
			var p := a.lerp(b, float(k) / n)
			post_st.append_from(post, 0, Transform3D(Basis(), Vector3(p.x, (height + 0.1) * 0.5, p.y)))
		var nrm2 := (b - a).normalized().orthogonal()
		var nrm := Vector3(nrm2.x, 0, nrm2.y)
		var va := Vector3(a.x, 0.05, a.y)
		var vb := Vector3(b.x, 0.05, b.y)
		var vc := Vector3(a.x, height, a.y)
		var vd := Vector3(b.x, height, b.y)
		MeshUtil.tri_uv(mesh_st, va, vb, vc, Vector2(0, 0), Vector2(L / 0.12, 0), Vector2(0, height / 0.12), nrm)
		MeshUtil.tri_uv(mesh_st, vb, vd, vc, Vector2(L / 0.12, 0), Vector2(L / 0.12, height / 0.12),
				Vector2(0, height / 0.12), nrm)
		var cs := CollisionShape3D.new()
		var bs := BoxShape3D.new()
		bs.size = Vector3(L, height, 0.1)
		cs.shape = bs
		var mid := (a + b) * 0.5
		cs.position = Vector3(mid.x, height * 0.5, mid.y)
		cs.rotation.y = -atan2(b.y - a.y, b.x - a.x)
		fence_body.add_child(cs)
	var fm := StandardMaterial3D.new()
	fm.albedo_texture = _chainlink_texture()
	fm.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA_SCISSOR
	fm.alpha_scissor_threshold = 0.5
	fm.cull_mode = BaseMaterial3D.CULL_DISABLED
	fm.metallic = 0.6
	fm.roughness = 0.5
	fm.texture_filter = BaseMaterial3D.TEXTURE_FILTER_LINEAR_WITH_MIPMAPS
	_mesh_instance(_finish(mesh_st, fm, false), "FenceMesh", false)
	var pm := StandardMaterial3D.new()
	pm.albedo_color = Color(0.25, 0.42, 0.3)
	pm.roughness = 0.6
	_mesh_instance(_finish(post_st, pm, false), "FencePosts")


# --------------------------------------------------------------------------- collision
func _build_collision() -> void:
	var ground := StaticBody3D.new()
	ground.name = "GroundBody"
	ground.collision_layer = LAYER_GROUND
	ground.collision_mask = 0
	var plane := CollisionShape3D.new()
	plane.shape = WorldBoundaryShape3D.new()
	ground.add_child(plane)
	if _collision_faces.size() > 0:
		var trimesh := ConcavePolygonShape3D.new()
		trimesh.backface_collision = true
		trimesh.set_faces(_collision_faces)
		var cs := CollisionShape3D.new()
		cs.shape = trimesh
		ground.add_child(cs)
	add_child(ground)


## World-space car spawn transform for the exam start (or any exercise start).
func spawn_transform(pos: Vector2, yaw_deg: float) -> Transform3D:
	var y := estakada_height(pos.x, pos.y) + 0.05
	return Transform3D(Basis(Vector3.UP, deg_to_rad(yaw_deg)), Vector3(pos.x, y, pos.y))
