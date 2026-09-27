// Head-less regression tests for the vehicle simulation core.
//
// Each test drives the real VehicleSim through a planar chassis and checks a
// behaviour a driving instructor would recognise: the engine idles, stalls
// when the clutch is dumped, the handbrake holds on the ramp, a hill start
// with clutch control succeeds, the car stops from 40 km/h in a plausible
// distance, the turning circle matches the manufacturer figure, and so on.
//
// Build & run:  cd native && python -m SCons tests=yes  &&  bin/sim_tests.exe
#include "planar_harness.h"

#include <cstdio>
#include <functional>
#include <string>
#include <vector>

using namespace avto;

namespace {

int g_failures = 0;
int g_checks = 0;

void check(bool ok, const std::string &what, double value) {
	g_checks++;
	if (!ok) {
		g_failures++;
	}
	std::printf("    [%s] %-58s %10.3f\n", ok ? " ok " : "FAIL", what.c_str(), value);
}

void check_range(double v, double lo, double hi, const std::string &what) {
	check(v >= lo && v <= hi, what + " in [" + std::to_string(lo).substr(0, 6) + ", " + std::to_string(hi).substr(0, 6) + "]", v);
}

PlanarHarness make(const VehicleParams &p, bool running) {
	PlanarHarness h(p);
	h.sim.reset(running);
	h.input.ignition = running;
	return h;
}

// Releases the clutch linearly from `from` to `to` over `seconds`.
void release_clutch(PlanarHarness &h, double seconds, double from = 1.0, double to = 0.0) {
	const double dt = 1.0 / 120.0;
	const int n = static_cast<int>(seconds / dt);
	for (int i = 0; i < n; ++i) {
		h.input.clutch = from + (to - from) * (static_cast<double>(i + 1) / n);
		h.step(dt);
	}
}

struct Test {
	const char *name;
	std::function<void()> fn;
};

} // namespace

int main() {
	const VehicleParams nexia = make_nexia2();
	const VehicleParams cobalt = make_cobalt_at();

	std::vector<Test> tests = {
		{ "Idle is stable in neutral",
				[&] {
					auto h = make(nexia, true);
					h.run(10.0);
					check_range(h.sim.telemetry().rpm, 800.0, 900.0, "rpm after 10 s");
					check(h.sim.telemetry().engine_running, "engine still running", 1.0);
					check_range(h.speed(), 0.0, 0.002, "car stays put (m/s)");
				} },
		{ "Starter cranks and the engine catches",
				[&] {
					auto h = make(nexia, false);
					h.input.ignition = true;
					h.input.starter = true;
					h.run(1.2);
					h.input.starter = false;
					check(h.sim.telemetry().engine_running, "running after 1.2 s of cranking", 1.0);
					h.run(3.0);
					check_range(h.sim.telemetry().rpm, 780.0, 950.0, "settles to idle");
				} },
		{ "Car at rest on the flat does not creep",
				[&] {
					auto h = make(nexia, true);
					h.input.brake = 0.0;
					h.run(20.0);
					check_range(std::fabs(h.z), 0.0, 0.01, "drift after 20 s (m)");
				} },
		{ "First gear, slow clutch release without gas: creeps, no stall",
				[&] {
					auto h = make(nexia, true);
					h.input.clutch = 1.0;
					check(h.sim.request_gear(1, 1.0), "engage 1st", 1.0);
					release_clutch(h, 1.0, 1.0, 0.60); // down to the bite point
					release_clutch(h, 4.0, 0.60, 0.40); // hold it slipping while the car picks up
					release_clutch(h, 1.0, 0.40, 0.0);
					h.run(4.0);
					check(h.sim.telemetry().engine_running, "engine running", 1.0);
					check_range(h.forward_speed() * 3.6, 4.5, 9.0, "creep speed (km/h)");
				} },
		{ "Dumping the clutch in 1st at idle stalls the engine",
				[&] {
					auto h = make(nexia, true);
					h.input.clutch = 1.0;
					h.sim.request_gear(1, 1.0);
					h.input.clutch = 0.0;
					h.run(2.0);
					check(!h.sim.telemetry().engine_running, "engine stalled", h.sim.telemetry().rpm);
					check(h.sim.telemetry().stall_count == 1, "one stall counted", h.sim.telemetry().stall_count);
				} },
		{ "Pulling away in 3rd gear stalls",
				[&] {
					auto h = make(nexia, true);
					h.input.clutch = 1.0;
					h.sim.request_gear(3, 1.0);
					h.input.throttle = 0.15;
					release_clutch(h, 2.0);
					h.run(3.0);
					check(!h.sim.telemetry().engine_running, "engine stalled", h.sim.telemetry().rpm);
				} },
		{ "Gear change without the clutch is refused",
				[&] {
					auto h = make(nexia, true);
					check(!h.sim.request_gear(1, 0.0), "refused", 0.0);
					check(h.sim.telemetry().grind_count == 1, "grind counted", 1.0);
				} },
		{ "Handbrake holds on a 16 % ramp",
				[&] {
					auto h = make(nexia, true);
					h.slope = 0.16;
					h.input.handbrake = 1.0;
					h.run(10.0);
					check_range(std::fabs(h.uphill_position()), 0.0, 0.03, "movement in 10 s (m)");
				} },
		{ "Foot brake holds on a 16 % ramp",
				[&] {
					auto h = make(nexia, true);
					h.slope = 0.16;
					h.input.brake = 0.35;
					h.run(10.0);
					check_range(std::fabs(h.uphill_position()), 0.0, 0.03, "movement in 10 s (m)");
				} },
		{ "Without brakes the car rolls back down a 12 % ramp",
				[&] {
					auto h = make(nexia, true);
					h.slope = 0.12;
					h.run(3.0);
					check(h.uphill_position() < -1.5, "rolled back more than 1.5 m", h.uphill_position());
				} },
		{ "Parked in 1st with the engine off holds on a 12 % ramp",
				[&] {
					auto h = make(nexia, false);
					h.input.ignition = false;
					h.input.clutch = 1.0;
					h.sim.request_gear(1, 1.0);
					h.input.clutch = 0.0;
					h.slope = 0.12;
					h.run(10.0);
					check_range(std::fabs(h.uphill_position()), 0.0, 0.05, "movement in 10 s (m)");
				} },
		{ "Hill start on 16 %: handbrake, clutch to bite, gas, release",
				[&] {
					auto h = make(nexia, true);
					h.slope = 0.16;
					h.input.handbrake = 1.0;
					h.input.clutch = 1.0;
					h.sim.request_gear(1, 1.0);
					h.input.throttle = 0.30;
					release_clutch(h, 1.5, 1.0, 0.55); // to the bite point: the nose lifts
					h.input.handbrake = 0.0;
					const double before = h.uphill_position();
					release_clutch(h, 2.5, 0.55, 0.35);
					release_clutch(h, 1.0, 0.35, 0.0);
					h.run(2.0);
					check(h.sim.telemetry().engine_running, "engine running", h.sim.telemetry().rpm);
					check(h.uphill_position() - before > 1.0, "moved up the ramp (m)", h.uphill_position() - before);
					check_range(h.forward_speed() * 3.6, 4.0, 20.0, "speed on the ramp (km/h)");
				} },
		{ "Hill start rollback when the handbrake is dropped too early",
				[&] {
					auto h = make(nexia, true);
					h.slope = 0.16;
					h.input.clutch = 1.0;
					h.sim.request_gear(1, 1.0);
					h.run(1.0);
					check(h.uphill_position() < -0.3, "rolls back > 0.3 m (penalty zone)", h.uphill_position());
				} },
		{ "0-40 km/h with a 1->2 shift",
				[&] {
					auto h = make(nexia, true);
					h.input.clutch = 1.0;
					h.sim.request_gear(1, 1.0);
					h.input.throttle = 0.55;
					release_clutch(h, 1.0, 1.0, 0.0);
					double t = 1.0;
					while (h.forward_speed() * 3.6 < 22.0 && t < 20.0) {
						h.step(1.0 / 120.0);
						t += 1.0 / 120.0;
					}
					h.input.throttle = 0.0;
					h.input.clutch = 1.0;
					h.run(0.3);
					check(h.sim.request_gear(2, 1.0), "shift to 2nd", 1.0);
					h.input.throttle = 0.6;
					release_clutch(h, 0.6);
					t += 0.9;
					while (h.forward_speed() * 3.6 < 40.0 && t < 30.0) {
						h.step(1.0 / 120.0);
						t += 1.0 / 120.0;
					}
					check_range(t, 3.5, 10.0, "time to 40 km/h (s)");
					check_range(h.sim.telemetry().rpm, 2200.0, 3600.0, "rpm at 40 km/h in 2nd");
				} },
		{ "Emergency stop from 40 km/h (ABS)",
				[&] {
					auto h = make(nexia, true);
					h.vz = -40.0 / 3.6;
					// Spin the wheels up to road speed first.
					h.input.clutch = 1.0;
					h.run(0.05);
					h.vz = -40.0 / 3.6;
					h.run(0.3);
					const double z0 = h.z;
					h.input.brake = 1.0;
					double t = 0.0;
					while (h.speed() > 0.05 && t < 10.0) {
						h.step(1.0 / 120.0);
						t += 1.0 / 120.0;
					}
					check_range(std::fabs(h.z - z0), 5.5, 9.5, "stopping distance (m)");
					check_range(std::fabs(h.x), 0.0, 0.2, "stays straight (m)");
				} },
		{ "Turning circle at full lock",
				[&] {
					auto h = make(nexia, true);
					h.input.clutch = 1.0;
					h.sim.request_gear(1, 1.0);
					h.input.steering_wheel_deg = 540.0;
					h.input.throttle = 0.12;
					h.run(1.0);
					release_clutch(h, 1.0, 1.0, 0.55);
					release_clutch(h, 3.0, 0.55, 0.0);
					h.run(4.0);
					double minx = 1e9, maxx = -1e9;
					const double dt = 1.0 / 120.0;
					for (int i = 0; i < 1800; ++i) {
						h.step(dt);
						// Track the outer (left) front wheel.
						const WheelParams &w = h.sim.params().wheels[0];
						const double bx = w.x, bz = w.z;
						const double wx = h.x + std::cos(h.yaw) * bx + std::sin(h.yaw) * bz;
						minx = std::min(minx, wx);
						maxx = std::max(maxx, wx);
					}
					check_range(maxx - minx, 9.0, 11.0, "outer-wheel turning circle diameter (m)");
					check(h.yaw < -1.0, "turned right (yaw decreasing)", h.yaw);
				} },
		{ "Straight-line coast at 40 km/h stays straight",
				[&] {
					auto h = make(nexia, true);
					h.vz = -40.0 / 3.6;
					h.input.clutch = 1.0;
					h.run(5.0);
					check_range(std::fabs(h.yaw_rate), 0.0, 1e-3, "yaw rate (rad/s)");
					check_range(std::fabs(h.x), 0.0, 0.05, "lateral drift (m)");
					check_range(h.forward_speed() * 3.6, 30.0, 40.0, "coasted speed (km/h)");
				} },
		{ "Auto-clutch: pulls away in 1st without gas and creeps",
				[&] {
					auto h = make(nexia, true);
					h.input.auto_clutch = true;
					check(h.sim.request_gear(1, 0.0, true), "engage 1st without pedal", 1.0);
					h.run(8.0);
					check(h.sim.telemetry().engine_running, "engine running", h.sim.telemetry().rpm);
					check_range(h.forward_speed() * 3.6, 4.0, 9.0, "creep speed (km/h)");
				} },
		{ "Auto-clutch: brake to a stop in 2nd does not stall",
				[&] {
					auto h = make(nexia, true);
					h.input.auto_clutch = true;
					h.sim.request_gear(1, 0.0, true);
					h.input.throttle = 0.5;
					h.run(3.0);
					h.sim.request_gear(2, 0.0, true);
					h.run(3.0);
					const double v = h.forward_speed() * 3.6;
					h.input.throttle = 0.0;
					h.input.brake = 0.6;
					h.run(6.0);
					check(v > 20.0, "reached > 20 km/h before braking", v);
					check_range(h.speed(), 0.0, 0.02, "stopped (m/s)");
					check(h.sim.telemetry().engine_running, "engine still running", h.sim.telemetry().rpm);
				} },
		{ "Auto-clutch: a full-throttle launch does not spin the front tyres",
				[&] {
					auto h = make(nexia, true);
					h.input.auto_clutch = true;
					h.sim.request_gear(1, 0.0, true);
					h.input.throttle = 1.0;
					double worst = 0.0;
					double t = 0.0;
					double t20 = -1.0;
					while (t < 4.0) {
						h.step(1.0 / 120.0);
						t += 1.0 / 120.0;
						worst = std::max(worst, (h.sim.telemetry().speed - h.forward_speed()) * 3.6);						if (t20 < 0.0 && h.forward_speed() * 3.6 >= 20.0) {
							t20 = t;
						}
					}
					check_range(worst, 0.0, 6.0, "worst speedometer lead over ground speed (km/h)");
					check_range(t20, 0.5, 3.0, "time to 20 km/h (s)");
				} },
		{ "Auto-clutch: hill start on 16 % with the handbrake",
				[&] {
					auto h = make(nexia, true);
					h.input.auto_clutch = true;
					h.slope = 0.16;
					h.input.handbrake = 1.0;
					h.sim.request_gear(1, 0.0, true);
					h.input.throttle = 0.35;
					h.run(1.0);
					h.input.handbrake = 0.0;
					const double before = h.uphill_position();
					h.run(4.0);
					check(h.sim.telemetry().engine_running, "engine running", h.sim.telemetry().rpm);
					check(h.uphill_position() - before > 2.0, "climbed (m)", h.uphill_position() - before);
				} },
		{ "Automatic: creeps in D at idle, brake holds it",
				[&] {
					auto h = make(cobalt, true);
					h.input.brake = 0.6;
					h.sim.request_gear(static_cast<int>(AutoSelector::Drive), 0.0);
					h.run(3.0);
					check_range(h.speed(), 0.0, 0.01, "held by the brake (m/s)");
					h.input.brake = 0.0;
					h.run(10.0);
					check(h.sim.telemetry().engine_running, "engine running", 1.0);
					check_range(h.forward_speed() * 3.6, 4.0, 14.0, "creep speed (km/h)");
				} },
		{ "Automatic: upshifts while accelerating",
				[&] {
					auto h = make(cobalt, true);
					h.sim.request_gear(static_cast<int>(AutoSelector::Drive), 0.0);
					h.input.throttle = 0.4;
					h.run(10.0);
					check(h.sim.telemetry().gear >= 3, "in 3rd or higher after 10 s", h.sim.telemetry().gear);
					check_range(h.forward_speed() * 3.6, 40.0, 90.0, "speed (km/h)");
				} },
		{ "Tyre slide speed: ~0 rolling, ~road speed with the handbrake locked",
				[&] {
					auto h = make(cobalt, true);
					h.sim.request_gear(static_cast<int>(AutoSelector::Drive), 0.0);
					h.input.throttle = 0.3;
					while (h.forward_speed() * 3.6 < 30.0) {
						h.step(1.0 / 120.0);
					}
					h.input.throttle = 0.0;
					h.run(0.5);
					double rolling = 0.0;
					for (int i = 0; i < 4; ++i) {
						rolling = std::max(rolling, h.sim.wheels()[static_cast<size_t>(i)].slide_speed);
					}
					check_range(rolling, 0.0, 0.2, "coasting, max slide (m/s)");
					h.input.handbrake = 1.0;
					h.run(0.5);
					const double v = h.forward_speed();
					check_range(h.sim.wheels()[2].slide_speed / v, 0.8, 1.2, "locked rear wheel slide / speed");
					check_range(h.sim.wheels()[0].slide_speed, 0.0, 0.5, "front wheel still rolling (m/s)");
				} },
		{ "Automatic: Park holds on a 16 % ramp",
				[&] {
					auto h = make(cobalt, true);
					h.slope = 0.16;
					h.run(10.0);
					check_range(std::fabs(h.uphill_position()), 0.0, 0.03, "movement (m)");
				} },
		{ "Automatic: reverse moves backwards",
				[&] {
					auto h = make(cobalt, true);
					h.sim.request_gear(static_cast<int>(AutoSelector::Reverse), 0.0);
					h.input.throttle = 0.1;
					h.run(5.0);
					check(h.forward_speed() < -0.5, "moving backwards (m/s)", h.forward_speed());
				} },
	};

	for (const Test &t : tests) {
		std::printf("%s\n", t.name);
		t.fn();
	}
	std::printf("\n%d checks, %d failed\n", g_checks, g_failures);
	return g_failures == 0 ? 0 : 1;
}
