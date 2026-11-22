import { Link, useLocation } from 'react-router-dom';
import { Icon } from '../icons';
import { lastMapId } from '../library';
import { logout, useSession } from '../session';

export function Rail({ onExport }: { onExport?: () => void }) {
  const loc = useLocation();
  const me = useSession();
  const staff = me.user.isStaff;
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
      {staff && (onExport ? (
        <button className="rail" onClick={onExport} title="Publiceren" aria-label="Publiceren"><Icon name="upload" /></button>
      ) : editorPath ? (
        <Link to={`${editorPath}?export=1`} className="rail" title="Publiceren" aria-label="Publiceren"><Icon name="upload" /></Link>
      ) : (
        <button className="rail" disabled title="Open eerst een kaart" aria-label="Publiceren"><Icon name="upload" /></button>
      ))}
      {staff && <Link to="/beheer" className={`rail ${at('/beheer') ? 'on' : ''}`} title="Beheer" aria-label="Beheer"><Icon name="users" /></Link>}
      <div style={{ flex: 1 }} />
      <button className="rail" onClick={logout} title={`Uitloggen (${me.user.email})`} aria-label="Uitloggen"><Icon name="logout" /></button>
    </nav>
  );
}
