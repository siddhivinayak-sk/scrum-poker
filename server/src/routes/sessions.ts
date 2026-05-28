import { Router, Request, Response } from 'express';
import { validateToken } from '../services/auth-service';
import { sessionRegistry } from '../services/session-registry';
import { DEFAULT_SESSION_CONFIG } from '../../../shared/types';
import { broadcastConfigUpdate } from '../websocket/handler';

export const sessionsRouter = Router();

/**
 * Extract and validate the auth token from the Authorization header.
 * Returns the authenticated user or null if invalid/missing.
 */
function authenticateRequest(req: Request) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  const token = authHeader.slice(7);
  return validateToken(token);
}

/**
 * POST /api/sessions
 * Create a new game session.
 * Body: { config?: SessionConfiguration }
 * Returns: { sessionId, config, createdAt } with status 201
 */
sessionsRouter.post('/', (req: Request, res: Response) => {
  const user = authenticateRequest(req);
  if (!user) {
    res.status(401).json({ error: 'UNAUTHORIZED' });
    return;
  }

  const config = req.body.config ?? DEFAULT_SESSION_CONFIG;
  const sessionInfo = sessionRegistry.createSession(user.id, config);

  res.status(201).json({
    sessionId: sessionInfo.sessionId,
    config: sessionInfo.config,
    createdAt: sessionInfo.createdAt,
  });
});

/**
 * GET /api/sessions/mine
 * Get sessions owned by the authenticated user.
 * Returns: { sessions: SessionSummary[] } sorted by lastActivityAt descending
 */
sessionsRouter.get('/mine', (req: Request, res: Response) => {
  const user = authenticateRequest(req);
  if (!user) {
    res.status(401).json({ error: 'UNAUTHORIZED' });
    return;
  }

  const sessions = sessionRegistry.getSessionsByOwner(user.id);

  const summaries = sessions.map(session => ({
    sessionId: session.sessionId,
    createdAt: session.createdAt,
    lastActivityAt: session.lastActivityAt,
    completedRounds: session.getHistory().length,
    participantCount: session.getParticipantCount(),
    config: session.config,
  }));

  // Sort by lastActivityAt descending (most recent first)
  summaries.sort((a, b) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime());

  res.status(200).json({ sessions: summaries });
});

/**
 * GET /api/sessions/:sessionId/exists
 * Lightweight existence check — no auth required.
 * Returns: { exists: boolean } with status 200
 *
 * NOTE: This route is registered before /:sessionId to prevent
 * "exists" from being captured as a sessionId parameter.
 */
sessionsRouter.get('/:sessionId/exists', (req: Request, res: Response) => {
  const sessionId = req.params.sessionId as string;
  const exists = sessionRegistry.hasSession(sessionId);
  res.status(200).json({ exists });
});

/**
 * GET /api/sessions/:sessionId
 * Get session info.
 * Returns: { sessionId, config, participantCount, createdAt, ownerId } with status 200
 */
sessionsRouter.get('/:sessionId', (req: Request, res: Response) => {
  const user = authenticateRequest(req);
  if (!user) {
    res.status(401).json({ error: 'UNAUTHORIZED' });
    return;
  }

  const sessionId = req.params.sessionId as string;
  const session = sessionRegistry.getSession(sessionId);
  if (!session) {
    res.status(404).json({ error: 'SESSION_NOT_FOUND' });
    return;
  }

  res.status(200).json({
    sessionId: session.sessionId,
    config: session.config,
    participantCount: session.getParticipantCount(),
    createdAt: session.createdAt,
    ownerId: session.ownerId,
  });
});

/**
 * PUT /api/sessions/:sessionId/config
 * Update session configuration.
 * Body: { config: Partial<SessionConfiguration> }
 * Returns: { config: SessionConfiguration } with status 200
 */
sessionsRouter.put('/:sessionId/config', (req: Request, res: Response) => {
  const user = authenticateRequest(req);
  if (!user) {
    res.status(401).json({ error: 'UNAUTHORIZED' });
    return;
  }

  const sessionId = req.params.sessionId as string;
  const session = sessionRegistry.getSession(sessionId);
  if (!session) {
    res.status(404).json({ error: 'SESSION_NOT_FOUND' });
    return;
  }

  // Check authorization: must be session owner or a moderator participant
  const isOwner = session.ownerId === user.id;
  const participant = session.getParticipants().find((p) => p.id === user.id);
  const isModerator = participant?.role === 'moderator';

  if (!isOwner && !isModerator) {
    res.status(403).json({ error: 'FORBIDDEN' });
    return;
  }

  const updatedConfig = session.updateConfig(req.body.config ?? {});

  // Broadcast config update to all participants in the session
  broadcastConfigUpdate(sessionId, updatedConfig);

  res.status(200).json({ config: updatedConfig });
});

/**
 * DELETE /api/sessions/:sessionId
 * End (delete) a session. Only the session owner (moderator) can do this.
 * Returns: { success: true } with status 200
 */
sessionsRouter.delete('/:sessionId', (req: Request, res: Response) => {
  const user = authenticateRequest(req);
  if (!user) {
    res.status(401).json({ error: 'UNAUTHORIZED' });
    return;
  }

  const sessionId = req.params.sessionId as string;
  const session = sessionRegistry.getSession(sessionId);
  if (!session) {
    res.status(404).json({ error: 'SESSION_NOT_FOUND' });
    return;
  }

  // Only the session owner can end the session
  if (session.ownerId !== user.id) {
    res.status(403).json({ error: 'FORBIDDEN', message: 'Only the session owner can end the session' });
    return;
  }

  sessionRegistry.deleteSession(sessionId);
  res.status(200).json({ success: true });
});
