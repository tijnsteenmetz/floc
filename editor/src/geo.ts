// Geometry helpers shared by the browser and the server.
import * as turf from '@turf/turf';
import type { Feature, FeatureCollection, Polygon, MultiPolygon, LineString, Position } from 'geojson';
import type { Facility, Layer, Project } from './types';
import { isVectorKind } from './types';

export type XY = [number, number];

/** Flat x/y in metres around a reference point (same constants as the app). */
export class LocalProjection {
  readonly mPerDegLat = 110_540;
  readonly mPerDegLon: number;
  constructor(readonly lon0: number, readonly lat0: number) {
    this.mPerDegLon = 111_320 * Math.cos((lat0 * Math.PI) / 180);
  }
  toXY(c: Position): XY {
    return [(c[0] - this.lon0) * this.mPerDegLon, (c[1] - this.lat0) * this.mPerDegLat];
  }
  toLonLat(p: XY): XY {
    return [this.lon0 + p[0] / this.mPerDegLon, this.lat0 + p[1] / this.mPerDegLat];
  }
}

/** Width × depth (metres) of a facility outline, in its own frame. */
export function shapeSize(points: [number, number][]): { w: number; h: number } {
  if (!points.length) return { w: 0, h: 0 };
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
  return { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

/** Area-weighted centroid of a simple polygon in metres. */
export function polygonCentroid(pts: XY[]): XY {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % pts.length];
    const f = x0 * y1 - x1 * y0;
    a += f; cx += (x0 + x1) * f; cy += (y0 + y1) * f;
  }
  if (Math.abs(a) < 1e-9) {
    const n = pts.length || 1;
    return [pts.reduce((s, p) => s + p[0], 0) / n, pts.reduce((s, p) => s + p[1], 0) / n];
  }
  a *= 0.5;
  return [cx / (6 * a), cy / (6 * a)];
}

/** The outline of a facility on the map, or null when it's a dot. */
export function facilityPolygon(f: Facility): Feature<Polygon> | null {
  if (!f.shape || f.shape.length < 3) return null;
  const ring = f.shape.map((o) => facilityToLonLat(f, { x: o[0], y: o[1] }));
  ring.push(ring[0]);
  return turf.polygon([ring], { facility: f.id });
}

/** Rotation handle position: a bit beyond the outline, north of the centre, rotated with it. */
export function rotationHandle(f: Facility): XY {
  const r = Math.max(2, ...(f.shape ?? []).map((o) => Math.hypot(o[0], o[1]))) * 1.15 + 2;
  return facilityToLonLat(f, { x: 0, y: r });
}

export function isHole(f: Feature): boolean {
  return !!(f.properties && (f.properties as any).hole);
}

/**
 * Polygons of a vector layer with its hole features cut out.
 * Order matters, like paint: a hole only cuts the polygons drawn before it, so a polygon drawn later
 * on top of a hole wins (draw a walkable area over a cut-out to make it walkable again).
 */
export function effectivePolygons(layer: Layer): Feature<Polygon | MultiPolygon>[] {
  const feats = layer.features?.features ?? [];
  const out: Feature<Polygon | MultiPolygon>[] = [];
  const isPoly = (f: Feature) => f.geometry?.type === 'Polygon' || f.geometry?.type === 'MultiPolygon';
  feats.forEach((p, i) => {
    if (isHole(p) || !isPoly(p)) return;
    let cur: Feature<Polygon | MultiPolygon> | null = p as Feature<Polygon | MultiPolygon>;
    for (let j = i + 1; j < feats.length && cur; j++) {
      const h = feats[j];
      if (!isHole(h) || h.geometry?.type !== 'Polygon') continue;
      try {
        if (!turf.booleanIntersects(cur, h as Feature<Polygon>)) continue;
        cur = turf.difference(turf.featureCollection([cur, h as Feature<Polygon>])) as Feature<Polygon | MultiPolygon> | null;
      } catch {
        /* keep the shape as it is if the cut fails */
      }
    }
    if (cur) out.push({ ...cur, id: p.id, properties: { ...(p.properties ?? {}) } });
  });
  return out;
}

/** A facility-frame offset (metres, before rotation) to lon/lat. */
export function facilityToLonLat(f: Facility, o: { x: number; y: number }): XY {
  const t = (f.rotation * Math.PI) / 180;
  const rx = o.x * Math.cos(t) + o.y * Math.sin(t);
  const ry = -o.x * Math.sin(t) + o.y * Math.cos(t);
  return new LocalProjection(f.lon, f.lat).toLonLat([rx, ry]);
}

/** Lon/lat to a facility-frame offset (inverse of facilityToLonLat). */
export function lonLatToFacility(f: Facility, c: Position): { x: number; y: number } {
  const [wx, wy] = new LocalProjection(f.lon, f.lat).toXY(c);
  const t = (f.rotation * Math.PI) / 180;
  return { x: wx * Math.cos(t) - wy * Math.sin(t), y: wx * Math.sin(t) + wy * Math.cos(t) };
}

/** Where routes to a facility may end: its navigation points, or its centre when it has none. */
export function facilityTargets(f: Facility): XY[] {
  return f.nav?.length ? f.nav.map((o) => facilityToLonLat(f, o)) : [[f.lon, f.lat]];
}

/** A polygon traced on the map as a facility outline: centre (area centroid) plus the outline in metres around it. */
export function shapeFromRing(ring: Position[]): { shape: [number, number][]; lon: number; lat: number } {
  const closed = ring.length > 3 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1];
  const pts = closed ? ring.slice(0, -1) : ring;
  const c0 = pts.reduce((a, p) => [a[0] + p[0] / pts.length, a[1] + p[1] / pts.length], [0, 0]);
  const proj0 = new LocalProjection(c0[0], c0[1]);
  const [lon, lat] = proj0.toLonLat(polygonCentroid(pts.map((p) => proj0.toXY(p))));
  const proj = new LocalProjection(lon, lat);
  const r2 = (v: number) => Math.round(v * 100) / 100;
  return { shape: pts.map((p) => { const [x, y] = proj.toXY(p); return [r2(x), r2(y)]; }), lon, lat };
}

export function layerLines(layer: Layer): Feature<LineString>[] {
  const out: Feature<LineString>[] = [];
  for (const f of layer.features?.features ?? []) {
    if (f.geometry?.type === 'LineString') out.push(f as Feature<LineString>);
    else if (f.geometry?.type === 'MultiLineString') {
      for (const c of f.geometry.coordinates) out.push(turf.lineString(c, f.properties ?? {}));
    }
  }
  return out;
}

/** Split multi-geometries into simple ones and turn interior rings into separate hole features. */
export function normaliseFeatures(fc: FeatureCollection, newId: () => string): Feature[] {
  const out: Feature[] = [];
  const add = (geometry: any, props: Record<string, any>) => out.push({ type: 'Feature', id: newId(), geometry, properties: { ...props } });
  for (const f of fc.features) {
    const g = f.geometry as any;
    if (!g) continue;
    const props = { ...(f.properties ?? {}) };
    delete props.mode;
    const poly = (rings: Position[][]) => {
      if (!rings.length || rings[0].length < 4) return;
      add({ type: 'Polygon', coordinates: [rings[0]] }, props);
      for (const hole of rings.slice(1)) if (hole.length >= 4) add({ type: 'Polygon', coordinates: [hole] }, { hole: true });
    };
    switch (g.type) {
      case 'LineString': if (g.coordinates.length >= 2) add(g, props); break;
      case 'MultiLineString': for (const c of g.coordinates) if (c.length >= 2) add({ type: 'LineString', coordinates: c }, props); break;
      case 'Polygon': poly(g.coordinates); break;
      case 'MultiPolygon': for (const p of g.coordinates) poly(p); break;
      case 'Point': add(g, props); break;
      case 'MultiPoint': for (const c of g.coordinates) add({ type: 'Point', coordinates: c }, props); break;
      case 'GeometryCollection':
        for (const sub of g.geometries) out.push(...normaliseFeatures({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: sub, properties: props }] }, newId));
        break;
    }
  }
  return out;
}

/** Bounding box [w, s, e, n] of everything drawn in a project, or null. */
export function projectBounds(p: Project): [number, number, number, number] | null {
  const feats: Feature[] = [];
  for (const l of p.layers) {
    if (isVectorKind(l.kind)) feats.push(...(l.features?.features ?? []));
    if (l.kind === 'image' && l.image?.warped) {
      const [w, s, e, n] = l.image.warped.bounds;
      feats.push(turf.bboxPolygon([w, s, e, n]));
    }
  }
  for (const f of p.facilities) {
    feats.push(facilityPolygon(f) ?? turf.point([f.lon, f.lat]));
  }
  if (!feats.length) return null;
  return turf.bbox(turf.featureCollection(feats)) as [number, number, number, number];
}

export function formatDistance(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1).replace('.', ',')} km` : `${Math.round(m / 5) * 5} m`;
}

export function formatWalkingTime(m: number): string {
  return `${Math.max(1, Math.ceil(m / (5000 / 3600) / 60))} min`;
}

export function fmtNum(n: number, digits = 1): string {
  const r = Math.round(n * 10 ** digits) / 10 ** digits;
  return String(r).replace('.', ',');
}
