#!/usr/bin/env python3
"""
Fetch Dutch BGT topography (PDOK) for an area and write a simplified base map for floc.

    python3 tools/fetch_bgt.py maps/festival-v1 5.8725,52.6785,5.8890,52.6875

Output: <map folder>/base.geojson — polygons with a single `kind` property:
farmland, grass, shrub, forest, sand, unpaved, paved, road, path, water, bank, bridge, building, wall.
The app styles each kind; restyling never requires re-fetching.
"""
import json
import sys
import urllib.parse
import urllib.request

API = "https://api.pdok.nl/lv/bgt/ogc/v1/collections/{}/items"

FOREST = {"gemengd bos", "loofbos", "naaldbos"}
SHRUB = {"struiken", "houtwal", "heide", "moeras", "rietland", "kwelder"}
FARMLAND = {"bouwland", "fruitteelt", "boomteelt"}
SAND = {"zand", "duin"}
PAVED = {"open verharding", "gesloten verharding"}
FOOTWAY = {"fietspad", "voetpad", "voetgangersgebied", "ruiterpad", "voetpad op trap", "woonerf"}


def kind_for(collection, p):
    fv = (p.get("fysiek_voorkomen") or "").lower()
    if collection == "begroeidterreindeel":
        if fv in FOREST: return "forest"
        if fv in SHRUB: return "shrub"
        if fv in FARMLAND: return "farmland"
        if fv in SAND: return "sand"
        return "grass"
    if collection == "onbegroeidterreindeel":
        if fv in SAND: return "sand"
        if fv in PAVED: return "paved"
        return "unpaved"
    if collection == "waterdeel": return "water"
    if collection == "ondersteunendwaterdeel": return "bank"
    if collection == "ondersteunendwegdeel": return "grass"
    if collection == "wegdeel":
        return "path" if (p.get("functie") or "").lower() in FOOTWAY else "road"
    if collection == "overbruggingsdeel": return "bridge"
    if collection == "pand": return "building"
    if collection == "scheiding_vlak": return "wall"
    return None


COLLECTIONS = ["begroeidterreindeel", "onbegroeidterreindeel", "waterdeel", "ondersteunendwaterdeel",
               "ondersteunendwegdeel", "wegdeel", "overbruggingsdeel", "pand", "scheiding_vlak"]


def fetch(collection, bbox):
    url = API.format(collection) + "?" + urllib.parse.urlencode({"f": "json", "bbox": bbox, "limit": 1000})
    while url:
        with urllib.request.urlopen(url, timeout=60) as r:
            page = json.load(r)
        yield from page.get("features", [])
        url = next((l["href"] for l in page.get("links", []) if l.get("rel") == "next"), None)


def main():
    folder, bbox = sys.argv[1], sys.argv[2]
    out, counts = [], {}
    for c in COLLECTIONS:
        for f in fetch(c, bbox):
            p = f.get("properties") or {}
            if p.get("eind_registratie") or not f.get("geometry"):
                continue  # historic version or no geometry
            if f["geometry"]["type"] not in ("Polygon", "MultiPolygon"):
                continue
            k = kind_for(c, p)
            if not k:
                continue
            counts[k] = counts.get(k, 0) + 1
            out.append({"type": "Feature", "properties": {"kind": k}, "geometry": f["geometry"]})
    path = f"{folder.rstrip('/')}/base.geojson"
    with open(path, "w") as fh:
        json.dump({"type": "FeatureCollection", "features": out}, fh, separators=(",", ":"))
    print(f"wrote {len(out)} shapes to {path}")
    for k, n in sorted(counts.items(), key=lambda x: -x[1]):
        print(f"  {k:10} {n}")


if __name__ == "__main__":
    main()
