// Road-sign plate: printed face in front, galvanised back, cut out by the
// artwork's alpha so round and triangular signs need no special meshes.
shader_type spatial;
render_mode blend_mix, depth_draw_opaque, cull_disabled, diffuse_burley;

uniform sampler2D face_tex : source_color, filter_linear_mipmap_anisotropic;
uniform vec4 back_color : source_color = vec4(0.55, 0.57, 0.58, 1.0);
uniform float retro = 0.18; // retro-reflective sheeting: a little self-illumination

void fragment() {
	vec4 face = texture(face_tex, UV);
	if (face.a < 0.5) {
		discard;
	}
	if (FRONT_FACING) {
		ALBEDO = face.rgb;
		EMISSION = face.rgb * retro;
		ROUGHNESS = 0.45;
	} else {
		ALBEDO = back_color.rgb;
		ROUGHNESS = 0.55;
		METALLIC = 0.6;
	}
}
