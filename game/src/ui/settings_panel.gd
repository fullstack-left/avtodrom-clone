class_name SettingsPanel
extends Control
## Settings screen (used from the main menu and from pause). Every change is
## saved immediately through the Settings autoload.

signal closed

var _list: VBoxContainer


func _ready() -> void:
	# Already in the tree here: the offsets must be reset too, otherwise the
	# panel keeps its 0×0 rect.
	set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	theme = UITheme.get_theme()
	mouse_filter = Control.MOUSE_FILTER_STOP
	_rebuild()
	Loc.language_changed.connect(func() -> void:
		for c in get_children():
			c.queue_free()
		_rebuild.call_deferred())


func _rebuild() -> void:
	var bg := ColorRect.new()
	bg.color = Color(0.03, 0.04, 0.05, 0.9)
	bg.set_anchors_preset(Control.PRESET_FULL_RECT)
	add_child(bg)
	var margin := MarginContainer.new()
	margin.set_anchors_preset(Control.PRESET_FULL_RECT)
	var safe := UITheme.safe_margins(get_viewport())
	margin.add_theme_constant_override("margin_left", 40 + int(safe["left"]))
	margin.add_theme_constant_override("margin_right", 40 + int(safe["right"]))
	margin.add_theme_constant_override("margin_top", 24 + int(safe["top"]))
	margin.add_theme_constant_override("margin_bottom", 24 + int(safe["bottom"]))
	add_child(margin)
	var v := VBoxContainer.new()
	v.add_theme_constant_override("separation", 14)
	margin.add_child(v)
	var head := HBoxContainer.new()
	v.add_child(head)
	var back := UITheme.button("‹  " + Loc.t("menu.back"), 21, 60)
	back.custom_minimum_size.x = 170
	back.pressed.connect(func() -> void: closed.emit())
	head.add_child(back)
	var title := UITheme.label(Loc.t("set.title"), 32, UITheme.TEXT, true)
	title.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	title.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	head.add_child(title)
	var spacer := Control.new()
	spacer.custom_minimum_size = Vector2(170, 0)
	head.add_child(spacer)
	var scroll := ScrollContainer.new()
	scroll.size_flags_vertical = Control.SIZE_EXPAND_FILL
	scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	v.add_child(scroll)
	var center := HBoxContainer.new()
	center.alignment = BoxContainer.ALIGNMENT_CENTER
	center.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	scroll.add_child(center)
	_list = VBoxContainer.new()
	_list.custom_minimum_size = Vector2(minf(860.0, get_viewport().get_visible_rect().size.x - 120.0), 0)
	_list.add_theme_constant_override("separation", 10)
	center.add_child(_list)
	_build()


func _section(key: String) -> void:
	var l := UITheme.label(Loc.t(key), 22, UITheme.CAUTION, true)
	l.custom_minimum_size = Vector2(0, 44)
	l.vertical_alignment = VERTICAL_ALIGNMENT_BOTTOM
	_list.add_child(l)


func _row(label_key: String, control: Control, desc_key := "") -> void:
	var p := PanelContainer.new()
	p.add_theme_stylebox_override("panel", UITheme.box(Color(1, 1, 1, 0.045), 16, 0, UITheme.LINE, 20))
	var h := HBoxContainer.new()
	h.add_theme_constant_override("separation", 20)
	p.add_child(h)
	var lv := VBoxContainer.new()
	lv.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	lv.alignment = BoxContainer.ALIGNMENT_CENTER
	lv.add_child(UITheme.label(Loc.t(label_key), 22, UITheme.TEXT))
	if desc_key != "":
		var d := UITheme.label(Loc.t(desc_key), 16, UITheme.TEXT_DIM)
		d.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
		lv.add_child(d)
	h.add_child(lv)
	control.size_flags_horizontal = Control.SIZE_SHRINK_END
	h.add_child(control)
	_list.add_child(p)


func _segmented(key: String, options: Array) -> Control:
	var h := HBoxContainer.new()
	h.add_theme_constant_override("separation", 6)
	var group := ButtonGroup.new()
	var current: Variant = Settings.get_value(key)
	for opt in options:
		var b := UITheme.button(str(opt[1]), 20, 60)
		b.toggle_mode = true
		b.button_group = group
		b.custom_minimum_size.x = 120
		b.button_pressed = current == opt[0]
		var value: Variant = opt[0]
		b.pressed.connect(func() -> void: Settings.set_value(key, value))
		h.add_child(b)
	return h


## Like _segmented, but the shown choice is given (for "automatic" values).
func _segmented_int(key: String, options: Array, current: int) -> Control:
	var h := HBoxContainer.new()
	h.add_theme_constant_override("separation", 6)
	var group := ButtonGroup.new()
	for opt in options:
		var b := UITheme.button(str(opt[1]), 20, 60)
		b.toggle_mode = true
		b.button_group = group
		b.custom_minimum_size.x = 120
		b.button_pressed = current == int(opt[0])
		var value: int = opt[0]
		b.pressed.connect(func() -> void:
			Settings.set_value(key, value)
			# The control rows below depend on it.
			for c in _list.get_children():
				c.queue_free()
			_build.call_deferred())
		h.add_child(b)
	return h


func _toggle(key: String) -> Control:
	var c := CheckButton.new()
	c.button_pressed = bool(Settings.get_value(key))
	c.focus_mode = Control.FOCUS_NONE
	c.custom_minimum_size = Vector2(90, 50)
	c.toggled.connect(func(on: bool) -> void: Settings.set_value(key, on))
	return c


func _slider(key: String, lo: float, hi: float, step: float, fmt := "%.0f%%", mul := 100.0) -> Control:
	var h := HBoxContainer.new()
	h.add_theme_constant_override("separation", 12)
	var s := HSlider.new()
	s.min_value = lo
	s.max_value = hi
	s.step = step
	s.value = float(Settings.get_value(key))
	s.custom_minimum_size = Vector2(300, 50)
	s.focus_mode = Control.FOCUS_NONE
	var val := UITheme.label(fmt % (s.value * mul), 20, UITheme.TEXT_DIM)
	val.custom_minimum_size = Vector2(80, 0)
	s.value_changed.connect(func(v: float) -> void:
		val.text = fmt % (v * mul)
		Settings.set_value(key, int(v) if typeof(Settings.DEFAULTS[key]) == TYPE_INT else v))
	h.add_child(s)
	h.add_child(val)
	return h


func _build() -> void:
	var touch := Settings.screen_controls_on()
	_section("set.general")
	_row("set.language", _segmented("language", [["uz_latn", "O‘zbekcha"], ["uz_cyrl", "Ўзбекча"], ["ru", "Русский"]]))
	_row("menu.car", _segmented("car", [["nexia2", Loc.t("car.nexia2")], ["cobalt_at", Loc.t("car.cobalt_at")]]))

	_section("set.controls")
	if not Settings.is_mobile():
		_row("set.screen_controls", _segmented_int("screen_controls", [[0, Loc.t("set.off")], [1, Loc.t("set.on")]],
				1 if touch else 0))
	if touch:
		var modes := [["wheel", Loc.t("set.steer_wheel")], ["buttons", Loc.t("set.steer_buttons")]]
		if Settings.is_mobile():
			modes.append(["tilt", Loc.t("set.steer_tilt")])
		_row("set.steering", _segmented("steering_mode", modes))
		_row("set.sensitivity", _slider("steering_sensitivity", 0.75, 3.0, 0.05, "%.2f", 1.0))
		_row("set.autocenter", _toggle("steering_autocenter"))
	_row("set.auto_clutch", _toggle("auto_clutch"))
	if touch:
		_row("set.left_handed", _toggle("left_handed"))
	_row("set.route", _toggle("show_route"))

	_section("set.graphics")
	_row("set.quality", _segmented("quality", [[0, Loc.t("set.q0")], [1, Loc.t("set.q1")], [2, Loc.t("set.q2")]]),
			"set.quality_desc")
	_row("set.render_scale", _segmented("render_scale", [[-1.0, Loc.t("set.auto")], [0.6, "60%"], [0.75, "75%"],
			[1.0, "100%"]]))
	_row("set.fps", _segmented("fps_limit", [[30, "30"], [60, "60"]]))
	_row("set.shadows", _toggle("shadows"))
	_row("set.mirrors", _toggle("mirrors"))

	_section("set.sound")
	_row("set.vol_master", _slider("vol_master", 0.0, 1.0, 0.05))
	_row("set.vol_engine", _slider("vol_engine", 0.0, 1.0, 0.05))

	if not Settings.is_mobile():
		_section("set.keys")
		for pair in [["W A S D / ↑ ← ↓ →", "key.drive"], ["Shift / C", "key.clutch"], ["1–5, R, N", "key.gears"],
				["P R N G", "key.auto"], ["Q / E", "key.indicators"], ["H", "key.hazard"], ["B", "key.belt"],
				["I", "key.key"], ["Space", "key.handbrake"], ["V", "key.camera"], ["Esc", "key.pause"],
				[Loc.t("key.mouse"), "key.look"]]:
			var h := HBoxContainer.new()
			h.add_theme_constant_override("separation", 16)
			var k := UITheme.label(pair[0], 19, UITheme.CAUTION, true)
			k.custom_minimum_size = Vector2(230, 0)
			h.add_child(k)
			var a := UITheme.label(Loc.t(pair[1]), 19, UITheme.TEXT)
			a.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
			a.size_flags_horizontal = Control.SIZE_EXPAND_FILL
			h.add_child(a)
			_list.add_child(h)

	var reset := UITheme.button(Loc.t("set.reset"), 20, 60)
	reset.pressed.connect(func() -> void:
		Settings.reset_to_defaults()
		for c in _list.get_children():
			c.queue_free()
		_build.call_deferred())
	_list.add_child(reset)
