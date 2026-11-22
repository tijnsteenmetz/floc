// Runs the GDAL tools that ship with the installed QGIS.
import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

function findQgis(): string | null {
  if (process.env.QGIS_APP && existsSync(process.env.QGIS_APP)) return process.env.QGIS_APP;
  try {
    const apps = readdirSync('/Applications').filter((n) => /^QGIS.*\.app$/.test(n)).sort().reverse();
    return apps.length ? path.join('/Applications', apps[0]) : null;
  } catch {
    return null;
  }
}

const QGIS = findQgis();
const BIN = QGIS ? path.join(QGIS, 'Contents/MacOS') : '';
const RES = QGIS ? path.join(QGIS, 'Contents/Resources/qgis') : '';

export const gdalAvailable = !!QGIS && existsSync(path.join(BIN, 'gdal_translate'));

const env = {
  ...process.env,
  GDAL_DATA: path.join(RES, 'gdal'),
  PROJ_DATA: path.join(RES, 'proj'),
  PROJ_LIB: path.join(RES, 'proj'),
  CPL_LOG: '/dev/null',
};

export function gdal(tool: string, args: string[], opts: { timeout?: number } = {}): Promise<string> {
  if (!gdalAvailable) return Promise.reject(new Error('Dit kan alleen in de studio op de Mac: daar draait GDAL (uit QGIS). Start daar `npm run dev` in editor/.'));
  return new Promise((resolve, reject) => {
    execFile(path.join(BIN, tool), args, { env, maxBuffer: 256 * 1024 * 1024, timeout: opts.timeout ?? 10 * 60_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${tool} mislukt: ${(stderr || err.message).toString().trim().split('\n').slice(-3).join(' ')}`));
      else resolve(stdout.toString());
    });
  });
}

export async function gdalInfo(file: string): Promise<any> {
  return JSON.parse(await gdal('gdalinfo', ['-json', file]));
}

export async function ogrLayers(file: string): Promise<{ name: string; geometry: string; count: number }[]> {
  const info = JSON.parse(await gdal('ogrinfo', ['-json', '-so', '-al', file]));
  return (info.layers ?? []).map((l: any) => ({
    name: l.name,
    geometry: l.geometryFields?.[0]?.type ?? 'None',
    count: l.featureCount ?? 0,
  }));
}

/** Converts one layer of any OGR-readable file to a GeoJSON FeatureCollection in EPSG:4326. */
export async function ogrToGeoJSON(file: string, layer?: string, extra: string[] = []): Promise<any> {
  const args = ['-f', 'GeoJSON', '-t_srs', 'EPSG:4326', '-lco', 'RFC7946=YES', '/vsistdout/', file, ...extra];
  if (layer) args.push(layer);
  const out = await gdal('ogr2ogr', args);
  return JSON.parse(out);
}
