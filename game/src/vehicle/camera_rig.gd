class_name CameraRig
extends Node3D
## Three views of the car, all of them turnable by dragging on the screen:
##   COCKPIT — the driver's eye; drag to turn the head all the way round;
##   CHASE   — close behind the car; drag to orbit it 360°, pinch / mouse
##             wheel to zoom; swings in front of the car when reversing;
##   TOP     — bird's-eye view for learning the manoeuvres.
## After a drag the view stays where it was put while the car stands still
## and eases back to the default once the car drives on.

signal mode_changed(mode: int)

enum Mode { COCKPIT, CHASE, TOP }

const CHASE_DIST := 5.0 # m from the pivot (roof height above the car centre)
const CHASE_PITCH := 0.2 # rad above the horizon
const PIVOT_HEIGHT := 1.05
const LOOK_LIFT := 0.45 # m above the pivot the chase view aims at
const ZOOM_MIN := 0.65
const ZOOM_MAX := 2.2
const RETURN_DELAY := 1.6 # s after the finger is lifted
const RETURN_RATE := 2.2 # 1/s, exponential ease back
const DRAG_TURN := 1.25 # full screen-width drag = 1.25 turns
const DODGES := [0.35, -0.35, 0.7, -0.7] # rad: sideways steps round a post

var car: Car
var mode: Mode = Mode.COCKPIT
var camera: Camera3D
## User offsets (radians) on top of the default view.
var orbit_yaw := 0.0
var orbit_pitch := 0.0
var zoom := 1.0
var _dragging := false
var _idle_t := 0.0
var _heading := 0.0 # smoothed car yaw (chase view)
var _reverse := 0.0 # 0 = behind the car, 1 = in front (reversing)
var _initialised := false
var _clear := 1.0 # share of the chase distance that is free of obstacles
var _dodge := 0.0 # sideways step while a post stands behind the car
var _dodge_target := 0.0
var _free_cache := 1.0
var _probe := SphereShape3D.new()


func _init(p_car: Car) -> void:
	car = p_car
	name = "CameraRig"
	camera = Camera3D.new()
	camera.name = "Camera"
	camera.current = true
	camera.near = 0.05
	camera.far = 900.0
	# Placed every frame from the car's interpolated transform already.
	camera.physics_interpolation_mode = Node.PHYSICS_INTERPOLATION_MODE_OFF
	add_child(camera)


func set_mode(m: Mode) -> void:
	mode = m
	reset_view()
	_initialised = false
	car.set_interior_audio(mode == Mode.COCKPIT)
	mode_changed.emit(mode)


func cycle() -> void:
	set_mode(((mode + 1) % 3) as Mode)


func reset_view() -> void:
	orbit_yaw = 0.0
	orbit_pitch = 0.0
	zoom = 1.0
	_dodge = 0.0
	_dodge_target = 0.0
	_clear = 1.0


## Screen drag in pixels (from the HUD's look pad or the mouse).
func drag(delta_px: Vector2, viewport_width: float) -> void:
	_dragging = true
	_idle_t = 0.0
	var k := TAU * DRAG_TURN / maxf(viewport_width, 1.0)
	orbit_yaw = wrapf(orbit_yaw - delta_px.x * k, -PI, PI)
	var lo := -0.15 if mode == Mode.CHASE else -0.9
	var hi := 1.2 if mode == Mode.CHASE else 0.7
	if mode == Mode.TOP:
		lo = 0.0
		hi = 0.0
	orbit_pitch = clampf(orbit_pitch + delta_px.y * k * 0.6, lo, hi)


func drag_end() -> void:
	_dragging = false
	_idle_t = 0.0


func zoom_by(factor: float) -> void:
	zoom = clampf(zoom * factor, ZOOM_MIN, ZOOM_MAX)


func _process(delta: float) -> void:
	if car == null:
		return
	_ease_back(delta)
	var xf := car.get_global_transform_interpolated()
	match mode:
		Mode.COCKPIT:
			_perspective(70.0, 0.08)
			var head := Basis(Vector3.UP, orbit_yaw) * Basis(Vector3.RIGHT, -orbit_pitch - 0.07)
			camera.global_transform = Transform3D(xf.basis * head, xf * car.cockpit_eye)
		Mode.CHASE:
			_place_chase(xf, delta)
		Mode.TOP:
			_perspective(55.0, 1.0)
			var fwd := -xf.basis.z
			fwd.y = 0.0
			fwd = fwd.normalized().rotated(Vector3.UP, orbit_yaw)
			var h := 15.0 * zoom
			camera.global_position = xf.origin + Vector3.UP * h - fwd * h * 0.22
			camera.look_at(xf.origin + fwd * 1.2, fwd)


## Near plane per view: as far out as the view allows, since depth precision
## (and so the stability of the thin layers of road, paint and kerb far away)
## grows with it, and phones have 24-bit depth buffers.
func _perspective(fov_deg: float, near: float) -> void:
	camera.fov = fov_deg
	camera.near = near


func _place_chase(xf: Transform3D, delta: float) -> void:
	var fwd := -xf.basis.z
	var car_yaw := atan2(-fwd.x, -fwd.z) # 0 = facing -Z
	var reversing := car.get_forward_speed() < -0.6
	if not _initialised:
		_heading = car_yaw
		_reverse = 1.0 if reversing else 0.0
		_initialised = true
	# Follow the heading with a short lag (turns look natural, the distance
	# to the car never changes).
	_heading = _heading + wrapf(car_yaw - _heading, -PI, PI) * (1.0 - exp(-delta * 5.0))
	_reverse = move_toward(_reverse, 1.0 if reversing else 0.0, delta * 0.9)
	var base_yaw := _heading + orbit_yaw + PI * smoothstep(0.0, 1.0, _reverse)
	var pitch := clampf(CHASE_PITCH + orbit_pitch, -0.1, 1.35)
	var dist := CHASE_DIST * zoom
	var pivot := xf.origin + Vector3.UP * PIVOT_HEIGHT
	# A sign post, lamp post or the fence between the car and the camera:
	# first step round it (a little to the side), and only if every side is
	# blocked, come closer.
	# Obstacle checks every other frame: the camera moves too little in one
	# frame for it to matter, and shape casts against the course cost CPU.
	var check := Engine.get_process_frames() % 2 == 0
	var free := _free_cache
	if check:
		free = _free_share(pivot, _chase_point(pivot, base_yaw + _dodge, dist, pitch, xf.origin.y))
	if check and free < 0.95:
		var best := _dodge
		var best_free := free
		for off in DODGES:
			var f := _free_share(pivot, _chase_point(pivot, base_yaw + off, dist, pitch, xf.origin.y))
			if f > best_free + 0.05:
				best = off
				best_free = f
			if f > 0.95:
				break
		_dodge_target = best
	elif check and absf(_dodge) > 0.001:
		# Back to straight behind as soon as that line is clear again.
		if _free_share(pivot, _chase_point(pivot, base_yaw, dist, pitch, xf.origin.y)) > 0.97:
			_dodge_target = 0.0
	_dodge = move_toward(_dodge, _dodge_target, delta * 0.9)
	var yaw := base_yaw + _dodge
	var back := Vector3(sin(yaw), 0.0, cos(yaw))
	var pos := _chase_point(pivot, yaw, dist, pitch, xf.origin.y)
	if check:
		free = _free_share(pivot, pos)
		_free_cache = free
	_clear = free if free < _clear else move_toward(_clear, free, delta * 1.5)
	pos = pivot + (pos - pivot) * _clear
	_perspective(62.0, 0.2)
	camera.global_position = pos
	# Aiming a little above the roof keeps the view almost level, so posts,
	# trees and buildings stand upright; a camera pitched down leans them out
	# at the screen edges. Views dragged up towards bird's-eye aim at the car.
	var lift := LOOK_LIFT * (1.0 - smoothstep(0.3, 0.8, pitch))
	camera.look_at(pivot - back * 1.2 + Vector3.UP * lift, Vector3.UP)


## Camera position `dist` from the pivot, `yaw` round and `pitch` above it.
func _chase_point(pivot: Vector3, yaw: float, dist: float, pitch: float, ground_y: float) -> Vector3:
	var back := Vector3(sin(yaw), 0.0, cos(yaw))
	var p := pivot + back * (dist * cos(pitch)) + Vector3.UP * (dist * sin(pitch) + 0.35)
	p.y = maxf(p.y, ground_y + 0.35)
	return p


func _free_share(from: Vector3, to: Vector3) -> float:
	var space := car.get_world_3d().direct_space_state
	if space == null:
		return 1.0
	_probe.radius = 0.35
	var q := PhysicsShapeQueryParameters3D.new()
	q.shape = _probe
	q.transform = Transform3D(Basis(), from)
	q.motion = to - from
	q.collision_mask = 1 | 4
	q.exclude = [car.get_rid()]
	var r := space.cast_motion(q)
	return clampf(r[0], 0.2, 1.0) if r.size() > 0 else 1.0


## Once the finger is lifted the view drifts back to the default — only while
## the car is moving, so a parked car can be inspected at leisure.
func _ease_back(delta: float) -> void:
	if _dragging:
		return
	_idle_t += delta
	if _idle_t < RETURN_DELAY or absf(car.get_forward_speed()) < 0.8:
		return
	var k := 1.0 - exp(-delta * RETURN_RATE)
	orbit_yaw = wrapf(orbit_yaw - orbit_yaw * k, -PI, PI)
	orbit_pitch -= orbit_pitch * k
