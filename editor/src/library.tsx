// The facility categories, available on every screen.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from './api';
import type { Library } from './types';
import { DEFAULT_CATEGORIES } from './types';

interface Ctx {
  lib: Library;
  loaded: boolean;
  update: (fn: (l: Library) => Library) => void;
}

const LibraryContext = createContext<Ctx>({ lib: { categories: DEFAULT_CATEGORIES }, loaded: false, update: () => {} });

export function LibraryProvider({ children }: { children: ReactNode }) {
  const [lib, setLib] = useState<Library>({ categories: DEFAULT_CATEGORIES });
  const [loaded, setLoaded] = useState(false);
  const timer = useRef<number>(0);
  useEffect(() => {
    api.library().then((l) => { setLib(l); setLoaded(true); }).catch(() => setLoaded(true));
  }, []);
  const update = useCallback((fn: (l: Library) => Library) => {
    setLib((cur) => {
      const next = fn(cur);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => { api.saveLibrary(next).catch(console.error); }, 400);
      return next;
    });
  }, []);
  return <LibraryContext.Provider value={{ lib, loaded, update }}>{children}</LibraryContext.Provider>;
}

export function useLibrary() {
  return useContext(LibraryContext);
}

export function lastMapId(): string | null {
  try { return localStorage.getItem('floc.lastMap'); } catch { return null; }
}
export function setLastMapId(id: string | null) {
  try { if (id) localStorage.setItem('floc.lastMap', id); else localStorage.removeItem('floc.lastMap'); } catch { /* ignore */ }
}
