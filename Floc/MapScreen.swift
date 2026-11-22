import SwiftUI
import CoreLocation

/// What the bottom panel shows.
enum Panel: Equatable {
    case home
    case category(String)
    case facility(String)
    case place(String)
    case pin(CLLocationCoordinate2D)
    /// Choosing a spot with the crosshair. `moving` = the id of a saved place being moved.
    case pick(PlaceKind, moving: String?)
    /// Naming a new place at this spot.
    case save(CLLocationCoordinate2D)

    static func == (a: Panel, b: Panel) -> Bool {
        switch (a, b) {
        case (.home, .home): true
        case (.category(let x), .category(let y)), (.facility(let x), .facility(let y)), (.place(let x), .place(let y)): x == y
        case (.pin(let p), .pin(let q)), (.save(let p), .save(let q)): p.latitude == q.latitude && p.longitude == q.longitude
        case (.pick(let k, let m), .pick(let l, let n)): k == l && m == n
        default: false
        }
    }
}

struct MapScreen: View {
    let map: EventMap
    @StateObject var location: LocationModel
    @StateObject var routing: RouteModel
    @StateObject var places: PlacesStore
    @StateObject var controller = MapController()
    @Environment(\.dismiss) var dismiss

    /// Your own path colour; empty = the colour from the dashboard.
    @AppStorage("pathColor") var pathColorPref = ""

    @State var panel: Panel = .home
    /// Where "back" goes from a facility (the category list you came from).
    @State var backTo: Panel?
    @State var query = ""
    @FocusState var searchFocused: Bool
    @State var showSettings = false
    @State var panelHeight: CGFloat = 0
    /// Bottom panel folded down to a single line so you see more map.
    @State var panelCollapsed = false
    @State var topHeight: CGFloat = 0
    @State var saveName = ""
    @State var saveKind: PlaceKind = .tent
    @State var renaming: SavedPlace?
    @State var renameText = ""
    @State var confirmDelete: SavedPlace?

    init(map: EventMap) {
        self.map = map
        let location = LocationModel(map: map)
        _location = StateObject(wrappedValue: location)
        _routing = StateObject(wrappedValue: RouteModel(map: map, location: location))
        _places = StateObject(wrappedValue: PlacesStore(mapID: map.id))
    }

    var pathColor: String { pathColorPref.isEmpty ? map.pathColor : pathColorPref }

    var selection: Selection? {
        switch panel {
        case .facility(let id): .facility(id)
        case .place(let id): .place(id)
        case .pin(let c): .pin(c)
        default: nil
        }
    }

    var categoryFilter: String? {
        switch panel {
        case .category(let id): id
        case .facility(let id) where backTo != nil: map.facility(id: id)?.category.id
        default: nil
        }
    }

    var isPicking: Bool { if case .pick = panel { true } else { false } }

    var body: some View {
        ZStack {
            MapLibreView(map: map, pathColor: pathColor, places: places.places, selection: selection,
                         categoryFilter: categoryFilter, location: location, routing: routing, controller: controller,
                         onTapFacility: { open(.facility($0), from: currentList) },
                         onTapPlace: { open(.place($0)) },
                         onTapEmpty: tappedEmpty,
                         onLongPress: { c in open(.pin(c)) })
                .ignoresSafeArea()

            if isPicking { crosshair }

            VStack(spacing: 0) {
                topBar
                    .background(GeometryReader { g in Color.clear.preference(key: TopHeightKey.self, value: g.frame(in: .global).maxY) })
                Spacer(minLength: 0)
                HStack(alignment: .bottom) {
                    joystick
                    Spacer()
                    sideButtons
                }
                .padding(.horizontal, 12)
                .padding(.bottom, 10)
                bottomPanel
                    .background(GeometryReader { g in Color.clear.preference(key: PanelHeightKey.self, value: g.size.height) })
            }
        }
        .background(Theme.bg)
        .toolbar(.hidden, for: .navigationBar)
        .onPreferenceChange(PanelHeightKey.self) { h in
            panelHeight = h
            controller.bottomInset = h + 30
        }
        .onPreferenceChange(TopHeightKey.self) { h in
            topHeight = h
            controller.topInset = h
        }
        .sheet(isPresented: $showSettings) { SettingsSheet(map: map, location: location, pathColorPref: $pathColorPref) }
        .alert("Naam wijzigen", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
            TextField("Naam", text: $renameText)
            Button("Bewaar") {
                if var p = renaming {
                    let t = renameText.trimmingCharacters(in: .whitespaces)
                    if !t.isEmpty { p.name = t; places.update(p) }
                }
                renaming = nil
            }
            Button("Annuleer", role: .cancel) { renaming = nil }
        }
        .confirmationDialog(confirmDelete.map { "\($0.name) verwijderen?" } ?? "",
                            isPresented: Binding(get: { confirmDelete != nil }, set: { if !$0 { confirmDelete = nil } }),
                            titleVisibility: .visible) {
            Button("Verwijderen", role: .destructive) {
                if let p = confirmDelete {
                    if case .place(let id) = routing.destination?.ref, id == p.id { routing.clear() }
                    places.remove(p.id)
                    panel = .home
                }
                confirmDelete = nil
            }
        }
        .preferredColorScheme(.dark)
        .onDisappear { location.stop() }
        .onAppear(perform: applyTestArguments)
        .onChange(of: controller.loaded) { _, loaded in if loaded { applyTestPanels() } }
    }

    /// The list to return to from a facility opened on the map.
    var currentList: Panel? {
        if case .category = panel { return panel }
        if case .facility = panel { return backTo }
        return nil
    }

    // MARK: - Navigation between panels

    func open(_ p: Panel, from: Panel? = nil) {
        searchFocused = false
        switch p {
        case .facility, .place, .category: location.following = false   // otherwise the camera snaps back to you
        default: break
        }
        withAnimation(.snappy(duration: 0.25)) {
            backTo = from
            panel = p
            panelCollapsed = false
        }
        // Wait for the panel to settle: a new content inset mid-animation cancels the camera move.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { focusCamera(on: p) }
    }

    func goHome() {
        searchFocused = false
        withAnimation(.snappy(duration: 0.25)) { panel = .home; backTo = nil; query = ""; panelCollapsed = false }
    }

    func back() {
        if let b = backTo { open(b) } else { goHome() }
    }

    private func focusCamera(on p: Panel) {
        switch p {
        case .facility(let id): if let f = map.facility(id: id) { controller.fly(to: f.coordinate) }
        case .place(let id): if let pl = places.place(id: id) { controller.fly(to: pl.coordinate) }
        case .category(let id):
            var pts = map.facilities.filter { $0.category.id == id }.map(\.coordinate)
            if let d = location.dot { pts.append(d) }
            controller.fit(pts)
        default: break
        }
    }

    private func tappedEmpty(_ c: CLLocationCoordinate2D) {
        if isPicking { return }
        switch panel {
        case .home:
            searchFocused = false
            if location.mode == .joystick { location.place(at: c) }
        case .facility, .place, .pin:
            if let b = backTo { open(b) } else { goHome() }
        default:
            goHome()
        }
    }

    // MARK: - Routing

    func navigate(to d: Destination) {
        location.following = false
        routing.setDestination(d)
        var pts = d.targets
        if let dot = location.dot { pts.append(dot) }
        controller.fit(pts)
        goHome()
    }

    func navigate(to f: Facility) { navigate(to: Destination(ref: .facility(f.id), name: f.name, targets: f.navTargets)) }
    func navigate(to p: SavedPlace) { navigate(to: Destination(ref: .place(p.id), name: p.name, targets: [p.coordinate])) }

    /// "140 m · 2 min" from where you are, or nil without a location.
    func distanceText(_ targets: [CLLocationCoordinate2D]) -> String? {
        _ = routing.distanceVersion
        guard let m = routing.walkingDistance(to: targets) else { return nil }
        return "\(formatDistance(m)) · \(formatWalkingTime(m))"
    }

    func distance(_ targets: [CLLocationCoordinate2D]) -> Double? { routing.walkingDistance(to: targets) }

    // MARK: - Top bar

    private var topBar: some View {
        VStack(spacing: 8) {
            HStack(spacing: 8) {
                SquareButton(symbol: "chevron.left", label: "Terug naar kaarten") { dismiss() }
                if routing.destination != nil {
                    routeCard
                } else {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(map.name).font(.system(size: 15, weight: .semibold)).lineLimit(1)
                        Text(statusLine).font(.system(size: 12)).foregroundStyle(Theme.muted).lineLimit(1)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 14)
                    .frame(height: 48)
                    .card(radius: 14)
                }
                SquareButton(symbol: "slider.horizontal.3", label: "Instellingen") { showSettings = true }
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 4)
    }

    private var statusLine: String {
        if location.mode == .joystick && location.raw == nil { return "Joystick · tik op de kaart om jezelf te plaatsen" }
        if location.mode == .gps && location.raw == nil { return "Wachten op GPS…" }
        if let a = location.accuracy, location.mode == .gps { return "GPS · ±\(Int(a)) m" }
        return "\(map.facilities.count) voorzieningen · \(places.places.count) eigen plekken"
    }

    private var routeCard: some View {
        HStack(spacing: 10) {
            destinationBadge
            VStack(alignment: .leading, spacing: 2) {
                Text(routing.destinationName ?? "Bestemming").font(.system(size: 15, weight: .semibold)).lineLimit(1)
                Group {
                    if location.dot == nil {
                        Text("Plaats jezelf om de route te zien").foregroundStyle(Theme.muted)
                    } else if routing.noRoute {
                        Text("Geen route — niet verbonden").foregroundStyle(Theme.danger)
                    } else if routing.arrived {
                        Text("Je bent er").foregroundStyle(Theme.lime)
                    } else if let r = routing.route {
                        Text("\(formatDistance(r.length)) · \(formatWalkingTime(r.length)) lopen").foregroundStyle(Theme.lime)
                    } else {
                        Text("Route zoeken…").foregroundStyle(Theme.muted)
                    }
                }
                .font(.system(size: 13, weight: .medium))
                .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Button { withAnimation { routing.clear() } } label: {
                Image(systemName: "xmark").font(.system(size: 13, weight: .bold))
                    .frame(width: 30, height: 30)
                    .background(Theme.btn, in: Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Stop route")
        }
        .padding(.leading, 9).padding(.trailing, 9)
        .frame(height: 48)
        .card(radius: 14)
        .contentShape(Rectangle())
        .onTapGesture {
            var pts = routing.destination?.targets ?? []
            if let d = location.dot { pts.append(d) }
            controller.fit(pts)
        }
    }

    @ViewBuilder private var destinationBadge: some View {
        switch routing.destination?.ref {
        case .facility(let id):
            if let f = map.facility(id: id) { CategoryBadge(color: f.category.color, label: f.category.label, size: 32) }
        case .place(let id):
            PlaceBadge(kind: places.place(id: id)?.kind ?? .favorite, size: 32)
        default:
            Image(systemName: "mappin").font(.system(size: 15, weight: .bold)).foregroundStyle(Theme.bg)
                .frame(width: 32, height: 32).background(Theme.lime, in: RoundedRectangle(cornerRadius: 10))
        }
    }

    // MARK: - Side controls

    private var sideButtons: some View {
        VStack(spacing: 8) {
            SquareButton(symbol: location.cameraMode == .northUp ? "location.north.line" : "location.north.line.fill",
                         on: location.cameraMode == .headingUp,
                         label: location.cameraMode == .northUp ? "Noorden boven" : "Looprichting boven") {
                location.cameraMode = location.cameraMode == .northUp ? .headingUp : .northUp
                location.following = true
            }
            SquareButton(symbol: location.following ? "location.fill" : "location",
                         on: location.following && location.dot != nil, label: "Centreer op mij") {
                location.following = true
            }
            .disabled(location.dot == nil)
        }
        .opacity(isPicking ? 0 : 1)
    }

    @ViewBuilder private var joystick: some View {
        if location.mode == .joystick, location.raw != nil, !isPicking {
            JoystickView { location.setStick($0) }
        }
    }

    private var crosshair: some View {
        ZStack {
            Circle().stroke(Theme.bg.opacity(0.6), lineWidth: 5).frame(width: 34, height: 34)
            Circle().stroke(Theme.lime, lineWidth: 2.5).frame(width: 34, height: 34)
            Rectangle().fill(Theme.lime).frame(width: 2, height: 52)
            Rectangle().fill(Theme.lime).frame(width: 52, height: 2)
            Circle().fill(Theme.lime).frame(width: 6, height: 6)
        }
        .shadow(color: .black.opacity(0.6), radius: 3)
        .allowsHitTesting(false)
        .ignoresSafeArea()
    }

    // MARK: - Test arguments

    /// Testing aids: `-place <lat>,<lon>`, `-goto <lat>,<lon>`, `-showRaw`, `-sleep <lat>,<lon>`,
    /// `-select <facility name>`, `-category <id>`.
    private func applyTestArguments() {
        let args = ProcessInfo.processInfo.arguments
        if args.contains("-showRaw") { location.showRaw = true }
        func arg(_ name: String) -> String? {
            guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
            return args[i + 1]
        }
        func coordArg(_ name: String) -> CLLocationCoordinate2D? {
            guard let parts = arg(name)?.split(separator: ",").compactMap({ Double($0) }), parts.count == 2 else { return nil }
            return .init(latitude: parts[0], longitude: parts[1])
        }
        if let c = coordArg("-place") { location.place(at: c) }
        if let c = coordArg("-sleep") { places.setSleep(at: c) }
        if let c = coordArg("-goto") { routing.setDestination(Destination(ref: .pin, name: "Gemarkeerde plek", targets: [c])) }
    }

    /// `-category`, `-select` and `-search` wait until the map has loaded, or its first camera move would undo theirs.
    private func applyTestPanels() {
        let args = ProcessInfo.processInfo.arguments
        func arg(_ name: String) -> String? {
            guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
            return args[i + 1]
        }
        if let id = arg("-category") { open(.category(id)) }
        if let q = arg("-select"), let f = map.facilities.first(where: { $0.name.localizedCaseInsensitiveContains(q) }) {
            open(.facility(f.id))
        }
        if let q = arg("-search") { query = q }
        if args.contains("-collapsed") { DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { panelCollapsed = true } }
    }
}

private struct PanelHeightKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}

private struct TopHeightKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}
