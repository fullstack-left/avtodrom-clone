class_name PauseMenu
extends CanvasLayer
## Pause overlay: resume, restart, quick settings, back to the menu (with a
## warning that leaving a running exam costs 100 points — rule №26).

signal resume
signal restart
signal quit_to_menu
signal edit_layout

var _panel: PanelContainer
var _warn: Label
var _restart: Button
var _layout_btn: Button
var _settings: SettingsPanel


func _init() -> void:
	layer = 20
	process_mode = Node.PROCESS_MODE_ALWAYS
	visible = false


func _ready() -> void:
	var dim := ColorRect.new()
	dim.color = Color(0, 0, 0, 0.55)
	dim.set_anchors_preset(Control.PRESET_FULL_RECT)
	add_child(dim)
	var center := CenterContainer.new()
	center.set_anchors_preset(Control.PRESET_FULL_RECT)
	center.theme = UITheme.get_theme()
	add_child(center)
	_panel = PanelContainer.new()
	_panel.custom_minimum_size = Vector2(460, 0)
	center.add_child(_panel)
	var v := VBoxContainer.new()
	v.add_theme_constant_override("separation", 14)
	_panel.add_child(v)
	var title := UITheme.label(Loc.t("pause.title"), 34, UITheme.TEXT, true)
	title.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	v.add_child(title)
	var b_resume := UITheme.primary_button(Loc.t("pause.resume"))
	b_resume.pressed.connect(func() -> void: resume.emit())
	v.add_child(b_resume)
	_restart = UITheme.button(Loc.t("pause.restart"))
	_restart.pressed.connect(func() -> void: restart.emit())
	v.add_child(_restart)
	var b_settings := UITheme.button(Loc.t("menu.settings"))
	b_settings.pressed.connect(_open_settings)
	v.add_child(b_settings)
	_layout_btn = UITheme.button(Loc.t("pause.layout"))
	_layout_btn.pressed.connect(func() -> void: edit_layout.emit())
	v.add_child(_layout_btn)
	var b_menu := UITheme.button(Loc.t("pause.menu"))
	b_menu.pressed.connect(func() -> void: quit_to_menu.emit())
	v.add_child(b_menu)
	_warn = UITheme.label(Loc.t("pause.warn_exam"), 18, UITheme.STOP)
	_warn.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_warn.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	v.add_child(_warn)


## During a real exam there is no "start again": leaving counts as a failed
## attempt (№26), like walking away from the examiner.
func open(exam_running: bool, touch_controls := false) -> void:
	visible = true
	_warn.visible = exam_running
	_restart.visible = not exam_running
	_layout_btn.visible = touch_controls
	_panel.visible = true


func close() -> void:
	visible = false
	if _settings:
		_settings.queue_free()
		_settings = null


## Android "back" while the menu is open: closes the settings page if it is
## showing and returns true; false means the caller should resume.
func back() -> bool:
	if _settings:
		_settings.queue_free()
		_settings = null
		_panel.visible = true
		return true
	return false


func _open_settings() -> void:
	_panel.visible = false
	_settings = SettingsPanel.new()
	_settings.closed.connect(func() -> void:
		_settings.queue_free()
		_settings = null
		_panel.visible = true)
	add_child(_settings)


func _unhandled_input(event: InputEvent) -> void:
	if visible and event is InputEventKey and event.pressed and event.keycode == KEY_ESCAPE:
		get_viewport().set_input_as_handled()
		resume.emit()
