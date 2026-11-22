import Foundation

/// The dark "Map" background: flat, near-black, cool-toned, with water as the one colour that pops.
/// Every map's `base.geojson` has a `kind` per shape; restyle everything here.
enum DarkPalette {
    static let background = "#0A0C0F"

    /// Drawn bottom to top.
    static let fills: [(kind: String, color: String)] = [
        ("farmland", "#101317"),
        ("grass",    "#121A16"),
        ("bank",     "#131C17"),
        ("shrub",    "#16261D"),
        ("forest",   "#1A3124"),
        ("sand",     "#2A261F"),
        ("unpaved",  "#1E2024"),
        ("paved",    "#25282D"),
        ("road",     "#2E3238"),
        ("path",     "#353A41"),
        ("water",    "#0D2638"),
        ("bridge",   "#40454D"),
        ("wall",     "#3A3F47"),
        ("building", "#1F2329"),
    ]

    static let waterEdge = "#1F5A7F"
    static let buildingEdge = "#4A515B"

    static func layers(source: String) -> [[String: Any]] {
        var out: [[String: Any]] = fills.map { f in
            ["id": "base-\(f.kind)", "type": "fill", "source": source,
             "filter": ["==", ["get", "kind"], f.kind],
             "layout": ["visibility": "none"],
             "paint": ["fill-color": f.color, "fill-antialias": true]]
        }
        out.append(["id": "base-water-edge", "type": "line", "source": source,
                    "filter": ["==", ["get", "kind"], "water"],
                    "layout": ["visibility": "none"],
                    "paint": ["line-color": waterEdge, "line-width": 1]])
        out.append(["id": "base-building-edge", "type": "line", "source": source,
                    "filter": ["==", ["get", "kind"], "building"],
                    "layout": ["visibility": "none"],
                    "paint": ["line-color": buildingEdge, "line-width": 1]])
        return out
    }
}
