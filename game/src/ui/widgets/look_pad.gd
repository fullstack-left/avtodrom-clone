class_name LookPad
extends Control
## Transparent layer under all HUD controls. One finger (or the mouse, which
## the project turns into touches) drags the camera round; two fingers pinch
## to zoom; the mouse wheel zooms too.

signal dragged(delta: Vector2)
signal released
signal zoomed(factor: float)

var _touches := {} # finger index -> last position


func _init() -> void:
	mouse_filter = Control.MOUSE_FILTER_STOP
	focus_mode = Control.FOCUS_NONE


func _gui_input(event: InputEvent) -> void:
	if event is InputEventScreenTouch:
		if event.pressed:
			_touches[event.index] = event.position
		elif _touches.has(event.index):
			_touches.erase(event.index)
			if _touches.is_empty():
				released.emit()
		accept_event()
	elif event is InputEventScreenDrag:
		if not _touches.has(event.index):
			return
		if _touches.size() >= 2:
			var other: int = -1
			for k in _touches:
				if k != event.index:
					other = k
					break
			var before: float = (_touches[event.index] as Vector2).distance_to(_touches[other])
			var after: float = event.position.distance_to(_touches[other])
			if before > 20.0 and after > 20.0:
				zoomed.emit(before / after) # fingers apart -> closer
		else:
			dragged.emit(event.relative)
		_touches[event.index] = event.position
		accept_event()
	elif event is InputEventMouseButton and event.pressed:
		if event.button_index == MOUSE_BUTTON_WHEEL_UP:
			zoomed.emit(0.9)
			accept_event()
		elif event.button_index == MOUSE_BUTTON_WHEEL_DOWN:
			zoomed.emit(1.1)
			accept_event()


func _notification(what: int) -> void:
	# A finger lifted outside the window must not leave a stuck drag behind.
	if what == NOTIFICATION_MOUSE_EXIT_SELF or what == NOTIFICATION_VISIBILITY_CHANGED:
		if not _touches.is_empty() and not is_visible_in_tree():
			_touches.clear()
			released.emit()
