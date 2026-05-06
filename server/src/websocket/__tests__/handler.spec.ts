import { IncomingMessage } from 'http';
import WebSocket from 'ws';
import { EventEmitter } from 'events';
import {
  handleWebSocket,
  _reset as resetHandler,
} from '../handler';
import * as authService from '../../services/auth-service';
import { sessionRegistry } from '../../services/session-registry';
import { User, WebSocketMessage, DEFAULT_SESSION_CONFIG, SessionConfiguration } from '../../../../shared/types';

// --- Helpers (same patterns as handler.test.ts) ---

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
  mock.on = emitter.on.bind(emitter);
  mock.emit = emitter.emit.bind(emitter);
  mock.removeAllListeners = emitter.removeAllListeners.bind(emitter);
  return mock;
}

function createMockRequest(url: string): IncomingMessage {
  return {
    url,
    headers: { host: 'localhost:3000' },
  } as unknown as IncomingMessage;
}

function parseMessage(raw: string): WebSocketMessage {
  return JSON.parse(raw);
}

function clientMessage(event: string, data: any = {}): string {
  return JSON.stringify({
    event,
    data,
    timestamp: new Date().toISOString(),
  });
}

function createSessionRequest(token: string, sessionId: string): IncomingMessage {
  return createMockRequest(`/?token=${token}&sessionId=${sessionId}`);
}

// --- Test Users ---

const moderatorUser: User = {
  id: 'mod-1',
  displayName: 'Moderator',
  role: 'moderator',
  isAnonymous: false,
};

const participantA: User = {
  id: 'user-a',
  displayName: 'Alice',
  role: 'participant',
  isAnonymous: false,
};

const participantB: User = {
  id: 'user-b',
  displayName: 'Bob',
  role: 'participant',
  isAnonymous: false,
};

// --- Test Suite ---

describe('WebSocket Handler - New Event Handlers', () => {
  let sessionId: string;

  beforeEach(() => {
    resetHandler();
    sessionRegistry._reset();
    jest.restoreAllMocks();
    // Create a session owned by moderatorUser
    const info = sessionRegistry.createSession(moderatorUser.id, DEFAULT_SESSION_CONFIG);
    sessionId = info.sessionId;
  });

  // ---- Display Name Rejection on Connect ----

  describe('Display name rejection on connect', () => {
    it('should reject connection when display name is already in use (case-insensitive)', () => {
      // Connect user A with name "Alice"
      jest.spyOn(authService, 'validateToken').mockReturnValueOnce(participantA);
      const wsA = createMockWs();
      handleWebSocket(wsA, createSessionRequest('token-a', sessionId));
      expect(wsA.close).not.toHaveBeenCalled();

      // Try to connect user B with name "alice" (case-insensitive duplicate)
      const duplicateUser: User = { id: 'user-c', displayName: 'alice', role: 'participant', isAnonymous: false };
      jest.spyOn(authService, 'validateToken').mockReturnValueOnce(duplicateUser);
      const wsB = createMockWs();
      handleWebSocket(wsB, createSessionRequest('token-b', sessionId));

      expect(wsB.close).toHaveBeenCalledWith(4009, 'Display name already in use in this session');
    });

    it('should reject connection when display name differs only in whitespace/case', () => {
      jest.spyOn(authService, 'validateToken').mockReturnValueOnce(participantA);
      const wsA = createMockWs();
      handleWebSocket(wsA, createSessionRequest('token-a', sessionId));

      const duplicateUser: User = { id: 'user-c', displayName: ' ALICE ', role: 'participant', isAnonymous: false };
      jest.spyOn(authService, 'validateToken').mockReturnValueOnce(duplicateUser);
      const wsB = createMockWs();
      handleWebSocket(wsB, createSessionRequest('token-b', sessionId));

      expect(wsB.close).toHaveBeenCalledWith(4009, 'Display name already in use in this session');
    });

    it('should allow session owner to reconnect with same name (not rejected)', () => {
      // Connect moderator (session owner)
      jest.spyOn(authService, 'validateToken').mockReturnValueOnce(moderatorUser);
      const wsOwner = createMockWs();
      handleWebSocket(wsOwner, createSessionRequest('token-mod', sessionId));
      expect(wsOwner.close).not.toHaveBeenCalled();

      // Reconnect session owner with same name (second tab)
      jest.spyOn(authService, 'validateToken').mockReturnValueOnce(moderatorUser);
      const wsOwner2 = createMockWs();
      handleWebSocket(wsOwner2, createSessionRequest('token-mod', sessionId));
      expect(wsOwner2.close).not.toHaveBeenCalled();
    });

    it('should allow different display names to connect', () => {
      jest.spyOn(authService, 'validateToken').mockReturnValueOnce(participantA);
      const wsA = createMockWs();
      handleWebSocket(wsA, createSessionRequest('token-a', sessionId));

      jest.spyOn(authService, 'validateToken').mockReturnValueOnce(participantB);
      const wsB = createMockWs();
      handleWebSocket(wsB, createSessionRequest('token-b', sessionId));

      expect(wsA.close).not.toHaveBeenCalled();
      expect(wsB.close).not.toHaveBeenCalled();
    });
  });

  // ---- participant:remove ----

  describe('participant:remove', () => {
    it('should reject removal from non-moderator (UNAUTHORIZED)', () => {
      // Connect moderator and participant
      jest.spyOn(authService, 'validateToken')
        .mockReturnValueOnce(moderatorUser)
        .mockReturnValueOnce(participantA);

      const modWs = createMockWs();
      handleWebSocket(modWs, createSessionRequest('token-mod', sessionId));
      const userWs = createMockWs();
      handleWebSocket(userWs, createSessionRequest('token-a', sessionId));

      // Participant tries to remove moderator
      userWs.emit('message', Buffer.from(clientMessage('participant:remove', { userId: moderatorUser.id })));

      const lastMsg = parseMessage(userWs.sentMessages[userWs.sentMessages.length - 1]);
      expect(lastMsg.event).toBe('error');
      expect(lastMsg.data.code).toBe('UNAUTHORIZED');
    });

    it('should reject moderator removing self (INVALID_ACTION)', () => {
      jest.spyOn(authService, 'validateToken').mockReturnValueOnce(moderatorUser);
      const modWs = createMockWs();
      handleWebSocket(modWs, createSessionRequest('token-mod', sessionId));

      modWs.emit('message', Buffer.from(clientMessage('participant:remove', { userId: moderatorUser.id })));

      const lastMsg = parseMessage(modWs.sentMessages[modWs.sentMessages.length - 1]);
      expect(lastMsg.event).toBe('error');
      expect(lastMsg.data.code).toBe('INVALID_ACTION');
    });

    it('should return USER_NOT_FOUND when removing non-existent user', () => {
      jest.spyOn(authService, 'validateToken').mockReturnValueOnce(moderatorUser);
      const modWs = createMockWs();
      handleWebSocket(modWs, createSessionRequest('token-mod', sessionId));

      modWs.emit('message', Buffer.from(clientMessage('participant:remove', { userId: 'non-existent-id' })));

      const lastMsg = parseMessage(modWs.sentMessages[modWs.sentMessages.length - 1]);
      expect(lastMsg.event).toBe('error');
      expect(lastMsg.data.code).toBe('USER_NOT_FOUND');
    });

    it('should send participant:removed to target before disconnecting', () => {
      jest.spyOn(authService, 'validateToken')
        .mockReturnValueOnce(moderatorUser)
        .mockReturnValueOnce(participantA);

      const modWs = createMockWs();
      handleWebSocket(modWs, createSessionRequest('token-mod', sessionId));
      const userWs = createMockWs();
      handleWebSocket(userWs, createSessionRequest('token-a', sessionId));

      // Moderator removes participant A
      modWs.emit('message', Buffer.from(clientMessage('participant:remove', { userId: participantA.id })));

      // Target should have received participant:removed
      const userMsgs = userWs.sentMessages.map(parseMessage);
      const removedMsg = userMsgs.find(m => m.event === 'participant:removed');
      expect(removedMsg).toBeDefined();
      expect(removedMsg!.data.reason).toBe('Removed by moderator');
    });

    it('should close target WebSocket with code 4010 after removal', () => {
      jest.spyOn(authService, 'validateToken')
        .mockReturnValueOnce(moderatorUser)
        .mockReturnValueOnce(participantA);

      const modWs = createMockWs();
      handleWebSocket(modWs, createSessionRequest('token-mod', sessionId));
      const userWs = createMockWs();
      handleWebSocket(userWs, createSessionRequest('token-a', sessionId));

      modWs.emit('message', Buffer.from(clientMessage('participant:remove', { userId: participantA.id })));

      expect(userWs.close).toHaveBeenCalledWith(4010, 'Removed from session by moderator');
    });

    it('should broadcast participant:left to remaining clients after removal', () => {
      jest.spyOn(authService, 'validateToken')
        .mockReturnValueOnce(moderatorUser)
        .mockReturnValueOnce(participantA)
        .mockReturnValueOnce(participantB);

      const modWs = createMockWs();
      handleWebSocket(modWs, createSessionRequest('token-mod', sessionId));
      const userAWs = createMockWs();
      handleWebSocket(userAWs, createSessionRequest('token-a', sessionId));
      const userBWs = createMockWs();
      handleWebSocket(userBWs, createSessionRequest('token-b', sessionId));

      // Record message count before removal
      const modMsgCountBefore = modWs.sentMessages.length;
      const userBMsgCountBefore = userBWs.sentMessages.length;

      // Moderator removes participant A
      modWs.emit('message', Buffer.from(clientMessage('participant:remove', { userId: participantA.id })));

      // Moderator and participant B should receive participant:left
      const modNewMsgs = modWs.sentMessages.slice(modMsgCountBefore).map(parseMessage);
      const leftMsgMod = modNewMsgs.find(m => m.event === 'participant:left');
      expect(leftMsgMod).toBeDefined();
      // Participant A should not be in the updated list
      expect(leftMsgMod!.data.participants.find((p: any) => p.id === participantA.id)).toBeUndefined();

      const userBNewMsgs = userBWs.sentMessages.slice(userBMsgCountBefore).map(parseMessage);
      const leftMsgB = userBNewMsgs.find(m => m.event === 'participant:left');
      expect(leftMsgB).toBeDefined();
    });

    it('should remove participant from session state after removal', () => {
      jest.spyOn(authService, 'validateToken')
        .mockReturnValueOnce(moderatorUser)
        .mockReturnValueOnce(participantA);

      const modWs = createMockWs();
      handleWebSocket(modWs, createSessionRequest('token-mod', sessionId));
      const userWs = createMockWs();
      handleWebSocket(userWs, createSessionRequest('token-a', sessionId));

      const session = sessionRegistry.getSession(sessionId)!;
      expect(session.getParticipants().find(p => p.id === participantA.id)).toBeDefined();

      modWs.emit('message', Buffer.from(clientMessage('participant:remove', { userId: participantA.id })));

      expect(session.getParticipants().find(p => p.id === participantA.id)).toBeUndefined();
    });
  });

  // ---- round:revote ----

  describe('round:revote', () => {
    it('should reject revote from user without reveal permission (UNAUTHORIZED)', () => {
      // Default config: revealPermission is moderator-only
      jest.spyOn(authService, 'validateToken')
        .mockReturnValueOnce(moderatorUser)
        .mockReturnValueOnce(participantA);

      const modWs = createMockWs();
      handleWebSocket(modWs, createSessionRequest('token-mod', sessionId));
      const userWs = createMockWs();
      handleWebSocket(userWs, createSessionRequest('token-a', sessionId));

      // Start and reveal a round
      modWs.emit('message', Buffer.from(clientMessage('story:submit', { storyDescription: 'Story' })));
      modWs.emit('message', Buffer.from(clientMessage('cards:reveal')));

      // Participant tries to revote
      userWs.emit('message', Buffer.from(clientMessage('round:revote')));

      const lastMsg = parseMessage(userWs.sentMessages[userWs.sentMessages.length - 1]);
      expect(lastMsg.event).toBe('error');
      expect(lastMsg.data.code).toBe('UNAUTHORIZED');
    });

    it('should allow user with reveal permission to revote after reveal', () => {
      jest.spyOn(authService, 'validateToken').mockReturnValueOnce(moderatorUser);
      const modWs = createMockWs();
      handleWebSocket(modWs, createSessionRequest('token-mod', sessionId));

      // Start round, reveal, then revote
      modWs.emit('message', Buffer.from(clientMessage('story:submit', { storyDescription: 'Revote Story' })));
      modWs.emit('message', Buffer.from(clientMessage('cards:reveal')));
      modWs.emit('message', Buffer.from(clientMessage('round:revote')));

      const msgs = modWs.sentMessages.map(parseMessage);
      const roundStartedMsgs = msgs.filter(m => m.event === 'round:started');
      // Should have two round:started messages (initial + revote)
      expect(roundStartedMsgs.length).toBe(2);
      // The revote round should have the same story description
      expect(roundStartedMsgs[1].data.round.storyDescription).toBe('Revote Story');
      expect(roundStartedMsgs[1].data.round.status).toBe('voting');
    });

    it('should broadcast round:started to all participants on revote', () => {
      // Create session with all-players reveal permission
      sessionRegistry._reset();
      resetHandler();
      const allPlayersConfig: SessionConfiguration = {
        ...DEFAULT_SESSION_CONFIG,
        revealPermission: { mode: 'all-players', allowedUserIds: [] },
      };
      const info = sessionRegistry.createSession(moderatorUser.id, allPlayersConfig);
      const sid = info.sessionId;

      jest.spyOn(authService, 'validateToken')
        .mockReturnValueOnce(moderatorUser)
        .mockReturnValueOnce(participantA);

      const modWs = createMockWs();
      handleWebSocket(modWs, createSessionRequest('token-mod', sid));
      const userWs = createMockWs();
      handleWebSocket(userWs, createSessionRequest('token-a', sid));

      // Start, reveal, revote
      modWs.emit('message', Buffer.from(clientMessage('story:submit', { storyDescription: 'Broadcast Story' })));
      modWs.emit('message', Buffer.from(clientMessage('cards:reveal')));

      const userMsgCountBefore = userWs.sentMessages.length;
      modWs.emit('message', Buffer.from(clientMessage('round:revote')));

      const userNewMsgs = userWs.sentMessages.slice(userMsgCountBefore).map(parseMessage);
      const roundStarted = userNewMsgs.find(m => m.event === 'round:started');
      expect(roundStarted).toBeDefined();
      expect(roundStarted!.data.round.storyDescription).toBe('Broadcast Story');
    });

    it('should return error when revote is attempted without a revealed round', () => {
      jest.spyOn(authService, 'validateToken').mockReturnValueOnce(moderatorUser);
      const modWs = createMockWs();
      handleWebSocket(modWs, createSessionRequest('token-mod', sessionId));

      // Try revote without any round
      modWs.emit('message', Buffer.from(clientMessage('round:revote')));

      const lastMsg = parseMessage(modWs.sentMessages[modWs.sentMessages.length - 1]);
      expect(lastMsg.event).toBe('error');
      expect(lastMsg.data.code).toBe('REVOTE_ERROR');
    });
  });

  // ---- issue:add ----

  describe('issue:add', () => {
    it('should reject issue:add from user without issue permission (UNAUTHORIZED)', () => {
      // Default config: issuePermission is moderator-only
      jest.spyOn(authService, 'validateToken')
        .mockReturnValueOnce(moderatorUser)
        .mockReturnValueOnce(participantA);

      const modWs = createMockWs();
      handleWebSocket(modWs, createSessionRequest('token-mod', sessionId));
      const userWs = createMockWs();
      handleWebSocket(userWs, createSessionRequest('token-a', sessionId));

      userWs.emit('message', Buffer.from(clientMessage('issue:add', { titles: ['Story 1'] })));

      const lastMsg = parseMessage(userWs.sentMessages[userWs.sentMessages.length - 1]);
      expect(lastMsg.event).toBe('error');
      expect(lastMsg.data.code).toBe('UNAUTHORIZED');
    });

    it('should add issues and broadcast issue:list-updated on valid titles', () => {
      jest.spyOn(authService, 'validateToken').mockReturnValueOnce(moderatorUser);
      const modWs = createMockWs();
      handleWebSocket(modWs, createSessionRequest('token-mod', sessionId));

      modWs.emit('message', Buffer.from(clientMessage('issue:add', { titles: ['Story 1', 'Story 2'] })));

      const msgs = modWs.sentMessages.map(parseMessage);
      const listUpdated = msgs.find(m => m.event === 'issue:list-updated');
      expect(listUpdated).toBeDefined();
      expect(listUpdated!.data.issues).toHaveLength(2);
      expect(listUpdated!.data.issues[0].title).toBe('Story 1');
      expect(listUpdated!.data.issues[1].title).toBe('Story 2');
    });

    it('should return INVALID_DATA when titles array is empty', () => {
      jest.spyOn(authService, 'validateToken').mockReturnValueOnce(moderatorUser);
      const modWs = createMockWs();
      handleWebSocket(modWs, createSessionRequest('token-mod', sessionId));

      modWs.emit('message', Buffer.from(clientMessage('issue:add', { titles: [] })));

      const lastMsg = parseMessage(modWs.sentMessages[modWs.sentMessages.length - 1]);
      expect(lastMsg.event).toBe('error');
      expect(lastMsg.data.code).toBe('INVALID_DATA');
    });

    it('should return EMPTY_ISSUE when all titles are whitespace-only', () => {
      jest.spyOn(authService, 'validateToken').mockReturnValueOnce(moderatorUser);
      const modWs = createMockWs();
      handleWebSocket(modWs, createSessionRequest('token-mod', sessionId));

      modWs.emit('message', Buffer.from(clientMessage('issue:add', { titles: ['  ', ''] })));

      const lastMsg = parseMessage(modWs.sentMessages[modWs.sentMessages.length - 1]);
      expect(lastMsg.event).toBe('error');
      expect(lastMsg.data.code).toBe('EMPTY_ISSUE');
    });

    it('should broadcast issue:list-updated to all participants', () => {
      jest.spyOn(authService, 'validateToken')
        .mockReturnValueOnce(moderatorUser)
        .mockReturnValueOnce(participantA);

      const modWs = createMockWs();
      handleWebSocket(modWs, createSessionRequest('token-mod', sessionId));
      const userWs = createMockWs();
      handleWebSocket(userWs, createSessionRequest('token-a', sessionId));

      const userMsgCountBefore = userWs.sentMessages.length;
      modWs.emit('message', Buffer.from(clientMessage('issue:add', { titles: ['New Issue'] })));

      const userNewMsgs = userWs.sentMessages.slice(userMsgCountBefore).map(parseMessage);
      const listUpdated = userNewMsgs.find(m => m.event === 'issue:list-updated');
      expect(listUpdated).toBeDefined();
      expect(listUpdated!.data.issues).toHaveLength(1);
    });
  });

  // ---- issue:select ----

  describe('issue:select', () => {
    it('should reject issue:select from user without issue permission (UNAUTHORIZED)', () => {
      jest.spyOn(authService, 'validateToken')
        .mockReturnValueOnce(moderatorUser)
        .mockReturnValueOnce(participantA);

      const modWs = createMockWs();
      handleWebSocket(modWs, createSessionRequest('token-mod', sessionId));
      const userWs = createMockWs();
      handleWebSocket(userWs, createSessionRequest('token-a', sessionId));

      userWs.emit('message', Buffer.from(clientMessage('issue:select', { issueId: 'some-id' })));

      const lastMsg = parseMessage(userWs.sentMessages[userWs.sentMessages.length - 1]);
      expect(lastMsg.event).toBe('error');
      expect(lastMsg.data.code).toBe('UNAUTHORIZED');
    });

    it('should broadcast round:started and issue:list-updated when selecting an issue', () => {
      jest.spyOn(authService, 'validateToken').mockReturnValueOnce(moderatorUser);
      const modWs = createMockWs();
      handleWebSocket(modWs, createSessionRequest('token-mod', sessionId));

      // First add an issue
      modWs.emit('message', Buffer.from(clientMessage('issue:add', { titles: ['Issue to estimate'] })));

      // Get the issue ID from the list-updated broadcast
      const msgs = modWs.sentMessages.map(parseMessage);
      const listUpdated = msgs.find(m => m.event === 'issue:list-updated');
      const issueId = listUpdated!.data.issues[0].id;

      // Select the issue
      const msgCountBefore = modWs.sentMessages.length;
      modWs.emit('message', Buffer.from(clientMessage('issue:select', { issueId })));

      const newMsgs = modWs.sentMessages.slice(msgCountBefore).map(parseMessage);
      const roundStarted = newMsgs.find(m => m.event === 'round:started');
      expect(roundStarted).toBeDefined();
      expect(roundStarted!.data.round.storyDescription).toBe('Issue to estimate');

      const issueListUpdated = newMsgs.find(m => m.event === 'issue:list-updated');
      expect(issueListUpdated).toBeDefined();
      // The issue should now be in 'estimating' status
      const estimatingIssue = issueListUpdated!.data.issues.find((i: any) => i.id === issueId);
      expect(estimatingIssue.status).toBe('estimating');
    });

    it('should return error when selecting non-existent issue', () => {
      jest.spyOn(authService, 'validateToken').mockReturnValueOnce(moderatorUser);
      const modWs = createMockWs();
      handleWebSocket(modWs, createSessionRequest('token-mod', sessionId));

      modWs.emit('message', Buffer.from(clientMessage('issue:select', { issueId: 'non-existent' })));

      const lastMsg = parseMessage(modWs.sentMessages[modWs.sentMessages.length - 1]);
      expect(lastMsg.event).toBe('error');
      expect(lastMsg.data.code).toBe('ISSUE_NOT_FOUND');
    });
  });

  // ---- issue:remove ----

  describe('issue:remove', () => {
    it('should reject issue:remove from user without issue permission', () => {
      jest.spyOn(authService, 'validateToken')
        .mockReturnValueOnce(moderatorUser)
        .mockReturnValueOnce(participantA);

      const modWs = createMockWs();
      handleWebSocket(modWs, createSessionRequest('token-mod', sessionId));
      const userWs = createMockWs();
      handleWebSocket(userWs, createSessionRequest('token-a', sessionId));

      userWs.emit('message', Buffer.from(clientMessage('issue:remove', { issueId: 'some-id' })));

      const lastMsg = parseMessage(userWs.sentMessages[userWs.sentMessages.length - 1]);
      expect(lastMsg.event).toBe('error');
      expect(lastMsg.data.code).toBe('UNAUTHORIZED');
    });

    it('should remove issue and broadcast issue:list-updated', () => {
      jest.spyOn(authService, 'validateToken').mockReturnValueOnce(moderatorUser);
      const modWs = createMockWs();
      handleWebSocket(modWs, createSessionRequest('token-mod', sessionId));

      // Add an issue first
      modWs.emit('message', Buffer.from(clientMessage('issue:add', { titles: ['To Remove'] })));
      const msgs = modWs.sentMessages.map(parseMessage);
      const listUpdated = msgs.find(m => m.event === 'issue:list-updated');
      const issueId = listUpdated!.data.issues[0].id;

      // Remove it
      const msgCountBefore = modWs.sentMessages.length;
      modWs.emit('message', Buffer.from(clientMessage('issue:remove', { issueId })));

      const newMsgs = modWs.sentMessages.slice(msgCountBefore).map(parseMessage);
      const updated = newMsgs.find(m => m.event === 'issue:list-updated');
      expect(updated).toBeDefined();
      expect(updated!.data.issues).toHaveLength(0);
    });
  });

  // ---- issue:reorder ----

  describe('issue:reorder', () => {
    it('should reject issue:reorder from user without issue permission', () => {
      jest.spyOn(authService, 'validateToken')
        .mockReturnValueOnce(moderatorUser)
        .mockReturnValueOnce(participantA);

      const modWs = createMockWs();
      handleWebSocket(modWs, createSessionRequest('token-mod', sessionId));
      const userWs = createMockWs();
      handleWebSocket(userWs, createSessionRequest('token-a', sessionId));

      userWs.emit('message', Buffer.from(clientMessage('issue:reorder', { orderedIds: [] })));

      const lastMsg = parseMessage(userWs.sentMessages[userWs.sentMessages.length - 1]);
      expect(lastMsg.event).toBe('error');
      expect(lastMsg.data.code).toBe('UNAUTHORIZED');
    });

    it('should reorder issues and broadcast issue:list-updated', () => {
      jest.spyOn(authService, 'validateToken').mockReturnValueOnce(moderatorUser);
      const modWs = createMockWs();
      handleWebSocket(modWs, createSessionRequest('token-mod', sessionId));

      // Add two issues
      modWs.emit('message', Buffer.from(clientMessage('issue:add', { titles: ['First', 'Second'] })));
      const msgs = modWs.sentMessages.map(parseMessage);
      const listUpdated = msgs.find(m => m.event === 'issue:list-updated');
      const issues = listUpdated!.data.issues;
      const id1 = issues[0].id;
      const id2 = issues[1].id;

      // Reorder: reverse
      const msgCountBefore = modWs.sentMessages.length;
      modWs.emit('message', Buffer.from(clientMessage('issue:reorder', { orderedIds: [id2, id1] })));

      const newMsgs = modWs.sentMessages.slice(msgCountBefore).map(parseMessage);
      const updated = newMsgs.find(m => m.event === 'issue:list-updated');
      expect(updated).toBeDefined();
      expect(updated!.data.issues[0].id).toBe(id2);
      expect(updated!.data.issues[1].id).toBe(id1);
    });
  });
});
