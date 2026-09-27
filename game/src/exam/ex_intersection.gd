class_name ExIntersection
extends Exercise
## №3 regulated intersection (one pass; the route has four: left, right,
## straight, right). On red/yellow stop no more than 1 m before the STOP
## line; enter only on green; clear the junction within 30 s of green.
##   penalties: 24 (entered on a prohibiting signal / front over the STOP line
##              on red), 4 (stopped > 1 m before the line), 9 (> 30 s to pass
##              on green). Indicators are checked by the director's turn list.

const STOP_SPEED := 0.12
const STABLE_STOP := 0.4 # a crawl through zero speed while creeping up is not a stop

var line: Dictionary
var travel := Vector2.ZERO
var approach := "N"
var box := PackedVector2Array()
var entered := false
var stop_gap := -1.0
var green_since := -1.0
var green_flagged := false
var red_flagged := false
var gap_judged := false


func _on_begin() -> void:
	line = def["stop_line"]
	approach = str(def["approach"])
	box = CourseData.poly(def["box"])
	var dirs := {"N": 180.0, "S": 0.0, "W": -90.0, "E": 90.0}
	travel = CourseData.forward2(dirs[approach])
	highlight = [line]
	_update_hint()


func _update_hint() -> void:
	var go := director.traffic_go(approach)
	var turn := str(def["turn"])
	if go:
		set_hint("hint.light_green_" + turn)
	else:
		set_hint("hint.light_red")


func _tick(dt: float, p: CarProbe) -> void:
	var go := director.traffic_go(approach)
	_update_hint()
	var front_past := Geo.past(line, travel, p.front)
	if not entered:
		# Time on green counts from the moment the car is waiting at (or
		# arriving at) the line while the light allows passage.
		if go and front_past > -15.0:
			if green_since < 0.0:
				green_since = director.exam_time
		elif not go:
			green_since = -1.0
		# The last proper stop before the line counts: pulling up closer after
		# a first stop further back is allowed.
		if not go and absf(p.speed) < STOP_SPEED and p.stopped_time > STABLE_STOP \
				and front_past > -6.0 and front_past <= 0.0:
			stop_gap = -front_past
		if front_past > 0.0 and not gap_judged:
			gap_judged = true
			if stop_gap > float(def.get("max_gap", 1.0)):
				penalize(4, "stopped %.2f m before the line" % stop_gap)
		if front_past > 0.0:
			if not go and not red_flagged:
				red_flagged = true
				penalize(24)
			entered = true
	if green_since >= 0.0 and not green_flagged:
		if director.exam_time - green_since > float(def.get("green_time_limit", 30.0)):
			green_flagged = true
			penalize(9)
	# Done once the car has left the junction box on the far side.
	if entered and not Geometry2D.is_point_in_polygon(p.rear, box) and front_past > 8.0:
		performed = true
		finish()


func passed_without_finish() -> void:
	performed = true
	finish()
