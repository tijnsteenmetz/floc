import type { VectorKind } from '../types';
import { KIND_INFO } from '../types';

const VECTORS: { kind: VectorKind; desc: string }[] = [
  { kind: 'beloopbaar', desc: 'lijnen (paden) + vlakken (open gebied) · bepaalt routes' },
  { kind: 'semi', desc: 'vlakken · camping, publiek: wel GPS, geen route erdoorheen' },
  { kind: 'water', desc: 'vlakken · weergave' },
  { kind: 'bos', desc: 'vlakken · weergave' },
  { kind: 'zand', desc: 'vlakken · weergave' },
  { kind: 'hekken', desc: 'lijnen · weergave' },
  { kind: 'eigen', desc: 'kies naam, kleur en of hij beloopbaar is' },
];

export function AddLayerMenu({ hasFacilities, onClose, onVector, onFacilities, onPdok, onImage, onBgt, onFile }: {
  hasFacilities: boolean;
  onClose: () => void;
  onVector: (k: VectorKind) => void;
  onFacilities: () => void;
  onPdok: () => void;
  onImage: () => void;
  onBgt: () => void;
  onFile: () => void;
}) {
  const icon = (txt: string, bg = '#1F2123') => (
    <span style={{ width: 30, height: 30, borderRadius: 9, background: bg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, fontWeight: 700, color: 'var(--text-2)', flexShrink: 0 }}>{txt}</span>
  );
  return (
    <div className="card col scroll" style={{ position: 'absolute', left: 348, top: 88, width: 380, maxHeight: 'calc(100% - 108px)', padding: 16, gap: 6, zIndex: 15, background: 'var(--card-solid)' }}>
      <div className="row" style={{ justifyContent: 'space-between', padding: '2px 4px 8px' }}>
        <span style={{ fontSize: 16, fontWeight: 600 }}>Nieuwe laag</span>
        <button className="link muted" onClick={onClose}>Sluiten</button>
      </div>
      <span className="eyebrow" style={{ padding: 4 }}>Tekenlagen</span>
      {VECTORS.map((v) => (
        <button key={v.kind} className="item" onClick={() => onVector(v.kind)}>
          {icon('', KIND_INFO[v.kind].color)}
          <span className="col grow" style={{ gap: 0 }}><span className="t">{KIND_INFO[v.kind].label}</span><span className="d">{v.desc}</span></span>
        </button>
      ))}
      <button className="item" disabled={hasFacilities} onClick={onFacilities} title={hasFacilities ? 'Deze kaart heeft al een laag Voorzieningen' : undefined}>
        {icon('', KIND_INFO.voorzieningen.color)}
        <span className="col grow" style={{ gap: 0 }}><span className="t">Voorzieningen</span><span className="d">{hasFacilities ? 'staat al in de lagen' : 'punten en geplaatste ontwerpen'}</span></span>
      </button>
      <span className="eyebrow" style={{ padding: '10px 4px 4px' }}>Beeld</span>
      <button className="item" onClick={onPdok}>{icon('PDOK')}<span className="col grow" style={{ gap: 0 }}><span className="t">Luchtfoto PDOK</span><span className="d">ophalen voor het kaartgebied · jaargang kies je in de eigenschappen</span></span></button>
      <button className="item" onClick={onImage}>{icon('PDF')}<span className="col grow" style={{ gap: 0 }}><span className="t">Afbeelding of PDF</span><span className="d">plattegrond, CAD-export → georefereren</span></span></button>
      <button className="item" onClick={onBgt}>{icon('BGT')}<span className="col grow" style={{ gap: 0 }}><span className="t">Basiskaart BGT</span><span className="d">donkere vectorkaart van het huidige kaartbeeld</span></span></button>
      <span className="eyebrow" style={{ padding: '10px 4px 4px' }}>Bestand</span>
      <button className="item" onClick={onFile}>{icon('FILE')}<span className="col grow" style={{ gap: 0 }}><span className="t">Bestand importeren</span><span className="d">GeoJSON, JSON, GeoPackage, KML, GPX, Shapefile (.zip), DXF, CSV</span></span></button>
    </div>
  );
}
