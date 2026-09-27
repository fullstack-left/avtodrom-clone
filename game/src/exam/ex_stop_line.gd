class_name ExStopLine
extends Exercise
## №2 pedestrian crossing and №8 railway crossing: stop no more than 1 m
## before the STOP line without touching it, wait at least 3 s, drive on.
##   penalties: 4 (stopped > 1 m before the line), 11 (did not stop / ran
##              over the line), 12 (moved off before 3 s),
##              25 (railway crossed without stopping)

const STOP_SPEED := 0.12

var line: Dictionary
var travel := Vector2.ZERO
var max_gap := 1.0
var min_wait := 3.0
var railway := false
## The last complete stop before the line: gap (m) and how long it lasted.
var stop_gap := -1.0
var stop_len := 0.0
var in_stop := false
var over_line_flagged := false


func _on_begin() -> void:
	line = def["stop_line"]
	travel = CourseData.forward2(float(def["heading"]))
	max_gap = float(def.get("max_gap", 1.0))
	min_wait = float(def.get("min_wait", 3.0))
	railway = def.get("skip_penalty", "") == "railway"
	highlight = [line]
	set_hint("hint.stopline")


func _tick(dt: float, p: CarProbe) -> void:
	var front_past := Geo.past(line, travel, p.front)
	var near := Geo.within_span(line, p.front, 1.5)
	if not near:
		return
	var stopped := absf(p.speed) < STOP_SPEED
	if stopped and front_past > -8.0:
		if not in_stop:
			in_stop = true
			stop_len = 0.0
		stop_len += dt
		stop_gap = -front_past
		if front_past > 0.0 and not over_line_flagged:
			over_line_flagged = true
			penalize(11)
		if stop_len < min_wait:
			set_hint("hint.wait3", [int(ceil(min_wait - stop_len))])
		else:
			set_hint("hint.go")
	elif in_stop and p.speed > STOP_SPEED:
		in_stop = false
		if front_past < -max_gap - 2.0:
			# Stopped well short and pulled up closer: that stop does not count.
			stop_gap = -1.0
	if front_past > 0.25 and p.speed > STOP_SPEED:
		_evaluate()
		finish()


func _evaluate() -> void:
	performed = true
	if stop_gap < 0.0:
		penalize(25 if railway else 11)
		return
	if over_line_flagged:
		return
	if stop_gap > max_gap:
		penalize(4)
	if stop_len < min_wait:
		penalize(12)


func passed_without_finish() -> void:
	if not performed:
		_evaluate()
	finish()
