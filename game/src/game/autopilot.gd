class_name Autopilot
extends Node
## Drives the exam the way an instructor would: follows the route, stops at
## the lines, waits the required seconds, obeys the lights, does the hill
## start, reverses into the box and the parallel pocket, handles the
## emergency signal and parks after the finish.
##
## Used for the "demonstration" mode and by the end-to-end test
## (tests/autopilot_test), which must finish the exam with 0 penalty points.

const CRUISE := 3.6 # m/s ≈ 13 km/h
const CORRIDOR := 1.9
const MANOEUVRE := 0.9
const DECEL := 1.1 # m/s² planning deceleration
const LIGHT_DECEL := 2.5 # m/s² hardest braking accepted for a light turning yellow
const LIGHT_MARGIN := 1.0 # s spare before the yellow when deciding to go on

enum Mode { ROUTE, PATH }

var car: Car
# Geometry of the car being driven (set in setup()).
var WHEELBASE := 2.48
var REAR_AXLE := 1.24 # body origin -> rear axle
var FRONT := 2.18 # body origin -> front bumper
var MAX_ROAD_ANGLE := 39.0
var director: ExamDirector
var data: CourseData
var active := false
var log_lines: PackedStringArray = []

var mode: Mode = Mode.ROUTE
var _path := PackedVector2Array()
var _path_reverse := false
var _path_speed := MANOEUVRE
var _path_done := Callable()
var _stops: Array = [] # [{s, wait, kind, id, done}]
var _stop_t := 0.0
var _stopped_at := -1
var _speed_i := 0.0
var _phase := ""
var _t := 0.0
var _hold_t := 0.0
var _box_state := 0
var _parallel_state := 0
var _emergency_state := 0
var _finish_state := 0
var _accel_state := 0
var _prep_state := 0
## Deliberate mistakes for the rule-detection test: "nobelt", "nosignal",
## "nostop" (crosswalk and railway), "speed" (30 km/h cruise), "redlight".
var faults: PackedStringArray = []
var _park_tries := 0
var _park_x := 0.0


func setup(p_car: Car, p_director: ExamDirector, p_data: CourseData) -> void:
	car = p_car
	director = p_director
	data = p_data
	WHEELBASE = car.get_wheelbase()
	REAR_AXLE = WHEELBASE * 0.5
	FRONT = car.body_front
	MAX_ROAD_ANGLE = car.get_max_road_angle()
	car.auto_clutch = true
	_plan_stops()


func _log(msg: String) -> void:
	var line := "[%6.1f s] %s" % [director.exam_time if director else _t, msg]
	log_lines.append(line)
	print(line)


# ------------------------------------------------------------------ planning
## Route arc length at which a line crosses the route, searching within the
## exercise's own stretch (the route passes some places more than once).
func _line_s(line: Dictionary, s_from: float, s_to: float) -> float:
	var mid := (Geo.line_a(line) + Geo.line_b(line)) * 0.5
	var best := INF
	var best_s := s_from
	var i0 := data.route_index(s_from)
	var i1 := data.route_index(s_to)
	for i in range(i0, mini(i1 + 1, data.route.size())):
		var d := data.route[i].distance_to(mid)
		if d < best:
			best = d
			best_s = data.route_s[i]
	return best_s


func _plan_stops() -> void:
	_stops.clear()
	for ex in director.exercises:
		var d := ex.def
		match ex.type:
			"stop_line":
				var s := _line_s(d["stop_line"], ex.s0, ex.s1 + 5.0)
				_stops.append({"s": s - FRONT - 0.45, "wait": 3.6, "kind": "line", "id": ex.id, "done": false})
			"hill":
				var s := _line_s(d["stop_line"], ex.s0, ex.s1 + 5.0)
				_stops.append({"s": s - FRONT - 1.4, "wait": 3.8, "kind": "hill", "id": ex.id, "done": false})
			"intersection":
				var s := _line_s(d["stop_line"], ex.s0, ex.s1)
				_stops.append({"s": s - FRONT - 0.45, "wait": 0.0, "kind": "light", "id": ex.id,
						"approach": d["approach"], "done": false})
			"finish":
				var s := _line_s(d["finish_line"], ex.s0, data.route_length())
				_stops.append({"s": s + 7.0, "wait": 0.0, "kind": "finish", "id": ex.id, "done": false})
	_stops.sort_custom(func(a: Dictionary, b: Dictionary) -> bool: return a["s"] < b["s"])


# ------------------------------------------------------------------ geometry
func _pos() -> Vector2:
	var o := car.global_transform.origin
	return Vector2(o.x, o.z)


func _fwd() -> Vector2:
	var f := -car.global_transform.basis.z
	return Vector2(f.x, f.z).normalized()


static func _right_of(d: Vector2) -> Vector2:
	return Vector2(-d.y, d.x)


func _rear_axle() -> Vector2:
	return _pos() - _fwd() * REAR_AXLE


## Pure pursuit, forwards or backwards. Returns steering-wheel degrees.
## Forwards along the route the reference is the body centre (midway between
## the axles), so in tight bends the front swings out and the rear cuts in by
## the same small amount instead of one axle taking all of it. `ref_back`
## moves that reference towards the rear axle (narrow corridors: the rear
## wheels, which cut the bends, then stay nearer the middle).
func _pursue(target: Vector2, reverse: bool, ref_centre := false, ref_back := 0.0) -> float:
	var ref := (_pos() - _fwd() * ref_back) if ref_centre else _rear_axle()
	var v := target - ref
	var ld := maxf(v.length(), 0.5)
	var d := -_fwd() if reverse else _fwd()
	var ang := atan2(v.dot(_right_of(d)), v.dot(d)) # + = target to the right of the motion
	var delta := atan(2.0 * WHEELBASE * sin(ang) / ld)
	if reverse:
		delta = -delta # reversing: the rear swings the way the wheel is turned
	var frac := rad_to_deg(delta) / (MAX_ROAD_ANGLE * 0.92)
	return clampf(frac, -1.0, 1.0) * car.get_steering_lock()


func _lookahead_route(dist: float) -> Vector2:
	return data.route_point(director.tracker.s + dist)


func _route_curvature_speed() -> float:
	var s := director.tracker.s
	var worst := CRUISE
	for k in [3.0, 6.0, 9.0, 12.0]:
		var d0 := data.route_dir(s + k)
		var d1 := data.route_dir(s + k + 3.0)
		var turn := absf(d0.angle_to(d1))
		if turn > 0.01:
			var radius := 3.0 / turn
			worst = minf(worst, sqrt(1.6 * radius))
	return clampf(worst, 1.6, CRUISE)


# ------------------------------------------------------------------ control
func _physics_process(dt: float) -> void:
	if not active or car == null or director == null:
		return
	_t += dt
	if director.state == ExamDirector.State.PREPARE:
		_prepare(dt)
		return
	if director.state != ExamDirector.State.RUNNING:
		_set_controls(0.0, 0.6, car.steering_wheel)
		return
	if _prep_state < 3:
		_after_start()
	_indicators()
	_gears()
	if _emergency(dt):
		return
	var ex := director.current_exercise()
	if ex and ex.type == "box" and _box(dt, ex):
		return
	if ex and ex.type == "parallel" and _parallel(dt, ex):
		return
	if _finish(dt):
		return
	_drive_route(dt, ex)


func _set_controls(throttle: float, brake: float, steer: float) -> void:
	car.throttle = clampf(throttle, 0.0, 1.0)
	car.brake = clampf(brake, 0.0, 1.0)
	car.steering_wheel = steer
	car.clutch = 0.0


func _speed_control(v_target: float, dt: float, reverse := false) -> Vector2:
	# Returns (throttle, brake) for a signed target along the direction of travel.
	var v := car.get_forward_speed()
	if reverse:
		v = -v
	var err := v_target - v
	if v_target <= 0.01:
		_speed_i = 0.0
		return Vector2(0.0, 0.55 if absf(v) < 0.6 else clampf(0.35 + absf(v) * 0.15, 0.0, 0.8))
	_speed_i = clampf(_speed_i + err * dt, -1.0, 1.5)
	var cmd := 0.22 * err + 0.08 * _speed_i
	# Grade feed-forward: on the estakada the car needs gas just to hold speed.
	var slope := -car.global_transform.basis.z.normalized().y
	if reverse:
		slope = -slope
	cmd += clampf(slope * 2.2, -0.1, 0.35)
	if cmd >= 0.0:
		return Vector2(clampf(cmd + 0.02, 0.0, 0.5), 0.0)
	return Vector2(0.0, clampf(-cmd * 1.6, 0.0, 0.8))


# ------------------------------------------------------------------ phases
func _prepare(dt: float) -> void:
	_hold_t += dt
	match _prep_state:
		0:
			car.seatbelt = not faults.has("nobelt")
			car.handbrake = 1.0
			car.ignition = true
			car.starter = true
			if car.is_engine_running():
				car.starter = false
				_prep_state = 1
				_hold_t = 0.0
				_log("engine running")
		1:
			if _hold_t > 1.0:
				car.set_indicator(Car.Indicator.LEFT)
				_prep_state = 2
		2:
			pass
	_set_controls(0.0, 0.0, 0.0)


func _after_start() -> void:
	if _prep_state == 2:
		car.request_gear(1 if not car.is_automatic() else AvtoGear.DRIVE)
		car.handbrake = 0.0
		_prep_state = 3
		_log("START: moving off")


func _indicators() -> void:
	var s := director.tracker.s
	if car.hazard:
		return
	if faults.has("nosignal") and director.state == ExamDirector.State.RUNNING:
		if car.indicator != Car.Indicator.OFF:
			car.set_indicator(Car.Indicator.OFF)
		return
	# Start: left indicator until 5 m past the start line.
	var start: Dictionary = data.exercise("start")
	if s < float(start["s1"]) - 7.0:
		if car.indicator != Car.Indicator.LEFT:
			car.set_indicator(Car.Indicator.LEFT)
		return
	var want := Car.Indicator.OFF
	var turns: Array = data.raw["route"]["turns"]
	for t in turns:
		var ts := float(t["s"])
		if s > ts - 12.0 and s < ts + 3.0:
			want = Car.Indicator.LEFT if t["dir"] == "left" else Car.Indicator.RIGHT
			break
	var fin := data.exercise("finish")
	var fs := _line_s(fin["finish_line"], float(fin["s0"]), data.route_length())
	if s > fs - 15.0 and s < fs + 2.0:
		want = Car.Indicator.RIGHT
	if car.indicator != want:
		car.set_indicator(want)


func _gears() -> void:
	if car.is_automatic():
		return
	var ex := director.current_exercise()
	var in_accel := ex != null and ex.type == "accel"
	var g := car.get_gear()
	if in_accel and director.tracker.s < float(ex.def["s1"]) - 5.0:
		if g == 1 and car.get_forward_speed() > 4.2:
			car.request_gear(2)
	elif g >= 2 and car.get_forward_speed() < 5.2:
		car.request_gear(1)
	elif g == 0 and _box_state == 0 and _parallel_state == 0:
		car.request_gear(1)


func _drive_route(dt: float, ex: Exercise) -> void:
	var s := director.tracker.s
	var v_target := _route_curvature_speed()
	if faults.has("speed") and (ex == null or ex.type in ["start", "intersection"]):
		v_target = 8.4 # ≈ 30 km/h
	if ex and ex.type == "corridor":
		v_target = minf(v_target, CORRIDOR)
	if ex and ex.type == "accel" and s < float(ex.def["s1"]) - 3.0:
		v_target = 8.6 # ≈ 31 km/h
	# Planned stops.
	for st in _stops:
		if st["done"]:
			continue
		var ds: float = float(st["s"]) - s
		if ds < -3.0:
			st["done"] = true
			continue
		if st["kind"] == "light" and director.traffic_go(str(st["approach"])) and _stop_t <= 0.0 \
				and _clears_before_yellow(ds, str(st["approach"])):
			if ds < 1.0:
				st["done"] = true
			continue
		if st["kind"] == "finish":
			continue
		if faults.has("nostop") and st["kind"] == "line":
			continue
		if faults.has("redlight") and st["kind"] == "light":
			continue
		var cap := sqrt(maxf(2.0 * DECEL * maxf(ds - 0.15, 0.0), 0.0))
		v_target = minf(v_target, cap)
		if ds < 0.35 or (cap < 0.3 and absf(car.get_forward_speed()) < 0.15):
			v_target = 0.0
			if absf(car.get_forward_speed()) < 0.1:
				_stop_t += dt
				if st["kind"] == "hill":
					car.handbrake = 1.0
				var waited: bool = _stop_t >= float(st["wait"])
				var go_ok := waited
				if st["kind"] == "light":
					go_ok = director.traffic_go(str(st["approach"])) and _stop_t > 0.8 \
							and director.traffic_go_left(str(st["approach"])) > 2.0
				if go_ok:
					if st["kind"] == "hill":
						_hill_start(dt, st)
						return
					st["done"] = true
					_stop_t = 0.0
					_log("leaving stop %s" % st["id"])
			break
		break
	var la := clampf(2.4 + car.get_forward_speed() * 0.6, 2.6, 7.0)
	var back := 0.0
	if ex and ex.type == "corridor":
		back = WHEELBASE * 0.3
	var target := _lookahead_route(la)
	var steer := _pursue(target, false, true, back)
	var tb := _speed_control(v_target, dt)
	_set_controls(tb.x, tb.y, steer)


## On green: true if the front will be over the STOP line (0.45 m past the
## planned stop point) before the light turns yellow, or if it is already too
## late to stop comfortably. Otherwise the car treats the green as a red.
func _clears_before_yellow(ds: float, approach: String) -> bool:
	var v := maxf(car.get_forward_speed(), 0.0)
	var to_line := ds + 0.45
	if to_line <= v * v / (2.0 * LIGHT_DECEL):
		return true
	return to_line / maxf(v, 0.5) + LIGHT_MARGIN < director.traffic_go_left(approach)


func _hill_start(dt: float, st: Dictionary) -> void:
	# Throttle against the handbrake until the clutch bites, then let it go.
	_hold_t += dt
	var steer := _pursue(_lookahead_route(4.0), false)
	_set_controls(0.42, 0.0, steer)
	if _hold_t > 1.1:
		car.handbrake = 0.0
	if _hold_t > 1.5 and car.get_forward_speed() > 0.4:
		st["done"] = true
		_stop_t = 0.0
		_hold_t = 0.0
		_log("hill start done")


# ------------------------------------------------------------------ path mode
func _follow_path(dt: float) -> bool:
	## Returns true when the end of the path is reached (and the car stopped).
	var ref := _rear_axle()
	var best := 0
	var best_d := INF
	for i in _path.size():
		var d := _path[i].distance_squared_to(ref)
		if d < best_d:
			best_d = d
			best = i
	var remaining := 0.0
	for i in range(best, _path.size() - 1):
		remaining += _path[i].distance_to(_path[i + 1])
	remaining += ref.distance_to(_path[best]) * (1.0 if best == _path.size() - 1 else 0.0)
	var la := 1.6
	var target := _path[_path.size() - 1]
	var acc := 0.0
	for i in range(best, _path.size() - 1):
		acc += _path[i].distance_to(_path[i + 1])
		if acc >= la:
			target = _path[i + 1]
			break
	if remaining < 1.2:
		# Aim past the end along the final direction so the wheel stays straight.
		var n := _path.size()
		var dir := (_path[n - 1] - _path[n - 2]).normalized()
		target = _path[n - 1] + dir * 1.6
	var steer := _pursue(target, _path_reverse)
	var end_d := (_path[_path.size() - 1] - ref).dot((_path[_path.size() - 1] - _path[_path.size() - 2]).normalized())
	var v_target := minf(_path_speed, sqrt(maxf(2.0 * 0.6 * maxf(end_d, 0.0), 0.0)))
	if end_d < 0.08:
		v_target = 0.0
	var tb := _speed_control(v_target, dt, _path_reverse)
	_set_controls(tb.x, tb.y, steer)
	return end_d < 0.08 and absf(car.get_forward_speed()) < 0.08


static func _arc(center: Vector2, r: float, a0: float, a1: float, n := 16) -> PackedVector2Array:
	var out := PackedVector2Array()
	for k in n + 1:
		var a := lerpf(a0, a1, float(k) / n)
		out.append(center + Vector2(cos(a), sin(a)) * r)
	return out


## Two tangent circular arcs moving along +x that shift the path by `dz`
## (the textbook parallel-parking manoeuvre, radius r).
static func _two_arc(p0: Vector2, dz: float, r: float, n := 14) -> PackedVector2Array:
	var s := signf(dz)
	var theta := acos(clampf(1.0 - absf(dz) / (2.0 * r), -1.0, 1.0))
	var out := PackedVector2Array()
	var c1 := p0 + Vector2(0, s * r)
	for k in n + 1:
		var phi := theta * float(k) / n
		out.append(c1 + Vector2(r * sin(phi), -s * r * cos(phi)))
	var c2 := p0 + Vector2(2.0 * r * sin(theta), dz - s * r)
	for k in range(1, n + 1):
		var psi := theta * (1.0 - float(k) / n)
		out.append(c2 + Vector2(-r * sin(psi), s * r * cos(psi)))
	return out


static func _s_curve(p0: Vector2, p1: Vector2, n := 24) -> PackedVector2Array:
	# Smooth lateral shift along the dominant axis between p0 and p1.
	var out := PackedVector2Array()
	for k in n + 1:
		var t := float(k) / n
		var e := t * t * (3.0 - 2.0 * t)
		if absf(p1.x - p0.x) >= absf(p1.y - p0.y):
			out.append(Vector2(lerpf(p0.x, p1.x, t), lerpf(p0.y, p1.y, e)))
		else:
			out.append(Vector2(lerpf(p0.x, p1.x, e), lerpf(p0.y, p1.y, t)))
	return out


# ------------------------------------------------------------------ box
func _box(dt: float, ex: Exercise) -> bool:
	var d := ex.def
	var entry: Dictionary = d["entry_line"]
	var bay := CourseData.poly(d["bay"])
	var fix: Dictionary = d["fixation_line"]
	var xc := (Geo.line_a(entry).x + Geo.line_b(entry).x) * 0.5
	var zb := 0.0
	for p in bay:
		zb += p.y
	zb /= bay.size()
	var xf := Geo.line_a(fix).x
	var r := 6.2
	match _box_state:
		0:
			# Drive down the pad until the rear axle is one radius past the bay centre.
			var ra := _rear_axle()
			if ra.y > zb - 0.5 and _fwd().y > 0.8:
				var steer := _pursue(Vector2(xc, ra.y + 5.0), false)
				var ds := (zb + r) - ra.y
				var tb := _speed_control(minf(CORRIDOR, sqrt(maxf(2.0 * DECEL * maxf(ds, 0.0), 0.0))) if ds > 0.1 else 0.0, dt)
				_set_controls(tb.x, tb.y, steer)
				if ds <= 0.1 and absf(car.get_forward_speed()) < 0.08:
					_box_state = 1
					_hold_t = 0.0
					_log("box: stopped past the bay, reversing")
				return true
			return false
		1:
			_hold_t += dt
			_set_controls(0.0, 0.6, car.steering_wheel)
			if _hold_t > 0.6:
				car.request_gear(-1 if not car.is_automatic() else AvtoGear.AUTO_REVERSE)
				# Rear axle: quarter circle from the pad centre line into the bay,
				# then straight back onto the middle of the fixation band.
				var ra := _rear_axle()
				var c := Vector2(xc + r, ra.y)
				_path = _arc(c, r, PI, PI * 1.5)
				# Fault "boxdeep": back in too far, over the yellow limit line.
				_path.append(Vector2(xf + (0.9 if faults.has("boxdeep") else 0.0), c.y - r))
				_path_reverse = true
				_path_speed = MANOEUVRE
				_box_state = 2
			return true
		2:
			if _follow_path(dt):
				_box_state = 3
				_hold_t = 0.0
				_log("box: parked, rear axle %.2f m off the fixation band" % (_rear_axle().x - xf))
			return true
		3:
			_hold_t += dt
			_set_controls(0.0, 0.6, car.steering_wheel)
			if _hold_t > 1.6:
				car.request_gear(1 if not car.is_automatic() else AvtoGear.DRIVE)
				var ra := _rear_axle()
				var r2 := 5.2
				_path = PackedVector2Array([ra, Vector2(xc + r2 + 0.5, ra.y)])
				_path.append_array(_arc(Vector2(xc + r2, ra.y - r2), r2, PI * 0.5, PI))
				_path.append(Vector2(xc, ra.y - r2 - 6.0))
				_path_reverse = false
				_path_speed = 1.6
				_box_state = 4
			return true
		4:
			_follow_path(dt)
			if _rear_axle().y < float(Geo.line_a(entry).y) + 6.0:
				_box_state = 5
				_log("box: leaving")
			return true
	return false


# ------------------------------------------------------------------ parallel
func _parallel(dt: float, ex: Exercise) -> bool:
	var d := ex.def
	var pocket := CourseData.poly(d["pocket"])
	var fix: Dictionary = d["fixation_line"]
	var px0 := INF
	var px1 := -INF
	for p in pocket:
		px0 = minf(px0, p.x)
		px1 = maxf(px1, p.x)
	var fix_z := Geo.line_a(fix).y
	var edge_z := -INF # the pocket's open (road) side
	for p in pocket:
		edge_z = maxf(edge_z, p.y)
	var z_target := fix_z + 0.71 # right wheels (north side) on the line
	if faults.has("parkoff"):
		z_target += 0.45 # right wheels short of the band
	var z_drive := edge_z + 1.1 # pass the pocket about a metre off its edge
	var arc_r := 4.3
	var shift := z_drive - z_target
	var theta := acos(clampf(1.0 - shift / (2.0 * arc_r), -1.0, 1.0))
	var x_stop := px0 + 1.2 # rear axle just past the pocket's near end
	var x_rear_target := x_stop + 2.0 * arc_r * sin(theta) + 1.5
	match _parallel_state:
		0:
			var ra := _rear_axle()
			if ra.x < px1 + 6.0 and _fwd().x < -0.8:
				var ds := ra.x - x_stop
				var target := Vector2(ra.x - 5.0, z_drive)
				var steer := _pursue(target, false)
				var tb := _speed_control(minf(CORRIDOR, sqrt(maxf(2.0 * DECEL * maxf(ds, 0.0), 0.0))) if ds > 0.1 else 0.0, dt)
				_set_controls(tb.x, tb.y, steer)
				if ds <= 0.1 and absf(car.get_forward_speed()) < 0.08:
					_parallel_state = 1
					_hold_t = 0.0
					_log("parallel: stopped past the pocket")
				return true
			return false
		1:
			_hold_t += dt
			_set_controls(0.0, 0.6, car.steering_wheel)
			if _hold_t > 0.6:
				car.request_gear(-1 if not car.is_automatic() else AvtoGear.AUTO_REVERSE)
				# Classic two-arc parallel park (rear-axle path), then a short
				# straight so the car settles square to the kerb.
				var ra := _rear_axle()
				var sh := ra.y - z_target
				var th := acos(clampf(1.0 - sh / (2.0 * arc_r), -1.0, 1.0))
				_path = _two_arc(ra, -sh, arc_r)
				_path.append(Vector2(ra.x + 2.0 * arc_r * sin(th) + 2.8, z_target))
				_path_reverse = true
				_path_speed = MANOEUVRE
				_parallel_state = 2
			return true
		2:
			if _follow_path(dt):
				_parallel_state = 3
				_hold_t = 0.0
				var ra := _rear_axle()
				_log("parallel: parked, rear axle z err %.2f m, heading err %.1f°" % [ra.y - z_target,
						rad_to_deg(_fwd().angle_to(Vector2(-1, 0)))])
			return true
		3:
			_hold_t += dt
			_set_controls(0.0, 0.6, car.steering_wheel)
			var ra0 := _rear_axle()
			var heading_err := absf(rad_to_deg(_fwd().angle_to(Vector2(-1, 0))))
			if _hold_t > 1.0 and _park_tries < 2 and (heading_err > 1.8 or absf(ra0.y - z_target) > 0.08):
				# Like a driver: pull forward a little, then back in straight.
				_park_tries += 1
				car.request_gear(1 if not car.is_automatic() else AvtoGear.DRIVE)
				_park_x = ra0.x
				_path = PackedVector2Array([ra0, Vector2(ra0.x - 2.4, z_target), Vector2(ra0.x - 4.0, z_target)])
				_path_reverse = false
				_path_speed = 0.7
				_parallel_state = 6
				_log("parallel: correcting (heading %.1f°, lateral %.2f m)" % [heading_err, ra0.y - z_target])
				return true
			if _hold_t > 1.6:
				car.request_gear(1 if not car.is_automatic() else AvtoGear.DRIVE)
				var ra := _rear_axle()
				var lane := data.route_point(director.tracker.s).y
				_path = PackedVector2Array([ra, Vector2(ra.x - 0.6, ra.y)])
				_path.append_array(_s_curve(Vector2(ra.x - 0.6, ra.y), Vector2(ra.x - 10.0, lane)))
				_path.append(Vector2(ra.x - 17.0, lane))
				_path_reverse = false
				_path_speed = 1.8
				_parallel_state = 4
			return true
		4:
			_follow_path(dt)
			if _rear_axle().x < x_stop - 8.0:
				_parallel_state = 5
				_log("parallel: back on the road")
			return true
		6:
			if _follow_path(dt) or _rear_axle().x < _park_x - 2.0:
				car.request_gear(-1 if not car.is_automatic() else AvtoGear.AUTO_REVERSE)
				var ra := _rear_axle()
				_path = PackedVector2Array([ra, Vector2(_park_x + 0.1, z_target)])
				_path_reverse = true
				_path_speed = 0.6
				_parallel_state = 7
			return true
		7:
			if _follow_path(dt):
				_parallel_state = 3
				_hold_t = 0.0
				var ra := _rear_axle()
				_log("parallel: re-parked, lateral %.2f m, heading %.1f°" % [ra.y - z_target,
						rad_to_deg(_fwd().angle_to(Vector2(-1, 0)))])
			return true
	return false


# ------------------------------------------------------------------ emergency / finish
func _emergency(dt: float) -> bool:
	match _emergency_state:
		0:
			if director.emergency_on:
				_emergency_state = 1
				_log("emergency signal: braking")
			return false
		1:
			_set_controls(0.0, 0.9, car.steering_wheel)
			if absf(car.get_forward_speed()) < 0.08:
				car.set_hazard(true)
				_emergency_state = 2
			return true
		2:
			_set_controls(0.0, 0.5, car.steering_wheel)
			if not director.emergency_on:
				car.set_hazard(false)
				_emergency_state = 3
				_log("emergency over")
			return true
	var _unused := dt
	return false


func _finish(dt: float) -> bool:
	var ex := director.current_exercise()
	if ex == null or ex.type != "finish":
		return false
	var fs := _line_s(ex.def["finish_line"], ex.s0, data.route_length())
	var s := director.tracker.s
	var park_s := minf(fs + 5.0, data.route_length() - 1.5)
	match _finish_state:
		0:
			if s > fs + 1.0:
				_finish_state = 1
			return false
		1:
			var ds := park_s - s
			var steer := _pursue(_lookahead_route(4.0), false)
			var tb := _speed_control(minf(2.0, sqrt(maxf(2.0 * DECEL * maxf(ds, 0.0), 0.0))) if ds > 0.2 else 0.0, dt)
			_set_controls(tb.x, tb.y, steer)
			if ds <= 0.2 and absf(car.get_forward_speed()) < 0.05:
				_finish_state = 2
				_hold_t = 0.0
			return true
		2:
			_hold_t += dt
			_set_controls(0.0, 0.6, car.steering_wheel)
			if _hold_t > 0.5:
				car.set_indicator(Car.Indicator.OFF)
				car.request_gear(0 if not car.is_automatic() else AvtoGear.PARK)
				car.handbrake = 1.0
			if _hold_t > 1.2:
				car.ignition = false
			if _hold_t > 2.0:
				car.seatbelt = false
				_finish_state = 3
				_log("parked after the finish")
			return true
		3:
			_set_controls(0.0, 0.3, car.steering_wheel)
			return true
	return false
