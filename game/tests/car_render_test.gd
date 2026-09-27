extends Node
## Renders the exam car from outside and from the driver's seat and saves PNGs
## (needs a GPU, not --headless). Used to review the car model and cabin:
##   godot --path game res://tests/car_render_test.tscn -- <out_dir> [car preset]

var out_dir := "user://car_shots"
var world: Node3D
var car: Car
var cam: Camera3D
var shots: Array = []
var idx := 0
var wait := 0


func _ready() -> void:
	var args := OS.get_cmdline_user_args()
	if args.size() > 0:
		out_dir = args[0]
	DirAccess.make_dir_recursive_absolute(out_dir)
	get_window().size = Vector2i(1280, 720)
	world = Node3D.new()
	add_child(world)
	EnvironmentSetup.create(world, 2)
	var builder := CourseBuilder.new()
	world.add_child(builder)
	builder.build(CourseData.get_default(), 2)
	car = Car.new()
	world.add_child(car)
	car.configure(args[1] if args.size() > 1 else "nexia2")
	var data := CourseData.get_default()
	var start: Dictionary = data.exercise("start")["spawn"]
	car.teleport(builder.spawn_transform(CourseData.v2(start["pos"]), float(start["yaw"])), true)
	cam = Camera3D.new()
	cam.current = true
	cam.far = 500
	world.add_child(cam)
	# Car-relative views (body frame: +x right, -z forward). fov, eye, target.
	shots = [
		["front34", 40, Vector3(-3.4, 1.5, -4.6), Vector3(0, 0.6, 0)],
		["rear34", 40, Vector3(3.4, 1.7, 4.8), Vector3(0, 0.6, 0)],
		["side", 35, Vector3(-7.5, 1.0, 0.0), Vector3(0, 0.7, 0)],
		["front", 35, Vector3(0, 1.2, -7.0), Vector3(0, 0.7, 0)],
		["top", 40, Vector3(0.01, 8.0, 0.0), Vector3(0, 0, 0)],
		["cockpit", -1, Vector3.ZERO, Vector3.ZERO],
		["cockpit_wide", -2, Vector3.ZERO, Vector3.ZERO],
		["dash_centre", 60, Vector3(0.1, 1.15, 0.45), Vector3(0.0, 0.9, -0.55)],
		["passenger", 70, Vector3(0.38, 1.12, 0.2), Vector3(-0.2, 0.85, -0.7)],
	]


func _process(_delta: float) -> void:
	wait += 1
	if wait < 25:
		return
	if idx > 0:
		var img := get_viewport().get_texture().get_image()
		img.save_png(out_dir.path_join(str(shots[idx - 1][0]) + ".png"))
		print("saved ", shots[idx - 1][0])
	if idx >= shots.size():
		get_tree().quit(0)
		return
	var s: Array = shots[idx]
	var xf := car.global_transform
	var fov: float = s[1]
	if fov < 0:
		cam.global_transform = Transform3D(xf.basis * Basis(Vector3.RIGHT, -0.07), xf * car.cockpit_eye)
		cam.fov = 72 if fov == -1 else 95
	else:
		cam.fov = fov
		cam.global_position = xf * (s[2] as Vector3)
		cam.look_at(xf * (s[3] as Vector3), Vector3.UP)
	idx += 1
	wait = 0
