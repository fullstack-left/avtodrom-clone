// Vehicle parameter sets. Every number here is a physical quantity of the
// real car (manufacturer data where published, engineering estimates where
// not — the estimates are marked).
#pragma once

#include "common.h"

#include <array>
#include <string>

namespace avto {

enum class TransmissionType { Manual = 0, Automatic = 1 };

// Automatic selector positions. Manual gear numbers are plain ints:
// -1 = reverse, 0 = neutral, 1..N = forward gears.
enum class AutoSelector { Park = 0, Reverse = 1, Neutral = 2, Drive = 3 };

struct EngineParams {
	Curve torque_full; // rpm -> N·m at wide-open throttle
	double inertia = 0.13; // kg·m², crank + flywheel (estimate)
	double friction_const = 9.0; // N·m, rubbing friction at 0 rpm
	double friction_per_krpm = 4.3; // N·m per 1000 rpm, pumping + rubbing
	double compression_hold = 38.0; // N·m extra breakaway torque of a stopped engine
	double idle_rpm = 850.0;
	double stall_rpm = 300.0; // combustion cannot sustain itself below this
	double catch_rpm = 350.0; // cranking speed at which the engine fires
	double limiter_rpm = 6200.0;
	double redline_rpm = 6000.0;
	double starter_torque = 95.0; // N·m at the crank (after the ring-gear reduction)
	double starter_max_rpm = 430.0;
	double idle_max_throttle = 0.12; // idle-air valve + ignition-advance authority (equivalent opening)
	double idle_kp = 0.00018; // per rpm
	double idle_ki = 0.00060; // per rpm·s
	// Engine load vs throttle opening is strongly non-linear: at low rpm a
	// small opening already fills the cylinders. load = 1 - (1 - opening)^k,
	// k falling from `progression_low` at 0 rpm to 1.3 at the redline.
	double progression_low = 4.0;
};

struct ClutchParams {
	double max_torque = 190.0; // N·m capacity when fully engaged
	double engage_start = 0.80; // pedal position where torque starts (1 = floored)
	double engage_full = 0.22; // pedal position where the clutch is fully engaged
	double curve_exponent = 2.2; // capacity = max · lin^exp: a wide, controllable bite zone
};

struct TorqueConverterParams {
	Curve k_factor; // speed ratio -> capacity factor K (rpm / sqrt(N·m))
	Curve torque_ratio; // speed ratio -> torque multiplication
	double turbine_inertia = 0.05;
	double lockup_speed = 60.0 / 3.6; // m/s, lock-up clutch engages above this in top gears
};

struct GearboxParams {
	TransmissionType type = TransmissionType::Manual;
	std::vector<double> forward; // forward gear ratios
	double reverse = 3.333;
	double final_drive = 3.722;
	double efficiency = 0.93;
	double inertia = 0.025; // kg·m² at the gearbox input
	// Automatic shift schedule (vehicle speed, km/h) as a function of throttle.
	std::vector<double> upshift_kmh_light; // throttle ~0.2
	std::vector<double> upshift_kmh_full; // throttle 1.0
	double downshift_hysteresis_kmh = 7.0;
	TorqueConverterParams converter;
	double creep_idle_rpm = 750.0; // AT idle (lower than manual)
};

struct TireParams {
	double radius = 0.289; // 185/60 R14
	double width = 0.185;
	double mu_long = 1.05;
	double mu_lat = 0.98;
	double peak_slip_long = 0.09; // slip ratio at peak force
	double peak_slip_lat = 0.12; // tan(slip angle) at peak force (~7°)
	double shape_c = 1.40; // Magic Formula C (tail ≈ sin(C·π/2) = 0.81 of peak)
	double load_nominal = 2700.0; // N
	double load_sensitivity = 0.10; // µ drop per unit of Fz/Fz0 above 1
	double relax_long = 0.22; // m, relaxation length
	double relax_lat = 0.42; // m
	double rolling_resistance = 0.012;
	// Carcass damping at crawling speed, N·s/m at nominal load. Sized for
	// ζ ≈ 0.5 of the patch spring (k = C/σ) against a quarter-car mass.
	double low_speed_damping_long = 12000.0;
	double low_speed_damping_lat = 8000.0;
	double low_speed_fade = 3.0; // m/s, damping faded out above this
};

struct WheelParams {
	// Suspension mount point in the body frame (+x right, +y up, forward = -z)
	// at static ride height; the wheel centre hangs `static_length` below it.
	double x = 0.0;
	double y = 0.0;
	double z = 0.0;
	bool steered = false;
	bool driven = false;
	bool handbrake = false;
	double inertia = 0.95; // kg·m² wheel + tyre + hub + disc
	double brake_torque = 1300.0; // N·m at full pedal
	double handbrake_torque = 0.0;
	double spring_rate = 22000.0; // N/m (at the wheel)
	double damper_bump = 1500.0; // N·s/m
	double damper_rebound = 2300.0;
	double static_length = 0.26; // mount -> wheel centre at static ride height
	double travel_up = 0.10; // bump travel from static
	double travel_down = 0.09; // droop travel from static
	double bump_stop_rate = 160000.0;
};

struct SteeringParams {
	double wheel_lock_deg = 540.0; // steering-wheel angle at full lock (each side)
	double max_rate_deg = 900.0; // how fast the rack can follow the wheel (deg/s)
	double max_road_angle_deg = 36.5; // inner road-wheel angle at lock
	double ackermann = 0.85; // 0 = parallel, 1 = full Ackermann
};

struct VehicleParams {
	std::string id = "nexia2";
	double mass = 1100.0; // kg incl. driver
	std::array<double, 3> inertia = { 540.0, 1850.0, 1700.0 }; // roll, yaw, pitch
	std::array<double, 3> center_of_mass = { 0.0, 0.52, -0.18 }; // body frame
	double drag_area = 0.66; // Cd·A, m²
	double wheelbase = 2.52;
	double track = 1.40;
	double anti_roll_front = 11000.0; // N/m
	double anti_roll_rear = 4000.0;
	bool abs = true;
	EngineParams engine;
	ClutchParams clutch;
	GearboxParams gearbox;
	TireParams tire;
	SteeringParams steering;
	std::array<WheelParams, 4> wheels; // FL, FR, RL, RR
};

// Daewoo/Ravon Nexia 2 (N150), 1.5 SOHC 8V (A15SMS), 5-speed manual, FWD.
// Maker data: 80 hp @ 5600 rpm, 123 N·m @ 3200 rpm, curb 1025 kg,
// wheelbase 2520 mm, track 1400/1406 mm, tyres 185/60 R14.
VehicleParams make_nexia2();

// Chevrolet Cobalt (T250 facelift, UzAuto), 1.5 DOHC (B15D2), 6-speed automatic
// (GM 6T30), FWD. Maker data: 106 hp @ 5800 rpm, 134 N·m @ 4000 rpm,
// curb 1165 kg, wheelbase 2620 mm, tyres 185/75 R14.
VehicleParams make_cobalt_at();

VehicleParams make_preset(const std::string &id);

} // namespace avto
