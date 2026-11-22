import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { platforms } from './transit/index.mjs';

const MINUTE_MS = 60_000;
const OPENING_ESTIMATE_MS = 4 * MINUTE_MS;
const VOTE_WINDOW_MS = OPENING_ESTIMATE_MS - MINUTE_MS;
const TIE_MARGIN_MS = 30_000;
const ARRIVAL_TIMEOUT_MS = 15 * MINUTE_MS;
const DEMO_COOLDOWN_MS = MINUTE_MS;
const LIVE_VIEWER_WINDOW_MS = 30_000;
const TRIP_REUSE_WINDOW_MS = 12 * 60 * MINUTE_MS;
const POLL_INTERVAL_MS = { demo: 250, live: 5_000 };
const CLOCK_RATE = { demo: 16, live: 1 };
// Keep SQLite stakes and refills in their original units so existing wallets scale in place.
const CREDITS_PER_UNIT = 10;
const STARTING_CREDIT_UNITS = 10;
const MAX_WAGER_UNITS = 100;
const MAX_WAGER_CREDITS = MAX_WAGER_UNITS * CREDITS_PER_UNIT;
const SETTLED_UNIT_CHANGE = `
  CASE
    WHEN r.arrived_at_ms IS NULL OR p.picked_at_ms >= r.arrived_at_ms THEN 0
    WHEN p.choice = r.outcome THEN p.wager_credits
    ELSE -p.wager_credits
  END
`;
const platformById = new Map(platforms.map(platform => [platform.id, platform]));
const supportedLines = new Set(platforms.map(platform => platform.line));

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function isMode(value) {
  return typeof value === 'string' && Object.hasOwn(CLOCK_RATE, value);
}

export function isPlatformId(value) {
  return platformById.has(value);
}

export function isLine(value) {
  return supportedLines.has(value);
}

function tokenHash(token) {
  return createHash('sha256').update(token).digest('hex');
}

function nickname(id) {
  return `Rider ${id}`;
}

function outcomeFor(offsetMs) {
  if (offsetMs < -TIE_MARGIN_MS) return 'sooner';
  if (offsetMs > TIE_MARGIN_MS) return 'later';
  return 'board';
}

function transaction(database, action, mode = 'IMMEDIATE') {
  database.exec(`BEGIN ${mode}`);
  try {
    const result = action();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function databaseAt(path) {
  const database = new DatabaseSync(path);
  database.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
  `);
  transaction(database, () => {
    database.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS guests (
      id INTEGER PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE
    ) STRICT;

    CREATE TABLE IF NOT EXISTS rounds (
      id TEXT PRIMARY KEY,
      mode TEXT NOT NULL CHECK (mode IN ('demo', 'live')),
      platform_id TEXT NOT NULL,
      line TEXT NOT NULL,
      trip_id TEXT NOT NULL,
      opened_at_ms INTEGER NOT NULL,
      target_at_ms INTEGER NOT NULL,
      vote_closes_at_ms INTEGER NOT NULL,
      opening_raw_arrival_at_ms INTEGER NOT NULL,
      latest_raw_arrival_at_ms INTEGER NOT NULL,
      arrived_at_ms INTEGER,
      outcome TEXT CHECK (outcome IN ('sooner', 'later', 'board')),
      void_reason TEXT CHECK (void_reason IN ('canceled', 'unconfirmed')),
      finished_at_real_ms INTEGER,
      CHECK (
        (finished_at_real_ms IS NULL AND outcome IS NULL AND void_reason IS NULL AND arrived_at_ms IS NULL)
        OR (finished_at_real_ms IS NOT NULL AND outcome IS NOT NULL AND void_reason IS NULL AND arrived_at_ms IS NOT NULL)
        OR (finished_at_real_ms IS NOT NULL AND outcome IS NULL AND void_reason IS NOT NULL AND arrived_at_ms IS NULL)
      )
    ) STRICT;

    CREATE UNIQUE INDEX IF NOT EXISTS one_active_round
      ON rounds (mode, platform_id) WHERE finished_at_real_ms IS NULL;
    CREATE INDEX IF NOT EXISTS platform_rounds
      ON rounds (mode, platform_id, opened_at_ms DESC);
    CREATE INDEX IF NOT EXISTS recent_trip_rounds
      ON rounds (mode, platform_id, trip_id, opened_at_ms DESC);

    CREATE TABLE IF NOT EXISTS picks (
      round_id TEXT NOT NULL REFERENCES rounds(id),
      guest_id INTEGER NOT NULL REFERENCES guests(id),
      choice TEXT NOT NULL CHECK (choice IN ('sooner', 'later')),
      picked_at_ms INTEGER NOT NULL,
      wager_credits INTEGER CHECK (wager_credits BETWEEN 1 AND ${MAX_WAGER_UNITS}),
      PRIMARY KEY (round_id, guest_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS rider_picks ON picks (guest_id, round_id);

    CREATE TABLE IF NOT EXISTS wallet_refills (
      guest_id INTEGER NOT NULL REFERENCES guests(id),
      mode TEXT NOT NULL CHECK (mode IN ('demo', 'live')),
      credits INTEGER NOT NULL CHECK (credits > 0),
      PRIMARY KEY (guest_id, mode)
    ) STRICT;
    `);
    if (!database.prepare("SELECT 1 FROM pragma_table_info('picks') WHERE name = 'wager_credits'").get()) {
      database.exec(`ALTER TABLE picks ADD COLUMN wager_credits INTEGER CHECK (wager_credits BETWEEN 1 AND ${MAX_WAGER_UNITS})`);
    }
  });
  return database;
}

export function createGame({ databasePath, demoTransit, liveTransit, now = Date.now, logger = console }) {
  const db = databaseAt(databasePath);
  db.prepare('INSERT OR IGNORE INTO settings VALUES (?, ?)').run('demo_epoch_ms', now());
  const demoEpochMs = db.prepare('SELECT value FROM settings WHERE key = ?').get('demo_epoch_ms').value;
  const transit = { demo: demoTransit, live: liveTransit };
  const watchedPlatforms = new Map();
  let timer;

  const activeRound = db.prepare(`
    SELECT * FROM rounds WHERE mode = ? AND platform_id = ? AND finished_at_real_ms IS NULL
  `);
  const newestRound = db.prepare(`
    SELECT * FROM rounds WHERE mode = ? AND platform_id = ? ORDER BY opened_at_ms DESC LIMIT 1
  `);
  const newestRiderResult = db.prepare(`
    SELECT r.* FROM rounds r JOIN picks p ON p.round_id = r.id
    WHERE r.mode = ? AND r.platform_id = ? AND p.guest_id = ? AND r.finished_at_real_ms IS NOT NULL
    ORDER BY r.finished_at_real_ms DESC, r.opened_at_ms DESC LIMIT 1
  `);
  const recentWaits = db.prepare(`
    SELECT arrived_at_ms - opened_at_ms AS wait_ms FROM rounds
    WHERE mode = ? AND platform_id = ? AND arrived_at_ms IS NOT NULL
    ORDER BY arrived_at_ms DESC LIMIT 3
  `);
  const roundById = db.prepare('SELECT * FROM rounds WHERE id = ?');
  const riderPick = db.prepare(`
    SELECT p.*, CASE WHEN p.wager_credits IS NOT NULL AND r.finished_at_real_ms IS NOT NULL
      THEN ${SETTLED_UNIT_CHANGE} END AS unit_change
    FROM picks p JOIN rounds r ON r.id = p.round_id
    WHERE p.round_id = ? AND p.guest_id = ?
  `);
  const roundSplit = db.prepare(`
    SELECT choice, COUNT(*) AS count FROM picks WHERE round_id = ?
    AND (? IS NULL OR picked_at_ms < ?) GROUP BY choice
  `);
  const recentTripRound = db.prepare(`
    SELECT 1 FROM rounds WHERE mode = ? AND platform_id = ? AND trip_id = ? AND opened_at_ms >= ? LIMIT 1
  `);
  const insertRound = db.prepare(`
    INSERT INTO rounds (id, mode, platform_id, line, trip_id, opened_at_ms, target_at_ms, vote_closes_at_ms,
      opening_raw_arrival_at_ms, latest_raw_arrival_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateRawArrival = db.prepare('UPDATE rounds SET latest_raw_arrival_at_ms = ? WHERE id = ?');
  const settleRound = db.prepare('UPDATE rounds SET arrived_at_ms = ?, outcome = ?, finished_at_real_ms = ? WHERE id = ?');
  const voidRound = db.prepare('UPDATE rounds SET void_reason = ?, finished_at_real_ms = ? WHERE id = ?');
  const insertPick = db.prepare(`
    INSERT INTO picks (round_id, guest_id, choice, picked_at_ms, wager_credits) VALUES (?, ?, ?, ?, ?)
  `);
  const addGuest = db.prepare('INSERT INTO guests (token_hash) VALUES (?)');
  const findGuest = db.prepare('SELECT id FROM guests WHERE token_hash = ?');
  const walletTotals = db.prepare(`
    SELECT
      COALESCE((SELECT credits FROM wallet_refills WHERE guest_id = ? AND mode = ?), 0)
      + COALESCE(SUM(CASE WHEN r.finished_at_real_ms IS NULL THEN -p.wager_credits
        ELSE ${SETTLED_UNIT_CHANGE} END), 0) AS adjustment,
      COALESCE(SUM(r.finished_at_real_ms IS NULL), 0) AS pending
    FROM picks p JOIN rounds r ON r.id = p.round_id
    WHERE p.guest_id = ? AND r.mode = ? AND p.wager_credits IS NOT NULL
  `);
  const addWalletRefill = db.prepare(`
    INSERT INTO wallet_refills (guest_id, mode, credits) VALUES (?, ?, ?)
    ON CONFLICT (guest_id, mode) DO UPDATE SET credits = wallet_refills.credits + excluded.credits
  `);
  const leaderboardRows = db.prepare(`
    WITH scores AS (
      SELECT p.guest_id,
        SUM(CASE
          WHEN p.wager_credits IS NOT NULL THEN ${SETTLED_UNIT_CHANGE}
          WHEN p.choice = r.outcome AND p.picked_at_ms < r.arrived_at_ms THEN 1
          ELSE 0
        END) AS points
      FROM picks p JOIN rounds r ON r.id = p.round_id
      WHERE r.mode = ? AND r.line = ?
      GROUP BY p.guest_id
    )
    SELECT g.id, COALESCE(s.points, 0) AS points
    FROM guests g LEFT JOIN scores s ON s.guest_id = g.id
    WHERE s.guest_id IS NOT NULL OR g.id = ?
    ORDER BY points DESC, g.id
  `);

  function walletFor(mode, guestId) {
    const { adjustment, pending } = walletTotals.get(guestId, mode, guestId, mode);
    const balance = (STARTING_CREDIT_UNITS + adjustment) * CREDITS_PER_UNIT;
    return {
      balance,
      maxWagerCredits: Math.min(balance, MAX_WAGER_CREDITS),
      wagerIncrement: CREDITS_PER_UNIT,
      canRefill: balance === 0 && pending === 0
    };
  }

  function clock(mode, realNowMs = now()) {
    const rate = CLOCK_RATE[mode];
    const nowMs = mode === 'demo' ? demoEpochMs + (realNowMs - demoEpochMs) * rate : realNowMs;
    return { nowMs, rate };
  }

  function present(round, guestId, nowMs) {
    if (!round) return null;
    const pick = riderPick.get(round.id, guestId);
    const split = pick ? { sooner: 0, later: 0 } : null;
    if (split) {
      for (const { choice, count } of roundSplit.all(round.id, round.arrived_at_ms, round.arrived_at_ms)) {
        split[choice] = count;
      }
    }
    let status = 'open';
    if (round.void_reason) status = 'void';
    else if (round.outcome) status = 'settled';
    else if (nowMs >= round.vote_closes_at_ms) status = 'locked';
    return {
      id: round.id,
      mode: round.mode,
      platform: platformById.get(round.platform_id),
      status,
      openedAtMs: round.opened_at_ms,
      targetAtMs: round.target_at_ms,
      voteClosesAtMs: round.vote_closes_at_ms,
      openingEstimateMs: round.target_at_ms - round.opened_at_ms,
      actualWaitMs: round.arrived_at_ms === null ? null : round.arrived_at_ms - round.opened_at_ms,
      outcome: round.outcome,
      voidReason: round.void_reason,
      pick: pick?.choice ?? null,
      wagerCredits: pick?.wager_credits == null ? null : pick.wager_credits * CREDITS_PER_UNIT,
      creditChange: pick?.unit_change == null ? null : pick.unit_change * CREDITS_PER_UNIT,
      split,
      pointEarned: Boolean(pick && pick.choice === round.outcome && pick.picked_at_ms < round.arrived_at_ms)
    };
  }

  function updateRound(round, { predictions, arrivals, canceledTripIds }, realNowMs, nowMs) {
    const prediction = predictions.find(({ tripId }) => tripId === round.trip_id);
    if (Number.isSafeInteger(prediction?.arrivalAtMs)) {
      updateRawArrival.run(prediction.arrivalAtMs, round.id);
    }
    if (canceledTripIds.includes(round.trip_id)) {
      voidRound.run('canceled', realNowMs, round.id);
      return;
    }

    const timeoutAtMs = round.target_at_ms + ARRIVAL_TIMEOUT_MS;
    const arrivedAtMs = arrivals.reduce((earliest, arrival) => {
      if (arrival.tripId !== round.trip_id || !Number.isSafeInteger(arrival.arrivedAtMs)) return earliest;
      if (arrival.arrivedAtMs < round.opened_at_ms || arrival.arrivedAtMs > Math.min(timeoutAtMs, nowMs)) return earliest;
      return Math.min(earliest, arrival.arrivedAtMs);
    }, Infinity);
    if (arrivedAtMs !== Infinity) {
      settleRound.run(arrivedAtMs, outcomeFor(arrivedAtMs - round.target_at_ms), realNowMs, round.id);
    } else if (nowMs >= timeoutAtMs) {
      voidRound.run('unconfirmed', realNowMs, round.id);
    }
  }

  function openRound(mode, platformId, id, { predictions, arrivals, canceledTripIds }, nowMs) {
    const next = predictions.find(prediction =>
      Number.isSafeInteger(prediction.arrivalAtMs) && prediction.arrivalAtMs > nowMs &&
      !canceledTripIds.includes(prediction.tripId) &&
      !arrivals.some(arrival => arrival.tripId === prediction.tripId && arrival.arrivedAtMs <= nowMs)
    );
    if (!next) return;
    const remaining = next.arrivalAtMs - nowMs;
    if (Math.ceil(remaining / MINUTE_MS) !== OPENING_ESTIMATE_MS / MINUTE_MS) return;
    // A scheduled trip identifier may recur on later service days.
    if (recentTripRound.get(mode, platformId, next.tripId, nowMs - TRIP_REUSE_WINDOW_MS)) return;
    insertRound.run(id, mode, platformId, platformById.get(platformId).line, next.tripId, nowMs,
      nowMs + OPENING_ESTIMATE_MS, nowMs + VOTE_WINDOW_MS, next.arrivalAtMs, next.arrivalAtMs);
  }

  function coolingDown(mode, platformId, realNowMs) {
    if (mode !== 'demo') return false;
    const finishedAt = newestRound.get(mode, platformId)?.finished_at_real_ms;
    return finishedAt != null && realNowMs < finishedAt + DEMO_COOLDOWN_MS;
  }

  async function observe(mode, platformId, before, observedAtRealMs) {
    const roundId = before?.id ?? randomUUID();
    const observedAtMs = clock(mode, observedAtRealMs).nowMs;
    let observation = { predictions: [], arrivals: [], canceledTripIds: [] };
    try {
      observation = await transit[mode].observe(platformId, {
        nowMs: observedAtMs,
        openedAtMs: before?.opened_at_ms ?? null,
        watchedTripId: before?.trip_id ?? null,
        demoRunId: roundId
      });
    } catch (error) {
      logger.warn(`Transit observation for ${mode}/${platformId} failed: ${error.message}`);
    }

    const realNowMs = now();
    const nowMs = clock(mode, realNowMs).nowMs;
    transaction(db, () => {
      const current = activeRound.get(mode, platformId);
      if (current?.id !== before?.id) return;
      if (current) updateRound(current, observation, realNowMs, nowMs);
      else if (!coolingDown(mode, platformId, realNowMs)) {
        openRound(mode, platformId, roundId, observation, mode === 'demo' ? observedAtMs : nowMs);
      }
    });
  }

  function watch(mode, platformId) {
    const key = `${mode}/${platformId}`;
    if (!watchedPlatforms.has(key)) {
      watchedPlatforms.set(key, {
        key, mode, platformId, liveViewerUntilMs: -Infinity, nextAtMs: -Infinity, task: null
      });
    }
    return watchedPlatforms.get(key);
  }

  function refresh(state, allowNewRound, dropIdleWatch = false) {
    if (state.task) return state.task;
    const realNowMs = now();
    if (realNowMs < state.nextAtMs) return Promise.resolve();
    const { mode, platformId } = state;
    const before = activeRound.get(mode, platformId);
    if (!before && !allowNewRound) {
      if (dropIdleWatch) watchedPlatforms.delete(state.key);
      return Promise.resolve();
    }
    if (!before && coolingDown(mode, platformId, realNowMs)) return Promise.resolve();

    state.nextAtMs = realNowMs + POLL_INTERVAL_MS[mode];
    state.task = observe(mode, platformId, before, realNowMs).finally(() => { state.task = null; });
    return state.task;
  }

  return {
    startPolling() {
      if (timer) return;
      const unfinished = db.prepare('SELECT mode, platform_id FROM rounds WHERE finished_at_real_ms IS NULL').all();
      for (const row of unfinished) watch(row.mode, row.platform_id);
      timer = setInterval(() => {
        const realNowMs = now();
        for (const state of watchedPlatforms.values()) {
          refresh(state, realNowMs < state.liveViewerUntilMs, true).catch(error => logger.error(error));
        }
      }, POLL_INTERVAL_MS.demo).unref();
    },
    async close() {
      clearInterval(timer);
      await Promise.allSettled([...watchedPlatforms.values()].map(state => state.task));
      db.close();
    },
    createGuest() {
      const token = randomBytes(32).toString('base64url');
      const { lastInsertRowid } = addGuest.run(tokenHash(token));
      return { guest: { nickname: nickname(lastInsertRowid) }, token };
    },
    authenticate(header) {
      const token = /^Bearer ([\w-]{43})$/i.exec(header ?? '')?.[1];
      const guest = token ? findGuest.get(tokenHash(token)) : null;
      if (!guest) throw new ApiError(401, 'guest_required', 'A valid guest credential is required.');
      return { id: guest.id, nickname: nickname(guest.id) };
    },
    async current(mode, platformId, guestId) {
      const state = watch(mode, platformId);
      if (mode === 'live') state.liveViewerUntilMs = now() + LIVE_VIEWER_WINDOW_MS;
      await refresh(state, true);
      const currentClock = clock(mode);
      return transaction(db, () => {
        const current = newestRound.get(mode, platformId);
        const lastResult = newestRiderResult.get(mode, platformId, guestId);
        return {
          clock: currentClock,
          round: present(current, guestId, currentClock.nowMs),
          lastResult: current?.id === lastResult?.id ? null : present(lastResult, guestId, currentClock.nowMs),
          recentWaitsMs: recentWaits.all(mode, platformId).map(row => row.wait_ms),
          wallet: walletFor(mode, guestId)
        };
      }, 'DEFERRED');
    },
    async pick(roundId, guestId, choice, wagerCredits) {
      if (choice !== 'sooner' && choice !== 'later') {
        throw new ApiError(400, 'invalid_choice', 'Choose Sooner or Later.');
      }
      const before = roundById.get(roundId);
      if (!before) throw new ApiError(404, 'round_not_found', 'This round is unavailable.');
      const receivedAtMs = clock(before.mode).nowMs;

      if (before.finished_at_real_ms === null) await refresh(watch(before.mode, before.platform_id), false);
      return transaction(db, () => {
        const currentClock = clock(before.mode);
        const round = roundById.get(roundId);
        const saved = riderPick.get(roundId, guestId);
        if (saved) {
          const matchesWager = saved.wager_credits === null
            ? wagerCredits === undefined
            : saved.wager_credits * CREDITS_PER_UNIT === wagerCredits;
          if (saved.choice !== choice || !matchesWager) {
            throw new ApiError(409, 'already_picked', 'Your pick is already locked.');
          }
        } else {
          if (!Number.isSafeInteger(wagerCredits) || wagerCredits < CREDITS_PER_UNIT ||
            wagerCredits > MAX_WAGER_CREDITS || wagerCredits % CREDITS_PER_UNIT !== 0) {
            throw new ApiError(400, 'invalid_wager',
              `Choose a wager of ${CREDITS_PER_UNIT} to ${MAX_WAGER_CREDITS} credits in increments of ${CREDITS_PER_UNIT}.`);
          }
          if (before.finished_at_real_ms !== null || round.void_reason || receivedAtMs >= round.vote_closes_at_ms ||
            (round.arrived_at_ms !== null && receivedAtMs >= round.arrived_at_ms)) {
            throw new ApiError(409, 'voting_closed', 'Voting is closed for this round.');
          }
          if (wagerCredits > walletFor(round.mode, guestId).balance) {
            throw new ApiError(409, 'insufficient_credits', 'Your wallet does not have enough credits for this wager.');
          }
          insertPick.run(roundId, guestId, choice, receivedAtMs, wagerCredits / CREDITS_PER_UNIT);
        }
        return { clock: currentClock, round: present(round, guestId, currentClock.nowMs), wallet: walletFor(round.mode, guestId) };
      });
    },
    refillWallet(mode, guestId) {
      return transaction(db, () => {
        const wallet = walletFor(mode, guestId);
        if (!wallet.canRefill) return { wallet };
        addWalletRefill.run(guestId, mode, STARTING_CREDIT_UNITS);
        return { wallet: walletFor(mode, guestId) };
      });
    },
    leaderboard(mode, line, guestId) {
      return {
        entries: leaderboardRows.all(mode, line, guestId).map(({ id, points }) => ({
          nickname: nickname(id), points: points * CREDITS_PER_UNIT, isMe: id === guestId
        }))
      };
    }
  };
}
