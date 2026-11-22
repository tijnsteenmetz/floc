// floc server: API (/api/v1), studio (/studio, the map editor) and the website (/).
// Local on the Mac: `npm run dev` (same database and bucket as Railway, plus GDAL from QGIS).
// On Railway: `npm start` after `npm run build`.
import express from 'express';
import multer from 'multer';
import os from 'node:os';
import path from 'node:path';
import { promises as fs, existsSync } from 'node:fs';
import type { Library, Project } from '../src/types';
import { makeLayer, newId } from '../src/types';
import { migrate, one } from './db';
import * as blob from './blob';
import {
  EDITOR, REPO, HttpError, deleteProject, fileKey, listProjects, projectDir, pullDir, pushDir, readLibrary, readProject,
  uniqueId, withImageFiles, writeLibrary, writeProject,
} from './store';
import { gdalAvailable } from './gdal';
import { addFileToProject, emptyProject, importGpkg, importMapFolder, listSources, parseVectorFile, sortLayers } from './importer';
import { applyCrop, georeference, removeImages, renderPdfPage, storeUpload } from './images';
import { exportPlan } from './exporter';
import { fetchBgt, searchPlace } from './pdok';
import { authRoutes, loadUser, projectAccess, requireStaff, requireUser } from './auth';
import { appRoutes, latestRelease, publish } from './releases';

const PROD = process.env.NODE_ENV === 'production' && !process.env.FLOC_LOCAL;
const PORT = Number(process.env.PORT ?? 5180);
const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '200mb' }));
const upload = multer({ dest: path.join(os.tmpdir(), 'floc-uploads'), limits: { fileSize: 500 * 1024 * 1024 } });

type Handler = (req: express.Request, res: express.Response) => Promise<unknown>;
/** Returned by handlers that write the response themselves (files, streams). */
const STREAMED = Symbol('streamed');
const h = (fn: Handler) => (req: express.Request, res: express.Response) => {
  fn(req, res)
    .then((out) => { if (out !== STREAMED && !res.headersSent) res.json(out ?? { ok: true }); })
    .catch((e: Error) => {
      const status = e instanceof HttpError ? e.status : 400;
      if (!(e instanceof HttpError)) console.error(e);
      if (!res.headersSent) res.status(status).json({ error: e.message });
    });
};
const pid = (req: express.Request) => String(req.params.id);
/** Staff only, and the map must exist. */
const staffProject = async (req: express.Request) => { requireStaff(req); await readProject(pid(req)); return pid(req); };

// ---- jobs (long-running publish) ----
interface Job { id: string; status: 'running' | 'done' | 'error'; message: string; progress: number; result?: unknown }
const jobs = new Map<string, Job>();

const api = express.Router();
api.use(loadUser);
api.use(authRoutes(h));
api.use(appRoutes(h));

// ---- status ----
api.get('/status', h(async () => ({ gdal: gdalAvailable, local: !!process.env.FLOC_LOCAL })));
api.get('/health', h(async () => { await one('SELECT 1'); return { ok: true }; }));

// ---- projects ----
api.get('/projects', h(async (req) => listProjects(requireUser(req))));
api.post('/projects', h(async (req) => {
  requireStaff(req);
  const { name, center, zoom } = req.body as { name: string; center?: [number, number]; zoom?: number };
  const id = await uniqueId(name || 'kaart');
  const p = emptyProject(id, name || 'Nieuwe kaart');
  if (center) p.view = { center, zoom: zoom ?? 16 };
  p.layers = [makeLayer('beloopbaar'), makeLayer('pdok')];
  sortLayers(p);
  return writeProject(p);
}));
api.get('/projects/:id', h(async (req) => {
  const access = await projectAccess(req, pid(req));
  const p = await readProject(pid(req));
  p.access = access;
  return p;
}));
api.put('/projects/:id', h(async (req) => {
  await staffProject(req);
  const p = req.body as Project;
  if (p.id !== pid(req)) throw new Error('Id klopt niet');
  const rev = req.headers['x-revision'];
  const saved = await writeProject(p, { expectedRevision: rev ? Number(rev) : undefined });
  return { updated: saved.updated, revision: saved.revision };
}));
api.patch('/projects/:id', h(async (req) => {
  await staffProject(req);
  const p = await readProject(pid(req));
  const { name, notes } = req.body as { name?: string; notes?: string };
  if (name != null) p.name = name;
  if (notes != null) p.notes = notes;
  return writeProject(p);
}));
api.post('/projects/:id/duplicate', h(async (req) => {
  await staffProject(req);
  const src = await readProject(pid(req));
  const name = `${src.name} (kopie)`;
  const id = await uniqueId(name);
  await blob.copyPrefix(`projects/${src.id}/`, `projects/${id}/`);
  const p: Project = { ...src, id, name, created: new Date().toISOString(), revision: undefined };
  return writeProject(p, { orgId: src.org?.id });
}));
api.delete('/projects/:id', h(async (req) => { await staffProject(req); await deleteProject(pid(req)); }));

// Project files (images, photos): from the local cache when present (Mac), else straight from the bucket.
api.get('/projects/:id/files/*rel', h(async (req, res) => {
  await projectAccess(req, pid(req));
  const rel = ([] as string[]).concat((req.params as any).rel).join('/');
  if (rel.split('/').includes('..')) throw new HttpError(400, 'Ongeldig pad');
  const local = path.join(projectDir(pid(req)), rel);
  res.setHeader('Cache-Control', 'private, max-age=0');
  if (process.env.FLOC_LOCAL && existsSync(local)) { res.sendFile(local); return STREAMED; }
  const obj = await blob.getStream(fileKey(pid(req), rel));
  if (!obj) throw new HttpError(404, 'Bestand niet gevonden');
  res.setHeader('Content-Type', obj.type);
  if (obj.size != null) res.setHeader('Content-Length', String(obj.size));
  obj.body.pipe(res);
  return STREAMED;
}));

// ---- library ----
api.get('/library', h(async (req) => { requireUser(req); return readLibrary(); }));
api.put('/library', h(async (req) => { requireStaff(req); await writeLibrary(req.body as Library); }));

// ---- import ----
api.get('/import/sources', h(async (req) => { requireStaff(req); return process.env.FLOC_LOCAL ? listSources() : []; }));
api.post('/import/source', h(async (req) => {
  requireStaff(req);
  const { source } = req.body as { source: string };
  const [type, name] = source.split(/:(.+)/);
  const p = type === 'map' ? await importMapFolder(name) : type === 'gpkg' ? await importGpkg(`qgis/${name}`) : null;
  if (!p) throw new Error('Onbekende bron');
  await pushDir(p.id, '');
  return p;
}));
// New map from uploaded files
api.post('/import/files', upload.array('files'), h(async (req) => {
  requireStaff(req);
  const files = (req.files as Express.Multer.File[]) ?? [];
  if (!files.length) throw new Error('Geen bestanden');
  const name = (req.body?.name as string) || files[0].originalname.replace(/\.[^.]+$/, '');
  const id = await uniqueId(name);
  const p = emptyProject(id, name);
  await fs.mkdir(projectDir(id), { recursive: true });
  try {
    for (const f of files) {
      const named = f.path + path.extname(f.originalname);
      await fs.rename(f.path, named);
      await addFileToProject(p, named);
    }
  } catch (e) {
    await fs.rm(projectDir(id), { recursive: true, force: true });
    throw e;
  }
  sortLayers(p);
  const saved = await writeProject(p);
  await pushDir(id, '');
  return saved;
}));
// Parse a vector file for adding to an open map (the browser decides where it goes)
api.post('/parse', upload.single('file'), h(async (req) => {
  requireStaff(req);
  const f = req.file;
  if (!f) throw new Error('Geen bestand');
  const named = f.path + path.extname(f.originalname);
  await fs.rename(f.path, named);
  try {
    return await parseVectorFile(named, f.originalname);
  } finally {
    await fs.rm(named, { force: true });
  }
}));

// ---- image / PDF layers (GDAL: only in the studio on the Mac) ----
const layerId = (req: express.Request) => String(req.params.layer);
api.post('/projects/:id/images/:layer/upload', upload.single('file'), h(async (req) => {
  await staffProject(req);
  const f = req.file;
  if (!f) throw new Error('Geen bestand');
  try {
    return await withImageFiles(pid(req), layerId(req), () => storeUpload(pid(req), layerId(req), f.path, f.originalname));
  } finally {
    await fs.rm(f.path, { force: true });
  }
}));
api.post('/projects/:id/images/:layer/render', h(async (req) => {
  await staffProject(req);
  const { page, dpi } = req.body as { page: number; dpi: number };
  const size = await withImageFiles(pid(req), layerId(req), () => renderPdfPage(pid(req), layerId(req), page, dpi));
  return { size };
}));
api.post('/projects/:id/images/:layer/crop', h(async (req) => {
  await staffProject(req);
  return withImageFiles(pid(req), layerId(req), () => applyCrop(pid(req), layerId(req), req.body.crop ?? null));
}));
api.post('/projects/:id/images/:layer/georef', h(async (req) => {
  await staffProject(req);
  const bounds = await withImageFiles(pid(req), layerId(req), () => georeference(pid(req), layerId(req), req.body.image));
  return { bounds, version: Date.now() };
}));
api.delete('/projects/:id/images/:layer', h(async (req) => {
  await staffProject(req);
  await removeImages(pid(req), layerId(req));
  await blob.removePrefix(fileKey(pid(req), `images/${layerId(req)}/`));
}));

// ---- facility photos ----
const PHOTO_EXT = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
api.post('/projects/:id/photos/:fid', upload.single('file'), h(async (req) => {
  await staffProject(req);
  const f = req.file;
  if (!f) throw new Error('Geen bestand');
  try {
    const ext = path.extname(f.originalname).toLowerCase();
    if (!PHOTO_EXT.includes(ext)) throw new Error('Gebruik een JPG, PNG, WebP of GIF (een iPhone-foto in HEIC eerst exporteren als JPG)');
    const fid = String(req.params.fid);
    if (!/^[a-zA-Z0-9-]+$/.test(fid)) throw new Error('Ongeldige id');
    for (const old of await blob.list(fileKey(pid(req), `photos/${fid}-`))) await blob.remove(old.key);
    const name = `${fid}-${Date.now()}${ext}`; // new name per photo, so the browser never shows a cached old one
    const dir = path.join(projectDir(pid(req)), 'photos');
    await fs.mkdir(dir, { recursive: true });
    await fs.copyFile(f.path, path.join(dir, name));
    await blob.putFile(fileKey(pid(req), `photos/${name}`), path.join(dir, name));
    return { path: `photos/${name}` };
  } finally {
    await fs.rm(f.path, { force: true });
  }
}));

// ---- BGT + place search ----
api.post('/bgt', h(async (req) => { requireStaff(req); return fetchBgt(req.body.bbox); }));
api.get('/search', h(async (req) => { requireUser(req); return searchPlace(String(req.query.q ?? '')); }));

// ---- publish ----
api.get('/projects/:id/publish', h(async (req) => {
  await staffProject(req);
  const p = await readProject(pid(req));
  const last = await latestRelease(p.id);
  const needsGdal = p.layers.some((l) => !l.noExport && l.kind === 'image' && l.visible && l.image?.warped);
  return {
    items: exportPlan(p, await readLibrary()),
    last: last ? { version: last.version, published: last.published, size: last.size } : null,
    blocked: needsGdal && !gdalAvailable ? 'Deze kaart heeft een plattegrond-laag die naar MBTiles moet. Dat kan alleen in de studio op de Mac (GDAL). Publiceer daar, of zet de plattegrond-laag op "Niet exporteren".' : null,
  };
}));
api.post('/projects/:id/publish', h(async (req) => {
  await staffProject(req);
  const user = requireUser(req);
  const p = await readProject(pid(req));
  const lib = await readLibrary();
  const job: Job = { id: newId(), status: 'running', message: 'Starten', progress: 0 };
  jobs.set(job.id, job);
  publish(p, lib, user.id, (message, progress) => Object.assign(job, { message, progress }))
    .then((m) => Object.assign(job, { status: 'done', progress: 1, result: { version: m.version, size: m.size, files: m.files.length } }))
    .catch((e: Error) => { console.error(e); Object.assign(job, { status: 'error', message: e.message }); });
  return { job: job.id };
}));
api.get('/jobs/:job', h(async (req) => {
  requireStaff(req);
  const j = jobs.get(String(req.params.job));
  if (!j) throw new Error('Onbekende taak');
  return j;
}));

app.use('/api/v1', api);
app.use('/api', (_req, res) => { res.status(404).json({ error: 'Onbekend adres' }); });

// ---- website (/) ----
app.use(express.static(path.join(REPO, 'website'), { extensions: ['html'] }));

// ---- studio (/studio) ----
app.use((req, res, next) => (req.path === '/studio' ? res.redirect('/studio/') : next()));
if (PROD) {
  const dist = path.join(EDITOR, 'dist');
  if (existsSync(path.join(dist, 'index.html'))) {
    app.use('/studio', express.static(dist, { index: false, maxAge: '1h' }));
    app.get('/studio{/*splat}', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  } else {
    app.get('/studio{/*splat}', (_req, res) => res.status(503).type('html').send(
      '<!doctype html><meta charset="utf-8"><title>floc studio</title><body style="background:#0C0D0E;color:#F2F3F4;font:16px system-ui;padding:48px">' +
      '<h1>floc studio is tijdelijk niet beschikbaar</h1><p>De studio kon bij deze versie niet gebouwd worden (zie de build-log op Railway). De app en de website werken gewoon.</p></body>'));
  }
} else {
  const { createServer } = await import('vite');
  const vite = await createServer({ root: EDITOR, server: { middlewareMode: true }, appType: 'spa' });
  app.use(vite.middlewares);
}

await migrate();
if (PROD) {
  app.listen(PORT, '0.0.0.0', () => console.log(`floc server op poort ${PORT}`));
} else {
  // Listen on both IPv6 and IPv4 loopback: browsers may resolve "localhost" to either.
  app.listen(PORT, '::1').on('error', () => { /* no IPv6 loopback: fine */ });
  app.listen(PORT, '127.0.0.1', () => {
    console.log(`\n  floc studio draait op http://localhost:${PORT}/studio/  (website: http://localhost:${PORT}/)\n`);
    if (!gdalAvailable) console.warn('  ⚠ QGIS/GDAL niet gevonden: georefereren, PDF en GeoPackage werken niet.\n');
  });
}
