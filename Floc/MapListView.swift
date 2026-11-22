import SwiftUI

struct MapListView: View {
    @State private var maps: [EventMap] = MapLoader.loadAll()
    @State private var navPath: [EventMap] = MapListView.initialPath()

    /// Launch with `-openMap <folder>` to jump straight into a map (handy for testing).
    static func initialPath() -> [EventMap] {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: "-openMap"), i + 1 < args.count else { return [] }
        return MapLoader.loadAll().filter { $0.id == args[i + 1] }
    }

    var body: some View {
        NavigationStack(path: $navPath) {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    HStack(spacing: 12) {
                        Text("f").font(.system(size: 22, weight: .heavy)).foregroundStyle(Theme.bg)
                            .frame(width: 44, height: 44).background(Theme.text, in: RoundedRectangle(cornerRadius: 14))
                        Text("Kaarten").font(.system(size: 32, weight: .semibold)).tracking(-0.5)
                    }
                    .padding(.top, 12)
                    if maps.isEmpty {
                        Text("Nog geen kaarten. Exporteer er een vanuit het dashboard en bouw opnieuw.")
                            .foregroundStyle(Theme.muted)
                    }
                    ForEach(maps) { map in
                        NavigationLink(value: map) { card(map) }.buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 16)
            }
            .background(Theme.bg)
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(for: EventMap.self) { MapScreen(map: $0) }
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
