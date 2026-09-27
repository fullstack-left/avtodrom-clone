extends SceneTree
## Head-less integration test of AvtoVehicle inside Jolt:
##   godot --headless --path game --script res://tests/vehicle_test.gd
##
## Builds a flat pad, a 16 % ramp and a 15 cm kerb, then drives the real
## vehicle node through a scripted lesson and checks the outcome.

var car: AvtoVehicle
var t := 0.0
var phase := 0
var phase_t := 0.0
var failures := 0
var checks := 0
var log_lines: PackedStringArray = []
var start_pos := Vector3.ZERO
var mark := Vector3.ZERO


func _initialize() -> void:
	var world := Node3D.new()
	root.add_child(world)

	_add_box(world, Vector3(0, -0.5, 0), Vector3(400, 1, 400), Basis())
	# 16 % ramp rising towards -x, starting at x = -40.
	var angle := atan(0.16)
	var ramp_len := 30.0
	var ramp_basis := Basis(Vector3(0, 0, 1), -angle)
	var ramp_center := Vector3(-40 - cos(angle) * ramp_len * 0.5, sin(angle) * ramp_len * 0.5 - 0.5 * cos(angle), 60)
	_add_box(world, ramp_center, Vector3(ramp_len, 1, 8), ramp_basis)
	# Kerb 15 cm high, 3 m wide, across the path at z = -30.
	_add_box(world, Vector3(0, 0.075, -30), Vector3(3, 0.15, 0.3), Basis())

	car = AvtoVehicle.new()
	car.preset = "nexia2"
	var shape := CollisionShape3D.new()
	var box := BoxShape3D.new()
	box.size = Vector3(1.6, 0.8, 4.3)
	shape.shape = box
	shape.position = Vector3(0, 0.75, 0)
	car.add_child(shape)
	world.add_child(car)
	car.teleport(Transform3D(Basis(), Vector3(0, 0.05, 0)), false)
	start_pos = Vector3(0, 0.05, 0)


func _add_box(parent: Node, pos: Vector3, size: Vector3, basis: Basis) -> void:
	var body := StaticBody3D.new()
	var cs := CollisionShape3D.new()
	var bs := BoxShape3D.new()
	bs.size = size
	cs.shape = bs
	body.add_child(cs)
	body.transform = Transform3D(basis, pos)
	parent.add_child(body)


func check(ok: bool, what: String, value: Variant) -> void:
	checks += 1
	if not ok:
		failures += 1
	print("    [%s] %-55s %s" % [" ok " if ok else "FAIL", what, str(value)])


func next_phase(title: String) -> void:
	phase += 1
	phase_t = 0.0
	print(title)


func _physics_process(delta: float) -> bool:
	t += delta
	phase_t += delta
	var speed := car.get_forward_speed() * 3.6
	match phase:
		0: # settle on the springs
			if phase_t > 1.5:
				var h := car.global_position.y
				check(abs(h) < 0.06, "ride height settles near 0 (body origin y)", "%.3f" % h)
				check(car.linear_velocity.length() < 0.02, "car at rest after landing", "%.4f" % car.linear_velocity.length())
				next_phase("Start the engine with the key")
				car.ignition = true
				car.starter = true
		1:
			if car.is_engine_running():
				car.starter = false
			if phase_t > 3.0:
				check(car.is_engine_running(), "engine running", car.get_rpm())
				check(abs(car.get_rpm() - car.get_idle_rpm()) < 80, "idling", "%.0f rpm" % car.get_rpm())
				next_phase("Pull away in 1st with the auto-clutch, light throttle")
				car.auto_clutch = true
				check(car.request_gear(1), "1st gear engaged", 1)
				car.throttle = 0.25
		2:
			if phase_t > 5.0:
				check(speed > 10 and speed < 40, "speed after 5 s", "%.1f km/h" % speed)
				check(abs(car.global_position.x - start_pos.x) < 0.3, "drives straight", "%.2f m" % (car.global_position.x - start_pos.x))
				check(car.is_engine_running(), "no stall", car.get_rpm())
				next_phase("Brake to a stop")
				car.throttle = 0.0
				car.brake = 0.7
		3:
			if phase_t > 4.0:
				check(car.linear_velocity.length() < 0.05, "stopped", "%.3f m/s" % car.linear_velocity.length())
				check(car.is_engine_running(), "engine still running", car.get_rpm())
				next_phase("Reverse 5 m")
				car.brake = 0.0
				check(car.request_gear(-1), "reverse engaged", -1)
				car.throttle = 0.15
				mark = car.global_position
		4:
			if car.get_forward_speed() < -0.1 and car.global_position.distance_to(mark) > 5.0:
				car.throttle = 0.0
				car.brake = 0.8
			if phase_t > 8.0:
				check(car.global_position.distance_to(mark) > 4.0, "reversed", "%.2f m" % car.global_position.distance_to(mark))
				check(car.linear_velocity.length() < 0.05, "stopped again", "%.3f" % car.linear_velocity.length())
				next_phase("Full-lock circle to the right")
				car.brake = 0.0
				car.request_gear(1)
				car.steering_wheel = 540.0
				car.throttle = 0.12
				mark = car.global_position
		5:
			if phase_t > 14.0:
				var yaw_deg := rad_to_deg(car.global_transform.basis.get_euler().y)
				check(car.get_forward_speed() > 0.5, "moving in a circle", "%.2f m/s" % car.get_forward_speed())
				check(car.angular_velocity.y < -0.1, "turning right (yaw rate < 0)", "%.3f" % car.angular_velocity.y)
				next_phase("Stop, straighten, handbrake on, park")
				car.throttle = 0.0
				car.brake = 0.8
				car.steering_wheel = 0.0
		6:
			if phase_t > 3.0:
				car.handbrake = 1.0
				car.brake = 0.0
				car.request_gear(0)
				next_phase("Teleport onto the 16 % ramp, handbrake holds")
				var angle := atan(0.16)
				var xf := Transform3D(Basis(Vector3(0, 1, 0), PI * 0.5) * Basis(Vector3(1, 0, 0), angle), Vector3(-52, 0, 60))
				xf.origin.y = tan(angle) * 12.0 + 0.3
				car.teleport(xf, true)
				mark = Vector3.INF
		7:
			if phase_t > 2.0 and mark == Vector3.INF:
				mark = car.global_position
			if phase_t > 8.0:
				var moved := car.global_position.distance_to(mark)
				check(moved < 0.05, "handbrake holds on the ramp", "%.3f m" % moved)
				next_phase("Hill start: 1st, gas, release handbrake")
				car.auto_clutch = true
				car.request_gear(1)
				car.throttle = 0.4
				mark = car.global_position
		8:
			if phase_t > 1.0:
				car.handbrake = 0.0
			if phase_t > 6.0:
				var along := (car.global_position - mark).dot(-car.global_transform.basis.z)
				check(along > 3.0, "climbed the ramp", "%.2f m" % along)
				check(car.is_engine_running(), "no stall on the hill", car.get_rpm())
				next_phase("Drive over the 15 cm kerb at walking pace")
				car.teleport(Transform3D(Basis(), Vector3(0, 0.05, -20)), true)
				car.handbrake = 0.0
				car.throttle = 0.0
		9:
			if phase_t > 1.0 and phase_t < 1.1:
				car.auto_clutch = true
				car.request_gear(1)
				car.throttle = 0.3
			if phase_t > 10.0:
				check(car.global_position.z < -32.0, "crossed the kerb", "z=%.2f" % car.global_position.z)
				check(car.global_transform.basis.y.y > 0.95, "still upright", "%.3f" % car.global_transform.basis.y.y)
				next_phase("done")
		10:
			print("\n%d checks, %d failed" % [checks, failures])
			quit(1 if failures > 0 else 0)
	if t > 120.0:
		print("TIMEOUT in phase %d" % phase)
		quit(1)
	return false
