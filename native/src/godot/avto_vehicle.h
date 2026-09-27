// AvtoVehicle — the drivable car as a Godot RigidBody3D.
//
// Jolt integrates the chassis; this node does the rest every physics tick in
// _integrate_forces():
//   1. sweeps a tyre-shaped cylinder down each suspension leg (so a wheel
//      rolls up a kerb edge instead of snapping onto it like a ray would),
//   2. measures spring length and contact-point velocity in the wheel frame,
//   3. steps avto::VehicleSim (engine, clutch, gearbox, brakes, tyres),
//   4. applies the resulting suspension and tyre forces at the contact points.
//
// Frame: Godot's. +x right, +y up, forward = -z.
#pragma once

#include "sim/vehicle_sim.h"

#include <godot_cpp/classes/cylinder_shape3d.hpp>
#include <godot_cpp/classes/physics_direct_body_state3d.hpp>
#include <godot_cpp/classes/rigid_body3d.hpp>
#include <godot_cpp/variant/packed_byte_array.hpp>
#include <godot_cpp/variant/packed_float32_array.hpp>

#include <array>
#include <memory>

namespace godot {

class AvtoVehicle : public RigidBody3D {
	GDCLASS(AvtoVehicle, RigidBody3D)

public:
	AvtoVehicle();
	~AvtoVehicle() override;

	void _ready() override;
	void _integrate_forces(PhysicsDirectBodyState3D *p_state) override;

	// --- configuration ---
	void set_preset(const String &p_id);
	String get_preset() const { return preset_; }
	void set_wheel_collision_mask(uint32_t p_mask) { wheel_mask_ = p_mask; }
	uint32_t get_wheel_collision_mask() const { return wheel_mask_; }
	void set_surface_map(const PackedByteArray &p_cells, int p_width, int p_height, const Vector2 &p_origin,
			float p_cell_size, const PackedFloat32Array &p_grip, const PackedFloat32Array &p_rolling);

	// --- driver controls ---
	void set_throttle(float v) { input_.throttle = v; }
	float get_throttle() const { return static_cast<float>(input_.throttle); }
	void set_brake(float v) { input_.brake = v; }
	float get_brake() const { return static_cast<float>(input_.brake); }
	void set_clutch(float v) { input_.clutch = v; }
	float get_clutch() const { return static_cast<float>(input_.clutch); }
	void set_handbrake(float v) { input_.handbrake = v; }
	float get_handbrake() const { return static_cast<float>(input_.handbrake); }
	void set_steering_wheel(float deg) { input_.steering_wheel_deg = deg; }
	float get_steering_wheel() const { return static_cast<float>(input_.steering_wheel_deg); }
	void set_ignition(bool v) { input_.ignition = v; }
	bool get_ignition() const { return input_.ignition; }
	void set_starter(bool v) { input_.starter = v; }
	bool get_starter() const { return input_.starter; }
	void set_auto_clutch(bool v) { input_.auto_clutch = v; }
	bool get_auto_clutch() const { return input_.auto_clutch; }
	bool request_gear(int gear_or_selector);

	// --- state ---
	void teleport(const Transform3D &p_xform, bool p_engine_running);
	float get_rpm() const;
	float get_speed_kmh() const; // speedometer (driven wheels), signed
	float get_forward_speed() const; // chassis velocity along its heading, m/s, signed
	int get_gear() const;
	int get_selector() const;
	bool is_automatic() const;
	int get_forward_gear_count() const;
	bool is_engine_running() const;
	bool is_engine_cranking() const;
	bool is_abs_active() const;
	int get_stall_count() const;
	int get_grind_count() const;
	float get_odometer() const;
	float get_clutch_engagement() const;
	float get_throttle_opening() const;
	float get_idle_rpm() const;
	float get_redline_rpm() const;
	float get_steering_lock() const;
	float get_wheel_radius() const;
	float get_max_road_angle() const; // degrees, inner wheel at full lock
	float get_wheelbase() const;
	Dictionary get_debug_info() const;

	bool get_wheel_contact(int i) const;
	Transform3D get_wheel_transform(int i) const; // local, suspension + steer + spin
	Vector3 get_wheel_ground_point(int i) const; // world, last contact point (or wheel bottom)
	int get_wheel_surface(int i) const;
	float get_wheel_slip(int i) const; // combined normalised slip, >1 = sliding
	float get_wheel_slide_speed(int i) const; // m/s the tyre rubs over the road
	bool is_wheel_sliding(int i) const;
	float get_wheel_load(int i) const;
	float get_wheel_brake_torque(int i) const;
	float get_wheel_steer(int i) const;
	float get_wheel_rotation(int i) const; // accumulated spin angle, rad
	Vector3 get_wheel_position(int i) const; // local wheel-centre position
	Vector3 get_wheel_mount(int i) const; // local

protected:
	static void _bind_methods();

private:
	struct WheelRuntime {
		bool contact = false;
		double length = 0.0;
		double prev_length = 0.0;
		bool had_contact = false;
		Vector3 point;
		Vector3 normal = Vector3(0, 1, 0);
		int surface = 0;
	};

	void apply_body_params();
	int surface_at(const Vector3 &p) const;

	String preset_ = "nexia2";
	std::unique_ptr<avto::VehicleSim> sim_;
	avto::DriverInput input_;
	std::array<WheelRuntime, 4> wheels_{};
	Ref<CylinderShape3D> wheel_shape_;
	uint32_t wheel_mask_ = 1;

	// Surface lookup grid (world x/z -> surface id).
	PackedByteArray surf_cells_;
	int surf_w_ = 0;
	int surf_h_ = 0;
	Vector2 surf_origin_;
	float surf_cell_ = 1.0f;
	PackedFloat32Array surf_grip_;
	PackedFloat32Array surf_rolling_;

	uint32_t last_stall_count_ = 0;
	bool was_running_ = false;
	bool pending_teleport_ = false;
	Transform3D teleport_xform_;
	bool teleport_running_ = false;
};

} // namespace godot
