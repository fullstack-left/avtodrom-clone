extends Node
## Renders the course from a set of viewpoints and saves PNGs (needs a GPU,
## not --headless):
##   godot --path game res://tests/render_test.tscn -- <out_dir> [car preset]

var out_dir := "user://shots"
var world: Node3D
var builder: CourseBuilder
var car: Car
var cam: Camera3D
var shots: Array = []
var idx := 0
var wait := 0
var frame_t := 0.0
var build_ms := 0


func _ready() -> void:
	var args := OS.get_cmdline_user_args()
	if args.size() > 0:
		out_dir = args[0]
	DirAccess.make_dir_recursive_absolute(out_dir)
	get_window().size = Vector2i(1280, 720)
	world = Node3D.new()
	add_child(world)
	EnvironmentSetup.create(world, 2)
	var t0 := Time.get_ticks_msec()
	builder = CourseBuilder.new()
	world.add_child(builder)
	builder.build(CourseData.get_default(), 2)
	build_ms = Time.get_ticks_msec() - t0
	print("course built in %d ms" % build_ms)
	car = Car.new()
	world.add_child(car)
	car.configure(args[1] if args.size() > 1 else "nexia2")
	var data := CourseData.get_default()
	var start: Dictionary = data.exercise("start")["spawn"]
	car.teleport(builder.spawn_transform(CourseData.v2(start["pos"]), float(start["yaw"])), true)
	cam = Camera3D.new()
	cam.current = true
	cam.far = 1500
	world.add_child(cam)
	var sp := CourseData.v2(start["pos"])
	if args.has("tiles"):
		# Top-down orthographic tiles of the whole course (inspection of kerbs
		# and paint): 4 × 3 tiles of 22 × 12.4 m... sized to the fence.
		var fence := builder._fence_rect()
		var cols := 4
		var rows := 3
		for r in rows:
			for c in cols:
				var cx := fence.position.x + fence.size.x * (c + 0.5) / cols
				var cz := fence.position.y + fence.size.y * (r + 0.5) / rows
				shots.append(["tile_%d_%d" % [r, c], Vector3(cx, 120, cz), Vector3(cx, 0, cz - 0.001),
						"ortho", fence.size.x / cols])
		return
	shots = [
		["overview", Vector3(0, 140, 95), Vector3(0, 0, 0)],
		["start_chase", Vector3(sp.x + 9, 3.2, sp.y + 2.5), Vector3(sp.x - 3, 0.8, sp.y)],
		["cockpit", Vector3.ZERO, Vector3.ZERO],
		["intersection", Vector3(-2, 14, 18), Vector3(0, 0, 0.5)],
		["estakada", Vector3(-26, 6, -34), Vector3(-45, 1.2, -43)],
		["zmeyka", Vector3(-12, 9, 35), Vector3(-25, 0, 26)],
		["boxes", Vector3(40, 13, 5), Vector3(40, 0, 25)],
		["car_close", Vector3(sp.x + 3.5, 1.4, sp.y + 4.0), Vector3(sp.x, 0.7, sp.y)],
		["exam_centre", Vector3(40, 6, -52), Vector3(22, 4, -95)],
		["from_field", Vector3(-20, 1.6, -30), Vector3(10, 3, -110)],
		["aerial", Vector3(-150, 60, 110), Vector3(0, 0, -20)],
		# Car-relative views (body frame: +x right, -z forward).
		["car_front", Vector3(-2.6, 1.3, -5.2), Vector3(0, 0.6, 0), true],
		["car_rear", Vector3(2.4, 1.5, 5.4), Vector3(0, 0.7, 0), true],
		["car_side", Vector3(-6.5, 1.1, 0.0), Vector3(0, 0.7, 0), true],
	]


func _process(delta: float) -> void:
	frame_t += delta
	wait += 1
	if wait < 25:
		return
	if idx > 0:
		var img := get_viewport().get_texture().get_image()
		var name_: String = shots[idx - 1][0]
		img.save_png(out_dir.path_join(name_ + ".png"))
		print("saved ", name_)
	if idx >= shots.size():
		get_tree().quit(0)
		return
	var s: Array = shots[idx]
	if s[0] == "cockpit":
		var xf := car.global_transform
		cam.global_transform = Transform3D(xf.basis * Basis(Vector3.RIGHT, -0.07), xf * car.cockpit_eye)
		cam.fov = 72
	elif s.size() > 4 and s[3] == "ortho":
		cam.projection = Camera3D.PROJECTION_ORTHOGONAL
		cam.size = float(s[4]) * 0.5625 * 1.02
		cam.global_position = s[1]
		cam.look_at(s[2], Vector3(0, 0, -1))
	elif s.size() > 3:
		var xf := car.global_transform
		cam.fov = 45
		cam.global_position = xf * (s[1] as Vector3)
		cam.look_at(xf * (s[2] as Vector3), Vector3.UP)
	else:
		cam.fov = 60
		cam.global_position = s[1]
		cam.look_at(s[2], Vector3.UP)
	idx += 1
	wait = 0
