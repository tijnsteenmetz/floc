// Importing existing work: map folders from maps/, GeoPackages, and loose vector files.
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import type { FeatureCollection } from 'geojson';
import type { Facility, Layer, LayerKind, Project } from '../src/types';
import { makeLayer, newId } from '../src/types';
import { normaliseFeatures } from '../src/geo';
import { MAPS, REPO, projectDir, uniqueId, writeProject } from './store';
import { gdal, gdalInfo, ogrLayers, ogrToGeoJSON } from './gdal';
import { mercToLonLat } from './images';

export interface ImportSource {
  id: string;
  type: 'map' | 'gpkg';
  path: string; // relative to repo
  desc: string;
}

export async function listSources(): Promise<ImportSource[]> {
  const out: ImportSource[] = [];
  if (existsSync(MAPS)) {
    for (const name of (await fs.readdir(MAPS)).sort()) {
      const dir = path.join(MAPS, name);
      if (!(await fs.stat(dir)).isDirectory()) continue;
      const files = (await fs.readdir(dir)).filter((f) => /\.(geojson|mbtiles|gpkg|json)$/.test(f));
      if (!files.length) continue;
      out.push({ id: `map:${name}`, type: 'map', path: `maps/${name}/`, desc: files.map((f) => f.replace(/\.(geojson|json)$/, '')).join(' · ') });
    }
  }
  const qdir = path.join(REPO, 'qgis');
  if (existsSync(qdir)) {
    for (const f of (await fs.readdir(qdir)).sort()) {
      if (!f.endsWith('.gpkg')) continue;
      let desc = 'GeoPackage';
      try {
        desc = (await ogrLayers(path.join(qdir, f))).map((l) => l.name).join(' · ') || desc;
      } catch { /* ignore */ }
      out.push({ id: `gpkg:${f}`, type: 'gpkg', path: `qgis/${f}`, desc });
    }
  }
  return out;
}

const FACILITY_FILES: Record<string, string> = {
  'stages.geojson': 'podium', 'podia.geojson': 'podium', 'bars.geojson': 'bar', 'munten.geojson': 'munten',
  'wc.geojson': 'wc', 'toiletten.geojson': 'wc', 'ehbo.geojson': 'ehbo', 'eten.geojson': 'eten',
};

/** Guess what a named vector layer is. */
export function guessKind(name: string, geometry: string): { kind: LayerKind | 'facility'; category?: string } {
  const n = name.toLowerCase();
  const isPoint = /point/i.test(geometry);
  if (isPoint) {
    if (/stage|podi/.test(n)) return { kind: 'facility', category: 'podium' };
    if (/bar/.test(n)) return { kind: 'facility', category: 'bar' };
    if (/munt|coin|token/.test(n)) return { kind: 'facility', category: 'munten' };
    if (/wc|toilet|sanit/.test(n)) return { kind: 'facility', category: 'wc' };
    if (/ehbo|first|aid/.test(n)) return { kind: 'facility', category: 'ehbo' };
    if (/food|eten/.test(n)) return { kind: 'facility', category: 'eten' };
    if (/nood|exit/.test(n)) return { kind: 'facility', category: 'nooduitgang' };
    if (/ingang|entr/.test(n)) return { kind: 'facility', category: 'ingang' };
    return { kind: 'facility', category: 'bar' };
  }
  if (/camping|semi|publiek|crowd/.test(n)) return { kind: 'semi' };
  if (/path|pad|walk|loop|route/.test(n)) return { kind: 'beloopbaar' };
  if (/water|vijver|pond|lake/.test(n)) return { kind: 'water' };
  if (/bos|forest|wood|tree/.test(n)) return { kind: 'bos' };
  if (/zand|sand|strand|beach/.test(n)) return { kind: 'zand' };
  if (/hek|fence/.test(n)) return { kind: 'hekken' };
  return { kind: 'eigen' };
}

function pointsToFacilities(fc: FeatureCollection, category: string): Facility[] {
  const out: Facility[] = [];
  for (const f of fc.features) {
    const g = f.geometry as any;
    const pts: number[][] = g?.type === 'Point' ? [g.coordinates] : g?.type === 'MultiPoint' ? g.coordinates : [];
    for (const c of pts) {
      const p = (f.properties ?? {}) as Record<string, any>;
      out.push({ id: newId(), category, name: String(p.name ?? p.naam ?? p.Name ?? ''), notes: '', lon: c[0], lat: c[1], rotation: 0 });
    }
  }
  return out;
}

async function readGeoJSON(file: string): Promise<FeatureCollection> {
  // Through ogr2ogr so files in other projections are converted to WGS84.
  try {
    return await ogrToGeoJSON(file);
  } catch {
    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    return toFeatureCollection(raw);
  }
}

/** Accepts a FeatureCollection, a single Feature, a bare geometry, or a JSON list of objects with lat/lon. */
export function toFeatureCollection(raw: any): FeatureCollection {
  if (raw?.type === 'FeatureCollection') return raw;
  if (raw?.type === 'Feature') return { type: 'FeatureCollection', features: [raw] };
  if (raw && typeof raw.type === 'string' && raw.coordinates) return { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: raw, properties: {} }] };
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.features) ? raw.features : null;
  if (list) {
    const features = list
      .map((o: any) => {
        const lat = Number(o.lat ?? o.latitude ?? o.y);
        const lon = Number(o.lon ?? o.lng ?? o.longitude ?? o.x);
        if (!isFinite(lat) || !isFinite(lon)) return null;
        return { type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties: { ...o } };
      })
      .filter(Boolean);
    if (features.length) return { type: 'FeatureCollection', features };
  }
  throw new Error('Geen geodata gevonden in dit JSON-bestand');
}

function vectorLayer(kind: LayerKind, name: string, fc: FeatureCollection): Layer {
  return makeLayer(kind, { name, features: { type: 'FeatureCollection', features: normaliseFeatures(fc, newId) as any } });
}

function emptyProject(id: string, name: string, notes = ''): Project {
  const now = new Date().toISOString();
  return { id, name, notes, created: now, updated: now, layers: [], facilities: [] };
}

/** Image layer from an already georeferenced raster (e.g. layout.mbtiles). */
async function georeferencedRasterLayer(p: Project, file: string, name: string): Promise<Layer> {
  const layer = makeLayer('image', { name });
  const dir = path.join(projectDir(p.id), 'images', layer.id);
  await fs.mkdir(dir, { recursive: true });
  const tif = path.join(dir, 'warped.tif');
  await gdal('gdalwarp', ['-t_srs', 'EPSG:3857', '-ts', '4096', '0', '-r', 'bilinear', '-of', 'GTiff', '-overwrite', file, tif]);
  await gdal('gdal_translate', ['-of', 'PNG', tif, path.join(dir, 'warped.png')]);
  await fs.copyFile(path.join(dir, 'warped.png'), path.join(dir, 'image.png'));
  await fs.copyFile(path.join(dir, 'warped.png'), path.join(dir, 'full.png'));
  const info = await gdalInfo(tif);
  const cc = info.cornerCoordinates;
  const [w, n] = mercToLonLat(cc.upperLeft[0], cc.upperLeft[1]);
  const [e, s] = mercToLonLat(cc.lowerRight[0], cc.lowerRight[1]);
  const [width, height] = info.size;
  layer.image = { sourceName: path.basename(file), width, height, fullWidth: width, fullHeight: height, crop: null, gcps: [], method: 'affine', warped: { bounds: [w, s, e, n], version: Date.now() } };
  return layer;
}

export async function importMapFolder(name: string): Promise<Project> {
  const dir = path.join(MAPS, name);
  let title = name;
  let notes = '';
  let baseDir: string | null = null;
  if (existsSync(path.join(dir, 'map.json'))) {
    const m = JSON.parse(await fs.readFile(path.join(dir, 'map.json'), 'utf8'));
    title = m.name ?? name;
    notes = m.notes ?? '';
    if (m.base) baseDir = path.join(MAPS, m.base);
  }
  const file = (f: string) => (existsSync(path.join(dir, f)) ? path.join(dir, f) : baseDir && existsSync(path.join(baseDir, f)) ? path.join(baseDir, f) : null);
  const id = await uniqueId(name);
  const p = emptyProject(id, title, notes);
  await fs.mkdir(projectDir(id), { recursive: true });

  const walk = makeLayer('beloopbaar', { features: { type: 'FeatureCollection', features: [] } });
  for (const f of ['paths.geojson', 'walkable.geojson']) {
    const src = file(f);
    if (src) walk.features!.features.push(...(normaliseFeatures(await readGeoJSON(src), newId) as any));
  }
  if (walk.features!.features.length) p.layers.push(walk);

  const blocked = file('blocked.geojson');
  if (blocked) p.layers.push({ ...vectorLayer('eigen', 'Geblokkeerd (import)', await readGeoJSON(blocked)), style: { color: '#F87171', fill: 'arcering', width: 'normaal', dash: 'vol' } });

  for (const f of await fs.readdir(dir)) {
    if (f.endsWith('.gpkg')) {
      for (const l of await ogrLayers(path.join(dir, f))) {
        const g = guessKind(l.name || f, l.geometry);
        const fc = await ogrToGeoJSON(path.join(dir, f), l.name);
        if (g.kind === 'facility') p.facilities.push(...pointsToFacilities(fc, g.category!));
        else p.layers.push(vectorLayer(g.kind, l.name || f.replace('.gpkg', ''), fc));
      }
    }
  }

  for (const [f, cat] of Object.entries(FACILITY_FILES)) {
    const src = path.join(dir, f);
    if (existsSync(src)) p.facilities.push(...pointsToFacilities(await readGeoJSON(src), cat));
  }

  const layout = file('layout.mbtiles');
  if (layout) {
    try {
      const l = await georeferencedRasterLayer(p, layout, 'Plattegrond (import)');
      l.visible = false;
      p.layers.push(l);
    } catch (e) {
      console.warn('layout import failed', e);
    }
  }
  if (file('aerial.mbtiles')) p.layers.push(makeLayer('pdok', { name: 'Luchtfoto PDOK' }));
  const base = file('base.geojson');
  if (base) p.layers.push(makeLayer('bgt', { features: JSON.parse(await fs.readFile(base, 'utf8')) }));

  sortLayers(p);
  return writeProject(p);
}

export async function importGpkg(relPath: string, title?: string): Promise<Project> {
  const file = path.join(REPO, relPath);
  const base = path.basename(file).replace(/\.[^.]+$/, '');
  const id = await uniqueId(base);
  const p = emptyProject(id, title ?? base);
  await fs.mkdir(projectDir(id), { recursive: true });
  await addFileToProject(p, file);
  sortLayers(p);
  return writeProject(p);
}

/** Puts every layer of a vector file into the project, guessing kinds. Paths + walkable areas share one Beloopbaar layer. */
export async function addFileToProject(p: Project, file: string): Promise<void> {
  const parsed = await parseVectorFile(file);
  let walk = p.layers.find((l) => l.kind === 'beloopbaar');
  for (const item of parsed) {
    if (item.suggested.kind === 'facility') {
      p.facilities.push(...pointsToFacilities(item.fc, item.suggested.category!));
    } else if (item.suggested.kind === 'beloopbaar') {
      if (!walk) { walk = makeLayer('beloopbaar'); p.layers.push(walk); }
      walk.features!.features.push(...(normaliseFeatures(item.fc, newId) as any));
    } else {
      p.layers.push(vectorLayer(item.suggested.kind, item.name, item.fc));
    }
  }
}

export interface ParsedLayer {
  name: string;
  geometry: string;
  fc: FeatureCollection;
  suggested: { kind: LayerKind | 'facility'; category?: string };
}

/** Reads any vector file (GeoJSON/JSON, GeoPackage, KML, GPX, Shapefile zip, DXF, CSV) into WGS84 layers. */
export async function parseVectorFile(file: string, originalName = path.basename(file)): Promise<ParsedLayer[]> {
  const ext = path.extname(originalName).toLowerCase();
  let source = file;
  if (ext === '.zip') source = `/vsizip/${file}`;
  const base = originalName.replace(/\.[^.]+$/, '');
  if (ext === '.json' || ext === '.geojson') {
    let fc: FeatureCollection;
    try {
      fc = await ogrToGeoJSON(source);
    } catch {
      fc = toFeatureCollection(JSON.parse(await fs.readFile(file, 'utf8')));
    }
    return [describe(base, fc)];
  }
  if (ext === '.csv') {
    const fc = await ogrToGeoJSON(source, undefined, ['-oo', 'X_POSSIBLE_NAMES=lon,lng,longitude,x', '-oo', 'Y_POSSIBLE_NAMES=lat,latitude,y', '-s_srs', 'EPSG:4326']);
    return [describe(base, fc)];
  }
  const layers = await ogrLayers(source);
  const out: ParsedLayer[] = [];
  for (const l of layers) {
    const fc = await ogrToGeoJSON(source, l.name);
    if (!fc.features?.length) continue;
    out.push(describe(layers.length > 1 ? l.name : base, fc));
  }
  return out;
}

function describe(name: string, fc: FeatureCollection): ParsedLayer {
  const types = new Set(fc.features.map((f) => f.geometry?.type ?? 'None'));
  const geometry = [...types].join(', ');
  const allPoints = [...types].every((t) => /Point/.test(t));
  return { name, geometry, fc, suggested: guessKind(name, allPoints ? 'Point' : geometry) };
}

/** Drawing layers on top, facilities, then images; walkable above terrain. */
export function sortLayers(p: Project) {
  const order: LayerKind[] = ['voorzieningen', 'hekken', 'beloopbaar', 'semi', 'eigen', 'water', 'bos', 'zand', 'image', 'pdok', 'bgt'];
  if (!p.layers.some((l) => l.kind === 'voorzieningen')) p.layers.push(makeLayer('voorzieningen'));
  p.layers.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
}

export { emptyProject };
