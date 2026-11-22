# floc editor

De floc studio: hier teken je festivalkaarten en publiceer je ze naar de app. Zie [SPEC.md](SPEC.md) voor wat de editor doet en [../backend/SPEC.md](../backend/SPEC.md) voor de server.

Online: **https://floc-server-production.up.railway.app/studio/** (zonder georefereren/PDF, want daar is geen GDAL). Op de Mac draait dezelfde studio met GDAL, op dezelfde database en opslag.

## Starten

```sh
cd editor
npm install      # eenmalig
npm run dev      # haalt via `railway run` de database- en opslagsleutels op
```

Open daarna **http://localhost:5180/studio/** en log in. Stoppen: `Ctrl+C` in de terminal.

Nodig:
- **Node 22** of nieuwer.
- **Railway CLI**, ingelogd (`railway login`) en in deze repo gekoppeld aan project `floc`.
- **QGIS** in `/Applications`. De editor gebruikt de GDAL die in QGIS zit voor PDF's, GeoPackages, georefereren en MBTiles. QGIS zelf hoeft niet open te staan.
- **Internet** voor de PDOK-luchtfoto, de BGT en het zoeken naar adressen.

## Waar staat wat

| Map | Inhoud |
|---|---|
| Postgres (Railway) | je kaarten (concept), accounts, organisaties, gepubliceerde versies |
| bucket `floc-files` (Railway) | `projects/<id>/images/…` en `photos/…`, en de gepubliceerde pakketten `releases/<id>/<versie>/…` |
| `editor/.cache/` | lokale werkkopieën van beelden voor GDAL (niet in git) |
| `editor/projects/` | oude opslag van vóór de backend, al overgezet (`npm run migrate-local`) |
| `editor/library/` | categorieën van voorzieningen (`categories.json`), gedeeld door alle kaarten. `designs.json` wordt niet meer gebruikt |
| `maps/<id>/` | wat **Exporteren** schrijft, voor de iOS-app |

Alles wordt automatisch opgeslagen.

## Sneltoetsen (editor)

| Toets | Actie |
|---|---|
| V | Selecteren |
| L | Lijn tekenen |
| G | Vlak tekenen |
| M | Rechthoek |
| U | Gat uitsnijden |
| F | Ingesloten vlak vullen |
| K | Vectoriseren op kleur (stap 2 „Kleuren uit elkaar halen”: klik kleuren aan om ze uit elkaar te trekken; ⌥ klik uitsluiten, ⌘ klik negeren, ⌫ laatste stap, ↵ toevoegen) |
| [ / ] | Snapafstand kleiner / groter (tijdens tekenen) |
| ⌥ (ingedrukt) | Punt zetten zonder te snappen |
| O | Voorziening plaatsen |
| T | Route testen |
| ⌘Z / ⇧⌘Z | Ongedaan maken / opnieuw |
| Backspace | Geselecteerde vorm of voorziening verwijderen |
| R / ⇧R | Geselecteerde voorziening 15° draaien |
| Esc | Selectie opheffen, tekenen annuleren |
