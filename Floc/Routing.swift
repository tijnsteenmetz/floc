import Foundation
import CoreLocation
import Combine

/// Walkable network built from `paths.geojson`, plus straight lines across walkable open areas.
///
/// Paths connect only where they actually touch (SPEC.md): a shared vertex, or a line's end lying
/// on another line (within 1 cm). Lines that cross without a shared vertex stay unconnected.
/// Pieces of path inside a blocked area are left out.
///
/// Open areas (`walkable.geojson`) use a visibility graph: the area's corners (nudged 0.75 m inwards)
/// and every path point inside or on the edge of the area are linked to each other wherever there's
/// a clear straight line (staying inside the area and out of blocked areas). Paths that cross an
/// area's edge are split there, so they join the area. The same Dijkstra then runs over everything.
struct RoutingGraph {
    let proj: LocalProjection
    private(set) var nodes: [SIMD2<Double>] = []
    private(set) var adjacency: [[(to: Int, weight: Double)]] = []
    /// Path edges only (used for snapping onto the network); open-area links live in `adjacency` only.
    private(set) var edges: [(a: Int, b: Int)] = []
    private let blocked: [[[SIMD2<Double>]]]
    private let areas: [[[SIMD2<Double>]]]
    /// Per open area: the nodes a free point inside it may link to.
    private var areaNodes: [[Int]] = []

    /// Where a route starts or ends.
    enum Anchor {
        case edge(Int, SIMD2<Double>)    // on a path edge
        case area(Int, SIMD2<Double>)    // anywhere inside an open area
        var point: SIMD2<Double> {
            switch self { case .edge(_, let p), .area(_, let p): p }
        }
    }

    init(map: EventMap, proj: LocalProjection) {
        self.proj = proj
        let lines = map.paths.map { $0.map(proj.toXY) }
        blocked = map.blocked.map { $0.map { $0.map(proj.toXY) } }
        areas = map.walkable.map { $0.map { $0.map(proj.toXY) } }
        let tolerance = 0.01

        // 1. Split points: line ends on the middle of another segment (T-junctions),
        //    and places where a path crosses the edge of an open area.
        var splits: [Int: [(t: Double, p: SIMD2<Double>)]] = [:]   // segment id → split points
        func segID(_ line: Int, _ seg: Int) -> Int { line * 1_000_000 + seg }
        for line in lines {
            for end in [line.first!, line.last!] {
                for (li, other) in lines.enumerated() {
                    for si in 0..<(other.count - 1) {
                        let a = other[si], b = other[si + 1]
                        if distance(a, end) < tolerance || distance(b, end) < tolerance { continue }
                        let c = closestPoint(on: a, b, to: end)
                        guard distance(c, end) < tolerance else { continue }
                        let ab = b - a
                        let t = ((end - a) * ab).sum() / (ab * ab).sum()
                        splits[segID(li, si), default: []].append((t, end))
                    }
                }
            }
        }
        // An area corner lying on the middle of a path (snapped onto it in the editor) splits the path,
        // so the area and the path join there.
        let corners = areas.flatMap { $0.flatMap { $0 } }
        if !corners.isEmpty {
            for (li, line) in lines.enumerated() {
                for si in 0..<(line.count - 1) {
                    let a = line[si], b = line[si + 1]
                    let lo = SIMD2(min(a.x, b.x) - tolerance, min(a.y, b.y) - tolerance)
                    let hi = SIMD2(max(a.x, b.x) + tolerance, max(a.y, b.y) + tolerance)
                    for v in corners where v.x >= lo.x && v.x <= hi.x && v.y >= lo.y && v.y <= hi.y {
                        if distance(a, v) < tolerance || distance(b, v) < tolerance { continue }
                        guard distance(closestPoint(on: a, b, to: v), v) < tolerance else { continue }
                        let ab = b - a
                        splits[segID(li, si), default: []].append((((v - a) * ab).sum() / (ab * ab).sum(), v))
                    }
                }
            }
        }
        for (li, line) in lines.enumerated() {
            for si in 0..<(line.count - 1) {
                for rings in areas {
                    for ring in rings where ring.count >= 2 {
                        for k in 0..<(ring.count - 1) {
                            if let t = Self.crossing(line[si], line[si + 1], ring[k], ring[k + 1]) {
                                splits[segID(li, si), default: []].append((t, line[si] + (line[si + 1] - line[si]) * t))
                            }
                        }
                    }
                }
            }
        }

        // 2. Build nodes (merged on a 1 cm grid) and path edges.
        var index: [SIMD2<Int64>: Int] = [:]
        func node(_ p: SIMD2<Double>) -> Int {
            let key = SIMD2(Int64((p.x * 100).rounded()), Int64((p.y * 100).rounded()))
            if let i = index[key] { return i }
            nodes.append(p); adjacency.append([])
            index[key] = nodes.count - 1
            return nodes.count - 1
        }
        func link(_ ia: Int, _ ib: Int) {
            let len = distance(nodes[ia], nodes[ib])
            adjacency[ia].append((ib, len))
            adjacency[ib].append((ia, len))
        }
        for (li, line) in lines.enumerated() {
            for si in 0..<(line.count - 1) {
                var pts = [line[si]]
                pts += (splits[segID(li, si)] ?? []).sorted { $0.t < $1.t }.map(\.p)
                pts.append(line[si + 1])
                for k in 0..<(pts.count - 1) {
                    let a = pts[k], b = pts[k + 1]
                    guard distance(a, b) > 0, !Self.crossesBlocked(a, b, blocked) else { continue }
                    let ia = node(a), ib = node(b)
                    guard ia != ib else { continue }
                    link(ia, ib)
                    edges.append((ia, ib))
                }
            }
        }

        // 3. Open areas: link every pair of mutually visible points.
        let pathNodeCount = nodes.count
        for (ai, rings) in areas.enumerated() {
            var members = Set<Int>()
            for ring in rings {
                let pts = ring.count > 1 && ring.first == ring.last ? Array(ring.dropLast()) : ring
                guard pts.count >= 3 else { continue }
                for i in 0..<pts.count {
                    let v = pts[i], prev = pts[(i + pts.count - 1) % pts.count], next = pts[(i + 1) % pts.count]
                    if let p = inset(v, prev, next, area: ai) { members.insert(node(p)) }
                }
            }
            for n in 0..<pathNodeCount where inArea(nodes[n], ai) || onEdge(nodes[n], of: ai) {
                members.insert(n)
            }
            let list = members.sorted()
            for i in 0..<list.count {
                for j in (i + 1)..<max(i + 1, list.count) where visible(nodes[list[i]], nodes[list[j]], in: ai) {
                    link(list[i], list[j])
                }
            }
            areaNodes.append(list)
        }
    }

    // MARK: Geometry helpers

    /// Parameter t along a–b where it properly crosses c–d (not just touching), or nil.
    private static func crossing(_ a: SIMD2<Double>, _ b: SIMD2<Double>, _ c: SIMD2<Double>, _ d: SIMD2<Double>) -> Double? {
        let r = b - a, s = d - c
        let den = r.x * s.y - r.y * s.x
        guard abs(den) > 1e-12 else { return nil }
        let q = c - a
        let t = (q.x * s.y - q.y * s.x) / den
        let u = (q.x * r.y - q.y * r.x) / den
        let eps = 1e-9
        return (t > eps && t < 1 - eps && u > eps && u < 1 - eps) ? t : nil
    }

    private static func crossesBlocked(_ a: SIMD2<Double>, _ b: SIMD2<Double>, _ blocked: [[[SIMD2<Double>]]]) -> Bool {
        guard !blocked.isEmpty else { return false }
        let steps = max(1, Int(distance(a, b)))   // sample every ~1 m
        for i in 0...steps {
            let p = a + (b - a) * (Double(i) / Double(steps))
            if isInsideBlocked(p, blocked) { return true }
        }
        return false
    }

    private func inArea(_ p: SIMD2<Double>, _ ai: Int) -> Bool {
        let rings = areas[ai]
        guard let outer = rings.first, contains(outer, p) else { return false }
        return !rings.dropFirst().contains { contains($0, p) }
    }

    private func onEdge(_ p: SIMD2<Double>, of ai: Int) -> Bool {
        for ring in areas[ai] where ring.count >= 2 {
            for k in 0..<(ring.count - 1) where distance(closestPoint(on: ring[k], ring[k + 1], to: p), p) < 0.02 {
                return true
            }
        }
        return false
    }

    /// The corner v moved 0.75 m into the area (so lines between corners don't run along the edge).
    private func inset(_ v: SIMD2<Double>, _ prev: SIMD2<Double>, _ next: SIMD2<Double>, area ai: Int) -> SIMD2<Double>? {
        func unit(_ d: SIMD2<Double>) -> SIMD2<Double> { let l = (d * d).sum().squareRoot(); return l > 0 ? d / l : d }
        let d1 = unit(v - prev), d2 = unit(next - v)
        var dir = unit(SIMD2(-d1.y, d1.x) + SIMD2(-d2.y, d2.x))
        if (dir * dir).sum() == 0 { dir = SIMD2(-d1.y, d1.x) }
        for candidate in [v + dir * 0.75, v - dir * 0.75]
        where inArea(candidate, ai) && !isInsideBlocked(candidate, blocked) {
            return candidate
        }
        return nil
    }

    /// A straight walk from a to b stays inside area `ai` and out of blocked areas.
    private func visible(_ a: SIMD2<Double>, _ b: SIMD2<Double>, in ai: Int) -> Bool {
        for rings in [areas[ai]] + blocked {
            for ring in rings where ring.count >= 2 {
                for k in 0..<(ring.count - 1) where Self.crossing(a, b, ring[k], ring[k + 1]) != nil {
                    return false
                }
            }
        }
        // Catch lines that leave through a corner or run outside along the edge.
        let steps = max(2, Int(distance(a, b) / 3))
        for i in 1..<steps {
            let p = a + (b - a) * (Double(i) / Double(steps))
            if !inArea(p, ai) || isInsideBlocked(p, blocked) { return false }
        }
        return true
    }

    // MARK: Queries

    /// Nearest point on the path network.
    func nearest(to p: SIMD2<Double>) -> (edge: Int, point: SIMD2<Double>)? {
        var best: (Int, SIMD2<Double>)?
        var bestDist = Double.infinity
        for (i, e) in edges.enumerated() {
            let c = closestPoint(on: nodes[e.a], nodes[e.b], to: p)
            let d = distance(c, p)
            if d < bestDist { bestDist = d; best = (i, c) }
        }
        return best
    }

    /// Inside an open area: start right there. Otherwise: the nearest point on a path.
    func anchor(for p: SIMD2<Double>) -> Anchor? {
        if !isInsideBlocked(p, blocked), let ai = areas.indices.first(where: { inArea(p, $0) }) {
            return .area(ai, p)
        }
        return nearest(to: p).map { .edge($0.edge, $0.point) }
    }

    /// Network nodes reachable straight from the anchor, with the distance.
    private func links(_ a: Anchor) -> [(node: Int, cost: Double)] {
        switch a {
        case .edge(let e, let p):
            return [edges[e].a, edges[e].b].map { ($0, distance(p, nodes[$0])) }
        case .area(let ai, let p):
            return areaNodes[ai].filter { visible(p, nodes[$0], in: ai) }.map { ($0, distance(p, nodes[$0])) }
        }
    }

    /// Everything reachable from one start point: one Dijkstra, reused for many destinations.
    struct Reach {
        let start: Anchor
        let dist: [Double]
        let prev: [Int]
    }

    func reach(from s: Anchor) -> Reach {
        var dist = [Double](repeating: .infinity, count: nodes.count)
        var prev = [Int](repeating: -1, count: nodes.count)
        var heap = MinHeap()
        for (n, d) in links(s) where d < dist[n] {
            dist[n] = d; heap.push(n, d)
        }
        while let (u, du) = heap.pop() {
            guard du <= dist[u] else { continue }
            for (v, w) in adjacency[u] where du + w < dist[v] {
                dist[v] = du + w; prev[v] = u; heap.push(v, du + w)
            }
        }
        return Reach(start: s, dist: dist, prev: prev)
    }

    /// Walking distance to `t` and the network node the route enters it from (-1 = straight line).
    private func best(_ r: Reach, to t: Anchor) -> (total: Double, end: Int)? {
        var bestEnd = -1
        var bestTotal = Double.infinity
        for (n, d) in links(t) where r.dist[n] + d < bestTotal {
            bestTotal = r.dist[n] + d; bestEnd = n
        }
        // Straight from s to t, when that's possible (same path edge, or same open area with a clear line).
        let s = r.start
        let direct = distance(s.point, t.point)
        var directOK = false
        switch (s, t) {
        case (.edge(let a, _), .edge(let b, _)):
            let ea = edges[a], eb = edges[b]
            directOK = a == b || (ea.a == eb.b && ea.b == eb.a)
        case (.area(let a, let p), .area(let b, let q)):
            directOK = a == b && visible(p, q, in: a)
        default: break
        }
        if directOK, direct <= bestTotal { return (direct, -1) }
        guard bestEnd >= 0, bestTotal.isFinite else { return nil }
        return (bestTotal, bestEnd)
    }

    /// Network distance from the reach's start to `t` (without the off-network bits at either end).
    func cost(_ r: Reach, to t: Anchor) -> Double? { best(r, to: t)?.total }

    /// The polyline from the reach's start to `t`, or nil when they aren't connected.
    func path(_ r: Reach, to t: Anchor) -> [SIMD2<Double>]? {
        guard let b = best(r, to: t) else { return nil }
        if b.end < 0 { return [r.start.point, t.point] }
        var chain: [SIMD2<Double>] = []
        var n = b.end
        while n != -1 { chain.append(nodes[n]); n = r.prev[n] }
        chain.reverse()
        return [r.start.point] + chain + [t.point]
    }

    /// Shortest path between two anchors. Returns the polyline from `s` to `t`, or nil when they aren't connected.
    func shortestPath(from s: Anchor, to t: Anchor) -> [SIMD2<Double>]? {
        path(reach(from: s), to: t)
    }
}

/// Small binary min-heap for Dijkstra.
struct MinHeap {
    private var items: [(node: Int, key: Double)] = []

    mutating func push(_ node: Int, _ key: Double) {
        items.append((node, key))
        var i = items.count - 1
        while i > 0 {
            let p = (i - 1) / 2
            guard items[i].key < items[p].key else { break }
            items.swapAt(i, p); i = p
        }
    }

    mutating func pop() -> (Int, Double)? {
        guard !items.isEmpty else { return nil }
        let top = items[0]
        let last = items.removeLast()
        if !items.isEmpty {
            items[0] = last
            var i = 0
            while true {
                let l = 2 * i + 1, r = l + 1
                var m = i
                if l < items.count, items[l].key < items[m].key { m = l }
                if r < items.count, items[r].key < items[m].key { m = r }
                if m == i { break }
                items.swapAt(i, m); i = m
            }
        }
        return (top.node, top.key)
    }
}

/// A route ready to draw.
struct Route {
    /// Over the network, in metres (local x/y).
    var path: [SIMD2<Double>]
    /// Start of the walk (the dot) and the chosen destination; off-network bits are drawn dashed.
    var from: SIMD2<Double>
    var to: SIMD2<Double>

    var length: Double {
        var total = distance(from, path.first!) + distance(path.last!, to)
        for i in 0..<(path.count - 1) { total += distance(path[i], path[i + 1]) }
        return total
    }
}

/// Where you're heading: a facility, a saved place, or a spot you pressed on the map.
struct Destination: Equatable {
    enum Ref: Equatable { case facility(String), place(String), pin }
    var ref: Ref
    var name: String
    /// Possible end points; the route goes to whichever is closest.
    var targets: [CLLocationCoordinate2D]

    static func == (a: Destination, b: Destination) -> Bool {
        a.ref == b.ref && a.name == b.name && a.targets.count == b.targets.count
            && zip(a.targets, b.targets).allSatisfy { $0.latitude == $1.latitude && $0.longitude == $1.longitude }
    }
}

/// Destination, current route, live rerouting, and walking distances for lists.
final class RouteModel: ObservableObject {
    @Published private(set) var destination: Destination?
    /// The end point actually used (the nearest of the destination's targets).
    @Published private(set) var target: CLLocationCoordinate2D?
    @Published private(set) var route: Route?
    @Published private(set) var noRoute = false
    /// Bumped whenever walking distances change (you moved a few metres).
    @Published private(set) var distanceVersion = 0

    let proj: LocalProjection
    private let graph: RoutingGraph
    private var lastFrom: SIMD2<Double>?
    private var cancellable: AnyCancellable?
    private weak var location: LocationModel?

    /// Dijkstra from the dot, reused for every distance in lists.
    private var reach: RoutingGraph.Reach?
    private var reachFrom: SIMD2<Double>?
    private var anchorCache: [SIMD2<Int64>: RoutingGraph.Anchor] = [:]

    /// Switch to a different route only when it's at least this much shorter (avoids flip-flopping).
    static let switchMargin = 10.0
    static let arrivalDistance = 5.0

    init(map: EventMap, location: LocationModel) {
        proj = location.projection
        graph = RoutingGraph(map: map, proj: proj)
        self.location = location
        cancellable = location.$dot.sink { [weak self] dot in self?.update(from: dot) }
    }

    var arrived: Bool { (route?.length ?? .infinity) < Self.arrivalDistance }
    var destinationName: String? { destination?.name }

    func setDestination(_ d: Destination) {
        destination = d
        target = nil
        route = nil
        lastFrom = nil
        noRoute = false
        update(from: location?.dot)
        if location?.dot == nil { target = d.targets.first }
    }

    func clear() {
        destination = nil; target = nil; route = nil; noRoute = false; lastFrom = nil
    }

    func coord(_ p: SIMD2<Double>) -> CLLocationCoordinate2D { proj.toCoord(p) }

    private func anchor(_ c: CLLocationCoordinate2D) -> RoutingGraph.Anchor? {
        let p = proj.toXY(c)
        let key = SIMD2(Int64((p.x * 10).rounded()), Int64((p.y * 10).rounded()))
        if let a = anchorCache[key] { return a }
        let a = graph.anchor(for: p)
        if let a { anchorCache[key] = a }
        return a
    }

    /// Walking distance (metres) from where you are to the nearest of `targets`; nil without a location or route.
    func walkingDistance(to targets: [CLLocationCoordinate2D]) -> Double? {
        guard let r = reach, let from = reachFrom else { return nil }
        var best: Double?
        for t in targets {
            guard let a = anchor(t), let c = graph.cost(r, to: a) else { continue }
            let total = c + distance(from, r.start.point) + distance(a.point, proj.toXY(t))
            if best == nil || total < best! { best = total }
        }
        return best
    }

    private func update(from dot: CLLocationCoordinate2D?) {
        guard let dot else { route = nil; reach = nil; reachFrom = nil; distanceVersion += 1; return }
        let p = proj.toXY(dot)
        // Distances for lists: refresh every few metres.
        if reachFrom == nil || distance(reachFrom!, p) > 3 {
            if let s = graph.anchor(for: p) { reach = graph.reach(from: s); reachFrom = p } else { reach = nil; reachFrom = nil }
            distanceVersion += 1
        }
        guard let dest = destination else { route = nil; return }
        // Recalculating every frame is wasteful; every half metre is plenty.
        if let last = lastFrom, distance(last, p) < 0.5, route != nil { return }
        lastFrom = p

        guard let s = graph.anchor(for: p) else { route = nil; noRoute = true; return }
        let r = graph.reach(from: s)
        var bestRoute: Route?
        var bestTarget: CLLocationCoordinate2D?
        for t in dest.targets {
            guard let a = anchor(t), let path = graph.path(r, to: a) else { continue }
            let candidate = Route(path: path, from: p, to: proj.toXY(t))
            if bestRoute == nil || candidate.length < bestRoute!.length { bestRoute = candidate; bestTarget = t }
        }
        guard let fresh = bestRoute else { route = nil; noRoute = true; return }
        noRoute = false

        // Keep following the current route unless the new one is clearly shorter.
        if let current = route, let kept = Self.trim(current, to: p),
           kept.length <= fresh.length + Self.switchMargin {
            route = kept
        } else {
            route = fresh
            target = bestTarget
        }
    }

    /// The remaining part of `route` as seen from `p`, or nil if `p` has wandered off it (> 10 m).
    private static func trim(_ route: Route, to p: SIMD2<Double>) -> Route? {
        var bestI = 0
        var bestPoint = route.path[0]
        var bestDist = Double.infinity
        for i in 0..<(route.path.count - 1) {
            let c = closestPoint(on: route.path[i], route.path[i + 1], to: p)
            let d = distance(c, p)
            if d < bestDist { bestDist = d; bestI = i; bestPoint = c }
        }
        guard bestDist <= 10 else { return nil }
        let rest = [bestPoint] + route.path[(bestI + 1)...]
        return Route(path: rest, from: p, to: route.to)
    }
}

func formatDistance(_ m: Double) -> String {
    m >= 1000 ? String(format: "%.1f km", m / 1000).replacingOccurrences(of: ".", with: ",") : "\(Int((m / 5).rounded() * 5)) m"
}

func formatWalkingTime(_ m: Double) -> String {
    let minutes = Int((m / LocationModel.walkingSpeed / 60).rounded(.up))
    return "\(max(1, minutes)) min"
}
