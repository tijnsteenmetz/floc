// Web Worker: runs the colour-vectorising pipeline off the main thread and caches the prepared image.
import { prepKey, prepare, run, type Prepared, type Raster, type RunParams } from './veccore';

let raster: Raster | null = null;
let rasterId = '';
let prepared: Prepared | null = null;

self.onmessage = (e: MessageEvent) => {
  const msg = e.data;
  try {
    if (msg.type === 'load') {
      raster = msg.raster as Raster;
      rasterId = msg.id;
      prepared = null;
      (self as any).postMessage({ type: 'loaded', id: rasterId });
      return;
    }
    if (msg.type === 'run') {
      if (!raster || msg.rasterId !== rasterId) { (self as any).postMessage({ type: 'result', req: msg.req, error: 'stale' }); return; }
      const p = msg.params as RunParams;
      const key = prepKey(p);
      if (!prepared || prepared.key !== key) prepared = prepare(raster, p);
      const res = run(raster, prepared, p);
      const preview = res.preview ? new Uint8ClampedArray(res.preview) : undefined;
      (self as any).postMessage({ type: 'result', req: msg.req, result: { ...res, preview } }, preview ? [preview.buffer] : []);
    }
  } catch (err: any) {
    (self as any).postMessage({ type: 'result', req: msg.req, error: String(err?.message ?? err) });
  }
};
