import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, type ImportSource, type Place } from '../api';
import { Icon } from '../icons';
import { Rail } from '../components/Rail';
import { setLastMapId, lastMapId, useLibrary } from '../library';
import type { ProjectSummary } from '../types';
import { KIND_INFO } from '../types';

const VECTOR_ACCEPT = '.geojson,.json,.gpkg,.kml,.kmz,.gpx,.zip,.dxf,.csv';

export function Maps() {
  const nav = useNavigate();
  const { lib } = useLibrary();
  const [maps, setMaps] = useState<ProjectSummary[] | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [modal, setModal] = useState<null | { type: 'new' } | { type: 'import' } | { type: 'rename'; map: ProjectSummary } | { type: 'delete'; map: ProjectSummary }>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => api.projects().then(setMaps).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);
  useEffect(() => {
    const close = () => setMenu(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, []);

  const open = (id: string) => { setLastMapId(id); nav(`/kaart/${id}`); };

  return (
    <div className="app">
      <Rail />
      <main className="page" style={{ position: 'relative' }}>
        <div className="row" style={{ alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
          <div className="col grow" style={{ gap: 6 }}>
            <span className="muted" style={{ fontSize: 13 }}>floc editor</span>
            <h1>Kaarten</h1>
          </div>
          <button className="btn" onClick={() => setModal({ type: 'import' })}><Icon name="download" size={16} />Importeren</button>
          <button className="btn lime" onClick={() => setModal({ type: 'new' })}><Icon name="plus" size={16} stroke={2.2} />Nieuwe kaart</button>
        </div>

        <div className="cards">
          {maps?.map((m) => (
            <div key={m.id} className="mapcard" onClick={() => open(m.id)} role="link" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && open(m.id)}>
              <Thumb m={m} />
              <div style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div className="row" style={{ gap: 8 }}>
                  <span className="grow" style={{ fontSize: 16, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.name}</span>
                  <button className="sq sm" style={{ width: 34, height: 34, borderRadius: 10 }} aria-label="Meer acties" onClick={(e) => { e.stopPropagation(); setMenu(menu === m.id ? null : m.id); }}>
                    <Icon name="more" size={16} stroke={2.4} />
                  </button>
                </div>
                {m.notes && <span className="muted" style={{ fontSize: 13 }}>{m.notes}</span>}
                <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                  {[...new Set(m.layerKinds)].filter((k) => k !== 'voorzieningen').map((k) => <span key={k} className="pill">{KIND_INFO[k].label}</span>)}
                </div>
                <span className="faint" style={{ fontSize: 12 }}>Gewijzigd {fmtDate(m.updated)}</span>
              </div>
              {menu === m.id && (
                <div className="menu" style={{ right: 14, top: 250 }} onClick={(e) => e.stopPropagation()}>
                  <button onClick={() => open(m.id)}>Openen</button>
                  <button onClick={() => { setMenu(null); setModal({ type: 'rename', map: m }); }}>Hernoemen</button>
                  <button onClick={async () => { setMenu(null); try { await api.duplicateProject(m.id); load(); } catch (e: any) { setError(e.message); } }}>Dupliceren</button>
                  <button className="danger" onClick={() => { setMenu(null); setModal({ type: 'delete', map: m }); }}>Verwijderen…</button>
                </div>
              )}
            </div>
          ))}
          <button onClick={() => setModal({ type: 'new' })} style={{ minHeight: 340, borderRadius: 20, border: '1.5px dashed rgba(255,255,255,.14)', background: 'transparent', color: 'var(--muted)', fontSize: 15, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, cursor: 'pointer' }}>
            <span style={{ width: 48, height: 48, borderRadius: 14, background: 'var(--sq)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--lime)' }}><Icon name="plus" stroke={2.2} /></span>
            Nieuwe kaart
            <span className="faint" style={{ fontSize: 12 }}>of dupliceer een bestaande via ···</span>
          </button>
        </div>


        {modal?.type === 'new' && <NewMapModal onClose={() => setModal(null)} onCreated={(id) => open(id)} />}
        {modal?.type === 'import' && <ImportModal onClose={() => setModal(null)} onDone={(id) => open(id)} />}
        {modal?.type === 'rename' && (
          <RenameModal name={modal.map.name} onClose={() => setModal(null)} onSave={async (name) => { await api.renameProject(modal.map.id, name); setModal(null); load(); }} />
        )}
        {modal?.type === 'delete' && (
          <div className="overlay" onClick={() => setModal(null)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <h2>„{modal.map.name}” verwijderen?</h2>
              <p className="sub">De kaart en al haar lagen worden verwijderd uit de editor. Een eerder geëxporteerde map in <code>maps/</code> blijft staan.</p>
              <div className="actions">
                <button className="btn" onClick={() => setModal(null)}>Annuleren</button>
                <button className="btn danger" onClick={async () => { await api.deleteProject(modal.map.id); if (lastMapId() === modal.map.id) setLastMapId(null); setModal(null); load(); }}>Verwijderen</button>
              </div>
            </div>
          </div>
        )}
        {error && <div className="toast err" onClick={() => setError(null)}>{error}</div>}
      </main>
    </div>
  );
}

function fmtDate(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return `vandaag ${d.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' })}`;
  return d.toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' });
}

function Thumb({ m }: { m: ProjectSummary }) {
  const W = 400, H = 210;
  const s = Math.min(W, H) * 0.9;
  const pt = (p: number[]) => `${W / 2 + (p[0] - 0.5) * s},${H / 2 + (p[1] - 0.5) * s}`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 210, display: 'block', background: '#141617' }} aria-hidden="true">
      {m.thumb.polys.map((p, i) => <polygon key={i} points={p.pts.map(pt).join(' ')} fill={p.color} fillOpacity={0.35} />)}
      {m.thumb.lines.map((l, i) => <polyline key={i} points={l.map(pt).join(' ')} fill="none" stroke="#8E959B" strokeWidth={1.2} strokeLinecap="round" />)}
      {m.thumb.dots.map((d, i) => <circle key={i} cx={W / 2 + (d.x - 0.5) * s} cy={H / 2 + (d.y - 0.5) * s} r={3.5} fill={d.color} />)}
      {!m.thumb.lines.length && !m.thumb.polys.length && !m.thumb.dots.length && <text x={W / 2} y={H / 2} textAnchor="middle" fill="#7A8086" fontSize={13}>Nog leeg</text>}
    </svg>
  );
}

function NewMapModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState('');
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Place[]>([]);
  const [place, setPlace] = useState<Place | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const t = useRef<number>(0);
  useEffect(() => {
    window.clearTimeout(t.current);
    if (q.trim().length < 3 || place?.name === q) { setResults([]); return; }
    t.current = window.setTimeout(() => api.search(q).then(setResults).catch(() => setResults([])), 300);
  }, [q]);
  const create = async () => {
    setBusy(true);
    try {
      const p = await api.createProject(name.trim() || 'Nieuwe kaart', place ? [place.lon, place.lat] : undefined, place ? 16 : undefined);
      onCreated(p.id);
    } catch (e: any) { setErr(e.message); setBusy(false); }
  };
  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Nieuwe kaart</h2>
        <div className="field"><label htmlFor="nm-name">Naam</label><input id="nm-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="bv. Wildeburg 2027" /></div>
        <div className="field" style={{ position: 'relative' }}>
          <label htmlFor="nm-place">Locatie</label>
          <input id="nm-place" value={q} onChange={(e) => { setQ(e.target.value); setPlace(null); }} placeholder="Adres of plaats (PDOK)" />
          {results.length > 0 && (
            <div className="col" style={{ gap: 4, marginTop: 4 }}>
              {results.map((r) => (
                <button key={r.name + r.lon} className="item" onClick={() => { setPlace(r); setQ(r.name); setResults([]); }}>
                  <Icon name="pin" size={16} /><span className="grow"><span className="t">{r.name}</span> <span className="d">{r.type}</span></span>
                </button>
              ))}
            </div>
          )}
        </div>
        {err && <span style={{ color: 'var(--danger)', fontSize: 13 }}>{err}</span>}
        <div className="actions">
          <button className="btn" onClick={onClose}>Annuleren</button>
          <button className="btn lime" disabled={busy} onClick={create}>{busy && <span className="spinner" />}Maken</button>
        </div>
      </div>
    </div>
  );
}

function ImportModal({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => void }) {
  const [sources, setSources] = useState<ImportSource[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { api.sources().then((s) => { setSources(s); if (s[0]) setSel(s[0].id); }).catch((e) => setErr(e.message)); }, []);
  const run = async () => {
    setBusy(true); setErr(null);
    try {
      const p = files.length ? await api.importFiles(files) : await api.importSource(sel!);
      onDone(p.id);
    } catch (e: any) { setErr(e.message); setBusy(false); }
  };
  return (
    <div className="overlay" onClick={() => !busy && onClose()}>
      <div className="modal" style={{ width: 540 }} onClick={(e) => e.stopPropagation()}>
        <div className="col" style={{ gap: 6 }}>
          <h2>Importeren</h2>
          <p className="sub">Maakt een nieuwe kaart van bestaand werk. Lagen worden herkend aan hun naam (paden, water, bos, podia, bars…).</p>
        </div>
        <div className="col" style={{ gap: 8 }}>
          {sources === null && <div className="row muted"><span className="spinner" />Bronnen zoeken…</div>}
          {sources?.map((s) => (
            <button key={s.id} className={`item ${sel === s.id && !files.length ? 'on' : ''}`} onClick={() => { setSel(s.id); setFiles([]); }}>
              <span style={{ width: 36, height: 36, borderRadius: 10, background: '#1f2123', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 700, color: 'var(--text-2)', flexShrink: 0 }}>{s.type === 'map' ? 'MAP' : 'GPKG'}</span>
              <span className="col grow" style={{ gap: 2 }}><span className="t" style={{ fontSize: 14 }}>{s.path}</span><span className="d">{s.desc}</span></span>
            </button>
          ))}
          <button className={`item ${files.length ? 'on' : ''}`} onClick={() => input.current?.click()}>
            <span style={{ width: 36, height: 36, borderRadius: 10, background: '#1f2123', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><Icon name="file" size={18} /></span>
            <span className="col grow" style={{ gap: 2 }}>
              <span className="t" style={{ fontSize: 14 }}>{files.length ? files.map((f) => f.name).join(', ') : 'Bestanden kiezen…'}</span>
              <span className="d">GeoJSON, JSON, GeoPackage, KML, GPX, Shapefile (.zip), DXF, CSV</span>
            </span>
          </button>
          <input ref={input} type="file" multiple accept={VECTOR_ACCEPT} style={{ display: 'none' }} onChange={(e) => setFiles([...(e.target.files ?? [])])} />
        </div>
        {err && <span style={{ color: 'var(--danger)', fontSize: 13 }}>{err}</span>}
        <div className="actions">
          <button className="btn" disabled={busy} onClick={onClose}>Annuleren</button>
          <button className="btn lime" disabled={busy || (!sel && !files.length)} onClick={run}>{busy && <span className="spinner" />}{busy ? 'Importeren…' : 'Importeren'}</button>
        </div>
      </div>
    </div>
  );
}

function RenameModal({ name, onClose, onSave }: { name: string; onClose: () => void; onSave: (n: string) => Promise<void> }) {
  const [v, setV] = useState(name);
  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Hernoemen</h2>
        <div className="field"><label htmlFor="rn">Naam</label><input id="rn" autoFocus value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && onSave(v)} /></div>
        <div className="actions"><button className="btn" onClick={onClose}>Annuleren</button><button className="btn lime" onClick={() => onSave(v)}>Opslaan</button></div>
      </div>
    </div>
  );
}
