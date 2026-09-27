// Tyre model: normalised combined-slip Magic Formula driven by a first-order
// contact-patch deflection state (relaxation length model).
//
// Why a deflection state instead of slip ratio/angle computed directly from
// velocities: slip = (ωR − Vx) / |Vx| is undefined at a standstill, and a
// driving-school simulator spends most of its time below 10 km/h — creeping
// with the clutch, holding on the hill, parking. The deflection u (along the
// wheel) and v (across it) obey
//
//     du/dt = (ωR − Vx) − |Vx|·u/σx        dv/dt = −Vy − |Vx|·v/σy
//
// which reduces to the classic steady-state slips (κ = u/σx, tan α = v/σy) at
// speed and turns into a stiff, damped spring at a standstill, so a braked car
// holds on a slope and a stopped car does not creep sideways.
#pragma once

#include "vehicle_params.h"

namespace avto {

struct TireState {
	double u = 0.0; // longitudinal patch deflection, m
	double v = 0.0; // lateral patch deflection, m
	double u_rate = 0.0;
	double v_rate = 0.0;
	double slip_long = 0.0; // transient κ
	double slip_lat = 0.0; // transient tan α
	double fx = 0.0; // last computed forces (wheel frame)
	double fy = 0.0;
	bool sliding = false;
};

class TireModel {
public:
	explicit TireModel(const TireParams *p = nullptr) : p_(p) {}
	void set_params(const TireParams *p) { p_ = p; }

	// Advances the deflection state by dt. vx, vy: contact-point velocity in the
	// wheel frame (x forward, y left). omega_r: wheel surface speed ωR.
	void integrate(TireState &s, double dt, double vx, double vy, double omega_r) const;

	// Force from the current deflection state. fz: normal load (N, ≥ 0),
	// grip: surface friction multiplier (asphalt 1.0).
	void compute_force(TireState &s, double fz, double grip, double vx) const;

	// Peak friction force available at this load (for ABS and diagnostics).
	double peak_force(double fz, double grip) const;

private:
	const TireParams *p_;
};

} // namespace avto
