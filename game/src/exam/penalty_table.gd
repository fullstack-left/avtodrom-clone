class_name PenaltyTable
extends RefCounted
## The official avtodrom penalty table (data/penalties.json, 32 items).

const PATH := "res://data/penalties.json"

static var _items := {}
static var _groups: Array = []
static var pass_below := 100


static func _load() -> void:
	if not _items.is_empty():
		return
	var parsed: Variant = JSON.parse_string(FileAccess.get_file_as_string(PATH))
	if not parsed is Dictionary:
		push_error("penalties.json could not be parsed")
		return
	pass_below = int(parsed.get("pass_below", 100))
	_groups = parsed["groups"]
	for g in _groups:
		for it in g["items"]:
			var item: Dictionary = it.duplicate()
			item["level"] = g["level"]
			_items[int(it["no"])] = item


static func item(no: int) -> Dictionary:
	_load()
	return _items.get(no, {})


static func points(no: int) -> int:
	return int(item(no).get("points", 0))


static func text(no: int) -> String:
	return Loc.pick(item(no).get("text", {}))


## A few words for the HUD notices and the result protocol; the official
## wording (text()) is in the penalty table screen.
static func short_text(no: int) -> String:
	var key := "pen.%d" % no
	var s := Loc.t(key)
	return s if s != key else text(no)


static func groups() -> Array:
	_load()
	return _groups
