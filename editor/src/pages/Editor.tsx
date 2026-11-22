import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import * as maplibregl from 'maplibre-gl';
import type { Map as MLMap, Marker } from 'maplibre-gl';
import type { Feature, FeatureCollection, Position } from 'geojson';
import * as turf from '@turf/turf';
import { api } from '../api';
import { Icon, type IconName } from '../icons';
import { Rail } from '../components/Rail';
import { setLastMapId, useLibrary } from '../library';
import type { Facility, Layer, Project } from '../types';
import { SHAPE_CATEGORIES, isVectorKind, isWalkableLayer, layerTakes, makeLayer, newId } from '../types';
import { facilityPolygon, facilityTargets, facilityToLonLat, fmtNum, layerLines, lonLatToFacility, normaliseFeatures, projectBounds, rotationHandle, shapeFromRing } from '../geo';
import { enclosedArea, type Boundary } from '../fill';
import { Vectorizer, areaKey, previewCanvas, sampleCorners, sampleCovers, sampleLayer, type MaskOp, type PickKind, type RunResult, type Sample } from '../vectorize';
import { RoutingGraph, type RouteResult } from '../routing';
import { DrawController, type DrawTool } from '../map/draw';
import { facilityData, layerData, removeLayerAndSource, styleLayers, syncSource } from '../map/render';
import { LayersCard } from '../components/LayersCard';
import { LayerPanel } from '../components/LayerPanel';
import { AddLayerMenu } from '../components/AddLayerMenu';
import { FacilityCard, FeatureCard, PlaceCard, RouteCard, DrawCard, FillCard, VecCard, VEC_DEFAULTS, type PlaceState, type RouteState, type VecState, type VecClick } from '../components/Cards';
import { PublishModal, ImportFileModal, ImageImportModal, CategoryModal } from '../components/Modals';

export type Tool = 'select' | 'line' | 'polygon' | 'rect' | 'hole' | 'fill' | 'wand' | 'place' | 'route';
const TOOLS: { id: Tool; label: string; key: string; icon: IconName }[] = [
  { id: 'select', label: 'Selecteren', key: 'v', icon: 'select' },
  { id: 'line', label: 'Lijn tekenen', key: 'l', icon: 'line' },
  { id: 'polygon', label: 'Vlak tekenen', key: 'g', icon: 'polygon' },
  { id: 'rect', label: 'Rechthoek', key: 'm', icon: 'rect' },
  { id: 'hole', label: 'Gat uitsnijden', key: 'u', icon: 'hole' },
  { id: 'fill', label: 'Ingesloten vlak vullen', key: 'f', icon: 'bucket' },
  { id: 'wand', label: 'Vectoriseren op kleur', key: 'k', icon: 'wand' },
  { id: 'place', label: 'Voorziening plaatsen', key: 'o', icon: 'pin' },
  { id: 'route', label: 'Route testen', key: 't', icon: 'route' },
];

type Selection = { type: 'facility'; id: string } | { type: 'feature'; id: string } | null;
type SaveState = 'saved' | 'saving' | 'dirty' | 'error';

export function Editor() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const { lib, update: updateLib } = useLibrary();

  const [project, setProjectState] = useState<Project | null>(null);
  const projectRef = useRef<Project | null>(null);
  const past = useRef<Project[]>([]);
  const future = useRef<Project[]>([]);
  const [, rerender] = useReducer((x: number) => x + 1, 0);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ msg: string; err?: boolean; busy?: boolean } | null>(null);

  const [tool, setTool] = useState<Tool>('select');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [panelId, setPanelId] = useState<string | null>(null);
  const [panelTab, setPanelTab] = useState<'stijl' | 'gedrag' | 'info'>('stijl');
  const [selection, setSelection] = useState<Selection>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [snapping, setSnapping] = useState(true);
  const [snapPx, setSnapPx] = useState(() => readPref('snapPx', 15));
  const [holeWalkable, setHoleWalkable] = useState(() => readPref('holeWalkable', true));
  const [cutBelow, setCutBelow] = useState(() => readPref('cutBelow', true));
  const [fillGap, setFillGap] = useState(() => readPref('fillGap', 1));
  const [navAdd, setNavAdd] = useState<string | null>(null);
  const sampleRef = useRef<Sample | null>(null);
  const vectorizerRef = useRef<Vectorizer | null>(null);
  const [vec, setVec] = useState<VecState>(() => ({ ...VEC_DEFAULTS, ...readPref<Partial<VecState>>('vec2', {}), sourceId: null, area: null, picks: [], ops: [], click: 'area' }));
  const [vecDraft, setVecDraft] = useState<Position[]>([]);
  const [vecRes, setVecRes] = useState<RunResult | null>(null);
  const [vecBusy, setVecBusy] = useState<string | null>(null);
  const [sampleTick, setSampleTick] = useState(0);
  useEffect(() => {
    const { sourceId, area, picks, ops, click, name, target, ...settings } = vec;
    writePref('vec2', settings);
  }, [vec]);
  useEffect(() => { writePref('snapPx', snapPx); writePref('holeWalkable', holeWalkable); writePref('cutBelow', cutBelow); writePref('fillGap', fillGap); }, [snapPx, holeWalkable, cutBelow, fillGap]);
  const [place, setPlace] = useState<PlaceState>({ category: 'podium', mode: 'trace' });
  // Facilities placed while their layer or category is switched off: shown anyway until that layer is toggled.
  const [forceShown, setForceShown] = useState<Set<string>>(() => new Set());
  const [route, setRoute] = useState<RouteState>({ mode: 'near', start: null, end: null, category: 'wc' });
  const [modal, setModal] = useState<
    | null
    | { type: 'export' }
    | { type: 'importFile'; file: File }
    | { type: 'image'; file: File }
    | { type: 'crop'; layerId: string }
    | { type: 'category' }
    | { type: 'deleteLayer'; layerId: string }
  >(null);
  const [cursor, setCursor] = useState<[number, number] | null>(null);
  const [scale, setScale] = useState<{ label: string; px: number }>({ label: '', px: 0 });

  const mapEl = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const drawRef = useRef<DrawController | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const lastFromDraw = useRef<FeatureCollection | null>(null);
  const markers = useRef(new Map<string, Marker>());
  const extraMarkers = useRef<Marker[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);

  // ---------- project state + history ----------
  const setProject = useCallback((p: Project) => { projectRef.current = p; setProjectState(p); }, []);
  const coalesce = useRef<{ key: string; t: number } | null>(null);
  const commit = useCallback((fn: (p: Project) => Project, opts: { history?: boolean; key?: string } = {}) => {
    const cur = projectRef.current;
    if (!cur) return;
    const next = fn(cur);
    if (next === cur) return;
    // history:false = a burst of small edits (slider, typing): one undo step per burst.
    const now = Date.now();
    const burst = opts.history === false && coalesce.current && coalesce.current.key === opts.key && now - coalesce.current.t < 1500;
    coalesce.current = opts.history === false ? { key: opts.key ?? '', t: now } : null;
    if (!burst) {
      past.current.push(cur);
      if (past.current.length > 150) past.current.shift();
      future.current = [];
    }
    setProject(next);
    setSaveState('dirty');
  }, [setProject]);
  const updateLayer = useCallback((layerId: string, patch: Partial<Layer> | ((l: Layer) => Layer), opts?: { history?: boolean }) => {
    commit((p) => ({ ...p, layers: p.layers.map((l) => (l.id === layerId ? (typeof patch === 'function' ? patch(l) : { ...l, ...patch }) : l)) }), { ...opts, key: `L${layerId}:${typeof patch === 'function' ? '' : Object.keys(patch).join()}` });
  }, [commit]);
  const updateFacility = useCallback((fid: string, patch: Partial<Facility>, opts?: { history?: boolean }) => {
    commit((p) => ({ ...p, facilities: p.facilities.map((f) => (f.id === fid ? { ...f, ...patch } : f)) }), { ...opts, key: `F${fid}:${Object.keys(patch).join()}` });
  }, [commit]);
  const undo = useCallback(() => {
    const prev = past.current.pop();
    if (!prev || !projectRef.current) return;
    future.current.push(projectRef.current);
    setProject(prev); setSaveState('dirty'); rerender();
  }, [setProject]);
  const redo = useCallback(() => {
    const next = future.current.pop();
    if (!next || !projectRef.current) return;
    past.current.push(projectRef.current);
    setProject(next); setSaveState('dirty'); rerender();
  }, [setProject]);

  useEffect(() => {
    if (!toast || toast.busy) return;
    const t = window.setTimeout(() => setToast(null), toast.err ? 7000 : 3500);
    return () => window.clearTimeout(t);
  }, [toast]);

  // ---------- load ----------
  useEffect(() => {
    setLastMapId(id);
    api.project(id).then((p) => {
      setProject(p);
      const firstVector = p.layers.find((l) => l.kind === 'beloopbaar') ?? p.layers.find((l) => isVectorKind(l.kind));
      setActiveId(firstVector?.id ?? null);
    }).catch((e) => setLoadError(e.message));
  }, [id, setProject]);

  useEffect(() => {
    if (params.get('export')) { setModal({ type: 'export' }); params.delete('export'); setParams(params, { replace: true }); }
  }, [params]);

  // ---------- autosave ----------
  // Organisers only look: their changes (e.g. panning, toggling layers) stay in the browser.
  const readonly = project?.access === 'view';
  useEffect(() => {
    if (saveState !== 'dirty' || !project) return;
    if (readonly) { setSaveState('saved'); return; }
    const t = window.setTimeout(async () => {
      setSaveState('saving');
      try {
        await api.saveProject(projectRef.current!);
        setSaveState((s) => (s === 'saving' ? 'saved' : s));
      } catch (e: any) { setSaveState('error'); setToast({ msg: e.message, err: true }); }
    }, 600);
    return () => window.clearTimeout(t);
  }, [project, saveState, readonly]);
  const flushSave = useCallback(async () => {
    if (readonly) return;
    if (projectRef.current && saveState !== 'saved') { await api.saveProject(projectRef.current); setSaveState('saved'); }
  }, [saveState, readonly]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (saveState === 'dirty' || saveState === 'saving') e.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [saveState]);

  // ---------- derived ----------
  const layers = project?.layers ?? [];
  const active = layers.find((l) => l.id === activeId) ?? null;
  const facLayer = layers.find((l) => l.kind === 'voorzieningen') ?? null;
  // A hidden layer isn't edited: its shapes would otherwise still show through the drawing tool.
  const editable = !!active && isVectorKind(active.kind) && !active.locked && active.visible;
  const selectedFacId = selection?.type === 'facility' ? selection.id : null;
  const facShown = useCallback((f: Facility) => {
    if (f.id === selectedFacId || forceShown.has(f.id)) return true;
    return !!facLayer?.visible && !(facLayer.hiddenCats ?? []).includes(f.category);
  }, [facLayer?.visible, facLayer?.hiddenCats, forceShown, selectedFacId]);
  const graphCache = useRef<{ key: unknown[]; graph: RoutingGraph } | null>(null);
  const graph = useMemo(() => {
    if (!project) return null;
    const key = project.layers.filter(isWalkableLayer).flatMap((l) => [l.features, l.kind, l.walkable]);
    const c = graphCache.current;
    if (c && c.key.length === key.length && c.key.every((k, i) => k === key[i])) return c.graph;
    const g = new RoutingGraph(project.layers);
    graphCache.current = { key, graph: g };
    return g;
  }, [project?.layers]);
  const stats = useMemo(() => {
    const paths = layers.filter(isWalkableLayer).reduce((n, l) => n + layerLines(l).length, 0);
    const comps = graph ? graph.components() : 0;
    return { paths, loose: Math.max(0, comps - 1), facilities: project?.facilities.length ?? 0 };
  }, [graph, layers, project?.facilities.length]);

  const routeResult = useMemo((): { res: RouteResult | null; target?: Facility; failed: boolean } | null => {
    if (!graph || !route.start || !project) return null;
    if (route.mode === 'ab') {
      if (!route.end) return null;
      const res = graph.route(route.start, route.end);
      return { res, failed: !res };
    }
    const targets = project.facilities.filter((f) => f.category === route.category).flatMap((f) => facilityTargets(f).map((pos) => ({ id: f.id, pos: pos as Position })));
    if (!targets.length) return { res: null, failed: true };
    const best = graph.nearestOf(route.start, targets);
    return best ? { res: best.route, target: project.facilities.find((f) => f.id === best.id), failed: false } : { res: null, failed: true };
  }, [graph, route, project?.facilities]);

  const gpsDot = useMemo(() => (graph && route.start && project ? graph.locate(route.start, project.layers) : null), [graph, route.start, project?.layers]);

  // ---------- colour vectorising: the result follows the sample, the picks and the settings ----------
  const rasterLayers = layers.filter((l) => l.kind === 'pdok' || (l.kind === 'image' && l.image?.warped));
  useEffect(() => {
    if (tool !== 'wand') return;
    if (!vec.sourceId || !rasterLayers.some((l) => l.id === vec.sourceId)) {
      const first = rasterLayers.find((l) => l.kind === 'image' && l.visible) ?? rasterLayers.find((l) => l.visible) ?? rasterLayers[0];
      if (first) setVec((v) => ({ ...v, sourceId: first.id }));
    }
  }, [tool, rasterLayers.map((l) => l.id).join()]);
  useEffect(() => () => vectorizerRef.current?.dispose(), []);

  /** The image the search runs on: the drawn area (or the whole plan) at full resolution. Independent of the zoom. */
  const sampleFits = (cur: Sample | null, src: Layer) => !!cur && cur.layerId === src.id && cur.areaKey === areaKey(vec.area) && (src.kind !== 'pdok' || cur.res === vec.res);
  const ensureSample = async (force = false): Promise<Sample | null> => {
    const p = projectRef.current!;
    const src = p.layers.find((l) => l.id === vec.sourceId);
    if (!src) { setToast({ msg: 'Kies in het paneel rechts een beeldlaag om van te vectoriseren', err: true }); return null; }
    if (!force && sampleFits(sampleRef.current, src)) return sampleRef.current;
    setVecBusy('Beeld ophalen…');
    try {
      const smp = await sampleLayer(src, p.id, vec.res, vec.area);
      sampleRef.current = smp;
      setSampleTick((t) => t + 1);
      return smp;
    } catch (e: any) {
      setToast({ msg: e.message, err: true });
      return null;
    } finally { setVecBusy(null); }
  };
  // A different source, area or resolution: fetch again.
  useEffect(() => {
    if (tool !== 'wand' || !vec.sourceId) return;
    const src = projectRef.current?.layers.find((l) => l.id === vec.sourceId);
    if (!src || sampleFits(sampleRef.current, src)) return;
    if (vec.area || vec.picks.length || vec.ops.length || vec.showPrep) void ensureSample();
  }, [tool, vec.sourceId, vec.res, vec.area, vec.showPrep]);
  useEffect(() => {
    const smp = sampleRef.current;
    if (tool !== 'wand' || !smp || smp.layerId !== vec.sourceId || smp.areaKey !== areaKey(vec.area) || (!vec.picks.length && !vec.ops.length && !vec.showPrep)) { setVecRes(null); return; }
    let live = true;
    const t = window.setTimeout(async () => {
      vectorizerRef.current ??= new Vectorizer();
      setVecBusy('Rekenen…');
      try {
        const res = await vectorizerRef.current.run(smp, {
          picks: vec.picks, ops: vec.ops, scope: vec.scope, reach: vec.reach, smooth: vec.smooth, bright: vec.bright, contrast: vec.contrast, sat: vec.sat,
          bridge: vec.bridge, speck: vec.speck, holes: vec.holes, output: vec.output, simplify: vec.simplify, minLength: vec.minLength, wantPreview: vec.showPrep,
        });
        if (live && res) setVecRes(res);
      } catch (e: any) { if (live) setToast({ msg: `Vectoriseren mislukt: ${e.message}`, err: true }); }
      finally { if (live) setVecBusy(null); }
    }, 120);
    return () => { live = false; window.clearTimeout(t); };
  }, [tool, sampleTick, vec.sourceId, vec.picks, vec.ops, vec.scope, vec.reach, vec.smooth, vec.bright, vec.contrast, vec.sat, vec.bridge, vec.speck, vec.holes, vec.output, vec.simplify, vec.minLength, vec.showPrep]);
  // "What the computer sees": the prepared image on the map.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const smp = sampleRef.current;
    const show = tool === 'wand' && vec.showPrep && vecRes?.preview && smp;
    if (map.getLayer('vecimg')) map.removeLayer('vecimg');
    if (map.getSource('src-vecimg')) map.removeSource('src-vecimg');
    if (!show) return;
    map.addSource('src-vecimg', { type: 'canvas', canvas: previewCanvas(smp!, vecRes!.preview!), coordinates: sampleCorners(smp!), animate: false });
    map.addLayer({ id: 'vecimg', type: 'raster', source: 'src-vecimg', paint: { 'raster-opacity': 1, 'raster-fade-duration': 0, 'raster-resampling': 'nearest' } }, map.getLayer('aux-fill') ? 'aux-fill' : undefined);
  }, [vecRes, vec.showPrep, tool, mapReady]);

  // ---------- map ----------
  useEffect(() => {
    if (!project || mapRef.current || !mapEl.current) return;
    const b = projectBounds(project);
    const map = new maplibregl.Map({
      container: mapEl.current,
      style: { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#141617' } }] },
      center: project.view?.center ?? (b ? [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2] : [5.3, 52.2]),
      zoom: project.view?.zoom ?? (b ? 15 : 7),
      maxZoom: 22,
      attributionControl: { compact: true },
      dragRotate: false,
      boxZoom: false,
    });
    if (!project.view && b) map.fitBounds(b, { padding: 80, duration: 0 });
    mapRef.current = map;
    map.on('load', () => {
      const draw = new DrawController(map);
      drawRef.current = draw;
      setMapReady(true);
    });
    const updScale = () => {
      const lat = map.getCenter().lat;
      const mpp = (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** map.getZoom();
      const nice = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000, 10000, 20000, 50000];
      const m = nice.find((n) => n / mpp >= 60) ?? 50000;
      setScale({ label: m >= 1000 ? `${m / 1000} km` : `${m} m`, px: Math.round(m / mpp) });
    };
    map.on('move', updScale);
    map.on('load', updScale);
    map.on('mousemove', (e) => setCursor([e.lngLat.lng, e.lngLat.lat]));
    map.on('moveend', () => {
      const c = map.getCenter();
      const view = { center: [c.lng, c.lat] as [number, number], zoom: map.getZoom() };
      const cur = projectRef.current;
      if (cur) { projectRef.current = { ...cur, view }; setProjectState(projectRef.current); setSaveState((s) => (s === 'saved' ? 'dirty' : s)); }
    });
    return () => { map.remove(); mapRef.current = null; drawRef.current = null; setMapReady(false); };
  }, [project ? project.id : null]);

  // Sources + style layers follow the layer stack.
  const dataCache = useRef(new WeakMap<object, FeatureCollection>());
  const styleSig = useRef('');
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !project) return;
    const getData = (l: Layer) => {
      if (!l.features) return undefined;
      let d = dataCache.current.get(l.features);
      if (!d) { d = layerData(l); dataCache.current.set(l.features, d); }
      return d;
    };
    for (const l of project.layers) if (l.kind !== 'voorzieningen') syncSource(map, l, project.id, getData(l));
    // drop sources of removed layers
    const ids = new Set(project.layers.map((l) => l.id));
    for (const s of Object.keys(map.getStyle().sources ?? {})) {
      const m = /^src-(.+)$/.exec(s);
      if (m && !['fac', 'route', 'aux'].includes(m[1]) && !ids.has(m[1])) removeLayerAndSource(map, m[1]);
    }
    const facSel = selection?.type === 'facility' ? selection.id : null;
    const facData = facilityData(project.facilities, lib, facSel, facShown);
    if (map.getSource('src-fac')) (map.getSource('src-fac') as any).setData(facData);
    else map.addSource('src-fac', { type: 'geojson', data: facData });

    const sig = JSON.stringify(project.layers.map((l) => [l.id, l.kind, l.visible, l.opacity, l.style, l.pdokLayer, l.image?.warped?.version]));
    if (sig !== styleSig.current || !map.getLayer('route-line')) {
      styleSig.current = sig;
      for (const ly of map.getStyle().layers ?? []) if (ly.id.startsWith('L-') || ly.id.startsWith('route-')) map.removeLayer(ly.id);
      const before = (map.getStyle().layers ?? []).find((x) => x.id.startsWith('td-'))?.id;
      for (const l of [...project.layers].reverse()) {
        if (l.kind === 'voorzieningen') {
          const op = l.opacity / 100; // which facilities show is decided per facility (facShown)
          map.addLayer({ id: `L-${l.id}-ffill`, type: 'fill', source: 'src-fac', paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.3 * op } }, before);
          map.addLayer({ id: `L-${l.id}-fline`, type: 'line', source: 'src-fac', paint: { 'line-color': ['case', ['get', 'selected'], '#FFFFFF', ['get', 'color']], 'line-width': ['case', ['get', 'selected'], 2.2, 1.6], 'line-opacity': op } }, before);
          continue;
        }
        for (const spec of styleLayers(map, l, project.id)) map.addLayer(spec, before);
      }
      if (!map.getSource('src-route')) map.addSource('src-route', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({ id: 'route-glow', type: 'line', source: 'src-route', filter: ['==', ['get', 'part'], 'net'], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#D4F56A', 'line-width': 12, 'line-opacity': 0.18 } }, before);
      map.addLayer({ id: 'route-line', type: 'line', source: 'src-route', filter: ['==', ['get', 'part'], 'net'], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#D4F56A', 'line-width': 4 } }, before);
      map.addLayer({ id: 'route-dash', type: 'line', source: 'src-route', filter: ['==', ['get', 'part'], 'off'], layout: { 'line-cap': 'round' }, paint: { 'line-color': '#D4F56A', 'line-width': 2.5, 'line-dasharray': [1, 2] } }, before);
      if (!map.getSource('src-aux')) map.addSource('src-aux', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      for (const ly of ['aux-fill', 'aux-line', 'aux-dash', 'aux-pt']) if (map.getLayer(ly)) map.removeLayer(ly);
      map.addLayer({ id: 'aux-fill', type: 'fill', source: 'src-aux', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': ['coalesce', ['get', 'color'], '#FF4FD8'], 'fill-opacity': ['coalesce', ['get', 'fo'], 0] } }, before);
      map.addLayer({ id: 'aux-line', type: 'line', source: 'src-aux', filter: ['all', ['!=', ['geometry-type'], 'Point'], ['!', ['to-boolean', ['get', 'dash']]]], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['coalesce', ['get', 'color'], '#FF4FD8'], 'line-width': ['coalesce', ['get', 'lw'], 2] } }, before);
      map.addLayer({ id: 'aux-dash', type: 'line', source: 'src-aux', filter: ['all', ['!=', ['geometry-type'], 'Point'], ['to-boolean', ['get', 'dash']]], paint: { 'line-color': ['coalesce', ['get', 'color'], '#FFFFFF'], 'line-width': ['coalesce', ['get', 'lw'], 1.5], 'line-opacity': ['coalesce', ['get', 'lo'], 1], 'line-dasharray': [2, 2] } }, before);
      map.addLayer({ id: 'aux-pt', type: 'circle', source: 'src-aux', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': ['coalesce', ['get', 'r'], 3.5], 'circle-color': ['coalesce', ['get', 'fill'], '#0C0D0E'], 'circle-stroke-color': ['coalesce', ['get', 'color'], '#FFFFFF'], 'circle-stroke-width': 2, 'circle-opacity': ['coalesce', ['get', 'po'], 1], 'circle-stroke-opacity': ['coalesce', ['get', 'po'], 1] } }, before);
    }
  }, [project, mapReady, lib, selection, facShown]);

  // Preview of colour vectorising + navigation points of all facilities
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !project) return;
    const src = map.getSource('src-aux') as any;
    if (!src) return;
    const feats: Feature[] = [];
    if (tool === 'wand') {
      // Where the search runs: the drawn area.
      if (vec.area) feats.push(turf.lineString([...vec.area, vec.area[0]], { dash: true, color: '#FFFFFF', lo: 0.9, lw: 2 }));
      for (const f of vecRes?.others.features ?? []) feats.push({ ...f, properties: { dash: true, color: '#FF4FD8', lo: 0.9, lw: 1.5 } });
      for (const f of vecRes?.features ?? []) feats.push({ ...f, properties: { part: 'vec', color: '#FF4FD8', fo: 0.3, lw: 2.2 } });
      for (const op of vec.ops) {
        if (op.type === 'line') feats.push(turf.lineString(op.line, { color: '#FF6B6B', lw: 3 }));
        else if (op.type === 'fill') feats.push(turf.point(op.pos, { color: '#D4F56A', fill: '#D4F56A', r: 4 }));
        else feats.push(turf.polygon([[...op.ring, op.ring[0]]], { color: op.type === 'add' ? '#D4F56A' : '#FF6B6B', fo: 0.12, dash: true, lw: 2 }));
      }
      if (vecDraft.length) {
        const c = vec.click === 'area' ? '#FFFFFF' : vec.click === 'add' ? '#D4F56A' : '#FF6B6B';
        if (vecDraft.length >= 3 && vec.click !== 'line') feats.push(turf.polygon([[...vecDraft, vecDraft[0]]], { color: c, fo: 0.15, lw: 0 }));
        if (vecDraft.length >= 2) feats.push(turf.lineString(vecDraft, { color: c, lw: 2, dash: vec.click !== 'line' }));
        vecDraft.forEach((q, i) => feats.push(turf.point(q, { color: c, fill: i === 0 ? c : '#0C0D0E', r: i === 0 ? 5 : 3.5 })));
      }
      const kc: Record<PickKind, string> = { pick: '#D4F56A', exclude: '#FF6B6B' };
      vec.picks.forEach((pk, i) => feats.push(turf.point(pk.pos, { color: kc[pk.kind], fill: (vec.showPrep ? vecRes?.picks[i]?.shown : vecRes?.picks[i]?.hex) ?? '#0C0D0E', r: 6 })));
    }
    for (const f of project.facilities) {
      if (!f.nav?.length || !facShown(f)) continue;
      const color = lib.categories.find((c) => c.id === f.category)?.color ?? '#F5B84A';
      const sel = selection?.type === 'facility' && selection.id === f.id;
      for (const pos of facilityTargets(f)) {
        if (!sel) feats.push(turf.point(pos, { part: 'nav', color }));
        feats.push(turf.lineString([[f.lon, f.lat], pos], { part: 'navlink', dash: true, lw: 1.2, lo: 0.6, color: '#FFFFFF' }));
      }
    }
    src.setData({ type: 'FeatureCollection', features: feats });
  }, [vecRes, vec.showPrep, vec.area, vec.ops, vec.picks, vec.click, vecDraft, tool, project?.facilities, selection, mapReady, lib.categories, project?.layers, facShown, sampleTick, vec.sourceId]);

  // Route geometry
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const src = map.getSource('src-route') as any;
    if (!src) return;
    const feats: Feature[] = [];
    if (tool === 'route' && routeResult?.res) {
      const r = routeResult.res;
      feats.push(turf.lineString(r.network.length >= 2 ? r.network : r.coords, { part: 'net' }));
      feats.push(turf.lineString([r.coords[0], r.network[0] ?? r.coords[0]], { part: 'off' }));
      feats.push(turf.lineString([r.network[r.network.length - 1] ?? r.coords[r.coords.length - 1], r.coords[r.coords.length - 1]], { part: 'off' }));
    }
    src.setData({ type: 'FeatureCollection', features: feats });
  }, [routeResult, tool, mapReady, project]);

  // ---------- Terra Draw follows the active layer ----------
  useEffect(() => {
    const draw = drawRef.current;
    if (!draw || !mapReady) return;
    draw.onCommit = (features, finished) => {
      const aid = activeIdRef.current!;
      const fc: FeatureCollection = { type: 'FeatureCollection', features };
      lastFromDraw.current = fc;
      const extra = finished ? afterDrawRef.current(aid, finished) : null;
      if (!extra) { updateLayer(aid, { features: fc }); return; }
      commit((p) => extra({ ...p, layers: p.layers.map((l) => (l.id === aid ? { ...l, features: fc } : l)) }));
    };
    draw.onTrace = (f) => traceRef.current(f);
    draw.onSelect = (fid) => setSelection(fid ? { type: 'feature', id: fid } : (s) => (s?.type === 'feature' ? null : s));
  }, [mapReady, updateLayer, commit]);
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;

  useEffect(() => {
    const draw = drawRef.current;
    if (!draw || !mapReady) return;
    if (!editable || !active) { draw.load([]); lastFromDraw.current = null; return; }
    if (active.features !== lastFromDraw.current) {
      draw.load(active.features?.features ?? []);
      lastFromDraw.current = active.features ?? null;
    }
    draw.setColor(active.style.color);
    const lines = ['beloopbaar', 'hekken', 'eigen'].includes(active.kind);
    const polys = active.kind !== 'hekken';
    draw.setAllowed(lines, polys);
  }, [mapReady, activeId, active?.features, editable, active?.style.color]);

  useEffect(() => {
    const draw = drawRef.current;
    if (!draw || !mapReady) return;
    const map: Record<Tool, DrawTool> = { select: 'select', line: 'line', polygon: 'polygon', rect: 'rect', hole: 'hole', fill: 'off', wand: 'off', place: 'off', route: 'off' };
    const tracing = tool === 'place' && place.mode === 'trace' && !facLayer?.locked;
    draw.setTool(tracing ? 'trace' : editable ? map[tool] : 'off');
    mapRef.current!.getCanvas().style.cursor = tracing ? '' : tool === 'place' || tool === 'route' || tool === 'fill' || tool === 'wand' || navAdd ? 'crosshair' : '';
  }, [tool, editable, mapReady, activeId, place.mode, facLayer?.locked, navAdd]);

  useEffect(() => { drawRef.current?.setSnapping(snapping); }, [snapping, mapReady]);
  // Clicking corners quickly in the vectorise tool must not zoom the map.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    if (tool === 'wand') map.doubleClickZoom.disable(); else map.doubleClickZoom.enable();
  }, [tool, mapReady, editable]);
  useEffect(() => { drawRef.current?.setSnapPx(snapPx); }, [snapPx, mapReady]);
  useEffect(() => { if (tool !== 'select') setNavAdd(null); if (tool !== 'place') setPlace((s) => (s.mode === 'trace' ? { ...s, mode: 'point', attachTo: undefined } : s)); }, [tool]);
  useEffect(() => { if (navAdd && !(selection?.type === 'facility' && selection.id === navAdd)) setNavAdd(null); }, [selection]);

  // Snap radius ring around the pointer while drawing
  const ringEl = useRef<HTMLDivElement>(null);
  const drawingTool = (['line', 'polygon', 'hole'].includes(tool) && editable) || (tool === 'place' && place.mode === 'trace' && !facLayer?.locked);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const move = (e: maplibregl.MapMouseEvent) => { const el = ringEl.current; if (el) { el.style.transform = `translate(${e.point.x}px, ${e.point.y}px)`; el.style.opacity = '1'; } };
    const out = () => { if (ringEl.current) ringEl.current.style.opacity = '0'; };
    map.on('mousemove', move);
    map.on('mouseout', out);
    return () => { map.off('mousemove', move); map.off('mouseout', out); };
  }, [mapReady]);

  // Keep TD selection in sync when switching layers
  useEffect(() => { setSelection((s) => (s?.type === 'feature' ? null : s)); }, [activeId]);

  // ---------- facility markers ----------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !project) return;
    const op = facLayer ? facLayer.opacity / 100 : 1;
    const locked = !!facLayer?.locked;
    const seen = new Set<string>();
    for (const f of project.facilities) {
      seen.add(f.id);
      const cat = lib.categories.find((c) => c.id === f.category);
      const shaped = !!facilityPolygon(f);
      const sel = selection?.type === 'facility' && selection.id === f.id;
      const visible = facShown(f);
      let m = markers.current.get(f.id);
      if (!m) {
        const el = document.createElement('button');
        el.className = 'fac-marker';
        el.addEventListener('click', (e) => { e.stopPropagation(); setSelection({ type: 'facility', id: f.id }); drawRef.current?.deselectAll(); });
        m = new maplibregl.Marker({ element: el, draggable: true }).setLngLat([f.lon, f.lat]).addTo(map);
        m.on('drag', () => {
          const ll = m!.getLngLat();
          const cur = projectRef.current!;
          const live = cur.facilities.map((x) => (x.id === f.id ? { ...x, lon: ll.lng, lat: ll.lat } : x));
          (map.getSource('src-fac') as any)?.setData(facilityData(live, libRef.current, f.id, facShownRef.current));
        });
        m.on('dragend', () => { const ll = m!.getLngLat(); updateFacility(f.id, { lon: ll.lng, lat: ll.lat }); setSelection({ type: 'facility', id: f.id }); });
        markers.current.set(f.id, m);
      }
      const el = m.getElement() as HTMLButtonElement;
      const color = cat?.color ?? '#F5B84A';
      el.title = `${cat?.name ?? f.category}${f.name ? ` · ${f.name}` : ''}`;
      el.setAttribute('aria-label', el.title);
      // One icon per facility, in the middle (also for a traced outline).
      el.textContent = cat?.label ?? '•';
      const size = shaped ? 26 : 30;
      el.style.cssText = `width:${size}px;height:${size}px;border-radius:50%;background:${sel ? '#fff' : '#1A1C1E'};color:${sel ? '#0C0D0E' : color};border:2px solid ${sel ? '#fff' : color};font:700 ${shaped ? 8 : 9}px Inter,sans-serif;display:${visible ? 'flex' : 'none'};align-items:center;justify-content:center;cursor:${tool === 'select' && !locked ? 'move' : 'pointer'};padding:0;opacity:${op};box-shadow:0 2px 8px rgba(0,0,0,.4)`;
      m.setLngLat([f.lon, f.lat]);
      m.setDraggable(!locked && tool === 'select');
    }
    for (const [fid, m] of markers.current) if (!seen.has(fid)) { m.remove(); markers.current.delete(fid); }
  }, [project?.facilities, lib, selection, mapReady, facShown, facLayer?.opacity, facLayer?.locked, tool]);
  const libRef = useRef(lib);
  libRef.current = lib;
  const facShownRef = useRef(facShown);
  facShownRef.current = facShown;

  // Rotation handle + route endpoints
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !project) return;
    for (const m of extraMarkers.current) m.remove();
    extraMarkers.current = [];
    if (selection?.type === 'facility' && tool === 'select' && !facLayer?.locked) {
      const f = project.facilities.find((x) => x.id === selection.id);
      if (f && facilityPolygon(f)) {
        const el = document.createElement('div');
        el.title = 'Sleep om te draaien';
        el.style.cssText = 'width:14px;height:14px;border-radius:50%;background:#0C0D0E;border:2px solid #fff;cursor:grab';
        const h = new maplibregl.Marker({ element: el, draggable: true }).setLngLat(rotationHandle(f)).addTo(map);
        const angle = () => {
          const ll = h.getLngLat();
          const dx = (ll.lng - f.lon) * Math.cos((f.lat * Math.PI) / 180);
          const dy = ll.lat - f.lat;
          let a = (Math.atan2(dx, dy) * 180) / Math.PI;
          a = Math.round(a);
          return ((a % 360) + 360) % 360;
        };
        h.on('drag', () => {
          const live = projectRef.current!.facilities.map((x) => (x.id === f.id ? { ...x, rotation: angle() } : x));
          (map.getSource('src-fac') as any)?.setData(facilityData(live, libRef.current, f.id, facShownRef.current));
        });
        h.on('dragend', () => updateFacility(f.id, { rotation: angle() }));
        extraMarkers.current.push(h);
      }
    }
    if (selection?.type === 'facility' && (tool === 'select' || tool === 'route')) {
      const f = project.facilities.find((x) => x.id === selection.id);
      const color = lib.categories.find((c) => c.id === f?.category)?.color ?? '#F5B84A';
      (f?.nav ?? []).forEach((o, i) => {
        const el = document.createElement('div');
        el.title = `Navigatiepunt ${i + 1}: hier eindigen routes naar deze voorziening. Sleep om te verplaatsen.`;
        el.textContent = String(i + 1);
        el.style.cssText = `width:20px;height:20px;border-radius:6px;background:#0C0D0E;color:${color};border:2px solid ${color};font:700 10px Inter,sans-serif;display:flex;align-items:center;justify-content:center;cursor:${facLayer?.locked ? 'default' : 'move'};box-shadow:0 2px 6px rgba(0,0,0,.5)`;
        const m = new maplibregl.Marker({ element: el, draggable: !facLayer?.locked && tool === 'select' }).setLngLat(facilityToLonLat(f!, o)).addTo(map);
        m.on('dragend', () => {
          const cur = projectRef.current!.facilities.find((x) => x.id === f!.id);
          if (!cur?.nav) return;
          const ll = m.getLngLat();
          updateFacility(cur.id, { nav: cur.nav.map((q, j) => (j === i ? lonLatToFacility(cur, [ll.lng, ll.lat]) : q)) });
        });
        extraMarkers.current.push(m);
      });
    }
    if (tool === 'route' && gpsDot && (gpsDot.snapped || gpsDot.semi)) {
      const el = document.createElement('div');
      el.title = 'Hier tekent de app je GPS-stip';
      el.style.cssText = 'width:14px;height:14px;border-radius:50%;background:#3B82F6;border:2.5px solid #fff;box-shadow:0 0 0 6px rgba(59,130,246,.25)';
      extraMarkers.current.push(new maplibregl.Marker({ element: el }).setLngLat(gpsDot.pos as [number, number]).addTo(map));
    }
    if (tool === 'route') {
      const mk = (pos: Position, color: string, round: boolean) => {
        const el = document.createElement('div');
        el.style.cssText = `width:16px;height:16px;border-radius:${round ? '50%' : '4px'};background:${color};border:2.5px solid #0C0D0E;box-shadow:0 0 0 2px ${color}55`;
        extraMarkers.current.push(new maplibregl.Marker({ element: el }).setLngLat(pos as [number, number]).addTo(map));
      };
      if (route.start) mk(route.start, '#D4F56A', true);
      if (route.mode === 'ab' && route.end) mk(route.end, '#F2F3F4', false);
    }
  }, [selection, project?.facilities, lib, tool, route, mapReady, facLayer?.locked, gpsDot]);

  // ---------- map clicks ----------
  const clickRef = useRef<(e: maplibregl.MapMouseEvent) => void>(() => {});
  clickRef.current = (e) => {
    const map = mapRef.current!;
    const p = projectRef.current!;
    const ll: Position = [e.lngLat.lng, e.lngLat.lat];
    if (tool === 'place') {
      if (place.mode === 'trace') return; // the clicks are the corners of the outline (Terra Draw), not new facilities
      if (facLayer?.locked) { setToast({ msg: 'De laag Voorzieningen is vergrendeld', err: true }); return; }
      const fl = p.layers.find((l) => l.kind === 'voorzieningen');
      const f: Facility = { id: newId(), category: place.category, name: '', notes: '', lon: ll[0], lat: ll[1], rotation: 0 };
      commit((cur) => ({ ...cur, layers: fl ? cur.layers : [makeLayer('voorzieningen'), ...cur.layers], facilities: [...cur.facilities, f] }));
      keepVisible(f.id, f.category);
      setSelection({ type: 'facility', id: f.id });
      return;
    }
    if (tool === 'fill') { fillAt(ll); return; }
    if (tool === 'wand') { void wandAt(e, ll); return; }
    if (tool === 'select' && navAdd) {
      if (facLayer?.locked) { setToast({ msg: 'De laag Voorzieningen is vergrendeld', err: true }); return; }
      addNavPoint(navAdd, ll);
      return;
    }
    if (tool === 'route') {
      setRoute((r) => (r.mode === 'near' ? { ...r, start: ll } : !r.start || r.end ? { ...r, start: ll, end: null } : { ...r, end: ll }));
      return;
    }
    if (tool !== 'select') return;
    const facIds = p.layers.filter((l) => l.kind === 'voorzieningen').map((l) => `L-${l.id}-ffill`);
    const facHit = facIds.length ? map.queryRenderedFeatures(e.point, { layers: facIds.filter((x) => map.getLayer(x)) }) : [];
    if (facHit.length) {
      drawRef.current?.deselectAll();
      setSelection({ type: 'facility', id: String(facHit[0].properties.id) });
      return;
    }
    window.setTimeout(() => {
      if (drawRef.current?.selectedId()) { setSelection((s) => (s?.type === 'facility' ? null : s)); return; }
      // A feature of another (unlocked) vector layer: make that layer active and select it.
      const candidates = p.layers.filter((l) => isVectorKind(l.kind) && l.visible && !l.locked && l.id !== activeIdRef.current);
      const ids = candidates.flatMap((l) => [`L-${l.id}-line`, `L-${l.id}-fill`, `L-${l.id}-edge`]).filter((x) => map.getLayer(x));
      const hits = ids.length ? map.queryRenderedFeatures(e.point, { layers: ids }) : [];
      if (hits.length) {
        const lid = hits[0].layer.id.split('-').slice(1, -1).join('-');
        const fid = hits[0].properties._id;
        setActiveId(lid);
        if (fid) window.setTimeout(() => drawRef.current?.select(String(fid)), 50);
        return;
      }
      setSelection(null);
    }, 0);
  };
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const fn = (e: maplibregl.MapMouseEvent) => clickRef.current(e);
    map.on('click', fn);
    return () => { map.off('click', fn); };
  }, [mapReady]);

  // ---------- actions ----------
  /** A facility you just placed stays visible, even when its layer or category is switched off. */
  const keepVisible = (fid: string, category: string) => {
    const fl = projectRef.current?.layers.find((l) => l.kind === 'voorzieningen');
    if (fl && fl.visible && !(fl.hiddenCats ?? []).includes(category)) return;
    setForceShown((s) => new Set(s).add(fid));
  };
  const toggleLayer = (lid: string) => {
    const l = projectRef.current?.layers.find((x) => x.id === lid);
    if (l?.kind === 'voorzieningen') setForceShown(new Set());
    updateLayer(lid, (x) => ({ ...x, visible: !x.visible }));
  };
  const toggleCategory = (lid: string, cat: string) => {
    setForceShown((s) => { const n = new Set(s); for (const f of projectRef.current?.facilities ?? []) if (f.category === cat) n.delete(f.id); return n; });
    updateLayer(lid, (l) => { const h = l.hiddenCats ?? []; return { ...l, hiddenCats: h.includes(cat) ? h.filter((c) => c !== cat) : [...h, cat] }; });
  };
  const flyTo = (feature: Feature) => {
    const map = mapRef.current;
    if (!map) return;
    const [w, so, e, n] = turf.bbox(feature);
    if (w === e && so === n) map.easeTo({ center: [w, so], zoom: Math.max(map.getZoom(), 18), duration: 500 });
    else map.fitBounds([w, so, e, n], { padding: { top: 120, bottom: 120, left: 380, right: 420 }, maxZoom: 19.5, duration: 500 });
  };
  const pickFacility = (fid: string) => {
    const f = projectRef.current?.facilities.find((x) => x.id === fid);
    if (!f) return;
    setTool('select');
    setPanelId(null);
    drawRef.current?.deselectAll();
    setSelection({ type: 'facility', id: fid });
    flyTo(facilityPolygon(f) ?? turf.point([f.lon, f.lat]));
  };
  const pickFeature = (lid: string, fid: string) => {
    const l = projectRef.current?.layers.find((x) => x.id === lid);
    const feat = l?.features?.features.find((x) => String(x.id) === fid);
    if (!l || !feat) return;
    if (!l.visible) updateLayer(lid, { visible: true });
    setTool('select');
    setPanelId(null);
    setActiveId(lid);
    flyTo(feat);
    window.setTimeout(() => drawRef.current?.select(fid), 80);
  };
  /**
   * Shape card actions that reach into another layer, each one undo step:
   * move = the shape goes to the other layer; hole = a new shape with the hole's outline (the hole stays);
   * rings = a new shape per inner ring of a shape; close = the inner rings are removed.
   */
  const shapeTo = (fromId: string, fid: string, how: 'move' | 'hole' | 'rings' | 'close', targetId?: string) => {
    const p = projectRef.current!;
    const from = p.layers.find((l) => l.id === fromId);
    const feat = from?.features?.features.find((f) => String(f.id) === fid);
    if (!from || !feat || feat.geometry.type === 'GeometryCollection') return;
    const target = targetId ? p.layers.find((l) => l.id === targetId) : undefined;
    const g = feat.geometry as any;
    let add: Feature[] = [];
    let fromFeats = from.features!.features;
    if (how === 'move') {
      fromFeats = fromFeats.filter((f) => f !== feat);
      add = [feat];
    } else if (how === 'hole') {
      add = [{ type: 'Feature', id: newId(), properties: {}, geometry: { type: 'Polygon', coordinates: [g.coordinates[0]] } }];
    } else if (how === 'rings') {
      add = (g.coordinates as Position[][]).slice(1).map((r) => ({ type: 'Feature', id: newId(), properties: {}, geometry: { type: 'Polygon', coordinates: [r] } }) as Feature);
    } else {
      fromFeats = fromFeats.map((f) => (f === feat ? { ...f, geometry: { type: 'Polygon', coordinates: [g.coordinates[0]] } } as Feature : f));
    }
    if (how !== 'close' && (!target || !add.length)) return;
    commit((pp) => ({
      ...pp,
      layers: pp.layers.map((l) => {
        if (l.id === fromId && l.id === target?.id) return { ...l, features: { type: 'FeatureCollection', features: [...fromFeats, ...add] } };
        if (l.id === fromId) return { ...l, features: { type: 'FeatureCollection', features: fromFeats } };
        if (l.id === target?.id) return { ...l, visible: true, features: { type: 'FeatureCollection', features: [...(l.features?.features ?? []), ...add] } };
        return l;
      }),
    }));
    if (how === 'close') { setToast({ msg: 'Gaten in het vlak gedicht. ⌘Z draait het terug.' }); return; }
    const n = add.length;
    setToast({ msg: how === 'move' ? `Verplaatst naar ${target!.name}` : `${n} ${n === 1 ? 'vlak' : 'vlakken'} gemaakt in ${target!.name}. ⌘Z draait het terug.` });
    // Follow the shape to its new layer, so you can go on editing it there.
    setActiveId(target!.id);
    setSelection(null);
    window.setTimeout(() => drawRef.current?.select(String(add[0].id)), 120);
  };

  const deleteFacility = useCallback((fid: string) => {
    commit((p) => ({ ...p, facilities: p.facilities.filter((f) => f.id !== fid) }));
    setSelection(null);
  }, [commit]);

  const rotateSelected = (delta: number) => {
    if (selection?.type !== 'facility') return;
    const f = projectRef.current!.facilities.find((x) => x.id === selection.id);
    if (f) updateFacility(f.id, { rotation: (((f.rotation + delta) % 360) + 360) % 360 });
  };

  const addLayer = (l: Layer) => {
    commit((p) => {
      const idx = isVectorKind(l.kind) ? Math.max(0, p.layers.findIndex((x) => isVectorKind(x.kind) || x.kind === 'voorzieningen')) : p.layers.findIndex((x) => !isVectorKind(x.kind) && x.kind !== 'voorzieningen');
      const layersNext = [...p.layers];
      layersNext.splice(idx < 0 ? layersNext.length : isVectorKind(l.kind) ? idx + 1 : idx, 0, l);
      return { ...p, layers: layersNext };
    });
    if (isVectorKind(l.kind)) setActiveId(l.id);
    setAddOpen(false);
  };

  const deleteLayer = async (layerId: string) => {
    const l = projectRef.current!.layers.find((x) => x.id === layerId);
    commit((p) => ({ ...p, layers: p.layers.filter((x) => x.id !== layerId), facilities: l?.kind === 'voorzieningen' ? [] : p.facilities }));
    if (activeId === layerId) setActiveId(null);
    if (panelId === layerId) setPanelId(null);
    setModal(null);
  };

  const moveLayer = (layerId: string, dir: -1 | 1) => {
    commit((p) => {
      const i = p.layers.findIndex((l) => l.id === layerId);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= p.layers.length) return p;
      const ls = [...p.layers];
      [ls[i], ls[j]] = [ls[j], ls[i]];
      return { ...p, layers: ls };
    });
  };

  const fetchBgt = async () => {
    setAddOpen(false);
    const map = mapRef.current!;
    const b = map.getBounds();
    setToast({ msg: 'BGT ophalen voor het huidige kaartbeeld…', busy: true });
    try {
      const fc = await api.bgt([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]);
      addLayer(makeLayer('bgt', { features: fc }));
      setToast({ msg: `Basiskaart BGT toegevoegd (${fc.features.length} vlakken)` });
    } catch (e: any) { setToast({ msg: e.message, err: true }); }
  };

  const openExport = async () => { await flushSave().catch(() => {}); setModal({ type: 'export' }); };

  // ---------- one-go cut-outs ----------
  // A hole in a non-walkable layer (an island in water) can become walkable right away, and a walkable
  // area drawn over water or a blocked area cuts it out of those layers.
  const afterDrawRef = useRef<(aid: string, fin: { feature: Feature; mode: string }) => ((p: Project) => Project) | null>(() => null);
  afterDrawRef.current = (aid, fin) => {
    const p = projectRef.current!;
    const act = p.layers.find((l) => l.id === aid);
    if (!act || fin.feature.geometry.type !== 'Polygon') return null;
    const shape = (props: Record<string, any>): Feature => ({ type: 'Feature', id: newId(), geometry: fin.feature.geometry, properties: props });
    if (fin.mode === 'hole' && !isWalkableLayer(act) && holeWalkable) {
      const walk = p.layers.find((l) => l.kind === 'beloopbaar' && !l.locked) ?? p.layers.find((l) => isWalkableLayer(l) && !l.locked);
      const newWalk = walk ? null : makeLayer('beloopbaar');
      const wid = walk?.id ?? newWalk!.id;
      setToast({ msg: `Uitgesneden uit ${act.name} en beloopbaar gemaakt in ${walk?.name ?? 'een nieuwe laag Beloopbaar'}` });
      return (q) => {
        const ls = newWalk ? [...q.layers.slice(0, q.layers.findIndex((l) => l.id === aid)), newWalk, ...q.layers.slice(q.layers.findIndex((l) => l.id === aid))] : q.layers;
        return { ...q, layers: ls.map((l) => (l.id === wid ? { ...l, features: { type: 'FeatureCollection', features: [...(l.features?.features ?? []), shape({})] } } : l)) };
      };
    }
    if ((fin.mode === 'polygon' || fin.mode === 'rectangle') && isWalkableLayer(act) && cutBelow) {
      const hits = p.layers.filter((l) => l.id !== aid && l.visible && !l.locked && (l.kind === 'water' || (l.kind === 'eigen' && !l.walkable))
        && (l.features?.features ?? []).some((f) => !f.properties?.hole && f.geometry?.type === 'Polygon' && safeIntersects(f, fin.feature)));
      if (!hits.length) return null;
      setToast({ msg: `Uitgesneden uit ${hits.map((l) => l.name).join(', ')}` });
      const ids = new Set(hits.map((l) => l.id));
      return (q) => ({ ...q, layers: q.layers.map((l) => (ids.has(l.id) ? { ...l, features: { type: 'FeatureCollection', features: [...(l.features?.features ?? []), shape({ hole: true })] } } : l)) });
    }
    return null;
  };

  // ---------- tracing a facility shape over the aerial ----------
  const traceRef = useRef<(f: Feature) => void>(() => {});
  traceRef.current = (feat) => {
    if (feat.geometry.type !== 'Polygon') return;
    const p = projectRef.current!;
    const d = shapeFromRing(feat.geometry.coordinates[0]);
    const existing = place.attachTo ? p.facilities.find((x) => x.id === place.attachTo) : undefined;
    if (existing) {
      // Keep its navigation points where they are on the map.
      const navWorld = (existing.nav ?? []).map((o) => facilityToLonLat(existing, o));
      const moved: Facility = { ...existing, lon: d.lon, lat: d.lat, rotation: 0, shape: d.shape };
      moved.nav = navWorld.map((c) => lonLatToFacility(moved, c));
      commit((q) => ({ ...q, facilities: q.facilities.map((x) => (x.id === existing.id ? moved : x)) }));
      setSelection({ type: 'facility', id: existing.id });
      setPlace((s) => ({ ...s, mode: 'point', attachTo: undefined }));
      setTool('select');
      return;
    }
    const f: Facility = { id: newId(), category: place.category, name: '', notes: '', lon: d.lon, lat: d.lat, rotation: 0, shape: d.shape };
    commit((q) => ({ ...q, layers: q.layers.some((l) => l.kind === 'voorzieningen') ? q.layers : [makeLayer('voorzieningen'), ...q.layers], facilities: [...q.facilities, f] }));
    keepVisible(f.id, f.category);
    setSelection({ type: 'facility', id: f.id });
    setTool('select');
  };

  // ---------- paint bucket ----------
  const fillAt = (ll: Position) => {
    const map = mapRef.current!;
    const p = projectRef.current!;
    const act = p.layers.find((l) => l.id === activeIdRef.current);
    if (!act || !isVectorKind(act.kind) || !layerTakes(act.kind).polys) { setToast({ msg: 'Kies links een laag met vlakken (Beloopbaar, Water, Bos, Zand, Semi-beloopbaar of een eigen laag)', err: true }); return; }
    if (act.locked) { setToast({ msg: 'Deze laag is vergrendeld', err: true }); return; }
    const bounds: Boundary[] = [];
    for (const l of p.layers) {
      if (!isVectorKind(l.kind) || !l.visible) continue;
      for (const f of l.features?.features ?? []) {
        const g = f.geometry as any;
        if (!g) continue;
        if (g.type === 'LineString') bounds.push({ coords: g.coordinates, closed: false });
        else if (g.type === 'MultiLineString') for (const c of g.coordinates) bounds.push({ coords: c, closed: false });
        else if (g.type === 'Polygon') for (const r of g.coordinates) bounds.push({ coords: r, closed: true });
        else if (g.type === 'MultiPolygon') for (const poly of g.coordinates) for (const r of poly) bounds.push({ coords: r, closed: true });
      }
    }
    if (facLayer?.visible) for (const f of p.facilities) {
      const poly = facilityPolygon(f);
      if (poly) bounds.push({ coords: poly.geometry.coordinates[0], closed: true });
    }
    const b = map.getBounds();
    const padX = (b.getEast() - b.getWest()) * 0.5, padY = (b.getNorth() - b.getSouth()) * 0.5;
    const res = enclosedArea(ll, bounds, fillGap, [b.getWest() - padX, b.getSouth() - padY, b.getEast() + padX, b.getNorth() + padY]);
    if (!res) { setToast({ msg: fillGap < 5 ? 'Hier is geen gesloten gebied. Zit er een opening in de rand? Zet „Gaten dichten” hoger.' : 'Hier is geen gesloten gebied gevonden.', err: true }); return; }
    const feats = normaliseFeatures({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [res.outer, ...res.holes] } }] }, newId);
    updateLayer(act.id, (l) => ({ ...l, features: { type: 'FeatureCollection', features: [...(l.features?.features ?? []), ...feats] } }));
    setToast({ msg: `Vlak gemaakt in ${act.name} · ${fmtNum(res.area, 0)} m²${res.holes.length ? ` · ${res.holes.length} ${res.holes.length === 1 ? 'gat' : 'gaten'}` : ''}${res.gapsClosed ? ` · ${res.gapsClosed} ${res.gapsClosed === 1 ? 'opening' : 'openingen'} gedicht` : ''}` });
  };

  // ---------- colour vectorising: clicks ----------
  const wandAt = async (e: maplibregl.MapMouseEvent, ll: Position) => {
    const oe = e.originalEvent;
    const mode: VecClick = oe.altKey ? 'exclude' : vec.click;
    if (mode === 'area' || mode === 'add' || mode === 'cut' || mode === 'line') {
      const map = mapRef.current!;
      const d = vecDraft;
      const near = (q: Position | undefined) => { if (!q) return false; const a = map.project(q as [number, number]); return Math.hypot(a.x - e.point.x, a.y - e.point.y) < 10; };
      if (mode !== 'line' && d.length >= 3 && near(d[0])) { finishDraft(); return; }
      if (mode === 'line' && d.length >= 2 && near(d[d.length - 1])) { finishDraft(); return; }
      setVecDraft([...d, ll]);
      return;
    }
    if (vec.area && !turf.booleanPointInPolygon(ll as [number, number], turf.polygon([[...vec.area, vec.area[0]]]))) {
      setToast({ msg: 'Klik binnen het gebied (de witte stippellijn), of teken bij stap 1 een nieuw gebied', err: true });
      return;
    }
    const smp = await ensureSample();
    if (!smp) return;
    if (!sampleCovers(smp, ll as [number, number])) { setToast({ msg: 'Dit punt ligt buiten de beeldlaag', err: true }); return; }
    if (mode === 'fill') { setVec((v) => ({ ...v, ops: [...v.ops, { type: 'fill', pos: ll }] })); return; }
    setVec((v) => ({ ...v, picks: [...v.picks, { kind: mode, pos: ll }] }));
  };
  const finishDraft = () => {
    const d = vecDraft;
    if (vec.click === 'line' ? d.length < 2 : d.length < 3) { setVecDraft([]); return; }
    if (vec.click === 'area') {
      // A new area: start fresh inside it, then go on with picking colours.
      setVec((v) => ({ ...v, area: d, picks: [], ops: [], click: 'pick' }));
      setVecDraft([]);
      return;
    }
    const op: MaskOp = vec.click === 'line' ? { type: 'line', line: d } : { type: vec.click === 'add' ? 'add' : 'cut', ring: d };
    setVec((v) => ({ ...v, ops: [...v.ops, op] }));
    setVecDraft([]);
    // Drawing in also works before any colour is picked: make sure the image is there.
    void ensureSample();
  };
  const undoVecStep = () => {
    if (vecDraft.length) { setVecDraft((d) => d.slice(0, -1)); return; }
    setVec((v) => (v.ops.length ? { ...v, ops: v.ops.slice(0, -1) } : { ...v, picks: v.picks.slice(0, -1) }));
  };
  const vecTargetLayer = (): Layer | null => {
    const p = projectRef.current!;
    if (vec.target.type === 'layer') return p.layers.find((l) => l.id === (vec.target as any).id) ?? null;
    if (vec.target.type === 'active') return p.layers.find((l) => l.id === activeIdRef.current) ?? null;
    return null;
  };
  const addVecResult = () => {
    if (!vecRes?.features.length) return;
    const geomOk = (l: Layer) => isVectorKind(l.kind) && (vec.output === 'line' ? layerTakes(l.kind).lines : layerTakes(l.kind).polys);
    let target = vecTargetLayer();
    let created: Layer | null = null;
    if (vec.target.type === 'new') {
      created = makeLayer(vec.target.kind, vec.name.trim() ? { name: vec.name.trim() } : {});
      target = created;
    }
    if (!target || !geomOk(target)) { setToast({ msg: vec.output === 'line' ? 'Kies een laag die lijnen kan bevatten (Beloopbaar, Hekken of een eigen laag)' : 'Kies een laag die vlakken kan bevatten', err: true }); return; }
    if (target.locked) { setToast({ msg: `${target.name} is vergrendeld`, err: true }); return; }
    const props = vec.name.trim() ? { name: vec.name.trim() } : {};
    const feats = normaliseFeatures({ type: 'FeatureCollection', features: vecRes.features.map((f) => ({ ...f, properties: { ...props } })) }, newId);
    const tid = target.id;
    commit((p) => {
      let ls = p.layers;
      if (created) {
        const idx = Math.max(0, ls.findIndex((x) => isVectorKind(x.kind) || x.kind === 'voorzieningen'));
        ls = [...ls.slice(0, idx + 1), created, ...ls.slice(idx + 1)];
      }
      return { ...p, layers: ls.map((l) => (l.id === tid ? { ...l, visible: true, features: { type: 'FeatureCollection', features: [...(l.features?.features ?? []), ...feats] } } : l)) };
    });
    const nShapes = feats.filter((f) => !f.properties?.hole).length;
    setToast({ msg: `${nShapes} ${vec.output === 'line' ? (nShapes === 1 ? 'lijn' : 'lijnen') : nShapes === 1 ? 'vlak' : 'vlakken'} toegevoegd aan ${target.name}. Je kunt ze nu aanpassen; ⌘Z draait het terug.` });
    setVec((v) => ({ ...v, picks: [], ops: [] }));
    setVecDraft([]);
    // Straight to editing: the target layer active, the first new shape selected.
    setActiveId(tid);
    setTool('select');
    const first = feats.find((f) => !f.properties?.hole);
    if (first) window.setTimeout(() => drawRef.current?.select(String(first.id)), 150);
  };

  // ---------- navigation points ----------
  const addNavPoint = (fid: string, ll: Position) => {
    const f = projectRef.current!.facilities.find((x) => x.id === fid);
    if (!f) return;
    updateFacility(fid, { nav: [...(f.nav ?? []), lonLatToFacility(f, ll)] });
  };

  // ---------- keyboard ----------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (modal) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); if (drawRef.current?.drawing) return; e.shiftKey ? redo() : undo(); return; }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (tool === 'wand' && (e.key === 'Backspace' || e.key === 'Delete')) { e.preventDefault(); undoVecStep(); return; }
      if (e.key === 'Backspace' || e.key === 'Delete') {
        if (drawRef.current?.removeSelected()) { setSelection(null); e.preventDefault(); return; }
        if (selection?.type === 'facility' && !facLayer?.locked) { deleteFacility(selection.id); e.preventDefault(); }
        return;
      }
      if (e.key === 'Escape') {
        if (navAdd) { setNavAdd(null); return; }
        if (tool === 'wand' && vecDraft.length) { setVecDraft([]); return; }
        if (tool === 'wand' && (vec.picks.length || vec.ops.length)) { setVec((v) => ({ ...v, picks: [], ops: [] })); return; }
        if (!drawRef.current?.drawing) { setSelection(null); drawRef.current?.deselectAll(); setAddOpen(false); }
        return;
      }
      if (e.key === 'Enter' && tool === 'wand') { e.preventDefault(); if (vecDraft.length) finishDraft(); else if (vecRes?.features.length) addVecResult(); return; }
      if (e.key === '[' || e.key === ']') { e.preventDefault(); setSnapPx((v) => clampSnap(e.key === ']' ? v * 1.25 + 0.5 : v / 1.25)); return; }
      if (e.key.toLowerCase() === 'r' && selection?.type === 'facility') { rotateSelected(e.shiftKey ? -15 : 15); return; }
      if (drawRef.current?.drawing) return;
      const t2 = TOOLS.find((x) => x.key === e.key.toLowerCase());
      if (t2) setTool(t2.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // ---------- render ----------
  if (loadError) return (
    <div className="app"><Rail /><main className="page"><h1>Kaart niet gevonden</h1><p className="muted">{loadError}</p><button className="btn" onClick={() => nav('/')}>Naar kaarten</button></main></div>
  );
  if (!project) return <div className="app"><Rail /><main className="page"><div className="row muted"><span className="spinner" />Kaart laden…</div></main></div>;

  const selFacility = selection?.type === 'facility' ? project.facilities.find((f) => f.id === selection.id) : undefined;
  const selFeature = selection?.type === 'feature' && active ? active.features?.features.find((f) => String(f.id) === selection.id) : undefined;
  const panelLayer = panelId ? layers.find((l) => l.id === panelId) : undefined;

  return (
    <div className="app">
      <Rail onExport={openExport} />
      <div className="editor">
        <div ref={mapEl} className="map" />

        <div className="topbar">
          {TOOLS.map((t) => (
            <button key={t.id} className={`sq ${tool === t.id ? 'on' : ''}`} onClick={() => setTool(t.id)} title={`${t.label} (${t.key.toUpperCase()})`} aria-label={t.label}>
              <Icon name={t.icon} />
            </button>
          ))}
          <div style={{ width: 1, height: 28, background: 'rgba(255,255,255,.1)', margin: '0 4px' }} />
          <button className="sq" onClick={undo} disabled={!past.current.length} title="Ongedaan maken (⌘Z)" aria-label="Ongedaan maken"><Icon name="undo" size={18} /></button>
          <button className="sq" onClick={redo} disabled={!future.current.length} title="Opnieuw (⇧⌘Z)" aria-label="Opnieuw"><Icon name="redo" size={18} /></button>
          <div className="grow" style={{ pointerEvents: 'none' }} />
          {readonly ? (
            <div className="row" style={{ gap: 8, padding: '0 14px', height: 48, background: 'var(--sq)', border: '1px solid rgba(255,255,255,.06)', borderRadius: 14, pointerEvents: 'auto', fontSize: 13 }}>
              <Icon name="eye" size={16} />Alleen bekijken · wijzigingen worden niet opgeslagen
            </div>
          ) : <div className="row" style={{ gap: 4, padding: 4, background: 'var(--sq)', border: '1px solid rgba(255,255,255,.06)', borderRadius: 14 }}>
            <button className="btn lime" style={{ height: 40 }} onClick={() => { setTool('place'); setSelection(null); }}><Icon name="plus" size={16} stroke={2.2} />Voorziening</button>
            <button className="btn" style={{ height: 40 }} onClick={openExport}>Publiceren</button>
          </div>}
        </div>

        <div className="left-stack">
          <div className="card col" style={{ padding: 16, gap: 12 }}>
            <div className="row">
              <button onClick={() => nav('/')} aria-label="Terug naar kaarten" title="Terug naar kaarten" style={{ width: 28, height: 28, borderRadius: 8, background: 'var(--text)', color: 'var(--bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', border: 0, cursor: 'pointer', flexShrink: 0 }}><Icon name="back" size={16} stroke={2.2} /></button>
              <span className="grow" style={{ fontSize: 16, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={project.name}>{project.name}</span>
              {readonly ? <span className="muted" style={{ fontSize: 12, flexShrink: 0 }}>alleen bekijken</span> : <SaveBadge state={saveState} onRetry={() => setSaveState('dirty')} />}
            </div>
            <div className="grid3">
              <div className="tile"><span className="k">Paden</span><span className="v">{stats.paths}</span></div>
              <div className="tile" title="Losse stukken: delen van het netwerk die niet met de rest verbonden zijn"><span className="k">Los</span><span className="v" style={{ color: stats.loose ? '#FF8A4C' : undefined }}>{stats.loose}</span></div>
              <div className="tile"><span className="k">Voorz.</span><span className="v">{stats.facilities}</span></div>
            </div>
          </div>
          <LayersCard
            layers={layers}
            activeId={activeId}
            panelId={panelId}
            onActivate={(lid) => { setActiveId(lid); }}
            onToggle={toggleLayer}
            onPanel={(lid) => { setPanelId(panelId === lid ? null : lid); setActiveId(lid); }}
            onAdd={() => setAddOpen((o) => !o)}
            facilities={project.facilities}
            categories={lib.categories}
            selectedId={selection?.id ?? null}
            onToggleCat={toggleCategory}
            onPickFacility={pickFacility}
            onPickFeature={pickFeature}
          />
        </div>

        {addOpen && (
          <AddLayerMenu
            hasFacilities={!!facLayer}
            onClose={() => setAddOpen(false)}
            onVector={(kind) => addLayer(makeLayer(kind))}
            onFacilities={() => addLayer(makeLayer('voorzieningen'))}
            onPdok={() => addLayer(makeLayer('pdok'))}
            onImage={() => { setAddOpen(false); imageInput.current?.click(); }}
            onBgt={fetchBgt}
            onFile={() => { setAddOpen(false); fileInput.current?.click(); }}
          />
        )}
        <input ref={fileInput} type="file" accept=".geojson,.json,.gpkg,.kml,.kmz,.gpx,.zip,.dxf,.csv" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) setModal({ type: 'importFile', file: f }); }} />
        <input ref={imageInput} type="file" accept=".pdf,.png,.jpg,.jpeg,.tif,.tiff,.webp" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) setModal({ type: 'image', file: f }); }} />

        {panelLayer ? (
          <LayerPanel
            key={panelLayer.id}
            layer={panelLayer}
            tab={panelTab}
            setTab={setPanelTab}
            index={layers.indexOf(panelLayer)}
            count={layers.length}
            onClose={() => setPanelId(null)}
            onChange={(patch, history) => updateLayer(panelLayer.id, patch, { history })}
            onMove={(d) => moveLayer(panelLayer.id, d)}
            onGeoref={() => nav(`/kaart/${project.id}/georef/${panelLayer.id}`)}
            onCrop={() => setModal({ type: 'crop', layerId: panelLayer.id })}
            onRefetchBgt={async () => {
              const b = mapRef.current!.getBounds();
              setToast({ msg: 'BGT opnieuw ophalen…', busy: true });
              try { const fc = await api.bgt([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]); updateLayer(panelLayer.id, { features: fc }); setToast({ msg: 'BGT bijgewerkt' }); }
              catch (e: any) { setToast({ msg: e.message, err: true }); }
            }}
            onDelete={() => setModal({ type: 'deleteLayer', layerId: panelLayer.id })}
          />
        ) : selFacility && tool === 'select' ? (
          <FacilityCard
            key={selFacility.id}
            facility={selFacility}
            pid={project.id}
            onPhoto={async (file) => {
              const fid = selFacility.id;
              setToast({ msg: 'Foto uploaden…', busy: true });
              try { const r = await api.uploadPhoto(project.id, fid, file); updateFacility(fid, { photo: r.path }); setToast(null); }
              catch (e: any) { setToast({ msg: e.message, err: true }); }
            }}
            navAdding={navAdd === selFacility.id}
            onNavAdd={() => setNavAdd(navAdd === selFacility.id ? null : selFacility.id)}
            onNavRemove={(i) => updateFacility(selFacility.id, { nav: (selFacility.nav ?? []).filter((_, j) => j !== i) })}
            onTrace={() => { setTool('place'); setPlace((s) => ({ ...s, category: selFacility.category, mode: 'trace', attachTo: selFacility.id })); }}
            locked={!!facLayer?.locked}
            onChange={(patch, history) => updateFacility(selFacility.id, patch, { history })}
            onDelete={() => deleteFacility(selFacility.id)}
          />
        ) : selFeature && active && tool === 'select' ? (
          <FeatureCard
            feature={selFeature}
            layer={active}
            layers={project.layers}
            onShapeTo={(how, target) => shapeTo(active.id, String(selFeature.id), how, target)}
            onToTop={() => drawRef.current?.toTop(String(selFeature.id))}
            onProps={(props) => drawRef.current?.setProperties(String(selFeature.id), props)}
            onDelete={() => { drawRef.current?.removeSelected(); setSelection(null); }}
          />
        ) : tool === 'place' ? (
          <PlaceCard state={place} setState={setPlace} locked={!!facLayer?.locked} onNewCategory={() => setModal({ type: 'category' })}
            attachName={place.attachTo ? (() => { const f = project.facilities.find((x) => x.id === place.attachTo); return f ? f.name || lib.categories.find((c) => c.id === f.category)?.name || 'voorziening' : undefined; })() : undefined} />
        ) : tool === 'route' ? (
          <RouteCard state={route} setState={setRoute} result={routeResult} facilities={project.facilities} gps={gpsDot} />
        ) : tool === 'fill' ? (
          <FillCard layer={active} gap={fillGap} setGap={setFillGap} />
        ) : tool === 'wand' ? (
          <VecCard
            state={vec}
            setState={(patch) => setVec((v) => ({ ...v, ...patch }))}
            sources={rasterLayers}
            layers={layers}
            active={active}
            result={vecRes}
            busy={vecBusy}
            mpp={sampleRef.current && sampleRef.current.layerId === vec.sourceId ? sampleRef.current.raster.mpp : null}
            drafting={vecDraft.length}
            onFinishDraft={finishDraft}
            onUndo={undoVecStep}
            onAdd={addVecResult}
            onClear={() => { setVec((v) => ({ ...v, picks: [], ops: [] })); setVecDraft([]); }}
            onRemovePick={(i) => setVec((v) => ({ ...v, picks: v.picks.filter((_, j) => j !== i) }))}
          />
        ) : ['line', 'polygon', 'rect', 'hole'].includes(tool) ? (
          <DrawCard tool={tool as 'line' | 'polygon' | 'rect' | 'hole'} layer={active} snapping={snapping} setSnapping={setSnapping} snapPx={snapPx} setSnapPx={(v) => setSnapPx(clampSnap(v))}
            holeWalkable={holeWalkable} setHoleWalkable={setHoleWalkable} cutBelow={cutBelow} setCutBelow={setCutBelow} />
        ) : null}

        {['line', 'polygon', 'hole'].includes(tool) && editable && !panelLayer && (
          <div className="card hint"><span><span className="kbd">klik</span> punt</span><span><span className="kbd">klik laatste punt</span> of <span className="kbd">↵</span> afronden</span><span><span className="kbd">esc</span> annuleren</span><span><span className="kbd">[ ]</span> snapafstand {snapPx}px</span><span><span className="kbd">⌥</span> niet snappen</span></div>
        )}
        {tool === 'place' && place.mode === 'trace' && !panelLayer && (
          <div className="card hint"><span><span className="kbd">klik</span> de hoeken van de vorm op de luchtfoto</span><span><span className="kbd">klik eerste punt</span> afronden</span><span><span className="kbd">[ ]</span> snapafstand</span></div>
        )}
        {tool === 'fill' && !panelLayer && (
          <div className="card hint"><span><span className="kbd">klik</span> binnen een gebied dat omsloten is door paden of vlakken</span><span><span className="kbd">⌘Z</span> ongedaan</span></div>
        )}
        {tool === 'wand' && !panelLayer && (
          vec.click === 'area' ? (
            <div className="card hint"><span><span className="kbd">klik</span> punten rond het zoekgebied</span><span><span className="kbd">klik eerste punt</span> of <span className="kbd">↵</span> afronden</span><span><span className="kbd">⌫</span> punt terug</span></div>
          ) : <div className="card hint"><span><span className="kbd">klik</span> kleur pakken</span><span><span className="kbd">⌥ klik</span> uitsluiten</span><span><span className="kbd">⌫</span> laatste stap</span><span><span className="kbd">↵</span> toevoegen</span></div>
        )}
        {navAdd && !panelLayer && (
          <div className="card hint"><span><span className="kbd">klik</span> op de kaart: navigatiepunt erbij</span><span><span className="kbd">esc</span> klaar</span></div>
        )}
        {drawingTool && !panelLayer && <div ref={ringEl} className="snap-ring" style={{ width: snapPx * 2, height: snapPx * 2, margin: `${-snapPx}px 0 0 ${-snapPx}px` }} />}
        {tool === 'rect' && editable && !panelLayer && (
          <div className="card hint"><span><span className="kbd">klik</span> eerste hoek</span><span><span className="kbd">klik</span> tegenoverliggende hoek</span></div>
        )}

        <div className="statusbar">
          {cursor && <span>{cursor[1].toFixed(5)} N · {cursor[0].toFixed(5)} E</span>}
          {scale.px > 0 && <span className="row" style={{ gap: 6 }}><span style={{ display: 'inline-block', width: scale.px, height: 4, borderLeft: '1.5px solid', borderRight: '1.5px solid', borderBottom: '1.5px solid' }} />{scale.label}</span>}
        </div>
        <div className="zoom">
          <button className="sq" aria-label="Inzoomen" onClick={() => mapRef.current?.zoomIn()}><Icon name="plus" size={18} stroke={2} /></button>
          <button className="sq" aria-label="Uitzoomen" onClick={() => mapRef.current?.zoomOut()}><Icon name="minus" size={18} stroke={2} /></button>
        </div>

        {modal?.type === 'export' && !readonly && <PublishModal pid={project.id} onClose={() => setModal(null)} />}
        {modal?.type === 'importFile' && (
          <ImportFileModal
            file={modal.file}
            layers={layers}
            onClose={() => setModal(null)}
            onImport={(apply) => { commit(apply); setModal(null); setToast({ msg: 'Geïmporteerd' }); }}
          />
        )}
        {modal?.type === 'image' && (
          <ImageImportModal
            file={modal.file}
            pid={project.id}
            onClose={() => setModal(null)}
            onDone={async (layer) => {
              addLayer(layer);
              await api.saveProject(projectRef.current!);
              setSaveState('saved');
              setModal(null);
              nav(`/kaart/${project.id}/georef/${layer.id}`);
            }}
          />
        )}
        {modal?.type === 'crop' && (() => {
          const l = layers.find((x) => x.id === modal.layerId);
          if (!l?.image) return null;
          return (
            <ImageImportModal
              pid={project.id}
              cropOnly={l}
              onClose={() => setModal(null)}
              onDone={(layer) => { updateLayer(l.id, { image: layer.image }); setModal(null); setToast({ msg: 'Bijgesneden. Controleer de georeferentie als de punten verschoven zijn.' }); }}
            />
          );
        })()}
        {modal?.type === 'category' && (
          <CategoryModal
            onClose={() => setModal(null)}
            onSave={(c) => { updateLib((L) => ({ ...L, categories: [...L.categories, c] })); setPlace((s) => ({ ...s, category: c.id, mode: SHAPE_CATEGORIES.includes(c.id) ? 'trace' : 'point' })); setModal(null); }}
          />
        )}
        {modal?.type === 'deleteLayer' && (() => {
          const l = layers.find((x) => x.id === modal.layerId);
          if (!l) return null;
          return (
            <div className="overlay" onClick={() => setModal(null)}>
              <div className="modal" onClick={(e) => e.stopPropagation()}>
                <h2>Laag „{l.name}” verwijderen?</h2>
                <p className="sub">{l.kind === 'voorzieningen' ? `Ook alle ${project.facilities.length} voorzieningen worden verwijderd.` : 'Je kunt dit ongedaan maken met ⌘Z.'}</p>
                <div className="actions"><button className="btn" onClick={() => setModal(null)}>Annuleren</button><button className="btn danger" onClick={() => deleteLayer(l.id)}>Verwijderen</button></div>
              </div>
            </div>
          );
        })()}

        {toast && (
          <div className={`toast ${toast.err ? 'err' : ''}`} onClick={() => !toast.busy && setToast(null)}>
            {toast.busy && <span className="spinner" />}{toast.msg}
            {!toast.busy && <button className="link muted" onClick={() => setToast(null)}>Sluiten</button>}
          </div>
        )}
      </div>
    </div>
  );
}

function SaveBadge({ state, onRetry }: { state: SaveState; onRetry: () => void }) {
  if (state === 'error') return <button className="link" style={{ color: 'var(--danger)', fontSize: 12 }} onClick={onRetry}>opslaan mislukt · opnieuw</button>;
  const txt = state === 'saved' ? 'opgeslagen' : 'opslaan…';
  return <span className="row muted" style={{ gap: 6, fontSize: 12, flexShrink: 0 }}><span className="dot" style={{ width: 6, height: 6, background: state === 'saved' ? 'var(--lime)' : 'var(--warn)' }} />{txt}</span>;
}

function readPref<T>(k: string, def: T): T {
  try { const v = localStorage.getItem(`floc.${k}`); return v == null ? def : (JSON.parse(v) as T); } catch { return def; }
}
function writePref(k: string, v: unknown) {
  try { localStorage.setItem(`floc.${k}`, JSON.stringify(v)); } catch { /* ignore */ }
}
function clampSnap(v: number) {
  return Math.max(2, Math.min(80, Math.round(v)));
}
function safeIntersects(a: Feature, b: Feature): boolean {
  try { return turf.booleanIntersects(a as any, b as any); } catch { return false; }
}
