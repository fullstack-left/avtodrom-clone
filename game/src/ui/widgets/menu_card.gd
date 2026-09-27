class_name MenuCard
extends Button
## Big menu tile: a glassy dark card with a soft shadow, an accent-coloured
## icon disc on the left and the title (and an optional small line under it).
## Lifts and lights up its border on hover, sinks when pressed.

var title := ""
var subtitle := ""
var icon_name := ""
var accent := UITheme.GO
## Filled accent background (the main action on a screen).
var primary := false
var _hover := 0.0


func _init(p_title := "", p_icon := "", p_accent := UITheme.GO, p_primary := false, p_subtitle := "") -> void:
	title = p_title
	icon_name = p_icon
	accent = p_accent
	primary = p_primary
	subtitle = p_subtitle
	flat = true
	focus_mode = Control.FOCUS_NONE
	text = ""
	custom_minimum_size = Vector2(0, 96)
	mouse_filter = Control.MOUSE_FILTER_STOP


func _process(delta: float) -> void:
	var target := 1.0 if is_hovered() and not disabled else 0.0
	if not is_equal_approx(_hover, target):
		_hover = move_toward(_hover, target, delta * 6.0)
		queue_redraw()


func _notification(what: int) -> void:
	if what == NOTIFICATION_RESIZED or what == NOTIFICATION_THEME_CHANGED:
		queue_redraw()


func _draw() -> void:
	var down := get_draw_mode() == DRAW_PRESSED or get_draw_mode() == DRAW_HOVER_PRESSED
	var lift := -3.0 * _hover + (2.0 if down else 0.0)
	var r := Rect2(Vector2(0, lift), size)
	var radius := int(minf(22.0, size.y * 0.3))
	# Shadow + body.
	var body := StyleBoxFlat.new()
	body.set_corner_radius_all(radius)
	body.anti_aliasing = true
	body.shadow_color = Color(0, 0, 0, 0.35 + 0.1 * _hover)
	body.shadow_size = int(10 + 6 * _hover)
	body.shadow_offset = Vector2(0, 4)
	if primary:
		body.bg_color = accent.darkened(0.18).lerp(accent, _hover * 0.6)
	else:
		body.bg_color = Color(0.1, 0.12, 0.15, 0.9).lerp(Color(0.14, 0.17, 0.21, 0.95), _hover)
	body.set_border_width_all(2)
	body.border_color = Color(1, 1, 1, 0.08).lerp(accent.lightened(0.2), _hover) if not primary \
			else accent.lightened(0.25 + 0.2 * _hover)
	draw_style_box(body, r)
	# Top sheen.
	var sheen := StyleBoxFlat.new()
	sheen.set_corner_radius_all(radius)
	sheen.corner_radius_bottom_left = 0
	sheen.corner_radius_bottom_right = 0
	sheen.bg_color = Color(1, 1, 1, 0.07 if primary else 0.035)
	sheen.anti_aliasing = true
	draw_style_box(sheen, Rect2(r.position, Vector2(r.size.x, r.size.y * 0.45)))
	# Icon disc.
	var d := minf(r.size.y * 0.62, 64.0)
	var ic := r.position + Vector2(r.size.y * 0.5 + 4.0, r.size.y * 0.5)
	if primary:
		draw_circle(ic, d * 0.5, Color(1, 1, 1, 0.18))
		Icons.draw(self, icon_name, ic, d * 0.3, Color.WHITE)
	else:
		draw_circle(ic, d * 0.5, Color(accent, 0.16 + 0.1 * _hover))
		Icons.draw(self, icon_name, ic, d * 0.3, accent.lightened(0.15))
	# Title (and subtitle).
	var f := UITheme.bold()
	var fs := int(clampf(r.size.y * 0.3, 22.0, 34.0))
	var tx := ic.x + d * 0.5 + 18.0
	var col := Color.WHITE if primary else UITheme.TEXT
	if subtitle == "":
		draw_string(f, Vector2(tx, ic.y + fs * 0.36), title, HORIZONTAL_ALIGNMENT_LEFT, r.end.x - tx - 16.0, fs, col)
	else:
		draw_string(f, Vector2(tx, ic.y - 2.0), title, HORIZONTAL_ALIGNMENT_LEFT, r.end.x - tx - 16.0, fs, col)
		var sf := UITheme.regular()
		var ss := int(fs * 0.58)
		draw_string(sf, Vector2(tx, ic.y + ss + 4.0), subtitle, HORIZONTAL_ALIGNMENT_LEFT, r.end.x - tx - 16.0, ss,
				Color(1, 1, 1, 0.8) if primary else UITheme.TEXT_DIM)
	# Chevron on the right.
	Icons.draw(self, "chev_right", Vector2(r.end.x - 26.0 + 3.0 * _hover, ic.y), 9.0,
			Color(1, 1, 1, 0.7) if primary else Color(1, 1, 1, 0.25 + 0.4 * _hover))


## Small round icon button with a caption under it (secondary actions).
class RoundAction:
	extends Button

	var caption := ""
	var icon_name := ""
	var _hover := 0.0

	func _init(p_caption := "", p_icon := "") -> void:
		caption = p_caption
		icon_name = p_icon
		flat = true
		focus_mode = Control.FOCUS_NONE
		text = ""
		custom_minimum_size = Vector2(92, 92)

	func _process(delta: float) -> void:
		var target := 1.0 if is_hovered() else 0.0
		if not is_equal_approx(_hover, target):
			_hover = move_toward(_hover, target, delta * 6.0)
			queue_redraw()

	func _draw() -> void:
		var c := Vector2(size.x * 0.5, 30.0)
		var down := get_draw_mode() == DRAW_PRESSED or get_draw_mode() == DRAW_HOVER_PRESSED
		var rr := 28.0 + (1.0 if down else 0.0)
		var sb := StyleBoxFlat.new()
		sb.set_corner_radius_all(int(rr))
		sb.bg_color = Color(0.1, 0.12, 0.15, 0.9).lerp(Color(0.16, 0.19, 0.24, 0.95), _hover)
		sb.set_border_width_all(2)
		sb.border_color = Color(1, 1, 1, 0.1 + 0.25 * _hover)
		sb.shadow_color = Color(0, 0, 0, 0.3)
		sb.shadow_size = 8
		sb.anti_aliasing = true
		draw_style_box(sb, Rect2(c - Vector2(rr, rr), Vector2(rr, rr) * 2.0))
		Icons.draw(self, icon_name, c, 12.0, UITheme.TEXT)
		var f := UITheme.regular()
		var fs := 16
		var w := f.get_string_size(caption, HORIZONTAL_ALIGNMENT_LEFT, -1, fs).x
		draw_string(f, Vector2(size.x * 0.5 - w * 0.5, 80.0), caption, HORIZONTAL_ALIGNMENT_LEFT, -1, fs,
				UITheme.TEXT if _hover > 0.5 else UITheme.TEXT_DIM)
