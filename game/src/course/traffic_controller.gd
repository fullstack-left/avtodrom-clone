class_name TrafficController
extends Node
## Two-phase signal plan for the avtodrom intersection (north–south vs
## east–west), with the CIS sequence red → red+yellow → green → blinking
## green → yellow → red and an all-red clearance between the phases.

signal changed

const SEQUENCE := [
	[TrafficLight.Aspect.RED_YELLOW, 1.5],
	[TrafficLight.Aspect.GREEN, 16.0],
	[TrafficLight.Aspect.GREEN_BLINK, 3.0],
	[TrafficLight.Aspect.YELLOW, 3.0],
	[TrafficLight.Aspect.RED, 2.0],
]

var lights: Array[TrafficLight] = []
var time := 0.0
var half_cycle := 0.0
var _last_ns := -1
var _last_ew := -1


func _ready() -> void:
	for step in SEQUENCE:
		half_cycle += float(step[1])
	if lights.is_empty() and get_parent():
		for n in get_parent().find_children("*", "TrafficLight", true, false):
			lights.append(n as TrafficLight)
	_apply()


## Starts the cycle so that the given group just turned red (the candidate
## will meet a red light first) — or with a random offset.
func randomize_phase(rng: RandomNumberGenerator) -> void:
	time = rng.randf_range(0.0, half_cycle * 2.0)
	_apply()


func _process(delta: float) -> void:
	time = fmod(time + delta, half_cycle * 2.0)
	_apply()


func _aspect_at(t: float) -> int:
	# t within [0, half_cycle): this group's active phase.
	var acc := 0.0
	for step in SEQUENCE:
		acc += float(step[1])
		if t < acc:
			return int(step[0])
	return TrafficLight.Aspect.RED


func aspect_for_group(group: String) -> int:
	var t := time if group == "NS" else fmod(time + half_cycle, half_cycle * 2.0)
	if t < half_cycle:
		return _aspect_at(t)
	return TrafficLight.Aspect.RED


## Seconds until the given group next shows green (0 if green now).
func time_to_green(group: String) -> float:
	var t := time if group == "NS" else fmod(time + half_cycle, half_cycle * 2.0)
	var green_start := float(SEQUENCE[0][1])
	var green_end := green_start + float(SEQUENCE[1][1]) + float(SEQUENCE[2][1])
	if t >= green_start and t < green_end:
		return 0.0
	return fposmod(green_start - t, half_cycle * 2.0)


## Seconds the given group may still enter (green or blinking green); 0 if not.
func time_to_stop(group: String) -> float:
	var t := time if group == "NS" else fmod(time + half_cycle, half_cycle * 2.0)
	var green_start := float(SEQUENCE[0][1])
	var green_end := green_start + float(SEQUENCE[1][1]) + float(SEQUENCE[2][1])
	if t >= green_start and t < green_end:
		return green_end - t
	return 0.0


func _apply() -> void:
	var ns := aspect_for_group("NS")
	var ew := aspect_for_group("EW")
	if ns == _last_ns and ew == _last_ew:
		return
	_last_ns = ns
	_last_ew = ew
	for l in lights:
		l.set_aspect(ns if l.group == "NS" else ew)
	changed.emit()


## Aspect shown to traffic arriving from `approach` ("N", "S", "E", "W").
func aspect_for_approach(approach: String) -> int:
	return aspect_for_group("NS" if approach in ["N", "S"] else "EW")
