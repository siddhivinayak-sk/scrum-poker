import { IncomingMessage } from 'http';
import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { handleRetroWebSocket, _resetRetroHandler } from '../../websocket/retro-handler';
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
  boardName: 'Merge Integration Test',
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

describe('Integration: Merge WebSocket Flow', () => {
  let sessionId: string;

  beforeEach(() => {
    _resetRetroHandler();
    retroSessionRegistry._reset();
    jest.restoreAllMocks();
    // Create a retro session owned by participantA (who becomes moderator)
    const info = retroSessionRegistry.createSession(participantA.id, defaultRetroConfig);
    sessionId = info.sessionId;
  });

  it('should broadcast retro:card:merged to all connected clients when one client merges cards', () => {
    // Connect two clients to the same retro session
    jest.spyOn(authService, 'validateToken')
      .mockReturnValueOnce(participantA)
      .mockReturnValueOnce(participantB);

    const wsA = createMockWs();
    handleRetroWebSocket(wsA, createRetroRequest('token-a', sessionId));
    const wsB = createMockWs();
    handleRetroWebSocket(wsB, createRetroRequest('token-b', sessionId));

    // Get the first column ID from session state
    const stateMsg = wsA.sentMessages.map(parseMessage).find(m => m.event === 'retro:session:state');
    const columnId = stateMsg!.data.state.board.columns[0].id;

    // Client A adds two cards (source and target)
    wsA.emit('message', Buffer.from(clientMessage('retro:card:add', { columnId, text: 'Target card text' })));
    wsA.emit('message', Buffer.from(clientMessage('retro:card:add', { columnId, text: 'Source card text' })));

    // Extract card IDs from the added broadcasts
    const allMsgsA = wsA.sentMessages.map(parseMessage);
    const addedMsgs = allMsgsA.filter(m => m.event === 'retro:card:added');
    const targetCardId = addedMsgs[0].data.card.id;
    const sourceCardId = addedMsgs[1].data.card.id;

    // Record message counts before merge
    const wsAMsgCountBefore = wsA.sentMessages.length;
    const wsBMsgCountBefore = wsB.sentMessages.length;

    // Client A sends merge request
    wsA.emit('message', Buffer.from(clientMessage('retro:card:merge', {
      sourceCardId,
      targetCardId,
    })));

    // Verify Client A receives retro:card:merged
    const aMsgsAfter = wsA.sentMessages.slice(wsAMsgCountBefore).map(parseMessage);
    const aMergedMsg = aMsgsAfter.find(m => m.event === 'retro:card:merged');
    expect(aMergedMsg).toBeDefined();
    expect(aMergedMsg!.data.targetCard.id).toBe(targetCardId);
    expect(aMergedMsg!.data.targetCard.text).toBe('Target card text\n--------\nSource card text');
    expect(aMergedMsg!.data.removedCardId).toBe(sourceCardId);
    expect(aMergedMsg!.data.removedFromColumnId).toBe(columnId);

    // Verify Client B also receives retro:card:merged
    const bMsgsAfter = wsB.sentMessages.slice(wsBMsgCountBefore).map(parseMessage);
    const bMergedMsg = bMsgsAfter.find(m => m.event === 'retro:card:merged');
    expect(bMergedMsg).toBeDefined();
    expect(bMergedMsg!.data.targetCard.id).toBe(targetCardId);
    expect(bMergedMsg!.data.targetCard.text).toBe('Target card text\n--------\nSource card text');
    expect(bMergedMsg!.data.removedCardId).toBe(sourceCardId);
    expect(bMergedMsg!.data.removedFromColumnId).toBe(columnId);
  });

  it('should reflect merged card and source card removed in session state for subsequent connections', () => {
    // Connect Client A
    jest.spyOn(authService, 'validateToken').mockReturnValueOnce(participantA);
    const wsA = createMockWs();
    handleRetroWebSocket(wsA, createRetroRequest('token-a', sessionId));

    // Get column ID
    const stateMsg = wsA.sentMessages.map(parseMessage).find(m => m.event === 'retro:session:state');
    const columnId = stateMsg!.data.state.board.columns[0].id;

    // Add two cards
    wsA.emit('message', Buffer.from(clientMessage('retro:card:add', { columnId, text: 'Keep this' })));
    wsA.emit('message', Buffer.from(clientMessage('retro:card:add', { columnId, text: 'Merge into target' })));

    const allMsgsA = wsA.sentMessages.map(parseMessage);
    const addedMsgs = allMsgsA.filter(m => m.event === 'retro:card:added');
    const targetCardId = addedMsgs[0].data.card.id;
    const sourceCardId = addedMsgs[1].data.card.id;

    // Perform merge
    wsA.emit('message', Buffer.from(clientMessage('retro:card:merge', {
      sourceCardId,
      targetCardId,
    })));

    // Now a new Client B connects and should see the merged state
    jest.spyOn(authService, 'validateToken').mockReturnValueOnce(participantB);
    const wsB = createMockWs();
    handleRetroWebSocket(wsB, createRetroRequest('token-b', sessionId));

    const bStateMsgs = wsB.sentMessages.map(parseMessage);
    const bState = bStateMsgs.find(m => m.event === 'retro:session:state');
    expect(bState).toBeDefined();

    const column = bState!.data.state.board.columns.find((c: any) => c.id === columnId);
    expect(column).toBeDefined();

    // Source card should be removed — only target card remains
    expect(column.cards.length).toBe(1);
    expect(column.cards[0].id).toBe(targetCardId);
    expect(column.cards[0].text).toBe('Keep this\n--------\nMerge into target');

    // Source card should not exist
    const sourceCardInState = column.cards.find((c: any) => c.id === sourceCardId);
    expect(sourceCardInState).toBeUndefined();
  });

  it('should merge votes and comments from both cards', () => {
    // Connect two clients
    jest.spyOn(authService, 'validateToken')
      .mockReturnValueOnce(participantA)
      .mockReturnValueOnce(participantB);

    const wsA = createMockWs();
    handleRetroWebSocket(wsA, createRetroRequest('token-a', sessionId));
    const wsB = createMockWs();
    handleRetroWebSocket(wsB, createRetroRequest('token-b', sessionId));

    // Get column ID
    const stateMsg = wsA.sentMessages.map(parseMessage).find(m => m.event === 'retro:session:state');
    const columnId = stateMsg!.data.state.board.columns[0].id;

    // Add target card and vote on it from A
    wsA.emit('message', Buffer.from(clientMessage('retro:card:add', { columnId, text: 'Target' })));
    const addedMsgs1 = wsA.sentMessages.map(parseMessage).filter(m => m.event === 'retro:card:added');
    const targetCardId = addedMsgs1[0].data.card.id;
    wsA.emit('message', Buffer.from(clientMessage('retro:card:vote', { cardId: targetCardId })));

    // Add source card and vote on it from B, also add a comment
    wsA.emit('message', Buffer.from(clientMessage('retro:card:add', { columnId, text: 'Source' })));
    const addedMsgs2 = wsA.sentMessages.map(parseMessage).filter(m => m.event === 'retro:card:added');
    const sourceCardId = addedMsgs2[1].data.card.id;
    wsB.emit('message', Buffer.from(clientMessage('retro:card:vote', { cardId: sourceCardId })));
    wsA.emit('message', Buffer.from(clientMessage('retro:comment:add', { cardId: sourceCardId, text: 'Good point' })));

    // Perform merge from Client A
    const wsAMsgCountBefore = wsA.sentMessages.length;
    const wsBMsgCountBefore = wsB.sentMessages.length;

    wsA.emit('message', Buffer.from(clientMessage('retro:card:merge', {
      sourceCardId,
      targetCardId,
    })));

    // Verify merged card has combined votes (1 from target + 1 from source = 2)
    const aMsgsAfter = wsA.sentMessages.slice(wsAMsgCountBefore).map(parseMessage);
    const mergedMsg = aMsgsAfter.find(m => m.event === 'retro:card:merged');
    expect(mergedMsg).toBeDefined();
    expect(mergedMsg!.data.targetCard.votes).toBe(2);
    expect(mergedMsg!.data.targetCard.text).toBe('Target\n--------\nSource');

    // Verify comments are concatenated
    expect(mergedMsg!.data.targetCard.comments.length).toBeGreaterThanOrEqual(1);
    const commentTexts = mergedMsg!.data.targetCard.comments.map((c: any) => c.text);
    expect(commentTexts).toContain('Good point');

    // Verify Client B also receives same data
    const bMsgsAfter = wsB.sentMessages.slice(wsBMsgCountBefore).map(parseMessage);
    const bMergedMsg = bMsgsAfter.find(m => m.event === 'retro:card:merged');
    expect(bMergedMsg).toBeDefined();
    expect(bMergedMsg!.data.targetCard.votes).toBe(2);
    expect(bMergedMsg!.data.removedCardId).toBe(sourceCardId);
  });

  it('should send error to requesting client when merging on a completed board', () => {
    // Connect Client A
    jest.spyOn(authService, 'validateToken').mockReturnValueOnce(participantA);
    const wsA = createMockWs();
    handleRetroWebSocket(wsA, createRetroRequest('token-a', sessionId));

    // Get column ID and add two cards
    const stateMsg = wsA.sentMessages.map(parseMessage).find(m => m.event === 'retro:session:state');
    const columnId = stateMsg!.data.state.board.columns[0].id;

    wsA.emit('message', Buffer.from(clientMessage('retro:card:add', { columnId, text: 'Card A' })));
    wsA.emit('message', Buffer.from(clientMessage('retro:card:add', { columnId, text: 'Card B' })));

    const addedMsgs = wsA.sentMessages.map(parseMessage).filter(m => m.event === 'retro:card:added');
    const targetCardId = addedMsgs[0].data.card.id;
    const sourceCardId = addedMsgs[1].data.card.id;

    // Complete the board (participantA is moderator/owner)
    wsA.emit('message', Buffer.from(clientMessage('retro:board:complete', {})));

    // Attempt to merge on completed board
    const msgCountBefore = wsA.sentMessages.length;
    wsA.emit('message', Buffer.from(clientMessage('retro:card:merge', {
      sourceCardId,
      targetCardId,
    })));

    // Verify error is sent back to requesting client
    const newMsgs = wsA.sentMessages.slice(msgCountBefore).map(parseMessage);
    const errorMsg = newMsgs.find(m => m.event === 'retro:error');
    expect(errorMsg).toBeDefined();
    expect(errorMsg!.data.code).toBe('BOARD_COMPLETED');
  });

  it('should send error when source card ID is invalid', () => {
    jest.spyOn(authService, 'validateToken').mockReturnValueOnce(participantA);
    const wsA = createMockWs();
    handleRetroWebSocket(wsA, createRetroRequest('token-a', sessionId));

    // Add a card to use as target
    const stateMsg = wsA.sentMessages.map(parseMessage).find(m => m.event === 'retro:session:state');
    const columnId = stateMsg!.data.state.board.columns[0].id;
    wsA.emit('message', Buffer.from(clientMessage('retro:card:add', { columnId, text: 'Target' })));
    const addedMsgs = wsA.sentMessages.map(parseMessage).filter(m => m.event === 'retro:card:added');
    const targetCardId = addedMsgs[0].data.card.id;

    // Attempt merge with non-existent source card
    const msgCountBefore = wsA.sentMessages.length;
    wsA.emit('message', Buffer.from(clientMessage('retro:card:merge', {
      sourceCardId: 'non-existent-card',
      targetCardId,
    })));

    const newMsgs = wsA.sentMessages.slice(msgCountBefore).map(parseMessage);
    const errorMsg = newMsgs.find(m => m.event === 'retro:error');
    expect(errorMsg).toBeDefined();
    expect(errorMsg!.data.code).toBe('NOT_FOUND');
  });

  it('should support cross-column merge and report correct removedFromColumnId', () => {
    // Connect two clients
    jest.spyOn(authService, 'validateToken')
      .mockReturnValueOnce(participantA)
      .mockReturnValueOnce(participantB);

    const wsA = createMockWs();
    handleRetroWebSocket(wsA, createRetroRequest('token-a', sessionId));
    const wsB = createMockWs();
    handleRetroWebSocket(wsB, createRetroRequest('token-b', sessionId));

    // Get the two column IDs (default template has at least 3 columns)
    const stateMsg = wsA.sentMessages.map(parseMessage).find(m => m.event === 'retro:session:state');
    const columns = stateMsg!.data.state.board.columns;
    const column1Id = columns[0].id;
    const column2Id = columns[1].id;

    // Add target card in column 1
    wsA.emit('message', Buffer.from(clientMessage('retro:card:add', { columnId: column1Id, text: 'In column 1' })));
    // Add source card in column 2
    wsA.emit('message', Buffer.from(clientMessage('retro:card:add', { columnId: column2Id, text: 'In column 2' })));

    const addedMsgs = wsA.sentMessages.map(parseMessage).filter(m => m.event === 'retro:card:added');
    const targetCardId = addedMsgs[0].data.card.id;
    const sourceCardId = addedMsgs[1].data.card.id;

    // Perform cross-column merge
    const wsAMsgCountBefore = wsA.sentMessages.length;
    const wsBMsgCountBefore = wsB.sentMessages.length;

    wsA.emit('message', Buffer.from(clientMessage('retro:card:merge', {
      sourceCardId,
      targetCardId,
    })));

    // Verify both clients receive the merge with correct removedFromColumnId
    const aMsgsAfter = wsA.sentMessages.slice(wsAMsgCountBefore).map(parseMessage);
    const aMergedMsg = aMsgsAfter.find(m => m.event === 'retro:card:merged');
    expect(aMergedMsg).toBeDefined();
    expect(aMergedMsg!.data.removedFromColumnId).toBe(column2Id);
    expect(aMergedMsg!.data.targetCard.text).toBe('In column 1\n--------\nIn column 2');

    const bMsgsAfter = wsB.sentMessages.slice(wsBMsgCountBefore).map(parseMessage);
    const bMergedMsg = bMsgsAfter.find(m => m.event === 'retro:card:merged');
    expect(bMergedMsg).toBeDefined();
    expect(bMergedMsg!.data.removedFromColumnId).toBe(column2Id);
    expect(bMergedMsg!.data.removedCardId).toBe(sourceCardId);
  });
});
