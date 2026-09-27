class_name HudLayoutEditor
extends Control
## Lays out the touch controls: drag a control to move it, the slider sets
## the size of the one picked; "Standard" brings back the built-in layout,
## "Done" keeps the new one (Settings "hud_layout"). Works over the paused
## drive, on top of the real controls.

signal finished

const MIN_SCALE := 0.5
const MAX_SCALE := 1.8

var hud: Hud
var _layout := {}
var _sel := ""
var _touch := -1
var _grab := Vector2.ZERO
var _slider: HSlider
var _size_label: Label
var _bar: PanelContainer


func _init(p_hud: Hud) -> void:
	hud = p_hud
	name = "HudLayoutEditor"
	process_mode = Node.PROCESS_MODE_ALWAYS
	mouse_filter = Control.MOUSE_FILTER_STOP
	set_anchors_preset(Control.PRESET_FULL_RECT)


func _ready() -> void:
	_layout = (Settings.get_value("hud_layout") as Dictionary).duplicate(true)
	_bar = PanelContainer.new()
	_bar.add_theme_stylebox_override("panel", UITheme.box(Color(0.05, 0.06, 0.08, 0.92), 18, 1, UITheme.LINE, 12))
	add_child(_bar)
	var v := VBoxContainer.new()
	v.add_theme_constant_override("separation", 8)
	_bar.add_child(v)
	var title := UITheme.label(Loc.t("layout.title"), 20, UITheme.CAUTION, true)
	title.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	v.add_child(title)
	var hint := UITheme.label(Loc.t("layout.hint"), 15, UITheme.TEXT_DIM)
	hint.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	hint.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	hint.custom_minimum_size = Vector2(420, 0)
	v.add_child(hint)
	var row := HBoxContainer.new()
	row.add_theme_constant_override("separation", 10)
	v.add_child(row)
	_size_label = UITheme.label("", 16, UITheme.TEXT)
	_size_label.custom_minimum_size = Vector2(120, 0)
	row.add_child(_size_label)
	_slider = HSlider.new()
	_slider.min_value = MIN_SCALE * 100.0
	_slider.max_value = MAX_SCALE * 100.0
	_slider.step = 5.0
	_slider.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_slider.custom_minimum_size = Vector2(220, 40)
	_slider.value_changed.connect(_on_scale)
	row.add_child(_slider)
	var buttons := HBoxContainer.new()
	buttons.add_theme_constant_override("separation", 10)
	buttons.alignment = BoxContainer.ALIGNMENT_CENTER
	v.add_child(buttons)
	var reset := UITheme.button(Loc.t("layout.reset"), 17, 46)
	reset.pressed.connect(func() -> void:
		_layout = {}
		_select("")
		hud.preview_layout(_layout)
		queue_redraw())
	buttons.add_child(reset)
	var done := UITheme.primary_button(Loc.t("layout.done"), 17, 46)
	done.pressed.connect(finish)
	buttons.add_child(done)
	_select("")
	hud.preview_layout(_layout)
	get_viewport().size_changed.connect(_place_bar)
	_place_bar.call_deferred()


func _place_bar() -> void:
	_bar.reset_size()
	var vp := get_viewport_rect().size
	_bar.position = Vector2(vp.x * 0.5 - _bar.size.x * 0.5, vp.y * 0.08)


func finish() -> void:
	Settings.set_value("hud_layout", _layout)
	hud.end_layout_preview()
	finished.emit()


func _controls() -> Dictionary:
	var out := {}
	var all := hud.editable_controls()
	for id in all:
		var c: Control = all[id]
		if c and c.visible:
			out[id] = c
	return out


## The smallest visible control under the point (small buttons sit near big pedals).
func _pick(p: Vector2) -> String:
	var best := ""
	var best_area := INF
	var all := _controls()
	for id in all:
		var r: Rect2 = (all[id] as Control).get_global_rect()
		if r.grow(10.0).has_point(p) and r.get_area() < best_area:
			best = id
			best_area = r.get_area()
	return best


func _select(id: String) -> void:
	_sel = id
	_slider.editable = id != ""
	_slider.set_value_no_signal(float(_entry(id).get("s", 1.0)) * 100.0 if id != "" else 100.0)
	_size_label.text = "%s %d%%" % [Loc.t("layout.size"), roundi(_slider.value)]
	queue_redraw()


func _entry(id: String) -> Dictionary:
	if id == "":
		return {}
	if not _layout.has(id):
		# First touch: start from where the control stands now.
		var c: Control = hud.editable_controls()[id]
		var area := _area()
		var centre := (c.get_global_rect().get_center() - area.position) / area.size
		_layout[id] = {"x": centre.x, "y": centre.y, "s": 1.0}
	return _layout[id]


## The safe area the stored positions are shares of (as Hud lays out).
func _area() -> Rect2:
	var vp := get_viewport_rect().size
	var safe := UITheme.safe_margins(get_viewport())
	var m := Hud.M
	var l := m + float(safe["left"])
	var t := m + float(safe["top"])
	return Rect2(l, t, vp.x - m - float(safe["right"]) - l, vp.y - m - float(safe["bottom"]) - t)


func _on_scale(v: float) -> void:
	if _sel == "":
		return
	_entry(_sel)["s"] = v / 100.0
	_size_label.text = "%s %d%%" % [Loc.t("layout.size"), roundi(v)]
	hud.preview_layout(_layout)
	queue_redraw()


func _gui_input(event: InputEvent) -> void:
	if event is InputEventScreenTouch:
		if event.pressed and _touch < 0:
			var id := _pick(event.position)
			_select(id)
			if id != "":
				_touch = event.index
				var c: Control = hud.editable_controls()[id]
				_grab = event.position - c.get_global_rect().get_center()
		elif not event.pressed and event.index == _touch:
			_touch = -1
		accept_event()
	elif event is InputEventScreenDrag and event.index == _touch and _sel != "":
		var area := _area()
		var centre: Vector2 = (event.position - _grab - area.position) / area.size
		var e := _entry(_sel)
		e["x"] = clampf(centre.x, 0.0, 1.0)
		e["y"] = clampf(centre.y, 0.0, 1.0)
		hud.preview_layout(_layout)
		queue_redraw()
		accept_event()
	elif event is InputEventMouseButton:
		accept_event()


func _draw() -> void:
	draw_rect(Rect2(Vector2.ZERO, size), Color(0, 0, 0, 0.28))
	var all := _controls()
	for id in all:
		var r: Rect2 = (all[id] as Control).get_global_rect()
		if id == _sel:
			draw_rect(r.grow(4.0), Color(UITheme.CAUTION, 0.18))
			draw_rect(r.grow(4.0), UITheme.CAUTION, false, 3.0)
		else:
			_dashed_rect(r.grow(3.0), Color(1, 1, 1, 0.7))


func _dashed_rect(r: Rect2, col: Color) -> void:
	var pts := [r.position, Vector2(r.end.x, r.position.y), r.end, Vector2(r.position.x, r.end.y)]
	for i in 4:
		draw_dashed_line(pts[i], pts[(i + 1) % 4], col, 2.0, 8.0)
