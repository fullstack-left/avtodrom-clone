#include <algorithm>
#include "vehicle_sim.h"

namespace avto {

namespace {

// Internal integration rate of the drivetrain / tyre model, independent of
// the engine's physics tick: 8 substeps at 120 Hz, 16 at 60 Hz (phones).
constexpr double kSubstepRate = 960.0;
constexpr int kSolverIterations = 14;
constexpr double kBearingDrag = 0.35; // N·m per rad/s, wheel bearings + brake drag
constexpr double kParasiticBrake = 2.0; // N·m, pads lightly touching the disc
constexpr double kParkLockTorque = 9000.0;
constexpr double kGearMeshTorque = 6000.0; // effectively rigid
constexpr double kShiftMeshTorque = 260.0; // AT clutch-to-clutch shift in progress
constexpr double kLockupTorque = 420.0;

} // namespace

VehicleSim::VehicleSim(const VehicleParams &params) : params_(params) {
	tire_model_.set_params(&params_.tire);

	const double wb_front = params_.wheels[0].z;
	const double wb_rear = params_.wheels[2].z;
	const double zc = params_.center_of_mass[2];
	const double front_share = clampd((wb_rear - zc) / (wb_rear - wb_front), 0.1, 0.9);
	const double weight = params_.mass * kGravity;
	for (int i = 0; i < 4; ++i) {
		const size_t k = static_cast<size_t>(i);
		const double share = (i < 2) ? front_share : (1.0 - front_share);
		static_load_[k] = weight * share * 0.5;
		const WheelParams &w = params_.wheels[k];
		free_length_[k] = w.static_length + static_load_[k] / w.spring_rate;
	}

	inv_inertia_.fill(0.0);
	inv_inertia_[kEngine] = 1.0 / params_.engine.inertia;
	if (params_.gearbox.type == TransmissionType::Automatic) {
		inv_inertia_[kTurbine] = 1.0 / params_.gearbox.converter.turbine_inertia;
	}
	for (int i = 0; i < 4; ++i) {
		inv_inertia_[static_cast<size_t>(kWheel0 + i)] = 1.0 / params_.wheels[static_cast<size_t>(i)].inertia;
	}
	constraints_.reserve(12);
	reset(false);
}

void VehicleSim::reset(bool engine_running) {
	omega_.fill(0.0);
	ext_torque_.fill(0.0);
	solved_torque_.fill(0.0);
	for (auto &t : tire_) {
		t = TireState{};
	}
	for (auto &o : out_) {
		o = WheelOutput{};
	}
	abs_factor_ = { { 1.0, 1.0, 1.0, 1.0 } };
	running_ = engine_running;
	cranking_ = false;
	limiter_cut_ = false;
	idle_integral_ = 0.0;
	const bool automatic = params_.gearbox.type == TransmissionType::Automatic;
	if (engine_running) {
		omega_[kEngine] = rpm_to_rads(automatic ? params_.gearbox.creep_idle_rpm : params_.engine.idle_rpm);
		// Pre-load the idle integrator with the torque that balances friction.
		const double rpm = rads_to_rpm(omega_[kEngine]);
		const EngineParams &e = params_.engine;
		const double friction = e.friction_const + e.friction_per_krpm * rpm / 1000.0;
		const double load = clampd(friction / std::max(e.torque_full.eval(rpm), 1.0), 0.0, 0.99);
		const double k = 1.3 + (e.progression_low - 1.3) * (1.0 - smoothstepd(0.0, e.redline_rpm, rpm));
		const double opening = 1.0 - std::pow(1.0 - load, 1.0 / k);
		idle_integral_ = opening / e.idle_ki;
	}
	gear_ = automatic ? 1 : 0;
	selector_ = static_cast<int>(AutoSelector::Park);
	shift_timer_ = 0.0;
	steer_rack_deg_ = 0.0;
	clutch_torque_ = 0.0;
	auto_clutch_ = 0.0;
	auto_shift_timer_ = 0.0;
	tel_ = VehicleTelemetry{};
	tel_.engine_running = running_;
}

double VehicleSim::min_length(int wheel) const {
	const WheelParams &w = params_.wheels[static_cast<size_t>(wheel)];
	return w.static_length - w.travel_up;
}

double VehicleSim::max_length(int wheel) const {
	const WheelParams &w = params_.wheels[static_cast<size_t>(wheel)];
	return w.static_length + w.travel_down;
}

double VehicleSim::total_ratio() const {
	const GearboxParams &g = params_.gearbox;
	if (g.type == TransmissionType::Manual) {
		if (gear_ > 0 && gear_ <= static_cast<int>(g.forward.size())) {
			return g.forward[static_cast<size_t>(gear_ - 1)] * g.final_drive;
		}
		if (gear_ == -1) {
			return -g.reverse * g.final_drive;
		}
		return 0.0;
	}
	const auto sel = static_cast<AutoSelector>(selector_);
	if (sel == AutoSelector::Drive) {
		const int gi = std::clamp(gear_, 1, static_cast<int>(g.forward.size()));
		return g.forward[static_cast<size_t>(gi - 1)] * g.final_drive;
	}
	if (sel == AutoSelector::Reverse) {
		return -g.reverse * g.final_drive;
	}
	return 0.0;
}

bool VehicleSim::request_gear(int gear_or_selector, double clutch_pedal, bool auto_clutch) {
	const GearboxParams &g = params_.gearbox;
	const double speed = std::fabs(tel_.speed);
	if (g.type == TransmissionType::Manual) {
		const int target = std::clamp(gear_or_selector, -1, static_cast<int>(g.forward.size()));
		if (target == gear_) {
			return true;
		}
		// Pulling into neutral never needs the clutch; engaging a gear does
		// (unless the auto-clutch does it for the driver).
		if (target != 0 && !auto_clutch && clutch_pedal < 0.72) {
			tel_.grind_count++;
			return false;
		}
		if (target == -1 && speed > 1.5) {
			tel_.grind_count++;
			return false;
		}
		gear_ = target;
		if (auto_clutch) {
			auto_clutch_ = 0.0;
			auto_shift_timer_ = 0.30;
		}
		return true;
	}
	const int sel = std::clamp(gear_or_selector, 0, 3);
	if (sel == selector_) {
		return true;
	}
	const auto target = static_cast<AutoSelector>(sel);
	if ((target == AutoSelector::Park || target == AutoSelector::Reverse) && speed > 1.2) {
		return false;
	}
	selector_ = sel;
	if (target == AutoSelector::Drive) {
		gear_ = 1;
	}
	shift_timer_ = 0.25;
	return true;
}

void VehicleSim::update_steering(double dt, double steering_wheel_deg) {
	const SteeringParams &s = params_.steering;
	const double target = clampd(steering_wheel_deg, -s.wheel_lock_deg, s.wheel_lock_deg);
	const double max_step = s.max_rate_deg * dt;
	steer_rack_deg_ += clampd(target - steer_rack_deg_, -max_step, max_step);

	const double frac = steer_rack_deg_ / s.wheel_lock_deg;
	const double inner = std::fabs(frac) * s.max_road_angle_deg * kPi / 180.0;
	double outer = inner;
	if (inner > 1e-4) {
		const double wb = params_.wheelbase;
		const double half_track = params_.track * 0.5;
		const double radius = wb / std::tan(inner) + half_track; // to the rear-axle centre
		const double outer_ack = std::atan(wb / (radius + half_track));
		outer = lerpd(inner, outer_ack, s.ackermann);
	}
	// Turning right: FR is the inner wheel.
	const double sign = signd(frac);
	out_[0].steer = sign * (frac > 0.0 ? outer : inner);
	out_[1].steer = sign * (frac > 0.0 ? inner : outer);
	out_[2].steer = 0.0;
	out_[3].steer = 0.0;
}

void VehicleSim::update_suspension(const std::array<WheelContact, 4> &contacts) {
	std::array<double, 4> len{};
	for (int i = 0; i < 4; ++i) {
		const size_t k = static_cast<size_t>(i);
		const WheelParams &w = params_.wheels[k];
		const WheelContact &c = contacts[k];
		const double lmin = min_length(i);
		const double lmax = max_length(i);
		len[k] = c.contact ? c.spring_length : lmax;
		out_[k].contact = c.contact;
		out_[k].compression = clampd((lmax - len[k]) / (lmax - lmin), 0.0, 1.0);
		if (!c.contact) {
			fz_[k] = 0.0;
			continue;
		}
		const double deflection = free_length_[k] - c.spring_length;
		double f = w.spring_rate * std::max(deflection, 0.0);
		const double damping = c.spring_velocity < 0.0 ? w.damper_bump : w.damper_rebound;
		f -= damping * c.spring_velocity;
		if (c.spring_length < lmin) {
			f += w.bump_stop_rate * (lmin - c.spring_length);
		}
		fz_[k] = f;
	}
	const double arb[2] = { params_.anti_roll_front, params_.anti_roll_rear };
	for (int axle = 0; axle < 2; ++axle) {
		const size_t l = static_cast<size_t>(axle * 2);
		const size_t r = l + 1;
		if (contacts[l].contact && contacts[r].contact) {
			const double f = arb[axle] * (len[r] - len[l]); // + when the left side is more compressed
			fz_[l] += f;
			fz_[r] -= f;
		}
	}
	for (int i = 0; i < 4; ++i) {
		const size_t k = static_cast<size_t>(i);
		fz_[k] = std::max(fz_[k], 0.0);
		out_[k].fz = fz_[k];
	}
}

void VehicleSim::update_automatic(double dt, double throttle, double speed_kmh) {
	if (shift_timer_ > 0.0) {
		shift_timer_ = std::max(0.0, shift_timer_ - dt);
	}
	if (static_cast<AutoSelector>(selector_) != AutoSelector::Drive) {
		return;
	}
	const GearboxParams &g = params_.gearbox;
	const int n = static_cast<int>(g.forward.size());
	const double t = smoothstepd(0.15, 1.0, throttle);
	auto up_speed = [&](int from_gear) {
		const size_t k = static_cast<size_t>(from_gear - 1);
		if (k >= g.upshift_kmh_light.size()) {
			return 1e9;
		}
		return lerpd(g.upshift_kmh_light[k], g.upshift_kmh_full[k], t);
	};
	if (shift_timer_ > 0.0) {
		return;
	}
	if (gear_ < n && speed_kmh > up_speed(gear_)) {
		gear_++;
		shift_timer_ = 0.35;
	} else if (gear_ > 1 && speed_kmh < up_speed(gear_ - 1) - g.downshift_hysteresis_kmh) {
		gear_--;
		shift_timer_ = 0.30;
	}
}

double VehicleSim::engine_combustion_torque(double dt, double pedal) {
	const EngineParams &e = params_.engine;
	const double rpm = rads_to_rpm(omega_[kEngine]);
	const double pedal_open = clampd(pedal, 0.0, 1.0);
	if (!running_) {
		throttle_opening_ = pedal_open;
		idle_integral_ = 0.0;
		return 0.0;
	}
	const bool automatic = params_.gearbox.type == TransmissionType::Automatic;
	const double target = automatic ? params_.gearbox.creep_idle_rpm : e.idle_rpm;
	const double error = target - rpm;
	if (pedal_open < 0.02) {
		idle_integral_ += error * dt;
	} else {
		idle_integral_ -= idle_integral_ * std::min(1.0, dt * 1.5);
	}
	idle_integral_ = clampd(idle_integral_, -30.0, e.idle_max_throttle / e.idle_ki);
	const double idle_open = clampd(e.idle_kp * error + e.idle_ki * idle_integral_, 0.0, e.idle_max_throttle);
	const double opening = clampd(pedal_open + idle_open, 0.0, 1.0);
	throttle_opening_ = opening;

	if (rpm > e.limiter_rpm) {
		limiter_cut_ = true;
	} else if (rpm < e.limiter_rpm - 150.0) {
		limiter_cut_ = false;
	}
	if (limiter_cut_) {
		return 0.0;
	}
	const double k = 1.3 + (e.progression_low - 1.3) * (1.0 - smoothstepd(0.0, e.redline_rpm, rpm));
	const double load = 1.0 - std::pow(1.0 - opening, k);
	return load * e.torque_full.eval(std::max(rpm, 0.0));
}

double VehicleSim::clutch_engagement_from_pedal(double pedal) const {
	const ClutchParams &cp = params_.clutch;
	const double lin = clampd((cp.engage_start - pedal) / (cp.engage_start - cp.engage_full), 0.0, 1.0);
	return std::pow(lin, cp.curve_exponent);
}

void VehicleSim::update_auto_clutch(double dt, const DriverInput &in, const std::array<WheelContact, 4> &contacts) {
	if (auto_shift_timer_ > 0.0) {
		auto_shift_timer_ = std::max(0.0, auto_shift_timer_ - dt);
	}
	if (params_.gearbox.type != TransmissionType::Manual || !in.auto_clutch) {
		return;
	}
	const EngineParams &e = params_.engine;
	const double rpm = rads_to_rpm(omega_[kEngine]);
	const double ratio = total_ratio();
	double target = 0.0;
	if (ratio != 0.0 && running_ && auto_shift_timer_ <= 0.0) {
		const double wheel_w = 0.5 * (omega_[kWheel0] + omega_[kWheel0 + 1]);
		const double input_rpm = rads_to_rpm(wheel_w * ratio);
		const double slip = rpm - input_rpm;
		const double speed = std::fabs(wheel_w * params_.tire.radius);
		// Slip while the engine has revs to spare; creep gently at idle.
		target = std::pow(clampd((rpm - (e.idle_rpm + 60.0)) / 1100.0, 0.0, 1.0), 1.4);
		if (in.throttle < 0.05 && in.brake < 0.05) {
			target = std::max(target, 0.065);
		}
		if (std::fabs(slip) < 120.0 && rpm > e.idle_rpm + 80.0) {
			target = 1.0; // synchronised: lock up
		}
		// Pulling away, a driver feeds the clutch in no harder than the front
		// tyres can take: while it slips, the clutch carries at most what the
		// driven wheels can put down (or the engine's own torque, if more), so
		// the revved-up flywheel is never dumped into the tyres.
		if (speed < 8.0 && std::fabs(slip) >= 120.0) {
			const double grip = params_.tire.mu_long * 0.5 * (contacts[0].grip + contacts[1].grip);
			const double traction = grip * (fz_[0] + fz_[1]) * params_.tire.radius / std::fabs(ratio);
			const double cap = std::max(traction, combustion_torque_);
			target = std::min(target, cap / params_.clutch.max_torque);
		}
		if (in.brake > 0.25 && speed < 2.0) {
			target = 0.0; // holding the car on the brake
		}
		if (rpm < e.idle_rpm - 120.0) {
			target = 0.0; // stall protection
		}
	}
	const double rate = target > auto_clutch_ ? 2.5 : 9.0;
	auto_clutch_ += clampd(target - auto_clutch_, -rate * dt, rate * dt);
}

void VehicleSim::add_constraint(int a, double ja, int b, double jb, int c, double jc, double lo, double hi) {
	Constraint k;
	k.a = a;
	k.b = b;
	k.c = c;
	k.ja = ja;
	k.jb = jb;
	k.jc = jc;
	k.lo = lo;
	k.hi = hi;
	double denom = 0.0;
	if (a >= 0) {
		denom += ja * ja * inv_inertia_[static_cast<size_t>(a)];
	}
	if (b >= 0) {
		denom += jb * jb * inv_inertia_[static_cast<size_t>(b)];
	}
	if (c >= 0) {
		denom += jc * jc * inv_inertia_[static_cast<size_t>(c)];
	}
	if (denom <= 1e-12) {
		return;
	}
	k.eff_mass = 1.0 / denom;
	constraints_.push_back(k);
}

void VehicleSim::solve_constraints(double h, int iterations) {
	for (int it = 0; it < iterations; ++it) {
		for (Constraint &k : constraints_) {
			double jv = 0.0;
			if (k.a >= 0) {
				jv += k.ja * omega_[static_cast<size_t>(k.a)];
			}
			if (k.b >= 0) {
				jv += k.jb * omega_[static_cast<size_t>(k.b)];
			}
			if (k.c >= 0) {
				jv += k.jc * omega_[static_cast<size_t>(k.c)];
			}
			const double target = clampd(k.impulse - jv * k.eff_mass, k.lo * h, k.hi * h);
			const double delta = target - k.impulse;
			k.impulse = target;
			if (k.a >= 0) {
				omega_[static_cast<size_t>(k.a)] += k.ja * delta * inv_inertia_[static_cast<size_t>(k.a)];
			}
			if (k.b >= 0) {
				omega_[static_cast<size_t>(k.b)] += k.jb * delta * inv_inertia_[static_cast<size_t>(k.b)];
			}
			if (k.c >= 0) {
				omega_[static_cast<size_t>(k.c)] += k.jc * delta * inv_inertia_[static_cast<size_t>(k.c)];
			}
		}
	}
}

void VehicleSim::substep(double h, const DriverInput &in, const std::array<WheelContact, 4> &contacts) {
	const EngineParams &e = params_.engine;
	const GearboxParams &g = params_.gearbox;
	const bool automatic = g.type == TransmissionType::Automatic;
	const double radius = params_.tire.radius;

	// 1. Tyre forces from the current patch deflection.
	std::array<double, 4> tyre_fx{};
	std::array<double, 4> tyre_fy{};
	for (int i = 0; i < 4; ++i) {
		const size_t k = static_cast<size_t>(i);
		if (contacts[k].contact) {
			tire_model_.compute_force(tire_[k], fz_[k], contacts[k].grip, contacts[k].vx);
			tyre_fx[k] = tire_[k].fx;
			tyre_fy[k] = tire_[k].fy;
		} else {
			tire_[k].fx = 0.0;
			tire_[k].fy = 0.0;
		}
	}

	// 2. External (explicit) torques.
	ext_torque_.fill(0.0);
	combustion_torque_ = engine_combustion_torque(h, in.throttle);
	ext_torque_[kEngine] += combustion_torque_;
	const double rpm = rads_to_rpm(omega_[kEngine]);
	cranking_ = in.ignition && in.starter && !running_;
	if (cranking_) {
		ext_torque_[kEngine] += e.starter_torque * std::max(0.0, 1.0 - rpm / e.starter_max_rpm);
	}
	for (int i = 0; i < 4; ++i) {
		const size_t b = static_cast<size_t>(kWheel0 + i);
		ext_torque_[b] += -tyre_fx[static_cast<size_t>(i)] * radius - kBearingDrag * omega_[b];
	}
	const auto sel = static_cast<AutoSelector>(selector_);
	if (automatic) {
		// Torque converter (explicit fluid coupling).
		const TorqueConverterParams &tc = g.converter;
		const double we = omega_[kEngine];
		const double wt = omega_[kTurbine];
		const double hi_w = std::max(std::fabs(we), std::fabs(wt));
		if (hi_w > 1.0) {
			const double sr = clampd(std::min(std::fabs(we), std::fabs(wt)) / hi_w, 0.0, 1.0);
			const double k = std::max(tc.k_factor.eval(sr), 1.0);
			const double t_pump = signd(we - wt) * std::pow(rads_to_rpm(hi_w) / k, 2.0);
			const double t_turb = (we > wt) ? t_pump * tc.torque_ratio.eval(sr) : t_pump;
			ext_torque_[kEngine] -= t_pump;
			ext_torque_[kTurbine] += t_turb;
		}
		ext_torque_[kTurbine] -= 0.02 * omega_[kTurbine]; // fluid drag
	}

	// 3. Integrate explicit torques.
	for (size_t b = 0; b < omega_.size(); ++b) {
		omega_[b] += h * ext_torque_[b] * inv_inertia_[b];
	}

	// 4. Constraints.
	constraints_.clear();
	const double friction = e.friction_const + e.friction_per_krpm * std::fabs(rpm) / 1000.0 +
			(running_ ? 0.0 : e.compression_hold * (1.0 - smoothstepd(0.0, 150.0, std::fabs(rpm))));
	add_constraint(kEngine, 1.0, -1, 0.0, -1, 0.0, -friction, friction);

	const double ratio = total_ratio();
	int clutch_index = -1;
	if (!automatic) {
		const ClutchParams &cp = params_.clutch;
		const double engagement = in.auto_clutch ? auto_clutch_ : clutch_engagement_from_pedal(in.clutch);
		tel_.clutch_engagement = engagement;
		const double cap = cp.max_torque * engagement;
		if (ratio != 0.0 && cap > 0.0) {
			clutch_index = static_cast<int>(constraints_.size());
			add_constraint(kEngine, 1.0, kWheel0 + 0, -ratio * 0.5, kWheel0 + 1, -ratio * 0.5, -cap, cap);
		}
	} else {
		if (ratio != 0.0) {
			const double cap = shift_timer_ > 0.0 ? kShiftMeshTorque : kGearMeshTorque;
			clutch_index = static_cast<int>(constraints_.size());
			add_constraint(kTurbine, 1.0, kWheel0 + 0, -ratio * 0.5, kWheel0 + 1, -ratio * 0.5, -cap, cap);
			const double speed = std::fabs(0.5 * (omega_[kWheel0] + omega_[kWheel0 + 1]) * radius);
			if (sel == AutoSelector::Drive && gear_ >= 3 && speed > g.converter.lockup_speed && in.throttle < 0.7 &&
					shift_timer_ <= 0.0) {
				add_constraint(kEngine, 1.0, kTurbine, -1.0, -1, 0.0, -kLockupTorque, kLockupTorque);
			}
		} else if (sel == AutoSelector::Park) {
			add_constraint(kWheel0 + 0, 0.5, kWheel0 + 1, 0.5, -1, 0.0, -kParkLockTorque, kParkLockTorque);
		}
	}

	const double brake_pedal = std::pow(clampd(in.brake, 0.0, 1.0), 1.15);
	bool abs_active = false;
	for (int i = 0; i < 4; ++i) {
		const size_t k = static_cast<size_t>(i);
		const WheelParams &w = params_.wheels[k];
		if (params_.abs && in.brake > 0.05 && contacts[k].contact) {
			const double vx = std::fabs(contacts[k].vx);
			const bool locking = tire_[k].slip_long * signd(contacts[k].vx) < -params_.tire.peak_slip_long * 1.25;
			if (vx > 1.2 && locking) {
				abs_factor_[k] = std::max(0.15, abs_factor_[k] - h * 12.0);
			} else {
				abs_factor_[k] = std::min(1.0, abs_factor_[k] + h * 5.0);
			}
			abs_active = abs_active || abs_factor_[k] < 0.97;
		} else {
			abs_factor_[k] = 1.0;
		}
		double cap = w.brake_torque * brake_pedal * abs_factor_[k] + kParasiticBrake;
		if (w.handbrake) {
			cap += w.handbrake_torque * clampd(in.handbrake, 0.0, 1.0);
		}
		add_constraint(kWheel0 + i, 1.0, -1, 0.0, -1, 0.0, -cap, cap);
	}
	tel_.abs_active = abs_active;

	solve_constraints(h, kSolverIterations);
	clutch_torque_ = clutch_index >= 0 ? constraints_[static_cast<size_t>(clutch_index)].impulse / h : 0.0;
	for (int i = 0; i < 4; ++i) {
		// The brake constraints are the last four.
		const Constraint &k = constraints_[constraints_.size() - 4 + static_cast<size_t>(i)];
		brake_acc_[static_cast<size_t>(i)] += std::fabs(k.impulse / h);
	}

	// 5. Engine state machine.
	const double rpm_after = rads_to_rpm(omega_[kEngine]);
	if (!in.ignition) {
		running_ = false;
	} else if (!running_) {
		// Fires from the starter, or bump-starts when the wheels spin it fast enough.
		if ((cranking_ && rpm_after >= e.catch_rpm) || (!cranking_ && rpm_after >= e.catch_rpm * 1.6)) {
			running_ = true;
		}
	} else if (rpm_after < e.stall_rpm) {
		running_ = false;
		tel_.stall_count++;
	}

	// 6. Tyre patch deflection with the new wheel speeds.
	for (int i = 0; i < 4; ++i) {
		const size_t k = static_cast<size_t>(i);
		const size_t b = static_cast<size_t>(kWheel0 + i);
		const double omega_r = omega_[b] * radius;
		if (contacts[k].contact) {
			tire_model_.integrate(tire_[k], h, contacts[k].vx, contacts[k].vy, omega_r);
		} else {
			const double decay = std::exp(-h * 40.0);
			tire_[k].u *= decay;
			tire_[k].v *= decay;
			tire_[k].u_rate = 0.0;
			tire_[k].v_rate = 0.0;
			tire_[k].slip_long = tire_[k].u / params_.tire.relax_long;
			tire_[k].slip_lat = tire_[k].v / params_.tire.relax_lat;
		}
		out_[k].rotation += omega_[b] * h;
		fx_acc_[k] += tyre_fx[k];
		fy_acc_[k] += tyre_fy[k];
	}
}

void VehicleSim::step(double dt, const DriverInput &input, const std::array<WheelContact, 4> &contacts) {
	if (dt <= 0.0) {
		return;
	}
	update_steering(dt, input.steering_wheel_deg);
	update_suspension(contacts);
	const double radius = params_.tire.radius;
	const double driven_speed = 0.5 * (omega_[kWheel0] + omega_[kWheel0 + 1]) * radius;
	if (params_.gearbox.type == TransmissionType::Automatic) {
		update_automatic(dt, input.throttle, std::fabs(driven_speed) * 3.6);
	} else {
		update_auto_clutch(dt, input, contacts);
	}

	fx_acc_.fill(0.0);
	fy_acc_.fill(0.0);
	brake_acc_.fill(0.0);
	const int n_sub = std::clamp(static_cast<int>(std::lround(dt * kSubstepRate)), 1, 32);
	const double h = dt / n_sub;
	for (int s = 0; s < n_sub; ++s) {
		substep(h, input, contacts);
	}

	for (int i = 0; i < 4; ++i) {
		const size_t k = static_cast<size_t>(i);
		const size_t b = static_cast<size_t>(kWheel0 + i);
		WheelOutput &o = out_[k];
		o.fx = fx_acc_[k] / n_sub;
		o.fy = fy_acc_[k] / n_sub;
		if (contacts[k].contact) {
			const double rr = params_.tire.rolling_resistance * contacts[k].rolling_resistance * fz_[k];
			o.fx -= rr * std::tanh(contacts[k].vx / 0.25);
		}
		o.omega = omega_[b];
		o.slide_speed = contacts[k].contact
				? std::hypot(omega_[b] * params_.tire.radius - contacts[k].vx, contacts[k].vy)
				: 0.0;
		o.slip_long = tire_[k].slip_long;
		o.slip_lat = tire_[k].slip_lat;
		o.sliding = tire_[k].sliding;
		o.brake_torque = brake_acc_[k] / n_sub;
	}

	const double speed = 0.5 * (omega_[kWheel0] + omega_[kWheel0 + 1]) * radius;
	tel_.rpm = rads_to_rpm(omega_[kEngine]);
	tel_.speed = speed;
	tel_.engine_torque = combustion_torque_;
	tel_.clutch_torque = clutch_torque_;
	tel_.throttle_opening = throttle_opening_;
	tel_.engine_running = running_;
	tel_.engine_cranking = cranking_;
	tel_.in_shift = shift_timer_ > 0.0;
	if (params_.gearbox.type == TransmissionType::Manual) {
		tel_.gear = gear_;
		tel_.selector = gear_;
	} else {
		const auto sel = static_cast<AutoSelector>(selector_);
		tel_.selector = selector_;
		tel_.gear = sel == AutoSelector::Drive ? gear_ : (sel == AutoSelector::Reverse ? -1 : 0);
	}
	double vsum = 0.0;
	int n = 0;
	for (int i = 0; i < 4; ++i) {
		if (contacts[static_cast<size_t>(i)].contact) {
			vsum += contacts[static_cast<size_t>(i)].vx;
			n++;
		}
	}
	if (n > 0) {
		tel_.odometer += std::fabs(vsum / n) * dt;
	}
}

} // namespace avto
