import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

/**
 * MapLibre starts its worker from `./maplibre-gl-worker.mjs` next to its own module.
 * In the dev server that is node_modules; in a production build it is assets/, so copy it there.
 */
function maplibreWorker(): Plugin {
  return {
    name: 'maplibre-worker',
    apply: 'build',
    generateBundle() {
      const dir = path.dirname(createRequire(import.meta.url).resolve('maplibre-gl/dist/maplibre-gl-worker.mjs'));
      this.emitFile({ type: 'asset', fileName: 'assets/maplibre-gl-worker.mjs', source: readFileSync(path.join(dir, 'maplibre-gl-worker.mjs')) });
    },
  };
}

export default defineConfig({
  plugins: [react(), maplibreWorker()],
  root: '.',
  base: '/studio/',
  // MapLibre loads its worker from next to its own module file; pre-bundling would break that.
  optimizeDeps: { exclude: ['maplibre-gl'] },
});
