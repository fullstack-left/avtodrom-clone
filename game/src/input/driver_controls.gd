class_name DriverControls
extends Node
## Merges every input device into one set of driver controls.
##
## Pedals and steering are continuous values; cabin switches are signals.
##   keyboard  W/S or arrows (pedals ramp like a foot, so a tap is a light
##             press), A/D steer, C or Left-Shift clutch, Space handbrake,
##             Q/E indicators, H hazards, B seat belt, I ignition (hold for
##             start), 1-5/R/N gears (P/R/N/G on the automatic), L lights,
##             V camera, Esc pause;
##   gamepad   triggers pedals, left stick steers, LB clutch, D-pad gears;
##   touch     on-screen wheel, pedals and switches (src/ui/touch_*.gd);
##   tilt      the accelerometer steers when that mode is chosen.

signal indicator_pressed(dir: int) # Car.Indicator.LEFT / RIGHT
signal hazard_pressed
signal seatbelt_pressed
signal ignition_pressed
signal starter_changed(held: bool)
signal gear_requested(gear: int) # manual: -1..5; automatic: AutoSelector 0..3
signal gear_step(delta: int)
signal handbrake_pressed
signal headlights_pressed
signal camera_pressed
signal pause_pressed

const THROTTLE_UP := 1.6 # pedal travel per second when "pressing" with a key
const THROTTLE_DOWN := 3.5
const BRAKE_UP := 2.2
const BRAKE_DOWN := 4.0
const CLUTCH_DOWN := 4.0 # pressing the clutch is quick...
const CLUTCH_UP := 1.4 # ...letting it out should not be
const STEER_RATE := 600.0 # deg/s at the steering wheel
const CENTER_RATE := 420.0
const TILT_DEAD_ZONE := 1.5 # degrees of phone roll
const TILT_SMOOTHING := 14.0 # 1/s, ~2 Hz corner
const TILT_GAIN := 9.0 # wheel degrees per degree of phone roll at sensitivity 1

var steering_lock := 540.0
var automatic := false
## Demonstration: only the camera and pause keys reach the game.
var view_only := false
## Set by the drive scene every tick (m/s): steering feel depends on it.
var car_speed := 0.0

# Outputs (read by the drive scene every physics tick).
var throttle := 0.0
var brake := 0.0
var clutch := 0.0
var steer_deg := 0.0

# Touch widgets write here; *_active means a finger is on the control.
var touch_throttle := 0.0
var touch_brake := 0.0
var touch_clutch := 0.0
var touch_steer_deg := 0.0
var touch_steer_active := false
var tilt_enabled := false

var _kb_throttle := 0.0
var _kb_brake := 0.0
var _kb_clutch := 0.0
var _kb_steer := 0.0
var _ignition_key_t := -1.0
var _tilt_deg := 0.0
## Gravity's direction in the screen plane with the phone held level ("wheel
## straight"), snapped to a screen axis; zero until the first reading.
var _tilt_ref := Vector2.ZERO
var _starter_held := false


func _ready() -> void:
	process_mode = Node.PROCESS_MODE_PAUSABLE
	tilt_enabled = str(Settings.get_value("steering_mode")) == "tilt"
	Settings.changed.connect(func(k: String) -> void:
		if k == "steering_mode":
			tilt_enabled = str(Settings.get_value("steering_mode")) == "tilt")


func _physics_process(delta: float) -> void:
	var up := Input.is_key_pressed(KEY_W) or Input.is_key_pressed(KEY_UP)
	var down := Input.is_key_pressed(KEY_S) or Input.is_key_pressed(KEY_DOWN)
	var left := Input.is_key_pressed(KEY_A) or Input.is_key_pressed(KEY_LEFT)
	var right := Input.is_key_pressed(KEY_D) or Input.is_key_pressed(KEY_RIGHT)
	var clutch_key := Input.is_key_pressed(KEY_C) or Input.is_key_pressed(KEY_SHIFT)
	_kb_throttle = move_toward(_kb_throttle, 1.0 if up else 0.0, (THROTTLE_UP if up else THROTTLE_DOWN) * delta)
	_kb_brake = move_toward(_kb_brake, 1.0 if down else 0.0, (BRAKE_UP if down else BRAKE_DOWN) * delta)
	_kb_clutch = move_toward(_kb_clutch, 1.0 if clutch_key else 0.0, (CLUTCH_DOWN if clutch_key else CLUTCH_UP) * delta)

	var sens := float(Settings.get_value("steering_sensitivity"))
	var v := absf(car_speed)
	if left != right:
		var target := steering_lock if right else -steering_lock
		# Full lock in about 0.9 s at parking speed, a little calmer when
		# driving on; turning back through the centre is twice as quick.
		var rate := STEER_RATE * clampf(sens / 1.5, 0.6, 1.6) / (1.0 + v / 14.0)
		if signf(target) != signf(_kb_steer) and absf(_kb_steer) > 1.0:
			rate *= 2.0
		_kb_steer = move_toward(_kb_steer, target, rate * delta)
	else:
		# Keys released: the wheel comes back to the centre (quicker when
		# rolling, like the caster does), so the car drives straight again.
		_kb_steer = move_toward(_kb_steer, 0.0, (CENTER_RATE + v * 60.0) * delta)

	# Gamepad (first connected pad).
	var pad_throttle := 0.0
	var pad_brake := 0.0
	var pad_clutch := 0.0
	var pad_steer := 0.0
	var pads := Input.get_connected_joypads()
	if not pads.is_empty():
		var id: int = pads[0]
		pad_throttle = Input.get_joy_axis(id, JOY_AXIS_TRIGGER_RIGHT)
		pad_brake = Input.get_joy_axis(id, JOY_AXIS_TRIGGER_LEFT)
		pad_clutch = 1.0 if Input.is_joy_button_pressed(id, JOY_BUTTON_LEFT_SHOULDER) else 0.0
		var x := Input.get_joy_axis(id, JOY_AXIS_LEFT_X)
		if absf(x) > 0.08:
			x = signf(x) * (absf(x) - 0.08) / 0.92
			pad_steer = signf(x) * pow(absf(x), 1.6) * steering_lock

	throttle = maxf(maxf(_kb_throttle, pad_throttle), touch_throttle)
	brake = maxf(maxf(_kb_brake, pad_brake), touch_brake)
	clutch = maxf(maxf(_kb_clutch, pad_clutch), touch_clutch)
	if touch_steer_active:
		steer_deg = touch_steer_deg
	elif tilt_enabled and Settings.is_mobile():
		# A small dead zone keeps a hand-held phone from weaving the car, and
		# a low-pass filter takes out the sensor's jitter; at speed the same
		# roll turns the wheel less, as a real steering ratio feels.
		var tilt := _tilt_roll_deg()
		tilt = signf(tilt) * maxf(absf(tilt) - TILT_DEAD_ZONE, 0.0)
		var tilt_target := clampf(tilt * TILT_GAIN * sens / (1.0 + v / 14.0), -steering_lock, steering_lock)
		_tilt_deg = lerpf(_tilt_deg, tilt_target, 1.0 - exp(-delta * TILT_SMOOTHING))
		steer_deg = _tilt_deg
	elif absf(pad_steer) > 0.0:
		steer_deg = pad_steer
	else:
		steer_deg = _kb_steer

	# Ignition key: tap = ON/OFF, hold > 0.4 s = crank.
	if _ignition_key_t >= 0.0:
		_ignition_key_t += delta
		if _ignition_key_t > 0.4 and not _starter_held:
			_starter_held = true
			starter_changed.emit(true)


## Phone roll in degrees, + = turned clockwise like a wheel to the right.
## The device frame (x right, y up, z out of the screen) is right-handed in
## any orientation, so the angle from the level reference to gravity turns
## the same way whether or not the OS rotates the sensor axes with the
## screen, and in either landscape.
func _tilt_roll_deg() -> float:
	var a := Input.get_accelerometer()
	var g := Vector2(a.x, a.y)
	if g.length() < 2.0:
		return 0.0 # phone lying flat: no reliable roll
	g = g.normalized()
	if _tilt_ref == Vector2.ZERO:
		_tilt_ref = _snap_axis(g)
	var ang := atan2(_tilt_ref.x * g.y - _tilt_ref.y * g.x, _tilt_ref.dot(g))
	if absf(ang) > deg_to_rad(100.0):
		# The phone was turned round to the other landscape.
		_tilt_ref = _snap_axis(g)
		ang = atan2(_tilt_ref.x * g.y - _tilt_ref.y * g.x, _tilt_ref.dot(g))
	return rad_to_deg(ang)


static func _snap_axis(g: Vector2) -> Vector2:
	if absf(g.x) > absf(g.y):
		return Vector2(signf(g.x), 0.0)
	return Vector2(0.0, signf(g.y))


func _unhandled_input(event: InputEvent) -> void:
	if view_only:
		if event.is_action_pressed("ui_cancel") or (event is InputEventJoypadButton and event.pressed
				and event.button_index == JOY_BUTTON_START):
			pause_pressed.emit()
		elif (event is InputEventKey and event.pressed and not event.echo and event.keycode == KEY_V) \
				or (event is InputEventJoypadButton and event.pressed and event.button_index == JOY_BUTTON_Y):
			camera_pressed.emit()
		return
	if event is InputEventKey:
		var k := event as InputEventKey
		if k.echo:
			return
		if k.keycode == KEY_I:
			if k.pressed:
				_ignition_key_t = 0.0
			else:
				if not _starter_held:
					ignition_pressed.emit()
				else:
					starter_changed.emit(false)
				_starter_held = false
				_ignition_key_t = -1.0
			return
		if not k.pressed:
			return
		match k.keycode:
			KEY_Q: indicator_pressed.emit(Car.Indicator.LEFT)
			KEY_E: indicator_pressed.emit(Car.Indicator.RIGHT)
			KEY_H: hazard_pressed.emit()
			KEY_B: seatbelt_pressed.emit()
			KEY_SPACE: handbrake_pressed.emit()
			KEY_L: headlights_pressed.emit()
			KEY_V: camera_pressed.emit()
			KEY_ESCAPE: pause_pressed.emit()
			KEY_N, KEY_0: gear_requested.emit(int(AvtoGear.selector_neutral(automatic)))
			KEY_R: gear_requested.emit(AvtoGear.reverse(automatic))
			KEY_P:
				if automatic:
					gear_requested.emit(AvtoGear.PARK)
			KEY_G:
				if automatic:
					gear_requested.emit(AvtoGear.DRIVE)
			KEY_1, KEY_2, KEY_3, KEY_4, KEY_5:
				if not automatic:
					gear_requested.emit(k.keycode - KEY_0)
			KEY_PAGEUP: gear_step.emit(1)
			KEY_PAGEDOWN: gear_step.emit(-1)
	elif event is InputEventJoypadButton and event.pressed:
		match event.button_index:
			JOY_BUTTON_A: handbrake_pressed.emit()
			JOY_BUTTON_X: indicator_pressed.emit(Car.Indicator.LEFT)
			JOY_BUTTON_B: indicator_pressed.emit(Car.Indicator.RIGHT)
			JOY_BUTTON_Y: camera_pressed.emit()
			JOY_BUTTON_BACK: hazard_pressed.emit()
			JOY_BUTTON_START: pause_pressed.emit()
			JOY_BUTTON_DPAD_UP: gear_step.emit(1)
			JOY_BUTTON_DPAD_DOWN: gear_step.emit(-1)
			JOY_BUTTON_RIGHT_SHOULDER: seatbelt_pressed.emit()


## Lets go of every on-screen control (the app lost focus mid-touch).
func release_touch() -> void:
	touch_throttle = 0.0
	touch_brake = 0.0
	touch_clutch = 0.0
	touch_steer_active = false
	if _starter_held:
		starter_changed.emit(false)
	_starter_held = false
	_ignition_key_t = -1.0


## On-screen key: press/release (tap = ON/OFF, hold = start).
func key_down() -> void:
	_ignition_key_t = 0.0


func key_up() -> void:
	if not _starter_held:
		ignition_pressed.emit()
	else:
		starter_changed.emit(false)
	_starter_held = false
	_ignition_key_t = -1.0
