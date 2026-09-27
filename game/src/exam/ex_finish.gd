class_name ExFinish
extends Exercise
## №12 "Finish": right indicator on before the FINISH line, cross it, stop,
## neutral (P), handbrake, engine off, seat belt off.
##   penalties: 7 (right indicator not on before the finish line)

var line: Dictionary
var crossed := false
var after_t := 0.0


func _on_begin() -> void:
	line = def["finish_line"]
	highlight = [line]
	set_hint("hint.finish_signal")


func _tick(dt: float, p: CarProbe) -> void:
	var travel := director.data.route_dir(director.tracker.s)
	if not crossed:
		if Geo.past(line, Vector2(1, 0), p.front) > 0.0:
			crossed = true
			performed = true
			if not director.car.signalling_right():
				penalize(7)
		return
	after_t += dt
	var car := director.car
	var parked := p.stopped and car.handbrake > 0.5 and AvtoGear.in_neutral_or_park(car)
	if not p.stopped:
		set_hint("hint.finish_stop")
	elif not parked:
		set_hint("hint.finish_park")
	elif car.is_engine_running():
		set_hint("hint.finish_engine")
	elif car.seatbelt:
		set_hint("hint.finish_belt")
	if (parked and not car.is_engine_running() and not car.seatbelt) or after_t > 40.0:
		finish()
	var _unused := travel


func passed_without_finish() -> void:
	if not crossed:
		return # the route ends here; the director waits for the finish line
	finish()
