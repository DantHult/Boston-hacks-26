import Foundation
import SwiftUI

@MainActor
final class GameModel: ObservableObject {
    static let defaultServer = URL(string: "http://127.0.0.1:3000")!

    struct Selection: Equatable {
        var server: URL
        var mode: GameMode
        var platformID: String
    }

    struct StandingsContext: Equatable {
        let sessionID: UUID
        let mode: GameMode
        let line: TransitLine
    }

    private struct ClockReading {
        let clock: ServerClock
        let received = ContinuousClock.now

        var nowMs: Int64 {
            let elapsed = received.duration(to: .now).components
            let milliseconds = Double(elapsed.seconds) * 1000 + Double(elapsed.attoseconds) / 1e15
            return clock.nowMs + Int64(milliseconds * clock.rate)
        }
    }

    @Published private(set) var selection: Selection
    @Published private(set) var sessionID = UUID()
    @Published private(set) var platforms: [Platform] = []
    @Published private(set) var nickname: String?
    @Published private(set) var round: TransitRound?
    @Published private(set) var lastResult: TransitRound?
    @Published private(set) var recentWaitsMs: [Int64] = []
    @Published private(set) var leaderboard: [LeaderboardEntry]?
    @Published private(set) var standingsUnavailable = false
    @Published private(set) var wallet: Wallet?
    @Published private(set) var liveFeed: LiveFeed?
    @Published private(set) var hasReceivedBoard = false
    @Published private(set) var connectionProblem: String?
    @Published private(set) var pickProblem: String?
    @Published private(set) var pendingPick: Pick?
    @Published private(set) var refillProblem: String?
    @Published private(set) var pendingRefill = false
    @Published private(set) var savedGuestRejected = false
    @Published private(set) var pendingGuestReplacement = false
    @Published private(set) var guestReplacementProblem: String?
    @Published private var clock: ClockReading?

    private let defaults: UserDefaults
    private var token: String?
    private var roundRevision = 0

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        selection = Selection(
            server: defaults.string(forKey: "backendURL").flatMap(Self.serverURL) ?? Self.defaultServer,
            mode: defaults.string(forKey: "gameMode").flatMap(GameMode.init(rawValue:)) ?? .demo,
            platformID: defaults.string(forKey: "platformID") ?? "red-ashmont"
        )
    }

    var platform: Platform? { platforms.first { $0.id == selection.platformID } }
    var nowMs: Int64? { clock?.nowMs }
    var canPlaceWager: Bool {
        guard !savedGuestRejected else { return false }
        guard selection.mode == .live else { return true }
        return platform?.supportsArrivalRounds != false && (liveFeed.map { $0.arrivals == .available } ?? true)
    }

    var standingsContext: StandingsContext? {
        guard !savedGuestRejected, token != nil, let line = platform?.line else { return nil }
        return StandingsContext(sessionID: sessionID, mode: selection.mode, line: line)
    }

    nonisolated static func serverURL(_ text: String) -> URL? {
        guard var parts = URLComponents(string: text.trimmingCharacters(in: .whitespacesAndNewlines)),
              let scheme = parts.scheme?.lowercased(), ["http", "https"].contains(scheme),
              let host = parts.host, !host.isEmpty,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              parts.port.map({ (1...65535).contains($0) }) ?? true else { return nil }

        parts.scheme = scheme
        parts.host = host.lowercased()
        if (scheme == "http" && parts.port == 80) || (scheme == "https" && parts.port == 443) {
            parts.port = nil
        }
        let path = parts.percentEncodedPath.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        parts.percentEncodedPath = path.isEmpty ? "" : "/\(path)"
        return parts.url
    }

    func setServer(_ url: URL) {
        guard url != selection.server else { return }
        defaults.set(url.absoluteString, forKey: "backendURL")
        token = nil
        nickname = nil
        platforms = []
        changeSelection(Selection(server: url, mode: selection.mode, platformID: selection.platformID))
    }

    func setMode(_ mode: GameMode) {
        guard mode != selection.mode else { return }
        defaults.set(mode.rawValue, forKey: "gameMode")
        platforms = []
        changeSelection(Selection(server: selection.server, mode: mode, platformID: selection.platformID))
    }

    func setPlatform(_ platformID: String) {
        guard platformID != selection.platformID else { return }
        defaults.set(platformID, forKey: "platformID")
        changeSelection(Selection(server: selection.server, mode: selection.mode, platformID: platformID))
    }

    private func changeSelection(_ newSelection: Selection) {
        selection = newSelection
        sessionID = UUID()
        resetBoard()
        savedGuestRejected = false
        pendingGuestReplacement = false
        guestReplacementProblem = nil
    }

    private func resetBoard() {
        round = nil
        lastResult = nil
        recentWaitsMs = []
        leaderboard = nil
        standingsUnavailable = false
        wallet = nil
        liveFeed = nil
        clock = nil
        hasReceivedBoard = false
        connectionProblem = nil
        pickProblem = nil
        pendingPick = nil
        refillProblem = nil
        pendingRefill = false
    }

    func pollWhileActive(session id: UUID) async {
        let currentSelection = selection
        let client = APIClient(baseURL: currentSelection.server)
        let interval: Duration = currentSelection.mode == .demo ? .milliseconds(500) : .seconds(3)
        while isCurrent(id) {
            await refresh(currentSelection, client: client, session: id)
            do {
                try await Task.sleep(for: savedGuestRejected ? .seconds(2) : interval)
            } catch {
                return
            }
        }
    }

    private func refresh(_ selection: Selection, client: APIClient, session id: UUID) async {
        guard pendingPick == nil, !pendingRefill, !pendingGuestReplacement else { return }
        let revision = roundRevision
        do {
            let credential = try await authenticate(client: client, session: id)
            guard isCurrent(id) else { return }

            if platforms.isEmpty {
                let available = try await client.platforms(mode: selection.mode)
                guard isCurrent(id) else { return }
                platforms = available
                if platform == nil, let first = available.first {
                    setPlatform(first.id)
                    return
                }
            }

            let current = try await client.current(
                mode: selection.mode,
                platformID: selection.platformID,
                token: credential
            )
            guard isCurrent(id), revision == roundRevision else { return }
            if current.round?.id != round?.id || current.round?.pick != nil { pickProblem = nil }
            round = current.round
            lastResult = current.lastResult
            recentWaitsMs = current.recentWaitsMs ?? []
            wallet = current.wallet
            liveFeed = current.liveFeed
            if current.wallet?.canRefill == false { refillProblem = nil }
            clock = ClockReading(clock: current.clock)
            hasReceivedBoard = true
            connectionProblem = nil
            savedGuestRejected = false
            guestReplacementProblem = nil
        } catch {
            guard isCurrent(id), revision == roundRevision else { return }
            if !handleGuestRejection(error) {
                connectionProblem = error.localizedDescription
            }
        }
    }

    func pollStandings(for context: StandingsContext) async {
        guard context == standingsContext, let token else { return }
        let client = APIClient(baseURL: selection.server)
        while isCurrent(context.sessionID), context == standingsContext {
            do {
                let standings = try await client.leaderboard(mode: context.mode, line: context.line, token: token)
                guard isCurrent(context.sessionID), context == standingsContext else { return }
                leaderboard = standings
                standingsUnavailable = false
            } catch {
                guard isCurrent(context.sessionID), context == standingsContext else { return }
                standingsUnavailable = true
            }
            do {
                try await Task.sleep(for: .seconds(5))
            } catch {
                return
            }
        }
    }

    private func handleGuestRejection(_ error: Error) -> Bool {
        guard (error as? APIError)?.status == 401,
              token != nil || (try? GuestKeychain.read(for: selection.server)) != nil else { return false }
        if !savedGuestRejected {
            roundRevision += 1
            resetBoard()
            savedGuestRejected = true
        }
        return true
    }

    func replaceSavedGuest() {
        guard savedGuestRejected, !pendingGuestReplacement else { return }
        let id = sessionID
        let client = APIClient(baseURL: selection.server)
        roundRevision += 1
        pendingGuestReplacement = true
        guestReplacementProblem = nil

        Task {
            defer {
                if sessionID == id { pendingGuestReplacement = false }
            }
            do {
                let created = try await client.createGuest()
                guard isCurrent(id) else { return }
                try GuestKeychain.save(created.token, for: client.baseURL)
                token = created.token
                nickname = created.guest.nickname
                changeSelection(selection)
            } catch {
                guard isCurrent(id) else { return }
                guestReplacementProblem = error.localizedDescription
            }
        }
    }

    private func authenticate(client: APIClient, session id: UUID) async throws -> String {
        if let token { return token }

        let guest: Guest
        let credential: String
        if let saved = try GuestKeychain.read(for: client.baseURL) {
            credential = saved
            guest = try await client.guest(token: saved)
        } else {
            let created = try await client.createGuest()
            guard isCurrent(id) else { throw CancellationError() }
            credential = created.token
            guest = created.guest
            try GuestKeychain.save(credential, for: client.baseURL)
        }
        guard isCurrent(id) else { throw CancellationError() }
        token = credential
        nickname = guest.nickname
        return credential
    }

    func choose(_ choice: Pick, wagerCredits: Int) {
        guard canPlaceWager, let round, let token, let nowMs, nowMs < round.voteClosesAtMs,
              let wallet, wagerCredits > 0, wagerCredits <= wallet.maxWagerCredits,
              wagerCredits.isMultiple(of: wallet.creditsPerStep),
              round.status == .open, round.pick == nil, pendingPick == nil, !pendingRefill else { return }

        let id = sessionID
        let client = APIClient(baseURL: selection.server)
        roundRevision += 1
        pendingPick = choice
        pickProblem = nil
        Task {
            defer {
                if sessionID == id { pendingPick = nil }
            }
            do {
                let response = try await client.pick(
                    roundID: round.id, choice: choice, wagerCredits: wagerCredits, token: token
                )
                guard isCurrent(id) else { return }
                self.round = response.round
                self.wallet = response.wallet
                clock = ClockReading(clock: response.clock)
            } catch {
                guard isCurrent(id) else { return }
                if !handleGuestRejection(error) {
                    pickProblem = error.localizedDescription
                }
            }
        }
    }

    func refillCredits() {
        guard !savedGuestRejected, let token, wallet?.canRefill == true, pendingPick == nil, !pendingRefill else { return }

        let id = sessionID
        let client = APIClient(baseURL: selection.server)
        let mode = selection.mode
        roundRevision += 1
        pendingRefill = true
        refillProblem = nil
        Task {
            defer {
                if sessionID == id { pendingRefill = false }
            }
            do {
                let updated = try await client.refill(mode: mode, token: token)
                guard isCurrent(id) else { return }
                wallet = updated
            } catch {
                guard isCurrent(id) else { return }
                if !handleGuestRejection(error) {
                    refillProblem = error.localizedDescription
                }
            }
        }
    }

    private func isCurrent(_ id: UUID) -> Bool { id == sessionID && !Task.isCancelled }
}
