class_name ExHill
extends Exercise
## №10 "Estakada" (hill start). Stop on the ramp with the whole car between
## the fixation line and the STOP line, hold, then move off forwards within
## 30 s without rolling back more than 0.3 m.
##   penalties: 11 (front over the STOP line when stopping), 4 (stopped short
##              of the zone), 12 (moved off before 3 s), 13 (not moving within
##              30 s), 14 (rolled back > 0.3 m), 27 (no stop at all)

const STOP_SPEED := 0.08
const STABLE_STOP := 0.4

var stop_line: Dictionary
var fix_line: Dictionary
var travel := Vector2.ZERO
var stop_pos := Vector2.ZERO
var stop_len := 0.0
var stopped_once := false
var in_stop := false
var rollback_flagged := false
var wait_flagged := false
var zone_checked := false
var max_rollback := 0.0


func _on_begin() -> void:
	stop_line = def["stop_line"]
	fix_line = def["fixation_line"]
	travel = CourseData.forward2(float(def["heading"]))
	highlight = [stop_line, fix_line]
	set_hint("hint.hill_stop")


func _tick(dt: float, p: CarProbe) -> void:
	var front_past := Geo.past(stop_line, travel, p.front)
	var rear_past_fix := Geo.past(fix_line, travel, p.rear)
	var on_ramp := rear_past_fix > -10.0 and front_past < 2.0
	if not on_ramp and not stopped_once:
		return
	var along := (p.pos - stop_pos).dot(travel)
	# A stop counts once the car has stood still for a moment (a crawl through
	# zero speed while creeping up to the line is not a stop).
	if not in_stop and absf(p.speed) < STOP_SPEED and p.stopped_time > STABLE_STOP and on_ramp and front_past < 1.0:
		in_stop = true
		stopped_once = true
		stop_pos = p.pos
		stop_len = 0.0
		max_rollback = 0.0
		if not zone_checked:
			zone_checked = true
			if front_past > 0.0:
				penalize(11, "front %.2f m over" % front_past)
			elif rear_past_fix < 0.0:
				penalize(4, "rear %.2f m short of the fixation line" % -rear_past_fix)
	if in_stop:
		stop_len += dt
		along = (p.pos - stop_pos).dot(travel)
		max_rollback = maxf(max_rollback, -along)
		if max_rollback > float(def.get("max_rollback", 0.3)) and not rollback_flagged:
			rollback_flagged = true
			penalize(14)
		if stop_len > float(def.get("max_wait", 30.0)) and not wait_flagged:
			wait_flagged = true
			penalize(13)
		if stop_len < float(def.get("min_wait", 3.0)):
			set_hint("hint.hold_3s", [int(ceil(float(def.get("min_wait", 3.0)) - stop_len))])
		else:
			set_hint("hint.hill_go")
		# Moving off: counted once the car has gone forwards past its stop point.
		if along > 0.6:
			in_stop = false
			performed = true
			if stop_len < float(def.get("min_wait", 3.0)):
				penalize(12)
			finish()


func passed_without_finish() -> void:
	if not stopped_once:
		penalize(27, "hill")
	finish()
