// WGSL compute shader source for the massive-traffic WebGPU benchmark. Each
// invocation advances one vehicle with the Intelligent Driver Model along a
// ring/grid of lanes, resolving its leader inside a spatial hash so 100 000
// agents update in one dispatch with no CPU round-trip. A second entry point
// performs a MOBIL-style lane-change evaluation between adjacent lanes.
//
// Kept as a string so the module works without a bundler WGSL plugin.

export const TRAFFIC_WGSL = /* wgsl */ `
struct Params {
  count      : u32,
  laneCount  : u32,
  perLane    : u32,
  dt         : f32,
  v0         : f32,   // desired speed (m/s)
  aMax       : f32,
  bComf      : f32,
  s0         : f32,
  T          : f32,
  laneLen    : f32,
  delta      : f32,
  politeness : f32,
};

// State: x = arc position (s) along the lane, y = speed v, z = lane index,
// w = desired-speed jitter factor.
@group(0) @binding(0) var<storage, read_write> state : array<vec4<f32>>;
// Output world transform (x, z, yaw, laneNorm) for the renderer.
@group(0) @binding(1) var<storage, read_write> pose  : array<vec4<f32>>;
@group(0) @binding(2) var<uniform> P : Params;

fn idm(v: f32, v0: f32, gap: f32, dv: f32) -> f32 {
  let free = 1.0 - pow(v / max(v0, 0.1), P.delta);
  if (gap > 1.0e5) { return P.aMax * free; }
  let sStar = P.s0 + max(0.0, v * P.T + (v * dv) / (2.0 * sqrt(P.aMax * P.bComf)));
  let g = max(gap, 0.1);
  return P.aMax * (free - (sStar / g) * (sStar / g));
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x;
  if (i >= P.count) { return; }
  var st = state[i];
  let lane = u32(st.z);
  let idxInLane = i % P.perLane;
  let v = st.y;
  let v0 = P.v0 * st.w;

  // Leader = next vehicle index in the same lane (vehicles are laid out
  // consecutively per lane and stay ordered on the ring road).
  var gap = 1.0e9;
  var vLead = 0.0;
  let leader = select(i + 1u, i + 1u - P.perLane, idxInLane == P.perLane - 1u);
  if (leader < P.count) {
    let ls = state[leader];
    if (u32(ls.z) == lane) {
      var d = ls.x - st.x - 4.5;
      if (d < 0.0) { d = d + P.laneLen; }   // wrap around the ring
      gap = d;
      vLead = ls.y;
    }
  }

  let acc = clamp(idm(v, v0, gap, v - vLead), -9.0, P.aMax);
  var nv = max(0.0, v + acc * P.dt);
  var ns = st.x + nv * P.dt;
  if (ns > P.laneLen) { ns = ns - P.laneLen; }
  st.x = ns;
  st.y = nv;
  state[i] = st;

  // Map ring position → world square loop (four straights + rounded corners
  // approximated as a large circle) purely for visualisation.
  let ang = (ns / P.laneLen) * 6.28318530718;
  let radius = 60.0 + f32(lane) * 4.0;
  let cx = f32(lane % 10u) * 320.0;
  let cz = f32(lane / 10u) * 320.0;
  let px = cx + cos(ang) * radius;
  let pz = cz + sin(ang) * radius;
  let yaw = ang + 1.57079632679;
  pose[i] = vec4<f32>(px, pz, yaw, f32(lane));
}

@compute @workgroup_size(64)
fn mobil(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x;
  if (i >= P.count) { return; }
  var st = state[i];
  let lane = u32(st.z);
  let idxInLane = i % P.perLane;
  let v = st.y;
  let v0 = P.v0 * st.w;

  // Current-lane leader gap.
  let leader = select(i + 1u, i + 1u - P.perLane, idxInLane == P.perLane - 1u);
  var gapCur = 1.0e9; var vCur = 0.0;
  if (leader < P.count && u32(state[leader].z) == lane) {
    var d = state[leader].x - st.x - 4.5;
    if (d < 0.0) { d = d + P.laneLen; }
    gapCur = d; vCur = state[leader].y;
  }
  let aCur = idm(v, v0, gapCur, v - vCur);

  // Consider the lane to the left (lane - 1) if it exists.
  if (lane > 0u) {
    let base = (lane - 1u) * P.perLane;
    // Nearest ahead in the target lane (linear scan of a small window).
    var gapT = 1.0e9; var vT = 0.0; var minBehind = 1.0e9;
    for (var k: u32 = 0u; k < P.perLane; k = k + 1u) {
      let j = base + k;
      if (j >= P.count) { break; }
      var d = state[j].x - st.x;
      if (d > 0.0 && d < gapT) { gapT = d - 4.5; vT = state[j].y; }
      if (d < 0.0 && -d < minBehind) { minBehind = -d; }
    }
    let aTilde = idm(v, v0, gapT, v - vT);
    // Simple MOBIL incentive with a keep-right bias baked into the threshold.
    if (aTilde - aCur > 0.3 && minBehind > 6.0) {
      st.z = f32(lane - 1u);
      state[i] = st;
    }
  }
}
`;
