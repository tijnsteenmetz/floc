# floc editor — Spec (v0)

A **local web dashboard for drawing festival maps**, replacing QGIS in my workflow. It's built around festival concepts (stages, bars, exits, fences, walkable areas) instead of a general-purpose GIS. It's also the first step towards the real product, where organisers would make their own maps. For now it's **a tool for me alone**.

It lives in `floc/editor/`, runs on **localhost on my Mac**, and has no hosting and no accounts. Its output is the same `maps/<id>/` folder the iOS app already reads. The iOS app is **not** changed as part of this work.

## Why not QGIS

- It's general-purpose: no notion of a stage, bar, exit or fence, and no properties that belong to them.
- Things end up split between QGIS and my own software, and I have to keep track of what lives where. One dashboard that Claude can read and change keeps it all in one place.
- I want to draw and test routes in the same place.

## Decisions

| Topic | Decision |
|---|---|
| Where | `floc/editor/`, `localhost`, my Mac only. Internet only for fetching the PDOK aerial |
| Stack | **Vite + React + TypeScript** frontend, **MapLibre GL JS** map (same engine as the app), **Terra Draw** for drawing/editing, **Turf** for geometry. Small **Node** server for file I/O and raster work |
| Raster work | **GDAL from the installed QGIS** (`/Applications/QGIS-final-4_2_3.app/Contents/MacOS/`): `gdal_translate` + `gdalwarp` for georeferencing, MBTiles export. No separate GDAL install |
| UI language | **Dutch** |
| Look | Dark, sleek, "modern dashboard": black icon rail, rounded floating cards over a full-bleed map, square tool buttons, one lime accent. **More colour on the map than the reference**: woods green, water blue, sand sandy, each facility type its own colour. Direction A in the [design canvas](https://claude.ai/artifact/VVsrv6zdFgD9SWhSPwZcyF) |
| Saving | **Autosave** to project files in `editor/projects/<id>/`. **Undo/redo** (Cmd+Z / Shift+Cmd+Z) |
| Output | An **Export** button writes `maps/<id>/` for the app |
| Workflow | **No fixed order.** Every tool is usable at any time: facilities first, paths first, whatever |

## Screens

### 1. Maps overview
- Cards for each map (name, notes, last edited). **New map** and **Duplicate** (for variants, e.g. "Wildeburg v2"). Delete asks for confirmation.
- **Import**: reads an existing `maps/<id>/` folder or `qgis/*.gpkg` into a new project (paths, walkable, blocked, stages, bars, munten, water…). Wildeburg must come in this way.

### 2. Map editor (main screen)
Full-bleed map with floating cards, as in the design:
- **Left rail:** Kaarten · Editor · Exporteren · Instellingen.
- **Top tool row:** Selecteren · Lijn · Vlak · Rechthoek · Gat uitsnijden · Voorziening · Route testen. Lines and polygons go into the **active layer**; what they mean depends on its kind. Keyboard shortcuts for each.
- **Layers card:** the single stack of all layers. Click a layer to make it active. The chevron unfolds its **components, grouped by kind** (Paden / Open gebieden / Gaten; Voorzieningen per category with its own eye). Clicking a component selects it and flies there. Plus quick stats (paths, disconnected pieces, facilities).
- **Properties card:** appears next to the selected object.
- **Route card:** see Route testing.
- Zoom controls, a cursor coordinate readout, and a scale bar.

### 3. Georeferencing
A split view: the image on one side, the map (aerial) on the other. See Georeferencing below.

## Layers — everything is a layer

There is **one layer stack**. Images and drawings live in it together; there is no separate "backgrounds" area. Every layer can be shown or hidden, has an **opacity** and a place in the **order** (top = drawn on top), and can be locked. **+ Laag** adds a layer of one of these types, and the same type can be added more than once (e.g. two "Bos" layers).

**Drawing (vector) layers.** Each has a *kind*, which decides what it means:

| Kind | Holds | Affects routing? | Notes |
|---|---|---|---|
| **Beloopbaar** | lines **and** polygons | **yes** | Lines = paths (the network, same connection rules as the app). Polygons = open walkable areas, crossed in straight lines. Holes = not walkable (cut a stage out of a field) |
| **Water** | polygons | no | Visual / information only |
| **Bos** | polygons | no | Visual only. Walkable forest = also draw it in Beloopbaar |
| **Zand** | polygons | no | Visual only |
| **Hekken** | lines | no (v0) | Must look clearly like a fence, so visitors can orient by it |
| **Voorzieningen** | points and traced outlines | via "nearest X" | See Facilities |
| **Eigen laag** | lines / polygons | my choice | Custom name and colour, and a switch: walkable or visual only |

**Image layers:**

| Type | Notes |
|---|---|
| **Luchtfoto (PDOK)** | Fetched for the map area. Shown live while editing; downloaded at export |
| **Afbeelding of PDF** | Organiser layout, site plan, CAD export as PDF. Pick a page, render it, optionally crop it, then **georeference** |
| **Basiskaart BGT** | The existing `base.geojson` as a dark vector base |
| GeoTIFF / DXF | Later: ready-made georeferenced maps from organisers, CAD lines |

**Layer properties window.** Every layer has a settings button that opens its own properties window (beside the map, in place of the object card), with three tabs:
- **Stijl**: colour (a palette per kind plus hex), fill (solid / hatched / texture / none), line or edge width and style (solid / dashed), opacity, order (up/down). For images also brightness, plus Georefereren and Bijsnijden.
- **Gedrag**: name, kind, walkable (fixed by kind, switchable only on a custom layer), locked, "don't export" (editor only).
- **Eigenschappen**: custom fields that every object in the layer gets (e.g. surface, width, opening times). The structure is there in v0; the fields themselves come later.

Layer style is stored in `project.json` and the export carries it along, so the app can use the same colours later.

Whether you can walk somewhere is decided **only** by Beloopbaar layers (and custom layers switched to walkable). There is **no `blocked` layer**.

Later: a "closed path" feature (a path that exists but is temporarily closed), and more terrain kinds.

## Drawing

- Draw by clicking points: lines (paths, fences) and polygons (areas, footprints). Plus a **rectangle** tool.
- Select, then move, edit vertices, add or remove vertices, delete.
- **Snapping** to vertices and segments of other features in the same layer, toggleable. **Shared vertices** at junctions, so the routing connects what I connect. Snapping can be held off with a modifier key.
- **Cut a hole** in a polygon (for a stage inside a walkable field).
- Rotating applies to traced facility outlines; free polygons can only be reshaped.
- **No live problem warnings** while drawing (explicitly not now). The layers card only shows counts.

## Facilities (Voorzieningen)

Every facility has a **category** and is either:
- **a dot**: one click (e.g. a nooduitgang), or
- **a traced outline**: click the corners over the aerial or plan (e.g. a stage). The icon sits in the middle. Podium, Bar and Eten default to tracing.

There is **no library of reusable designs**: every festival is different, so each outline belongs to its own facility. Move it by dragging the icon, rotate it with the white handle or R / ⇧R.

**Categories**: Podium, Bar, Eten, WC, EHBO, Munten, Waterpunt, Kluisjes, Ingang, Nooduitgang, Calamiteitendoorgang, plus custom categories. Each has a colour and a short label.

**Facility card**: shows the information, with a *Bewerken* mode to change it:
- name, category, info text
- a **photo** (stored in `projects/<id>/photos/`)
- a **planning / timetable** (day, start, end, act), shown grouped per day; always offered for stages
- under *Op de kaart*: outline (trace again or back to a dot), navigation points, delete.

**Visibility**: the Voorzieningen layer and each category can be switched off in the layers card. A facility you place while its layer or category is off stays visible until you toggle that layer or category again; the selected facility is always visible.

The export writes `facilities.geojson` with category, name, info, timetable, photo path (copied to `maps/<id>/photos/`), outline and navigation points.

## Georeferencing

The same way QGIS does it:
- In the split view, click a point on the image, then the matching point on the map. Repeat. Points can be edited and deleted.
- Shows the error per point.
- Transform: **affine** for 3+ points (default). **Polynomial** for 6+, as an option.
- Live preview of the warped image on the map with an opacity slider.
- The server runs `gdal_translate -gcp` + `gdalwarp` and stores the warped result in the project.

## Route testing

In the browser, using **the same routing rules as the app**. Port `Floc/Routing.swift` to TypeScript, so the browser predicts what the phone will do:

- **Paths connect only where they really touch:** a shared vertex, or a line end on another line (≤ 1 cm). Crossings without a shared vertex are not connected. A gap is intentional.
- **Walkable areas:** a visibility graph across the polygons, honouring holes, joined to the path network.
- **Shortest walking distance**, shown as distance + time at 5 km/h.

Modes:
- **A → B**: click a start, click a destination.
- **Nearest X**: click a start, then pick a category (WC, Bar, EHBO, Munten, Nooduitgang, … — every category, custom ones included). It routes to the nearest one.
- A facility's routing target is **its centre** (the dot, or the footprint's centroid).
- A target that can't be reached shows "Geen route — niet verbonden".

## Export → `maps/<id>/`

Writes what the app reads today, plus extra data the app ignores for now:

| File | From |
|---|---|
| `map.json` | name, notes |
| `paths.geojson` | lines from Beloopbaar layers |
| `walkable.geojson` | polygons from Beloopbaar layers (with holes) |
| `stages.geojson`, `bars.geojson`, `munten.geojson` | Facilities of those categories, as **points** (dot, or outline centre) with `name` |
| `base.geojson` | BGT base merged with my Water / Bos / Zand layers (`kind`: water / forest / sand) |
| `aerial.mbtiles` | PDOK aerial, map extent, zoom 14–20, **JPG** |
| `layout.mbtiles` | the georeferenced layout (top visible Afbeelding/PDF layer), PNG |
| `facilities.geojson`, `fences.geojson` | **Extra**: every facility with category, footprint and all properties, plus fences. Not read by the app yet |

All GeoJSON is EPSG:4326. Export overwrites the folder after a confirmation.

## Project storage

```
editor/
├── projects/<id>/
│   ├── project.json        name, notes, extent, the layer stack (type, kind, order, opacity, visibility)
│   ├── layers/<layer>.geojson   one file per drawing layer (mixed lines/polygons allowed)
│   ├── facilities.geojson  dots and outlines, info, photo, timetable, nav points
│   └── images/             source images/PDF renders, GCPs, warped GeoTIFFs
└── library/
    ├── (designs.json)      no longer used
    └── categories.json     categories, colours, icons (incl. custom)
```

Plain files, so Claude can read them and I can see in git what changed. Large rasters are git-ignored.

## Build order

The tools don't force any workflow; this is only the order I build them in:

1. **Skeleton + look.** Maps overview, editor screen in the chosen design, MapLibre with the PDOK aerial, autosave, undo. **Import** of Wildeburg.
2. **Drawing.** The layer stack, all drawing kinds (Beloopbaar with lines + polygons), snapping, shared vertices, holes.
3. **Facilities as dots** + categories + the properties card.
4. **Image layers.** PDOK, image/PDF import, crop, georeferencing via GDAL, opacity and order in the one stack.
5. **Design workshop + library**, placing/rotating designs, shared vs individual properties.
6. **Route testing.** Port of the routing, A→B and nearest X.
7. **Export** to `maps/<id>/`, including MBTiles.

## Out of scope (v0)

3D, SketchUp/CAD model import, DXF/GeoTIFF import, inner details of designs, timetables, opening times, one-way lanes, time-based closures, closed-path feature, calamity entrances, live drawing warnings, grid and labels from the organiser's plan, user-placed points (meet-up spots, tent location — an **app** feature for later), multiple users, hosting, app changes.

## Defaults I chose (not discussed; change freely)

- A dot can be swapped for a design and back (asked, not answered).
- PDF import = pick a page + optional crop (asked, not answered).
- The design library is **global** (shared by all maps), not per map.
- Stack: React + Vite + TS, Terra Draw, Node server, QGIS's bundled GDAL.
- Affine georeferencing by default.
- Fences don't block routing in v0. You leave the walkable area out where a fence is.

## Built (v0, 2026-11-21)

How to run: see [README.md](README.md). Choices made while building:

- **Holes** are stored as separate polygons in the layer with `hole: true`, so a hole (e.g. a stage cut-out) can be moved and reshaped. They're cut out on screen, in routing and in the export.
- **Importing** works in two places. In *Kaarten → Importeren* you make a new map from a `maps/` folder, a `qgis/*.gpkg` or your own files. In the editor, *+ Laag → Bestand importeren* adds a file to the open map, and you choose per part where it goes: a new layer, an existing layer, or facilities of a category. Formats: GeoJSON, JSON (including a list of objects with lat/lon), GeoPackage, KML, GPX, Shapefile (.zip), DXF and CSV. Other projections are converted to WGS84.
- Imported `blocked.geojson` becomes a custom layer "Geblokkeerd (import)" that is visual only. An imported `layout.mbtiles` becomes an image layer that is already georeferenced.
- A **new map** starts with Voorzieningen, Beloopbaar and the PDOK aerial. The PDOK year/resolution is chosen in the layer properties.
- Left out because nothing in the spec gives them a function yet: an *Instellingen* screen and GeoTIFF import.

## v1 additions (2026-11-21)

Asked for after using v0. Built pragmatically after one interview round ("keep to what I said, be pragmatic where you need to be creative").

| Feature | How it works |
|---|---|
| **Snap distance** | Slider in the draw card and `[` / `]` while drawing. In **screen pixels** (zooming in makes it finer). A dashed circle around the cursor shows it. |
| **Holes are order-aware** | A hole only cuts polygons drawn *before* it. A walkable area drawn later over a hole wins. "Bovenop leggen" in the shape card moves a shape to the top. |
| **One-go cut-outs** | *Gat uitsnijden* in a non-walkable layer (an island in water) can make the cut-out walkable right away (toggle, on by default). A walkable area drawn over Water or a non-walkable custom layer cuts it out of those (toggle, on by default). |
| **Navigation points** | Per facility, any number. Routes end at the nearest one; without points, at the centre. Stored relative to the facility (they move and rotate with it). Exported as `nav` in `facilities.geojson` and the POI files. |
| **Semi-beloopbaar** | New layer kind (polygons). Meant for walkable bushes and campings full of tents. Routing ignores it, and that is final (2026-11-22, see "Terrain classes" in [../SPEC.md](../SPEC.md)); paths through it still work. The app's GPS dot only snaps to a path within a smaller distance there (default 2 m instead of 5 m; per layer, per shape adjustable). Exported as `semi.geojson` with `snap_m`. The app doesn't read it yet. *Route testen* shows where the GPS dot would be drawn. |
| **Overtrekken** | Voorziening → *Overtrekken*: click a shape over the aerial. Creates a design in the library (upright, rotation detected from the tightest rectangle), places it there and links it. From a facility card: *Vorm overtrekken* attaches the traced shape to that facility. |
| **Ingesloten vlak vullen** (F) | Click inside an area closed off by lines/polygons/footprints of all visible layers. Exact: the polygon uses the boundary's own vertices, so it joins the paths. Shapes inside become holes. "Gaten dichten tot X m" bridges loose path ends (only for filling). |
| **Vectoriseren op kleur** (K) | See below. |

### Vectoriseren op kleur

A pipeline in six visible steps; the heavy work runs in a Web Worker.

Order on screen = order of working = order of processing. A toggle at the top, **Toon wat de computer ziet**, shows the edited image of step 2 on the map. Colours in step 3 are picked from that edited image.

1. **Beeld**: a plan/PDF is always taken whole, an aerial photo for the area in view. Fixed ground resolution (1 / 0.5 / 0.25 m or the file's own), **independent of zoom**.
2. **Beeld bewerken**, applied top to bottom:
   - **Gladstrijken**: median smoothing (removes texture and thin drawn lines, keeps edges). First, so enhancing doesn't amplify noise.
   - **Contrast**: stretches lightness so the darkest and lightest 1% become black and white (0–100% mix).
   - **Verzadiging**: multiplies colourfulness (a/b in Lab), 0–300%. 0% = lightness only.
   - **Kleuren uit elkaar halen**: *+ Kleur aanwijzen*, then click each colour to tell apart (e.g. a light-grey path and the grass). Each click measures the mean and spread in a ~1 m circle. Every pixel's distance to each group is measured relative to the pooled spread (Mahalanobis), so texture within a group counts little and the difference between groups a lot. Pixels close to a group move towards that group's bright colour (auto, or chosen per colour; give two clicks the same colour to treat them as one kind, e.g. grass in sun and in shade). Pixels like none of them turn grey and darker. *Sterkte* 0–100%. The aimed colours are kept after *Toevoegen* (so you can vectorise the next object with the same image) and cleared when you switch image.
   - **Kleuren samenvoegen**: k-means in Lab (shades that belong together become identical), on the enhanced image.
   - *Terug naar het originele beeld* resets the enhancement.
3. **Kleuren**: click = pick, ⌥ click = exclude (never, even within the tolerance), ⌘ click = ignore (lines and labels count as part of what's around them). Colour difference is ΔE in CIELAB, with *Licht en donker meetellen* (moved here from step 2: it's part of measuring difference). Scope: the clicked piece, or everywhere.
4. **Opschonen**: remove patches smaller than X m², fill holes smaller than X m² (small obstacles aren't cut out), close narrow gaps.
5. **Bijwerken**: draw in, cut away, cut line, fill a hole. Stored in map coordinates, so they survive changing the settings.
6. **Resultaat**: polygons or centre lines, simplification in metres (never self-crossing), target layer. *Toevoegen* adds it, makes that layer active and selects the shape for editing.

Enhancement settings (contrast, saturation, strength) are remembered like the other settings; the aimed colours are not (they belong to one image).

Background: tolerance-based selection on photos works badly unless colour variation is reduced first. Map-digitising research uses mean-shift/median smoothing followed by k-means colour quantisation, in a perceptual colour space, then vectorises a binary mask. ([Chiang et al.](https://spatial-computing.github.io/papers/chiang09icdar.pdf), [Global Mapper Vectorize Raster](https://www.bluemarblegeo.com/knowledgebase/global-mapper/Vectorize_Raster.htm))

## v2 additions (2026-11-22)

From a feedback list after using v1. Built straight away (no interview), choices listed here.

| Feature | How it works |
|---|---|
| **Shape to another layer** | Shape card → *Laag*: lists the unlocked layers that hold this geometry (lines or polygons). The shape moves there in one undo step; that layer becomes active and the shape stays selected. |
| **Hole → shape** | Shape card of a hole → *Vlak van dit gat maken in…*: a new polygon with exactly the hole's outline goes into the chosen layer (e.g. a grass layer). The hole itself stays, so it keeps cutting the original layer. A polygon with inner rings (from Ingesloten vlak vullen) gets *Gaten in dit vlak als vlak in…* (one polygon per ring) and *Gaten dichten*. |
| **Own colours** | Layer properties → Stijl: a colour picker (rainbow swatch) next to the palette, plus the hex field (now also without `#`). |
| **Snapping across lines and polygons** | Terra Draw only snapped a polygon to polygons and a line to lines. Replaced by our own snapping: every line and polygon of the active layer, corners first, otherwise the nearest point on an edge. Same for dragging corners in Selecteren. Hold **⌥** to place a point without snapping. |
| **Areas join paths at a snapped corner** | Routing: an area corner lying on the middle of a path splits the path there, so the area and the path connect without overlapping. Also in the app (`Floc/Routing.swift`). Earlier rules still apply: a path point on an area edge, or a path crossing the edge, also connects. |
| **Colour pick = what you see** | A pick used the most typical pixel of a 3×3 block of the *edited* image (step 2). On a photo one pixel is noisy, so the colour depended on where exactly you clicked. Now: that pixel, then the average of all pixels within ~0.75 m that look like it. The card shows the colour as you see it, and an arrow to the colour the computer compares when step 2 changed it. |
