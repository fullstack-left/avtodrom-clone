#include "tire.h"

namespace avto {

namespace {

// Magic Formula with its peak placed at s = 1: C·atan(B) = π/2.
double mf_normalized(double s, double c) {
	const double b = std::tan(kPi / (2.0 * c));
	return std::sin(c * std::atan(b * s));
}

// Deflection beyond which the contact patch is fully sliding; keeps the state
// bounded while a wheel spins or locks so it unwinds quickly afterwards.
constexpr double kMaxNormalizedSlip = 3.0;

} // namespace

void TireModel::integrate(TireState &s, double dt, double vx, double vy, double omega_r) const {
	const double avx = std::fabs(vx);
	const double sx = p_->relax_long;
	const double sy = p_->relax_lat;
	const double slip_vel = omega_r - vx;

	// Implicit (backward Euler) in the relaxation term: unconditionally stable.
	const double u_new = (s.u + dt * slip_vel) / (1.0 + dt * avx / sx);
	const double v_new = (s.v + dt * (-vy)) / (1.0 + dt * avx / sy);
	s.u_rate = (u_new - s.u) / dt;
	s.v_rate = (v_new - s.v) / dt;
	s.u = u_new;
	s.v = v_new;

	// Saturate: a sliding patch cannot store more deflection.
	const double nx = (s.u / sx) / p_->peak_slip_long;
	const double ny = (s.v / sy) / p_->peak_slip_lat;
	const double n = std::sqrt(nx * nx + ny * ny);
	if (n > kMaxNormalizedSlip) {
		const double k = kMaxNormalizedSlip / n;
		s.u *= k;
		s.v *= k;
	}
	s.slip_long = s.u / sx;
	s.slip_lat = s.v / sy;
}

void TireModel::compute_force(TireState &s, double fz, double grip, double vx) const {
	if (fz <= 0.0) {
		s.fx = 0.0;
		s.fy = 0.0;
		s.sliding = false;
		return;
	}
	const double load_ratio = fz / p_->load_nominal;
	const double mu_scale = grip * clampd(1.0 - p_->load_sensitivity * (load_ratio - 1.0), 0.6, 1.15);
	const double dx = p_->mu_long * mu_scale * fz;
	const double dy = p_->mu_lat * mu_scale * fz;

	const double nx = s.slip_long / p_->peak_slip_long;
	const double ny = s.slip_lat / p_->peak_slip_lat;
	const double n = std::sqrt(nx * nx + ny * ny);
	double fx = 0.0;
	double fy = 0.0;
	if (n > 1e-9) {
		const double f = mf_normalized(n, p_->shape_c);
		fx = dx * f * (nx / n);
		fy = dy * f * (ny / n);
	}
	s.sliding = n > 1.0;

	// Extra carcass damping at crawling speed (MF-Tyre style low-speed damping)
	// kills the patch-spring oscillation of a stopped car.
	const double fade = 1.0 - smoothstepd(0.0, p_->low_speed_fade, std::fabs(vx));
	if (fade > 0.0 && !s.sliding) {
		const double load_scale = clampd(load_ratio, 0.2, 2.0);
		fx += p_->low_speed_damping_long * load_scale * s.u_rate * fade;
		fy += p_->low_speed_damping_lat * load_scale * s.v_rate * fade;
		// Damping must never push the force past the friction limit.
		fx = clampd(fx, -dx, dx);
		fy = clampd(fy, -dy, dy);
	}
	s.fx = fx;
	s.fy = fy;
}

double TireModel::peak_force(double fz, double grip) const {
	const double load_ratio = fz / p_->load_nominal;
	const double mu_scale = grip * clampd(1.0 - p_->load_sensitivity * (load_ratio - 1.0), 0.6, 1.15);
	return p_->mu_long * mu_scale * std::max(fz, 0.0);
}

} // namespace avto
