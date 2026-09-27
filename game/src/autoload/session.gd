extends Node
## What the player chose in the menu, and the saved history of exam attempts.

signal history_changed

enum Mode { EXAM, PRACTICE, FREE }

const HISTORY_PATH := "user://history.json"
const MAX_HISTORY := 50

var mode: Mode = Mode.EXAM
## Exercise id for PRACTICE mode (see data/course.json "exercises").
var practice_exercise: String = ""
## Demonstration: the autopilot performs the exercise (or the whole exam).
var demo := false
## Car preset forced from the command line (automated checks); "" = settings.
var car_override := ""
var last_result: Dictionary = {}
var history: Array = []


func _ready() -> void:
	_load_history()
	# Automated checks can open the drive scene directly:
	#   -- --mode=practice --exercise=<id> --demo --car=cobalt_at
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("--mode="):
			mode = {"exam": Mode.EXAM, "practice": Mode.PRACTICE, "free": Mode.FREE}.get(arg.substr(7), Mode.EXAM)
		elif arg.begins_with("--exercise="):
			practice_exercise = arg.substr(11)
		elif arg == "--demo":
			demo = true
		elif arg.begins_with("--car="):
			car_override = arg.substr(6)


func start(p_mode: Mode, exercise: String = "", p_demo := false) -> void:
	mode = p_mode
	practice_exercise = exercise
	demo = p_demo
	get_tree().change_scene_to_file("res://scenes/drive.tscn")


func back_to_menu() -> void:
	get_tree().paused = false
	get_tree().change_scene_to_file("res://scenes/main.tscn")


## Instructions on the exercise card and the yellow lines: practice and the
## demonstrations only — the exam is taken without prompts, like the real one.
func hints_enabled() -> bool:
	return mode == Mode.PRACTICE or demo


## The blue route line: always in practice and the demonstrations, optional
## in the exam, never in free driving.
func route_visible() -> bool:
	if mode == Mode.PRACTICE or demo:
		return true
	return mode == Mode.EXAM and bool(Settings.get_value("show_route"))


func car_id() -> String:
	return car_override if car_override != "" else str(Settings.get_value("car"))


func record_result(result: Dictionary) -> void:
	last_result = result
	if mode != Mode.EXAM or demo:
		return
	history.push_front(result)
	if history.size() > MAX_HISTORY:
		history.resize(MAX_HISTORY)
	_save_history()
	history_changed.emit()


func best_exam_score() -> int:
	var best := -1
	for r in history:
		if r.get("passed", false):
			var p := int(r.get("penalty", 999))
			if best < 0 or p < best:
				best = p
	return best


func pass_count() -> int:
	var n := 0
	for r in history:
		if r.get("passed", false):
			n += 1
	return n


func _load_history() -> void:
	if not FileAccess.file_exists(HISTORY_PATH):
		return
	var text := FileAccess.get_file_as_string(HISTORY_PATH)
	var data: Variant = JSON.parse_string(text)
	if data is Array:
		history = data


func _save_history() -> void:
	var f := FileAccess.open(HISTORY_PATH, FileAccess.WRITE)
	if f == null:
		push_warning("History could not be saved: %s" % error_string(FileAccess.get_open_error()))
		return
	f.store_string(JSON.stringify(history))
