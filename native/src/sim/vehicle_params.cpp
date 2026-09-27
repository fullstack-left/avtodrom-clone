#include "vehicle_params.h"

namespace avto {

namespace {

// Corner layout helper. Body frame = Godot's: origin on the ground centred
// between the axles, +x right, +y up, forward is -z.
void layout_wheels(VehicleParams &p, double wheelbase, double track_f, double track_r, double radius,
		double mount_above_center) {
	const double zf = -wheelbase * 0.5;
	const double zr = wheelbase * 0.5;
	const double xs[4] = { -track_f * 0.5, track_f * 0.5, -track_r * 0.5, track_r * 0.5 };
	const double zs[4] = { zf, zf, zr, zr };
	for (int i = 0; i < 4; ++i) {
		WheelParams &w = p.wheels[static_cast<size_t>(i)];
		w.x = xs[i];
		w.z = zs[i];
		w.y = radius + mount_above_center; // mount point height at static ride
		w.static_length = mount_above_center;
		w.steered = i < 2;
		w.driven = i < 2; // both presets are front-wheel drive
		w.handbrake = i >= 2;
	}
}

} // namespace

VehicleParams make_nexia2() {
	VehicleParams p;
	p.id = "nexia2";
	p.mass = 1025.0 + 75.0;
	// Estimated from mass distribution (61 % front) and body dimensions.
	p.inertia = { 520.0, 1780.0, 1650.0 };
	// Wheel layout measured on the game model (pipeline/blender/build_nexia.py):
	// wheelbase 2480 mm, track 1421 mm — within 1.6 % of the maker's figures.
	p.center_of_mass = { 0.0, 0.50, -0.27 }; // 61/39 front/rear split
	p.drag_area = 0.34 * 1.92;
	p.wheelbase = 2.4802;
	p.track = 1.4212;
	p.abs = true;

	EngineParams &e = p.engine;
	e.torque_full = Curve{ { 0.0, 62.0 }, { 600.0, 86.0 }, { 1000.0, 97.0 }, { 1500.0, 106.0 }, { 2000.0, 113.0 },
		{ 2500.0, 119.0 }, { 3200.0, 123.0 }, { 3800.0, 121.0 }, { 4400.0, 116.0 }, { 5000.0, 109.0 },
		{ 5600.0, 101.0 }, { 6200.0, 88.0 }, { 7000.0, 60.0 } };
	e.inertia = 0.13;
	e.idle_rpm = 850.0;
	e.limiter_rpm = 6200.0;
	e.redline_rpm = 6000.0;

	p.clutch.max_torque = 190.0;

	GearboxParams &g = p.gearbox;
	g.type = TransmissionType::Manual;
	g.forward = { 3.545, 2.048, 1.346, 0.971, 0.763 };
	g.reverse = 3.333;
	g.final_drive = 3.722;
	g.efficiency = 0.93;

	TireParams &t = p.tire;
	t.radius = 0.2888; // 185/60 R14: 355.6/2 + 185*0.6 = 288.8 mm
	t.width = 0.185;
	t.load_nominal = (1100.0 * kGravity) / 4.0;

	p.steering.wheel_lock_deg = 540.0; // ≈3 turns lock to lock
	p.steering.max_road_angle_deg = 39.0; // ≈10 m kerb-to-kerb turning circle

	layout_wheels(p, p.wheelbase, p.track, p.track, t.radius, 0.26);
	for (int i = 0; i < 4; ++i) {
		WheelParams &w = p.wheels[static_cast<size_t>(i)];
		const bool front = i < 2;
		w.inertia = front ? 1.05 : 0.85;
		w.brake_torque = front ? 1250.0 : 520.0; // disc front, drum rear
		w.handbrake_torque = front ? 0.0 : 900.0;
		w.spring_rate = front ? 23000.0 : 19000.0;
		w.damper_bump = front ? 1550.0 : 1250.0;
		w.damper_rebound = front ? 2500.0 : 2050.0;
		w.travel_up = 0.095;
		w.travel_down = 0.085;
	}
	p.anti_roll_front = 11000.0;
	p.anti_roll_rear = 3500.0;
	return p;
}

VehicleParams make_cobalt_at() {
	VehicleParams p;
	p.id = "cobalt_at";
	p.mass = 1165.0 + 75.0;
	p.inertia = { 600.0, 2050.0, 1900.0 };
	p.center_of_mass = { 0.0, 0.54, -0.26 }; // ~60/40
	p.drag_area = 0.33 * 2.05;
	p.wheelbase = 2.62;
	// Maker: 1479/1493 mm; the game model's wheel arches sit at 1.52 m.
	p.track = 1.52;
	p.abs = true;

	EngineParams &e = p.engine;
	e.torque_full = Curve{ { 0.0, 66.0 }, { 600.0, 92.0 }, { 1000.0, 104.0 }, { 1500.0, 112.0 }, { 2000.0, 118.0 },
		{ 2500.0, 123.0 }, { 3000.0, 128.0 }, { 4000.0, 134.0 }, { 4800.0, 131.0 }, { 5400.0, 127.0 },
		{ 5800.0, 124.0 }, { 6400.0, 110.0 }, { 7000.0, 80.0 } };
	e.inertia = 0.14;
	e.idle_rpm = 750.0;
	e.limiter_rpm = 6500.0;
	e.redline_rpm = 6300.0;

	GearboxParams &g = p.gearbox;
	g.type = TransmissionType::Automatic;
	g.forward = { 4.584, 2.964, 1.912, 1.446, 1.000, 0.746 };
	g.reverse = 2.943;
	g.final_drive = 3.53;
	g.efficiency = 0.90;
	g.upshift_kmh_light = { 17.0, 30.0, 44.0, 57.0, 70.0 };
	g.upshift_kmh_full = { 42.0, 72.0, 105.0, 138.0, 168.0 };
	g.downshift_hysteresis_kmh = 8.0;
	g.creep_idle_rpm = 750.0;
	TorqueConverterParams &tc = g.converter;
	// Typical small-car converter: stall ratio 2.0, coupling point at SR 0.86.
	tc.k_factor = Curve{ { 0.0, 150.0 }, { 0.5, 158.0 }, { 0.7, 170.0 }, { 0.8, 185.0 }, { 0.86, 205.0 },
		{ 0.92, 260.0 }, { 0.97, 450.0 }, { 1.0, 2000.0 } };
	tc.torque_ratio = Curve{ { 0.0, 2.0 }, { 0.3, 1.72 }, { 0.6, 1.36 }, { 0.8, 1.10 }, { 0.86, 1.0 }, { 1.0, 1.0 } };
	tc.turbine_inertia = 0.05;

	TireParams &t = p.tire;
	t.radius = 0.3165; // 185/75 R14
	t.width = 0.185;
	t.load_nominal = (1240.0 * kGravity) / 4.0;

	p.steering.wheel_lock_deg = 510.0;
	p.steering.max_road_angle_deg = 37.0; // 10.4 m turning circle

	layout_wheels(p, p.wheelbase, p.track, p.track, t.radius, 0.27);
	for (int i = 0; i < 4; ++i) {
		WheelParams &w = p.wheels[static_cast<size_t>(i)];
		const bool front = i < 2;
		w.inertia = front ? 1.2 : 1.0;
		w.brake_torque = front ? 1450.0 : 620.0;
		w.handbrake_torque = front ? 0.0 : 1000.0;
		w.spring_rate = front ? 25000.0 : 21000.0;
		w.damper_bump = front ? 1700.0 : 1400.0;
		w.damper_rebound = front ? 2700.0 : 2250.0;
		w.travel_up = 0.10;
		w.travel_down = 0.09;
	}
	p.anti_roll_front = 12500.0;
	p.anti_roll_rear = 4000.0;
	return p;
}

VehicleParams make_preset(const std::string &id) {
	if (id == "cobalt_at") {
		return make_cobalt_at();
	}
	return make_nexia2();
}

} // namespace avto
