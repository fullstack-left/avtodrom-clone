class_name SignalBadge
extends Control
## Repeats the traffic light the car is approaching. From the driver's seat
## the signal head stands above the roof line once the car is at the STOP
## line, so without this the candidate could not see red or green at all.

const LAMP_OFF := Color(0.16, 0.17, 0.19)
const LAMP_ON := [Color(1.0, 0.2, 0.16), Color(1.0, 0.72, 0.1), Color(0.2, 0.95, 0.45)]

var aspect: int = TrafficLight.Aspect.OFF:
	set(v):
		if aspect != v:
			aspect = v
			_blink_t = 0.0
			queue_redraw()
var _blink_t := 0.0


func _init() -> void:
	custom_minimum_size = Vector2(150, 58)
	mouse_filter = Control.MOUSE_FILTER_IGNORE


func _process(delta: float) -> void:
	if aspect == TrafficLight.Aspect.GREEN_BLINK and is_visible_in_tree():
		var was := _blink_on()
		_blink_t += delta
		if _blink_on() != was:
			queue_redraw()


func _blink_on() -> bool:
	return fmod(_blink_t, 1.0) < 0.5


func _draw() -> void:
	var r := Rect2(Vector2.ZERO, size)
	draw_style_box(UITheme.box(UITheme.SURFACE, 16, 1, UITheme.LINE, 0), r)
	var lit := [false, false, false]
	match aspect:
		TrafficLight.Aspect.RED: lit = [true, false, false]
		TrafficLight.Aspect.RED_YELLOW: lit = [true, true, false]
		TrafficLight.Aspect.YELLOW: lit = [false, true, false]
		TrafficLight.Aspect.GREEN: lit = [false, false, true]
		TrafficLight.Aspect.GREEN_BLINK: lit = [false, false, _blink_on()]
	var rad := minf(size.y * 0.32, size.x / 6.0 - 4.0)
	for i in 3:
		var c := Vector2(size.x * (i + 0.5) / 3.0, size.y * 0.5)
		if lit[i]:
			draw_circle(c, rad + 5.0, Color(LAMP_ON[i], 0.25))
		draw_circle(c, rad, LAMP_ON[i] if lit[i] else LAMP_OFF)
