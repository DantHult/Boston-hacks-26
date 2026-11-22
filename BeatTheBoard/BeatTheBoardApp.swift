import SwiftUI

@main
@MainActor
struct BeatTheBoardApp: App {
    @StateObject private var game = GameModel()

    var body: some Scene {
        WindowGroup {
            GameView(game: game)
                .preferredColorScheme(.dark)
        }
    }
}
