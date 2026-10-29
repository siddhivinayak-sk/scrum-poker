import express from 'express';
import request from 'supertest';

import { sessionsRouter } from '../sessions';
import { broadcastConfigUpdate } from '../../websocket/handler';
import { _resetStore, login } from '../../services/auth-service';
import { sessionRegistry } from '../../services/session-registry';
import {
  DEFAULT_SESSION_CONFIG,
  type SessionConfiguration,
} from '../../../../shared/types';

// Feature: vote-reveal-fun-callouts — the `funCallouts` setting on
// `POST /api/sessions` (creation normalisation) and
// `PUT /api/sessions/:sessionId/config` (owner-only, boolean-only guard).
//
// Requirements 6.6, 6.8, 6.10, 6.13.

// `broadcastConfigUpdate` is what emits `session:config-updated`; it is mocked
// so the suite needs no live WebSocket server and can assert on its calls.
jest.mock('../../websocket/handler', () => ({
  broadcastConfigUpdate: jest.fn(),
}));

const broadcastMock = broadcastConfigUpdate as jest.MockedFunction<typeof broadcastConfigUpdate>;

const app = express();
app.use(express.json());
app.use('/api/sessions', sessionsRouter);

beforeEach(() => {
  _resetStore();
  sessionRegistry._reset();
  broadcastMock.mockClear();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function loginUser(name: string) {
  return login(name, false);
}

/** Creates a session through the real route and returns its id. */
async function createViaRoute(token: string, config?: unknown): Promise<string> {
  const res = await request(app)
    .post('/api/sessions')
    .set('Authorization', `Bearer ${token}`)
    .send(config === undefined ? {} : { config });
  expect(res.status).toBe(201);
  return res.body.sessionId as string;
}

function putConfig(sessionId: string, token: string, config: Record<string, unknown>) {
  return request(app)
    .put(`/api/sessions/${sessionId}/config`)
    .set('Authorization', `Bearer ${token}`)
    .send({ config });
}

/** Sets up an owner plus a joined participant holding `role`. */
async function setupSession(role: 'moderator' | 'participant', initial?: Partial<SessionConfiguration>) {
  const owner = loginUser('alice');
  const other = loginUser('bob');
  const sessionId = await createViaRoute(owner.token, { ...DEFAULT_SESSION_CONFIG, ...initial });
  const session = sessionRegistry.getSession(sessionId)!;
  session.addParticipant({ ...other.user, role });
  return { sessionId, session, owner, other };
}

// ---------------------------------------------------------------------------
// Creation (R6.6)
// ---------------------------------------------------------------------------

describe('POST /api/sessions — funCallouts normalisation (R6.6)', () => {
  it('defaults funCallouts to true when no config is supplied', async () => {
    const { token } = loginUser('alice');
    const sessionId = await createViaRoute(token);

    expect(sessionRegistry.getSession(sessionId)!.config.funCallouts).toBe(true);
  });

  it('defaults funCallouts to true when the supplied config omits the key', async () => {
    const { token } = loginUser('alice');
    const { funCallouts: _omitted, ...withoutKey } = DEFAULT_SESSION_CONFIG;
    const sessionId = await createViaRoute(token, withoutKey);

    const res = await request(app)
      .get(`/api/sessions/${sessionId}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.config.funCallouts).toBe(true);
  });

  it('stores a supplied boolean unchanged', async () => {
    const { token } = loginUser('alice');
    const offId = await createViaRoute(token, { ...DEFAULT_SESSION_CONFIG, funCallouts: false });
    const onId = await createViaRoute(token, { ...DEFAULT_SESSION_CONFIG, funCallouts: true });

    expect(sessionRegistry.getSession(offId)!.config.funCallouts).toBe(false);
    expect(sessionRegistry.getSession(onId)!.config.funCallouts).toBe(true);
  });

  it.each([
    ['null', null],
    ['the string "false"', 'false'],
    ['the number 0', 0],
    ['an object', {}],
  ])('resolves %s to the boolean true', async (_label, value) => {
    const { token } = loginUser('alice');
    const sessionId = await createViaRoute(token, { ...DEFAULT_SESSION_CONFIG, funCallouts: value });

    const stored = sessionRegistry.getSession(sessionId)!.config.funCallouts;
    expect(typeof stored).toBe('boolean');
    expect(stored).toBe(true);
  });

  it('returns a boolean funCallouts in the creation response', async () => {
    const { token } = loginUser('alice');
    const res = await request(app)
      .post('/api/sessions')
      .set('Authorization', `Bearer ${token}`)
      .send({ config: { ...DEFAULT_SESSION_CONFIG, funCallouts: undefined } });

    expect(res.status).toBe(201);
    expect(res.body.config.funCallouts).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Owner change (R6.8)
// ---------------------------------------------------------------------------

describe('PUT /api/sessions/:sessionId/config — owner changes funCallouts (R6.8)', () => {
  it.each([false, true])('accepts the owner setting funCallouts to %s, stores it and broadcasts it', async (next) => {
    const { sessionId, session, owner } = await setupSession('participant', { funCallouts: !next });

    const res = await putConfig(sessionId, owner.token, { funCallouts: next });

    expect(res.status).toBe(200);
    expect(res.body.config.funCallouts).toBe(next);
    expect(session.config.funCallouts).toBe(next);

    expect(broadcastMock).toHaveBeenCalledTimes(1);
    const [broadcastSessionId, broadcastConfig] = broadcastMock.mock.calls[0];
    expect(broadcastSessionId).toBe(sessionId);
    expect(typeof broadcastConfig.funCallouts).toBe('boolean');
    expect(broadcastConfig.funCallouts).toBe(next);
  });

  it('applies the other fields in the same owner request', async () => {
    const { sessionId, session, owner } = await setupSession('participant');

    const res = await putConfig(sessionId, owner.token, { funCallouts: false, autoReveal: true });

    expect(res.status).toBe(200);
    expect(session.config.funCallouts).toBe(false);
    expect(session.config.autoReveal).toBe(true);
  });

  it('carries a boolean funCallouts in the state snapshot after the change', async () => {
    const { sessionId, session, owner } = await setupSession('participant');

    await putConfig(sessionId, owner.token, { funCallouts: false });

    expect(session.getSessionState().config.funCallouts).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Non-owner rejection (R6.10)
// ---------------------------------------------------------------------------

describe('PUT /api/sessions/:sessionId/config — non-owner funCallouts change (R6.10)', () => {
  it('rejects a non-owner moderator with 403, leaves the config unchanged and broadcasts nothing', async () => {
    const { sessionId, session, other } = await setupSession('moderator', { funCallouts: true });
    const before = { ...session.config };

    const res = await putConfig(sessionId, other.token, { funCallouts: false });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'FORBIDDEN', setting: 'funCallouts' });
    expect(session.config).toEqual(before);
    expect(session.config.funCallouts).toBe(true);
    expect(broadcastMock).not.toHaveBeenCalled();
  });

  it('rejects the whole request, so other fields sent alongside are not applied', async () => {
    const { sessionId, session, other } = await setupSession('moderator');
    const before = { ...session.config };

    const res = await putConfig(sessionId, other.token, { funCallouts: false, autoReveal: !before.autoReveal });

    expect(res.status).toBe(403);
    expect(session.config).toEqual(before);
    expect(broadcastMock).not.toHaveBeenCalled();
  });

  it('rejects a non-owner moderator who re-sends the current value', async () => {
    const { sessionId, session, other } = await setupSession('moderator', { funCallouts: true });

    const res = await putConfig(sessionId, other.token, { funCallouts: true });

    expect(res.status).toBe(403);
    expect(res.body.setting).toBe('funCallouts');
    expect(session.config.funCallouts).toBe(true);
    expect(broadcastMock).not.toHaveBeenCalled();
  });

  it('rejects a plain participant with 403, leaves the config unchanged and broadcasts nothing', async () => {
    const { sessionId, session, other } = await setupSession('participant', { funCallouts: true });
    const before = { ...session.config };

    const res = await putConfig(sessionId, other.token, { funCallouts: false });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
    expect(session.config).toEqual(before);
    expect(broadcastMock).not.toHaveBeenCalled();
  });

  it('rejects a user who has not joined the session', async () => {
    const { sessionId, session } = await setupSession('participant', { funCallouts: true });
    const stranger = loginUser('carol');

    const res = await putConfig(sessionId, stranger.token, { funCallouts: false });

    expect(res.status).toBe(403);
    expect(session.config.funCallouts).toBe(true);
    expect(broadcastMock).not.toHaveBeenCalled();
  });

  it('reports the ownership failure (403) for a non-owner even when the value is not a boolean', async () => {
    const { sessionId, session, other } = await setupSession('moderator', { funCallouts: true });

    const res = await putConfig(sessionId, other.token, { funCallouts: 'no' });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'FORBIDDEN', setting: 'funCallouts' });
    expect(session.config.funCallouts).toBe(true);
    expect(broadcastMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Non-boolean rejection (R6.13)
// ---------------------------------------------------------------------------

describe('PUT /api/sessions/:sessionId/config — non-boolean funCallouts (R6.13)', () => {
  it.each([
    ['the string "false"', 'false'],
    ['the string "true"', 'true'],
    ['the number 0', 0],
    ['the number 1', 1],
    ['null', null],
    ['an object', {}],
    ['an array', [true]],
  ])('rejects %s from the owner with 400 and changes nothing', async (_label, value) => {
    const { sessionId, session, owner } = await setupSession('participant', { funCallouts: true });
    const before = { ...session.config };

    const res = await putConfig(sessionId, owner.token, { funCallouts: value });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'INVALID_SETTING', setting: 'funCallouts' });
    expect(session.config).toEqual(before);
    expect(typeof session.config.funCallouts).toBe('boolean');
    expect(broadcastMock).not.toHaveBeenCalled();
  });

  it('rejects the whole owner request, so other fields sent alongside are not applied', async () => {
    const { sessionId, session, owner } = await setupSession('participant');
    const before = { ...session.config };

    const res = await putConfig(sessionId, owner.token, { funCallouts: 'yes', autoReveal: !before.autoReveal });

    expect(res.status).toBe(400);
    expect(session.config).toEqual(before);
    expect(broadcastMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Requests without the key (additive guard)
// ---------------------------------------------------------------------------

describe('PUT /api/sessions/:sessionId/config — requests without funCallouts', () => {
  it('still lets a moderator change other fields and broadcasts a boolean funCallouts', async () => {
    const { sessionId, session, other } = await setupSession('moderator', { funCallouts: false });

    const res = await putConfig(sessionId, other.token, { autoReveal: true });

    expect(res.status).toBe(200);
    expect(res.body.config.autoReveal).toBe(true);
    expect(session.config.autoReveal).toBe(true);
    // The untouched setting survives the update.
    expect(session.config.funCallouts).toBe(false);

    expect(broadcastMock).toHaveBeenCalledTimes(1);
    const [, broadcastConfig] = broadcastMock.mock.calls[0];
    expect(typeof broadcastConfig.funCallouts).toBe('boolean');
    expect(broadcastConfig.funCallouts).toBe(false);
  });

  it('still lets the owner change other fields', async () => {
    const { sessionId, session, owner } = await setupSession('participant');

    const res = await putConfig(sessionId, owner.token, { autoReveal: true });

    expect(res.status).toBe(200);
    expect(session.config.autoReveal).toBe(true);
    expect(broadcastMock).toHaveBeenCalledTimes(1);
  });

  it('still lets a moderator send an empty config', async () => {
    const { sessionId, other } = await setupSession('moderator');

    const res = await putConfig(sessionId, other.token, {});

    expect(res.status).toBe(200);
    expect(typeof res.body.config.funCallouts).toBe('boolean');
  });

  it('still answers a plain participant with a bare FORBIDDEN (no setting named)', async () => {
    const { sessionId, session, other } = await setupSession('participant');

    const res = await putConfig(sessionId, other.token, { autoReveal: true });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'FORBIDDEN' });
    expect(session.config.autoReveal).toBe(DEFAULT_SESSION_CONFIG.autoReveal);
    expect(broadcastMock).not.toHaveBeenCalled();
  });
});
