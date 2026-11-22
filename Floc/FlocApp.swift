import SwiftUI

@main
struct FlocApp: App {
    @StateObject private var session = Session.shared

    /// `-openMap` (testing) opens a bundled map without signing in.
    private var skipLogin: Bool { ProcessInfo.processInfo.arguments.contains("-openMap") }

    /// Testing: `-login <email> <password>` signs in at launch.
    private func testLogin() async {
        let a = ProcessInfo.processInfo.arguments
        guard let i = a.firstIndex(of: "-login"), i + 2 < a.count, !session.signedIn else { return }
        if let r = try? await Backend.login(email: a[i + 1], password: a[i + 2]) { session.signedIn(r) }
    }

    var body: some Scene {
        WindowGroup {
            Group {
                if session.signedIn || skipLogin { MapListView() } else { AccountView() }
            }
            .preferredColorScheme(.dark)
            .task { await testLogin() }
        }
    }
}
