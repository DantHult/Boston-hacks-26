import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createGame } from '../backend/game.mjs';
import { createApp } from '../backend/server.mjs';
import { createDemoTransit } from '../backend/transit/index.mjs';

const openingTimeMs = 1_800_000_000_000;
const votingClosesAfterMs = 180_000;
const openingEstimateMs = 240_000;
const terminalTimeOffsets = { later: 310_000, tied: 240_000, canceled: 190_000, skipped: 190_000, unconfirmed: 1_140_000 };
const fixtureTransitions = new Set([
  'locked', 'finished', 'expired', 'guest-unavailable', 'guest-restored',
  'hold-standings', 'fail-standings', 'arrival-outage', 'arrival-restored'
]);
const fixtures = new Map();

function createFixture(outcome) {
  let nowMs = openingTimeMs;
  let finished = false;
  let arrivalsAvailable = true;
  const liveTransit = {
    async observe(platformId) {
      const tripId = `fixture-${platformId}`;
      const arrivals = finished && (outcome === 'later' || outcome === 'tied')
        ? [{ tripId, arrivedAtMs: openingTimeMs + terminalTimeOffsets[outcome] }] : [];
      return {
        predictions: finished ? [] : [{ tripId, arrivalAtMs: openingTimeMs + openingEstimateMs }],
        arrivals,
        canceledTripIds: finished && outcome === 'canceled' ? [tripId] : [],
        skippedTripIds: finished && outcome === 'skipped' ? [tripId] : [],
        liveFeed: { predictions: 'available', arrivals: arrivalsAvailable ? 'available' : 'unavailable' }
      };
    }
  };
  const game = createGame({
    databasePath: ':memory:',
    demoTransit: createDemoTransit(),
    liveTransit,
    now: () => nowMs
  });
  return {
    game,
    api: createApp(game),
    stats: { pickPosts: 0, guestPosts: 0, currentGets: 0, standingsGets: 0 },
    guestUnavailable: false,
    standings: 'available',
    pendingStandings: new Set(),
    advance(phase) {
      if (phase === 'locked' && !finished) {
        nowMs = openingTimeMs + votingClosesAfterMs;
      } else if (phase === 'finished') {
        finished = true;
        nowMs = openingTimeMs + terminalTimeOffsets[outcome];
      } else if (phase === 'expired' && finished) {
        nowMs = openingTimeMs + 86_400_000;
      } else if (phase === 'guest-unavailable' || phase === 'guest-restored') {
        this.guestUnavailable = phase === 'guest-unavailable';
      } else if (phase === 'hold-standings' || phase === 'fail-standings') {
        this.standings = phase === 'hold-standings' ? 'held' : 'failed';
        if (this.standings === 'failed') this.releaseStandings();
      } else if (phase === 'arrival-outage' || phase === 'arrival-restored') {
        arrivalsAvailable = phase === 'arrival-restored';
        nowMs += 5_000;
      }
    },
    releaseStandings() {
      for (const response of this.pendingStandings) sendStandingsFailure(response);
      this.pendingStandings.clear();
    }
  };
}

function sendJson(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

function sendStandingsFailure(response) {
  sendJson(response, 503, { error: { code: 'standings_unavailable', message: 'Standings are unavailable.' } });
}

async function readJson(request) {
  let body = '';
  for await (const chunk of request) body += chunk;
  return JSON.parse(body);
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  if (request.method === 'POST' && url.pathname === '/fixtures') {
    let outcome;
    try {
      ({ outcome } = await readJson(request));
    } catch {
      return sendJson(response, 400, { error: 'Expected a JSON fixture outcome.' });
    }
    if (!Object.hasOwn(terminalTimeOffsets, outcome)) {
      return sendJson(response, 400, { error: 'Unknown fixture outcome.' });
    }
    const id = randomUUID();
    fixtures.set(id, createFixture(outcome));
    return sendJson(response, 201, { id });
  }

  const match = url.pathname.match(/^\/fixtures\/([\w-]+)(\/.*)?$/);
  const fixture = match && fixtures.get(match[1]);
  if (!fixture) return sendJson(response, 404, { error: 'Fixture not found.' });
  const path = match[2] ?? '';
  if (request.method === 'GET' && path === '') {
    return sendJson(response, 200, { ...fixture.stats, pendingStandings: fixture.pendingStandings.size });
  }
  if (request.method === 'POST' && fixtureTransitions.has(path.slice(1))) {
    fixture.advance(path.slice(1));
    return sendJson(response, 200, fixture.stats);
  }
  if (path.startsWith('/api/')) {
    if (request.method === 'POST' && /^\/api\/rounds\/[^/]+\/pick$/.test(path)) fixture.stats.pickPosts += 1;
    if (request.method === 'POST' && path === '/api/guests') fixture.stats.guestPosts += 1;
    if (request.method === 'GET' && path === '/api/current') fixture.stats.currentGets += 1;
    if (fixture.guestUnavailable && request.headers.authorization) {
      return sendJson(response, 401, { error: { code: 'guest_required', message: 'A valid guest credential is required.' } });
    }
    if (request.method === 'GET' && path === '/api/leaderboard') {
      fixture.stats.standingsGets += 1;
      if (fixture.standings === 'failed') return sendStandingsFailure(response);
      if (fixture.standings === 'held') {
        fixture.pendingStandings.add(response);
        response.once('close', () => fixture.pendingStandings.delete(response));
        return;
      }
    }
    request.url = `${path}${url.search}`;
    return fixture.api(request, response);
  }
  return sendJson(response, 404, { error: 'Fixture route not found.' });
});

server.listen(Number(process.argv[2] ?? 38661), '127.0.0.1', () => {
  console.log(`http://127.0.0.1:${server.address().port}`);
});

function shutDown() {
  for (const fixture of fixtures.values()) fixture.releaseStandings();
  server.close(async () => {
    await Promise.all([...fixtures.values()].map(({ game }) => game.close()));
  });
}

process.once('SIGINT', shutDown);
process.once('SIGTERM', shutDown);
