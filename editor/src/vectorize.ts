// "Vectoriseren op kleur", browser side: fetches the image layer at a fixed ground resolution
// (independent of the zoom level) and talks to the worker that does the work (see veccore.ts).
import type { Map as MLMap } from 'maplibre-gl';
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
  res: number; // requested metres per pixel (0 = the file's own)
  raster: Raster;
  bounds: [number, number, number, number]; // w, s, e, n
}

const MAX_PX = 9_000_000;

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
 * The pixels of an image layer at `res` metres per pixel.
 * A plan/PDF: the whole image. The aerial photo: the area in view (it's endless), at a fixed tile level.
 */
export async function sampleLayer(map: MLMap, layer: Layer, pid: string, res: number, include: Position[] = []): Promise<Sample> {
  const id = `${layer.id}:${res}:${Date.now()}`;
  if (layer.kind === 'image') {
    if (!layer.image?.warped) throw new Error('Deze afbeelding is nog niet gegeorefereerd');
    const img = await loadImage(fileUrl(pid, `images/${layer.id}/warped.png`, layer.image.warped.version));
    if (!img) throw new Error('Afbeelding laden mislukt');
    const [west, south, east, north] = layer.image.warped.bounds;
    const x0 = mercX(west), y0 = mercY(north);
    const mNative = (mercX(east) - x0) / img.naturalWidth;
    const cos = Math.cos((((south + north) / 2) * Math.PI) / 180);
    let scale = res > 0 ? Math.min(1, (mNative * cos) / res) : 1;
    if (img.naturalWidth * img.naturalHeight * scale * scale > MAX_PX) scale = Math.sqrt(MAX_PX / (img.naturalWidth * img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale)), h = Math.max(1, Math.round(img.naturalHeight * scale));
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d', { willReadFrequently: true })!;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, w, h);
    const m = (mercX(east) - x0) / w;
    return { id, layerId: layer.id, res, bounds: [west, south, east, north], raster: { w, h, rgba: ctx.getImageData(0, 0, w, h).data, x0, y0, m, mpp: m * cos } };
  }
  if (layer.kind !== 'pdok') throw new Error('Kies een beeldlaag (luchtfoto of afbeelding)');
  // The area in view, grown to include earlier clicks (so a new fetch doesn't drop them).
  const vb = map.getBounds();
  const lons = [vb.getWest(), vb.getEast(), ...include.map((c) => c[0])], lats = [vb.getSouth(), vb.getNorth(), ...include.map((c) => c[1])];
  const b = { getWest: () => Math.min(...lons), getEast: () => Math.max(...lons), getSouth: () => Math.min(...lats), getNorth: () => Math.max(...lats) };
  const lat = map.getCenter().lat;
  const cos = Math.cos((lat * Math.PI) / 180);
  // Tile level whose pixels are at least as fine as the requested resolution.
  const want = res > 0 ? res : 0.25;
  const z = Math.max(12, Math.min(20, Math.ceil(Math.log2((156543.03392 * cos) / want))));
  const n = 2 ** z;
  const tx = (lon: number) => Math.floor(((lon + 180) / 360) * n);
  const ty = (la: number) => { const r = (la * Math.PI) / 180; return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n); };
  const tLon = (x: number) => (x / n) * 360 - 180;
  const tLat = (y: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
  const xs = [tx(b.getWest()), tx(b.getEast())], ys = [ty(b.getNorth()), ty(b.getSouth())];
  const tiles = (xs[1] - xs[0] + 1) * (ys[1] - ys[0] + 1);
  if (tiles * 256 * 256 > MAX_PX * 1.6) throw new Error('Dit beeld is te groot voor deze resolutie. Zoom wat in, kies een grovere resolutie, of wis klikken die ver weg liggen.');
  const west = tLon(xs[0]), north = tLat(ys[0]), east = tLon(xs[1] + 1), south = tLat(ys[1] + 1);
  const w = (xs[1] - xs[0] + 1) * 256, h = (ys[1] - ys[0] + 1) * 256;
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d', { willReadFrequently: true })!;
  const url = pdokUrl(layer.pdokLayer ?? 'Actueel_orthoHR');
  const jobs: Promise<void>[] = [];
  for (let x = xs[0]; x <= xs[1]; x++)
    for (let y = ys[0]; y <= ys[1]; y++)
      jobs.push(loadImage(url.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y))).then((img) => { if (img) ctx.drawImage(img, (x - xs[0]) * 256, (y - ys[0]) * 256); }));
  await Promise.all(jobs);
  const x0 = mercX(west), y0 = mercY(north);
  const m = (mercX(east) - x0) / w;
  return { id, layerId: layer.id, res, bounds: [west, south, east, north], raster: { w, h, rgba: ctx.getImageData(0, 0, w, h).data, x0, y0, m, mpp: m * cos } };
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

/** A data URL of the prepared image, to show "what the computer sees". */
export function previewUrl(s: Sample, rgba: Uint8ClampedArray): string {
  const cv = document.createElement('canvas');
  cv.width = s.raster.w; cv.height = s.raster.h;
  cv.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(rgba), s.raster.w, s.raster.h), 0, 0);
  return cv.toDataURL('image/png');
}

export function sampleCorners(s: Sample): [[number, number], [number, number], [number, number], [number, number]] {
  const [w, so, e, n] = s.bounds;
  return [[w, n], [e, n], [e, so], [w, so]];
}

export { unMercX, unMercY };
export type { MaskOp as VecOp, Pick as VecPick };
