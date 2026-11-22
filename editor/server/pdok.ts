// Downloads PDOK aerial tiles into an MBTiles file, and fetches the BGT base map.
import { DatabaseSync } from 'node:sqlite';
import { promises as fs, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { REPO } from './store';

function tileX(lon: number, z: number) {
  return Math.floor(((lon + 180) / 360) * 2 ** z);
}
function tileY(lat: number, z: number) {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
}

export function countTiles(b: [number, number, number, number], minZ: number, maxZ: number): number {
  let n = 0;
  for (let z = minZ; z <= maxZ; z++) n += (tileX(b[2], z) - tileX(b[0], z) + 1) * (tileY(b[1], z) - tileY(b[3], z) + 1);
  return n;
}

export async function writeAerialMbtiles(
  out: string,
  layer: string,
  b: [number, number, number, number],
  minZ: number,
  maxZ: number,
  progress: (done: number, total: number) => void,
) {
  if (existsSync(out)) await fs.rm(out);
  await fs.mkdir(path.dirname(out), { recursive: true });
  const db = new DatabaseSync(out);
  db.exec('CREATE TABLE metadata (name text, value text); CREATE TABLE tiles (zoom_level integer, tile_column integer, tile_row integer, tile_data blob); CREATE UNIQUE INDEX tile_index on tiles (zoom_level, tile_column, tile_row);');
  const meta = db.prepare('INSERT INTO metadata VALUES (?, ?)');
  for (const [k, v] of Object.entries({ name: `PDOK ${layer}`, format: 'jpg', type: 'baselayer', version: '1.1', minzoom: String(minZ), maxzoom: String(maxZ), bounds: b.join(','), attribution: 'PDOK Luchtfoto' })) meta.run(k, v);
  const ins = db.prepare('INSERT OR REPLACE INTO tiles VALUES (?, ?, ?, ?)');
  const jobs: [number, number, number][] = [];
  for (let z = minZ; z <= maxZ; z++)
    for (let x = tileX(b[0], z); x <= tileX(b[2], z); x++)
      for (let y = tileY(b[3], z); y <= tileY(b[1], z); y++) jobs.push([z, x, y]);
  let done = 0;
  let failed = 0;
  const worker = async () => {
    while (jobs.length) {
      const [z, x, y] = jobs.shift()!;
      const url = `https://service.pdok.nl/hwh/luchtfotorgb/wmts/v1_0/${layer}/EPSG:3857/${z}/${x}/${y}.jpeg`;
      let ok = false;
      for (let attempt = 0; attempt < 3 && !ok; attempt++) {
        try {
          const r = await fetch(url);
          if (r.ok) {
            ins.run(z, x, 2 ** z - 1 - y, new Uint8Array(await r.arrayBuffer()));
            ok = true;
          } else if (r.status === 404) ok = true;
        } catch { /* retry */ }
      }
      if (!ok) failed++;
      progress(++done, done + jobs.length);
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  db.close();
  if (failed > 10) throw new Error(`${failed} luchtfototegels konden niet worden opgehaald`);
}

/** Runs tools/fetch_bgt.py for a bbox and returns the base map FeatureCollection. */
export async function fetchBgt(b: [number, number, number, number]): Promise<any> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'floc-bgt-'));
  const script = path.join(REPO, 'tools', 'fetch_bgt.py');
  if (!existsSync(script)) throw new Error('tools/fetch_bgt.py niet gevonden');
  await new Promise<void>((resolve, reject) => {
    execFile('python3', [script, tmp, b.map((v) => v.toFixed(6)).join(',')], { timeout: 5 * 60_000 }, (err, _o, stderr) =>
      err ? reject(new Error(`BGT ophalen mislukt: ${stderr || err.message}`)) : resolve(),
    );
  });
  const fc = JSON.parse(await fs.readFile(path.join(tmp, 'base.geojson'), 'utf8'));
  await fs.rm(tmp, { recursive: true, force: true });
  return fc;
}

/** PDOK Locatieserver search for the "new map" dialog. */
export async function searchPlace(q: string) {
  const url = `https://api.pdok.nl/bzk/locatieserver/search/v3_1/free?q=${encodeURIComponent(q)}&rows=6&fl=weergavenaam,centroide_ll,type`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('Zoeken mislukt');
  const j: any = await r.json();
  return (j.response?.docs ?? []).map((d: any) => {
    const m = /POINT\(([-\d.]+) ([-\d.]+)\)/.exec(d.centroide_ll ?? '');
    return { name: d.weergavenaam, type: d.type, lon: m ? Number(m[1]) : 0, lat: m ? Number(m[2]) : 0 };
  });
}
