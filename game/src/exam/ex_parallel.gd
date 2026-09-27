class_name ExParallel
extends Exercise
## №7 parallel parking. Pass the pocket, reverse into it so that both right
## tyres (front and rear) stand on the white fixation band along the kerb,
## then drive out. Small corrections inside the pocket are allowed: the
## position is judged at the last stop before the car leaves the pocket.
##   penalties: 17 (a right wheel off the band), 27 (not performed)

enum Phase { APPROACH, IN_POCKET, LEAVING }

const TYRE_HALF := 0.0925 # half the tyre's footprint
const STABLE_STOP := 0.8
## A car standing crooked in the pocket has still performed the exercise; the
## crooked stance is judged by the fixation line (№17), not as "not done" (№27).
const MAX_ANGLE := 35.0

var phase: Phase = Phase.APPROACH
var pocket := PackedVector2Array()
var fix_line: Dictionary
var fix_touch := 0.0
var last_on_line := false
var judged := false


func _on_begin() -> void:
	pocket = CourseData.poly(def["pocket"])
	fix_line = def["fixation_line"]
	fix_touch = float(def.get("fixation_width", 0.12)) * 0.5 + TYRE_HALF
	highlight = [fix_line]
	set_hint("hint.parallel_pass")


func allows_reverse() -> bool:
	return true


func _right_wheels_on_line(p: CarProbe) -> bool:
	for i in [1, 3]:
		if Geo.line_distance(fix_line, p.wheels[i]) > fix_touch:
			return false
	return true


func _tick(_dt: float, p: CarProbe) -> void:
	var inside := p.inside(pocket, 0.35)
	var aligned := p.heading_error_deg(float(def["park_heading"])) < MAX_ANGLE
	match phase:
		Phase.APPROACH:
			if inside and aligned and p.stopped_time > STABLE_STOP:
				phase = Phase.IN_POCKET
				performed = true
			elif p.reversing:
				set_hint("hint.parallel_reverse")
			else:
				set_hint("hint.parallel_pass")
		Phase.IN_POCKET:
			if inside and p.stopped_time > STABLE_STOP:
				last_on_line = _right_wheels_on_line(p)
				set_hint("hint.parallel_leave" if last_on_line else "hint.parallel_fix")
			if not p.inside(pocket, 1.0) and p.speed > 0.2:
				_judge(p)
				phase = Phase.LEAVING
		Phase.LEAVING:
			set_hint("hint.go")
			if director.tracker.s > s1 - 3.0:
				finish()


func _judge(p: CarProbe) -> void:
	if judged:
		return
	judged = true
	if not last_on_line:
		penalize(17, "FR %.2f m, RR %.2f m from the line" % [Geo.line_distance(fix_line, p.wheels[1]),
				Geo.line_distance(fix_line, p.wheels[3])])


func passed_without_finish() -> void:
	if not performed:
		penalize(27, id)
	elif not judged:
		judged = true
		if not last_on_line:
			penalize(17)
	finish()
