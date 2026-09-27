class_name UITheme
extends RefCounted
## Visual language of the app: one font (Inter, covers O‘zbek lotin, кирилл
## and русский), a dark translucent surface for everything drawn over the
## road, and four signal colours used consistently (go / caution / stop / info).

const BG := Color(0.06, 0.08, 0.1)
const SURFACE := Color(0.09, 0.11, 0.14, 0.86)
const SURFACE_SOLID := Color(0.11, 0.13, 0.16)
const SURFACE_HI := Color(0.16, 0.19, 0.23, 0.92)
const LINE := Color(1, 1, 1, 0.12)
const TEXT := Color(0.95, 0.96, 0.97)
const TEXT_DIM := Color(0.72, 0.76, 0.8)
const TEXT_FAINT := Color(0.5, 0.55, 0.6)
const GO := Color(0.18, 0.72, 0.42)
const CAUTION := Color(0.96, 0.7, 0.1)
const STOP := Color(0.9, 0.28, 0.3)
const INFO := Color(0.3, 0.56, 0.96)
const INDICATOR := Color(0.25, 0.9, 0.35)

static var _theme: Theme
static var _font: FontVariation
static var _font_bold: FontVariation


static func font(weight := 500) -> Font:
	var base: Font = load("res://assets/fonts/Inter.ttf")
	var fv := FontVariation.new()
	fv.base_font = base
	fv.variation_opentype = {"wght": weight}
	return fv


static func regular() -> Font:
	if _font == null:
		_font = font(500) as FontVariation
	return _font


static func bold() -> Font:
	if _font_bold == null:
		_font_bold = font(750) as FontVariation
	return _font_bold


static func box(color: Color, radius := 18, border := 0, border_color := LINE, pad := 16) -> StyleBoxFlat:
	var s := StyleBoxFlat.new()
	s.bg_color = color
	s.set_corner_radius_all(radius)
	s.set_border_width_all(border)
	s.border_color = border_color
	s.content_margin_left = pad
	s.content_margin_right = pad
	s.content_margin_top = pad * 0.6
	s.content_margin_bottom = pad * 0.6
	s.anti_aliasing = true
	return s


static func get_theme() -> Theme:
	if _theme:
		return _theme
	var t := Theme.new()
	t.default_font = regular()
	t.default_font_size = 22
	t.set_color("font_color", "Label", TEXT)

	var btn_normal := box(SURFACE_HI, 16, 1, LINE, 22)
	var btn_hover := box(Color(0.2, 0.24, 0.29, 0.95), 16, 1, Color(1, 1, 1, 0.2), 22)
	var btn_pressed := box(Color(0.12, 0.45, 0.28, 0.95), 16, 1, GO, 22)
	var btn_disabled := box(Color(0.12, 0.13, 0.15, 0.7), 16, 0, LINE, 22)
	var btn_focus := box(Color(0, 0, 0, 0), 16, 2, INFO, 22)
	for cls in ["Button", "OptionButton", "CheckButton"]:
		t.set_stylebox("normal", cls, btn_normal)
		t.set_stylebox("hover", cls, btn_hover)
		t.set_stylebox("pressed", cls, btn_pressed)
		t.set_stylebox("disabled", cls, btn_disabled)
		t.set_stylebox("focus", cls, btn_focus)
		t.set_color("font_color", cls, TEXT)
		t.set_color("font_hover_color", cls, TEXT)
		t.set_color("font_pressed_color", cls, TEXT)
		t.set_color("font_disabled_color", cls, TEXT_FAINT)
		t.set_font_size("font_size", cls, 24)
	t.set_stylebox("normal", "CheckButton", box(Color(0, 0, 0, 0), 12, 0, LINE, 8))
	t.set_stylebox("hover", "CheckButton", box(Color(1, 1, 1, 0.04), 12, 0, LINE, 8))
	t.set_stylebox("pressed", "CheckButton", box(Color(0, 0, 0, 0), 12, 0, LINE, 8))

	t.set_stylebox("panel", "PanelContainer", box(SURFACE, 22, 1, LINE, 24))
	t.set_stylebox("panel", "Panel", box(SURFACE, 22, 1, LINE, 24))

	# Slider track: the stylebox's content margins give it its thickness.
	for pair in [["slider", Color(1, 1, 1, 0.16)], ["grabber_area", GO], ["grabber_area_highlight", GO.lightened(0.15)]]:
		var sb := box(pair[1], 6, 0, LINE, 0)
		sb.content_margin_top = 4
		sb.content_margin_bottom = 4
		t.set_stylebox(pair[0], "HSlider", sb)
	var g_img := Image.create(32, 32, false, Image.FORMAT_RGBA8)
	g_img.fill(Color(0, 0, 0, 0))
	for y in 32:
		for x in 32:
			var d := Vector2(x - 15.5, y - 15.5).length()
			if d < 14.5:
				g_img.set_pixel(x, y, Color(1, 1, 1, clampf(14.5 - d, 0.0, 1.0)))
	var g_tex := ImageTexture.create_from_image(g_img)
	t.set_icon("grabber", "HSlider", g_tex)
	t.set_icon("grabber_highlight", "HSlider", g_tex)
	# On/off switch drawn big enough for a thumb.
	t.set_icon("checked", "CheckButton", _switch_texture(true))
	t.set_icon("unchecked", "CheckButton", _switch_texture(false))
	t.set_icon("checked_disabled", "CheckButton", _switch_texture(true))
	t.set_icon("unchecked_disabled", "CheckButton", _switch_texture(false))

	t.set_stylebox("panel", "PopupMenu", box(SURFACE_SOLID, 14, 1, LINE, 10))
	t.set_font_size("font_size", "PopupMenu", 24)
	t.set_constant("v_separation", "PopupMenu", 18)

	t.set_stylebox("scroll", "VScrollBar", box(Color(1, 1, 1, 0.05), 6, 0, LINE, 0))
	t.set_stylebox("grabber", "VScrollBar", box(Color(1, 1, 1, 0.25), 6, 0, LINE, 0))
	t.set_stylebox("grabber_highlight", "VScrollBar", box(Color(1, 1, 1, 0.35), 6, 0, LINE, 0))
	t.set_stylebox("grabber_pressed", "VScrollBar", box(Color(1, 1, 1, 0.45), 6, 0, LINE, 0))
	_theme = t
	return t


static func _switch_texture(on: bool) -> ImageTexture:
	var w := 72
	var h := 40
	var img := Image.create(w, h, false, Image.FORMAT_RGBA8)
	img.fill(Color(0, 0, 0, 0))
	var track := GO if on else Color(1, 1, 1, 0.22)
	var r := h * 0.5
	var knob_x := w - r if on else r
	for y in h:
		for x in w:
			var p := Vector2(x + 0.5, y + 0.5)
			var cx := clampf(p.x, r, w - r)
			var d := p.distance_to(Vector2(cx, r))
			var a := clampf(r - d, 0.0, 1.0)
			var col := Color(track, track.a * a)
			var dk := p.distance_to(Vector2(knob_x, r))
			var ak := clampf(r - 4.0 - dk, 0.0, 1.0)
			if ak > 0.0:
				col = col.blend(Color(1, 1, 1, ak))
			img.set_pixel(x, y, col)
	return ImageTexture.create_from_image(img)


static func label(text: String, size := 22, color := TEXT, bold_font := false) -> Label:
	var l := Label.new()
	l.text = text
	l.add_theme_font_size_override("font_size", size)
	l.add_theme_color_override("font_color", color)
	if bold_font:
		l.add_theme_font_override("font", bold())
	return l


static func button(text: String, size := 24, min_height := 76) -> Button:
	var b := Button.new()
	b.text = text
	b.add_theme_font_size_override("font_size", size)
	b.custom_minimum_size = Vector2(0, min_height)
	b.focus_mode = Control.FOCUS_NONE
	return b


static func primary_button(text: String, size := 26, min_height := 84) -> Button:
	var b := button(text, size, min_height)
	b.add_theme_font_override("font", bold())
	b.add_theme_stylebox_override("normal", box(GO.darkened(0.1), 18, 0, LINE, 26))
	b.add_theme_stylebox_override("hover", box(GO, 18, 0, LINE, 26))
	b.add_theme_stylebox_override("pressed", box(GO.darkened(0.3), 18, 0, LINE, 26))
	return b


## Seconds -> "m:ss".
static func clock(t: float) -> String:
	var s := int(t)
	return "%d:%02d" % [s / 60, s % 60]


## Screen-edge insets for notches / rounded corners (logical pixels).
static func safe_margins(viewport: Viewport) -> Dictionary:
	var out := {"left": 0.0, "top": 0.0, "right": 0.0, "bottom": 0.0}
	if not OS.has_feature("mobile"):
		return out
	var safe := DisplayServer.get_display_safe_area()
	var screen := DisplayServer.screen_get_size()
	if safe.size.x <= 0 or screen.x <= 0:
		return out
	var scale := viewport.get_visible_rect().size.x / float(screen.x)
	out["left"] = safe.position.x * scale
	out["top"] = safe.position.y * scale
	out["right"] = (screen.x - safe.end.x) * scale
	out["bottom"] = (screen.y - safe.end.y) * scale
	return out
