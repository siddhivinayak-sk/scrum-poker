import express from 'express';
import request from 'supertest';
import { sessionsRouter } from '../sessions';
import { _resetStore, login } from '../../services/auth-service';
import { sessionRegistry } from '../../services/session-registry';
import { DEFAULT_SESSION_CONFIG, SessionConfiguration } from '../../../../shared/types';

// Mock broadcastConfigUpdate so we don't need a real WebSocket server
jest.mock('../../websocket/handler', () => ({
  broadcastConfigUpdate: jest.fn(),
}));

const app = express();
app.use(express.json());
app.use('/api/sessions', sessionsRouter);

/** Helper: login a user and return their token and user info */
function loginUser(name: string) {
  return login(name, false);
}

beforeEach(() => {
  _resetStore();
  sessionRegistry._reset();
});

// ---------------------------------------------------------------------------
// POST /api/sessions — Create a new session
// ---------------------------------------------------------------------------
describe('POST /api/sessions', () => {
  it('should create a session with default config when no config provided', async () => {
    const { token } = loginUser('alice');

    const res = await request(app)
      .post('/api/sessions')
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('sessionId');
    expect(res.body).toHaveProperty('config');
    expect(res.body).toHaveProperty('createdAt');
    expect(res.body.config.votingSystem).toBe(DEFAULT_SESSION_CONFIG.votingSystem);
  });

  it('should create a session with a custom config', async () => {
    const { token } = loginUser('bob');

    const customConfig: SessionConfiguration = {
      votingSystem: 't-shirt',
      revealPermission: { mode: 'all-players', allowedUserIds: [] },
      issuePermission: { mode: 'moderator-only', allowedUserIds: [] },
      autoReveal: true,
      countdownAnimation: false,
    };

    const res = await request(app)
      .post('/api/sessions')
      .set('Authorization', `Bearer ${token}`)
      .send({ config: customConfig });

    expect(res.status).toBe(201);
    expect(res.body.config.votingSystem).toBe('t-shirt');
    expect(res.body.config.autoReveal).toBe(true);
    expect(res.body.config.revealPermission.mode).toBe('all-players');
  });

  it('should return 401 when no auth token is provided', async () => {
    const res = await request(app)
      .post('/api/sessions')
      .send({});

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHORIZED');
  });

  it('should return 401 when auth token is invalid', async () => {
    const res = await request(app)
      .post('/api/sessions')
      .set('Authorization', 'Bearer invalid-token')
      .send({});

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHORIZED');
  });

  it('should return 401 when Authorization header has wrong format', async () => {
    const res = await request(app)
      .post('/api/sessions')
      .set('Authorization', 'Basic some-token')
      .send({});

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHORIZED');
  });

  it('should register the session in the registry', async () => {
    const { token } = loginUser('charlie');

    const res = await request(app)
      .post('/api/sessions')
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(201);
    const sessionId = res.body.sessionId;
    expect(sessionRegistry.hasSession(sessionId)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GET /api/sessions/:sessionId — Get session info
// ---------------------------------------------------------------------------
describe('GET /api/sessions/:sessionId', () => {
  it('should return session info for an existing session', async () => {
    const { token, user } = loginUser('alice');

    // Create a session first
    const createRes = await request(app)
      .post('/api/sessions')
      .set('Authorization', `Bearer ${token}`)
      .send({});

    const sessionId = createRes.body.sessionId;

    const res = await request(app)
      .get(`/api/sessions/${sessionId}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.sessionId).toBe(sessionId);
    expect(res.body).toHaveProperty('config');
    expect(res.body).toHaveProperty('participantCount');
    expect(res.body).toHaveProperty('createdAt');
    expect(res.body.ownerId).toBe(user.id);
  });

  it('should return 404 for a non-existing session', async () => {
    const { token } = loginUser('bob');

    const res = await request(app)
      .get('/api/sessions/nonexist')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('SESSION_NOT_FOUND');
  });

  it('should return 401 when no auth token is provided', async () => {
    const res = await request(app)
      .get('/api/sessions/someid');

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHORIZED');
  });

  it('should return correct participant count', async () => {
    const { token } = loginUser('alice');

    const createRes = await request(app)
      .post('/api/sessions')
      .set('Authorization', `Bearer ${token}`)
      .send({});

    const sessionId = createRes.body.sessionId;

    // Add a participant directly to the session
    const session = sessionRegistry.getSession(sessionId)!;
    session.addParticipant({ id: 'user-1', displayName: 'User1', role: 'participant', isAnonymous: false });
    session.addParticipant({ id: 'user-2', displayName: 'User2', role: 'participant', isAnonymous: false });

    const res = await request(app)
      .get(`/api/sessions/${sessionId}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.participantCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// PUT /api/sessions/:sessionId/config — Update session configuration
// ---------------------------------------------------------------------------
describe('PUT /api/sessions/:sessionId/config', () => {
  it('should update config when user is the session owner', async () => {
    const { token } = loginUser('alice');

    const createRes = await request(app)
      .post('/api/sessions')
      .set('Authorization', `Bearer ${token}`)
      .send({});

    const sessionId = createRes.body.sessionId;

    const res = await request(app)
      .put(`/api/sessions/${sessionId}/config`)
      .set('Authorization', `Bearer ${token}`)
      .send({ config: { votingSystem: 'power-of-2' } });

    expect(res.status).toBe(200);
    expect(res.body.config.votingSystem).toBe('power-of-2');
    // Other fields should remain at defaults
    expect(res.body.config.autoReveal).toBe(DEFAULT_SESSION_CONFIG.autoReveal);
  });

  it('should update config when user is a moderator participant', async () => {
    const { token: ownerToken } = loginUser('alice');
    const { token: modToken, user: modUser } = loginUser('bob');

    const createRes = await request(app)
      .post('/api/sessions')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({});

    const sessionId = createRes.body.sessionId;

    // Add bob as a moderator participant
    const session = sessionRegistry.getSession(sessionId)!;
    session.addParticipant({ ...modUser, role: 'moderator' });

    const res = await request(app)
      .put(`/api/sessions/${sessionId}/config`)
      .set('Authorization', `Bearer ${modToken}`)
      .send({ config: { autoReveal: true } });

    expect(res.status).toBe(200);
    expect(res.body.config.autoReveal).toBe(true);
  });

  it('should return 403 when user is not owner and not moderator', async () => {
    const { token: ownerToken } = loginUser('alice');
    const { token: participantToken, user: participantUser } = loginUser('bob');

    const createRes = await request(app)
      .post('/api/sessions')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({});

    const sessionId = createRes.body.sessionId;

    // Add bob as a regular participant (not moderator)
    const session = sessionRegistry.getSession(sessionId)!;
    session.addParticipant({ ...participantUser, role: 'participant' });

    const res = await request(app)
      .put(`/api/sessions/${sessionId}/config`)
      .set('Authorization', `Bearer ${participantToken}`)
      .send({ config: { autoReveal: true } });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
  });

  it('should return 403 when user is not a participant at all and not owner', async () => {
    const { token: ownerToken } = loginUser('alice');
    const { token: strangerToken } = loginUser('stranger');

    const createRes = await request(app)
      .post('/api/sessions')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({});

    const sessionId = createRes.body.sessionId;

    const res = await request(app)
      .put(`/api/sessions/${sessionId}/config`)
      .set('Authorization', `Bearer ${strangerToken}`)
      .send({ config: { autoReveal: true } });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
  });

  it('should return 404 for a non-existing session', async () => {
    const { token } = loginUser('alice');

    const res = await request(app)
      .put('/api/sessions/nonexist/config')
      .set('Authorization', `Bearer ${token}`)
      .send({ config: { autoReveal: true } });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('SESSION_NOT_FOUND');
  });

  it('should return 401 when no auth token is provided', async () => {
    const res = await request(app)
      .put('/api/sessions/someid/config')
      .send({ config: { autoReveal: true } });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHORIZED');
  });

  it('should handle empty config update gracefully', async () => {
    const { token } = loginUser('alice');

    const createRes = await request(app)
      .post('/api/sessions')
      .set('Authorization', `Bearer ${token}`)
      .send({});

    const sessionId = createRes.body.sessionId;

    const res = await request(app)
      .put(`/api/sessions/${sessionId}/config`)
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(200);
    // Config should remain unchanged
    expect(res.body.config.votingSystem).toBe(DEFAULT_SESSION_CONFIG.votingSystem);
  });
});

// ---------------------------------------------------------------------------
// GET /api/sessions/:sessionId/exists — Check session existence
// ---------------------------------------------------------------------------
describe('GET /api/sessions/:sessionId/exists', () => {
  it('should return exists: true for an existing session', async () => {
    const { token } = loginUser('alice');

    const createRes = await request(app)
      .post('/api/sessions')
      .set('Authorization', `Bearer ${token}`)
      .send({});

    const sessionId = createRes.body.sessionId;

    // No auth required for exists check
    const res = await request(app)
      .get(`/api/sessions/${sessionId}/exists`);

    expect(res.status).toBe(200);
    expect(res.body.exists).toBe(true);
  });

  it('should return exists: false for a non-existing session', async () => {
    const res = await request(app)
      .get('/api/sessions/nonexist/exists');

    expect(res.status).toBe(200);
    expect(res.body.exists).toBe(false);
  });

  it('should not require authentication', async () => {
    // No Authorization header — should still work
    const res = await request(app)
      .get('/api/sessions/anysession/exists');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('exists');
  });
});
