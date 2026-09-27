class_name SignFactory
extends RefCounted
## Road signs: galvanised pole + printed plate(s) from assets/signs/<code>.png.
##
## A sign is placed with the yaw of the traffic it addresses; the plate's
## printed face (local +Z) then looks at the oncoming driver.

const SIGN_DIR := "res://assets/signs/"
const POLE_RADIUS := 0.035
const OBSTACLE_LAYER := 4

static var _shader: Shader
static var _pole_mat: StandardMaterial3D
static var _plate_mats := {}
static var _pole_mesh: CylinderMesh


static func _material_for(code: String) -> ShaderMaterial:
	if _plate_mats.has(code):
		return _plate_mats[code]
	if _shader == null:
		_shader = load("res://assets/shaders/sign.gdshader")
	var tex: Texture2D = load(SIGN_DIR + code + ".png")
	var m := ShaderMaterial.new()
	m.shader = _shader
	m.set_shader_parameter("face_tex", tex)
	_plate_mats[code] = m
	return m


static func pole_material() -> StandardMaterial3D:
	if _pole_mat == null:
		_pole_mat = StandardMaterial3D.new()
		_pole_mat.albedo_color = Color(0.62, 0.64, 0.66)
		_pole_mat.metallic = 0.7
		_pole_mat.roughness = 0.45
	return _pole_mat


static func _aspect(code: String) -> float:
	var tex: Texture2D = load(SIGN_DIR + code + ".png")
	if tex == null:
		return 1.0
	return float(tex.get_width()) / float(maxi(tex.get_height(), 1))


## Builds one sign. `size` is the plate's longer side in metres (0.7 = type II).
static func make(code: String, height: float, size: float, plates: Array) -> Node3D:
	var root := StaticBody3D.new()
	root.name = "Sign_" + code.replace(".", "_")
	root.collision_layer = OBSTACLE_LAYER
	root.collision_mask = 0
	root.add_to_group("obstacle", true)

	var top := height + size * 0.5
	var pole := MeshInstance3D.new()
	if _pole_mesh == null:
		_pole_mesh = CylinderMesh.new()
		_pole_mesh.top_radius = POLE_RADIUS
		_pole_mesh.bottom_radius = POLE_RADIUS
		_pole_mesh.height = 1.0
		_pole_mesh.radial_segments = 8
		_pole_mesh.rings = 1
		_pole_mesh.material = pole_material()
	pole.mesh = _pole_mesh
	pole.scale = Vector3(1, top, 1)
	pole.position = Vector3(0, top * 0.5, 0)
	root.add_child(pole)

	var shape := CollisionShape3D.new()
	var cyl := CylinderShape3D.new()
	cyl.radius = POLE_RADIUS + 0.02
	cyl.height = top
	shape.shape = cyl
	shape.position = Vector3(0, top * 0.5, 0)
	root.add_child(shape)

	var y := height
	y = _add_plate(root, code, size, y) - 0.04
	for p in plates:
		y = _add_plate(root, str(p), size, y - 0.02, true) - 0.04
	return root


## Adds a plate whose top edge sits at... centre at `y` for the main sign;
## returns the plate's bottom edge so supplementary plates stack below.
static func _add_plate(root: Node3D, code: String, size: float, y: float, below := false) -> float:
	var aspect := _aspect(code)
	var w := size if aspect >= 1.0 else size * aspect
	var h := size / aspect if aspect >= 1.0 else size
	if below:
		# Supplementary plates (7.x) are as wide as the main sign.
		w = size
		h = size / aspect
	var q := QuadMesh.new()
	q.size = Vector2(w, h)
	var mi := MeshInstance3D.new()
	mi.mesh = q
	mi.material_override = _material_for(code)
	var cy := y if not below else y - h * 0.5
	mi.position = Vector3(0, cy, POLE_RADIUS + 0.01)
	root.add_child(mi)
	return cy - h * 0.5
