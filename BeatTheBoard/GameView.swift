import SwiftUI

enum BoardColor {
    static let background = Color(red: 0.035, green: 0.065, blue: 0.055)
    static let surface = Color(red: 0.070, green: 0.110, blue: 0.092)
    static let surfaceRaised = Color(red: 0.105, green: 0.155, blue: 0.127)
    static let border = Color(red: 0.23, green: 0.31, blue: 0.27)
    static let primary = Color(red: 0.95, green: 0.98, blue: 0.94)
    static let secondary = Color(red: 0.69, green: 0.77, blue: 0.72)
    static let signal = Color(red: 0.83, green: 0.98, blue: 0.45)
    static let mint = Color(red: 0.50, green: 0.90, blue: 0.73)
    static let warning = Color(red: 1, green: 0.79, blue: 0.49)
    static let danger = Color(red: 1, green: 0.64, blue: 0.62)

    static func line(_ line: TransitLine) -> Color {
        switch line {
        case .red: Color(red: 1, green: 0.56, blue: 0.56)
        case .orange: Color(red: 1, green: 0.69, blue: 0.34)
        case .blue: Color(red: 0.51, green: 0.77, blue: 1)
        case .green: Color(red: 0.53, green: 0.88, blue: 0.65)
        case .mattapan: Color(red: 1, green: 0.59, blue: 0.75)
        }
    }
}

struct BoardDuration {
    let seconds: Int64

    init(milliseconds: Int64, countingDown: Bool = false) {
        let remaining = max(0, milliseconds)
        seconds = (remaining + (countingDown ? 999 : 0)) / 1000
    }

    var clockText: String {
        let remainder = seconds % 60
        return "\(seconds / 60):\(remainder < 10 ? "0" : "")\(remainder)"
    }

    var spoken: String {
        let minutes = seconds / 60
        let remainder = seconds % 60
        return "\(minutes) \(minutes == 1 ? "minute" : "minutes"), \(remainder) \(remainder == 1 ? "second" : "seconds")"
    }
}

func creditAmount(_ count: Int) -> String {
    "\(count.formatted()) \(count == 1 ? "credit" : "credits")"
}

func pointAmount(_ count: Int) -> String {
    let signed = count > 0 ? "+\(count.formatted())" : count.formatted()
    return "\(signed) \(count.magnitude == 1 ? "point" : "points")"
}

extension View {
    func boardCard() -> some View {
        padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(BoardColor.surface, in: RoundedRectangle(cornerRadius: 20))
            .overlay {
                RoundedRectangle(cornerRadius: 20)
                    .strokeBorder(BoardColor.border, lineWidth: 1)
                    .allowsHitTesting(false)
            }
    }
}

@MainActor
struct GameView: View {
    @ObservedObject var game: GameModel
    @Environment(\.scenePhase) private var phase
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var sheet: HomeSheet?

    private enum HomeSheet: String, Identifiable {
        case settings, stations, activity
        var id: Self { self }
    }

    private struct PollID: Equatable {
        let session: UUID
        let active: Bool
    }

    var body: some View {
        let poll = PollID(session: game.sessionID, active: phase == .active)

        NavigationStack {
            ScrollView {
                VStack(spacing: 12) {
                    header
                    stationAndMode
                    if let round = game.round {
                        if round.status == .open || round.status == .locked {
                            TimelineView(.periodic(from: .now, by: 0.25)) { _ in
                                roundArea(round, nowMs: game.nowMs)
                            }
                        } else {
                            roundArea(round, nowMs: nil)
                        }
                    } else {
                        waitingBoard
                    }
                    walletAction
                    if game.connectionProblem != nil { connectionNotice }
                    activityButton
                }
                .frame(maxWidth: 540)
                .padding(.horizontal, 16)
                .padding(.top, 6)
                .padding(.bottom, 24)
                .frame(maxWidth: .infinity)
            }
            .background {
                LinearGradient(
                    colors: [BoardColor.surface, BoardColor.background],
                    startPoint: .top, endPoint: .center
                )
                .ignoresSafeArea()
            }
            .foregroundStyle(BoardColor.primary)
            .toolbar(.hidden, for: .navigationBar)
        }
        .tint(BoardColor.signal)
        .sheet(item: $sheet) { presented in
            switch presented {
            case .settings:
                ServerSettingsView(server: game.selection.server, save: game.setServer)
            case .stations:
                StationPickerView(platforms: game.platforms, selectedPlatformID: game.selection.platformID) { platform in
                    game.setPlatform(platform.id)
                    sheet = nil
                }
            case .activity:
                GameActivityView(game: game) { sheet = nil }
            }
        }
        .task(id: poll) {
            guard poll.active else { return }
            await game.pollWhileActive(session: poll.session)
        }
    }

    private var header: some View {
        let layout = typeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 4))
            : AnyLayout(HStackLayout(spacing: 8))

        return layout {
            Text("Beat the Board")
                .font(.title2.weight(.bold))
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityAddTraits(.isHeader)

            HStack(spacing: 6) {
                if let wallet = game.wallet {
                    Label {
                        Text(creditAmount(wallet.balance))
                            .font(.caption.weight(.bold).monospacedDigit())
                            .fixedSize(horizontal: false, vertical: true)
                    } icon: {
                        Image(systemName: "circle.hexagongrid.fill")
                            .accessibilityHidden(true)
                    }
                    .padding(.horizontal, 12)
                    .frame(minHeight: 44)
                    .foregroundStyle(BoardColor.signal)
                    .background(BoardColor.surfaceRaised, in: Capsule())
                    .overlay { Capsule().strokeBorder(BoardColor.border, lineWidth: 1) }
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("Available credits")
                    .accessibilityValue(creditAmount(wallet.balance))
                    .accessibilityIdentifier("home.wallet")
                }

                Button {
                    sheet = .settings
                } label: {
                    Image(systemName: "gearshape")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(BoardColor.secondary)
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Settings")
                .accessibilityIdentifier("home.settings")
            }
        }
    }

    private var stationAndMode: some View {
        let layout = typeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 2))
            : AnyLayout(HStackLayout(spacing: 8))

        return layout {
            stationButton
            modeMenu
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 3)
        .background(BoardColor.surface, in: RoundedRectangle(cornerRadius: 16))
        .overlay {
            RoundedRectangle(cornerRadius: 16)
                .strokeBorder(BoardColor.border, lineWidth: 1)
                .allowsHitTesting(false)
        }
    }

    private var stationButton: some View {
        Button {
            sheet = .stations
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "tram.fill")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(game.platform.map { BoardColor.line($0.line) } ?? BoardColor.secondary)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(game.platform?.station ?? "Choose a station")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(BoardColor.primary)
                    if let platform = game.platform {
                        Text("\(platform.serviceTitle) · \(platform.direction)")
                            .font(.caption)
                            .foregroundStyle(BoardColor.secondary)
                    }
                }
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                Image(systemName: "chevron.right")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(BoardColor.secondary)
                    .accessibilityHidden(true)
            }
            .padding(.vertical, 5)
            .padding(.leading, 2)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(game.platforms.isEmpty)
        .accessibilityLabel("Choose station")
        .accessibilityValue(game.platform.map { "\($0.station), \($0.serviceTitle), \($0.direction)" } ?? "")
        .accessibilityIdentifier("home.station")
    }

    private var modeMenu: some View {
        let isLive = game.selection.mode == .live
        let accent = isLive ? BoardColor.mint : BoardColor.signal

        return Menu {
            Picker("Game mode", selection: Binding(get: { game.selection.mode }, set: { game.setMode($0) })) {
                ForEach(GameMode.allCases) { mode in Text(mode.title).tag(mode) }
            }
        } label: {
            HStack(spacing: 5) {
                Circle().fill(accent).frame(width: 6, height: 6)
                    .accessibilityHidden(true)
                Text(isLive ? "Live" : "Demo")
                    .font(.caption.weight(.bold))
                Image(systemName: "chevron.down")
                    .font(.caption2.weight(.semibold))
                    .accessibilityHidden(true)
            }
            .fixedSize(horizontal: true, vertical: false)
            .foregroundStyle(accent)
            .padding(.horizontal, 8)
            .frame(minWidth: 44, minHeight: 44)
            .contentShape(Rectangle())
        }
        .accessibilityLabel("Game mode")
        .accessibilityValue(game.selection.mode.title)
        .accessibilityIdentifier("home.mode")
    }

    private var waitingBoard: some View {
        Group {
            if game.hasReceivedBoard {
                Label("Waiting for a 4-minute estimate", systemImage: "clock")
                    .font(.headline)
            } else if game.connectionProblem == nil {
                ProgressView("Connecting to the board")
                    .font(.subheadline)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, game.connectionProblem == nil ? 12 : 0)
    }

    private func roundArea(_ round: TransitRound, nowMs: Int64?) -> some View {
        let canPredict = round.status == .open && round.pick == nil &&
            nowMs.map { $0 < round.voteClosesAtMs } == true

        return VStack(spacing: 12) {
            RoundPresentationView(round: round, nowMs: nowMs, legacyWinPoints: game.wallet?.creditsPerStep ?? 1)

            if canPredict, let wallet = game.wallet, wallet.maxWagerCredits >= wallet.creditsPerStep {
                PredictionPanel(wallet: wallet, isSaving: game.pendingPick != nil, isRefilling: game.pendingRefill) { pick, credits in
                    guard game.round?.id == round.id else { return }
                    game.choose(pick, wagerCredits: credits)
                }
                .id(round.id)
            } else if game.pendingPick != nil {
                ProgressView("Locking in prediction")
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else if canPredict && game.hasReceivedBoard && game.wallet == nil && game.connectionProblem == nil {
                VStack(alignment: .leading, spacing: 6) {
                    Label("Wagers unavailable", systemImage: "exclamationmark.circle")
                        .font(.headline)
                        .foregroundStyle(BoardColor.warning)
                    Text("Update and restart the game server to place a wager.")
                        .font(.subheadline)
                        .foregroundStyle(BoardColor.secondary)
                }
                .boardCard()
            }

            if let problem = game.pickProblem {
                Label(problem, systemImage: "exclamationmark.circle")
                    .font(.subheadline)
                    .foregroundStyle(BoardColor.warning)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if let split = round.split { CrowdSplitView(split: split) }
        }
    }

    @ViewBuilder
    private var walletAction: some View {
        if let wallet = game.wallet, wallet.balance == 0 {
            VStack(alignment: .leading, spacing: 6) {
                if game.pendingRefill {
                    ProgressView("Refilling credits")
                } else if wallet.canRefill {
                    Button {
                        game.refillCredits()
                    } label: {
                        Text("Refill credits")
                            .font(.subheadline.weight(.semibold))
                            .frame(minWidth: 44, minHeight: 44, alignment: .leading)
                            .contentShape(Rectangle())
                    }
                    .accessibilityHint("Add free credits to keep playing")
                } else {
                    Label("Credits held in open wagers", systemImage: "lock")
                        .font(.subheadline)
                        .foregroundStyle(BoardColor.secondary)
                }
                if let problem = game.refillProblem {
                    Text(problem)
                        .font(.footnote)
                        .foregroundStyle(BoardColor.warning)
                }
            }
            .boardCard()
        }
    }

    private var connectionNotice: some View {
        VStack(alignment: .leading, spacing: 4) {
            Label(game.hasReceivedBoard ? "Connection interrupted" : "Can’t reach the board", systemImage: "wifi.exclamationmark")
                .font(.headline)
                .foregroundStyle(BoardColor.warning)
            Text("Check your connection or the server address.")
                .font(.subheadline)
                .foregroundStyle(BoardColor.secondary)
            Button {
                sheet = .settings
            } label: {
                Text("Server settings")
                    .font(.subheadline.weight(.semibold))
                    .frame(minWidth: 44, minHeight: 44, alignment: .leading)
                    .contentShape(Rectangle())
            }
        }
        .boardCard()
    }

    private var activityButton: some View {
        Button {
            sheet = .activity
        } label: {
            HStack(spacing: 10) {
                Label("Activity", systemImage: "chart.bar.xaxis")
                    .font(.subheadline.weight(.semibold))
                    .frame(maxWidth: .infinity, alignment: .leading)
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .accessibilityHidden(true)
            }
            .foregroundStyle(BoardColor.secondary)
            .padding(.horizontal, 12)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityHint("Previous results, standings, and recent waits")
        .accessibilityIdentifier("home.activity")
    }
}

private struct PredictionPanel: View {
    let wallet: Wallet
    let isSaving: Bool
    let isRefilling: Bool
    let submit: (Pick, Int) -> Void

    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var choice: Pick?
    @State private var wagerSteps = 1

    private var isBusy: Bool { isSaving || isRefilling }
    private var maxSteps: Int { wallet.maxWagerCredits / wallet.creditsPerStep }
    private var visibleSteps: Int { min(wagerSteps, maxSteps) }
    private var stake: Int { visibleSteps * wallet.creditsPerStep }

    var body: some View {
        let optionLayout = typeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(spacing: 8))
            : AnyLayout(HStackLayout(spacing: 8))

        VStack(alignment: .leading, spacing: 12) {
            Text("Your prediction")
                .font(.headline)
                .accessibilityAddTraits(.isHeader)

            optionLayout {
                ForEach(Pick.allCases) { pick in
                    PredictionOption(pick: pick, isSelected: choice == pick) {
                        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.16)) {
                            choice = pick
                        }
                    }
                    .disabled(isBusy)
                }
            }

            WagerControl(stake: stake, canDecrease: visibleSteps > 1, canIncrease: visibleSteps < maxSteps) { step in
                wagerSteps = min(max(1, visibleSteps + step), maxSteps)
            }
            .disabled(isBusy)

            Button {
                guard let choice else { return }
                submit(choice, stake)
            } label: {
                Group {
                    if isSaving {
                        ProgressView("Locking in prediction")
                            .tint(BoardColor.signal)
                    } else {
                        Label("Lock in prediction", systemImage: "lock.fill")
                    }
                }
                .font(.headline)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .frame(maxWidth: .infinity, minHeight: 52)
                .foregroundStyle(choice == nil || isBusy ? BoardColor.secondary : BoardColor.background)
                .background(choice == nil || isBusy ? BoardColor.surfaceRaised : BoardColor.signal, in: RoundedRectangle(cornerRadius: 14))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(choice == nil || isBusy)
            .accessibilityHint(choice.map { "Wager \(creditAmount(stake)) on \($0.title)" } ?? "Choose Sooner or Later first")
            .accessibilityIdentifier("prediction.lockIn")

            Text("A win pays double. Within 30 seconds, the board wins.")
                .font(.footnote)
                .foregroundStyle(BoardColor.secondary)
        }
        .boardCard()
    }
}

private struct PredictionOption: View {
    let pick: Pick
    let isSelected: Bool
    let action: () -> Void

    private var accent: Color { pick == .sooner ? BoardColor.signal : BoardColor.mint }
    private var guidance: String { pick == .sooner ? "More than 30 sec early" : "More than 30 sec late" }

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Image(systemName: pick == .sooner ? "arrow.down.right" : "arrow.up.right")
                        .font(.subheadline.weight(.semibold))
                    Spacer(minLength: 4)
                    if isSelected {
                        Image(systemName: "checkmark.circle.fill")
                            .font(.subheadline.weight(.semibold))
                    }
                }
                .foregroundStyle(accent)
                .accessibilityHidden(true)
                Text(pick.title)
                    .font(.body.weight(.bold))
                    .foregroundStyle(BoardColor.primary)
                Text(guidance)
                    .font(.caption)
                    .foregroundStyle(BoardColor.secondary)
            }
            .frame(maxWidth: .infinity, minHeight: 56, alignment: .leading)
            .padding(10)
            .background(isSelected ? accent.opacity(0.11) : BoardColor.surfaceRaised, in: RoundedRectangle(cornerRadius: 12))
            .overlay {
                RoundedRectangle(cornerRadius: 12)
                    .strokeBorder(isSelected ? accent : BoardColor.border, lineWidth: isSelected ? 2 : 1)
                    .allowsHitTesting(false)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(pick.title)
        .accessibilityHint(pick == .sooner ? "More than 30 seconds early" : "More than 30 seconds late")
        .accessibilityAddTraits(isSelected ? .isSelected : [])
        .accessibilityIdentifier("prediction.\(pick.rawValue)")
    }
}

private struct WagerControl: View {
    let stake: Int
    let canDecrease: Bool
    let canIncrease: Bool
    let adjust: (Int) -> Void

    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let layout = typeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 6))
            : AnyLayout(HStackLayout(spacing: 10))

        return layout {
            VStack(alignment: .leading, spacing: 2) {
                Text("Wager")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(BoardColor.secondary)
                    .accessibilityHidden(true)
                Text(creditAmount(stake))
                    .font(.body.weight(.bold).monospacedDigit())
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityLabel("Wager, \(creditAmount(stake))")
                    .accessibilityIdentifier("wager.amount")
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            HStack(spacing: 6) {
                adjustmentButton("minus", label: "Decrease wager", id: "wager.decrease", step: -1, enabled: canDecrease)
                adjustmentButton("plus", label: "Increase wager", id: "wager.increase", step: 1, enabled: canIncrease)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 4)
        .background(BoardColor.background, in: RoundedRectangle(cornerRadius: 12))
    }

    private func adjustmentButton(_ symbol: String, label: String, id: String, step: Int, enabled: Bool) -> some View {
        Button {
            adjust(step)
        } label: {
            Image(systemName: symbol)
                .font(.body.weight(.semibold))
                .foregroundStyle(enabled ? BoardColor.signal : BoardColor.secondary)
                .frame(width: 44, height: 44)
                .background(BoardColor.surfaceRaised, in: RoundedRectangle(cornerRadius: 10))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .buttonRepeatBehavior(.enabled)
        .disabled(!enabled)
        .accessibilityLabel(label)
        .accessibilityIdentifier(id)
    }
}
