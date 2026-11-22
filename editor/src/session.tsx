// Who is signed in. Everything except the login page sits behind this.
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api, type Me } from './api';

const SessionContext = createContext<Me | null>(null);

export function SessionGate({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const nav = useNavigate();
  const loc = useLocation();
  useEffect(() => {
    api.me().then(setMe).catch(() => nav(`/login?next=${encodeURIComponent('/studio' + loc.pathname + loc.search)}`, { replace: true }));
  }, []);
  if (!me) return <div className="app" style={{ alignItems: 'center', justifyContent: 'center' }}><span className="spinner" /></div>;
  return <SessionContext.Provider value={me}>{children}</SessionContext.Provider>;
}

export function useSession(): Me {
  return useContext(SessionContext)!;
}

export async function logout() {
  await api.logout().catch(() => {});
  location.href = '/studio/login';
}
