class_name TrafficLight
extends StaticBody3D
## One three-aspect traffic signal on a pole: a rounded dark housing with
## round lenses under visors, on a yellow contrast board with a black rim.
## The lamp face (local +Z) looks at the traffic it controls. State is set by
## TrafficController.
##
## Built once by CourseBuilder (setup()) and saved into the baked course
## scene; on load, _ready() re-links the lamp meshes by name. A course baked
## with the older box-shaped model is upgraded in _ready().
## Pole, housing, visors and board are one mesh with vertex colours, shared
## by every light (one draw call per light plus the three lenses); the lamp
## materials are shared as well.

enum Aspect { OFF, RED, RED_YELLOW, GREEN, GREEN_BLINK, YELLOW }

const HOUSING_COLOR := Color(0.075, 0.08, 0.085)
const LAMP_COLORS := [Color(1.0, 0.12, 0.08), Color(1.0, 0.7, 0.05), Color(0.1, 1.0, 0.45)]
const POLE_H := 2.6
const HEAD_Y := POLE_H + 0.45 # centre of the housing
const LAMP_STEP := 0.3
const LENS_R := 0.1
const LEGACY_NODES := ["Pole", "Housing", "Board"]

@export var light_id := ""
@export var group := ""
var aspect: Aspect = Aspect.OFF
var _lamps: Array[MeshInstance3D] = []
var _blink_t := 0.0

static var _body_mesh: ArrayMesh
static var _lens_mesh: ArrayMesh
static var _on_mats: Array[StandardMaterial3D] = []
static var _off_mats: Array[StandardMaterial3D] = []


func setup(p_id: String, p_group: String) -> void:
	light_id = p_id
	group = p_group
	name = "TrafficLight_" + p_id
	collision_layer = SignFactory.OBSTACLE_LAYER
	collision_mask = 0
	add_to_group("obstacle", true)
	_build()


func _ready() -> void:
	if get_node_or_null("Body") == null:
		_upgrade_legacy()
	if _lamps.is_empty():
		for i in 3:
			var lamp := get_node_or_null("Lamp%d" % i) as MeshInstance3D
			if lamp:
				_lamps.append(lamp)
	_make_materials()
	set_aspect(aspect if aspect != Aspect.OFF else Aspect.RED)


## Swaps the box-shaped model of an older baked course for the current one
## (the collision shape stays).
func _upgrade_legacy() -> void:
	for n in LEGACY_NODES + ["Lamp0", "Lamp1", "Lamp2"]:
		var old := get_node_or_null(n)
		if old:
			remove_child(old)
			old.free()
	_lamps.clear()
	_build_visuals()


func _build() -> void:
	var shape := CollisionShape3D.new()
	shape.name = "Shape"
	var cyl := CylinderShape3D.new()
	cyl.radius = 0.1
	cyl.height = POLE_H + 0.9
	shape.shape = cyl
	shape.position = Vector3(0, (POLE_H + 0.9) * 0.5, 0)
	add_child(shape)
	_build_visuals()


func _build_visuals() -> void:
	var body := MeshInstance3D.new()
	body.name = "Body"
	body.mesh = _get_body_mesh()
	add_child(body)
	for i in 3:
		var lamp := MeshInstance3D.new()
		lamp.name = "Lamp%d" % i
		lamp.mesh = _get_lens_mesh()
		lamp.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
		lamp.position = Vector3(0, HEAD_Y + LAMP_STEP - i * LAMP_STEP, 0.112)
		add_child(lamp)
		_lamps.append(lamp)


static func _get_body_mesh() -> ArrayMesh:
	if _body_mesh:
		return _body_mesh
	var st := SurfaceTool.new()
	st.begin(Mesh.PRIMITIVE_TRIANGLES)
	var id := Transform3D.IDENTITY
	var pole_col := Color(0.52, 0.54, 0.56)
	# Pole with a base flange and a clamp under the head.
	ProcGeo.cylinder(st, id, Vector3.ZERO, 0.13, 0.12, 0.06, 16, pole_col.darkened(0.2))
	ProcGeo.cylinder(st, id, Vector3.ZERO, 0.058, 0.05, HEAD_Y - 0.5, 14, pole_col, false)
	ProcGeo.cylinder(st, id, Vector3(0, HEAD_Y - 0.62, 0), 0.07, 0.07, 0.1, 14, pole_col.darkened(0.3))
	# Contrast board: black rim behind a yellow face, rounded corners.
	var c := Vector3(0, HEAD_Y, 0)
	ProcGeo.rounded_slab(st, id, c, 0.66, 1.26, 0.16, -0.15, -0.128, 6, Color(0.05, 0.05, 0.05))
	ProcGeo.rounded_slab(st, id, c, 0.6, 1.2, 0.13, -0.128, -0.118, 6, Color(0.96, 0.78, 0.06), false)
	# Housing: a dark rounded box, fully round at the top and bottom.
	ProcGeo.rounded_slab(st, id, c, 0.34, 0.98, 0.16, -0.118, 0.11, 8, HOUSING_COLOR)
	for i in 3:
		var lc := Vector3(0, HEAD_Y + LAMP_STEP - i * LAMP_STEP, 0.0)
		# Glossy black bezel and a visor over each lens.
		ProcGeo.ring(st, id, lc + Vector3(0, 0, 0.1115), LENS_R - 0.004, LENS_R + 0.022, 24, Color(0.02, 0.02, 0.02))
		ProcGeo.visor(st, id, lc + Vector3(0, 0, 0.11), LENS_R + 0.012, 0.008, 0.17, -0.25, PI + 0.25, 14,
				HOUSING_COLOR, Color(0.01, 0.01, 0.01))
	st.index()
	var m := StandardMaterial3D.new()
	m.vertex_color_use_as_albedo = true
	m.roughness = 0.45
	m.metallic_specular = 0.6
	st.set_material(m)
	_body_mesh = st.commit()
	return _body_mesh


## Slightly domed round lens, facing +z, flat back at z = 0.
static func _get_lens_mesh() -> ArrayMesh:
	if _lens_mesh:
		return _lens_mesh
	var st := SurfaceTool.new()
	st.begin(Mesh.PRIMITIVE_TRIANGLES)
	var seg := 24
	var rings := 3
	var dome := 0.025
	for j in rings:
		var r0 := LENS_R * float(j) / rings
		var r1 := LENS_R * float(j + 1) / rings
		var z0 := dome * (1.0 - pow(float(j) / rings, 2.0))
		var z1 := dome * (1.0 - pow(float(j + 1) / rings, 2.0))
		for i in seg:
			var a0 := TAU * i / seg
			var a1 := TAU * (i + 1) / seg
			var d0 := Vector3(cos(a0), sin(a0), 0)
			var d1 := Vector3(cos(a1), sin(a1), 0)
			var n := func(d: Vector3, r: float) -> Vector3:
				return (Vector3(0, 0, 1) + d * (2.0 * dome * r / (LENS_R * LENS_R)) * 1.5).normalized()
			var p00 := d0 * r0 + Vector3(0, 0, z0)
			var p01 := d1 * r0 + Vector3(0, 0, z0)
			var p10 := d0 * r1 + Vector3(0, 0, z1)
			var p11 := d1 * r1 + Vector3(0, 0, z1)
			if j > 0:
				ProcGeo.tri(st, p00, p11, p01, n.call(d0, r0), n.call(d1, r1), n.call(d1, r0), Color.WHITE)
			ProcGeo.tri(st, p00, p10, p11, n.call(d0, r0), n.call(d0, r1), n.call(d1, r1), Color.WHITE)
	st.index()
	_lens_mesh = st.commit()
	return _lens_mesh


static func _make_materials() -> void:
	if not _on_mats.is_empty():
		return
	for i in 3:
		var on := StandardMaterial3D.new()
		on.albedo_color = LAMP_COLORS[i]
		on.emission_enabled = true
		on.emission = LAMP_COLORS[i]
		on.emission_energy_multiplier = 3.2
		on.roughness = 0.15
		_on_mats.append(on)
		var off := StandardMaterial3D.new()
		off.albedo_color = LAMP_COLORS[i].darkened(0.78)
		off.roughness = 0.12
		off.metallic_specular = 0.8
		_off_mats.append(off)


func set_aspect(a: Aspect) -> void:
	aspect = a
	_refresh(true)


func _refresh(blink_on: bool) -> void:
	if _lamps.size() < 3 or _on_mats.size() < 3:
		return
	var red := aspect == Aspect.RED or aspect == Aspect.RED_YELLOW
	var yellow := aspect == Aspect.YELLOW or aspect == Aspect.RED_YELLOW
	var green := aspect == Aspect.GREEN or (aspect == Aspect.GREEN_BLINK and blink_on)
	var states := [red, yellow, green]
	for i in 3:
		_lamps[i].material_override = _on_mats[i] if states[i] else _off_mats[i]


func _process(delta: float) -> void:
	if aspect == Aspect.GREEN_BLINK:
		_blink_t += delta
		_refresh(fmod(_blink_t, 1.0) < 0.5)


## True when a driver may enter the junction (green or blinking green).
func is_go() -> bool:
	return aspect == Aspect.GREEN or aspect == Aspect.GREEN_BLINK


func is_stop() -> bool:
	return aspect == Aspect.RED or aspect == Aspect.RED_YELLOW or aspect == Aspect.YELLOW
