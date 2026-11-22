import SwiftUI

struct RoundPresentationView: View {
    let round: TransitRound
    let nowMs: Int64?
    let legacyWinPoints: Int
    var isVotingPaused = false

    @Environment(\.dynamicTypeSize) private var typeSize
    @ScaledMetric(relativeTo: .largeTitle) private var estimateSize = 56.0

    private enum Phase {
        case open, paused, locked, settled, tied, canceled, skipped, unconfirmed, voided

        var title: String {
            switch self {
            case .open: "Voting open"
            case .paused: "Voting paused"
            case .locked: "Voting closed"
            case .settled: "Round settled"
            case .tied: "Board tie"
            case .canceled: "Trip canceled"
            case .skipped: "Stop skipped"
            case .unconfirmed: "Arrival unconfirmed"
            case .voided: "Round voided"
            }
        }

        var symbol: String {
            switch self {
            case .open: "bolt.fill"
            case .paused: "pause.circle.fill"
            case .locked: "lock.fill"
            case .settled: "checkmark.circle.fill"
            case .tied: "equal.circle.fill"
            case .canceled: "xmark.octagon.fill"
            case .skipped: "arrow.turn.up.right"
            case .unconfirmed: "questionmark.circle.fill"
            case .voided: "minus.circle.fill"
            }
        }

        var tint: Color {
            switch self {
            case .open: BoardColor.signal
            case .locked, .voided: BoardColor.secondary
            case .settled: BoardColor.mint
            case .paused, .tied, .unconfirmed: BoardColor.warning
            case .canceled, .skipped: BoardColor.danger
            }
        }

        var identifier: String {
            switch self {
            case .open: "round.open"
            case .paused: "round.paused"
            case .locked: "round.locked"
            case .settled: "round.settled"
            case .tied: "round.tied"
            case .canceled: "round.canceled"
            case .skipped: "round.skipped"
            case .unconfirmed: "round.unconfirmed"
            case .voided: "round.voided"
            }
        }
    }

    private var phase: Phase {
        switch round.status {
        case .open:
            if nowMs.map({ $0 >= round.voteClosesAtMs }) == true { .locked }
            else { isVotingPaused ? .paused : .open }
        case .locked: .locked
        case .settled: round.outcome == .board ? .tied : .settled
        case .void:
            switch round.voidReason {
            case .canceled: .canceled
            case .skipped: .skipped
            case .unconfirmed: .unconfirmed
            case nil: .voided
            }
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            switch round.status {
            case .open, .locked:
                estimate
                arrivalCountdown
                savedPrediction
            case .settled:
                if let outcome = round.outcome {
                    Text(outcome.title)
                        .font(.largeTitle.weight(.bold))
                        .foregroundStyle(phase.tint)
                        .accessibilityAddTraits(.isHeader)
                        .accessibilityIdentifier("round.outcome")
                }
                resultTimes
                finishedPrediction
            case .void:
                resultTimes
                finishedPrediction
            }
        }
        .boardCard()
    }

    private var header: some View {
        let layout = typeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 6))
            : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 10))

        return layout {
            Label(phase.title, systemImage: phase.symbol)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(phase.tint)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 9)
                .padding(.vertical, 5)
                .background(phase.tint.opacity(0.12), in: Capsule())
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(phase.title)
                .accessibilityIdentifier(phase.identifier)

            if round.status == .open, let nowMs, nowMs < round.voteClosesAtMs {
                if !typeSize.isAccessibilitySize { Spacer(minLength: 0) }
                countdown("Closes in", spokenTitle: "Voting closes in", milliseconds: round.voteClosesAtMs - nowMs)
            }
        }
    }

    private var estimate: some View {
        let minutes = round.openingEstimateMs / 60_000
        return VStack(alignment: .leading, spacing: 2) {
            Text("Opening estimate")
                .font(.subheadline)
                .foregroundStyle(BoardColor.secondary)
                .accessibilityHidden(true)
            Text("\(minutes) min")
                .font(.system(size: estimateSize, weight: .bold, design: .monospaced))
                .foregroundStyle(BoardColor.primary)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityLabel("Opening estimate, \(minutes) \(minutes == 1 ? "minute" : "minutes")")
                .accessibilityIdentifier("round.estimate")
        }
    }

    @ViewBuilder
    private var arrivalCountdown: some View {
        if let nowMs {
            if nowMs < round.targetAtMs {
                countdown("Board due in", spokenTitle: "Board estimate in", milliseconds: round.targetAtMs - nowMs)
            } else {
                Label("Waiting for arrival", systemImage: "clock")
                    .font(.subheadline)
                    .foregroundStyle(BoardColor.secondary)
            }
        }
    }

    private func countdown(_ title: String, spokenTitle: String, milliseconds: Int64) -> some View {
        let duration = BoardDuration(milliseconds: milliseconds, countingDown: true)
        return Text("\(title) \(duration.clockText)")
            .font(.subheadline.monospacedDigit())
            .foregroundStyle(BoardColor.secondary)
            .accessibilityLabel("\(spokenTitle), \(duration.spoken)")
    }

    @ViewBuilder
    private var savedPrediction: some View {
        if let pick = round.pick {
            Divider().overlay(BoardColor.border)
            VStack(alignment: .leading, spacing: 4) {
                Label("\(pick.title) locked in", systemImage: "checkmark.circle.fill")
                    .font(.headline)
                    .foregroundStyle(BoardColor.mint)
                    .accessibilityIdentifier("round.savedPrediction")
                if let wager = round.wagerCredits {
                    Text("\(creditAmount(wager)) wagered")
                        .font(.subheadline)
                        .foregroundStyle(BoardColor.secondary)
                        .accessibilityIdentifier("round.savedWager")
                }
            }
        }
    }

    private var resultTimes: some View {
        let layout = typeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8))
            : AnyLayout(HStackLayout(alignment: .top, spacing: 24))

        return layout {
            timing("Board estimate", value: round.openingEstimateMs)
            if let actual = round.actualWaitMs {
                timing("Actual wait", value: actual)
            }
        }
    }

    private func timing(_ title: String, value: Int64) -> some View {
        let duration = BoardDuration(milliseconds: value)
        return VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(.subheadline)
                .foregroundStyle(BoardColor.secondary)
            Text(duration.clockText)
                .font(.title2.weight(.bold).monospacedDigit())
                .foregroundStyle(BoardColor.primary)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(title), \(duration.spoken)")
    }

    @ViewBuilder
    private var finishedPrediction: some View {
        if let pick = round.pick {
            Divider().overlay(BoardColor.border)
            VStack(alignment: .leading, spacing: 4) {
                Text("You picked \(pick.title)")
                    .font(.subheadline)
                    .foregroundStyle(BoardColor.secondary)
                    .accessibilityIdentifier("round.savedPrediction")
                if let wager = round.wagerCredits, let change = round.creditChange {
                    Text(payout(stake: wager, change: change))
                        .font(.headline)
                        .foregroundStyle(change > 0 ? BoardColor.mint : BoardColor.primary)
                        .accessibilityIdentifier("round.payout")
                } else if round.wagerCredits == nil && round.pointEarned {
                    Text(pointAmount(legacyWinPoints))
                        .font(.headline)
                        .foregroundStyle(BoardColor.mint)
                        .accessibilityIdentifier("round.payout")
                }
            }
        }
    }

    private func payout(stake: Int, change: Int) -> String {
        if change > 0 { return "Won \(creditAmount(change))" }
        if change < 0 { return "Lost \(creditAmount(stake))" }
        return "Refunded \(creditAmount(stake))"
    }
}

struct CrowdSplitView: View {
    let split: CrowdSplit

    @Environment(\.dynamicTypeSize) private var typeSize

    private var soonerShare: Double {
        let total = split.sooner + split.later
        return total > 0 ? Double(split.sooner) / Double(total) : 0
    }

    var body: some View {
        let layout = typeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 6))
            : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 8))

        return VStack(alignment: .leading, spacing: 8) {
            Text("Crowd split")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(BoardColor.primary)
            layout {
                Text("Sooner \(split.sooner)")
                    .foregroundStyle(BoardColor.signal)
                if !typeSize.isAccessibilitySize { Spacer(minLength: 0) }
                Text("Later \(split.later)")
                    .foregroundStyle(BoardColor.mint)
            }
            .font(.subheadline.monospacedDigit())

            if split.sooner + split.later > 0 {
                GeometryReader { geometry in
                    ZStack(alignment: .leading) {
                        Rectangle().fill(BoardColor.mint)
                        Rectangle()
                            .fill(BoardColor.signal)
                            .frame(width: geometry.size.width * soonerShare)
                    }
                    .clipShape(Capsule())
                }
                .frame(height: 4)
            }
        }
        .boardCard()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Crowd split, \(split.sooner) Sooner, \(split.later) Later")
        .accessibilityIdentifier("round.split")
    }
}
