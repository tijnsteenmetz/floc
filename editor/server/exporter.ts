// Writes a project to maps/<id>/ in the format the iOS app reads.
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import * as turf from '@turf/turf';
import type { Feature } from 'geojson';
import type { Library, Project } from '../src/types';
import { SEMI_SNAP_M, isVectorKind, isWalkableLayer } from '../src/types';
import { effectivePolygons, facilityPolygon, facilityTargets, layerLines, projectBounds } from '../src/geo';
import { MAPS, projectDir } from './store';
import { gdal } from './gdal';
import { imageDir } from './images';
import { countTiles, writeAerialMbtiles } from './pdok';

export interface ExportPlanItem {
  file: string;
  what: string;
  app: boolean;
}

const APP_POI: Record<string, string> = { podium: 'stages.geojson', bar: 'bars.geojson', munten: 'munten.geojson' };
const MANAGED = ['photos', 'map.json', 'paths.geojson', 'walkable.geojson', 'semi.geojson', 'blocked.geojson', 'base.geojson', 'stages.geojson', 'bars.geojson', 'munten.geojson', 'facilities.geojson', 'fences.geojson', 'aerial.mbtiles', 'layout.mbtiles'];

export function exportTarget(p: Project) {
  return { dir: path.join(MAPS, p.id), rel: `maps/${p.id}/` };
}

function included(p: Project) {
  return p.layers.filter((l) => !l.noExport);
}

export function exportPlan(p: Project, lib: Library): ExportPlanItem[] {
  const layers = included(p);
  const walk = layers.filter(isWalkableLayer);
  const lines = walk.flatMap(layerLines).length;
  const polys = walk.flatMap(effectivePolygons).length;
  const items: ExportPlanItem[] = [{ file: 'map.json', what: 'naam, notities en laagkleuren', app: true }];
  items.push({ file: 'paths.geojson', what: `${lines} paden uit Beloopbaar`, app: true });
  if (polys) items.push({ file: 'walkable.geojson', what: `${polys} beloopbare vlakken`, app: true });
  const semi = layers.filter((l) => l.kind === 'semi').flatMap(effectivePolygons).length;
  if (semi) items.push({ file: 'semi.geojson', what: `${semi} semi-beloopbare vlakken met GPS-snapafstand`, app: false });
  const facLayer = layers.find((l) => l.kind === 'voorzieningen');
  if (facLayer) {
    const pois = Object.entries(APP_POI).map(([cat, file]) => [file, p.facilities.filter((f) => f.category === cat).length] as const).filter(([, n]) => n);
    if (pois.length) items.push({ file: pois.map(([f]) => f.replace('.geojson', '')).join(' · '), what: 'als punten (midden van de vorm)', app: true });
  }
  const terrain = layers.filter((l) => ['water', 'bos', 'zand'].includes(l.kind)).length;
  if (layers.some((l) => l.kind === 'bgt') || terrain) items.push({ file: 'base.geojson', what: ['BGT', terrain ? 'Water, Bos, Zand' : ''].filter(Boolean).join(' + '), app: true });
  const pdok = layers.find((l) => l.kind === 'pdok' && l.visible);
  const b = terrainBounds(p);
  if (pdok && b) items.push({ file: 'aerial.mbtiles', what: `PDOK · ${AERIAL_MARGIN_M} m rond het terrein · zoom 14–20 · JPG · ${countTiles(pad(b, AERIAL_MARGIN_M), 14, 20)} tegels`, app: true });
  const img = layers.find((l) => l.kind === 'image' && l.visible && l.image?.warped);
  if (img) items.push({ file: 'layout.mbtiles', what: `${img.name} · PNG`, app: true });
  if (facLayer && p.facilities.length) items.push({ file: 'facilities.geojson', what: `${p.facilities.length} voorzieningen met vorm, info, foto en planning`, app: false });
  if (layers.some((l) => l.kind === 'hekken')) items.push({ file: 'fences.geojson', what: 'Hekken', app: false });
  return items;
}

/** The app shows the aerial this far around the terrain, so you can find your way back from the car park or the village. */
const AERIAL_MARGIN_M = 600;

/** The terrain itself: walkable layers and facilities (not georeferenced plans, which often reach far beyond the site). */
function terrainBounds(p: Project): [number, number, number, number] | null {
  const feats: Feature[] = [];
  for (const l of included(p).filter(isWalkableLayer)) feats.push(...((l.features?.features ?? []) as Feature[]));
  for (const f of p.facilities) feats.push(turf.point([f.lon, f.lat]));
  return feats.length ? (turf.bbox(turf.featureCollection(feats)) as [number, number, number, number]) : projectBounds(p);
}

function pad(b: [number, number, number, number], m: number): [number, number, number, number] {
  const dLat = m / 110_540;
  const dLon = m / (111_320 * Math.cos((((b[1] + b[3]) / 2) * Math.PI) / 180));
  return [b[0] - dLon, b[1] - dLat, b[2] + dLon, b[3] + dLat];
}

async function writeGeo(dir: string, file: string, features: Feature[]) {
  await fs.writeFile(path.join(dir, file), JSON.stringify({ type: 'FeatureCollection', features }));
}

/** Identifies the aerial photo an export would fetch; equal keys = same tiles, so a publish can reuse the previous file. */
export function aerialKey(p: Project): string | null {
  const pdok = included(p).find((l) => l.kind === 'pdok' && l.visible);
  const site = terrainBounds(p);
  if (!pdok || !site) return null;
  return `${pdok.pdokLayer ?? 'Actueel_orthoHR'}:${pad(site, AERIAL_MARGIN_M).map((v) => v.toFixed(5)).join(',')}:14-20`;
}

export const MANAGED_FILES = MANAGED;

export async function runExport(p: Project, lib: Library, progress: (msg: string, frac: number) => void, opts: { skipAerial?: boolean } = {}): Promise<string[]> {
  const { dir } = exportTarget(p);
  await fs.mkdir(dir, { recursive: true });
  for (const f of MANAGED) if (!(opts.skipAerial && f === 'aerial.mbtiles')) await fs.rm(path.join(dir, f), { force: true, recursive: true });
  const written: string[] = [];
  const layers = included(p);

  progress('Vectorlagen schrijven', 0.02);
  const styles: Record<string, unknown> = {};
  for (const l of layers) styles[l.name] = { kind: l.kind, ...l.style, opacity: l.opacity / 100 };
  const site = terrainBounds(p);
  const hasAerial = layers.some((l) => l.kind === 'pdok' && l.visible);
  const meta = { name: p.name, notes: p.notes, styles, ...(site ? { site_bounds: site } : {}), ...(site && hasAerial ? { aerial_bounds: pad(site, AERIAL_MARGIN_M) } : {}) };
  await fs.writeFile(path.join(dir, 'map.json'), JSON.stringify(meta, null, 1));
  written.push('map.json');

  const walk = layers.filter(isWalkableLayer);
  await writeGeo(dir, 'paths.geojson', walk.flatMap((l) => layerLines(l).map((f) => ({ ...f, properties: { ...(f.properties ?? {}), layer: l.name } }))));
  written.push('paths.geojson');
  const polys = walk.flatMap(effectivePolygons);
  if (polys.length) { await writeGeo(dir, 'walkable.geojson', polys); written.push('walkable.geojson'); }

  const semi = layers.filter((l) => l.kind === 'semi').flatMap((l) => effectivePolygons(l).map((f) => {
    const own = f.properties?.snap_m;
    return { ...f, properties: { ...(f.properties ?? {}), snap_m: own !== undefined && own !== '' ? Number(own) : l.snapM ?? SEMI_SNAP_M, layer: l.name } };
  }));
  if (semi.length) { await writeGeo(dir, 'semi.geojson', semi); written.push('semi.geojson'); }

  const facLayer = layers.find((l) => l.kind === 'voorzieningen');
  if (facLayer) {
    for (const [cat, file] of Object.entries(APP_POI)) {
      const pts = p.facilities.filter((f) => f.category === cat).map((f) => turf.point([f.lon, f.lat], { name: f.name, ...(f.nav?.length ? { nav: facilityTargets(f) } : {}) }));
      if (pts.length) { await writeGeo(dir, file, pts); written.push(file); }
    }
    if (p.facilities.length) {
      const feats: Feature[] = [];
      for (const f of p.facilities) {
        const cat = lib.categories.find((c) => c.id === f.category);
        const props: Record<string, unknown> = { id: f.id, category: f.category, category_name: cat?.name ?? f.category, category_color: cat?.color, category_label: cat?.label, name: f.name, info: f.notes, nav: facilityTargets(f) };
        if (f.timetable?.length) props.timetable = f.timetable.map(({ id, ...t }) => t);
        if (f.photo && existsSync(path.join(projectDir(p.id), f.photo))) {
          const rel = `photos/${f.id}${path.extname(f.photo)}`; // app-side name stays stable
          await fs.mkdir(path.join(dir, 'photos'), { recursive: true });
          await fs.copyFile(path.join(projectDir(p.id), f.photo), path.join(dir, rel));
          props.photo = rel;
        }
        const poly = facilityPolygon(f);
        feats.push(poly ? { ...poly, properties: { ...props, centre: [f.lon, f.lat] } } : turf.point([f.lon, f.lat], props));
      }
      await writeGeo(dir, 'facilities.geojson', feats as Feature[]);
      written.push('facilities.geojson');
    }
  }

  const fences = layers.filter((l) => l.kind === 'hekken').flatMap(layerLines);
  if (fences.length) { await writeGeo(dir, 'fences.geojson', fences); written.push('fences.geojson'); }

  const KIND: Record<string, string> = { water: 'water', bos: 'forest', zand: 'sand' };
  const base: Feature[] = [];
  for (const l of [...layers].reverse()) {
    if (l.kind === 'bgt') base.push(...((l.features?.features ?? []) as Feature[]));
    else if (KIND[l.kind]) base.push(...effectivePolygons(l).map((f) => ({ ...f, properties: { kind: KIND[l.kind] } })));
  }
  if (base.length) { await writeGeo(dir, 'base.geojson', base); written.push('base.geojson'); }

  const img = layers.find((l) => l.kind === 'image' && l.visible && l.image?.warped);
  if (img) {
    progress(`${img.name} naar MBTiles`, 0.1);
    const tif = path.join(imageDir(p.id, img.id), 'warped.tif');
    const out = path.join(dir, 'layout.mbtiles');
    await gdal('gdal_translate', ['-of', 'MBTILES', '-co', 'TILE_FORMAT=PNG', '-co', 'ZOOM_LEVEL_STRATEGY=UPPER', tif, out]);
    await gdal('gdaladdo', ['-r', 'average', out, '2', '4', '8', '16', '32', '64']);
    written.push('layout.mbtiles');
  }

  const pdok = layers.find((l) => l.kind === 'pdok' && l.visible);
  if (pdok && site && !opts.skipAerial) {
    const bb = pad(site, AERIAL_MARGIN_M);
    await writeAerialMbtiles(path.join(dir, 'aerial.mbtiles'), pdok.pdokLayer ?? 'Actueel_orthoHR', bb, 14, 20, (done, total) =>
      progress(`Luchtfoto ophalen: ${done} / ${total} tegels`, 0.2 + 0.8 * (done / total)),
    );
    written.push('aerial.mbtiles');
  }
  progress('Klaar', 1);
  return written;
}

export async function folderExists(p: Project) {
  return existsSync(exportTarget(p).dir);
}

export { isVectorKind };
