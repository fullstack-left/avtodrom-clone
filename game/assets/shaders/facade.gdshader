// Building walls with windows, from world position alone (no textures, no
// UVs): one material for the exam centre and every distant block.
// Wall colour = tint × vertex/instance colour; roofs are darker.
shader_type spatial;
render_mode blend_mix, depth_draw_opaque, cull_back, diffuse_burley, specular_schlick_ggx;

uniform vec4 tint : source_color = vec4(1.0);
uniform float floor_h = 3.3;
uniform float bay_w = 3.2;
uniform float ground_floor = 1.0; // no windows below this height

varying vec3 wp;
varying vec3 wn;

void vertex() {
	wp = (MODEL_MATRIX * vec4(VERTEX, 1.0)).xyz;
	wn = normalize((MODEL_MATRIX * vec4(NORMAL, 0.0)).xyz);
}

float hash(vec2 p) {
	return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

void fragment() {
	vec3 base = tint.rgb * COLOR.rgb;
	float wall = 1.0 - step(0.5, abs(wn.y));
	float u = abs(wn.x) > abs(wn.z) ? wp.z : wp.x;
	vec2 cell = vec2(floor(u / bay_w), floor(wp.y / floor_h));
	float fy = fract(wp.y / floor_h);
	float fx = fract(u / bay_w);
	float win = step(0.32, fy) * step(fy, 0.8) * step(0.16, fx) * step(fx, 0.84) * wall
			* step(ground_floor, wp.y);
	vec3 glass = vec3(0.13, 0.18, 0.25) + vec3(0.1, 0.1, 0.08) * hash(cell);
	vec3 roof = base * 0.55;
	vec3 c = mix(roof, base, wall);
	ALBEDO = mix(c, glass, win);
	ROUGHNESS = mix(0.88, 0.12, win);
	SPECULAR = mix(0.3, 0.7, win);
	METALLIC = 0.0;
}
