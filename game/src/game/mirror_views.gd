class_name MirrorViews
extends Node
## The two door mirrors, rendered to small textures and shown over the
## screen's upper corners while reversing (or always, in the top camera).
## Parking and the box are practically impossible from a phone screen
## without them. Rendered at low resolution.

const SIZE := Vector2i(360, 200)
# The eye sits just behind each mirror glass (Car.mirror_eye, per model) so
# the housing itself stays out of view.
# Radians. Angled outwards far enough that the car's own flank is only a thin
# strip at the inner edge (~1/8 of the glass), as a correctly set mirror shows.
const TOE := 0.42
const PITCH := -0.10 # slightly down, so the kerb and the lines near the car show
# Directional shadows are rendered again for every camera, so a mirror lit by
# the real sun would redraw the whole shadow map twice more. The mirrors see
# the world lit by a shadowless copy of the sun instead; each light sits on a
# render layer that only its own cameras include.
const LAYER_SUN := 1 << 18 # layer 19
const LAYER_MIRROR_SUN := 1 << 19 # layer 20
const FAR := 120.0

var car: Car
var quality := 1
var _vps: Array[SubViewport] = []
var _cams: Array[Camera3D] = []
var _rects: Array[TextureRect] = []
var _frames: Array[Panel] = []
var _visible := false


func setup(p_car: Car, hud_root: Control, p_quality: int, sun: DirectionalLight3D = null,
		main_camera: Camera3D = null) -> void:
	car = p_car
	quality = p_quality
	if sun and main_camera:
		_split_sun(sun, main_camera)
	for side in 2:
		var vp := SubViewport.new()
		vp.size = SIZE
		vp.msaa_3d = Viewport.MSAA_DISABLED
		vp.render_target_update_mode = SubViewport.UPDATE_DISABLED
		vp.handle_input_locally = false
		add_child(vp)
		var cam := Camera3D.new()
		cam.fov = 38.0
		cam.near = 0.12
		cam.far = FAR
		cam.cull_mask = cam.cull_mask & ~LAYER_SUN if _mirror_sun else cam.cull_mask
		cam.physics_interpolation_mode = Node.PHYSICS_INTERPOLATION_MODE_OFF
		vp.add_child(cam)
		_vps.append(vp)
		_cams.append(cam)
		var frame := Panel.new()
		frame.add_theme_stylebox_override("panel", UITheme.box(Color(0.03, 0.03, 0.04, 0.95), 26, 3,
				Color(0.25, 0.27, 0.3), 0))
		frame.mouse_filter = Control.MOUSE_FILTER_IGNORE
		frame.visible = false
		hud_root.add_child(frame)
		hud_root.move_child(frame, 1)
		var tr := TextureRect.new()
		tr.texture = vp.get_texture()
		tr.flip_h = true # a mirror reverses left and right
		tr.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
		tr.stretch_mode = TextureRect.STRETCH_SCALE
		tr.mouse_filter = Control.MOUSE_FILTER_IGNORE
		frame.add_child(tr)
		_rects.append(tr)
		_frames.append(frame)
	hud_root.get_viewport().size_changed.connect(_layout)
	_layout()


var _mirror_sun: DirectionalLight3D


func _split_sun(sun: DirectionalLight3D, main_camera: Camera3D) -> void:
	var copy := sun.duplicate() as DirectionalLight3D
	copy.name = "MirrorSun"
	copy.shadow_enabled = false
	copy.layers = LAYER_MIRROR_SUN
	sun.get_parent().add_child(copy)
	sun.layers = LAYER_SUN
	main_camera.cull_mask &= ~LAYER_MIRROR_SUN
	_mirror_sun = copy


func _layout() -> void:
	if _frames.is_empty():
		return
	var vp := _frames[0].get_viewport().get_visible_rect().size
	# Small, high on the screen, clear of the card (left) and the buttons (right).
	var w := minf(250.0, vp.x * 0.17)
	var h := w * float(SIZE.y) / float(SIZE.x)
	var y := vp.y * 0.2
	_frames[0].position = Vector2(vp.x * 0.5 - w - 110, y)
	_frames[1].position = Vector2(vp.x * 0.5 + 110, y)
	for i in 2:
		_frames[i].size = Vector2(w, h)
		_rects[i].position = Vector2(4, 4)
		_rects[i].size = Vector2(w - 8, h - 8)


func _process(_delta: float) -> void:
	if car == null or _vps.is_empty():
		return
	var want := bool(Settings.get_value("mirrors")) and quality >= 1 and AvtoGear.in_reverse(car)
	if want != _visible:
		_visible = want
		for f in _frames:
			f.visible = want
		for vp in _vps:
			vp.render_target_update_mode = SubViewport.UPDATE_DISABLED
	if not _visible:
		return
	var xf := car.get_global_transform_interpolated()
	for i in 2:
		var pos := car.mirror_eye * Vector3(-1.0 if i == 0 else 1.0, 1.0, 1.0)
		# Yaw PI looks backwards; a further +angle would turn the left mirror
		# inwards (towards +x), so the outward toe is negative on the left.
		var toe := -TOE if i == 0 else TOE
		var basis := xf.basis * Basis(Vector3.UP, PI + toe) * Basis(Vector3.RIGHT, PITCH)
		_cams[i].global_transform = Transform3D(basis, xf * pos)
	# Every frame: at half rate the mirror image judders against the car
	# moving under it. They are small and only shown while reversing.
	for vp in _vps:
		vp.render_target_update_mode = SubViewport.UPDATE_ALWAYS
