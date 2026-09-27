extends Node
## Command-line helpers for automated visual checks (arguments after "--"):
##   --shots=<dir>        save a screenshot every --shot-every seconds
##   --shot-every=<s>     interval (default 2)
##   --quit-after-s=<s>   quit after this many seconds of game time
##   --menu-page=<name>   open a main-menu page (practice, rules, settings, history, help)
##   --perf               print frame/physics/render counters every 2 s, and a
##                        summary (average and worst frame) on exit
## Inactive unless one of them is given.

var shot_dir := ""
var every := 2.0
var quit_after := -1.0
var menu_page := ""
var perf := false
var _perf_t := 0.0
var _perf_frames := 0
var _perf_sum_ms := 0.0
var _perf_worst_ms := 0.0
var _perf_all: PackedFloat32Array = []
var _t := 0.0
var _shot_t := 0.0
var _n := 0


func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("--shots="):
			shot_dir = arg.substr(8)
			DirAccess.make_dir_recursive_absolute(shot_dir)
		elif arg.begins_with("--shot-every="):
			every = float(arg.substr(13))
		elif arg.begins_with("--quit-after-s="):
			quit_after = float(arg.substr(15))
		elif arg.begins_with("--menu-page="):
			menu_page = arg.substr(12)
		elif arg == "--perf":
			perf = true
			# Uncapped: the frame rate then shows how much work a frame is.
			DisplayServer.window_set_vsync_mode(DisplayServer.VSYNC_DISABLED)
			Engine.max_fps = 0
	set_process(shot_dir != "" or quit_after > 0.0 or perf)


func _process(delta: float) -> void:
	_t += delta
	if shot_dir != "":
		_shot_t += delta
		if _shot_t >= every:
			_shot_t = 0.0
			_n += 1
			get_viewport().get_texture().get_image().save_png(shot_dir.path_join("shot_%03d.png" % _n))
	if perf:
		_perf_sample(delta)
	if quit_after > 0.0 and _t > quit_after:
		if perf:
			_perf_summary()
		get_tree().quit()


func _perf_sample(delta: float) -> void:
	var ms := delta * 1000.0
	_perf_frames += 1
	_perf_sum_ms += ms
	_perf_worst_ms = maxf(_perf_worst_ms, ms)
	if _t > 3.0: # skip loading hitches for the summary
		_perf_all.append(ms)
	_perf_t += delta
	if _perf_t < 2.0:
		return
	print("PERF t=%5.1f fps=%5.1f frame_avg=%5.2fms worst=%5.2fms process=%5.2fms physics=%5.2fms draws=%d prims=%d objs=%d nodes=%d vram=%dMB" % [
			_t, Performance.get_monitor(Performance.TIME_FPS), _perf_sum_ms / _perf_frames, _perf_worst_ms,
			Performance.get_monitor(Performance.TIME_PROCESS) * 1000.0,
			Performance.get_monitor(Performance.TIME_PHYSICS_PROCESS) * 1000.0,
			Performance.get_monitor(Performance.RENDER_TOTAL_DRAW_CALLS_IN_FRAME),
			Performance.get_monitor(Performance.RENDER_TOTAL_PRIMITIVES_IN_FRAME),
			Performance.get_monitor(Performance.RENDER_TOTAL_OBJECTS_IN_FRAME),
			Performance.get_monitor(Performance.OBJECT_NODE_COUNT),
			Performance.get_monitor(Performance.RENDER_VIDEO_MEM_USED) / 1048576.0])
	_perf_t = 0.0
	_perf_frames = 0
	_perf_sum_ms = 0.0
	_perf_worst_ms = 0.0


func _perf_summary() -> void:
	if _perf_all.is_empty():
		return
	var sorted := _perf_all.duplicate()
	sorted.sort()
	var total := 0.0
	for ms in sorted:
		total += ms
	print("PERF_SUMMARY frames=%d avg=%.2fms p95=%.2fms p99=%.2fms worst=%.2fms" % [sorted.size(),
			total / sorted.size(), sorted[int(sorted.size() * 0.95)], sorted[int(sorted.size() * 0.99)],
			sorted[-1]])
