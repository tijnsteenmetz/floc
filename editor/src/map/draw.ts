// Terra Draw wrapper: edits the features of the one active vector layer.
import type { Map as MLMap } from 'maplibre-gl';
import {
  TerraDraw, TerraDrawLineStringMode, TerraDrawPolygonMode, TerraDrawRectangleMode, TerraDrawSelectMode,
  type GeoJSONStoreFeatures, type HexColor, type TerraDrawMouseEvent,
} from 'terra-draw';
import { TerraDrawMapLibreGLAdapter } from 'terra-draw-maplibre-gl-adapter';
import type { Feature } from 'geojson';

export type DrawTool = 'select' | 'line' | 'polygon' | 'rect' | 'hole' | 'trace' | 'off';
const MODE: Record<Exclude<DrawTool, 'off'>, string> = { select: 'select', line: 'linestring', polygon: 'polygon', rect: 'rectangle', hole: 'hole', trace: 'trace' };
const TRACE = '#F5B84A' as HexColor;
const DRAW_MODES = ['linestring', 'polygon', 'rectangle', 'hole'];
const HOLE = '#FF6B6B' as HexColor;

export class DrawController {
  readonly draw: TerraDraw;
  private color: HexColor = '#D4F56A';
  private snapping = true;
  private snapPx = 15;
  private allowLines = true;
  private allowPolys = true;
  /** finished = the shape that was just drawn (with its mode), so the editor can do more with it in the same undo step. */
  onCommit: (features: Feature[], finished?: { feature: Feature; mode: string }) => void = () => {};
  /** A shape drawn with the trace tool. It is not kept in the layer. */
  onTrace: (feature: Feature) => void = () => {};
  onSelect: (id: string | null) => void = () => {};
  private loading = false;

  constructor(map: MLMap) {
    this.draw = new TerraDraw({
      adapter: new TerraDrawMapLibreGLAdapter({ map, prefixId: 'td' }),
      modes: this.buildModes(),
    });
    this.draw.start();
    this.draw.setMode('static');
    this.draw.on('finish', (_id, ctx) => {
      if (this.loading) return;
      const f = this.draw.getSnapshotFeature(_id);
      if (ctx.mode === 'trace') {
        this.loading = true;
        this.draw.removeFeatures([_id]);
        this.loading = false;
        if (f) this.onTrace({ type: 'Feature', geometry: f.geometry as any, properties: {} });
        return;
      }
      if (ctx.mode === 'hole') this.draw.updateFeatureProperties(_id, { hole: true });
      const { mode, ...props } = (f?.properties ?? {}) as Record<string, any>;
      this.commit(f && ctx.action === 'draw' ? { feature: { type: 'Feature', id: String(_id), geometry: f.geometry as any, properties: { ...props, ...(ctx.mode === 'hole' ? { hole: true } : {}) } }, mode: ctx.mode } : undefined);
    });
    // Only a deleted shape of the layer counts; snapping and guide points come and go all the time.
    this.draw.on('change', (ids, type) => { if (type === 'delete' && !this.loading && ids.some((i) => this.known.has(String(i)))) this.commit(); });
    this.draw.on('select', (id) => this.onSelect(String(id)));
    this.draw.on('deselect', () => this.onSelect(null));
  }

  /** Lines and shapes of the layer, for snapping. Rebuilt when the layer changes, not on every mouse move. */
  private snapIndex: { id: string; pts: number[][]; box: [number, number, number, number] }[] = [];

  /** Ids of the layer's shapes as last seen. */
  private known = new Set<string>();

  private rebuildSnapIndex() {
    this.snapIndex = [];
    this.known = new Set();
    for (const f of this.draw.getSnapshot()) {
      if (!DRAW_MODES.includes(String(f.properties?.mode)) || f.properties?.currentlyDrawing) continue;
      this.known.add(String(f.id));
      const g = f.geometry as any;
      const parts: number[][][] = g.type === 'LineString' ? [g.coordinates] : g.type === 'Polygon' ? g.coordinates : [];
      for (const pts of parts) {
        if (!pts.length) continue;
        const xs = pts.map((c) => c[0]), ys = pts.map((c) => c[1]);
        this.snapIndex.push({ id: String(f.id), pts, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] });
      }
    }
  }

  /**
   * Snapping to every line and shape of the layer, whatever its type (Terra Draw itself only snaps a
   * shape to shapes and a line to lines). A corner within reach wins; otherwise the nearest point on an
   * edge. The point is put exactly on the edge, so a shape snapped onto a path is joined to it in routing.
   */
  private snapTo = (e: TerraDrawMouseEvent, ctx: { currentId?: string | number; project: (lng: number, lat: number) => { x: number; y: number }; unproject: (x: number, y: number) => { lng: number; lat: number } }): number[] | undefined => {
    if (!this.snapping || e.heldKeys?.includes('Alt')) return undefined;
    const r = this.snapPx;
    const a = ctx.unproject(e.containerX - r, e.containerY - r), b = ctx.unproject(e.containerX + r, e.containerY + r);
    const qx0 = Math.min(a.lng, b.lng), qx1 = Math.max(a.lng, b.lng), qy0 = Math.min(a.lat, b.lat), qy1 = Math.max(a.lat, b.lat);
    const skip = ctx.currentId != null ? String(ctx.currentId) : null;
    let vBest: number[] | undefined, vd = r;
    let eBest: number[] | undefined, ed = r;
    for (const it of this.snapIndex) {
      if (it.id === skip || it.box[0] > qx1 || it.box[2] < qx0 || it.box[1] > qy1 || it.box[3] < qy0) continue;
      let prev: { x: number; y: number } | null = null;
      for (let i = 0; i < it.pts.length; i++) {
        const c = it.pts[i];
        const inBox = c[0] >= qx0 && c[0] <= qx1 && c[1] >= qy0 && c[1] <= qy1;
        const p = ctx.project(c[0], c[1]);
        if (inBox) {
          const d = Math.hypot(p.x - e.containerX, p.y - e.containerY);
          if (d < vd) { vd = d; vBest = c; }
        }
        if (prev && i > 0) {
          const q = it.pts[i - 1];
          if (!(Math.max(c[0], q[0]) < qx0 || Math.min(c[0], q[0]) > qx1 || Math.max(c[1], q[1]) < qy0 || Math.min(c[1], q[1]) > qy1)) {
            const dx = p.x - prev.x, dy = p.y - prev.y, len2 = dx * dx + dy * dy;
            const t = len2 ? Math.max(0, Math.min(1, ((e.containerX - prev.x) * dx + (e.containerY - prev.y) * dy) / len2)) : 0;
            const d = Math.hypot(prev.x + t * dx - e.containerX, prev.y + t * dy - e.containerY);
            if (d < ed) { ed = d; eBest = [q[0] + t * (c[0] - q[0]), q[1] + t * (c[1] - q[1])]; }
          }
        }
        prev = p;
      }
    }
    // Terra Draw rejects a shape with more than 9 decimals (it then disappears while drawing). A point on an
    // edge is computed, so round it: 1e-9° is 0.1 mm, well within the 1 cm at which routing joins things.
    const hit = vBest ?? eBest;
    return hit ? [Math.round(hit[0] * 1e9) / 1e9, Math.round(hit[1] * 1e9) / 1e9] : undefined;
  };

  private snap() {
    return { toCustom: this.snapTo as any };
  }

  /** How close (screen pixels) the pointer must be to snap or to grab a point. */
  setSnapPx(px: number) {
    this.snapPx = px;
    // Terra Draw copies the distance into each mode's helpers when it starts, so update those too.
    const modes = (this.draw as any)._modes as Record<string, any> | undefined;
    for (const m of Object.values(modes ?? {})) {
      if (!m || typeof m !== 'object') continue;
      m.pointerDistance = px;
      for (const v of Object.values(m)) {
        if (v && typeof v === 'object' && 'pointerDistance' in (v as any)) (v as any).pointerDistance = px;
        if (v && typeof v === 'object' && (v as any).config && typeof (v as any).config === 'object' && 'pointerDistance' in (v as any).config) (v as any).config.pointerDistance = px;
      }
    }
  }

  private buildModes() {
    const c = this.color;
    const editFlags = {
      feature: {
        draggable: true,
        coordinates: { midpoints: true, draggable: true, deletable: true, snappable: { toCustom: this.snapTo as any } },
      },
    };
    return [
      new TerraDrawSelectMode({
        pointerDistance: this.snapPx,
        flags: { linestring: editFlags, polygon: editFlags, rectangle: editFlags, hole: editFlags },
        keyEvents: { deselect: 'Escape', delete: null, rotate: null, scale: null },
        styles: {
          selectedLineStringColor: '#FFFFFF', selectedLineStringWidth: 3,
          selectedPolygonColor: c, selectedPolygonFillOpacity: 0.15, selectedPolygonOutlineColor: '#FFFFFF', selectedPolygonOutlineWidth: 2,
          selectionPointColor: '#FFFFFF', selectionPointOutlineColor: '#0C0D0E', selectionPointWidth: 5, selectionPointOutlineWidth: 2,
          midPointColor: c, midPointOutlineColor: '#0C0D0E', midPointWidth: 3,
        },
      }),
      new TerraDrawLineStringMode({
        pointerDistance: this.snapPx,
        snapping: this.snap(),
        styles: { lineStringColor: c, lineStringWidth: 3, closingPointColor: '#FFFFFF', snappingPointColor: '#FFFFFF', snappingPointOutlineColor: c, coordinatePointColor: c },
      }),
      new TerraDrawPolygonMode({
        pointerDistance: this.snapPx,
        snapping: this.snap(),
        styles: { fillColor: c, fillOpacity: 0.12, outlineColor: c, outlineWidth: 2, closingPointColor: '#FFFFFF', snappingPointColor: '#FFFFFF', snappingPointOutlineColor: c },
      }),
      new TerraDrawRectangleMode({ styles: { fillColor: c, fillOpacity: 0.12, outlineColor: c, outlineWidth: 2 } }),
      new TerraDrawPolygonMode({
        modeName: 'trace',
        pointerDistance: this.snapPx,
        snapping: { toCoordinate: true, toLine: true },
        styles: { fillColor: TRACE, fillOpacity: 0.2, outlineColor: TRACE, outlineWidth: 2, closingPointColor: '#FFFFFF', snappingPointColor: '#FFFFFF', snappingPointOutlineColor: TRACE },
      }),
      new TerraDrawPolygonMode({
        modeName: 'hole',
        pointerDistance: this.snapPx,
        snapping: this.snap(),
        styles: { fillColor: HOLE, fillOpacity: 0.12, outlineColor: HOLE, outlineWidth: 2, closingPointColor: '#FFFFFF', snappingPointColor: '#FFFFFF', snappingPointOutlineColor: HOLE },
      }),
    ];
  }

  /** Line / polygon colours follow the active layer. */
  setColor(color: string) {
    if (color === this.color) return;
    this.color = color as HexColor;
    this.draw.updateModeOptions<typeof TerraDrawLineStringMode>('linestring', { styles: { lineStringColor: this.color, snappingPointOutlineColor: this.color, coordinatePointColor: this.color } } as any);
    this.draw.updateModeOptions<typeof TerraDrawPolygonMode>('polygon', { styles: { fillColor: this.color, outlineColor: this.color, snappingPointOutlineColor: this.color } } as any);
    this.draw.updateModeOptions<typeof TerraDrawRectangleMode>('rectangle', { styles: { fillColor: this.color, outlineColor: this.color } } as any);
  }

  setSnapping(on: boolean) {
    this.snapping = on;
    const snapping = this.snap();
    this.draw.updateModeOptions<typeof TerraDrawLineStringMode>('linestring', { snapping } as any);
    this.draw.updateModeOptions<typeof TerraDrawPolygonMode>('polygon', { snapping } as any);
    this.draw.updateModeOptions<typeof TerraDrawPolygonMode>('hole', { snapping } as any);
  }

  setAllowed(lines: boolean, polys: boolean) {
    this.allowLines = lines;
    this.allowPolys = polys;
  }

  setTool(tool: DrawTool) {
    if (tool === 'off') { this.draw.setMode('static'); return; }
    if (tool === 'trace') { this.draw.setMode('trace'); return; }
    if (tool === 'line' && !this.allowLines) { this.draw.setMode('static'); return; }
    if ((tool === 'polygon' || tool === 'rect' || tool === 'hole') && !this.allowPolys) { this.draw.setMode('static'); return; }
    this.draw.setMode(MODE[tool]);
  }

  /** Replaces what's being edited with the features of a layer. */
  load(features: Feature[]) {
    this.loading = true;
    try { this.loadInner(features); } finally { this.loading = false; }
  }

  private loadInner(features: Feature[]) {
    const mode = this.draw.getMode();
    this.draw.setMode('static');
    this.draw.clear();
    const items: GeoJSONStoreFeatures[] = [];
    for (const f of features) {
      const g = f.geometry;
      if (!g || (g.type !== 'LineString' && g.type !== 'Polygon')) continue;
      const m = g.type === 'LineString' ? 'linestring' : f.properties?.hole ? 'hole' : 'polygon';
      items.push({ type: 'Feature', id: String(f.id), geometry: tidy(g) as any, properties: { ...(f.properties ?? {}), mode: m } } as GeoJSONStoreFeatures);
    }
    if (items.length) {
      const res = this.draw.addFeatures(items);
      const bad = res.filter((r) => !r.valid);
      if (bad.length) console.warn(`${bad.length} vormen konden niet bewerkbaar worden gemaakt`, JSON.stringify(bad.slice(0, 3).map((b) => (b as any).reason)));
    }
    this.rebuildSnapIndex();
    this.draw.setMode(mode);
  }

  features(): Feature[] {
    return this.draw
      .getSnapshot()
      .filter((f) => DRAW_MODES.includes(String(f.properties?.mode)) && !f.properties?.currentlyDrawing && (f.geometry.type === 'LineString' || f.geometry.type === 'Polygon'))
      .map((f) => {
        const { mode, ...props } = (f.properties ?? {}) as Record<string, any>;
        if (mode === 'hole') props.hole = true;
        return { type: 'Feature', id: String(f.id), geometry: f.geometry as any, properties: props } as Feature;
      });
  }

  private commit(finished?: { feature: Feature; mode: string }) {
    this.rebuildSnapIndex();
    this.onCommit(this.features(), finished);
  }

  select(id: string) {
    if (this.draw.hasFeature(id)) {
      if (this.draw.getMode() !== 'select') this.draw.setMode('select');
      this.draw.selectFeature(id);
    }
  }

  deselectAll() {
    for (const f of this.draw.getSnapshot()) if (f.properties?.selected) this.draw.deselectFeature(f.id!);
  }

  selectedId(): string | null {
    const f = this.draw.getSnapshot().find((x) => x.properties?.selected && DRAW_MODES.includes(String(x.properties?.mode)));
    return f ? String(f.id) : null;
  }

  removeSelected(): boolean {
    const id = this.selectedId();
    if (!id) return false;
    this.loading = true;
    this.draw.deselectFeature(id);
    this.draw.removeFeatures([id]);
    this.loading = false;
    this.commit();
    return true;
  }

  /** Puts a shape last in the layer, so it lies on top: a walkable area then wins over holes drawn before it. */
  toTop(id: string) {
    const f = this.draw.getSnapshotFeature(id);
    if (!f) return;
    this.loading = true;
    this.draw.removeFeatures([id]);
    this.draw.addFeatures([{ ...f, properties: { ...f.properties, selected: false } } as GeoJSONStoreFeatures]);
    this.loading = false;
    this.commit();
    this.select(id);
  }

  setProperties(id: string, props: Record<string, any>) {
    if (!this.draw.hasFeature(id)) return;
    this.loading = true;
    this.draw.updateFeatureProperties(id, props);
    if ('hole' in props) {
      // Switching between area and hole: re-add with the other mode so it gets the right style.
      const f = this.draw.getSnapshotFeature(id);
      if (f) {
        this.draw.removeFeatures([id]);
        this.draw.addFeatures([{ ...f, properties: { ...f.properties, mode: props.hole ? 'hole' : 'polygon', selected: false } } as GeoJSONStoreFeatures]);
      }
    }
    this.loading = false;
    this.commit();
  }

  get drawing(): boolean {
    return this.draw.getModeState() === 'drawing';
  }
}

/** Terra Draw only accepts 9 decimals (sub-millimetre) and no repeated points; computed shapes have more. */
function tidy(g: { type: string; coordinates: any }) {
  const r = (c: number[]) => [Math.round(c[0] * 1e9) / 1e9, Math.round(c[1] * 1e9) / 1e9];
  const dedupe = (pts: number[][]) => pts.filter((c, i) => i === 0 || c[0] !== pts[i - 1][0] || c[1] !== pts[i - 1][1]);
  if (g.type === 'LineString') return { type: g.type, coordinates: dedupe(g.coordinates.map(r)) };
  return { type: g.type, coordinates: g.coordinates.map((ring: number[][]) => dedupe(ring.map(r))) };
}
