class_name AvtoGear
extends RefCounted
## Gear numbering shared by the UI, input and exam logic.
##   manual:    -1 = R, 0 = N, 1..5
##   automatic: selector 0 = P, 1 = R, 2 = N, 3 = D (AvtoVehicle AutoSelector)

const PARK := 0
const AUTO_REVERSE := 1
const AUTO_NEUTRAL := 2
const DRIVE := 3


static func selector_neutral(automatic: bool) -> int:
	return AUTO_NEUTRAL if automatic else 0


static func reverse(automatic: bool) -> int:
	return AUTO_REVERSE if automatic else -1


## Next gear in the shift sequence (manual R-N-1-2-3-4-5, automatic P-R-N-D).
static func step(current: int, delta: int, automatic: bool, gear_count: int) -> int:
	if automatic:
		return clampi(current + delta, PARK, DRIVE)
	return clampi(current + delta, -1, gear_count)


static func label(car: AvtoVehicle) -> String:
	if car.is_automatic():
		var sel := car.get_selector()
		match sel:
			PARK: return "P"
			AUTO_REVERSE: return "R"
			AUTO_NEUTRAL: return "N"
			_: return "D%d" % car.get_gear()
	var g := car.get_gear()
	if g == -1:
		return "R"
	if g == 0:
		return "N"
	return str(g)


## True while the gearbox is set to drive backwards.
static func in_reverse(car: AvtoVehicle) -> bool:
	if car.is_automatic():
		return car.get_selector() == AUTO_REVERSE
	return car.get_gear() == -1


## True when no drive is engaged (N, or P on the automatic).
static func in_neutral_or_park(car: AvtoVehicle) -> bool:
	if car.is_automatic():
		var s := car.get_selector()
		return s == PARK or s == AUTO_NEUTRAL
	return car.get_gear() == 0
