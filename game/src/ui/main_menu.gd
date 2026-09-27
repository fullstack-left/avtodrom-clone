extends Node
## Main menu: the chosen car on the avtodrom, the camera slowly circling it
## (a "garage" view), with the menu over the left half of the screen.
##   Home      — three modes (exam, exercises, free drive), the car, and
##               results / penalties / settings;
##   Exam      — what the exam is in four lines, then start (or watch it);
##   Exercises — every exercise on its own, each with a demonstration;
##   Results, Penalties, Settings.

var _world: Node3D
var _cam: Camera3D
var _orbit := 0.0
var _ui: Control
var _content: Control
var _stats: Label
var _menu_car: Car
var _car_name: Label
var _car_type: Label
var _car_focus := Vector3.ZERO
var _on_home := true
var _settings_panel: SettingsPanel


func _ready() -> void:
	_build_world()
	_build_ui()
	Loc.language_changed.connect(_rebuild_ui)
	Session.history_changed.connect(_update_stats)
	match DebugShots.menu_page:
		"exam": _show_exam()
		"practice": _show_practice()
		"rules": _show_rules()
		"settings": _show_settings()
		"history": _show_history()


func _build_world() -> void:
	_world = Node3D.new()
	add_child(_world)
	var q := mini(int(Settings.get_value("quality")), 1)
	EnvironmentSetup.create(_world, q)
	var data := CourseData.get_default()
	var course := CourseBuilder.load_or_build(data, q)
	_world.add_child(course)
	var car := Car.new()
	_world.add_child(car)
	car.configure(Session.car_id())
	_menu_car = car
	var sp: Dictionary = data.exercise("start")["spawn"]
	var xf := course.spawn_transform(CourseData.v2(sp["pos"]), float(sp["yaw"]))
	car.teleport(xf, false)
	car.freeze = true
	_car_focus = xf.origin + Vector3.UP * 0.75
	_cam = Camera3D.new()
	_cam.fov = 42.0
	_cam.far = 1200.0
	_world.add_child(_cam)
	_cam.current = true
	EnvironmentSetup.apply_viewport(get_viewport(), q)
	# The menu background is a slow orbit: 30 fps is plenty and keeps the phone
	# cool (the drive scene sets its own limit from the settings).
	Engine.max_fps = 30


func _process(delta: float) -> void:
	_orbit += delta * 0.12
	var r := 8.2
	_cam.global_position = _car_focus + Vector3(cos(_orbit) * r, 1.55, sin(_orbit) * r)
	_cam.look_at(_car_focus, Vector3.UP)
	# The car sits in the right half of the screen, clear of the menu.
	_cam.h_offset = -r * tan(deg_to_rad(_cam.fov * 0.5)) * _aspect() * 0.42


func _vw() -> float:
	return get_viewport().get_visible_rect().size.x


func _aspect() -> float:
	var s := get_viewport().get_visible_rect().size
	return s.x / maxf(s.y, 1.0)


# ------------------------------------------------------------------ UI
func _build_ui() -> void:
	var layer := CanvasLayer.new()
	layer.layer = 10
	add_child(layer)
	_ui = Control.new()
	_ui.set_anchors_preset(Control.PRESET_FULL_RECT)
	_ui.theme = UITheme.get_theme()
	layer.add_child(_ui)
	_rebuild_ui()


func _rebuild_ui() -> void:
	for c in _ui.get_children():
		c.queue_free()
	# Dark on the menu side, clear over the car.
	var grad := Gradient.new()
	grad.set_color(0, Color(0.02, 0.03, 0.05, 0.82))
	grad.set_color(1, Color(0.02, 0.03, 0.05, 0.0))
	grad.add_point(0.45, Color(0.02, 0.03, 0.05, 0.45))
	var gt := GradientTexture2D.new()
	gt.gradient = grad
	gt.width = 256
	gt.height = 4
	var shade := TextureRect.new()
	shade.texture = gt
	shade.stretch_mode = TextureRect.STRETCH_SCALE
	shade.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	shade.set_anchors_preset(Control.PRESET_FULL_RECT)
	shade.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_ui.add_child(shade)
	var safe := UITheme.safe_margins(_ui.get_viewport())
	var margin := MarginContainer.new()
	margin.set_anchors_preset(Control.PRESET_FULL_RECT)
	margin.add_theme_constant_override("margin_left", 44 + int(safe["left"]))
	margin.add_theme_constant_override("margin_right", 44 + int(safe["right"]))
	margin.add_theme_constant_override("margin_top", 28 + int(safe["top"]))
	margin.add_theme_constant_override("margin_bottom", 28 + int(safe["bottom"]))
	_ui.add_child(margin)
	_content = margin
	_show_home()


func _clear_content() -> void:
	for c in _content.get_children():
		c.queue_free()


func _show_home() -> void:
	_clear_content()
	_on_home = true
	var h := HBoxContainer.new()
	h.add_theme_constant_override("separation", 24)
	_content.add_child(h)

	var left := VBoxContainer.new()
	left.custom_minimum_size = Vector2(minf(520.0, _vw() * 0.42), 0)
	left.add_theme_constant_override("separation", 14)
	h.add_child(left)
	left.add_child(_logo())
	var gap := Control.new()
	gap.size_flags_vertical = Control.SIZE_EXPAND_FILL
	left.add_child(gap)
	var stats := ""
	if not Session.history.is_empty():
		stats = Loc.t("menu.stats", [Session.history.size(), Session.pass_count()])
	var exam := MenuCard.new(Loc.t("menu.exam"), "flag", UITheme.GO, true, stats)
	exam.custom_minimum_size.y = 104
	exam.pressed.connect(_show_exam)
	left.add_child(exam)
	var practice := MenuCard.new(Loc.t("menu.practice"), "cone", Color(1.0, 0.6, 0.2))
	practice.pressed.connect(_show_practice)
	left.add_child(practice)
	var free := MenuCard.new(Loc.t("menu.free"), "wheel", UITheme.INFO)
	free.pressed.connect(func() -> void: _start(Session.Mode.FREE))
	left.add_child(free)
	var gap2 := Control.new()
	gap2.custom_minimum_size = Vector2(0, 4)
	left.add_child(gap2)
	var row := HBoxContainer.new()
	row.add_theme_constant_override("separation", 6)
	left.add_child(row)
	var items := [["menu.history", "list", _show_history], ["menu.rules", "warn", _show_rules],
			["menu.settings", "gear", _show_settings]]
	if not OS.has_feature("mobile"):
		items.append(["menu.quit", "exit", func() -> void: get_tree().quit()])
	for it in items:
		var b := MenuCard.RoundAction.new(Loc.t(it[0]), it[1])
		b.size_flags_horizontal = Control.SIZE_EXPAND_FILL
		b.pressed.connect(it[2])
		row.add_child(b)

	# Right: the car (3D, behind) and its switch at the bottom.
	var right := VBoxContainer.new()
	right.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	h.add_child(right)
	var fill := Control.new()
	fill.size_flags_vertical = Control.SIZE_EXPAND_FILL
	right.add_child(fill)
	var car_row := HBoxContainer.new()
	car_row.alignment = BoxContainer.ALIGNMENT_CENTER
	right.add_child(car_row)
	car_row.add_child(_car_carousel())
	_stats = null


func _logo() -> Control:
	var box := HBoxContainer.new()
	box.add_theme_constant_override("separation", 14)
	var badge := Control.new()
	badge.custom_minimum_size = Vector2(64, 64)
	badge.draw.connect(func() -> void:
		var sb := StyleBoxFlat.new()
		sb.set_corner_radius_all(18)
		sb.bg_color = UITheme.GO
		sb.shadow_color = Color(0, 0, 0, 0.35)
		sb.shadow_size = 8
		sb.anti_aliasing = true
		badge.draw_style_box(sb, Rect2(Vector2.ZERO, badge.size))
		Icons.draw(badge, "wheel", badge.size * 0.5, 22.0, Color.WHITE))
	box.add_child(badge)
	var v := VBoxContainer.new()
	v.add_theme_constant_override("separation", -4)
	v.alignment = BoxContainer.ALIGNMENT_CENTER
	var t := UITheme.label(Loc.t("app.title").to_upper(), 40, UITheme.TEXT, true)
	t.add_theme_color_override("font_outline_color", Color(0, 0, 0, 0.45))
	t.add_theme_constant_override("outline_size", 6)
	v.add_child(t)
	var tag := UITheme.label(Loc.t("app.tagline"), 17, Color(1, 1, 1, 0.8))
	tag.add_theme_color_override("font_outline_color", Color(0, 0, 0, 0.45))
	tag.add_theme_constant_override("outline_size", 4)
	v.add_child(tag)
	box.add_child(v)
	return box


## ‹ Nexia 2 · mexanika › — switches the car (and the model on screen).
func _car_carousel() -> Control:
	var p := PanelContainer.new()
	p.add_theme_stylebox_override("panel", UITheme.box(Color(0.08, 0.1, 0.13, 0.86), 26, 1, UITheme.LINE, 10))
	var h := HBoxContainer.new()
	h.add_theme_constant_override("separation", 10)
	p.add_child(h)
	var prev := _chevron("chev_left")
	h.add_child(prev)
	var v := VBoxContainer.new()
	v.custom_minimum_size = Vector2(190, 0)
	v.alignment = BoxContainer.ALIGNMENT_CENTER
	v.add_theme_constant_override("separation", -2)
	_car_name = UITheme.label("", 26, UITheme.TEXT, true)
	_car_name.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_car_type = UITheme.label("", 16, UITheme.TEXT_DIM)
	_car_type.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	v.add_child(_car_name)
	v.add_child(_car_type)
	h.add_child(v)
	var next := _chevron("chev_right")
	h.add_child(next)
	prev.pressed.connect(func() -> void: _switch_car())
	next.pressed.connect(func() -> void: _switch_car())
	_show_car_name()
	return p


func _chevron(icon: String) -> Button:
	var b := Button.new()
	b.flat = true
	b.focus_mode = Control.FOCUS_NONE
	b.custom_minimum_size = Vector2(56, 56)
	b.draw.connect(func() -> void:
		var hov := b.is_hovered()
		b.draw_circle(b.size * 0.5, 24.0, Color(1, 1, 1, 0.14 if hov else 0.07))
		Icons.draw(b, icon, b.size * 0.5, 11.0, UITheme.TEXT))
	b.mouse_entered.connect(b.queue_redraw)
	b.mouse_exited.connect(b.queue_redraw)
	return b


func _switch_car() -> void:
	var cid := "cobalt_at" if str(Settings.get_value("car")) == "nexia2" else "nexia2"
	Settings.set_value("car", cid)
	if _menu_car:
		_menu_car.configure(cid)
	_show_car_name()


func _show_car_name() -> void:
	var cid := str(Settings.get_value("car"))
	if _car_name:
		_car_name.text = Loc.t("car." + cid)
		_car_type.text = Loc.t("car." + cid + "_desc")


func _update_stats() -> void:
	if _stats == null or not is_instance_valid(_stats):
		return
	if Session.history.is_empty():
		_stats.text = Loc.t("menu.no_history")
	else:
		_stats.text = Loc.t("menu.stats", [Session.history.size(), Session.pass_count()])


func _start(mode: Session.Mode, exercise := "", demo := false) -> void:
	_clear_content()
	var c := CenterContainer.new()
	_content.add_child(c)
	c.add_child(UITheme.label(Loc.t("menu.loading"), 34, UITheme.TEXT, true))
	await get_tree().process_frame
	await get_tree().process_frame
	Session.start(mode, exercise, demo)


# ------------------------------------------------------------------ sub-screens
func _screen(title_key: String) -> VBoxContainer:
	_clear_content()
	_on_home = false
	var v := VBoxContainer.new()
	v.add_theme_constant_override("separation", 14)
	_content.add_child(v)
	var head := HBoxContainer.new()
	v.add_child(head)
	head.add_theme_constant_override("separation", 14)
	var back := _chevron("back")
	back.custom_minimum_size = Vector2(64, 64)
	back.pressed.connect(_show_home)
	head.add_child(back)
	var t := UITheme.label(Loc.t(title_key), 34, UITheme.TEXT, true)
	t.add_theme_color_override("font_outline_color", Color(0, 0, 0, 0.45))
	t.add_theme_constant_override("outline_size", 6)
	t.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	head.add_child(t)
	return v


func _scroll_list(parent: Control) -> VBoxContainer:
	var bg := PanelContainer.new()
	bg.size_flags_vertical = Control.SIZE_EXPAND_FILL
	parent.add_child(bg)
	var scroll := ScrollContainer.new()
	scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	bg.add_child(scroll)
	var list := VBoxContainer.new()
	list.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	list.add_theme_constant_override("separation", 8)
	scroll.add_child(list)
	return list


func _show_exam() -> void:
	var v := _screen("exam.title")
	var split := HBoxContainer.new()
	split.size_flags_vertical = Control.SIZE_EXPAND_FILL
	v.add_child(split)
	var body := VBoxContainer.new()
	body.custom_minimum_size = Vector2(minf(600.0, _vw() * 0.45), 0)
	body.add_theme_constant_override("separation", 12)
	split.add_child(body)
	var rest := Control.new()
	rest.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	rest.mouse_filter = Control.MOUSE_FILTER_IGNORE
	split.add_child(rest)
	var panel := PanelContainer.new()
	panel.add_theme_stylebox_override("panel", UITheme.box(Color(0.08, 0.1, 0.13, 0.88), 22, 1, UITheme.LINE, 22))
	body.add_child(panel)
	var box := VBoxContainer.new()
	box.add_theme_constant_override("separation", 12)
	panel.add_child(box)
	var minutes := int(Settings.get_value("exam_time_limit_min"))
	var rows := [["flag", Loc.t("exam.rule_route")], ["warn", Loc.t("exam.rule_pass")],
			["list", Loc.t("exam.rule_time", [minutes])], ["cone", Loc.t("exam.rule_hints")]]
	for r in rows:
		var h := HBoxContainer.new()
		h.add_theme_constant_override("separation", 14)
		var ic := Control.new()
		ic.custom_minimum_size = Vector2(30, 30)
		var icon_name: String = r[0]
		ic.draw.connect(func() -> void: Icons.draw(ic, icon_name, ic.size * 0.5, 11.0, UITheme.CAUTION))
		h.add_child(ic)
		var l := UITheme.label(r[1], 21, UITheme.TEXT)
		l.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
		l.size_flags_horizontal = Control.SIZE_EXPAND_FILL
		h.add_child(l)
		box.add_child(h)
	var fill := Control.new()
	fill.size_flags_vertical = Control.SIZE_EXPAND_FILL
	body.add_child(fill)
	var row := HBoxContainer.new()
	row.add_theme_constant_override("separation", 12)
	body.add_child(row)
	var go := MenuCard.new(Loc.t("menu.start"), "flag", UITheme.GO, true)
	go.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	go.pressed.connect(func() -> void: _start(Session.Mode.EXAM))
	row.add_child(go)
	var demo := MenuCard.RoundAction.new(Loc.t("menu.demo"), "play")
	demo.pressed.connect(func() -> void: _start(Session.Mode.EXAM, "", true))
	row.add_child(demo)


func _show_practice() -> void:
	var v := _screen("menu.practice")
	var scroll := ScrollContainer.new()
	scroll.size_flags_vertical = Control.SIZE_EXPAND_FILL
	scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	v.add_child(scroll)
	var grid := GridContainer.new()
	grid.columns = 3 if _vw() >= 1500.0 else 2
	grid.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	grid.add_theme_constant_override("h_separation", 14)
	grid.add_theme_constant_override("v_separation", 12)
	scroll.add_child(grid)
	var data := CourseData.get_default()
	var n := 0
	var seen := {}
	var accents := [UITheme.GO, Color(1.0, 0.6, 0.2), UITheme.INFO, UITheme.CAUTION]
	for e in data.exercises:
		var id := str(e["id"])
		var key := "intersection" if id.begins_with("intersection") else id
		if seen.has(key):
			continue
		seen[key] = true
		n += 1
		var cell := HBoxContainer.new()
		cell.size_flags_horizontal = Control.SIZE_EXPAND_FILL
		cell.add_theme_constant_override("separation", 4)
		var b := MenuCard.new(Loc.pick(e["name"]), str(n), accents[(n - 1) % accents.size()])
		b.custom_minimum_size = Vector2(0, 84)
		b.size_flags_horizontal = Control.SIZE_EXPAND_FILL
		var ex_id := id
		b.pressed.connect(func() -> void: _start(Session.Mode.PRACTICE, ex_id))
		cell.add_child(b)
		# Watch the instructor (autopilot) do it first.
		var demo := MenuCard.RoundAction.new(Loc.t("menu.demo"), "play")
		demo.pressed.connect(func() -> void: _start(Session.Mode.PRACTICE, ex_id, true))
		cell.add_child(demo)
		grid.add_child(cell)


func _show_rules() -> void:
	var v := _screen("menu.rules")
	var list := _scroll_list(v)
	var colors := {"kichik": UITheme.CAUTION, "orta": Color(1.0, 0.55, 0.2), "qopol": UITheme.STOP}
	for g in PenaltyTable.groups():
		var gt := UITheme.label(Loc.pick(g["title"]), 21, colors.get(g["level"], UITheme.TEXT), true)
		list.add_child(gt)
		for it in g["items"]:
			list.add_child(_rule_row(it, colors.get(g["level"], UITheme.TEXT)))
	var note := UITheme.label(Loc.t("res.rule"), 17, UITheme.TEXT_DIM)
	list.add_child(note)


## One penalty: number, short name, points; a tap shows the official wording.
func _rule_row(it: Dictionary, col: Color) -> Control:
	var no := int(it["no"])
	var h := HBoxContainer.new()
	h.add_theme_constant_override("separation", 12)
	var num := UITheme.label(str(no), 18, UITheme.TEXT_FAINT, true)
	num.custom_minimum_size = Vector2(34, 0)
	var txt := UITheme.label(PenaltyTable.short_text(no), 19, UITheme.TEXT)
	txt.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	txt.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	var pts := "%d %s" % [int(it["points"]), Loc.t("hud.points")]
	if it.has("note"):
		pts += " *"
	var pl := UITheme.label(pts, 19, col, true)
	pl.horizontal_alignment = HORIZONTAL_ALIGNMENT_RIGHT
	pl.custom_minimum_size = Vector2(96, 0)
	for c in [num, txt, pl]:
		h.add_child(c)
	var full := Loc.pick(it["text"])
	if it.has("note"):
		full += " (" + Loc.pick(it["note"]) + ")"
	var detail := UITheme.label(full, 17, UITheme.TEXT_DIM)
	detail.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	return _expandable(h, detail)


## A list row that shows `detail` under `summary` when tapped. Drags pass
## through to the scrolling list.
func _expandable(summary: Control, detail: Control) -> PanelContainer:
	var p := PanelContainer.new()
	p.add_theme_stylebox_override("panel", UITheme.box(Color(1, 1, 1, 0.045), 12, 0, UITheme.LINE, 14))
	p.mouse_filter = Control.MOUSE_FILTER_PASS
	var box := VBoxContainer.new()
	box.add_theme_constant_override("separation", 6)
	box.mouse_filter = Control.MOUSE_FILTER_PASS
	summary.mouse_filter = Control.MOUSE_FILTER_PASS
	box.add_child(summary)
	detail.visible = false
	box.add_child(detail)
	p.add_child(box)
	var down := [Vector2.INF]
	p.gui_input.connect(func(e: InputEvent) -> void:
		if e is InputEventScreenTouch:
			if e.pressed:
				down[0] = e.position
			elif down[0] != Vector2.INF:
				if e.position.distance_to(down[0]) < 14.0:
					detail.visible = not detail.visible
				down[0] = Vector2.INF)
	return p


func _show_history() -> void:
	var v := _screen("menu.history")
	var list := _scroll_list(v)
	if Session.history.is_empty():
		list.add_child(UITheme.label(Loc.t("menu.no_history"), 21, UITheme.TEXT_DIM))
		return
	for r in Session.history:
		list.add_child(_history_row(r))


## One exam attempt; a tap lists its errors.
func _history_row(r: Dictionary) -> Control:
	var passed: bool = r.get("passed", false)
	var h := HBoxContainer.new()
	h.add_theme_constant_override("separation", 16)
	var badge := UITheme.label("✓" if passed else "✗", 24, UITheme.GO if passed else UITheme.STOP, true)
	var date := str(r.get("date", "")).replace("T", " ").substr(0, 16)
	var info := UITheme.label(date, 19, UITheme.TEXT)
	info.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	var car_id := str(r.get("car", ""))
	var car_l := UITheme.label(Loc.t("car." + car_id) if car_id != "" else "", 17, UITheme.TEXT_DIM)
	var pts := UITheme.label(Loc.t("res.total", [int(r.get("penalty", 0))]), 19,
			UITheme.GO if passed else UITheme.STOP, true)
	var tm := UITheme.label(UITheme.clock(float(r.get("time", 0))), 17, UITheme.TEXT_DIM)
	for c in [badge, info, car_l, pts, tm]:
		h.add_child(c)
	var errs := []
	for e in r.get("entries", []):
		errs.append("+%d   %s" % [int(e["points"]), PenaltyTable.short_text(int(e["no"]))])
	var detail := UITheme.label("\n".join(errs) if not errs.is_empty() else Loc.t("res.no_errors"), 17,
			UITheme.TEXT_DIM)
	return _expandable(h, detail)


func _show_settings() -> void:
	_clear_content()
	_on_home = false
	var s := SettingsPanel.new()
	s.closed.connect(func() -> void:
		s.queue_free()
		_settings_panel = null
		_show_home())
	_ui.add_child(s)
	_settings_panel = s


## Android "back": a sub-page goes back to the home page; on the home page the
## app closes, as Android users expect (the project turns off Godot's own
## quit-on-back so a drive in progress is never closed by it).
func _notification(what: int) -> void:
	if what != NOTIFICATION_WM_GO_BACK_REQUEST or _content == null:
		return
	if _settings_panel:
		_settings_panel.closed.emit()
	elif not _on_home:
		_show_home()
	else:
		get_tree().quit()
