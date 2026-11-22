import { useState } from 'react';
import { Icon } from '../icons';
import type { DashStyle, FieldDef, FillStyle, Layer, WidthStyle } from '../types';
import { KIND_INFO, PDOK_LAYERS, SEMI_SNAP_M, isVectorKind } from '../types';

export function LayerPanel({ layer: l, tab, setTab, index, count, onClose, onChange, onMove, onGeoref, onCrop, onRefetchBgt, onDelete }: {
  layer: Layer;
  tab: 'stijl' | 'gedrag' | 'info';
  setTab: (t: 'stijl' | 'gedrag' | 'info') => void;
  index: number;
  count: number;
  onClose: () => void;
  onChange: (patch: Partial<Layer>, history?: boolean) => void;
  onMove: (dir: -1 | 1) => void;
  onGeoref: () => void;
  onCrop: () => void;
  onRefetchBgt: () => void;
  onDelete: () => void;
}) {
  const vector = isVectorKind(l.kind) || l.kind === 'voorzieningen';
  const image = l.kind === 'image';
  const raster = l.kind === 'pdok' || image;
  const hasFill = isVectorKind(l.kind) && l.kind !== 'hekken';
  const palette = KIND_INFO[l.kind].palette;
  const setStyle = (patch: Partial<Layer['style']>, history = true) => onChange({ style: { ...l.style, ...patch } }, history);
  const [hex, setHex] = useState(l.style.color);
  const [newField, setNewField] = useState<FieldDef>({ name: '', type: 'tekst' });

  const header = raster ? (l.kind === 'pdok' ? 'linear-gradient(135deg,#66733F,#22341C)' : 'linear-gradient(135deg,#EFE8D6,#D9E6B8)') : l.kind === 'bgt' ? 'linear-gradient(135deg,#1B3524,#14384F)' : l.style.color;

  return (
    <div className="card right-card scroll" style={{ background: 'var(--card-solid)', bottom: 20, maxHeight: 'none' }}>
      <div className="row" style={{ gap: 12 }}>
        <div style={{ width: 38, height: 38, borderRadius: 11, background: header, flexShrink: 0 }} />
        <div className="col grow" style={{ gap: 0 }}>
          <span className="eyebrow">Laageigenschappen</span>
          <span style={{ fontSize: 16, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.name}</span>
        </div>
        <button className="sq" style={{ width: 32, height: 32, borderRadius: 9, background: 'var(--btn)' }} onClick={onClose} aria-label="Sluiten"><Icon name="close" size={14} stroke={2.2} /></button>
      </div>
      <div className="seg-group">
        <button className={`seg ${tab === 'stijl' ? 'on' : ''}`} onClick={() => setTab('stijl')}>Stijl</button>
        <button className={`seg ${tab === 'gedrag' ? 'on' : ''}`} onClick={() => setTab('gedrag')}>Gedrag</button>
        {isVectorKind(l.kind) && <button className={`seg ${tab === 'info' ? 'on' : ''}`} onClick={() => setTab('info')}>Eigenschappen</button>}
      </div>

      {(tab === 'stijl' || (tab === 'info' && !isVectorKind(l.kind))) && (
        <div className="col" style={{ gap: 16 }}>
          {vector && palette.length > 0 && l.kind !== 'voorzieningen' && (
            <div className="col" style={{ gap: 8 }}>
              <span className="muted" style={{ fontSize: 12 }}>Kleur</span>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                {palette.map((c) => (
                  <button key={c} onClick={() => { setStyle({ color: c }); setHex(c); }} aria-label={`Kleur ${c}`} style={{ width: 30, height: 30, borderRadius: 9, border: c.toLowerCase() === l.style.color.toLowerCase() ? '2px solid #fff' : '2px solid transparent', background: c, cursor: 'pointer', padding: 0 }} />
                ))}
                <label title="Eigen kleur kiezen" style={{ position: 'relative', width: 30, height: 30, borderRadius: 9, cursor: 'pointer', flexShrink: 0,
                  background: palette.some((c) => c.toLowerCase() === l.style.color.toLowerCase()) ? 'conic-gradient(#FF6B6B,#FACC15,#A3E635,#5EEAD4,#60A5FA,#C084FC,#FF6B6B)' : l.style.color,
                  border: palette.some((c) => c.toLowerCase() === l.style.color.toLowerCase()) ? '2px solid transparent' : '2px solid #fff' }}>
                  <input type="color" aria-label="Eigen kleur" value={/^#[0-9a-fA-F]{6}$/.test(l.style.color) ? l.style.color.toLowerCase() : '#888888'}
                    style={{ position: 'absolute', inset: 0, opacity: 0, width: '100%', height: '100%', cursor: 'pointer', border: 0, padding: 0 }}
                    onChange={(e) => { const c = e.target.value.toUpperCase(); setHex(c); setStyle({ color: c }, false); }} />
                </label>
                <input aria-label="Kleurcode" className="input" style={{ width: 96, fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12, padding: '6px 8px' }} value={hex}
                  onChange={(e) => { const v = e.target.value.trim(); setHex(v); const full = /^#?[0-9a-fA-F]{6}$/.test(v) ? (v.startsWith('#') ? v : '#' + v) : null; if (full) setStyle({ color: full.toUpperCase() }); }} />
              </div>
            </div>
          )}
          {hasFill && (
            <div className="col" style={{ gap: 8 }}>
              <span className="muted" style={{ fontSize: 12 }}>Vulling</span>
              <div className="seg-group">
                {(['vol', 'arcering', 'textuur', 'geen'] as FillStyle[]).map((f) => <button key={f} className={`seg ${l.style.fill === f ? 'on' : ''}`} onClick={() => setStyle({ fill: f })}>{f}</button>)}
              </div>
            </div>
          )}
          {isVectorKind(l.kind) && (
            <div className="col" style={{ gap: 8 }}>
              <span className="muted" style={{ fontSize: 12 }}>{l.kind === 'hekken' || l.kind === 'beloopbaar' || l.kind === 'eigen' ? 'Lijnen' : 'Rand'}</span>
              <div className="row" style={{ gap: 8 }}>
                <div className="seg-group grow">
                  {(['dun', 'normaal', 'dik'] as WidthStyle[]).map((w) => <button key={w} className={`seg ${l.style.width === w ? 'on' : ''}`} onClick={() => setStyle({ width: w })}>{w}</button>)}
                </div>
                <div className="seg-group">
                  {(['vol', 'gestreept'] as DashStyle[]).map((d) => (
                    <button key={d} className={`seg ${l.style.dash === d ? 'on' : ''}`} onClick={() => setStyle({ dash: d })} aria-label={d === 'vol' ? 'Doorgetrokken' : 'Gestreept'} title={d === 'vol' ? 'Doorgetrokken' : 'Gestreept'}>
                      <svg width="28" height="8" viewBox="0 0 28 8" aria-hidden="true"><line x1="1" y1="4" x2="27" y2="4" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeDasharray={d === 'vol' ? undefined : '4 4'} /></svg>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
          <div className="col" style={{ gap: 8 }}>
            <div className="row" style={{ justifyContent: 'space-between' }}><label htmlFor="lp-op" className="muted" style={{ fontSize: 12 }}>Dekking</label><span style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>{l.opacity}%</span></div>
            <input type="range" id="lp-op" min={0} max={100} value={l.opacity} onChange={(e) => onChange({ opacity: Number(e.target.value) }, false)} />
          </div>
          {l.kind === 'pdok' && (
            <div className="field">
              <label htmlFor="lp-pdok">Luchtfoto</label>
              <select id="lp-pdok" value={l.pdokLayer ?? 'Actueel_orthoHR'} onChange={(e) => onChange({ pdokLayer: e.target.value })}>
                {PDOK_LAYERS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
            </div>
          )}
          {raster && (
            <div className="col" style={{ gap: 8 }}>
              <div className="row" style={{ justifyContent: 'space-between' }}><label htmlFor="lp-br" className="muted" style={{ fontSize: 12 }}>Helderheid</label><span style={{ fontSize: 13 }}>{l.style.brightness ?? 0}</span></div>
              <input type="range" id="lp-br" min={-50} max={50} value={l.style.brightness ?? 0} onChange={(e) => setStyle({ brightness: Number(e.target.value) }, false)} />
            </div>
          )}
          {image && (
            <div className="row" style={{ gap: 6 }}>
              <button className="btn sm grow" onClick={onGeoref}><Icon name="crosshair" size={15} />Georefereren</button>
              <button className="btn sm grow" onClick={onCrop}><Icon name="crop" size={15} />Bijsnijden</button>
            </div>
          )}
          {l.kind === 'bgt' && <button className="btn sm" onClick={onRefetchBgt}>Opnieuw ophalen voor huidig beeld</button>}
          <div className="col" style={{ gap: 8 }}>
            <span className="muted" style={{ fontSize: 12 }}>Volgorde</span>
            <div className="row" style={{ gap: 6 }}>
              <button className="sq sm" onClick={() => onMove(-1)} disabled={index <= 0} aria-label="Omhoog" title="Omhoog"><Icon name="up" size={18} stroke={2.2} /></button>
              <button className="sq sm" onClick={() => onMove(1)} disabled={index >= count - 1} aria-label="Omlaag" title="Omlaag"><Icon name="down" size={18} stroke={2.2} /></button>
            </div>
          </div>
        </div>
      )}

      {tab === 'gedrag' && (
        <div className="col" style={{ gap: 10 }}>
          <div className="field"><label htmlFor="lp-name">Naam</label><input id="lp-name" value={l.name} onChange={(e) => onChange({ name: e.target.value }, false)} /></div>
          <div className="field"><label htmlFor="lp-kind">Soort</label><input id="lp-kind" value={KIND_INFO[l.kind].label} readOnly /></div>
          <span className="muted" style={{ fontSize: 12 }}>{KIND_INFO[l.kind].desc}</span>
          {isVectorKind(l.kind) && (
            <Toggle label="Beloopbaar" desc={l.kind === 'beloopbaar' ? 'Altijd aan voor deze soort' : l.kind === 'eigen' ? 'Telt mee voor de routes' : 'Alleen bij een eigen laag aan te zetten'}
              on={l.kind === 'beloopbaar' || (l.kind === 'eigen' && !!l.walkable)} disabled={l.kind !== 'eigen'} onFlip={() => onChange({ walkable: !l.walkable })} />
          )}
          {l.kind === 'semi' && (
            <div className="field">
              <label htmlFor="lp-snap">GPS springt naar een pad binnen (m)</label>
              <input id="lp-snap" type="number" min={0} max={20} step={0.5} value={l.snapM ?? SEMI_SNAP_M} onChange={(e) => onChange({ snapM: Math.max(0, Number(e.target.value)) }, false)} />
              <span className="faint" style={{ fontSize: 12 }}>Buiten deze gebieden is dat 5 m. Lager = de stip blijft vaker waar je echt bent. Per vlak aan te passen.</span>
            </div>
          )}
          <Toggle label="Vergrendeld" desc="Niet per ongeluk aanpassen" on={l.locked} onFlip={() => onChange({ locked: !l.locked })} />
          <Toggle label="Niet exporteren" desc="Alleen in de editor, niet naar de app" on={l.noExport} onFlip={() => onChange({ noExport: !l.noExport })} />
          <button className="btn danger sm" style={{ marginTop: 6 }} onClick={onDelete}><Icon name="trash" size={15} />Laag verwijderen</button>
        </div>
      )}

      {tab === 'info' && isVectorKind(l.kind) && (
        <div className="col" style={{ gap: 10 }}>
          <span className="muted" style={{ fontSize: 13 }}>Eigen velden die elk object in deze laag krijgt, bijvoorbeeld ondergrond, breedte of drukte. Je vult ze in bij een geselecteerd object.</span>
          {l.fields.map((f, i) => (
            <div key={f.name + i} className="prop">
              <span>{f.name}</span>
              <span className="row" style={{ gap: 8 }}><span className="muted" style={{ fontSize: 12 }}>{f.type}</span>
                <button className="icon-btn" aria-label={`Veld ${f.name} verwijderen`} onClick={() => onChange({ fields: l.fields.filter((_, j) => j !== i) })}><Icon name="close" size={14} /></button>
              </span>
            </div>
          ))}
          <div className="row" style={{ gap: 6 }}>
            <input className="input grow" aria-label="Naam nieuw veld" placeholder="Nieuw veld" value={newField.name} onChange={(e) => setNewField({ ...newField, name: e.target.value })}
              onKeyDown={(e) => { if (e.key === 'Enter' && newField.name.trim()) { onChange({ fields: [...l.fields, { ...newField, name: newField.name.trim() }] }); setNewField({ name: '', type: 'tekst' }); } }} />
            <select className="input" style={{ width: 96 }} aria-label="Type" value={newField.type} onChange={(e) => setNewField({ ...newField, type: e.target.value as FieldDef['type'] })}>
              <option value="tekst">tekst</option><option value="getal">getal</option><option value="keuze">keuze</option>
            </select>
          </div>
          <button className="btn sm" disabled={!newField.name.trim()} onClick={() => { onChange({ fields: [...l.fields, { ...newField, name: newField.name.trim() }] }); setNewField({ name: '', type: 'tekst' }); }}>+ Veld toevoegen</button>
        </div>
      )}
    </div>
  );
}

export function Toggle({ label, desc, on, disabled, onFlip }: { label: string; desc?: string; on: boolean; disabled?: boolean; onFlip: () => void }) {
  return (
    <button onClick={() => !disabled && onFlip()} aria-pressed={on} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 12, borderRadius: 12, border: '1px solid rgba(255,255,255,.06)', background: 'var(--tile)', textAlign: 'left', cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.6 : 1 }}>
      <span className="col grow" style={{ gap: 2 }}><span style={{ fontSize: 14, fontWeight: 500 }}>{label}</span>{desc && <span className="muted" style={{ fontSize: 12 }}>{desc}</span>}</span>
      <span className={`toggle ${on ? 'on' : ''}`} />
    </button>
  );
}
