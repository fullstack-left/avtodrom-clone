class_name ExBox
extends Exercise
## №4 "Boksga kirish" (turn-round using the box). Drive into the dead-end
## pad, reverse into the side bay until both rear wheels stand on the white
## fixation band, then drive out forwards and leave the way you came. Past the
## band, just short of the back kerb, runs a yellow limit line that no wheel
## may touch. The position is judged at the last stop in the bay before the
## car drives out of it.
##   penalties: 17 (a rear wheel off the band, or the yellow line run over),
##              27 (not performed)

enum Phase { ENTER, IN_BAY, LEAVING }

const TYRE_HALF := 0.0925 # half the tyre's footprint
const STABLE_STOP := 0.8

var phase: Phase = Phase.ENTER
var bay := PackedVector2Array()
var fix_line: Dictionary
var fix_touch := 0.0
var limit_line: Dictionary
var limit_touch := 0.0
var limit_hit := false
var last_ok := false
var judged := false


func _on_begin() -> void:
	bay = CourseData.poly(def["bay"])
	fix_line = def["fixation_line"]
	fix_touch = float(def.get("fixation_width", 0.12)) * 0.5 + TYRE_HALF
	limit_line = def.get("limit_line", {})
	limit_touch = float(def.get("limit_width", 0.15)) * 0.5 + TYRE_HALF
	highlight = [fix_line]
	set_hint("hint.box_enter")


func allows_reverse() -> bool:
	return true


## Both rear tyres touch the fixation band.
func _rear_wheels_on_band(p: CarProbe) -> bool:
	for i in [2, 3]:
		if Geo.line_distance(fix_line, p.wheels[i]) > fix_touch:
			return false
	return true


func _check_limit(p: CarProbe) -> void:
	if limit_hit or limit_line.is_empty():
		return
	for i in 4:
		if p.wheel_contact[i] and Geo.line_distance(limit_line, p.wheels[i]) <= limit_touch:
			limit_hit = true
			penalize(17, "yellow limit line, wheel %s" % CarProbe.WHEEL_NAMES[i])
			return


func _in_bay(p: CarProbe) -> bool:
	return Geometry2D.is_point_in_polygon(p.rear, bay) and p.heading_error_deg(float(def["bay_heading"])) < 35.0


func _tick(_dt: float, p: CarProbe) -> void:
	if phase != Phase.LEAVING:
		_check_limit(p)
	match phase:
		Phase.ENTER:
			if _in_bay(p):
				set_hint("hint.box_fix")
				if p.stopped_time > STABLE_STOP:
					phase = Phase.IN_BAY
					performed = true
			elif p.reversing:
				set_hint("hint.box_reverse")
			else:
				set_hint("hint.box_enter")
		Phase.IN_BAY:
			if _in_bay(p) and p.stopped_time > STABLE_STOP:
				last_ok = _rear_wheels_on_band(p)
				set_hint("hint.box_leave" if last_ok else "hint.box_fix")
			if not Geometry2D.is_point_in_polygon(p.rear, bay) and p.speed > 0.2:
				_judge(p)
				phase = Phase.LEAVING
		Phase.LEAVING:
			set_hint("hint.box_leave")
			var entry: Dictionary = def["entry_line"]
			if Geo.past(entry, Vector2(0, -1), p.rear) > 0.5:
				finish()


func _judge(p: CarProbe) -> void:
	if judged:
		return
	judged = true
	# One №17 per exercise: the yellow line already cost it.
	if not last_ok and not limit_hit:
		penalize(17, "RL %.2f m, RR %.2f m from the band" % [Geo.line_distance(fix_line, p.wheels[2]),
				Geo.line_distance(fix_line, p.wheels[3])])


func passed_without_finish() -> void:
	if not performed:
		penalize(27, id)
	else:
		_judge(director.probe)
	finish()
