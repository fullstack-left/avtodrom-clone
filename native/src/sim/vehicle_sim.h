// VehicleSim: everything below the chassis — suspension springs, tyres,
// wheels, brakes, clutch / torque converter, gearbox, engine.
//
// The host (Godot node or test harness) owns the rigid chassis. Every physics
// tick it measures each wheel's suspension length and contact-point velocity,
// calls step(), and applies the returned forces to the chassis at the contact
// points. Internally step() sub-steps the fast rotational dynamics (wheels,
// engine) at `substeps` × the tick rate.
//
// Rotating parts are coupled through a small projected Gauss-Seidel solver
// (one "body" per rotating inertia, one bounded constraint per clutch, brake
// and engine-friction element). Friction elements that are able to hold —
// a brake on a slope, an engaged clutch, a stopped engine with its compression
// — therefore stick exactly instead of chattering around zero, which is what
// makes hill starts and clutch control feel right.
#pragma once

#include "tire.h"
#include "vehicle_params.h"

#include <array>
#include <cstdint>

namespace avto {

struct DriverInput {
	double throttle = 0.0; // 0..1 accelerator pedal
	double brake = 0.0; // 0..1 brake pedal
	double clutch = 0.0; // 0..1 clutch pedal (1 = floored = disengaged)
	double handbrake = 0.0; // 0..1
	double steering_wheel_deg = 0.0; // + = clockwise = turn right
	bool ignition = false; // key at ON
	bool starter = false; // key held at START
	// Manual gearbox only: the clutch pedal is operated by the simulation
	// (touch-screen friendly). Gear changes then never need the pedal.
	bool auto_clutch = false;
};

struct WheelContact {
	bool contact = false;
	double spring_length = 0.0; // mount -> wheel centre along the suspension axis
	double spring_velocity = 0.0; // d(length)/dt, negative while compressing
	double vx = 0.0; // contact-point velocity along the wheel heading (m/s)
	double vy = 0.0; // contact-point velocity to the wheel's left (m/s)
	double grip = 1.0; // surface friction multiplier
	double rolling_resistance = 1.0; // surface rolling-resistance multiplier
};

struct WheelOutput {
	bool contact = false;
	double fz = 0.0; // suspension force along the suspension axis (N)
	double fx = 0.0; // tyre force along the wheel heading (N)
	double fy = 0.0; // tyre force to the wheel's left (N)
	double steer = 0.0; // road-wheel angle, rad, + = right
	double omega = 0.0; // rad/s, + = rolling forward
	double rotation = 0.0; // accumulated spin angle, rad
	double compression = 0.0; // 0 = full droop .. 1 = bump stop
	double slip_long = 0.0;
	double slip_lat = 0.0;
	bool sliding = false;
	double slide_speed = 0.0; // m/s the contact patch rubs over the road (0 when rolling freely)
	double brake_torque = 0.0; // N·m actually applied (for brake-light / ABS display)
};

struct VehicleTelemetry {
	double rpm = 0.0;
	double speed = 0.0; // m/s from the driven wheels (what the speedometer shows)
	double engine_torque = 0.0; // N·m net combustion torque
	double clutch_torque = 0.0; // N·m transmitted
	double clutch_engagement = 0.0; // 0..1 (effective, after auto-clutch)
	double throttle_opening = 0.0;
	bool engine_running = false;
	bool engine_cranking = false;
	bool abs_active = false;
	bool in_shift = false;
	int gear = 0; // manual: -1/0/1..N; automatic: current internal gear, 0 in P/N, -1 in R
	int selector = 0; // automatic selector (AutoSelector as int); manual: same as gear
	uint32_t stall_count = 0;
	uint32_t grind_count = 0; // rejected gear changes (manual, clutch not pressed)
	double odometer = 0.0; // m
};

class VehicleSim {
public:
	explicit VehicleSim(const VehicleParams &params);

	const VehicleParams &params() const { return params_; }
	void reset(bool engine_running);

	// Manual: gear -1..N. Automatic: selector as AutoSelector int.
	// Returns false (and counts a grind) when a manual shift is attempted
	// without the clutch pressed.
	bool request_gear(int gear_or_selector, double clutch_pedal, bool auto_clutch = false);

	void step(double dt, const DriverInput &input, const std::array<WheelContact, 4> &contacts);

	const std::array<WheelOutput, 4> &wheels() const { return out_; }
	const VehicleTelemetry &telemetry() const { return tel_; }

	// Static corner loads (N) implied by mass and centre of mass.
	double static_corner_load(int wheel) const { return static_load_[static_cast<size_t>(wheel)]; }
	// Spring free length (mount -> wheel centre at zero load).
	double free_length(int wheel) const { return free_length_[static_cast<size_t>(wheel)]; }
	double min_length(int wheel) const;
	double max_length(int wheel) const;
	double total_ratio() const; // signed engine-to-wheel ratio of the engaged gear (0 = none)

private:
	struct Constraint {
		int a = -1, b = -1, c = -1; // body indices (-1 = unused)
		double ja = 0.0, jb = 0.0, jc = 0.0; // Jacobian
		double lo = 0.0, hi = 0.0; // torque bounds (N·m)
		double eff_mass = 0.0;
		double impulse = 0.0;
	};

	void update_steering(double dt, double steering_wheel_deg);
	void update_suspension(const std::array<WheelContact, 4> &contacts);
	void update_automatic(double dt, double throttle, double speed_kmh);
	double engine_combustion_torque(double dt, double pedal);
	double clutch_engagement_from_pedal(double pedal) const;
	void update_auto_clutch(double dt, const DriverInput &in, const std::array<WheelContact, 4> &contacts);
	void substep(double h, const DriverInput &in, const std::array<WheelContact, 4> &contacts);
	void add_constraint(int a, double ja, int b, double jb, int c, double jc, double lo, double hi);
	void solve_constraints(double h, int iterations);

	VehicleParams params_;
	TireModel tire_model_;
	std::array<TireState, 4> tire_{};
	std::array<WheelOutput, 4> out_{};
	std::array<double, 4> static_load_{};
	std::array<double, 4> free_length_{};
	std::array<double, 4> fz_{};
	std::array<double, 4> abs_factor_{ { 1.0, 1.0, 1.0, 1.0 } };
	std::array<double, 4> fx_acc_{};
	std::array<double, 4> fy_acc_{};
	std::array<double, 4> brake_acc_{};
	VehicleTelemetry tel_{};

	// Rotating bodies: 0 engine, 1 turbine (automatic only), 2..5 wheels.
	static constexpr int kEngine = 0;
	static constexpr int kTurbine = 1;
	static constexpr int kWheel0 = 2;
	std::array<double, 6> omega_{};
	std::array<double, 6> inv_inertia_{};
	std::array<double, 6> ext_torque_{};
	std::array<double, 6> solved_torque_{};
	std::vector<Constraint> constraints_;

	// Engine / idle controller.
	bool running_ = false;
	bool cranking_ = false;
	bool limiter_cut_ = false;
	double idle_integral_ = 0.0;
	double throttle_opening_ = 0.0;
	double combustion_torque_ = 0.0;

	// Transmission.
	int gear_ = 0; // manual gear, or automatic internal gear (1..N)
	int selector_ = static_cast<int>(AutoSelector::Park);
	double shift_timer_ = 0.0;
	double auto_clutch_ = 0.0; // auto-clutch engagement 0..1
	double auto_shift_timer_ = 0.0; // auto-clutch: gear change in progress
	double steer_rack_deg_ = 0.0;
	double clutch_torque_ = 0.0;
};

} // namespace avto
