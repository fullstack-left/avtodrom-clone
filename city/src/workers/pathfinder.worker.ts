// A* path-finding over the directed edge graph, off the main thread.
// The graph is sent once (init); afterwards the worker answers route requests
// (edge id → edge id) with the sequence of edge ids and a poly-line for the
// GPS ribbon. Legal turns come from the connector-derived adjacency, so the
// route never asks the driver to make a forbidden manoeuvre.

interface RoutingGraph {
  nodes: { x: number; z: number }[];
  edges: { from: number; to: number; dir: number; len: number; speed: number }[];
  turns: number[][];
}

let G: RoutingGraph | null = null;

interface InitMsg {
  type: 'init';
  graph: RoutingGraph;
}
interface RouteMsg {
  type: 'route';
  id: number;
  start: number;
  goal: number;
  avoid?: number[];
}
type In = InitMsg | RouteMsg;

self.onmessage = (ev: MessageEvent<In>) => {
  const msg = ev.data;
  if (msg.type === 'init') {
    G = msg.graph;
    (self as any).postMessage({ type: 'ready' });
    return;
  }
  if (msg.type === 'route' && G) {
    const path = astar(G, msg.start, msg.goal, new Set(msg.avoid ?? []));
    let poly: Float32Array | null = null;
    if (path) {
      const pts: number[] = [];
      for (const e of path) {
        const a = G.nodes[G.edges[e].from];
        const b = G.nodes[G.edges[e].to];
        pts.push(a.x, a.z, b.x, b.z);
      }
      poly = new Float32Array(pts);
    }
    (self as any).postMessage({ type: 'route', id: msg.id, edges: path, poly }, poly ? [poly.buffer] : []);
  }
};

function astar(G: RoutingGraph, start: number, goal: number, avoid: Set<number>): number[] | null {
  const E = G.edges;
  const N = E.length;
  const gCost = new Float32Array(N).fill(Infinity);
  const fCost = new Float32Array(N).fill(Infinity);
  const came = new Int32Array(N).fill(-1);
  const closed = new Uint8Array(N);
  const goalNode = G.nodes[E[goal].to];
  const h = (e: number) => {
    const n = G.nodes[E[e].to];
    return Math.hypot(n.x - goalNode.x, n.z - goalNode.z) / 16.6; // /vmax → time
  };
  gCost[start] = 0;
  fCost[start] = h(start);
  // Binary heap of edge ids keyed by fCost.
  const heap: number[] = [start];
  const less = (a: number, b: number) => fCost[a] < fCost[b];
  const push = (e: number) => {
    heap.push(e);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (less(heap[i], heap[p])) {
        [heap[i], heap[p]] = [heap[p], heap[i]];
        i = p;
      } else break;
    }
  };
  const pop = (): number => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < heap.length && less(heap[l], heap[m])) m = l;
        if (r < heap.length && less(heap[r], heap[m])) m = r;
        if (m === i) break;
        [heap[i], heap[m]] = [heap[m], heap[i]];
        i = m;
      }
    }
    return top;
  };

  while (heap.length) {
    const cur = pop();
    if (cur === goal) return reconstruct(came, cur);
    if (closed[cur]) continue;
    closed[cur] = 1;
    const baseTime = gCost[cur];
    for (const nxt of G.turns[cur]) {
      if (closed[nxt] || avoid.has(nxt)) continue;
      // cost = travel time on the next edge + small turn penalty
      const e = E[nxt];
      const cost = e.len / (e.speed / 3.6) + 1.5;
      const tentative = baseTime + cost;
      if (tentative < gCost[nxt]) {
        came[nxt] = cur;
        gCost[nxt] = tentative;
        fCost[nxt] = tentative + h(nxt);
        push(nxt);
      }
    }
  }
  return null;
}

function reconstruct(came: Int32Array, e: number): number[] {
  const out = [e];
  while (came[e] !== -1) {
    e = came[e];
    out.push(e);
  }
  out.reverse();
  return out;
}
