import Foundation

enum GameMode: String, CaseIterable, Identifiable, Sendable {
    case demo
    case live

    var id: String { rawValue }

    var title: String {
        switch self {
        case .demo: "Simulated demo"
        case .live: "Live MBTA"
        }
    }
}

enum TransitLine: String, CaseIterable, Decodable, Sendable {
    case red
    case orange
    case blue
    case green
    case mattapan

    var title: String {
        switch self {
        case .red: "Red Line"
        case .orange: "Orange Line"
        case .blue: "Blue Line"
        case .green: "Green Line"
        case .mattapan: "Mattapan Trolley"
        }
    }
}

struct Platform: Decodable, Identifiable, Equatable, Sendable {
    let id: String
    let stationID: String?
    let station: String
    let line: TransitLine
    let direction: String
    let routes: [String]?

    private enum CodingKeys: String, CodingKey {
        case id, station, line, direction, routes
        case stationID = "stationId"
    }
}

enum Pick: String, Encodable, Decodable, CaseIterable, Identifiable, Sendable {
    case sooner
    case later

    var id: String { rawValue }
    var title: String { rawValue.capitalized }
}

enum RoundStatus: String, Decodable, Sendable {
    case open
    case locked
    case settled
    case void
}

enum Outcome: String, Decodable, Sendable {
    case sooner
    case later
    case board

    var title: String {
        switch self {
        case .sooner: "Sooner wins"
        case .later: "Later wins"
        case .board: "The board wins"
        }
    }
}

enum VoidReason: String, Decodable, Sendable {
    case canceled
    case unconfirmed

    var message: String {
        switch self {
        case .canceled: "The trip was canceled."
        case .unconfirmed: "The train’s arrival could not be confirmed."
        }
    }
}

struct CrowdSplit: Decodable, Sendable {
    let sooner: Int
    let later: Int
}

struct TransitRound: Decodable, Sendable {
    let id: String
    let platform: Platform
    let status: RoundStatus
    let targetAtMs: Int64
    let voteClosesAtMs: Int64
    let openingEstimateMs: Int64
    let actualWaitMs: Int64?
    let outcome: Outcome?
    let voidReason: VoidReason?
    let pick: Pick?
    let split: CrowdSplit?
    let pointEarned: Bool
    let wagerCredits: Int?
    let creditChange: Int?
}

struct ServerClock: Decodable, Sendable {
    let nowMs: Int64
    let rate: Double
}

struct Wallet: Decodable, Sendable {
    let balance: Int
    let maxWagerCredits: Int
    let canRefill: Bool
    let wagerIncrement: Int?

    var creditsPerStep: Int { max(1, wagerIncrement ?? 1) }
}

struct CurrentState: Decodable, Sendable {
    let clock: ServerClock
    let round: TransitRound?
    let lastResult: TransitRound?
    let recentWaitsMs: [Int64]?
    let wallet: Wallet?
}

struct PickResponse: Decodable, Sendable {
    let clock: ServerClock
    let round: TransitRound
    let wallet: Wallet?
}

struct LeaderboardEntry: Decodable, Sendable {
    let nickname: String
    let points: Int
    let isMe: Bool
}

struct Guest: Decodable, Sendable {
    let nickname: String
}

struct NewGuest: Decodable, Sendable {
    let guest: Guest
    let token: String
}

struct APIError: LocalizedError {
    let status: Int
    let message: String

    var errorDescription: String? { message }
}

struct APIClient: Sendable {
    let baseURL: URL

    private static let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 12
        config.timeoutIntervalForResource = 15
        return URLSession(configuration: config)
    }()

    private struct GuestResponse: Decodable { let guest: Guest }
    private struct PlatformResponse: Decodable { let platforms: [Platform] }
    private struct LeaderboardResponse: Decodable { let entries: [LeaderboardEntry] }
    private struct WalletResponse: Decodable { let wallet: Wallet }
    private struct PickBody: Encodable {
        let choice: Pick
        let wagerCredits: Int
    }
    private struct ErrorResponse: Decodable {
        struct Details: Decodable { let message: String }
        let error: Details
    }

    func createGuest() async throws -> NewGuest {
        try await read(
            ["guests"],
            method: "POST",
            body: Data("{}".utf8)
        )
    }

    func guest(token: String) async throws -> Guest {
        let response: GuestResponse = try await read(["guest"], token: token)
        return response.guest
    }

    func platforms(mode: GameMode) async throws -> [Platform] {
        let response: PlatformResponse = try await read(
            ["platforms"],
            query: [URLQueryItem(name: "mode", value: mode.rawValue)]
        )
        return response.platforms
    }

    func current(mode: GameMode, platformID: String, token: String) async throws -> CurrentState {
        try await read(
            ["current"],
            query: [
                URLQueryItem(name: "mode", value: mode.rawValue),
                URLQueryItem(name: "platformId", value: platformID)
            ],
            token: token
        )
    }

    func pick(roundID: String, choice: Pick, wagerCredits: Int, token: String) async throws -> PickResponse {
        try await read(
            ["rounds", roundID, "pick"],
            method: "POST",
            token: token,
            body: JSONEncoder().encode(PickBody(choice: choice, wagerCredits: wagerCredits))
        )
    }

    func refill(mode: GameMode, token: String) async throws -> Wallet {
        let response: WalletResponse = try await read(
            ["wallet", "refill"],
            method: "POST",
            query: [URLQueryItem(name: "mode", value: mode.rawValue)],
            token: token,
            body: Data("{}".utf8)
        )
        return response.wallet
    }

    func leaderboard(mode: GameMode, line: TransitLine, token: String) async throws -> [LeaderboardEntry] {
        let response: LeaderboardResponse = try await read(
            ["leaderboard"],
            query: [
                URLQueryItem(name: "mode", value: mode.rawValue),
                URLQueryItem(name: "line", value: line.rawValue)
            ],
            token: token
        )
        return response.entries
    }

    private func read<Response: Decodable>(
        _ path: [String],
        method: String = "GET",
        query: [URLQueryItem] = [],
        token: String? = nil,
        body: Data? = nil
    ) async throws -> Response {
        let endpoint = path.reduce(baseURL.appendingPathComponent("api")) {
            $0.appendingPathComponent($1)
        }
        guard var components = URLComponents(url: endpoint, resolvingAgainstBaseURL: false) else {
            throw URLError(.badURL)
        }
        if !query.isEmpty { components.queryItems = query }
        guard let url = components.url else { throw URLError(.badURL) }

        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = body
        }

        let (data, response) = try await Self.session.data(for: request)
        guard let response = response as? HTTPURLResponse else {
            throw URLError(.badServerResponse)
        }
        let decoder = JSONDecoder()
        guard (200..<300).contains(response.statusCode) else {
            let detail = try? decoder.decode(ErrorResponse.self, from: data)
            throw APIError(
                status: response.statusCode,
                message: detail?.error.message ?? "The server returned HTTP \(response.statusCode)."
            )
        }
        return try decoder.decode(Response.self, from: data)
    }
}
