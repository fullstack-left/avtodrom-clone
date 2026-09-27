class_name Hud
extends CanvasLayer
## Everything drawn over the road while driving, kept to the essentials so
## the road stays visible:
##   top    — exercise card (left), penalty · time (centre), camera / map /
##            pause (right), short penalty notices under the centre;
##   bottom — compact speed strip; on touch screens the steering wheel with
##            the indicators (left) and the pedals, gear lever and the key /
##            belt / handbrake switches (right).
## Any free part of the screen is a look pad: drag to turn the camera round
## the car (or the driver's head), pinch or scroll to zoom.
##
## Layout is recomputed on every resize from the visible rect and the
## display's safe area, so it works from 16:9 tablets to 21:9 phones.

signal pause_requested
signal camera_requested
signal look_drag(delta: Vector2, width: float)
signal look_end
signal look_zoom(factor: float)

const M := 14.0 # screen margin

var car: Car
var controls: DriverControls
var director: ExamDirector
var data: CourseData
var touch_mode := true
## Demonstration: the autopilot drives, the driving controls are hidden.
var demo := false

var root: Control
var look_pad: LookPad
var card: PanelContainer
var card_title: Label
var card_hint: Label
var card_turn: Label
var signal_badge: SignalBadge
var status: PanelContainer
var status_penalty: Label
var status_time: Label
var demo_badge: PanelContainer
var toasts: VBoxContainer
var center_msg: Label
var emergency_overlay: ColorRect
var prepare_panel: PanelContainer
var prep_items := {}
var ready_btn: Button
var cluster: GaugeCluster
var minimap: Minimap
var wheel: SteeringWheelWidget
var btn_steer_left: IconButton
var btn_steer_right: IconButton
var gas: Pedal
var brake_pedal: Pedal
var clutch_pedal: Pedal
var gears: GearSelector
var b_ind_left: IconButton
var b_ind_right: IconButton
var b_hazard: IconButton
var b_key: IconButton
var b_belt: IconButton
var b_handbrake: IconButton
var b_camera: IconButton
var b_map: IconButton
var b_pause: IconButton

var _center_t := 0.0
var _emergency := false
var _emergency_t := 0.0
var _map_on := false
var _steer_dir := 0
var _preview: Variant = null # the layout editor's working copy while it is open


func _init() -> void:
	layer = 5


func setup(p_car: Car, p_controls: DriverControls, p_director: ExamDirector, p_data: CourseData) -> void:
	car = p_car
	controls = p_controls
	director = p_director
	data = p_data
	touch_mode = Settings.screen_controls_on()
	_map_on = not touch_mode
	_build()
	if director:
		director.penalty_added.connect(_on_penalty)
		director.hint_changed.connect(_refresh_card)
		director.exercise_changed.connect(_refresh_card)
		director.state_changed.connect(_refresh_card)
		director.start_signal.connect(func() -> void: show_center(Loc.t("hud.start_signal"), UITheme.GO, 2.0))
		director.emergency_signal.connect(_on_emergency)
	car.engine_stalled.connect(func() -> void: show_center(Loc.t("hud.stalled"), UITheme.CAUTION, 2.0))
	Loc.language_changed.connect(_relabel)
	get_viewport().size_changed.connect(_layout)
	Settings.changed.connect(func(k: String) -> void:
		if k in ["screen_controls", "steering_mode", "left_handed", "auto_clutch", "hud_layout"]:
			touch_mode = Settings.screen_controls_on()
			if not touch_mode:
				controls.touch_steer_active = false
			_layout())
	_relabel()
	_layout()


# ------------------------------------------------------------------ construction
func _build() -> void:
	root = Control.new()
	root.name = "HudRoot"
	root.set_anchors_preset(Control.PRESET_FULL_RECT)
	root.mouse_filter = Control.MOUSE_FILTER_IGNORE
	root.theme = UITheme.get_theme()
	add_child(root)

	# Lowest layer: every touch that no control takes turns the camera.
	look_pad = LookPad.new()
	look_pad.set_anchors_preset(Control.PRESET_FULL_RECT)
	look_pad.dragged.connect(func(d: Vector2) -> void: look_drag.emit(d, root.size.x))
	look_pad.released.connect(func() -> void: look_end.emit())
	look_pad.zoomed.connect(func(f: float) -> void: look_zoom.emit(f))
	root.add_child(look_pad)

	emergency_overlay = ColorRect.new()
	emergency_overlay.color = Color(0.9, 0.1, 0.1, 0.0)
	emergency_overlay.mouse_filter = Control.MOUSE_FILTER_IGNORE
	emergency_overlay.set_anchors_preset(Control.PRESET_FULL_RECT)
	root.add_child(emergency_overlay)

	card = PanelContainer.new()
	card.mouse_filter = Control.MOUSE_FILTER_IGNORE
	card.add_theme_stylebox_override("panel", UITheme.box(Color(0.05, 0.06, 0.08, 0.72), 16, 0, UITheme.LINE, 12))
	var cv := VBoxContainer.new()
	cv.add_theme_constant_override("separation", 2)
	card.add_child(cv)
	card_title = UITheme.label("", 19, UITheme.CAUTION, true)
	card_hint = UITheme.label("", 17, UITheme.TEXT)
	card_hint.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	card_turn = UITheme.label("", 17, UITheme.INFO, true)
	cv.add_child(card_title)
	cv.add_child(card_hint)
	cv.add_child(card_turn)
	root.add_child(card)

	signal_badge = SignalBadge.new()
	signal_badge.visible = false
	root.add_child(signal_badge)

	status = PanelContainer.new()
	status.mouse_filter = Control.MOUSE_FILTER_IGNORE
	status.add_theme_stylebox_override("panel", UITheme.box(Color(0.05, 0.06, 0.08, 0.72), 24, 0, UITheme.LINE, 10))
	var sh := HBoxContainer.new()
	sh.add_theme_constant_override("separation", 16)
	sh.alignment = BoxContainer.ALIGNMENT_CENTER
	status.add_child(sh)
	status_penalty = UITheme.label("0", 21, UITheme.TEXT, true)
	status_time = UITheme.label("0:00", 21, UITheme.TEXT_DIM, true)
	sh.add_child(status_penalty)
	sh.add_child(status_time)
	root.add_child(status)

	demo_badge = PanelContainer.new()
	demo_badge.mouse_filter = Control.MOUSE_FILTER_IGNORE
	demo_badge.add_theme_stylebox_override("panel", UITheme.box(Color(0.05, 0.12, 0.22, 0.85), 14, 2, UITheme.INFO, 8))
	var db := UITheme.label("", 17, UITheme.INFO, true)
	db.name = "Text"
	demo_badge.add_child(db)
	demo_badge.visible = false
	root.add_child(demo_badge)

	toasts = VBoxContainer.new()
	toasts.mouse_filter = Control.MOUSE_FILTER_IGNORE
	toasts.add_theme_constant_override("separation", 6)
	root.add_child(toasts)

	center_msg = UITheme.label("", 42, UITheme.GO, true)
	center_msg.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	center_msg.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	center_msg.add_theme_color_override("font_outline_color", Color(0, 0, 0, 0.8))
	center_msg.add_theme_constant_override("outline_size", 9)
	center_msg.mouse_filter = Control.MOUSE_FILTER_IGNORE
	center_msg.visible = false
	root.add_child(center_msg)

	cluster = GaugeCluster.new()
	cluster.car = car
	root.add_child(cluster)

	minimap = Minimap.new()
	minimap.setup(data, car, director)
	root.add_child(minimap)

	_build_touch()
	_build_prepare()


func _build_prepare() -> void:
	prepare_panel = PanelContainer.new()
	prepare_panel.add_theme_stylebox_override("panel", UITheme.box(Color(0.05, 0.06, 0.08, 0.86), 18, 0, UITheme.LINE, 16))
	var v := VBoxContainer.new()
	v.add_theme_constant_override("separation", 6)
	prepare_panel.add_child(v)
	var title := UITheme.label("", 21, UITheme.CAUTION, true)
	title.name = "Title"
	v.add_child(title)
	for key in ["prep.belt", "prep.engine", "prep.handbrake", "prep.signal"]:
		var l := UITheme.label("", 18, UITheme.TEXT)
		prep_items[key] = l
		v.add_child(l)
	ready_btn = UITheme.primary_button("", 20, 54)
	ready_btn.pressed.connect(func() -> void:
		if director:
			director.request_start())
	v.add_child(ready_btn)
	prepare_panel.visible = false
	root.add_child(prepare_panel)


func _build_touch() -> void:
	wheel = SteeringWheelWidget.new()
	wheel.lock_deg = car.get_steering_lock()
	wheel.steered.connect(func(d: float) -> void:
		controls.touch_steer_deg = d
		controls.touch_steer_active = true)
	root.add_child(wheel)

	btn_steer_left = IconButton.new("left", 110)
	btn_steer_right = IconButton.new("right", 110)
	btn_steer_left.pressed_down.connect(func() -> void: _steer_dir = -1)
	btn_steer_left.released.connect(func() -> void: _steer_dir = 0)
	btn_steer_right.pressed_down.connect(func() -> void: _steer_dir = 1)
	btn_steer_right.released.connect(func() -> void: _steer_dir = 0)
	root.add_child(btn_steer_left)
	root.add_child(btn_steer_right)

	# A touch is a light press (the clutch goes straight to the floor, as for a
	# gear change); slide down for more, up to ease off.
	gas = Pedal.new("", UITheme.GO, 1.35, 0.12)
	gas.changed.connect(func(v: float) -> void: controls.touch_throttle = v)
	brake_pedal = Pedal.new("", UITheme.STOP, 1.1, 0.3)
	brake_pedal.changed.connect(func(v: float) -> void: controls.touch_brake = v)
	clutch_pedal = Pedal.new("", UITheme.INFO, 1.0, 1.0)
	clutch_pedal.changed.connect(func(v: float) -> void: controls.touch_clutch = v)
	root.add_child(gas)
	root.add_child(brake_pedal)
	root.add_child(clutch_pedal)

	gears = GearSelector.new()
	gears.automatic = car.is_automatic()
	gears.gear_requested.connect(func(g: int) -> void: controls.gear_requested.emit(g))
	root.add_child(gears)

	b_ind_left = IconButton.new("left", 76)
	b_ind_left.lit_color = UITheme.INDICATOR
	b_ind_left.tapped.connect(func() -> void: controls.indicator_pressed.emit(Car.Indicator.LEFT))
	b_ind_right = IconButton.new("right", 76)
	b_ind_right.lit_color = UITheme.INDICATOR
	b_ind_right.tapped.connect(func() -> void: controls.indicator_pressed.emit(Car.Indicator.RIGHT))
	b_hazard = IconButton.new("hazard", 64)
	b_hazard.lit_color = UITheme.STOP
	b_hazard.icon_color = Color(1.0, 0.45, 0.45)
	b_hazard.tapped.connect(func() -> void: controls.hazard_pressed.emit())
	b_key = IconButton.new("key", 66)
	b_key.lit_color = UITheme.CAUTION
	b_key.pressed_down.connect(func() -> void: controls.key_down())
	b_key.released.connect(func() -> void: controls.key_up())
	b_belt = IconButton.new("belt", 66)
	b_belt.lit_color = UITheme.GO
	b_belt.tapped.connect(func() -> void: controls.seatbelt_pressed.emit())
	b_handbrake = IconButton.new("handbrake", 66)
	b_handbrake.lit_color = UITheme.STOP
	b_handbrake.tapped.connect(func() -> void: controls.handbrake_pressed.emit())
	b_camera = IconButton.new("camera", 60)
	b_camera.tapped.connect(func() -> void: camera_requested.emit())
	b_map = IconButton.new("map", 60)
	b_map.tapped.connect(func() -> void:
		_map_on = not _map_on
		_layout())
	b_pause = IconButton.new("pause", 60)
	b_pause.tapped.connect(func() -> void: pause_requested.emit())
	for b in [b_ind_left, b_ind_right, b_hazard, b_key, b_belt, b_handbrake, b_camera, b_map, b_pause,
			btn_steer_left, btn_steer_right]:
		# Placed by _layout at base_size, possibly scaled by the player's layout.
		b.custom_minimum_size = Vector2.ZERO
		if b.get_parent() == null:
			root.add_child(b)
## Lets go of every on-screen control (the app lost focus mid-touch, e.g.
## the Android back button or a notification).
func release_touch() -> void:
	_steer_dir = 0
	for c in [gas, brake_pedal, clutch_pedal, wheel, gears, btn_steer_left, btn_steer_right, b_ind_left,
			b_ind_right, b_hazard, b_key, b_belt, b_handbrake, b_camera, b_map, b_pause]:
		if c and c.has_method("release_touch"):
			c.release_touch()


## Settings that move or hide touch controls changed during the drive.
func relayout() -> void:
	_layout()



# ------------------------------------------------------------------ layout
func _place(c: Control, pos: Vector2, sz: Vector2) -> void:
	c.position = pos
	c.size = sz


func _layout() -> void:
	if root == null:
		return
	var vp := get_viewport().get_visible_rect().size
	var safe := UITheme.safe_margins(get_viewport())
	var L := M + float(safe["left"])
	var R := vp.x - M - float(safe["right"])
	var T := M + float(safe["top"])
	var B := vp.y - M - float(safe["bottom"])
	var W := R - L
	var steer_mode := str(Settings.get_value("steering_mode"))
	var manual_clutch := not car.is_automatic() and not car.auto_clutch
	var left_handed := bool(Settings.get_value("left_handed"))
	var controls_on := touch_mode and not demo

	# Top row, right: pause, camera, map.
	var bx := R - 60.0
	for b in [b_pause, b_camera, b_map]:
		_place(b, Vector2(bx, T), b.base_size)
		bx -= 68.0

	# Exercise card (top-left), status (top-centre), notices under it.
	var card_w := minf(420.0, W * 0.3)
	card.position = Vector2(L, T)
	card.custom_minimum_size = Vector2(card_w, 0)
	card_hint.custom_minimum_size = Vector2(card_w - 24.0, 0)
	card.reset_size()
	signal_badge.size = signal_badge.custom_minimum_size
	status.visible = director != null
	status.reset_size()
	status.position = Vector2(L + W * 0.5 - status.size.x * 0.5, T)
	demo_badge.reset_size()
	demo_badge.position = Vector2(L + W * 0.5 - demo_badge.size.x * 0.5, T + 52)
	var toast_w := minf(460.0, W * 0.36)
	toasts.position = Vector2(L + W * 0.5 - toast_w * 0.5, T + (92 if demo else 54))
	toasts.size = Vector2(toast_w, 200)
	center_msg.position = Vector2(L + W * 0.15, vp.y * 0.26)
	center_msg.size = Vector2(W * 0.7, 60)
	prepare_panel.custom_minimum_size = Vector2(minf(380.0, W * 0.36), 0)
	prepare_panel.reset_size()
	prepare_panel.position = Vector2(L + W * 0.5 - prepare_panel.custom_minimum_size.x * 0.5, T + 60)

	# Pedals and gear lever on the right (mirrored for left-handed drivers).
	var gas_sz := Vector2(116, 226)
	var brake_sz := Vector2(136, 176)
	var clutch_sz := Vector2(122, 176)
	var gear_sz := Vector2(150, 150) if not car.is_automatic() else Vector2(84, 190)
	var gas_pos := Vector2(R - gas_sz.x, B - gas_sz.y)
	var brake_pos := Vector2(gas_pos.x - 12 - brake_sz.x, B - brake_sz.y)
	var clutch_pos := Vector2(brake_pos.x - 12 - clutch_sz.x, B - clutch_sz.y)
	var gear_pos := Vector2(brake_pos.x + brake_sz.x - gear_sz.x, brake_pos.y - 12 - gear_sz.y)
	# Cabin switches (key, belt, handbrake) in a column above the gas pedal.
	var sw := 66.0
	var col_x := gas_pos.x + gas_sz.x * 0.5 - sw * 0.5
	var col_y := gas_pos.y - 12 - sw * 3 - 16
	var wheel_d := minf(250.0, vp.y * 0.36)
	var wheel_pos := Vector2(L, B - wheel_d)
	if left_handed:
		var mirror := func(p: Vector2, s: Vector2) -> Vector2: return Vector2(L + R - p.x - s.x, p.y)
		gas_pos = mirror.call(gas_pos, gas_sz)
		brake_pos = mirror.call(brake_pos, brake_sz)
		clutch_pos = mirror.call(clutch_pos, clutch_sz)
		gear_pos = mirror.call(gear_pos, gear_sz)
		col_x = L + R - col_x - sw
		wheel_pos = Vector2(R - wheel_d, B - wheel_d)
	_place(gas, gas_pos, gas_sz)
	_place(brake_pedal, brake_pos, brake_sz)
	_place(clutch_pedal, clutch_pos, clutch_sz)
	_place(gears, gear_pos, gear_sz)
	for i in 3:
		var b: IconButton = [b_key, b_belt, b_handbrake][i]
		_place(b, Vector2(col_x, col_y + i * (sw + 8)), b.base_size)
	# Steering (left): wheel or buttons; indicators and hazards above it.
	_place(wheel, wheel_pos, Vector2(wheel_d, wheel_d))
	_place(btn_steer_left, Vector2(wheel_pos.x, B - 112), Vector2(110, 110))
	_place(btn_steer_right, Vector2(wheel_pos.x + 126, B - 112), Vector2(110, 110))
	var ind_y := wheel_pos.y - 86
	_place(b_ind_left, Vector2(wheel_pos.x, ind_y), b_ind_left.base_size)
	_place(b_hazard, Vector2(wheel_pos.x + wheel_d * 0.5 - 32, ind_y + 6), b_hazard.base_size)
	_place(b_ind_right, Vector2(wheel_pos.x + wheel_d - 76, ind_y), b_ind_right.base_size)

	wheel.visible = controls_on and steer_mode == "wheel"
	btn_steer_left.visible = controls_on and steer_mode == "buttons"
	btn_steer_right.visible = btn_steer_left.visible
	for c in [gas, brake_pedal, gears, b_key, b_belt, b_handbrake, b_ind_left, b_ind_right, b_hazard]:
		c.visible = controls_on
	clutch_pedal.visible = controls_on and manual_clutch
	b_map.visible = director != null or data != null

	# Speed strip: bottom centre, between the wheel and the pedals on phones.
	var cw := GaugeCluster.W
	var cx := L + W * 0.5
	if controls_on:
		var left_edge := wheel_pos.x + wheel_d if not left_handed else (clutch_pos.x + clutch_sz.x if manual_clutch
				else brake_pos.x + brake_sz.x)
		var right_edge := (clutch_pos.x if manual_clutch else brake_pos.x) if not left_handed else wheel_pos.x
		cx = (left_edge + right_edge) * 0.5
	_place(cluster, Vector2(cx - cw * 0.5, B - GaugeCluster.H), Vector2(cw, GaugeCluster.H))
	if controls_on:
		_apply_custom_layout(Rect2(L, T, W, B - T))

	# Map: under the top-right buttons (desktop) or under the status (phones).
	minimap.visible = _map_on and data != null
	var mm := 190.0 if touch_mode else 220.0
	if touch_mode:
		# On short (~720 px tall) layouts a full-size map would reach down over
		# the gear lever; keep clear of it.
		mm = clampf(minf(mm, gear_pos.y - 12.0 - (T + (96.0 if demo else 58.0))), 120.0, mm)
		_place(minimap, Vector2(L + W * 0.5 - mm * 0.5, T + (96 if demo else 58)), Vector2(mm, mm))
	else:
		_place(minimap, Vector2(R - mm, T + 72), Vector2(mm, mm))


## The touch controls the player can move and resize, by layout id.
func editable_controls() -> Dictionary:
	return {
		"wheel": wheel, "steer_left": btn_steer_left, "steer_right": btn_steer_right,
		"gas": gas, "brake": brake_pedal, "clutch": clutch_pedal, "gears": gears,
		"ind_left": b_ind_left, "hazard": b_hazard, "ind_right": b_ind_right,
		"key": b_key, "belt": b_belt, "handbrake": b_handbrake,
	}


## Lays the controls out with `layout` instead of the saved one (the editor's
## working copy); an empty dictionary is the standard layout.
func preview_layout(layout: Dictionary) -> void:
	_preview = layout
	_layout()


func end_layout_preview() -> void:
	_preview = null
	_layout()


## Moves and scales the controls the player has placed. Positions are stored
## as the centre's share of the safe area, so a layout carries over between
## screens of different shapes.
func _apply_custom_layout(area: Rect2) -> void:
	var layout: Dictionary = _preview if _preview != null else Settings.get_value("hud_layout")
	var vp := root.get_viewport_rect()
	for id in layout:
		var c: Control = editable_controls().get(id)
		if c == null:
			continue
		var e: Dictionary = layout[id]
		var sz := c.size * clampf(float(e.get("s", 1.0)), 0.5, 1.8)
		var centre := area.position + Vector2(float(e.get("x", 0.5)), float(e.get("y", 0.5))) * area.size
		var pos := (centre - sz * 0.5).clamp(Vector2.ZERO, vp.size - sz)
		_place(c, pos, sz)


# ------------------------------------------------------------------ updates
func _process(delta: float) -> void:
	if car == null:
		return
	if _steer_dir != 0:
		var rate := 360.0 * float(Settings.get_value("steering_sensitivity"))
		controls.touch_steer_deg = clampf(controls.touch_steer_deg + _steer_dir * rate * delta,
				-car.get_steering_lock(), car.get_steering_lock())
		controls.touch_steer_active = true
	elif btn_steer_left.visible:
		if bool(Settings.get_value("steering_autocenter")):
			var back := maxf(absf(controls.touch_steer_deg) * 6.0, 360.0)
			controls.touch_steer_deg = move_toward(controls.touch_steer_deg, 0.0, back * delta)
		controls.touch_steer_active = true
	wheel.sensitivity = float(Settings.get_value("steering_sensitivity"))
	wheel.autocenter = bool(Settings.get_value("steering_autocenter"))
	# Until the player takes the wheel it shows what the car's wheel does
	# (keyboard, pad, autopilot in the demonstrations).
	if not wheel.driving or not wheel.visible:
		wheel.set_angle(car.steering_wheel)
	b_ind_left.lit = car.left_lit()
	b_ind_right.lit = car.right_lit()
	b_hazard.lit = car.hazard
	b_key.lit = car.ignition
	b_belt.lit = car.seatbelt
	b_handbrake.lit = car.handbrake > 0.5
	gears.automatic = car.is_automatic()
	gears.set_current(car.get_selector() if car.is_automatic() else car.get_gear())
	# Status.
	if director:
		status_penalty.text = "%s %d" % [Loc.t("hud.penalty"), director.total]
		_font_color(status_penalty,
				UITheme.GO if director.total == 0 else (UITheme.CAUTION if director.total < 50 else UITheme.STOP))
		status_time.text = UITheme.clock(director.exam_time)
		_update_signal_badge()
		_update_prepare()
		_update_turn()
	# A wrapped label can report a tall minimum while its width is still being
	# laid out; shrink the card back once the layout has settled.
	if card.visible and card.size.y > card.get_combined_minimum_size().y + 0.5:
		card.reset_size()
	# Centre message fade.
	if _center_t > 0.0:
		_center_t -= delta
		center_msg.modulate.a = clampf(_center_t / 0.4, 0.0, 1.0)
		if _center_t <= 0.0:
			center_msg.visible = false
	if _emergency:
		_emergency_t += delta
		var pulse := 0.5 + 0.5 * sin(_emergency_t * TAU * 2.0)
		emergency_overlay.color.a = 0.1 + 0.16 * pulse
		center_msg.visible = true
		center_msg.text = Loc.t("hud.emergency")
		center_msg.add_theme_color_override("font_color", UITheme.STOP.lerp(Color.WHITE, pulse * 0.4))
		center_msg.modulate.a = 1.0
	# Notice life.
	for t in toasts.get_children():
		var life: float = t.get_meta("life", 3.5) - delta
		t.set_meta("life", life)
		t.modulate.a = clampf(life / 0.5, 0.0, 1.0)
		if life <= 0.0:
			t.queue_free()


## Re-setting an override, even to the same colour, makes the label and its
## containers recompute their layout, so the per-frame updates only touch it
## when the colour really changes.
func _font_color(l: Label, color: Color) -> void:
	if not l.has_theme_color_override("font_color") or l.get_theme_color("font_color") != color:
		l.add_theme_color_override("font_color", color)


func _update_prepare() -> void:
	var preparing := director.state == ExamDirector.State.PREPARE
	if prepare_panel.visible != preparing:
		prepare_panel.visible = preparing
		_refresh_card()
	if not preparing:
		return
	var checks := {
		"prep.belt": car.seatbelt,
		"prep.engine": car.is_engine_running(),
		"prep.handbrake": car.handbrake > 0.5,
		"prep.signal": car.signalling_left(),
	}
	# Without the on-screen switches, say which key does it.
	var keys := {"prep.belt": "B", "prep.engine": "I", "prep.handbrake": Loc.t("key.space"), "prep.signal": "Q"}
	for key in prep_items:
		var ok: bool = checks[key]
		var l: Label = prep_items[key]
		l.text = ("✓  " if ok else "○  ") + Loc.t(key) + ("" if touch_mode else "  [%s]" % keys[key])
		_font_color(l, UITheme.GO if ok else UITheme.TEXT)
	ready_btn.disabled = not car.is_engine_running()


func _update_turn() -> void:
	if director.state != ExamDirector.State.RUNNING:
		card_turn.visible = false
		return
	var t := director.next_turn()
	var show := not t.is_empty() and float(t["distance"]) <= 45.0
	if show:
		var arrow := "←  " if t["dir"] == "left" else "→  "
		var dir_txt := Loc.t("hud.turn_left") if t["dir"] == "left" else Loc.t("hud.turn_right")
		card_turn.text = arrow + dir_txt + "  ·  " + Loc.t("hud.in_m", [maxi(int(t["distance"]), 0)])
	if card_turn.visible != show:
		card_turn.visible = show
		card.reset_size()


## Shows the light of the junction the car is in (see SignalBadge).
func _update_signal_badge() -> void:
	var ex := director.current_exercise()
	var at_light := ex is ExIntersection and director.traffic != null \
			and director.state == ExamDirector.State.RUNNING and not (ex as ExIntersection).entered
	signal_badge.visible = at_light
	if at_light:
		# Under the exercise card, whose height follows its text.
		signal_badge.position = card.position + Vector2(0.0, card.size.y + 10.0)
		signal_badge.aspect = director.traffic.aspect_for_approach((ex as ExIntersection).approach)


func _refresh_card() -> void:
	if director == null:
		card.visible = false
		return
	# The preparation checklist has its own panel; the card stays out of the way.
	card.visible = director.state == ExamDirector.State.RUNNING
	var ex := director.current_exercise()
	if ex:
		card_title.text = ex.title()
		card_hint.text = Loc.t(ex.hint_key, ex.hint_args) if ex.hint_key != "" else ""
	else:
		var nxt := director.upcoming_exercise()
		card_title.text = (Loc.t("hud.next") + ": " + nxt.title()) if nxt else ""
		card_hint.text = ""
	card_hint.visible = Session.hints_enabled() and card_hint.text != ""
	card_title.visible = card_title.text != ""
	card.reset_size()


func _on_penalty(entry: Dictionary) -> void:
	var p := PanelContainer.new()
	var col := UITheme.CAUTION if int(entry["points"]) < 50 else UITheme.STOP
	p.add_theme_stylebox_override("panel", UITheme.box(Color(0.1, 0.05, 0.05, 0.88), 14, 2, col, 10))
	var h := HBoxContainer.new()
	h.add_theme_constant_override("separation", 12)
	p.add_child(h)
	var pts := UITheme.label("+%d" % int(entry["points"]), 21, col, true)
	var txt := UITheme.label(PenaltyTable.short_text(int(entry["no"])), 17, UITheme.TEXT)
	txt.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	txt.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	h.add_child(pts)
	h.add_child(txt)
	p.set_meta("life", 3.5)
	p.mouse_filter = Control.MOUSE_FILTER_IGNORE
	toasts.add_child(p)
	toasts.move_child(p, 0)
	while toasts.get_child_count() > 2:
		var last := toasts.get_child(toasts.get_child_count() - 1)
		toasts.remove_child(last)
		last.queue_free()


func _on_emergency(on: bool) -> void:
	_emergency = on
	_emergency_t = 0.0
	if not on:
		emergency_overlay.color.a = 0.0
		center_msg.visible = false


func set_demo(on: bool) -> void:
	demo = on
	demo_badge.visible = on
	ready_btn.visible = not on
	_relabel()
	_layout()


func show_center(text: String, color: Color, seconds: float) -> void:
	if _emergency:
		return
	center_msg.text = text
	center_msg.add_theme_color_override("font_color", color)
	center_msg.visible = true
	center_msg.modulate.a = 1.0
	_center_t = seconds


func _relabel() -> void:
	gas.caption = Loc.t("hud.gas")
	brake_pedal.caption = Loc.t("hud.brake")
	clutch_pedal.caption = Loc.t("hud.clutch")
	for p in [gas, brake_pedal, clutch_pedal]:
		p.queue_redraw()
	ready_btn.text = Loc.t("hud.ready")
	(prepare_panel.find_child("Title", true, false) as Label).text = Loc.t("hud.prepare")
	(demo_badge.get_node("Text") as Label).text = "▶  " + Loc.t("hud.demo")
	_refresh_card()
