import SwiftUI
import UIKit

/// The look of the floc dashboard (editor/src/styles.css): near-black, rounded floating cards,
/// square tool buttons, one lime accent.
enum Theme {
    static let bg = Color(hex: "#0C0D0E")
    static let card = Color(hex: "#151617").opacity(0.96)
    static let cardSolid = Color(hex: "#151617")
    static let tile = Color(hex: "#111213")
    static let sq = Color(hex: "#1A1C1E")
    static let btn = Color(hex: "#2A2C2F")
    static let line = Color.white.opacity(0.07)
    static let text = Color(hex: "#F2F3F4")
    static let text2 = Color(hex: "#C9CDD1")
    static let muted = Color(hex: "#9EA4AA")
    static let faint = Color(hex: "#7A8086")
    static let lime = Color(hex: "#D4F56A")
    static let danger = Color(hex: "#FF6B6B")

    static let limeHex = "#D4F56A"
    /// Same choices as the Beloopbaar palette in the dashboard.
    static let pathPalette = ["#D4F56A", "#A3E635", "#FACC15", "#5EEAD4", "#F2F3F4", "#93C5FD", "#F472B6", "#FF8A4C"]
}

extension Color {
    init(hex: String) { self.init(uiColor: UIColor(hex: hex)) }
}

extension UIColor {
    convenience init(hex: String) {
        var s = hex.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: "#", with: "")
        if s.count == 3 { s = s.map { "\($0)\($0)" }.joined() }
        var v: UInt64 = 0
        Scanner(string: s).scanHexInt64(&v)
        self.init(red: CGFloat((v >> 16) & 0xFF) / 255, green: CGFloat((v >> 8) & 0xFF) / 255,
                  blue: CGFloat(v & 0xFF) / 255, alpha: 1)
    }

    var hex: String {
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        getRed(&r, green: &g, blue: &b, alpha: &a)
        func c(_ x: CGFloat) -> Int { Int((min(1, max(0, x)) * 255).rounded()) }
        return String(format: "#%02X%02X%02X", c(r), c(g), c(b))
    }

    /// Black or white, whichever reads better on this colour.
    var onColor: UIColor {
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        getRed(&r, green: &g, blue: &b, alpha: &a)
        return (0.299 * r + 0.587 * g + 0.114 * b) > 0.6 ? UIColor(hex: "#0C0D0E") : .white
    }
}

// MARK: - Building blocks

/// Rounded floating card.
struct CardBackground: ViewModifier {
    var radius: CGFloat = 20
    func body(content: Content) -> some View {
        content
            .background(Theme.card, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous).stroke(Theme.line))
            .shadow(color: .black.opacity(0.35), radius: 18, y: 6)
    }
}

extension View {
    func card(radius: CGFloat = 20) -> some View { modifier(CardBackground(radius: radius)) }
}

/// Square tool button (48×48, radius 14). `on` = lime.
struct SquareButton: View {
    let symbol: String
    var on = false
    var size: CGFloat = 48
    let label: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: size * 0.38, weight: .semibold))
                .frame(width: size, height: size)
                .foregroundStyle(on ? Theme.bg : Theme.text2)
                .background(on ? Theme.lime : Theme.sq, in: RoundedRectangle(cornerRadius: size * 0.29, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: size * 0.29, style: .continuous).stroke(Color.white.opacity(on ? 0 : 0.06)))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}

/// Wide button: lime = primary action, otherwise grey.
struct PillButton: View {
    let title: String
    var symbol: String?
    var lime = false
    var danger = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if let symbol { Image(systemName: symbol).font(.system(size: 14, weight: .semibold)) }
                Text(title).font(.system(size: 15, weight: lime ? .semibold : .medium)).lineLimit(1)
            }
            .frame(maxWidth: .infinity)
            .frame(height: 46)
            .foregroundStyle(lime ? Theme.bg : danger ? Theme.danger : Theme.text)
            .background(lime ? Theme.lime : danger ? Theme.danger.opacity(0.14) : Theme.btn,
                        in: RoundedRectangle(cornerRadius: 13, style: .continuous))
        }
        .buttonStyle(.plain)
    }
}

/// Small filter chip with a coloured dot.
struct Chip: View {
    let title: String
    var color: Color?
    var symbol: String?
    var on = false
    var dashed = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 7) {
                if let symbol { Image(systemName: symbol).font(.system(size: 12, weight: .semibold)) }
                else if let color { Circle().fill(color).frame(width: 9, height: 9) }
                Text(title).font(.system(size: 13, weight: .medium)).lineLimit(1)
            }
            .padding(.horizontal, 12)
            .frame(height: 34)
            .foregroundStyle(on ? Theme.bg : dashed ? Theme.muted : Color(hex: "#E3E6E8"))
            .background(on ? Theme.text : Theme.tile, in: RoundedRectangle(cornerRadius: 11, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 11, style: .continuous)
                .stroke(Color.white.opacity(dashed ? 0.18 : 0.06), style: StrokeStyle(lineWidth: 1, dash: dashed ? [4, 3] : [])))
        }
        .buttonStyle(.plain)
    }
}

/// Small uppercase section label.
struct Eyebrow: View {
    let text: String
    init(_ text: String) { self.text = text }
    var body: some View {
        Text(text.uppercased())
            .font(.system(size: 11, weight: .semibold))
            .tracking(0.7)
            .foregroundStyle(Theme.faint)
    }
}

/// Round category badge with its short label (like the dashboard's map markers).
struct CategoryBadge: View {
    let color: UIColor
    let label: String
    var size: CGFloat = 40

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.3, style: .continuous).fill(Color(uiColor: color))
            Text(label)
                .font(.system(size: label.count > 2 ? size * 0.24 : size * 0.36, weight: .heavy))
                .minimumScaleFactor(0.5)
                .lineLimit(1)
                .padding(.horizontal, 3)
                .foregroundStyle(Color(uiColor: color.onColor))
        }
        .frame(width: size, height: size)
    }
}

/// A saved place's round icon.
struct PlaceBadge: View {
    let kind: PlaceKind
    var size: CGFloat = 40
    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.3, style: .continuous).fill(Color(uiColor: kind.color))
            Image(systemName: kind.symbol)
                .font(.system(size: size * 0.42, weight: .semibold))
                .foregroundStyle(Color(uiColor: kind.color.onColor))
        }
        .frame(width: size, height: size)
    }
}
