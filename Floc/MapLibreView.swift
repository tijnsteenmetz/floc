import SwiftUI
import MapLibre

/// What's highlighted on the map.
enum Selection: Equatable {
    case facility(String)
    case place(String)
    case pin(CLLocationCoordinate2D)

    static func == (a: Selection, b: Selection) -> Bool {
        switch (a, b) {
        case (.facility(let x), .facility(let y)), (.place(let x), .place(let y)): x == y
        case (.pin(let p), .pin(let q)): p.latitude == q.latitude && p.longitude == q.longitude
        default: false
        }
    }
}

/// Lets SwiftUI move the camera and read where it is.
final class MapController: ObservableObject {
    weak var view: MLNMapView? { didSet { applyInsets() } }
    /// Height of the bottom panel, so "fly to" keeps things visible above it.
    var bottomInset: CGFloat = 0 { didSet { applyInsets() } }
    var topInset: CGFloat = 0 { didSet { applyInsets() } }

    /// The panel and top bar cover the map; centring (following you, flying to a stage) uses the part in between.
    private func applyInsets() {
        guard let view else { return }
        let insets = UIEdgeInsets(top: topInset, left: 0, bottom: bottomInset, right: 0)
        if view.contentInset != insets { view.setContentInset(insets, animated: false, completionHandler: nil) }
    }
    /// True once the map style (and the first camera position) is in place.
    @Published var loaded = false

    private var padding: UIEdgeInsets { UIEdgeInsets(top: 50, left: 50, bottom: 30, right: 70) }

    /// Centre on `c` in the visible part of the map (between the top bar and the panel), zooming in to about 120 m across if needed.
    func fly(to c: CLLocationCoordinate2D) {
        guard let view else { return }
        let d = 0.0006
        let close = view.cameraThatFitsCoordinateBounds(
            MLNCoordinateBounds(sw: .init(latitude: c.latitude - d, longitude: c.longitude - d),
                                ne: .init(latitude: c.latitude + d, longitude: c.longitude + d)),
            edgePadding: .zero)
        let cam = view.camera
        cam.centerCoordinate = c
        cam.altitude = min(cam.altitude, close.altitude)
        view.setCamera(cam, withDuration: 0.45, animationTimingFunction: CAMediaTimingFunction(name: .easeInEaseOut),
                       edgePadding: .zero, completionHandler: nil)
    }

    func fit(_ coords: [CLLocationCoordinate2D]) {
        guard let view, let first = coords.first else { return }
        if coords.count == 1 { fly(to: first); return }
        var sw = first, ne = first
        for c in coords {
            sw.latitude = min(sw.latitude, c.latitude); sw.longitude = min(sw.longitude, c.longitude)
            ne.latitude = max(ne.latitude, c.latitude); ne.longitude = max(ne.longitude, c.longitude)
        }
        // The edge padding comes on top of the content inset (panel + top bar).
        view.setVisibleCoordinateBounds(MLNCoordinateBounds(sw: sw, ne: ne), edgePadding: padding, animated: true, completionHandler: nil)
    }

    var centerCoordinate: CLLocationCoordinate2D? { view?.centerCoordinate }
}

/// MapLibre map showing one event map: the aerial photo, walkable areas, paths, facilities, your places and you. Fully offline.
struct MapLibreView: UIViewRepresentable {
    let map: EventMap
    let pathColor: String
    let places: [SavedPlace]
    let selection: Selection?
    /// Only show facilities of this category (nil = all).
    let categoryFilter: String?
    @ObservedObject var location: LocationModel
    @ObservedObject var routing: RouteModel
    let controller: MapController
    var onTapFacility: (String) -> Void
    var onTapPlace: (String) -> Void
    var onTapEmpty: (CLLocationCoordinate2D) -> Void
    var onLongPress: (CLLocationCoordinate2D) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

    func makeUIView(context: Context) -> MLNMapView {
        let view = MLNMapView(frame: .zero, styleURL: Self.writeStyle(for: map))
        view.delegate = context.coordinator
        view.logoView.isHidden = true
        view.attributionButton.isHidden = true
        view.compassView.isHidden = true
        view.automaticallyAdjustsContentInset = false
        view.maximumZoomLevel = 21
        view.minimumZoomLevel = 14
        controller.view = view

        let tap = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.tapped(_:)))
        for g in view.gestureRecognizers ?? [] {
            if let t = g as? UITapGestureRecognizer, t.numberOfTapsRequired == 2 { tap.require(toFail: t) }
        }
        view.addGestureRecognizer(tap)

        let press = UILongPressGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.longPressed(_:)))
        press.minimumPressDuration = 0.5
        view.addGestureRecognizer(press)
        return view
    }

    func updateUIView(_ view: MLNMapView, context: Context) {
        context.coordinator.parent = self
        context.coordinator.refresh(view)
    }

    final class Coordinator: NSObject, MLNMapViewDelegate {
        var parent: MapLibreView
        private var didFit = false
        private var styleLoaded = false
        private var appliedPathColor: String?
        private var appliedPlaces: [SavedPlace]?
        private var appliedSelection: Selection??
        private var appliedFilter: String??

        init(parent: MapLibreView) { self.parent = parent }

        private var map: EventMap { parent.map }
        private var location: LocationModel { parent.location }
        private var routing: RouteModel { parent.routing }

        // MARK: Style

        /// Keep the centre of the map on the aerial photo (maximumScreenBounds hangs MapLibre here, so this instead).
        func mapView(_ view: MLNMapView, shouldChangeFrom old: MLNMapCamera, to new: MLNMapCamera) -> Bool {
            guard let b = map.aerialBounds else { return true }
            let c = new.centerCoordinate
            return c.longitude >= b[0] && c.latitude >= b[1] && c.longitude <= b[2] && c.latitude <= b[3]
        }

        func mapViewDidFailLoadingMap(_ view: MLNMapView, withError error: Error) {
            NSLog("Floc: map failed: \(error)")
        }

        func mapView(_ view: MLNMapView, didFinishLoading style: MLNStyle) {
            styleLoaded = true
            addLayers(to: style)
            if !didFit, let b = map.bounds {
                didFit = true
                view.setVisibleCoordinateBounds(MLNCoordinateBounds(sw: b.sw, ne: b.ne),
                                                edgePadding: UIEdgeInsets(top: 20, left: 20, bottom: 20, right: 20),
                                                animated: false, completionHandler: nil)
                view.zoomLevel = max(view.zoomLevel, 15.8)
                if let z = Self.testZoom { view.zoomLevel = z }
            }
            refresh(view)
            DispatchQueue.main.async { self.parent.controller.loaded = true }
        }

        /// Testing aid: `-zoom <level>`.
        static var testZoom: Double? {
            let args = ProcessInfo.processInfo.arguments
            guard let i = args.firstIndex(of: "-zoom"), i + 1 < args.count else { return nil }
            return Double(args[i + 1])
        }

        func refresh(_ view: MLNMapView) {
            guard styleLoaded, let style = view.style else { return }
            if appliedPathColor != parent.pathColor { applyPathColor(style); appliedPathColor = parent.pathColor }
            if appliedPlaces != parent.places { updatePlaces(style); appliedPlaces = parent.places }
            if appliedFilter != .some(parent.categoryFilter) { applyFilter(style); appliedFilter = .some(parent.categoryFilter) }
            updateSelection(style)
            updateLocation(on: view)
        }

        private func applyPathColor(_ style: MLNStyle) {
            let c = UIColor(hex: parent.pathColor)
            (style.layer(withIdentifier: "paths") as? MLNLineStyleLayer)?.lineColor = NSExpression(forConstantValue: c)
            (style.layer(withIdentifier: "walkable-fill") as? MLNFillStyleLayer)?.fillColor = NSExpression(forConstantValue: c)
            (style.layer(withIdentifier: "walkable-line") as? MLNLineStyleLayer)?.lineColor = NSExpression(forConstantValue: c)
        }

        private func applyFilter(_ style: MLNStyle) {
            let pred = parent.categoryFilter.map { NSPredicate(format: "category == %@", $0) }
            for id in ["fac-icons", "fac-labels-main", "fac-labels-rest"] {
                (style.layer(withIdentifier: id) as? MLNVectorStyleLayer)?.predicate =
                    id == "fac-labels-main" ? (pred ?? NSPredicate(format: "rank == 0")) : pred
            }
            // With a filter on, show all labels of that category; otherwise stages only until you zoom in.
            (style.layer(withIdentifier: "fac-labels-rest") as? MLNSymbolStyleLayer)?.minimumZoomLevel = parent.categoryFilter == nil ? 17.3 : 0
        }

        private func addLayers(to style: MLNStyle) {
            style.setImage(Self.dotImage(), forName: "me")
            style.setImage(Self.pinImage(), forName: "pin")

            // Selected facility: footprint + halo (under everything else)
            let selShape = MLNShapeSource(identifier: "sel-shape", shape: nil, options: nil)
            let selPoint = MLNShapeSource(identifier: "sel-point", shape: nil, options: nil)
            [selShape, selPoint].forEach(style.addSource)
            let selFill = MLNFillStyleLayer(identifier: "sel-fill", source: selShape)
            selFill.fillColor = NSExpression(forKeyPath: "color")
            selFill.fillOpacity = NSExpression(forConstantValue: 0.25)
            style.addLayer(selFill)
            let selLine = MLNLineStyleLayer(identifier: "sel-line", source: selShape)
            selLine.lineColor = NSExpression(forKeyPath: "color")
            selLine.lineWidth = NSExpression(forConstantValue: 2.5)
            style.addLayer(selLine)

            // Route
            let route = MLNShapeSource(identifier: "route", shape: nil, options: nil)
            let connectors = MLNShapeSource(identifier: "route-connectors", shape: nil, options: nil)
            [route, connectors].forEach(style.addSource)
            let lime = UIColor(hex: Theme.limeHex)
            let glow = MLNLineStyleLayer(identifier: "route-glow", source: route)
            glow.lineColor = NSExpression(forConstantValue: lime)
            glow.lineOpacity = NSExpression(forConstantValue: 0.22)
            glow.lineWidth = NSExpression(forConstantValue: 16)
            style.addLayer(glow)
            let casing = MLNLineStyleLayer(identifier: "route-casing", source: route)
            casing.lineColor = NSExpression(forConstantValue: UIColor(hex: "#0C0D0E"))
            casing.lineWidth = NSExpression(forConstantValue: 9)
            style.addLayer(casing)
            let line = MLNLineStyleLayer(identifier: "route", source: route)
            line.lineColor = NSExpression(forConstantValue: lime)
            line.lineWidth = NSExpression(forConstantValue: 5.5)
            style.addLayer(line)
            for l in [glow, casing, line] {
                l.lineCap = NSExpression(forConstantValue: "round")
                l.lineJoin = NSExpression(forConstantValue: "round")
            }
            let conn = MLNLineStyleLayer(identifier: "route-connectors", source: connectors)
            conn.lineColor = NSExpression(forConstantValue: lime)
            conn.lineWidth = NSExpression(forConstantValue: 3)
            conn.lineDashPattern = NSExpression(forConstantValue: [1, 1.6])
            conn.lineCap = NSExpression(forConstantValue: "round")
            style.addLayer(conn)

            addFacilityLayers(to: style)

            // Saved places (above facilities)
            let places = MLNShapeSource(identifier: "places", shape: nil, options: nil)
            style.addSource(places)
            let placeLabels = MLNSymbolStyleLayer(identifier: "place-labels", source: places)
            placeLabels.iconImageName = NSExpression(forKeyPath: "label")
            placeLabels.iconAnchor = NSExpression(forConstantValue: "left")
            placeLabels.iconOffset = NSExpression(forConstantValue: NSValue(cgVector: CGVector(dx: 17, dy: 0)))
            style.addLayer(placeLabels)
            let placeIcons = MLNSymbolStyleLayer(identifier: "place-icons", source: places)
            placeIcons.iconImageName = NSExpression(forKeyPath: "icon")
            placeIcons.iconAllowsOverlap = NSExpression(forConstantValue: true)
            placeIcons.iconIgnoresPlacement = NSExpression(forConstantValue: true)
            placeIcons.symbolSortKey = NSExpression(forKeyPath: "rank")
            style.addLayer(placeIcons)

            // Selection halo + dropped pin
            let halo = MLNCircleStyleLayer(identifier: "sel-halo", source: selPoint)
            halo.circleRadius = NSExpression(forConstantValue: 24)
            halo.circleColor = NSExpression(forConstantValue: UIColor.white.withAlphaComponent(0.18))
            halo.circleStrokeColor = NSExpression(forConstantValue: UIColor.white)
            halo.circleStrokeWidth = NSExpression(forConstantValue: 2)
            halo.predicate = NSPredicate(format: "pin == NO")
            style.insertLayer(halo, below: style.layer(withIdentifier: "fac-icons")!)
            let pin = MLNSymbolStyleLayer(identifier: "sel-pin", source: selPoint)
            pin.iconImageName = NSExpression(forConstantValue: "pin")
            pin.iconAnchor = NSExpression(forConstantValue: "bottom")
            pin.iconAllowsOverlap = NSExpression(forConstantValue: true)
            pin.iconIgnoresPlacement = NSExpression(forConstantValue: true)
            pin.predicate = NSPredicate(format: "pin == YES")
            style.addLayer(pin)

            // You
            let link = MLNShapeSource(identifier: "raw-link", shape: nil, options: nil)
            let raw = MLNShapeSource(identifier: "raw", shape: nil, options: nil)
            let me = MLNShapeSource(identifier: "me", shape: nil, options: nil)
            [link, raw, me].forEach(style.addSource)

            let linkLayer = MLNLineStyleLayer(identifier: "raw-link", source: link)
            linkLayer.lineColor = NSExpression(forConstantValue: UIColor.white)
            linkLayer.lineWidth = NSExpression(forConstantValue: 1.5)
            linkLayer.lineDashPattern = NSExpression(forConstantValue: [2, 2])
            style.addLayer(linkLayer)

            let rawLayer = MLNCircleStyleLayer(identifier: "raw", source: raw)
            rawLayer.circleRadius = NSExpression(forConstantValue: 6)
            rawLayer.circleColor = NSExpression(forConstantValue: UIColor.systemGray)
            rawLayer.circleStrokeColor = NSExpression(forConstantValue: UIColor.white)
            rawLayer.circleStrokeWidth = NSExpression(forConstantValue: 1.5)
            style.addLayer(rawLayer)

            let meLayer = MLNSymbolStyleLayer(identifier: "me", source: me)
            meLayer.iconImageName = NSExpression(forConstantValue: "me")
            meLayer.iconRotation = NSExpression(forKeyPath: "heading")
            meLayer.iconRotationAlignment = NSExpression(forConstantValue: "map")
            meLayer.iconAllowsOverlap = NSExpression(forConstantValue: true)
            meLayer.iconIgnoresPlacement = NSExpression(forConstantValue: true)
            style.addLayer(meLayer)
        }

        /// Facilities: a coloured rounded badge per category (as in the dashboard), plus a name label that hides when labels would overlap.
        private func addFacilityLayers(to style: MLNStyle) {
            for c in map.categories { style.setImage(Self.badgeImage(c), forName: "cat-\(c.id)") }
            var features: [MLNPointFeature] = []
            for f in map.facilities {
                style.setImage(Self.labelImage(f.name), forName: "label-\(f.id)")
                let p = MLNPointFeature()
                p.coordinate = f.coordinate
                p.attributes = ["id": f.id, "category": f.category.id, "icon": "cat-\(f.category.id)",
                                "label": "label-\(f.id)", "rank": f.category.id == "podium" ? 0 : 1]
                features.append(p)
            }
            let source = MLNShapeSource(identifier: "facilities", features: features, options: nil)
            style.addSource(source)

            for (id, main) in [("fac-labels-rest", false), ("fac-labels-main", true)] {
                let labels = MLNSymbolStyleLayer(identifier: id, source: source)
                labels.iconImageName = NSExpression(forKeyPath: "label")
                labels.iconAnchor = NSExpression(forConstantValue: "left")
                labels.iconOffset = NSExpression(forConstantValue: NSValue(cgVector: CGVector(dx: 15, dy: 0)))
                labels.symbolSortKey = NSExpression(forKeyPath: "rank")
                labels.predicate = NSPredicate(format: main ? "rank == 0" : "rank == 1")
                if !main { labels.minimumZoomLevel = 17.3 }
                style.addLayer(labels)
            }

            let icons = MLNSymbolStyleLayer(identifier: "fac-icons", source: source)
            icons.iconImageName = NSExpression(forKeyPath: "icon")
            icons.iconAllowsOverlap = NSExpression(forConstantValue: true)
            icons.iconIgnoresPlacement = NSExpression(forConstantValue: true)
            icons.iconScale = NSExpression(format: "mgl_interpolate:withCurveType:parameters:stops:($zoomLevel, 'linear', nil, %@)",
                                           [15: 0.7, 18: 1.0])
            style.addLayer(icons)
        }

        private func updatePlaces(_ style: MLNStyle) {
            for k in PlaceKind.allCases { style.setImage(Self.placeImage(k), forName: "place-\(k.rawValue)") }
            var features: [MLNPointFeature] = []
            for p in parent.places {
                style.setImage(Self.labelImage(p.name, strong: p.kind == .sleep), forName: "plabel-\(p.id)")
                let f = MLNPointFeature()
                f.coordinate = p.coordinate
                f.attributes = ["id": p.id, "icon": "place-\(p.kind.rawValue)", "label": "plabel-\(p.id)",
                                "rank": p.kind == .sleep ? 1 : 0]
                features.append(f)
            }
            (style.source(withIdentifier: "places") as? MLNShapeSource)?.shape = MLNShapeCollectionFeature(shapes: features)
        }

        private func updateSelection(_ style: MLNStyle) {
            guard appliedSelection != .some(parent.selection) else { return }
            appliedSelection = .some(parent.selection)
            let shapeSrc = style.source(withIdentifier: "sel-shape") as? MLNShapeSource
            let pointSrc = style.source(withIdentifier: "sel-point") as? MLNShapeSource
            shapeSrc?.shape = nil
            pointSrc?.shape = nil
            switch parent.selection {
            case .facility(let id):
                guard let f = map.facility(id: id) else { return }
                let p = MLNPointFeature(); p.coordinate = f.coordinate; p.attributes = ["pin": false]
                pointSrc?.shape = p
                if var ring = f.outline, ring.count >= 3 {
                    let poly = MLNPolygonFeature(coordinates: &ring, count: UInt(ring.count))
                    poly.attributes = ["color": f.category.color]
                    shapeSrc?.shape = poly
                }
            case .place(let id):
                guard let pl = parent.places.first(where: { $0.id == id }) else { return }
                let p = MLNPointFeature(); p.coordinate = pl.coordinate; p.attributes = ["pin": false]
                pointSrc?.shape = p
            case .pin(let c):
                let p = MLNPointFeature(); p.coordinate = c; p.attributes = ["pin": true]
                pointSrc?.shape = p
            case nil: break
            }
        }

        // MARK: Images (offline: no font server, so text is drawn into images)

        static func badgeImage(_ c: FacilityCategory) -> UIImage {
            let size = CGSize(width: 30, height: 30)
            return UIGraphicsImageRenderer(size: size).image { _ in
                let rect = CGRect(origin: .zero, size: size).insetBy(dx: 1, dy: 1)
                UIColor(hex: "#0C0D0E").setFill()
                UIBezierPath(roundedRect: rect, cornerRadius: 9).fill()
                c.color.setFill()
                UIBezierPath(roundedRect: rect.insetBy(dx: 1.5, dy: 1.5), cornerRadius: 7.5).fill()
                let fontSize: CGFloat = c.label.count > 3 ? 7.5 : c.label.count > 2 ? 9 : c.label.count > 1 ? 11 : 15
                let attrs: [NSAttributedString.Key: Any] = [.font: UIFont.systemFont(ofSize: fontSize, weight: .heavy),
                                                            .foregroundColor: c.color.onColor]
                let t = (c.label as NSString).size(withAttributes: attrs)
                (c.label as NSString).draw(at: CGPoint(x: (size.width - t.width) / 2, y: (size.height - t.height) / 2), withAttributes: attrs)
            }
        }

        static func placeImage(_ k: PlaceKind) -> UIImage {
            let d: CGFloat = k == .sleep ? 38 : 30
            let size = CGSize(width: d, height: d)
            return UIGraphicsImageRenderer(size: size).image { ctx in
                let g = ctx.cgContext
                g.setFillColor(UIColor(hex: "#0C0D0E").cgColor)
                g.fillEllipse(in: CGRect(origin: .zero, size: size))
                g.setFillColor(k.color.cgColor)
                g.fillEllipse(in: CGRect(origin: .zero, size: size).insetBy(dx: 2.5, dy: 2.5))
                let cfg = UIImage.SymbolConfiguration(pointSize: d * 0.4, weight: .bold)
                if let sym = UIImage(systemName: k.symbol, withConfiguration: cfg)?
                    .withTintColor(k.color.onColor, renderingMode: .alwaysOriginal) {
                    sym.draw(at: CGPoint(x: (d - sym.size.width) / 2, y: (d - sym.size.height) / 2))
                }
            }
        }

        static func labelImage(_ text: String, strong: Bool = false) -> UIImage {
            let attrs: [NSAttributedString.Key: Any] = [.font: UIFont.systemFont(ofSize: 12, weight: .semibold),
                                                        .foregroundColor: strong ? UIColor(hex: "#0C0D0E") : UIColor.white]
            let t = (text as NSString).size(withAttributes: attrs)
            let size = CGSize(width: ceil(t.width) + 14, height: ceil(t.height) + 8)
            return UIGraphicsImageRenderer(size: size).image { _ in
                (strong ? UIColor(hex: Theme.limeHex) : UIColor(hex: "#151617").withAlphaComponent(0.9)).setFill()
                UIBezierPath(roundedRect: CGRect(origin: .zero, size: size), cornerRadius: 8).fill()
                (text as NSString).draw(at: CGPoint(x: 7, y: 4), withAttributes: attrs)
            }
        }

        /// White map pin with a lime head, for a spot you long-pressed.
        static func pinImage() -> UIImage {
            let size = CGSize(width: 30, height: 40)
            return UIGraphicsImageRenderer(size: size).image { ctx in
                let g = ctx.cgContext
                g.setFillColor(UIColor(hex: "#0C0D0E").cgColor)
                g.move(to: CGPoint(x: 15, y: 40))
                g.addLine(to: CGPoint(x: 6, y: 24)); g.addLine(to: CGPoint(x: 24, y: 24)); g.closePath(); g.fillPath()
                g.fillEllipse(in: CGRect(x: 0, y: 0, width: 30, height: 30))
                g.setFillColor(UIColor(hex: Theme.limeHex).cgColor)
                g.fillEllipse(in: CGRect(x: 3, y: 3, width: 24, height: 24))
                g.setFillColor(UIColor(hex: "#0C0D0E").cgColor)
                g.fillEllipse(in: CGRect(x: 11, y: 11, width: 8, height: 8))
            }
        }

        /// Blue dot with a white ring and a heading wedge pointing up.
        static func dotImage() -> UIImage {
            let size = CGSize(width: 48, height: 48)
            return UIGraphicsImageRenderer(size: size).image { ctx in
                let g = ctx.cgContext
                let blue = UIColor(hex: "#3B9BFF")
                g.setFillColor(blue.withAlphaComponent(0.85).cgColor)
                g.move(to: CGPoint(x: 24, y: 2))
                g.addLine(to: CGPoint(x: 33, y: 17))
                g.addLine(to: CGPoint(x: 15, y: 17))
                g.closePath(); g.fillPath()
                g.setFillColor(UIColor.white.cgColor)
                g.fillEllipse(in: CGRect(x: 13, y: 13, width: 22, height: 22))
                g.setFillColor(blue.cgColor)
                g.fillEllipse(in: CGRect(x: 16, y: 16, width: 16, height: 16))
            }
        }

        // MARK: Location

        func updateLocation(on view: MLNMapView) {
            guard styleLoaded, let style = view.style else { return }
            let me = style.source(withIdentifier: "me") as? MLNShapeSource
            let raw = style.source(withIdentifier: "raw") as? MLNShapeSource
            let link = style.source(withIdentifier: "raw-link") as? MLNShapeSource

            if let dot = location.dot {
                let f = MLNPointFeature()
                f.coordinate = dot
                f.attributes = ["heading": location.heading]
                me?.shape = f
            } else {
                me?.shape = nil
            }

            if location.showRaw, let r = location.raw, let d = location.dot {
                let p = MLNPointFeature(); p.coordinate = r
                raw?.shape = p
                var coords = [r, d]
                link?.shape = MLNPolylineFeature(coordinates: &coords, count: 2)
            } else {
                raw?.shape = nil
                link?.shape = nil
            }

            updateRoute(on: style)

            if location.following, let dot = location.dot {
                let direction = location.cameraMode == .headingUp ? location.heading : 0
                isProgrammaticMove = true
                view.setCenter(dot, zoomLevel: view.zoomLevel, direction: direction, animated: false)
                isProgrammaticMove = false
            }
        }

        private var isProgrammaticMove = false

        private func updateRoute(on style: MLNStyle) {
            let routeSrc = style.source(withIdentifier: "route") as? MLNShapeSource
            let connSrc = style.source(withIdentifier: "route-connectors") as? MLNShapeSource
            guard let r = routing.route else {
                routeSrc?.shape = nil; connSrc?.shape = nil; return
            }
            var main = r.path.map(routing.coord)
            routeSrc?.shape = MLNPolylineFeature(coordinates: &main, count: UInt(main.count))
            var start = [routing.coord(r.from), routing.coord(r.path.first!)]
            var end = [routing.coord(r.path.last!), routing.coord(r.to)]
            connSrc?.shape = MLNShapeCollectionFeature(shapes: [
                MLNPolylineFeature(coordinates: &start, count: 2),
                MLNPolylineFeature(coordinates: &end, count: 2),
            ])
        }

        // MARK: Gestures

        @objc func longPressed(_ g: UILongPressGestureRecognizer) {
            guard g.state == .began, let view = g.view as? MLNMapView else { return }
            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
            parent.onLongPress(view.convert(g.location(in: view), toCoordinateFrom: view))
        }

        @objc func tapped(_ g: UITapGestureRecognizer) {
            guard let view = g.view as? MLNMapView else { return }
            let pt = g.location(in: view)
            let box = CGRect(x: pt.x - 22, y: pt.y - 22, width: 44, height: 44)
            if let f = view.visibleFeatures(in: box, styleLayerIdentifiers: ["place-icons", "place-labels"]).first,
               let id = f.attribute(forKey: "id") as? String {
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                parent.onTapPlace(id)
                return
            }
            if let f = view.visibleFeatures(in: box, styleLayerIdentifiers: ["fac-icons", "fac-labels-main", "fac-labels-rest"]).first,
               let id = f.attribute(forKey: "id") as? String {
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                parent.onTapFacility(id)
                return
            }
            parent.onTapEmpty(view.convert(pt, toCoordinateFrom: view))
        }

        func mapView(_ view: MLNMapView, regionWillChangeWith reason: MLNCameraChangeReason, animated: Bool) {
            // Dragging the map stops following; pinch-zoom doesn't.
            if !isProgrammaticMove, reason.contains(.gesturePan) {
                DispatchQueue.main.async { self.location.following = false }
            }
        }

        func mapViewRegionIsChanging(_ view: MLNMapView) {
            location.mapBearing = view.direction
        }

        func mapView(_ view: MLNMapView, regionDidChangeAnimated animated: Bool) {
            location.mapBearing = view.direction
        }
    }

    /// Builds a MapLibre style JSON for the map and writes it to a temp file.
    /// Only the aerial photo, walkable areas and paths are drawn; everything else is added at runtime.
    static func writeStyle(for map: EventMap) -> URL {
        var sources: [String: Any] = [:]
        var layers: [[String: Any]] = [
            ["id": "bg", "type": "background", "paint": ["background-color": "#0C0D0E"]]
        ]

        if map.hasAerial {
            sources["aerial"] = ["type": "raster", "url": "mbtiles://" + map.aerialURL.path, "tileSize": 256]
            layers.append(["id": "aerial", "type": "raster", "source": "aerial",
                           "paint": ["raster-fade-duration": 0]])
        }

        if map.hasWalkable, let data = try? Data(contentsOf: map.walkableURL),
           let json = try? JSONSerialization.jsonObject(with: data) {
            sources["walkable"] = ["type": "geojson", "data": json]
            layers.append(["id": "walkable-fill", "type": "fill", "source": "walkable",
                           "paint": ["fill-color": map.pathColor, "fill-opacity": 0.16]])
            layers.append(["id": "walkable-line", "type": "line", "source": "walkable",
                           "paint": ["line-color": map.pathColor, "line-width": 1.5, "line-opacity": 0.8, "line-dasharray": [2, 2]]])
        }

        if let data = try? Data(contentsOf: map.pathsURL),
           let json = try? JSONSerialization.jsonObject(with: data) {
            sources["paths"] = ["type": "geojson", "data": json]
            let width: [Any] = ["interpolate", ["linear"], ["zoom"], 15, 1.2, 18, 3, 20, 5]
            let casing: [Any] = ["interpolate", ["linear"], ["zoom"], 15, 2.6, 18, 5.5, 20, 8]
            layers.append(["id": "paths-casing", "type": "line", "source": "paths",
                           "layout": ["line-cap": "round", "line-join": "round"],
                           "paint": ["line-color": "#0C0D0E", "line-width": casing, "line-opacity": 0.55]])
            layers.append(["id": "paths", "type": "line", "source": "paths",
                           "layout": ["line-cap": "round", "line-join": "round"],
                           "paint": ["line-color": map.pathColor, "line-width": width]])
        }

        let style: [String: Any] = ["version": 8, "name": map.name, "sources": sources, "layers": layers]
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("style-\(map.id).json")
        if let data = try? JSONSerialization.data(withJSONObject: style) {
            try? data.write(to: url)
        }
        return url
    }
}
