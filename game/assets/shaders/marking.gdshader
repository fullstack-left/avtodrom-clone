// Road paint. Drawn a few millimetres above the road and nudged towards the
// camera in the vertex stage so it always wins the depth test against the
// asphalt without visible floating, at any distance.
shader_type spatial;
render_mode blend_mix, depth_draw_opaque, cull_back, world_vertex_coords, diffuse_burley;

uniform sampler2D wear_tex : source_color, filter_linear_mipmap, repeat_enable;
uniform vec4 paint : source_color = vec4(0.93, 0.93, 0.91, 1.0);
uniform float wear = 0.22;
uniform float camera_bias = 0.012;

void vertex() {
	vec3 to_cam = CAMERA_POSITION_WORLD - VERTEX;
	float dist = length(to_cam);
	VERTEX += to_cam / max(dist, 0.001) * camera_bias * clamp(dist * 0.08, 0.3, 4.0);
}

void fragment() {
	vec3 grime = texture(wear_tex, UV * 0.37).rgb;
	float w = smoothstep(0.25, 0.75, texture(wear_tex, UV * 0.11 + vec2(0.3)).g);
	ALBEDO = mix(paint.rgb * COLOR.rgb, grime * 1.1, w * wear);
	ROUGHNESS = 0.62;
	SPECULAR = 0.35;
}
