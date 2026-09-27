class_name ResultsPanel
extends CanvasLayer
## The exam protocol: pass / fail, total penalty against the 100-point
## limit, each error with its official wording and time, and which
## exercises were performed.

signal retry
signal menu

var _box: VBoxContainer


func _init() -> void:
	layer = 25
	process_mode = Node.PROCESS_MODE_ALWAYS
	visible = false


func show_result(r: Dictionary) -> void:
	for c in get_children():
		c.queue_free()
	visible = true
	var dim := ColorRect.new()
	dim.color = Color(0.02, 0.03, 0.04, 0.78)
	dim.set_anchors_preset(Control.PRESET_FULL_RECT)
	add_child(dim)
	var margin := MarginContainer.new()
	margin.set_anchors_preset(Control.PRESET_FULL_RECT)
	for side in ["left", "right", "top", "bottom"]:
		margin.add_theme_constant_override("margin_" + side, 24)
	margin.theme = UITheme.get_theme()
	add_child(margin)
	var center := CenterContainer.new()
	margin.add_child(center)
	var panel := PanelContainer.new()
	panel.custom_minimum_size = Vector2(640, 0)
	center.add_child(panel)
	var outer := VBoxContainer.new()
	outer.add_theme_constant_override("separation", 10)
	panel.add_child(outer)

	var practice: bool = r.get("practice", false)
	var passed: bool = r.get("passed", false)
	var total := int(r.get("penalty", 0))
	var head: String
	var col: Color
	if Session.demo:
		head = Loc.t("res.demo")
		col = UITheme.INFO
	elif practice:
		head = Loc.t("res.practice")
		col = UITheme.GO if total == 0 else UITheme.CAUTION
	else:
		head = Loc.t("res.passed") if passed else Loc.t("res.failed")
		col = UITheme.GO if passed else UITheme.STOP
	var title := UITheme.label(head, 36, col, true)
	title.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	outer.add_child(title)
	var tot := UITheme.label("%s   ·   %s" % [Loc.t("res.total", [total]),
			Loc.t("res.time", [UITheme.clock(float(r.get("time", 0)))])], 22, UITheme.TEXT, true)
	tot.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	outer.add_child(tot)
	if not practice and not Session.demo:
		var rule := UITheme.label(Loc.t("res.rule"), 16, UITheme.TEXT_DIM)
		rule.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
		outer.add_child(rule)

	var scroll := ScrollContainer.new()
	scroll.custom_minimum_size = Vector2(0, 250)
	scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	outer.add_child(scroll)
	_box = VBoxContainer.new()
	_box.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_box.add_theme_constant_override("separation", 6)
	scroll.add_child(_box)
	var entries: Array = r.get("entries", [])
	if entries.is_empty():
		_box.add_child(UITheme.label(Loc.t("res.no_errors"), 22, UITheme.GO, true))
	else:
		_box.add_child(UITheme.label(Loc.t("res.errors"), 18, UITheme.TEXT_DIM, true))
		for e in entries:
			_box.add_child(_entry_row(e))
	if not practice:
		# Exercises not performed (the exam lists only what went wrong).
		var missed := []
		for ex in r.get("exercises", []):
			if not ex.get("performed", false):
				missed.append("✗  " + Loc.pick(ex["name"]))
		if not missed.is_empty():
			_box.add_child(UITheme.label(Loc.t("res.exercises"), 18, UITheme.TEXT_DIM, true))
			var l := UITheme.label("\n".join(missed), 18, UITheme.STOP)
			_box.add_child(l)

	var buttons := HBoxContainer.new()
	buttons.add_theme_constant_override("separation", 12)
	outer.add_child(buttons)
	var b_retry := UITheme.primary_button(Loc.t("res.retry_practice") if practice or Session.demo
			else Loc.t("res.retry"), 22, 64)
	b_retry.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	b_retry.pressed.connect(func() -> void: retry.emit())
	var b_menu := UITheme.button(Loc.t("res.menu"), 22, 64)
	b_menu.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	b_menu.pressed.connect(func() -> void: menu.emit())
	buttons.add_child(b_retry)
	buttons.add_child(b_menu)


func _entry_row(e: Dictionary) -> Control:
	var p := PanelContainer.new()
	var pts := int(e["points"])
	var col := UITheme.CAUTION if pts < 20 else (UITheme.STOP if pts >= 50 else Color(1.0, 0.55, 0.2))
	p.add_theme_stylebox_override("panel", UITheme.box(Color(1, 1, 1, 0.04), 10, 0, UITheme.LINE, 12))
	var h := HBoxContainer.new()
	h.add_theme_constant_override("separation", 12)
	p.add_child(h)
	var badge := UITheme.label("+%d" % pts, 20, col, true)
	badge.custom_minimum_size = Vector2(56, 0)
	h.add_child(badge)
	var txt := UITheme.label(PenaltyTable.short_text(int(e["no"])), 18, UITheme.TEXT)
	txt.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	txt.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	h.add_child(txt)
	var t := UITheme.label("№%d · %s" % [int(e["no"]), UITheme.clock(float(e.get("time", 0)))], 16, UITheme.TEXT_FAINT)
	h.add_child(t)
	return p
