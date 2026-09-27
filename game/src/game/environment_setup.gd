class_name EnvironmentSetup
extends RefCounted
## Sky, sun and post-processing, scaled to the quality level.
##   0 = low (phones from ~2018, OpenGL fallback), 1 = medium, 2 = high.

static func create(parent: Node, quality: int) -> DirectionalLight3D:
	var env := Environment.new()
	var sky := Sky.new()
	var sky_mat := PanoramaSkyMaterial.new()
	sky_mat.panorama = load("res://assets/sky/sky_1k.hdr")
	sky_mat.energy_multiplier = 1.0
	sky.sky_material = sky_mat
	sky.radiance_size = [Sky.RADIANCE_SIZE_64, Sky.RADIANCE_SIZE_128, Sky.RADIANCE_SIZE_256][clampi(quality, 0, 2)]
	# The sky never changes: its lighting is computed once, fully, before the
	# first frame (incremental mode spreads it over frames, and the ground and
	# the background visibly change brightness while it converges).
	sky.process_mode = Sky.PROCESS_MODE_QUALITY
	env.background_mode = Environment.BG_SKY
	env.sky = sky
	env.ambient_light_source = Environment.AMBIENT_SOURCE_SKY
	env.ambient_light_energy = 1.0
	env.reflected_light_source = Environment.REFLECTION_SOURCE_SKY
	env.tonemap_mode = Environment.TONE_MAPPER_FILMIC
	env.tonemap_exposure = 1.0
	env.tonemap_white = 6.0
	env.fog_enabled = true
	env.fog_light_color = Color(0.72, 0.8, 0.9)
	env.fog_density = 0.0016
	env.fog_sky_affect = 0.0
	var mobile := OS.has_feature("mobile")
	# Glow is a full-screen blur chain: on phones only at the top level.
	env.glow_enabled = quality >= 2 or (quality >= 1 and not mobile)
	env.glow_intensity = 0.35
	env.glow_bloom = 0.02
	env.glow_hdr_threshold = 1.2
	env.adjustment_enabled = true
	env.adjustment_saturation = 1.06
	env.adjustment_contrast = 1.04
	var we := WorldEnvironment.new()
	we.name = "WorldEnvironment"
	we.environment = env
	parent.add_child(we)

	var sun := DirectionalLight3D.new()
	sun.name = "Sun"
	# Late-morning sun from the south-east, as in the scheme's shading.
	sun.rotation = Vector3(deg_to_rad(-52.0), deg_to_rad(150.0), 0.0)
	sun.light_energy = 1.25
	sun.light_color = Color(1.0, 0.97, 0.92)
	# Low: no shadows. Medium: one cascade to 35 m on phones. High: more.
	sun.shadow_enabled = quality >= 1 and bool(Settings.get_value("shadows"))
	sun.shadow_bias = 0.03
	sun.shadow_normal_bias = 1.2
	if quality >= 2:
		sun.directional_shadow_mode = DirectionalLight3D.SHADOW_PARALLEL_2_SPLITS if mobile 				else DirectionalLight3D.SHADOW_PARALLEL_4_SPLITS
		sun.directional_shadow_max_distance = 55.0 if mobile else 80.0
	else:
		sun.directional_shadow_mode = DirectionalLight3D.SHADOW_ORTHOGONAL if mobile 				else DirectionalLight3D.SHADOW_PARALLEL_2_SPLITS
		sun.directional_shadow_max_distance = 35.0 if mobile else 45.0
	sun.directional_shadow_blend_splits = quality >= 2 and not mobile
	parent.add_child(sun)
	return sun


## Resolution, anti-aliasing and level of detail for a viewport.
static func apply_viewport(vp: Viewport, quality: int) -> void:
	var mobile := OS.has_feature("mobile")
	var scale := Settings.render_scale()
	vp.scaling_3d_scale = scale
	vp.scaling_3d_mode = Viewport.SCALING_3D_MODE_FSR if (scale < 0.99 and quality >= 1) 			else Viewport.SCALING_3D_MODE_BILINEAR
	var q := clampi(quality, 0, 2)
	var msaa := [Viewport.MSAA_DISABLED, Viewport.MSAA_2X, Viewport.MSAA_2X] if mobile 			else [Viewport.MSAA_DISABLED, Viewport.MSAA_2X, Viewport.MSAA_4X]
	vp.msaa_3d = msaa[q]
	vp.screen_space_aa = Viewport.SCREEN_SPACE_AA_DISABLED
	# Switch meshes to their lighter automatic LODs earlier on phones.
	# Higher thresholds make the car body visibly pop between its LODs.
	var lod := [4.0, 2.0, 1.5] if mobile else [3.0, 1.0, 1.0]
	vp.mesh_lod_threshold = lod[q]
