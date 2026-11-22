// Core of "Vectoriseren op kleur" — pure functions, run in a Web Worker.
// Pipeline (each step visible in the panel):
//   1. image at a fixed ground resolution (not the screen)
//   2. prepare: edge-preserving smoothing (median)
//   3. classify: every click is a colour group (what you want / what you don't). Distance to a group is
//      measured relative to the spread of colours inside the groups (Mahalanobis, pooled covariance), so
//      texture and shading count little and the difference between the groups counts a lot. A pixel belongs
//      to the result when its nearest group is a "pick" group and it lies within reach of it.
//   4. mask edits, bridge thin interruptions (grid lines), keep what's connected to a click, clean up
//   5. outline (marching squares) or centre lines (thinning), simplified in metres, always valid shapes
// Why this way: measured on the Wildeburg aerial and site plan against hand-drawn fields, plain ΔE
// tolerance only worked in a narrow band (2 of 15 settings), contrast/saturation/lightness weighting barely
// helped (they are per-axis stretches, which this distance ignores anyway), and clicking the field plus the
// path next to it gave the same good result at every setting.
import { contours } from 'd3-contour';
import type { Feature, Position } from 'geojson';

export interface Raster {
  w: number;
  h: number;
  rgba: Uint8ClampedArray;
  x0: number; // web-mercator metres of the top-left corner
  y0: number;
  m: number; // mercator metres per pixel
  mpp: number; // ground metres per pixel
}

export type PickKind = 'pick' | 'exclude';
export interface Pick { kind: PickKind; pos: Position }
export type MaskOp = { type: 'add' | 'cut'; ring: Position[] } | { type: 'line'; line: Position[] } | { type: 'fill'; pos: Position };

/** How the image is prepared: smoothing, then colour adjustments (brightness/contrast −100..100, saturation in %). */
export interface PrepParams { smooth: number; bright: number; contrast: number; sat: number }
export const prepKey = (p: PrepParams) => [p.smooth, p.bright, p.contrast, p.sat].join('|');
export interface RunParams extends PrepParams {
  picks: Pick[];
  ops: MaskOp[];
  scope: 'connected' | 'all';
  reach: number; // how far from a clicked colour still counts, in units of the colour spread inside the groups
  bridge: number; // metres: interruptions up to this width (grid lines, text) are bridged
  speck: number; // m²: remove patches smaller than this
  holes: number; // m²: fill holes smaller than this
  output: 'polygon' | 'line';
  simplify: number; // metres
  minLength: number; // metres (lines)
  wantPreview: boolean;
}

export interface RunResult {
  features: Feature[];
  /** Per click: its colour as measured, the colour it is shown in on "what the computer sees", whether it lies on the image. */
  picks: { kind: PickKind; hex: string; shown: string; inside: boolean }[];
  areaM2: number;
  lengthM: number;
  /** Same-colour patches left out because they don't touch what was clicked (scope 'connected'). */
  others: { count: number; areaM2: number; features: Feature[] };
  preview?: Uint8ClampedArray; // the classified image, RGBA
}

/** Colours on "what the computer sees": everything you pick shows in the result colour, each excluded colour in its own. */
export const PICK_SHOWN = '#FF1F8E';
export const EXCLUDE_SHOWN = ['#00D5FF', '#FFE500', '#22D33A', '#FF7A00', '#8A5CFF', '#2F4BFF', '#FFFFFF'];

const R = 6378137;
const mercX = (lon: number) => (R * lon * Math.PI) / 180;
const mercY = (lat: number) => R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
const unMercX = (x: number) => (x / R) * (180 / Math.PI);
const unMercY = (y: number) => (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * (180 / Math.PI);
export const toPx = (r: Raster, c: Position): [number, number] => [(mercX(c[0]) - r.x0) / r.m, (r.y0 - mercY(c[1])) / r.m];
export const toGeo = (r: Raster, x: number, y: number): Position => [unMercX(r.x0 + x * r.m), unMercY(r.y0 - y * r.m)];

// ---------- colour ----------
const LIN = new Float32Array(256).map((_, i) => { const c = i / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
const fLab = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
export function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  const R1 = LIN[r], G = LIN[g], B = LIN[b];
  const x = fLab((R1 * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047);
  const y = fLab(R1 * 0.2126 + G * 0.7152 + B * 0.0722);
  const z = fLab((R1 * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
const GAMMA = new Uint8ClampedArray(4096).map((_, i) => { const c = i / 4095; return Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)); });
const fInv = (t: number) => (t > 0.206893 ? t * t * t : (t - 16 / 116) / 7.787);
const lin2u8 = (v: number) => GAMMA[Math.max(0, Math.min(4095, Math.round(v * 4095)))];
export function labToRgb(L: number, A: number, B: number): [number, number, number] {
  const y = (L + 16) / 116, x = y + A / 500, z = y - B / 200;
  const X = fInv(x) * 0.95047, Y = fInv(y), Z = fInv(z) * 1.08883;
  return [lin2u8(3.2406 * X - 1.5372 * Y - 0.4986 * Z), lin2u8(-0.9689 * X + 1.8758 * Y + 0.0415 * Z), lin2u8(0.0557 * X - 0.204 * Y + 1.057 * Z)];
}
const hexToRgb = (h: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) || 0) as [number, number, number];
const hex = (r: number, g: number, b: number) => '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');

// ---------- step 2: prepare ----------
export interface Prepared { key: string; rgb: Uint8ClampedArray; lab: Float32Array; valid: Uint8Array }

/** Separable median (rows, then columns) per channel: smooths texture and specks but keeps edges sharp. Fast. */
function median(src: Uint8ClampedArray, w: number, h: number, r: number): Uint8ClampedArray {
  const tmp = new Uint8ClampedArray(src);
  const out = new Uint8ClampedArray(src);
  const win = new Uint8Array(2 * r + 1);
  const med = (k: number) => { const a = win.subarray(0, k).sort(); return a[k >> 1]; };
  for (let ch = 0; ch < 3; ch++) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let k = 0;
      for (let d = -r; d <= r; d++) { const xx = x + d; if (xx >= 0 && xx < w) win[k++] = src[(y * w + xx) * 4 + ch]; }
      tmp[(y * w + x) * 4 + ch] = med(k);
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let k = 0;
      for (let d = -r; d <= r; d++) { const yy = y + d; if (yy >= 0 && yy < h) win[k++] = tmp[(yy * w + x) * 4 + ch]; }
      out[(y * w + x) * 4 + ch] = med(k);
    }
  }
  return out;
}

/** Brightness, contrast (around mid-grey) and saturation (away from each pixel's own grey), in place. */
function adjustColours(rgb: Uint8ClampedArray, n: number, p: PrepParams) {
  const b = (p.bright ?? 0) * 1.28;
  const c = p.contrast ?? 0;
  const k = c >= 0 ? 1 + c / 25 : 1 + c / 100; // +100 → 5×, −100 → flat
  const s = (p.sat ?? 100) / 100;
  if (!b && k === 1 && s === 1) return;
  const lut = new Uint8ClampedArray(256).map((_, v) => Math.round((v - 128) * k + 128 + b));
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    let R = lut[rgb[o]], G = lut[rgb[o + 1]], B = lut[rgb[o + 2]];
    if (s !== 1) { const y = 0.299 * R + 0.587 * G + 0.114 * B; R = y + (R - y) * s; G = y + (G - y) * s; B = y + (B - y) * s; }
    rgb[o] = R; rgb[o + 1] = G; rgb[o + 2] = B; // clamped by the array
  }
}

export function prepare(r: Raster, p: PrepParams): Prepared {
  const n = r.w * r.h;
  const valid = new Uint8Array(n);
  for (let i = 0; i < n; i++) valid[i] = r.rgba[i * 4 + 3] > 16 ? 1 : 0;
  const rgb = p.smooth > 0 ? median(r.rgba, r.w, r.h, Math.round(p.smooth)) : new Uint8ClampedArray(r.rgba);
  adjustColours(rgb, n, p);
  const lab = new Float32Array(n * 3);
  // Lab via a small cache: many pixels share colours.
  const cache = new Map<number, [number, number, number]>();
  for (let i = 0; i < n; i++) {
    const k = (rgb[i * 4] << 16) | (rgb[i * 4 + 1] << 8) | rgb[i * 4 + 2];
    let c = cache.get(k);
    if (!c) { c = rgbToLab(rgb[i * 4], rgb[i * 4 + 1], rgb[i * 4 + 2]); if (cache.size < 400000) cache.set(k, c); }
    lab[i * 3] = c[0]; lab[i * 3 + 1] = c[1]; lab[i * 3 + 2] = c[2];
  }
  return { key: prepKey(p), rgb, lab, valid };
}

// ---------- step 3: colour groups ----------
interface Group { kind: PickKind; px: [number, number]; ok: boolean; mean: number[]; members: number[]; hex: string; shown: string }

/**
 * A click's colour group: the pixels in a ~0.75 m circle around it. Centre = per-channel median, then the
 * 60% closest to it are kept (a click next to an edge or on a drawn line doesn't take the other colour along).
 */
function sampleGroup(r: Raster, prep: Prepared, pk: Pick, excludeIndex: number): Group {
  const { w, h } = r;
  const { lab, valid } = prep;
  const [fx, fy] = toPx(r, pk.pos);
  const cx = Math.round(fx), cy = Math.round(fy);
  const shown = pk.kind === 'pick' ? PICK_SHOWN : EXCLUDE_SHOWN[excludeIndex % EXCLUDE_SHOWN.length];
  const rad = Math.max(1, Math.min(5, Math.round(0.75 / r.mpp)));
  const px: number[] = [];
  for (let dy = -rad; dy <= rad; dy++) for (let dx = -rad; dx <= rad; dx++) {
    const x = cx + dx, y = cy + dy;
    if (dx * dx + dy * dy <= rad * rad + 1 && x >= 0 && y >= 0 && x < w && y < h && valid[y * w + x]) px.push(y * w + x);
  }
  if (!px.length) return { kind: pk.kind, px: [cx, cy], ok: false, mean: [0, 0, 0], members: [], hex: '#000000', shown };
  const med = [0, 1, 2].map((k) => { const v = px.map((i) => lab[i * 3 + k]).sort((a, b) => a - b); return v[v.length >> 1]; });
  const d = (i: number) => (lab[i * 3] - med[0]) ** 2 + (lab[i * 3 + 1] - med[1]) ** 2 + (lab[i * 3 + 2] - med[2]) ** 2;
  const members = [...px].sort((a, b) => d(a) - d(b)).slice(0, Math.max(1, Math.ceil(px.length * 0.6)));
  const mean = [0, 1, 2].map((k) => members.reduce((a, i) => a + lab[i * 3 + k], 0) / members.length);
  return { kind: pk.kind, px: [cx, cy], ok: true, mean, members, hex: hex(...labToRgb(mean[0], mean[1], mean[2])), shown };
}

/** Inverse of the pooled colour spread inside the groups, with a floor (ΔE 1.5 per axis) for perfectly flat colours. */
function spreadInverse(lab: Float32Array, groups: Group[]): number[] {
  const S = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  let cnt = 0;
  for (const g of groups) for (const i of g.members) {
    const v = [lab[i * 3] - g.mean[0], lab[i * 3 + 1] - g.mean[1], lab[i * 3 + 2] - g.mean[2]];
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) S[a * 3 + b] += v[a] * v[b];
    cnt++;
  }
  for (let k = 0; k < 9; k++) S[k] /= Math.max(1, cnt);
  S[0] += 2.25; S[4] += 2.25; S[8] += 2.25;
  const [a, b, c, d, e, f, g, h, k] = S;
  const A = e * k - f * h, B = -(d * k - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C || 1e-9;
  return [A / det, -(b * k - c * h) / det, (b * f - c * e) / det, B / det, (a * k - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}

// ---------- steps 3–5 ----------
export function run(r: Raster, prep: Prepared, p: RunParams): RunResult {
  const { w, h } = r;
  const n = w * h;
  const { lab, valid } = prep;
  const at = (pos: Position) => { const [x, y] = toPx(r, pos); return [Math.round(x), Math.round(y)] as [number, number]; };
  const inside = ([x, y]: [number, number]) => x >= 0 && y >= 0 && x < w && y < h;
  let ex = 0;
  const groups = p.picks.map((pk) => sampleGroup(r, prep, pk, pk.kind === 'exclude' ? ex++ : 0));
  const usable = groups.filter((g) => g.ok);
  const inc = usable.filter((g) => g.kind === 'pick');
  const pickInfo = groups.map((g) => ({ kind: g.kind, hex: g.hex, shown: g.shown, inside: g.ok }));
  const noOthers = { count: 0, areaM2: 0, features: [] as Feature[] };

  // Classify: nearest group (relative to the spread), within reach.
  let mask: Uint8Array = new Uint8Array(n);
  const cls = new Int16Array(n).fill(-1);
  if (usable.length) {
    const I = spreadInverse(lab, usable);
    const reach2 = p.reach * p.reach;
    const means = usable.map((g) => g.mean);
    for (let i = 0; i < n; i++) {
      if (!valid[i]) continue;
      const L = lab[i * 3], A = lab[i * 3 + 1], B = lab[i * 3 + 2];
      let best = -1, bd = Infinity;
      for (let c = 0; c < means.length; c++) {
        const x = L - means[c][0], y = A - means[c][1], z = B - means[c][2];
        const d2 = x * (I[0] * x + I[1] * y + I[2] * z) + y * (I[3] * x + I[4] * y + I[5] * z) + z * (I[6] * x + I[7] * y + I[8] * z);
        if (d2 < bd) { bd = d2; best = c; }
      }
      if (bd <= reach2) { cls[i] = best; if (usable[best].kind === 'pick') mask[i] = 1; }
    }
  }
  // "What the computer sees": the prepared image (smoothed, colours adjusted) in full colour, with every pixel
  // that matches a group painted in that group's colour.
  let preview: Uint8ClampedArray | undefined;
  if (p.wantPreview) {
    preview = new Uint8ClampedArray(prep.rgb);
    const cols = usable.map((g) => hexToRgb(g.shown));
    for (let i = 0; i < n; i++) {
      if (!valid[i]) continue;
      const c = cls[i];
      if (c >= 0) { preview[i * 4] = cols[c][0] * 0.85 + preview[i * 4] * 0.15; preview[i * 4 + 1] = cols[c][1] * 0.85 + preview[i * 4 + 1] * 0.15; preview[i * 4 + 2] = cols[c][2] * 0.85 + preview[i * 4 + 2] * 0.15; }
    }
  }
  const empty: RunResult = { features: [], picks: pickInfo, areaM2: 0, lengthM: 0, others: noOthers, preview };
  // Drawing in works on its own too: without a picked colour the result is just what was drawn.
  if (!inc.length && !p.ops.some((o) => o.type === 'add')) return empty;

  // Mask edits, in map coordinates so they survive a change of resolution.
  const thick = Math.max(1, Math.round(0.6 / r.mpp));
  for (const op of p.ops) {
    if (op.type === 'add') fillRing(mask, w, h, op.ring.map((c) => toPx(r, c)), 1);
    if (op.type === 'line') drawLine(mask, w, h, op.line.map((c) => toPx(r, c)), thick, 0);
  }
  // Bridge thin interruptions (grid lines, text, a drawn outline): a closing over the bridge width,
  // so the two sides join and the line itself is filled in. Cut lines are drawn again afterwards.
  const br = p.bridge > 0 ? Math.max(1, Math.ceil(p.bridge / r.mpp / 2)) : 0;
  if (br) mask = morph(morph(mask, w, h, br, true), w, h, br, false);
  for (const op of p.ops) if (op.type === 'line') drawLine(mask, w, h, op.line.map((c) => toPx(r, c)), thick, 0);
  const px2 = r.mpp * r.mpp;
  let others = noOthers;
  if (p.scope === 'connected') {
    const starts = inc.filter((c) => inside(c.px)).map((c) => c.px[1] * w + c.px[0]);
    for (const op of p.ops) if (op.type === 'add') { const c = ringCentre(op.ring.map((q) => toPx(r, q))); if (inside(c)) starts.push(c[1] * w + c[0]); }
    const all = mask;
    mask = flood(mask, w, h, starts, 1);
    others = leftOut(all, mask, w, h, Math.max(p.speck, 4) / px2, r);
  }
  if (p.speck > 0) removeSmall(mask, w, h, 1, Math.round(p.speck / px2), false);
  if (p.holes > 0) removeSmall(mask, w, h, 0, Math.round(p.holes / px2), true);
  for (const op of p.ops) {
    if (op.type === 'cut') fillRing(mask, w, h, op.ring.map((c) => toPx(r, c)), 0);
    if (op.type === 'add') fillRing(mask, w, h, op.ring.map((c) => toPx(r, c)), 1);
    if (op.type === 'fill') { const c = at(op.pos); if (inside(c) && !mask[c[1] * w + c[0]]) { const f = flood(invert(mask), w, h, [c[1] * w + c[0]], 0); for (let i = 0; i < n; i++) if (f[i]) mask[i] = 1; } }
  }

  const features: Feature[] = [];
  let areaM2 = 0, lengthM = 0;
  const geo = (q: [number, number]) => toGeo(r, q[0], q[1]);
  if (p.output === 'polygon') {
    const [mp] = contours().size([w, h]).thresholds([0.5])(mask as unknown as number[]);
    const tolPx = Math.max(0.3, p.simplify / r.mpp);
    for (const poly of mp.coordinates) {
      const rings = poly.map((ring) => safeSimplify(ring as [number, number][], tolPx)).filter((ring) => ring.length >= 4);
      if (!rings.length || Math.abs(ringArea(rings[0])) * px2 < Math.max(p.speck, 0.5)) continue;
      const holes = rings.slice(1).filter((ring) => Math.abs(ringArea(ring)) * px2 >= Math.max(p.holes, 0.5));
      areaM2 += (Math.abs(ringArea(rings[0])) - holes.reduce((a, ring) => a + Math.abs(ringArea(ring)), 0)) * px2;
      features.push({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [rings[0], ...holes].map((ring) => ring.map(geo)) } });
    }
  } else {
    const lines = traceSkeleton(thin(mask, w, h), w, h);
    const minPx = p.minLength / r.mpp;
    for (const l of lines) {
      const len = polyLength(l);
      if (len < minPx) continue;
      const s = simplifyLine(l, Math.max(0.5, p.simplify / r.mpp));
      if (s.length < 2) continue;
      lengthM += len * r.mpp;
      features.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: s.map(geo) } });
    }
  }
  return { features, picks: pickInfo, areaM2, lengthM, others, preview };
}

/** Patches of `all` that aren't in `kept` and are at least `minPx` pixels: counted, and outlined for the map. */
function leftOut(all: Uint8Array, kept: Uint8Array, w: number, h: number, minPx: number, r: Raster): RunResult['others'] {
  const n = w * h;
  const rest = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (all[i] && !kept[i]) rest[i] = 1;
  removeSmall(rest, w, h, 1, Math.round(minPx), false);
  let px = 0;
  for (let i = 0; i < n; i++) px += rest[i];
  if (!px) return { count: 0, areaM2: 0, features: [] };
  const [mp] = contours().size([w, h]).thresholds([0.5])(rest as unknown as number[]);
  const tol = Math.max(0.5, 1 / r.mpp);
  const features: Feature[] = mp.coordinates.map((poly) => ({
    type: 'Feature', properties: {},
    geometry: { type: 'Polygon', coordinates: [safeSimplify(poly[0] as [number, number][], tol).map((q) => toGeo(r, q[0], q[1]))] },
  }));
  return { count: mp.coordinates.length, areaM2: px * r.mpp * r.mpp, features };
}

// ---------- raster helpers ----------
function invert(m: Uint8Array): Uint8Array { const o = new Uint8Array(m.length); for (let i = 0; i < m.length; i++) o[i] = m[i] ? 0 : 1; return o; }

function ringCentre(pts: [number, number][]): [number, number] {
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  // a point that's surely inside for convex-ish shapes; fine for a start point
  return [Math.round((Math.min(...xs) + Math.max(...xs)) / 2), Math.round((Math.min(...ys) + Math.max(...ys)) / 2)];
}

/** Scanline fill of a polygon (pixel coordinates) with value v. */
function fillRing(m: Uint8Array, w: number, h: number, pts: [number, number][], v: number) {
  if (pts.length < 3) return;
  const ys = pts.map((p) => p[1]);
  const y0 = Math.max(0, Math.floor(Math.min(...ys))), y1 = Math.min(h - 1, Math.ceil(Math.max(...ys)));
  for (let y = y0; y <= y1; y++) {
    const yc = y + 0.5;
    const xs: number[] = [];
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const a = pts[i], b = pts[j];
      if ((a[1] > yc) !== (b[1] > yc)) xs.push(a[0] + ((yc - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = Math.max(0, Math.ceil(xs[k] - 0.5)), xb = Math.min(w - 1, Math.floor(xs[k + 1] - 0.5));
      for (let x = xa; x <= xb; x++) m[y * w + x] = v;
    }
  }
}

function drawLine(m: Uint8Array, w: number, h: number, pts: [number, number][], thick: number, v: number) {
  for (let k = 0; k < pts.length - 1; k++) {
    const [ax, ay] = pts[k], [bx, by] = pts[k + 1];
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) * 2));
    for (let s = 0; s <= steps; s++) {
      const x = Math.round(ax + ((bx - ax) * s) / steps), y = Math.round(ay + ((by - ay) * s) / steps);
      for (let dy = -thick; dy <= thick; dy++) for (let dx = -thick; dx <= thick; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx >= 0 && yy >= 0 && xx < w && yy < h && dx * dx + dy * dy <= thick * thick + 1) m[yy * w + xx] = v;
      }
    }
  }
}

/** Box dilate or erode with radius r (separable, prefix sums). Outside counts as "set" when eroding. */
function morph(src: Uint8Array, w: number, h: number, r: number, dilate: boolean): Uint8Array {
  const pass = (get: (line: number, k: number) => number, set: (line: number, k: number, v: number) => void, lines: number, len: number) => {
    const P = new Int32Array(len + 1);
    for (let l = 0; l < lines; l++) {
      for (let k = 0; k < len; k++) P[k + 1] = P[k] + get(l, k);
      for (let k = 0; k < len; k++) {
        const lo = Math.max(0, k - r), hi = Math.min(len - 1, k + r);
        const cnt = P[hi + 1] - P[lo];
        set(l, k, dilate ? +(cnt > 0) : +(cnt === hi - lo + 1));
      }
    }
  };
  const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
  pass((y, x) => src[y * w + x], (y, x, v) => { tmp[y * w + x] = v; }, h, w);
  pass((x, y) => tmp[y * w + x], (x, y, v) => { out[y * w + x] = v; }, w, h);
  return out;
}

/** Pixels with value `v` reachable (4-neighbours) from the starts. */
function flood(m: Uint8Array, w: number, h: number, starts: number[], v: number): Uint8Array {
  const out = new Uint8Array(w * h);
  const stack: number[] = [];
  const want = v === 1 ? 1 : 1; // m is already the "allowed" mask
  for (const s0 of starts) {
    let s = s0;
    if (m[s] !== want) {
      // a click on the edge still counts: look a few pixels around
      const sx = s % w, sy = Math.floor(s / w);
      search: for (let r = 1; r <= 4; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        const x = sx + dx, y = sy + dy;
        if (x >= 0 && y >= 0 && x < w && y < h && m[y * w + x] === want) { s = y * w + x; break search; }
      }
    }
    if (m[s] === want && !out[s]) { out[s] = 1; stack.push(s); }
  }
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % w;
    if (x > 0 && m[i - 1] === want && !out[i - 1]) { out[i - 1] = 1; stack.push(i - 1); }
    if (x < w - 1 && m[i + 1] === want && !out[i + 1]) { out[i + 1] = 1; stack.push(i + 1); }
    if (i >= w && m[i - w] === want && !out[i - w]) { out[i - w] = 1; stack.push(i - w); }
    if (i < w * (h - 1) && m[i + w] === want && !out[i + w]) { out[i + w] = 1; stack.push(i + w); }
  }
  return out;
}

/** Flips connected patches of value v smaller than `max` pixels. For holes, patches touching the edge are kept. */
function removeSmall(m: Uint8Array, w: number, h: number, v: number, max: number, keepEdge: boolean) {
  if (max <= 0) return;
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  const comp: number[] = [];
  for (let s = 0; s < w * h; s++) {
    if (seen[s] || m[s] !== v) continue;
    comp.length = 0;
    let edge = false;
    seen[s] = 1; stack.push(s);
    while (stack.length) {
      const i = stack.pop()!;
      comp.push(i);
      const x = i % w, y = (i - x) / w;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) edge = true;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
        if (j >= 0 && !seen[j] && m[j] === v) { seen[j] = 1; stack.push(j); }
      }
    }
    if (comp.length < max && !(keepEdge && edge)) for (const i of comp) m[i] = 1 - v;
  }
}

/** Zhang–Suen thinning: reduces strokes to one-pixel centre lines. */
function thin(src: Uint8Array, w: number, h: number): Uint8Array {
  const m = new Uint8Array(src);
  for (let x = 0; x < w; x++) { m[x] = 0; m[(h - 1) * w + x] = 0; }
  for (let y = 0; y < h; y++) { m[y * w] = 0; m[y * w + w - 1] = 0; }
  const del: number[] = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (let pass = 0; pass < 2; pass++) {
      del.length = 0;
      for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (!m[i]) continue;
        const p2 = m[i - w], p3 = m[i - w + 1], p4 = m[i + 1], p5 = m[i + w + 1], p6 = m[i + w], p7 = m[i + w - 1], p8 = m[i - 1], p9 = m[i - w - 1];
        const B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
        if (B < 2 || B > 6) continue;
        const A = (+(!p2 && p3)) + (+(!p3 && p4)) + (+(!p4 && p5)) + (+(!p5 && p6)) + (+(!p6 && p7)) + (+(!p7 && p8)) + (+(!p8 && p9)) + (+(!p9 && p2));
        if (A !== 1) continue;
        if (pass === 0 ? p2 * p4 * p6 === 0 && p4 * p6 * p8 === 0 : p2 * p4 * p8 === 0 && p2 * p6 * p8 === 0) del.push(i);
      }
      for (const i of del) m[i] = 0;
      if (del.length) changed = true;
    }
  }
  return m;
}

/** Walks a one-pixel skeleton into polylines, broken at junctions (which they share as end points). */
function traceSkeleton(m: Uint8Array, w: number, h: number): [number, number][][] {
  const N = [-w - 1, -w, -w + 1, -1, 1, w - 1, w, w + 1];
  const nb = (i: number) => {
    const x = i % w;
    const out: number[] = [];
    for (const d of N) {
      const j = i + d;
      if (j < 0 || j >= w * h || Math.abs((j % w) - x) > 1) continue;
      if (m[j]) out.push(j);
    }
    return out;
  };
  const deg = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) if (m[i]) deg[i] = nb(i).length;
  const isNode = (i: number) => deg[i] !== 2;
  const used = new Set<number>();
  const key = (a: number, b: number) => (a < b ? a * w * h + b : b * w * h + a);
  const pt = (i: number): [number, number] => [(i % w) + 0.5, Math.floor(i / w) + 0.5];
  const lines: [number, number][][] = [];
  const walk = (start: number, next: number) => {
    const line = [pt(start)];
    let prev = start, cur = next;
    used.add(key(prev, cur));
    for (let g = 0; g < w * h; g++) {
      line.push(pt(cur));
      if (isNode(cur) || cur === start) break;
      const cand = nb(cur).filter((j) => j !== prev && !used.has(key(cur, j)));
      if (!cand.length) break;
      const nx = cand.find((j) => Math.abs(j - cur) === 1 || Math.abs(j - cur) === w) ?? cand[0];
      used.add(key(cur, nx));
      prev = cur; cur = nx;
    }
    lines.push(line);
  };
  for (let i = 0; i < w * h; i++) if (m[i] && isNode(i)) for (const j of nb(i)) if (!used.has(key(i, j))) walk(i, j);
  for (let i = 0; i < w * h; i++) if (m[i] && !isNode(i)) for (const j of nb(i)) if (!used.has(key(i, j))) walk(i, j);
  return lines.filter((l) => l.length > 2 || polyLength(l) > 1.5);
}

function polyLength(l: [number, number][]): number {
  let s = 0;
  for (let i = 1; i < l.length; i++) s += Math.hypot(l[i][0] - l[i - 1][0], l[i][1] - l[i - 1][1]);
  return s;
}

function ringArea(r: [number, number][]): number {
  let s = 0;
  for (let i = 0; i < r.length - 1; i++) s += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1];
  return s / 2;
}

function perpDist(p: [number, number], a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  if (!l2) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

/** Douglas–Peucker. */
export function simplifyLine(pts: [number, number][], tol: number): [number, number][] {
  if (pts.length <= 2) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let md = 0, mi = -1;
    for (let i = a + 1; i < b; i++) { const d = perpDist(pts[i], pts[a], pts[b]); if (d > md) { md = d; mi = i; } }
    if (mi >= 0 && md > tol) { keep[mi] = 1; stack.push([a, mi], [mi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

function simplifyRing(r: [number, number][], tol: number): [number, number][] {
  if (r.length < 5) return r;
  let far = 0, fd = 0;
  for (let i = 1; i < r.length - 1; i++) { const d = Math.hypot(r[i][0] - r[0][0], r[i][1] - r[0][1]); if (d > fd) { fd = d; far = i; } }
  const out = [...simplifyLine(r.slice(0, far + 1), tol), ...simplifyLine(r.slice(far), tol).slice(1)];
  return out.length >= 4 ? out : r;
}

function segsCross(a: [number, number], b: [number, number], c: [number, number], d: [number, number]): boolean {
  const o = (p: [number, number], q: [number, number], r: [number, number]) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
}

/** Self-crossing ring? (grid-bucketed segment test) */
function selfCrosses(r: [number, number][]): boolean {
  const n = r.length - 1;
  if (n < 4) return false;
  const cell = 8;
  const grid = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const a = r[i], b = r[i + 1];
    for (let x = Math.floor(Math.min(a[0], b[0]) / cell); x <= Math.floor(Math.max(a[0], b[0]) / cell); x++)
      for (let y = Math.floor(Math.min(a[1], b[1]) / cell); y <= Math.floor(Math.max(a[1], b[1]) / cell); y++) {
        const k = `${x},${y}`;
        const arr = grid.get(k);
        if (arr) { for (const j of arr) if (Math.abs(i - j) > 1 && !(i === n - 1 && j === 0) && !(j === n - 1 && i === 0) && segsCross(a, b, r[j], r[j + 1])) return true; arr.push(i); }
        else grid.set(k, [i]);
      }
  }
  return false;
}

/** Simplify, but never into a self-crossing shape (those can't be edited afterwards). */
function safeSimplify(r: [number, number][], tol: number): [number, number][] {
  for (let t = tol; t >= 0.25; t /= 2) {
    const s = simplifyRing(r, t);
    if (s.length >= 4 && !selfCrosses(s)) return s;
  }
  return r;
}
