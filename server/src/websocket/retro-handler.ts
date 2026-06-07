import { IncomingMessage } from 'http';
import WebSocket from 'ws';
import { URL } from 'url';
import {
  User,
  WebSocketMessage,
  FeelingCategory,
  ALL_FEELING_CATEGORIES,
  RETRO_FEELING_SELECT,
  RETRO_FEELING_UPDATED,
} from '../../../shared/types';
import { validateToken } from '../services/auth-service';
import { retroSessionRegistry } from '../services/retro-session-registry';
import { RetroSession } from '../services/retro-session';

// sessionId -> userId -> Set<WebSocket>
const retroSessionClients = new Map<string, Map<string, Set<WebSocket>>>();

// Track which session each WebSocket belongs to
const wsSessionMap = new WeakMap<WebSocket, string>();

// Track which user each WebSocket belongs to
const wsUserMap = new WeakMap<WebSocket, User>();

/**
 * Get the retro session-scoped clients map (exported for testing and broadcasting).
 */
export function getRetroSessionClients(): Map<string, Map<string, Set<WebSocket>>> {
  return retroSessionClients;
}

/**
 * Create a WebSocket message envelope.
 */
function createMessage(event: string, data: any): string {
  const message: WebSocketMessage = {
    event,
    data,
    timestamp: new Date().toISOString(),
  };
  return JSON.stringify(message);
}

/**
 * Broadcast a message to all connected clients in a specific retro session.
 */
function broadcastToSession(sessionId: string, event: string, data: any): void {
  const userMap = retroSessionClients.get(sessionId);
  if (!userMap) return;
  const msg = createMessage(event, data);
  userMap.forEach((sockets) => {
    sockets.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
      }
    });
  });
}

/**
 * Send a message to a specific WebSocket connection.
 */
function sendToClient(ws: WebSocket, event: string, data: any): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(createMessage(event, data));
  }
}

/**
 * Send an error message to a specific WebSocket connection.
 */
function sendError(ws: WebSocket, message: string, code: string): void {
  sendToClient(ws, 'retro:error', { message, code });
}

/**
 * Check if a user is the moderator (owner or has moderator role) of the session.
 */
function isModerator(session: RetroSession, userId: string): boolean {
  if (session.ownerId === userId) return true;
  const participant = session.getParticipants().find(p => p.id === userId);
  return participant?.role === 'moderator';
}

/**
 * Get the visible state for a user, respecting card visibility rules.
 */
function getVisibleStateForUser(session: RetroSession, userId: string): any {
  return session.getVisibleState(userId);
}

/**
 * Broadcast the visible state to each participant individually,
 * respecting card visibility filtering.
 */
function broadcastVisibleStateToAll(sessionId: string, session: RetroSession): void {
  const userMap = retroSessionClients.get(sessionId);
  if (!userMap) return;

  userMap.forEach((sockets, userId) => {
    const state = getVisibleStateForUser(session, userId);
    const msg = createMessage('retro:session:state', { state });
    sockets.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
      }
    });
  });
}

/**
 * Handle an incoming retro client event, routed to the correct RetroSession method.
 */
function handleRetroEvent(ws: WebSocket, user: User, sessionId: string, event: string, data: any): void {
  const session = retroSessionRegistry.getSession(sessionId);
  if (!session) {
    sendError(ws, 'Session not found', 'NOT_FOUND');
    return;
  }

  // Moderator-only events
  const moderatorOnlyEvents = [
    'retro:context:update',
    'retro:cards:reveal',
    'retro:voting:enable',
    'retro:board:complete',
    'retro:config:update',
  ];

  if (moderatorOnlyEvents.includes(event) && !isModerator(session, user.id)) {
    sendError(ws, 'Only the moderator can perform this action', 'UNAUTHORIZED');
    return;
  }

  try {
    switch (event) {
      case 'retro:card:add':
        handleCardAdd(ws, user, sessionId, session, data);
        break;
      case 'retro:card:edit':
        handleCardEdit(ws, user, sessionId, session, data);
        break;
      case 'retro:card:remove':
        handleCardRemove(ws, user, sessionId, session, data);
        break;
      case 'retro:card:move':
        handleCardMove(ws, user, sessionId, session, data);
        break;
      case 'retro:card:vote':
        handleCardVote(ws, user, sessionId, session, data);
        break;
      case 'retro:card:unvote':
        handleCardUnvote(ws, user, sessionId, session, data);
        break;
      case 'retro:comment:add':
        handleCommentAdd(ws, user, sessionId, session, data);
        break;
      case 'retro:comment:remove':
        handleCommentRemove(ws, user, sessionId, session, data);
        break;
      case 'retro:column:add':
        handleColumnAdd(ws, user, sessionId, session, data);
        break;
      case 'retro:column:remove':
        handleColumnRemove(ws, user, sessionId, session, data);
        break;
      case 'retro:column:reorder':
        handleColumnReorder(ws, user, sessionId, session, data);
        break;
      case 'retro:column:rename':
        handleColumnRename(ws, user, sessionId, session, data);
        break;
      case 'retro:context:update':
        handleContextUpdate(ws, user, sessionId, session, data);
        break;
      case 'retro:cards:reveal':
        handleCardsReveal(ws, user, sessionId, session);
        break;
      case 'retro:voting:enable':
        handleVotingEnable(ws, user, sessionId, session);
        break;
      case 'retro:board:complete':
        handleBoardComplete(ws, user, sessionId, session);
        break;
      case 'retro:card:merge':
        handleCardMerge(ws, user, sessionId, session, data);
        break;
      case 'retro:config:update':
        handleConfigUpdate(ws, user, sessionId, session, data);
        break;
      case RETRO_FEELING_SELECT:
        handleFeelingSelect(ws, user, sessionId, session, data);
        break;
      case 'role:change':
        handleRoleChange(ws, user, sessionId, session, data);
        break;
      default:
        sendError(ws, `Unknown event: ${event}`, 'UNKNOWN_EVENT');
    }
  } catch (err: any) {
    // Map known error messages to error codes
    const errorCode = mapErrorToCode(err.message);
    sendError(ws, err.message, errorCode);
  }
}

/**
 * Map error messages from RetroSession to appropriate error codes.
 */
function mapErrorToCode(message: string): string {
  if (message.includes('completed')) return 'BOARD_COMPLETED';
  if (message.includes('not found') || message.includes('Not found')) return 'NOT_FOUND';
  if (message.includes('Not authorized') || message.includes('not authorized')) return 'UNAUTHORIZED';
  if (message.includes('No votes remaining') || message.includes('no votes remaining')) return 'NO_VOTES_REMAINING';
  if (message.includes('empty') || message.includes('Empty')) return 'EMPTY_INPUT';
  return 'ERROR';
}

// --- Event Handlers ---

function handleCardAdd(ws: WebSocket, user: User, sessionId: string, session: RetroSession, data: any): void {
  const { columnId, text } = data || {};
  if (!columnId) {
    sendError(ws, 'Column ID is required', 'NOT_FOUND');
    return;
  }

  const cardText = (typeof text === 'string') ? text : '';
  const card = session.addCard(columnId, cardText, user.id, user.displayName);
  broadcastToSession(sessionId, 'retro:card:added', { card, columnId });
}

function handleCardEdit(ws: WebSocket, user: User, sessionId: string, session: RetroSession, data: any): void {
  const { cardId, text } = data || {};
  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    sendError(ws, 'Card text cannot be empty', 'EMPTY_INPUT');
    return;
  }
  if (!cardId) {
    sendError(ws, 'Card ID is required', 'NOT_FOUND');
    return;
  }

  session.editCard(cardId, text.trim(), user.id);
  broadcastToSession(sessionId, 'retro:card:edited', { cardId, text: text.trim() });
}

function handleCardRemove(ws: WebSocket, user: User, sessionId: string, session: RetroSession, data: any): void {
  const { cardId } = data || {};
  if (!cardId) {
    sendError(ws, 'Card ID is required', 'NOT_FOUND');
    return;
  }

  session.removeCard(cardId, user.id);
  broadcastToSession(sessionId, 'retro:card:removed', { cardId });
}

function handleCardMove(ws: WebSocket, user: User, sessionId: string, session: RetroSession, data: any): void {
  const { cardId, targetColumnId, targetIndex } = data || {};
  if (!cardId) {
    sendError(ws, 'Card ID is required', 'NOT_FOUND');
    return;
  }
  if (!targetColumnId) {
    sendError(ws, 'Target column ID is required', 'NOT_FOUND');
    return;
  }
  if (targetIndex === undefined || typeof targetIndex !== 'number') {
    sendError(ws, 'Target index is required', 'NOT_FOUND');
    return;
  }

  session.moveCard(cardId, targetColumnId, targetIndex);
  broadcastToSession(sessionId, 'retro:card:moved', { cardId, targetColumnId, targetIndex });
}

function handleCardMerge(ws: WebSocket, user: User, sessionId: string, session: RetroSession, data: any): void {
  const { sourceCardId, targetCardId } = data || {};
  if (!sourceCardId) {
    sendError(ws, 'Source card ID is required', 'NOT_FOUND');
    return;
  }
  if (!targetCardId) {
    sendError(ws, 'Target card ID is required', 'NOT_FOUND');
    return;
  }

  const { targetCard, removedFromColumnId } = session.mergeCards(sourceCardId, targetCardId, user.id);
  broadcastToSession(sessionId, 'retro:card:merged', {
    targetCard,
    removedCardId: sourceCardId,
    removedFromColumnId,
  });
}

function handleCardVote(ws: WebSocket, user: User, sessionId: string, session: RetroSession, data: any): void {
  const { cardId } = data || {};
  if (!cardId) {
    sendError(ws, 'Card ID is required', 'NOT_FOUND');
    return;
  }

  session.voteCard(cardId, user.id);
  const votesRemaining = session.getVotesRemaining(user.id);
  broadcastToSession(sessionId, 'retro:card:voted', {
    cardId,
    votes: session.getVisibleState(user.id).board.columns
      .flatMap(col => col.cards)
      .find(c => c.id === cardId)?.votes ?? 0,
    votedBy: session.getVisibleState(user.id).board.columns
      .flatMap(col => col.cards)
      .find(c => c.id === cardId)?.votedBy ?? [],
    votesRemaining: { [user.id]: votesRemaining },
  });
}

function handleCardUnvote(ws: WebSocket, user: User, sessionId: string, session: RetroSession, data: any): void {
  const { cardId } = data || {};
  if (!cardId) {
    sendError(ws, 'Card ID is required', 'NOT_FOUND');
    return;
  }

  session.unvoteCard(cardId, user.id);
  const votesRemaining = session.getVotesRemaining(user.id);
  broadcastToSession(sessionId, 'retro:card:voted', {
    cardId,
    votes: session.getSessionState().board.columns
      .flatMap(col => col.cards)
      .find(c => c.id === cardId)?.votes ?? 0,
    votedBy: session.getSessionState().board.columns
      .flatMap(col => col.cards)
      .find(c => c.id === cardId)?.votedBy ?? [],
    votesRemaining: { [user.id]: votesRemaining },
  });
}

function handleCommentAdd(ws: WebSocket, user: User, sessionId: string, session: RetroSession, data: any): void {
  const { cardId, text } = data || {};
  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    sendError(ws, 'Comment text cannot be empty', 'EMPTY_INPUT');
    return;
  }
  if (!cardId) {
    sendError(ws, 'Card ID is required', 'NOT_FOUND');
    return;
  }

  const comment = session.addComment(cardId, text.trim(), user.id, user.displayName);
  broadcastToSession(sessionId, 'retro:comment:added', { cardId, comment });
}

function handleCommentRemove(ws: WebSocket, user: User, sessionId: string, session: RetroSession, data: any): void {
  const { cardId, commentId } = data || {};
  if (!cardId) {
    sendError(ws, 'Card ID is required', 'NOT_FOUND');
    return;
  }
  if (!commentId) {
    sendError(ws, 'Comment ID is required', 'NOT_FOUND');
    return;
  }

  session.removeComment(cardId, commentId, user.id);
  broadcastToSession(sessionId, 'retro:comment:removed', { cardId, commentId });
}

function handleColumnAdd(ws: WebSocket, user: User, sessionId: string, session: RetroSession, data: any): void {
  const { name } = data || {};
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    sendError(ws, 'Column name cannot be empty', 'EMPTY_INPUT');
    return;
  }

  const column = session.addColumn(name.trim());
  broadcastToSession(sessionId, 'retro:column:added', { column });
}

function handleColumnRemove(ws: WebSocket, user: User, sessionId: string, session: RetroSession, data: any): void {
  const { columnId } = data || {};
  if (!columnId) {
    sendError(ws, 'Column ID is required', 'NOT_FOUND');
    return;
  }

  session.removeColumn(columnId);
  broadcastToSession(sessionId, 'retro:column:removed', { columnId });
}

function handleColumnReorder(ws: WebSocket, user: User, sessionId: string, session: RetroSession, data: any): void {
  const { orderedIds } = data || {};
  if (!orderedIds || !Array.isArray(orderedIds)) {
    sendError(ws, 'Ordered IDs array is required', 'NOT_FOUND');
    return;
  }

  session.reorderColumns(orderedIds);
  broadcastToSession(sessionId, 'retro:column:reordered', { orderedIds });
}

function handleColumnRename(ws: WebSocket, user: User, sessionId: string, session: RetroSession, data: any): void {
  const { columnId, name } = data || {};
  if (!columnId) {
    sendError(ws, 'Column ID is required', 'NOT_FOUND');
    return;
  }
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    sendError(ws, 'Column name cannot be empty', 'EMPTY_INPUT');
    return;
  }

  session.renameColumn(columnId, name.trim());
  broadcastToSession(sessionId, 'retro:column:renamed', { columnId, name: name.trim() });
}

function handleContextUpdate(ws: WebSocket, user: User, sessionId: string, session: RetroSession, data: any): void {
  const { text } = data || {};
  if (text === undefined || typeof text !== 'string') {
    sendError(ws, 'Context text is required', 'EMPTY_INPUT');
    return;
  }

  session.updateContext(text);
  broadcastToSession(sessionId, 'retro:context:updated', { text });
}

function handleCardsReveal(ws: WebSocket, user: User, sessionId: string, session: RetroSession): void {
  session.revealCards();
  broadcastToSession(sessionId, 'retro:cards:revealed', {});
}

function handleVotingEnable(ws: WebSocket, user: User, sessionId: string, session: RetroSession): void {
  session.enableVoting();
  broadcastToSession(sessionId, 'retro:voting:enabled', {});
}

function handleBoardComplete(ws: WebSocket, user: User, sessionId: string, session: RetroSession): void {
  session.completeBoard();
  broadcastToSession(sessionId, 'retro:board:completed', {});
}

function handleConfigUpdate(ws: WebSocket, user: User, sessionId: string, session: RetroSession, data: any): void {
  const { config } = data || {};
  if (!config || typeof config !== 'object') {
    sendError(ws, 'Configuration object is required', 'EMPTY_INPUT');
    return;
  }

  const { config: updatedConfig, affectedUserIds } = session.updateConfig(config);
  // Include current votingEnabled so clients can update board state immediately
  const votingEnabled = session.getSessionState().board.votingEnabled;
  broadcastToSession(sessionId, 'retro:config:updated', { config: updatedConfig, votingEnabled });

  // Broadcast individual feeling cleared events for participants whose feelings were removed
  if (affectedUserIds && affectedUserIds.length > 0) {
    for (const affectedUserId of affectedUserIds) {
      broadcastToSession(sessionId, RETRO_FEELING_UPDATED, { userId: affectedUserId, category: null });
    }
  }
}

function handleFeelingSelect(ws: WebSocket, user: User, sessionId: string, session: RetroSession, data: any): void {
  const { category } = data || {};

  // Validate the category value: must be null or a valid FeelingCategory string
  if (category !== null && category !== undefined) {
    if (typeof category !== 'string' || !ALL_FEELING_CATEGORIES.includes(category as FeelingCategory)) {
      sendError(ws, 'Invalid feeling category', 'INVALID_FEELING');
      return;
    }
  }

  const feelingCategory: FeelingCategory | null = category === undefined ? null : category as FeelingCategory | null;

  try {
    session.setFeeling(user.id, feelingCategory);
    broadcastToSession(sessionId, RETRO_FEELING_UPDATED, { userId: user.id, category: feelingCategory });
  } catch (err: any) {
    if (err.message.includes('completed')) {
      sendError(ws, err.message, 'BOARD_COMPLETED');
    } else if (err.message.includes('Invalid feeling')) {
      sendError(ws, err.message, 'INVALID_FEELING');
    } else {
      sendError(ws, err.message, 'ERROR');
    }
  }
}

function handleRoleChange(ws: WebSocket, user: User, sessionId: string, session: RetroSession, data: any): void {
  const { role } = data || {};
  if (role !== 'moderator' && role !== 'participant') {
    sendError(ws, 'Invalid role', 'ERROR');
    return;
  }

  // Update the user's role in the participant list
  const updatedUser: User = { ...user, role };
  session.removeParticipant(user.id);
  session.addParticipant(updatedUser);

  // Update the ws user mapping
  wsUserMap.set(ws, updatedUser);

  // Broadcast updated participant list
  broadcastToSession(sessionId, 'retro:participant:joined', { participants: session.getParticipants() });
}

/**
 * Main WebSocket connection handler for retrospective sessions.
 * Authenticates the connection via token query parameter,
 * validates the session, registers the participant, and routes incoming messages.
 */
export function handleRetroWebSocket(ws: WebSocket, request: IncomingMessage): void {
  // Parse token and sessionId from query string
  const url = new URL(
    request.url || '',
    `http://${request.headers.host || (request.headers as any)[':authority'] || 'localhost:3000'}`
  );
  const token = url.searchParams.get('token');
  const sessionId = url.searchParams.get('sessionId');

  if (!token) {
    ws.close(4001, 'Authentication required');
    return;
  }

  // Validate the token
  const user = validateToken(token);
  if (!user) {
    ws.close(4001, 'Invalid or expired token');
    return;
  }

  // Validate session ID
  if (!sessionId) {
    ws.close(4004, 'Session ID required');
    return;
  }

  if (!retroSessionRegistry.hasSession(sessionId)) {
    ws.close(4004, 'Session not found');
    return;
  }

  const session = retroSessionRegistry.getSession(sessionId)!;

  // If this user is the session owner, ensure they are a moderator
  let participant: User = user;
  if (user.id === session.ownerId) {
    participant = { ...user, role: 'moderator' };
  }

  // Check display name uniqueness (skip for same user reconnecting/multi-tab)
  const existingParticipant = session.getParticipants().find(p => p.id === participant.id);
  if (!existingParticipant && session.hasDisplayName(participant.displayName)) {
    ws.close(4009, 'Display name already in use in this session');
    return;
  }

  // Track ws → session and ws → user
  wsSessionMap.set(ws, sessionId);
  wsUserMap.set(ws, participant);

  // Register the client connection in session-scoped map
  if (!retroSessionClients.has(sessionId)) {
    retroSessionClients.set(sessionId, new Map());
  }
  const userMap = retroSessionClients.get(sessionId)!;
  if (!userMap.has(participant.id)) {
    userMap.set(participant.id, new Set());
  }
  userMap.get(participant.id)!.add(ws);

  // Add user as participant in the RetroSession (handles reconnect — replaces existing entry)
  session.addParticipant(participant);

  // Send full session state to the newly connected client (filtered by visibility)
  const visibleState = getVisibleStateForUser(session, participant.id);
  sendToClient(ws, 'retro:session:state', { state: visibleState });

  // Broadcast updated participant list to all clients in this session
  broadcastToSession(sessionId, 'retro:participant:joined', { participants: session.getParticipants() });

  // Listen for incoming messages
  ws.on('message', (rawData: WebSocket.RawData) => {
    try {
      const message: WebSocketMessage = JSON.parse(rawData.toString());

      if (!message.event || typeof message.event !== 'string') {
        sendError(ws, 'Invalid message format: missing event', 'INVALID_MESSAGE');
        return;
      }

      handleRetroEvent(ws, participant, sessionId, message.event, message.data || {});
    } catch {
      sendError(ws, 'Invalid message format: malformed JSON', 'INVALID_MESSAGE');
    }
  });

  // Handle disconnect
  ws.on('close', () => {
    const sid = wsSessionMap.get(ws) || sessionId;
    const uMap = retroSessionClients.get(sid);
    if (uMap) {
      const userSockets = uMap.get(participant.id);
      if (userSockets) {
        userSockets.delete(ws);
        // Only remove participant if all connections for this user in this session are closed
        if (userSockets.size === 0) {
          uMap.delete(participant.id);

          const retroSession = retroSessionRegistry.getSession(sid);
          if (retroSession) {
            retroSession.removeParticipant(participant.id);
            broadcastToSession(sid, 'retro:participant:left', { participants: retroSession.getParticipants() });
            // Broadcast feeling cleared for disconnected user
            broadcastToSession(sid, RETRO_FEELING_UPDATED, { userId: participant.id, category: null });
          }

          // Clean up empty session client map
          if (uMap.size === 0) {
            retroSessionClients.delete(sid);
          }
        }
      }
    }
  });
}

/**
 * Reset handler state. Used for test isolation.
 */
export function _resetRetroHandler(): void {
  retroSessionClients.clear();
}
