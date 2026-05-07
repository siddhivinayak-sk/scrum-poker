import { IncomingMessage } from 'http';
import WebSocket from 'ws';
import { EventEmitter } from 'events';
import * as fc from 'fast-check';
import { handleRetroWebSocket, _resetRetroHandler } from '../retro-handler';
import * as authService from '../../services/auth-service';
import { retroSessionRegistry } from '../../services/retro-session-registry';
import { User, WebSocketMessage, RetroConfiguration } from '../../../../shared/types';

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

function createRetroRequest(token: string, sessionId: string): IncomingMessage {
  return createMockRequest(`/retro?token=${token}&sessionId=${sessionId}`);
}

const defaultRetroConfig: RetroConfiguration = {
  boardName: 'Test Retro',
  maxVotesPerUser: 6,
  templateId: 'went-well-improve-actions',
  hideCardsInitially: false,
  disableVotingInitially: false,
  hideVoteCount: false,
  oneVotePerCard: false,
  showCardAuthor: false,
  password: null,
  enableGifEmoji: true,
  columnLayout: 'vertical',
};

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

describe('Retro WebSocket Handler', () => {
  let sessionId: string;

  beforeEach(() => {
    _resetRetroHandler();
    retroSessionRegistry._reset();
    jest.restoreAllMocks();
    // Create a retro session owned by moderatorUser
    const info = retroSessionRegistry.createSession(moderatorUser.id, defaultRetroConfig);
    sessionId = info.sessionId;
  });

  // ---- Authentication ----

  describe('Authentication', () => {
    it('should close with 4001 when token is missing', () => {
      const ws = createMockWs();
      const request = createMockRequest(`/retro?sessionId=${sessionId}`);
      handleRetroWebSocket(ws, request);
      expect(ws.close).toHaveBeenCalledWith(4001, 'Authentication required');
    });

    it('should close with 4001 when token is invalid', () => {
      jest.spyOn(authService, 'validateToken').mockReturnValueOnce(null);
      const ws = createMockWs();
      handleRetroWebSocket(ws, createRetroRequest('invalid-token', sessionId));
      expect(ws.close).toHaveBeenCalledWith(4001, 'Invalid or expired token');
    });

    it('should close with 4004 when sessionId is missing', () => {
      jest.spyOn(authService, 'validateToken').mockReturnValueOnce(participantA);
      const ws = createMockWs();
      const request = createMockRequest(`/retro?token=valid-token`);
      handleRetroWebSocket(ws, request);
      expect(ws.close).toHaveBeenCalledWith(4004, 'Session ID required');
    });

    it('should close with 4004 when session does not exist', () => {
      jest.spyOn(authService, 'validateToken').mockReturnValueOnce(participantA);
      const ws = createMockWs();
      handleRetroWebSocket(ws, createRetroRequest('valid-token', 'non-existent'));
      expect(ws.close).toHaveBeenCalledWith(4004, 'Session not found');
    });
  });

  // ---- Connection Lifecycle ----

  describe('Connection lifecycle', () => {
    it('should send retro:session:state on valid connection', () => {
      jest.spyOn(authService, 'validateToken').mockReturnValueOnce(participantA);
      const ws = createMockWs();
      handleRetroWebSocket(ws, createRetroRequest('token-a', sessionId));

      expect(ws.close).not.toHaveBeenCalled();
      const msgs = ws.sentMessages.map(parseMessage);
      const stateMsg = msgs.find(m => m.event === 'retro:session:state');
      expect(stateMsg).toBeDefined();
      expect(stateMsg!.data.state.sessionId).toBe(sessionId);
      expect(stateMsg!.data.state.config.boardName).toBe('Test Retro');
    });

    it('should broadcast retro:participant:joined on valid connection', () => {
      jest.spyOn(authService, 'validateToken').mockReturnValueOnce(moderatorUser);
      const modWs = createMockWs();
      handleRetroWebSocket(modWs, createRetroRequest('token-mod', sessionId));

      jest.spyOn(authService, 'validateToken').mockReturnValueOnce(participantA);
      const userWs = createMockWs();
      handleRetroWebSocket(userWs, createRetroRequest('token-a', sessionId));

      // Moderator should receive participant:joined broadcast
      const modMsgs = modWs.sentMessages.map(parseMessage);
      const joinedMsg = modMsgs.find(m => m.event === 'retro:participant:joined');
      expect(joinedMsg).toBeDefined();
      expect(joinedMsg!.data.participants.length).toBeGreaterThanOrEqual(1);
    });

    it('should broadcast retro:participant:left on disconnect', () => {
      jest.spyOn(authService, 'validateToken')
        .mockReturnValueOnce(moderatorUser)
        .mockReturnValueOnce(participantA);

      const modWs = createMockWs();
      handleRetroWebSocket(modWs, createRetroRequest('token-mod', sessionId));
      const userWs = createMockWs();
      handleRetroWebSocket(userWs, createRetroRequest('token-a', sessionId));

      const modMsgCountBefore = modWs.sentMessages.length;

      // Simulate disconnect
      userWs.emit('close');

      const modNewMsgs = modWs.sentMessages.slice(modMsgCountBefore).map(parseMessage);
      const leftMsg = modNewMsgs.find(m => m.event === 'retro:participant:left');
      expect(leftMsg).toBeDefined();
      // Alice should not be in the participant list anymore
      const aliceInList = leftMsg!.data.participants.find((p: any) => p.id === participantA.id);
      expect(aliceInList).toBeUndefined();
    });
  });

  // ---- Event Routing ----

  describe('Event routing', () => {
    it('should handle retro:card:add and broadcast retro:card:added', () => {
      jest.spyOn(authService, 'validateToken').mockReturnValueOnce(moderatorUser);
      const ws = createMockWs();
      handleRetroWebSocket(ws, createRetroRequest('token-mod', sessionId));

      // Get the first column ID from the session state
      const stateMsg = ws.sentMessages.map(parseMessage).find(m => m.event === 'retro:session:state');
      const columnId = stateMsg!.data.state.board.columns[0].id;

      const msgCountBefore = ws.sentMessages.length;
      ws.emit('message', Buffer.from(clientMessage('retro:card:add', { columnId, text: 'Test card' })));

      const newMsgs = ws.sentMessages.slice(msgCountBefore).map(parseMessage);
      const addedMsg = newMsgs.find(m => m.event === 'retro:card:added');
      expect(addedMsg).toBeDefined();
      expect(addedMsg!.data.card.text).toBe('Test card');
      expect(addedMsg!.data.columnId).toBe(columnId);
    });

    it('should handle retro:card:vote and broadcast retro:card:voted', () => {
      jest.spyOn(authService, 'validateToken').mockReturnValueOnce(moderatorUser);
      const ws = createMockWs();
      handleRetroWebSocket(ws, createRetroRequest('token-mod', sessionId));

      // Get column ID and add a card first
      const stateMsg = ws.sentMessages.map(parseMessage).find(m => m.event === 'retro:session:state');
      const columnId = stateMsg!.data.state.board.columns[0].id;

      ws.emit('message', Buffer.from(clientMessage('retro:card:add', { columnId, text: 'Vote me' })));
      const addedMsg = ws.sentMessages.map(parseMessage).find(m => m.event === 'retro:card:added');
      const cardId = addedMsg!.data.card.id;

      const msgCountBefore = ws.sentMessages.length;
      ws.emit('message', Buffer.from(clientMessage('retro:card:vote', { cardId })));

      const newMsgs = ws.sentMessages.slice(msgCountBefore).map(parseMessage);
      const votedMsg = newMsgs.find(m => m.event === 'retro:card:voted');
      expect(votedMsg).toBeDefined();
      expect(votedMsg!.data.cardId).toBe(cardId);
      expect(votedMsg!.data.votes).toBe(1);
    });

    it('should handle retro:column:add and broadcast retro:column:added', () => {
      jest.spyOn(authService, 'validateToken').mockReturnValueOnce(moderatorUser);
      const ws = createMockWs();
      handleRetroWebSocket(ws, createRetroRequest('token-mod', sessionId));

      const msgCountBefore = ws.sentMessages.length;
      ws.emit('message', Buffer.from(clientMessage('retro:column:add', { name: 'New Column' })));

      const newMsgs = ws.sentMessages.slice(msgCountBefore).map(parseMessage);
      const addedMsg = newMsgs.find(m => m.event === 'retro:column:added');
      expect(addedMsg).toBeDefined();
      expect(addedMsg!.data.column.name).toBe('New Column');
    });

    it('should handle retro:card:edit and broadcast retro:card:edited', () => {
      jest.spyOn(authService, 'validateToken').mockReturnValueOnce(moderatorUser);
      const ws = createMockWs();
      handleRetroWebSocket(ws, createRetroRequest('token-mod', sessionId));

      const stateMsg = ws.sentMessages.map(parseMessage).find(m => m.event === 'retro:session:state');
      const columnId = stateMsg!.data.state.board.columns[0].id;

      ws.emit('message', Buffer.from(clientMessage('retro:card:add', { columnId, text: 'Original' })));
      const addedMsg = ws.sentMessages.map(parseMessage).find(m => m.event === 'retro:card:added');
      const cardId = addedMsg!.data.card.id;

      const msgCountBefore = ws.sentMessages.length;
      ws.emit('message', Buffer.from(clientMessage('retro:card:edit', { cardId, text: 'Edited' })));

      const newMsgs = ws.sentMessages.slice(msgCountBefore).map(parseMessage);
      const editedMsg = newMsgs.find(m => m.event === 'retro:card:edited');
      expect(editedMsg).toBeDefined();
      expect(editedMsg!.data.cardId).toBe(cardId);
      expect(editedMsg!.data.text).toBe('Edited');
    });

    it('should handle retro:comment:add and broadcast retro:comment:added', () => {
      jest.spyOn(authService, 'validateToken').mockReturnValueOnce(moderatorUser);
      const ws = createMockWs();
      handleRetroWebSocket(ws, createRetroRequest('token-mod', sessionId));

      const stateMsg = ws.sentMessages.map(parseMessage).find(m => m.event === 'retro:session:state');
      const columnId = stateMsg!.data.state.board.columns[0].id;

      ws.emit('message', Buffer.from(clientMessage('retro:card:add', { columnId, text: 'Card with comment' })));
      const addedMsg = ws.sentMessages.map(parseMessage).find(m => m.event === 'retro:card:added');
      const cardId = addedMsg!.data.card.id;

      const msgCountBefore = ws.sentMessages.length;
      ws.emit('message', Buffer.from(clientMessage('retro:comment:add', { cardId, text: 'A comment' })));

      const newMsgs = ws.sentMessages.slice(msgCountBefore).map(parseMessage);
      const commentMsg = newMsgs.find(m => m.event === 'retro:comment:added');
      expect(commentMsg).toBeDefined();
      expect(commentMsg!.data.cardId).toBe(cardId);
      expect(commentMsg!.data.comment.text).toBe('A comment');
    });

    it('should handle retro:column:remove and broadcast retro:column:removed', () => {
      jest.spyOn(authService, 'validateToken').mockReturnValueOnce(moderatorUser);
      const ws = createMockWs();
      handleRetroWebSocket(ws, createRetroRequest('token-mod', sessionId));

      const stateMsg = ws.sentMessages.map(parseMessage).find(m => m.event === 'retro:session:state');
      const columnId = stateMsg!.data.state.board.columns[0].id;

      const msgCountBefore = ws.sentMessages.length;
      ws.emit('message', Buffer.from(clientMessage('retro:column:remove', { columnId })));

      const newMsgs = ws.sentMessages.slice(msgCountBefore).map(parseMessage);
      const removedMsg = newMsgs.find(m => m.event === 'retro:column:removed');
      expect(removedMsg).toBeDefined();
      expect(removedMsg!.data.columnId).toBe(columnId);
    });

    it('should handle retro:context:update and broadcast retro:context:updated', () => {
      jest.spyOn(authService, 'validateToken').mockReturnValueOnce(moderatorUser);
      const ws = createMockWs();
      handleRetroWebSocket(ws, createRetroRequest('token-mod', sessionId));

      const msgCountBefore = ws.sentMessages.length;
      ws.emit('message', Buffer.from(clientMessage('retro:context:update', { text: 'Sprint 42' })));

      const newMsgs = ws.sentMessages.slice(msgCountBefore).map(parseMessage);
      const contextMsg = newMsgs.find(m => m.event === 'retro:context:updated');
      expect(contextMsg).toBeDefined();
      expect(contextMsg!.data.text).toBe('Sprint 42');
    });
  });

  // ---- Moderator-Only Enforcement ----

  describe('Moderator-only enforcement', () => {
    it('should reject retro:cards:reveal from non-moderator with UNAUTHORIZED', () => {
      jest.spyOn(authService, 'validateToken').mockReturnValueOnce(participantA);
      const ws = createMockWs();
      handleRetroWebSocket(ws, createRetroRequest('token-a', sessionId));

      const msgCountBefore = ws.sentMessages.length;
      ws.emit('message', Buffer.from(clientMessage('retro:cards:reveal', {})));

      const newMsgs = ws.sentMessages.slice(msgCountBefore).map(parseMessage);
      const errorMsg = newMsgs.find(m => m.event === 'retro:error');
      expect(errorMsg).toBeDefined();
      expect(errorMsg!.data.code).toBe('UNAUTHORIZED');
    });

    it('should allow moderator to reveal cards successfully', () => {
      jest.spyOn(authService, 'validateToken').mockReturnValueOnce(moderatorUser);
      const ws = createMockWs();
      handleRetroWebSocket(ws, createRetroRequest('token-mod', sessionId));

      const msgCountBefore = ws.sentMessages.length;
      ws.emit('message', Buffer.from(clientMessage('retro:cards:reveal', {})));

      const newMsgs = ws.sentMessages.slice(msgCountBefore).map(parseMessage);
      const revealedMsg = newMsgs.find(m => m.event === 'retro:cards:revealed');
      expect(revealedMsg).toBeDefined();
    });

    it('should reject retro:voting:enable from non-moderator with UNAUTHORIZED', () => {
      jest.spyOn(authService, 'validateToken').mockReturnValueOnce(participantA);
      const ws = createMockWs();
      handleRetroWebSocket(ws, createRetroRequest('token-a', sessionId));

      const msgCountBefore = ws.sentMessages.length;
      ws.emit('message', Buffer.from(clientMessage('retro:voting:enable', {})));

      const newMsgs = ws.sentMessages.slice(msgCountBefore).map(parseMessage);
      const errorMsg = newMsgs.find(m => m.event === 'retro:error');
      expect(errorMsg).toBeDefined();
      expect(errorMsg!.data.code).toBe('UNAUTHORIZED');
    });

    it('should reject retro:board:complete from non-moderator with UNAUTHORIZED', () => {
      jest.spyOn(authService, 'validateToken').mockReturnValueOnce(participantA);
      const ws = createMockWs();
      handleRetroWebSocket(ws, createRetroRequest('token-a', sessionId));

      const msgCountBefore = ws.sentMessages.length;
      ws.emit('message', Buffer.from(clientMessage('retro:board:complete', {})));

      const newMsgs = ws.sentMessages.slice(msgCountBefore).map(parseMessage);
      const errorMsg = newMsgs.find(m => m.event === 'retro:error');
      expect(errorMsg).toBeDefined();
      expect(errorMsg!.data.code).toBe('UNAUTHORIZED');
    });

    it('should reject retro:config:update from non-moderator with UNAUTHORIZED', () => {
      jest.spyOn(authService, 'validateToken').mockReturnValueOnce(participantA);
      const ws = createMockWs();
      handleRetroWebSocket(ws, createRetroRequest('token-a', sessionId));

      const msgCountBefore = ws.sentMessages.length;
      ws.emit('message', Buffer.from(clientMessage('retro:config:update', { config: { hideVoteCount: true } })));

      const newMsgs = ws.sentMessages.slice(msgCountBefore).map(parseMessage);
      const errorMsg = newMsgs.find(m => m.event === 'retro:error');
      expect(errorMsg).toBeDefined();
      expect(errorMsg!.data.code).toBe('UNAUTHORIZED');
    });
  });

  // ---- Error Handling ----

  describe('Error handling', () => {
    it('should send error for invalid JSON message', () => {
      jest.spyOn(authService, 'validateToken').mockReturnValueOnce(participantA);
      const ws = createMockWs();
      handleRetroWebSocket(ws, createRetroRequest('token-a', sessionId));

      const msgCountBefore = ws.sentMessages.length;
      ws.emit('message', Buffer.from('not valid json{{{'));

      const newMsgs = ws.sentMessages.slice(msgCountBefore).map(parseMessage);
      const errorMsg = newMsgs.find(m => m.event === 'retro:error');
      expect(errorMsg).toBeDefined();
      expect(errorMsg!.data.code).toBe('INVALID_MESSAGE');
    });

    it('should send NOT_FOUND error for card not found', () => {
      jest.spyOn(authService, 'validateToken').mockReturnValueOnce(moderatorUser);
      const ws = createMockWs();
      handleRetroWebSocket(ws, createRetroRequest('token-mod', sessionId));

      const msgCountBefore = ws.sentMessages.length;
      ws.emit('message', Buffer.from(clientMessage('retro:card:vote', { cardId: 'non-existent-card' })));

      const newMsgs = ws.sentMessages.slice(msgCountBefore).map(parseMessage);
      const errorMsg = newMsgs.find(m => m.event === 'retro:error');
      expect(errorMsg).toBeDefined();
      expect(errorMsg!.data.code).toBe('NOT_FOUND');
    });

    it('should send BOARD_COMPLETED error when board is completed', () => {
      jest.spyOn(authService, 'validateToken').mockReturnValueOnce(moderatorUser);
      const ws = createMockWs();
      handleRetroWebSocket(ws, createRetroRequest('token-mod', sessionId));

      // Complete the board
      ws.emit('message', Buffer.from(clientMessage('retro:board:complete', {})));

      // Get column ID
      const stateMsg = ws.sentMessages.map(parseMessage).find(m => m.event === 'retro:session:state');
      const columnId = stateMsg!.data.state.board.columns[0].id;

      const msgCountBefore = ws.sentMessages.length;
      ws.emit('message', Buffer.from(clientMessage('retro:card:add', { columnId, text: 'Should fail' })));

      const newMsgs = ws.sentMessages.slice(msgCountBefore).map(parseMessage);
      const errorMsg = newMsgs.find(m => m.event === 'retro:error');
      expect(errorMsg).toBeDefined();
      expect(errorMsg!.data.code).toBe('BOARD_COMPLETED');
    });

    it('should accept empty card text and create a card', () => {
      jest.spyOn(authService, 'validateToken').mockReturnValueOnce(moderatorUser);
      const ws = createMockWs();
      handleRetroWebSocket(ws, createRetroRequest('token-mod', sessionId));

      const stateMsg = ws.sentMessages.map(parseMessage).find(m => m.event === 'retro:session:state');
      const columnId = stateMsg!.data.state.board.columns[0].id;

      const msgCountBefore = ws.sentMessages.length;
      ws.emit('message', Buffer.from(clientMessage('retro:card:add', { columnId, text: '' })));

      const newMsgs = ws.sentMessages.slice(msgCountBefore).map(parseMessage);
      const addedMsg = newMsgs.find(m => m.event === 'retro:card:added');
      expect(addedMsg).toBeDefined();
      expect(addedMsg!.data.card.text).toBe('');
    });

    it('should send error for unknown event type', () => {
      jest.spyOn(authService, 'validateToken').mockReturnValueOnce(participantA);
      const ws = createMockWs();
      handleRetroWebSocket(ws, createRetroRequest('token-a', sessionId));

      const msgCountBefore = ws.sentMessages.length;
      ws.emit('message', Buffer.from(clientMessage('retro:unknown:event', {})));

      const newMsgs = ws.sentMessages.slice(msgCountBefore).map(parseMessage);
      const errorMsg = newMsgs.find(m => m.event === 'retro:error');
      expect(errorMsg).toBeDefined();
      expect(errorMsg!.data.code).toBe('UNKNOWN_EVENT');
    });
  });

  // ---- Broadcast to All Participants ----

  describe('Broadcast to all participants', () => {
    it('should broadcast card:added to all connected participants', () => {
      jest.spyOn(authService, 'validateToken')
        .mockReturnValueOnce(moderatorUser)
        .mockReturnValueOnce(participantA);

      const modWs = createMockWs();
      handleRetroWebSocket(modWs, createRetroRequest('token-mod', sessionId));
      const userWs = createMockWs();
      handleRetroWebSocket(userWs, createRetroRequest('token-a', sessionId));

      const stateMsg = modWs.sentMessages.map(parseMessage).find(m => m.event === 'retro:session:state');
      const columnId = stateMsg!.data.state.board.columns[0].id;

      const userMsgCountBefore = userWs.sentMessages.length;
      modWs.emit('message', Buffer.from(clientMessage('retro:card:add', { columnId, text: 'Broadcast test' })));

      const userNewMsgs = userWs.sentMessages.slice(userMsgCountBefore).map(parseMessage);
      const addedMsg = userNewMsgs.find(m => m.event === 'retro:card:added');
      expect(addedMsg).toBeDefined();
      expect(addedMsg!.data.card.text).toBe('Broadcast test');
    });

    it('should broadcast column:added to all connected participants', () => {
      jest.spyOn(authService, 'validateToken')
        .mockReturnValueOnce(moderatorUser)
        .mockReturnValueOnce(participantA);

      const modWs = createMockWs();
      handleRetroWebSocket(modWs, createRetroRequest('token-mod', sessionId));
      const userWs = createMockWs();
      handleRetroWebSocket(userWs, createRetroRequest('token-a', sessionId));

      const userMsgCountBefore = userWs.sentMessages.length;
      modWs.emit('message', Buffer.from(clientMessage('retro:column:add', { name: 'Broadcast Column' })));

      const userNewMsgs = userWs.sentMessages.slice(userMsgCountBefore).map(parseMessage);
      const addedMsg = userNewMsgs.find(m => m.event === 'retro:column:added');
      expect(addedMsg).toBeDefined();
      expect(addedMsg!.data.column.name).toBe('Broadcast Column');
    });
  });


  // ---- Property 20: Reconnect restores full board state ----

  describe('Property 20: Reconnect restores full board state', () => {
    /**
     * **Validates: Requirements 12.6**
     *
     * For any board state at time T, when a participant disconnects and reconnects,
     * the state received should be equivalent to the current board state.
     */
    it('should restore full board state on reconnect after modifications', () => {
      // Generate non-whitespace strings (at least one non-space character)
      const nonEmptyTextArb = fc.string({ minLength: 1, maxLength: 50 }).filter(s => s.trim().length > 0);

      fc.assert(
        fc.property(
          fc.array(nonEmptyTextArb, { minLength: 1, maxLength: 5 }),
          fc.array(nonEmptyTextArb, { minLength: 0, maxLength: 3 }),
          (cardTexts, columnNames) => {
            // Reset state for each iteration
            _resetRetroHandler();
            retroSessionRegistry._reset();
            const info = retroSessionRegistry.createSession(moderatorUser.id, defaultRetroConfig);
            const sid = info.sessionId;

            // Connect moderator
            jest.spyOn(authService, 'validateToken').mockReturnValueOnce(moderatorUser);
            const modWs = createMockWs();
            handleRetroWebSocket(modWs, createRetroRequest('token-mod', sid));

            // Get initial column ID
            const stateMsg = modWs.sentMessages.map(parseMessage).find(m => m.event === 'retro:session:state');
            const columnId = stateMsg!.data.state.board.columns[0].id;

            // Add cards
            for (const text of cardTexts) {
              modWs.emit('message', Buffer.from(clientMessage('retro:card:add', { columnId, text })));
            }

            // Add columns
            for (const name of columnNames) {
              modWs.emit('message', Buffer.from(clientMessage('retro:column:add', { name })));
            }

            // Now simulate a new participant connecting (reconnect scenario)
            jest.spyOn(authService, 'validateToken').mockReturnValueOnce(participantA);
            const reconnectWs = createMockWs();
            handleRetroWebSocket(reconnectWs, createRetroRequest('token-a', sid));

            // The reconnecting client should receive full state
            const reconnectMsgs = reconnectWs.sentMessages.map(parseMessage);
            const reconnectState = reconnectMsgs.find(m => m.event === 'retro:session:state');
            expect(reconnectState).toBeDefined();

            const state = reconnectState!.data.state;

            // Verify all cards are present in the first column
            const firstColumn = state.board.columns.find((c: any) => c.id === columnId);
            expect(firstColumn).toBeDefined();
            expect(firstColumn.cards.length).toBe(cardTexts.length);

            // Verify card texts match (handler trims text before storing)
            const receivedTexts = firstColumn.cards.map((c: any) => c.text);
            for (const text of cardTexts) {
              expect(receivedTexts).toContain(text);
            }

            // Verify added columns are present
            for (const name of columnNames) {
              const col = state.board.columns.find((c: any) => c.name === name.trim());
              expect(col).toBeDefined();
            }

            // Verify session config is preserved
            expect(state.config.boardName).toBe('Test Retro');
            expect(state.sessionId).toBe(sid);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('should restore votes and comments on reconnect', () => {
      jest.spyOn(authService, 'validateToken').mockReturnValueOnce(moderatorUser);
      const modWs = createMockWs();
      handleRetroWebSocket(modWs, createRetroRequest('token-mod', sessionId));

      // Get column ID and add a card
      const stateMsg = modWs.sentMessages.map(parseMessage).find(m => m.event === 'retro:session:state');
      const columnId = stateMsg!.data.state.board.columns[0].id;

      modWs.emit('message', Buffer.from(clientMessage('retro:card:add', { columnId, text: 'Voted card' })));
      const addedMsg = modWs.sentMessages.map(parseMessage).find(m => m.event === 'retro:card:added');
      const cardId = addedMsg!.data.card.id;

      // Vote on the card
      modWs.emit('message', Buffer.from(clientMessage('retro:card:vote', { cardId })));

      // Add a comment
      modWs.emit('message', Buffer.from(clientMessage('retro:comment:add', { cardId, text: 'Great point!' })));

      // New participant connects — should see full state with votes and comments
      jest.spyOn(authService, 'validateToken').mockReturnValueOnce(participantA);
      const reconnectWs = createMockWs();
      handleRetroWebSocket(reconnectWs, createRetroRequest('token-a', sessionId));

      const reconnectMsgs = reconnectWs.sentMessages.map(parseMessage);
      const reconnectState = reconnectMsgs.find(m => m.event === 'retro:session:state');
      expect(reconnectState).toBeDefined();

      const firstColumn = reconnectState!.data.state.board.columns.find((c: any) => c.id === columnId);
      const card = firstColumn.cards.find((c: any) => c.id === cardId);
      expect(card).toBeDefined();
      expect(card.votes).toBe(1);
      expect(card.comments.length).toBe(1);
      expect(card.comments[0].text).toBe('Great point!');
    });
  });
});
