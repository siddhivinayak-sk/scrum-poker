import { IncomingMessage } from 'http';
import WebSocket from 'ws';
import { EventEmitter } from 'events';
import {
  handleWebSocket,
  _reset as resetHandler,
} from '../../websocket/handler';
import * as authService from '../../services/auth-service';
import { sessionRegistry } from '../../services/session-registry';
import {
  User,
  WebSocketMessage,
  DEFAULT_SESSION_CONFIG,
  SessionConfiguration,
} from '../../../../shared/types';

// --- Helpers ---

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

// --- Integration Test Suite ---

describe('Integration Flows', () => {
  let sessionId: string;

  beforeEach(() => {
    resetHandler();
    sessionRegistry._reset();
    jest.restoreAllMocks();
    const info = sessionRegistry.createSession(moderatorUser.id, DEFAULT_SESSION_CONFIG);
    sessionId = info.sessionId;
  });

  // ---- Flow 1: Moderator Removal ----

  describe('Moderator removal flow', () => {
    it('should remove participant, discard vote, close ws, and broadcast to remaining', () => {
      // Connect moderator and 2 participants
      jest.spyOn(authService, 'validateToken')
        .mockReturnValueOnce(moderatorUser)
        .mockReturnValueOnce(participantA)
        .mockReturnValueOnce(participantB);

      const modWs = createMockWs();
      handleWebSocket(modWs, createSessionRequest('token-mod', sessionId));
      const wsA = createMockWs();
      handleWebSocket(wsA, createSessionRequest('token-a', sessionId));
      const wsB = createMockWs();
      handleWebSocket(wsB, createSessionRequest('token-b', sessionId));

      // Moderator starts a round
      modWs.emit('message', Buffer.from(clientMessage('story:submit', { storyDescription: 'Story 1' })));

      // Participant A votes
      wsA.emit('message', Buffer.from(clientMessage('card:select', { cardValue: 5 })));

      // Verify A's vote is recorded
      const session = sessionRegistry.getSession(sessionId)!;
      expect(session.getSelections().has(participantA.id)).toBe(true);

      // Record message counts before removal
      const wsAMsgCountBefore = wsA.sentMessages.length;
      const wsBMsgCountBefore = wsB.sentMessages.length;

      // Moderator removes Participant A
      modWs.emit('message', Buffer.from(clientMessage('participant:remove', { userId: participantA.id })));

      // Verify: A receives participant:removed
      const aMsgsAfter = wsA.sentMessages.slice(wsAMsgCountBefore).map(parseMessage);
      const removedMsg = aMsgsAfter.find(m => m.event === 'participant:removed');
      expect(removedMsg).toBeDefined();
      expect(removedMsg!.data.reason).toBe('Removed by moderator');

      // Verify: A's ws is closed with 4010
      expect(wsA.close).toHaveBeenCalledWith(4010, 'Removed from session by moderator');

      // Verify: remaining participants receive participant:left
      const bMsgsAfter = wsB.sentMessages.slice(wsBMsgCountBefore).map(parseMessage);
      const leftMsg = bMsgsAfter.find(m => m.event === 'participant:left');
      expect(leftMsg).toBeDefined();
      // A should not be in the updated participant list
      expect(leftMsg!.data.participants.find((p: any) => p.id === participantA.id)).toBeUndefined();

      // Verify: A's vote is discarded
      expect(session.getSelections().has(participantA.id)).toBe(false);
    });
  });

  // ---- Flow 2: Duplicate Name Rejection ----

  describe('Duplicate name rejection flow', () => {
    it('should reject case-insensitive duplicate name and allow different name', () => {
      // User A connects with name "Alice"
      jest.spyOn(authService, 'validateToken').mockReturnValueOnce(participantA);
      const wsA = createMockWs();
      handleWebSocket(wsA, createSessionRequest('token-a', sessionId));
      expect(wsA.close).not.toHaveBeenCalled();

      // User B tries to connect with name "alice" (case-insensitive duplicate)
      const duplicateUser: User = { id: 'user-dup', displayName: 'alice', role: 'participant', isAnonymous: false };
      jest.spyOn(authService, 'validateToken').mockReturnValueOnce(duplicateUser);
      const wsB = createMockWs();
      handleWebSocket(wsB, createSessionRequest('token-b', sessionId));

      // Verify: B's ws is closed with 4009
      expect(wsB.close).toHaveBeenCalledWith(4009, 'Display name already in use in this session');

      // User C connects with name "Bob" (different name)
      jest.spyOn(authService, 'validateToken').mockReturnValueOnce(participantB);
      const wsC = createMockWs();
      handleWebSocket(wsC, createSessionRequest('token-c', sessionId));

      // Verify: C connects successfully
      expect(wsC.close).not.toHaveBeenCalled();
      const cMsgs = wsC.sentMessages.map(parseMessage);
      const stateMsg = cMsgs.find(m => m.event === 'session:state');
      expect(stateMsg).toBeDefined();
    });
  });

  // ---- Flow 3: Re-Vote ----

  describe('Re-vote flow', () => {
    it('should discard current round, start fresh with same story, and not add history', () => {
      // Moderator connects
      jest.spyOn(authService, 'validateToken').mockReturnValueOnce(moderatorUser);
      const modWs = createMockWs();
      handleWebSocket(modWs, createSessionRequest('token-mod', sessionId));

      const session = sessionRegistry.getSession(sessionId)!;

      // Start round, vote, reveal
      modWs.emit('message', Buffer.from(clientMessage('story:submit', { storyDescription: 'Revote Story' })));
      modWs.emit('message', Buffer.from(clientMessage('card:select', { cardValue: 8 })));
      modWs.emit('message', Buffer.from(clientMessage('cards:reveal')));

      // Verify round is revealed
      expect(session.getCurrentRound()?.status).toBe('revealed');
      const historyBefore = session.getHistory().length;

      // Trigger revote
      const msgCountBefore = modWs.sentMessages.length;
      modWs.emit('message', Buffer.from(clientMessage('round:revote')));

      // Verify: new round:started broadcast with same story
      const newMsgs = modWs.sentMessages.slice(msgCountBefore).map(parseMessage);
      const roundStarted = newMsgs.find(m => m.event === 'round:started');
      expect(roundStarted).toBeDefined();
      expect(roundStarted!.data.round.storyDescription).toBe('Revote Story');
      expect(roundStarted!.data.round.status).toBe('voting');

      // Verify: no history entry added
      expect(session.getHistory().length).toBe(historyBefore);

      // Vote again and reveal again
      modWs.emit('message', Buffer.from(clientMessage('card:select', { cardValue: 13 })));
      modWs.emit('message', Buffer.from(clientMessage('cards:reveal')));

      // Verify: round is revealed with new votes
      expect(session.getCurrentRound()?.status).toBe('revealed');
      const selections = session.getSelections();
      expect(selections.get(moderatorUser.id)).toBe(13);
    });
  });

  // ---- Flow 4: Issue List Management ----

  describe('Issue list management flow', () => {
    it('should add issues, select for estimation, vote, reveal, clear, and mark estimated', () => {
      // Moderator connects
      jest.spyOn(authService, 'validateToken')
        .mockReturnValueOnce(moderatorUser)
        .mockReturnValueOnce(participantA);

      const modWs = createMockWs();
      handleWebSocket(modWs, createSessionRequest('token-mod', sessionId));
      const wsA = createMockWs();
      handleWebSocket(wsA, createSessionRequest('token-a', sessionId));

      // Moderator adds issues
      const aMsgCountBefore = wsA.sentMessages.length;
      modWs.emit('message', Buffer.from(clientMessage('issue:add', { titles: ['Issue 1', 'Issue 2', 'Issue 3'] })));

      // Verify: issue:list-updated broadcast to participant
      const aMsgsAfterAdd = wsA.sentMessages.slice(aMsgCountBefore).map(parseMessage);
      const listUpdatedAdd = aMsgsAfterAdd.find(m => m.event === 'issue:list-updated');
      expect(listUpdatedAdd).toBeDefined();
      expect(listUpdatedAdd!.data.issues).toHaveLength(3);

      // Get issue ID for selection
      const issueId = listUpdatedAdd!.data.issues[0].id;

      // Moderator selects issue for estimation
      const aMsgCountBeforeSelect = wsA.sentMessages.length;
      modWs.emit('message', Buffer.from(clientMessage('issue:select', { issueId })));

      // Verify: round:started and issue:list-updated broadcast
      const aMsgsAfterSelect = wsA.sentMessages.slice(aMsgCountBeforeSelect).map(parseMessage);
      const roundStarted = aMsgsAfterSelect.find(m => m.event === 'round:started');
      expect(roundStarted).toBeDefined();
      expect(roundStarted!.data.round.storyDescription).toBe('Issue 1');

      const listUpdatedSelect = aMsgsAfterSelect.find(m => m.event === 'issue:list-updated');
      expect(listUpdatedSelect).toBeDefined();
      const estimatingIssue = listUpdatedSelect!.data.issues.find((i: any) => i.id === issueId);
      expect(estimatingIssue.status).toBe('estimating');

      // Moderator and participant vote
      modWs.emit('message', Buffer.from(clientMessage('card:select', { cardValue: 5 })));
      wsA.emit('message', Buffer.from(clientMessage('card:select', { cardValue: 8 })));

      // Moderator reveals
      modWs.emit('message', Buffer.from(clientMessage('cards:reveal')));

      // Moderator clears board
      const aMsgCountBeforeClear = wsA.sentMessages.length;
      modWs.emit('message', Buffer.from(clientMessage('board:clear')));

      // Verify: issue marked as 'estimated' in issue:list-updated
      const aMsgsAfterClear = wsA.sentMessages.slice(aMsgCountBeforeClear).map(parseMessage);
      const listUpdatedClear = aMsgsAfterClear.find(m => m.event === 'issue:list-updated');
      expect(listUpdatedClear).toBeDefined();
      const estimatedIssue = listUpdatedClear!.data.issues.find((i: any) => i.id === issueId);
      expect(estimatedIssue.status).toBe('estimated');
      expect(estimatedIssue.historyEntryId).toBeDefined();
    });
  });

  // ---- Flow 5: Session Resume ----

  describe('Session resume flow', () => {
    it('should return correct completedRounds in session summary after multiple rounds', () => {
      const session = sessionRegistry.getSession(sessionId)!;

      // Add participants and complete rounds
      session.addParticipant(moderatorUser);
      session.addParticipant(participantA);

      // Complete 3 rounds
      session.startRound('Story 1');
      session.selectCard(moderatorUser.id, 3);
      session.selectCard(participantA.id, 5);
      session.revealCards();
      session.clearBoard();

      session.startRound('Story 2');
      session.selectCard(moderatorUser.id, 8);
      session.selectCard(participantA.id, 8);
      session.revealCards();
      session.clearBoard();

      session.startRound('Story 3');
      session.selectCard(moderatorUser.id, 13);
      session.selectCard(participantA.id, 21);
      session.revealCards();
      session.clearBoard();

      // Verify via getSessionsByOwner (same logic as /api/sessions/mine)
      const ownerSessions = sessionRegistry.getSessionsByOwner(moderatorUser.id);
      expect(ownerSessions).toHaveLength(1);
      expect(ownerSessions[0].getHistory().length).toBe(3);

      // Verify session state includes correct history count
      const state = session.getSessionState();
      expect(state.history).toHaveLength(3);
      expect(state.history[0].storyDescription).toBe('Story 3'); // newest first
      expect(state.history[1].storyDescription).toBe('Story 2');
      expect(state.history[2].storyDescription).toBe('Story 1');
    });
  });
});
