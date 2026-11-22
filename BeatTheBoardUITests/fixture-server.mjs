import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createGame } from '../backend/game.mjs';
import { createApp } from '../backend/server.mjs';
import { createDemoTransit } from '../backend/transit/index.mjs';

const openingTimeMs = 1_800_000_000_000;
const votingClosesAfterMs = 180_000;
const openingEstimateMs = 240_000;
const terminalTimeOffsets = { later: 310_000, tied: 240_000, canceled: 190_000, unconfirmed: 1_140_000 };
const fixtures = new Map();

function createFixture(outcome) {
  let nowMs = openingTimeMs;
  let finished = false;
  const liveTransit = {
    async observe(platformId) {
      const tripId = `fixture-${platformId}`;
      if (!finished) {
        return { predictions: [{ tripId, arrivalAtMs: openingTimeMs + openingEstimateMs }], arrivals: [], canceledTripIds: [] };
      }
      const arrivals = outcome === 'later' || outcome === 'tied' ? [{ tripId, arrivedAtMs: nowMs }] : [];
      const canceledTripIds = outcome === 'canceled' ? [tripId] : [];
      return { predictions: [], arrivals, canceledTripIds };
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
    pickPosts: 0,
    advance(phase) {
      if (phase === 'locked' && !finished) {
        nowMs = openingTimeMs + votingClosesAfterMs;
      } else if (phase === 'finished') {
        finished = true;
        nowMs = openingTimeMs + terminalTimeOffsets[outcome];
      }
    }
  };
}

function sendJson(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
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
  if (request.method === 'GET' && path === '') return sendJson(response, 200, { pickPosts: fixture.pickPosts });
  if (request.method === 'POST' && (path === '/locked' || path === '/finished')) {
    fixture.advance(path.slice(1));
    return sendJson(response, 200, { pickPosts: fixture.pickPosts });
  }
  if (path.startsWith('/api/')) {
    if (request.method === 'POST' && /^\/api\/rounds\/[^/]+\/pick$/.test(path)) fixture.pickPosts += 1;
    request.url = `${path}${url.search}`;
    return fixture.api(request, response);
  }
  return sendJson(response, 404, { error: 'Fixture route not found.' });
});

server.listen(Number(process.argv[2] ?? 38661), '127.0.0.1', () => {
  console.log(`http://127.0.0.1:${server.address().port}`);
});

function shutDown() {
  server.close(async () => {
    await Promise.all([...fixtures.values()].map(({ game }) => game.close()));
  });
}

process.once('SIGINT', shutDown);
process.once('SIGTERM', shutDown);
