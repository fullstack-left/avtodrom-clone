shader_type spatial;
render_mode unshaded, cull_back;
// Backlit dashboard dial drawn from UVs (the quad's UVs span 0..1):
// bezel ring, tick marks over a 240 degree sweep, red zone, live needle.

uniform float value : hint_range(0.0, 1.0) = 0.0;
uniform int majors = 11; // number of major ticks, both ends included
uniform float red_from : hint_range(0.0, 1.0) = 1.0;
uniform vec3 face_color : source_color = vec3(0.025, 0.027, 0.03);
uniform vec3 mark_color : source_color = vec3(0.86, 0.88, 0.9);
uniform vec3 needle_color : source_color = vec3(1.0, 0.32, 0.06);

const float SWEEP = 4.18879; // 240 degrees

float band(float x, float a, float b, float aa) {
	return smoothstep(a - aa, a, x) * (1.0 - smoothstep(b, b + aa, x));
}

void fragment() {
	vec2 p = (UV - 0.5) * vec2(2.0, -2.0);
	float r = length(p);
	if (r > 1.0) {
		discard;
	}
	float aa = fwidth(r) * 1.2;
	// Angle from straight up, clockwise; the scale runs -120..+120 degrees.
	float ang = atan(p.x, p.y);
	float t = (ang + SWEEP * 0.5) / SWEEP;
	vec3 col = face_color;
	col = mix(col, vec3(0.5, 0.52, 0.55), band(r, 0.93, 1.0, aa)); // bezel
	bool on_scale = t >= -0.004 && t <= 1.004;
	if (on_scale) {
		float seg = float(max(majors - 1, 1));
		float minor_n = seg * 2.0;
		float dmaj = abs(fract(t * seg + 0.5) - 0.5) / seg * SWEEP * r;
		float dmin = abs(fract(t * minor_n + 0.5) - 0.5) / minor_n * SWEEP * r;
		float w = fwidth(t) * SWEEP * r;
		float major = band(r, 0.66, 0.88, aa) * (1.0 - smoothstep(0.018, 0.018 + w, dmaj));
		float minor = band(r, 0.76, 0.88, aa) * (1.0 - smoothstep(0.01, 0.01 + w, dmin));
		vec3 mc = t > red_from ? vec3(0.95, 0.12, 0.08) : mark_color;
		col = mix(col, mc, max(major, minor));
		col = mix(col, vec3(0.7, 0.08, 0.05), band(r, 0.88, 0.91, aa) * step(red_from, t));
	}
	// Needle: a thin wedge from the hub towards the current value.
	float na = (value - 0.5) * SWEEP;
	vec2 dir = vec2(sin(na), cos(na));
	float along = dot(p, dir);
	float across = abs(dot(p, vec2(dir.y, -dir.x)));
	float needle_w = mix(0.045, 0.012, clamp(along / 0.85, 0.0, 1.0));
	float needle = step(-0.12, along) * (1.0 - smoothstep(0.84, 0.86, along))
			* (1.0 - smoothstep(needle_w, needle_w + fwidth(across) * 1.5, across));
	col = mix(col, needle_color, needle);
	col = mix(col, vec3(0.12, 0.12, 0.13), 1.0 - smoothstep(0.1, 0.1 + aa, r)); // hub cap
	ALBEDO = col;
}
