import Foundation
import XCTest

final class BeatTheBoardUITests: XCTestCase {
    private struct Fixture: Decodable {
        let id: String
    }

    private struct FixtureState: Decodable {
        let pickPosts: Int
    }

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    @MainActor
    func testSelectAdjustLockAndSettleWager() async throws {
        let fixture = try await makeFixture(outcome: "later")
        let app = launch(fixture)
        requireElement("round.open", in: app)
        assertText("4 minutes", on: "round.estimate", in: app)
        assertText("100", on: "home.wallet", in: app)
        XCTAssertFalse(element("prediction.lockIn", in: app).isEnabled)
        for identifier in ["home.station", "home.mode", "prediction.sooner", "prediction.later",
                           "wager.decrease", "wager.increase", "prediction.lockIn"] {
            let frame = requireElement(identifier, in: app).frame
            XCTAssertGreaterThanOrEqual(frame.width, 44, identifier)
            XCTAssertGreaterThanOrEqual(frame.height, 44, identifier)
        }

        requireElement("prediction.sooner", in: app).tap()
        XCTAssertTrue(element("prediction.lockIn", in: app).isEnabled)
        requireElement("prediction.later", in: app).tap()
        tapVisible("wager.increase", in: app)
        assertText("20", on: "wager.amount", in: app)
        tapVisible("wager.decrease", in: app)
        assertText("10", on: "wager.amount", in: app)
        tapVisible("wager.increase", in: app)
        assertText("20", on: "wager.amount", in: app)
        assertText("100", on: "home.wallet", in: app)
        XCTAssertFalse(element("round.savedPrediction", in: app).exists)
        XCTAssertFalse(element("round.split", in: app).exists)
        let beforeLock = try await fixtureState(fixture)
        XCTAssertEqual(beforeLock.pickPosts, 0)

        tapVisible("prediction.lockIn", in: app)
        assertText("Later locked in", on: "round.savedPrediction", in: app)
        assertText("20 credits", on: "round.savedWager", in: app)
        assertText("80", on: "home.wallet", in: app)
        assertText("1 Later", on: "round.split", in: app)
        let afterLock = try await fixtureState(fixture)
        XCTAssertEqual(afterLock.pickPosts, 1)

        try await advance(fixture, to: "locked")
        requireElement("round.locked", in: app)
        assertText("20 credits", on: "round.savedWager", in: app)

        try await advance(fixture, to: "finished")
        requireElement("round.settled", in: app)
        assertText("Later wins", on: "round.outcome", in: app)
        assertText("Won 20 credits", on: "round.payout", in: app)
        assertText("120", on: "home.wallet", in: app)

        tapVisible("home.activity", in: app)
        requireElement("activity.sheet", in: app)
        assertText("Red Line", on: "activity.leaderboard", in: app)
        tapVisible("activity.done", in: app)
        let dismissed = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "exists == false"),
            object: element("activity.sheet", in: app)
        )
        await fulfillment(of: [dismissed], timeout: 10)
    }

    @MainActor
    func testTieSpendsTheSavedWager() async throws {
        try await verifyTerminalOutcome("tied", phase: "round.tied", payout: "Lost 10 credits", balance: "90")
    }

    @MainActor
    func testCanceledTripRefundsTheSavedWager() async throws {
        try await verifyTerminalOutcome("canceled", phase: "round.canceled", payout: "Refunded 10 credits", balance: "100")
    }

    @MainActor
    func testUnconfirmedArrivalRefundsTheSavedWager() async throws {
        try await verifyTerminalOutcome("unconfirmed", phase: "round.unconfirmed", payout: "Refunded 10 credits", balance: "100")
    }

    @MainActor
    private func verifyTerminalOutcome(_ outcome: String, phase: String, payout: String, balance: String) async throws {
        let fixture = try await makeFixture(outcome: outcome)
        let app = launch(fixture)
        requireElement("round.open", in: app)
        tapVisible("prediction.later", in: app)
        tapVisible("prediction.lockIn", in: app)
        assertText("10 credits", on: "round.savedWager", in: app)
        assertText("90", on: "home.wallet", in: app)

        try await advance(fixture, to: "finished")
        requireElement(phase, in: app)
        assertText(payout, on: "round.payout", in: app)
        assertText(balance, on: "home.wallet", in: app)
    }

    @MainActor
    private func launch(_ fixture: URL) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-backendURL", fixture.absoluteString, "-gameMode", "live", "-platformID", "red-ashmont"]
        app.launch()
        return app
    }

    @MainActor
    private func element(_ identifier: String, in app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: identifier).firstMatch
    }

    @MainActor
    @discardableResult
    private func requireElement(_ identifier: String, in app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) -> XCUIElement {
        let target = element(identifier, in: app)
        XCTAssertTrue(target.exists || target.waitForExistence(timeout: 12), "Missing \(identifier)", file: file, line: line)
        return target
    }

    @MainActor
    private func tapVisible(_ identifier: String, in app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        let target = requireElement(identifier, in: app, file: file, line: line)
        for _ in 0..<3 where !target.isHittable {
            app.swipeUp()
        }
        XCTAssertTrue(target.isHittable, "Cannot reach \(identifier)", file: file, line: line)
        target.tap()
    }

    @MainActor
    private func assertText(_ expected: String, on identifier: String, in app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        let target = requireElement(identifier, in: app, file: file, line: line)
        let text = [target.label, target.value as? String ?? ""].joined(separator: " ")
        XCTAssertTrue(text.localizedCaseInsensitiveContains(expected), "Expected \(expected) on \(identifier), got \(text)", file: file, line: line)
    }

    private func makeFixture(outcome: String) async throws -> URL {
        let address = ProcessInfo.processInfo.environment["BTB_TEST_SERVER_URL"] ?? "http://127.0.0.1:38661"
        let base = try XCTUnwrap(URL(string: address)).appendingPathComponent("fixtures")
        let body = try JSONEncoder().encode(["outcome": outcome])
        let data = try await fixtureRequest(base, method: "POST", body: body, status: 201)
        let fixture = try JSONDecoder().decode(Fixture.self, from: data)
        return base.appendingPathComponent(fixture.id)
    }

    private func fixtureState(_ fixture: URL) async throws -> FixtureState {
        let data = try await fixtureRequest(fixture)
        return try JSONDecoder().decode(FixtureState.self, from: data)
    }

    private func advance(_ fixture: URL, to phase: String) async throws {
        _ = try await fixtureRequest(fixture.appendingPathComponent(phase), method: "POST")
    }

    private func fixtureRequest(_ url: URL, method: String = "GET", body: Data? = nil, status: Int = 200) async throws -> Data {
        var request = URLRequest(url: url, timeoutInterval: 20)
        request.httpMethod = method
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        let httpResponse = try XCTUnwrap(response as? HTTPURLResponse)
        XCTAssertEqual(httpResponse.statusCode, status, String(decoding: data, as: UTF8.self))
        return data
    }
}
