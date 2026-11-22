// floc editor: local server (API + Vite dev middleware). Run with `npm run dev`.
import express from 'express';
import multer from 'multer';
import os from 'node:os';
import path from 'node:path';
import { promises as fs, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer as createVite } from 'vite';
import type { Library, Project } from '../src/types';
import { makeLayer, newId } from '../src/types';
import { EDITOR, PROJECTS, listProjects, projectDir, readLibrary, readProject, uniqueId, writeLibrary, writeProject } from './store';
import { gdalAvailable } from './gdal';
import { addFileToProject, emptyProject, importGpkg, importMapFolder, listSources, parseVectorFile, sortLayers } from './importer';
import { applyCrop, georeference, removeImages, renderPdfPage, storeUpload } from './images';
import { exportPlan, exportTarget, folderExists, runExport } from './exporter';
import { fetchBgt, searchPlace } from './pdok';

const PORT = Number(process.env.PORT ?? 5180);
const app = express();
app.use(express.json({ limit: '200mb' }));
const upload = multer({ dest: path.join(os.tmpdir(), 'floc-uploads'), limits: { fileSize: 500 * 1024 * 1024 } });

type Handler = (req: express.Request, res: express.Response) => Promise<unknown>;
const h = (fn: Handler) => (req: express.Request, res: express.Response) => {
  fn(req, res)
    .then((out) => { if (!res.headersSent) res.json(out ?? { ok: true }); })
    .catch((e: Error) => { console.error(e); if (!res.headersSent) res.status(400).json({ error: e.message }); });
};
const pid = (req: express.Request) => String(req.params.id);

// ---- jobs (long-running export) ----
interface Job { id: string; status: 'running' | 'done' | 'error'; message: string; progress: number; result?: unknown }
const jobs = new Map<string, Job>();

// ---- status ----
app.get('/api/status', h(async () => ({ gdal: gdalAvailable })));

// ---- projects ----
app.get('/api/projects', h(async () => listProjects()));
app.post('/api/projects', h(async (req) => {
  const { name, center, zoom } = req.body as { name: string; center?: [number, number]; zoom?: number };
  const id = await uniqueId(name || 'kaart');
  const p = emptyProject(id, name || 'Nieuwe kaart');
  if (center) p.view = { center, zoom: zoom ?? 16 };
  p.layers = [makeLayer('beloopbaar'), makeLayer('pdok')];
  await fs.mkdir(projectDir(id), { recursive: true });
  sortLayers(p);
  return writeProject(p);
}));
app.get('/api/projects/:id', h(async (req) => readProject(pid(req))));
app.put('/api/projects/:id', h(async (req) => {
  const p = req.body as Project;
  if (p.id !== pid(req)) throw new Error('Id klopt niet');
  const saved = await writeProject(p);
  return { updated: saved.updated };
}));
app.patch('/api/projects/:id', h(async (req) => {
  const p = await readProject(pid(req));
  const { name, notes } = req.body as { name?: string; notes?: string };
  if (name != null) p.name = name;
  if (notes != null) p.notes = notes;
  return writeProject(p);
}));
app.post('/api/projects/:id/duplicate', h(async (req) => {
  const src = await readProject(pid(req));
  const name = `${src.name} (kopie)`;
  const id = await uniqueId(name);
  await fs.cp(projectDir(src.id), projectDir(id), { recursive: true });
  const p = await readProject(id);
  p.id = id; p.name = name; p.created = new Date().toISOString();
  return writeProject(p);
}));
app.delete('/api/projects/:id', h(async (req) => {
  await fs.rm(projectDir(pid(req)), { recursive: true, force: true });
}));
app.use('/api/projects/:id/files', (req, res, next) => {
  try {
    express.static(projectDir(String(req.params.id)), { maxAge: 0 })(req, res, next);
  } catch { res.status(404).end(); }
});

// ---- library ----
app.get('/api/library', h(async () => readLibrary()));
app.put('/api/library', h(async (req) => { await writeLibrary(req.body as Library); }));

// ---- import ----
app.get('/api/import/sources', h(async () => listSources()));
app.post('/api/import/source', h(async (req) => {
  const { source } = req.body as { source: string };
  const [type, name] = source.split(/:(.+)/);
  if (type === 'map') return importMapFolder(name);
  if (type === 'gpkg') return importGpkg(`qgis/${name}`);
  throw new Error('Onbekende bron');
}));
// New map from uploaded files
app.post('/api/import/files', upload.array('files'), h(async (req) => {
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
  return writeProject(p);
}));
// Parse a vector file for adding to an open map (the browser decides where it goes)
app.post('/api/parse', upload.single('file'), h(async (req) => {
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

// ---- image / PDF layers ----
app.post('/api/projects/:id/images/:layer/upload', upload.single('file'), h(async (req) => {
  const f = req.file;
  if (!f) throw new Error('Geen bestand');
  try {
    return await storeUpload(pid(req), String(req.params.layer), f.path, f.originalname);
  } finally {
    await fs.rm(f.path, { force: true });
  }
}));
app.post('/api/projects/:id/images/:layer/render', h(async (req) => {
  const { page, dpi } = req.body as { page: number; dpi: number };
  const size = await renderPdfPage(pid(req), String(req.params.layer), page, dpi);
  return { size };
}));
app.post('/api/projects/:id/images/:layer/crop', h(async (req) => applyCrop(pid(req), String(req.params.layer), req.body.crop ?? null)));
app.post('/api/projects/:id/images/:layer/georef', h(async (req) => {
  const bounds = await georeference(pid(req), String(req.params.layer), req.body.image);
  return { bounds, version: Date.now() };
}));
app.delete('/api/projects/:id/images/:layer', h(async (req) => { await removeImages(pid(req), String(req.params.layer)); }));

// ---- facility photos ----
const PHOTO_EXT = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
app.post('/api/projects/:id/photos/:fid', upload.single('file'), h(async (req) => {
  const f = req.file;
  if (!f) throw new Error('Geen bestand');
  try {
    const ext = path.extname(f.originalname).toLowerCase();
    if (!PHOTO_EXT.includes(ext)) throw new Error('Gebruik een JPG, PNG, WebP of GIF (een iPhone-foto in HEIC eerst exporteren als JPG)');
    const fid = String(req.params.fid);
    if (!/^[a-zA-Z0-9-]+$/.test(fid)) throw new Error('Ongeldige id');
    const dir = path.join(projectDir(pid(req)), 'photos');
    await fs.mkdir(dir, { recursive: true });
    for (const old of await fs.readdir(dir)) if (old.startsWith(fid + '-')) await fs.rm(path.join(dir, old), { force: true });
    const name = `${fid}-${Date.now()}${ext}`; // new name per photo, so the browser never shows a cached old one
    await fs.copyFile(f.path, path.join(dir, name));
    return { path: `photos/${name}` };
  } finally {
    await fs.rm(f.path, { force: true });
  }
}));

// ---- BGT + place search ----
app.post('/api/bgt', h(async (req) => fetchBgt(req.body.bbox)));
app.get('/api/search', h(async (req) => searchPlace(String(req.query.q ?? ''))));

// ---- export ----
app.get('/api/projects/:id/export', h(async (req) => {
  const p = await readProject(pid(req));
  return { target: exportTarget(p).rel, exists: await folderExists(p), items: exportPlan(p, await readLibrary()) };
}));
app.post('/api/projects/:id/export', h(async (req) => {
  const p = await readProject(pid(req));
  const lib = await readLibrary();
  const job: Job = { id: newId(), status: 'running', message: 'Starten', progress: 0 };
  jobs.set(job.id, job);
  runExport(p, lib, (message, progress) => Object.assign(job, { message, progress }))
    .then((files) => Object.assign(job, { status: 'done', progress: 1, result: files }))
    .catch((e: Error) => Object.assign(job, { status: 'error', message: e.message }));
  return { job: job.id };
}));
app.get('/api/jobs/:job', h(async (req) => {
  const j = jobs.get(String(req.params.job));
  if (!j) throw new Error('Onbekende taak');
  return j;
}));
app.post('/api/projects/:id/reveal', h(async (req) => {
  const p = await readProject(pid(req));
  const dir = exportTarget(p).dir;
  if (!existsSync(dir)) throw new Error('Nog niet geëxporteerd');
  spawn('open', [dir], { detached: true, stdio: 'ignore' }).unref();
}));

// ---- front-end ----
const vite = await createVite({ root: EDITOR, server: { middlewareMode: true }, appType: 'spa' });
app.use(vite.middlewares);

await fs.mkdir(PROJECTS, { recursive: true });
// Listen on both IPv6 and IPv4 loopback: browsers may resolve "localhost" to either.
app.listen(PORT, '::1').on('error', () => { /* no IPv6 loopback: fine */ });
app.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  floc editor draait op http://localhost:${PORT}\n`);
  if (!gdalAvailable) console.warn('  ⚠ QGIS/GDAL niet gevonden: georefereren, PDF en GeoPackage werken niet.\n');
});
