import SwiftUI
import CoreLocation

/// The bottom panel's contents. Lives in an extension so MapScreen.swift stays about layout.
extension MapScreen {
    var bottomPanel: some View {
        VStack(spacing: 0) {
            grabber
            if panelCollapsed {
                collapsedRow
            } else {
                AutoHeightScroll(maxHeight: maxPanelHeight) {
                    panelContent
                        .padding(.horizontal, 16)
                        .padding(.bottom, 16)
                        .padding(.top, 4)
                }
            }
        }
        .frame(maxWidth: .infinity)
        .card(radius: 24)
        .padding(.horizontal, 8)
        .padding(.bottom, 4)
        .onChange(of: searchFocused) { _, f in if f { setCollapsed(false) } }
    }

    /// The handle: tap to fold/unfold, drag down to fold, drag up to unfold.
    private var grabber: some View {
        Capsule().fill(Color.white.opacity(0.18)).frame(width: 36, height: 4)
            .frame(maxWidth: .infinity)
            .padding(.top, 8).padding(.bottom, 6)
            .contentShape(Rectangle())
            .onTapGesture { setCollapsed(!panelCollapsed) }
            .gesture(collapseDrag)
            .accessibilityElement()
            .accessibilityLabel(panelCollapsed ? "Paneel uitklappen" : "Paneel inklappen")
            .accessibilityAddTraits(.isButton)
            .accessibilityAction { setCollapsed(!panelCollapsed) }
    }

    private var collapseDrag: some Gesture {
        DragGesture(minimumDistance: 10).onEnded { v in
            if v.translation.height > 30 { setCollapsed(true) }
            else if v.translation.height < -30 { setCollapsed(false) }
        }
    }

    private func setCollapsed(_ c: Bool) {
        guard c != panelCollapsed else { return }
        if c { searchFocused = false }
        withAnimation(.snappy(duration: 0.25)) { panelCollapsed = c }
    }

    /// One line shown while folded; tap it to unfold.
    private var collapsedRow: some View {
        HStack(spacing: 10) {
            Text(collapsedTitle).font(.system(size: 15, weight: .semibold)).lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
            Image(systemName: "chevron.up").font(.system(size: 13, weight: .bold)).foregroundStyle(Theme.muted)
        }
        .padding(.horizontal, 18)
        .padding(.bottom, 14)
        .contentShape(Rectangle())
        .onTapGesture { setCollapsed(false) }
        .gesture(collapseDrag)
    }

    private var collapsedTitle: String {
        switch panel {
        case .home: return query.isEmpty ? "Zoeken & mijn plekken" : "Zoeken: \(query)"
        case .category(let id): return map.categories.first { $0.id == id }?.name ?? id
        case .facility(let id): return map.facility(id: id)?.name ?? "Voorziening"
        case .place(let id): return places.place(id: id)?.name ?? "Plek"
        case .pin: return "Gemarkeerde plek"
        case .pick: return "Plek kiezen"
        case .save: return "Plek opslaan"
        }
    }

    private var maxPanelHeight: CGFloat {
        let h = UIScreen.main.bounds.height
        if searchFocused || !query.isEmpty { return h * 0.5 }
        switch panel {
        case .category, .facility: return h * 0.46
        default: return h * 0.48
        }
    }

    @ViewBuilder private var panelContent: some View {
        switch panel {
        case .home: homePanel
        case .category(let id): categoryPanel(id)
        case .facility(let id):
            if let f = map.facility(id: id) { facilityPanel(f) } else { homePanel }
        case .place(let id):
            if let p = places.place(id: id) { placePanel(p) } else { homePanel }
        case .pin(let c): pinPanel(c)
        case .pick(let kind, let moving): pickPanel(kind, moving: moving)
        case .save(let c): savePanel(c)
        }
    }

    // MARK: - Home

    private var homePanel: some View {
        VStack(alignment: .leading, spacing: 14) {
            searchField
            if query.isEmpty {
                categoryChips
                myPlaces
            } else {
                searchResults
            }
        }
    }

    private var searchField: some View {
        HStack(spacing: 10) {
            Image(systemName: "magnifyingglass").foregroundStyle(Theme.muted)
            TextField("", text: $query, prompt: Text("Zoek een podium, bar, plek…").foregroundStyle(Theme.faint))
                .focused($searchFocused)
                .submitLabel(.search)
                .autocorrectionDisabled()
            if !query.isEmpty {
                Button { query = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(Theme.muted) }
                    .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 14)
        .frame(height: 46)
        .background(Theme.tile, in: RoundedRectangle(cornerRadius: 13, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 13, style: .continuous).stroke(searchFocused ? Theme.lime.opacity(0.5) : Color.white.opacity(0.08)))
    }

    private var categoryChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(map.categories) { c in
                    Chip(title: c.name, color: Color(uiColor: c.color)) { open(.category(c.id)) }
                }
            }
        }
        .padding(.horizontal, -16)
        .contentMargins(.horizontal, 16, for: .scrollContent)
    }

    // MARK: My places

    private var myPlaces: some View {
        VStack(alignment: .leading, spacing: 10) {
            Eyebrow("Mijn plekken")
            sleepRow
            let favs = places.favoriteFacilities.compactMap { map.facility(id: $0) }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(places.others) { p in
                        placeTile(title: p.name, subtitle: distanceText([p.coordinate]) ?? p.kind.label) {
                            PlaceBadge(kind: p.kind, size: 30)
                        } action: { open(.place(p.id)) }
                    }
                    ForEach(favs) { f in
                        placeTile(title: f.name, subtitle: distanceText(f.navTargets) ?? f.category.name) {
                            CategoryBadge(color: f.category.color, label: f.category.label, size: 30)
                                .overlay(alignment: .topTrailing) {
                                    Image(systemName: "star.fill").font(.system(size: 9)).foregroundStyle(Color(hex: "#FACC15"))
                                        .padding(2).background(Theme.bg, in: Circle()).offset(x: 5, y: -5)
                                }
                        } action: { open(.facility(f.id)) }
                    }
                    Button { open(.pick(.tent, moving: nil)) } label: {
                        VStack(alignment: .leading, spacing: 6) {
                            Image(systemName: "plus").font(.system(size: 15, weight: .bold))
                                .frame(width: 30, height: 30)
                                .background(Theme.btn, in: RoundedRectangle(cornerRadius: 9))
                            Text("Plek opslaan").font(.system(size: 13, weight: .semibold))
                            Text("Tent, ontmoetingsplek…").font(.system(size: 11)).foregroundStyle(Theme.muted)
                        }
                        .padding(12)
                        .frame(width: 140, alignment: .leading)
                        .foregroundStyle(Theme.text2)
                        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Color.white.opacity(0.18), style: StrokeStyle(lineWidth: 1, dash: [4, 3])))
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, -16)
            .contentMargins(.horizontal, 16, for: .scrollContent)
            if places.others.isEmpty && favs.isEmpty {
                Text("Tip: houd de kaart ingedrukt om een plek te markeren, of tik op ☆ bij een podium.")
                    .font(.system(size: 12)).foregroundStyle(Theme.faint)
            }
        }
    }

    @ViewBuilder private var sleepRow: some View {
        if let s = places.sleep {
            HStack(spacing: 12) {
                PlaceBadge(kind: .sleep, size: 42)
                VStack(alignment: .leading, spacing: 2) {
                    Text(s.name).font(.system(size: 15, weight: .semibold))
                    Text(distanceText([s.coordinate]) ?? "Je eigen tent").font(.system(size: 12)).foregroundStyle(Theme.muted)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                Button { navigate(to: s) } label: {
                    Label("Naar huis", systemImage: "arrow.triangle.turn.up.right.diamond.fill")
                        .font(.system(size: 13, weight: .semibold))
                        .padding(.horizontal, 12).frame(height: 36)
                        .foregroundStyle(Theme.bg)
                        .background(Theme.lime, in: RoundedRectangle(cornerRadius: 11))
                }
                .buttonStyle(.plain)
            }
            .padding(10)
            .background(Theme.lime.opacity(0.07), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(Theme.lime.opacity(0.35)))
            .contentShape(Rectangle())
            .onTapGesture { open(.place(s.id)) }
        } else {
            Button { open(.pick(.sleep, moving: nil)) } label: {
                HStack(spacing: 12) {
                    Image(systemName: "tent.fill").font(.system(size: 18, weight: .semibold))
                        .frame(width: 42, height: 42)
                        .foregroundStyle(Theme.bg)
                        .background(Theme.lime, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Slaapplek toevoegen").font(.system(size: 15, weight: .semibold))
                        Text("Zet je eigen tent op de kaart, dan vind je altijd terug").font(.system(size: 12)).foregroundStyle(Theme.muted)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    Image(systemName: "plus").font(.system(size: 14, weight: .bold)).foregroundStyle(Theme.lime)
                }
                .padding(10)
                .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .stroke(Theme.lime.opacity(0.55), style: StrokeStyle(lineWidth: 1.2, dash: [5, 4])))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
    }

    private func placeTile<B: View>(title: String, subtitle: String, @ViewBuilder badge: () -> B, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 6) {
                badge()
                Text(title).font(.system(size: 13, weight: .semibold)).lineLimit(1)
                Text(subtitle).font(.system(size: 11)).foregroundStyle(Theme.muted).lineLimit(1)
            }
            .padding(12)
            .frame(width: 140, alignment: .leading)
            .background(Theme.tile, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(Color.white.opacity(0.06)))
        }
        .buttonStyle(.plain)
    }

    // MARK: Search

    private var searchResults: some View {
        let q = query.trimmingCharacters(in: .whitespaces)
        let facs = map.facilities.filter {
            $0.name.localizedCaseInsensitiveContains(q) || $0.category.name.localizedCaseInsensitiveContains(q)
                || $0.timetable.contains { $0.act.localizedCaseInsensitiveContains(q) }
        }
        let pls = places.places.filter { $0.name.localizedCaseInsensitiveContains(q) || $0.kind.label.localizedCaseInsensitiveContains(q) }
        let cats = map.categories.filter { $0.name.localizedCaseInsensitiveContains(q) }
        return VStack(alignment: .leading, spacing: 8) {
            if facs.isEmpty && pls.isEmpty {
                Text("Niets gevonden voor “\(q)”").font(.system(size: 14)).foregroundStyle(Theme.muted).padding(.vertical, 8)
            }
            ForEach(cats) { c in
                Button { open(.category(c.id)) } label: {
                    HStack(spacing: 10) {
                        CategoryBadge(color: c.color, label: c.label, size: 34)
                        Text("Alle \(c.name.lowercased())").font(.system(size: 14, weight: .semibold))
                        Spacer()
                        Text("\(map.facilities.filter { $0.category.id == c.id }.count)").foregroundStyle(Theme.muted)
                        Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.faint)
                    }
                    .rowStyle()
                }
                .buttonStyle(.plain)
            }
            ForEach(pls) { p in
                Button { open(.place(p.id)) } label: {
                    resultRow(title: p.name, subtitle: p.kind.label, distance: distance([p.coordinate])) { PlaceBadge(kind: p.kind, size: 34) }
                }
                .buttonStyle(.plain)
            }
            ForEach(sorted(facs)) { f in
                Button { open(.facility(f.id)) } label: {
                    resultRow(title: f.name, subtitle: matchingAct(f, q) ?? f.category.name, distance: distance(f.navTargets)) {
                        CategoryBadge(color: f.category.color, label: f.category.label, size: 34)
                    }
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func matchingAct(_ f: Facility, _ q: String) -> String? {
        guard !f.name.localizedCaseInsensitiveContains(q),
              let e = f.timetable.first(where: { $0.act.localizedCaseInsensitiveContains(q) }) else { return nil }
        return "\(e.act) · \(e.day) \(e.start)"
    }

    /// By walking distance when you're on the map, else by name ("Area 2" before "Area 10").
    func sorted(_ list: [Facility]) -> [Facility] {
        let d = Dictionary(uniqueKeysWithValues: list.map { ($0.id, distance($0.navTargets) ?? .infinity) })
        return list.sorted { a, b in
            let da = d[a.id]!, db = d[b.id]!
            if da != db { return da < db }
            return a.name.localizedStandardCompare(b.name) == .orderedAscending
        }
    }

    private func resultRow<B: View>(title: String, subtitle: String, distance: Double?, star: Bool = false, @ViewBuilder badge: () -> B) -> some View {
        HStack(spacing: 12) {
            badge()
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 5) {
                    Text(title).font(.system(size: 14, weight: .semibold)).lineLimit(1)
                    if star { Image(systemName: "star.fill").font(.system(size: 10)).foregroundStyle(Color(hex: "#FACC15")) }
                }
                Text(subtitle).font(.system(size: 12)).foregroundStyle(Theme.muted).lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if let distance {
                VStack(alignment: .trailing, spacing: 2) {
                    Text(formatDistance(distance)).font(.system(size: 13, weight: .semibold)).monospacedDigit()
                    Text(formatWalkingTime(distance)).font(.system(size: 11)).foregroundStyle(Theme.muted)
                }
            }
        }
        .rowStyle()
    }

    // MARK: - Category

    private func categoryPanel(_ id: String) -> some View {
        let list = sorted(map.facilities.filter { $0.category.id == id })
        let cat = list.first?.category ?? FacilityCategory.defaults[id]
        return VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                if let cat { CategoryBadge(color: cat.color, label: cat.label, size: 40) }
                VStack(alignment: .leading, spacing: 2) {
                    Text(cat?.name ?? id).font(.system(size: 19, weight: .semibold))
                    Text("\(list.count) op deze kaart").font(.system(size: 12)).foregroundStyle(Theme.muted)
                }
                Spacer()
                closeButton { goHome() }
            }
            if let nearest = list.first, let d = distance(nearest.navTargets) {
                PillButton(title: "Dichtstbijzijnde · \(formatDistance(d))", symbol: "arrow.triangle.turn.up.right.diamond.fill", lime: true) {
                    navigate(to: nearest)
                }
            }
            VStack(spacing: 6) {
                ForEach(list) { f in
                    Button { open(.facility(f.id), from: .category(id)) } label: {
                        resultRow(title: f.name, subtitle: facilitySubtitle(f), distance: distance(f.navTargets), star: places.isFavorite(f)) {
                            CategoryBadge(color: f.category.color, label: f.category.label, size: 34)
                        }
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private func facilitySubtitle(_ f: Facility) -> String {
        if !f.timetable.isEmpty { return "\(f.timetable.count) acts in de planning" }
        if !f.info.isEmpty { return f.info.replacingOccurrences(of: "\n", with: " ") }
        return f.category.name
    }

    // MARK: - Facility

    private func facilityPanel(_ f: Facility) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top, spacing: 12) {
                if backTo != nil {
                    Button { back() } label: {
                        Image(systemName: "chevron.left").font(.system(size: 14, weight: .bold))
                            .frame(width: 32, height: 32).background(Theme.btn, in: Circle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Terug naar de lijst")
                }
                CategoryBadge(color: f.category.color, label: f.category.label, size: 44)
                VStack(alignment: .leading, spacing: 3) {
                    Text(f.name).font(.system(size: 19, weight: .semibold)).fixedSize(horizontal: false, vertical: true)
                    HStack(spacing: 6) {
                        Text(f.category.name).foregroundStyle(Color(uiColor: f.category.color))
                        if let t = distanceText(f.navTargets) { Text("·").foregroundStyle(Theme.faint); Text(t).foregroundStyle(Theme.muted) }
                    }
                    .font(.system(size: 13, weight: .medium))
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                closeButton { goHome() }
            }

            if let url = f.photo, let img = UIImage(contentsOfFile: url.path) {
                Image(uiImage: img).resizable().scaledToFill()
                    .frame(maxWidth: .infinity).frame(height: 170)
                    .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            }

            HStack(spacing: 8) {
                PillButton(title: "Route", symbol: "arrow.triangle.turn.up.right.diamond.fill", lime: true) { navigate(to: f) }
                SquareButton(symbol: places.isFavorite(f) ? "star.fill" : "star", on: places.isFavorite(f), size: 46,
                             label: places.isFavorite(f) ? "Uit favorieten" : "Aan favorieten toevoegen") {
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                    places.toggleFavorite(f)
                }
            }

            if !f.info.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Eyebrow("Info")
                    Text(f.info).font(.system(size: 14)).foregroundStyle(Theme.text2).fixedSize(horizontal: false, vertical: true)
                }
            }

            if !f.timetable.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    Eyebrow("Planning")
                    ForEach(f.timetableByDay, id: \.day) { group in
                        VStack(alignment: .leading, spacing: 4) {
                            if !group.day.isEmpty {
                                Text(group.day.capitalized).font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.text2)
                            }
                            VStack(spacing: 0) {
                                ForEach(Array(group.entries.enumerated()), id: \.offset) { i, e in
                                    HStack(spacing: 12) {
                                        Text(e.end.isEmpty ? e.start : "\(e.start)–\(e.end)")
                                            .font(.system(size: 13, weight: .medium)).monospacedDigit()
                                            .foregroundStyle(Theme.muted)
                                            .frame(width: 92, alignment: .leading)
                                        Text(e.act).font(.system(size: 14, weight: .medium)).frame(maxWidth: .infinity, alignment: .leading)
                                    }
                                    .padding(.vertical, 9).padding(.horizontal, 12)
                                    if i < group.entries.count - 1 { Divider().overlay(Theme.line) }
                                }
                            }
                            .background(Theme.tile, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                        }
                    }
                }
            }

            if f.info.isEmpty && f.timetable.isEmpty && f.photo == nil {
                Text("Nog geen extra informatie over deze plek.").font(.system(size: 13)).foregroundStyle(Theme.faint)
            }
        }
    }

    // MARK: - Saved place

    private func placePanel(_ p: SavedPlace) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top, spacing: 12) {
                PlaceBadge(kind: p.kind, size: 44)
                VStack(alignment: .leading, spacing: 3) {
                    Text(p.name).font(.system(size: 19, weight: .semibold))
                    HStack(spacing: 6) {
                        Text(p.kind.label).foregroundStyle(Color(uiColor: p.kind.color))
                        if let t = distanceText([p.coordinate]) { Text("·").foregroundStyle(Theme.faint); Text(t).foregroundStyle(Theme.muted) }
                    }
                    .font(.system(size: 13, weight: .medium))
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                closeButton { goHome() }
            }
            PillButton(title: p.kind == .sleep ? "Naar mijn tent" : "Route", symbol: "arrow.triangle.turn.up.right.diamond.fill", lime: true) {
                navigate(to: p)
            }
            HStack(spacing: 8) {
                PillButton(title: "Verplaatsen", symbol: "move.3d") { open(.pick(p.kind, moving: p.id)) }
                PillButton(title: "Naam", symbol: "pencil") { renameText = p.name; renaming = p }
            }
            PillButton(title: "Verwijderen", symbol: "trash", danger: true) { confirmDelete = p }
        }
    }

    // MARK: - Long-pressed spot

    private func pinPanel(_ c: CLLocationCoordinate2D) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "mappin").font(.system(size: 18, weight: .bold)).foregroundStyle(Theme.bg)
                    .frame(width: 44, height: 44).background(Theme.lime, in: RoundedRectangle(cornerRadius: 13, style: .continuous))
                VStack(alignment: .leading, spacing: 3) {
                    Text("Gemarkeerde plek").font(.system(size: 19, weight: .semibold))
                    Text(distanceText([c]) ?? String(format: "%.5f, %.5f", c.latitude, c.longitude))
                        .font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.muted)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                closeButton { goHome() }
            }
            PillButton(title: "Route hierheen", symbol: "arrow.triangle.turn.up.right.diamond.fill", lime: true) {
                navigate(to: Destination(ref: .pin, name: "Gemarkeerde plek", targets: [c]))
            }
            HStack(spacing: 8) {
                PillButton(title: places.sleep == nil ? "Hier slaap ik" : "Tent hierheen", symbol: "tent.fill") {
                    let s = places.setSleep(at: c)
                    open(.place(s.id))
                }
                PillButton(title: "Opslaan", symbol: "bookmark.fill") {
                    saveName = PlaceKind.tent.defaultName; saveKind = .tent
                    open(.save(c))
                }
            }
        }
    }

    // MARK: - Choosing a spot

    private func pickPanel(_ kind: PlaceKind, moving: String?) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                PlaceBadge(kind: kind, size: 40)
                VStack(alignment: .leading, spacing: 2) {
                    Text(moving != nil ? "Verplaatsen" : kind == .sleep ? "Slaapplek toevoegen" : "Plek opslaan")
                        .font(.system(size: 17, weight: .semibold))
                    Text("Schuif de kaart tot het kruis op de plek staat").font(.system(size: 12)).foregroundStyle(Theme.muted)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                closeButton { if let m = moving { open(.place(m)) } else { goHome() } }
            }
            HStack(spacing: 8) {
                if let dot = location.dot {
                    PillButton(title: "Mijn locatie", symbol: "location.fill") {
                        location.following = false
                        controller.view?.setCenter(dot, animated: true)
                    }
                }
                PillButton(title: "Hier", symbol: "checkmark", lime: true) {
                    guard let c = controller.centerCoordinate else { return }
                    UINotificationFeedbackGenerator().notificationOccurred(.success)
                    if let m = moving, var p = places.place(id: m) {
                        p.coordinate = c
                        places.update(p)
                        open(.place(p.id))
                    } else if kind == .sleep {
                        let s = places.setSleep(at: c)
                        open(.place(s.id))
                    } else {
                        saveName = kind.defaultName; saveKind = kind
                        open(.save(c))
                    }
                }
            }
        }
        .onAppear {
            // Start where you are, or where the place already is.
            location.following = false
            if let m = moving, let p = places.place(id: m) { controller.view?.setCenter(p.coordinate, animated: true) }
            else if let dot = location.dot { controller.view?.setCenter(dot, animated: true) }
        }
    }

    // MARK: - Naming a new place

    private func savePanel(_ c: CLLocationCoordinate2D) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("Plek opslaan").font(.system(size: 19, weight: .semibold))
                Spacer()
                closeButton { goHome() }
            }
            Eyebrow("Wat is het?")
            HStack(spacing: 6) {
                ForEach(PlaceKind.saveable) { k in
                    Chip(title: k.label, symbol: k.symbol, on: saveKind == k) {
                        let wasDefault = PlaceKind.allCases.contains { $0.defaultName == saveName } || saveName.isEmpty
                        saveKind = k
                        if wasDefault { saveName = k.defaultName }
                    }
                }
            }
            VStack(alignment: .leading, spacing: 6) {
                Eyebrow("Naam")
                TextField("", text: $saveName, prompt: Text("Bijv. Tent van Sam").foregroundStyle(Theme.faint))
                    .padding(.horizontal, 12).frame(height: 44)
                    .background(Theme.tile, in: RoundedRectangle(cornerRadius: 11))
                    .overlay(RoundedRectangle(cornerRadius: 11).stroke(Color.white.opacity(0.08)))
                    .submitLabel(.done)
            }
            PillButton(title: "Opslaan", symbol: "checkmark", lime: true) {
                let p = places.add(name: saveName, kind: saveKind, at: c)
                UINotificationFeedbackGenerator().notificationOccurred(.success)
                open(.place(p.id))
            }
        }
    }

    // MARK: - Bits

    private func closeButton(_ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: "xmark").font(.system(size: 12, weight: .bold))
                .frame(width: 30, height: 30).background(Theme.btn, in: Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Sluiten")
    }
}

extension View {
    /// A list row like the dashboard's `.item`.
    func rowStyle() -> some View {
        self
            .padding(10)
            .background(Theme.tile, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Color.white.opacity(0.06)))
            .contentShape(Rectangle())
    }
}

/// A scroll view as tall as its content, up to `maxHeight`.
struct AutoHeightScroll<Content: View>: View {
    let maxHeight: CGFloat
    @ViewBuilder let content: Content
    @State private var contentHeight: CGFloat = 0

    var body: some View {
        ScrollView(showsIndicators: false) {
            content
                .background(GeometryReader { g in
                    Color.clear.onAppear { contentHeight = g.size.height }
                        .onChange(of: g.size.height) { _, h in contentHeight = h }
                })
        }
        .frame(height: min(max(contentHeight, 1), maxHeight))
        .scrollBounceBehavior(.basedOnSize)
    }
}
