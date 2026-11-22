import SwiftUI

/// Path colour, location mode and map info.
struct SettingsSheet: View {
    let map: EventMap
    @ObservedObject var location: LocationModel
    @Binding var pathColorPref: String
    @Environment(\.dismiss) private var dismiss

    private var current: String { pathColorPref.isEmpty ? map.pathColor : pathColorPref }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                HStack {
                    Text("Instellingen").font(.system(size: 22, weight: .semibold))
                    Spacer()
                    Button { dismiss() } label: {
                        Image(systemName: "xmark").font(.system(size: 13, weight: .bold))
                            .frame(width: 32, height: 32).background(Theme.btn, in: Circle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Sluiten")
                }

                section("Kleur van de paden") {
                    LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 10), count: 5), spacing: 10) {
                        swatch(hex: map.pathColor, label: "Kaart", selected: pathColorPref.isEmpty) { pathColorPref = "" }
                        ForEach(Theme.pathPalette.filter { $0.caseInsensitiveCompare(map.pathColor) != .orderedSame }, id: \.self) { hex in
                            swatch(hex: hex, label: nil, selected: pathColorPref.caseInsensitiveCompare(hex) == .orderedSame) { pathColorPref = hex }
                        }
                    }
                    ColorPicker(selection: Binding(
                        get: { Color(hex: current) },
                        set: { pathColorPref = UIColor($0).hex }
                    ), supportsOpacity: false) {
                        Text("Eigen kleur").font(.system(size: 14))
                    }
                    .padding(.horizontal, 12).frame(height: 46)
                    .background(Theme.tile, in: RoundedRectangle(cornerRadius: 12))
                    preview
                }

                section("Locatie") {
                    HStack(spacing: 2) {
                        ForEach(LocationMode.allCases) { m in
                            Button { location.mode = m } label: {
                                Text(m == .gps ? "GPS" : "Joystick (test)")
                                    .font(.system(size: 13, weight: .medium))
                                    .frame(maxWidth: .infinity).frame(height: 34)
                                    .foregroundStyle(location.mode == m ? .white : Theme.muted)
                                    .background(location.mode == m ? Theme.btn : .clear, in: RoundedRectangle(cornerRadius: 9))
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(3)
                    .background(Theme.tile, in: RoundedRectangle(cornerRadius: 11))
                    Toggle(isOn: $location.showRaw) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Ruwe locatie tonen").font(.system(size: 14))
                            Text("Grijze stip: wat GPS of joystick zegt, vóór het vastklikken op een pad.")
                                .font(.system(size: 12)).foregroundStyle(Theme.muted)
                        }
                    }
                    .tint(Theme.lime)
                    .padding(12)
                    .background(Theme.tile, in: RoundedRectangle(cornerRadius: 12))
                }

                section("Over deze kaart") {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(map.name).font(.system(size: 14, weight: .semibold))
                        if let n = map.notes { Text(n).font(.system(size: 13)).foregroundStyle(Theme.muted) }
                        Text("\(map.facilities.count) voorzieningen · \(map.paths.count) paden · \(map.walkable.count) open vlakken")
                            .font(.system(size: 12)).foregroundStyle(Theme.faint).padding(.top, 4)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
                    .background(Theme.tile, in: RoundedRectangle(cornerRadius: 12))
                }
            }
            .padding(20)
        }
        .background(Theme.cardSolid)
        .presentationDetents([.medium, .large])
        .presentationBackground(Theme.cardSolid)
        .presentationCornerRadius(24)
        .preferredColorScheme(.dark)
    }

    private func section<C: View>(_ title: String, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Eyebrow(title)
            content()
        }
    }

    private func swatch(hex: String, label: String?, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 4) {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(Color(hex: hex))
                    .frame(height: 40)
                    .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .stroke(selected ? Theme.text : Color.white.opacity(0.15), lineWidth: selected ? 2.5 : 1))
                    .overlay { if selected { Image(systemName: "checkmark").font(.system(size: 13, weight: .bold)).foregroundStyle(Color(uiColor: UIColor(hex: hex).onColor)) } }
                if let label { Text(label).font(.system(size: 10)).foregroundStyle(Theme.muted) }
            }
        }
        .buttonStyle(.plain)
    }

    /// A little sample: paths over a dark-green "aerial".
    private var preview: some View {
        Canvas { ctx, size in
            var p = Path()
            p.move(to: CGPoint(x: 0, y: size.height * 0.7))
            p.addCurve(to: CGPoint(x: size.width, y: size.height * 0.3),
                       control1: CGPoint(x: size.width * 0.3, y: size.height * 0.2),
                       control2: CGPoint(x: size.width * 0.6, y: size.height * 0.9))
            p.move(to: CGPoint(x: size.width * 0.45, y: size.height * 0.55))
            p.addLine(to: CGPoint(x: size.width * 0.55, y: 0))
            ctx.stroke(p, with: .color(.black.opacity(0.5)), style: StrokeStyle(lineWidth: 6, lineCap: .round))
            ctx.stroke(p, with: .color(Color(hex: current)), style: StrokeStyle(lineWidth: 3.5, lineCap: .round))
        }
        .frame(height: 60)
        .background(LinearGradient(colors: [Color(hex: "#2F4A2A"), Color(hex: "#4B5A33"), Color(hex: "#3A4E2E")],
                                   startPoint: .topLeading, endPoint: .bottomTrailing),
                    in: RoundedRectangle(cornerRadius: 12))
    }
}
