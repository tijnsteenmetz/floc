# floc — Prototype Spec (v0, discovery)

## Purpose

floc will be navigation for events (festivals, marathons, fairs, city events), working where Google Maps can't: on sites Google doesn't map (fields, forests) and with event information Google doesn't have (closures, facilities).

**This prototype is a disposable test bench for me alone.** It proves the core loop:

> draw an event map in QGIS → get it into an app on my iPhone → see where I am → get a sensible walking route

and shows me the pain points, technical, workflow and UX, so I can later **spec the real app from scratch**. The code doesn't need to last. Learning fast beats architecture.

There is no definition of done. I'll use and extend it over the coming ~2 months (winter 2026–27), aiming to start the real product next summer.

## Core principle: a bad route costs trust, a long route doesn't

> **Never send someone along a route that visibly doesn't work. A slightly longer route is fine.**

Visitors notice a bad route at once: a dead end, a closed gate, walking between a thousand tents, pushing through bushes. That breaks trust in the app. A route that's 200 m longer usually goes unnoticed. If someone does find a shorter way, they feel proud of themselves rather than distrusting the app.

So the two kinds of error are not equal. A **false connection** (the map says you can pass, reality says no) is expensive. A **missed shortcut** (the map leaves out a passage that exists) is cheap. Every step from drawing to routing chooses the cheap error:

- **Drawing:** only draw a connection you're sure of. When in doubt, leave the gap, or mark the area semi-walkable or not walkable. This is also why a gap between paths counts as intentional.
- **Routing** runs only over paths and walkable areas. Prefer the robust route (paths, clear open areas) over the shortest one. Route changes need a clear gain (hysteresis), so the route doesn't jump around.
- **Location:** when it's unclear which path someone is on, don't guess confidently. A wrong snap gives a wrong route.

### Terrain classes (decided 2026-11-22)

Terrain classes decide **where the dot may be**. Only paths and walkable areas decide **where routes go**.

| Class | Routing | Location dot |
|---|---|---|
| **Path** | yes | snaps to the path |
| **Walkable area** | yes | raw location (no snapping) |
| **Semi-walkable** (walkable bushes, campings full of tents) | **no** | GPS may be here: raw location, snaps to a path only when very close (`snap_m`, default 2 m). You're snapped to a path later than elsewhere |
| **Not walkable** (water, dense forest, and everything not drawn as one of the above) | no | a GPS location here is not shown: the dot goes to the nearest walkable point (path or walkable area), **if that is within the snap range** |

**Snap range from not-walkable terrain** (`unwalkable_snap_m`): an adjustable distance, e.g. 10 or 20 m (default 15 m).
- Within the range, the dot goes to the nearest walkable point.
- Further away, the app assumes you really are somewhere off the map (outside the site, or GPS badly off) and doesn't guess. The dot shows the raw location, and a route starts with the dashed connector to the nearest walkable point.
- Set per map in the editor and exported in `map.json`. It can be overridden in the app's *Instellingen* for testing.
- Later: the range follows the GPS's own accuracy estimate.
- **Editor checks:** look for false connections first (a path that seems to connect but doesn't in reality, a route through a fence or between tents). Missing shortcuts come second.

## Decisions

| Topic | Decision |
|---|---|
| Platform | **Native iOS app, Swift + SwiftUI**, installed on my own iPhone from Xcode (free Apple ID; re-run from Xcode when the 7-day provisioning expires) |
| Map engine | **MapLibre Native for iOS** (via Swift Package Manager). Fully offline, no base map required, local raster tiles, rotation and heading support |
| Connectivity | **Fully offline.** No server, no hosting, no network calls |
| Maps source | **Bundled in the project**, one folder per map. Adding a map = add a folder and rebuild |
| Map editor | **QGIS** stays the only editor. Nothing is edited in the app |
| Background | **No street map.** A switch between a **dark vector "Map"** (from `base.geojson`), the **aerial photo (PDOK luchtfoto)** and the **organiser layout**. The app runs in dark mode |
| Closures | Drawn in QGIS as non-walkable areas. A different closure situation = a different map |
| Location | Two modes: **Real GPS** and **Joystick (simulated)** |
| Snapping | Lock to a path when within **5 m** (fixed for now) |

## Map package

Each map is a folder under `maps/`. The folder name is the map's ID, and maps are just separate folders. Two versions of the same festival are simply two maps.

```
maps/
└── festival-v1/
    ├── map.json            name shown in the app (+ optional notes)
    ├── paths.geojson       LineStrings — where you can walk           (required)
    ├── blocked.geojson     Polygons — non-walkable: water, fences,
    │                       stages, closed roads…                      (optional)
    ├── base.geojson        Polygons with `kind` — dark vector base map,
    │                       generated from BGT by tools/fetch_bgt.py   (optional)
    ├── aerial.mbtiles      PDOK aerial of the event area               (optional)
    └── layout.mbtiles      organiser's georeferenced site plan         (optional)
```

`map.json`:
```json
{ "name": "Festival — v1, paths only", "notes": "first try" }
```

- All GeoJSON files are in **EPSG:4326**. No attributes are required yet. Any fields present are ignored for now.
- Images are **MBTiles** produced directly by QGIS. No conversion script needed (see appendix).
- The app finds all map folders at launch and shows them in a list using `name`.

## Screens

### 1. Map list
List of bundled maps by name (and notes). Tap one to open it.

### 2. Map screen
Full-screen map with:

- **Background switch:** Aerial ↔ Layout (only the ones present in the folder).
- **Layers:** paths (lines), blocked areas (semi-transparent fill).
- **Location dot with heading arrow.** This is the *interpreted* location (see below).
- **"Show raw location" toggle:** also shows the raw location as a small grey dot, with a thin line to the interpreted dot, to see how the interpretation behaves.
- **Camera toggle:** north-up ↔ rotate with heading, plus a re-centre button, like Google Maps.
- **Location mode toggle:** Real GPS ↔ Joystick.
- **Route:** line from the dot to the destination, with **remaining distance and walking time**.
- **Back** to the map list.

## Location

There are two separate things:

- **Raw location:** what the "sensor" says. Real GPS, or the joystick position in simulation.
- **Interpreted location (the dot):** where the app decides I am. All routing starts from here.

### Real GPS mode
`CLLocationManager` with best accuracy for position, and the compass (`CLHeading`) for heading. The location permission is "while using".

### Joystick mode
- On switching to joystick, I **tap the map to place my simulated location**. I can re-place it by tapping again at any time.
- An **on-screen joystick** (thumb, bottom corner) moves the raw location at walking speed (~5 km/h), proportional to how far I push it.
- Heading = the joystick direction (it keeps the last direction when released).
- The joystick moves the **raw** location, never the dot directly. The dot follows the interpretation rules exactly as with real GPS.

### Interpretation rules (v0)
1. If the raw location is **within 5 m of a path**, the dot = the nearest point on that path.
2. Otherwise, the dot = the raw location…
3. …unless that falls **inside a blocked area**. Then the dot = the nearest point outside it. The dot never shows me somewhere I can't be.

Planned later (not in v0): a let-go distance that scales with the GPS's own accuracy estimate (±2 m → trust raw, ±10 m → hold onto the path much longer), and walkable open areas.

## Routing

- **Network:** built from `paths.geojson` at load time.
  - Paths connect **only where they actually touch**: a shared vertex, or a line's end lying exactly on another line (within ~1 cm for rounding). A gap, even 1 m, is treated as intentional. Lines that cross without a shared vertex are *not* connected (think bridge).
  - Any path segment inside a blocked area is removed.
  - Imperfect maps giving odd routes is fine for now. Seeing what happens is the point.
- **Choosing a destination:** **long-press anywhere on the map.** The destination snaps to the nearest point on the network. Tap ✕ to clear.
- **Route:** shortest walking distance (A*/Dijkstra).
  - If the dot is off the network, the route starts with a straight dashed connector to the nearest walkable point on a path.
  - The same applies at the end, to the pressed point.
- **Updating:** the route is recalculated as the dot moves. It switches to a different route when that route becomes shorter, with a small margin so it doesn't flicker between two near-equal options.
- **No turn-by-turn directions.** Generated instructions risk misleading at unconventional sites. The route line is the guidance.

## Explicitly out of scope (v0)

Street or base maps, routing from outside the event, POIs and facilities (list, search, "nearest toilet"), one-way lanes, gates, access zones, time-based closures, accessibility, walkable open areas, path preferences or weights, simulated GPS error, GPS offset mode, session recording, debug or graph views, in-app editing, closure toggles, servers, Android.

## Build order

1. **Skeleton:** Xcode project, MapLibre, map list from `maps/`, open a map showing aerial/layout + paths + blocked areas, background switch.
2. **Joystick mode:** tap-to-place, joystick movement, heading, camera modes.
3. **Interpretation:** 5 m snapping, blocked-area push-out, raw location toggle.
4. **Routing:** network build, long-press destination, route line, distance and time, live updates.
5. **Real GPS mode:** permission, GPS + compass, mode toggle. First walk in my own neighbourhood with a small test map.

## Things I want to find out

- How much work is it to make a routable map in QGIS, and what goes wrong (gaps, crossings, missing pieces)?
- Do paths plus blocked areas give routes that *feel* right, and where exactly do they fail (open fields)?
- Does the 5 m snapping feel intuitive with joystick and with real GPS, and where does it break?
- Is aerial or layout the better background to navigate by?
- How does real GPS behave on foot, especially near trees and buildings?

## Defaults I chose (not discussed; change freely)

- Long-press to set a destination, since a plain tap is for placing the joystick location.
- Distance and walking time shown at 5 km/h.
- Minimum iOS version 17.

---

## Appendix: exporting from QGIS

### Drawn layers (paths, blocked areas)
1. In the Layers panel, right-click the layer → **Export → Save Features As…**
2. Format: **GeoJSON**.
3. File name: `…/floc/maps/<map-id>/paths.geojson` (or `blocked.geojson`).
4. CRS: **EPSG:4326 – WGS 84**.
5. OK. Repeat for each layer.

Blocked areas must be **polygons**. When creating the layer: *Layer → Create Layer → New GeoPackage Layer…*, geometry type **Polygon**.

Tip: turn on snapping while drawing paths (*Project → Snapping Options*, or the magnet icon) so lines actually connect.

### Aerial photo / organiser layout
1. Make **only** the image layer you want to export visible. The tool renders what's on the canvas.
2. **Processing Toolbox → Raster tools → Generate XYZ tiles (MBTiles)**.
3. Extent: **Draw on canvas** around the event area, with a little margin.
4. Minimum zoom **14**, maximum zoom **20**. Tile format **JPG** for the aerial; **PNG** for the layout if it has transparency.
5. Output file: `…/floc/maps/<map-id>/aerial.mbtiles` (or `layout.mbtiles`).

For a site of ~800 × 500 m this comes to a few hundred tiles, about 10–30 MB per image.

---

## App v1 — dashboard-driven (2026-11-21)

Asked for: "upgrade the app based on the dashboard: all information handy, easy to find a stage and its info, save places (own tent is special: *Slaapplek toevoegen*), favourites, follow the dashboard's UI. Only the aerial, paths and walkable areas are shown. Path colour adjustable. Aerial reaches ~600 m around the site." Built pragmatically; choices below.

**Map content.** Only three map layers: aerial photo, walkable areas, paths (in the path colour). Base map, layout, water, forest, semi-walkable and blocked areas are no longer drawn (blocked areas from old maps still affect routing). On top: facility markers (rounded badge in the category colour and label, as in the dashboard; stage names always, other names from zoom 17.3), your saved places, the route, you.

**Data from the dashboard.** The app reads `facilities.geojson` (category, colour, label, name, info, nav points, timetable, photo, outline). Older maps fall back to `stages/bars/munten.geojson`. Nameless facilities get "Nooduitgang 1, 2…" (north to south). The path colour defaults to the Beloopbaar layer colour in `map.json → styles`.

**Aerial.** The export now fetches the PDOK aerial for the terrain (walkable layers + facilities) plus **600 m** on each side, zoom 14–20 JPG (Wildeburg: ~10,500 tiles, 187 MB). `map.json` gets `site_bounds` and `aerial_bounds`; the app keeps the camera inside `aerial_bounds` and won't zoom out past 14.

**Screens.**
- *Kaarten*: dark cards with the map's categories.
- *Map*: top bar (back · map name/status · settings), square buttons for north-up/heading-up and re-centre, and one bottom panel that changes with what you're doing:
  - **Start**: search (names, categories, and acts in the timetable), category chips, *Mijn plekken*: the sleeping spot (or a dashed **Slaapplek toevoegen**), saved places and starred facilities as tiles, *Plek opslaan*.
  - **Category**: all of that kind, sorted by **real walking distance** over the network (one Dijkstra from you), "Dichtstbijzijnde · 140 m" to route there; the map shows only that category and zooms to fit.
  - **Facility**: photo, name, category, distance + time, **Route**, ☆ favourite, Info, Planning grouped by day; the traced outline is highlighted on the map. Routes end at the nearest navigation point.
  - **Saved place**: route ("Naar mijn tent" for the sleeping spot), move, rename, delete.
  - **Long-press** anywhere: *Gemarkeerde plek* → route, "Hier slaap ik", or save.
  - **Choosing a spot**: a crosshair in the middle; drag the map, "Mijn locatie" or "Hier".
- *Route*: shown in the top bar (name, distance · time, ✕). Route line lime with a dark casing, like *Route testen* in the dashboard.
- *Instellingen*: path colour (map default, 7 swatches, or any colour), GPS/Joystick, raw location.

**Saved places** are per map, on the phone only (UserDefaults): one sleeping spot, plus places of kind *Tent van iemand*, *Ontmoetingsplek*, *Favoriete plek*. Favourite facilities are a separate list of facility ids.

**Not done / open:** sharing a place with friends, opening times / "now playing" (the timetable's day is free text), the app still starts in Joystick mode, labels are images (offline, no font server).
