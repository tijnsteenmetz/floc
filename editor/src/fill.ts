// "Vlak vullen": finds the area enclosed by lines and polygon edges around a click,
// like a paint bucket but exact: the new polygon uses the very vertices of the paths around it,
// so the routing joins it to those paths.
import type { Position } from 'geojson';
import { LocalProjection, type XY } from './geo';

const TOL = 0.01; // 1 cm, same as the routing

const sub = (a: XY, b: XY): XY => [a[0] - b[0], a[1] - b[1]];
const dot = (a: XY, b: XY) => a[0] * b[0] + a[1] * b[1];
const dist = (a: XY, b: XY) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function closestT(a: XY, b: XY, p: XY): number {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  return l2 === 0 ? 0 : Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2));
}
const at = (a: XY, b: XY, t: number): XY => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

function ringContains(ring: XY[], p: XY): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

function signedArea(ring: XY[]): number {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

export interface Boundary {
  coords: Position[];
  /** true for polygon rings: their ends are not loose path ends. */
  closed: boolean;
}

export interface FillResult {
  outer: Position[];
  holes: Position[][];
  area: number; // m²
  gapsClosed: number;
}

interface Seg { a: XY; b: XY; ga?: Position; gb?: Position }

/**
 * The smallest area around `click` that is closed off by the boundaries.
 * `gapM` bridges loose path ends that stop short of another line by up to that many metres.
 * Only boundaries that touch `window` (lon/lat w,s,e,n) are considered.
 */
export function enclosedArea(click: Position, boundaries: Boundary[], gapM: number, window: [number, number, number, number]): FillResult | null {
  const proj = new LocalProjection(click[0], click[1]);
  const [ww, ws] = proj.toXY([window[0], window[1]]);
  const [we, wn] = proj.toXY([window[2], window[3]]);
  const inWin = (a: XY, b: XY) => Math.max(a[0], b[0]) >= ww && Math.min(a[0], b[0]) <= we && Math.max(a[1], b[1]) >= ws && Math.min(a[1], b[1]) <= wn;

  const segs: Seg[] = [];
  const looseEnds: { p: XY; g: Position }[] = [];
  for (const bd of boundaries) {
    const xy = bd.coords.map((c) => proj.toXY(c));
    let any = false;
    for (let i = 0; i < xy.length - 1; i++) {
      if (dist(xy[i], xy[i + 1]) < 1e-6 || !inWin(xy[i], xy[i + 1])) continue;
      segs.push({ a: xy[i], b: xy[i + 1], ga: bd.coords[i], gb: bd.coords[i + 1] });
      any = true;
    }
    if (any && !bd.closed && xy.length >= 2) {
      looseEnds.push({ p: xy[0], g: bd.coords[0] });
      looseEnds.push({ p: xy[xy.length - 1], g: bd.coords[bd.coords.length - 1] });
    }
  }
  if (!segs.length) return null;

  // Spatial grid over the segments.
  const cell = Math.max(10, gapM * 2);
  const grid = new Map<string, number[]>();
  const cellsOf = (a: XY, b: XY, pad = 0) => {
    const out: string[] = [];
    const x0 = Math.floor((Math.min(a[0], b[0]) - pad) / cell), x1 = Math.floor((Math.max(a[0], b[0]) + pad) / cell);
    const y0 = Math.floor((Math.min(a[1], b[1]) - pad) / cell), y1 = Math.floor((Math.max(a[1], b[1]) + pad) / cell);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push(`${x},${y}`);
    return out;
  };
  const index = (i: number) => { for (const k of cellsOf(segs[i].a, segs[i].b)) { const arr = grid.get(k); if (arr) arr.push(i); else grid.set(k, [i]); } };
  segs.forEach((_, i) => index(i));
  const near = (p: XY, pad: number) => {
    const seen = new Set<number>();
    for (const k of cellsOf(p, p, pad)) for (const i of grid.get(k) ?? []) seen.add(i);
    return seen;
  };

  // 1. Bridge small gaps at loose path ends.
  const realSegs = segs.length;
  if (gapM > 0) {
    const added: Seg[] = [];
    for (const e of looseEnds) {
      let best: { d: number; p: XY } | null = null;
      let touching = false;
      for (const i of near(e.p, gapM)) {
        const s = segs[i];
        if (dist(s.a, e.p) < TOL || dist(s.b, e.p) < TOL) { if (!(s.ga === e.g || s.gb === e.g)) touching = true; continue; }
        const c = at(s.a, s.b, closestT(s.a, s.b, e.p));
        const d = dist(c, e.p);
        if (d < TOL) { touching = true; break; }
        if (d <= gapM && (!best || d < best.d)) best = { d, p: c };
      }
      if (!touching && best) added.push({ a: e.p, b: best.p, ga: e.g });
    }
    for (const s of added) { segs.push(s); index(segs.length - 1); }
  }

  // 2. Split segments where others touch or cross them.
  const splits: { t: number; p: XY }[][] = segs.map(() => []);
  const stamp = new Int32Array(segs.length).fill(-1);
  for (let i = 0; i < segs.length; i++) {
    const A = segs[i];
    for (const k of cellsOf(A.a, A.b, TOL)) {
      for (const j of grid.get(k) ?? []) {
        if (j <= i || stamp[j] === i) continue;
        stamp[j] = i;
        const B = segs[j];
        // ends lying on the other segment (T-junctions, overlaps)
        for (const [S, T, si] of [[A, B, i], [B, A, j]] as [Seg, Seg, number][]) {
          for (const e of [T.a, T.b]) {
            if (dist(e, S.a) < TOL || dist(e, S.b) < TOL) continue;
            const t = closestT(S.a, S.b, e);
            if (dist(at(S.a, S.b, t), e) < TOL) splits[si].push({ t, p: e });
          }
        }
        // proper crossings
        const r = sub(A.b, A.a), s = sub(B.b, B.a);
        const den = r[0] * s[1] - r[1] * s[0];
        if (Math.abs(den) < 1e-12) continue;
        const q = sub(B.a, A.a);
        const t = (q[0] * s[1] - q[1] * s[0]) / den;
        const u = (q[0] * r[1] - q[1] * r[0]) / den;
        if (t > 1e-9 && t < 1 - 1e-9 && u > 1e-9 && u < 1 - 1e-9) {
          const p = at(A.a, A.b, t);
          splits[i].push({ t, p });
          splits[j].push({ t: u, p });
        }
      }
    }
  }

  // 3. Planar graph on a 1 cm grid; keep the original lon/lat of real vertices.
  const nodeIx = new Map<string, number>();
  const nodes: XY[] = [];
  const geo: (Position | null)[] = [];
  const node = (p: XY, g?: Position) => {
    const key = `${Math.round(p[0] * 100)},${Math.round(p[1] * 100)}`;
    let n = nodeIx.get(key);
    if (n == null) { n = nodes.length; nodes.push(p); geo.push(g ?? null); nodeIx.set(key, n); }
    else if (g && !geo[n]) geo[n] = g;
    return n;
  };
  const adj: Set<number>[] = [];
  const link = (a: number, b: number) => {
    if (a === b) return;
    while (adj.length <= Math.max(a, b)) adj.push(new Set());
    adj[a].add(b); adj[b].add(a);
  };
  const bridge = new Map<string, number>(); // edge key → which gap bridge it belongs to
  segs.forEach((s, i) => {
    const pts = [{ t: 0, p: s.a, g: s.ga }, ...splits[i].sort((x, y) => x.t - y.t).map((x) => ({ ...x, g: undefined })), { t: 1, p: s.b, g: s.gb }];
    for (let k = 0; k < pts.length - 1; k++) {
      const a = node(pts[k].p, pts[k].g), b = node(pts[k + 1].p, pts[k + 1].g);
      link(a, b);
      if (i >= realSegs) bridge.set(a < b ? `${a},${b}` : `${b},${a}`, i);
    }
  });
  while (adj.length < nodes.length) adj.push(new Set());

  // 4. Drop dead ends (loose path pieces) repeatedly: they don't close anything off.
  const stack = nodes.map((_, i) => i).filter((i) => adj[i].size === 1);
  while (stack.length) {
    const n = stack.pop()!;
    if (adj[n].size !== 1) continue;
    const [m] = adj[n];
    adj[n].delete(m); adj[m].delete(n);
    if (adj[m].size === 1) stack.push(m);
  }

  // 5. Trace faces: always take the sharpest left turn, so bounded faces come out counter-clockwise.
  const order: number[][] = adj.map((s, u) => [...s].sort((a, b) => Math.atan2(nodes[a][1] - nodes[u][1], nodes[a][0] - nodes[u][0]) - Math.atan2(nodes[b][1] - nodes[u][1], nodes[b][0] - nodes[u][0])));
  const used = new Set<string>();
  const faces: { nodes: number[]; area: number }[] = [];
  for (let u = 0; u < nodes.length; u++) {
    for (const v0 of order[u]) {
      if (used.has(`${u},${v0}`)) continue;
      const ring: number[] = [];
      let a = u, b = v0, guard = 0;
      while (!used.has(`${a},${b}`) && guard++ < 200000) {
        used.add(`${a},${b}`);
        ring.push(a);
        const list = order[b];
        const k = list.indexOf(a);
        const c = list[(k - 1 + list.length) % list.length];
        a = b; b = c;
      }
      if (ring.length >= 3) faces.push({ nodes: ring, area: signedArea(ring.map((n) => nodes[n])) });
    }
  }

  const c: XY = [0, 0];
  let chosen: { nodes: number[]; area: number } | null = null;
  for (const f of faces) {
    if (f.area <= 0) continue;
    if ((!chosen || f.area < chosen.area) && ringContains(f.nodes.map((n) => nodes[n]), c)) chosen = f;
  }
  if (!chosen) return null;

  // 6. A face that wraps around an inner loop runs along a connecting path twice; cut that out into a hole.
  const halfs = chosen.nodes.map((n, i) => [n, chosen!.nodes[(i + 1) % chosen!.nodes.length]] as [number, number]);
  const hk = new Set(halfs.map(([a, b]) => `${a},${b}`));
  const keep = halfs.filter(([a, b]) => !hk.has(`${b},${a}`));
  const outRings: XY[][] = [];
  const outGeo: Position[][] = [];
  const byStart = new Map<number, [number, number][]>();
  for (const h of keep) { const arr = byStart.get(h[0]); if (arr) arr.push(h); else byStart.set(h[0], [h]); }
  const done = new Set<string>();
  for (const h of keep) {
    if (done.has(`${h[0]},${h[1]}`)) continue;
    const ring: number[] = [];
    let cur = h;
    while (!done.has(`${cur[0]},${cur[1]}`)) {
      done.add(`${cur[0]},${cur[1]}`);
      ring.push(cur[0]);
      const nexts = (byStart.get(cur[1]) ?? []).filter((x) => !done.has(`${x[0]},${x[1]}`));
      if (!nexts.length) break;
      cur = nexts[0];
    }
    if (ring.length >= 3) {
      outRings.push(ring.map((n) => nodes[n]));
      outGeo.push(ring.map((n) => geo[n] ?? proj.toLonLat(nodes[n])));
    }
  }
  let oi = -1;
  outRings.forEach((r, i) => { if (signedArea(r) > 0 && (oi < 0 || signedArea(r) > signedArea(outRings[oi]))) oi = i; });
  if (oi < 0) return null;
  const outerXY = outRings[oi];
  const holes: Position[][] = outGeo.filter((_, i) => i !== oi).map((g) => close([...g].reverse()));
  let holeArea = outRings.reduce((s, r, i) => (i === oi ? s : s + Math.abs(signedArea(r))), 0);

  // 7. Separate shapes lying inside the area (a stage, a pond) become holes.
  const parent = nodes.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  adj.forEach((s, a) => s.forEach((b) => { parent[find(a)] = find(b); }));
  const mine = find(chosen.nodes[0]);
  const outerOf = new Map<number, { nodes: number[]; area: number }>();
  for (const f of faces) {
    if (f.area >= 0) continue;
    const r = find(f.nodes[0]);
    if (r === mine) continue;
    const cur = outerOf.get(r);
    if (!cur || f.area < cur.area) outerOf.set(r, f);
  }
  for (const f of outerOf.values()) {
    const pts = f.nodes.map((n) => nodes[n]);
    if (!pts.every((p) => ringContains(outerXY, p))) continue;
    if (ringContains(pts, c)) continue;
    holes.push(close(f.nodes.map((n) => geo[n] ?? proj.toLonLat(nodes[n]))));
    holeArea += -f.area;
  }
  const usedBridges = new Set<number>();
  for (const [a, b] of halfs) { const i = bridge.get(a < b ? `${a},${b}` : `${b},${a}`); if (i != null) usedBridges.add(i); }
  return { outer: close(outGeo[oi]), holes, area: signedArea(outerXY) - holeArea, gapsClosed: usedBridges.size };
}

function close(r: Position[]): Position[] {
  const a = r[0], b = r[r.length - 1];
  return a[0] === b[0] && a[1] === b[1] ? r : [...r, a];
}
