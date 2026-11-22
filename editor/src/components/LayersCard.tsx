import { useState } from 'react';
import * as turf from '@turf/turf';
import type { Feature } from 'geojson';
import { Icon } from '../icons';
import type { Category, Facility, Layer } from '../types';
import { KIND_INFO, isVectorKind, isWalkableLayer } from '../types';
import { fmtNum, isHole } from '../geo';

function meta(l: Layer): string {
  if (l.kind === 'image') return l.image?.warped ? 'beeld' : 'niet gegeorefereerd';
  if (l.kind === 'pdok') return 'luchtfoto';
  if (l.kind === 'bgt') return 'basiskaart';
  if (l.kind === 'eigen') return l.walkable ? 'beloopbaar' : 'eigen';
  return KIND_INFO[l.kind].geom;
}

function swatch(l: Layer): string {
  if (l.kind === 'pdok') return 'linear-gradient(135deg,#66733F,#22341C)';
  if (l.kind === 'image') return 'linear-gradient(135deg,#EFE8D6,#D9E6B8)';
  if (l.kind === 'bgt') return 'linear-gradient(135deg,#1B3524,#14384F)';
  return l.style.color;
}

interface Group { key: string; label: string; one: string; feats: Feature[] }

/** The components of a drawing layer, by what they are. */
function vectorGroups(l: Layer): Group[] {
  const feats = l.features?.features ?? [];
  const lines = feats.filter((f) => f.geometry?.type === 'LineString' || f.geometry?.type === 'MultiLineString');
  const polys = feats.filter((f) => (f.geometry?.type === 'Polygon' || f.geometry?.type === 'MultiPolygon') && !isHole(f));
  const holes = feats.filter((f) => isHole(f));
  const walk = isWalkableLayer(l);
  const groups: Group[] = [
    { key: 'lines', label: walk ? 'Paden' : l.kind === 'hekken' ? 'Hekken' : 'Lijnen', one: walk ? 'Pad' : l.kind === 'hekken' ? 'Hek' : 'Lijn', feats: lines },
    { key: 'polys', label: walk ? 'Open gebieden' : 'Vlakken', one: walk ? 'Open gebied' : 'Vlak', feats: polys },
    { key: 'holes', label: walk ? 'Gaten (niet beloopbaar)' : 'Gaten', one: 'Gat', feats: holes },
  ];
  return groups.filter((g) => g.feats.length);
}

function measure(f: Feature): string {
  try {
    const t = f.geometry?.type;
    if (t === 'Polygon' || t === 'MultiPolygon') return `${fmtNum(turf.area(f as any), 0)} m²`;
    if (t === 'LineString' || t === 'MultiLineString') return `${fmtNum(turf.length(f as any, { units: 'meters' }), 0)} m`;
  } catch { /* odd geometry */ }
  return '';
}

export function LayersCard({ layers, activeId, panelId, onActivate, onToggle, onPanel, onAdd, facilities, categories, selectedId, onToggleCat, onPickFacility, onPickFeature }: {
  layers: Layer[];
  activeId: string | null;
  panelId: string | null;
  onActivate: (id: string) => void;
  onToggle: (id: string) => void;
  onPanel: (id: string) => void;
  onAdd: () => void;
  facilities: Facility[];
  categories: Category[];
  selectedId: string | null;
  onToggleCat: (layerId: string, catId: string) => void;
  onPickFacility: (id: string) => void;
  onPickFeature: (layerId: string, featureId: string) => void;
}) {
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const flip = (k: string) => setOpen((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });

  const facilityTree = (l: Layer) => {
    const cats = [...categories, ...[...new Set(facilities.map((f) => f.category))].filter((id) => !categories.some((c) => c.id === id)).map((id) => ({ id, name: id, color: '#F5B84A', label: '?' }))];
    const used = cats.filter((c) => facilities.some((f) => f.category === c.id));
    if (!used.length) return <span className="tree-empty">Nog geen voorzieningen</span>;
    return used.map((c) => {
      const items = facilities.filter((f) => f.category === c.id);
      const k = `${l.id}:${c.id}`;
      const hidden = (l.hiddenCats ?? []).includes(c.id);
      return (
        <div key={c.id}>
          <div className={`tree-row group ${hidden || !l.visible ? 'off' : ''}`}>
            <button className="tree-main" onClick={() => flip(k)} aria-expanded={open.has(k)}>
              <Icon name="chevR" size={13} stroke={2.2} style={{ transform: open.has(k) ? 'rotate(90deg)' : undefined, transition: 'transform .12s', flexShrink: 0 }} />
              <span className="dot" style={{ width: 9, height: 9, background: c.color, opacity: hidden ? 0.35 : 1 }} />
              <span className="name">{c.name}</span>
              <span className="count">{items.length}</span>
            </button>
            <button className="icon-btn sm" onClick={() => onToggleCat(l.id, c.id)} aria-label={hidden ? `${c.name} tonen` : `${c.name} verbergen`} title={hidden ? 'Tonen' : 'Verbergen'}>
              <Icon name={hidden ? 'eyeOff' : 'eye'} size={14} stroke={1.8} />
            </button>
          </div>
          {open.has(k) && items.map((f, i) => (
            <button key={f.id} className={`tree-row item ${selectedId === f.id ? 'sel' : ''}`} onClick={() => onPickFacility(f.id)} title="Selecteren en erheen gaan">
              <span className="name">{f.name || `${c.name} ${i + 1}`}</span>
              <span className="count">{f.shape?.length ? 'vorm' : 'punt'}</span>
            </button>
          ))}
        </div>
      );
    });
  };

  const vectorTree = (l: Layer) => {
    const groups = vectorGroups(l);
    if (!groups.length) return <span className="tree-empty">Nog niets getekend</span>;
    return groups.map((g) => {
      const k = `${l.id}:${g.key}`;
      return (
        <div key={g.key}>
          <div className="tree-row group">
            <button className="tree-main" onClick={() => flip(k)} aria-expanded={open.has(k)}>
              <Icon name="chevR" size={13} stroke={2.2} style={{ transform: open.has(k) ? 'rotate(90deg)' : undefined, transition: 'transform .12s', flexShrink: 0 }} />
              <span className="name">{g.label}</span>
              <span className="count">{g.feats.length}</span>
            </button>
          </div>
          {open.has(k) && g.feats.map((f, i) => (
            <button key={String(f.id ?? i)} className={`tree-row item ${selectedId != null && String(f.id) === selectedId ? 'sel' : ''}`} onClick={() => f.id != null && onPickFeature(l.id, String(f.id))} title="Selecteren en erheen gaan">
              <span className="name">{f.properties?.name || `${g.one} ${i + 1}`}</span>
              <span className="count">{measure(f)}</span>
            </button>
          ))}
        </div>
      );
    });
  };

  return (
    <div className="card col scroll" style={{ padding: 10, gap: 2, minHeight: 0, flex: '0 1 auto' }}>
      <div className="row" style={{ justifyContent: 'space-between', padding: '6px 10px 8px' }}>
        <span style={{ fontSize: 15, fontWeight: 600 }}>Lagen</span>
        <button className="link" onClick={onAdd}>+ Laag</button>
      </div>
      {layers.map((l) => {
        const raster = l.kind === 'pdok' || l.kind === 'image' || l.kind === 'bgt';
        const expandable = isVectorKind(l.kind) || l.kind === 'voorzieningen';
        const isOpen = open.has(l.id);
        return (
          <div key={l.id}>
            <div className={`layer-row ${activeId === l.id ? 'act' : ''} ${l.visible ? '' : 'off'}`}>
              {expandable ? (
                <button className="chev" onClick={() => flip(l.id)} aria-expanded={isOpen} aria-label={isOpen ? `Onderdelen van ${l.name} inklappen` : `Onderdelen van ${l.name} tonen`}>
                  <Icon name="chevR" size={14} stroke={2.2} style={{ transform: isOpen ? 'rotate(90deg)' : undefined, transition: 'transform .12s' }} />
                </button>
              ) : <span className="chev" aria-hidden="true" />}
              <button className="main" onClick={() => onActivate(l.id)} title={l.locked ? `${l.name} (vergrendeld)` : l.name}>
                <span className="swatch" style={{ background: swatch(l), borderRadius: raster ? 4 : '50%', opacity: l.visible ? 1 : 0.3 }} />
                <span className="name">{l.name}</span>
                {l.locked && <Icon name="lock" size={13} style={{ opacity: 0.6, flexShrink: 0 }} />}
                <span className="meta">{l.kind === 'voorzieningen' ? facilities.length : meta(l)}</span>
              </button>
              <button className={`icon-btn ${panelId === l.id ? 'on' : ''}`} onClick={() => onPanel(l.id)} aria-label={`Eigenschappen van ${l.name}`} title="Eigenschappen">
                <Icon name="sliders" size={16} stroke={1.8} />
              </button>
              <button className="icon-btn" onClick={() => onToggle(l.id)} aria-label={l.visible ? `${l.name} verbergen` : `${l.name} tonen`} title={l.visible ? 'Verbergen' : 'Tonen'}>
                <Icon name={l.visible ? 'eye' : 'eyeOff'} size={16} stroke={1.8} />
              </button>
            </div>
            {expandable && isOpen && <div className="tree">{l.kind === 'voorzieningen' ? facilityTree(l) : vectorTree(l)}</div>}
          </div>
        );
      })}
      {!layers.length && <span className="muted" style={{ padding: 10, fontSize: 13 }}>Nog geen lagen. Voeg er een toe met + Laag.</span>}
    </div>
  );
}
