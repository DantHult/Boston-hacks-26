# Beat the Board API

The local server defaults to port 3000. API paths start with `/api`. Times and durations are Unix milliseconds and milliseconds respectively. The `clock` object gives `nowMs` in game time and a `rate` in game milliseconds per real millisecond. Clients advance the last received clock against elapsed local time. Live runs at 1× and demo at 16×.

## HTTP routes

| Method and path | Request | Success response |
| --- | --- | --- |
| `POST /api/guests` | `{}` | `201 {guest: {nickname}, token}` |
| `GET /api/guest` | Bearer token | `{guest: {nickname}}` |
| `GET /api/platforms?mode=demo` | `mode=demo` or `mode=live` | `{platforms: [{id, stationId, station, line, direction, routes, supportsArrivalRounds}]}` |
| `GET /api/current?mode=demo&platformId=red-ashmont` | Bearer token and platform | `{clock, round, lastResult, recentWaitsMs, wallet, liveFeed?}` |
| `POST /api/rounds/:id/pick` | Bearer token, `choice` (`sooner` or `later`), and `wagerCredits` in the body | `{clock, round, wallet}` |
| `POST /api/wallet/refill?mode=demo` | Bearer token, mode, and `{}` | `{wallet}` |
| `GET /api/leaderboard?mode=demo&line=red` | Bearer token and a subway `line` | `{entries: [{nickname, points, isMe}]}` |

`nickname` is assigned by the server and stays tied to the guest token. Clients persist only the token in Keychain and can always recover the nickname. Repeat a pick with the same choice and stake to receive its stored representation even after settlement. Changing the choice or stake for an existing pick or placing a new pick after close returns `409`. Errors use `{error: {code, message}}`. Required credentials that are missing or unrecognized return `401`. Responses are uncached.

Both modes expose the full subway catalog. Platform `line` values are `red`, `orange`, `blue`, `green`, and `mattapan`. Group platforms by `stationId`, the MBTA station identifier, because different stations can have the same name. Each platform identifies a boarding or arrival location and direction within a station and lists its MBTA route IDs in `routes`. Green Line branches that share a platform and direction share a round. Branches that use separate tracks can run separate rounds. Clients should use the returned `id` as an opaque key. The original Downtown Crossing southbound IDs `red-ashmont` and `orange-forest-hills` still address the same rounds and picks. Leaderboards are shared across stations and branches on a line and separate between modes.

`supportsArrivalRounds` is false for departure-only directions in the schedule catalog. Those directions can still be used in demo mode.

## Rider round

```json
{
  "id": "opaque-string",
  "mode": "demo",
  "platform": {"id": "red-ashmont", "stationId": "place-dwnxg", "station": "Downtown Crossing", "line": "red", "direction": "Ashmont / Braintree", "routes": ["Red"], "supportsArrivalRounds": true},
  "status": "open",
  "openedAtMs": 1795294800000,
  "targetAtMs": 1795295040000,
  "voteClosesAtMs": 1795294980000,
  "openingEstimateMs": 240000,
  "actualWaitMs": null,
  "outcome": null,
  "voidReason": null,
  "pick": null,
  "wagerCredits": null,
  "creditChange": null,
  "split": null,
  "pointEarned": false
}
```

`status` is `open`, `locked`, `settled`, or `void`. `outcome` is `sooner`, `later`, or `board` after settlement. `voidReason` is `canceled`, `skipped`, or `unconfirmed` if voided. A saved `pick` is `sooner` or `later`. `split` is `{sooner: number, later: number}` counting saved picks and is `null` until the requesting rider has picked. `pointEarned` reports whether this rider won the round. `round` is nullable when the board is idle. A finished live round stays on the board until a new round opens or two real minutes pass. `lastResult` is the rider's most recent completed pick for this platform if it differs from `round`.

`recentWaitsMs` lists up to three actual waits for settled rounds at the selected platform and in the selected mode, most recent first. A platform with no confirmed arrivals has an empty list.

A live prediction 1–240 seconds away displays a whole-minute ceiling. The server opens on the first poll at which a matching upcoming prediction displays four minutes, with remaining time in `(180s, 240s]`. Each platform has at most one active round. Its target is exactly 240,000 ms after opening and its scheduled voting deadline is 180,000 ms after opening. Arrival closes voting immediately when observed. The server retains the opening raw prediction and can update the latest raw prediction without affecting scoring. The wait is measured from opening to the first matching `STOPPED_AT` report timestamp. Deviations greater than 30,000 ms win for the corresponding side. A canceled trip or confirmed skip at the watched platform voids the round. A round voids if a matching arrival is unconfirmed 15 minutes after the frozen target.

Live responses include `liveFeed: {predictions, arrivals}`. Each channel reports `loading`, `available`, or `unavailable`. A healthy prediction response can contain zero upcoming trains. A failed or 15-second-old snapshot is unavailable. Opening a live round requires both channels to be available. When arrival tracking is unavailable, new live picks return `503 arrival_feed_unavailable`. Saved picks can still be read and retried.

## Wagers and wallets

Each guest starts with 100 fictional credits per mode. The available balance is shared across lines and stations within that mode. A wallet reports `{balance, maxWagerCredits, wagerIncrement, canRefill}`. A new pick reserves a stake in 10-credit increments, up to the available balance and 1,000 credits per round. Requests with an invalid amount return `400 invalid_wager`. A wager exceeding the available balance returns `409 insufficient_credits`.

A correct pick returns the stake and earns an equal amount. An incorrect pick or a board win spends the stake. A voided round or a report showing a pick was made after the train arrived returns the stake. `wagerCredits` exposes the rider’s saved stake. `creditChange` is the net change after settlement, including zero for a refund. It is `null` while the wager is pending. Historical picks from before wagers have `null` for both values. Each of their earned leaderboard points counts as 10 in the current scale.

The refill endpoint restores 100 free credits when `canRefill` is true, which requires a zero balance and no pending wagers. Repeated refill requests return the current wallet. Settled credit gains and losses change the rider’s points on the matching line by the same amount. Starter credits and refills stay in the wallet. The API reports existing balances, stakes, and scores at ten times their former values using the same saved records.

## Transit adapter interface

`backend/transit/index.mjs` exports `platforms` (public platform descriptors above), `createLiveTransit({apiKey})` and `createDemoTransit()`. Each adapter exposes an async `observe(platformId, {nowMs, openedAtMs, watchedTripId})`. `openedAtMs` is the persisted opening time for the current active round or `null` before one opens. `watchedTripId` is the active trip ID or `null`. Return the observations below. `predictions` should contain upcoming predictions ordered closest first. Include cancellation IDs and matching `STOPPED_AT` arrival reports even when the watched trip's prediction disappears. Polling, persistence, opening and scoring are the game server's responsibility. Report times are game clock times in demo and real UTC times in live mode.

```js
{
  predictions: [{ tripId, arrivalAtMs }],
  arrivals: [{ tripId, arrivedAtMs }],
  canceledTripIds: [tripId],
  skippedTripIds: [tripId],
  liveFeed: { predictions: 'available', arrivals: 'available' }
}
```

The deterministic demo predicts `nowMs + 240000` before each round opens, then reports arrival at `openedAtMs + 310000` once the clock reaches that value. Predictions and reports share the supplied platform's synthetic trip ID. The game server can use optional `demoRunId` in the observe options as a stable per-round synthetic trip discriminator. Demo clock state must permit restart with the same saved round and scores.

Live polling starts when a client requests a platform's current board. The server can open a new round for 30 seconds after the most recent request. An open round continues polling through arrival, cancellation, skip, or timeout even after all riders leave the board. The adapter shares MBTA requests across watched platforms and matches the resulting predictions and reports to exact route, direction, and platform stop IDs. `liveFeed` and `skippedTripIds` are specific to live observations.
