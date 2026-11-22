import { useEffect, useRef, useState } from 'react';
import type { Feature, Position } from 'geojson';
import * as turf from '@turf/turf';
import { Icon } from '../icons';
import { useLibrary } from '../library';
import type { Facility, Layer, TimetableEntry, VectorKind } from '../types';
import { KIND_INFO, SEMI_SNAP_M, SHAPE_CATEGORIES, isVectorKind, isWalkableLayer, layerTakes, newId } from '../types';
import { fmtNum, formatDistance, formatWalkingTime, shapeSize } from '../geo';
import { fileUrl } from '../api';
import type { MaskOp, Pick, PickKind, RunResult } from '../vectorize';
import type { RouteResult } from '../routing';
import { Toggle } from './LayerPanel';

export interface PlaceState { category: string; mode: 'point' | 'trace'; attachTo?: string }
export type VecTarget = { type: 'active' } | { type: 'layer'; id: string } | { type: 'new'; kind: VectorKind };
export interface RouteState { mode: 'ab' | 'near'; start: Position | null; end: Position | null; category: string }

/** Days in the order they first appear; acts within a day by start time. */
function groupTimetable(tt: TimetableEntry[]): [string, TimetableEntry[]][] {
  const days: string[] = [];
  for (const t of tt) if (!days.includes(t.day.trim())) days.push(t.day.trim());
  return days.map((d) => [d, tt.filter((t) => t.day.trim() === d).sort((a, b) => a.start.localeCompare(b.start))]);
}
const DAY_SUGGESTIONS = ['donderdag', 'vrijdag', 'zaterdag', 'zondag', 'maandag'];

export function FacilityCard({ facility: f, pid, locked, onChange, onDelete, navAdding, onNavAdd, onNavRemove, onTrace, onPhoto }: {
  facility: Facility;
  pid: string;
  navAdding: boolean;
  onNavAdd: () => void;
  onNavRemove: (i: number) => void;
  onTrace: () => void;
  onPhoto: (file: File) => void;
  locked: boolean;
  onChange: (patch: Partial<Facility>, history?: boolean) => void;
  onDelete: () => void;
}) {
  const { lib } = useLibrary();
  const cat = lib.categories.find((c) => c.id === f.category);
  const [editing, setEditing] = useState(!f.name && !locked);
  const photoInput = useRef<HTMLInputElement>(null);
  const tt = f.timetable ?? [];
  const size = f.shape ? shapeSize(f.shape) : null;
  const showPlanning = editing || tt.length > 0 || f.category === 'podium';
  const setTT = (next: TimetableEntry[]) => onChange({ timetable: next }, false);
  const lastDay = tt.length ? tt[tt.length - 1].day : 'vrijdag';
  return (
    <div className="card right-card">
      {f.photo ? (
        <div className="fac-photo">
          <img src={fileUrl(pid, f.photo)} alt={f.name ? `Foto van ${f.name}` : 'Foto'} />
          {editing && (
            <div className="row fac-photo-actions">
              <button className="btn sm" onClick={() => photoInput.current?.click()}><Icon name="image" size={15} />Andere foto</button>
              <button className="btn sm" onClick={() => onChange({ photo: undefined })}>Weghalen</button>
            </div>
          )}
        </div>
      ) : editing ? (
        <button className="fac-photo empty" onClick={() => photoInput.current?.click()}><Icon name="image" size={22} /><span>Foto toevoegen</span></button>
      ) : null}
      <input ref={photoInput} type="file" accept="image/jpeg,image/png,image/webp,image/gif" style={{ display: 'none' }} onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ''; if (file) onPhoto(file); }} />

      <div className="row" style={{ gap: 12 }}>
        <div style={{ width: 38, height: 38, borderRadius: 11, background: cat?.color ?? '#F5B84A', color: '#0C0D0E', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 800, flexShrink: 0 }}>
          {f.category === 'podium' ? <Icon name="stage" size={18} stroke={2} /> : cat?.label}
        </div>
        <div className="col grow" style={{ gap: 0, minWidth: 0 }}>
          <span style={{ fontSize: 17, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.name || <span className="faint">Naamloos</span>}</span>
          <span className="muted" style={{ fontSize: 12 }}>{cat?.name ?? f.category}{locked ? ' · vergrendeld' : ''}</span>
        </div>
        {!locked && (
          <button className={`btn sm ${editing ? 'lime' : ''}`} onClick={() => setEditing(!editing)}>
            <Icon name={editing ? 'check' : 'edit'} size={15} />{editing ? 'Klaar' : 'Bewerken'}
          </button>
        )}
      </div>

      {editing ? (
        <>
          <div className="field"><label htmlFor="fc-name">Naam</label><input id="fc-name" autoFocus={!f.name} value={f.name} placeholder={`Bijv. ${cat?.id === 'podium' ? 'Area 5 · BUD x KAS' : cat?.name ?? ''}`} onChange={(e) => onChange({ name: e.target.value }, false)} /></div>
          <div className="field">
            <label htmlFor="fc-cat">Soort</label>
            <select id="fc-cat" value={f.category} onChange={(e) => onChange({ category: e.target.value })}>
              {lib.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div className="field"><label htmlFor="fc-info">Info</label><textarea id="fc-info" rows={3} value={f.notes} placeholder="Wat bezoekers hier moeten weten" onChange={(e) => onChange({ notes: e.target.value }, false)} /></div>
        </>
      ) : f.notes ? (
        <p style={{ margin: 0, fontSize: 14, lineHeight: 1.45, whiteSpace: 'pre-wrap' }}>{f.notes}</p>
      ) : null}

      {showPlanning && (
        <div className="col" style={{ gap: 8 }}>
          <span className="eyebrow">Planning</span>
          {editing ? (
            <>
              <datalist id="tt-days">{DAY_SUGGESTIONS.map((d) => <option key={d} value={d} />)}</datalist>
              {tt.map((t) => {
                const set = (patch: Partial<TimetableEntry>) => setTT(tt.map((x) => (x.id === t.id ? { ...x, ...patch } : x)));
                return (
                  <div key={t.id} className="tt-edit">
                    <input className="input" list="tt-days" value={t.day} aria-label="Dag" onChange={(e) => set({ day: e.target.value })} />
                    <input className="input" type="time" value={t.start} aria-label="Begin" onChange={(e) => set({ start: e.target.value })} />
                    <input className="input" type="time" value={t.end} aria-label="Eind" onChange={(e) => set({ end: e.target.value })} />
                    <button className="icon-btn" aria-label="Weghalen" onClick={() => setTT(tt.filter((x) => x.id !== t.id))}><Icon name="close" size={14} /></button>
                    <input className="input act" value={t.act} placeholder="Artiest of programma" aria-label="Artiest" onChange={(e) => set({ act: e.target.value })} />
                  </div>
                );
              })}
              <button className="btn sm" onClick={() => {
                const prev = tt[tt.length - 1];
                setTT([...tt, { id: newId(), day: lastDay, start: prev?.end ?? '', end: '', act: '' }]);
              }}><Icon name="plus" size={15} />Optreden</button>
            </>
          ) : tt.length ? (
            groupTimetable(tt).map(([day, acts]) => (
              <div key={day} className="col" style={{ gap: 2 }}>
                <span className="muted" style={{ fontSize: 12, fontWeight: 600, textTransform: 'capitalize' }}>{day || 'Zonder dag'}</span>
                {acts.map((t) => (
                  <div key={t.id} className="tt-row">
                    <span className="tt-time">{t.start || '··'}{t.end ? `–${t.end}` : ''}</span>
                    <span>{t.act || <span className="faint">—</span>}</span>
                  </div>
                ))}
              </div>
            ))
          ) : (
            <span className="faint" style={{ fontSize: 13 }}>Nog geen planning. Voeg optredens toe via Bewerken.</span>
          )}
        </div>
      )}

      <details className="fac-map" open={editing}>
        <summary className="eyebrow">Op de kaart</summary>
        <div className="col" style={{ gap: 10, paddingTop: 10 }}>
          <div className="prop">
            <span className="k">Vorm</span>
            <span>{size ? `overgetrokken · ${fmtNum(size.w, 0)} × ${fmtNum(size.h, 0)} m` : 'punt'}</span>
          </div>
          <div className="row" style={{ gap: 6 }}>
            <button className="btn sm grow" disabled={locked} onClick={onTrace} title="Klik de hoeken van de vorm op de luchtfoto of plattegrond">
              <Icon name="polygon" size={15} />{size ? 'Opnieuw overtrekken' : 'Vorm overtrekken'}
            </button>
            {size && <button className="btn sm" disabled={locked} onClick={() => onChange({ shape: undefined })}>Alleen punt</button>}
          </div>
          {size && !locked && <span className="faint" style={{ fontSize: 12 }}>Sleep het pictogram om te verplaatsen. Draaien: sleep de witte stip, of druk R / ⇧R.</span>}
          <span className="muted" style={{ fontSize: 13 }}>Navigatiepunten</span>
          <span className="faint" style={{ fontSize: 12, marginTop: -6 }}>Waar routes hierheen eindigen, bijvoorbeeld midden in het publiek. Zonder punt: het midden.</span>
          {(f.nav ?? []).map((o, i) => (
            <div key={i} className="prop">
              <span className="row" style={{ gap: 8 }}><span style={{ width: 18, height: 18, borderRadius: 5, border: `2px solid ${cat?.color ?? '#F5B84A'}`, color: cat?.color, fontSize: 10, fontWeight: 700, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>{i + 1}</span>{fmtNum(Math.hypot(o.x, o.y), 0)} m van het midden</span>
              <button className="icon-btn" disabled={locked} aria-label={`Navigatiepunt ${i + 1} verwijderen`} onClick={() => onNavRemove(i)}><Icon name="close" size={14} /></button>
            </div>
          ))}
          <button className={`btn sm ${navAdding ? 'lime' : ''}`} disabled={locked} onClick={onNavAdd}><Icon name={navAdding ? 'check' : 'flag'} size={15} />{navAdding ? 'Klaar met punten plaatsen' : '+ Navigatiepunt'}</button>
          <button className="btn danger sm" disabled={locked} onClick={onDelete}><Icon name="trash" size={15} />Voorziening verwijderen</button>
        </div>
      </details>
    </div>
  );
}

export function FeatureCard({ feature, layer, layers, onProps, onDelete, onToTop, onShapeTo }: {
  feature: Feature; layer: Layer; layers: Layer[];
  onProps: (p: Record<string, any>) => void; onDelete: () => void; onToTop: () => void;
  onShapeTo: (how: 'move' | 'hole' | 'rings' | 'close', target?: string) => void;
}) {
  const g = feature.geometry;
  const isPoly = g.type === 'Polygon';
  const hole = !!feature.properties?.hole;
  const rings = isPoly ? (g as any).coordinates.length - 1 : 0;
  // Layers this shape can go to: vector layers that hold its kind of geometry and aren't locked.
  const fits = layers.filter((l) => isVectorKind(l.kind) && !l.locked && (isPoly ? layerTakes(l.kind).polys : layerTakes(l.kind).lines));
  const others = fits.filter((l) => l.id !== layer.id);
  const polyLayers = layers.filter((l) => isVectorKind(l.kind) && !l.locked && layerTakes(l.kind).polys && l.id !== layer.id);
  const layerSelect = (id: string, label: string, list: Layer[], placeholder: string, run: (lid: string) => void) => (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} className="input" value="" onChange={(e) => { if (e.target.value) run(e.target.value); }} disabled={!list.length}>
        <option value="">{list.length ? placeholder : 'geen andere laag met vlakken'}</option>
        {list.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
      </select>
    </div>
  );
  const measure = isPoly ? `${fmtNum(turf.area(feature), 0)} m²` : `${fmtNum(turf.length(feature, { units: 'meters' }), 0)} m`;
  const kindLabel = layer.kind === 'beloopbaar' || (layer.kind === 'eigen' && layer.walkable) ? (isPoly ? (hole ? 'Gat (niet beloopbaar)' : 'Open gebied') : 'Pad') : layer.kind === 'semi' && !hole ? 'Semi-beloopbaar gebied' : isPoly ? (hole ? 'Gat' : 'Vlak') : 'Lijn';
  return (
    <div className="card right-card">
      <div className="row" style={{ gap: 12 }}>
        <div style={{ width: 38, height: 38, borderRadius: 11, background: hole ? 'rgba(255,107,107,.18)' : layer.style.color, color: hole ? 'var(--danger)' : '#0C0D0E', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <Icon name={isPoly ? (hole ? 'hole' : 'polygon') : 'line'} size={18} stroke={2} />
        </div>
        <div className="col grow" style={{ gap: 0 }}>
          <span style={{ fontSize: 16, fontWeight: 600 }}>{kindLabel}</span>
          <span className="muted" style={{ fontSize: 12 }}>{layer.name} · {measure}</span>
        </div>
      </div>
      {isPoly && KIND_INFO[layer.kind].geom.includes('vlak') && (
        <Toggle label="Gat" desc="Wordt uit de andere vlakken van deze laag gesneden" on={hole} onFlip={() => onProps({ hole: !hole })} />
      )}
      <div className="field">
        <label htmlFor="ff-layer">Laag</label>
        <select id="ff-layer" className="input" value={layer.id} onChange={(e) => { if (e.target.value !== layer.id) onShapeTo('move', e.target.value); }}>
          {fits.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          {!fits.some((l) => l.id === layer.id) && <option value={layer.id}>{layer.name}</option>}
        </select>
        {!others.length && <span className="faint" style={{ fontSize: 12 }}>Er is geen andere laag die {isPoly ? 'vlakken' : 'lijnen'} kan bevatten.</span>}
      </div>
      {isPoly && hole && layerSelect('ff-hole', 'Vlak van dit gat maken in', polyLayers, 'Kies een laag…', (lid) => onShapeTo('hole', lid))}
      {isPoly && hole && <span className="faint" style={{ fontSize: 12, marginTop: -6 }}>Het gat blijft hier; in de gekozen laag komt een vlak met precies dezelfde rand.</span>}
      {isPoly && !hole && rings > 0 && (
        <>
          {layerSelect('ff-rings', `${rings === 1 ? 'Het gat' : `De ${rings} gaten`} in dit vlak als vlak in`, polyLayers, 'Kies een laag…', (lid) => onShapeTo('rings', lid))}
          <button className="btn sm" onClick={() => onShapeTo('close')} title="Haalt de gaten uit dit vlak weg, zodat het vlak dicht is">{rings === 1 ? 'Gat dichten' : 'Gaten dichten'}</button>
        </>
      )}
      {isPoly && !hole && <button className="btn sm" onClick={onToTop} title="Legt dit vlak bovenop: gaten die eerder getekend zijn snijden het dan niet meer">Bovenop leggen</button>}
      {layer.kind === 'semi' && !hole && (
        <div className="field">
          <label htmlFor="ff-snap">GPS springt naar pad binnen (m)</label>
          <input id="ff-snap" type="number" min={0} step={0.5} placeholder={`${fmtNum(layer.snapM ?? SEMI_SNAP_M)} (van de laag)`} defaultValue={feature.properties?.snap_m ?? ''} key={String(feature.id) + 'snap'}
            onBlur={(e) => { const v = e.target.value === '' ? '' : Number(e.target.value); if ((feature.properties?.snap_m ?? '') !== v) onProps({ snap_m: v }); }} />
        </div>
      )}
      <div className="field"><label htmlFor="ff-name">Naam</label><input id="ff-name" defaultValue={feature.properties?.name ?? ''} key={String(feature.id) + 'name'} placeholder="optioneel"
        onBlur={(e) => { if ((feature.properties?.name ?? '') !== e.target.value) onProps({ name: e.target.value }); }} /></div>
      {layer.fields.length > 0 && <span className="eyebrow">Eigenschappen</span>}
      {layer.fields.map((fd) => (
        <div key={fd.name} className="field">
          <label htmlFor={`ff-${fd.name}`}>{fd.name}</label>
          <input id={`ff-${fd.name}`} type={fd.type === 'getal' ? 'number' : 'text'} defaultValue={feature.properties?.[fd.name] ?? ''} key={String(feature.id) + fd.name}
            onBlur={(e) => { if ((feature.properties?.[fd.name] ?? '') !== e.target.value) onProps({ [fd.name]: fd.type === 'getal' && e.target.value !== '' ? Number(e.target.value) : e.target.value }); }} />
        </div>
      ))}
      {!layer.fields.length && <span className="faint" style={{ fontSize: 12 }}>Eigen velden voor deze laag voeg je toe bij Laageigenschappen → Eigenschappen.</span>}
      <span className="faint" style={{ fontSize: 12 }}>Sleep hoekpunten om te wijzigen; klik een middenpunt om een punt toe te voegen; Backspace verwijdert de vorm.</span>
      <button className="btn danger sm" onClick={onDelete}><Icon name="trash" size={15} />Verwijderen</button>
    </div>
  );
}

export function PlaceCard({ state, setState, locked, onNewCategory, attachName }: { state: PlaceState; setState: (s: PlaceState) => void; locked: boolean; onNewCategory: () => void; attachName?: string }) {
  const { lib } = useLibrary();
  const cat = lib.categories.find((c) => c.id === state.category);
  const pick = (category: string) => setState({ category, mode: SHAPE_CATEGORIES.includes(category) ? 'trace' : 'point', attachTo: undefined });
  return (
    <div className="card right-card" style={{ width: 380 }}>
      <span style={{ fontSize: 16, fontWeight: 600 }}>Voorziening plaatsen</span>
      {locked && <span style={{ color: 'var(--warn)', fontSize: 13 }}>De laag Voorzieningen is vergrendeld.</span>}
      {attachName && state.mode === 'trace' ? (
        <div className="row" style={{ padding: '10px 12px', borderRadius: 12, background: 'var(--tile)', fontSize: 14 }}>
          <Icon name="polygon" size={16} /><span className="grow">Vorm overtrekken voor <b>{attachName}</b></span>
          <button className="link muted" onClick={() => setState({ ...state, mode: 'point', attachTo: undefined })}>Annuleren</button>
        </div>
      ) : (
        <>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            {lib.categories.map((c) => (
              <button key={c.id} className={`chip ${c.id === state.category ? 'on' : ''}`} onClick={() => pick(c.id)}><span className="dot" style={{ background: c.color }} />{c.name}</button>
            ))}
            <button className="chip dashed" onClick={onNewCategory}>+ Eigen categorie</button>
          </div>
          <div className="grid2" style={{ gap: 8 }}>
            <button className={`opt ${state.mode === 'point' ? 'on' : ''}`} onClick={() => setState({ ...state, mode: 'point', attachTo: undefined })}><span className="t">Punt</span><span className="d">Eén klik, bijv. een nooduitgang</span></button>
            <button className={`opt ${state.mode === 'trace' ? 'on' : ''}`} onClick={() => setState({ ...state, mode: 'trace' })}><span className="t">Vorm overtrekken</span><span className="d">Klik de hoeken, bijv. een podium</span></button>
          </div>
        </>
      )}
      <span className="muted" style={{ fontSize: 13 }}>
        {state.mode === 'trace'
          ? `Klik de hoeken van ${cat?.name.toLowerCase() === 'podium' ? 'het podium' : 'de vorm'} op de luchtfoto of plattegrond en klik het eerste punt om af te ronden. Het pictogram komt in het midden.`
          : 'Klik op de kaart om te plaatsen. Daarna kun je naam, info, foto en planning invullen.'}
      </span>
    </div>
  );
}

export function RouteCard({ state, setState, result, facilities, gps }: { state: RouteState; setState: (s: RouteState) => void; result: { res: RouteResult | null; target?: Facility; failed: boolean } | null; facilities: Facility[]; gps: { snapped: boolean; semi: boolean; snapM: number } | null }) {
  const { lib } = useLibrary();
  const counts = new Map<string, number>();
  for (const f of facilities) counts.set(f.category, (counts.get(f.category) ?? 0) + 1);
  const targetCat = lib.categories.find((c) => c.id === state.category);
  const res = result?.res;
  useEffect(() => {
    if (state.mode === 'near' && !counts.get(state.category)) {
      const first = lib.categories.find((c) => counts.get(c.id));
      if (first) setState({ ...state, category: first.id });
    }
  }, [state.mode, state.category, facilities.length]);
  return (
    <div className="card right-card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span style={{ fontSize: 16, fontWeight: 600 }}>Route testen</span>
        <div className="seg-group">
          <button className={`seg ${state.mode === 'ab' ? 'on' : ''}`} onClick={() => setState({ ...state, mode: 'ab', end: null })}>A → B</button>
          <button className={`seg ${state.mode === 'near' ? 'on' : ''}`} onClick={() => setState({ ...state, mode: 'near' })}>Dichtstbijzijnde</button>
        </div>
      </div>
      <div className="col" style={{ gap: 8, fontSize: 14 }}>
        <div className="row"><span className="dot" style={{ background: 'var(--lime)' }} />{state.start ? 'Start gezet' : <span className="muted">Klik op de kaart voor het startpunt</span>}</div>
        {state.mode === 'ab' && <div className="row"><span className="dot" style={{ background: 'var(--text)', borderRadius: 3 }} />{state.end ? 'Bestemming gezet' : <span className="muted">{state.start ? 'Klik op de kaart voor de bestemming' : 'Daarna de bestemming'}</span>}</div>}
        {state.mode === 'near' && (
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            {lib.categories.map((c) => (
              <button key={c.id} className={`chip ${state.category === c.id ? 'on' : ''}`} style={{ height: 32 }} disabled={!counts.get(c.id)} title={counts.get(c.id) ? undefined : 'Geen voorzieningen van deze soort op de kaart'}
                onClick={() => setState({ ...state, category: c.id })}>
                <span className="dot" style={{ width: 8, height: 8, background: c.color }} />{c.name}
              </button>
            ))}
          </div>
        )}
      </div>
      {result && (
        res ? (
          <div className="row" style={{ gap: 14, padding: 14, borderRadius: 14, background: 'var(--tile)' }}>
            <span style={{ fontSize: 30, fontWeight: 600 }}>{formatDistance(res.length).replace(/ (m|km)$/, '')}<span className="faint"> {formatDistance(res.length).endsWith('km') ? 'km' : 'm'}</span></span>
            <span style={{ padding: '4px 10px', borderRadius: 8, background: 'rgba(212,245,106,.14)', color: 'var(--lime)', fontSize: 13, fontWeight: 600 }}>± {formatWalkingTime(res.length)}</span>
            <span className="muted grow" style={{ fontSize: 12, textAlign: 'right' }}>{state.mode === 'ab' ? 'naar punt B' : `naar ${result.target?.name || `dichtstbijzijnde ${targetCat?.name ?? ''}`}`}</span>
          </div>
        ) : (
          <div className="row" style={{ padding: 14, borderRadius: 14, background: 'rgba(255,107,107,.1)', color: '#FFB4B4', fontSize: 14 }}>
            <Icon name="warn" size={18} />{state.mode === 'near' && !counts.get(state.category) ? `Geen ${targetCat?.name ?? 'voorzieningen'} op de kaart` : 'Geen route — niet verbonden'}
          </div>
        )
      )}
      {gps && state.start && (
        <div className="row" style={{ gap: 8, fontSize: 12 }}>
          <span className="dot" style={{ background: '#3B82F6' }} />
          <span className="muted">GPS-stip bij de start: {gps.snapped ? `springt naar het pad (binnen ${fmtNum(gps.snapM)} m${gps.semi ? ', semi-beloopbaar' : ''})` : gps.semi ? `blijft staan (semi-beloopbaar, pas binnen ${fmtNum(gps.snapM)} m naar een pad)` : gps.snapM === 0 ? 'blijft staan (open gebied)' : 'blijft staan (geen pad binnen 5 m)'}</span>
        </div>
      )}
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="faint" style={{ fontSize: 12 }}>Zelfde regels als de app: paden + beloopbare vlakken, 5 km/u.</span>
        {state.start && <button className="link muted" onClick={() => setState({ ...state, start: null, end: null })}>Wissen</button>}
      </div>
    </div>
  );
}

export function DrawCard({ tool, layer, snapping, setSnapping, snapPx, setSnapPx, holeWalkable, setHoleWalkable, cutBelow, setCutBelow }: {
  tool: 'line' | 'polygon' | 'rect' | 'hole'; layer: Layer | null; snapping: boolean; setSnapping: (v: boolean) => void; snapPx: number; setSnapPx: (v: number) => void;
  holeWalkable: boolean; setHoleWalkable: (v: boolean) => void; cutBelow: boolean; setCutBelow: (v: boolean) => void;
}) {
  const titles = { line: 'Lijn tekenen', polygon: 'Vlak tekenen', rect: 'Rechthoek tekenen', hole: 'Gat uitsnijden' };
  const hints: Record<string, string> = {
    beloopbaar: 'Lijn = pad · Vlak = open gebied · Gat = niet beloopbaar',
    semi: 'Vlakken waar je kunt zijn, maar waar routes niet doorheen gaan',
    hekken: 'Lijnen worden als hek getekend',
    water: 'Vlakken, alleen weergave', bos: 'Vlakken, alleen weergave', zand: 'Vlakken, alleen weergave',
    eigen: 'Lijnen en vlakken',
  };
  const isVector = layer && isVectorKind(layer.kind);
  const noLines = tool === 'line' && layer && !layerTakes(layer.kind).lines;
  const walk = !!layer && isWalkableLayer(layer);
  const noPolys = tool !== 'line' && layer?.kind === 'hekken';
  return (
    <div className="card right-card" style={{ width: 320 }}>
      <span style={{ fontSize: 16, fontWeight: 600 }}>{titles[tool]}</span>
      {!isVector ? (
        <span style={{ color: 'var(--warn)', fontSize: 13 }}>Kies links een tekenlaag (Beloopbaar, Water, Bos, Zand, Hekken of een eigen laag).</span>
      ) : layer!.locked ? (
        <span style={{ color: 'var(--warn)', fontSize: 13 }}>Deze laag is vergrendeld. Zet dat uit bij Laageigenschappen → Gedrag.</span>
      ) : (
        <>
          <div className="row" style={{ padding: '10px 12px', borderRadius: 12, background: 'var(--tile)', fontSize: 14 }}>
            <span className="swatch" style={{ width: 12, height: 12, borderRadius: 4, background: layer!.style.color }} />
            <span className="grow">Laag: {layer!.name}</span>
            <span className="muted" style={{ fontSize: 12 }}>wijzig links</span>
          </div>
          {noLines && <span style={{ color: 'var(--warn)', fontSize: 13 }}>Deze laag heeft alleen vlakken.</span>}
          {noPolys && <span style={{ color: 'var(--warn)', fontSize: 13 }}>Hekken zijn lijnen; kies Lijn tekenen.</span>}
          <span className="muted" style={{ fontSize: 13 }}>{tool === 'hole' ? 'Teken een vlak dat uit de vlakken van deze laag wordt gesneden (bijvoorbeeld een podium uit een veld).' : hints[layer!.kind]}</span>
          {tool === 'hole' && !walk && <Toggle label="Uitsnede beloopbaar maken" desc="Bijvoorbeeld een eiland: het gat komt ook als open gebied in Beloopbaar" on={holeWalkable} onFlip={() => setHoleWalkable(!holeWalkable)} />}
          {(tool === 'polygon' || tool === 'rect') && walk && <Toggle label="Uitsnijden uit water en geblokkeerd" desc="Waar dit vlak over water of een niet-beloopbare eigen laag valt, wordt het daar weggesneden" on={cutBelow} onFlip={() => setCutBelow(!cutBelow)} />}
          {tool !== 'rect' && <Toggle label="Snappen" desc="Aan hoekpunten en lijnen in deze laag, zodat paden echt verbinden" on={snapping} onFlip={() => setSnapping(!snapping)} />}
          {tool !== 'rect' && snapping && <SnapSlider px={snapPx} setPx={setSnapPx} />}
        </>
      )}
    </div>
  );
}

export function SnapSlider({ px, setPx }: { px: number; setPx: (v: number) => void }) {
  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <label htmlFor="snap-px" className="muted" style={{ fontSize: 12 }}>Snapafstand <span className="kbd">[</span> <span className="kbd">]</span></label>
        <span style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>{px} px</span>
      </div>
      <input type="range" id="snap-px" min={2} max={80} value={px} onChange={(e) => setPx(Number(e.target.value))} />
      <span className="faint" style={{ fontSize: 12 }}>In schermpixels: ver ingezoomd is dat maar een paar centimeter. De stippelcirkel bij de cursor laat het zien.</span>
    </div>
  );
}

export function FillCard({ layer, gap, setGap }: { layer: Layer | null; gap: number; setGap: (v: number) => void }) {
  const ok = layer && isVectorKind(layer.kind) && layerTakes(layer.kind).polys && !layer.locked;
  return (
    <div className="card right-card" style={{ width: 320 }}>
      <span style={{ fontSize: 16, fontWeight: 600 }}>Ingesloten vlak vullen</span>
      {ok ? (
        <div className="row" style={{ padding: '10px 12px', borderRadius: 12, background: 'var(--tile)', fontSize: 14 }}>
          <span className="swatch" style={{ width: 12, height: 12, borderRadius: 4, background: layer!.style.color }} />
          <span className="grow">Naar laag: {layer!.name}</span>
          <span className="muted" style={{ fontSize: 12 }}>wijzig links</span>
        </div>
      ) : (
        <span style={{ color: 'var(--warn)', fontSize: 13 }}>{layer?.locked ? 'Deze laag is vergrendeld.' : 'Kies links een laag met vlakken: Beloopbaar, Semi-beloopbaar, Water, Bos, Zand of een eigen laag.'}</span>
      )}
      <span className="muted" style={{ fontSize: 13 }}>Klik binnen een gebied dat rondom is afgesloten door paden, vlakken of voorzieningen (uit alle zichtbare lagen). Het nieuwe vlak gebruikt precies de punten van die randen, dus het sluit aan op de paden. Vormen erbinnen worden gaten.</span>
      <div className="col" style={{ gap: 6 }}>
        <div className="row" style={{ justifyContent: 'space-between' }}><label htmlFor="fill-gap" className="muted" style={{ fontSize: 12 }}>Gaten dichten tot</label><span style={{ fontSize: 13 }}>{fmtNum(gap)} m</span></div>
        <input type="range" id="fill-gap" min={0} max={10} step={0.5} value={gap} onChange={(e) => setGap(Number(e.target.value))} />
        <span className="faint" style={{ fontSize: 12 }}>Een pad dat net niet aansluit, telt toch als rand. Alleen voor het vullen; de paden zelf blijven zoals ze zijn.</span>
      </div>
    </div>
  );
}

export type VecClick = 'area' | 'pick' | 'exclude' | 'fill' | 'add' | 'cut' | 'line';
export interface VecState {
  sourceId: string | null;
  res: number; // aerial: metres per pixel (a plan is always looked at in full)
  area: Position[] | null; // where to search (lon/lat ring); null = the whole plan
  picks: Pick[];
  ops: MaskOp[];
  click: VecClick;
  scope: 'connected' | 'all';
  reach: number;
  smooth: number;
  bright: number; // −100..100
  contrast: number; // −100..100
  sat: number; // %
  showPrep: boolean;
  bridge: number;
  speck: number;
  holes: number;
  output: 'polygon' | 'line';
  simplify: number;
  minLength: number;
  name: string;
  target: VecTarget;
}
export const VEC_DEFAULTS: VecState = {
  sourceId: null, res: 0.5, area: null, picks: [], ops: [], click: 'area', scope: 'all', reach: 4, smooth: 0, bright: 0, contrast: 0, sat: 100, showPrep: false, bridge: 0.5,
  speck: 4, holes: 4, output: 'polygon', simplify: 0.4, minLength: 3, name: '', target: { type: 'active' },
};

function Step({ n, title, children, open: initial = true }: { n: number; title: string; children: React.ReactNode; open?: boolean }) {
  return (
    <details open={initial} className="vec-step">
      <summary><span className="vec-n">{n}</span>{title}</summary>
      <div className="col" style={{ gap: 10, paddingTop: 10 }}>{children}</div>
    </details>
  );
}

export function VecCard({ state, setState, sources, layers, active, result, busy, mpp, drafting, onFinishDraft, onUndo, onAdd, onClear, onRemovePick }: {
  state: VecState;
  setState: (p: Partial<VecState>) => void;
  sources: Layer[];
  layers: Layer[];
  active: Layer | null;
  result: RunResult | null;
  busy: string | null;
  mpp: number | null;
  drafting: number;
  onFinishDraft: () => void;
  onUndo: () => void;
  onAdd: () => void;
  onClear: () => void;
  onRemovePick: (i: number) => void;
}) {
  const want = state.output === 'line' ? 'lines' : 'polys';
  const fits = (l: Layer) => isVectorKind(l.kind) && layerTakes(l.kind)[want];
  const targets = layers.filter(fits);
  const newKinds: VectorKind[] = state.output === 'line' ? ['beloopbaar', 'hekken', 'eigen'] : ['beloopbaar', 'semi', 'water', 'bos', 'zand', 'eigen'];
  const tv = state.target.type === 'active' ? 'active' : state.target.type === 'layer' ? `L:${state.target.id}` : `N:${state.target.kind}`;
  const activeOk = !!active && fits(active);
  const n = result?.features.length ?? 0;
  const src = sources.find((l) => l.id === state.sourceId);
  const slider = (id: string, label: string, val: string, min: number, max: number, step: number, v: number, set: (v: number) => void, help?: string) => (
    <div className="col" style={{ gap: 4 }}>
      <div className="row" style={{ justifyContent: 'space-between' }}><label htmlFor={id} className="muted" style={{ fontSize: 12 }}>{label}</label><span style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>{val}</span></div>
      <input type="range" id={id} min={min} max={max} step={step} value={v} onChange={(e) => set(Number(e.target.value))} />
      {help && <span className="faint" style={{ fontSize: 11.5 }}>{help}</span>}
    </div>
  );
  const kindName: Record<PickKind, string> = { pick: 'pakken', exclude: 'uitsluiten' };
  const kindColor: Record<PickKind, string> = { pick: 'var(--lime)', exclude: 'var(--danger)' };
  const clickBtn = (c: VecClick, label: string, title: string) => (
    <button className={`seg ${state.click === c ? 'on' : ''}`} onClick={() => setState({ click: c })} title={title}>{label}</button>
  );
  if (!sources.length) return (
    <div className="card right-card" style={{ width: 360 }}>
      <span style={{ fontSize: 16, fontWeight: 600 }}>Vectoriseren op kleur</span>
      <span style={{ color: 'var(--warn)', fontSize: 13 }}>Er is nog geen beeldlaag. Voeg een luchtfoto of een gegeorefereerde plattegrond toe.</span>
    </div>
  );
  return (
    <div className="card right-card scroll" style={{ width: 360, bottom: 20, maxHeight: 'none' }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span style={{ fontSize: 16, fontWeight: 600 }}>Vectoriseren op kleur</span>
        {busy ? <span className="row muted" style={{ gap: 6, fontSize: 12 }}><span className="spinner" />{busy}</span> : mpp != null ? <span className="faint" style={{ fontSize: 12 }}>1 px = {fmtNum(mpp, 2)} m</span> : null}
      </div>

      <Step n={1} title="Wat en waarvan">
        <div className="field">
          <label htmlFor="vec-src">Van</label>
          <select id="vec-src" value={state.sourceId ?? ''} onChange={(e) => setState({ sourceId: e.target.value })}>
            {sources.map((l) => <option key={l.id} value={l.id}>{l.name}{l.visible ? '' : ' (verborgen)'}</option>)}
          </select>
        </div>
        <div className="col" style={{ gap: 6 }}>
          <span className="muted" style={{ fontSize: 12 }}>Gebied</span>
          <div className="seg-group">
            <button className={`seg ${state.click === 'area' ? 'on' : ''}`} onClick={() => setState({ click: 'area' })} title="Klik punten rond het gebied waarin gezocht moet worden">{state.area ? 'Nieuw gebied tekenen' : 'Gebied tekenen'}</button>
            {src?.kind === 'image' && <button className={`seg ${!state.area && state.click !== 'area' ? 'on' : ''}`} onClick={() => setState({ area: null, picks: [], ops: [], click: 'pick' })} title="De hele plattegrond (als die niet te groot is)">Hele plattegrond</button>}
          </div>
          <span className="faint" style={{ fontSize: 11.5 }}>
            {state.click === 'area'
              ? 'Klik punten rond het gebied; klik het eerste punt of ↵ om af te ronden. Alleen binnen dit gebied wordt gezocht, op volle scherpte, hoe ver je ook in- of uitzoomt.'
              : state.area
                ? 'Er wordt alleen binnen de witte stippellijn gezocht, op volle scherpte.'
                : 'De hele plattegrond op volle scherpte. Te groot? Teken dan een gebied.'}
          </span>
        </div>
        <div className="col" style={{ gap: 4 }}>
          <span className="muted" style={{ fontSize: 12 }}>Pakken</span>
          <div className="seg-group">
            <button className={`seg ${state.scope === 'all' ? 'on' : ''}`} onClick={() => setState({ scope: 'all' })} title="Alles in het gebied met deze kleur">Alles in het gebied</button>
            <button className={`seg ${state.scope === 'connected' ? 'on' : ''}`} onClick={() => setState({ scope: 'connected' })} title="Alleen wat vastzit aan waar je klikt">Alleen aangeklikt stuk</button>
          </div>
        </div>
        {src?.kind === 'pdok' && (
          <div className="col" style={{ gap: 4 }}>
            <span className="muted" style={{ fontSize: 12 }}>Detail luchtfoto</span>
            <div className="seg-group">
              {[[1, 'Grof · 1 m'], [0.5, 'Normaal · 0,5 m'], [0, 'Fijn · 0,25 m']].map(([v, l]) => (
                <button key={String(v)} className={`seg ${state.res === v ? 'on' : ''}`} onClick={() => setState({ res: v as number })}>{l}</button>
              ))}
            </div>
          </div>
        )}
      </Step>

      <Step n={2} title="Beeld bewerken (voor de computer)">
        {slider('vec-bright', 'Helderheid', `${state.bright > 0 ? '+' : ''}${state.bright}`, -100, 100, 5, state.bright, (v) => setState({ bright: v }))}
        {slider('vec-contrast', 'Contrast', `${state.contrast > 0 ? '+' : ''}${state.contrast}`, -100, 100, 5, state.contrast, (v) => setState({ contrast: v }))}
        {slider('vec-sat', 'Verzadiging', `${state.sat}%`, 0, 400, 10, state.sat, (v) => setState({ sat: v }), 'Hoger = kleuren feller en verder uit elkaar, bijv. lichtgroen tegen wit of grijs.')}
        {slider('vec-smooth', 'Gladstrijken', state.smooth ? `${state.smooth} px` : 'uit', 0, 4, 1, state.smooth, (v) => setState({ smooth: v }), 'Haalt korrel en ruis weg, maar houdt randen scherp. Luchtfoto: 2–3. Plattegrond: uit (anders verdwijnen dunne paadjes).')}
        {(state.bright !== 0 || state.contrast !== 0 || state.sat !== 100) && <button className="link muted" style={{ alignSelf: 'flex-start' }} onClick={() => setState({ bright: 0, contrast: 0, sat: 100 })}>Kleuren terugzetten</button>}
        <Toggle label="Toon wat de computer ziet" desc="Het bewerkte beeld zoals de computer het gebruikt. Wat bij een aangeklikte kleur hoort, staat erin in die kleur (roze = pakken)." on={state.showPrep} onFlip={() => setState({ showPrep: !state.showPrep })} />
      </Step>

      <Step n={3} title="Kleuren kiezen">
        <div className="seg-group">
          {clickBtn('pick', 'Pakken', 'Klik: deze kleur hoort erbij')}
          {clickBtn('exclude', 'Uitsluiten', 'Klik: deze kleur hoort er niet bij (⌥ klik)')}
        </div>
        {state.picks.length ? (
          <div className="col" style={{ gap: 4 }}>
            {state.picks.map((pk, i) => {
              const info = result?.picks[i];
              return (
                <div key={i} className="prop" style={{ padding: '6px 10px' }}>
                  <span className="row" style={{ gap: 8 }}>
                    <span className="swatch" style={{ width: 18, height: 18, borderRadius: 5, background: info?.hex ?? '#333', border: `2px solid ${kindColor[pk.kind]}` }} title="De aangeklikte kleur" />
                    <span style={{ fontSize: 13 }}>{kindName[pk.kind]}</span>
                    {info && !info.inside && <span className="faint" style={{ fontSize: 11.5 }}>buiten het beeld</span>}
                  </span>
                  <span className="row" style={{ gap: 6 }}>
                    {info?.inside && state.showPrep && <span className="swatch" style={{ width: 12, height: 12, borderRadius: 3, background: info.shown }} title="Zo staat deze kleur op ‘wat de computer ziet’" />}
                    <button className="icon-btn" aria-label="Weghalen" onClick={() => onRemovePick(i)}><Icon name="close" size={14} /></button>
                  </span>
                </div>
              );
            })}
          </div>
        ) : null}
        {!state.picks.some((p) => p.kind === 'exclude') && (
          <span className={state.picks.length ? '' : 'muted'} style={{ fontSize: 12.5, ...(state.picks.length ? { color: 'var(--warn)' } : {}) }}>
            {state.picks.length
              ? 'Tip: ⌥ klik nu ook wat ernaast ligt en er níet bij hoort (het pad, de rand, het bos). Dat maakt het meeste verschil: dan klopt het resultaat bij bijna elk bereik.'
              : 'Klik op wat je wilt hebben. Dan ⌥ klik op wat ernaast ligt en er niet bij hoort. Meer klikken mag (bijv. gras in zon én schaduw). Of teken meteen een vlak bij stap 5.'}
          </span>
        )}
        {slider('vec-reach', 'Bereik', fmtNum(state.reach, 1), 1, 12, 0.5, state.reach, (v) => setState({ reach: v }), 'Hoeveel een kleur mag afwijken van wat je aanklikte, gemeten aan de variatie die erin zit. Lager = strenger. Met een uitgesloten kleur maakt dit weinig uit.')}
        {state.scope === 'connected' && !!result?.others.count && (
          <div className="col" style={{ gap: 8, padding: 12, borderRadius: 12, background: 'rgba(255,79,216,.08)', border: '1px dashed rgba(255,79,216,.5)', fontSize: 13 }}>
            <span>
              <b>{result.others.count} {result.others.count === 1 ? 'stuk' : 'stukken'}</b> met dezelfde kleur ({fmtNum(result.others.areaM2, 0)} m²) {result.others.count === 1 ? 'valt' : 'vallen'} buiten het resultaat: ze raken het aangeklikte stuk niet.
            </span>
            <span className="muted" style={{ fontSize: 12 }}>Ze staan roze gestippeld op de kaart. Klik erin om ze mee te nemen. Zit er alleen een rasterlijn of tekst tussen? Zet <b>Overbruggen</b> (stap 4) hoger.</span>
            <button className="btn sm" onClick={() => setState({ scope: 'all' })}>Alles met deze kleur meenemen</button>
          </div>
        )}
      </Step>

      <Step n={4} title="Opschonen">
        {slider('vec-bridge', 'Overbruggen', state.bridge ? `${fmtNum(state.bridge, 2)} m` : 'uit', 0, 3, 0.25, state.bridge, (v) => setState({ bridge: v }), 'Springt over rasterlijnen, tekst en dunne lijntjes: de velden aan weerszijden worden één. Te hoog plakt ook velden aan elkaar die door een smal pad gescheiden zijn.')}
        {slider('vec-speck', 'Losse stukjes weg kleiner dan', `${state.speck} m²`, 0, 200, 1, state.speck, (v) => setState({ speck: v }))}
        {slider('vec-holes', 'Gaten opvullen kleiner dan', `${state.holes} m²`, 0, 500, 1, state.holes, (v) => setState({ holes: v }), 'Kleine obstakels (een boom, een tekstje) worden niet uitgesneden.')}
      </Step>

      <Step n={5} title="Bijwerken">
        <div className="seg-group" style={{ flexWrap: 'wrap' }}>
          {clickBtn('add', 'Bijtekenen', 'Teken een vlak dat er zeker bij hoort')}
          {clickBtn('cut', 'Wegknippen', 'Teken een vlak dat er zeker niet bij hoort')}
          {clickBtn('line', 'Snijlijn', 'Trek een lijn die het resultaat doorsnijdt, bijvoorbeeld tussen twee punten waar het weglekt')}
          {clickBtn('fill', 'Gat vullen', 'Klik in een gat om het op te vullen')}
        </div>
        <span className="faint" style={{ fontSize: 11.5 }}>
          {state.click === 'line' ? 'Klik punten; klik het laatste punt nog eens of ↵ om af te ronden.' : state.click === 'add' ? 'Klik punten rond wat erbij moet; klik het eerste punt of ↵ om af te ronden. Werkt ook zonder gekozen kleur.' : state.click === 'cut'  ? 'Klik punten; klik het eerste punt of ↵ om af te ronden.' : state.click === 'fill' ? 'Klik in een gat van het resultaat.' : 'Kies een gereedschap om het resultaat met de hand bij te werken.'}
        </span>
        <div className="row" style={{ gap: 6 }}>
          {drafting > 0 && <button className="btn sm lime" onClick={onFinishDraft}>Afronden ↵</button>}
          <button className="btn sm" onClick={onUndo} disabled={!drafting && !state.ops.length && !state.picks.length}>↶ Laatste stap</button>
          {(state.ops.length > 0 || state.picks.length > 0) && <button className="link muted" onClick={onClear}>Alles wissen</button>}
        </div>
      </Step>

      <Step n={6} title="Resultaat">
        <div className="seg-group">
          <button className={`seg ${state.output === 'polygon' ? 'on' : ''}`} onClick={() => setState({ output: 'polygon' })}>Vlakken</button>
          <button className={`seg ${state.output === 'line' ? 'on' : ''}`} onClick={() => setState({ output: 'line' })} title="De middellijn van gekleurde stroken, bijvoorbeeld getekende paden">Lijnen (middellijn)</button>
        </div>
        {slider('vec-simp', 'Vereenvoudigen', `${fmtNum(state.simplify, 1)} m`, 0, 3, 0.1, state.simplify, (v) => setState({ simplify: v }), 'Hoger = minder hoekpunten, makkelijker bij te werken.')}
        {state.output === 'line' && slider('vec-minlen', 'Kortste lijn', `${state.minLength} m`, 0, 30, 1, state.minLength, (v) => setState({ minLength: v }))}
        <div className="field">
          <label htmlFor="vec-target">Naar laag</label>
          <select id="vec-target" value={tv} onChange={(e) => {
            const v = e.target.value;
            setState({ target: v === 'active' ? { type: 'active' } : v.startsWith('L:') ? { type: 'layer', id: v.slice(2) } : { type: 'new', kind: v.slice(2) as VectorKind } });
          }}>
            <option value="active" disabled={!activeOk}>Actieve laag{active ? ` (${active.name})` : ''}{activeOk ? '' : ' — past niet'}</option>
            <optgroup label="Bestaande laag">{targets.map((l) => <option key={l.id} value={`L:${l.id}`}>{l.name} · {KIND_INFO[l.kind].label}</option>)}</optgroup>
            <optgroup label="Nieuwe laag">{newKinds.map((k) => <option key={k} value={`N:${k}`}>+ {KIND_INFO[k].label}</option>)}</optgroup>
          </select>
        </div>
        <div className="field"><label htmlFor="vec-name">Naam {state.target.type === 'new' ? '(van de nieuwe laag en de vormen)' : '(van de vormen)'}</label><input id="vec-name" value={state.name} placeholder="optioneel, bijv. Camping 2" onChange={(e) => setState({ name: e.target.value })} /></div>
        {result && (state.picks.some((p) => p.kind === 'pick') || state.ops.some((o) => o.type === 'add')) && (
          <div className="row" style={{ padding: 12, borderRadius: 12, background: 'var(--tile)', fontSize: 13 }}>
            {n ? (state.output === 'line' ? `${n} lijnen · ${formatDistance(result.lengthM)}` : `${n} ${n === 1 ? 'vlak' : 'vlakken'} · ${fmtNum(result.areaM2, 0)} m²`) : 'Niets gevonden: verhoog het bereik'}
          </div>
        )}
        <button className="btn lime" disabled={!n} onClick={onAdd}>Toevoegen en bewerken <span className="kbd" style={{ marginLeft: 6 }}>↵</span></button>
      </Step>
    </div>
  );
}
