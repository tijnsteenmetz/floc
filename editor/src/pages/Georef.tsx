import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import * as maplibregl from 'maplibre-gl';
import type { Map as MLMap, Marker } from 'maplibre-gl';
import { api, fileUrl } from '../api';
import { Icon } from '../icons';
import { Rail } from '../components/Rail';
import { setLastMapId } from '../library';
import type { Gcp, Layer, Project } from '../types';
import { isWalkableLayer, newId, pdokUrl } from '../types';
import { LocalProjection, fmtNum, layerLines, projectBounds } from '../geo';

/** Least-squares fit from image pixels to local metres. Returns residuals per point and a transform. */
function fit(gcps: Gcp[], method: 'affine' | 'poly') {
  const pts = gcps.filter((g) => g.lon != null && g.lat != null);
  const need = method === 'poly' ? 6 : 3;
  if (pts.length < need) return null;
  const lon0 = pts.reduce((s, g) => s + g.lon!, 0) / pts.length;
  const lat0 = pts.reduce((s, g) => s + g.lat!, 0) / pts.length;
  const proj = new LocalProjection(lon0, lat0);
  const terms = (x: number, y: number) => (method === 'poly' ? [1, x, y, x * x, x * y, y * y] : [1, x, y]);
  // Scale pixels to keep the normal equations well conditioned.
  const sx = Math.max(...pts.map((g) => Math.abs(g.px)), 1), sy = Math.max(...pts.map((g) => Math.abs(g.py)), 1);
  const solve = (target: number[]) => {
    const n = terms(0, 0).length;
    const A = Array.from({ length: n }, () => new Array(n + 1).fill(0));
    pts.forEach((g, i) => {
      const t = terms(g.px / sx, g.py / sy);
      for (let r = 0; r < n; r++) { for (let c = 0; c < n; c++) A[r][c] += t[r] * t[c]; A[r][n] += t[r] * target[i]; }
    });
    for (let c = 0; c < n; c++) {
      let piv = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
      [A[c], A[piv]] = [A[piv], A[c]];
      if (Math.abs(A[c][c]) < 1e-12) return null;
      for (let r = 0; r < n; r++) if (r !== c) { const f = A[r][c] / A[c][c]; for (let k = c; k <= n; k++) A[r][k] -= f * A[c][k]; }
    }
    return A.map((row, i) => row[n] / A[i][i]);
  };
  const xy = pts.map((g) => proj.toXY([g.lon!, g.lat!]));
  const cx = solve(xy.map((p) => p[0])), cy = solve(xy.map((p) => p[1]));
  if (!cx || !cy) return null;
  const apply = (px: number, py: number): [number, number] => {
    const t = terms(px / sx, py / sy);
    return [t.reduce((s, v, i) => s + v * cx[i], 0), t.reduce((s, v, i) => s + v * cy[i], 0)];
  };
  const residuals = new Map<string, number>();
  pts.forEach((g, i) => { const [x, y] = apply(g.px, g.py); residuals.set(g.id, Math.hypot(x - xy[i][0], y - xy[i][1])); });
  const mean = [...residuals.values()].reduce((a, b) => a + b, 0) / residuals.size;
  return { residuals, mean, toLonLat: (px: number, py: number) => proj.toLonLat(apply(px, py)) };
}

export function Georef() {
  const { id = '', layerId = '' } = useParams();
  const nav = useNavigate();
  const [project, setProject] = useState<Project | null>(null);
  const [gcps, setGcps] = useState<Gcp[]>([]);
  const [method, setMethod] = useState<'affine' | 'poly'>('affine');
  const [active, setActive] = useState<string | null>(null);
  const [preview, setPreview] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const layer: Layer | undefined = project?.layers.find((l) => l.id === layerId);
  const img = layer?.image;

  useEffect(() => {
    setLastMapId(id);
    api.project(id).then((p) => {
      setProject(p);
      const l = p.layers.find((x) => x.id === layerId);
      if (l?.image) { setGcps(l.image.gcps); setMethod(l.image.method); setActive(l.image.gcps[0]?.id ?? null); }
    }).catch((e) => setErr(e.message));
  }, [id, layerId]);

  const result = useMemo(() => fit(gcps, method), [gcps, method]);
  const linked = gcps.filter((g) => g.lon != null).length;
  const pending = gcps.find((g) => g.lon == null);

  // ---------- image viewer ----------
  const viewer = useRef<HTMLDivElement>(null);
  const [vt, setVt] = useState({ k: 1, x: 0, y: 0 });
  const pan = useRef<{ x: number; y: number; moved: boolean; pin?: string } | null>(null);
  useEffect(() => {
    if (!img || !viewer.current) return;
    const r = viewer.current.getBoundingClientRect();
    const k = Math.min(r.width / img.width, r.height / img.height) * 0.95;
    setVt({ k, x: (r.width - img.width * k) / 2, y: (r.height - img.height * k) / 2 });
  }, [img?.width, img?.height]);
  const toPx = (e: React.PointerEvent | React.WheelEvent) => {
    const r = viewer.current!.getBoundingClientRect();
    return [(e.clientX - r.left - vt.x) / vt.k, (e.clientY - r.top - vt.y) / vt.k] as [number, number];
  };
  const onWheel = (e: React.WheelEvent) => {
    const r = viewer.current!.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const f = Math.exp(-e.deltaY * 0.0015);
    setVt((v) => { const k = Math.max(0.02, Math.min(20, v.k * f)); return { k, x: mx - ((mx - v.x) * k) / v.k, y: my - ((my - v.y) * k) / v.k }; });
  };
  const onImgDown = (e: React.PointerEvent, pin?: string) => {
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    pan.current = { x: e.clientX, y: e.clientY, moved: false, pin };
    if (pin) setActive(pin);
  };
  const onImgMove = (e: React.PointerEvent) => {
    const p = pan.current;
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) p.moved = true;
    if (!p.moved) return;
    if (p.pin) { const [px, py] = toPx(e); setGcps((gs) => gs.map((g) => (g.id === p.pin ? { ...g, px, py } : g))); }
    else { setVt((v) => ({ ...v, x: v.x + dx, y: v.y + dy })); p.x = e.clientX; p.y = e.clientY; }
  };
  const onImgUp = (e: React.PointerEvent) => {
    const p = pan.current;
    pan.current = null;
    if (!p || p.moved || p.pin || !img) return;
    const [px, py] = toPx(e);
    if (px < 0 || py < 0 || px > img.width || py > img.height) return;
    if (pending) { setGcps((gs) => gs.map((g) => (g.id === pending.id ? { ...g, px, py } : g))); setActive(pending.id); }
    else { const g: Gcp = { id: newId(), px, py, lon: null, lat: null }; setGcps((gs) => [...gs, g]); setActive(g.id); }
  };

  // ---------- map ----------
  const mapEl = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const markers = useRef(new Map<string, Marker>());
  const [mapReady, setMapReady] = useState(false);
  const gcpsRef = useRef(gcps);
  gcpsRef.current = gcps;
  const activeRef = useRef(active);
  activeRef.current = active;
  useEffect(() => {
    if (!project || !mapEl.current || mapRef.current) return;
    const pdok = project.layers.find((l) => l.kind === 'pdok')?.pdokLayer ?? 'Actueel_orthoHR';
    const b = projectBounds(project);
    const map = new maplibregl.Map({
      container: mapEl.current,
      style: {
        version: 8,
        sources: { aerial: { type: 'raster', tiles: [pdokUrl(pdok)], tileSize: 256, maxzoom: 21, attribution: 'Luchtfoto © PDOK' } },
        layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#141617' } }, { id: 'aerial', type: 'raster', source: 'aerial' }],
      },
      center: project.view?.center ?? (b ? [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2] : [5.3, 52.2]),
      zoom: project.view?.zoom ?? 15,
      maxZoom: 22, dragRotate: false, attributionControl: { compact: true },
    });
    mapRef.current = map;
    map.on('load', () => {
      const lines = project.layers.filter(isWalkableLayer).flatMap(layerLines);
      map.addSource('paths', { type: 'geojson', data: { type: 'FeatureCollection', features: lines } });
      map.addLayer({ id: 'paths', type: 'line', source: 'paths', paint: { 'line-color': '#D4F56A', 'line-width': 1.5, 'line-opacity': 0.5 } });
      setMapReady(true);
    });
    map.on('click', (e) => {
      const gs = gcpsRef.current;
      const target = gs.find((g) => g.id === activeRef.current && g.lon == null) ?? gs.find((g) => g.lon == null);
      if (!target) { setErr('Klik eerst een herkenbaar punt op de plattegrond (links), daarna hetzelfde punt hier.'); return; }
      setErr(null);
      setGcps(gs.map((g) => (g.id === target.id ? { ...g, lon: e.lngLat.lng, lat: e.lngLat.lat } : g)));
      setActive(target.id);
    });
    return () => { map.remove(); mapRef.current = null; };
  }, [project ? 1 : 0]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const seen = new Set<string>();
    gcps.forEach((g, i) => {
      if (g.lon == null || g.lat == null) return;
      seen.add(g.id);
      let m = markers.current.get(g.id);
      if (!m) {
        const el = document.createElement('div');
        m = new maplibregl.Marker({ element: el, draggable: true }).setLngLat([g.lon, g.lat]).addTo(map);
        m.on('dragstart', () => setActive(g.id));
        m.on('dragend', () => { const ll = m!.getLngLat(); setGcps((gs) => gs.map((x) => (x.id === g.id ? { ...x, lon: ll.lng, lat: ll.lat } : x))); });
        el.addEventListener('click', (ev) => { ev.stopPropagation(); setActive(g.id); });
        markers.current.set(g.id, m);
      }
      const el = m.getElement();
      const on = active === g.id;
      el.textContent = String(i + 1);
      el.style.cssText = `width:${on ? 26 : 22}px;height:${on ? 26 : 22}px;border-radius:50%;background:${on ? '#fff' : '#D4F56A'};color:#0C0D0E;border:2px solid #0C0D0E;font:700 11px Inter,sans-serif;display:flex;align-items:center;justify-content:center;cursor:move`;
      m.setLngLat([g.lon, g.lat]);
    });
    for (const [gid, m] of markers.current) if (!seen.has(gid)) { m.remove(); markers.current.delete(gid); }
  }, [gcps, active, mapReady]);

  // Preview: the cropped image placed with the fitted transform.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !img) return;
    const has = !!map.getSource('preview');
    if (!result || preview === 0) { if (has) { map.removeLayer('preview'); map.removeSource('preview'); } return; }
    const c = [result.toLonLat(0, 0), result.toLonLat(img.width, 0), result.toLonLat(img.width, img.height), result.toLonLat(0, img.height)] as [[number, number], [number, number], [number, number], [number, number]];
    if (has) {
      (map.getSource('preview') as maplibregl.ImageSource).setCoordinates(c);
      map.setPaintProperty('preview', 'raster-opacity', preview / 100);
    } else {
      map.addSource('preview', { type: 'image', url: fileUrl(id, `images/${layerId}/image.png`), coordinates: c });
      map.addLayer({ id: 'preview', type: 'raster', source: 'preview', paint: { 'raster-opacity': preview / 100, 'raster-fade-duration': 0 } }, 'paths');
    }
  }, [result, preview, mapReady, img?.width]);

  const remove = (gid: string) => { setGcps((gs) => gs.filter((g) => g.id !== gid)); if (active === gid) setActive(null); };

  const apply = async () => {
    if (!project || !layer || !img) return;
    setBusy(true); setErr(null);
    try {
      const image = { ...img, gcps, method };
      const r = await api.georef(id, layerId, image);
      const latest = await api.project(id);
      const next: Project = { ...latest, layers: latest.layers.map((l) => (l.id === layerId ? { ...l, image: { ...image, warped: { bounds: r.bounds, version: r.version } } } : l)) };
      await api.saveProject(next);
      nav(`/kaart/${id}`);
    } catch (e: any) { setErr(e.message); setBusy(false); }
  };

  const saveAndBack = async () => {
    if (project && layer && img) {
      const latest = await api.project(id);
      await api.saveProject({ ...latest, layers: latest.layers.map((l) => (l.id === layerId ? { ...l, image: { ...img, gcps, method } } : l)) });
    }
    nav(`/kaart/${id}`);
  };

  if (!project) return <div className="app"><Rail /><main className="page">{err ? <p>{err}</p> : <div className="row muted"><span className="spinner" />Laden…</div>}</main></div>;
  if (!layer || !img) return <div className="app"><Rail /><main className="page"><h1>Geen afbeeldingslaag</h1><button className="btn" onClick={() => nav(`/kaart/${id}`)}>Terug</button></main></div>;

  const need = method === 'poly' ? 6 : 3;
  const step = linked >= need ? 3 : 2;
  const hint = pending ? `Klik punt ${gcps.indexOf(pending) + 1} nu op de luchtfoto (rechts).` : linked < need ? `Klik een herkenbaar punt op de plattegrond (links). Nog ${need - linked} nodig.` : 'Genoeg punten. Controleer met het voorbeeld en klik Toepassen.';

  return (
    <div className="app">
      <Rail />
      <div className="editor" style={{ display: 'flex', flexDirection: 'column', padding: 20, gap: 16 }}>
        <div className="row" style={{ gap: 18, flexWrap: 'wrap' }}>
          <button className="sq sm" onClick={saveAndBack} aria-label="Terug naar editor" title="Opslaan en terug"><Icon name="back" size={16} stroke={2.2} /></button>
          <div className="col" style={{ gap: 0 }}>
            <span style={{ fontSize: 17, fontWeight: 600 }}>{layer.name} georefereren</span>
            <span className="muted" style={{ fontSize: 12 }}>{img.sourceName}{img.page ? ` · pagina ${img.page}` : ''}{img.crop ? ' · bijgesneden' : ''}</span>
          </div>
          <div className="grow" />
          {[{ n: 1, t: 'Bestand' }, { n: 2, t: 'Punten koppelen' }, { n: 3, t: 'Controleren' }].map((s) => (
            <div key={s.n} className="row" style={{ gap: 8, fontSize: 13, color: s.n <= step ? 'var(--text)' : 'var(--faint)' }}>
              <span style={{ width: 22, height: 22, borderRadius: '50%', background: s.n === step ? 'var(--lime)' : s.n < step ? '#2A2C2F' : '#1F2123', color: s.n === step ? 'var(--bg)' : 'var(--muted)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 600 }}>{s.n < step ? '✓' : s.n}</span>{s.t}
            </div>
          ))}
          <div className="grow" />
          <button className="btn lime" disabled={busy || linked < need} onClick={apply}>{busy && <span className="spinner" />}Toepassen</button>
        </div>

        <div className="row" style={{ gap: 20, flex: '1 1 auto', minHeight: 0, alignItems: 'stretch' }}>
          <div ref={viewer} style={{ position: 'relative', flex: 1, borderRadius: 20, overflow: 'hidden', background: '#2A2C2F', border: '1px solid var(--line)', cursor: 'crosshair', touchAction: 'none' }}
            onWheel={onWheel} onPointerDown={(e) => onImgDown(e)} onPointerMove={onImgMove} onPointerUp={onImgUp}>
            <img src={fileUrl(id, `images/${layerId}/image.png`)} alt="Plattegrond" draggable={false}
              style={{ position: 'absolute', left: vt.x, top: vt.y, width: img.width * vt.k, height: img.height * vt.k, maxWidth: 'none', userSelect: 'none', pointerEvents: 'none' }} />
            {gcps.map((g, i) => {
              const on = active === g.id;
              return (
                <button key={g.id} onPointerDown={(e) => onImgDown(e, g.id)} onPointerMove={onImgMove} onPointerUp={(e) => { (e.currentTarget as Element).releasePointerCapture(e.pointerId); pan.current = null; }}
                  aria-label={`Punt ${i + 1}`} title="Sleep om te verplaatsen"
                  style={{ position: 'absolute', left: vt.x + g.px * vt.k - (on ? 13 : 11), top: vt.y + g.py * vt.k - (on ? 13 : 11), width: on ? 26 : 22, height: on ? 26 : 22, borderRadius: '50%', background: on ? '#fff' : g.lon == null ? '#F5B84A' : '#D4F56A', color: '#0C0D0E', border: '2px solid #0C0D0E', fontSize: 11, fontWeight: 700, cursor: 'move', padding: 0 }}>
                  {i + 1}
                </button>
              );
            })}
            <div className="row" style={{ position: 'absolute', left: 14, top: 14, padding: '8px 12px', borderRadius: 12, background: 'rgba(12,13,14,.85)', fontSize: 13, fontWeight: 600, gap: 6 }}>Plattegrond <span className="muted" style={{ fontWeight: 400 }}>· scroll = zoom, slepen = schuiven</span></div>
          </div>
          <div style={{ position: 'relative', flex: 1, borderRadius: 20, overflow: 'hidden', border: '1px solid var(--line)' }}>
            <div ref={mapEl} style={{ position: 'absolute', inset: 0, cursor: 'crosshair' }} />
            <div className="row" style={{ position: 'absolute', left: 14, top: 14, padding: '8px 12px', borderRadius: 12, background: 'rgba(12,13,14,.85)', fontSize: 13, fontWeight: 600, gap: 6, zIndex: 2 }}>Luchtfoto PDOK <span className="muted" style={{ fontWeight: 400 }}>· klik hetzelfde punt</span></div>
          </div>
        </div>

        <div className="card row" style={{ padding: '14px 16px', gap: 24, alignItems: 'stretch', flex: '0 0 auto', maxHeight: 260 }}>
          <div className="col grow scroll" style={{ gap: 2 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '40px 1fr 1fr 80px 36px', gap: 8, padding: '0 10px', fontSize: 12, color: 'var(--faint)' }}><span>#</span><span>Plattegrond (px)</span><span>Kaart (lat, lon)</span><span>Fout</span><span /></div>
            {gcps.map((g, i) => {
              const r = result?.residuals.get(g.id);
              return (
                <div key={g.id} onClick={() => setActive(g.id)} style={{ display: 'grid', gridTemplateColumns: '40px 1fr 1fr 80px 36px', alignItems: 'center', gap: 8, height: 38, padding: '0 10px', borderRadius: 10, fontSize: 13, fontVariantNumeric: 'tabular-nums', cursor: 'pointer', background: active === g.id ? 'rgba(212,245,106,.08)' : 'transparent' }}>
                  <span style={{ width: 22, height: 22, borderRadius: '50%', background: g.lon == null ? '#F5B84A' : 'var(--lime)', color: 'var(--bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700 }}>{i + 1}</span>
                  <span>{Math.round(g.px)}, {Math.round(g.py)}</span>
                  <span>{g.lat != null ? `${g.lat.toFixed(5)}, ${g.lon!.toFixed(5)}` : <span style={{ color: 'var(--warn)' }}>klik op de luchtfoto</span>}</span>
                  <span style={{ color: r != null && r > 2 ? 'var(--warn)' : 'var(--text-2)' }}>{r != null ? `${fmtNum(r)} m` : '—'}</span>
                  <button className="icon-btn" aria-label={`Punt ${i + 1} verwijderen`} onClick={(e) => { e.stopPropagation(); remove(g.id); }}><Icon name="close" size={14} /></button>
                </div>
              );
            })}
            {!gcps.length && <span className="muted" style={{ padding: 10, fontSize: 13 }}>Nog geen punten.</span>}
          </div>
          <div className="col" style={{ width: 320, flexShrink: 0, gap: 14, paddingLeft: 24, borderLeft: '1px solid var(--line)' }}>
            <div className="col" style={{ gap: 6 }}>
              <span className="muted" style={{ fontSize: 12 }}>Transformatie</span>
              <div className="seg-group" style={{ width: 'fit-content' }}>
                <button className={`seg ${method === 'affine' ? 'on' : ''}`} onClick={() => setMethod('affine')}>Affien (3+)</button>
                <button className={`seg ${method === 'poly' ? 'on' : ''}`} onClick={() => setMethod('poly')}>Polynoom (6+)</button>
              </div>
            </div>
            <div className="row" style={{ justifyContent: 'space-between' }}><span className="muted" style={{ fontSize: 12 }}>Gemiddelde fout</span><span style={{ fontSize: 22, fontWeight: 600 }}>{result ? `${fmtNum(result.mean)} m` : '—'}</span></div>
            <div className="row" style={{ gap: 10 }}>
              <label htmlFor="gr-prev" className="muted grow" style={{ fontSize: 12 }}>Voorbeeld over luchtfoto</label>
              <input type="range" id="gr-prev" min={0} max={100} value={preview} disabled={!result} onChange={(e) => setPreview(Number(e.target.value))} style={{ width: 140 }} />
            </div>
            <span style={{ fontSize: 12, color: err ? 'var(--danger)' : 'var(--muted)' }}>{err ?? hint}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
