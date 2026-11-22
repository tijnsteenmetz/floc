import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import 'maplibre-gl/dist/maplibre-gl.css';
import './styles.css';
import { LibraryProvider } from './library';
import { SessionGate } from './session';
import { Maps } from './pages/Maps';
import { Editor } from './pages/Editor';
import { Georef } from './pages/Georef';
import { Login } from './pages/Login';
import { Admin } from './pages/Admin';

createRoot(document.getElementById('root')!).render(
  <BrowserRouter basename="/studio">
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        path="*"
        element={
          <SessionGate>
            <LibraryProvider>
              <Routes>
                <Route path="/" element={<Maps />} />
                <Route path="/beheer" element={<Admin />} />
                <Route path="/kaart/:id" element={<Editor />} />
                <Route path="/kaart/:id/georef/:layerId" element={<Georef />} />
              </Routes>
            </LibraryProvider>
          </SessionGate>
        }
      />
    </Routes>
  </BrowserRouter>,
);
