import SwiftUI

@MainActor
struct GameActivityView: View {
    @ObservedObject var game: GameModel
    let onDone: () -> Void
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    riderContext

                    if let line = game.platform?.line {
                        leaderboard(line: line)
                    }

                    if let round = game.lastResult {
                        VStack(alignment: .leading, spacing: 12) {
                            sectionHeading("Previous round", symbol: "clock.arrow.circlepath", id: "activity.history")
                            RoundPresentationView(
                                round: round,
                                nowMs: nil,
                                legacyWinPoints: game.wallet?.creditsPerStep ?? 1
                            )
                        }
                    }

                    if game.selection.mode == .live, !game.recentWaitsMs.isEmpty {
                        recentWaits
                    }
                }
                .frame(maxWidth: 540)
                .padding(.horizontal, 16)
                .padding(.vertical, 16)
                .frame(maxWidth: .infinity)
            }
            .accessibilityIdentifier("activity.sheet")
            .background(BoardColor.background.ignoresSafeArea())
            .foregroundStyle(BoardColor.primary)
            .navigationTitle("Activity")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(action: onDone) {
                        Text("Done")
                            .frame(minWidth: 44, minHeight: 44)
                            .contentShape(Rectangle())
                    }
                    .accessibilityIdentifier("activity.done")
                }
            }
        }
        .tint(BoardColor.signal)
    }

    private var riderContext: some View {
        let layout = typeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 6))
            : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 12))

        return layout {
            if let nickname = game.nickname {
                Label(nickname, systemImage: "person.crop.circle")
                    .font(.headline)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityLabel("Playing as \(nickname)")
            }

            Text(game.selection.mode.title)
                .font(.subheadline)
                .foregroundStyle(BoardColor.secondary)
        }
    }

    private func leaderboard(line: TransitLine) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            sectionHeading("\(line.title) leaderboard", symbol: "trophy", id: "activity.leaderboard")

            VStack(alignment: .leading, spacing: 10) {
                if let entries = game.leaderboard {
                    if entries.isEmpty {
                        Text("No points yet.")
                            .font(.subheadline)
                            .foregroundStyle(BoardColor.secondary)
                    }
                    ForEach(Array(entries.enumerated()), id: \.offset) { index, entry in
                        if index > 0 {
                            Divider().overlay(BoardColor.border)
                        }
                        leaderboardRow(rank: index + 1, entry: entry)
                    }
                } else if game.connectionProblem != nil {
                    Text("Standings are unavailable. Check your connection.")
                        .font(.subheadline)
                        .foregroundStyle(BoardColor.secondary)
                } else {
                    ProgressView("Loading standings")
                }
            }
            .boardCard()
        }
    }

    private func leaderboardRow(rank: Int, entry: LeaderboardEntry) -> some View {
        let name = entry.isMe ? "\(entry.nickname) (you)" : entry.nickname
        let points = pointAmount(entry.points)
        let layout = typeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 4))
            : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 12))

        return layout {
            Text("\(rank). \(name)")
                .font(.subheadline.weight(entry.isMe ? .semibold : .regular))
                .frame(maxWidth: .infinity, alignment: .leading)

            Text(points)
                .font(.subheadline.monospacedDigit())
                .foregroundStyle(entry.isMe ? BoardColor.mint : BoardColor.secondary)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Rank \(rank), \(name), \(points)")
    }

    private var recentWaits: some View {
        VStack(alignment: .leading, spacing: 12) {
            sectionHeading("Recent waits from 4 min", symbol: "clock", id: "activity.recentWaits")

            VStack(alignment: .leading, spacing: 10) {
                if let platform = game.platform {
                    Text("\(platform.station) · \(platform.direction)")
                        .font(.subheadline)
                        .foregroundStyle(BoardColor.secondary)
                }

                ForEach(Array(game.recentWaitsMs.enumerated()), id: \.offset) { index, wait in
                    let duration = BoardDuration(milliseconds: wait)
                    Text(duration.clockText)
                        .font(.headline.monospacedDigit())
                        .accessibilityLabel(index == 0 ? "Most recent, \(duration.spoken)" : duration.spoken)
                }
            }
            .boardCard()
        }
    }

    private func sectionHeading(_ title: String, symbol: String, id: String) -> some View {
        Label {
            Text(title)
                .font(.headline)
        } icon: {
            Image(systemName: symbol)
                .foregroundStyle(BoardColor.mint)
                .accessibilityHidden(true)
        }
        .accessibilityAddTraits(.isHeader)
        .accessibilityIdentifier(id)
    }
}
