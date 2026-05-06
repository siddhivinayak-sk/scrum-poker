import { IncomingMessage } from 'http';
import WebSocket from 'ws';
import { EventEmitter } from 'events';
import {
  handleWebSocket,
  _reset as resetHandler,
  getClients,
  getSessionClients,
} from '../handler';
import * as authService from '../../services/auth-service';
import { sessionRegistry } from '../../services/session-registry';
import { User, WebSocketMessage, DEFAULT_SESSION_CONFIG } from '../../../../shared/types';

// --- Helpers ---

/** Create a mock WebSocket that captures sent messages and supports events. */
function createMockWs(): WebSocket & { sentMessages: string[]; closedWith?: { code: number; reason: string } } {
  const emitter = new EventEmitter();
  const mock = emitter as any;
  mock.readyState = WebSocket.OPEN;
  mock.sentMessages = [];
  mock.send = jest.fn((data: string) => {
    mock.sentMessages.push(data);
  });
  mock.close = jest.fn((code?: number, reason?: string) => {
    mock.closedWith = { code: code || 1000, reason: reason || '' };
    mock.readyState = WebSocket.CLOSED;
  });
  // Proxy EventEmitter methods so ws.on / ws.emit work
  mock.on = emitter.on.bind(emitter);
  mock.emit = emitter.emit.bind(emitter);
  mock.removeAllListeners = emitter.removeAllListeners.bind(emitter);
  return mock;
}

/** Create a mock IncomingMessage with a given URL. */
function createMockRequest(url: string): IncomingMessage {
  return {
    url,
    headers: { host: 'localhost:3000' },
  } as unknown as IncomingMessage;
}

/** Parse a sent WebSocket message. */
function parseMessage(raw: string): WebSocketMessage {
  return JSON.parse(raw);
}

/** Create a valid JSON envelope for a client event. */
function clientMessage(event: string, data: any = {}): string {
  return JSON.stringify({
    event,
    data,
    timestamp: new Date().toISOString(),
  });
}

const testUser: User = {
  id: 'user-1',
  displayName: 'Alice',
  role: 'participant',
  isAnonymous: false,
};

const moderatorUser: User = {
  id: 'user-2',
  displayName: 'Bob',
  role: 'moderator',
  isAnonymous: false,
};

/** Helper: create a session and return its ID */
function createTestSession(): string {
  const info = sessionRegistry.createSession(moderatorUser.id, DEFAULT_SESSION_CONFIG);
  return info.sessionId;
}

/** Helper: create a mock request with token and sessionId */
function createSessionRequest(token: string, sessionId: string): IncomingMessage {
  return createMockRequest(`/?token=${token}&sessionId=${sessionId}`);
}

// --- Test Suite ---

describe('WebSocket Handler', () => {
  let sessionId: string;

  beforeEach(() => {
    resetHandler();
    sessionRegistry._reset();
    jest.restoreAllMocks();
    sessionId = createTestSession();
  });

  // ---- Authentication ----

  describe('Authentication', () => {
    it('should close connection when no token is provided', () => {
      const ws = createMockWs();
      const req = createMockRequest('/');

      handleWebSocket(ws, req);

      expect(ws.close).toHaveBeenCalledWith(4001, 'Authentication required');
    });

    it('should close connection when token is invalid', () => {
      jest.spyOn(authService, 'validateToken').mockReturnValue(null);
      const ws = createMockWs();
      const req = createSessionRequest('bad-token', sessionId);

      handleWebSocket(ws, req);

      expect(ws.close).toHaveBeenCalledWith(4001, 'Invalid or expired token');
    });

    it('should close connection when no sessionId is provided', () => {
      jest.spyOn(authService, 'validateToken').mockReturnValue(testUser);
      const ws = createMockWs();
      const req = createMockRequest('/?token=valid-token');

      handleWebSocket(ws, req);

      expect(ws.close).toHaveBeenCalledWith(4004, 'Session ID required');
    });

    it('should close connection when sessionId does not exist', () => {
      jest.spyOn(authService, 'validateToken').mockReturnValue(testUser);
      const ws = createMockWs();
      const req = createSessionRequest('valid-token', 'nonexistent');

      handleWebSocket(ws, req);

      expect(ws.close).toHaveBeenCalledWith(4004, 'Session not found');
    });

    it('should accept connection with valid token and sessionId and send session:state', () => {
      jest.spyOn(authService, 'validateToken').mockReturnValue(testUser);
      const ws = createMockWs();
      const req = createSessionRequest('valid-token', sessionId);

      handleWebSocket(ws, req);

      expect(ws.close).not.toHaveBeenCalled();
      // Should have sent session:state and participant:joined
      expect(ws.sentMessages.length).toBeGreaterThanOrEqual(2);

      const stateMsg = parseMessage(ws.sentMessages[0]);
      expect(stateMsg.event).toBe('session:state');
      expect(stateMsg.data.state).toBeDefined();
      expect(stateMsg.data.state.participants).toBeDefined();
      expect(stateMsg.data.state.sessionId).toBe(sessionId);
      expect(stateMsg.data.state.config).toBeDefined();

      const joinMsg = parseMessage(ws.sentMessages[1]);
      expect(joinMsg.event).toBe('participant:joined');
    });

    it('should register user as participant on connect', () => {
      jest.spyOn(authService, 'validateToken').mockReturnValue(testUser);
      const ws = createMockWs();
      const req = createSessionRequest('valid-token', sessionId);

      handleWebSocket(ws, req);

      const session = sessionRegistry.getSession(sessionId)!;
      const participants = session.getParticipants();
      expect(participants).toHaveLength(1);
      expect(participants[0].id).toBe(testUser.id);
    });
  });

  // ---- Session State on Reconnect ----

  describe('Session state on reconnect', () => {
    it('should send full session state including current round on reconnect', () => {
      // Set up a round first via moderator connection
      jest.spyOn(authService, 'validateToken').mockReturnValue(moderatorUser);
      const modWs = createMockWs();
      handleWebSocket(modWs, createSessionRequest('mod-token', sessionId));
      modWs.emit('message', Buffer.from(clientMessage('story:submit', { storyDescription: 'Test story' })));

      // Now connect as test user (reconnect scenario)
      jest.spyOn(authService, 'validateToken').mockReturnValue(testUser);
      const ws = createMockWs();
      handleWebSocket(ws, createSessionRequest('valid-token', sessionId));

      const stateMsg = parseMessage(ws.sentMessages[0]);
      expect(stateMsg.event).toBe('session:state');
      expect(stateMsg.data.state.currentRound).not.toBeNull();
      expect(stateMsg.data.state.currentRound.storyDescription).toBe('Test story');
    });
  });

  // ---- Message Routing ----

  describe('Message routing', () => {
    it('should send error for malformed JSON', () => {
      jest.spyOn(authService, 'validateToken').mockReturnValue(testUser);
      const ws = createMockWs();
      handleWebSocket(ws, createSessionRequest('valid-token', sessionId));

      ws.emit('message', Buffer.from('not json'));

      const lastMsg = parseMessage(ws.sentMessages[ws.sentMessages.length - 1]);
      expect(lastMsg.event).toBe('error');
      expect(lastMsg.data.code).toBe('INVALID_MESSAGE');
    });

    it('should send error for message without event field', () => {
      jest.spyOn(authService, 'validateToken').mockReturnValue(testUser);
      const ws = createMockWs();
      handleWebSocket(ws, createSessionRequest('valid-token', sessionId));

      ws.emit('message', Buffer.from(JSON.stringify({ data: {} })));

      const lastMsg = parseMessage(ws.sentMessages[ws.sentMessages.length - 1]);
      expect(lastMsg.event).toBe('error');
      expect(lastMsg.data.code).toBe('INVALID_MESSAGE');
    });

    it('should send error for unknown event', () => {
      jest.spyOn(authService, 'validateToken').mockReturnValue(testUser);
      const ws = createMockWs();
      handleWebSocket(ws, createSessionRequest('valid-token', sessionId));

      ws.emit('message', Buffer.from(clientMessage('unknown:event')));

      const lastMsg = parseMessage(ws.sentMessages[ws.sentMessages.length - 1]);
      expect(lastMsg.event).toBe('error');
      expect(lastMsg.data.code).toBe('UNKNOWN_EVENT');
    });
  });

  // ---- Permission-Based Authorization ----

  describe('Permission-based authorization', () => {
    it('should reject story:submit from a participant (default moderator-only issue permission)', () => {
      jest.spyOn(authService, 'validateToken').mockReturnValue(testUser);
      const ws = createMockWs();
      handleWebSocket(ws, createSessionRequest('valid-token', sessionId));

      ws.emit('message', Buffer.from(clientMessage('story:submit', { storyDescription: 'Story' })));

      const lastMsg = parseMessage(ws.sentMessages[ws.sentMessages.length - 1]);
      expect(lastMsg.event).toBe('error');
      expect(lastMsg.data.code).toBe('UNAUTHORIZED');
    });

    it('should reject cards:reveal from a participant (default moderator-only reveal permission)', () => {
      jest.spyOn(authService, 'validateToken').mockReturnValue(testUser);
      const ws = createMockWs();
      handleWebSocket(ws, createSessionRequest('valid-token', sessionId));

      ws.emit('message', Buffer.from(clientMessage('cards:reveal')));

      const lastMsg = parseMessage(ws.sentMessages[ws.sentMessages.length - 1]);
      expect(lastMsg.event).toBe('error');
      expect(lastMsg.data.code).toBe('UNAUTHORIZED');
    });

    it('should reject board:clear from a participant', () => {
      jest.spyOn(authService, 'validateToken').mockReturnValue(testUser);
      const ws = createMockWs();
      handleWebSocket(ws, createSessionRequest('valid-token', sessionId));

      ws.emit('message', Buffer.from(clientMessage('board:clear')));

      const lastMsg = parseMessage(ws.sentMessages[ws.sentMessages.length - 1]);
      expect(lastMsg.event).toBe('error');
      expect(lastMsg.data.code).toBe('UNAUTHORIZED');
    });

    it('should reject history:clear from a participant', () => {
      jest.spyOn(authService, 'validateToken').mockReturnValue(testUser);
      const ws = createMockWs();
      handleWebSocket(ws, createSessionRequest('valid-token', sessionId));

      ws.emit('message', Buffer.from(clientMessage('history:clear')));

      const lastMsg = parseMessage(ws.sentMessages[ws.sentMessages.length - 1]);
      expect(lastMsg.event).toBe('error');
      expect(lastMsg.data.code).toBe('UNAUTHORIZED');
    });

    it('should allow moderator to submit a story', () => {
      jest.spyOn(authService, 'validateToken').mockReturnValue(moderatorUser);
      const ws = createMockWs();
      handleWebSocket(ws, createSessionRequest('valid-token', sessionId));

      ws.emit('message', Buffer.from(clientMessage('story:submit', { storyDescription: 'My Story' })));

      const msgs = ws.sentMessages.map(parseMessage);
      const roundStarted = msgs.find((m) => m.event === 'round:started');
      expect(roundStarted).toBeDefined();
      expect(roundStarted!.data.round.storyDescription).toBe('My Story');
    });
  });

  // ---- Event Handlers ----

  describe('story:submit', () => {
    it('should broadcast round:started on valid story submission', () => {
      jest.spyOn(authService, 'validateToken').mockReturnValue(moderatorUser);
      const ws = createMockWs();
      handleWebSocket(ws, createSessionRequest('valid-token', sessionId));

      ws.emit('message', Buffer.from(clientMessage('story:submit', { storyDescription: 'Estimate this' })));

      const msgs = ws.sentMessages.map(parseMessage);
      const roundStarted = msgs.find((m) => m.event === 'round:started');
      expect(roundStarted).toBeDefined();
      expect(roundStarted!.data.round.status).toBe('voting');
    });

    it('should send error for empty story description', () => {
      jest.spyOn(authService, 'validateToken').mockReturnValue(moderatorUser);
      const ws = createMockWs();
      handleWebSocket(ws, createSessionRequest('valid-token', sessionId));

      ws.emit('message', Buffer.from(clientMessage('story:submit', { storyDescription: '' })));

      const lastMsg = parseMessage(ws.sentMessages[ws.sentMessages.length - 1]);
      expect(lastMsg.event).toBe('error');
      expect(lastMsg.data.code).toBe('EMPTY_STORY');
    });
  });

  describe('card:select', () => {
    it('should broadcast card:voted on valid card selection', () => {
      // Set up: moderator starts a round, then participant selects
      jest.spyOn(authService, 'validateToken')
        .mockReturnValueOnce(moderatorUser)
        .mockReturnValueOnce(testUser);

      const modWs = createMockWs();
      handleWebSocket(modWs, createSessionRequest('mod-token', sessionId));
      modWs.emit('message', Buffer.from(clientMessage('story:submit', { storyDescription: 'Story' })));

      const userWs = createMockWs();
      handleWebSocket(userWs, createSessionRequest('user-token', sessionId));

      userWs.emit('message', Buffer.from(clientMessage('card:select', { cardValue: 5 })));

      // Both clients should receive card:voted
      const modMsgs = modWs.sentMessages.map(parseMessage);
      const voted = modMsgs.find((m) => m.event === 'card:voted');
      expect(voted).toBeDefined();
      expect(voted!.data.userId).toBe(testUser.id);
    });

    it('should send error for invalid card value', () => {
      jest.spyOn(authService, 'validateToken').mockReturnValue(moderatorUser);
      const ws = createMockWs();
      handleWebSocket(ws, createSessionRequest('valid-token', sessionId));
      ws.emit('message', Buffer.from(clientMessage('story:submit', { storyDescription: 'Story' })));

      ws.emit('message', Buffer.from(clientMessage('card:select', { cardValue: 999 })));

      const lastMsg = parseMessage(ws.sentMessages[ws.sentMessages.length - 1]);
      expect(lastMsg.event).toBe('error');
      expect(lastMsg.data.code).toBe('INVALID_CARD');
    });

    it('should send error when no active round', () => {
      jest.spyOn(authService, 'validateToken').mockReturnValue(testUser);
      const ws = createMockWs();
      handleWebSocket(ws, createSessionRequest('valid-token', sessionId));

      ws.emit('message', Buffer.from(clientMessage('card:select', { cardValue: 5 })));

      const lastMsg = parseMessage(ws.sentMessages[ws.sentMessages.length - 1]);
      expect(lastMsg.event).toBe('error');
      expect(lastMsg.data.code).toBe('NO_ACTIVE_ROUND');
    });
  });

  describe('cards:reveal', () => {
    it('should broadcast cards:revealed with selections and metrics', () => {
      jest.spyOn(authService, 'validateToken')
        .mockReturnValueOnce(moderatorUser)
        .mockReturnValueOnce(testUser);

      const modWs = createMockWs();
      handleWebSocket(modWs, createSessionRequest('mod-token', sessionId));
      modWs.emit('message', Buffer.from(clientMessage('story:submit', { storyDescription: 'Story' })));

      const userWs = createMockWs();
      handleWebSocket(userWs, createSessionRequest('user-token', sessionId));
      userWs.emit('message', Buffer.from(clientMessage('card:select', { cardValue: 8 })));

      modWs.emit('message', Buffer.from(clientMessage('cards:reveal')));

      const modMsgs = modWs.sentMessages.map(parseMessage);
      const revealed = modMsgs.find((m) => m.event === 'cards:revealed');
      expect(revealed).toBeDefined();
      expect(revealed!.data.selections).toBeDefined();
      expect(revealed!.data.metrics).toBeDefined();
    });
  });

  describe('board:clear', () => {
    it('should broadcast board:cleared with history entry', () => {
      jest.spyOn(authService, 'validateToken').mockReturnValue(moderatorUser);
      const ws = createMockWs();
      handleWebSocket(ws, createSessionRequest('valid-token', sessionId));

      // Start round, reveal, then clear
      ws.emit('message', Buffer.from(clientMessage('story:submit', { storyDescription: 'Story' })));
      ws.emit('message', Buffer.from(clientMessage('cards:reveal')));
      ws.emit('message', Buffer.from(clientMessage('board:clear')));

      const msgs = ws.sentMessages.map(parseMessage);
      const cleared = msgs.find((m) => m.event === 'board:cleared');
      expect(cleared).toBeDefined();
      expect(cleared!.data.historyEntry).toBeDefined();
      expect(cleared!.data.historyEntry.storyDescription).toBe('Story');
    });
  });

  describe('role:change', () => {
    it('should broadcast role:changed when user changes role', () => {
      jest.spyOn(authService, 'validateToken').mockReturnValue(testUser);
      const ws = createMockWs();
      handleWebSocket(ws, createSessionRequest('valid-token', sessionId));

      ws.emit('message', Buffer.from(clientMessage('role:change', { role: 'moderator' })));

      const msgs = ws.sentMessages.map(parseMessage);
      const roleChanged = msgs.find((m) => m.event === 'role:changed');
      expect(roleChanged).toBeDefined();
      expect(roleChanged!.data.user.role).toBe('moderator');
    });

    it('should send error for invalid role', () => {
      jest.spyOn(authService, 'validateToken').mockReturnValue(testUser);
      const ws = createMockWs();
      handleWebSocket(ws, createSessionRequest('valid-token', sessionId));

      ws.emit('message', Buffer.from(clientMessage('role:change', { role: 'admin' })));

      const lastMsg = parseMessage(ws.sentMessages[ws.sentMessages.length - 1]);
      expect(lastMsg.event).toBe('error');
      expect(lastMsg.data.code).toBe('INVALID_ROLE');
    });
  });

  describe('history:clear', () => {
    it('should broadcast history:cleared when moderator clears history', () => {
      jest.spyOn(authService, 'validateToken').mockReturnValue(moderatorUser);
      const ws = createMockWs();
      handleWebSocket(ws, createSessionRequest('valid-token', sessionId));

      ws.emit('message', Buffer.from(clientMessage('history:clear')));

      const msgs = ws.sentMessages.map(parseMessage);
      const historyCleared = msgs.find((m) => m.event === 'history:cleared');
      expect(historyCleared).toBeDefined();
    });
  });

  // ---- Disconnect ----

  describe('Disconnect handling', () => {
    it('should remove participant and broadcast participant:left on disconnect', () => {
      jest.spyOn(authService, 'validateToken').mockReturnValue(testUser);
      const ws = createMockWs();
      handleWebSocket(ws, createSessionRequest('valid-token', sessionId));

      const session = sessionRegistry.getSession(sessionId)!;
      expect(session.getParticipants()).toHaveLength(1);

      // Simulate disconnect
      ws.emit('close');

      expect(session.getParticipants()).toHaveLength(0);
      expect(getClients().has(testUser.id)).toBe(false);
    });

    it('should not remove participant if other connections remain (multi-tab)', () => {
      jest.spyOn(authService, 'validateToken').mockReturnValue(testUser);

      const ws1 = createMockWs();
      handleWebSocket(ws1, createSessionRequest('valid-token', sessionId));

      const ws2 = createMockWs();
      handleWebSocket(ws2, createSessionRequest('valid-token', sessionId));

      const session = sessionRegistry.getSession(sessionId)!;
      expect(session.getParticipants()).toHaveLength(1);
      expect(getClients().get(testUser.id)?.size).toBe(2);

      // Close one connection
      ws1.emit('close');

      // Participant should still be active
      expect(session.getParticipants()).toHaveLength(1);
      expect(getClients().get(testUser.id)?.size).toBe(1);
    });

    it('should broadcast participant:left only when all connections close', () => {
      jest.spyOn(authService, 'validateToken')
        .mockReturnValueOnce(moderatorUser)
        .mockReturnValueOnce(testUser)
        .mockReturnValueOnce(testUser);

      // Connect moderator to receive broadcasts
      const modWs = createMockWs();
      handleWebSocket(modWs, createSessionRequest('mod-token', sessionId));

      // Connect participant with two tabs
      const ws1 = createMockWs();
      handleWebSocket(ws1, createSessionRequest('user-token', sessionId));
      const ws2 = createMockWs();
      handleWebSocket(ws2, createSessionRequest('user-token', sessionId));

      const countLeftEvents = () =>
        modWs.sentMessages.map(parseMessage).filter((m) => m.event === 'participant:left').length;

      // Close first tab — no participant:left yet
      ws1.emit('close');
      expect(countLeftEvents()).toBe(0);

      // Close second tab — now participant:left should fire
      ws2.emit('close');
      expect(countLeftEvents()).toBe(1);
    });
  });

  // ---- Broadcast to multiple clients ----

  describe('Broadcasting', () => {
    it('should broadcast events to all connected clients in the same session', () => {
      jest.spyOn(authService, 'validateToken')
        .mockReturnValueOnce(moderatorUser)
        .mockReturnValueOnce(testUser);

      const modWs = createMockWs();
      handleWebSocket(modWs, createSessionRequest('mod-token', sessionId));

      const userWs = createMockWs();
      handleWebSocket(userWs, createSessionRequest('user-token', sessionId));

      // Moderator submits story — both should receive round:started
      modWs.emit('message', Buffer.from(clientMessage('story:submit', { storyDescription: 'Broadcast test' })));

      const modMsgs = modWs.sentMessages.map(parseMessage);
      const userMsgs = userWs.sentMessages.map(parseMessage);

      expect(modMsgs.some((m) => m.event === 'round:started')).toBe(true);
      expect(userMsgs.some((m) => m.event === 'round:started')).toBe(true);
    });

    it('should NOT broadcast events to clients in a different session', () => {
      // Create a second session
      const sessionId2 = createTestSession();

      jest.spyOn(authService, 'validateToken')
        .mockReturnValueOnce(moderatorUser)
        .mockReturnValueOnce(testUser);

      const modWs = createMockWs();
      handleWebSocket(modWs, createSessionRequest('mod-token', sessionId));

      const otherWs = createMockWs();
      handleWebSocket(otherWs, createSessionRequest('user-token', sessionId2));

      // Moderator submits story in session 1
      modWs.emit('message', Buffer.from(clientMessage('story:submit', { storyDescription: 'Session 1 story' })));

      const otherMsgs = otherWs.sentMessages.map(parseMessage);
      // Other session should NOT receive round:started
      expect(otherMsgs.some((m) => m.event === 'round:started')).toBe(false);
    });
  });

  // ---- Event routing to correct GameSession ----

  describe('Event routing to correct GameSession', () => {
    it('should route story:submit to the correct session and not affect another session', () => {
      const sessionId2 = createTestSession();

      jest.spyOn(authService, 'validateToken')
        .mockReturnValueOnce(moderatorUser)
        .mockReturnValueOnce({ ...moderatorUser, id: 'mod-2', displayName: 'Mod2' });

      const ws1 = createMockWs();
      handleWebSocket(ws1, createSessionRequest('mod-token', sessionId));

      const ws2 = createMockWs();
      handleWebSocket(ws2, createSessionRequest('mod-token-2', sessionId2));

      // Submit story in session 1
      ws1.emit('message', Buffer.from(clientMessage('story:submit', { storyDescription: 'Session 1 story' })));

      // Session 1 should have an active round
      const session1 = sessionRegistry.getSession(sessionId)!;
      expect(session1.getCurrentRound()).not.toBeNull();
      expect(session1.getCurrentRound()!.storyDescription).toBe('Session 1 story');

      // Session 2 should NOT have an active round
      const session2 = sessionRegistry.getSession(sessionId2)!;
      expect(session2.getCurrentRound()).toBeNull();
    });

    it('should route card:select to the correct session state', () => {
      const sessionId2 = createTestSession();

      jest.spyOn(authService, 'validateToken')
        .mockReturnValueOnce(moderatorUser)
        .mockReturnValueOnce(testUser)
        .mockReturnValueOnce({ ...moderatorUser, id: 'mod-2', displayName: 'Mod2' });

      // Session 1: moderator + participant
      const modWs = createMockWs();
      handleWebSocket(modWs, createSessionRequest('mod-token', sessionId));
      const userWs = createMockWs();
      handleWebSocket(userWs, createSessionRequest('user-token', sessionId));

      // Session 2: moderator only
      const mod2Ws = createMockWs();
      handleWebSocket(mod2Ws, createSessionRequest('mod-token-2', sessionId2));

      // Start round in session 1 and select card
      modWs.emit('message', Buffer.from(clientMessage('story:submit', { storyDescription: 'Story' })));
      userWs.emit('message', Buffer.from(clientMessage('card:select', { cardValue: 8 })));

      // Session 1 should have the selection
      const session1 = sessionRegistry.getSession(sessionId)!;
      expect(session1.getSelections().get(testUser.id)).toBe(8);

      // Session 2 should have no round or selections
      const session2 = sessionRegistry.getSession(sessionId2)!;
      expect(session2.getCurrentRound()).toBeNull();
    });
  });

  // ---- Broadcast isolation between sessions ----

  describe('Broadcast isolation between sessions', () => {
    it('should isolate card:voted broadcasts to the correct session', () => {
      const sessionId2 = createTestSession();

      jest.spyOn(authService, 'validateToken')
        .mockReturnValueOnce(moderatorUser)
        .mockReturnValueOnce(testUser)
        .mockReturnValueOnce({ ...moderatorUser, id: 'mod-2', displayName: 'Mod2' });

      const modWs = createMockWs();
      handleWebSocket(modWs, createSessionRequest('mod-token', sessionId));
      const userWs = createMockWs();
      handleWebSocket(userWs, createSessionRequest('user-token', sessionId));
      const otherWs = createMockWs();
      handleWebSocket(otherWs, createSessionRequest('mod-token-2', sessionId2));

      // Start round and vote in session 1
      modWs.emit('message', Buffer.from(clientMessage('story:submit', { storyDescription: 'Story' })));
      userWs.emit('message', Buffer.from(clientMessage('card:select', { cardValue: 5 })));

      // Session 2 client should NOT receive card:voted
      const otherMsgs = otherWs.sentMessages.map(parseMessage);
      expect(otherMsgs.some((m) => m.event === 'card:voted')).toBe(false);
    });

    it('should isolate cards:revealed broadcasts to the correct session', () => {
      const sessionId2 = createTestSession();

      jest.spyOn(authService, 'validateToken')
        .mockReturnValueOnce(moderatorUser)
        .mockReturnValueOnce({ ...moderatorUser, id: 'mod-2', displayName: 'Mod2' });

      const modWs = createMockWs();
      handleWebSocket(modWs, createSessionRequest('mod-token', sessionId));
      const otherWs = createMockWs();
      handleWebSocket(otherWs, createSessionRequest('mod-token-2', sessionId2));

      // Start round and reveal in session 1
      modWs.emit('message', Buffer.from(clientMessage('story:submit', { storyDescription: 'Story' })));
      modWs.emit('message', Buffer.from(clientMessage('cards:reveal')));

      // Session 2 client should NOT receive cards:revealed
      const otherMsgs = otherWs.sentMessages.map(parseMessage);
      expect(otherMsgs.some((m) => m.event === 'cards:revealed')).toBe(false);
    });

    it('should isolate participant:joined broadcasts to the correct session', () => {
      const sessionId2 = createTestSession();

      jest.spyOn(authService, 'validateToken')
        .mockReturnValueOnce(moderatorUser)
        .mockReturnValueOnce({ ...moderatorUser, id: 'mod-2', displayName: 'Mod2' });

      // Connect to session 2 first
      const otherWs = createMockWs();
      handleWebSocket(otherWs, createSessionRequest('mod-token-2', sessionId2));
      const otherMsgCountBefore = otherWs.sentMessages.length;

      // Now connect to session 1
      const modWs = createMockWs();
      handleWebSocket(modWs, createSessionRequest('mod-token', sessionId));

      // Session 2 client should NOT receive participant:joined from session 1
      const newMsgs = otherWs.sentMessages.slice(otherMsgCountBefore).map(parseMessage);
      expect(newMsgs.some((m) => m.event === 'participant:joined')).toBe(false);
    });
  });

  // ---- Permission-based event handling (all modes) ----

  describe('Permission-based event handling (all modes)', () => {
    it('should allow participant to reveal when revealPermission is all-players', () => {
      // Create session with all-players reveal permission
      sessionRegistry._reset();
      resetHandler();
      const allPlayersConfig = {
        ...DEFAULT_SESSION_CONFIG,
        revealPermission: { mode: 'all-players' as const, allowedUserIds: [] },
      };
      const info = sessionRegistry.createSession(moderatorUser.id, allPlayersConfig);
      const sid = info.sessionId;

      jest.spyOn(authService, 'validateToken')
        .mockReturnValueOnce(moderatorUser)
        .mockReturnValueOnce(testUser);

      const modWs = createMockWs();
      handleWebSocket(modWs, createSessionRequest('mod-token', sid));
      modWs.emit('message', Buffer.from(clientMessage('story:submit', { storyDescription: 'Story' })));

      const userWs = createMockWs();
      handleWebSocket(userWs, createSessionRequest('user-token', sid));

      // Participant should be able to reveal
      userWs.emit('message', Buffer.from(clientMessage('cards:reveal')));

      const userMsgs = userWs.sentMessages.map(parseMessage);
      expect(userMsgs.some((m) => m.event === 'cards:revealed')).toBe(true);
      // Should NOT have an UNAUTHORIZED error
      const lastErrors = userMsgs.filter((m) => m.event === 'error' && m.data.code === 'UNAUTHORIZED');
      expect(lastErrors).toHaveLength(0);
    });

    it('should allow participant to submit story when issuePermission is all-players', () => {
      sessionRegistry._reset();
      resetHandler();
      const allPlayersConfig = {
        ...DEFAULT_SESSION_CONFIG,
        issuePermission: { mode: 'all-players' as const, allowedUserIds: [] },
      };
      const info = sessionRegistry.createSession(moderatorUser.id, allPlayersConfig);
      const sid = info.sessionId;

      jest.spyOn(authService, 'validateToken').mockReturnValue(testUser);
      const ws = createMockWs();
      handleWebSocket(ws, createSessionRequest('user-token', sid));

      ws.emit('message', Buffer.from(clientMessage('story:submit', { storyDescription: 'Participant story' })));

      const msgs = ws.sentMessages.map(parseMessage);
      expect(msgs.some((m) => m.event === 'round:started')).toBe(true);
    });

    it('should allow specific participant to reveal when in select-specific allowedUserIds', () => {
      sessionRegistry._reset();
      resetHandler();
      const selectConfig = {
        ...DEFAULT_SESSION_CONFIG,
        revealPermission: { mode: 'select-specific' as const, allowedUserIds: [testUser.id] },
      };
      const info = sessionRegistry.createSession(moderatorUser.id, selectConfig);
      const sid = info.sessionId;

      jest.spyOn(authService, 'validateToken')
        .mockReturnValueOnce(moderatorUser)
        .mockReturnValueOnce(testUser);

      const modWs = createMockWs();
      handleWebSocket(modWs, createSessionRequest('mod-token', sid));
      modWs.emit('message', Buffer.from(clientMessage('story:submit', { storyDescription: 'Story' })));

      const userWs = createMockWs();
      handleWebSocket(userWs, createSessionRequest('user-token', sid));

      userWs.emit('message', Buffer.from(clientMessage('cards:reveal')));

      const userMsgs = userWs.sentMessages.map(parseMessage);
      expect(userMsgs.some((m) => m.event === 'cards:revealed')).toBe(true);
    });

    it('should reject participant not in select-specific allowedUserIds from revealing', () => {
      sessionRegistry._reset();
      resetHandler();
      const selectConfig = {
        ...DEFAULT_SESSION_CONFIG,
        revealPermission: { mode: 'select-specific' as const, allowedUserIds: ['other-user-id'] },
      };
      const info = sessionRegistry.createSession(moderatorUser.id, selectConfig);
      const sid = info.sessionId;

      const freshParticipant: User = { id: 'user-no-perm', displayName: 'NoPerm', role: 'participant', isAnonymous: false };

      jest.spyOn(authService, 'validateToken')
        .mockReturnValueOnce(moderatorUser)
        .mockReturnValueOnce(freshParticipant);

      const modWs = createMockWs();
      handleWebSocket(modWs, createSessionRequest('mod-token', sid));
      modWs.emit('message', Buffer.from(clientMessage('story:submit', { storyDescription: 'Story' })));

      const userWs = createMockWs();
      handleWebSocket(userWs, createSessionRequest('user-token', sid));

      // Record message count before the reveal attempt
      const msgCountBefore = userWs.sentMessages.length;

      userWs.emit('message', Buffer.from(clientMessage('cards:reveal')));

      // The participant should receive an error, not a cards:revealed
      const newMsgs = userWs.sentMessages.slice(msgCountBefore).map(parseMessage);
      const errorMsg = newMsgs.find((m) => m.event === 'error');
      expect(errorMsg).toBeDefined();
      expect(errorMsg!.data.code).toBe('UNAUTHORIZED');
      expect(newMsgs.some((m) => m.event === 'cards:revealed')).toBe(false);
    });

    it('should allow specific participant to submit story when in select-specific allowedUserIds', () => {
      sessionRegistry._reset();
      resetHandler();
      const selectConfig = {
        ...DEFAULT_SESSION_CONFIG,
        issuePermission: { mode: 'select-specific' as const, allowedUserIds: [testUser.id] },
      };
      const info = sessionRegistry.createSession(moderatorUser.id, selectConfig);
      const sid = info.sessionId;

      jest.spyOn(authService, 'validateToken').mockReturnValue(testUser);
      const ws = createMockWs();
      handleWebSocket(ws, createSessionRequest('user-token', sid));

      ws.emit('message', Buffer.from(clientMessage('story:submit', { storyDescription: 'Allowed story' })));

      const msgs = ws.sentMessages.map(parseMessage);
      expect(msgs.some((m) => m.event === 'round:started')).toBe(true);
    });
  });

  // ---- Auto-reveal trigger ----

  describe('Auto-reveal trigger after last vote', () => {
    it('should trigger auto-reveal when all participants have voted and autoReveal is enabled (no countdown)', () => {
      sessionRegistry._reset();
      resetHandler();
      const autoRevealConfig = {
        ...DEFAULT_SESSION_CONFIG,
        autoReveal: true,
        countdownAnimation: false,
      };
      const info = sessionRegistry.createSession(moderatorUser.id, autoRevealConfig);
      const sid = info.sessionId;

      jest.spyOn(authService, 'validateToken')
        .mockReturnValueOnce(moderatorUser)
        .mockReturnValueOnce(testUser);

      const modWs = createMockWs();
      handleWebSocket(modWs, createSessionRequest('mod-token', sid));
      const userWs = createMockWs();
      handleWebSocket(userWs, createSessionRequest('user-token', sid));

      // Start round
      modWs.emit('message', Buffer.from(clientMessage('story:submit', { storyDescription: 'Auto reveal story' })));

      // Moderator votes
      modWs.emit('message', Buffer.from(clientMessage('card:select', { cardValue: 5 })));

      // Participant votes (last vote)
      userWs.emit('message', Buffer.from(clientMessage('card:select', { cardValue: 8 })));

      // Both should receive auto:reveal-triggered and cards:revealed
      const modMsgs = modWs.sentMessages.map(parseMessage);
      const userMsgs = userWs.sentMessages.map(parseMessage);

      expect(modMsgs.some((m) => m.event === 'auto:reveal-triggered')).toBe(true);
      expect(modMsgs.some((m) => m.event === 'cards:revealed')).toBe(true);
      expect(userMsgs.some((m) => m.event === 'auto:reveal-triggered')).toBe(true);
      expect(userMsgs.some((m) => m.event === 'cards:revealed')).toBe(true);

      // auto:reveal-triggered should have countdown: false
      const autoRevealMsg = modMsgs.find((m) => m.event === 'auto:reveal-triggered');
      expect(autoRevealMsg!.data.countdown).toBe(false);
    });

    it('should trigger auto-reveal with countdown flag when countdownAnimation is enabled', () => {
      sessionRegistry._reset();
      resetHandler();
      const autoRevealConfig = {
        ...DEFAULT_SESSION_CONFIG,
        autoReveal: true,
        countdownAnimation: true,
      };
      const info = sessionRegistry.createSession(moderatorUser.id, autoRevealConfig);
      const sid = info.sessionId;

      jest.spyOn(authService, 'validateToken')
        .mockReturnValueOnce(moderatorUser)
        .mockReturnValueOnce(testUser);

      const modWs = createMockWs();
      handleWebSocket(modWs, createSessionRequest('mod-token', sid));
      const userWs = createMockWs();
      handleWebSocket(userWs, createSessionRequest('user-token', sid));

      modWs.emit('message', Buffer.from(clientMessage('story:submit', { storyDescription: 'Countdown story' })));
      modWs.emit('message', Buffer.from(clientMessage('card:select', { cardValue: 3 })));
      userWs.emit('message', Buffer.from(clientMessage('card:select', { cardValue: 5 })));

      const modMsgs = modWs.sentMessages.map(parseMessage);

      // Should have auto:reveal-triggered with countdown: true
      const autoRevealMsg = modMsgs.find((m) => m.event === 'auto:reveal-triggered');
      expect(autoRevealMsg).toBeDefined();
      expect(autoRevealMsg!.data.countdown).toBe(true);

      // Should NOT have cards:revealed (client handles the delay when countdown is true)
      expect(modMsgs.some((m) => m.event === 'cards:revealed')).toBe(false);
    });

    it('should NOT trigger auto-reveal when autoReveal is disabled', () => {
      // Default config has autoReveal: false
      jest.spyOn(authService, 'validateToken')
        .mockReturnValueOnce(moderatorUser)
        .mockReturnValueOnce(testUser);

      const modWs = createMockWs();
      handleWebSocket(modWs, createSessionRequest('mod-token', sessionId));
      const userWs = createMockWs();
      handleWebSocket(userWs, createSessionRequest('user-token', sessionId));

      modWs.emit('message', Buffer.from(clientMessage('story:submit', { storyDescription: 'No auto reveal' })));
      modWs.emit('message', Buffer.from(clientMessage('card:select', { cardValue: 5 })));
      userWs.emit('message', Buffer.from(clientMessage('card:select', { cardValue: 8 })));

      const modMsgs = modWs.sentMessages.map(parseMessage);
      expect(modMsgs.some((m) => m.event === 'auto:reveal-triggered')).toBe(false);
      expect(modMsgs.some((m) => m.event === 'cards:revealed')).toBe(false);
    });

    it('should NOT trigger auto-reveal when not all participants have voted', () => {
      sessionRegistry._reset();
      resetHandler();
      const autoRevealConfig = {
        ...DEFAULT_SESSION_CONFIG,
        autoReveal: true,
        countdownAnimation: false,
      };
      const info = sessionRegistry.createSession(moderatorUser.id, autoRevealConfig);
      const sid = info.sessionId;

      jest.spyOn(authService, 'validateToken')
        .mockReturnValueOnce(moderatorUser)
        .mockReturnValueOnce(testUser);

      const modWs = createMockWs();
      handleWebSocket(modWs, createSessionRequest('mod-token', sid));
      const userWs = createMockWs();
      handleWebSocket(userWs, createSessionRequest('user-token', sid));

      modWs.emit('message', Buffer.from(clientMessage('story:submit', { storyDescription: 'Partial votes' })));

      // Only moderator votes, participant hasn't voted yet
      modWs.emit('message', Buffer.from(clientMessage('card:select', { cardValue: 5 })));

      const modMsgs = modWs.sentMessages.map(parseMessage);
      expect(modMsgs.some((m) => m.event === 'auto:reveal-triggered')).toBe(false);
      expect(modMsgs.some((m) => m.event === 'cards:revealed')).toBe(false);
    });
  });

  // ---- Session owner gets moderator role ----

  describe('Session owner role assignment', () => {
    it('should assign moderator role to session owner on connect', () => {
      // Create session owned by testUser (who is normally a participant)
      sessionRegistry._reset();
      resetHandler();
      const info = sessionRegistry.createSession(testUser.id, DEFAULT_SESSION_CONFIG);
      const sid = info.sessionId;

      jest.spyOn(authService, 'validateToken').mockReturnValue(testUser);
      const ws = createMockWs();
      handleWebSocket(ws, createSessionRequest('user-token', sid));

      const session = sessionRegistry.getSession(sid)!;
      const participants = session.getParticipants();
      const owner = participants.find((p) => p.id === testUser.id);
      expect(owner).toBeDefined();
      expect(owner!.role).toBe('moderator');
    });
  });

  // ---- Disconnect cleanup within session scope ----

  describe('Disconnect cleanup within session scope', () => {
    it('should clean up session client map entry when all users disconnect', () => {
      jest.spyOn(authService, 'validateToken').mockReturnValue(testUser);
      const ws = createMockWs();
      handleWebSocket(ws, createSessionRequest('valid-token', sessionId));

      expect(getSessionClients().has(sessionId)).toBe(true);

      ws.emit('close');

      // Session client map entry should be cleaned up
      expect(getSessionClients().has(sessionId)).toBe(false);
    });

    it('should only clean up the disconnected user from the correct session', () => {
      const sessionId2 = createTestSession();

      const user2: User = { id: 'user-3', displayName: 'Charlie', role: 'participant', isAnonymous: false };

      jest.spyOn(authService, 'validateToken')
        .mockReturnValueOnce(testUser)
        .mockReturnValueOnce(user2);

      const ws1 = createMockWs();
      handleWebSocket(ws1, createSessionRequest('user-token', sessionId));

      const ws2 = createMockWs();
      handleWebSocket(ws2, createSessionRequest('user2-token', sessionId2));

      // Disconnect from session 1
      ws1.emit('close');

      // Session 1 should have no participants
      const session1 = sessionRegistry.getSession(sessionId)!;
      expect(session1.getParticipants()).toHaveLength(0);

      // Session 2 should still have its participant
      const session2 = sessionRegistry.getSession(sessionId2)!;
      expect(session2.getParticipants()).toHaveLength(1);
      expect(session2.getParticipants()[0].id).toBe(user2.id);
    });

    it('should broadcast participant:left only within the disconnected session', () => {
      const sessionId2 = createTestSession();

      const user2: User = { id: 'user-3', displayName: 'Charlie', role: 'participant', isAnonymous: false };

      jest.spyOn(authService, 'validateToken')
        .mockReturnValueOnce(moderatorUser)
        .mockReturnValueOnce(testUser)
        .mockReturnValueOnce(user2);

      // Session 1: moderator + participant
      const modWs = createMockWs();
      handleWebSocket(modWs, createSessionRequest('mod-token', sessionId));
      const userWs = createMockWs();
      handleWebSocket(userWs, createSessionRequest('user-token', sessionId));

      // Session 2: another user
      const otherWs = createMockWs();
      handleWebSocket(otherWs, createSessionRequest('user2-token', sessionId2));

      const otherMsgCountBefore = otherWs.sentMessages.length;

      // Disconnect participant from session 1
      userWs.emit('close');

      // Moderator in session 1 should receive participant:left
      const modMsgs = modWs.sentMessages.map(parseMessage);
      expect(modMsgs.some((m) => m.event === 'participant:left')).toBe(true);

      // User in session 2 should NOT receive participant:left
      const newOtherMsgs = otherWs.sentMessages.slice(otherMsgCountBefore).map(parseMessage);
      expect(newOtherMsgs.some((m) => m.event === 'participant:left')).toBe(false);
    });
  });
});
