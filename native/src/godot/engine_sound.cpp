#include "engine_sound.h"

#include <godot_cpp/core/class_db.hpp>
#include <godot_cpp/core/math.hpp>
#include <godot_cpp/variant/packed_vector2_array.hpp>

#include <algorithm>
#include <cmath>

namespace godot {

namespace {

constexpr double kTwoPi = 6.283185307179586;
// Per-cylinder firing strength: small imbalances give a real engine its
// "character" (a perfectly even pulse train sounds like a buzzer).
constexpr double kCylinderGain[4] = { 1.0, 0.86, 0.95, 0.9 };

} // namespace

void EngineSound::Biquad::bandpass(double freq, double q, double rate) {
	const double w = kTwoPi * std::min(freq, rate * 0.45) / rate;
	const double alpha = std::sin(w) / (2.0 * q);
	const double a0 = 1.0 + alpha;
	b0 = alpha / a0;
	b1 = 0.0;
	b2 = -alpha / a0;
	a1 = -2.0 * std::cos(w) / a0;
	a2 = (1.0 - alpha) / a0;
}

void EngineSound::_bind_methods() {
	ClassDB::bind_method(D_METHOD("set_rpm", "rpm"), &EngineSound::set_rpm);
	ClassDB::bind_method(D_METHOD("get_rpm"), &EngineSound::get_rpm);
	ClassDB::bind_method(D_METHOD("set_load", "load"), &EngineSound::set_load);
	ClassDB::bind_method(D_METHOD("get_load"), &EngineSound::get_load);
	ClassDB::bind_method(D_METHOD("set_running", "running"), &EngineSound::set_running);
	ClassDB::bind_method(D_METHOD("get_running"), &EngineSound::get_running);
	ClassDB::bind_method(D_METHOD("set_cranking", "cranking"), &EngineSound::set_cranking);
	ClassDB::bind_method(D_METHOD("get_cranking"), &EngineSound::get_cranking);
	ClassDB::bind_method(D_METHOD("set_interior", "interior"), &EngineSound::set_interior);
	ClassDB::bind_method(D_METHOD("get_interior"), &EngineSound::get_interior);
	ClassDB::bind_method(D_METHOD("set_mix_rate", "rate"), &EngineSound::set_mix_rate);
	ClassDB::bind_method(D_METHOD("get_mix_rate"), &EngineSound::get_mix_rate);
	ADD_PROPERTY(PropertyInfo(Variant::FLOAT, "rpm"), "set_rpm", "get_rpm");
	ADD_PROPERTY(PropertyInfo(Variant::FLOAT, "load"), "set_load", "get_load");
	ADD_PROPERTY(PropertyInfo(Variant::BOOL, "running"), "set_running", "get_running");
	ADD_PROPERTY(PropertyInfo(Variant::BOOL, "cranking"), "set_cranking", "get_cranking");
	ADD_PROPERTY(PropertyInfo(Variant::FLOAT, "interior"), "set_interior", "get_interior");
	ADD_PROPERTY(PropertyInfo(Variant::FLOAT, "mix_rate"), "set_mix_rate", "get_mix_rate");
}

void EngineSound::_ready() {
	Ref<AudioStreamGenerator> gen;
	gen.instantiate();
	gen->set_mix_rate(mix_rate_);
	gen->set_buffer_length(0.12f);
	set_stream(gen);
	rate_ = mix_rate_;
	play();
	playback_ = get_stream_playback();
}

double EngineSound::noise() {
	rng_ ^= rng_ << 13;
	rng_ ^= rng_ >> 17;
	rng_ ^= rng_ << 5;
	return static_cast<double>(rng_) / 2147483648.0 - 1.0;
}

void EngineSound::_process(double) {
	if (playback_.is_null()) {
		playback_ = get_stream_playback();
		if (playback_.is_null()) {
			return;
		}
	}
	const int frames = playback_->get_frames_available();
	if (frames > 0) {
		render(frames);
	}
}

void EngineSound::render(int frames) {
	PackedVector2Array buf;
	buf.resize(frames);
	Vector2 *out = buf.ptrw();

	// Block-rate parameters.
	const double target_rpm = std::max(0.0, static_cast<double>(rpm_));
	const double target_level = (running_ || cranking_) ? 1.0 : 0.0;
	const double smooth = 1.0 - std::exp(-1.0 / (rate_ * 0.035));
	const double rpm_now = rpm_s_;
	const double ld = std::clamp(static_cast<double>(load_), 0.0, 1.0);
	// Exhaust boom, intake roar, panel rattle.
	res_[0].bandpass(70.0 + rpm_now * 0.012, 2.2, rate_);
	res_[1].bandpass(210.0 + rpm_now * 0.05, 3.0, rate_);
	res_[2].bandpass(620.0 + rpm_now * 0.09, 4.0, rate_);
	res_[3].bandpass(2100.0, 1.4, rate_);
	const double g_exh = 1.0;
	const double g_int = 0.35 + 0.65 * ld;
	const double g_pan = 0.12 + 0.35 * ld;
	const double g_noise = 0.02 + 0.10 * ld * std::min(1.0, rpm_now / 3000.0);
	const double cutoff = interior_ > 0.5 ? (900.0 + rpm_now * 0.35 + ld * 900.0) : (2500.0 + rpm_now * 0.6);
	const double lp_a = 1.0 - std::exp(-kTwoPi * cutoff / rate_);
	const double volume = 0.30 * (interior_ > 0.5 ? 0.85 : 1.0);

	for (int i = 0; i < frames; ++i) {
		rpm_s_ += (target_rpm - rpm_s_) * smooth;
		load_s_ += (ld - load_s_) * smooth;
		level_s_ += (target_level - level_s_) * smooth * 0.5;
		crank_s_ += ((cranking_ ? 1.0 : 0.0) - crank_s_) * smooth;

		const double rev_per_sample = rpm_s_ / 60.0 / rate_;
		const double prev = phase_;
		phase_ += rev_per_sample;
		// Four-stroke, four cylinders: two firings per crank revolution.
		double excitation = 0.0;
		if (std::floor(phase_ * 2.0) != std::floor(prev * 2.0)) {
			const double strength = 0.55 + 0.9 * load_s_;
			excitation = strength * kCylinderGain[cylinder_] * (1.0 + 0.08 * noise());
			cylinder_ = (cylinder_ + 1) & 3;
		}
		if (phase_ > 1e6) {
			phase_ -= std::floor(phase_);
		}
		const double firing_env = 0.5 + 0.5 * std::cos(kTwoPi * phase_ * 2.0);
		const double n = noise();

		double s = g_exh * res_[0].tick(excitation * 3.0) + g_int * res_[1].tick(excitation * 2.0) +
				g_pan * res_[2].tick(excitation + n * 0.03) + g_noise * res_[3].tick(n * firing_env);

		// Starter motor: whine plus the compression pulses it is fighting.
		if (crank_s_ > 0.001) {
			starter_phase_ += 190.0 / rate_;
			if (starter_phase_ > 1.0) {
				starter_phase_ -= 1.0;
			}
			const double whine = std::sin(kTwoPi * starter_phase_) * 0.25 + 0.08 * n;
			s = s * (1.0 - crank_s_) + crank_s_ * (whine * (0.6 + 0.4 * firing_env) + s * 0.8);
		}

		s = std::tanh(s * 1.6) * level_s_;
		lp_ += (s - lp_) * lp_a;
		// DC blocker.
		const double y = lp_ - dc_prev_ + 0.995 * dc_;
		dc_prev_ = lp_;
		dc_ = y;
		const float v = static_cast<float>(y * volume);
		out[i] = Vector2(v, v);
	}
	playback_->push_buffer(buf);
}

} // namespace godot
