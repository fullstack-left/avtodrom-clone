// Tiled PBR ground (asphalt, concrete, grass) with a low-frequency macro
// variation so the 4 m texture tile does not read as a grid from the car.
shader_type spatial;
render_mode blend_mix, depth_draw_opaque, cull_back, diffuse_burley, specular_schlick_ggx;

uniform sampler2D albedo_tex : source_color, filter_linear_mipmap_anisotropic, repeat_enable;
uniform sampler2D normal_tex : hint_normal, filter_linear_mipmap_anisotropic, repeat_enable;
uniform sampler2D arm_tex : hint_default_white, filter_linear_mipmap_anisotropic, repeat_enable;
uniform vec4 tint : source_color = vec4(1.0);
uniform float normal_strength = 1.0;
uniform float macro_scale = 0.071;
uniform float macro_strength = 0.28;
uniform float roughness_offset = 0.0;
uniform float ao_strength = 1.0;

void fragment() {
	vec3 albedo = texture(albedo_tex, UV).rgb;
	float macro = texture(albedo_tex, UV * macro_scale + vec2(0.37, 0.11)).g;
	macro += texture(albedo_tex, UV * macro_scale * 0.31 + vec2(0.71, 0.53)).r;
	albedo *= mix(1.0, 0.72 + macro * 0.32, macro_strength);
	ALBEDO = albedo * tint.rgb * COLOR.rgb;
	vec3 arm = texture(arm_tex, UV).rgb;
	AO = mix(1.0, arm.r, ao_strength);
	AO_LIGHT_AFFECT = 0.35;
	ROUGHNESS = clamp(arm.g + roughness_offset, 0.04, 1.0);
	METALLIC = 0.0;
	NORMAL_MAP = texture(normal_tex, UV).rgb;
	NORMAL_MAP_DEPTH = normal_strength;
}
