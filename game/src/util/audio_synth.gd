class_name AudioSynth
extends RefCounted
## Small procedural sound effects (no audio files needed): relay clicks for
## the indicators, the seat-belt chime, the emergency beeper, tyre squeal and
## scrub, and impact thumps. Generated once and cached.

const RATE := 32000

static var _cache := {}


## Frames of padding around the samples. The WAV mixer interpolates a few
## frames past the loop points and past the end of the data. On Android a big
## buffer (these loops are ~96 KB) ends right at a guard page, so those reads
## crashed the audio thread (SIGSEGV in AudioTrack, fault on a page boundary).
## Loops are padded with their own continuation, one-shots with silence.
const PAD := 64


static func _wav(samples: PackedFloat32Array, loop := false) -> AudioStreamWAV:
	var n := samples.size()
	var total := n + PAD * 2
	var data := PackedByteArray()
	data.resize(total * 2)
	for i in total:
		var k := i - PAD
		var v := 0.0
		if loop:
			v = samples[posmod(k, n)]
		elif k >= 0 and k < n:
			v = samples[k]
		data.encode_s16(i * 2, int(clampf(v, -1.0, 1.0) * 32767.0))
	var w := AudioStreamWAV.new()
	w.format = AudioStreamWAV.FORMAT_16_BITS
	w.mix_rate = RATE
	w.stereo = false
	w.data = data
	if loop:
		w.loop_mode = AudioStreamWAV.LOOP_FORWARD
		w.loop_begin = PAD
		w.loop_end = PAD + n
	return w


static func _rng() -> RandomNumberGenerator:
	var r := RandomNumberGenerator.new()
	r.seed = 1234
	return r


## Indicator relay: a sharp click with a short resonant body.
static func relay_click(pitch := 1.0) -> AudioStreamWAV:
	var key := "click%.2f" % pitch
	if _cache.has(key):
		return _cache[key]
	var n := int(RATE * 0.03)
	var s := PackedFloat32Array()
	s.resize(n)
	var r := _rng()
	for i in n:
		var t := float(i) / RATE
		var env := exp(-t * 380.0)
		s[i] = (r.randf_range(-1, 1) * 0.6 + sin(TAU * 1900.0 * pitch * t) * 0.5) * env * 0.8
	_cache[key] = _wav(s)
	return _cache[key]


## Two-tone chime (seat-belt reminder, exercise start).
static func chime(f1 := 880.0, f2 := 660.0) -> AudioStreamWAV:
	var key := "chime%d_%d" % [f1, f2]
	if _cache.has(key):
		return _cache[key]
	var n := int(RATE * 0.7)
	var s := PackedFloat32Array()
	s.resize(n)
	for i in n:
		var t := float(i) / RATE
		var f := f1 if t < 0.25 else f2
		var tt := t if t < 0.25 else t - 0.25
		var env := exp(-tt * 7.0) * minf(1.0, tt * 400.0)
		s[i] = (sin(TAU * f * t) * 0.6 + sin(TAU * f * 2.0 * t) * 0.15) * env * 0.5
	_cache[key] = _wav(s)
	return _cache[key]


## Continuous beeper for the emergency-stop signal (looping, 2.5 Hz pulses).
static func beeper() -> AudioStreamWAV:
	if _cache.has("beeper"):
		return _cache["beeper"]
	var n := int(RATE * 0.4)
	var s := PackedFloat32Array()
	s.resize(n)
	for i in n:
		var t := float(i) / RATE
		var gate := 1.0 if t < 0.22 else 0.0
		s[i] = sin(TAU * 1250.0 * t) * 0.45 * gate * minf(1.0, t * 300.0)
	_cache["beeper"] = _wav(s, true)
	return _cache["beeper"]


## Tyre squeal loop. Rubber stick-slipping at its grip limit screams at a
## pitch (~1 kHz) that wanders and chatters, so the loop is a tone with two
## harmonics whose pitch and loudness drift, plus a thin band of noise around
## it for the rubber. Broadband noise alone sounds like TV static, not tyres.
## Every modulation runs a whole number of cycles per loop: no seam.
static func squeal() -> AudioStreamWAV:
	if _cache.has("squeal"):
		return _cache["squeal"]
	var dur := 1.5
	var n := int(RATE * dur)
	var f0 := 940.0 # f0 * dur is whole, so the tone's phase closes the loop
	# [cycles per loop, depth, phase]
	var wander := [[2, 0.03, 0.4], [5, 0.018, 1.9], [13, 0.009, 3.1], [32, 0.005, 0.7]]
	var chatter := [[4, 0.22, 0.0], [10, 0.14, 2.2], [22, 0.08, 4.0]]
	# The modulation (all under 25 Hz) is updated every 16 samples, 2 kHz: the
	# same sound for a fraction of the work. n is a multiple of 16.
	var block := 16
	var tone := PackedFloat32Array()
	tone.resize(n)
	var ph := 0.0
	var step := 0.0
	var amp := 1.0
	for i in n:
		if i % block == 0:
			var u := TAU * float(i) / float(n)
			var dev := 0.0
			for m in wander:
				dev += m[1] * sin(u * m[0] + m[2])
			amp = 1.0
			for m in chatter:
				amp += m[1] * sin(u * m[0] + m[2])
			step = TAU * f0 * (1.0 + dev) / RATE
		tone[i] = (sin(ph) + 0.35 * sin(2.0 * ph + 0.3) + 0.12 * sin(3.0 * ph + 1.1)) * amp
		ph = fmod(ph + step, TAU)
	var xf := int(RATE * 0.1)
	var noise := PackedFloat32Array()
	noise.resize(n + xf)
	var r := _rng()
	var b1 := _Biquad.new()
	b1.bandpass(f0, 9.0, RATE)
	for i in n + xf:
		noise[i] = b1.tick(r.randf_range(-1.0, 1.0))
	noise = _normalize(_seamless(noise, xf), 1.0)
	tone = _normalize(tone, 1.0)
	for i in n:
		tone[i] += noise[i] * 0.3
	_cache["squeal"] = _wav(_normalize(tone, 0.8), true)
	return _cache["squeal"]


## Rubber scrub loop: the dull, gritty rasp of a locked or sliding tyre at
## low speed (handbrake turns, parking-speed skids).
static func scrub() -> AudioStreamWAV:
	if _cache.has("scrub"):
		return _cache["scrub"]
	var xf := int(RATE * 0.1)
	var n := int(RATE * 1.5) + xf
	var s := PackedFloat32Array()
	s.resize(n)
	var r := _rng()
	# Low and dark: anything bright in a noise loop reads as static.
	var body := _Biquad.new()
	body.bandpass(280.0, 1.4, RATE)
	var grit := _Biquad.new()
	grit.bandpass(700.0, 2.5, RATE)
	var grain := 0.0
	for i in n:
		var x := r.randf_range(-1.0, 1.0)
		# Sparse grains (~80/s) give the texture of rubber tearing over grit.
		if r.randf() < 80.0 / RATE:
			grain = r.randf_range(0.5, 1.0)
		grain *= 0.994
		s[i] = body.tick(x) * (0.7 + grain) + grit.tick(x * grain) * 0.3
	_cache["scrub"] = _wav(_seamless(_normalize(s, 0.8), xf), true)
	return _cache["scrub"]


## Scales a buffer so its peak is `peak`.
static func _normalize(s: PackedFloat32Array, peak: float) -> PackedFloat32Array:
	var m := 0.0
	for v in s:
		m = maxf(m, absf(v))
	if m > 0.0:
		for i in s.size():
			s[i] *= peak / m
	return s


## Turns a buffer into a click-free loop: the last `xf` samples are
## cross-faded (equal power) into the first `xf` and then dropped.
static func _seamless(s: PackedFloat32Array, xf: int) -> PackedFloat32Array:
	var n := s.size() - xf
	var out := s.slice(0, n)
	for i in xf:
		var a := float(i) / xf
		out[i] = s[i] * sqrt(a) + s[n + i] * sqrt(1.0 - a)
	return out


## RBJ band-pass biquad (constant 0 dB peak gain).
class _Biquad:
	var b0 := 0.0
	var b2 := 0.0
	var a1 := 0.0
	var a2 := 0.0
	var x1 := 0.0
	var x2 := 0.0
	var y1 := 0.0
	var y2 := 0.0

	func bandpass(freq: float, q: float, rate: float) -> void:
		var w := TAU * freq / rate
		var alpha := sin(w) / (2.0 * q)
		var a0 := 1.0 + alpha
		b0 = alpha / a0
		b2 = -alpha / a0
		a1 = -2.0 * cos(w) / a0
		a2 = (1.0 - alpha) / a0

	func tick(x: float) -> float:
		var y := b0 * x + b2 * x2 - a1 * y1 - a2 * y2
		x2 = x1
		x1 = x
		y2 = y1
		y1 = y
		return y


## Dull impact.
static func thump() -> AudioStreamWAV:
	if _cache.has("thump"):
		return _cache["thump"]
	var n := int(RATE * 0.35)
	var s := PackedFloat32Array()
	s.resize(n)
	var r := _rng()
	var lp := 0.0
	for i in n:
		var t := float(i) / RATE
		lp += (r.randf_range(-1, 1) - lp) * 0.05
		s[i] = (sin(TAU * 70.0 * t) * 0.8 + lp * 2.0) * exp(-t * 14.0)
	_cache["thump"] = _wav(s)
	return _cache["thump"]


## UI tick.
static func tick() -> AudioStreamWAV:
	if _cache.has("tick"):
		return _cache["tick"]
	var n := int(RATE * 0.04)
	var s := PackedFloat32Array()
	s.resize(n)
	for i in n:
		var t := float(i) / RATE
		s[i] = sin(TAU * 2600.0 * t) * exp(-t * 160.0) * 0.4
	_cache["tick"] = _wav(s)
	return _cache["tick"]
