class_name Icons
extends RefCounted
## Vector pictograms drawn straight into a CanvasItem (no image assets, crisp
## at every screen density). `c` is the centre, `s` the half-size.


static func draw(ci: CanvasItem, icon: String, c: Vector2, s: float, color: Color) -> void:
	match icon:
		"left":
			_arrow(ci, c, s, color, -1.0)
		"right":
			_arrow(ci, c, s, color, 1.0)
		"hazard":
			var pts := PackedVector2Array()
			for k in 3:
				var a := -PI * 0.5 + k * TAU / 3.0
				pts.append(c + Vector2(cos(a), sin(a)) * s * 0.95 + Vector2(0, s * 0.18))
			pts.append(pts[0])
			ci.draw_polyline(pts, color, s * 0.16, true)
			var inner := PackedVector2Array()
			for k in 3:
				var a := -PI * 0.5 + k * TAU / 3.0
				inner.append(c + Vector2(cos(a), sin(a)) * s * 0.42 + Vector2(0, s * 0.1))
			inner.append(inner[0])
			ci.draw_polyline(inner, color, s * 0.1, true)
		"belt":
			ci.draw_circle(c + Vector2(0, -s * 0.62), s * 0.22, color)
			var body := PackedVector2Array([c + Vector2(-s * 0.45, s * 0.85), c + Vector2(-s * 0.4, -s * 0.18),
					c + Vector2(0, -s * 0.34), c + Vector2(s * 0.4, -s * 0.18), c + Vector2(s * 0.45, s * 0.85)])
			ci.draw_colored_polygon(body, color.darkened(0.35))
			ci.draw_line(c + Vector2(-s * 0.55, -s * 0.2), c + Vector2(s * 0.5, s * 0.75), color, s * 0.18, true)
		"key":
			ci.draw_arc(c + Vector2(-s * 0.45, 0), s * 0.38, 0, TAU, 24, color, s * 0.16, true)
			ci.draw_line(c + Vector2(-s * 0.08, 0), c + Vector2(s * 0.9, 0), color, s * 0.18, true)
			ci.draw_line(c + Vector2(s * 0.55, 0), c + Vector2(s * 0.55, s * 0.32), color, s * 0.16, true)
			ci.draw_line(c + Vector2(s * 0.85, 0), c + Vector2(s * 0.85, s * 0.4), color, s * 0.16, true)
		"handbrake":
			ci.draw_arc(c, s * 0.62, 0, TAU, 28, color, s * 0.14, true)
			ci.draw_arc(c, s * 0.92, PI * 0.72, PI * 1.28, 10, color, s * 0.12, true)
			ci.draw_arc(c, s * 0.92, -PI * 0.28, PI * 0.28, 10, color, s * 0.12, true)
			_letter(ci, "P", c, s * 0.9, color)
		"lights":
			var d := PackedVector2Array()
			for k in 13:
				var a := -PI * 0.5 + k * PI / 12.0
				d.append(c + Vector2(-s * 0.1 + cos(a) * s * 0.55, sin(a) * s * 0.6))
			d.append(c + Vector2(-s * 0.1, -s * 0.6))
			ci.draw_polyline(d, color, s * 0.14, true)
			for k in 4:
				var y := -s * 0.45 + k * s * 0.3
				ci.draw_line(c + Vector2(-s * 0.3, y), c + Vector2(-s * 0.95, y + s * 0.12), color, s * 0.12, true)
		"camera":
			ci.draw_rect(Rect2(c - Vector2(s * 0.8, s * 0.5), Vector2(s * 1.3, s * 1.0)), color, false, s * 0.14)
			ci.draw_colored_polygon(PackedVector2Array([c + Vector2(s * 0.5, -s * 0.2), c + Vector2(s * 0.95, -s * 0.5),
					c + Vector2(s * 0.95, s * 0.5), c + Vector2(s * 0.5, s * 0.2)]), color)
		"pause":
			ci.draw_rect(Rect2(c + Vector2(-s * 0.5, -s * 0.6), Vector2(s * 0.32, s * 1.2)), color)
			ci.draw_rect(Rect2(c + Vector2(s * 0.18, -s * 0.6), Vector2(s * 0.32, s * 1.2)), color)
		"engine":
			var e := PackedVector2Array([c + Vector2(-s * 0.8, -s * 0.2), c + Vector2(-s * 0.45, -s * 0.2),
					c + Vector2(-s * 0.3, -s * 0.5), c + Vector2(s * 0.35, -s * 0.5), c + Vector2(s * 0.5, -s * 0.25),
					c + Vector2(s * 0.85, -s * 0.25), c + Vector2(s * 0.85, s * 0.45), c + Vector2(-s * 0.3, s * 0.45),
					c + Vector2(-s * 0.5, s * 0.2), c + Vector2(-s * 0.8, s * 0.2)])
			e.append(e[0])
			ci.draw_polyline(e, color, s * 0.13, true)
		"abs":
			ci.draw_arc(c, s * 0.62, 0, TAU, 28, color, s * 0.12, true)
			var f := UITheme.bold()
			var fs := int(s * 0.62)
			var w := f.get_string_size("ABS", HORIZONTAL_ALIGNMENT_LEFT, -1, fs).x
			ci.draw_string(f, c + Vector2(-w * 0.5, fs * 0.36), "ABS", HORIZONTAL_ALIGNMENT_LEFT, -1, fs, color)
		"map":
			var m := PackedVector2Array([c + Vector2(-s * 0.85, -s * 0.55), c + Vector2(-s * 0.3, -s * 0.8),
					c + Vector2(s * 0.3, -s * 0.55), c + Vector2(s * 0.85, -s * 0.8), c + Vector2(s * 0.85, s * 0.55),
					c + Vector2(s * 0.3, s * 0.8), c + Vector2(-s * 0.3, s * 0.55), c + Vector2(-s * 0.85, s * 0.8)])
			m.append(m[0])
			ci.draw_polyline(m, color, s * 0.12, true)
		"restart":
			ci.draw_arc(c, s * 0.62, -PI * 0.1, PI * 1.5, 24, color, s * 0.16, true)
			ci.draw_colored_polygon(PackedVector2Array([c + Vector2(s * 0.62, -s * 0.5), c + Vector2(s * 0.95, 0.0),
					c + Vector2(s * 0.3, s * 0.02)]), color)
		"flag":
			# Chequered flag on a pole: the exam.
			ci.draw_line(c + Vector2(-s * 0.7, -s * 0.9), c + Vector2(-s * 0.7, s * 0.95), color, s * 0.13, true)
			var cell := s * 0.34
			for yy in 3:
				for xx in 4:
					var r := Rect2(c + Vector2(-s * 0.62 + xx * cell, -s * 0.86 + yy * cell), Vector2(cell, cell))
					if (xx + yy) % 2 == 0:
						ci.draw_rect(r, color)
			ci.draw_rect(Rect2(c + Vector2(-s * 0.62, -s * 0.86), Vector2(cell * 4.0, cell * 3.0)), color, false, s * 0.06)
		"cone":
			# Traffic cone: the exercises.
			var body := PackedVector2Array([c + Vector2(-s * 0.2, -s * 0.9), c + Vector2(s * 0.2, -s * 0.9),
					c + Vector2(s * 0.55, s * 0.62), c + Vector2(-s * 0.55, s * 0.62)])
			ci.draw_colored_polygon(body, color)
			ci.draw_rect(Rect2(c + Vector2(-s * 0.85, s * 0.6), Vector2(s * 1.7, s * 0.28)), color)
			var band := color.darkened(0.55)
			ci.draw_colored_polygon(PackedVector2Array([c + Vector2(-s * 0.3, -s * 0.35), c + Vector2(s * 0.3, -s * 0.35),
					c + Vector2(s * 0.37, -s * 0.08), c + Vector2(-s * 0.37, -s * 0.08)]), band)
			ci.draw_colored_polygon(PackedVector2Array([c + Vector2(-s * 0.42, s * 0.16), c + Vector2(s * 0.42, s * 0.16),
					c + Vector2(s * 0.49, s * 0.42), c + Vector2(-s * 0.49, s * 0.42)]), band)
		"wheel":
			# Steering wheel: free driving.
			ci.draw_arc(c, s * 0.85, 0, TAU, 40, color, s * 0.17, true)
			ci.draw_circle(c, s * 0.24, color)
			for a in [PI, 0.0, PI * 0.5]:
				ci.draw_line(c + Vector2(cos(a), sin(a)) * s * 0.2, c + Vector2(cos(a), sin(a)) * s * 0.78, color,
						s * 0.15, true)
		"list":
			for k in 3:
				var y := -s * 0.55 + k * s * 0.55
				ci.draw_circle(c + Vector2(-s * 0.7, y), s * 0.11, color)
				ci.draw_line(c + Vector2(-s * 0.4, y), c + Vector2(s * 0.85, y), color, s * 0.14, true)
		"warn":
			var t := PackedVector2Array([c + Vector2(0, -s * 0.9), c + Vector2(s * 0.95, s * 0.75),
					c + Vector2(-s * 0.95, s * 0.75), c + Vector2(0, -s * 0.9)])
			ci.draw_polyline(t, color, s * 0.13, true)
			ci.draw_line(c + Vector2(0, -s * 0.3), c + Vector2(0, s * 0.22), color, s * 0.15, true)
			ci.draw_circle(c + Vector2(0, s * 0.48), s * 0.09, color)
		"gear":
			for k in 8:
				var a := k * TAU / 8.0
				ci.draw_line(c + Vector2(cos(a), sin(a)) * s * 0.55, c + Vector2(cos(a), sin(a)) * s * 0.92, color,
						s * 0.24, true)
			ci.draw_arc(c, s * 0.55, 0, TAU, 28, color, s * 0.2, true)
			ci.draw_arc(c, s * 0.18, 0, TAU, 16, color, s * 0.12, true)
		"exit":
			ci.draw_polyline(PackedVector2Array([c + Vector2(s * 0.1, -s * 0.85), c + Vector2(-s * 0.75, -s * 0.85),
					c + Vector2(-s * 0.75, s * 0.85), c + Vector2(s * 0.1, s * 0.85)]), color, s * 0.13, true)
			ci.draw_line(c + Vector2(-s * 0.25, 0), c + Vector2(s * 0.8, 0), color, s * 0.15, true)
			ci.draw_colored_polygon(PackedVector2Array([c + Vector2(s * 0.95, 0), c + Vector2(s * 0.5, -s * 0.38),
					c + Vector2(s * 0.5, s * 0.38)]), color)
		"play":
			ci.draw_colored_polygon(PackedVector2Array([c + Vector2(-s * 0.55, -s * 0.8), c + Vector2(s * 0.85, 0),
					c + Vector2(-s * 0.55, s * 0.8)]), color)
		"back":
			ci.draw_polyline(PackedVector2Array([c + Vector2(s * 0.35, -s * 0.75), c + Vector2(-s * 0.4, 0),
					c + Vector2(s * 0.35, s * 0.75)]), color, s * 0.2, true)
		"chev_left":
			ci.draw_polyline(PackedVector2Array([c + Vector2(s * 0.3, -s * 0.7), c + Vector2(-s * 0.35, 0),
					c + Vector2(s * 0.3, s * 0.7)]), color, s * 0.2, true)
		"chev_right":
			ci.draw_polyline(PackedVector2Array([c + Vector2(-s * 0.3, -s * 0.7), c + Vector2(s * 0.35, 0),
					c + Vector2(-s * 0.3, s * 0.7)]), color, s * 0.2, true)
		_:
			_letter(ci, icon, c, s, color)


## The turn-signal tell-tale: a broad head on a short tail. Polygons have no
## anti-aliasing, so an outline in the same colour smooths the edges, and a
## thin dark rim keeps it readable over a lit (coloured) button.
static func _arrow(ci: CanvasItem, c: Vector2, s: float, color: Color, dir: float) -> void:
	var o := c + Vector2(-dir * s * 0.08, 0)
	var pts := PackedVector2Array([
		o + Vector2(dir * s * 0.98, 0), o + Vector2(-dir * s * 0.02, -s * 0.86), o + Vector2(-dir * s * 0.02, -s * 0.34),
		o + Vector2(-dir * s * 0.82, -s * 0.34), o + Vector2(-dir * s * 0.82, s * 0.34), o + Vector2(-dir * s * 0.02, s * 0.34),
		o + Vector2(-dir * s * 0.02, s * 0.86),
	])
	var ring := pts.duplicate()
	ring.append(pts[0])
	ci.draw_polyline(ring, Color(0, 0, 0, 0.35 * color.a), s * 0.16, true)
	ci.draw_colored_polygon(pts, color)
	ci.draw_polyline(ring, color, maxf(s * 0.05, 1.0), true)


static func _letter(ci: CanvasItem, text: String, c: Vector2, s: float, color: Color) -> void:
	var f := UITheme.bold()
	var fs := int(s * 1.1)
	var sz := f.get_string_size(text, HORIZONTAL_ALIGNMENT_LEFT, -1, fs)
	ci.draw_string(f, c + Vector2(-sz.x * 0.5, fs * 0.36), text, HORIZONTAL_ALIGNMENT_LEFT, -1, fs, color)
