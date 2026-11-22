import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import 'maplibre-gl/dist/maplibre-gl.css';
import './styles.css';
import { LibraryProvider } from './library';
import { Maps } from './pages/Maps';
import { Editor } from './pages/Editor';
import { Georef } from './pages/Georef';

createRoot(document.getElementById('root')!).render(
  <BrowserRouter>
    <LibraryProvider>
      <Routes>
        <Route path="/" element={<Maps />} />
        <Route path="/kaart/:id" element={<Editor />} />
        <Route path="/kaart/:id/georef/:layerId" element={<Georef />} />
      </Routes>
    </LibraryProvider>
  </BrowserRouter>,
);
