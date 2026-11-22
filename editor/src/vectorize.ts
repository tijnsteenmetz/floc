// "Vectoriseren op kleur", browser side: fetches the image layer at a fixed ground resolution
// (independent of the zoom level) and talks to the worker that does the work (see veccore.ts).
import type { Position } from 'geojson';
import { fileUrl } from './api';
import type { Layer } from './types';
import { pdokUrl } from './types';
import type { MaskOp, Pick, Raster, RunParams, RunResult } from './veccore';
export type { MaskOp, Pick, PickKind, RunParams, RunResult } from './veccore';

const R = 6378137;
const mercX = (lon: number) => (R * lon * Math.PI) / 180;
const mercY = (lat: number) => R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
const unMercX = (x: number) => (x / R) * (180 / Math.PI);
const unMercY = (y: number) => (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * (180 / Math.PI);

export interface Sample {
  id: string; // unique per fetched raster
  layerId: string;
  res: number; // requested metres per pixel (aerial only; a plan is always at its own resolution)
  areaKey: string; // the area it was fetched for ('' = the whole plan)
  raster: Raster;
  bounds: [number, number, number, number]; // w, s, e, n
}

/** Most pixels one search may cover: about 40 bytes each while it runs, so ~1 GB in the worker. */
export const MAX_PX = 25_000_000;

export const areaKey = (area: Position[] | null) => (area ? area.map((c) => `${c[0].toFixed(7)},${c[1].toFixed(7)}`).join(';') : '');

// The plan, decoded once per version (it's large; re-decoding for every new area is slow).
let planCache: { url: string; img: HTMLImageElement } | null = null;
async function loadPlan(url: string): Promise<HTMLImageElement | null> {
  if (planCache?.url === url) return planCache.img;
  const img = await loadImage(url);
  if (img) planCache = { url, img };
  return img;
}

/** Makes everything outside the area transparent: it's then not looked at. */
function clipToArea(rgba: Uint8ClampedArray, w: number, h: number, ring: [number, number][]) {
  const inside = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const yc = y + 0.5;
    const xs: number[] = [];
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i], b = ring[j];
      if ((a[1] > yc) !== (b[1] > yc)) xs.push(a[0] + ((yc - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = Math.max(0, Math.ceil(xs[k] - 0.5)), xb = Math.min(w - 1, Math.floor(xs[k + 1] - 0.5));
      for (let x = xa; x <= xb; x++) inside[y * w + x] = 1;
    }
  }
  for (let i = 0; i < w * h; i++) if (!inside[i]) rgba[i * 4 + 3] = 0;
}

const tooBig = (px: number, mpp: number, hasArea: boolean) => {
  const km2 = (MAX_PX * mpp * mpp) / 1e6;
  return new Error(`Dit gebied is te groot om in één keer op volle scherpte te bekijken (${Math.round(px / 1e6)} miljoen pixels, max ${MAX_PX / 1e6} miljoen ≈ ${km2 < 1 ? `${Math.round(km2 * 100)} ha` : `${km2.toFixed(1)} km²`}). ${hasArea ? 'Teken een kleiner gebied.' : 'Teken bij stap 1 het gebied waar je in wilt zoeken.'}`);
};

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((res) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => res(img);
    img.onerror = () => res(null);
    img.src = url;
  });
}

export function sampleCovers(s: Sample, pos: [number, number]): boolean {
  const [w, so, e, n] = s.bounds;
  return pos[0] >= w && pos[0] <= e && pos[1] >= so && pos[1] <= n;
}

/**
 * The pixels of an image layer within `area` (a ring, lon/lat), or the whole plan when there's no area.
 * A plan: always at the file's own resolution, nothing scaled down. The aerial: at `res` metres per pixel.
 * Independent of where you are and how far you're zoomed in.
 */
export async function sampleLayer(layer: Layer, pid: string, res: number, area: Position[] | null): Promise<Sample> {
  const id = `${layer.id}:${res}:${Date.now()}`;
  const key = areaKey(area);
  if (layer.kind === 'image') {
    if (!layer.image?.warped) throw new Error('Deze afbeelding is nog niet gegeorefereerd');
    const img = await loadPlan(fileUrl(pid, `images/${layer.id}/warped.png`, layer.image.warped.version));
    if (!img) throw new Error('Afbeelding laden mislukt');
    const [west, south, east, north] = layer.image.warped.bounds;
    const X0 = mercX(west), Y0 = mercY(north);
    const m = (mercX(east) - X0) / img.naturalWidth; // mercator metres per pixel of the file
    const cos = Math.cos((((south + north) / 2) * Math.PI) / 180);
    // The area's bounding box in file pixels (whole plan without an area).
    let sx = 0, sy = 0, sw = img.naturalWidth, sh = img.naturalHeight;
    let ring: [number, number][] | null = null;
    if (area) {
      const pts = area.map((c) => [(mercX(c[0]) - X0) / m, (Y0 - mercY(c[1])) / m] as [number, number]);
      sx = Math.max(0, Math.floor(Math.min(...pts.map((q) => q[0]))));
      sy = Math.max(0, Math.floor(Math.min(...pts.map((q) => q[1]))));
      sw = Math.min(img.naturalWidth, Math.ceil(Math.max(...pts.map((q) => q[0])))) - sx;
      sh = Math.min(img.naturalHeight, Math.ceil(Math.max(...pts.map((q) => q[1])))) - sy;
      if (sw < 2 || sh < 2) throw new Error('Het gebied ligt buiten deze plattegrond');
      ring = pts.map((q) => [q[0] - sx, q[1] - sy]);
    }
    if (sw * sh > MAX_PX) throw tooBig(sw * sh, m * cos, !!area);
    const cv = document.createElement('canvas');
    cv.width = sw; cv.height = sh;
    const ctx = cv.getContext('2d', { willReadFrequently: true })!;
    ctx.imageSmoothingEnabled = false; // 1:1, the file's own pixels
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
    const rgba = ctx.getImageData(0, 0, sw, sh).data;
    if (ring) clipToArea(rgba, sw, sh, ring);
    const x0 = X0 + sx * m, y0 = Y0 - sy * m;
    return { id, layerId: layer.id, res: 0, areaKey: key, bounds: [unMercX(x0), unMercY(y0 - sh * m), unMercX(x0 + sw * m), unMercY(y0)], raster: { w: sw, h: sh, rgba, x0, y0, m, mpp: m * cos } };
  }
  if (layer.kind !== 'pdok') throw new Error('Kies een beeldlaag (luchtfoto of afbeelding)');
  if (!area) throw new Error('Teken eerst het gebied waarin gezocht moet worden (stap 1)');
  const lons = area.map((c) => c[0]), lats = area.map((c) => c[1]);
  const lat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const cos = Math.cos((lat * Math.PI) / 180);
  // Tile level whose pixels are at least as fine as the requested resolution.
  const want = res > 0 ? res : 0.25;
  const z = Math.max(12, Math.min(20, Math.ceil(Math.log2((156543.03392 * cos) / want))));
  const n = 2 ** z;
  const tx = (lon: number) => Math.floor(((lon + 180) / 360) * n);
  const ty = (la: number) => { const r = (la * Math.PI) / 180; return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n); };
  const tLon = (x: number) => (x / n) * 360 - 180;
  const tLat = (y: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
  const xs = [tx(Math.min(...lons)), tx(Math.max(...lons))], ys = [ty(Math.max(...lats)), ty(Math.min(...lats))];
  const w = (xs[1] - xs[0] + 1) * 256, h = (ys[1] - ys[0] + 1) * 256;
  const west = tLon(xs[0]), north = tLat(ys[0]), east = tLon(xs[1] + 1), south = tLat(ys[1] + 1);
  const x0 = mercX(west), y0 = mercY(north);
  const m = (mercX(east) - x0) / w;
  if (w * h > MAX_PX) throw tooBig(w * h, m * cos, true);
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d', { willReadFrequently: true })!;
  const url = pdokUrl(layer.pdokLayer ?? 'Actueel_orthoHR');
  const jobs: Promise<void>[] = [];
  for (let x = xs[0]; x <= xs[1]; x++)
    for (let y = ys[0]; y <= ys[1]; y++)
      jobs.push(loadImage(url.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y))).then((img) => { if (img) ctx.drawImage(img, (x - xs[0]) * 256, (y - ys[0]) * 256); }));
  await Promise.all(jobs);
  const rgba = ctx.getImageData(0, 0, w, h).data;
  clipToArea(rgba, w, h, area.map((c) => [(mercX(c[0]) - x0) / m, (y0 - mercY(c[1])) / m]));
  return { id, layerId: layer.id, res, areaKey: key, bounds: [west, south, east, north], raster: { w, h, rgba, x0, y0, m, mpp: m * cos } };
}

/** Wraps the worker: one raster loaded at a time, newest request wins. */
export class Vectorizer {
  private worker = new Worker(new URL('./vecworker.ts', import.meta.url), { type: 'module' });
  private loadedId = '';
  private req = 0;
  private waiting = new Map<number, (r: RunResult | null, err?: string) => void>();

  constructor() {
    this.worker.onmessage = (e) => {
      const m = e.data;
      if (m.type !== 'result') return;
      const cb = this.waiting.get(m.req);
      this.waiting.delete(m.req);
      cb?.(m.error ? null : m.result, m.error);
    };
  }

  load(s: Sample) {
    if (this.loadedId === s.id) return;
    const rgba = new Uint8ClampedArray(s.raster.rgba); // copy: the sample keeps its own
    this.worker.postMessage({ type: 'load', id: s.id, raster: { ...s.raster, rgba } }, [rgba.buffer]);
    this.loadedId = s.id;
  }

  run(s: Sample, params: RunParams): Promise<RunResult | null> {
    this.load(s);
    const req = ++this.req;
    return new Promise((resolve, reject) => {
      this.waiting.set(req, (r, err) => {
        if (req !== this.req) return resolve(null); // a newer request is on its way
        if (err && err !== 'stale') reject(new Error(err)); else resolve(r);
      });
      this.worker.postMessage({ type: 'run', req, rasterId: s.id, params });
    });
  }

  dispose() { this.worker.terminate(); }
}

/** A canvas with the prepared image, to show "what the computer sees" (no PNG encoding: large areas stay fast). */
export function previewCanvas(s: Sample, rgba: Uint8ClampedArray): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = s.raster.w; cv.height = s.raster.h;
  cv.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(rgba), s.raster.w, s.raster.h), 0, 0);
  return cv;
}

export function sampleCorners(s: Sample): [[number, number], [number, number], [number, number], [number, number]] {
  const [w, so, e, n] = s.bounds;
  return [[w, n], [e, n], [e, so], [w, so]];
}

export { unMercX, unMercY };
export type { MaskOp as VecOp, Pick as VecPick };
