import { IncomingMessage } from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import { URL } from 'url';
import {
  User,
  CardValue,
  WebSocketMessage,
  VotingRound,
  GameSessionState,
  ExtendedCardValue,
  VOTING_SYSTEMS,
  SPECIAL_CARDS,
} from '../../../shared/types';
import { validateToken } from '../services/auth-service';
import { sessionRegistry } from '../services/session-registry';
import { GameSession } from '../services/game-session';

// sessionId -> userId -> Set<WebSocket>
const sessionClients = new Map<string, Map<string, Set<WebSocket>>>();

// Track which session each WebSocket belongs to
const wsSessionMap = new WeakMap<WebSocket, string>();

// Track which user each WebSocket belongs to
const wsUserMap = new WeakMap<WebSocket, User>();

// Reference to the WebSocket server instance
let wss: WebSocketServer | null = null;

/**
 * Set the WebSocket server instance used for broadcasting.
 */
export function setWebSocketServer(server: WebSocketServer): void {
  wss = server;
}

/**
 * Get the connected clients map (exported for testing / backward compatibility).
 * Returns a flat userId -> Set<WebSocket> view across all sessions.
 */
export function getClients(): Map<string, Set<WebSocket>> {
  const flat = new Map<string, Set<WebSocket>>();
  for (const [, userMap] of sessionClients) {
    for (const [userId, sockets] of userMap) {
      if (!flat.has(userId)) {
        flat.set(userId, new Set());
      }
      for (const ws of sockets) {
        flat.get(userId)!.add(ws);
      }
    }
  }
  return flat;
}

/**
 * Get the session-scoped clients map (exported for testing).
 */
export function getSessionClients(): Map<string, Map<string, Set<WebSocket>>> {
  return sessionClients;
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
 * Serialize a VotingRound for JSON transport.
 * Converts the selections Map to a Record.
 */
function serializeRound(round: VotingRound): any {
  return {
    ...round,
    selections: Object.fromEntries(round.selections),
  };
}

/**
 * Serialize the full game session state for JSON transport.
 */
function serializeSessionState(state: GameSessionState): any {
  return {
    ...state,
    currentRound: state.currentRound ? serializeRound(state.currentRound) : null,
  };
}

/**
 * Broadcast a message to all connected clients in a specific session.
 */
function broadcastToSession(sessionId: string, event: string, data: any): void {
  const userMap = sessionClients.get(sessionId);
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
 * Send a message to a specific user within a session (all their connected sockets).
 */
function sendToUserInSession(sessionId: string, userId: string, event: string, data: any): void {
  const userMap = sessionClients.get(sessionId);
  if (!userMap) return;
  const sockets = userMap.get(userId);
  if (!sockets) return;
  const msg = createMessage(event, data);
  sockets.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  });
}

/**
 * Send an error message to a specific WebSocket connection.
 */
function sendError(ws: WebSocket, message: string, code: string): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(createMessage('error', { message, code }));
  }
}

/**
 * Check if a user is a moderator within a specific GameSession.
 */
function isModerator(session: GameSession, userId: string): boolean {
  const participants = session.getParticipants();
  const user = participants.find((p) => p.id === userId);
  return user?.role === 'moderator';
}

/**
 * Get the valid card values for a session's voting system.
 */
function getValidCards(session: GameSession): ExtendedCardValue[] {
  const systemCards = VOTING_SYSTEMS[session.config.votingSystem];
  return [...systemCards, ...SPECIAL_CARDS];
}

/**
 * Handle an incoming client event, routed to the correct GameSession.
 */
function handleEvent(ws: WebSocket, user: User, sessionId: string, event: string, data: any): void {
  const session = sessionRegistry.getSession(sessionId);
  if (!session) {
    sendError(ws, 'Session not found', 'SESSION_NOT_FOUND');
    return;
  }

  // Permission checks for specific events
  switch (event) {
    case 'story:submit':
      if (!session.hasPermission(user.id, 'issue')) {
        sendError(ws, 'You do not have permission to submit stories', 'UNAUTHORIZED');
        return;
      }
      break;
    case 'cards:reveal':
      if (!session.hasPermission(user.id, 'reveal')) {
        sendError(ws, 'You do not have permission to reveal cards', 'UNAUTHORIZED');
        return;
      }
      break;
    case 'board:clear':
    case 'history:clear':
      if (!isModerator(session, user.id)) {
        sendError(ws, 'Only moderators can perform this action', 'UNAUTHORIZED');
        return;
      }
      break;
    case 'participant:remove':
      if (!isModerator(session, user.id)) {
        sendError(ws, 'Only moderators can remove participants', 'UNAUTHORIZED');
        return;
      }
      break;
    case 'round:revote':
      if (!session.hasPermission(user.id, 'reveal')) {
        sendError(ws, 'You do not have permission to trigger a re-vote', 'UNAUTHORIZED');
        return;
      }
      break;
    case 'issue:add':
    case 'issue:remove':
    case 'issue:reorder':
    case 'issue:select':
      if (!session.hasPermission(user.id, 'issue')) {
        sendError(ws, 'You do not have permission to manage issues', 'UNAUTHORIZED');
        return;
      }
      break;
  }

  switch (event) {
    case 'story:submit':
      handleStorySubmit(ws, user, sessionId, session, data);
      break;
    case 'card:select':
      handleCardSelect(ws, user, sessionId, session, data);
      break;
    case 'cards:reveal':
      handleCardsReveal(ws, user, sessionId, session);
      break;
    case 'board:clear':
      handleBoardClear(ws, user, sessionId, session);
      break;
    case 'role:change':
      handleRoleChange(ws, user, sessionId, session, data);
      break;
    case 'history:clear':
      handleHistoryClear(ws, user, sessionId, session);
      break;
    case 'participant:remove':
      handleParticipantRemove(ws, user, sessionId, session, data);
      break;
    case 'round:revote':
      handleRoundRevote(ws, user, sessionId, session);
      break;
    case 'issue:add':
      handleIssueAdd(ws, user, sessionId, session, data);
      break;
    case 'issue:remove':
      handleIssueRemove(ws, user, sessionId, session, data);
      break;
    case 'issue:reorder':
      handleIssueReorder(ws, user, sessionId, session, data);
      break;
    case 'issue:select':
      handleIssueSelect(ws, user, sessionId, session, data);
      break;
    default:
      sendError(ws, `Unknown event: ${event}`, 'UNKNOWN_EVENT');
  }
}

/**
 * Handle story:submit event.
 */
function handleStorySubmit(ws: WebSocket, user: User, sessionId: string, session: GameSession, data: any): void {
  const { storyDescription } = data || {};
  if (!storyDescription || typeof storyDescription !== 'string' || storyDescription.trim().length === 0) {
    sendError(ws, 'Story description is required', 'EMPTY_STORY');
    return;
  }

  try {
    const round = session.startRound(storyDescription);
    broadcastToSession(sessionId, 'round:started', { round: serializeRound(round) });
  } catch (err: any) {
    sendError(ws, err.message, 'ROUND_ERROR');
  }
}

/**
 * Handle card:select event.
 */
function handleCardSelect(ws: WebSocket, user: User, sessionId: string, session: GameSession, data: any): void {
  const { cardValue } = data || {};

  const validCards = getValidCards(session);
  if (cardValue === undefined || !validCards.includes(cardValue)) {
    sendError(ws, 'Invalid card value', 'INVALID_CARD');
    return;
  }

  const currentRound = session.getCurrentRound();
  if (!currentRound || currentRound.status !== 'voting') {
    sendError(ws, 'No active voting round', 'NO_ACTIVE_ROUND');
    return;
  }

  session.selectCard(user.id, cardValue as CardValue);
  // Broadcast that a user voted (without revealing the value)
  broadcastToSession(sessionId, 'card:voted', { userId: user.id });

  // Check auto-reveal after card selection
  if (session.checkAutoReveal()) {
    const countdown = session.config.countdownAnimation;
    broadcastToSession(sessionId, 'auto:reveal-triggered', { countdown });

    // If no countdown, reveal immediately; otherwise client handles the delay
    if (!countdown) {
      try {
        const result = session.revealCards();
        broadcastToSession(sessionId, 'cards:revealed', {
          selections: Object.fromEntries(result.selections),
          metrics: result.metrics,
        });
      } catch (err: any) {
        // Round may have been revealed by another action in the meantime
        sendError(ws, err.message, 'REVEAL_ERROR');
      }
    }
  }
}

/**
 * Handle cards:reveal event.
 */
function handleCardsReveal(ws: WebSocket, user: User, sessionId: string, session: GameSession): void {
  try {
    const result = session.revealCards();
    broadcastToSession(sessionId, 'cards:revealed', {
      selections: Object.fromEntries(result.selections),
      metrics: result.metrics,
    });
  } catch (err: any) {
    sendError(ws, err.message, 'REVEAL_ERROR');
  }
}

/**
 * Handle board:clear event.
 */
function handleBoardClear(ws: WebSocket, user: User, sessionId: string, session: GameSession): void {
  try {
    const historyEntry = session.clearBoard();
    broadcastToSession(sessionId, 'board:cleared', { historyEntry });

    // Check if the cleared round's story matches an issue in the list
    const issues = session.getIssueList();
    const matchingIssue = issues.find(
      issue => issue.status === 'estimating' && issue.title === historyEntry.storyDescription
    );
    if (matchingIssue) {
      session.markIssueEstimated(matchingIssue.id, historyEntry.roundId);
      broadcastToSession(sessionId, 'issue:list-updated', { issues: session.getIssueList() });
    }
  } catch (err: any) {
    sendError(ws, err.message, 'CLEAR_ERROR');
  }
}

/**
 * Handle role:change event.
 */
function handleRoleChange(ws: WebSocket, user: User, sessionId: string, session: GameSession, data: any): void {
  const { role } = data || {};
  if (role !== 'moderator' && role !== 'participant') {
    sendError(ws, 'Invalid role. Must be "moderator" or "participant"', 'INVALID_ROLE');
    return;
  }

  // Update the user's role in the session's participants list
  const participants = session.getParticipants();
  const participant = participants.find((p) => p.id === user.id);
  if (!participant) {
    sendError(ws, 'User not found in session', 'USER_NOT_FOUND');
    return;
  }

  participant.role = role;
  broadcastToSession(sessionId, 'role:changed', { user: participant });
}

/**
 * Handle history:clear event.
 */
function handleHistoryClear(ws: WebSocket, user: User, sessionId: string, session: GameSession): void {
  session.clearHistory();
  broadcastToSession(sessionId, 'history:cleared', {});
}

/**
 * Handle participant:remove event.
 */
function handleParticipantRemove(ws: WebSocket, user: User, sessionId: string, session: GameSession, data: any): void {
  const { userId } = data || {};
  if (!userId || typeof userId !== 'string') {
    sendError(ws, 'User ID is required', 'INVALID_DATA');
    return;
  }
  if (userId === user.id) {
    sendError(ws, 'Cannot remove yourself from the session', 'INVALID_ACTION');
    return;
  }
  const participants = session.getParticipants();
  if (!participants.find(p => p.id === userId)) {
    sendError(ws, 'User not found in session', 'USER_NOT_FOUND');
    return;
  }

  // Send removal notification to target before disconnecting
  sendToUserInSession(sessionId, userId, 'participant:removed', { reason: 'Removed by moderator' });

  // Remove from game session
  session.removeParticipantByModerator(userId);

  // Close target's WebSocket connections
  const userMap = sessionClients.get(sessionId);
  if (userMap) {
    const targetSockets = userMap.get(userId);
    if (targetSockets) {
      targetSockets.forEach(targetWs => {
        targetWs.close(4010, 'Removed from session by moderator');
      });
      userMap.delete(userId);
    }
  }

  // Broadcast updated participant list
  broadcastToSession(sessionId, 'participant:left', { participants: session.getParticipants() });
}

/**
 * Handle round:revote event.
 */
function handleRoundRevote(ws: WebSocket, user: User, sessionId: string, session: GameSession): void {
  try {
    const round = session.revote();
    broadcastToSession(sessionId, 'round:started', { round: serializeRound(round) });
  } catch (err: any) {
    sendError(ws, err.message, 'REVOTE_ERROR');
  }
}

/**
 * Handle issue:add event.
 */
function handleIssueAdd(ws: WebSocket, user: User, sessionId: string, session: GameSession, data: any): void {
  const { titles } = data || {};
  if (!titles || !Array.isArray(titles) || titles.length === 0) {
    sendError(ws, 'At least one issue title is required', 'INVALID_DATA');
    return;
  }

  // Validate that all titles are non-empty strings
  const validTitles = titles.filter((t: any) => typeof t === 'string' && t.trim().length > 0);
  if (validTitles.length === 0) {
    sendError(ws, 'Issue title must not be empty', 'EMPTY_ISSUE');
    return;
  }

  try {
    session.addIssues(validTitles);
    broadcastToSession(sessionId, 'issue:list-updated', { issues: session.getIssueList() });
  } catch (err: any) {
    sendError(ws, err.message, 'ISSUE_ERROR');
  }
}

/**
 * Handle issue:remove event.
 */
function handleIssueRemove(ws: WebSocket, user: User, sessionId: string, session: GameSession, data: any): void {
  const { issueId } = data || {};
  if (!issueId || typeof issueId !== 'string') {
    sendError(ws, 'Issue ID is required', 'INVALID_DATA');
    return;
  }

  try {
    session.removeIssue(issueId);
    broadcastToSession(sessionId, 'issue:list-updated', { issues: session.getIssueList() });
  } catch (err: any) {
    sendError(ws, err.message, 'ISSUE_NOT_FOUND');
  }
}

/**
 * Handle issue:reorder event.
 */
function handleIssueReorder(ws: WebSocket, user: User, sessionId: string, session: GameSession, data: any): void {
  const { orderedIds } = data || {};
  if (!orderedIds || !Array.isArray(orderedIds)) {
    sendError(ws, 'Ordered IDs array is required', 'INVALID_DATA');
    return;
  }

  try {
    session.reorderIssues(orderedIds);
    broadcastToSession(sessionId, 'issue:list-updated', { issues: session.getIssueList() });
  } catch (err: any) {
    sendError(ws, err.message, 'INVALID_REORDER');
  }
}

/**
 * Handle issue:select event.
 */
function handleIssueSelect(ws: WebSocket, user: User, sessionId: string, session: GameSession, data: any): void {
  const { issueId } = data || {};
  if (!issueId || typeof issueId !== 'string') {
    sendError(ws, 'Issue ID is required', 'INVALID_DATA');
    return;
  }

  try {
    const round = session.selectIssueForEstimation(issueId);
    broadcastToSession(sessionId, 'round:started', { round: serializeRound(round) });
    broadcastToSession(sessionId, 'issue:list-updated', { issues: session.getIssueList() });
  } catch (err: any) {
    sendError(ws, err.message, 'ISSUE_NOT_FOUND');
  }
}

/**
 * Broadcast a session:config-updated event to all participants in a session.
 * Called externally (e.g., from REST route) when config changes.
 */
export function broadcastConfigUpdate(sessionId: string, config: any): void {
  broadcastToSession(sessionId, 'session:config-updated', { config });
}

/**
 * Main WebSocket connection handler.
 * Authenticates the connection via token query parameter,
 * validates the session, registers the participant, and routes incoming messages.
 */
export function handleWebSocket(ws: WebSocket, request: IncomingMessage): void {
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

  if (!sessionRegistry.hasSession(sessionId)) {
    ws.close(4004, 'Session not found');
    return;
  }

  const session = sessionRegistry.getSession(sessionId)!;

  // If this user is the session owner, ensure they are a moderator
  let participant: User = user;
  if (user.id === session.ownerId) {
    participant = { ...user, role: 'moderator' };
  }

  // Check display name uniqueness (skip for session owner and for same user reconnecting/multi-tab)
  const existingParticipant = session.getParticipants().find(p => p.id === participant.id);
  if (!existingParticipant && participant.id !== session.ownerId && session.hasDisplayName(participant.displayName)) {
    ws.close(4009, 'Display name already in use in this session');
    return;
  }

  // Track ws → session and ws → user
  wsSessionMap.set(ws, sessionId);
  wsUserMap.set(ws, participant);

  // Register the client connection in session-scoped map
  if (!sessionClients.has(sessionId)) {
    sessionClients.set(sessionId, new Map());
  }
  const userMap = sessionClients.get(sessionId)!;
  if (!userMap.has(participant.id)) {
    userMap.set(participant.id, new Set());
  }
  userMap.get(participant.id)!.add(ws);

  // Add user as participant in the GameSession (handles reconnect — replaces existing entry)
  session.addParticipant(participant);

  // Send full session state to the newly connected client
  const sessionState = session.getSessionState();
  ws.send(createMessage('session:state', { state: serializeSessionState(sessionState) }));

  // Broadcast updated participant list to all clients in this session
  broadcastToSession(sessionId, 'participant:joined', { participants: session.getParticipants() });

  // Listen for incoming messages
  ws.on('message', (rawData: WebSocket.RawData) => {
    try {
      const message: WebSocketMessage = JSON.parse(rawData.toString());

      if (!message.event || typeof message.event !== 'string') {
        sendError(ws, 'Invalid message format: missing event', 'INVALID_MESSAGE');
        return;
      }

      handleEvent(ws, participant, sessionId, message.event, message.data || {});
    } catch {
      sendError(ws, 'Invalid message format: malformed JSON', 'INVALID_MESSAGE');
    }
  });

  // Handle disconnect
  ws.on('close', () => {
    const sid = wsSessionMap.get(ws) || sessionId;
    const uMap = sessionClients.get(sid);
    if (uMap) {
      const userSockets = uMap.get(participant.id);
      if (userSockets) {
        userSockets.delete(ws);
        // Only remove participant if all connections for this user in this session are closed
        if (userSockets.size === 0) {
          uMap.delete(participant.id);

          const gameSession = sessionRegistry.getSession(sid);
          if (gameSession) {
            gameSession.removeParticipant(participant.id);
            broadcastToSession(sid, 'participant:left', { participants: gameSession.getParticipants() });
          }

          // Clean up empty session client map
          if (uMap.size === 0) {
            sessionClients.delete(sid);
          }
        }
      }
    }
  });
}

/**
 * Reset handler state. Used for test isolation.
 */
export function _reset(): void {
  sessionClients.clear();
  wss = null;
}
