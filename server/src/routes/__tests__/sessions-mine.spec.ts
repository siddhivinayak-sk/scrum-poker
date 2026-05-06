import express from 'express';
import request from 'supertest';
import { sessionsRouter } from '../sessions';
import { _resetStore, login } from '../../services/auth-service';
import { sessionRegistry } from '../../services/session-registry';
import { DEFAULT_SESSION_CONFIG } from '../../../../shared/types';

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

describe('GET /api/sessions/mine', () => {
  it('returns 401 for unauthenticated request', async () => {
    const res = await request(app).get('/api/sessions/mine');

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHORIZED');
  });

  it('returns 401 for invalid token', async () => {
    const res = await request(app)
      .get('/api/sessions/mine')
      .set('Authorization', 'Bearer invalid-token');

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHORIZED');
  });

  it('returns empty sessions array when user has no sessions', async () => {
    const { token } = loginUser('alice');

    const res = await request(app)
      .get('/api/sessions/mine')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.sessions).toEqual([]);
  });

  it('returns sessions owned by the authenticated user', async () => {
    const { token, user } = loginUser('alice');

    // Create sessions via the registry directly using the user's ID
    sessionRegistry.createSession(user.id, DEFAULT_SESSION_CONFIG);
    sessionRegistry.createSession(user.id, DEFAULT_SESSION_CONFIG);

    const res = await request(app)
      .get('/api/sessions/mine')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.sessions).toHaveLength(2);
  });

  it('does not return sessions owned by other users', async () => {
    const { token, user } = loginUser('alice');
    const { user: bob } = loginUser('bob');

    sessionRegistry.createSession(user.id, DEFAULT_SESSION_CONFIG);
    sessionRegistry.createSession(bob.id, DEFAULT_SESSION_CONFIG);
    sessionRegistry.createSession(bob.id, DEFAULT_SESSION_CONFIG);

    const res = await request(app)
      .get('/api/sessions/mine')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.sessions).toHaveLength(1);
  });

  it('returns sessions sorted by lastActivityAt descending', async () => {
    const { token, user } = loginUser('alice');

    // Create sessions with different activity times
    const info1 = sessionRegistry.createSession(user.id, DEFAULT_SESSION_CONFIG);
    const info2 = sessionRegistry.createSession(user.id, DEFAULT_SESSION_CONFIG);

    // Touch session 1 to make it more recent
    const session1 = sessionRegistry.getSession(info1.sessionId)!;
    session1.addParticipant({ id: 'p1', displayName: 'P1', role: 'participant', isAnonymous: false });

    const res = await request(app)
      .get('/api/sessions/mine')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.sessions).toHaveLength(2);

    // Session 1 was touched more recently, so it should be first
    const lastActivities = res.body.sessions.map((s: any) => new Date(s.lastActivityAt).getTime());
    expect(lastActivities[0]).toBeGreaterThanOrEqual(lastActivities[1]);
  });

  it('returns correct SessionSummary fields', async () => {
    const { token, user } = loginUser('alice');

    const info = sessionRegistry.createSession(user.id, {
      ...DEFAULT_SESSION_CONFIG,
      votingSystem: 't-shirt',
    });

    // Add participants and complete a round
    const session = sessionRegistry.getSession(info.sessionId)!;
    session.addParticipant({ id: 'p1', displayName: 'P1', role: 'participant', isAnonymous: false });
    session.addParticipant({ id: 'p2', displayName: 'P2', role: 'participant', isAnonymous: false });
    session.startRound('Test story');
    session.selectCard('p1', 5);
    session.selectCard('p2', 8);
    session.revealCards();
    session.clearBoard();

    const res = await request(app)
      .get('/api/sessions/mine')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.sessions).toHaveLength(1);

    const summary = res.body.sessions[0];
    expect(summary.sessionId).toBe(info.sessionId);
    expect(summary.createdAt).toBeDefined();
    expect(summary.lastActivityAt).toBeDefined();
    expect(summary.completedRounds).toBe(1);
    expect(summary.participantCount).toBe(2);
    expect(summary.config).toBeDefined();
    expect(summary.config.votingSystem).toBe('t-shirt');
  });

  it('returns correct completedRounds count with multiple rounds', async () => {
    const { token, user } = loginUser('alice');

    const info = sessionRegistry.createSession(user.id, DEFAULT_SESSION_CONFIG);
    const session = sessionRegistry.getSession(info.sessionId)!;
    session.addParticipant({ id: 'p1', displayName: 'P1', role: 'participant', isAnonymous: false });

    // Complete 3 rounds
    for (let i = 0; i < 3; i++) {
      session.startRound(`Story ${i}`);
      session.selectCard('p1', 5);
      session.revealCards();
      session.clearBoard();
    }

    const res = await request(app)
      .get('/api/sessions/mine')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.sessions[0].completedRounds).toBe(3);
  });
});
