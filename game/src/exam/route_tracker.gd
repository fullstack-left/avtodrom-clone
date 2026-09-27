class_name RouteTracker
extends RefCounted
## Follows the car's progress along the exam route.
##
## The route crosses itself (the intersection is passed four times) and in
## the box pad it runs down and back up the same lane, so the nearest point
## is searched only in a window around the last known index, and segments
## whose direction matches the car's motion are preferred.

const BACK := 40 # samples (0.5 m each) searched behind the last index
const AHEAD := 90
const DIRECTION_WEIGHT := 4.0 # m² penalty for a segment pointing against the motion
const INDEX_WEIGHT := 0.0004 # tie-break towards the current index

var data: CourseData
var index := 0
var s := 0.0 # arc length along the route, m
var lateral := 0.0 # signed distance from the route, + = left of travel
var max_s := 0.0
var _last_pos := Vector2.INF


func _init(p_data: CourseData) -> void:
	data = p_data


func reset(s0: float) -> void:
	index = data.route_index(s0)
	s = s0
	max_s = s0
	_last_pos = Vector2.INF


func update(p: Vector2) -> void:
	var motion := Vector2.ZERO
	if _last_pos != Vector2.INF:
		var d := p - _last_pos
		if d.length() > 0.004:
			motion = d.normalized()
	_last_pos = p
	var pts := data.route
	var n := pts.size()
	var lo := maxi(index - BACK, 0)
	var hi := mini(index + AHEAD, n - 2)
	var best := INF
	var best_i := index
	var best_t := 0.0
	for i in range(lo, hi + 1):
		var a := pts[i]
		var b := pts[i + 1]
		var d := b - a
		var t := clampf((p - a).dot(d) / maxf(d.length_squared(), 1e-9), 0.0, 1.0)
		var q := a + d * t
		var score := p.distance_squared_to(q) + absf(i - index) * INDEX_WEIGHT
		if motion != Vector2.ZERO:
			score += DIRECTION_WEIGHT * (1.0 - motion.dot(d.normalized())) * 0.5
		if score < best:
			best = score
			best_i = i
			best_t = t
	index = best_i
	var a2 := pts[best_i]
	var b2 := pts[best_i + 1]
	var dir := (b2 - a2).normalized()
	s = data.route_s[best_i] + (data.route_s[best_i + 1] - data.route_s[best_i]) * best_t
	var q2 := a2.lerp(b2, best_t)
	var off := p - q2
	lateral = off.dot(Vector2(dir.y, -dir.x))
	max_s = maxf(max_s, s)


func distance_from_route() -> float:
	return absf(lateral)
