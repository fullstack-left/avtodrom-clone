extends Node
## Persistent user settings (user://settings.cfg).
##
## Every value has a default here; the file only stores what the user changed.
## Graphics settings are applied immediately to the viewport/environment by
## whoever listens to `changed` (see src/game/graphics.gd).

signal changed(key: String)

const PATH := "user://settings.cfg"
const SECTION := "settings"

const DEFAULTS := {
	"language": "uz_latn", # uz_latn | uz_cyrl | ru
	"car": "nexia2", # nexia2 (mexanika) | cobalt_at (avtomat)
	"auto_clutch": true, # manual gearbox: the simulation works the clutch
	"abs": true,
	"steering_mode": "wheel", # wheel | tilt | buttons (on-screen controls)
	# On-screen wheel, pedals and switches: -1 = automatic (phones and
	# tablets yes, computers no), 0 = off, 1 = on.
	"screen_controls": -1,
	# On-screen wheel: 1.5 = one full turn of the finger gives the car's full
	# lock (1.5 steering-wheel turns on the Nexia).
	"steering_sensitivity": 1.5,
	"steering_autocenter": true,
	"camera": "chase", # cockpit | chase | top (the last one used)
	"quality": -1, # -1 = auto, 0 low, 1 medium, 2 high
	"render_scale": -1.0, # 3D resolution; -1 = by quality (phones render below screen resolution)
	"fps_limit": 60,
	"shadows": true,
	"mirrors": true,
	"show_hints": true,
	"show_route": true,
	"vol_master": 0.9,
	"vol_engine": 0.8,
	"vol_effects": 0.8,
	"left_handed": false,
	# Touch controls moved / resized by the player (HudLayoutEditor):
	# control id -> {"x", "y": centre as a share of the safe area, "s": scale}.
	"hud_layout": {},
	"exam_time_limit_min": 25,
}

var _values: Dictionary = {}


func _ready() -> void:
	_values = DEFAULTS.duplicate(true)
	var cfg := ConfigFile.new()
	if cfg.load(PATH) == OK:
		for key in cfg.get_section_keys(SECTION):
			if DEFAULTS.has(key):
				var v: Variant = cfg.get_value(SECTION, key)
				if typeof(v) == typeof(DEFAULTS[key]) or (typeof(DEFAULTS[key]) == TYPE_FLOAT and typeof(v) == TYPE_INT):
					_values[key] = v
	if int(_values["quality"]) < 0:
		_values["quality"] = detect_quality()
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("--physics-hz="): # tests: the phones' tick rate on a PC
			Engine.physics_ticks_per_second = int(arg.substr(13))
			Engine.max_physics_steps_per_frame = 3
	if OS.has_feature("mobile"):
		# Phones: 60 physics ticks (the C++ car model keeps its own 960 Hz
		# substeps) and never more than 3 catch-up ticks in a slow frame.
		Engine.physics_ticks_per_second = 60
		Engine.max_physics_steps_per_frame = 3


func get_value(key: String) -> Variant:
	return _values.get(key, DEFAULTS.get(key))


func set_value(key: String, value: Variant) -> void:
	if not DEFAULTS.has(key):
		push_warning("Unknown setting: %s" % key)
		return
	if _values.get(key) == value:
		return
	_values[key] = value
	save()
	changed.emit(key)


func save() -> void:
	var cfg := ConfigFile.new()
	for key in _values:
		if _values[key] != DEFAULTS[key]:
			cfg.set_value(SECTION, key, _values[key])
	var err := cfg.save(PATH)
	if err != OK:
		push_warning("Settings could not be saved (%s)" % error_string(err))


func reset_to_defaults() -> void:
	_values = DEFAULTS.duplicate(true)
	_values["quality"] = detect_quality()
	save()
	for key in _values:
		changed.emit(key)


## Picks a starting quality level from the hardware: phones with few cores or
## the OpenGL fallback start on Low; desktops on High.
func detect_quality() -> int:
	if not OS.has_feature("mobile"):
		return 2
	var cores := OS.get_processor_count()
	var method := str(ProjectSettings.get_setting("rendering/renderer/rendering_method"))
	if RenderingServer.get_current_rendering_method() == "gl_compatibility" or method == "gl_compatibility":
		return 0
	if cores >= 8:
		return 1
	return 0


## 3D render resolution as a share of the screen: the setting, or by quality
## (phone screens have far more pixels than their GPUs can shade at 60 fps).
func render_scale() -> float:
	var v := float(get_value("render_scale"))
	if v > 0.0:
		return clampf(v, 0.5, 1.0)
	if not OS.has_feature("mobile"):
		return 1.0
	return [0.6, 0.72, 0.85][clampi(int(get_value("quality")), 0, 2)]


## Whether the on-screen driving controls are shown.
func screen_controls_on() -> bool:
	var v := int(get_value("screen_controls"))
	return is_mobile() if v < 0 else v == 1


func is_mobile() -> bool:
	# "--touch" (after "--") previews the phone layout on a desktop.
	var forced := "--touch" in OS.get_cmdline_user_args()
	return forced or OS.has_feature("mobile") or OS.has_feature("web_android") or OS.has_feature("web_ios")
