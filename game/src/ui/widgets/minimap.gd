class_name Minimap
extends Control
## Heading-up map around the car: grass islands, exercise pads, the exam
## route ahead and the next exercise. Drawn from the course data each frame
## (a dozen polygons — cheap on any GPU).

var data: CourseData
var car: Car
var director: ExamDirector
var metres_per_px := 0.28
var _islands: Array[PackedVector2Array] = []
var _pads: Array[PackedVector2Array] = []
var _drawn_xf := Transform3D()
var _drawn_ex: Object


func _init() -> void:
	mouse_filter = Control.MOUSE_FILTER_IGNORE
	clip_contents = true
	# The HUD sizes the map to the space it has; a larger minimum would override that.
	custom_minimum_size = Vector2(120, 120)


func setup(p_data: CourseData, p_car: Car, p_director: ExamDirector) -> void:
	data = p_data
	car = p_car
	director = p_director
	for isl in data.islands:
		_islands.append(isl)
	for p in data.pads:
		_pads.append(p)
	Settings.changed.connect(func(_k: String) -> void: queue_redraw())


func _process(_delta: float) -> void:
	if car == null or not is_visible_in_tree():
		return
	# A parked car shows the same map; only repaint when it moves or the
	# next exercise changes.
	var xf := car.get_global_transform_interpolated()
	var ex: Object = director.upcoming_exercise() if director else null
	if xf.origin.distance_squared_to(_drawn_xf.origin) > 0.0004 or not xf.basis.is_equal_approx(_drawn_xf.basis) \
			or ex != _drawn_ex:
		_drawn_xf = xf
		_drawn_ex = ex
		queue_redraw()


func _draw() -> void:
	draw_style_box(UITheme.box(Color(0.12, 0.14, 0.16, 0.85), 22, 1, UITheme.LINE, 0), Rect2(Vector2.ZERO, size))
	if car == null or data == null:
		return
	var xf := car.get_global_transform_interpolated()
	var pos := Vector2(xf.origin.x, xf.origin.z)
	var f3 := -xf.basis.z
	var heading := atan2(f3.x, -f3.z) # 0 = facing -Z
	var k := 1.0 / metres_per_px
	var centre := size * Vector2(0.5, 0.62)
	# World -> map: translate to the car, rotate heading-up, scale.
	var t := Transform2D(-heading, Vector2.ZERO).scaled(Vector2(k, k))
	t = Transform2D(0, centre) * t * Transform2D(0, -pos)
	draw_set_transform_matrix(t)
	var fence := data.fence
	draw_colored_polygon(fence, Color(0.24, 0.26, 0.29))
	for p in _pads:
		draw_colored_polygon(p, Color(0.42, 0.44, 0.46))
	for isl in _islands:
		draw_colored_polygon(isl, Color(0.2, 0.42, 0.22))
	# Route ahead.
	if director and Session.route_visible():
		var s := director.tracker.s
		var pts := PackedVector2Array()
		var i0 := data.route_index(s)
		var i1 := data.route_index(s + 120.0)
		for i in range(i0, i1 + 1):
			pts.append(data.route[i])
		if pts.size() > 1:
			draw_polyline(pts, Color(0.35, 0.65, 1.0, 0.9), 1.6 * metres_per_px * 3.0, true)
		var ex := director.upcoming_exercise()
		if ex:
			var ep := data.route_point(ex.s0)
			draw_circle(ep, 2.2, UITheme.CAUTION)
	draw_set_transform_matrix(Transform2D.IDENTITY)
	# The car, always pointing up.
	var tri := PackedVector2Array([centre + Vector2(0, -12), centre + Vector2(8, 9), centre + Vector2(-8, 9)])
	draw_colored_polygon(tri, UITheme.TEXT)
	draw_polyline(PackedVector2Array([tri[0], tri[1], tri[2], tri[0]]), Color(0, 0, 0, 0.6), 2.0, true)
