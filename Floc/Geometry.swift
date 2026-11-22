import Foundation
import CoreLocation

/// Flat x/y in metres around a reference point. Accurate enough for an event site (~1–2 km).
struct LocalProjection {
    let origin: CLLocationCoordinate2D
    private let mPerDegLat = 110_540.0
    private let mPerDegLon: Double

    init(origin: CLLocationCoordinate2D) {
        self.origin = origin
        mPerDegLon = 111_320.0 * cos(origin.latitude * .pi / 180)
    }

    func toXY(_ c: CLLocationCoordinate2D) -> SIMD2<Double> {
        SIMD2((c.longitude - origin.longitude) * mPerDegLon, (c.latitude - origin.latitude) * mPerDegLat)
    }

    func toCoord(_ p: SIMD2<Double>) -> CLLocationCoordinate2D {
        CLLocationCoordinate2D(latitude: origin.latitude + p.y / mPerDegLat,
                               longitude: origin.longitude + p.x / mPerDegLon)
    }
}

/// Nearest point on segment a–b to p.
func closestPoint(on a: SIMD2<Double>, _ b: SIMD2<Double>, to p: SIMD2<Double>) -> SIMD2<Double> {
    let ab = b - a
    let len2 = (ab * ab).sum()
    guard len2 > 0 else { return a }
    let t = max(0, min(1, ((p - a) * ab).sum() / len2))
    return a + t * ab
}

func distance(_ a: SIMD2<Double>, _ b: SIMD2<Double>) -> Double {
    let d = a - b
    return (d * d).sum().squareRoot()
}

/// Turns a raw location into the location the app believes you're at.
///
/// v0 rules (SPEC.md):
/// 1. Within `snapDistance` of a path → nearest point on that path.
/// 2. Otherwise the raw location…
/// 3. …unless that's inside a blocked area → nearest point just outside it.
/// Inside a walkable open area the dot is simply the raw location (no snapping).
struct LocationInterpreter {
    let projection: LocationProjectionData
    var snapDistance: Double = 5

    struct LocationProjectionData {
        let proj: LocalProjection
        let segments: [(SIMD2<Double>, SIMD2<Double>)]
        /// Each blocked area: rings in metres (first = outer, rest = holes).
        let blocked: [[[SIMD2<Double>]]]
        /// Each walkable open area: rings in metres.
        let walkable: [[[SIMD2<Double>]]]
    }

    init(map: EventMap) {
        var origin = CLLocationCoordinate2D(latitude: 0, longitude: 0)
        if let b = map.bounds {
            let lat: Double = (b.sw.latitude + b.ne.latitude) / 2
            let lon: Double = (b.sw.longitude + b.ne.longitude) / 2
            origin = CLLocationCoordinate2D(latitude: lat, longitude: lon)
        }
        let proj = LocalProjection(origin: origin)
        var segs: [(SIMD2<Double>, SIMD2<Double>)] = []
        for line in map.paths {
            let pts = line.map(proj.toXY)
            for i in 0..<(pts.count - 1) { segs.append((pts[i], pts[i + 1])) }
        }
        let blocked = map.blocked.map { $0.map { $0.map(proj.toXY) } }
        let walkable = map.walkable.map { $0.map { $0.map(proj.toXY) } }
        projection = LocationProjectionData(proj: proj, segments: segs, blocked: blocked, walkable: walkable)
    }

    func interpret(_ raw: CLLocationCoordinate2D) -> CLLocationCoordinate2D {
        let p = projection.proj.toXY(raw)

        // 0. In an open area you can be anywhere: trust the raw location.
        if isInsideBlocked(p, projection.walkable), !isInsideBlocked(p, projection.blocked) {
            return raw
        }

        // 1. Snap to the nearest path, if close enough and not inside a blocked area (e.g. a closed road).
        var best: SIMD2<Double>?
        var bestDist = Double.infinity
        for (a, b) in projection.segments {
            let c = closestPoint(on: a, b, to: p)
            let d = distance(c, p)
            if d < bestDist { bestDist = d; best = c }
        }
        if let snapped = best, bestDist <= snapDistance, blockedArea(containing: snapped) == nil {
            return projection.proj.toCoord(snapped)
        }

        // 2./3. Raw location, pushed out of blocked areas.
        if let area = blockedArea(containing: p) {
            return projection.proj.toCoord(pushOut(p, of: area))
        }
        return raw
    }

    private func blockedArea(containing p: SIMD2<Double>) -> [[SIMD2<Double>]]? {
        projection.blocked.first { rings in
            guard let outer = rings.first, contains(outer, p) else { return false }
            return !rings.dropFirst().contains { contains($0, p) }
        }
    }

    /// Nearest point on the area's edge, nudged 0.5 m outward.
    private func pushOut(_ p: SIMD2<Double>, of rings: [[SIMD2<Double>]]) -> SIMD2<Double> {
        var best = p
        var bestDist = Double.infinity
        for ring in rings where ring.count >= 2 {
            for i in 0..<(ring.count - 1) {
                let c = closestPoint(on: ring[i], ring[i + 1], to: p)
                let d = distance(c, p)
                if d < bestDist { bestDist = d; best = c }
            }
        }
        guard bestDist > 0 else { return best }
        return best + (best - p) / bestDist * 0.5
    }
}

/// True when `p` is inside any blocked area (inside the outer ring and not in a hole).
func isInsideBlocked(_ p: SIMD2<Double>, _ blocked: [[[SIMD2<Double>]]]) -> Bool {
    blocked.contains { rings in
        guard let outer = rings.first, contains(outer, p) else { return false }
        return !rings.dropFirst().contains { contains($0, p) }
    }
}

/// Ray-casting point-in-polygon.
func contains(_ ring: [SIMD2<Double>], _ p: SIMD2<Double>) -> Bool {
    var inside = false
    var j = ring.count - 1
    for i in 0..<ring.count {
        let a = ring[i], b = ring[j]
        if (a.y > p.y) != (b.y > p.y),
           p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x {
            inside.toggle()
        }
        j = i
    }
    return inside
}
