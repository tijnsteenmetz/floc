// Shared data model for the editor (browser + server).
import type { Feature, FeatureCollection, Geometry } from 'geojson';

export type VectorKind = 'beloopbaar' | 'semi' | 'water' | 'bos' | 'zand' | 'hekken' | 'eigen';
export type ImageKind = 'pdok' | 'image' | 'bgt';
export type LayerKind = VectorKind | 'voorzieningen' | ImageKind;

export type FillStyle = 'vol' | 'arcering' | 'textuur' | 'geen';
export type WidthStyle = 'dun' | 'normaal' | 'dik';
export type DashStyle = 'vol' | 'gestreept';

export interface LayerStyle {
  color: string;
  fill: FillStyle;
  width: WidthStyle;
  dash: DashStyle;
  brightness?: number; // -50..50, image layers
}

export interface FieldDef {
  name: string;
  type: 'tekst' | 'getal' | 'keuze';
}

export interface Gcp {
  id: string;
  px: number; // pixel x in the (cropped) image
  py: number;
  lon: number | null;
  lat: number | null;
}

export interface ImageInfo {
  sourceName: string;      // original file name
  page?: number;           // PDF page (1-based)
  width: number;           // cropped image size in px
  height: number;
  fullWidth: number;       // uncropped render size
  fullHeight: number;
  crop: { x: number; y: number; w: number; h: number } | null;
  gcps: Gcp[];
  method: 'affine' | 'poly';
  warped: { bounds: [number, number, number, number]; version: number } | null; // lon/lat W,S,E,N of warped PNG
}

export interface Layer {
  id: string;
  name: string;
  kind: LayerKind;
  visible: boolean;
  opacity: number; // 0..100
  locked: boolean;
  noExport: boolean;
  style: LayerStyle;
  walkable?: boolean;          // only meaningful for kind 'eigen'
  snapM?: number;              // semi: how far (m) the GPS dot still jumps to a path inside these areas
  fields: FieldDef[];
  features?: FeatureCollection; // vector layers (not for voorzieningen / images)
  pdokLayer?: string;          // pdok: WMTS layer id, e.g. Actueel_orthoHR
  hiddenCats?: string[];       // voorzieningen: categories switched off in the layers card
  image?: ImageInfo;           // image layers
}

export interface Facility {
  id: string;
  category: string;
  name: string;
  notes: string;
  lon: number;
  lat: number;
  rotation: number; // degrees clockwise
  /** Traced outline in metres around lon/lat (x east, y north, before rotation). Empty = shown as a dot. */
  shape?: [number, number][];
  /** Photo file inside the project folder, e.g. photos/<id>.jpg */
  photo?: string;
  /** Planning, e.g. the timetable of a stage. */
  timetable?: TimetableEntry[];
  /** Where routes to this facility end. Metres from the centre in the facility's own frame (x east, y north before rotation). Empty = the centre. */
  nav?: { x: number; y: number }[];
}

export interface TimetableEntry {
  id: string;
  day: string;   // free text, e.g. "vrijdag"
  start: string; // "21:30"
  end: string;
  act: string;
}

export interface Project {
  id: string;
  name: string;
  notes: string;
  created: string;
  updated: string;
  view?: { center: [number, number]; zoom: number };
  layers: Layer[];
  facilities: Facility[];
  /** Server-side save counter, to detect someone else saving in between. */
  revision?: number;
  /** What the signed-in user may do with this map. */
  access?: 'edit' | 'view';
  org?: { id: string; name: string };
}

export interface ProjectSummary {
  id: string;
  name: string;
  notes: string;
  updated: string;
  layerKinds: LayerKind[];
  org?: string;
  /** Latest published version, if any. */
  version?: number;
  thumb: { lines: number[][][]; polys: { pts: number[][]; color: string }[]; dots: { x: number; y: number; color: string }[] };
}

export interface Category {
  id: string;
  name: string;
  color: string;
  label: string; // short text shown inside the map marker
  builtin?: boolean;
}

export interface Library {
  categories: Category[];
}

export type AnyFeature = Feature<Geometry, Record<string, any>>;

export const DEFAULT_CATEGORIES: Category[] = [
  { id: 'podium', name: 'Podium', color: '#A78BFA', label: '♪', builtin: true },
  { id: 'bar', name: 'Bar', color: '#F5B84A', label: 'BAR', builtin: true },
  { id: 'eten', name: 'Eten', color: '#F472B6', label: 'ETEN', builtin: true },
  { id: 'wc', name: 'WC', color: '#F2F3F4', label: 'WC', builtin: true },
  { id: 'ehbo', name: 'EHBO', color: '#FF6B6B', label: '+', builtin: true },
  { id: 'munten', name: 'Munten', color: '#D4F56A', label: '€', builtin: true },
  { id: 'water', name: 'Waterpunt', color: '#6BC0FF', label: 'H₂O', builtin: true },
  { id: 'kluis', name: 'Kluisjes', color: '#94A3B8', label: 'KL', builtin: true },
  { id: 'ingang', name: 'Ingang', color: '#2DD4BF', label: 'IN', builtin: true },
  { id: 'nooduitgang', name: 'Nooduitgang', color: '#FF8A4C', label: 'NU', builtin: true },
  { id: 'calamiteit', name: 'Calamiteitendoorgang', color: '#F43F5E', label: 'CAL', builtin: true },
];

/** Categories that are usually an outline (traced), not a dot. */
export const SHAPE_CATEGORIES = ['podium', 'bar', 'eten'];

export const KIND_INFO: Record<LayerKind, { label: string; desc: string; color: string; geom: string; walkable: boolean; palette: string[] }> = {
  beloopbaar: { label: 'Beloopbaar', desc: 'Lijnen = paden, vlakken = open gebied waar je recht overheen loopt. Bepaalt de routes.', color: '#D4F56A', geom: 'lijnen · vlakken', walkable: true, palette: ['#D4F56A', '#A3E635', '#FACC15', '#5EEAD4', '#F2F3F4', '#93C5FD'] },
  semi: { label: 'Semi-beloopbaar', desc: 'Camping, publiek voor een podium: je kunt er zijn, maar routes gaan er niet doorheen. De GPS-stip springt hier minder snel naar een pad.', color: '#5EEAD4', geom: 'vlakken', walkable: false, palette: ['#5EEAD4', '#2DD4BF', '#A7F3D0', '#93C5FD', '#FDE68A', '#F2F3F4'] },
  water: { label: 'Water', desc: 'Alleen weergave.', color: '#2F7FB0', geom: 'vlakken', walkable: false, palette: ['#2F7FB0', '#1F5F8C', '#3B9AD9', '#2A6F86', '#4AA3C7', '#1D4E6E'] },
  bos: { label: 'Bos', desc: 'Alleen weergave. Beloopbaar bos teken je ook in Beloopbaar.', color: '#3E7A4E', geom: 'vlakken', walkable: false, palette: ['#3E7A4E', '#2F6B3A', '#4F8A3C', '#5E9C6E', '#2E5A44', '#6B8F3E'] },
  zand: { label: 'Zand', desc: 'Alleen weergave.', color: '#A88B4A', geom: 'vlakken', walkable: false, palette: ['#A88B4A', '#C2A35E', '#8C7440', '#D1B477', '#9C7B3C', '#B59A68'] },
  hekken: { label: 'Hekken', desc: 'Herkenbare hekken. Blokkeren (nog) geen routes.', color: '#FF8A4C', geom: 'lijnen', walkable: false, palette: ['#FF8A4C', '#F87171', '#FBBF24', '#F2F3F4', '#C084FC', '#FB923C'] },
  eigen: { label: 'Eigen laag', desc: 'Eigen naam en kleur; kies zelf of hij beloopbaar is.', color: '#C084FC', geom: 'lijnen · vlakken', walkable: false, palette: ['#C084FC', '#F472B6', '#5EEAD4', '#FACC15', '#F2F3F4', '#93C5FD'] },
  voorzieningen: { label: 'Voorzieningen', desc: 'Bars, podia, WC… als punt of als overgetrokken vorm.', color: '#F5B84A', geom: 'punten · vormen', walkable: false, palette: ['#F5B84A', '#A78BFA', '#F472B6', '#6BC0FF', '#D4F56A', '#F2F3F4'] },
  pdok: { label: 'Luchtfoto PDOK', desc: 'Automatisch opgehaald voor het kaartgebied.', color: '#66733F', geom: 'beeld', walkable: false, palette: [] },
  image: { label: 'Afbeelding / PDF', desc: 'Plattegrond of CAD-export, gegeorefereerd.', color: '#EFE8D6', geom: 'beeld', walkable: false, palette: [] },
  bgt: { label: 'Basiskaart BGT', desc: 'Donkere basiskaart uit de BGT.', color: '#1B3524', geom: 'vector', walkable: false, palette: [] },
};

export const PDOK_LAYERS: { id: string; label: string }[] = [
  { id: 'Actueel_orthoHR', label: 'Actueel · 8 cm' },
  { id: 'Actueel_ortho25', label: 'Actueel · 25 cm' },
  { id: '2025_orthoHR', label: '2025 · 8 cm' },
  { id: '2024_orthoHR', label: '2024 · 8 cm' },
  { id: '2023_orthoHR', label: '2023 · 8 cm' },
  { id: '2022_orthoHR', label: '2022 · 8 cm' },
];

export function pdokUrl(layer: string): string {
  return `https://service.pdok.nl/hwh/luchtfotorgb/wmts/v1_0/${layer}/EPSG:3857/{z}/{x}/{y}.jpeg`;
}

export function isVectorKind(k: LayerKind): k is VectorKind {
  return k === 'beloopbaar' || k === 'semi' || k === 'water' || k === 'bos' || k === 'zand' || k === 'hekken' || k === 'eigen';
}

export function isWalkableLayer(l: Layer): boolean {
  return l.kind === 'beloopbaar' || (l.kind === 'eigen' && !!l.walkable);
}

/** The app snaps the GPS dot to a path within 5 m; inside semi-walkable areas by default only within 2 m. */
export const APP_SNAP_M = 5;
export const SEMI_SNAP_M = 2;

/** Which geometry a vector layer holds. */
export function layerTakes(kind: LayerKind): { lines: boolean; polys: boolean } {
  return { lines: kind === 'beloopbaar' || kind === 'hekken' || kind === 'eigen', polys: isVectorKind(kind) && kind !== 'hekken' };
}

export function newId(): string {
  return (globalThis.crypto as Crypto).randomUUID();
}

export function defaultStyle(kind: LayerKind): LayerStyle {
  const color = KIND_INFO[kind].color;
  switch (kind) {
    case 'beloopbaar': return { color, fill: 'arcering', width: 'normaal', dash: 'vol' };
    case 'bos': return { color, fill: 'textuur', width: 'dun', dash: 'vol' };
    case 'semi': return { color, fill: 'arcering', width: 'dun', dash: 'gestreept' };
    case 'hekken': return { color, fill: 'vol', width: 'dik', dash: 'gestreept' };
    case 'pdok': case 'image': case 'bgt': return { color, fill: 'vol', width: 'normaal', dash: 'vol', brightness: 0 };
    default: return { color, fill: 'vol', width: 'normaal', dash: 'vol' };
  }
}

export function makeLayer(kind: LayerKind, extra: Partial<Layer> = {}): Layer {
  return {
    id: newId(),
    name: KIND_INFO[kind].label,
    kind,
    visible: true,
    opacity: kind === 'image' ? 60 : 100,
    locked: false,
    noExport: false,
    style: defaultStyle(kind),
    fields: [],
    ...(isVectorKind(kind) ? { features: { type: 'FeatureCollection', features: [] } } : {}),
    ...(kind === 'pdok' ? { pdokLayer: 'Actueel_orthoHR' } : {}),
    ...(kind === 'semi' ? { snapM: SEMI_SNAP_M } : {}),
    ...extra,
  };
}
