import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { createGame } from '../game.mjs';
import { createApp } from '../server.mjs';
import { createDemoTransit } from '../transit/index.mjs';

const RED = 'red-ashmont';
const ORANGE = 'orange-forest-hills';
const FIRST_TIME_MS = 1_800_000_000_000;

function observations(predictions = [], arrivals = [], canceledTripIds = []) {
  return { predictions, arrivals, canceledTripIds };
}

async function databaseFile(t) {
  const directory = await mkdtemp(join(tmpdir(), 'beat-the-board-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, 'game.sqlite');
}

async function harness(t, { databasePath = ':memory:', time, liveTransit, demoTransit = createDemoTransit(), poll = false } = {}) {
  const game = createGame({
    databasePath,
    demoTransit,
    liveTransit: liveTransit ?? { async observe() { return observations(); } },
    now: () => time.nowMs,
    logger: { warn() {}, error() {} }
  });
  if (poll) game.startPolling();
  const server = createApp(game).listen(0, '127.0.0.1');
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await game.close();
  };
  t.after(close);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}/api`;

  async function request(route, { token, body, status = 200 } = {}) {
    const response = await fetch(`${base}${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...(token && { Authorization: `Bearer ${token}` }),
        ...(body !== undefined && { 'Content-Type': 'application/json' })
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const payload = await response.json();
    assert.ok([status].flat().includes(response.status), `${route}: HTTP ${response.status} ${JSON.stringify(payload)}`);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return payload;
  }

  return {
    close,
    request,
    guest: () => request('/guests', { body: {}, status: 201 }),
    current: (token, mode = 'demo', platform = RED) => request(`/current?mode=${mode}&platformId=${platform}`, { token }),
    pick: (token, id, choice, status = 200, wagerCredits = 10) => request(`/rounds/${id}/pick`, {
      token, body: { choice, wagerCredits }, status
    }),
    refill: (token, mode = 'demo') => request(`/wallet/refill?mode=${mode}`, { token, body: {} }),
    leaderboard: (token, mode = 'demo', line = 'red') => request(`/leaderboard?mode=${mode}&line=${line}`, { token })
  };
}

test('two guests share the demo, resume saved picks, and keep points across a restart', async t => {
  const time = { nowMs: FIRST_TIME_MS };
  const databasePath = await databaseFile(t);
  const server = await harness(t, { databasePath, time });
  const [sooner, later, silent] = await Promise.all([server.guest(), server.guest(), server.guest()]);
  assert.notEqual(sooner.token, later.token);
  assert.notEqual(sooner.guest.nickname, later.guest.nickname);
  assert.deepEqual((await server.request('/current?mode=demo&platformId=red-ashmont', { status: 401 })).error.code,
    'guest_required');

  const [first, second] = await Promise.all([server.current(sooner.token), server.current(later.token)]);
  assert.equal(first.round.id, second.round.id);
  assert.equal(first.clock.rate, 16);
  assert.equal(first.round.status, 'open');
  assert.equal(first.round.openingEstimateMs, 240_000);
  assert.equal(first.round.targetAtMs - first.round.openedAtMs, 240_000);
  assert.equal(first.round.voteClosesAtMs - first.round.openedAtMs, 180_000);
  assert.equal(first.round.split, null);
  assert.equal(first.round.wagerCredits, null);
  assert.equal(first.round.creditChange, null);
  assert.deepEqual(first.wallet, { balance: 100, maxWagerCredits: 100, wagerIncrement: 10, canRefill: false });
  assert.deepEqual(first.recentWaitsMs, []);
  const id = first.round.id;
  const orange = await server.current(sooner.token, 'demo', ORANGE);
  assert.notEqual(orange.round.id, id);
  assert.equal(orange.round.platform.line, 'orange');

  time.nowMs += 500;
  const [stakedSooner, stakedLater, laterRetry] = await Promise.all([
    server.pick(sooner.token, id, 'sooner', 200, 30),
    server.pick(later.token, id, 'later', 200, 50),
    server.pick(later.token, id, 'later', 200, 50)
  ]);
  assert.equal(stakedSooner.wallet.balance, 70);
  assert.equal(stakedLater.wallet.balance, 50);
  assert.deepEqual(laterRetry.wallet, stakedLater.wallet);
  assert.equal(stakedLater.round.wagerCredits, 50);
  assert.equal(stakedLater.round.creditChange, null);
  assert.equal((await server.pick(later.token, id, 'sooner', 409, 50)).error.code, 'already_picked');
  assert.equal((await server.pick(later.token, id, 'later', 409, 40)).error.code, 'already_picked');
  assert.equal((await server.current(later.token, 'demo', ORANGE)).wallet.balance, 50);
  assert.equal((await server.current(later.token, 'live')).wallet.balance, 100);
  assert.deepEqual((await server.current(sooner.token)).round.split, { sooner: 1, later: 1 });
  assert.equal((await server.current(silent.token)).round.split, null);

  time.nowMs = FIRST_TIME_MS + 11_250;
  assert.equal((await server.current(sooner.token)).round.status, 'locked');
  assert.equal((await server.pick(silent.token, id, 'later', 409)).error.code, 'voting_closed');

  time.nowMs = FIRST_TIME_MS + 19_500;
  const soonerState = await server.current(sooner.token);
  const laterState = await server.current(later.token);
  const resultSooner = soonerState.round;
  const resultLater = laterState.round;
  for (const result of [resultSooner, resultLater]) {
    assert.equal(result.id, id);
    assert.equal(result.status, 'settled');
    assert.equal(result.openingEstimateMs, 240_000);
    assert.equal(result.actualWaitMs, 310_000);
    assert.equal(result.outcome, 'later');
    assert.deepEqual(result.split, { sooner: 1, later: 1 });
  }
  assert.equal(resultSooner.pick, 'sooner');
  assert.equal(resultSooner.pointEarned, false);
  assert.equal(resultSooner.creditChange, -30);
  assert.equal(soonerState.wallet.balance, 70);
  assert.equal(resultLater.pick, 'later');
  assert.equal(resultLater.pointEarned, true);
  assert.equal(resultLater.creditChange, 50);
  assert.equal(laterState.wallet.balance, 150);
  const settledRetry = await server.pick(later.token, id, 'later', 200, 50);
  assert.deepEqual(settledRetry.round, resultLater);
  assert.deepEqual(settledRetry.wallet, laterState.wallet);
  const winnerRow = { nickname: later.guest.nickname, points: 50, isMe: true };
  assert.deepEqual((await server.leaderboard(later.token)).entries, [
    winnerRow, { nickname: sooner.guest.nickname, points: -30, isMe: false }
  ]);
  assert.equal((await server.leaderboard(later.token, 'demo', 'orange')).entries[0].points, 0);
  assert.equal((await server.leaderboard(later.token, 'live')).entries[0].points, 0);

  await server.close();
  const restarted = await harness(t, { databasePath, time });
  assert.deepEqual(await restarted.request('/guest', { token: later.token }), { guest: later.guest });
  const recovered = await restarted.current(later.token);
  assert.deepEqual(recovered.round, resultLater);
  assert.deepEqual(recovered.wallet, laterState.wallet);
  assert.deepEqual((await restarted.leaderboard(later.token)).entries[0], winnerRow);

  time.nowMs += 60_250;
  const newRound = await restarted.current(later.token);
  assert.notEqual(newRound.round.id, id);
  assert.equal(newRound.round.status, 'open');
  assert.deepEqual(newRound.lastResult, resultLater);
  assert.deepEqual(newRound.recentWaitsMs, [310_000]);
});

test('both modes list the subway network and directional platforms share a line leaderboard', async t => {
  const time = { nowMs: FIRST_TIME_MS };
  const server = await harness(t, { time });
  const { platforms } = await server.request('/platforms?mode=demo');
  assert.deepEqual((await server.request('/platforms?mode=live')).platforms, platforms);
  assert.deepEqual([...new Set(platforms.map(({ line }) => line))].sort(), ['blue', 'green', 'mattapan', 'orange', 'red']);
  assert.ok(platforms.some(({ id, stationId }) => id === RED && stationId === 'place-dwnxg'));
  assert.ok(platforms.some(({ id, stationId }) => id === ORANGE && stationId === 'place-dwnxg'));

  const airport = platforms.filter(({ stationId, line }) => stationId === 'place-aport' && line === 'blue');
  assert.equal(airport.length, 2);
  const otherStation = platforms.find(({ stationId, line }) => stationId === 'place-wondl' && line === 'blue');
  assert.ok(otherStation);
  const [rider, neighbor] = await Promise.all([server.guest(), server.guest()]);
  const [samePlatform, otherDirection, atWonderland, shared] = await Promise.all([
    server.current(rider.token, 'demo', airport[0].id),
    server.current(rider.token, 'demo', airport[1].id),
    server.current(rider.token, 'demo', otherStation.id),
    server.current(neighbor.token, 'demo', airport[0].id)
  ]);
  assert.equal(samePlatform.round.id, shared.round.id);
  assert.equal(new Set([samePlatform, otherDirection, atWonderland].map(({ round }) => round.id)).size, 3);
  await server.pick(rider.token, samePlatform.round.id, 'later');
  await server.pick(rider.token, atWonderland.round.id, 'later');
  time.nowMs += 20_000;
  await server.current(rider.token, 'demo', airport[0].id);
  await server.current(rider.token, 'demo', otherStation.id);
  assert.equal((await server.leaderboard(rider.token, 'demo', 'blue')).entries[0].points, 20);
  assert.equal((await server.leaderboard(rider.token, 'live', 'blue')).entries[0].points, 0);
  assert.equal((await server.leaderboard(rider.token, 'demo', 'green')).entries[0].points, 0);
});

test('simultaneous wagers on different platforms cannot overspend a mode balance', async t => {
  const time = { nowMs: FIRST_TIME_MS };
  const server = await harness(t, { time });
  const { token } = await server.guest();
  const [{ round: red }, { round: orange }] = await Promise.all([
    server.current(token, 'demo', RED), server.current(token, 'demo', ORANGE)
  ]);

  for (const wagerCredits of [undefined, 0, -10, 10.5, '20', 11, 1010]) {
    const rejected = await server.request(`/rounds/${red.id}/pick`, {
      token, body: { choice: 'later', wagerCredits }, status: 400
    });
    assert.equal(rejected.error.code, 'invalid_wager');
  }
  const unaffordable = await server.pick(token, red.id, 'later', 409, 110);
  assert.equal(unaffordable.error.code, 'insufficient_credits');

  const attempts = await Promise.all([
    server.pick(token, red.id, 'later', [200, 409], 70),
    server.pick(token, orange.id, 'later', [200, 409], 70)
  ]);
  const accepted = attempts.filter(attempt => attempt.round);
  const refused = attempts.filter(attempt => attempt.error);
  assert.equal(accepted.length, 1);
  assert.equal(refused.length, 1);
  assert.equal(refused[0].error.code, 'insufficient_credits');
  assert.deepEqual(accepted[0].wallet, { balance: 30, maxWagerCredits: 30, wagerIncrement: 10, canRefill: false });
  assert.equal((await server.current(token, 'demo', RED)).wallet.balance, 30);
  assert.equal((await server.current(token, 'demo', ORANGE)).wallet.balance, 30);
  assert.equal((await server.current(token, 'live')).wallet.balance, 100);
});

test('an empty balance can refill once its pending wager settles without changing standings', async t => {
  const time = { nowMs: FIRST_TIME_MS };
  const databasePath = await databaseFile(t);
  const server = await harness(t, { time, databasePath });
  const { token } = await server.guest();
  const { round } = await server.current(token);
  const pending = await server.pick(token, round.id, 'sooner', 200, 100);
  assert.deepEqual(pending.wallet, { balance: 0, maxWagerCredits: 0, wagerIncrement: 10, canRefill: false });
  assert.deepEqual((await server.refill(token)).wallet, pending.wallet);

  time.nowMs += 20_000;
  const lost = await server.current(token);
  assert.equal(lost.round.creditChange, -100);
  assert.deepEqual(lost.wallet, { balance: 0, maxWagerCredits: 0, wagerIncrement: 10, canRefill: true });
  const refills = await Promise.all([server.refill(token), server.refill(token)]);
  for (const { wallet } of refills) {
    assert.deepEqual(wallet, { balance: 100, maxWagerCredits: 100, wagerIncrement: 10, canRefill: false });
  }
  assert.equal((await server.leaderboard(token)).entries[0].points, -100);

  await server.close();
  const restarted = await harness(t, { time, databasePath });
  assert.equal((await restarted.current(token)).wallet.balance, 100);
  assert.equal((await restarted.leaderboard(token)).entries[0].points, -100);
});

test('stored wagers and refills scale on read and the maximum accepted stake is 1000 credits', async t => {
  const time = { nowMs: FIRST_TIME_MS };
  const databasePath = await databaseFile(t);
  const server = await harness(t, { time, databasePath });
  const { token } = await server.guest();
  const { round } = await server.current(token);
  await server.close();

  const db = new DatabaseSync(databasePath);
  try {
    // Store amounts exactly as the previous credit denomination did.
    const { id: guestId } = db.prepare('SELECT id FROM guests').get();
    db.prepare(`
      INSERT INTO picks (round_id, guest_id, choice, picked_at_ms, wager_credits)
      VALUES (?, ?, 'later', ?, 4)
    `).run(round.id, guestId, round.openedAtMs);
    db.prepare("INSERT INTO wallet_refills (guest_id, mode, credits) VALUES (?, 'demo', 100)").run(guestId);
  } finally {
    db.close();
  }

  const upgraded = await harness(t, { time, databasePath });
  const saved = await upgraded.current(token);
  assert.equal(saved.round.wagerCredits, 40);
  assert.equal(saved.round.creditChange, null);
  assert.deepEqual(saved.wallet, { balance: 1060, maxWagerCredits: 1000, wagerIncrement: 10, canRefill: false });
  assert.deepEqual((await upgraded.pick(token, round.id, 'later', 200, 40)).wallet, saved.wallet);

  time.nowMs += 20_000;
  const settled = await upgraded.current(token);
  assert.equal(settled.round.creditChange, 40);
  assert.equal(settled.wallet.balance, 1140);
  assert.equal((await upgraded.leaderboard(token)).entries[0].points, 40);

  time.nowMs += 60_250;
  const { round: next } = await upgraded.current(token);
  assert.equal((await upgraded.pick(token, next.id, 'later', 400, 1010)).error.code, 'invalid_wager');
  const atCap = await upgraded.pick(token, next.id, 'later', 200, 1000);
  assert.equal(atCap.round.wagerCredits, 1000);
  assert.equal(atCap.wallet.balance, 140);
});

test('migrating a saved pick keeps its original result and scales its point without charging the new wallet', async t => {
  const time = { nowMs: FIRST_TIME_MS };
  const databasePath = await databaseFile(t);
  const server = await harness(t, { time, databasePath });
  const { token, guest } = await server.guest();
  const { round } = await server.current(token);
  await server.pick(token, round.id, 'later', 200, 60);
  time.nowMs += 20_000;
  assert.equal((await server.current(token)).round.pointEarned, true);
  await server.close();

  // Keep the stored rider and round while restoring the older schema.
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE legacy_picks (
        round_id TEXT NOT NULL REFERENCES rounds(id),
        guest_id INTEGER NOT NULL REFERENCES guests(id),
        choice TEXT NOT NULL CHECK (choice IN ('sooner', 'later')),
        picked_at_ms INTEGER NOT NULL,
        PRIMARY KEY (round_id, guest_id)
      ) STRICT;
      INSERT INTO legacy_picks SELECT round_id, guest_id, choice, picked_at_ms FROM picks;
      DROP TABLE picks;
      ALTER TABLE legacy_picks RENAME TO picks;
      ALTER TABLE rounds DROP COLUMN stop_skipped;
      PRAGMA user_version = 0;
      COMMIT;
    `);
  } finally {
    db.close();
  }

  const upgraded = await harness(t, { time, databasePath });
  const { round: previous, wallet } = await upgraded.current(token);
  assert.equal(previous.id, round.id);
  assert.equal(previous.pick, 'later');
  assert.equal(previous.pointEarned, true);
  assert.equal(previous.wagerCredits, null);
  assert.equal(previous.creditChange, null);
  assert.equal(wallet.balance, 100);
  assert.deepEqual((await upgraded.leaderboard(token)).entries[0], { nickname: guest.nickname, points: 10, isMe: true });
  const repeated = await upgraded.request(`/rounds/${round.id}/pick`, { token, body: { choice: 'later' } });
  assert.deepEqual(repeated.round, previous);
  assert.deepEqual(repeated.wallet, wallet);

  time.nowMs += 60_250;
  const { round: next } = await upgraded.current(token);
  await upgraded.pick(token, next.id, 'later', 200, 20);
  time.nowMs += 20_000;
  assert.equal((await upgraded.current(token)).wallet.balance, 120);
  assert.equal((await upgraded.leaderboard(token)).entries[0].points, 30);
});

test('live polling drops idle platforms while finishing rounds without a viewer', { timeout: 5_000 }, async t => {
  const time = { nowMs: FIRST_TIME_MS };
  const visits = new Map();
  const arrivalSeen = Promise.withResolvers();
  const tripId = 'live-arrival';
  const arrivalAtMs = FIRST_TIME_MS + 240_000;
  const liveTransit = {
    async observe(id, { nowMs, watchedTripId }) {
      visits.set(id, (visits.get(id) ?? 0) + 1);
      if (id === ORANGE) return observations();
      if (nowMs < arrivalAtMs) return observations([{ tripId, arrivalAtMs }]);
      assert.equal(watchedTripId, tripId);
      setImmediate(arrivalSeen.resolve);
      return observations([], [{ tripId, arrivedAtMs: arrivalAtMs }]);
    }
  };
  const server = await harness(t, { time, liveTransit, poll: true });
  const { token } = await server.guest();
  const open = await server.current(token, 'live', RED);
  assert.equal(open.round.status, 'open');
  assert.equal((await server.current(token, 'live', ORANGE)).round, null);

  time.nowMs = arrivalAtMs;
  await arrivalSeen.promise;
  assert.equal(visits.get(ORANGE), 1);
  assert.equal((await server.current(token, 'live', RED)).round.status, 'settled');
});

test('live feed health gates new rounds and wagers while leaving saved picks and demo available', async t => {
  const time = { nowMs: FIRST_TIME_MS };
  let arrivals = 'loading';
  const visits = new Map();
  const liveTransit = {
    async observe(id) {
      visits.set(id, (visits.get(id) ?? 0) + 1);
      return {
        ...observations([{ tripId: id, arrivalAtMs: time.nowMs + 240_000 }]),
        liveFeed: { predictions: id === ORANGE ? 'unavailable' : 'available', arrivals }
      };
    }
  };
  const server = await harness(t, { time, liveTransit });
  const [rider, second] = await Promise.all([server.guest(), server.guest()]);
  const initial = await server.current(rider.token, 'live');
  assert.equal(initial.round, null);
  assert.deepEqual(initial.liveFeed, { predictions: 'available', arrivals: 'loading' });
  assert.equal((await server.current(rider.token)).liveFeed, undefined);

  time.nowMs += 5_000;
  arrivals = 'available';
  const healthy = await server.current(rider.token, 'live');
  assert.equal(healthy.round.status, 'open');
  assert.deepEqual(healthy.liveFeed, { predictions: 'available', arrivals: 'available' });
  const saved = await server.pick(rider.token, healthy.round.id, 'later');
  assert.equal(saved.wallet.balance, 90);

  // An outage reported by another platform applies before this station's next poll.
  arrivals = 'unavailable';
  const orange = await server.current(second.token, 'live', ORANGE);
  assert.equal(orange.round, null);
  assert.deepEqual(orange.liveFeed, { predictions: 'unavailable', arrivals: 'unavailable' });
  const degraded = await server.current(second.token, 'live', RED);
  assert.equal(visits.get(RED), 2);
  assert.equal(degraded.round.id, healthy.round.id);
  assert.deepEqual(degraded.liveFeed, { predictions: 'available', arrivals: 'unavailable' });
  const blocked = await server.pick(second.token, healthy.round.id, 'sooner', 503);
  assert.equal(blocked.error.code, 'arrival_feed_unavailable');
  assert.equal((await server.current(second.token, 'live')).wallet.balance, 100);
  assert.deepEqual(await server.pick(rider.token, healthy.round.id, 'later'), saved);

  const demo = await server.current(second.token);
  assert.equal(demo.round.status, 'open');
  assert.equal((await server.pick(second.token, demo.round.id, 'sooner')).wallet.balance, 90);

  time.nowMs += 5_000;
  arrivals = 'available';
  assert.deepEqual((await server.current(second.token, 'live')).liveFeed,
    { predictions: 'available', arrivals: 'available' });
  const differentlyDegraded = await server.current(second.token, 'live', ORANGE);
  assert.equal(differentlyDegraded.round, null);
  assert.deepEqual(differentlyDegraded.liveFeed, { predictions: 'unavailable', arrivals: 'available' });
  assert.equal((await server.pick(second.token, healthy.round.id, 'sooner')).wallet.balance, 90);
});

test('a live adapter exception reports unavailable feeds and refunds an existing wager on timeout', async t => {
  const time = { nowMs: FIRST_TIME_MS };
  let offline = false;
  const liveTransit = {
    async observe() {
      if (offline) throw new Error('test feed failure');
      return observations([{ tripId: 'before-outage', arrivalAtMs: time.nowMs + 240_000 }]);
    }
  };
  const server = await harness(t, { time, liveTransit });
  const { token } = await server.guest();
  const { round } = await server.current(token, 'live');
  await server.pick(token, round.id, 'later');

  offline = true;
  time.nowMs = round.targetAtMs + 15 * 60_000;
  const result = await server.current(token, 'live');
  assert.deepEqual(result.liveFeed, { predictions: 'unavailable', arrivals: 'unavailable' });
  assert.equal(result.round.voidReason, 'unconfirmed');
  assert.equal(result.round.creditChange, 0);
  assert.equal(result.wallet.balance, 100);
});

test('finished live results leave the board after two minutes and remain available to the rider', async t => {
  const time = { nowMs: FIRST_TIME_MS };
  const tripId = 'expired-result';
  let fixture = observations([{ tripId, arrivalAtMs: time.nowMs + 240_000 }]);
  const server = await harness(t, { time, liveTransit: { async observe() { return fixture; } } });
  const [rider, spectator] = await Promise.all([server.guest(), server.guest()]);
  const { round } = await server.current(rider.token, 'live');
  await server.pick(rider.token, round.id, 'later');

  time.nowMs = round.targetAtMs + 70_000;
  fixture = observations([], [{ tripId, arrivedAtMs: time.nowMs }]);
  const { round: settled } = await server.current(rider.token, 'live');
  assert.equal(settled.status, 'settled');
  fixture = observations();

  time.nowMs += 119_999;
  assert.deepEqual((await server.current(rider.token, 'live')).round, settled);
  time.nowMs += 1;
  const expired = await server.current(rider.token, 'live');
  assert.equal(expired.round, null);
  assert.deepEqual(expired.lastResult, settled);
  assert.deepEqual(expired.recentWaitsMs, [310_000]);
  assert.equal(expired.wallet.balance, 110);
  const otherBoard = await server.current(spectator.token, 'live');
  assert.equal(otherBoard.round, null);
  assert.equal(otherBoard.lastResult, null);
});

test('skipped stops prevent new rounds and refund existing wagers across a restart', async t => {
  const time = { nowMs: FIRST_TIME_MS };
  const tripId = 'skipped-at-board';
  const databasePath = await databaseFile(t);
  let fixture = {
    ...observations([{ tripId, arrivalAtMs: time.nowMs + 240_000 }]),
    skippedTripIds: [tripId]
  };
  const liveTransit = { async observe() { return fixture; } };
  const server = await harness(t, { time, databasePath, liveTransit });
  const [rider, second] = await Promise.all([server.guest(), server.guest()]);
  assert.equal((await server.current(rider.token, 'live')).round, null);

  time.nowMs += 5_000;
  fixture = { ...observations([{ tripId, arrivalAtMs: time.nowMs + 240_000 }]), skippedTripIds: ['different-trip'] };
  const { round } = await server.current(rider.token, 'live');
  assert.equal(round.status, 'open');
  assert.equal((await server.pick(rider.token, round.id, 'later', 200, 40)).wallet.balance, 60);

  time.nowMs += 5_000;
  fixture = {
    ...observations(), skippedTripIds: [tripId], liveFeed: { predictions: 'available', arrivals: 'unavailable' }
  };
  const rejection = await server.pick(second.token, round.id, 'sooner', 409);
  assert.equal(rejection.error.code, 'voting_closed');
  const result = await server.current(rider.token, 'live');
  assert.equal(result.round.status, 'void');
  assert.equal(result.round.voidReason, 'skipped');
  assert.equal(result.round.creditChange, 0);
  assert.equal(result.wallet.balance, 100);
  await server.close();

  time.nowMs += 120_000;
  const reopened = await harness(t, { time, databasePath, liveTransit });
  const saved = await reopened.current(rider.token, 'live');
  assert.equal(saved.round, null);
  assert.deepEqual(saved.lastResult, result.round);
  assert.equal(saved.wallet.balance, 100);
});

test('background polling settles a saved demo after restart before any phone requests it', { timeout: 5_000 }, async t => {
  const time = { nowMs: FIRST_TIME_MS };
  const databasePath = await databaseFile(t);
  const server = await harness(t, { databasePath, time });
  const { token } = await server.guest();
  const id = (await server.current(token)).round.id;
  await server.pick(token, id, 'later');
  await server.close();

  time.nowMs += 20_000;
  const observedArrival = Promise.withResolvers();
  const fixture = createDemoTransit();
  const demoTransit = {
    async observe(...args) {
      const report = await fixture.observe(...args);
      if (report.arrivals.length) setImmediate(observedArrival.resolve);
      return report;
    }
  };
  const restarted = await harness(t, { databasePath, time, demoTransit, poll: true });
  await observedArrival.promise;
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT outcome FROM rounds WHERE id = ?').get(id).outcome, 'later');
  } finally {
    db.close();
  }
  const { round: result, wallet } = await restarted.current(token);
  assert.equal(result.id, id);
  assert.equal(result.actualWaitMs, 310_000);
  assert.equal(result.pick, 'later');
  assert.equal(result.pointEarned, true);
  assert.equal(wallet.balance, 110);

  time.nowMs += 60_000;
  await sleep(300);
  const observer = new DatabaseSync(databasePath, { readOnly: true });
  try {
    assert.equal(observer.prepare('SELECT COUNT(*) AS count FROM rounds').get().count, 1);
  } finally {
    observer.close();
  }
  assert.notEqual((await restarted.current(token)).round.id, id);
});

test('live opens in the four-minute display window and a revised forecast never changes the target', async t => {
  const time = { nowMs: FIRST_TIME_MS };
  const databasePath = await databaseFile(t);
  const prediction = { tripId: 'red-trip-a', arrivalAtMs: FIRST_TIME_MS + 245_000 };
  let observation = observations([prediction]);
  const server = await harness(t, { databasePath, time, liveTransit: { async observe() { return observation; } } });
  const rider = await server.guest();
  assert.equal((await server.current(rider.token, 'live')).round, null);

  time.nowMs += 6_000;
  const opened = (await server.current(rider.token, 'live')).round;
  assert.equal(opened.openedAtMs, time.nowMs);
  assert.equal(opened.targetAtMs, time.nowMs + 240_000);
  assert.equal(opened.voteClosesAtMs, time.nowMs + 180_000);
  await server.pick(rider.token, opened.id, 'later');

  time.nowMs += 10_000;
  const revisedAt = time.nowMs + 285_000;
  observation = observations([{ ...prediction, arrivalAtMs: revisedAt }], [
    { tripId: prediction.tripId, arrivedAtMs: opened.openedAtMs - 1_000 },
    { tripId: 'another-trip', arrivedAtMs: time.nowMs }
  ]);
  const updated = (await server.current(rider.token, 'live')).round;
  assert.equal(updated.status, 'open');
  assert.equal(updated.targetAtMs, opened.targetAtMs);
  assert.equal(updated.voteClosesAtMs, opened.voteClosesAtMs);
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const raw = db.prepare('SELECT opening_raw_arrival_at_ms, latest_raw_arrival_at_ms FROM rounds').get();
    assert.equal(raw.opening_raw_arrival_at_ms, prediction.arrivalAtMs);
    assert.equal(raw.latest_raw_arrival_at_ms, revisedAt);
  } finally {
    db.close();
  }

  time.nowMs = opened.openedAtMs + 315_000;
  observation = observations([], [
    { tripId: prediction.tripId, arrivedAtMs: opened.openedAtMs + 310_000 },
    { tripId: prediction.tripId, arrivedAtMs: opened.openedAtMs + 315_000 }
  ]);
  const result = (await server.current(rider.token, 'live')).round;
  assert.equal(result.outcome, 'later');
  assert.equal(result.actualWaitMs, 310_000);
  assert.equal(result.pointEarned, true);
  time.nowMs += 5_000;
  assert.deepEqual((await server.current(rider.token, 'live')).round, result);
  assert.equal((await server.leaderboard(rider.token, 'live')).entries[0].points, 10);
  assert.equal((await server.leaderboard(rider.token, 'demo')).entries[0].points, 0);

  for (const waitMs of [195_000, 225_000, 240_000]) {
    time.nowMs += 5_000;
    const tripId = `red-history-${waitMs}`;
    observation = observations([{ tripId, arrivalAtMs: time.nowMs + 240_000 }]);
    const next = (await server.current(rider.token, 'live')).round;
    assert.equal(next.status, 'open');
    time.nowMs = next.openedAtMs + waitMs;
    observation = observations([], [{ tripId, arrivedAtMs: time.nowMs }]);
    assert.equal((await server.current(rider.token, 'live')).round.actualWaitMs, waitMs);
  }
  assert.deepEqual((await server.current(rider.token, 'live')).recentWaitsMs, [240_000, 225_000, 195_000]);
  assert.deepEqual((await server.current(rider.token, 'live', ORANGE)).recentWaitsMs, []);
});

test('the board wins at both 30-second boundaries', async t => {
  for (const [offsetMs, outcome] of [[-30_001, 'sooner'], [-30_000, 'board'], [30_000, 'board'], [30_001, 'later']]) {
    await t.test(`${offsetMs} ms: ${outcome}`, async t => {
      const time = { nowMs: FIRST_TIME_MS };
      const tripId = 'boundary-trip';
      const arrivalAtMs = time.nowMs + 240_000;
      let observation = observations([{ tripId, arrivalAtMs }]);
      const server = await harness(t, { time, liveTransit: { async observe() { return observation; } } });
      const [sooner, later] = await Promise.all([server.guest(), server.guest()]);
      const { round } = await server.current(sooner.token, 'live');
      await server.pick(sooner.token, round.id, 'sooner');
      await server.pick(later.token, round.id, 'later');
      time.nowMs = round.targetAtMs + offsetMs;
      observation = observations([], [{ tripId, arrivedAtMs: time.nowMs }]);
      assert.equal((await server.current(sooner.token, 'live')).round.outcome, outcome);
      assert.equal((await server.leaderboard(sooner.token, 'live')).entries.find(row => row.isMe).points,
        outcome === 'sooner' ? 10 : -10);
      assert.equal((await server.leaderboard(later.token, 'live')).entries.find(row => row.isMe).points,
        outcome === 'later' ? 10 : -10);
    });
  }
});

test('an early STOPPED_AT report closes voting before the scheduled deadline', async t => {
  const time = { nowMs: FIRST_TIME_MS };
  const tripId = 'early-trip';
  let observation = observations([{ tripId, arrivalAtMs: time.nowMs + 240_000 }]);
  const server = await harness(t, { time, liveTransit: { async observe() { return observation; } } });
  const [first, second] = await Promise.all([server.guest(), server.guest()]);
  const { round } = await server.current(first.token, 'live');
  await server.pick(first.token, round.id, 'sooner');

  time.nowMs += 90_000;
  observation = observations([], [{ tripId, arrivedAtMs: time.nowMs }]);
  const response = await server.pick(second.token, round.id, 'sooner', 409);
  assert.equal(response.error.code, 'voting_closed');
  const result = (await server.current(first.token, 'live')).round;
  assert.equal(result.actualWaitMs, 90_000);
  assert.equal(result.outcome, 'sooner');
  assert.equal(result.pointEarned, true);
});

test('a vote received before arrival counts even when its request waits for the arrival poll', async t => {
  const time = { nowMs: FIRST_TIME_MS };
  const tripId = 'arrival-during-vote';
  const started = Promise.withResolvers();
  const released = Promise.withResolvers();
  let waitForReport = false;
  const liveTransit = {
    async observe() {
      if (!waitForReport) return observations([{ tripId, arrivalAtMs: time.nowMs + 240_000 }]);
      started.resolve();
      return released.promise;
    }
  };
  const server = await harness(t, { time, liveTransit });
  const { token } = await server.guest();
  const { round } = await server.current(token, 'live');

  time.nowMs += 5_000;
  waitForReport = true;
  const pending = server.pick(token, round.id, 'sooner');
  await started.promise;
  time.nowMs += 1_000;
  released.resolve(observations([], [{ tripId, arrivedAtMs: time.nowMs }]));
  const { round: result, wallet } = await pending;
  assert.equal(result.status, 'settled');
  assert.equal(result.pick, 'sooner');
  assert.equal(result.pointEarned, true);
  assert.equal(result.creditChange, 10);
  assert.equal(wallet.balance, 110);
});

test('a delayed arrival report removes a vote cast after its timestamp from scoring and the split', async t => {
  const time = { nowMs: FIRST_TIME_MS };
  const tripId = 'delayed-report';
  let observation = observations([{ tripId, arrivalAtMs: time.nowMs + 240_000 }]);
  const server = await harness(t, { time, liveTransit: { async observe() { return observation; } } });
  const { token } = await server.guest();
  const { round } = await server.current(token, 'live');

  time.nowMs += 10_000;
  const accepted = await server.pick(token, round.id, 'sooner', 200, 40);
  assert.equal(accepted.round.pick, 'sooner');
  assert.equal(accepted.wallet.balance, 60);
  time.nowMs += 5_000;
  observation = observations([], [{ tripId, arrivedAtMs: round.openedAtMs + 5_000 }]);
  const { round: result, wallet } = await server.current(token, 'live');
  assert.equal(result.outcome, 'sooner');
  assert.equal(result.pick, 'sooner');
  assert.equal(result.pointEarned, false);
  assert.equal(result.creditChange, 0);
  assert.equal(wallet.balance, 100);
  assert.deepEqual(result.split, { sooner: 0, later: 0 });
  assert.equal((await server.leaderboard(token, 'live')).entries[0].points, 0);
});

test('cancellation and an unconfirmed arrival both void the round without awarding points', async t => {
  const time = { nowMs: FIRST_TIME_MS };
  const redTrip = 'red-canceled';
  const orangeTrip = 'orange-missing';
  const fixtures = new Map([
    [RED, observations([{ tripId: redTrip, arrivalAtMs: time.nowMs + 240_000 }])],
    [ORANGE, observations([{ tripId: orangeTrip, arrivalAtMs: time.nowMs + 240_000 }])]
  ]);
  const liveTransit = {
    async observe(platformId) {
      const fixture = fixtures.get(platformId);
      if (!fixture) throw new Error('fixture transport offline');
      return fixture;
    }
  };
  const server = await harness(t, { time, liveTransit });
  const { token } = await server.guest();
  const { round: red } = await server.current(token, 'live', RED);
  const { round: orange } = await server.current(token, 'live', ORANGE);
  await server.pick(token, red.id, 'later', 200, 30);
  assert.equal((await server.pick(token, orange.id, 'later', 200, 40)).wallet.balance, 30);

  time.nowMs += 5_000;
  fixtures.set(RED, observations([], [], [redTrip]));
  const { round: canceled, wallet: afterCancellation } = await server.current(token, 'live', RED);
  assert.equal(canceled.status, 'void');
  assert.equal(canceled.voidReason, 'canceled');
  assert.equal(canceled.pointEarned, false);
  assert.equal(canceled.creditChange, 0);
  assert.equal(afterCancellation.balance, 60);

  time.nowMs = orange.targetAtMs + 15 * 60_000 - 5_000;
  fixtures.delete(ORANGE);
  assert.equal((await server.current(token, 'live', ORANGE)).round.status, 'locked');
  time.nowMs += 5_000;
  const { round: missing, wallet: afterTimeout } = await server.current(token, 'live', ORANGE);
  assert.equal(missing.status, 'void');
  assert.equal(missing.voidReason, 'unconfirmed');
  assert.equal(missing.pointEarned, false);
  assert.equal(missing.creditChange, 0);
  assert.equal(afterTimeout.balance, 100);
  time.nowMs += 5_000;
  fixtures.set(ORANGE, observations([], [{ tripId: orangeTrip, arrivedAtMs: time.nowMs }]));
  assert.deepEqual((await server.current(token, 'live', ORANGE)).round, missing);
  assert.equal((await server.leaderboard(token, 'live', 'red')).entries[0].points, 0);
  assert.equal((await server.leaderboard(token, 'live', 'orange')).entries[0].points, 0);
});
