extends SceneTree
## Bakes the procedural course into res://data/course_baked.scn so the game
## loads it in milliseconds instead of building ~100k triangles on the phone.
##   godot --headless --path game --script res://tests/bake_course.gd


func _set_owner_recursive(node: Node, owner_node: Node) -> void:
	for child in node.get_children():
		child.owner = owner_node
		_set_owner_recursive(child, owner_node)


func _initialize() -> void:
	var t0 := Time.get_ticks_msec()
	var builder := CourseBuilder.new()
	builder.name = "Course"
	root.add_child(builder)
	builder.build(CourseData.get_default(), 2)
	var t1 := Time.get_ticks_msec()
	_set_owner_recursive(builder, builder)
	var packed := PackedScene.new()
	var err := packed.pack(builder)
	if err != OK:
		push_error("pack failed: %s" % error_string(err))
		quit(1)
		return
	err = ResourceSaver.save(packed, CourseBuilder.BAKED_PATH, ResourceSaver.FLAG_COMPRESS)
	if err != OK:
		push_error("save failed: %s" % error_string(err))
		quit(1)
		return
	print("baked course: build %d ms, total %d ms -> %s" % [t1 - t0, Time.get_ticks_msec() - t0, CourseBuilder.BAKED_PATH])
	quit(0)
