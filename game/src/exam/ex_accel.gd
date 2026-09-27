class_name ExAccel
extends Exercise
## №9 acceleration section: between the "40" and "20" signs keep at least
## 20 km/h (sign 4.7) and at most 40 km/h (sign 3.24); on a manual gearbox
## change up into 2nd gear; slow back to 20 km/h after the section.
##   penalties: 6 (signs 4.7 / 3.24 disobeyed), 18 (2nd gear not engaged)
## The general "> 20 km/h" rule is suspended inside the section.

const SETTLE_DISTANCE := 18.0 # metres allowed to reach 20 km/h after the sign
const SLOW_GRACE := 2.0 # seconds below 20 km/h tolerated

var entry_s := 0.0
var slow_t := 0.0
var sign_flagged := false
var used_second := false
var max_kmh := 0.0


func _on_begin() -> void:
	entry_s = director.tracker.s
	set_hint("hint.accel")


func suspends_speed_limit() -> bool:
	return true


func _tick(dt: float, p: CarProbe) -> void:
	var s := director.tracker.s
	max_kmh = maxf(max_kmh, p.speed_kmh)
	var car := director.car
	if not car.is_automatic() and car.get_gear() >= 2 and p.speed_kmh > 12.0:
		used_second = true
	if s > s0 + SETTLE_DISTANCE and s < s1:
		if p.speed_kmh < float(def.get("min_speed", 20.0)):
			slow_t += dt
			if slow_t > SLOW_GRACE and not sign_flagged:
				sign_flagged = true
				penalize(6)
		else:
			slow_t = 0.0
		if p.speed_kmh > float(def.get("max_speed", 40.0)) + 0.5 and not sign_flagged:
			sign_flagged = true
			penalize(6)
	if s >= s1:
		set_hint("hint.accel_end")
	elif not car.is_automatic() and not used_second:
		set_hint("hint.accel")
	else:
		set_hint("hint.accel_hold")
	if s >= s1 + 12.0:
		_evaluate()
		finish()


func _evaluate() -> void:
	performed = true
	if not director.car.is_automatic() and not used_second:
		penalize(18)


func passed_without_finish() -> void:
	if not performed:
		_evaluate()
	finish()
