// Lawn: calm, mown grass instead of a busy repeating photo.
//  * colour comes from two greens (lush / sun-dried) mixed by a slow,
//    world-space variation, so large areas look natural;
//  * the photo texture only adds fine detail, at reduced contrast, sampled
//    at two scales and angles so its 3 m tile never lines up;
//  * detail and bump fade out with distance, where they would only shimmer;
//  * rough and barely specular — grass does not glint.
shader_type spatial;
render_mode blend_mix, depth_draw_opaque, cull_back, diffuse_burley, specular_schlick_ggx;

uniform sampler2D albedo_tex : source_color, filter_linear_mipmap_anisotropic, repeat_enable;
uniform sampler2D normal_tex : hint_normal, filter_linear_mipmap_anisotropic, repeat_enable;
uniform vec4 lush : source_color = vec4(0.29, 0.44, 0.17, 1.0);
uniform vec4 dry : source_color = vec4(0.47, 0.5, 0.26, 1.0);
uniform float tile = 3.0; // metres per texture repeat
uniform float detail = 0.5; // contrast of the photo detail near the camera
uniform float bump = 0.45;

varying vec3 wpos;

void vertex() {
	wpos = (MODEL_MATRIX * vec4(VERTEX, 1.0)).xyz;
}

void fragment() {
	vec2 p = wpos.xz;
	vec2 uv1 = p / tile;
	vec2 uv2 = mat2(vec2(0.8, -0.6), vec2(0.6, 0.8)) * p / (tile * 2.9) + vec2(0.31, 0.77);
	vec3 a = texture(albedo_tex, uv1).rgb;
	vec3 b = texture(albedo_tex, uv2).rgb;
	// The texture's own average (its smallest mip) turns it into pure detail.
	vec3 avg = textureLod(albedo_tex, vec2(0.5), 12.0).rgb;
	float lum_avg = max(dot(avg, vec3(0.3, 0.59, 0.11)), 0.01);
	float lum = dot(mix(a, b, 0.45), vec3(0.3, 0.59, 0.11)) / lum_avg;

	// Slow patches of lusher and drier grass (tens of metres).
	float m1 = textureLod(albedo_tex, p / 173.0, 6.0).g;
	float m2 = textureLod(albedo_tex, p / 57.0 + vec2(0.43, 0.19), 5.0).g;
	float macro = clamp((m1 * 0.6 + m2 * 0.4 - avg.g) * 9.0 + 0.5, 0.0, 1.0);
	vec3 base = mix(lush.rgb, dry.rgb, macro * 0.4);

	float dist = length(wpos - CAMERA_POSITION_WORLD);
	float near = 1.0 - smoothstep(6.0, 70.0, dist);
	float k = detail * (0.35 + 0.65 * near);
	ALBEDO = base * clamp(1.0 + (lum - 1.0) * k, 0.55, 1.45) * COLOR.rgb;

	NORMAL_MAP = texture(normal_tex, uv1).rgb;
	NORMAL_MAP_DEPTH = bump * near;
	ROUGHNESS = 0.93;
	SPECULAR = 0.22;
	METALLIC = 0.0;
	AO = 1.0;
}
