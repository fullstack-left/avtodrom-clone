class_name Pedal
extends Control
## Analog on-screen pedal worked like a real one: touching it presses it by
## `base`, sliding the finger down presses it further and sliding up lets it
## back, so any opening can be held (half throttle, the clutch's biting point).
## Where on the pedal the finger lands does not matter.

signal changed(value: float)

## Finger travel, as a fraction of the pedal's height, from released to floor.
const TRAVEL := 0.5

@export var caption := ""
@export var accent := UITheme.GO
## Opening as soon as the pedal is touched (1 = straight to the floor).
@export var base := 0.15
## value = travel ^ curve (curve > 1 gives finer control at small openings).
@export var curve := 1.0
var value := 0.0
var _touch := -1
## Finger y at which the pedal is released; follows the finger past either end
## of the travel, so reversing direction always acts at once.
var _zero_y := 0.0


func _init(p_caption := "", p_accent := UITheme.GO, p_curve := 1.0, p_base := 0.15) -> void:
	caption = p_caption
	accent = p_accent
	curve = p_curve
	base = p_base
	mouse_filter = Control.MOUSE_FILTER_STOP


func _gui_input(event: InputEvent) -> void:
	if event is InputEventScreenTouch:
		if event.pressed and _touch < 0:
			_touch = event.index
			_zero_y = event.position.y - pow(base, 1.0 / curve) * _travel_px()
			_set_from(event.position)
		elif not event.pressed and event.index == _touch:
			_touch = -1
			_set_value(0.0)
		accept_event()
	elif event is InputEventScreenDrag and event.index == _touch:
		_set_from(event.position)
		accept_event()
	elif event is InputEventMouseButton:
		accept_event()


func _travel_px() -> float:
	return maxf(size.y * TRAVEL, 40.0)


func _set_from(p: Vector2) -> void:
	var span := _travel_px()
	var u := (p.y - _zero_y) / span
	if u > 1.0:
		_zero_y += (u - 1.0) * span
	elif u < 0.0:
		_zero_y += u * span
	_set_value(pow(clampf(u, 0.0, 1.0), curve))


func _set_value(v: float) -> void:
	if is_equal_approx(v, value):
		return
	value = v
	changed.emit(value)
	queue_redraw()


## The app lost focus mid-touch: no finger-up will arrive.
func release_touch() -> void:
	_touch = -1
	_set_value(0.0)


func is_held() -> bool:
	return _touch >= 0


func _draw() -> void:
	var r := Rect2(Vector2.ZERO, size)
	# Perspective: the pressed pedal leans away (shorter, darker).
	var squash := value * 0.08
	var body := Rect2(r.position + Vector2(size.x * squash, size.y * squash * 0.5),
			r.size - Vector2(size.x * squash * 2.0, size.y * squash))
	var held := _touch >= 0
	draw_style_box(UITheme.box(Color(0.14, 0.15, 0.17, 0.92).darkened(value * 0.3), 22, 2,
			accent.lerp(Color.WHITE, 0.1) if held else Color(1, 1, 1, 0.18), 0), body)
	# Rubber ridges.
	var ridge_col := Color(1, 1, 1, 0.08 + value * 0.05)
	var n := 7
	for i in n:
		var y := body.position.y + body.size.y * (0.2 + 0.1 * i)
		draw_line(Vector2(body.position.x + body.size.x * 0.18, y),
				Vector2(body.end.x - body.size.x * 0.18, y), ridge_col, 4.0, true)
	# Pressure level, with the percentage so a steady part-throttle is easy to hold.
	if value > 0.0:
		var fill_h := (body.size.y - 12) * value
		var fill := Rect2(body.position.x + 6, body.end.y - 6 - fill_h, body.size.x - 12, fill_h)
		draw_style_box(UITheme.box(Color(accent, 0.35), 16, 0, UITheme.LINE, 0), fill)
	var f := UITheme.bold()
	var fs := 18
	var w := f.get_string_size(caption, HORIZONTAL_ALIGNMENT_LEFT, -1, fs).x
	draw_string(f, Vector2(size.x * 0.5 - w * 0.5, body.position.y + 30), caption, HORIZONTAL_ALIGNMENT_LEFT, -1,
			fs, UITheme.TEXT if held else UITheme.TEXT_DIM)
	if held:
		var pct := "%d%%" % roundi(value * 100.0)
		var pw := f.get_string_size(pct, HORIZONTAL_ALIGNMENT_LEFT, -1, 20).x
		draw_string(f, Vector2(size.x * 0.5 - pw * 0.5, body.end.y - 16), pct, HORIZONTAL_ALIGNMENT_LEFT, -1,
				20, UITheme.TEXT)
