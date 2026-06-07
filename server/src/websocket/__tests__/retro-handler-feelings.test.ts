import { IncomingMessage } from 'http';
import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { handleRetroWebSocket, _resetRetroHandler } from '../retro-handler';
import * as authService from '../../services/auth-service';
import { retroSessionRegistry } from '../../services/retro-session-registry';
import {
  User,
  WebSocketMessage,
  RetroConfiguration,
  RETRO_FEELING_SELECT,
  RETRO_FEELING_UPDATED,
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
  allowedFeelings: ['Happy', 'Sad', 'No_Feeling'],
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

describe('Retro Handler - Feelings Events', () => {
  let sessionId: string;

  beforeEach(() => {
    _resetRetroHandler();
    retroSessionRegistry._reset();
    jest.restoreAllMocks();
    const info = retroSessionRegistry.createSession(moderatorUser.id, defaultRetroConfig);
    sessionId = info.sessionId;
  });

  // ---- retro:feeling:select routes correctly and broadcasts ----

  describe('retro:feeling:select routes correctly and broadcasts', () => {
    it('should broadcast retro:feeling:updated when participant selects a valid feeling', () => {
      jest.spyOn(authService, 'validateToken')
        .mockReturnValueOnce(moderatorUser)
        .mockReturnValueOnce(participantA);

      const modWs = createMockWs();
      handleRetroWebSocket(modWs, createRetroRequest('token-mod', sessionId));
      const userWs = createMockWs();
      handleRetroWebSocket(userWs, createRetroRequest('token-a', sessionId));

      const modMsgCountBefore = modWs.sentMessages.length;
      const userMsgCountBefore = userWs.sentMessages.length;

      userWs.emit('message', Buffer.from(clientMessage(RETRO_FEELING_SELECT, { category: 'Happy' })));

      // Both clients should receive retro:feeling:updated
      const modNewMsgs = modWs.sentMessages.slice(modMsgCountBefore).map(parseMessage);
      const modFeelingMsg = modNewMsgs.find(m => m.event === RETRO_FEELING_UPDATED);
      expect(modFeelingMsg).toBeDefined();
      expect(modFeelingMsg!.data.userId).toBe(participantA.id);
      expect(modFeelingMsg!.data.category).toBe('Happy');

      const userNewMsgs = userWs.sentMessages.slice(userMsgCountBefore).map(parseMessage);
      const userFeelingMsg = userNewMsgs.find(m => m.event === RETRO_FEELING_UPDATED);
      expect(userFeelingMsg).toBeDefined();
      expect(userFeelingMsg!.data.userId).toBe(participantA.id);
      expect(userFeelingMsg!.data.category).toBe('Happy');
    });

    it('should store the feeling in session state after selection', () => {
      jest.spyOn(authService, 'validateToken').mockReturnValueOnce(participantA);
      const ws = createMockWs();
      handleRetroWebSocket(ws, createRetroRequest('token-a', sessionId));

      ws.emit('message', Buffer.from(clientMessage(RETRO_FEELING_SELECT, { category: 'Sad' })));

      const session = retroSessionRegistry.getSession(sessionId)!;
      expect(session.getFeeling(participantA.id)).toBe('Sad');
    });

    it('should broadcast retro:feeling:updated with null when participant deselects', () => {
      jest.spyOn(authService, 'validateToken').mockReturnValueOnce(participantA);
      const ws = createMockWs();
      handleRetroWebSocket(ws, createRetroRequest('token-a', sessionId));

      // First select a feeling
      ws.emit('message', Buffer.from(clientMessage(RETRO_FEELING_SELECT, { category: 'Happy' })));

      const msgCountBefore = ws.sentMessages.length;

      // Then deselect
      ws.emit('message', Buffer.from(clientMessage(RETRO_FEELING_SELECT, { category: null })));

      const newMsgs = ws.sentMessages.slice(msgCountBefore).map(parseMessage);
      const feelingMsg = newMsgs.find(m => m.event === RETRO_FEELING_UPDATED);
      expect(feelingMsg).toBeDefined();
      expect(feelingMsg!.data.userId).toBe(participantA.id);
      expect(feelingMsg!.data.category).toBeNull();
    });

    it('should allow moderator to select a feeling just like a participant', () => {
      jest.spyOn(authService, 'validateToken').mockReturnValueOnce(moderatorUser);
      const ws = createMockWs();
      handleRetroWebSocket(ws, createRetroRequest('token-mod', sessionId));

      const msgCountBefore = ws.sentMessages.length;
      ws.emit('message', Buffer.from(clientMessage(RETRO_FEELING_SELECT, { category: 'No_Feeling' })));

      const newMsgs = ws.sentMessages.slice(msgCountBefore).map(parseMessage);
      const feelingMsg = newMsgs.find(m => m.event === RETRO_FEELING_UPDATED);
      expect(feelingMsg).toBeDefined();
      expect(feelingMsg!.data.userId).toBe(moderatorUser.id);
      expect(feelingMsg!.data.category).toBe('No_Feeling');
    });
  });

  // ---- Rejection of feeling selection on completed board ----

  describe('Rejection of feeling selection on completed board', () => {
    it('should return BOARD_COMPLETED error when selecting feeling on a completed board', () => {
      jest.spyOn(authService, 'validateToken').mockReturnValueOnce(moderatorUser);
      const modWs = createMockWs();
      handleRetroWebSocket(modWs, createRetroRequest('token-mod', sessionId));

      // Complete the board
      modWs.emit('message', Buffer.from(clientMessage('retro:board:complete', {})));

      const msgCountBefore = modWs.sentMessages.length;
      modWs.emit('message', Buffer.from(clientMessage(RETRO_FEELING_SELECT, { category: 'Happy' })));

      const newMsgs = modWs.sentMessages.slice(msgCountBefore).map(parseMessage);
      const errorMsg = newMsgs.find(m => m.event === 'retro:error');
      expect(errorMsg).toBeDefined();
      expect(errorMsg!.data.code).toBe('BOARD_COMPLETED');
    });

    it('should not broadcast retro:feeling:updated when board is completed', () => {
      jest.spyOn(authService, 'validateToken')
        .mockReturnValueOnce(moderatorUser)
        .mockReturnValueOnce(participantA);

      const modWs = createMockWs();
      handleRetroWebSocket(modWs, createRetroRequest('token-mod', sessionId));
      const userWs = createMockWs();
      handleRetroWebSocket(userWs, createRetroRequest('token-a', sessionId));

      // Complete the board
      modWs.emit('message', Buffer.from(clientMessage('retro:board:complete', {})));

      const userMsgCountBefore = userWs.sentMessages.length;
      userWs.emit('message', Buffer.from(clientMessage(RETRO_FEELING_SELECT, { category: 'Happy' })));

      const userNewMsgs = userWs.sentMessages.slice(userMsgCountBefore).map(parseMessage);
      const feelingMsg = userNewMsgs.find(m => m.event === RETRO_FEELING_UPDATED);
      expect(feelingMsg).toBeUndefined();
    });
  });

  // ---- Rejection of invalid/disallowed feeling category ----

  describe('Rejection of invalid/disallowed feeling category', () => {
    it('should return INVALID_FEELING error when category is not in allowedFeelings', () => {
      jest.spyOn(authService, 'validateToken').mockReturnValueOnce(participantA);
      const ws = createMockWs();
      handleRetroWebSocket(ws, createRetroRequest('token-a', sessionId));

      const msgCountBefore = ws.sentMessages.length;
      // 'Confidence' is not in the default allowedFeelings ['Happy', 'Sad', 'No_Feeling']
      ws.emit('message', Buffer.from(clientMessage(RETRO_FEELING_SELECT, { category: 'Confidence' })));

      const newMsgs = ws.sentMessages.slice(msgCountBefore).map(parseMessage);
      const errorMsg = newMsgs.find(m => m.event === 'retro:error');
      expect(errorMsg).toBeDefined();
      expect(errorMsg!.data.code).toBe('INVALID_FEELING');
    });

    it('should return INVALID_FEELING error for a completely invalid category string', () => {
      jest.spyOn(authService, 'validateToken').mockReturnValueOnce(participantA);
      const ws = createMockWs();
      handleRetroWebSocket(ws, createRetroRequest('token-a', sessionId));

      const msgCountBefore = ws.sentMessages.length;
      ws.emit('message', Buffer.from(clientMessage(RETRO_FEELING_SELECT, { category: 'NotACategory' })));

      const newMsgs = ws.sentMessages.slice(msgCountBefore).map(parseMessage);
      const errorMsg = newMsgs.find(m => m.event === 'retro:error');
      expect(errorMsg).toBeDefined();
      expect(errorMsg!.data.code).toBe('INVALID_FEELING');
    });

    it('should not change participant feeling when disallowed category is submitted', () => {
      jest.spyOn(authService, 'validateToken').mockReturnValueOnce(participantA);
      const ws = createMockWs();
      handleRetroWebSocket(ws, createRetroRequest('token-a', sessionId));

      // Select a valid feeling first
      ws.emit('message', Buffer.from(clientMessage(RETRO_FEELING_SELECT, { category: 'Happy' })));

      // Now try to select disallowed category
      ws.emit('message', Buffer.from(clientMessage(RETRO_FEELING_SELECT, { category: 'Confidence' })));

      const session = retroSessionRegistry.getSession(sessionId)!;
      // Feeling should remain 'Happy', not changed to 'Confidence'
      expect(session.getFeeling(participantA.id)).toBe('Happy');
    });

    it('should not broadcast when disallowed feeling is submitted', () => {
      jest.spyOn(authService, 'validateToken')
        .mockReturnValueOnce(moderatorUser)
        .mockReturnValueOnce(participantA);

      const modWs = createMockWs();
      handleRetroWebSocket(modWs, createRetroRequest('token-mod', sessionId));
      const userWs = createMockWs();
      handleRetroWebSocket(userWs, createRetroRequest('token-a', sessionId));

      const modMsgCountBefore = modWs.sentMessages.length;
      userWs.emit('message', Buffer.from(clientMessage(RETRO_FEELING_SELECT, { category: 'Boredom' })));

      // Moderator should NOT receive a feeling:updated broadcast for the invalid request
      const modNewMsgs = modWs.sentMessages.slice(modMsgCountBefore).map(parseMessage);
      const feelingMsg = modNewMsgs.find(m => m.event === RETRO_FEELING_UPDATED);
      expect(feelingMsg).toBeUndefined();
    });
  });

  // ---- Non-moderator config update rejected ----

  describe('Non-moderator config update rejected', () => {
    it('should reject retro:config:update from non-moderator with UNAUTHORIZED', () => {
      jest.spyOn(authService, 'validateToken').mockReturnValueOnce(participantA);
      const ws = createMockWs();
      handleRetroWebSocket(ws, createRetroRequest('token-a', sessionId));

      const msgCountBefore = ws.sentMessages.length;
      ws.emit('message', Buffer.from(clientMessage('retro:config:update', {
        config: { allowedFeelings: ['Happy', 'Sad', 'Mad'] },
      })));

      const newMsgs = ws.sentMessages.slice(msgCountBefore).map(parseMessage);
      const errorMsg = newMsgs.find(m => m.event === 'retro:error');
      expect(errorMsg).toBeDefined();
      expect(errorMsg!.data.code).toBe('UNAUTHORIZED');
    });

    it('should not update allowedFeelings when non-moderator sends config update', () => {
      jest.spyOn(authService, 'validateToken').mockReturnValueOnce(participantA);
      const ws = createMockWs();
      handleRetroWebSocket(ws, createRetroRequest('token-a', sessionId));

      ws.emit('message', Buffer.from(clientMessage('retro:config:update', {
        config: { allowedFeelings: ['Mad', 'Glad'] },
      })));

      const session = retroSessionRegistry.getSession(sessionId)!;
      // allowedFeelings should remain unchanged
      expect(session.config.allowedFeelings).toEqual(['Happy', 'Sad', 'No_Feeling']);
    });
  });

  // ---- Config update clearing affected participants' feelings ----

  describe('Config update clearing affected participants\' feelings', () => {
    it('should clear feelings and broadcast retro:feeling:updated with null for affected participants', () => {
      jest.spyOn(authService, 'validateToken')
        .mockReturnValueOnce(moderatorUser)
        .mockReturnValueOnce(participantA)
        .mockReturnValueOnce(participantB);

      const modWs = createMockWs();
      handleRetroWebSocket(modWs, createRetroRequest('token-mod', sessionId));
      const userAWs = createMockWs();
      handleRetroWebSocket(userAWs, createRetroRequest('token-a', sessionId));
      const userBWs = createMockWs();
      handleRetroWebSocket(userBWs, createRetroRequest('token-b', sessionId));

      // Alice selects 'Happy', Bob selects 'Sad'
      userAWs.emit('message', Buffer.from(clientMessage(RETRO_FEELING_SELECT, { category: 'Happy' })));
      userBWs.emit('message', Buffer.from(clientMessage(RETRO_FEELING_SELECT, { category: 'Sad' })));

      const modMsgCountBefore = modWs.sentMessages.length;

      // Moderator removes 'Happy' from allowedFeelings
      modWs.emit('message', Buffer.from(clientMessage('retro:config:update', {
        config: { allowedFeelings: ['Sad', 'No_Feeling'] },
      })));

      const modNewMsgs = modWs.sentMessages.slice(modMsgCountBefore).map(parseMessage);

      // Should have a retro:feeling:updated broadcast with null for Alice (who had 'Happy')
      const feelingUpdatedMsgs = modNewMsgs.filter(m => m.event === RETRO_FEELING_UPDATED);
      expect(feelingUpdatedMsgs.length).toBeGreaterThanOrEqual(1);

      const aliceClearedMsg = feelingUpdatedMsgs.find(m => m.data.userId === participantA.id);
      expect(aliceClearedMsg).toBeDefined();
      expect(aliceClearedMsg!.data.category).toBeNull();

      // Bob should NOT have his feeling cleared (Sad is still allowed)
      const bobClearedMsg = feelingUpdatedMsgs.find(m => m.data.userId === participantB.id);
      expect(bobClearedMsg).toBeUndefined();
    });

    it('should update session state when config update clears feelings', () => {
      jest.spyOn(authService, 'validateToken')
        .mockReturnValueOnce(moderatorUser)
        .mockReturnValueOnce(participantA);

      const modWs = createMockWs();
      handleRetroWebSocket(modWs, createRetroRequest('token-mod', sessionId));
      const userWs = createMockWs();
      handleRetroWebSocket(userWs, createRetroRequest('token-a', sessionId));

      // Alice selects 'Happy'
      userWs.emit('message', Buffer.from(clientMessage(RETRO_FEELING_SELECT, { category: 'Happy' })));

      const session = retroSessionRegistry.getSession(sessionId)!;
      expect(session.getFeeling(participantA.id)).toBe('Happy');

      // Moderator removes 'Happy' from allowedFeelings
      modWs.emit('message', Buffer.from(clientMessage('retro:config:update', {
        config: { allowedFeelings: ['Sad', 'No_Feeling'] },
      })));

      // Alice's feeling should be cleared
      expect(session.getFeeling(participantA.id)).toBeNull();
    });

    it('should not clear feelings when removed category has no selections', () => {
      jest.spyOn(authService, 'validateToken')
        .mockReturnValueOnce(moderatorUser)
        .mockReturnValueOnce(participantA);

      const modWs = createMockWs();
      handleRetroWebSocket(modWs, createRetroRequest('token-mod', sessionId));
      const userWs = createMockWs();
      handleRetroWebSocket(userWs, createRetroRequest('token-a', sessionId));

      // Alice selects 'Sad'
      userWs.emit('message', Buffer.from(clientMessage(RETRO_FEELING_SELECT, { category: 'Sad' })));

      const modMsgCountBefore = modWs.sentMessages.length;

      // Remove 'No_Feeling' (nobody has selected it)
      modWs.emit('message', Buffer.from(clientMessage('retro:config:update', {
        config: { allowedFeelings: ['Happy', 'Sad'] },
      })));

      const modNewMsgs = modWs.sentMessages.slice(modMsgCountBefore).map(parseMessage);
      const feelingUpdatedMsgs = modNewMsgs.filter(m => m.event === RETRO_FEELING_UPDATED);

      // No feeling cleared events should be broadcast
      expect(feelingUpdatedMsgs.length).toBe(0);

      // Alice's feeling should remain unchanged
      const session = retroSessionRegistry.getSession(sessionId)!;
      expect(session.getFeeling(participantA.id)).toBe('Sad');
    });
  });

  // ---- Disconnect broadcasts null feeling ----

  describe('Disconnect broadcasts null feeling', () => {
    it('should broadcast retro:feeling:updated with null when participant disconnects', () => {
      jest.spyOn(authService, 'validateToken')
        .mockReturnValueOnce(moderatorUser)
        .mockReturnValueOnce(participantA);

      const modWs = createMockWs();
      handleRetroWebSocket(modWs, createRetroRequest('token-mod', sessionId));
      const userWs = createMockWs();
      handleRetroWebSocket(userWs, createRetroRequest('token-a', sessionId));

      // Alice selects a feeling
      userWs.emit('message', Buffer.from(clientMessage(RETRO_FEELING_SELECT, { category: 'Happy' })));

      const modMsgCountBefore = modWs.sentMessages.length;

      // Alice disconnects
      userWs.emit('close');

      const modNewMsgs = modWs.sentMessages.slice(modMsgCountBefore).map(parseMessage);
      const feelingUpdatedMsg = modNewMsgs.find(m => m.event === RETRO_FEELING_UPDATED);
      expect(feelingUpdatedMsg).toBeDefined();
      expect(feelingUpdatedMsg!.data.userId).toBe(participantA.id);
      expect(feelingUpdatedMsg!.data.category).toBeNull();
    });

    it('should broadcast null feeling on disconnect even if participant had no feeling selected', () => {
      jest.spyOn(authService, 'validateToken')
        .mockReturnValueOnce(moderatorUser)
        .mockReturnValueOnce(participantA);

      const modWs = createMockWs();
      handleRetroWebSocket(modWs, createRetroRequest('token-mod', sessionId));
      const userWs = createMockWs();
      handleRetroWebSocket(userWs, createRetroRequest('token-a', sessionId));

      const modMsgCountBefore = modWs.sentMessages.length;

      // Alice disconnects without selecting any feeling
      userWs.emit('close');

      const modNewMsgs = modWs.sentMessages.slice(modMsgCountBefore).map(parseMessage);
      const feelingUpdatedMsg = modNewMsgs.find(m => m.event === RETRO_FEELING_UPDATED);
      expect(feelingUpdatedMsg).toBeDefined();
      expect(feelingUpdatedMsg!.data.userId).toBe(participantA.id);
      expect(feelingUpdatedMsg!.data.category).toBeNull();
    });

    it('should not broadcast null feeling when multi-tab user closes one connection', () => {
      jest.spyOn(authService, 'validateToken')
        .mockReturnValueOnce(moderatorUser)
        .mockReturnValueOnce(participantA)
        .mockReturnValueOnce(participantA);

      const modWs = createMockWs();
      handleRetroWebSocket(modWs, createRetroRequest('token-mod', sessionId));

      // Alice connects with two tabs
      const userWs1 = createMockWs();
      handleRetroWebSocket(userWs1, createRetroRequest('token-a', sessionId));
      const userWs2 = createMockWs();
      handleRetroWebSocket(userWs2, createRetroRequest('token-a', sessionId));

      // Alice selects a feeling
      userWs1.emit('message', Buffer.from(clientMessage(RETRO_FEELING_SELECT, { category: 'Happy' })));

      const modMsgCountBefore = modWs.sentMessages.length;

      // Close one tab
      userWs1.emit('close');

      const modNewMsgs = modWs.sentMessages.slice(modMsgCountBefore).map(parseMessage);
      const feelingUpdatedMsg = modNewMsgs.find(m => m.event === RETRO_FEELING_UPDATED);
      // Should NOT broadcast feeling cleared because Alice still has another connection
      expect(feelingUpdatedMsg).toBeUndefined();

      // Alice's feeling should still be stored
      const session = retroSessionRegistry.getSession(sessionId)!;
      expect(session.getFeeling(participantA.id)).toBe('Happy');
    });

    it('should broadcast null feeling when last connection of multi-tab user closes', () => {
      jest.spyOn(authService, 'validateToken')
        .mockReturnValueOnce(moderatorUser)
        .mockReturnValueOnce(participantA)
        .mockReturnValueOnce(participantA);

      const modWs = createMockWs();
      handleRetroWebSocket(modWs, createRetroRequest('token-mod', sessionId));

      // Alice connects with two tabs
      const userWs1 = createMockWs();
      handleRetroWebSocket(userWs1, createRetroRequest('token-a', sessionId));
      const userWs2 = createMockWs();
      handleRetroWebSocket(userWs2, createRetroRequest('token-a', sessionId));

      // Alice selects a feeling
      userWs1.emit('message', Buffer.from(clientMessage(RETRO_FEELING_SELECT, { category: 'Happy' })));

      // Close both tabs
      userWs1.emit('close');
      const modMsgCountBefore = modWs.sentMessages.length;
      userWs2.emit('close');

      const modNewMsgs = modWs.sentMessages.slice(modMsgCountBefore).map(parseMessage);
      const feelingUpdatedMsg = modNewMsgs.find(m => m.event === RETRO_FEELING_UPDATED);
      expect(feelingUpdatedMsg).toBeDefined();
      expect(feelingUpdatedMsg!.data.userId).toBe(participantA.id);
      expect(feelingUpdatedMsg!.data.category).toBeNull();
    });
  });
});
