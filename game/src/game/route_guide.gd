class_name RouteGuide
extends MeshInstance3D
## A soft blue ribbon painted on the road along the next ~35 m of the exam
## route, plus glowing strips over the lines that matter in the current
## exercise (stop / fixation / start / end lines).

const AHEAD := 36.0
const WIDTH := 0.55

var data: CourseData
var director: ExamDirector
var course: CourseBuilder
var _mesh := ImmediateMesh.new()
var _t := 0.0


func setup(p_data: CourseData, p_director: ExamDirector, p_course: CourseBuilder) -> void:
	data = p_data
	director = p_director
	course = p_course
	mesh = _mesh
	cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	var m := StandardMaterial3D.new()
	m.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	m.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	m.vertex_color_use_as_albedo = true
	m.no_depth_test = false
	m.render_priority = 2
	m.cull_mode = BaseMaterial3D.CULL_DISABLED
	material_override = m


func _process(delta: float) -> void:
	_t -= delta
	if _t > 0.0:
		return
	_t = 0.1
	_mesh.clear_surfaces()
	if director == null or director.state != ExamDirector.State.RUNNING:
		return
	var show_route := Session.route_visible()
	var s0 := director.tracker.s + 2.0
	_mesh.surface_begin(Mesh.PRIMITIVE_TRIANGLES)
	var wrote := false
	if show_route:
		var step := 1.0
		var s := s0
		while s < s0 + AHEAD:
			var a := data.route_point(s)
			var b := data.route_point(s + step)
			var d := (b - a).normalized()
			var n := Vector2(-d.y, d.x) * WIDTH * 0.5
			var fade_a := 1.0 - (s - s0) / AHEAD
			var fade_b := 1.0 - (s + step - s0) / AHEAD
			var ca := Color(0.3, 0.62, 1.0, 0.33 * fade_a)
			var cb := Color(0.3, 0.62, 1.0, 0.33 * fade_b)
			_quad(a + n, a - n, b + n, b - n, ca, ca, cb, cb)
			wrote = true
			s += step
	if Session.hints_enabled():
		var ex := director.current_exercise()
		if ex:
			for line in ex.highlight:
				var a := CourseData.v2(line["a"])
				var b := CourseData.v2(line["b"])
				var d := (b - a).normalized()
				var n := Vector2(-d.y, d.x) * 0.22
				# Green "put the wheels here": yellow would read as the box's limit line.
				var c := Color(0.25, 0.9, 0.45, 0.5)
				_quad(a + n, a - n, b + n, b - n, c, c, c, c)
				wrote = true
	if wrote:
		_mesh.surface_end()
	else:
		_mesh.clear_surfaces()


func _y(p: Vector2) -> float:
	return (course.estakada_height(p.x, p.y) if course else 0.0) + 0.035


func _quad(a: Vector2, b: Vector2, c: Vector2, d: Vector2, ca: Color, cb: Color, cc: Color, cd: Color) -> void:
	var va := Vector3(a.x, _y(a), a.y)
	var vb := Vector3(b.x, _y(b), b.y)
	var vc := Vector3(c.x, _y(c), c.y)
	var vd := Vector3(d.x, _y(d), d.y)
	for pair in [[va, ca], [vb, cb], [vc, cc], [vb, cb], [vd, cd], [vc, cc]]:
		_mesh.surface_set_color(pair[1])
		_mesh.surface_add_vertex(pair[0])
