import type { Library, Project, ProjectSummary } from './types';

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { 'content-type': 'application/json' };
  }
  const r = await fetch(url, init);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || (j && j.error)) throw new Error(j?.error ?? `Fout ${r.status}`);
  return j as T;
}

export interface ImportSource { id: string; type: 'map' | 'gpkg'; path: string; desc: string }
export interface ParsedLayer { name: string; geometry: string; fc: GeoJSON.FeatureCollection; suggested: { kind: string; category?: string } }
export interface ExportPlan { target: string; exists: boolean; items: { file: string; what: string; app: boolean }[] }
export interface Job { id: string; status: 'running' | 'done' | 'error'; message: string; progress: number; result?: string[] }
export interface UploadResult { kind: 'pdf' | 'image'; pages: number; previews: string[]; size?: [number, number] }
export interface CropResult { crop: { x: number; y: number; w: number; h: number } | null; width: number; height: number; fullWidth: number; fullHeight: number }
export interface Place { name: string; type: string; lon: number; lat: number }

export const api = {
  status: () => req<{ gdal: boolean }>('GET', '/api/status'),
  projects: () => req<ProjectSummary[]>('GET', '/api/projects'),
  createProject: (name: string, center?: [number, number], zoom?: number) => req<Project>('POST', '/api/projects', { name, center, zoom }),
  project: (id: string) => req<Project>('GET', `/api/projects/${id}`),
  saveProject: (p: Project) => req<{ updated: string }>('PUT', `/api/projects/${p.id}`, p),
  renameProject: (id: string, name: string) => req<Project>('PATCH', `/api/projects/${id}`, { name }),
  duplicateProject: (id: string) => req<Project>('POST', `/api/projects/${id}/duplicate`),
  deleteProject: (id: string) => req('DELETE', `/api/projects/${id}`),
  library: () => req<Library>('GET', '/api/library'),
  saveLibrary: (lib: Library) => req('PUT', '/api/library', lib),
  sources: () => req<ImportSource[]>('GET', '/api/import/sources'),
  importSource: (source: string) => req<Project>('POST', '/api/import/source', { source }),
  importFiles: (files: File[], name?: string) => {
    const fd = new FormData();
    for (const f of files) fd.append('files', f);
    if (name) fd.append('name', name);
    return req<Project>('POST', '/api/import/files', fd);
  },
  parseFile: (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return req<ParsedLayer[]>('POST', '/api/parse', fd);
  },
  uploadImage: (pid: string, layerId: string, file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return req<UploadResult>('POST', `/api/projects/${pid}/images/${layerId}/upload`, fd);
  },
  renderPage: (pid: string, layerId: string, page: number, dpi: number) => req<{ size: [number, number] }>('POST', `/api/projects/${pid}/images/${layerId}/render`, { page, dpi }),
  crop: (pid: string, layerId: string, crop: CropResult['crop']) => req<CropResult>('POST', `/api/projects/${pid}/images/${layerId}/crop`, { crop }),
  georef: (pid: string, layerId: string, image: unknown) => req<{ bounds: [number, number, number, number]; version: number }>('POST', `/api/projects/${pid}/images/${layerId}/georef`, { image }),
  deleteImages: (pid: string, layerId: string) => req('DELETE', `/api/projects/${pid}/images/${layerId}`),
  bgt: (bbox: [number, number, number, number]) => req<GeoJSON.FeatureCollection>('POST', '/api/bgt', { bbox }),
  search: (q: string) => req<Place[]>('GET', `/api/search?q=${encodeURIComponent(q)}`),
  exportPlan: (pid: string) => req<ExportPlan>('GET', `/api/projects/${pid}/export`),
  startExport: (pid: string) => req<{ job: string }>('POST', `/api/projects/${pid}/export`),
  job: (id: string) => req<Job>('GET', `/api/jobs/${id}`),
  uploadPhoto: (pid: string, fid: string, file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return req<{ path: string }>('POST', `/api/projects/${pid}/photos/${fid}`, fd);
  },
  reveal: (pid: string) => req('POST', `/api/projects/${pid}/reveal`),
};

export function fileUrl(pid: string, rel: string, version?: number): string {
  return `/api/projects/${pid}/files/${rel}${version ? `?v=${version}` : ''}`;
}
