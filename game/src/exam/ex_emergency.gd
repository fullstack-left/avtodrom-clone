class_name ExEmergency
extends Exercise
## №11 emergency stop. At a random point a sound + light signal comes on in
## the cabin: stop within 2 s, switch the hazard lights on within 3 s of
## stopping; when the signal goes out, switch them off before moving on.
##   penalties: 19 (not stopped within 2 s), 20 (hazards not on within 3 s),
##              21 (moved off with the hazards still on)

enum Phase { CRUISE, SIGNAL, STOPPED, RELEASED }

var phase: Phase = Phase.CRUISE
var trigger_s := 0.0
var signal_t := 0.0
var stop_t := 0.0
var hazard_ok := false
var stop_flagged := false
var hazard_flagged := false
var release_t := 0.0


func _on_begin() -> void:
	var a := float(def.get("trigger_s0", s0))
	var b := float(def.get("trigger_s1", s1))
	trigger_s = director.rng.randf_range(a, b)
	set_hint("hint.emergency_ready")


func _tick(dt: float, p: CarProbe) -> void:
	match phase:
		Phase.CRUISE:
			if director.tracker.s >= trigger_s and p.speed > 1.0:
				phase = Phase.SIGNAL
				signal_t = 0.0
				director.set_emergency_signal(true)
				set_hint("hint.emergency_stop")
		Phase.SIGNAL:
			signal_t += dt
			if p.stopped:
				phase = Phase.STOPPED
				stop_t = 0.0
				if signal_t > float(def.get("stop_within", 2.0)) + 0.35 and not stop_flagged:
					stop_flagged = true
					penalize(19)
			elif signal_t > 8.0 and not stop_flagged:
				stop_flagged = true
				penalize(19)
		Phase.STOPPED:
			stop_t += dt
			if director.car.hazard and not hazard_ok:
				hazard_ok = true
				stop_t = minf(stop_t, float(def.get("hazard_within", 3.0)))
			if not hazard_ok and stop_t > float(def.get("hazard_within", 3.0)) and not hazard_flagged:
				hazard_flagged = true
				penalize(20)
			if not hazard_ok:
				set_hint("hint.emergency_hazard")
			else:
				set_hint("hint.emergency_wait")
			var hold := float(def.get("signal_hold", 5.0))
			if (hazard_ok or hazard_flagged) and stop_t > hold:
				director.set_emergency_signal(false)
				phase = Phase.RELEASED
				release_t = 0.0
			if not p.stopped and p.travelled > 0.0 and absf(p.speed) > 0.5:
				# Drove off during the signal.
				director.set_emergency_signal(false)
				phase = Phase.RELEASED
		Phase.RELEASED:
			release_t += dt
			set_hint("hint.emergency_go" if director.car.hazard else "hint.go")
			if absf(p.speed) > 0.6:
				if director.car.hazard:
					penalize(21)
				performed = true
				finish()


func passed_without_finish() -> void:
	director.set_emergency_signal(false)
	performed = phase != Phase.CRUISE
	finish()
