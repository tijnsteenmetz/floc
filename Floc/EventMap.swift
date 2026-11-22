import Foundation
import CoreLocation
import UIKit
import SQLite3

/// One map folder from `maps/` in the app bundle.
struct EventMap: Identifiable, Hashable {
    let id: String              // folder name
    let name: String
    let notes: String?
    let folder: URL
    /// Optional other map folder (`"base"` in map.json) to borrow missing files from, e.g. the big aerial photo.
    let baseFolder: URL?

    /// Each path as a list of coordinates (MultiLineStrings are flattened into separate lines).
    let paths: [[CLLocationCoordinate2D]]
    /// Each non-walkable area as rings (first = outer, rest = holes). Only used for routing, not drawn.
    let blocked: [[[CLLocationCoordinate2D]]]
    /// Open areas you can walk straight across (fields, beaches, in front of stages).
    let walkable: [[[CLLocationCoordinate2D]]]
    /// Stages, bars, toilets… everything placed in the dashboard.
    let facilities: [Facility]
    /// Path colour chosen in the dashboard (the Beloopbaar layer), used until you pick your own.
    let pathColor: String
    /// Where the aerial photo is (W, S, E, N); the camera stays inside it.
    let aerialBounds: [Double]?

    /// A file from this map's folder, or else from the base folder.
    static func file(_ name: String, in folder: URL, base: URL?) -> URL {
        let own = folder.appendingPathComponent(name)
        if FileManager.default.fileExists(atPath: own.path) { return own }
        if let base {
            let other = base.appendingPathComponent(name)
            if FileManager.default.fileExists(atPath: other.path) { return other }
        }
        return own
    }
    func file(_ name: String) -> URL { Self.file(name, in: folder, base: baseFolder) }
    private func has(_ name: String) -> Bool { FileManager.default.fileExists(atPath: file(name).path) }

    var pathsURL: URL { file("paths.geojson") }
    var walkableURL: URL { file("walkable.geojson") }
    var aerialURL: URL { file("aerial.mbtiles") }
    var hasWalkable: Bool { has("walkable.geojson") }
    var hasAerial: Bool { has("aerial.mbtiles") }

    /// South-west and north-east corners around all paths and facilities.
    var bounds: (sw: CLLocationCoordinate2D, ne: CLLocationCoordinate2D)? {
        let all = paths.flatMap { $0 } + facilities.map(\.coordinate)
        guard let first = all.first else { return nil }
        var minLat = first.latitude, maxLat = first.latitude
        var minLon = first.longitude, maxLon = first.longitude
        for c in all {
            minLat = min(minLat, c.latitude); maxLat = max(maxLat, c.latitude)
            minLon = min(minLon, c.longitude); maxLon = max(maxLon, c.longitude)
        }
        return (CLLocationCoordinate2D(latitude: minLat, longitude: minLon),
                CLLocationCoordinate2D(latitude: maxLat, longitude: maxLon))
    }

    /// Categories present on this map, in the dashboard's order.
    var categories: [FacilityCategory] {
        var seen = Set<String>()
        var out: [FacilityCategory] = []
        for f in facilities where !seen.contains(f.category.id) {
            seen.insert(f.category.id); out.append(f.category)
        }
        let order = FacilityCategory.builtinOrder
        return out.sorted { (order.firstIndex(of: $0.id) ?? 99, $0.name) < (order.firstIndex(of: $1.id) ?? 99, $1.name) }
    }

    func facility(id: String) -> Facility? { facilities.first { $0.id == id } }

    static func == (a: EventMap, b: EventMap) -> Bool { a.id == b.id }
    func hash(into h: inout Hasher) { h.combine(id) }
}

struct FacilityCategory: Hashable, Identifiable {
    let id: String
    let name: String
    let colorHex: String
    let label: String
    var color: UIColor { UIColor(hex: colorHex) }

    static let builtinOrder = ["podium", "bar", "eten", "wc", "ehbo", "munten", "water", "kluis", "ingang", "nooduitgang", "calamiteit"]

    /// Same defaults as the dashboard's DEFAULT_CATEGORIES, for old exports without colours.
    static let defaults: [String: FacilityCategory] = [
        "podium": .init(id: "podium", name: "Podium", colorHex: "#A78BFA", label: "♪"),
        "bar": .init(id: "bar", name: "Bar", colorHex: "#F5B84A", label: "BAR"),
        "eten": .init(id: "eten", name: "Eten", colorHex: "#F472B6", label: "ETEN"),
        "wc": .init(id: "wc", name: "WC", colorHex: "#F2F3F4", label: "WC"),
        "ehbo": .init(id: "ehbo", name: "EHBO", colorHex: "#FF6B6B", label: "+"),
        "munten": .init(id: "munten", name: "Munten", colorHex: "#D4F56A", label: "€"),
        "water": .init(id: "water", name: "Waterpunt", colorHex: "#6BC0FF", label: "H₂O"),
        "kluis": .init(id: "kluis", name: "Kluisjes", colorHex: "#94A3B8", label: "KL"),
        "ingang": .init(id: "ingang", name: "Ingang", colorHex: "#2DD4BF", label: "IN"),
        "nooduitgang": .init(id: "nooduitgang", name: "Nooduitgang", colorHex: "#FF8A4C", label: "NU"),
        "calamiteit": .init(id: "calamiteit", name: "Calamiteitendoorgang", colorHex: "#F43F5E", label: "CAL"),
    ]
}

struct TimetableEntry: Hashable {
    let day: String
    let start: String
    let end: String
    let act: String
}

/// A stage, bar, toilet… as exported by the dashboard.
struct Facility: Identifiable, Hashable {
    let id: String
    /// Name from the dashboard; may be empty (many emergency exits have none).
    let rawName: String
    let category: FacilityCategory
    let info: String
    let coordinate: CLLocationCoordinate2D
    /// Where routes end (the nearest one is used). Never empty: falls back to the centre.
    let navTargets: [CLLocationCoordinate2D]
    /// Traced footprint, if any.
    let outline: [CLLocationCoordinate2D]?
    let photo: URL?
    let timetable: [TimetableEntry]
    /// "Nooduitgang 3" for nameless ones.
    var name: String

    static func == (a: Facility, b: Facility) -> Bool { a.id == b.id }
    func hash(into h: inout Hasher) { h.combine(id) }

    /// Timetable grouped by day, in the order the days first appear.
    var timetableByDay: [(day: String, entries: [TimetableEntry])] {
        var order: [String] = []
        var groups: [String: [TimetableEntry]] = [:]
        for e in timetable {
            if groups[e.day] == nil { order.append(e.day) }
            groups[e.day, default: []].append(e)
        }
        return order.map { ($0, groups[$0]!.sorted { $0.start < $1.start }) }
    }
}

enum MapLoader {
    /// All map folders bundled under `maps/`, sorted by name.
    static func loadAll() -> [EventMap] {
        guard let root = Bundle.main.resourceURL?.appendingPathComponent("maps"),
              let dirs = try? FileManager.default.contentsOfDirectory(
                at: root, includingPropertiesForKeys: [.isDirectoryKey]) else { return [] }
        return dirs
            .filter { (try? $0.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true }
            .compactMap(load)
            .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }

    static func load(folder: URL) -> EventMap? {
        let id = folder.lastPathComponent
        var name = id
        var notes: String?
        var base: URL?
        var pathColor = Theme.limeHex
        var aerialBounds: [Double]?
        if let data = try? Data(contentsOf: folder.appendingPathComponent("map.json")),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            name = obj["name"] as? String ?? id
            notes = (obj["notes"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            if let b = obj["base"] as? String { base = folder.deletingLastPathComponent().appendingPathComponent(b) }
            if let styles = obj["styles"] as? [String: [String: Any]],
               let walk = styles.values.first(where: { $0["kind"] as? String == "beloopbaar" }),
               let c = walk["color"] as? String { pathColor = c }
            if let b = obj["aerial_bounds"] as? [Double], b.count == 4 { aerialBounds = b }
        }
        func url(_ n: String) -> URL { EventMap.file(n, in: folder, base: base) }
        let paths = GeoJSON.lines(at: url("paths.geojson"))
        let blocked = GeoJSON.polygons(at: url("blocked.geojson"))
        let walkable = GeoJSON.polygons(at: url("walkable.geojson"))
        guard !paths.isEmpty else { return nil }
        if aerialBounds == nil { aerialBounds = MBTiles.bounds(url("aerial.mbtiles")) }
        return EventMap(id: id, name: name, notes: notes, folder: folder, baseFolder: base,
                        paths: paths, blocked: blocked, walkable: walkable,
                        facilities: loadFacilities(folder: folder, base: base),
                        pathColor: pathColor, aerialBounds: aerialBounds)
    }

    /// `facilities.geojson` from the dashboard, or else the older stages/bars/munten point files.
    static func loadFacilities(folder: URL, base: URL?) -> [Facility] {
        let file = EventMap.file("facilities.geojson", in: folder, base: base)
        var out: [Facility] = []
        if let data = try? Data(contentsOf: file),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let features = obj["features"] as? [[String: Any]] {
            for (i, f) in features.enumerated() {
                guard let g = f["geometry"] as? [String: Any] else { continue }
                let p = f["properties"] as? [String: Any] ?? [:]
                var centre: CLLocationCoordinate2D?
                var outline: [CLLocationCoordinate2D]?
                if g["type"] as? String == "Point" {
                    centre = GeoJSON.coord(g["coordinates"] as Any)
                } else if g["type"] as? String == "Polygon", let rings = g["coordinates"] as? [Any], let r = rings.first {
                    outline = GeoJSON.ring(r)
                    centre = GeoJSON.coord(p["centre"] as Any) ?? outline.map(GeoJSON.average)
                }
                guard let centre else { continue }
                let catID = p["category"] as? String ?? "overig"
                let fallback = FacilityCategory.defaults[catID]
                let category = FacilityCategory(
                    id: catID,
                    name: p["category_name"] as? String ?? fallback?.name ?? catID.capitalized,
                    colorHex: p["category_color"] as? String ?? fallback?.colorHex ?? "#F5B84A",
                    label: p["category_label"] as? String ?? fallback?.label ?? String(catID.prefix(2)).uppercased())
                let nav = ((p["nav"] as? [Any]) ?? []).compactMap(GeoJSON.coord)
                let timetable = ((p["timetable"] as? [[String: Any]]) ?? []).map {
                    TimetableEntry(day: $0["day"] as? String ?? "", start: $0["start"] as? String ?? "",
                                   end: $0["end"] as? String ?? "", act: $0["act"] as? String ?? "")
                }
                let photo = (p["photo"] as? String).map { EventMap.file($0, in: folder, base: base) }
                    .flatMap { FileManager.default.fileExists(atPath: $0.path) ? $0 : nil }
                let raw = (p["name"] as? String ?? "").trimmingCharacters(in: .whitespaces)
                out.append(Facility(id: p["id"] as? String ?? "f\(i)", rawName: raw, category: category,
                                    info: (p["info"] as? String ?? p["notes"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines),
                                    coordinate: centre, navTargets: nav.isEmpty ? [centre] : nav,
                                    outline: outline, photo: photo, timetable: timetable, name: raw))
            }
        } else {
            for (cat, fileName) in [("podium", "stages.geojson"), ("bar", "bars.geojson"), ("munten", "munten.geojson")] {
                for (i, pt) in GeoJSON.points(at: EventMap.file(fileName, in: folder, base: base)).enumerated() {
                    out.append(Facility(id: "\(cat)-\(i)", rawName: pt.name ?? "", category: FacilityCategory.defaults[cat]!,
                                        info: "", coordinate: pt.coord, navTargets: [pt.coord], outline: nil,
                                        photo: nil, timetable: [], name: pt.name ?? ""))
                }
            }
        }
        // Nameless ones get "Nooduitgang 1, 2, …" in north-to-south order.
        var counters: [String: Int] = [:]
        let order = out.indices.sorted { out[$0].coordinate.latitude > out[$1].coordinate.latitude }
        for i in order where out[i].rawName.isEmpty {
            counters[out[i].category.id, default: 0] += 1
            out[i].name = "\(out[i].category.name) \(counters[out[i].category.id]!)"
        }
        return out
    }
}

/// Reads the `bounds` row of an MBTiles file (W,S,E,N), for maps exported before map.json carried it.
enum MBTiles {
    static func bounds(_ url: URL) -> [Double]? {
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        var db: OpaquePointer?
        guard sqlite3_open_v2(url.path, &db, SQLITE_OPEN_READONLY, nil) == SQLITE_OK else { return nil }
        defer { sqlite3_close(db) }
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, "SELECT value FROM metadata WHERE name = 'bounds'", -1, &stmt, nil) == SQLITE_OK else { return nil }
        defer { sqlite3_finalize(stmt) }
        guard sqlite3_step(stmt) == SQLITE_ROW, let c = sqlite3_column_text(stmt, 0) else { return nil }
        let b = String(cString: c).split(separator: ",").compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
        return b.count == 4 ? b : nil
    }
}

/// Minimal GeoJSON reader: only what the prototype needs.
enum GeoJSON {
    static func geometries(at url: URL) -> [[String: Any]] {
        guard let data = try? Data(contentsOf: url),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [] }
        if let features = obj["features"] as? [[String: Any]] {
            return features.compactMap { $0["geometry"] as? [String: Any] }
        }
        return [obj]
    }

    /// Features with Point geometry, with their `name` property.
    static func points(at url: URL) -> [(coord: CLLocationCoordinate2D, name: String?)] {
        guard let data = try? Data(contentsOf: url),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let features = obj["features"] as? [[String: Any]] else { return [] }
        return features.compactMap { f in
            guard let g = f["geometry"] as? [String: Any], g["type"] as? String == "Point",
                  let c = coord(g["coordinates"] as Any) else { return nil }
            let name = (f["properties"] as? [String: Any])?["name"] as? String
            return (c, name)
        }
    }

    static func coord(_ v: Any) -> CLLocationCoordinate2D? {
        guard let a = v as? [Any], a.count >= 2,
              let lon = (a[0] as? NSNumber)?.doubleValue, let lat = (a[1] as? NSNumber)?.doubleValue else { return nil }
        return CLLocationCoordinate2D(latitude: lat, longitude: lon)
    }

    static func ring(_ v: Any) -> [CLLocationCoordinate2D] {
        (v as? [Any])?.compactMap(coord) ?? []
    }

    static func average(_ pts: [CLLocationCoordinate2D]) -> CLLocationCoordinate2D {
        let n = Double(max(1, pts.count))
        return CLLocationCoordinate2D(latitude: pts.map(\.latitude).reduce(0, +) / n,
                                      longitude: pts.map(\.longitude).reduce(0, +) / n)
    }

    static func lines(at url: URL) -> [[CLLocationCoordinate2D]] {
        geometries(at: url).flatMap { g -> [[CLLocationCoordinate2D]] in
            switch g["type"] as? String {
            case "LineString": return [ring(g["coordinates"] as Any)]
            case "MultiLineString": return ((g["coordinates"] as? [Any]) ?? []).map(ring)
            default: return []
            }
        }.filter { $0.count >= 2 }
    }

    static func polygons(at url: URL) -> [[[CLLocationCoordinate2D]]] {
        geometries(at: url).flatMap { g -> [[[CLLocationCoordinate2D]]] in
            switch g["type"] as? String {
            case "Polygon": return [((g["coordinates"] as? [Any]) ?? []).map(ring)]
            case "MultiPolygon": return ((g["coordinates"] as? [Any]) ?? []).map { (($0 as? [Any]) ?? []).map(ring) }
            default: return []
            }
        }.filter { !($0.first?.isEmpty ?? true) }
    }
}
