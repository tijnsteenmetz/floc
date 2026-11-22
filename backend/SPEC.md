# floc backend — Spec (fase 1: fundament)

Opgesteld 2026-11-22 na een interview. Dit is het **begin van het echte product**, niet meer het wegwerp-prototype: degelijk genoeg om te blijven en om pilotfestivals in 2027 te bedienen.

## Wat de backend doet

Eén backend voor drie dingen:

| Onderdeel | Wie | Wat |
|---|---|---|
| **Studio** (de huidige editor, online) | floc-team (bewerken), organisatoren (meelezen) | kaarten maken, concept → publiceren |
| **Website** | iedereen | de commerciële site, plus inloggen voor organisatoren (portaal → studio) |
| **iOS-app** | bezoekers (met account) | festivals ophalen, kaart downloaden, daarna offline; later live updates |

## Besluiten uit het interview

| Onderwerp | Besluit |
|---|---|
| Fase | Begin echt product |
| Editor-gebruikers | floc-team bewerkt. Organisatoren hebben een eigen account, zien alleen de kaarten van hun eigen organisatie en **lezen mee** (later: afsluitingen en meldingen sturen) |
| Inloggen organisatoren | E-mail + wachtwoord |
| Bezoekers | **Verplicht account** in de app |
| App ↔ kaarten | Downloaden en dan offline. Later live updates als er bereik is |
| Live (fase 2) | kaart- en infowijzigingen, afsluitingen, pushmeldingen, vrienden/locatie delen |
| Publiceren | **Concept → Publiceren.** De app ziet alleen gepubliceerde versies. Afsluitingen en meldingen (fase 2) gaan direct live |
| Zware verwerking | **Hybride.** GDAL (PDF, georefereren, GeoPackage, MBTiles/luchtfoto) draait op de Mac van het floc-team. De server slaat het resultaat op en deelt het |
| Domein | Nog geen domein. Voorlopig `*.up.railway.app` |
| Hosting | Railway |

## Architectuur (mijn keuzes, vrij te wijzigen)

```
Railway-project "floc"
├── service  floc-server   Node 22 + TypeScript (Express), één container
│     /            website (statisch, uit website/)
│     /studio      editor (gebouwde Vite-app)
│     /api/v1      API voor studio en app
├── Postgres                gebruikers, organisaties, kaarten (concept), versies
└── Bucket (S3)             afbeeldingen, foto's, gepubliceerde kaartpakketten (incl. aerial.mbtiles)
```

- **Eén service** in plaats van drie: goedkoper en simpeler. Met een eigen domein kan het later `floc.nl` / `studio.floc.nl` / `api.floc.nl` worden zonder codewijziging.
- **De editor-server groeit uit tot de backend.** De opslag verhuist van mappen op schijf (`editor/projects/`) naar Postgres en de bucket. De editor-code (types, export, routing) wordt hergebruikt.
- **Hybride = dezelfde server, twee plekken.** Op Railway draait hij zonder GDAL. Op je Mac start je dezelfde server met `railway run npm run dev`. Die praat met **dezelfde database en bucket**, en omdat QGIS er is, werken georefereren, PDF en publiceren daar. Online zijn die knoppen grijs met de uitleg "alleen in de studio op de Mac".
- Later kan GDAL ook in de Docker-container (`apt install gdal-bin`). Dan valt de hybride stap weg, als organisatoren zelf gaan tekenen.

## Datamodel (Postgres)

| Tabel | Inhoud |
|---|---|
| `users` | e-mail, wachtwoord-hash (scrypt), naam, `is_staff` (floc-team) |
| `organizations` | naam |
| `memberships` | user ↔ organisatie, rol `viewer` (later `live`: mag afsluitingen en meldingen sturen) |
| `sessions` | token-hash, user, verloopdatum, soort (`web` cookie / `app` bearer) |
| `projects` | kaart (concept): id, organisatie, naam, notities, meta (project.json), voorzieningen, `revision` |
| `project_layers` | per laag de GeoJSON (jsonb) |
| `releases` | gepubliceerde versie: kaart, volgnummer, door wie, wanneer, manifest (bestanden + groottes + hashes) |

Bucket-indeling:
```
projects/<id>/images/…     bronbeelden en gegeorefereerde beelden
projects/<id>/photos/…     foto's van voorzieningen
releases/<id>/<n>/…        map.json, facilities.geojson, paden, vlakken, aerial.mbtiles
```

**Gelijktijdig bewerken:** elke opslag stuurt de `revision` mee. Heeft iemand anders intussen opgeslagen, dan weigert de server (409) en meldt de studio "deze kaart is elders gewijzigd, herladen". Geen stil overschrijven.

## Inloggen en rechten

- Wachtwoorden met scrypt (ingebouwd in Node, geen extra pakket). Sessietoken als httpOnly-cookie (web) of `Authorization: Bearer` (app).
- **Organisatoraccounts maakt het floc-team aan** in de studio en zet ze in een organisatie. Het wachtwoord geef je zelf door.
- **Wachtwoord vergeten:** in fase 1 zet een teamlid het opnieuw. Mail (reset-link) komt met een maildienst, bijvoorbeeld Resend, in fase 2.
- Bezoekers registreren zich in de app met e-mail + wachtwoord.
- Het eerste staff-account komt uit een eenmalig script (`npm run create-staff`).

## API (fase 1)

```
POST /api/v1/auth/register|login|logout     GET /api/v1/auth/me
GET  /api/v1/events                         gepubliceerde festivals (voor de app)
GET  /api/v1/events/:id/release             nieuwste versie: manifest met download-URL's
… plus de huidige editor-API onder /api/v1/projects, met rechtencheck
```

De app downloadt pakketbestanden via tijdelijke (pre-signed) bucket-URL's. 190 MB luchtfoto's gaan dan rechtstreeks uit de bucket, niet door de server.

## iOS-app (fase 1)

- Inlogscherm (registreren/inloggen), token in de Keychain.
- Festivallijst van de server. Tik → pakket downloaden met voortgangsbalk → opslaan in Application Support → openen zoals nu.
- Bij openen (met bereik): is er een nieuwere versie? Dan "Update beschikbaar (35 MB)".
- Daarna volledig offline, zoals nu. De meegebundelde kaarten blijven voorlopig als testkaarten.

## Migratie

Een script zet `editor/projects/*` (incl. beelden en foto's) over naar Postgres en de bucket, onder een organisatie "floc (intern)".

## Bouwvolgorde fase 1

1. Railway: project `floc`, Postgres, bucket, service `floc-server` gekoppeld aan GitHub (`main` → automatisch deployen).
2. Server: database-schema, opslaglaag (Postgres + bucket) in plaats van schijf, migratiescript.
3. Inloggen, organisaties, rechten. Studio onder `/studio` met inlogscherm. Website onder `/`.
4. Publiceren: export → pakket in de bucket → release.
5. App: inloggen, festivallijst, downloaden, updatecheck.

## Fase 2 en later

- Live: afsluitingen en meldingen (de app haalt ze op bij bereik, via polling of SSE). Routes houden rekening met afsluitingen.
- Pushmeldingen (APNs).
- Vrienden: groep, locatie en tent delen.
- Mail (wachtwoord-reset, uitnodigingen), eigen domein, GDAL op de server, organisatoren die zelf tekenen.

## Risico's en open punten

- **App Store en verplicht account.** Apple wijst apps af die een account eisen voor functies die er niet om vragen (richtlijn 5.1.1). Een kaart bekijken vraagt er niet om, vrienden en sync wel. Voor TestFlight en pilots is dit geen probleem. Vóór de echte App Store-release opnieuw bekijken.
- **Push en distributie vragen een betaald Apple Developer-account** (€99 per jaar). Met de huidige gratis Apple ID werken pushmeldingen niet en kunnen pilotbezoekers de app niet installeren (geen TestFlight).
- **Locatie delen = persoonsgegevens (AVG).** Dit vraagt toestemming, korte bewaartermijn en een privacyverklaring. Daar zijn we in fase 2 mee bezig.
- **Kosten Railway:** Hobby $5 per maand incl. $5 verbruik. Server + Postgres + enkele GB in de bucket komt naar schatting op $5–15 per maand.
