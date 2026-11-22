// Turns the project's layer stack into MapLibre sources and style layers.
import type { Map as MLMap, LayerSpecification } from 'maplibre-gl';
import type { Feature, FeatureCollection } from 'geojson';
import type { Facility, Layer, Library } from '../types';
import { isVectorKind, pdokUrl } from '../types';
import { effectivePolygons, facilityPolygon, layerLines } from '../geo';
import { fileUrl } from '../api';

export const BGT_COLORS: Record<string, string> = {
  farmland: '#1F251C', grass: '#1E2A1F', shrub: '#203322', forest: '#1B3524', sand: '#3B3322', unpaved: '#2A2824',
  paved: '#26282B', road: '#2E3135', path: '#34373B', water: '#14384F', bank: '#1C2B30', bridge: '#3A3D41', building: '#2B2D31', wall: '#3A3D41',
};

const WIDTH = { dun: 1.5, normaal: 2.5, dik: 4 } as const;

export function mix(hex: string, other: string, t: number): string {
  const p = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const a = p(hex.length === 7 ? hex : '#888888'), b = p(other);
  return '#' + a.map((v, i) => Math.round(v * (1 - t) + b[i] * t).toString(16).padStart(2, '0')).join('');
}

/** Hatch / texture fill pattern for a colour, registered once per map. */
function ensurePattern(map: MLMap, kind: 'arcering' | 'textuur', color: string): string {
  const name = `pat-${kind}-${color}`;
  if (map.hasImage(name)) return name;
  const size = kind === 'arcering' ? 10 : 14;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = color;
  ctx.globalAlpha = kind === 'arcering' ? 0.08 : 0.28;
  ctx.fillRect(0, 0, size, size);
  ctx.globalAlpha = kind === 'arcering' ? 0.45 : 0.75;
  if (kind === 'arcering') {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.moveTo(0, size); ctx.lineTo(size, 0);
    ctx.moveTo(-2, 2); ctx.lineTo(2, -2);
    ctx.moveTo(size - 2, size + 2); ctx.lineTo(size + 2, size - 2);
    ctx.stroke();
  } else {
    ctx.fillStyle = mix(color, '#000000', 0.25);
    ctx.beginPath(); ctx.arc(4, 4, 2.4, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(11, 10, 2.8, 0, Math.PI * 2); ctx.fill();
  }
  const data = ctx.getImageData(0, 0, size, size);
  map.addImage(name, { width: size, height: size, data: new Uint8Array(data.data.buffer) });
  return name;
}

export function layerData(l: Layer): FeatureCollection {
  if (l.kind === 'bgt') return l.features ?? { type: 'FeatureCollection', features: [] };
  const feats: Feature[] = [];
  for (const f of effectivePolygons(l)) feats.push({ ...f, properties: { ...(f.properties ?? {}), _id: f.id ?? null } });
  for (const f of layerLines(l)) feats.push({ ...f, properties: { ...(f.properties ?? {}), _id: f.id ?? null } });
  return { type: 'FeatureCollection', features: feats };
}

/** Outlines of the facilities that are shown (see `shown`). */
export function facilityData(facilities: Facility[], lib: Library, selected: string | null, shown: (f: Facility) => boolean = () => true): FeatureCollection {
  const feats: Feature[] = [];
  for (const f of facilities) {
    if (!shown(f)) continue;
    const poly = facilityPolygon(f);
    if (!poly) continue;
    const cat = lib.categories.find((c) => c.id === f.category);
    feats.push({ ...poly, properties: { id: f.id, color: cat?.color ?? '#F5B84A', selected: f.id === selected, name: f.name } });
  }
  return { type: 'FeatureCollection', features: feats };
}

/** Style layers for one project layer, bottom to top. */
export function styleLayers(map: MLMap, l: Layer, pid: string): LayerSpecification[] {
  const src = `src-${l.id}`;
  const op = l.visible ? l.opacity / 100 : 0;
  const vis = l.visible ? 'visible' : 'none';
  const id = (s: string) => `L-${l.id}-${s}`;
  const st = l.style;
  if (l.kind === 'pdok') {
    return [{ id: id('r'), type: 'raster', source: src, layout: { visibility: vis }, paint: { 'raster-opacity': op, 'raster-brightness-min': Math.max(0, (st.brightness ?? 0) / 100), 'raster-brightness-max': Math.min(1, 1 + (st.brightness ?? 0) / 100) } }];
  }
  if (l.kind === 'image') {
    if (!l.image?.warped) return [];
    return [{ id: id('r'), type: 'raster', source: src, layout: { visibility: vis }, paint: { 'raster-opacity': op, 'raster-fade-duration': 0, 'raster-brightness-min': Math.max(0, (st.brightness ?? 0) / 100), 'raster-brightness-max': Math.min(1, 1 + (st.brightness ?? 0) / 100) } }];
  }
  if (l.kind === 'bgt') {
    const colors: any[] = ['match', ['get', 'kind']];
    for (const [k, c] of Object.entries(BGT_COLORS)) colors.push(k, c);
    colors.push('#1C1F21');
    return [{ id: id('fill'), type: 'fill', source: src, layout: { visibility: vis }, paint: { 'fill-color': colors as any, 'fill-opacity': op } }];
  }
  if (!isVectorKind(l.kind)) return [];
  const out: LayerSpecification[] = [];
  const polyFilter: any = ['==', ['geometry-type'], 'Polygon'];
  const lineFilter: any = ['==', ['geometry-type'], 'LineString'];
  const w = WIDTH[st.width];
  if (st.fill !== 'geen' && l.kind !== 'hekken') {
    if (st.fill === 'vol') out.push({ id: id('fill'), type: 'fill', source: src, filter: polyFilter, layout: { visibility: vis }, paint: { 'fill-color': st.color, 'fill-opacity': 0.45 * op } });
    else out.push({ id: id('fill'), type: 'fill', source: src, filter: polyFilter, layout: { visibility: vis }, paint: { 'fill-pattern': ensurePattern(map, st.fill, st.color), 'fill-opacity': op } });
  }
  out.push({
    id: id('edge'), type: 'line', source: src, filter: polyFilter, layout: { visibility: vis, 'line-join': 'round' },
    paint: { 'line-color': st.color, 'line-width': Math.max(1, w * 0.6), 'line-opacity': op * (l.kind === 'beloopbaar' ? 0.7 : 0.9), ...(st.dash === 'gestreept' ? { 'line-dasharray': [3, 2.5] } : {}) },
  });
  if (l.kind === 'hekken') {
    out.push({ id: id('line'), type: 'line', source: src, filter: lineFilter, layout: { visibility: vis, 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': st.color, 'line-width': Math.max(1, w * 0.5), 'line-opacity': op } });
    if (st.dash === 'gestreept') out.push({ id: id('posts'), type: 'line', source: src, filter: lineFilter, layout: { visibility: vis, 'line-cap': 'round' }, paint: { 'line-color': st.color, 'line-width': w * 1.8, 'line-opacity': op, 'line-dasharray': [0.2, 3.2] } });
    return out;
  }
  const lineColor = l.kind === 'beloopbaar' ? mix(st.color, '#9AA0A6', 0.55) : st.color;
  out.push({ id: id('case'), type: 'line', source: src, filter: lineFilter, layout: { visibility: vis, 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#0C0D0E', 'line-width': w + 3, 'line-opacity': 0.55 * op } });
  out.push({ id: id('line'), type: 'line', source: src, filter: lineFilter, layout: { visibility: vis, 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': lineColor, 'line-width': w, 'line-opacity': op, ...(st.dash === 'gestreept' ? { 'line-dasharray': [2, 1.6] } : {}) } });
  return out;
}

/** Adds or updates the source for one project layer. Returns false if it doesn't render. */
export function syncSource(map: MLMap, l: Layer, pid: string, data?: FeatureCollection): void {
  const src = `src-${l.id}`;
  const existing = map.getSource(src) as any;
  if (l.kind === 'pdok') {
    const url = pdokUrl(l.pdokLayer ?? 'Actueel_orthoHR');
    if (existing && existing._floc === url) return;
    if (existing) removeLayerAndSource(map, l.id);
    map.addSource(src, { type: 'raster', tiles: [url], tileSize: 256, maxzoom: 21, attribution: 'Luchtfoto © PDOK' });
    (map.getSource(src) as any)._floc = url;
    return;
  }
  if (l.kind === 'image') {
    if (!l.image?.warped) { if (existing) removeLayerAndSource(map, l.id); return; }
    const [w, s, e, n] = l.image.warped.bounds;
    const url = fileUrl(pid, `images/${l.id}/warped.png`, l.image.warped.version);
    const coordinates: [[number, number], [number, number], [number, number], [number, number]] = [[w, n], [e, n], [e, s], [w, s]];
    if (existing && existing._floc === url) return;
    if (existing) removeLayerAndSource(map, l.id);
    map.addSource(src, { type: 'image', url, coordinates });
    (map.getSource(src) as any)._floc = url;
    return;
  }
  if (existing) { if (data) existing.setData(data); return; }
  map.addSource(src, { type: 'geojson', data: data ?? layerData(l) });
}

export function removeLayerAndSource(map: MLMap, layerId: string) {
  for (const ly of map.getStyle().layers ?? []) if (ly.id.startsWith(`L-${layerId}-`)) map.removeLayer(ly.id);
  if (map.getSource(`src-${layerId}`)) map.removeSource(`src-${layerId}`);
}
