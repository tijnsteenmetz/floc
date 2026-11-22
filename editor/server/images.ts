// Image and PDF layers: upload, page rendering, cropping and georeferencing with GDAL.
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import type { ImageInfo } from '../src/types';
import { gdal, gdalInfo } from './gdal';
import { projectDir } from './store';

const R = 6378137;
export function mercToLonLat(x: number, y: number): [number, number] {
  return [(x / R) * (180 / Math.PI), (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * (180 / Math.PI)];
}

export function imageDir(projectId: string, layerId: string): string {
  if (!/^[0-9a-f-]{36}$/.test(layerId)) throw new Error('Ongeldige laag-id');
  return path.join(projectDir(projectId), 'images', layerId);
}

async function bandArgs(file: string): Promise<string[]> {
  const info = await gdalInfo(file);
  const bands = info.bands ?? [];
  if (bands.length === 1 && bands[0].colorTable) return ['-expand', 'rgba'];
  if (bands.length === 1) return ['-b', '1', '-b', '1', '-b', '1'];
  if (bands.length === 2) return ['-b', '1', '-b', '1', '-b', '1', '-b', '2'];
  if (bands.length > 4) return ['-b', '1', '-b', '2', '-b', '3', '-b', '4'];
  return [];
}

/** Stores an uploaded image or PDF. For a PDF, renders small page previews. */
export async function storeUpload(projectId: string, layerId: string, tmpFile: string, originalName: string) {
  const dir = imageDir(projectId, layerId);
  await fs.mkdir(dir, { recursive: true });
  const ext = path.extname(originalName).toLowerCase();
  const src = path.join(dir, `source${ext}`);
  await fs.copyFile(tmpFile, src);
  if (ext === '.pdf') {
    const info = await gdalInfo(src).catch(() => ({} as any));
    const subs = Object.keys(info.metadata?.SUBDATASETS ?? {}).filter((k) => k.endsWith('_NAME'));
    const pages = Math.max(1, subs.length);
    for (let i = 1; i <= pages; i++) {
      const name = pages > 1 ? `PDF:${i}:${src}` : src;
      await gdal('gdal_translate', ['--config', 'GDAL_PDF_DPI', '30', '-of', 'PNG', name, path.join(dir, `page-${i}.png`)]);
    }
    return { kind: 'pdf' as const, pages, previews: Array.from({ length: pages }, (_, i) => `images/${layerId}/page-${i + 1}.png`) };
  }
  // Plain image: the full render is just the image as PNG.
  await gdal('gdal_translate', ['-of', 'PNG', ...(await bandArgs(src)), src, path.join(dir, 'full.png')]);
  const info = await gdalInfo(path.join(dir, 'full.png'));
  return { kind: 'image' as const, pages: 1, previews: [`images/${layerId}/full.png`], size: info.size as [number, number] };
}

/** Renders the chosen PDF page at the given DPI into full.png. */
export async function renderPdfPage(projectId: string, layerId: string, page: number, dpi: number) {
  const dir = imageDir(projectId, layerId);
  const src = path.join(dir, 'source.pdf');
  const info = await gdalInfo(src).catch(() => ({} as any));
  const multi = Object.keys(info.metadata?.SUBDATASETS ?? {}).length > 0;
  const name = multi ? `PDF:${page}:${src}` : src;
  const tmp = path.join(dir, 'render.tif');
  await gdal('gdal_translate', ['--config', 'GDAL_PDF_DPI', String(Math.min(400, Math.max(50, dpi))), '-of', 'GTiff', name, tmp]);
  await gdal('gdal_translate', ['-of', 'PNG', ...(await bandArgs(tmp)), tmp, path.join(dir, 'full.png')]);
  await fs.rm(tmp, { force: true });
  const out = await gdalInfo(path.join(dir, 'full.png'));
  return out.size as [number, number];
}

/** Cuts image.png out of full.png. crop is in full-image pixels; null = whole image. */
export async function applyCrop(projectId: string, layerId: string, crop: ImageInfo['crop']) {
  const dir = imageDir(projectId, layerId);
  const full = path.join(dir, 'full.png');
  const info = await gdalInfo(full);
  const [fw, fh] = info.size as [number, number];
  let c = crop;
  if (c) {
    const x = Math.max(0, Math.round(c.x)), y = Math.max(0, Math.round(c.y));
    c = { x, y, w: Math.min(fw - x, Math.round(c.w)), h: Math.min(fh - y, Math.round(c.h)) };
    if (c.w < 8 || c.h < 8) c = null;
  }
  if (c) await gdal('gdal_translate', ['-of', 'PNG', '-srcwin', String(c.x), String(c.y), String(c.w), String(c.h), full, path.join(dir, 'image.png')]);
  else await fs.copyFile(full, path.join(dir, 'image.png'));
  return { crop: c, width: c ? c.w : fw, height: c ? c.h : fh, fullWidth: fw, fullHeight: fh };
}

/** Warps image.png with the control points into a Web Mercator PNG; returns its lon/lat bounds. */
export async function georeference(projectId: string, layerId: string, img: ImageInfo): Promise<[number, number, number, number]> {
  const dir = imageDir(projectId, layerId);
  const pts = img.gcps.filter((g) => g.lon != null && g.lat != null);
  const need = img.method === 'poly' ? 6 : 3;
  if (pts.length < need) throw new Error(`Minstens ${need} gekoppelde punten nodig`);
  const src = path.join(dir, 'image.png');
  const gcpTif = path.join(dir, 'gcp.tif');
  const warped = path.join(dir, 'warped.tif');
  const args = ['-of', 'GTiff', '-a_srs', 'EPSG:4326'];
  for (const g of pts) args.push('-gcp', String(g.px), String(g.py), String(g.lon), String(g.lat));
  await gdal('gdal_translate', [...args, src, gcpTif]);
  const bands = (await gdalInfo(gcpTif)).bands?.length ?? 3;
  await gdal('gdalwarp', ['-overwrite', '-order', img.method === 'poly' ? '2' : '1', '-t_srs', 'EPSG:3857', '-r', 'bilinear', ...(bands === 3 ? ['-dstalpha'] : []), '-of', 'GTiff', gcpTif, warped]);
  await gdal('gdal_translate', ['-of', 'PNG', warped, path.join(dir, 'warped.png')]);
  await fs.rm(gcpTif, { force: true });
  const info = await gdalInfo(warped);
  const cc = info.cornerCoordinates;
  const [w, n] = mercToLonLat(cc.upperLeft[0], cc.upperLeft[1]);
  const [e, s] = mercToLonLat(cc.lowerRight[0], cc.lowerRight[1]);
  return [w, s, e, n];
}

export async function removeImages(projectId: string, layerId: string) {
  const dir = imageDir(projectId, layerId);
  if (existsSync(dir)) await fs.rm(dir, { recursive: true, force: true });
}
