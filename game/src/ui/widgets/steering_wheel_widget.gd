class_name SteeringWheelWidget
extends Control
## On-screen steering wheel. Grab it anywhere and turn: the finger's angle
## around the centre drives the wheel 1:1, over as many turns as the car's
## lock allows (the Nexia has 1.5 turns each way). Letting go returns it to
## straight (setting "steering_autocenter").

signal steered(deg: float)

const WHEEL_ART := preload("res://assets/ui/steering_wheel.png") # pipeline/make_hud_art.py

var lock_deg := 540.0
var angle_deg := 0.0
var sensitivity := 1.0
var autocenter := true
var _touch := -1
var _last_ang := 0.0
## True once the player has taken the wheel; until then it only mirrors the
## car's steering (keyboard, pad, autopilot) and never drives it.
var driving := false


func _init() -> void:
	mouse_filter = Control.MOUSE_FILTER_STOP
	texture_filter = CanvasItem.TEXTURE_FILTER_LINEAR_WITH_MIPMAPS


func _gui_input(event: InputEvent) -> void:
	var c := size * 0.5
	if event is InputEventScreenTouch:
		if event.pressed and _touch < 0:
			_touch = event.index
			driving = true
			_last_ang = (event.position - c).angle()
			queue_redraw()
		elif not event.pressed and event.index == _touch:
			_touch = -1
			queue_redraw()
		accept_event()
	elif event is InputEventScreenDrag and event.index == _touch:
		var v: Vector2 = event.position - c
		if v.length() > 12.0:
			var ang := v.angle()
			var d := wrapf(ang - _last_ang, -PI, PI)
			_last_ang = ang
			angle_deg = clampf(angle_deg + rad_to_deg(d) * sensitivity, -lock_deg, lock_deg)
			steered.emit(angle_deg)
			queue_redraw()
		accept_event()
	elif event is InputEventMouseButton:
		accept_event()


## The app lost focus mid-touch: no finger-up will arrive.
func release_touch() -> void:
	_touch = -1
	queue_redraw()


func is_held() -> bool:
	return _touch >= 0


func _process(delta: float) -> void:
	if driving and _touch < 0 and autocenter and absf(angle_deg) > 0.01:
		# Let go, the wheel spins back quickly and settles softly: from full
		# lock to straight in about half a second.
		var rate := maxf(absf(angle_deg) * 6.0, 360.0)
		angle_deg = move_toward(angle_deg, 0.0, rate * delta)
		steered.emit(angle_deg)
		queue_redraw()


func set_angle(deg: float) -> void:
	angle_deg = clampf(deg, -lock_deg, lock_deg)
	queue_redraw()


func _draw() -> void:
	var c := size * 0.5
	var d := minf(size.x, size.y)
	if _touch >= 0:
		draw_arc(c, d * 0.455, 0, TAU, 72, Color(UITheme.CAUTION, 0.22), d * 0.06, true)
	# The wheel art faces straight ahead; the orange mark at the top shows how
	# far round it is.
	draw_set_transform(c, deg_to_rad(angle_deg), Vector2.ONE)
	draw_texture_rect(WHEEL_ART, Rect2(-d * 0.5, -d * 0.5, d, d), false)
	draw_set_transform(Vector2.ZERO, 0.0, Vector2.ONE)
	# Turns read-out on the hub (e.g. → 1.2).
	var turns := angle_deg / 360.0
	if absf(turns) > 0.02:
		var f := UITheme.bold()
		var txt := "%s %.1f" % ["→" if turns > 0 else "←", absf(turns)]
		var fs := int(clampf(d * 0.075, 13.0, 20.0))
		var w := f.get_string_size(txt, HORIZONTAL_ALIGNMENT_LEFT, -1, fs).x
		draw_style_box(UITheme.box(Color(0, 0, 0, 0.55), 10, 0, UITheme.LINE, 0),
				Rect2(c.x - w * 0.5 - 8, c.y - fs * 0.75, w + 16, fs * 1.5))
		draw_string(f, c + Vector2(-w * 0.5, fs * 0.36), txt, HORIZONTAL_ALIGNMENT_LEFT, -1, fs, UITheme.TEXT)
