class_name CourseData
extends RefCounted
## Parsed data/course.json plus the surface / kerb-distance grids.
##
## World frame (metres): X = scheme right, Z = scheme down, Y up. A yaw of 0
## faces -Z. See pipeline/course_def.py for how the file is produced.

const PATH := "res://data/course.json"

enum Surface { ASPHALT = 0, CONCRETE = 1, CURB = 2, GRASS = 3, OUTSIDE = 4 }

var raw: Dictionary = {}
var fence: PackedVector2Array
var islands: Array[PackedVector2Array] = []
var pads: Array[PackedVector2Array] = []
var route: PackedVector2Array
var route_s: PackedFloat32Array
var exercises: Array = []
var exercise_by_id: Dictionary = {}

var grid_origin := Vector2.ZERO
var grid_cell := 0.1
var grid_w := 0
var grid_h := 0
var surface_cells: PackedByteArray
var edge_cells: PackedByteArray

static var _cache: CourseData


static func get_default() -> CourseData:
	if _cache == null:
		_cache = CourseData.new()
		_cache.load_file(PATH)
	return _cache


func load_file(path: String) -> void:
	var text := FileAccess.get_file_as_string(path)
	var parsed: Variant = JSON.parse_string(text)
	if not parsed is Dictionary:
		push_error("course.json could not be parsed")
		return
	raw = parsed
	fence = poly(raw["fence"])
	for p in raw["islands"]:
		islands.append(poly(p))
	for p in raw["pads"]:
		pads.append(poly(p))
	route = poly(raw["route"]["points"])
	route_s = PackedFloat32Array()
	route_s.resize(route.size())
	var acc := 0.0
	for i in route.size():
		if i > 0:
			acc += route[i].distance_to(route[i - 1])
		route_s[i] = acc
	exercises = raw["exercises"]
	for e in exercises:
		exercise_by_id[e["id"]] = e
	var g: Dictionary = raw["grids"]
	grid_origin = Vector2(g["origin"][0], g["origin"][1])
	grid_cell = float(g["cell"])
	grid_w = int(g["width"])
	grid_h = int(g["height"])
	surface_cells = _load_grid(g["surface"])
	edge_cells = _load_grid(g["edge_distance"])


## Grids are zlib-compressed raw bytes (one per 0.1 m cell), see course_def.py.
func _load_grid(res_path: String) -> PackedByteArray:
	var packed := FileAccess.get_file_as_bytes(res_path)
	if packed.is_empty():
		push_error("grid missing: %s" % res_path)
		return PackedByteArray()
	var data := packed.decompress(grid_w * grid_h, FileAccess.COMPRESSION_DEFLATE)
	if data.size() != grid_w * grid_h:
		push_error("grid %s has %d bytes, expected %d" % [res_path, data.size(), grid_w * grid_h])
	return data


static func v2(p: Array) -> Vector2:
	return Vector2(float(p[0]), float(p[1]))


static func v3(p: Array, y := 0.0) -> Vector3:
	return Vector3(float(p[0]), y, float(p[1]))


static func poly(arr: Array) -> PackedVector2Array:
	var out := PackedVector2Array()
	for p in arr:
		out.append(Vector2(float(p[0]), float(p[1])))
	return out


## Yaw (radians) from a course heading in degrees.
static func yaw(deg: float) -> float:
	return deg_to_rad(deg)


## Unit forward vector (X/Z) for a yaw in degrees.
static func forward2(deg: float) -> Vector2:
	var r := deg_to_rad(deg)
	return Vector2(-sin(r), -cos(r))


func _cell(p: Vector2) -> int:
	var ix := int(floor((p.x - grid_origin.x) / grid_cell))
	var iz := int(floor((p.y - grid_origin.y) / grid_cell))
	if ix < 0 or iz < 0 or ix >= grid_w or iz >= grid_h:
		return -1
	return iz * grid_w + ix


func surface_at(p: Vector2) -> int:
	var i := _cell(p)
	return Surface.OUTSIDE if i < 0 or i >= surface_cells.size() else surface_cells[i]


## Distance (m) from p to the nearest kerb face (island outline), capped at 2.55 m.
func kerb_distance(p: Vector2) -> float:
	var i := _cell(p)
	return 2.55 if i < 0 or i >= edge_cells.size() else edge_cells[i] * 0.01


func exercise(id: String) -> Dictionary:
	return exercise_by_id.get(id, {})


## Route point / direction at arc length s.
func route_point(s: float) -> Vector2:
	var i := route_index(s)
	if i >= route.size() - 1:
		return route[route.size() - 1]
	var seg := route_s[i + 1] - route_s[i]
	var t := 0.0 if seg <= 0.0 else (s - route_s[i]) / seg
	return route[i].lerp(route[i + 1], clampf(t, 0.0, 1.0))


func route_dir(s: float) -> Vector2:
	var i := clampi(route_index(s), 0, route.size() - 2)
	return (route[i + 1] - route[i]).normalized()


func route_index(s: float) -> int:
	var lo := 0
	var hi := route_s.size() - 1
	while lo < hi:
		var mid := (lo + hi + 1) >> 1
		if route_s[mid] <= s:
			lo = mid
		else:
			hi = mid - 1
	return lo


func route_length() -> float:
	return route_s[route_s.size() - 1] if route_s.size() > 0 else 0.0
