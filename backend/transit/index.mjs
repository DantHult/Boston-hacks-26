import { definitions } from './catalog.mjs';

const platformById = new Map(definitions.map(platform => [platform.id, platform]));
export const platforms = definitions.map(({ id, stationId, station, line, direction, routes }) => ({
  id, stationId, station, line, direction, routes
}));

function platformFor(id) {
  const platform = platformById.get(id);
  if (!platform) throw new Error(`Unknown platform ${id}`);
  return platform;
}

export function createDemoTransit() {
  return {
    async observe(platformId, { nowMs, openedAtMs, watchedTripId, demoRunId }) {
      platformFor(platformId);
      const tripId = watchedTripId ?? `demo:${platformId}:${demoRunId ?? 'first'}`;
      const arrivals = [];
      const predictions = [];
      if (openedAtMs == null) {
        predictions.push({ tripId, arrivalAtMs: nowMs + 240_000 });
      } else if (nowMs >= openedAtMs + 310_000) {
        arrivals.push({ tripId, arrivedAtMs: openedAtMs + 310_000 });
      } else {
        predictions.push({ tripId, arrivalAtMs: openedAtMs + 240_000 });
      }
      return { predictions, arrivals, canceledTripIds: [] };
    }
  };
}

const baseUrl = 'https://api-v3.mbta.com';
const railRoutes = [...new Set(definitions.flatMap(platform => platform.routes))].sort().join(',');
const observationRetentionMs = 15_000;

function relatedId(record, relationship) {
  return record.relationships?.[relationship]?.data?.id;
}

function canceled(attributes) {
  return ['CANCELED', 'CANCELLED'].includes(attributes?.schedule_relationship?.toUpperCase());
}

function indexByStop(records) {
  const result = new Map();
  for (const record of records) {
    const stopId = relatedId(record, 'stop');
    if (!stopId) continue;
    if (!result.has(stopId)) result.set(stopId, []);
    result.get(stopId).push(record);
  }
  return result;
}

function platformRows(index, platform) {
  const rows = platform.stopIds.flatMap(stopId => index.get(stopId) ?? []);
  return rows.filter(record => {
    const routeId = relatedId(record, 'route');
    return record.attributes?.direction_id === platform.directionId && platform.routes.includes(routeId);
  });
}

export function createLiveTransit({ apiKey, fetchImpl = fetch, now = Date.now, logger = console } = {}) {
  // Two shared requests per refresh allows at most 16 requests in an anonymous minute.
  const intervalMs = apiKey ? 4000 : 7500;
  const stationWatches = new Map();
  let nextRequestAtMs = -Infinity;
  let pending;
  let snapshot = { predictions: new Map(), vehicles: new Map(), trips: new Set() };

  async function load(resource, filters = {}) {
    const url = new URL(`/${resource}`, baseUrl);
    url.search = new URLSearchParams({ 'filter[route]': railRoutes, ...filters });
    const headers = { Accept: 'application/vnd.api+json' };
    if (apiKey) headers['x-api-key'] = apiKey;
    const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(4500) });
    if (response.status === 429) {
      const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
      nextRequestAtMs = Math.max(nextRequestAtMs, reset > now() ? reset : now() + 60_000);
    }
    if (!response.ok) throw new Error(`${resource} returned HTTP ${response.status}`);
    const payload = await response.json();
    if (!Array.isArray(payload.data)) throw new Error(`${resource} returned invalid data`);
    return payload;
  }

  async function update() {
    const expiredAtMs = now() - observationRetentionMs;
    for (const [stationId, observedAtMs] of stationWatches) {
      if (observedAtMs <= expiredAtMs) stationWatches.delete(stationId);
    }
    const filters = { 'filter[stop]': [...stationWatches.keys()].join(','), include: 'trip' };
    const results = await Promise.allSettled([load('predictions', filters), load('vehicles')]);
    const [predictions, vehicles] = results.map(result => {
      if (result.status === 'fulfilled') return result.value;
      logger.warn(`MBTA V3 ${result.reason.message}`);
      return { data: [] };
    });
    snapshot = {
      predictions: indexByStop(predictions.data),
      vehicles: indexByStop(vehicles.data),
      trips: new Set((predictions.included ?? []).filter(item => item.type === 'trip' && canceled(item.attributes)).map(item => item.id))
    };
  }

  async function currentSnapshot(stationId) {
    const observedAtMs = now();
    stationWatches.set(stationId, observedAtMs);
    if (!pending && observedAtMs >= nextRequestAtMs) {
      nextRequestAtMs = observedAtMs + intervalMs;
      // Collect simultaneous platform observations before sending the combined station filter.
      pending = Promise.resolve().then(update).finally(() => { pending = null; });
    }
    if (pending) await pending;
    return snapshot;
  }

  return {
    async observe(platformId, { nowMs, watchedTripId }) {
      const platform = platformFor(platformId);
      const rows = await currentSnapshot(platform.stationId);
      const predictions = [];
      const canceledTripIds = new Set();
      if (rows.trips.has(watchedTripId)) canceledTripIds.add(watchedTripId);
      for (const row of platformRows(rows.predictions, platform)) {
        const tripId = relatedId(row, 'trip');
        if (!tripId) continue;
        if (canceled(row.attributes) || rows.trips.has(tripId)) {
          canceledTripIds.add(tripId);
        } else {
          const arrivalAtMs = Date.parse(row.attributes.arrival_time);
          if (arrivalAtMs > nowMs) predictions.push({ tripId, arrivalAtMs });
        }
      }
      const arrivals = platformRows(rows.vehicles, platform).flatMap(row => {
        const tripId = relatedId(row, 'trip');
        const arrivedAtMs = Date.parse(row.attributes.updated_at);
        if (row.attributes.current_status !== 'STOPPED_AT' || !tripId || !Number.isFinite(arrivedAtMs)) return [];
        if (watchedTripId && tripId !== watchedTripId) return [];
        return [{ tripId, arrivedAtMs }];
      });
      predictions.sort((a, b) => a.arrivalAtMs - b.arrivalAtMs);
      return {
        predictions: predictions.filter(prediction => !canceledTripIds.has(prediction.tripId)),
        arrivals,
        canceledTripIds: [...canceledTripIds]
      };
    }
  };
}
