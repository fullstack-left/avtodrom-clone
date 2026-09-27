class_name ExCorridor
extends Exercise
## №5 "90° turns" and №6 "Zmeyka": drive the corridor from its start line to
## its end line in under 2 minutes without a tyre touching the control lines
## painted 0.35 m off the kerbs.
##   penalties: 15 (tyre on a control line — each separate touch),
##              16 (more than 2 minutes)

## A tyre (185 mm wide) touches the 120 mm line centred 0.35 m off the kerb
## once its centre comes within 0.35 + 0.06 + 0.0925 m of the kerb face.
const TOUCH_DISTANCE := 0.5025
const RELEASE_TIME := 0.8

var start_line: Dictionary
var end_line: Dictionary
var started := false
var run_time := 0.0
var touching := false
var clear_time := 0.0
var time_flagged := false
var touches := 0


func _on_begin() -> void:
	start_line = def["start_line"]
	end_line = def["end_line"]
	highlight = [start_line, end_line]
	set_hint("hint.corridor")


func _travel_dir() -> Vector2:
	return director.data.route_dir(director.tracker.s)


func _tick(dt: float, p: CarProbe) -> void:
	if not started:
		var d0 := Geo.line_distance(start_line, p.front)
		if d0 < 0.6 or director.tracker.s > s0 + 0.5:
			started = true
		else:
			return
	run_time += dt
	if run_time > float(def.get("time_limit", 120.0)) and not time_flagged:
		time_flagged = true
		penalize(16)
	var any := false
	var which := -1
	for i in 4:
		if p.wheel_contact[i] and director.data.kerb_distance(p.wheels[i]) < TOUCH_DISTANCE:
			any = true
			which = i
			break
	if any:
		clear_time = 0.0
		if not touching:
			touching = true
			touches += 1
			penalize(15, "%s wheel %.2f m from the kerb at (%.1f, %.1f)" % [CarProbe.WHEEL_NAMES[which],
					director.data.kerb_distance(p.wheels[which]), p.wheels[which].x, p.wheels[which].y])
	else:
		clear_time += dt
		if clear_time > RELEASE_TIME:
			touching = false
	var remaining := float(def.get("time_limit", 120.0)) - run_time
	set_hint("hint.corridor_time", [int(maxf(remaining, 0.0))])
	if director.tracker.s >= s1 - 0.3 and Geo.line_distance(end_line, p.pos) < 4.0:
		performed = true
		finish()


func passed_without_finish() -> void:
	performed = started
	if not started:
		penalize(27, id)
	finish()
