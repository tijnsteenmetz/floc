# floc editor

Lokale webapp om festivalkaarten te tekenen voor de floc-app. Zie [SPEC.md](SPEC.md) voor wat hij doet en waarom.

## Starten

```sh
cd editor
npm install      # eenmalig
npm run dev
```

Open daarna **http://localhost:5180**. Stoppen: `Ctrl+C` in de terminal.

Nodig:
- **Node 22** of nieuwer.
- **QGIS** in `/Applications`. De editor gebruikt de GDAL die in QGIS zit voor PDF's, GeoPackages, georefereren en MBTiles. QGIS zelf hoeft niet open te staan.
- **Internet** voor de PDOK-luchtfoto, de BGT en het zoeken naar adressen.

## Waar staat wat

| Map | Inhoud |
|---|---|
| `editor/projects/<id>/` | je kaarten: `project.json`, `layers/*.geojson`, `facilities.json`, `photos/` (foto's van voorzieningen), `images/` (bronbestanden en gegeorefereerde beelden, niet in git) |
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
