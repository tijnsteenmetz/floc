import SwiftUI

@main
struct FlocApp: App {
    @StateObject private var session = Session.shared

    /// `-openMap` (testing) opens a bundled map without signing in.
    private var skipLogin: Bool { ProcessInfo.processInfo.arguments.contains("-openMap") }

    var body: some Scene {
        WindowGroup {
            Group {
                if session.signedIn || skipLogin { MapListView() } else { AccountView() }
            }
            .preferredColorScheme(.dark)
        }
    }
}
