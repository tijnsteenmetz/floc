import { Link, useLocation } from 'react-router-dom';
import { Icon } from '../icons';
import { lastMapId } from '../library';

export function Rail({ onExport }: { onExport?: () => void }) {
  const loc = useLocation();
  const mapId = lastMapId();
  const at = (p: string) => loc.pathname === p || (p !== '/' && loc.pathname.startsWith(p));
  const editorPath = mapId ? `/kaart/${mapId}` : null;
  return (
    <nav className="rail-nav" aria-label="Hoofdmenu">
      <div className="logo" aria-hidden="true">f</div>
      <Link to="/" className={`rail ${loc.pathname === '/' ? 'on' : ''}`} title="Kaarten" aria-label="Kaarten"><Icon name="grid" /></Link>
      {editorPath ? (
        <Link to={editorPath} className={`rail ${at('/kaart/') && !loc.pathname.includes('/georef') ? 'on' : ''}`} title="Editor" aria-label="Editor"><Icon name="map" /></Link>
      ) : (
        <button className="rail" disabled title="Open eerst een kaart" aria-label="Editor"><Icon name="map" /></button>
      )}
      {onExport ? (
        <button className="rail" onClick={onExport} title="Exporteren" aria-label="Exporteren"><Icon name="upload" /></button>
      ) : editorPath ? (
        <Link to={`${editorPath}?export=1`} className="rail" title="Exporteren" aria-label="Exporteren"><Icon name="upload" /></Link>
      ) : (
        <button className="rail" disabled title="Open eerst een kaart" aria-label="Exporteren"><Icon name="upload" /></button>
      )}
    </nav>
  );
}
