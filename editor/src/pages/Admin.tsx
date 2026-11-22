// Beheer (floc team only): organisations, accounts and which organisation owns which map.
import { useEffect, useState } from 'react';
import { api, type AdminData } from '../api';
import { Icon } from '../icons';
import { Rail } from '../components/Rail';
import { useSession } from '../session';

export function Admin() {
  const me = useSession();
  const [data, setData] = useState<AdminData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [modal, setModal] = useState<null | 'org' | 'user' | { pw: string; email: string }>(null);
  const load = () => api.admin().then(setData).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  const run = async (fn: () => Promise<unknown>, msg?: string) => {
    try { await fn(); await load(); if (msg) setToast(msg); } catch (e: any) { setErr(e.message); }
  };

  if (!me.user.isStaff) return <div className="app"><Rail /><main className="page"><h1>Beheer</h1><p className="muted">Alleen voor het floc-team.</p></main></div>;

  return (
    <div className="app">
      <Rail />
      <main className="page" style={{ position: 'relative' }}>
        <div className="col" style={{ gap: 6 }}>
          <span className="muted" style={{ fontSize: 13 }}>floc studio</span>
          <h1>Beheer</h1>
        </div>

        <section className="col" style={{ gap: 12 }}>
          <div className="row"><h2 className="grow">Organisaties</h2><button className="btn" onClick={() => setModal('org')}><Icon name="plus" size={16} />Organisatie</button></div>
          {data?.orgs.map((o) => {
            const maps = data.projects.filter((p) => p.orgId === o.id);
            const people = data.users.filter((u) => u.orgs.some((x) => x.id === o.id));
            return (
              <div key={o.id} className="tile" style={{ gap: 8 }}>
                <div className="row">
                  <span className="grow" style={{ fontWeight: 600 }}>{o.name}</span>
                  {!maps.length && <button className="icon-btn" title="Verwijderen" aria-label={`${o.name} verwijderen`} onClick={() => run(() => api.deleteOrg(o.id))}><Icon name="trash" size={16} /></button>}
                </div>
                <span className="muted" style={{ fontSize: 13 }}>Kaarten: {maps.map((m) => m.name).join(', ') || 'geen'}</span>
                <span className="muted" style={{ fontSize: 13 }}>Mensen: {people.map((u) => u.name || u.email).join(', ') || 'niemand'}</span>
              </div>
            );
          })}
        </section>

        <section className="col" style={{ gap: 12 }}>
          <h2>Kaarten → organisatie</h2>
          <span className="muted" style={{ fontSize: 13 }}>Organisatoren zien (alleen-lezen) de kaarten van hun eigen organisatie. Het floc-team ziet en bewerkt alles.</span>
          {data?.projects.map((p) => (
            <div key={p.id} className="row tile" style={{ flexDirection: 'row' }}>
              <span className="grow">{p.name}</span>
              <span className="pill">{p.version ? `gepubliceerd v${p.version}` : 'concept'}</span>
              <select className="input" style={{ width: 220 }} value={p.orgId ?? ''} onChange={(e) => run(() => api.setProjectOrg(p.id, e.target.value || null))}>
                <option value="">— geen —</option>
                {data.orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
              </select>
            </div>
          ))}
        </section>

        <section className="col" style={{ gap: 12 }}>
          <div className="row"><h2 className="grow">Accounts</h2><button className="btn lime" onClick={() => setModal('user')}><Icon name="plus" size={16} />Account</button></div>
          {data?.users.map((u) => (
            <div key={u.id} className="tile" style={{ gap: 8 }}>
              <div className="row">
                <div className="col grow" style={{ gap: 2 }}>
                  <span style={{ fontWeight: 600 }}>{u.name || u.email}{u.id === me.user.id && <span className="faint"> (jij)</span>}</span>
                  <span className="muted" style={{ fontSize: 13 }}>{u.email}</span>
                </div>
                <span className="pill" style={u.isStaff ? { background: 'rgba(212,245,106,.12)', color: 'var(--lime)' } : undefined}>{u.isStaff ? 'floc-team' : u.orgs.length ? 'organisator' : 'bezoeker'}</span>
              </div>
              <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
                {u.orgs.map((o) => (
                  <span key={o.id} className="chip" style={{ height: 30 }}>{o.name}
                    <button className="icon-btn" style={{ padding: 2 }} aria-label={`Uit ${o.name} halen`} onClick={() => run(() => api.updateUser(u.id, { removeOrg: o.id }))}><Icon name="close" size={12} /></button>
                  </span>
                ))}
                <select className="input" style={{ width: 200, padding: '6px 10px' }} value="" onChange={(e) => e.target.value && run(() => api.updateUser(u.id, { addOrg: e.target.value }))}>
                  <option value="">+ aan organisatie koppelen</option>
                  {data.orgs.filter((o) => !u.orgs.some((x) => x.id === o.id)).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
                <div className="grow" />
                <button className="btn" style={{ height: 32 }} onClick={() => { const pw = randomPassword(); run(() => api.updateUser(u.id, { password: pw })).then(() => setModal({ pw, email: u.email })); }}>Nieuw wachtwoord</button>
                {u.id !== me.user.id && <button className="btn" style={{ height: 32 }} onClick={() => run(() => api.updateUser(u.id, { isStaff: !u.isStaff }))}>{u.isStaff ? 'Geen teamlid meer' : 'Maak teamlid'}</button>}
                {u.id !== me.user.id && <button className="btn danger" style={{ height: 32 }} onClick={() => confirm(`${u.email} verwijderen?`) && run(() => api.deleteUser(u.id))}>Verwijderen</button>}
              </div>
            </div>
          ))}
        </section>

        {modal === 'org' && <OrgModal onClose={() => setModal(null)} onSave={(name) => run(() => api.createOrg(name), 'Organisatie aangemaakt').then(() => setModal(null))} />}
        {modal === 'user' && data && (
          <UserModal orgs={data.orgs} onClose={() => setModal(null)} onSave={async (u) => { await api.createUser(u); await load(); setModal({ pw: u.password, email: u.email }); }} />
        )}
        {modal && typeof modal === 'object' && (
          <div className="overlay" onClick={() => setModal(null)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <h2>Wachtwoord voor {modal.email}</h2>
              <p className="muted" style={{ margin: 0, fontSize: 14 }}>Geef dit door aan de persoon. Het wordt maar één keer getoond.</p>
              <code style={{ fontSize: 20, padding: 14, background: 'var(--tile)', borderRadius: 12, textAlign: 'center', userSelect: 'all' }}>{modal.pw}</code>
              <div className="actions"><button className="btn lime" onClick={() => setModal(null)}>Klaar</button></div>
            </div>
          </div>
        )}
        {err && <div className="toast err" onClick={() => setErr(null)}>{err}</div>}
        {toast && <div className="toast" onClick={() => setToast(null)}>{toast}</div>}
      </main>
    </div>
  );
}

function randomPassword() {
  const a = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const r = crypto.getRandomValues(new Uint32Array(12));
  return Array.from(r, (n) => a[n % a.length]).join('');
}

function OrgModal({ onClose, onSave }: { onClose: () => void; onSave: (name: string) => void }) {
  const [v, setV] = useState('');
  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Nieuwe organisatie</h2>
        <div className="field"><label htmlFor="org-n">Naam</label><input id="org-n" autoFocus value={v} onChange={(e) => setV(e.target.value)} placeholder="bv. Kultlab" onKeyDown={(e) => e.key === 'Enter' && v.trim() && onSave(v.trim())} /></div>
        <div className="actions"><button className="btn" onClick={onClose}>Annuleren</button><button className="btn lime" disabled={!v.trim()} onClick={() => onSave(v.trim())}>Aanmaken</button></div>
      </div>
    </div>
  );
}

function UserModal({ orgs, onClose, onSave }: { orgs: { id: string; name: string }[]; onClose: () => void; onSave: (u: { email: string; name: string; password: string; isStaff: boolean; orgId?: string }) => Promise<void> }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<string>(orgs.find((o) => o.name !== 'floc (intern)')?.id ?? 'staff');
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    setErr(null);
    try { await onSave({ email, name, password: randomPassword(), isStaff: role === 'staff', orgId: role === 'staff' ? undefined : role }); }
    catch (e: any) { setErr(e.message); }
  };
  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Nieuw account</h2>
        <div className="field"><label htmlFor="u-e">E-mail</label><input id="u-e" type="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} /></div>
        <div className="field"><label htmlFor="u-n">Naam</label><input id="u-n" value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div className="field"><label htmlFor="u-r">Rol</label>
          <select id="u-r" value={role} onChange={(e) => setRole(e.target.value)}>
            {orgs.map((o) => <option key={o.id} value={o.id}>Organisator bij {o.name} (meelezen)</option>)}
            <option value="staff">floc-team (alles bewerken)</option>
          </select>
        </div>
        <span className="faint" style={{ fontSize: 12 }}>Er wordt een wachtwoord gemaakt dat je daarna één keer te zien krijgt.</span>
        {err && <span style={{ color: 'var(--danger)', fontSize: 13 }}>{err}</span>}
        <div className="actions"><button className="btn" onClick={onClose}>Annuleren</button><button className="btn lime" disabled={!email} onClick={save}>Aanmaken</button></div>
      </div>
    </div>
  );
}
