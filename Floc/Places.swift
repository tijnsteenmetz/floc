import Foundation
import CoreLocation
import UIKit

/// What a saved place is. Your own sleeping spot is special: there's only one, and it has its own button.
enum PlaceKind: String, Codable, CaseIterable, Identifiable {
    case sleep, tent, meet, favorite
    var id: String { rawValue }

    var label: String {
        switch self {
        case .sleep: "Mijn slaapplek"
        case .tent: "Tent van iemand"
        case .meet: "Ontmoetingsplek"
        case .favorite: "Favoriete plek"
        }
    }
    var symbol: String {
        switch self {
        case .sleep: "tent.fill"
        case .tent: "tent"
        case .meet: "person.2.fill"
        case .favorite: "star.fill"
        }
    }
    var color: UIColor {
        switch self {
        case .sleep: UIColor(hex: Theme.limeHex)
        case .tent: UIColor(hex: "#5EEAD4")
        case .meet: UIColor(hex: "#F472B6")
        case .favorite: UIColor(hex: "#FACC15")
        }
    }
    /// Suggested name when saving.
    var defaultName: String {
        switch self {
        case .sleep: "Mijn slaapplek"
        case .tent: "Tent van "
        case .meet: "Ontmoetingsplek"
        case .favorite: "Favoriete plek"
        }
    }
    /// Kinds you can pick when saving a place (the sleeping spot has its own flow).
    static let saveable: [PlaceKind] = [.tent, .meet, .favorite]
}

struct SavedPlace: Codable, Identifiable, Hashable {
    var id = UUID().uuidString
    var name: String
    var kind: PlaceKind
    var lat: Double
    var lon: Double
    var note: String = ""
    var created = Date()

    var coordinate: CLLocationCoordinate2D {
        get { .init(latitude: lat, longitude: lon) }
        set { lat = newValue.latitude; lon = newValue.longitude }
    }
}

/// Saved places and favourite facilities for one map, kept on this phone (UserDefaults).
final class PlacesStore: ObservableObject {
    @Published private(set) var places: [SavedPlace] = []
    @Published private(set) var favoriteFacilities: [String] = []   // facility ids, most recent first

    private let key: String
    private let favKey: String

    init(mapID: String) {
        key = "places.\(mapID)"
        favKey = "favorites.\(mapID)"
        if let data = UserDefaults.standard.data(forKey: key),
           let list = try? JSONDecoder().decode([SavedPlace].self, from: data) { places = list }
        favoriteFacilities = UserDefaults.standard.stringArray(forKey: favKey) ?? []
    }

    var sleep: SavedPlace? { places.first { $0.kind == .sleep } }
    /// Everything except the sleeping spot, newest first.
    var others: [SavedPlace] { places.filter { $0.kind != .sleep }.sorted { $0.created > $1.created } }

    func place(id: String) -> SavedPlace? { places.first { $0.id == id } }

    /// Sets (or moves) your sleeping spot.
    @discardableResult
    func setSleep(at c: CLLocationCoordinate2D) -> SavedPlace {
        if let i = places.firstIndex(where: { $0.kind == .sleep }) {
            places[i].coordinate = c
            save()
            return places[i]
        }
        let p = SavedPlace(name: PlaceKind.sleep.defaultName, kind: .sleep, lat: c.latitude, lon: c.longitude)
        places.append(p)
        save()
        return p
    }

    @discardableResult
    func add(name: String, kind: PlaceKind, at c: CLLocationCoordinate2D) -> SavedPlace {
        if kind == .sleep { return setSleep(at: c) }
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        let p = SavedPlace(name: trimmed.isEmpty ? kind.label : trimmed, kind: kind, lat: c.latitude, lon: c.longitude)
        places.append(p)
        save()
        return p
    }

    func update(_ p: SavedPlace) {
        guard let i = places.firstIndex(where: { $0.id == p.id }) else { return }
        places[i] = p
        save()
    }

    func remove(_ id: String) {
        places.removeAll { $0.id == id }
        save()
    }

    func isFavorite(_ f: Facility) -> Bool { favoriteFacilities.contains(f.id) }

    func toggleFavorite(_ f: Facility) {
        if let i = favoriteFacilities.firstIndex(of: f.id) { favoriteFacilities.remove(at: i) }
        else { favoriteFacilities.insert(f.id, at: 0) }
        UserDefaults.standard.set(favoriteFacilities, forKey: favKey)
    }

    private func save() {
        if let data = try? JSONEncoder().encode(places) { UserDefaults.standard.set(data, forKey: key) }
    }
}
