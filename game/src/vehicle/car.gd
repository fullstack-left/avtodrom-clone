class_name Car
extends AvtoVehicle
## The candidate's car: AvtoVehicle physics (C++) + model, lamps, cabin
## controls (indicators, hazards, seat belt, headlights) and sounds.
##
## Physics state lives in the native class; everything a learner sees or
## hears about the car is handled here.

signal obstacle_hit(body: Node, speed: float)
signal indicator_changed

enum Indicator { OFF, LEFT, RIGHT }

## Per-model data from the Blender builds (pipeline/blender/build_*.py):
## body origin midway between the axles on the ground; front/rear = distance
## to the bumpers, half_width = body side (without mirrors), mirror = right
## door-mirror eye point (the left one is mirrored). speed_max/rpm_max: the
## dashboard dials' full scale (km/h, rpm).
const MODELS := {
	"nexia2": {"path": "res://assets/cars/nexia2/nexia2.glb", "lod": "res://assets/cars/lod/nexia2_lod.glb", "front": 2.18, "rear": 2.31, "half_width": 0.83,
			"mirror": Vector3(0.88, 0.93, -0.37), "speed_max": 220.0, "rpm_max": 8000.0},
	"cobalt_at": {"path": "res://assets/cars/cobalt/cobalt.glb", "lod": "res://assets/cars/lod/cobalt_lod.glb", "front": 2.22, "rear": 2.26, "half_width": 0.86,
			"mirror": Vector3(0.936, 1.043, -0.53), "speed_max": 220.0, "rpm_max": 7000.0},
}
const GAUGE_SHADER := preload("res://assets/shaders/gauge.gdshader")
const BLINK_HZ := 1.5 # 90 flashes per minute (UNECE R48)
const LAYER_CAR := 2
const MASK_WORLD := 1 | 4

var indicator: Indicator = Indicator.OFF
var hazard := false
var seatbelt := false
var headlights := false
## True while the indicator/hazard lamps are lit in the blink cycle.
var blink_lit := false

var model: Node3D
var cockpit_eye := Vector3(-0.35, 1.13, 0.2)
var body_front := 2.18
var body_rear := 2.31
var body_half_width := 0.83
var mirror_eye := Vector3(0.88, 0.93, -0.37)
var _wheel_pivots: Array[Node3D] = []
var _wheel_spins: Array[Node3D] = []
var _steering: Node3D
var _gauge_speed: ShaderMaterial
var _gauge_rpm: ShaderMaterial
var _speed_max := 220.0
var _rpm_max := 8000.0
var _lamps := {}
var _lamp_on := {}
var _lamp_off := {}
var _blink_t := 0.0
var _engine_sound: EngineSound
var _click: AudioStreamPlayer
var _squeal: AudioStreamPlayer
var _scrub: AudioStreamPlayer
## Smoothed 0..1 levels of the two tyre layers and the effects volume.
var _squeal_lvl := 0.0
var _scrub_lvl := 0.0
var _fx_gain := 1.0
var _interior := false
var _thump: AudioStreamPlayer3D
var _chime: AudioStreamPlayer
var _chime_t := 0.0
var _last_hit_time := -10.0
var _model_preset := ""


func _ready() -> void:
	collision_layer = LAYER_CAR
	collision_mask = MASK_WORLD
	wheel_collision_mask = 1
	contact_monitor = true
	max_contacts_reported = 6
	body_entered.connect(_on_body_entered)
	_load_model()
	_setup_audio()


func configure(preset_id: String) -> void:
	preset = preset_id
	auto_clutch = bool(Settings.get_value("auto_clutch"))
	# _ready() already built the default model when the car entered the tree.
	if model and _model_preset != preset_id:
		_clear_model()
		_load_model()


# --------------------------------------------------------------------------- model
func _clear_model() -> void:
	for n in [model, get_node_or_null("Hull")]:
		if n:
			remove_child(n)
			n.free()
	model = null
	_wheel_pivots.clear()
	_wheel_spins.clear()
	_steering = null
	_gauge_speed = null
	_gauge_rpm = null
	_lamps.clear()
	_lamp_on.clear()
	_lamp_off.clear()


func _load_model() -> void:
	_model_preset = preset
	var spec: Dictionary = MODELS.get(preset, MODELS["nexia2"])
	body_front = spec["front"]
	body_rear = spec["rear"]
	body_half_width = spec["half_width"]
	mirror_eye = spec["mirror"]
	var scene: PackedScene = load(spec["path"])
	model = scene.instantiate()
	model.name = "Model"
	add_child(model)
	for corner in ["FL", "FR", "RL", "RR"]:
		var pivot := model.find_child("Wheel_" + corner, true, false) as Node3D
		var spin := model.find_child("Spin_" + corner, true, false) as Node3D
		_wheel_pivots.append(pivot)
		_wheel_spins.append(spin)
	_steering = model.find_child("SteeringWheel", true, false) as Node3D
	var pivot_node := model.find_child("SteeringPivot", true, false) as Node3D
	if pivot_node:
		cockpit_eye = pivot_node.position + Vector3(-0.01, 0.34, 0.52)
	for n in ["Lamp_Head", "Lamp_Fog", "Lamp_Tail", "Lamp_Brake", "Lamp_Reverse", "Lamp_TurnFL", "Lamp_TurnFR",
			"Lamp_TurnRL", "Lamp_TurnRR", "Lamp_TurnSL", "Lamp_TurnSR"]:
		var mi := model.find_child(n, true, false) as MeshInstance3D
		if mi:
			_lamps[n] = mi
	_apply_materials(model)
	_make_gauges(spec)
	_make_collision()
	_add_shadow_proxy(spec)
	_make_lamp_materials()
	_update_lamps(0.0)


## Invisible 2.5k-triangle copy of the car that only casts the shadow.
func _add_shadow_proxy(spec: Dictionary) -> void:
	if not spec.has("lod") or not ResourceLoader.exists(spec["lod"]):
		return
	var src := (load(spec["lod"]) as PackedScene).instantiate()
	for mi in src.find_children("*", "MeshInstance3D", true, false):
		var m := mi as MeshInstance3D
		var proxy := MeshInstance3D.new()
		proxy.name = "ShadowProxy"
		proxy.mesh = m.mesh
		proxy.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_SHADOWS_ONLY
		var t := Transform3D()
		var n: Node = m
		while n != src and n is Node3D:
			t = (n as Node3D).transform * t
			n = n.get_parent()
		proxy.transform = t
		model.add_child(proxy)
	src.free()


func _make_collision() -> void:
	var hull := model.find_child("CollisionHull", true, false) as MeshInstance3D
	var cs := CollisionShape3D.new()
	cs.name = "Hull"
	if hull and hull.mesh:
		var shape := hull.mesh.create_convex_shape(true, true)
		cs.shape = shape
		cs.transform = hull.transform
		hull.queue_free()
	else:
		var b := BoxShape3D.new()
		b.size = Vector3(1.65, 0.9, 4.4)
		cs.shape = b
		cs.position = Vector3(0, 0.75, 0)
	add_child(cs)


func _pbr(color: Color, metallic: float, roughness: float) -> StandardMaterial3D:
	var m := StandardMaterial3D.new()
	m.albedo_color = color
	m.metallic = metallic
	m.roughness = roughness
	return m


## Cabin surfaces skip the sun's shadow maps: seen from the driver's seat the
## roof shadow falls on them as big jagged steps. Their dark albedo stands in
## for the shade under the roof instead.
func _cabin(color: Color, roughness: float, metallic := 0.0) -> StandardMaterial3D:
	var m := _pbr(color, metallic, roughness)
	m.disable_receive_shadows = true
	return m


func _apply_materials(root: Node) -> void:
	var paint := _pbr(Color(0.93, 0.94, 0.95), 0.05, 0.28)
	paint.clearcoat_enabled = true
	paint.clearcoat = 0.9
	paint.clearcoat_roughness = 0.08
	var window := _pbr(Color(0.03, 0.05, 0.06, 0.42), 0.2, 0.04)
	window.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	window.cull_mode = BaseMaterial3D.CULL_DISABLED
	var lamp_glass := _pbr(Color(0.9, 0.92, 0.95, 0.22), 0.0, 0.03)
	lamp_glass.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	var table := {
		"paint": paint,
		"trim_black": _pbr(Color(0.035, 0.035, 0.038), 0.0, 0.55),
		"rim": _pbr(Color(0.78, 0.79, 0.8), 0.85, 0.28),
		"rubber": _pbr(Color(0.045, 0.045, 0.048), 0.0, 0.88),
		"metal": _pbr(Color(0.6, 0.61, 0.62), 0.7, 0.4),
		"brake_disc": _pbr(Color(0.42, 0.4, 0.38), 0.8, 0.45),
		"chrome": _pbr(Color(0.86, 0.87, 0.88), 1.0, 0.12),
		"window": window,
		"lamp_glass": lamp_glass,
		"lamp_orange": _pbr(Color(0.75, 0.33, 0.02), 0.0, 0.25),
		"lamp_red": _pbr(Color(0.42, 0.03, 0.03), 0.0, 0.2),
		"interior": _cabin(Color(0.13, 0.13, 0.135), 0.85),
		"interior_light": _cabin(Color(0.22, 0.22, 0.225), 0.8),
		"interior_black": _cabin(Color(0.03, 0.03, 0.032), 0.6),
		"dash": _cabin(Color(0.06, 0.06, 0.065), 0.8),
		"dash_panel": _cabin(Color(0.012, 0.012, 0.014), 0.3),
		"dash_trim": _cabin(Color(0.1, 0.1, 0.11), 0.5),
		"mirror": _pbr(Color(0.9, 0.92, 0.94), 1.0, 0.02),
		"lamp_white": _pbr(Color(0.82, 0.84, 0.86), 0.3, 0.12),
		"plate": _pbr(Color(0.92, 0.93, 0.94), 0.0, 0.45),
	}
	for mi in root.find_children("*", "MeshInstance3D", true, false):
		var m := mi as MeshInstance3D
		if m.mesh == null:
			continue
		for s in m.mesh.get_surface_count():
			var src := m.mesh.surface_get_material(s)
			var key := src.resource_name if src else ""
			if table.has(key):
				m.set_surface_override_material(s, table[key])
		# The shadow comes from the light proxy (see _add_shadow_proxy): the
		# full model would cost ~100k triangles again in the shadow pass.
		m.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF


func _make_gauges(spec: Dictionary) -> void:
	_speed_max = spec.get("speed_max", 220.0)
	_rpm_max = spec.get("rpm_max", 8000.0)
	_gauge_speed = _gauge("GaugeSpeed", int(_speed_max / 20.0) + 1, 2.0)
	var red := get_redline_rpm()
	_gauge_rpm = _gauge("GaugeRpm", int(_rpm_max / 1000.0) + 1, red / _rpm_max if red > 0.0 else 1.0)


func _gauge(node_name: String, majors: int, red_from: float) -> ShaderMaterial:
	var mi := model.find_child(node_name, true, false) as MeshInstance3D
	if mi == null:
		return null
	var m := ShaderMaterial.new()
	m.shader = GAUGE_SHADER
	m.set_shader_parameter("majors", majors)
	m.set_shader_parameter("red_from", red_from)
	mi.set_surface_override_material(0, m)
	mi.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	return m


func _emissive(color: Color, energy: float) -> StandardMaterial3D:
	var m := StandardMaterial3D.new()
	m.albedo_color = color
	m.emission_enabled = true
	m.emission = color
	m.emission_energy_multiplier = energy
	m.roughness = 0.2
	return m


func _make_lamp_materials() -> void:
	var orange := Color(1.0, 0.52, 0.05)
	var red := Color(1.0, 0.06, 0.04)
	var white := Color(1.0, 0.97, 0.9)
	for n in _lamps:
		var off: Material = _lamps[n].get_active_material(0)
		_lamp_off[n] = off
		if n.begins_with("Lamp_Turn"):
			_lamp_on[n] = _emissive(orange, 6.0)
		elif n == "Lamp_Tail":
			_lamp_on[n] = _emissive(red, 2.2)
		elif n == "Lamp_Brake":
			_lamp_on[n] = _emissive(red, 7.0)
		elif n == "Lamp_Reverse":
			_lamp_on[n] = _emissive(white, 4.0)
		else:
			_lamp_on[n] = _emissive(white, 5.0)
	# Brighter tail variant used while braking (the Nexia's tail and stop
	# lamps share one lens).
	if _lamps.has("Lamp_Tail"):
		_lamp_on["Lamp_Tail_brake"] = _emissive(red, 7.0)


func _set_lamp(n: String, on: bool, variant := "") -> void:
	if not _lamps.has(n):
		return
	var mi: MeshInstance3D = _lamps[n]
	var mat: Material = _lamp_on.get(n + variant, _lamp_on.get(n)) if on else _lamp_off[n]
	if mi.get_surface_override_material(0) != mat:
		mi.set_surface_override_material(0, mat)


# --------------------------------------------------------------------------- audio
func _setup_audio() -> void:
	_engine_sound = EngineSound.new()
	_engine_sound.name = "EngineSound"
	_engine_sound.bus = "Master"
	add_child(_engine_sound)
	_click = AudioStreamPlayer.new()
	_click.volume_db = -6.0
	add_child(_click)
	# Tyre layers loop for the whole drive and are faded in and out by volume
	# (see _set_loop): starting and stopping a player several times a second
	# as the slip flickers churns playbacks under the audio thread, and a
	# phone's audio thread crashed on it (SIGSEGV in AudioTrack).
	_squeal = AudioStreamPlayer.new()
	_squeal.stream = AudioSynth.squeal()
	_squeal.volume_db = -80.0
	add_child(_squeal)
	_squeal.play(randf() * _squeal.stream.get_length())
	_scrub = AudioStreamPlayer.new()
	_scrub.stream = AudioSynth.scrub()
	_scrub.volume_db = -80.0
	add_child(_scrub)
	_scrub.play(randf() * _scrub.stream.get_length())
	_thump = AudioStreamPlayer3D.new()
	_thump.stream = AudioSynth.thump()
	add_child(_thump)
	_chime = AudioStreamPlayer.new()
	_chime.stream = AudioSynth.chime(1046.0, 784.0)
	_chime.volume_db = -8.0
	add_child(_chime)
	_apply_volumes()
	Settings.changed.connect(func(_k: String) -> void: _apply_volumes())


func _apply_volumes() -> void:
	var master := float(Settings.get_value("vol_master"))
	_engine_sound.volume_db = linear_to_db(maxf(master * float(Settings.get_value("vol_engine")), 0.0001))
	_fx_gain = master * float(Settings.get_value("vol_effects"))
	var fx := linear_to_db(maxf(_fx_gain, 0.0001))
	_click.volume_db = fx - 6.0
	_thump.volume_db = fx
	_chime.volume_db = fx - 8.0


func set_interior_audio(inside: bool) -> void:
	_engine_sound.interior = 1.0 if inside else 0.0
	_interior = inside


# --------------------------------------------------------------------------- cabin controls
func set_indicator(dir: Indicator) -> void:
	if indicator == dir:
		return
	indicator = dir
	if indicator != Indicator.OFF or hazard:
		_blink_t = 0.0 # a fresh flash starts immediately
	indicator_changed.emit()
	_click.stream = AudioSynth.relay_click(1.0)
	_click.play()


func toggle_indicator(dir: Indicator) -> void:
	set_indicator(Indicator.OFF if indicator == dir else dir)


func set_hazard(on: bool) -> void:
	if hazard == on:
		return
	hazard = on
	_blink_t = 0.0
	indicator_changed.emit()
	_click.stream = AudioSynth.relay_click(1.0)
	_click.play()


func left_lit() -> bool:
	return blink_lit and (hazard or indicator == Indicator.LEFT)


func right_lit() -> bool:
	return blink_lit and (hazard or indicator == Indicator.RIGHT)


## Indicator lever position as the exam sees it (hazards count as both).
func signalling_left() -> bool:
	return hazard or indicator == Indicator.LEFT


func signalling_right() -> bool:
	return hazard or indicator == Indicator.RIGHT


# --------------------------------------------------------------------------- per frame
func _process(delta: float) -> void:
	_update_wheels()
	_update_lamps(delta)
	_update_audio(delta)


func _update_wheels() -> void:
	for i in 4:
		var pivot := _wheel_pivots[i]
		if pivot == null:
			continue
		pivot.transform = Transform3D(Basis(Vector3.UP, -get_wheel_steer(i)), get_wheel_position(i))
		if _wheel_spins[i]:
			_wheel_spins[i].rotation.x = -fmod(get_wheel_rotation(i), TAU)
	if _steering:
		_steering.rotation.y = -deg_to_rad(steering_wheel)
	if _gauge_speed:
		var kmh := absf(get_forward_speed()) * 3.6
		_gauge_speed.set_shader_parameter("value", clampf(kmh / _speed_max, 0.0, 1.0))
	if _gauge_rpm:
		_gauge_rpm.set_shader_parameter("value", clampf(get_rpm() / _rpm_max, 0.0, 1.0))


func _update_lamps(delta: float) -> void:
	var blinking := hazard or indicator != Indicator.OFF
	var was := blink_lit
	if blinking and (ignition or hazard):
		_blink_t += delta
		blink_lit = fmod(_blink_t * BLINK_HZ, 1.0) < 0.5
	else:
		_blink_t = 0.0
		blink_lit = false
	if blink_lit != was and blinking:
		_click.stream = AudioSynth.relay_click(1.0 if blink_lit else 0.8)
		_click.play()
	var l := left_lit()
	var r := right_lit()
	for n in ["Lamp_TurnFL", "Lamp_TurnRL", "Lamp_TurnSL"]:
		_set_lamp(n, l)
	for n in ["Lamp_TurnFR", "Lamp_TurnRR", "Lamp_TurnSR"]:
		_set_lamp(n, r)
	var braking := brake > 0.05 and ignition
	_set_lamp("Lamp_Brake", braking)
	_set_lamp("Lamp_Tail", braking or (headlights and ignition), "_brake" if braking else "")
	_set_lamp("Lamp_Head", headlights and ignition)
	var reversing := ignition and (get_gear() == -1)
	_set_lamp("Lamp_Reverse", reversing)


func _update_audio(delta: float) -> void:
	_engine_sound.rpm = get_rpm()
	_engine_sound.load = get_throttle_opening()
	_engine_sound.running = is_engine_running()
	_engine_sound.cranking = is_engine_cranking()
	var speed := absf(get_forward_speed())
	_update_tyre_audio(delta, speed)
	# Seat-belt reminder chime while moving unbelted, like the real car.
	if not seatbelt and ignition and speed > 2.0:
		_chime_t -= delta
		if _chime_t <= 0.0:
			_chime.play()
			_chime_t = 2.0
	else:
		_chime_t = 0.0


## Tyre noise from how fast each contact patch rubs over the road. Two
## layers, like a real car:
## - squeal: the tonal scream of tyres sliding past their grip limit at speed
##   (a fast corner, a skid from 40 km/h);
## - scrub: the dull rasp of a locked or sliding tyre (a skid, the handbrake),
##   much quieter, and silent at parking speed.
## The normalised slip saturates at 3 as soon as a tyre lets go, so it cannot
## tell a slight slide from a locked wheel: the slide speed decides.
func _update_tyre_audio(delta: float, speed: float) -> void:
	var squeal := 0.0
	var scrub := 0.0
	var nominal_load := mass * 9.81 * 0.25
	for i in 4:
		if not get_wheel_contact(i):
			continue
		var s := get_wheel_slip(i)
		if s < 0.9:
			continue
		var slide := get_wheel_slide_speed(i)
		var load := clampf(get_wheel_load(i) / nominal_load, 0.0, 1.5)
		squeal += smoothstep(0.9, 1.5, s) * smoothstep(0.8, 4.0, slide) * load
		scrub += smoothstep(1.0, 2.5, s) * smoothstep(0.2, 5.0, slide) * load
	# Two wheels sliding is "full"; the scream needs real speed (fades in
	# from ~10 km/h, full above ~45 km/h).
	squeal = clampf(squeal * 0.5, 0.0, 1.0) * smoothstep(3.0, 12.0, speed)
	# Scrub is a real slide only (a skid, a locked wheel): at parking speed a
	# tyre on full lock is silent.
	scrub = clampf(scrub * 0.5, 0.0, 1.0) * smoothstep(1.5, 5.0, speed)
	# Fast attack, slower release: no clicks or stutter when slip flickers.
	# A non-finite level would stick forever (it feeds back through _follow).
	_squeal_lvl = _follow(_squeal_lvl, squeal if is_finite(squeal) else 0.0, delta)
	_scrub_lvl = _follow(_scrub_lvl, scrub if is_finite(scrub) else 0.0, delta)
	if not is_finite(_squeal_lvl):
		_squeal_lvl = 0.0
	if not is_finite(_scrub_lvl):
		_scrub_lvl = 0.0
	if not is_finite(speed):
		speed = 0.0
	var muffle := 0.5 if _interior else 1.0
	_set_loop(_squeal, _squeal_lvl * 0.32 * muffle, 0.94 + 0.1 * _squeal_lvl)
	_set_loop(_scrub, _scrub_lvl * 0.25 * muffle, 0.75 + clampf(speed / 20.0, 0.0, 0.45))


static func _follow(current: float, target: float, delta: float) -> float:
	var tau := 0.05 if target > current else 0.2
	return lerpf(current, target, 1.0 - exp(-delta / tau))


## The audio thread trusts these values: pitch_scale rejects <= 0 but lets a
## NaN through, and a NaN pitch sends the WAV mixer's read position off the
## end of the sample data (the SIGSEGV in AudioTrack seen on phones). Slip and
## load come straight from the tyre model, so anything non-finite is silence.
func _set_loop(p: AudioStreamPlayer, gain: float, pitch: float) -> void:
	var g := gain * _fx_gain
	if not (is_finite(g) and is_finite(pitch)):
		g = 0.0
		pitch = 1.0
	p.volume_db = linear_to_db(g) if g >= 0.003 else -80.0
	p.pitch_scale = clampf(pitch, 0.5, 2.0)


func _on_body_entered(body: Node) -> void:
	if not body.is_in_group("obstacle"):
		return
	# Game time, not wall time: the debounce must not depend on the frame rate.
	var now := Engine.get_physics_frames() / float(Engine.physics_ticks_per_second)
	if now - _last_hit_time < 0.6:
		return
	_last_hit_time = now
	var speed := linear_velocity.length()
	_thump.volume_db = linear_to_db(clampf(speed / 6.0, 0.05, 1.0))
	_thump.play()
	obstacle_hit.emit(body, speed)
