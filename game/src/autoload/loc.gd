extends Node
## Tiny localisation layer: data/i18n.json maps key -> {uz_latn, uz_cyrl, ru}.
##
## Godot's TranslationServer would work too, but one JSON file that
## translators can edit side by side is easier to keep consistent across the
## three scripts (O'zbek lotin, Ўзбек кирилл, Русский).

signal language_changed

const PATH := "res://data/i18n.json"
const LANGUAGES := ["uz_latn", "uz_cyrl", "ru"]
const LANGUAGE_NAMES := {"uz_latn": "O‘zbekcha", "uz_cyrl": "Ўзбекча", "ru": "Русский"}

var language: String = "uz_latn"
var _strings: Dictionary = {}


func _ready() -> void:
	var text := FileAccess.get_file_as_string(PATH)
	var data: Variant = JSON.parse_string(text)
	if data is Dictionary:
		_strings = data
	else:
		push_error("i18n.json could not be parsed")
	language = str(Settings.get_value("language"))
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("--lang="):
			language = arg.substr(7) # screenshots in every language, not saved
	if language not in LANGUAGES:
		language = "uz_latn"
	Settings.changed.connect(_on_setting_changed)


func _on_setting_changed(key: String) -> void:
	if key == "language":
		language = str(Settings.get_value("language"))
		language_changed.emit()


## Translates `key`; `args` fills {0}, {1}, ... placeholders.
func t(key: String, args: Array = []) -> String:
	var entry: Variant = _strings.get(key)
	var s: String
	if entry is Dictionary:
		s = str(entry.get(language, entry.get("uz_latn", key)))
	else:
		s = key
	for i in args.size():
		s = s.replace("{%d}" % i, str(args[i]))
	return s


## Picks the current language out of a {uz_latn, uz_cyrl, ru} dictionary
## (used for texts stored in data files, e.g. the penalty table).
func pick(d: Variant) -> String:
	if d is Dictionary:
		var s := str(d.get(language, d.get("uz_latn", "")))
		return uz_typography(s) if language == "uz_latn" or not d.has(language) else s
	return str(d)


## Data files type the Uzbek Latin letters oʻ/gʻ and the tutuq belgisi with a
## plain ASCII apostrophe; the UI strings use the proper marks, so match them.
static func uz_typography(s: String) -> String:
	for pair in [["o'", "o‘"], ["O'", "O‘"], ["g'", "g‘"], ["G'", "G‘"]]:
		s = s.replace(pair[0], pair[1])
	return s.replace("'", "’")
