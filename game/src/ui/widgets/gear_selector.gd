class_name GearSelector
extends Control
## Gear lever. Manual: the H-gate of the Nexia (1-2 / 3-4 / 5-R, neutral
## across the middle) — tap a gate to select it. Automatic: P R N D strip.

signal gear_requested(gear: int)

var automatic := false
var current := 0 # manual gear (-1..5) or AT selector (0..3)
var reject_flash := 0.0
var _slots := {} # gear -> Rect2
var _touch := -1


func _init() -> void:
	mouse_filter = Control.MOUSE_FILTER_STOP


func _layout() -> void:
	_slots.clear()
	var w := size.x
	var h := size.y
	if automatic:
		var labels := [AvtoGear.PARK, AvtoGear.AUTO_REVERSE, AvtoGear.AUTO_NEUTRAL, AvtoGear.DRIVE]
		var cell := h / 4.0
		for i in 4:
			_slots[labels[i]] = Rect2(0, i * cell, w, cell)
		return
	var col := w / 3.0
	var row := h / 3.0
	var gates := {1: Vector2(0, 0), 2: Vector2(0, 2), 3: Vector2(1, 0), 4: Vector2(1, 2), 5: Vector2(2, 0), -1: Vector2(2, 2)}
	for g in gates:
		var p: Vector2 = gates[g]
		_slots[g] = Rect2(p.x * col, p.y * row, col, row)
	_slots[0] = Rect2(0, row, w, row)


func _gui_input(event: InputEvent) -> void:
	if event is InputEventScreenTouch:
		if event.pressed and _touch < 0:
			_touch = event.index
			_layout()
			for g in _slots:
				if (_slots[g] as Rect2).has_point(event.position):
					gear_requested.emit(g)
					break
		elif not event.pressed and event.index == _touch:
			_touch = -1
		accept_event()
	elif event is InputEventMouseButton:
		accept_event()


func set_current(g: int) -> void:
	if g != current:
		current = g
		queue_redraw()


## The app lost focus mid-touch: no finger-up will arrive.
func release_touch() -> void:
	_touch = -1


func reject() -> void:
	reject_flash = 0.6
	queue_redraw()


func _process(delta: float) -> void:
	if reject_flash > 0.0:
		reject_flash = maxf(0.0, reject_flash - delta)
		queue_redraw()


func _draw() -> void:
	_layout()
	var bg := UITheme.SURFACE.lerp(UITheme.STOP.darkened(0.4), reject_flash)
	draw_style_box(UITheme.box(bg, 20, 1, UITheme.LINE, 0), Rect2(Vector2.ZERO, size))
	var f := UITheme.bold()
	if automatic:
		var names := {AvtoGear.PARK: "P", AvtoGear.AUTO_REVERSE: "R", AvtoGear.AUTO_NEUTRAL: "N", AvtoGear.DRIVE: "D"}
		for g in _slots:
			var r: Rect2 = _slots[g]
			var on: bool = g == current
			if on:
				draw_style_box(UITheme.box(UITheme.GO.darkened(0.25), 14, 0, UITheme.LINE, 0), r.grow(-6))
			var fs := 30
			var t: String = names[g]
			var tw := f.get_string_size(t, HORIZONTAL_ALIGNMENT_LEFT, -1, fs).x
			draw_string(f, r.get_center() + Vector2(-tw * 0.5, fs * 0.36), t, HORIZONTAL_ALIGNMENT_LEFT, -1, fs,
					UITheme.TEXT if on else UITheme.TEXT_FAINT)
		return
	# H-gate lines.
	var col := size.x / 3.0
	var row := size.y / 3.0
	var line_col := Color(1, 1, 1, 0.22)
	var mid := row * 1.5
	draw_line(Vector2(col * 0.5, row * 0.5), Vector2(col * 0.5, row * 2.5), line_col, 5.0, true)
	draw_line(Vector2(col * 1.5, row * 0.5), Vector2(col * 1.5, row * 2.5), line_col, 5.0, true)
	draw_line(Vector2(col * 2.5, row * 0.5), Vector2(col * 2.5, row * 2.5), line_col, 5.0, true)
	draw_line(Vector2(col * 0.5, mid), Vector2(col * 2.5, mid), line_col, 5.0, true)
	var labels := {1: "1", 2: "2", 3: "3", 4: "4", 5: "5", -1: "R"}
	for g in labels:
		var r: Rect2 = _slots[g]
		var on: bool = g == current
		var cpos := r.get_center()
		if on:
			draw_circle(cpos, minf(col, row) * 0.36, UITheme.GO.darkened(0.2))
		var fs := 26
		var t: String = labels[g]
		var tw := f.get_string_size(t, HORIZONTAL_ALIGNMENT_LEFT, -1, fs).x
		draw_string(f, cpos + Vector2(-tw * 0.5, fs * 0.36), t, HORIZONTAL_ALIGNMENT_LEFT, -1, fs,
				UITheme.TEXT if on else UITheme.TEXT_DIM)
	# Knob in neutral.
	if current == 0:
		draw_circle(Vector2(size.x * 0.5, mid), minf(col, row) * 0.3, UITheme.GO.darkened(0.2))
		var t := "N"
		var fs := 22
		var tw := f.get_string_size(t, HORIZONTAL_ALIGNMENT_LEFT, -1, fs).x
		draw_string(f, Vector2(size.x * 0.5 - tw * 0.5, mid + fs * 0.36), t, HORIZONTAL_ALIGNMENT_LEFT, -1, fs, UITheme.TEXT)
