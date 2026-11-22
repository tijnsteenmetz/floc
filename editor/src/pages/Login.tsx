import { useState } from 'react';
import { api } from '../api';

export function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const next = new URLSearchParams(location.search).get('next');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      await api.login(email, password);
      location.href = next && next.startsWith('/studio') ? next : '/studio/';
    } catch (e: any) {
      setErr(e.message); setBusy(false);
    }
  };

  return (
    <div className="app" style={{ alignItems: 'center', justifyContent: 'center', position: 'relative' }}>
      <form className="modal" style={{ width: 400 }} onSubmit={submit}>
        <div className="row" style={{ gap: 12 }}>
          <div className="logo" style={{ margin: 0 }} aria-hidden="true">f</div>
          <div className="col" style={{ gap: 2 }}>
            <h2>floc studio</h2>
            <span className="muted" style={{ fontSize: 13 }}>Log in om je festivalkaarten te bekijken</span>
          </div>
        </div>
        <div className="field"><label htmlFor="li-email">E-mail</label><input id="li-email" type="email" autoComplete="username" autoFocus required value={email} onChange={(e) => setEmail(e.target.value)} /></div>
        <div className="field"><label htmlFor="li-pw">Wachtwoord</label><input id="li-pw" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></div>
        {err && <span style={{ color: 'var(--danger)', fontSize: 13 }}>{err}</span>}
        <button className="btn lime" type="submit" disabled={busy} style={{ width: '100%' }}>{busy && <span className="spinner" />}Inloggen</button>
        <span className="faint" style={{ fontSize: 12, textAlign: 'center' }}>Wachtwoord vergeten? Vraag het floc-team om het opnieuw in te stellen.</span>
        <a href="/" className="link" style={{ textAlign: 'center', textDecoration: 'none' }}>← naar de website</a>
      </form>
    </div>
  );
}
