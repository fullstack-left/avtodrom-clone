class_name Exercise
extends RefCounted
## One exam exercise. The director activates it when the car reaches the
## exercise's stretch of route (def.s0) and keeps ticking it until it reports
## done. Penalty numbers are those of the official table (data/penalties.json).

enum State { WAITING, ACTIVE, DONE }

var id := ""
var type := ""
var def: Dictionary
var director: ExamDirector
var state: State = State.WAITING
var s0 := 0.0
var s1 := 0.0
var elapsed := 0.0
## Localisation key of what the driver should do now (shown on the HUD).
var hint_key := ""
var hint_args: Array = []
## Lines to highlight for the learner (practice mode), as course line dicts.
var highlight: Array = []
var performed := false # the manoeuvre itself was carried out
var penalties_here := 0


func _init(p_def: Dictionary, p_director: ExamDirector) -> void:
	def = p_def
	director = p_director
	id = str(def["id"])
	type = str(def["type"])
	s0 = float(def["s0"])
	s1 = float(def["s1"])


func title() -> String:
	return Loc.pick(def.get("name", {}))


func begin() -> void:
	state = State.ACTIVE
	elapsed = 0.0
	_on_begin()


func tick(dt: float, p: CarProbe) -> void:
	elapsed += dt
	_tick(dt, p)


func finish() -> void:
	if state == State.DONE:
		return
	state = State.DONE
	_on_finish()


## Called when the car has moved past s1 without the exercise finishing
## itself. Default: finish (subclasses decide whether that means "skipped").
func passed_without_finish() -> void:
	finish()


func penalize(no: int, detail := "") -> void:
	penalties_here += 1
	director.add_penalty(no, id, detail)


func set_hint(key: String, args: Array = []) -> void:
	if key == hint_key and args == hint_args:
		return
	hint_key = key
	hint_args = args
	director.hint_changed.emit()


## Rules the director should relax while this exercise is active.
func allows_reverse() -> bool:
	return false


func suspends_speed_limit() -> bool:
	return false


## Free manoeuvring area (route deviation is not "leaving the route" here).
func free_area() -> Array:
	return def.get("zone", [])


func _on_begin() -> void:
	pass


func _tick(_dt: float, _p: CarProbe) -> void:
	pass


func _on_finish() -> void:
	pass
