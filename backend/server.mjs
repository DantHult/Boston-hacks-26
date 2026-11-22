import express from 'express';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ApiError, createGame, isLine, isMode, isPlatformId } from './game.mjs';
import { createDemoTransit, createLiveTransit, platforms } from './transit/index.mjs';

function required(value, isValid, code, message) {
  if (!isValid(value)) throw new ApiError(400, code, message);
  return value;
}

function requestMode(request) {
  return required(request.query.mode, isMode, 'invalid_mode', 'Choose demo or live mode.');
}

export function createApp(game) {
  const app = express();
  app.disable('x-powered-by');
  app.use((_request, response, next) => {
    response.set('Cache-Control', 'no-store');
    next();
  });
  app.use(express.json({ limit: '16kb' }));

  const api = express.Router();
  app.use('/api', api);
  api.post('/guests', (_request, response) => {
    response.status(201).json(game.createGuest());
  });
  api.get('/platforms', (request, response) => {
    requestMode(request);
    response.json({ platforms });
  });

  api.use((request, response, next) => {
    response.locals.guest = game.authenticate(request.get('Authorization'));
    next();
  });
  api.get('/guest', (_request, response) => {
    response.json({ guest: { nickname: response.locals.guest.nickname } });
  });
  api.get('/current', async (request, response) => {
    const mode = requestMode(request);
    const platformId = required(request.query.platformId, isPlatformId, 'invalid_platform', 'Choose an available platform.');
    response.json(await game.current(mode, platformId, response.locals.guest.id));
  });
  api.post('/rounds/:id/pick', async (request, response) => {
    response.json(await game.pick(request.params.id, response.locals.guest.id, request.body?.choice, request.body?.wagerCredits));
  });
  api.post('/wallet/refill', (request, response) => {
    const mode = requestMode(request);
    response.json(game.refillWallet(mode, response.locals.guest.id));
  });
  api.get('/leaderboard', (request, response) => {
    const mode = requestMode(request);
    const line = required(request.query.line, isLine, 'invalid_line', 'Choose an available line.');
    response.json(game.leaderboard(mode, line, response.locals.guest.id));
  });

  app.use((_request, _response, next) => {
    next(new ApiError(404, 'not_found', 'This API route is unavailable.'));
  });
  app.use((error, _request, response, next) => {
    if (response.headersSent) return next(error);
    if (error instanceof ApiError) {
      response.status(error.status).json({ error: { code: error.code, message: error.message } });
    } else if (error.status === 400 || error.status === 413) {
      const tooLarge = error.status === 413;
      const code = tooLarge ? 'body_too_large' : 'invalid_json';
      const message = tooLarge ? 'The request body is too large.' : 'Send a valid JSON object.';
      response.status(error.status).json({ error: { code, message } });
    } else {
      console.error(error);
      response.status(500).json({ error: { code: 'internal_error', message: 'The game server could not complete the request.' } });
    }
  });

  return app;
}

export function startServer(env = process.env) {
  const host = env.HOST ?? '0.0.0.0';
  const port = Number(env.PORT ?? 3000);
  const databasePath = env.DB_PATH ?? fileURLToPath(new URL('./beat-the-board.sqlite', import.meta.url));
  const game = createGame({
    databasePath,
    demoTransit: createDemoTransit(),
    liveTransit: createLiveTransit({ apiKey: env.MBTA_API_KEY })
  });
  const server = createApp(game).listen(port, host, () => {
    console.log(`Beat the Board listening on http://${host}:${server.address().port}`);
  });
  game.startPolling();
  server.once('close', () => {
    game.close().catch(error => {
      console.error(error);
      process.exitCode = 1;
    });
  });
  return server;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const server = startServer();
  process.once('SIGINT', () => server.close());
  process.once('SIGTERM', () => server.close());
}
