// Projects and the library in Postgres; project files (images, photos) in the bucket.
// GDAL needs real files, so those are worked on in a local cache folder and synced with the bucket.
import { promises as fs, existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Facility, Library, Project, ProjectSummary, Category } from '../src/types';
import { DEFAULT_CATEGORIES, isVectorKind } from '../src/types';
import { effectivePolygons, facilityPolygon, layerLines, polygonCentroid } from '../src/geo';
import { one, q, tx, internalOrgId } from './db';
import * as blob from './blob';

export const EDITOR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO = path.resolve(EDITOR, '..');
export const LIBRARY = path.join(EDITOR, 'library');
/** Local working copies of project files. On the Mac inside the repo (ignored by git), on the server in /tmp. */
export const CACHE = process.env.FLOC_LOCAL ? path.join(EDITOR, '.cache') : path.join(os.tmpdir(), 'floc-cache');
export const PROJECTS = path.join(CACHE, 'projects');
/** Export target. On the Mac the repo's maps/ folder (so Xcode builds keep working), on the server a temp folder. */
export const MAPS = process.env.FLOC_LOCAL ? path.join(REPO, 'maps') : path.join(CACHE, 'maps');

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function projectDir(id: string): string {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) throw new Error('Ongeldige kaart-id');
  return path.join(PROJECTS, id);
}

// ---------- project files: bucket <-> cache ----------

export const fileKey = (pid: string, rel: string) => `projects/${pid}/${rel}`;

/** Downloads the files under projects/<pid>/<rel> that aren't in the cache yet. */
export async function pullDir(pid: string, rel: string): Promise<void> {
  const prefix = fileKey(pid, rel.replace(/\/?$/, '/'));
  for (const o of await blob.list(prefix)) {
    const local = path.join(projectDir(pid), o.key.slice(`projects/${pid}/`.length));
    const st = await fs.stat(local).catch(() => null);
    if (!st || st.size !== o.size) await blob.getFile(o.key, local);
  }
}

/** Uploads every file under <cache>/<pid>/<rel> changed since `since` (ms). */
export async function pushDir(pid: string, rel: string, since = 0): Promise<void> {
  const root = path.join(projectDir(pid), rel);
  if (!existsSync(root)) return;
  const walk = async (dir: string): Promise<string[]> => {
    const out: string[] = [];
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...(await walk(f)));
      else if (!e.name.endsWith('.part')) out.push(f);
    }
    return out;
  };
  for (const f of await walk(root)) {
    if ((await fs.stat(f)).mtimeMs < since) continue;
    await blob.putFile(fileKey(pid, path.relative(projectDir(pid), f).split(path.sep).join('/')), f);
  }
}

/** Runs a GDAL step on a layer's image folder: fetch what's missing, run, upload what changed. */
export async function withImageFiles<T>(pid: string, layerId: string, fn: () => Promise<T>): Promise<T> {
  await pullDir(pid, `images/${layerId}`);
  const start = Date.now() - 1000;
  const out = await fn();
  await pushDir(pid, `images/${layerId}`, start);
  return out;
}

// ---------- ids ----------

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
  while (await one('SELECT 1 FROM projects WHERE id = $1', [id])) id = `${slugify(base)}-${n++}`;
  return id;
}

// ---------- projects ----------

/** Facilities linked to a library design (before the library was dropped) get that outline as their own. */
function migrateFacilities(list: any[]): Facility[] {
  if (!list.some((f) => 'designId' in f || 'overrides' in f)) return list;
  const dFile = path.join(LIBRARY, 'designs.json');
  const designs: { id: string; points: [number, number][] }[] = existsSync(dFile) ? JSON.parse(readFileSync(dFile, 'utf8')) : [];
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

export async function projectExists(id: string): Promise<boolean> {
  return !!(await one('SELECT 1 FROM projects WHERE id = $1', [id]));
}

export async function readProject(id: string): Promise<Project> {
  const row = await one<{ meta: any; facilities: any[]; revision: number; org_id: string | null; org_name: string | null; created: Date; updated: Date }>(
    `SELECT p.meta, p.facilities, p.revision, p.org_id, o.name AS org_name, p.created, p.updated
       FROM projects p LEFT JOIN organizations o ON o.id = p.org_id WHERE p.id = $1`, [id]);
  if (!row) throw new HttpError(404, 'Kaart niet gevonden');
  const layers = await q<{ layer_id: string; features: any }>('SELECT layer_id, features FROM project_layers WHERE project_id = $1', [id]);
  const byId = new Map(layers.map((l) => [l.layer_id, l.features]));
  const p = row.meta as Project;
  p.id = id;
  p.created = row.created.toISOString();
  p.updated = row.updated.toISOString();
  p.revision = row.revision;
  p.org = row.org_id ? { id: row.org_id, name: row.org_name ?? '' } : undefined;
  p.facilities = migrateFacilities(row.facilities ?? []);
  for (const l of p.layers) {
    if (isVectorKind(l.kind) || l.kind === 'bgt') l.features = byId.get(l.id) ?? { type: 'FeatureCollection', features: [] };
  }
  return p;
}

/**
 * Saves a project. With `expectedRevision`, refuses (409) when someone else saved in between,
 * so nobody overwrites another person's work without noticing.
 */
export async function writeProject(p: Project, opts: { expectedRevision?: number; orgId?: string } = {}): Promise<Project> {
  const lib = await readLibrary();
  const thumb = thumbnail(p, lib);
  const { facilities, layers, revision, access, org, ...rest } = p;
  const meta = { ...rest, layers: layers.map(({ features, ...l }) => l) };
  const hashes = new Map<string, { json: string; hash: string }>();
  for (const l of layers) {
    if (!l.features) continue;
    const json = JSON.stringify(l.features);
    hashes.set(l.id, { json, hash: createHash('sha1').update(json).digest('hex') });
  }
  const saved = await tx(async (c) => {
    const cur = (await c.query('SELECT revision FROM projects WHERE id = $1 FOR UPDATE', [p.id])).rows[0];
    if (cur && opts.expectedRevision != null && cur.revision !== opts.expectedRevision) {
      throw new HttpError(409, 'Deze kaart is intussen ergens anders gewijzigd. Herlaad de pagina; je laatste wijziging is niet opgeslagen.');
    }
    let row;
    if (cur) {
      row = (await c.query(
        `UPDATE projects SET name = $2, meta = $3, facilities = $4, thumb = $5, revision = revision + 1, updated = now() WHERE id = $1 RETURNING revision, updated`,
        [p.id, p.name, meta, JSON.stringify(facilities ?? []), thumb])).rows[0];
    } else {
      const orgId = opts.orgId ?? (await internalOrgId());
      row = (await c.query(
        `INSERT INTO projects (id, org_id, name, meta, facilities, thumb) VALUES ($1, $2, $3, $4, $5, $6) RETURNING revision, updated`,
        [p.id, orgId, p.name, meta, JSON.stringify(facilities ?? []), thumb])).rows[0];
    }
    const old = new Map((await c.query('SELECT layer_id, hash FROM project_layers WHERE project_id = $1', [p.id])).rows.map((r) => [r.layer_id, r.hash]));
    for (const [lid, h] of hashes) {
      if (old.get(lid) === h.hash) continue;
      await c.query(
        `INSERT INTO project_layers (project_id, layer_id, features, hash) VALUES ($1, $2, $3, $4)
         ON CONFLICT (project_id, layer_id) DO UPDATE SET features = EXCLUDED.features, hash = EXCLUDED.hash`,
        [p.id, lid, h.json, h.hash]);
    }
    const gone = [...old.keys()].filter((k) => !hashes.has(k));
    if (gone.length) await c.query('DELETE FROM project_layers WHERE project_id = $1 AND layer_id = ANY($2)', [p.id, gone]);
    return row;
  });
  p.revision = saved.revision;
  p.updated = new Date(saved.updated).toISOString();
  return p;
}

export async function deleteProject(id: string): Promise<void> {
  await q('DELETE FROM projects WHERE id = $1', [id]);
  await blob.removePrefix(`projects/${id}/`);
  await blob.removePrefix(`releases/${id}/`);
  await fs.rm(projectDir(id), { recursive: true, force: true });
}

/** Projects the user may see. Staff see all; organisers only their organisations' maps. */
export async function listProjects(user: { id: string; is_staff: boolean }): Promise<ProjectSummary[]> {
  const rows = await q(
    `SELECT p.id, p.name, p.meta->>'notes' AS notes, p.updated, p.meta->'layers' AS layers, p.thumb, o.name AS org_name,
            (SELECT max(version) FROM releases r WHERE r.project_id = p.id) AS version
       FROM projects p LEFT JOIN organizations o ON o.id = p.org_id
      WHERE $1::boolean OR p.org_id IN (SELECT org_id FROM memberships WHERE user_id = $2)
      ORDER BY p.updated DESC`, [user.is_staff, user.id]);
  return rows.map((r) => ({
    id: r.id, name: r.name, notes: r.notes ?? '', updated: new Date(r.updated).toISOString(),
    layerKinds: (r.layers ?? []).map((l: any) => l.kind), thumb: r.thumb ?? { lines: [], polys: [], dots: [] },
    org: r.org_name ?? undefined, version: r.version ?? undefined,
  }));
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

// ---------- library ----------

export async function readLibrary(): Promise<Library> {
  const row = await one<{ value: Category[] }>("SELECT value FROM settings WHERE key = 'categories'");
  let categories: Category[] = row?.value ?? [];
  for (const c of DEFAULT_CATEGORIES) if (!categories.some((x) => x.id === c.id)) categories.push(c);
  categories = categories.sort((a, b) => (a.builtin === b.builtin ? 0 : a.builtin ? -1 : 1));
  return { categories };
}

export async function writeLibrary(lib: Library): Promise<void> {
  await q(`INSERT INTO settings (key, value) VALUES ('categories', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(lib.categories)]);
}

export { facilityPolygon };
