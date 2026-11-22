// Publishing: export a map, upload it as an immutable versioned package, and serve packages to the app.
import express from 'express';
import { createHash } from 'node:crypto';
import { createReadStream, promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import type { Library, Project } from '../src/types';
import { one, q } from './db';
import * as blob from './blob';
import { HttpError, pullDir } from './store';
import { MANAGED_FILES, aerialKey, exportTarget, runExport } from './exporter';
import { requireUser } from './auth';

export interface ReleaseFile { path: string; size: number; sha256: string }
export interface Manifest {
  version: number;
  name: string;
  notes: string;
  published: string;
  aerialKey: string | null;
  size: number;
  files: ReleaseFile[];
}

const releaseKey = (pid: string, v: number, rel: string) => `releases/${pid}/${v}/${rel}`;

async function sha256(file: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(file)) h.update(chunk);
  return h.digest('hex');
}

async function walk(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(f, base)));
    else out.push(path.relative(base, f).split(path.sep).join('/'));
  }
  return out;
}

export async function latestRelease(pid: string): Promise<Manifest | null> {
  const r = await one<{ manifest: Manifest }>('SELECT manifest FROM releases WHERE project_id = $1 ORDER BY version DESC LIMIT 1', [pid]);
  return r?.manifest ?? null;
}

/** Exports the current draft and publishes it as the next version. */
export async function publish(p: Project, lib: Library, userId: string, progress: (msg: string, frac: number) => void): Promise<Manifest> {
  progress('Bestanden ophalen', 0.01);
  await pullDir(p.id, 'photos');
  const img = p.layers.find((l) => !l.noExport && l.kind === 'image' && l.visible && l.image?.warped);
  if (img) await pullDir(p.id, `images/${img.id}`);

  const prev = await latestRelease(p.id);
  const key = aerialKey(p);
  const prevAerial = prev?.files.find((f) => f.path === 'aerial.mbtiles');
  const reuseAerial = !!(key && prev && prev.aerialKey === key && prevAerial);

  // Export takes 0–70 %, upload the rest.
  await runExport(p, lib, (m, f) => progress(m, f * 0.7), { skipAerial: reuseAerial });
  const dir = exportTarget(p).dir;
  const rels: string[] = [];
  for (const name of MANAGED_FILES) {
    const f = path.join(dir, name);
    if (!existsSync(f) || (reuseAerial && name === 'aerial.mbtiles')) continue;
    if ((await fs.stat(f)).isDirectory()) rels.push(...(await walk(f)).map((r) => `${name}/${r}`));
    else rels.push(name);
  }

  const version = ((await one<{ v: number }>('SELECT coalesce(max(version), 0) AS v FROM releases WHERE project_id = $1', [p.id]))!.v) + 1;
  const files: ReleaseFile[] = [];
  for (const [i, rel] of rels.entries()) {
    progress(`Uploaden: ${rel}`, 0.7 + 0.3 * (i / rels.length));
    const f = path.join(dir, rel);
    const size = await blob.putFile(releaseKey(p.id, version, rel), f);
    files.push({ path: rel, size, sha256: await sha256(f) });
  }
  if (reuseAerial) {
    progress('Luchtfoto ongewijzigd: vorige versie hergebruiken', 0.98);
    await blob.copy(releaseKey(p.id, prev!.version, 'aerial.mbtiles'), releaseKey(p.id, version, 'aerial.mbtiles'));
    files.push(prevAerial!);
  }
  const manifest: Manifest = {
    version, name: p.name, notes: p.notes ?? '', published: new Date().toISOString(), aerialKey: key,
    size: files.reduce((s, f) => s + f.size, 0), files,
  };
  await q('INSERT INTO releases (project_id, version, published_by, manifest) VALUES ($1, $2, $3, $4)', [p.id, version, userId, manifest]);
  progress(`Versie ${version} gepubliceerd`, 1);
  return manifest;
}

type H = (req: express.Request, res: express.Response) => Promise<unknown>;

/** What the iOS app uses: the list of published events and their download packages. */
export function appRoutes(h: (fn: H) => express.RequestHandler): express.Router {
  const r = express.Router();

  r.get('/events', h(async (req) => {
    requireUser(req);
    const rows = await q(
      `SELECT DISTINCT ON (r.project_id) r.project_id AS id, r.version, r.published, r.manifest, o.name AS org
         FROM releases r JOIN projects p ON p.id = r.project_id LEFT JOIN organizations o ON o.id = p.org_id
        ORDER BY r.project_id, r.version DESC`);
    return rows
      .map((x) => ({ id: x.id, name: x.manifest.name, notes: x.manifest.notes, organizer: x.org, version: x.version, published: x.published, size: x.manifest.size }))
      .sort((a, b) => a.name.localeCompare(b.name, 'nl'));
  }));

  r.get('/events/:id/release', h(async (req) => {
    requireUser(req);
    const pid = String(req.params.id);
    const m = await latestRelease(pid);
    if (!m) throw new HttpError(404, 'Dit evenement is (nog) niet gepubliceerd');
    const files = await Promise.all(m.files.map(async (f) => ({ ...f, url: await blob.signedUrl(releaseKey(pid, m.version, f.path), 6 * 3600) })));
    return { id: pid, ...m, files };
  }));

  return r;
}
