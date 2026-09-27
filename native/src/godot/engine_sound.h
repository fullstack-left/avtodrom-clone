// EngineSound — procedural four-cylinder engine audio.
//
// No samples: each cylinder firing is an impulse that rings through a few
// resonators standing in for the exhaust, intake and body panels, plus a
// little combustion noise. Pitch follows rpm exactly (so the sound tells the
// learner when to change gear or that the engine is about to stall), timbre
// and loudness follow engine load. The starter motor has its own whine.
#pragma once

#include <godot_cpp/classes/audio_stream_generator.hpp>
#include <godot_cpp/classes/audio_stream_generator_playback.hpp>
#include <godot_cpp/classes/audio_stream_player.hpp>

#include <array>
#include <cstdint>

namespace godot {

class EngineSound : public AudioStreamPlayer {
	GDCLASS(EngineSound, AudioStreamPlayer)

public:
	EngineSound() = default;

	void _ready() override;
	void _process(double p_delta) override;

	void set_rpm(float v) { rpm_ = v; }
	float get_rpm() const { return rpm_; }
	void set_load(float v) { load_ = v; }
	float get_load() const { return load_; }
	void set_running(bool v) { running_ = v; }
	bool get_running() const { return running_; }
	void set_cranking(bool v) { cranking_ = v; }
	bool get_cranking() const { return cranking_; }
	void set_interior(float v) { interior_ = v; }
	float get_interior() const { return interior_; }
	void set_mix_rate(float v) { mix_rate_ = v; }
	float get_mix_rate() const { return mix_rate_; }

protected:
	static void _bind_methods();

private:
	struct Biquad {
		double b0 = 0, b1 = 0, b2 = 0, a1 = 0, a2 = 0;
		double z1 = 0, z2 = 0;
		void bandpass(double freq, double q, double rate);
		double tick(double x) {
			const double y = b0 * x + z1;
			z1 = b1 * x - a1 * y + z2;
			z2 = b2 * x - a2 * y;
			return y;
		}
	};

	double noise();
	void render(int frames);

	float rpm_ = 0.0f;
	float load_ = 0.0f;
	bool running_ = false;
	bool cranking_ = false;
	float interior_ = 1.0f; // 1 = heard from the driver's seat (muffled), 0 = outside
	float mix_rate_ = 32000.0f;

	Ref<AudioStreamGeneratorPlayback> playback_;
	double rate_ = 32000.0;
	double rpm_s_ = 0.0;
	double load_s_ = 0.0;
	double level_s_ = 0.0;
	double crank_s_ = 0.0;
	double phase_ = 0.0; // crankshaft revolutions (fractional part used)
	double starter_phase_ = 0.0;
	int cylinder_ = 0;
	uint32_t rng_ = 0x2468ace1u;
	std::array<Biquad, 4> res_{};
	double lp_ = 0.0;
	double dc_ = 0.0;
	double dc_prev_ = 0.0;
};

} // namespace godot
