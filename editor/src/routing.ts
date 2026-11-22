// Port of Floc/Routing.swift so the browser predicts exactly what the phone does.
// Paths connect only where they really touch (shared vertex, or a line end on another line within 1 cm).
// Walkable areas use a visibility graph between their corners (inset 0.75 m) and path points inside them.
import type { Position } from 'geojson';
import { LocalProjection, effectivePolygons, layerLines, type XY } from './geo';
import type { Layer } from './types';
import { APP_SNAP_M, SEMI_SNAP_M, isWalkableLayer } from './types';

const sub = (a: XY, b: XY): XY => [a[0] - b[0], a[1] - b[1]];
const add = (a: XY, b: XY): XY => [a[0] + b[0], a[1] + b[1]];
const mul = (a: XY, k: number): XY => [a[0] * k, a[1] * k];
const dot = (a: XY, b: XY) => a[0] * b[0] + a[1] * b[1];
const dist = (a: XY, b: XY) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function closestPoint(a: XY, b: XY, p: XY): XY {
  const ab = sub(b, a);
  const len2 = dot(ab, ab);
  if (len2 === 0) return a;
  const t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / len2));
  return add(a, mul(ab, t));
}

function ringContains(ring: XY[], p: XY): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

/** Parameter t along a–b where it properly crosses c–d (not just touching), or null. */
function crossing(a: XY, b: XY, c: XY, d: XY): number | null {
  const r = sub(b, a), s = sub(d, c);
  const den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) <= 1e-12) return null;
  const q = sub(c, a);
  const t = (q[0] * s[1] - q[1] * s[0]) / den;
  const u = (q[0] * r[1] - q[1] * r[0]) / den;
  const eps = 1e-9;
  return t > eps && t < 1 - eps && u > eps && u < 1 - eps ? t : null;
}

class MinHeap {
  private items: { n: number; k: number }[] = [];
  get size() { return this.items.length; }
  push(n: number, k: number) {
    const it = this.items;
    it.push({ n, k });
    let i = it.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (it[i].k >= it[p].k) break;
      [it[i], it[p]] = [it[p], it[i]];
      i = p;
    }
  }
  pop(): { n: number; k: number } | undefined {
    const it = this.items;
    if (!it.length) return undefined;
    const top = it[0];
    const last = it.pop()!;
    if (it.length) {
      it[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < it.length && it[l].k < it[m].k) m = l;
        if (r < it.length && it[r].k < it[m].k) m = r;
        if (m === i) break;
        [it[i], it[m]] = [it[m], it[i]];
        i = m;
      }
    }
    return top;
  }
}

type Anchor = { type: 'edge'; edge: number; p: XY } | { type: 'area'; area: number; p: XY };

export interface RouteResult {
  coords: Position[]; // full line lon/lat, from click to click
  network: Position[]; // the part over the network (between the anchors)
  length: number; // metres from the start click to the end click
}

export class RoutingGraph {
  readonly proj: LocalProjection;
  nodes: XY[] = [];
  adjacency: { to: number; w: number }[][] = [];
  edges: [number, number][] = [];
  private areas: XY[][][] = [];
  private areaNodes: number[][] = [];
  pathNodeCount = 0;

  constructor(layers: Layer[]) {
    const walk = layers.filter(isWalkableLayer);
    const rawLines = walk.flatMap(layerLines).map((f) => f.geometry.coordinates);
    const rawAreas: Position[][][] = [];
    for (const l of walk) {
      for (const f of effectivePolygons(l)) {
        const g = f.geometry;
        if (g.type === 'Polygon') rawAreas.push(g.coordinates);
        else for (const p of g.coordinates) rawAreas.push(p);
      }
    }
    const all = [...rawLines.flat(), ...rawAreas.flat(2)];
    const lon0 = all.length ? (Math.min(...all.map((c) => c[0])) + Math.max(...all.map((c) => c[0]))) / 2 : 0;
    const lat0 = all.length ? (Math.min(...all.map((c) => c[1])) + Math.max(...all.map((c) => c[1]))) / 2 : 0;
    this.proj = new LocalProjection(lon0, lat0);
    const lines = rawLines.map((l) => l.map((c) => this.proj.toXY(c))).filter((l) => l.length >= 2);
    this.areas = rawAreas.map((rings) => rings.map((r) => r.map((c) => this.proj.toXY(c))));
    const tol = 0.01;

    // 1. Split points: line ends on another line's segment, and crossings with area edges.
    const splits = new Map<string, { t: number; p: XY }[]>();
    const key = (li: number, si: number) => `${li}:${si}`;
    const pushSplit = (k: string, v: { t: number; p: XY }) => { const a = splits.get(k); if (a) a.push(v); else splits.set(k, [v]); };
    // Spatial bucket of segments for the T-junction test.
    const cell = 20;
    const buckets = new Map<string, [number, number][]>();
    lines.forEach((line, li) => {
      for (let si = 0; si < line.length - 1; si++) {
        const a = line[si], b = line[si + 1];
        const x0 = Math.floor(Math.min(a[0], b[0]) / cell), x1 = Math.floor(Math.max(a[0], b[0]) / cell);
        const y0 = Math.floor(Math.min(a[1], b[1]) / cell), y1 = Math.floor(Math.max(a[1], b[1]) / cell);
        for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
          const k = `${x},${y}`;
          const arr = buckets.get(k); if (arr) arr.push([li, si]); else buckets.set(k, [[li, si]]);
        }
      }
    });
    for (const line of lines) {
      for (const end of [line[0], line[line.length - 1]]) {
        const cand = buckets.get(`${Math.floor(end[0] / cell)},${Math.floor(end[1] / cell)}`) ?? [];
        for (const [li, si] of cand) {
          const a = lines[li][si], b = lines[li][si + 1];
          if (dist(a, end) < tol || dist(b, end) < tol) continue;
          const c = closestPoint(a, b, end);
          if (dist(c, end) >= tol) continue;
          const ab = sub(b, a);
          pushSplit(key(li, si), { t: dot(sub(end, a), ab) / dot(ab, ab), p: end });
        }
      }
    }
    // An area corner lying on a path (snapped onto it) splits the path there, so area and path join.
    for (const rings of this.areas) for (const ring of rings) for (const v of ring) {
      const cand = buckets.get(`${Math.floor(v[0] / cell)},${Math.floor(v[1] / cell)}`) ?? [];
      for (const [li, si] of cand) {
        const a = lines[li][si], b = lines[li][si + 1];
        if (dist(a, v) < tol || dist(b, v) < tol) continue;
        if (dist(closestPoint(a, b, v), v) >= tol) continue;
        const ab = sub(b, a);
        pushSplit(key(li, si), { t: dot(sub(v, a), ab) / dot(ab, ab), p: v });
      }
    }
    lines.forEach((line, li) => {
      for (let si = 0; si < line.length - 1; si++) {
        for (const rings of this.areas) for (const ring of rings) {
          for (let k = 0; k < ring.length - 1; k++) {
            const t = crossing(line[si], line[si + 1], ring[k], ring[k + 1]);
            if (t != null) pushSplit(key(li, si), { t, p: add(line[si], mul(sub(line[si + 1], line[si]), t)) });
          }
        }
      }
    });

    // 2. Nodes merged on a 1 cm grid, and path edges.
    const index = new Map<string, number>();
    const node = (p: XY) => {
      const k = `${Math.round(p[0] * 100)},${Math.round(p[1] * 100)}`;
      const i = index.get(k);
      if (i != null) return i;
      this.nodes.push(p); this.adjacency.push([]);
      index.set(k, this.nodes.length - 1);
      return this.nodes.length - 1;
    };
    const link = (a: number, b: number) => {
      const w = dist(this.nodes[a], this.nodes[b]);
      this.adjacency[a].push({ to: b, w });
      this.adjacency[b].push({ to: a, w });
    };
    lines.forEach((line, li) => {
      for (let si = 0; si < line.length - 1; si++) {
        const pts: XY[] = [line[si], ...(splits.get(key(li, si)) ?? []).sort((x, y) => x.t - y.t).map((s) => s.p), line[si + 1]];
        for (let k = 0; k < pts.length - 1; k++) {
          if (dist(pts[k], pts[k + 1]) <= 0) continue;
          const ia = node(pts[k]), ib = node(pts[k + 1]);
          if (ia === ib) continue;
          link(ia, ib);
          this.edges.push([ia, ib]);
        }
      }
    });

    // 3. Open areas: link every pair of mutually visible points.
    this.pathNodeCount = this.nodes.length;
    this.areas.forEach((rings, ai) => {
      const members = new Set<number>();
      for (const ring of rings) {
        const pts = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring.slice(0, -1) : ring;
        if (pts.length < 3) continue;
        for (let i = 0; i < pts.length; i++) {
          const p = this.inset(pts[i], pts[(i + pts.length - 1) % pts.length], pts[(i + 1) % pts.length], ai);
          if (p) members.add(node(p));
        }
      }
      for (let n = 0; n < this.pathNodeCount; n++) if (this.inArea(this.nodes[n], ai) || this.onEdge(this.nodes[n], ai)) members.add(n);
      const list = [...members].sort((a, b) => a - b);
      for (let i = 0; i < list.length; i++)
        for (let j = i + 1; j < list.length; j++)
          if (this.visible(this.nodes[list[i]], this.nodes[list[j]], ai)) link(list[i], list[j]);
      this.areaNodes.push(list);
    });
  }

  private inArea(p: XY, ai: number): boolean {
    const rings = this.areas[ai];
    if (!rings[0] || !ringContains(rings[0], p)) return false;
    return !rings.slice(1).some((r) => ringContains(r, p));
  }

  private onEdge(p: XY, ai: number): boolean {
    for (const ring of this.areas[ai]) for (let k = 0; k < ring.length - 1; k++) if (dist(closestPoint(ring[k], ring[k + 1], p), p) < 0.02) return true;
    return false;
  }

  private inset(v: XY, prev: XY, next: XY, ai: number): XY | null {
    const unit = (d: XY): XY => { const l = Math.hypot(d[0], d[1]); return l > 0 ? [d[0] / l, d[1] / l] : d; };
    const d1 = unit(sub(v, prev)), d2 = unit(sub(next, v));
    let dir = unit(add([-d1[1], d1[0]], [-d2[1], d2[0]]));
    if (dir[0] === 0 && dir[1] === 0) dir = [-d1[1], d1[0]];
    for (const c of [add(v, mul(dir, 0.75)), sub(v, mul(dir, 0.75))]) if (this.inArea(c, ai)) return c;
    return null;
  }

  private visible(a: XY, b: XY, ai: number): boolean {
    for (const ring of this.areas[ai]) for (let k = 0; k < ring.length - 1; k++) if (crossing(a, b, ring[k], ring[k + 1]) != null) return false;
    const steps = Math.max(2, Math.floor(dist(a, b) / 3));
    for (let i = 1; i < steps; i++) if (!this.inArea(add(a, mul(sub(b, a), i / steps)), ai)) return false;
    return true;
  }

  private nearest(p: XY): { edge: number; p: XY } | null {
    let best: { edge: number; p: XY } | null = null;
    let bd = Infinity;
    this.edges.forEach(([a, b], i) => {
      const c = closestPoint(this.nodes[a], this.nodes[b], p);
      const d = dist(c, p);
      if (d < bd) { bd = d; best = { edge: i, p: c }; }
    });
    return best;
  }

  private anchor(p: XY): Anchor | null {
    const ai = this.areas.findIndex((_, i) => this.inArea(p, i));
    if (ai >= 0) return { type: 'area', area: ai, p };
    const n = this.nearest(p);
    return n ? { type: 'edge', edge: n.edge, p: n.p } : null;
  }

  private links(a: Anchor): { n: number; c: number }[] {
    if (a.type === 'edge') return this.edges[a.edge].map((n) => ({ n, c: dist(a.p, this.nodes[n]) }));
    return this.areaNodes[a.area].filter((n) => this.visible(a.p, this.nodes[n], a.area)).map((n) => ({ n, c: dist(a.p, this.nodes[n]) }));
  }

  /** Dijkstra from a start point; returns distances to every node plus a path finder. */
  private search(s: Anchor) {
    const d = new Float64Array(this.nodes.length).fill(Infinity);
    const prev = new Int32Array(this.nodes.length).fill(-1);
    const heap = new MinHeap();
    for (const { n, c } of this.links(s)) if (c < d[n]) { d[n] = c; heap.push(n, c); }
    while (heap.size) {
      const { n: u, k } = heap.pop()!;
      if (k > d[u]) continue;
      for (const { to, w } of this.adjacency[u]) if (k + w < d[to]) { d[to] = k + w; prev[to] = u; heap.push(to, k + w); }
    }
    return { d, prev };
  }

  private finish(s: Anchor, t: Anchor, d: Float64Array, prev: Int32Array): { path: XY[]; len: number } | null {
    let bestEnd = -1, bestTotal = Infinity;
    for (const { n, c } of this.links(t)) if (d[n] + c < bestTotal) { bestTotal = d[n] + c; bestEnd = n; }
    const direct = dist(s.p, t.p);
    let directOK = false;
    if (s.type === 'edge' && t.type === 'edge') {
      const ea = this.edges[s.edge], eb = this.edges[t.edge];
      directOK = s.edge === t.edge || (ea[0] === eb[1] && ea[1] === eb[0]);
    } else if (s.type === 'area' && t.type === 'area') directOK = s.area === t.area && this.visible(s.p, t.p, s.area);
    if (directOK && direct <= bestTotal) return { path: [s.p, t.p], len: direct };
    if (bestEnd < 0 || !isFinite(bestTotal)) return null;
    const chain: XY[] = [];
    for (let n = bestEnd; n !== -1; n = prev[n]) chain.push(this.nodes[n]);
    chain.reverse();
    return { path: [s.p, ...chain, t.p], len: bestTotal };
  }

  private result(from: XY, to: XY, r: { path: XY[]; len: number }): RouteResult {
    const net = r.path.map((p) => this.proj.toLonLat(p));
    return {
      coords: [this.proj.toLonLat(from), ...net, this.proj.toLonLat(to)],
      network: net,
      length: r.len + dist(from, r.path[0]) + dist(r.path[r.path.length - 1], to),
    };
  }

  route(from: Position, to: Position): RouteResult | null {
    const p = this.proj.toXY(from), q = this.proj.toXY(to);
    const s = this.anchor(p), t = this.anchor(q);
    if (!s || !t) return null;
    const { d, prev } = this.search(s);
    const r = this.finish(s, t, d, prev);
    return r ? this.result(p, q, r) : null;
  }

  /** Shortest route to the nearest of several targets (by walking distance). */
  nearestOf(from: Position, targets: { id: string; pos: Position }[]): { id: string; route: RouteResult } | null {
    const p = this.proj.toXY(from);
    const s = this.anchor(p);
    if (!s) return null;
    const { d, prev } = this.search(s);
    let best: { id: string; route: RouteResult } | null = null;
    for (const tg of targets) {
      const q = this.proj.toXY(tg.pos);
      const t = this.anchor(q);
      if (!t) continue;
      const r = this.finish(s, t, d, prev);
      if (!r) continue;
      const res = this.result(p, q, r);
      if (!best || res.length < best.route.length) best = { id: tg.id, route: res };
    }
    return best;
  }

  /**
   * Where the app would draw the GPS dot for a raw location (lock-to-path):
   * inside a walkable area it stays put; otherwise it jumps onto the nearest path within 5 m,
   * or within the area's own (smaller) distance inside a semi-walkable area.
   */
  locate(pos: Position, layers: Layer[]): { pos: Position; snapped: boolean; semi: boolean; snapM: number } {
    const p = this.proj.toXY(pos);
    if (this.areas.some((_, i) => this.inArea(p, i))) return { pos, snapped: false, semi: false, snapM: 0 };
    let snapM = APP_SNAP_M, semi = false;
    for (const l of layers) {
      if (l.kind !== 'semi' || !l.visible) continue;
      for (const f of effectivePolygons(l)) {
        const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
        for (const rings of polys) {
          const rr = rings.map((r) => r.map((c) => this.proj.toXY(c)));
          if (ringContains(rr[0], p) && !rr.slice(1).some((r) => ringContains(r, p))) {
            const own = Number(f.properties?.snap_m);
            const m = Number.isFinite(own) && f.properties?.snap_m !== '' && f.properties?.snap_m != null ? own : l.snapM ?? SEMI_SNAP_M;
            if (!semi || m < snapM) snapM = m;
            semi = true;
          }
        }
      }
    }
    const n = this.nearest(p);
    if (n && dist(n.p, p) <= snapM) return { pos: this.proj.toLonLat(n.p), snapped: true, semi, snapM };
    return { pos, snapped: false, semi, snapM };
  }

  /** Number of separate pieces in the path network (areas included). */
  components(): number {
    const parent = this.nodes.map((_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    this.adjacency.forEach((adj, a) => adj.forEach(({ to }) => { parent[find(a)] = find(to); }));
    const roots = new Set<number>();
    for (let i = 0; i < this.nodes.length; i++) if (this.adjacency[i].length) roots.add(find(i));
    return roots.size;
  }
}
