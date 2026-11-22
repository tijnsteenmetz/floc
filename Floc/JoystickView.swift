import SwiftUI

/// On-screen thumb joystick. Reports deflection as (x right, y up), each −1…1, and (0,0) on release.
struct JoystickView: View {
    var onChange: (SIMD2<Double>) -> Void
    @State private var knob: CGSize = .zero
    private let radius: CGFloat = 46

    var body: some View {
        ZStack {
            Circle()
                .fill(.ultraThinMaterial)
                .overlay(Circle().stroke(.white.opacity(0.6), lineWidth: 1.5))
                .frame(width: radius * 2, height: radius * 2)
            Circle()
                .fill(.white)
                .shadow(radius: 3)
                .frame(width: 40, height: 40)
                .offset(knob)
        }
        .contentShape(Circle())
        .gesture(
            DragGesture(minimumDistance: 0)
                .onChanged { g in
                    var v = g.translation
                    let len = (v.width * v.width + v.height * v.height).squareRoot()
                    if len > radius { v = CGSize(width: v.width / len * radius, height: v.height / len * radius) }
                    knob = v
                    onChange(SIMD2(Double(v.width / radius), Double(-v.height / radius)))
                }
                .onEnded { _ in
                    withAnimation(.spring(duration: 0.2)) { knob = .zero }
                    onChange(.zero)
                }
        )
    }
}
