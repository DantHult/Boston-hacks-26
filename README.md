# Beat the Board

Wager fictional credits on whether an MBTA subway train will beat its opening four-minute estimate. Choose a line, station, and direction, set your stake, then choose **Sooner** or **Later** and tap **Lock in prediction**. After the server saves your pick, see how the other riders voted.

## Start the backend

Install Node.js 24 or later with npm. From the repository root, install dependencies and start the server.

```sh
cd backend
npm ci
npm start
```

The demo uses local fixtures and needs no credentials. Both modes cover the Red, Orange, Blue, Green B/C/D/E, and Mattapan lines. Live mode uses the public MBTA V3 feed and shares requests across watched stations. You can give the server a key for a higher request limit by starting it with `MBTA_API_KEY` in its environment. [MBTA V3 reference](https://api-v3.mbta.com/docs/swagger)

The backend listens on port 3000 on all interfaces. Set `HOST` or `PORT` to override those defaults. SQLite stores guests, picks, and points in `backend/beat-the-board.sqlite`. Set `DB_PATH` to use a different file and keep using that file across restarts. Demo and live leaderboards are separate for each line.

## Station catalog

The bundled catalog contains 125 stations and 271 directional platforms from the November 19, 2026 MBTA GTFS feed. It preserves distinct tracks where branches use different platforms and includes terminal arrivals. MassDOT and the MBTA provide the transit data. [MBTA GTFS documentation](https://github.com/mbta/gtfs-documentation/blob/master/reference/gtfs.md)

To refresh the catalog, download the official feed ZIP, run the generator from the repository root, then restart the backend with the same database. [Official MBTA GTFS feed](https://cdn.mbta.com/MBTA_GTFS.zip)

```sh
python3 backend/transit/data/generate-catalog.py /path/to/MBTA_GTFS.zip
```

## Run on iPhone

1. Open `BeatTheBoard.xcodeproj` in Xcode 15 or later. Select the shared **BeatTheBoard** scheme and an iPhone Simulator running iOS 17 or later, then press ⌘R. Leave the backend address at `http://127.0.0.1:3000` for a simulator on the backend Mac.
2. For a physical iPhone, select your development team under **Signing & Capabilities** and run on the connected phone. Connect the Mac and phone to the same Wi-Fi. Tap the gear icon, enter `http://YOUR-MAC.local:3000` in **Server address**, and save. Get the Mac’s local hostname with `scutil --get LocalHostName`. Allow local network access when iOS prompts you. The Mac’s LAN IP also works as the host if `.local` resolution is unavailable.
3. Select **Simulated demo** or **Live MBTA**. Tap the station name and choose a line. Search that line’s stations, then tap a station to reveal its directions and platforms on the same screen. Green Line platforms show the branches they serve. Live mode shows up to three confirmed waits from previous four-minute rounds on that platform. The app creates a guest automatically and keeps the credential in Keychain. [Apple’s device and Simulator run guide](https://developer.apple.com/documentation/xcode/running-your-app-on-simulated-or-physical-devices)

## 60-second judging walkthrough

| Elapsed | What to do |
| --- | --- |
| Before starting | Install the app on two independent simulators or phones. While connected to the regular backend, set both to **Simulated demo** and **Downtown Crossing · Red Line · Ashmont / Braintree**. Change both server addresses to the demo port, leave both apps open, then start the separate server below. |
| 0–10 seconds | Both boards show an opening estimate of **4 min** and 100 available demo credits. Keep the 10-credit stake, select **Sooner** on one device and **Later** on the other, then tap **Lock in prediction** on both. Check the split and send the Later app to the background. |
| Around 20 seconds | The first device shows **Board said 4:00 · Actual wait 5:10 · Later wins**. Return to the Later app and check its saved pick and the same result. |
| 25–60 seconds | The Later guest has 110 credits and the Sooner guest has 90. Open **Activity** to see **+10** and **−10** on the Red Line leaderboard. Switch to Live MBTA and search for a station such as Airport to show another line and the separate live wallet. |

Demo game time runs at 16×. Voting closes about 11 seconds after opening, and the train arrives in about 19 seconds. The result stays on the board for 60 real seconds before the next demo round can open.

For a fresh rehearsal, leave the regular backend on port 3000 and start a separate server from `backend/`. Set both iPhones or simulators to port 3001 in **Server address**. Use a previously unused port for another fresh database, or reuse the rehearsal database to keep its guest credentials valid. If a server rejects a saved guest, the app keeps the credential and retries it so the guest can recover when that server uses its original database again.

```sh
PORT=3001 DB_PATH="$(mktemp -d)/beat-the-board.sqlite" npm start
```

## Rules and tests

Each round freezes a four-minute target and keeps the raw forecast for comparison. Voting closes 60 game seconds before the target or on arrival, whichever comes first. The first matching MBTA `STOPPED_AT` report supplies the arrival timestamp. An arrival within 30 seconds of the target, including either boundary, goes to the board. A cancellation or confirmed skipped stop voids the round. An unconfirmed round voids 15 minutes after its target.

Live boards distinguish an unavailable MBTA feed from a healthy feed without a qualifying estimate. Arrival-feed outages pause new wagers while the server continues tracking any open round. Departure-only directions remain available in demo mode. The home board shows a live result for up to two minutes. Riders who wagered can find their latest result for that platform in Activity.

Each guest starts with 100 demo credits and 100 live credits. Set a stake in 10-credit increments up to the available balance and 1,000 credits per round. A correct pick pays back twice the stake. An incorrect pick or a board win spends the stake. Voided rounds refund it. An empty wallet with no pending wagers can claim 100 free credits. Settled gains and losses count toward the line leaderboard. Existing balances, wagers, and points carry over at ten times their former values.

```sh
cd backend
npm test
```

The backend suite exercises deterministic demo timing, trip and platform matching, duplicate submissions and reports, both tie boundaries, ETA revisions, wager settlement and refunds, concurrent balance checks, refills, and leaderboard persistence. GitHub Actions runs it on pull requests and pushes to `main`. See [API.md](API.md) for the HTTP contract.

From the repository root, run the XCUITest suite against a local, in-memory game fixture. Use an installed iPhone Simulator name for the destination.

```sh
bash BeatTheBoardUITests/run.sh 'platform=iOS Simulator,name=iPhone 17e'
```
