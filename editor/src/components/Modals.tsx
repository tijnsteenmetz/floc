import { useEffect, useRef, useState } from 'react';
import type { FeatureCollection } from 'geojson';
import { api, fileUrl, type ExportPlan, type Job, type ParsedLayer } from '../api';
import { Icon } from '../icons';
import { useLibrary } from '../library';
import type { Category, Facility, Layer, Project, VectorKind } from '../types';
import { KIND_INFO, makeLayer, newId, isVectorKind } from '../types';
import { fmtNum, normaliseFeatures } from '../geo';

export function ExportModal({ pid, onClose }: { pid: string; onClose: () => void }) {
  const [plan, setPlan] = useState<ExportPlan | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api.exportPlan(pid).then(setPlan).catch((e) => setErr(e.message)); }, [pid]);
  useEffect(() => {
    if (!job || job.status !== 'running') return;
    const t = window.setTimeout(() => api.job(job.id).then(setJob).catch((e) => setErr(e.message)), 700);
    return () => window.clearTimeout(t);
  }, [job]);
  const start = async () => {
    setErr(null);
    try { const { job: id } = await api.startExport(pid); setJob({ id, status: 'running', message: 'Starten', progress: 0 }); }
    catch (e: any) { setErr(e.message); }
  };
  const running = job?.status === 'running';
  return (
    <div className="overlay" onClick={() => !running && onClose()}>
      <div className="modal" style={{ width: 640 }} onClick={(e) => e.stopPropagation()}>
        {job?.status === 'done' ? (
          <div className="col" style={{ alignItems: 'center', gap: 14, padding: '20px 0', textAlign: 'center' }}>
            <div style={{ width: 64, height: 64, borderRadius: 20, background: 'var(--lime)', color: 'var(--bg)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Icon name="check" size={30} stroke={2.4} /></div>
            <span style={{ fontSize: 20, fontWeight: 600 }}>Geëxporteerd</span>
            <span className="muted" style={{ fontSize: 14, maxWidth: 440 }}>{job.result?.length} bestanden in <code style={{ color: 'var(--text)' }}>{plan?.target}</code>. Build de app opnieuw in Xcode om de kaart op je iPhone te zien.</span>
            <div className="row" style={{ marginTop: 6 }}>
              <button className="btn" onClick={() => api.reveal(pid).catch((e) => setErr(e.message))}>Map openen in Finder</button>
              <button className="btn lime" onClick={onClose}>Terug naar editor</button>
            </div>
          </div>
        ) : (
          <>
            <div className="row" style={{ gap: 14 }}>
              <div style={{ width: 44, height: 44, borderRadius: 12, background: 'var(--lime)', color: 'var(--bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><Icon name="upload" stroke={2} /></div>
              <div className="col" style={{ gap: 2 }}>
                <h2>Exporteren voor de app</h2>
                <span className="muted" style={{ fontSize: 13 }}>→ <code style={{ color: 'var(--text)' }}>{plan?.target ?? '…'}</code></span>
              </div>
            </div>
            {!plan && !err && <div className="row muted"><span className="spinner" />Overzicht maken…</div>}
            {plan && (
              <div className="col" style={{ gap: 0 }}>
                {plan.items.map((f, i) => (
                  <div key={f.file} style={{ display: 'grid', gridTemplateColumns: '24px 190px 1fr 60px', alignItems: 'center', gap: 12, minHeight: 40, padding: '6px 12px', borderRadius: 10, background: i % 2 ? 'transparent' : 'var(--tile)', fontSize: 13 }}>
                    <Icon name="check" size={16} stroke={2.4} color="var(--lime)" />
                    <span style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12 }}>{f.file}</span>
                    <span className="muted">{f.what}</span>
                    <span className="pill" style={{ textAlign: 'center', background: f.app ? 'rgba(212,245,106,.12)' : undefined, color: f.app ? 'var(--lime)' : undefined }}>{f.app ? 'app' : 'extra'}</span>
                  </div>
                ))}
              </div>
            )}
            {plan?.exists && !running && (
              <div className="row" style={{ padding: '12px 14px', borderRadius: 12, background: 'rgba(245,184,74,.1)', color: 'var(--warn)', fontSize: 13 }}>
                <Icon name="warn" size={16} />De bestaande map wordt overschreven (alleen de bestanden hierboven). {plan.items.some((i) => i.file === 'aerial.mbtiles') ? 'Luchtfoto ophalen kan een paar minuten duren.' : ''}
              </div>
            )}
            {running && (
              <div className="col" style={{ gap: 8 }}>
                <div style={{ height: 6, borderRadius: 3, background: 'var(--tile)', overflow: 'hidden' }}><div style={{ height: '100%', width: `${Math.round(job!.progress * 100)}%`, background: 'var(--lime)', transition: 'width .3s' }} /></div>
                <span className="muted" style={{ fontSize: 13 }}>{job!.message}</span>
              </div>
            )}
            {(err || job?.status === 'error') && <span style={{ color: 'var(--danger)', fontSize: 13 }}>{err ?? job?.message}</span>}
            <div className="actions">
              <button className="btn" disabled={running} onClick={onClose}>Annuleren</button>
              <button className="btn lime" disabled={!plan || running} onClick={start}>{running && <span className="spinner" />}Exporteren</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

type Target = { type: 'new'; kind: VectorKind } | { type: 'existing'; layerId: string } | { type: 'facilities'; category: string } | { type: 'skip' };

export function ImportFileModal({ file, layers, onClose, onImport }: { file: File; layers: Layer[]; onClose: () => void; onImport: (apply: (p: Project) => Project) => void }) {
  const { lib } = useLibrary();
  const [parsed, setParsed] = useState<ParsedLayer[] | null>(null);
  const [targets, setTargets] = useState<Target[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const vectorLayers = layers.filter((l) => isVectorKind(l.kind));
  useEffect(() => {
    api.parseFile(file).then((p) => {
      setParsed(p);
      setTargets(p.map((x) => {
        const s = x.suggested;
        if (s.kind === 'facility') return { type: 'facilities', category: s.category ?? 'bar' };
        const same = vectorLayers.find((l) => l.kind === s.kind);
        if (s.kind === 'beloopbaar' && same) return { type: 'existing', layerId: same.id };
        return { type: 'new', kind: s.kind as VectorKind };
      }));
    }).catch((e) => setErr(e.message));
  }, [file]);
  const enc = (t: Target) => (t.type === 'new' ? `new:${t.kind}` : t.type === 'existing' ? `ex:${t.layerId}` : t.type === 'facilities' ? `fac:${t.category}` : 'skip');
  const dec = (s: string): Target => {
    const [a, b] = s.split(/:(.+)/);
    return a === 'new' ? { type: 'new', kind: b as VectorKind } : a === 'ex' ? { type: 'existing', layerId: b } : a === 'fac' ? { type: 'facilities', category: b } : { type: 'skip' };
  };
  const run = () => {
    if (!parsed) return;
    onImport((p) => {
      let next: Project = { ...p, layers: [...p.layers], facilities: [...p.facilities] };
      parsed.forEach((item, i) => {
        const t = targets[i];
        if (!t || t.type === 'skip') return;
        if (t.type === 'facilities') {
          for (const f of item.fc.features) {
            const g: any = f.geometry;
            const pts: number[][] = g?.type === 'Point' ? [g.coordinates] : g?.type === 'MultiPoint' ? g.coordinates : [];
            for (const c of pts) {
              const pr: any = f.properties ?? {};
              next.facilities.push({ id: newId(), category: t.category, name: String(pr.name ?? pr.naam ?? ''), notes: '', lon: c[0], lat: c[1], rotation: 0 });
            }
          }
          if (!next.layers.some((l) => l.kind === 'voorzieningen')) next.layers.unshift(makeLayer('voorzieningen'));
          return;
        }
        const feats = normaliseFeatures(item.fc as FeatureCollection, newId).filter((f) => f.geometry.type !== 'Point');
        if (t.type === 'new') {
          const l = makeLayer(t.kind, { name: item.name, features: { type: 'FeatureCollection', features: feats as any } });
          const idx = next.layers.findIndex((x) => isVectorKind(x.kind));
          next.layers.splice(idx < 0 ? 0 : idx, 0, l);
        } else {
          next.layers = next.layers.map((l) => (l.id === t.layerId ? { ...l, features: { type: 'FeatureCollection', features: [...(l.features?.features ?? []), ...(feats as any)] } } : l));
        }
      });
      return next;
    });
  };
  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" style={{ width: 600 }} onClick={(e) => e.stopPropagation()}>
        <div className="col" style={{ gap: 6 }}>
          <h2>{file.name} importeren</h2>
          <p className="sub">Kies per onderdeel waar het heen gaat.</p>
        </div>
        {!parsed && !err && <div className="row muted"><span className="spinner" />Bestand lezen…</div>}
        {parsed?.map((item, i) => {
          const pointsOnly = /^(Multi)?Point(, (Multi)?Point)*$/.test(item.geometry);
          return (
            <div key={i} className="row" style={{ padding: 12, borderRadius: 14, background: 'var(--tile)', gap: 12 }}>
              <div className="col grow" style={{ gap: 2 }}>
                <span style={{ fontWeight: 600 }}>{item.name}</span>
                <span className="muted" style={{ fontSize: 12 }}>{item.fc.features.length} objecten · {item.geometry}</span>
              </div>
              <select className="input" style={{ width: 250 }} aria-label={`Doel voor ${item.name}`} value={targets[i] ? enc(targets[i]) : 'skip'} onChange={(e) => setTargets((ts) => ts.map((t, j) => (j === i ? dec(e.target.value) : t)))}>
                {!pointsOnly && (
                  <optgroup label="Nieuwe laag">
                    {(['beloopbaar', 'water', 'bos', 'zand', 'hekken', 'eigen'] as VectorKind[]).map((k) => <option key={k} value={`new:${k}`}>Nieuwe laag: {KIND_INFO[k].label}</option>)}
                  </optgroup>
                )}
                {!pointsOnly && vectorLayers.length > 0 && (
                  <optgroup label="Toevoegen aan">
                    {vectorLayers.map((l) => <option key={l.id} value={`ex:${l.id}`}>Toevoegen aan: {l.name}</option>)}
                  </optgroup>
                )}
                {/Point/.test(item.geometry) && (
                  <optgroup label="Als voorzieningen">
                    {lib.categories.map((c) => <option key={c.id} value={`fac:${c.id}`}>Voorzieningen: {c.name}</option>)}
                  </optgroup>
                )}
                <option value="skip">Overslaan</option>
              </select>
            </div>
          );
        })}
        {err && <span style={{ color: 'var(--danger)', fontSize: 13 }}>{err}</span>}
        <div className="actions">
          <button className="btn" onClick={onClose}>Annuleren</button>
          <button className="btn lime" disabled={!parsed?.length} onClick={run}>Importeren</button>
        </div>
      </div>
    </div>
  );
}

type Crop = { x: number; y: number; w: number; h: number } | null;

export function ImageImportModal({ file, pid, cropOnly, onClose, onDone }: { file?: File; pid: string; cropOnly?: Layer; onClose: () => void; onDone: (layer: Layer) => void }) {
  const [layerId] = useState(() => cropOnly?.id ?? newId());
  const [step, setStep] = useState<'upload' | 'page' | 'crop'>(cropOnly ? 'crop' : 'upload');
  const [pages, setPages] = useState<string[]>([]);
  const [page, setPage] = useState(1);
  const [dpi, setDpi] = useState(150);
  const [size, setSize] = useState<[number, number] | null>(cropOnly?.image ? [cropOnly.image.fullWidth, cropOnly.image.fullHeight] : null);
  const [crop, setCrop] = useState<Crop>(cropOnly?.image?.crop ?? null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ver] = useState(() => Date.now());
  const isPdf = !!file && /\.pdf$/i.test(file.name);

  useEffect(() => {
    if (!file || cropOnly) return;
    api.uploadImage(pid, layerId, file).then((r) => {
      if (r.kind === 'pdf') { setPages(r.previews); setStep(r.pages > 1 ? 'page' : 'page'); }
      else { setSize(r.size!); setStep('crop'); }
    }).catch((e) => setErr(e.message));
  }, []);

  const render = async () => {
    setBusy(true); setErr(null);
    try { const r = await api.renderPage(pid, layerId, page, dpi); setSize(r.size); setStep('crop'); }
    catch (e: any) { setErr(e.message); }
    setBusy(false);
  };

  const finish = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api.crop(pid, layerId, crop);
      if (cropOnly?.image) {
        const old = cropOnly.image.crop ?? { x: 0, y: 0 };
        const nw = r.crop ?? { x: 0, y: 0 };
        const dx = old.x - nw.x, dy = old.y - nw.y;
        onDone({ ...cropOnly, image: { ...cropOnly.image, crop: r.crop, width: r.width, height: r.height, gcps: cropOnly.image.gcps.map((g) => ({ ...g, px: g.px + dx, py: g.py + dy })) } });
      } else {
        const name = file!.name.replace(/\.[^.]+$/, '');
        onDone(makeLayer('image', {
          id: layerId, name,
          image: { sourceName: file!.name, page: isPdf ? page : undefined, width: r.width, height: r.height, fullWidth: r.fullWidth, fullHeight: r.fullHeight, crop: r.crop, gcps: [], method: 'affine', warped: null },
        }));
      }
    } catch (e: any) { setErr(e.message); setBusy(false); }
  };

  const cancel = async () => {
    if (!cropOnly) await api.deleteImages(pid, layerId).catch(() => {});
    onClose();
  };

  return (
    <div className="overlay" onClick={() => !busy && cancel()}>
      <div className="modal" style={{ width: 760 }} onClick={(e) => e.stopPropagation()}>
        <div className="col" style={{ gap: 6 }}>
          <h2>{cropOnly ? `${cropOnly.name} bijsnijden` : `${file?.name} toevoegen`}</h2>
          <p className="sub">{step === 'upload' ? 'Bestand verwerken…' : step === 'page' ? 'Kies de pagina en de resolutie.' : 'Sleep een kader om bij te snijden, of gebruik de hele afbeelding.'}</p>
        </div>
        {step === 'upload' && !err && <div className="row muted"><span className="spinner" />Uploaden en lezen…</div>}
        {step === 'page' && (
          <>
            <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
              {pages.map((src, i) => (
                <button key={src} onClick={() => setPage(i + 1)} className={`item ${page === i + 1 ? 'on' : ''}`} style={{ width: 150, flexDirection: 'column', gap: 6 }}>
                  <img src={fileUrl(pid, src)} alt={`Pagina ${i + 1}`} style={{ width: '100%', height: 110, objectFit: 'contain', background: '#fff', borderRadius: 6 }} />
                  <span className="d">Pagina {i + 1}</span>
                </button>
              ))}
            </div>
            <div className="field" style={{ width: 220 }}>
              <label htmlFor="ii-dpi">Resolutie</label>
              <select id="ii-dpi" value={dpi} onChange={(e) => setDpi(Number(e.target.value))}>
                {[100, 150, 200, 300].map((d) => <option key={d} value={d}>{d} dpi</option>)}
              </select>
            </div>
          </>
        )}
        {step === 'crop' && size && <Cropper src={fileUrl(pid, `images/${layerId}/full.png`, ver)} size={size} crop={crop} setCrop={setCrop} />}
        {err && <span style={{ color: 'var(--danger)', fontSize: 13 }}>{err}</span>}
        <div className="actions">
          <button className="btn" disabled={busy} onClick={cancel}>Annuleren</button>
          {step === 'crop' && crop && <button className="btn" onClick={() => setCrop(null)}>Hele afbeelding</button>}
          {step === 'page' && <button className="btn lime" disabled={busy} onClick={render}>{busy && <span className="spinner" />}Pagina gebruiken</button>}
          {step === 'crop' && <button className="btn lime" disabled={busy} onClick={finish}>{busy && <span className="spinner" />}{cropOnly ? 'Opslaan' : 'Verder naar georefereren'}</button>}
        </div>
      </div>
    </div>
  );
}

function Cropper({ src, size, crop, setCrop }: { src: string; size: [number, number]; crop: Crop; setCrop: (c: Crop) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const start = useRef<[number, number] | null>(null);
  const maxW = 700, maxH = 440;
  const k = Math.min(maxW / size[0], maxH / size[1], 1);
  const W = size[0] * k, H = size[1] * k;
  const toImg = (e: React.PointerEvent): [number, number] => {
    const r = box.current!.getBoundingClientRect();
    return [Math.max(0, Math.min(size[0], (e.clientX - r.left) / k)), Math.max(0, Math.min(size[1], (e.clientY - r.top) / k))];
  };
  return (
    <div ref={box} style={{ position: 'relative', width: W, height: H, margin: '0 auto', cursor: 'crosshair', userSelect: 'none', touchAction: 'none', background: '#fff' }}
      onPointerDown={(e) => { (e.target as HTMLElement).setPointerCapture(e.pointerId); start.current = toImg(e); }}
      onPointerMove={(e) => { if (!start.current) return; const [x, y] = toImg(e); const [x0, y0] = start.current; setCrop({ x: Math.min(x, x0), y: Math.min(y, y0), w: Math.abs(x - x0), h: Math.abs(y - y0) }); }}
      onPointerUp={() => { start.current = null; if (crop && (crop.w < 8 || crop.h < 8)) setCrop(null); }}>
      <img src={src} alt="" draggable={false} style={{ width: W, height: H, display: 'block' }} />
      {crop && (
        <>
          <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,.5)', clipPath: `polygon(0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${crop.x * k}px ${crop.y * k}px, ${crop.x * k}px ${(crop.y + crop.h) * k}px, ${(crop.x + crop.w) * k}px ${(crop.y + crop.h) * k}px, ${(crop.x + crop.w) * k}px ${crop.y * k}px, ${crop.x * k}px ${crop.y * k}px)` }} />
          <div style={{ position: 'absolute', left: crop.x * k, top: crop.y * k, width: crop.w * k, height: crop.h * k, border: '2px solid var(--lime)', pointerEvents: 'none' }} />
        </>
      )}
      <span className="pill" style={{ position: 'absolute', right: 8, bottom: 8 }}>{crop ? `${Math.round(crop.w)} × ${Math.round(crop.h)} px` : `${size[0]} × ${size[1]} px`}</span>
    </div>
  );
}

const CAT_COLORS = ['#A78BFA', '#F5B84A', '#F472B6', '#6BC0FF', '#2DD4BF', '#D4F56A', '#FF8A4C', '#FF6B6B', '#94A3B8', '#F2F3F4'];

export function CategoryModal({ onClose, onSave }: { onClose: () => void; onSave: (c: Category) => void }) {
  const { lib } = useLibrary();
  const [name, setName] = useState('');
  const [color, setColor] = useState(CAT_COLORS[0]);
  const [label, setLabel] = useState('');
  const save = () => {
    const base = name.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'categorie';
    let id = base, n = 2;
    while (lib.categories.some((c) => c.id === id)) id = `${base}-${n++}`;
    onSave({ id, name: name.trim(), color, label: (label.trim() || name.trim().slice(0, 3)).toUpperCase() });
  };
  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" style={{ width: 420 }} onClick={(e) => e.stopPropagation()}>
        <h2>Eigen categorie</h2>
        <div className="field"><label htmlFor="cm-name">Naam</label><input id="cm-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="bv. Entertainment" /></div>
        <div className="field"><label htmlFor="cm-label">Korte tekst op de kaart</label><input id="cm-label" maxLength={4} value={label} onChange={(e) => setLabel(e.target.value)} placeholder={name.slice(0, 3).toUpperCase() || 'ENT'} /></div>
        <div className="col" style={{ gap: 8 }}>
          <span className="muted" style={{ fontSize: 12 }}>Kleur</span>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            {CAT_COLORS.map((c) => <button key={c} aria-label={`Kleur ${c}`} onClick={() => setColor(c)} style={{ width: 30, height: 30, borderRadius: 9, border: c === color ? '2px solid #fff' : '2px solid transparent', background: c, cursor: 'pointer', padding: 0 }} />)}
          </div>
        </div>
        <div className="actions"><button className="btn" onClick={onClose}>Annuleren</button><button className="btn lime" disabled={!name.trim()} onClick={save}>Toevoegen</button></div>
      </div>
    </div>
  );
}
