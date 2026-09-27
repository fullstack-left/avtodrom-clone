class_name Geo
extends RefCounted
## 2-D helpers for the exam rules (world X/Z as Vector2).


static func line_a(line: Dictionary) -> Vector2:
	return CourseData.v2(line["a"])


static func line_b(line: Dictionary) -> Vector2:
	return CourseData.v2(line["b"])


## Unit normal of a line, oriented along `travel` (so "ahead" is positive).
static func line_normal(line: Dictionary, travel: Vector2) -> Vector2:
	var d := (line_b(line) - line_a(line)).normalized()
	var n := Vector2(-d.y, d.x)
	return n if n.dot(travel) >= 0.0 else -n


## Signed distance of `p` past the line in the direction of travel.
static func past(line: Dictionary, travel: Vector2, p: Vector2) -> float:
	return (p - line_a(line)).dot(line_normal(line, travel))


## True when p lies within the line's extent (between its end points, with margin).
static func within_span(line: Dictionary, p: Vector2, margin := 0.5) -> bool:
	var a := line_a(line)
	var b := line_b(line)
	var d := b - a
	var t := (p - a).dot(d) / maxf(d.length_squared(), 1e-6)
	var L := d.length()
	return t >= -margin / L and t <= 1.0 + margin / L


static func seg_distance(p: Vector2, a: Vector2, b: Vector2) -> float:
	var d := b - a
	var t := clampf((p - a).dot(d) / maxf(d.length_squared(), 1e-9), 0.0, 1.0)
	return p.distance_to(a + d * t)


static func line_distance(line: Dictionary, p: Vector2) -> float:
	return seg_distance(p, line_a(line), line_b(line))


static func poly(arr: Array) -> PackedVector2Array:
	return CourseData.poly(arr)


static func dir_from_yaw(yaw_deg: float) -> Vector2:
	return CourseData.forward2(yaw_deg)


## Smallest angle between two directions, degrees.
static func angle_between(a: Vector2, b: Vector2) -> float:
	return rad_to_deg(absf(a.angle_to(b)))
