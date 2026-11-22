import assert from 'node:assert/strict';
import test from 'node:test';
import { definitions } from './catalog.mjs';
import { createDemoTransit, createLiveTransit, platforms } from './index.mjs';

const start = Date.parse('2026-11-21T19:00:00Z');
const timestamp = seconds => new Date(start + seconds * 1000).toISOString();

function record(trip, stop, attributes, route = 'Red') {
  return {
    attributes: { direction_id: 0, ...attributes },
    relationships: {
      trip: { data: { id: trip } },
      stop: { data: { id: stop } },
      route: { data: { id: route } }
    }
  };
}

function predicted(trip, stop, attributes = {}, route) {
  return record(trip, stop, { arrival_time: timestamp(220), ...attributes }, route);
}

function stopped(trip, stop, attributes = {}, route) {
  return record(trip, stop, { current_status: 'STOPPED_AT', updated_at: timestamp(4), ...attributes }, route);
}

test('the fixture has one exact 5:10 arrival per platform and repeats it for both riders', async () => {
  const demo = createDemoTransit();
  const tripIds = [];
  for (const { id } of platforms) {
    const opening = await demo.observe(id, { nowMs: start, openedAtMs: null, demoRunId: 'fixture' });
    const [prediction] = opening.predictions;
    assert.equal(prediction.arrivalAtMs, start + 240_000);
    tripIds.push(prediction.tripId);

    const watch = { openedAtMs: start, watchedTripId: prediction.tripId };
    assert.deepEqual((await demo.observe(id, { ...watch, nowMs: start + 309_999 })).arrivals, []);
    for (const nowMs of [start + 310_000, start + 350_000]) {
      const { arrivals } = await demo.observe(id, { ...watch, nowMs });
      assert.deepEqual(arrivals, [{ tripId: prediction.tripId, arrivedAtMs: start + 310_000 }]);
    }
  }
  assert.ok(platforms.some(platform => platform.line === 'blue'));
  assert.equal(new Set(tripIds).size, platforms.length);
});

test('live polls share requests and match direction, route, stop, trip and status', async () => {
  const requests = [];
  const payload = {
    '/predictions': [
      predicted('next-red', '70077'),
      predicted('skipped-north', '70077', { direction_id: 1 }),
      predicted('wrong-stop', '70078'),
      predicted('cancelled-red', '70077', { schedule_relationship: 'CANCELLED', arrival_time: null }),
      predicted('next-orange', '70020', {}, 'Orange')
    ],
    '/vehicles': [
      stopped('watched', '70077'),
      stopped('other-trip', '70077'),
      stopped('watched', '70078'),
      stopped('watched', '70077', { direction_id: 1 }),
      stopped('watched', '70077', { current_status: 'INCOMING_AT' }),
      stopped('watched', '70077', {}, 'Orange'),
      stopped('orange-arrival', '70020', {}, 'Orange')
    ]
  };
  const live = createLiveTransit({
    apiKey: 'fixture-key',
    now: () => start + 5000,
    fetchImpl: async (url, { headers }) => {
      requests.push({ url, headers });
      return Response.json({ data: payload[url.pathname] });
    }
  });
  const [red, orange] = await Promise.all([
    live.observe('red-ashmont', { nowMs: start + 5000, watchedTripId: 'watched' }),
    live.observe('orange-forest-hills', { nowMs: start + 5000 })
  ]);
  assert.deepEqual(requests.map(({ url }) => url.pathname).sort(), ['/predictions', '/vehicles']);
  assert.ok(requests.every(({ headers }) => headers['x-api-key'] === 'fixture-key'));
  assert.deepEqual(red, {
    predictions: [{ tripId: 'next-red', arrivalAtMs: start + 220_000 }],
    arrivals: [{ tripId: 'watched', arrivedAtMs: start + 4000 }],
    canceledTripIds: ['cancelled-red']
  });
  assert.deepEqual(orange, {
    predictions: [{ tripId: 'next-orange', arrivalAtMs: start + 220_000 }],
    arrivals: [{ tripId: 'orange-arrival', arrivedAtMs: start + 4000 }],
    canceledTripIds: []
  });
});

test('Aquarium’s two directions and Kenmore’s separate Green platforms use the same poll', async () => {
  const blue = [0, 1].map(directionId => definitions.find(platform =>
    platform.stationId === 'place-aqucl' && platform.line === 'blue' && platform.directionId === directionId
  ));
  assert.ok(blue.every(Boolean));
  const kenmoreWestbound = definitions.filter(platform =>
    platform.stationId === 'place-kencl' && platform.line === 'green' && platform.directionId === 0
  );
  const greenB = kenmoreWestbound.find(platform => platform.routes.includes('Green-B'));
  const greenCD = kenmoreWestbound.find(platform => platform.routes.includes('Green-C'));
  assert.ok(greenB && greenCD);
  assert.deepEqual(greenB.routes, ['Green-B']);
  assert.deepEqual(greenCD.routes, ['Green-C', 'Green-D']);
  const [bStop] = greenB.stopIds;
  const [cdStop] = greenCD.stopIds;
  assert.notEqual(bStop, cdStop);

  const requests = [];
  const [blueInbound, blueOutbound] = blue;
  const eastbound = { direction_id: 1 };
  const payload = {
    '/predictions': [
      predicted('inbound-blue', blueInbound.stopIds[0], {}, 'Blue'),
      predicted('outbound-blue', blueOutbound.stopIds[0], eastbound, 'Blue'),
      predicted('green-b', bStop, {}, 'Green-B'),
      predicted('green-c', cdStop, {}, 'Green-C'),
      predicted('green-d', cdStop, {}, 'Green-D'),
      predicted('wrong-platform', cdStop, {}, 'Green-B'),
      predicted('duplicate-branch', cdStop, {}, 'Green-C'),
      predicted('duplicate-branch', cdStop, { schedule_relationship: 'CANCELLED' }, 'Green-C')
    ],
    '/vehicles': [
      stopped('inbound-blue', blueInbound.stopIds[0], {}, 'Blue'),
      stopped('outbound-blue', blueOutbound.stopIds[0], eastbound, 'Blue'),
      stopped('green-b', bStop, {}, 'Green-B'),
      stopped('green-d', cdStop, {}, 'Green-D')
    ]
  };
  const live = createLiveTransit({
    now: () => start + 5000,
    fetchImpl: async url => {
      requests.push(url);
      return Response.json({ data: payload[url.pathname] });
    }
  });
  const nowMs = start + 5000;
  const [inbound, outbound, kenmoreB, kenmoreCD] = await Promise.all([
    live.observe(blueInbound.id, { nowMs, watchedTripId: 'inbound-blue' }),
    live.observe(blueOutbound.id, { nowMs, watchedTripId: 'outbound-blue' }),
    live.observe(greenB.id, { nowMs, watchedTripId: 'green-b' }),
    live.observe(greenCD.id, { nowMs, watchedTripId: 'green-d' }),
    ...Array.from({ length: 25 }, () => live.observe(greenCD.id, { nowMs }))
  ]);
  assert.deepEqual(requests.map(url => url.pathname).sort(), ['/predictions', '/vehicles']);
  const predictionsRequest = requests.find(url => url.pathname === '/predictions');
  assert.deepEqual(predictionsRequest.searchParams.get('filter[stop]').split(',').sort(), ['place-aqucl', 'place-kencl']);
  const advertisedRoutes = predictionsRequest.searchParams.get('filter[route]').split(',');
  assert.ok(advertisedRoutes.includes('Blue') && advertisedRoutes.includes('Mattapan'));

  assert.deepEqual(inbound.predictions.map(prediction => prediction.tripId), ['inbound-blue']);
  assert.deepEqual(inbound.arrivals.map(arrival => arrival.tripId), ['inbound-blue']);
  assert.deepEqual(outbound.predictions.map(prediction => prediction.tripId), ['outbound-blue']);
  assert.deepEqual(outbound.arrivals.map(arrival => arrival.tripId), ['outbound-blue']);
  assert.deepEqual(kenmoreB.predictions.map(prediction => prediction.tripId), ['green-b']);
  assert.deepEqual(kenmoreB.arrivals, [{ tripId: 'green-b', arrivedAtMs: start + 4000 }]);
  assert.deepEqual(kenmoreCD.predictions.map(prediction => prediction.tripId), ['green-c', 'green-d']);
  assert.deepEqual(kenmoreCD.arrivals, [{ tripId: 'green-d', arrivedAtMs: start + 4000 }]);
  assert.deepEqual(kenmoreCD.canceledTripIds, ['duplicate-branch']);
});

test('anonymous polling stays within budget and expires idle station watches', async () => {
  const requests = [];
  const anotherStation = definitions.find(platform => platform.stationId !== 'place-dwnxg');
  let nowMs = start;
  const live = createLiveTransit({
    now: () => nowMs,
    fetchImpl: async url => {
      requests.push(url);
      return Response.json({ data: [] });
    }
  });
  await live.observe('red-ashmont', { nowMs });
  for (let index = 1; index < 60; index++) {
    nowMs = start + index * 1000;
    await live.observe(anotherStation.id, { nowMs });
  }
  assert.equal(requests.length, 16);
  const predictionFilters = requests
    .filter(url => url.pathname === '/predictions')
    .map(url => url.searchParams.get('filter[stop]'));
  assert.deepEqual(predictionFilters.slice(0, 3), [
    'place-dwnxg', `place-dwnxg,${anotherStation.stationId}`, anotherStation.stationId
  ]);
});
