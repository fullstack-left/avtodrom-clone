#include "avto_vehicle.h"

#include <godot_cpp/classes/physics_direct_space_state3d.hpp>
#include <godot_cpp/classes/physics_ray_query_parameters3d.hpp>
#include <godot_cpp/classes/physics_shape_query_parameters3d.hpp>
#include <godot_cpp/core/class_db.hpp>
#include <godot_cpp/core/math.hpp>
#include <godot_cpp/variant/typed_array.hpp>
#include <godot_cpp/variant/utility_functions.hpp>

namespace godot {

namespace {

constexpr double kCastHeadroom = 0.12; // sweep starts this far above the bump stop
constexpr double kAirDensity = 1.2;
constexpr double kMinGroundNormalY = 0.25; // steeper than this is a wall, not ground

bool valid_wheel(int i) {
	return i >= 0 && i < 4;
}

} // namespace

AvtoVehicle::AvtoVehicle() {
	wheel_shape_.instantiate();
	sim_ = std::make_unique<avto::VehicleSim>(avto::make_preset(preset_.utf8().get_data()));
}

AvtoVehicle::~AvtoVehicle() = default;

void AvtoVehicle::_bind_methods() {
	ClassDB::bind_method(D_METHOD("set_preset", "id"), &AvtoVehicle::set_preset);
	ClassDB::bind_method(D_METHOD("get_preset"), &AvtoVehicle::get_preset);
	ClassDB::bind_method(D_METHOD("set_wheel_collision_mask", "mask"), &AvtoVehicle::set_wheel_collision_mask);
	ClassDB::bind_method(D_METHOD("get_wheel_collision_mask"), &AvtoVehicle::get_wheel_collision_mask);
	ClassDB::bind_method(D_METHOD("set_surface_map", "cells", "width", "height", "origin", "cell_size", "grip", "rolling"),
			&AvtoVehicle::set_surface_map);

	ClassDB::bind_method(D_METHOD("set_throttle", "value"), &AvtoVehicle::set_throttle);
	ClassDB::bind_method(D_METHOD("get_throttle"), &AvtoVehicle::get_throttle);
	ClassDB::bind_method(D_METHOD("set_brake", "value"), &AvtoVehicle::set_brake);
	ClassDB::bind_method(D_METHOD("get_brake"), &AvtoVehicle::get_brake);
	ClassDB::bind_method(D_METHOD("set_clutch", "value"), &AvtoVehicle::set_clutch);
	ClassDB::bind_method(D_METHOD("get_clutch"), &AvtoVehicle::get_clutch);
	ClassDB::bind_method(D_METHOD("set_handbrake", "value"), &AvtoVehicle::set_handbrake);
	ClassDB::bind_method(D_METHOD("get_handbrake"), &AvtoVehicle::get_handbrake);
	ClassDB::bind_method(D_METHOD("set_steering_wheel", "degrees"), &AvtoVehicle::set_steering_wheel);
	ClassDB::bind_method(D_METHOD("get_steering_wheel"), &AvtoVehicle::get_steering_wheel);
	ClassDB::bind_method(D_METHOD("set_ignition", "on"), &AvtoVehicle::set_ignition);
	ClassDB::bind_method(D_METHOD("get_ignition"), &AvtoVehicle::get_ignition);
	ClassDB::bind_method(D_METHOD("set_starter", "on"), &AvtoVehicle::set_starter);
	ClassDB::bind_method(D_METHOD("get_starter"), &AvtoVehicle::get_starter);
	ClassDB::bind_method(D_METHOD("set_auto_clutch", "on"), &AvtoVehicle::set_auto_clutch);
	ClassDB::bind_method(D_METHOD("get_auto_clutch"), &AvtoVehicle::get_auto_clutch);
	ClassDB::bind_method(D_METHOD("request_gear", "gear_or_selector"), &AvtoVehicle::request_gear);

	ClassDB::bind_method(D_METHOD("teleport", "xform", "engine_running"), &AvtoVehicle::teleport);
	ClassDB::bind_method(D_METHOD("get_rpm"), &AvtoVehicle::get_rpm);
	ClassDB::bind_method(D_METHOD("get_speed_kmh"), &AvtoVehicle::get_speed_kmh);
	ClassDB::bind_method(D_METHOD("get_forward_speed"), &AvtoVehicle::get_forward_speed);
	ClassDB::bind_method(D_METHOD("get_gear"), &AvtoVehicle::get_gear);
	ClassDB::bind_method(D_METHOD("get_selector"), &AvtoVehicle::get_selector);
	ClassDB::bind_method(D_METHOD("is_automatic"), &AvtoVehicle::is_automatic);
	ClassDB::bind_method(D_METHOD("get_forward_gear_count"), &AvtoVehicle::get_forward_gear_count);
	ClassDB::bind_method(D_METHOD("is_engine_running"), &AvtoVehicle::is_engine_running);
	ClassDB::bind_method(D_METHOD("is_engine_cranking"), &AvtoVehicle::is_engine_cranking);
	ClassDB::bind_method(D_METHOD("is_abs_active"), &AvtoVehicle::is_abs_active);
	ClassDB::bind_method(D_METHOD("get_stall_count"), &AvtoVehicle::get_stall_count);
	ClassDB::bind_method(D_METHOD("get_grind_count"), &AvtoVehicle::get_grind_count);
	ClassDB::bind_method(D_METHOD("get_odometer"), &AvtoVehicle::get_odometer);
	ClassDB::bind_method(D_METHOD("get_clutch_engagement"), &AvtoVehicle::get_clutch_engagement);
	ClassDB::bind_method(D_METHOD("get_throttle_opening"), &AvtoVehicle::get_throttle_opening);
	ClassDB::bind_method(D_METHOD("get_idle_rpm"), &AvtoVehicle::get_idle_rpm);
	ClassDB::bind_method(D_METHOD("get_redline_rpm"), &AvtoVehicle::get_redline_rpm);
	ClassDB::bind_method(D_METHOD("get_steering_lock"), &AvtoVehicle::get_steering_lock);
	ClassDB::bind_method(D_METHOD("get_wheel_radius"), &AvtoVehicle::get_wheel_radius);
	ClassDB::bind_method(D_METHOD("get_max_road_angle"), &AvtoVehicle::get_max_road_angle);
	ClassDB::bind_method(D_METHOD("get_wheelbase"), &AvtoVehicle::get_wheelbase);
	ClassDB::bind_method(D_METHOD("get_debug_info"), &AvtoVehicle::get_debug_info);

	ClassDB::bind_method(D_METHOD("get_wheel_contact", "index"), &AvtoVehicle::get_wheel_contact);
	ClassDB::bind_method(D_METHOD("get_wheel_transform", "index"), &AvtoVehicle::get_wheel_transform);
	ClassDB::bind_method(D_METHOD("get_wheel_ground_point", "index"), &AvtoVehicle::get_wheel_ground_point);
	ClassDB::bind_method(D_METHOD("get_wheel_surface", "index"), &AvtoVehicle::get_wheel_surface);
	ClassDB::bind_method(D_METHOD("get_wheel_slip", "index"), &AvtoVehicle::get_wheel_slip);
	ClassDB::bind_method(D_METHOD("is_wheel_sliding", "index"), &AvtoVehicle::is_wheel_sliding);
	ClassDB::bind_method(D_METHOD("get_wheel_slide_speed", "index"), &AvtoVehicle::get_wheel_slide_speed);
	ClassDB::bind_method(D_METHOD("get_wheel_load", "index"), &AvtoVehicle::get_wheel_load);
	ClassDB::bind_method(D_METHOD("get_wheel_brake_torque", "index"), &AvtoVehicle::get_wheel_brake_torque);
	ClassDB::bind_method(D_METHOD("get_wheel_steer", "index"), &AvtoVehicle::get_wheel_steer);
	ClassDB::bind_method(D_METHOD("get_wheel_mount", "index"), &AvtoVehicle::get_wheel_mount);
	ClassDB::bind_method(D_METHOD("get_wheel_rotation", "index"), &AvtoVehicle::get_wheel_rotation);
	ClassDB::bind_method(D_METHOD("get_wheel_position", "index"), &AvtoVehicle::get_wheel_position);

	ADD_PROPERTY(PropertyInfo(Variant::STRING, "preset"), "set_preset", "get_preset");
	ADD_PROPERTY(PropertyInfo(Variant::INT, "wheel_collision_mask", PROPERTY_HINT_LAYERS_3D_PHYSICS),
			"set_wheel_collision_mask", "get_wheel_collision_mask");
	ADD_PROPERTY(PropertyInfo(Variant::FLOAT, "throttle"), "set_throttle", "get_throttle");
	ADD_PROPERTY(PropertyInfo(Variant::FLOAT, "brake"), "set_brake", "get_brake");
	ADD_PROPERTY(PropertyInfo(Variant::FLOAT, "clutch"), "set_clutch", "get_clutch");
	ADD_PROPERTY(PropertyInfo(Variant::FLOAT, "handbrake"), "set_handbrake", "get_handbrake");
	ADD_PROPERTY(PropertyInfo(Variant::FLOAT, "steering_wheel"), "set_steering_wheel", "get_steering_wheel");
	ADD_PROPERTY(PropertyInfo(Variant::BOOL, "ignition"), "set_ignition", "get_ignition");
	ADD_PROPERTY(PropertyInfo(Variant::BOOL, "starter"), "set_starter", "get_starter");
	ADD_PROPERTY(PropertyInfo(Variant::BOOL, "auto_clutch"), "set_auto_clutch", "get_auto_clutch");

	ADD_SIGNAL(MethodInfo("engine_stalled"));
	ADD_SIGNAL(MethodInfo("engine_started"));
}

void AvtoVehicle::_ready() {
	apply_body_params();
}

void AvtoVehicle::set_preset(const String &p_id) {
	preset_ = p_id;
	sim_ = std::make_unique<avto::VehicleSim>(avto::make_preset(preset_.utf8().get_data()));
	for (int i = 0; i < 4; ++i) {
		wheels_[static_cast<size_t>(i)] = WheelRuntime{};
		wheels_[static_cast<size_t>(i)].length = sim_->max_length(i);
		wheels_[static_cast<size_t>(i)].prev_length = sim_->max_length(i);
	}
	last_stall_count_ = 0;
	if (is_inside_tree()) {
		apply_body_params();
	}
}

void AvtoVehicle::apply_body_params() {
	const avto::VehicleParams &p = sim_->params();
	set_mass(static_cast<real_t>(p.mass));
	set_center_of_mass_mode(CENTER_OF_MASS_MODE_CUSTOM);
	set_center_of_mass(Vector3(static_cast<real_t>(p.center_of_mass[0]), static_cast<real_t>(p.center_of_mass[1]),
			static_cast<real_t>(p.center_of_mass[2])));
	// Godot's inertia vector is about the local x (pitch), y (yaw), z (roll) axes.
	set_inertia(Vector3(static_cast<real_t>(p.inertia[2]), static_cast<real_t>(p.inertia[1]),
			static_cast<real_t>(p.inertia[0])));
	set_can_sleep(false);
	wheel_shape_->set_radius(static_cast<real_t>(p.tire.radius));
	wheel_shape_->set_height(static_cast<real_t>(p.tire.width));
}

void AvtoVehicle::set_surface_map(const PackedByteArray &p_cells, int p_width, int p_height, const Vector2 &p_origin,
		float p_cell_size, const PackedFloat32Array &p_grip, const PackedFloat32Array &p_rolling) {
	surf_cells_ = p_cells;
	surf_w_ = p_width;
	surf_h_ = p_height;
	surf_origin_ = p_origin;
	surf_cell_ = p_cell_size > 0.0f ? p_cell_size : 1.0f;
	surf_grip_ = p_grip;
	surf_rolling_ = p_rolling;
}

int AvtoVehicle::surface_at(const Vector3 &p) const {
	if (surf_w_ <= 0 || surf_h_ <= 0) {
		return 0;
	}
	const int ix = static_cast<int>(Math::floor((p.x - surf_origin_.x) / surf_cell_));
	const int iz = static_cast<int>(Math::floor((p.z - surf_origin_.y) / surf_cell_));
	if (ix < 0 || iz < 0 || ix >= surf_w_ || iz >= surf_h_) {
		return 0;
	}
	return surf_cells_[static_cast<int64_t>(iz) * surf_w_ + ix];
}

bool AvtoVehicle::request_gear(int gear_or_selector) {
	return sim_->request_gear(gear_or_selector, input_.clutch, input_.auto_clutch);
}

void AvtoVehicle::teleport(const Transform3D &p_xform, bool p_engine_running) {
	pending_teleport_ = true;
	teleport_xform_ = p_xform;
	teleport_running_ = p_engine_running;
	set_global_transform(p_xform);
	set_linear_velocity(Vector3());
	set_angular_velocity(Vector3());
	sim_->reset(p_engine_running);
	for (int i = 0; i < 4; ++i) {
		WheelRuntime &w = wheels_[static_cast<size_t>(i)];
		w = WheelRuntime{};
		w.length = sim_->max_length(i);
		w.prev_length = w.length;
	}
	last_stall_count_ = 0;
	was_running_ = p_engine_running;
}

void AvtoVehicle::_integrate_forces(PhysicsDirectBodyState3D *p_state) {
	if (pending_teleport_) {
		pending_teleport_ = false;
		p_state->set_transform(teleport_xform_);
		p_state->set_linear_velocity(Vector3());
		p_state->set_angular_velocity(Vector3());
		return;
	}
	const double dt = p_state->get_step();
	if (dt <= 0.0) {
		return;
	}
	const avto::VehicleParams &p = sim_->params();
	const Transform3D xform = p_state->get_transform();
	const Vector3 right = xform.basis.get_column(0).normalized();
	const Vector3 up = xform.basis.get_column(1).normalized();
	const Vector3 forward = -xform.basis.get_column(2).normalized();
	const Vector3 down = -up;
	const Vector3 lin_vel = p_state->get_linear_velocity();
	const Vector3 ang_vel = p_state->get_angular_velocity();
	const Vector3 com = xform.origin + p_state->get_center_of_mass();
	PhysicsDirectSpaceState3D *space = p_state->get_space_state();

	Ref<PhysicsShapeQueryParameters3D> query;
	query.instantiate();
	query->set_shape(wheel_shape_);
	query->set_collision_mask(wheel_mask_);
	TypedArray<RID> exclude;
	exclude.push_back(get_rid());
	query->set_exclude(exclude);

	std::array<avto::WheelContact, 4> contacts{};
	std::array<Vector3, 4> heading{};
	std::array<Vector3, 4> lateral{};
	const double radius = p.tire.radius;

	for (int i = 0; i < 4; ++i) {
		const size_t k = static_cast<size_t>(i);
		const avto::WheelParams &wp = p.wheels[k];
		WheelRuntime &w = wheels_[k];
		const double steer = sim_->wheels()[k].steer;
		const Vector3 mount = xform.xform(Vector3(static_cast<real_t>(wp.x), static_cast<real_t>(wp.y),
				static_cast<real_t>(wp.z)));
		const double s0 = sim_->min_length(i) - kCastHeadroom;
		const double s1 = sim_->max_length(i);
		const Vector3 start = mount + down * static_cast<real_t>(s0);
		const Vector3 motion = down * static_cast<real_t>(s1 - s0);
		const Basis shape_basis = xform.basis * Basis(Vector3(0, 1, 0), static_cast<real_t>(-steer)) *
				Basis(Vector3(0, 0, 1), static_cast<real_t>(Math::PI * 0.5));

		query->set_transform(Transform3D(shape_basis, start));
		query->set_motion(motion);
		const PackedFloat32Array cast = space->cast_motion(query);
		const double safe = cast.size() >= 2 ? cast[0] : 1.0;
		const double unsafe = cast.size() >= 2 ? cast[1] : 1.0;

		bool contact = false;
		double length = s1;
		Vector3 point = mount + down * static_cast<real_t>(s1 + radius);
		Vector3 normal = up;
		Vector3 ground_vel;
		if (unsafe < 1.0 - 1e-6 || safe < 1.0 - 1e-6) {
			length = s0 + safe * (s1 - s0);
			query->set_transform(Transform3D(shape_basis, start + motion * static_cast<real_t>(unsafe)));
			query->set_motion(Vector3());
			const Dictionary info = space->get_rest_info(query);
			if (!info.is_empty()) {
				point = info["point"];
				normal = Vector3(info["normal"]).normalized();
				ground_vel = info["linear_velocity"];
			} else {
				point = mount + down * static_cast<real_t>(length + radius);
			}
			contact = normal.dot(up) > kMinGroundNormalY;
		}
		if (!contact && safe <= 1e-6) {
			// Started inside something (e.g. pressed against a wall): fall back to a ray.
			Ref<PhysicsRayQueryParameters3D> ray = PhysicsRayQueryParameters3D::create(
					mount, mount + down * static_cast<real_t>(s1 + radius), wheel_mask_, exclude);
			const Dictionary hit = space->intersect_ray(ray);
			if (!hit.is_empty()) {
				const Vector3 hp = hit["position"];
				const Vector3 hn = Vector3(hit["normal"]).normalized();
				if (hn.dot(up) > kMinGroundNormalY) {
					contact = true;
					point = hp;
					normal = hn;
					length = Math::clamp(static_cast<double>((hp - mount).dot(down)) - radius, s0, s1);
				}
			}
		}

		w.contact = contact;
		w.length = contact ? length : s1;
		w.point = point;
		w.normal = normal;
		w.surface = contact ? surface_at(point) : 0;

		avto::WheelContact &c = contacts[k];
		c.contact = contact;
		c.spring_length = w.length;
		c.spring_velocity = w.had_contact ? (w.length - w.prev_length) / dt : 0.0;
		w.prev_length = w.length;
		w.had_contact = contact;

		const Vector3 h = forward * static_cast<real_t>(Math::cos(steer)) + right * static_cast<real_t>(Math::sin(steer));
		Vector3 hp = h - normal * normal.dot(h);
		if (hp.length_squared() < 1e-8) {
			hp = h;
		}
		hp.normalize();
		const Vector3 lp = normal.cross(hp).normalized();
		heading[k] = hp;
		lateral[k] = lp;
		if (contact) {
			const Vector3 v = lin_vel + ang_vel.cross(point - com) - ground_vel;
			c.vx = v.dot(hp);
			c.vy = v.dot(lp);
			const int s = w.surface;
			c.grip = (s >= 0 && s < surf_grip_.size()) ? surf_grip_[s] : 1.0;
			c.rolling_resistance = (s >= 0 && s < surf_rolling_.size()) ? surf_rolling_[s] : 1.0;
		}
	}

	sim_->step(dt, input_, contacts);

	for (int i = 0; i < 4; ++i) {
		const size_t k = static_cast<size_t>(i);
		const avto::WheelOutput &o = sim_->wheels()[k];
		const WheelRuntime &w = wheels_[k];
		if (!w.contact) {
			continue;
		}
		const Vector3 force = up * static_cast<real_t>(o.fz) + heading[k] * static_cast<real_t>(o.fx) +
				lateral[k] * static_cast<real_t>(o.fy);
		p_state->apply_force(force, w.point - xform.origin);
	}
	const real_t speed = lin_vel.length();
	if (speed > 0.01f) {
		p_state->apply_central_force(-lin_vel * static_cast<real_t>(0.5 * kAirDensity * p.drag_area) * speed);
	}

	const avto::VehicleTelemetry &t = sim_->telemetry();
	if (t.stall_count != last_stall_count_) {
		last_stall_count_ = t.stall_count;
		emit_signal("engine_stalled");
	}
	if (t.engine_running && !was_running_) {
		emit_signal("engine_started");
	}
	was_running_ = t.engine_running;
}

float AvtoVehicle::get_rpm() const {
	return static_cast<float>(sim_->telemetry().rpm);
}

float AvtoVehicle::get_speed_kmh() const {
	return static_cast<float>(sim_->telemetry().speed * 3.6);
}

float AvtoVehicle::get_forward_speed() const {
	const Vector3 fwd = -get_global_transform().basis.get_column(2).normalized();
	return static_cast<float>(get_linear_velocity().dot(fwd));
}

int AvtoVehicle::get_gear() const {
	return sim_->telemetry().gear;
}

int AvtoVehicle::get_selector() const {
	return sim_->telemetry().selector;
}

bool AvtoVehicle::is_automatic() const {
	return sim_->params().gearbox.type == avto::TransmissionType::Automatic;
}

int AvtoVehicle::get_forward_gear_count() const {
	return static_cast<int>(sim_->params().gearbox.forward.size());
}

bool AvtoVehicle::is_engine_running() const {
	return sim_->telemetry().engine_running;
}

bool AvtoVehicle::is_engine_cranking() const {
	return sim_->telemetry().engine_cranking;
}

bool AvtoVehicle::is_abs_active() const {
	return sim_->telemetry().abs_active;
}

int AvtoVehicle::get_stall_count() const {
	return static_cast<int>(sim_->telemetry().stall_count);
}

int AvtoVehicle::get_grind_count() const {
	return static_cast<int>(sim_->telemetry().grind_count);
}

float AvtoVehicle::get_odometer() const {
	return static_cast<float>(sim_->telemetry().odometer);
}

float AvtoVehicle::get_clutch_engagement() const {
	return static_cast<float>(sim_->telemetry().clutch_engagement);
}

float AvtoVehicle::get_throttle_opening() const {
	return static_cast<float>(sim_->telemetry().throttle_opening);
}

float AvtoVehicle::get_idle_rpm() const {
	const avto::VehicleParams &p = sim_->params();
	return static_cast<float>(
			p.gearbox.type == avto::TransmissionType::Automatic ? p.gearbox.creep_idle_rpm : p.engine.idle_rpm);
}

float AvtoVehicle::get_redline_rpm() const {
	return static_cast<float>(sim_->params().engine.redline_rpm);
}

float AvtoVehicle::get_steering_lock() const {
	return static_cast<float>(sim_->params().steering.wheel_lock_deg);
}

float AvtoVehicle::get_wheel_radius() const {
	return static_cast<float>(sim_->params().tire.radius);
}

float AvtoVehicle::get_max_road_angle() const {
	return static_cast<float>(sim_->params().steering.max_road_angle_deg);
}

float AvtoVehicle::get_wheelbase() const {
	return static_cast<float>(sim_->params().wheelbase);
}

Dictionary AvtoVehicle::get_debug_info() const {
	const avto::VehicleTelemetry &t = sim_->telemetry();
	Dictionary d;
	d["rpm"] = t.rpm;
	d["speed_kmh"] = t.speed * 3.6;
	d["engine_torque"] = t.engine_torque;
	d["clutch_torque"] = t.clutch_torque;
	d["clutch_engagement"] = t.clutch_engagement;
	d["throttle_opening"] = t.throttle_opening;
	d["gear"] = t.gear;
	d["running"] = t.engine_running;
	d["abs"] = t.abs_active;
	Array fz;
	Array slip;
	for (int i = 0; i < 4; ++i) {
		fz.push_back(sim_->wheels()[static_cast<size_t>(i)].fz);
		slip.push_back(get_wheel_slip(i));
	}
	d["fz"] = fz;
	d["slip"] = slip;
	return d;
}

bool AvtoVehicle::get_wheel_contact(int i) const {
	return valid_wheel(i) && wheels_[static_cast<size_t>(i)].contact;
}

Transform3D AvtoVehicle::get_wheel_transform(int i) const {
	if (!valid_wheel(i)) {
		return Transform3D();
	}
	const size_t k = static_cast<size_t>(i);
	const avto::WheelParams &wp = sim_->params().wheels[k];
	const avto::WheelOutput &o = sim_->wheels()[k];
	const Basis b = Basis(Vector3(0, 1, 0), static_cast<real_t>(-o.steer)) *
			Basis(Vector3(1, 0, 0), static_cast<real_t>(-o.rotation));
	return Transform3D(b, Vector3(static_cast<real_t>(wp.x), static_cast<real_t>(wp.y - wheels_[k].length),
			static_cast<real_t>(wp.z)));
}

Vector3 AvtoVehicle::get_wheel_ground_point(int i) const {
	return valid_wheel(i) ? wheels_[static_cast<size_t>(i)].point : Vector3();
}

int AvtoVehicle::get_wheel_surface(int i) const {
	return valid_wheel(i) ? wheels_[static_cast<size_t>(i)].surface : 0;
}

float AvtoVehicle::get_wheel_slip(int i) const {
	if (!valid_wheel(i)) {
		return 0.0f;
	}
	const avto::TireParams &tp = sim_->params().tire;
	const avto::WheelOutput &o = sim_->wheels()[static_cast<size_t>(i)];
	const double nx = o.slip_long / tp.peak_slip_long;
	const double ny = o.slip_lat / tp.peak_slip_lat;
	return static_cast<float>(Math::sqrt(nx * nx + ny * ny));
}

float AvtoVehicle::get_wheel_slide_speed(int i) const {
	return valid_wheel(i) ? static_cast<float>(sim_->wheels()[static_cast<size_t>(i)].slide_speed) : 0.0f;
}

bool AvtoVehicle::is_wheel_sliding(int i) const {
	return valid_wheel(i) && sim_->wheels()[static_cast<size_t>(i)].sliding;
}

float AvtoVehicle::get_wheel_load(int i) const {
	return valid_wheel(i) ? static_cast<float>(sim_->wheels()[static_cast<size_t>(i)].fz) : 0.0f;
}

float AvtoVehicle::get_wheel_brake_torque(int i) const {
	return valid_wheel(i) ? static_cast<float>(sim_->wheels()[static_cast<size_t>(i)].brake_torque) : 0.0f;
}

float AvtoVehicle::get_wheel_steer(int i) const {
	return valid_wheel(i) ? static_cast<float>(sim_->wheels()[static_cast<size_t>(i)].steer) : 0.0f;
}

float AvtoVehicle::get_wheel_rotation(int i) const {
	return valid_wheel(i) ? static_cast<float>(sim_->wheels()[static_cast<size_t>(i)].rotation) : 0.0f;
}

Vector3 AvtoVehicle::get_wheel_position(int i) const {
	if (!valid_wheel(i)) {
		return Vector3();
	}
	const avto::WheelParams &wp = sim_->params().wheels[static_cast<size_t>(i)];
	return Vector3(static_cast<real_t>(wp.x), static_cast<real_t>(wp.y - wheels_[static_cast<size_t>(i)].length),
			static_cast<real_t>(wp.z));
}

Vector3 AvtoVehicle::get_wheel_mount(int i) const {
	if (!valid_wheel(i)) {
		return Vector3();
	}
	const avto::WheelParams &wp = sim_->params().wheels[static_cast<size_t>(i)];
	return Vector3(static_cast<real_t>(wp.x), static_cast<real_t>(wp.y), static_cast<real_t>(wp.z));
}

} // namespace godot
