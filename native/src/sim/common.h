// Avtodrom — vehicle simulation core.
// Pure C++17, no engine dependencies: the Godot node and the unit tests both
// drive it through the same API. SI units everywhere (m, kg, s, N, N·m, rad).
#pragma once

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <vector>

namespace avto {

constexpr double kPi = 3.14159265358979323846;
constexpr double kGravity = 9.80665;

inline double clampd(double v, double lo, double hi) { return v < lo ? lo : (v > hi ? hi : v); }
inline double lerpd(double a, double b, double t) { return a + (b - a) * t; }
inline double signd(double v) { return (v > 0.0) - (v < 0.0); }
inline double smoothstepd(double e0, double e1, double x) {
	const double t = clampd((x - e0) / (e1 - e0), 0.0, 1.0);
	return t * t * (3.0 - 2.0 * t);
}
inline double rpm_to_rads(double rpm) { return rpm * (2.0 * kPi / 60.0); }
inline double rads_to_rpm(double w) { return w * (60.0 / (2.0 * kPi)); }

// Piecewise-linear lookup table, clamped at both ends.
struct Curve {
	std::vector<double> xs;
	std::vector<double> ys;

	Curve() = default;
	Curve(std::initializer_list<std::pair<double, double>> pts) {
		for (const auto &p : pts) {
			xs.push_back(p.first);
			ys.push_back(p.second);
		}
	}

	double eval(double x) const {
		if (xs.empty()) {
			return 0.0;
		}
		if (x <= xs.front()) {
			return ys.front();
		}
		if (x >= xs.back()) {
			return ys.back();
		}
		const auto it = std::upper_bound(xs.begin(), xs.end(), x);
		const size_t i = static_cast<size_t>(it - xs.begin());
		const double t = (x - xs[i - 1]) / (xs[i] - xs[i - 1]);
		return lerpd(ys[i - 1], ys[i], t);
	}

	double max_y() const {
		double m = 0.0;
		for (double y : ys) {
			m = std::max(m, y);
		}
		return m;
	}
};

} // namespace avto
