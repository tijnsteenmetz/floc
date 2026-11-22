import type { Library, Project, ProjectSummary } from './types';

export const API = '/api/v1';
export const STUDIO = '/studio';

/** Last known server revision per map, sent along with each save so the server can refuse stale saves. */
const revisions = new Map<string, number>();

async function req<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const init: RequestInit = { method, headers: { ...headers }, credentials: 'same-origin' };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)['content-type'] = 'application/json';
  }
  const r = await fetch(API + path, init);
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && !path.startsWith('/auth/')) {
    const here = location.pathname + location.search;
    location.href = `${STUDIO}/login?next=${encodeURIComponent(here)}`;
    throw new Error('Log eerst in');
  }
  if (!r.ok || (j && j.error)) throw new Error(j?.error ?? `Fout ${r.status}`);
  return j as T;
}

export interface Me { user: { id: string; email: string; name: string; isStaff: boolean }; orgs: { id: string; name: string; role: string }[] }
export interface AdminData {
  orgs: { id: string; name: string }[];
  users: { id: string; email: string; name: string; isStaff: boolean; created: string; orgs: { id: string; name: string; role: string }[] }[];
  projects: { id: string; name: string; orgId: string | null; version: number | null }[];
}
export interface PublishPlan {
  items: { file: string; what: string; app: boolean }[];
  last: { version: number; published: string; size: number } | null;
  blocked: string | null;
}

export interface ImportSource { id: string; type: 'map' | 'gpkg'; path: string; desc: string }
export interface ParsedLayer { name: string; geometry: string; fc: GeoJSON.FeatureCollection; suggested: { kind: string; category?: string } }
export interface Job { id: string; status: 'running' | 'done' | 'error'; message: string; progress: number; result?: { version: number; size: number; files: number } }
export interface UploadResult { kind: 'pdf' | 'image'; pages: number; previews: string[]; size?: [number, number] }
export interface CropResult { crop: { x: number; y: number; w: number; h: number } | null; width: number; height: number; fullWidth: number; fullHeight: number }
export interface Place { name: string; type: string; lon: number; lat: number }

export const api = {
  me: () => req<Me>('GET', '/auth/me'),
  login: (email: string, password: string) => req<Me>('POST', '/auth/login', { email, password, client: 'web' }),
  logout: () => req('POST', '/auth/logout'),
  admin: () => req<AdminData>('GET', '/admin'),
  createOrg: (name: string) => req('POST', '/admin/orgs', { name }),
  deleteOrg: (id: string) => req('DELETE', `/admin/orgs/${id}`),
  createUser: (u: { email: string; name: string; password: string; isStaff: boolean; orgId?: string }) => req('POST', '/admin/users', u),
  updateUser: (id: string, patch: { password?: string; isStaff?: boolean; name?: string; addOrg?: string; removeOrg?: string }) => req('PATCH', `/admin/users/${id}`, patch),
  deleteUser: (id: string) => req('DELETE', `/admin/users/${id}`),
  setProjectOrg: (id: string, orgId: string | null) => req('PATCH', `/admin/projects/${id}`, { orgId }),
  publishPlan: (pid: string) => req<PublishPlan>('GET', `/projects/${pid}/publish`),
  startPublish: (pid: string) => req<{ job: string }>('POST', `/projects/${pid}/publish`),
  status: () => req<{ gdal: boolean; local: boolean }>('GET', '/status'),
  projects: () => req<ProjectSummary[]>('GET', '/projects'),
  createProject: (name: string, center?: [number, number], zoom?: number) => req<Project>('POST', '/projects', { name, center, zoom }),
  project: async (id: string) => {
    const p = await req<Project>('GET', `/projects/${id}`);
    if (p.revision != null) revisions.set(id, p.revision);
    return p;
  },
  saveProject: async (p: Project) => {
    const rev = revisions.get(p.id);
    const out = await req<{ updated: string; revision: number }>('PUT', `/projects/${p.id}`, p, rev != null ? { 'x-revision': String(rev) } : {});
    revisions.set(p.id, out.revision);
    return out;
  },
  renameProject: (id: string, name: string) => req<Project>('PATCH', `/projects/${id}`, { name }),
  duplicateProject: (id: string) => req<Project>('POST', `/projects/${id}/duplicate`),
  deleteProject: (id: string) => req('DELETE', `/projects/${id}`),
  library: () => req<Library>('GET', '/library'),
  saveLibrary: (lib: Library) => req('PUT', '/library', lib),
  sources: () => req<ImportSource[]>('GET', '/import/sources'),
  importSource: (source: string) => req<Project>('POST', '/import/source', { source }),
  importFiles: (files: File[], name?: string) => {
    const fd = new FormData();
    for (const f of files) fd.append('files', f);
    if (name) fd.append('name', name);
    return req<Project>('POST', '/import/files', fd);
  },
  parseFile: (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return req<ParsedLayer[]>('POST', '/parse', fd);
  },
  uploadImage: (pid: string, layerId: string, file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return req<UploadResult>('POST', `/projects/${pid}/images/${layerId}/upload`, fd);
  },
  renderPage: (pid: string, layerId: string, page: number, dpi: number) => req<{ size: [number, number] }>('POST', `/projects/${pid}/images/${layerId}/render`, { page, dpi }),
  crop: (pid: string, layerId: string, crop: CropResult['crop']) => req<CropResult>('POST', `/projects/${pid}/images/${layerId}/crop`, { crop }),
  georef: (pid: string, layerId: string, image: unknown) => req<{ bounds: [number, number, number, number]; version: number }>('POST', `/projects/${pid}/images/${layerId}/georef`, { image }),
  deleteImages: (pid: string, layerId: string) => req('DELETE', `/projects/${pid}/images/${layerId}`),
  bgt: (bbox: [number, number, number, number]) => req<GeoJSON.FeatureCollection>('POST', '/bgt', { bbox }),
  search: (q: string) => req<Place[]>('GET', `/search?q=${encodeURIComponent(q)}`),
  job: (id: string) => req<Job>('GET', `/jobs/${id}`),
  uploadPhoto: (pid: string, fid: string, file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return req<{ path: string }>('POST', `/projects/${pid}/photos/${fid}`, fd);
  },
};

export function fileUrl(pid: string, rel: string, version?: number): string {
  return `${API}/projects/${pid}/files/${rel}${version ? `?v=${version}` : ''}`;
}
