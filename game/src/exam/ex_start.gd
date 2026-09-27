class_name ExStart
extends Exercise
## №1 "Start". After the START signal the candidate must move off within
## 30 s (40 s is a gross error), cross the START line with the left indicator
## on and switch it off within 10 m after the line.
##   penalties: 2 (no left indicator at the line), 3 (not switched off in 10 m),
##              10 (no start within 30 s), 23 (no start within 40 s)

var line: Dictionary
var travel := Vector2.ZERO
var crossed := false
var cross_pos := Vector2.ZERO
var moved := false
var warned_30 := false
var failed_40 := false
var off_checked := false


func _on_begin() -> void:
	line = def["start_line"]
	travel = CourseData.forward2(float(def["spawn"]["yaw"]))
	set_hint("hint.start_go")


func _tick(_dt: float, p: CarProbe) -> void:
	var since_signal := director.time_since_start_signal()
	if not moved:
		if p.travelled > 0.5:
			moved = true
		elif since_signal > 40.0 and not failed_40:
			failed_40 = true
			penalize(23)
		elif since_signal > 30.0 and not warned_30:
			warned_30 = true
			penalize(10)
	if not crossed:
		if Geo.past(line, travel, p.front) > 0.0:
			crossed = true
			cross_pos = p.pos
			if not director.car.signalling_left():
				penalize(2)
			set_hint("hint.signal_off")
		return
	if not off_checked:
		var d := p.pos.distance_to(cross_pos)
		if not director.car.signalling_left():
			off_checked = true
			performed = true
			finish()
		elif d > float(def.get("signal_off_distance", 10.0)):
			off_checked = true
			penalize(3)
			performed = true
			finish()


func passed_without_finish() -> void:
	if crossed and not off_checked and director.car.signalling_left():
		penalize(3)
	finish()
