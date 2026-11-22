import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  root: '.',
  base: '/studio/',
  // MapLibre loads its worker from next to its own module file; pre-bundling would break that.
  optimizeDeps: { exclude: ['maplibre-gl'] },
});
