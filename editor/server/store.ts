// Project and library files on disk.
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Facility, Library, Project, ProjectSummary, Category } from '../src/types';
import { DEFAULT_CATEGORIES, isVectorKind } from '../src/types';
import { effectivePolygons, facilityPolygon, layerLines, polygonCentroid } from '../src/geo';

export const EDITOR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO = path.resolve(EDITOR, '..');
export const PROJECTS = path.join(EDITOR, 'projects');
export const LIBRARY = path.join(EDITOR, 'library');
export const MAPS = path.join(REPO, 'maps');

export function projectDir(id: string): string {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) throw new Error('Ongeldige kaart-id');
  return path.join(PROJECTS, id);
}

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'kaart'
  );
}

export async function uniqueId(base: string): Promise<string> {
  let id = slugify(base);
  let n = 2;
  while (existsSync(path.join(PROJECTS, id))) id = `${slugify(base)}-${n++}`;
  return id;
}

/** Facilities linked to a library design (before the library was dropped) get that outline as their own. */
async function migrateFacilities(list: any[]): Promise<Facility[]> {
  if (!list.some((f) => 'designId' in f || 'overrides' in f)) return list;
  const dFile = path.join(LIBRARY, 'designs.json');
  const designs: { id: string; points: [number, number][] }[] = existsSync(dFile) ? JSON.parse(await fs.readFile(dFile, 'utf8')) : [];
  return list.map(({ designId, overrides, ...f }) => {
    const d = designs.find((x) => x.id === designId);
    if (d && d.points.length >= 3 && !f.shape) {
      const xs = d.points.map((q) => q[0]), ys = d.points.map((q) => q[1]);
      const W = Math.max(...xs) - Math.min(...xs) || 1, H = Math.max(...ys) - Math.min(...ys) || 1;
      const sx = overrides?.w ? overrides.w / W : 1, sy = overrides?.d ? overrides.d / H : 1;
      const c = polygonCentroid(d.points);
      f.shape = d.points.map(([x, y]) => [(x - c[0]) * sx, -(y - c[1]) * sy]); // design y pointed down
    }
    return f as Facility;
  });
}

async function writeJson(file: string, data: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(data, null, 1));
  await fs.rename(tmp, file);
}

export async function readProject(id: string): Promise<Project> {
  const dir = projectDir(id);
  const p = JSON.parse(await fs.readFile(path.join(dir, 'project.json'), 'utf8')) as Project;
  p.facilities = existsSync(path.join(dir, 'facilities.json'))
    ? await migrateFacilities(JSON.parse(await fs.readFile(path.join(dir, 'facilities.json'), 'utf8')))
    : [];
  for (const l of p.layers) {
    const f = path.join(dir, 'layers', `${l.id}.geojson`);
    if (isVectorKind(l.kind) || l.kind === 'bgt') {
      l.features = existsSync(f) ? JSON.parse(await fs.readFile(f, 'utf8')) : { type: 'FeatureCollection', features: [] };
    }
  }
  return p;
}

export async function writeProject(p: Project): Promise<Project> {
  const dir = projectDir(p.id);
  p.updated = new Date().toISOString();
  const keep = new Set<string>();
  for (const l of p.layers) {
    if (l.features) {
      keep.add(`${l.id}.geojson`);
      await writeJson(path.join(dir, 'layers', `${l.id}.geojson`), l.features);
    }
  }
  if (existsSync(path.join(dir, 'layers'))) {
    for (const f of await fs.readdir(path.join(dir, 'layers'))) if (!keep.has(f)) await fs.rm(path.join(dir, 'layers', f));
  }
  await writeJson(path.join(dir, 'facilities.json'), p.facilities);
  const { facilities, ...rest } = p;
  await writeJson(path.join(dir, 'project.json'), { ...rest, layers: p.layers.map(({ features, ...l }) => l) });
  return p;
}

export async function listProjects(): Promise<ProjectSummary[]> {
  await fs.mkdir(PROJECTS, { recursive: true });
  const lib = await readLibrary();
  const out: ProjectSummary[] = [];
  for (const id of await fs.readdir(PROJECTS)) {
    if (!existsSync(path.join(PROJECTS, id, 'project.json'))) continue;
    try {
      const p = await readProject(id);
      out.push({ id: p.id, name: p.name, notes: p.notes, updated: p.updated, layerKinds: p.layers.map((l) => l.kind), thumb: thumbnail(p, lib) });
    } catch {
      /* skip broken folders */
    }
  }
  return out.sort((a, b) => b.updated.localeCompare(a.updated));
}

/** Small normalised (0..1) sketch of the map for the overview cards. */
function thumbnail(p: Project, lib: Library): ProjectSummary['thumb'] {
  const lines: number[][][] = [];
  const polys: { pts: number[][]; color: string }[] = [];
  for (const l of p.layers) {
    if (!isVectorKind(l.kind) || !l.visible) continue;
    for (const f of layerLines(l)) lines.push(f.geometry.coordinates as number[][]);
    for (const f of effectivePolygons(l)) {
      const g = f.geometry;
      const rings = g.type === 'Polygon' ? [g.coordinates[0]] : g.coordinates.map((c) => c[0]);
      for (const r of rings) polys.push({ pts: r as number[][], color: l.style.color });
    }
  }
  const dots = p.facilities.map((f) => ({ lon: f.lon, lat: f.lat, color: lib.categories.find((c) => c.id === f.category)?.color ?? '#F5B84A' }));
  const all: number[][] = [...lines.flat(), ...polys.flatMap((r) => r.pts), ...dots.map((d) => [d.lon, d.lat])];
  if (!all.length) return { lines: [], polys: [], dots: [] };
  const xs = all.map((c) => c[0]), ys = all.map((c) => c[1]);
  const w = Math.min(...xs), e = Math.max(...xs), s = Math.min(...ys), n = Math.max(...ys);
  const kx = Math.cos((((s + n) / 2) * Math.PI) / 180);
  const span = Math.max((e - w) * kx, n - s) || 1;
  const norm = (c: number[]) => [0.5 + (((c[0] - (w + e) / 2) * kx) / span), 0.5 - ((c[1] - (s + n) / 2) / span)];
  const thin = (arr: number[][], max: number) => (arr.length <= max ? arr : arr.filter((_, i) => i % Math.ceil(arr.length / max) === 0 || i === arr.length - 1));
  return {
    lines: lines.slice(0, 400).map((l) => thin(l, 30).map(norm)),
    polys: polys.slice(0, 200).map((r) => ({ pts: thin(r.pts, 60).map(norm), color: r.color })),
    dots: dots.slice(0, 200).map((d) => { const [x, y] = norm([d.lon, d.lat]); return { x, y, color: d.color }; }),
  };
}

export async function readLibrary(): Promise<Library> {
  const cFile = path.join(LIBRARY, 'categories.json');
  let categories: Category[] = existsSync(cFile) ? JSON.parse(await fs.readFile(cFile, 'utf8')) : [];
  for (const c of DEFAULT_CATEGORIES) if (!categories.some((x) => x.id === c.id)) categories.push(c);
  categories = categories.sort((a, b) => (a.builtin === b.builtin ? 0 : a.builtin ? -1 : 1));
  return { categories };
}

export async function writeLibrary(lib: Library): Promise<void> {
  await writeJson(path.join(LIBRARY, 'categories.json'), lib.categories);
}

export { facilityPolygon };
