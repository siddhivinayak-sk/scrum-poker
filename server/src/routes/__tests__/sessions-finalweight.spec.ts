import express from 'express';
import request from 'supertest';

import { sessionsRouter } from '../sessions';
import { broadcastConfigUpdate } from '../../websocket/handler';
import { _resetStore, login } from '../../services/auth-service';
import { sessionRegistry } from '../../services/session-registry';
import { DEFAULT_SESSION_CONFIG, type SessionConfiguration } from '../../../../shared/types';

// Feature: final-weight-accuracy — `finalWeightEnabled` on PUT /:id/config and the
// registry's create-time normalisation.
// Validates: Requirements 1.3, 1.4, 1.7

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

function putConfig(sessionId: string, token: string, config: Record<string, unknown>) {
  return request(app)
    .put(`/api/sessions/${sessionId}/config`)
    .set('Authorization', `Bearer ${token}`)
    .send({ config });
}

async function setupSession(role: 'moderator' | 'participant', initial?: Partial<SessionConfiguration>) {
  const owner = login('alice', false);
  const other = login('bob', false);
  const res = await request(app)
    .post('/api/sessions')
    .set('Authorization', `Bearer ${owner.token}`)
    .send({ config: { ...DEFAULT_SESSION_CONFIG, ...initial } });
  expect(res.status).toBe(201);
  const sessionId = res.body.sessionId as string;
  const session = sessionRegistry.getSession(sessionId)!;
  session.addParticipant({ ...other.user, role });
  return { sessionId, session, owner, other };
}

describe('PUT /api/sessions/:sessionId/config — finalWeightEnabled', () => {
  it.each([
    ['the string "true"', 'true'],
    ['the string "false"', 'false'],
    ['the number 1', 1],
    ['the number 0', 0],
    ['null', null],
    ['an object', {}],
    ['an array', [true]],
  ])('rejects %s with 400 INVALID_SETTING, no state change and no broadcast', async (_l, value) => {
    const { sessionId, session, owner } = await setupSession('participant', { finalWeightEnabled: false });
    const before = { ...session.config };

    const res = await putConfig(sessionId, owner.token, { finalWeightEnabled: value, autoReveal: true });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'INVALID_SETTING', setting: 'finalWeightEnabled' });
    expect(session.config).toEqual(before);
    expect(broadcastMock).not.toHaveBeenCalled();
  });

  it('rejects a non-boolean from a moderator too', async () => {
    const { sessionId, session, other } = await setupSession('moderator');
    const before = { ...session.config };

    const res = await putConfig(sessionId, other.token, { finalWeightEnabled: 'true' });

    expect(res.status).toBe(400);
    expect(res.body.setting).toBe('finalWeightEnabled');
    expect(session.config).toEqual(before);
    expect(broadcastMock).not.toHaveBeenCalled();
  });

  it.each([true, false])('accepts boolean %s from the owner, stores it and broadcasts', async (next) => {
    const { sessionId, session, owner } = await setupSession('participant', { finalWeightEnabled: !next });

    const res = await putConfig(sessionId, owner.token, { finalWeightEnabled: next });

    expect(res.status).toBe(200);
    expect(res.body.config.finalWeightEnabled).toBe(next);
    expect(session.config.finalWeightEnabled).toBe(next);
    expect(broadcastMock).toHaveBeenCalledTimes(1);
    const [id, cfg] = broadcastMock.mock.calls[0];
    expect(id).toBe(sessionId);
    expect(cfg.finalWeightEnabled).toBe(next);
  });

  it.each([true, false])('accepts boolean %s from a non-owner moderator and broadcasts', async (next) => {
    const { sessionId, session, other } = await setupSession('moderator', { finalWeightEnabled: !next });

    const res = await putConfig(sessionId, other.token, { finalWeightEnabled: next });

    expect(res.status).toBe(200);
    expect(session.config.finalWeightEnabled).toBe(next);
    expect(broadcastMock).toHaveBeenCalledTimes(1);
    expect(broadcastMock.mock.calls[0][1].finalWeightEnabled).toBe(next);
  });

  it('still rejects a plain participant with 403', async () => {
    const { sessionId, session, other } = await setupSession('participant', { finalWeightEnabled: false });

    const res = await putConfig(sessionId, other.token, { finalWeightEnabled: true });

    expect(res.status).toBe(403);
    expect(session.config.finalWeightEnabled).toBe(false);
    expect(broadcastMock).not.toHaveBeenCalled();
  });
});

describe('SessionRegistry.createSession — finalWeightEnabled normalisation', () => {
  it('keeps the key absent when absent', () => {
    const { finalWeightEnabled: _o, ...base } = { ...DEFAULT_SESSION_CONFIG, finalWeightEnabled: true };
    const { sessionId } = sessionRegistry.createSession('owner-1', base as SessionConfiguration);

    const config = sessionRegistry.getSession(sessionId)!.config;
    expect('finalWeightEnabled' in config).toBe(false);
  });

  it.each([true, false])('stores boolean %s unchanged', (value) => {
    const { sessionId } = sessionRegistry.createSession('owner-1', {
      ...DEFAULT_SESSION_CONFIG,
      finalWeightEnabled: value,
    });

    expect(sessionRegistry.getSession(sessionId)!.config.finalWeightEnabled).toBe(value);
  });

  it.each([
    ['the string "true"', 'true'],
    ['the number 1', 1],
    ['null', null],
    ['undefined (key present)', undefined],
  ])('coerces %s to false when the key is present', (_l, value) => {
    const { sessionId } = sessionRegistry.createSession('owner-1', {
      ...DEFAULT_SESSION_CONFIG,
      finalWeightEnabled: value,
    } as unknown as SessionConfiguration);

    expect(sessionRegistry.getSession(sessionId)!.config.finalWeightEnabled).toBe(false);
  });
});
