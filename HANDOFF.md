# Handoff — working on the maps (QGIS)

**For the next Claude session.** The user wants to work on building their event maps in QGIS and wants informed advice on how to set them up so they work well in the floc app. Read this first, then [SPEC.md](SPEC.md).


## Update 2026-11-21: app v1

The map editing moved from QGIS to the **dashboard** (`editor/`, see `editor/SPEC.md`). The iOS app was rebuilt around what the dashboard exports: see **"App v1 — dashboard-driven"** at the end of [SPEC.md](SPEC.md). In short: dark dashboard look, aerial + walkable areas + paths only (path colour adjustable), facilities with info/timetable/photo, search, categories sorted by walking distance, saved places with a special sleeping spot, favourites. The current test map is `maps/wildenburg2026-v2` (export with a 600 m aerial). New test arguments: `-sleep <lat>,<lon>`, `-category <id>`, `-select <name>`, `-search <text>`.

## Who and what

- **floc**: navigation for events (festivals, marathons, fairs, city events), "Google Maps for events". It routes over the event's own layout (paths, closures, obstacles), which normal maps don't have.
- **This repo is a throwaway prototype / test bench for the user alone.** It exists to discover pain points before specifying the real product from scratch. Optimise for learning fast, not for polish.
- The user writes Dutch and English mixed (often dictated). Answer in the language they use.
- **QGIS level: beginner.** They have georeferenced the organiser's layout over a PDOK aerial photo, drawn paths as lines and exported layers. They did not know how QGIS stores layers. Give **click-by-click steps** with the Dutch menu name plus the English one (their QGIS may be in either language). QGIS stays their only map editor; there is no editing in the app.
- They prefer being **interviewed before you write specs or make big decisions**. Ask, don't assume.

## Current map: `maps/wildenburg2026/`

- **Event:** the Wildeburg festival site (organiser Kultlab), Leemringweg, Kraggenburg (NL). Roughly 5.874–5.887 E, 52.679–52.687 N, about 870 × 750 m.
- **Terrain:** woods with many small paths, a big open field area, ponds and water, and several camping areas.
- **Files:**
  - `paths.geojson`: 186 MultiLineStrings, EPSG:4326 (CRS84), field `lengte_m` (unused).
    - One big connected network plus **3 tiny disconnected pieces** (2–7 points).
    - 85 line ends lie *on* another line without a shared vertex. The app handles these as T-junctions.
  - `aerial.mbtiles`: PDOK luchtfoto, zoom 14–20, exported as **PNG (162 MB)**. JPG would be about 5× smaller.
  - `layout.mbtiles`: the organiser's site plan, georeferenced.
  - `base.geojson`: dark vector base map generated from the Dutch BGT by `tools/fetch_bgt.py` (366 polygons, `kind` field).
    - Precise around the site.
    - Coarse *inside* the festival grounds: mostly one big grass polygon, no forest or sand detail.
  - `map.json`: still `{ "name": "Festival v1" }`. The user renamed the folder but not the name.
  - **No `blocked.geojson` yet**, so no water or obstacles are blocking routes.
- The organiser's plan (the user shared it) has these land classes: gras, begaanbare bebossing, dichte bebossing, zand, water. It also shows a grid A–R × 1–13, areas (Area 1 Wildlive … Area 12 De Tanker), campings 1–4, EHBO, sanitair, entrances/exits (poortwachter A/B, nooduitgangen NU1–NU13, calamiteiten ingangen) and a long bridge or jetty over the southern pond (near Area 9/10).

## What the app does with map files (built and working)

One folder per map in `maps/<id>/`. The app finds every folder that has a `paths.geojson`; adding a map means adding a folder and rebuilding. **All GeoJSON must be EPSG:4326.**

| File | Geometry | Used for |
|---|---|---|
| `map.json` | — | `name` (and optional `notes`) shown in the map list |
| `paths.geojson` | (Multi)LineString | the walking network; routing runs only over this |
| `blocked.geojson` | (Multi)Polygon | non-walkable areas: water, fences, stages, closed roads |
| `base.geojson` | Polygon with `kind` | the dark "Map" background (styled in `Floc/DarkPalette.swift`) |
| `aerial.mbtiles` / `layout.mbtiles` | raster | "Aerial" / "Layout" backgrounds |

**Rules the routing applies.** These matter most when advising on drawing:

- **Paths connect only where they really touch:**
  - a shared vertex, or
  - a line's end lying on another line (within 1 cm).

  A gap, even 1 m, is treated as intentional. **Lines that cross without a shared vertex are NOT connected** (treated like a bridge). This was the user's explicit choice: "if there's a gap, it may be there for a reason."
- Path pieces inside a blocked polygon are removed from the network. Drawing a blocked polygon over a road therefore closes it, and a path that crosses water without being drawn as a bridge is cut.
- **Location snapping:** within 5 m of a path, the dot snaps onto it. A raw location inside a blocked area is pushed just outside it.
- Destinations snap to the nearest point on the network. A destination on a disconnected piece shows "No route — not connected", which is handy for finding gaps.

Not built yet: walkable open areas, POIs and labels, attributes such as cost or one-way.

## Open topics the user may bring up

1. **Water and obstacles.** I explained how to draw a `blocked` polygon layer in QGIS. I also offered to extract the 62 BGT water polygons from `base.geojson` into `blocked.geojson` automatically. **The user hasn't answered.**
   - Remind them that any bridge or jetty must be drawn as a path, or routes can't cross the water.
2. **Walkable open areas** (fields, beaches, the area in front of a stage). The user wants routes straight across open space, not along lines only.
   - I recommended a **visibility graph**: `walkable.geojson` polygons, with blocked polygons as holes and vertices inset by about 1 m. Lines of sight between vertices are added to the existing graph, so the same Dijkstra runs. Path ends touching an area get connected too.
   - Inside walkable areas the dot follows the raw location (no snapping).
   - Alternatives I rejected for now: navmesh (overkill), grid A* (only if many surface costs are wanted later).
   - **Not built and not yet in SPEC.md.** The user only asked what the best approach is.
3. **Richer base map.** The BGT is coarse inside the site. Options I gave:
   - (a) try OpenStreetMap
   - (b) the user traces forest and sand polygons over the aerial in QGIS (most control, best result)
   - (c) recolour the georeferenced organiser layout raster (fast, but grid and labels are baked in)

   I recommended (a), then (b). The user hasn't chosen.
4. **POIs** (EHBO, sanitair, food, munten, stages/areas, entrances, emergency exits). These are not in the spec yet. They were explicitly deferred: v0 picks destinations by long-press. Worth suggesting a `pois` point layer with `name` and `category` when they start mapping facilities, but ask first.

## Advice to give on structuring the QGIS work

- Keep **one GeoPackage** (e.g. `floc_tekenen.gpkg`) holding all their drawing layers: `paths` (line), `blocked` (polygon, field `kind`: water/fence/stage/closure), later `walkable` (polygon) and `pois` (point, `name`, `category`).
- **Snapping:** turn on vertex + segment snapping, and **topological editing** (Project → Snapping Options). This gives shared vertices at junctions, which is exactly what the routing needs.
- Export each layer with right-click → Export → Save Features As… → GeoJSON → `maps/<id>/<layer>.geojson`, **CRS EPSG:4326**.
- **Versions** = copy the map folder (`maps/wildenburg2026-v2/`) and change `name` in `map.json`. The user wants to compare map versions side by side in the app.
- For rasters: Processing Toolbox → Generate XYZ tiles (MBTiles), zoom 14–20. Make only that layer visible, use JPG for aerial photos.
- A helpful next tool: `tools/check_paths.py`, reporting disconnected pieces, near-miss gaps (< 2 m) and crossings without a shared vertex, so the user gets feedback without opening the app. I did this check ad hoc once; it isn't a script yet.

## Practical notes for running the app

- Intel MacBook Pro 2020, macOS 26. **Xcode 26.6 Universal** in `/Applications/Xcode.app` (Xcode 27 doesn't run on Intel).
- The project is generated with **XcodeGen** (`project.yml`). Run `xcodegen generate` after adding Swift files. The `maps/` folder is a folder reference, so new maps only need a rebuild.
- Build: `xcodebuild -project Floc.xcodeproj -scheme Floc -destination 'platform=iOS Simulator,id=E53D5F36-539F-4BAE-9957-93116EC0C0FB' -derivedDataPath build build`
  - This is the **iPhone 16 / iOS 18.3 simulator**. The iOS 26.5 simulator hangs on boot on this Mac.
- Test launch arguments:
  - `-openMap <folder>`
  - `-place <lat>,<lon>` (joystick location)
  - `-goto <lat>,<lon>` (destination)
  - `-showRaw`
  - `-zoom <n>`
  - `-logLocation`

  The map takes about 30–45 s to render in the simulator, so wait before taking a screenshot.
- The app **is installed on the user's iPhone 15 (iOS 26.6)** since 2026-11-21. Build: `xcodebuild -project Floc.xcodeproj -scheme Floc -destination 'platform=iOS,id=5B279DE7-5F30-543E-835D-79E53158A000' -derivedDataPath build -allowProvisioningUpdates build`, then `xcrun devicectl device install app --device 5B279DE7-5F30-543E-835D-79E53158A000 build/Build/Products/Debug-iphoneos/Floc.app` and `xcrun devicectl device process launch --device 5B279DE7-5F30-543E-835D-79E53158A000 nl.floc.prototype`. Free Apple ID: re-install every 7 days.
- **Nothing is committed to git yet.** Everything is untracked, and `*.mbtiles` is in `.gitignore`.
