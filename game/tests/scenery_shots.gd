extends Node
## Renders the course as the game loads it (baked course + surroundings) from the
## driver's chase view and a few aerial views, and prints draw/primitive
## counts per shot (needs a GPU, not --headless):
##   godot --path game res://tests/scenery_shots.tscn -- <out_dir> [quality]

var out_dir := "user://scenery_shots"
var quality := 2
var world: Node3D
var course: CourseBuilder
var car: Car
var cam: Camera3D
var shots: Array = []
var idx := 0
var wait := 0


func _ready() -> void:
	var args := OS.get_cmdline_user_args()
	if args.size() > 0:
		out_dir = args[0]
	if args.size() > 1:
		quality = int(args[1])
	DirAccess.make_dir_recursive_absolute(out_dir)
	get_window().size = Vector2i(1600, 800)
	world = Node3D.new()
	add_child(world)
	EnvironmentSetup.create(world, quality)
	var t0 := Time.get_ticks_usec()
	course = CourseBuilder.load_or_build(CourseData.get_default(), quality)
	print("course load %.1f ms" % ((Time.get_ticks_usec() - t0) / 1000.0))
	world.add_child(course)
	car = Car.new()
	world.add_child(car)
	car.configure("nexia2")
	car.freeze = true
	cam = Camera3D.new()
	cam.current = true
	cam.far = 1400.0
	world.add_child(cam)
	# [name, car xz, car yaw (deg, 0 = facing -z), camera]: camera is "chase"
	# (behind the car, as in the game) or [position, target] in world space.
	shots = [
		["light_approach", Vector2(-4.6, -32.0), 180.0, "chase"],
		["light_close", Vector2(-4.6, -18.0), 180.0, [Vector3(-4.2, 3.0, -15.5), Vector3(-6.8, 3.0, -10.3)]],
		["light_side", Vector2(-4.6, -18.0), 180.0, [Vector3(-9.6, 3.2, -12.6), Vector3(-6.8, 3.0, -10.3)]],
		["look_east", Vector2(70.0, -30.0), -90.0, "chase"],
		["look_west", Vector2(-70.0, 30.0), 90.0, "chase"],
		["look_north", Vector2(20.0, -20.0), 0.0, "chase"],
		["look_south", Vector2(-20.0, 20.0), 180.0, "chase"],
		["overview", Vector2(-20.0, 20.0), 180.0, [Vector3(0, 140, 95), Vector3(0, 0, 0)]],
		["aerial_wide", Vector2(-20.0, 20.0), 180.0, [Vector3(-60, 90, 230), Vector3(0, 0, 0)]],
	]


func _process(_delta: float) -> void:
	wait += 1
	if wait < 30:
		return
	if idx > 0:
		var img := get_viewport().get_texture().get_image()
		var name_: String = shots[idx - 1][0]
		img.save_png(out_dir.path_join(name_ + ".png"))
		print("shot %-15s draws=%d prims=%d" % [name_,
				RenderingServer.get_rendering_info(RenderingServer.RENDERING_INFO_TOTAL_DRAW_CALLS_IN_FRAME),
				RenderingServer.get_rendering_info(RenderingServer.RENDERING_INFO_TOTAL_PRIMITIVES_IN_FRAME)])
	if idx >= shots.size():
		get_tree().quit(0)
		return
	var s: Array = shots[idx]
	var p: Vector2 = s[1]
	car.teleport(course.spawn_transform(p, float(s[2])), true)
	car.freeze = true
	if s[3] is String:
		var xf := car.global_transform
		cam.fov = 70.0
		cam.global_position = xf * Vector3(0, 2.4, 6.2)
		cam.look_at(xf * Vector3(0, 1.1, -8.0), Vector3.UP)
	else:
		cam.fov = 60.0
		cam.global_position = s[3][0]
		cam.look_at(s[3][1], Vector3.UP)
	idx += 1
	wait = 0
