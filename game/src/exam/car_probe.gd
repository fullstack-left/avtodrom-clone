class_name CarProbe
extends RefCounted
## Snapshot of the car's footprint on the ground plane, refreshed every tick.
## Body dimensions come from the car model (Car.MODELS): origin midway between
## the axles, distances to the bumpers and the half width.

const WHEEL_NAMES := ["FL", "FR", "RL", "RR"]

var car: Car
var pos := Vector2.ZERO
var fwd := Vector2(0, -1)
var right := Vector2(1, 0)
var speed := 0.0 # m/s along the heading (negative = rolling backwards)
## Ground speed, km/h, absolute: what the exam judges. Not the speedometer,
## which follows the driven wheels and jumps when they spin at a hard launch.
var speed_kmh := 0.0
var front := Vector2.ZERO
var rear := Vector2.ZERO
var corners := PackedVector2Array() # FL, FR, RR, RL
var wheels: Array[Vector2] = [Vector2.ZERO, Vector2.ZERO, Vector2.ZERO, Vector2.ZERO]
var wheel_contact: Array[bool] = [false, false, false, false]
var stopped := false # below 0.1 m/s
var stopped_time := 0.0 # seconds continuously stopped
var travelled := 0.0 # metres, total
var reversing := false


func _init(p_car: Car) -> void:
	car = p_car
	corners.resize(4)


func update(dt: float) -> void:
	var xf := car.global_transform
	pos = Vector2(xf.origin.x, xf.origin.z)
	var f3 := -xf.basis.z
	fwd = Vector2(f3.x, f3.z).normalized()
	right = Vector2(-fwd.y, fwd.x)
	front = pos + fwd * car.body_front
	rear = pos - fwd * car.body_rear
	var hw := car.body_half_width
	corners[0] = front - right * hw
	corners[1] = front + right * hw
	corners[2] = rear + right * hw
	corners[3] = rear - right * hw
	# The tyre's footprint centre is the wheel centre dropped onto the ground
	# (the physics contact point can sit anywhere across the tread).
	for i in 4:
		wheel_contact[i] = car.get_wheel_contact(i)
		var w := xf * car.get_wheel_position(i)
		wheels[i] = Vector2(w.x, w.z)
	speed = car.get_forward_speed()
	var v := car.linear_velocity
	var ground_speed := Vector2(v.x, v.z).length()
	speed_kmh = ground_speed * 3.6
	travelled += ground_speed * dt
	reversing = speed < -0.05
	if ground_speed < 0.1:
		stopped_time += dt
		stopped = true
	else:
		stopped_time = 0.0
		stopped = false


## True when every body corner lies inside `polygon` grown by `margin`.
func inside(polygon: PackedVector2Array, margin := 0.0) -> bool:
	var poly := polygon
	if margin != 0.0:
		var grown := Geometry2D.offset_polygon(polygon, margin)
		if grown.is_empty():
			return false
		poly = grown[0]
	for c in corners:
		if not Geometry2D.is_point_in_polygon(c, poly):
			return false
	return true


func heading_error_deg(yaw_deg: float) -> float:
	return Geo.angle_between(fwd, CourseData.forward2(yaw_deg))
