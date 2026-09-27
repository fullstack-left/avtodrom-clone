// Planar (3-DOF) chassis used by the unit tests to exercise VehicleSim
// without a physics engine: x/z position, yaw, on a plane that may be tilted
// along a fixed "uphill" world direction.
//
// Frame: Godot's. +x right, +y up, forward = -z. Yaw ψ rotates about +y,
// forward = (-sin ψ, -cos ψ), so positive ψ turns the car left.
#pragma once

#include "sim/vehicle_sim.h"

#include <array>
#include <cmath>

namespace avto {

struct PlanarHarness {
	VehicleSim sim;
	double x = 0.0, z = 0.0, yaw = 0.0;
	double vx = 0.0, vz = 0.0, yaw_rate = 0.0;
	double slope = 0.0; // rise/run; the plane rises along uphill_dir
	double up_x = 0.0, up_z = -1.0; // uphill direction (world, unit) — default: car's initial forward
	double grip = 1.0;
	double long_accel = 0.0;
	double pitch_accel = 0.0; // long_accel through the body-pitch lag (~0.12 s)
	DriverInput input;

	explicit PlanarHarness(const VehicleParams &p) : sim(p) {}

	double forward_speed() const { return vx * -std::sin(yaw) + vz * -std::cos(yaw); }
	double speed() const { return std::sqrt(vx * vx + vz * vz); }
	// Distance travelled up the slope (along uphill_dir).
	double uphill_position() const { return x * up_x + z * up_z; }

	void step(double dt) {
		const VehicleParams &p = sim.params();
		const double theta = std::atan(slope);
		const double cos_t = std::cos(theta);
		const double sin_t = std::sin(theta);
		const double fwd_x = -std::sin(yaw), fwd_z = -std::cos(yaw);
		const double rgt_x = std::cos(yaw), rgt_z = -std::sin(yaw);
		const double hcg = p.center_of_mass[1];
		const double cz = p.center_of_mass[2];

		std::array<WheelContact, 4> contacts{};
		std::array<double, 4> ox{}, oz{};
		for (int i = 0; i < 4; ++i) {
			const size_t k = static_cast<size_t>(i);
			const WheelParams &w = p.wheels[k];
			// Offset from the CoM in world space.
			const double bx = w.x - p.center_of_mass[0];
			const double bz = w.z - cz;
			ox[k] = rgt_x * bx - fwd_x * bz;
			oz[k] = rgt_z * bx - fwd_z * bz;

			// Quasi-static load incl. slope and longitudinal transfer.
			const bool front = i < 2;
			double fz = sim.static_corner_load(i) * cos_t;
			const double pitch_force = sim.params().mass * (pitch_accel + kGravity * sin_t * (fwd_x * up_x + fwd_z * up_z));
			fz += (front ? -1.0 : 1.0) * 0.5 * pitch_force * hcg / p.wheelbase;
			fz = std::max(fz, 50.0);
			WheelContact &c = contacts[k];
			c.contact = true;
			c.spring_length = sim.free_length(i) - fz / w.spring_rate;
			c.spring_velocity = 0.0;
			c.grip = grip;

			const double pvx = vx + yaw_rate * oz[k];
			const double pvz = vz - yaw_rate * ox[k];
			const double steer = sim.wheels()[k].steer;
			const double hyaw = yaw - steer;
			const double hx = -std::sin(hyaw), hz = -std::cos(hyaw);
			const double lx = -std::cos(hyaw), lz = std::sin(hyaw); // left = -right
			c.vx = pvx * hx + pvz * hz;
			c.vy = pvx * lx + pvz * lz;
		}

		sim.step(dt, input, contacts);

		double fx_sum = 0.0, fz_sum = 0.0, torque = 0.0;
		for (int i = 0; i < 4; ++i) {
			const size_t k = static_cast<size_t>(i);
			const WheelOutput &o = sim.wheels()[k];
			const double hyaw = yaw - o.steer;
			const double hx = -std::sin(hyaw), hz = -std::cos(hyaw);
			const double lx = -std::cos(hyaw), lz = std::sin(hyaw);
			const double fx = o.fx * hx + o.fy * lx;
			const double fz = o.fx * hz + o.fy * lz;
			fx_sum += fx;
			fz_sum += fz;
			torque += oz[k] * fx - ox[k] * fz; // (r × F)_y
		}
		const double m = p.mass;
		// Gravity along the slope.
		fx_sum -= m * kGravity * sin_t * up_x;
		fz_sum -= m * kGravity * sin_t * up_z;
		// Aerodynamic drag.
		const double v = speed();
		fx_sum -= 0.5 * 1.2 * p.drag_area * v * vx;
		fz_sum -= 0.5 * 1.2 * p.drag_area * v * vz;

		const double ax = fx_sum / m;
		const double az = fz_sum / m;
		long_accel = ax * fwd_x + az * fwd_z;
		pitch_accel += (long_accel - pitch_accel) * std::min(1.0, dt / 0.12);
		vx += ax * dt;
		vz += az * dt;
		yaw_rate += torque / p.inertia[1] * dt;
		x += vx * dt;
		z += vz * dt;
		yaw += yaw_rate * dt;
	}

	void run(double seconds, double dt = 1.0 / 120.0) {
		const int n = static_cast<int>(std::lround(seconds / dt));
		for (int i = 0; i < n; ++i) {
			step(dt);
		}
	}
};

} // namespace avto
