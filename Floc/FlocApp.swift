import SwiftUI

@main
struct FlocApp: App {
    var body: some Scene {
        WindowGroup {
            MapListView()
                .preferredColorScheme(.dark)
        }
    }
}
