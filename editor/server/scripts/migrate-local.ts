// One-off: moves the maps from editor/projects/ (the old on-disk format) and library/categories.json
// into Postgres + the bucket. Skips maps that already exist online. Usage: npm run migrate-local
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import type { Project } from '../../src/types';
import { isVectorKind } from '../../src/types';
import { migrate, pool } from '../db';
import * as blob from '../blob';
import { EDITOR, LIBRARY, projectExists, writeLibrary, writeProject } from '../store';
import { DEFAULT_CATEGORIES } from '../../src/types';

const OLD = path.join(EDITOR, 'projects');
await migrate();

const cFile = path.join(LIBRARY, 'categories.json');
if (existsSync(cFile)) {
  await writeLibrary({ categories: JSON.parse(await fs.readFile(cFile, 'utf8')) });
  console.log('Categorieën overgezet');
} else await writeLibrary({ categories: DEFAULT_CATEGORIES });

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(f)));
    else out.push(f);
  }
  return out;
}

for (const id of existsSync(OLD) ? await fs.readdir(OLD) : []) {
  const dir = path.join(OLD, id);
  if (!existsSync(path.join(dir, 'project.json'))) continue;
  if (await projectExists(id)) { console.log(`${id}: staat al online, overgeslagen`); continue; }
  const p = JSON.parse(await fs.readFile(path.join(dir, 'project.json'), 'utf8')) as Project;
  p.facilities = existsSync(path.join(dir, 'facilities.json')) ? JSON.parse(await fs.readFile(path.join(dir, 'facilities.json'), 'utf8')) : [];
  for (const l of p.layers) {
    const f = path.join(dir, 'layers', `${l.id}.geojson`);
    if ((isVectorKind(l.kind) || l.kind === 'bgt') && existsSync(f)) l.features = JSON.parse(await fs.readFile(f, 'utf8'));
  }
  await writeProject(p);
  let n = 0, bytes = 0;
  for (const sub of ['images', 'photos']) {
    if (!existsSync(path.join(dir, sub))) continue;
    for (const f of await walk(path.join(dir, sub))) {
      const rel = path.relative(dir, f).split(path.sep).join('/');
      bytes += await blob.putFile(`projects/${id}/${rel}`, f);
      n++;
    }
  }
  console.log(`${id}: overgezet (${n} bestanden, ${(bytes / 1e6).toFixed(0)} MB)`);
}
await pool.end();
