import SwiftUI

struct MapListView: View {
    @ObservedObject private var store = EventStore.shared
    @ObservedObject private var session = Session.shared
    @State private var bundled: [EventMap] = MapLoader.loadAll()
    @State private var downloaded: [String: EventMap] = [:]
    @State private var navPath: [EventMap] = MapListView.initialPath()
    @State private var confirmRemove: Backend.Event?

    /// Launch with `-openMap <folder>` to jump straight into a bundled map (handy for testing).
    static func initialPath() -> [EventMap] {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: "-openMap"), i + 1 < args.count else { return [] }
        return MapLoader.loadAll().filter { $0.id == args[i + 1] }
    }

    /// Server events, plus downloaded ones the server didn't list (offline, or unpublished since).
    private var events: [Backend.Event] {
        var out = store.events
        for (id, map) in downloaded where !out.contains(where: { $0.id == id }) {
            out.append(.init(id: id, name: map.name, notes: map.notes ?? "", organizer: nil, version: store.installed[id] ?? 0, size: 0))
        }
        return out
    }

    var body: some View {
        NavigationStack(path: $navPath) {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    HStack(spacing: 12) {
                        Text("f").font(.system(size: 22, weight: .heavy)).foregroundStyle(Theme.bg)
                            .frame(width: 44, height: 44).background(Theme.text, in: RoundedRectangle(cornerRadius: 14))
                        Text("Festivals").font(.system(size: 32, weight: .semibold)).tracking(-0.5)
                        Spacer()
                        Menu {
                            if let e = session.email { Text(e) }
                            Button("Uitloggen", role: .destructive) { Task { await session.logout() } }
                        } label: {
                            Image(systemName: "person.crop.circle").font(.system(size: 22)).foregroundStyle(Theme.muted)
                                .frame(width: 44, height: 44)
                        }
                    }
                    .padding(.top, 12)

                    if store.loading && store.events.isEmpty {
                        HStack(spacing: 10) { ProgressView(); Text("Festivals ophalen…").foregroundStyle(Theme.muted) }
                    } else if let err = store.loadError {
                        Text("Geen verbinding met floc (\(err)). Je gedownloade festivals werken gewoon offline.")
                            .font(.system(size: 14)).foregroundStyle(Theme.muted)
                    } else if events.isEmpty {
                        Text("Er zijn nog geen festivals gepubliceerd.").foregroundStyle(Theme.muted)
                    }
                    ForEach(events) { e in eventCard(e) }

                    if !bundled.isEmpty {
                        Eyebrow("Testkaarten (ingebouwd)").padding(.top, 12)
                        ForEach(bundled) { map in
                            NavigationLink(value: map) { card(map) }.buttonStyle(.plain)
                        }
                    }
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 24)
            }
            .refreshable { await store.refresh() }
            .background(Theme.bg)
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(for: EventMap.self) { MapScreen(map: $0) }
        }
        .task {
            reloadDownloaded()
            await store.refresh()
            // Testing: `-download <event id>` downloads (or updates) that event and opens it.
            let a = ProcessInfo.processInfo.arguments
            if let i = a.firstIndex(of: "-download"), i + 1 < a.count {
                await store.download(a[i + 1])
                reloadDownloaded()
                if let m = downloaded[a[i + 1]] { navPath.append(m) }
            }
        }
        .onChange(of: store.installed) { _, _ in reloadDownloaded() }
        .confirmationDialog("Van je telefoon verwijderen?", isPresented: Binding(get: { confirmRemove != nil }, set: { if !$0 { confirmRemove = nil } }), presenting: confirmRemove) { e in
            Button("\(e.name) verwijderen", role: .destructive) { store.remove(e.id) }
        } message: { _ in Text("Je kunt hem later opnieuw downloaden. Je opgeslagen plekken blijven bewaard.") }
    }

    private func reloadDownloaded() {
        var out: [String: EventMap] = [:]
        for id in store.installed.keys { if let m = MapLoader.load(folder: EventStore.folder(id)) { out[id] = m } }
        downloaded = out
    }

    private func mb(_ b: Int) -> String { b >= 10_000_000 ? "\(b / 1_000_000) MB" : String(format: "%.1f MB", Double(b) / 1e6) }

    @ViewBuilder private func eventCard(_ e: Backend.Event) -> some View {
        let map = downloaded[e.id]
        let state = store.states[e.id] ?? .idle
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(e.name).font(.system(size: 17, weight: .semibold)).multilineTextAlignment(.leading)
                    if let o = e.organizer, o != "floc (intern)" { Text(o).font(.system(size: 13)).foregroundStyle(Theme.faint) }
                }
                Spacer()
                if map != nil, case .idle = state {
                    Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.faint).padding(.top, 4)
                }
            }
            if !e.notes.isEmpty {
                Text(e.notes).font(.system(size: 13)).foregroundStyle(Theme.muted).lineLimit(2).multilineTextAlignment(.leading)
            }
            if let map {
                HStack(spacing: 6) {
                    ForEach(map.categories.prefix(6)) { c in CategoryBadge(color: c.color, label: c.label, size: 24) }
                    Spacer()
                    Text("\(map.facilities.count) plekken").font(.system(size: 12)).foregroundStyle(Theme.faint)
                }
            }
            switch state {
            case .downloading(let f):
                VStack(alignment: .leading, spacing: 6) {
                    ProgressView(value: f).tint(Theme.lime)
                    Text("Downloaden… \(Int(f * 100))%").font(.system(size: 12)).foregroundStyle(Theme.muted)
                }
            case .failed(let msg):
                Text(msg).font(.system(size: 13)).foregroundStyle(Theme.danger)
                actionButton("Opnieuw proberen") { Task { await store.download(e.id) } }
            case .idle:
                if map == nil {
                    actionButton("Downloaden · \(mb(e.size))") { Task { await store.download(e.id) } }
                } else if store.hasUpdate(e) {
                    actionButton("Update beschikbaar · bijwerken") { Task { await store.download(e.id) } }
                }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.cardSolid, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).stroke(Theme.line))
        .contentShape(Rectangle())
        .onTapGesture { if let map, case .idle = state { navPath.append(map) } }
        .contextMenu { if map != nil { Button("Verwijderen van telefoon", systemImage: "trash", role: .destructive) { confirmRemove = e } } }
    }

    private func actionButton(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title).font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.bg)
                .frame(maxWidth: .infinity).frame(height: 44)
                .background(Theme.lime, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
    }

    private func card(_ map: EventMap) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(map.name).font(.system(size: 17, weight: .semibold)).multilineTextAlignment(.leading)
            if let notes = map.notes {
                Text(notes).font(.system(size: 13)).foregroundStyle(Theme.muted).lineLimit(2).multilineTextAlignment(.leading)
            }
            HStack(spacing: 6) {
                ForEach(map.categories.prefix(6)) { c in
                    CategoryBadge(color: c.color, label: c.label, size: 24)
                }
                Spacer()
                Text("\(map.facilities.count) plekken").font(.system(size: 12)).foregroundStyle(Theme.faint)
                Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.faint)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.cardSolid, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).stroke(Theme.line))
    }
}
