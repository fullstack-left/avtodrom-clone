class_name ExamDirector
extends Node
## Runs the practical exam (or one practice exercise) against the official
## penalty table: activates exercises along the route, applies the general
## rules, keeps the score and produces the result sheet.

signal penalty_added(entry: Dictionary)
signal hint_changed
signal exercise_changed
signal state_changed
signal start_signal
signal emergency_signal(on: bool)
signal finished(result: Dictionary)

enum State { PREPARE, RUNNING, FINISHED, FAILED }

const SPEED_LIMIT := 20.0
const SPEED_GROSS := 40.0
const OVERSPEED_STEP := 5.0 # seconds per 5-point penalty above 20 km/h
## How long the car must stay above 40 km/h for №31: a knock off a kerb must
## not end the exam.
const GROSS_DWELL := 0.3
const OFF_ROUTE_DISTANCE := 5.5
const OFF_ROUTE_TIME := 1.5
const TURN_WINDOW_BEFORE := 14.0
const TURN_WINDOW_AFTER := 3.0

var practice := false
var practice_id := ""
var data: CourseData
var car: Car
var traffic: TrafficController
var tracker: RouteTracker
var probe: CarProbe
var rng := RandomNumberGenerator.new()
var state: State = State.PREPARE
var exercises: Array[Exercise] = []
var active: Array[Exercise] = []
var entries: Array = []
var total := 0
var exam_time := 0.0 # seconds since the START signal
var time_limit := 25.0 * 60.0
var emergency_on := false
var ready_requested := false

var _start_signal_at := -1.0
var _prepare_t := 0.0
var _ready_t := -1.0
var _over20_t := 0.0
var _over40_flagged := false
var _over40_t := 0.0
var _reverse_dist := 0.0
var _reverse_flagged := false
var _off_route_t := 0.0
var _off_route_flagged := false
var _time_flagged := false
var _belt_flagged := false
var _stall_count := 0
var _turn_idx := 0
var _turn_seen := false
var _last_hit := -10.0


func setup(p_data: CourseData, p_car: Car, p_traffic: TrafficController, p_practice_id := "") -> void:
	data = p_data
	car = p_car
	traffic = p_traffic
	practice_id = p_practice_id
	practice = practice_id != ""
	tracker = RouteTracker.new(data)
	probe = CarProbe.new(car)
	rng.randomize()
	time_limit = float(Settings.get_value("exam_time_limit_min")) * 60.0
	for def in data.exercises:
		if practice and str(def["id"]) != practice_id:
			continue
		var ex := _make_exercise(def)
		if ex:
			exercises.append(ex)
	var s0 := 0.0
	if practice and not exercises.is_empty() and practice_id != "start":
		s0 = maxf(exercises[0].s0 - 25.0, 0.0)
	tracker.reset(s0)
	_skip_turns_before(s0)
	car.engine_stalled.connect(_on_stall)
	car.obstacle_hit.connect(_on_obstacle)
	if practice and practice_id != "start":
		_begin_running()


func _make_exercise(def: Dictionary) -> Exercise:
	match str(def["type"]):
		"start": return ExStart.new(def, self)
		"stop_line": return ExStopLine.new(def, self)
		"hill": return ExHill.new(def, self)
		"corridor": return ExCorridor.new(def, self)
		"intersection": return ExIntersection.new(def, self)
		"box": return ExBox.new(def, self)
		"parallel": return ExParallel.new(def, self)
		"emergency": return ExEmergency.new(def, self)
		"accel": return ExAccel.new(def, self)
		"finish": return ExFinish.new(def, self)
	push_warning("Unknown exercise type %s" % def["type"])
	return null


## Where the car should be placed for this session.
func spawn_point() -> Dictionary:
	if not practice or practice_id == "start":
		var sp: Dictionary = data.exercise("start")["spawn"]
		return {"pos": CourseData.v2(sp["pos"]), "yaw": float(sp["yaw"]), "running": false}
	var s := tracker.s
	var p := data.route_point(s)
	var d := data.route_dir(s)
	return {"pos": p, "yaw": rad_to_deg(atan2(-d.x, -d.y)), "running": true}


func _skip_turns_before(s0: float) -> void:
	var turns: Array = data.raw["route"]["turns"]
	_turn_idx = 0
	while _turn_idx < turns.size() and float(turns[_turn_idx]["s"]) < s0 + 2.0:
		_turn_idx += 1


# ------------------------------------------------------------------ public API
func time_since_start_signal() -> float:
	return exam_time if _start_signal_at >= 0.0 else 0.0


func traffic_go(approach: String) -> bool:
	if traffic == null:
		return true
	var a := traffic.aspect_for_approach(approach)
	return a == TrafficLight.Aspect.GREEN or a == TrafficLight.Aspect.GREEN_BLINK


## Seconds left before the light for `approach` stops allowing entry.
func traffic_go_left(approach: String) -> float:
	if traffic == null:
		return INF
	return traffic.time_to_stop("NS" if approach in ["N", "S"] else "EW")


## The candidate confirms readiness (on-screen button).
func request_start() -> void:
	ready_requested = true


func set_emergency_signal(on: bool) -> void:
	if emergency_on == on:
		return
	emergency_on = on
	emergency_signal.emit(on)


func current_exercise() -> Exercise:
	var best: Exercise = null
	for ex in active:
		if best == null or ex.s0 > best.s0:
			best = ex
	return best


func upcoming_exercise() -> Exercise:
	for ex in exercises:
		if ex.state == Exercise.State.WAITING:
			return ex
	return null


func add_penalty(no: int, exercise_id := "", detail := "") -> void:
	if state == State.FINISHED or state == State.FAILED:
		return
	var pts := PenaltyTable.points(no)
	total += pts
	var entry := {
		"no": no, "points": pts, "exercise": exercise_id, "detail": detail,
		"time": snappedf(exam_time, 0.1), "total": total,
	}
	entries.append(entry)
	penalty_added.emit(entry)
	if total >= PenaltyTable.pass_below and not practice:
		_end(State.FAILED)


# ------------------------------------------------------------------ main loop
func _physics_process(dt: float) -> void:
	if state == State.FINISHED or state == State.FAILED:
		return
	probe.update(dt)
	tracker.update(probe.pos)
	match state:
		State.PREPARE:
			_prepare(dt)
		State.RUNNING:
			exam_time += dt
			_run(dt)


func _prepare(dt: float) -> void:
	_prepare_t += dt
	var engine_ok := car.is_engine_running()
	var ready := engine_ok and (car.signalling_left() or ready_requested)
	if ready:
		if _ready_t < 0.0:
			_ready_t = 0.0
		_ready_t += dt
		if _ready_t > 1.2:
			_begin_running()
	else:
		_ready_t = -1.0
		ready_requested = ready_requested and engine_ok


func _begin_running() -> void:
	state = State.RUNNING
	_start_signal_at = 0.0
	exam_time = 0.0
	_stall_count = car.get_stall_count()
	state_changed.emit()
	start_signal.emit()


func _run(dt: float) -> void:
	# Activate / tick / retire exercises.
	for ex in exercises:
		if ex.state == Exercise.State.WAITING and tracker.s >= ex.s0 - 0.01:
			ex.begin()
			active.append(ex)
			exercise_changed.emit()
	for ex in active.duplicate():
		ex.tick(dt, probe)
		if ex.state == Exercise.State.ACTIVE and tracker.s > ex.s1 + 8.0 and ex.type != "finish":
			ex.passed_without_finish()
		if ex.state == Exercise.State.DONE:
			active.erase(ex)
			exercise_changed.emit()
	_general_rules(dt)
	var all_done := true
	for ex in exercises:
		if ex.state != Exercise.State.DONE:
			all_done = false
			break
	if all_done and state == State.RUNNING:
		_end(State.FINISHED)


func _general_rules(dt: float) -> void:
	var suspend_speed := false
	var reverse_ok := false
	var free_zone := false
	for ex in active:
		suspend_speed = suspend_speed or ex.suspends_speed_limit()
		reverse_ok = reverse_ok or ex.allows_reverse()
		for zone in ex.free_area():
			if Geometry2D.is_point_in_polygon(probe.pos, CourseData.poly(zone)):
				free_zone = true
	var kmh := probe.speed_kmh

	# №1 seat belt: checked when the car first moves, and whenever it is
	# unfastened on the move.
	if not _belt_flagged and not car.seatbelt and probe.travelled > 0.5 and absf(probe.speed) > 0.5:
		_belt_flagged = true
		add_penalty(1)

	# №8 speed above 20 km/h, 5 points per full 5 s; №31 above 40 km/h.
	if kmh > SPEED_LIMIT + 0.5 and not suspend_speed:
		_over20_t += dt
		if _over20_t >= OVERSPEED_STEP:
			_over20_t -= OVERSPEED_STEP
			add_penalty(8)
	else:
		_over20_t = 0.0
	_over40_t = _over40_t + dt if kmh > SPEED_GROSS + 0.5 else 0.0
	if _over40_t >= GROSS_DWELL and not _over40_flagged:
		_over40_flagged = true
		add_penalty(31, "", "%.1f km/h" % kmh)

	# №22 engine stalled (counted via the car's signal, see _on_stall).

	# №29 reversing where the exercises do not call for it.
	if AvtoGear.in_reverse(car) and probe.speed < -0.1 and not reverse_ok:
		_reverse_dist += -probe.speed * dt
		if _reverse_dist > 1.0 and not _reverse_flagged:
			_reverse_flagged = true
			add_penalty(29)
	elif probe.speed > 0.2:
		_reverse_dist = 0.0
		_reverse_flagged = false

	# №28 leaving the route.
	if tracker.distance_from_route() > OFF_ROUTE_DISTANCE and not free_zone:
		_off_route_t += dt
		if _off_route_t > OFF_ROUTE_TIME and not _off_route_flagged:
			_off_route_flagged = true
			add_penalty(28)
	else:
		_off_route_t = 0.0

	# Driving on the grass is leaving the route too.
	for i in 4:
		if probe.wheel_contact[i] and data.surface_at(probe.wheels[i]) == CourseData.Surface.GRASS:
			if not _off_route_flagged and absf(probe.speed) > 0.3:
				_off_route_flagged = true
				add_penalty(28, "", "grass")
			break

	# №32 total time.
	if not practice and exam_time > time_limit and not _time_flagged:
		_time_flagged = true
		add_penalty(32)

	# №5 indicator for every turn on the route.
	_check_turns()


func _check_turns() -> void:
	var turns: Array = data.raw["route"]["turns"]
	if _turn_idx >= turns.size():
		return
	var t: Dictionary = turns[_turn_idx]
	var ts := float(t["s"])
	if tracker.s < ts - TURN_WINDOW_BEFORE:
		return
	if practice and not _turn_in_practice(ts):
		_turn_idx += 1
		return
	var want_left: bool = t["dir"] == "left"
	if (want_left and car.signalling_left()) or (not want_left and car.signalling_right()):
		_turn_seen = true
	if tracker.s > ts + TURN_WINDOW_AFTER:
		if not _turn_seen:
			add_penalty(5, "", t["dir"])
		_turn_idx += 1
		_turn_seen = false


func _turn_in_practice(ts: float) -> bool:
	for ex in exercises:
		if ts >= ex.s0 - TURN_WINDOW_BEFORE and ts <= ex.s1 + 5.0:
			return true
	return false


## Direction of the next route turn (for the HUD arrow), or "".
func next_turn() -> Dictionary:
	var turns: Array = data.raw["route"]["turns"]
	if _turn_idx >= turns.size():
		return {}
	var t: Dictionary = turns[_turn_idx]
	return {"dir": t["dir"], "distance": float(t["s"]) - tracker.s}


func _on_stall() -> void:
	if state == State.RUNNING:
		add_penalty(22)


func _on_obstacle(body: Node, speed: float) -> void:
	if state != State.RUNNING:
		return
	if exam_time - _last_hit < 2.0 or speed < 0.15:
		return
	_last_hit = exam_time
	var where := probe.pos if probe else Vector2.ZERO
	add_penalty(30, "", "%s at (%.1f, %.1f)" % [body.name, where.x, where.y])


## Leaving the exam voluntarily (№26).
func abandon() -> void:
	if state == State.RUNNING and not practice:
		add_penalty(26)
	if state != State.FAILED:
		_end(State.FAILED)


func _end(s: State) -> void:
	if state == State.FINISHED or state == State.FAILED:
		return
	state = s
	set_emergency_signal(false)
	state_changed.emit()
	finished.emit(result())


func result() -> Dictionary:
	var ex_list := []
	for ex in exercises:
		ex_list.append({"id": ex.id, "name": ex.def.get("name", {}), "performed": ex.performed,
				"penalties": ex.penalties_here})
	return {
		"practice": practice,
		"exercise": practice_id,
		"passed": total < PenaltyTable.pass_below and state == State.FINISHED,
		"completed": state == State.FINISHED,
		"penalty": total,
		"entries": entries,
		"time": snappedf(exam_time, 0.1),
		"distance": snappedf(probe.travelled if probe else 0.0, 1.0),
		"exercises": ex_list,
		"car": car.preset,
		"date": Time.get_datetime_string_from_system(false, true),
	}
