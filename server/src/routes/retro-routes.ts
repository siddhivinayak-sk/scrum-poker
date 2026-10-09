import { Router, Request, Response } from 'express';
import { validateToken } from '../services/auth-service';
import { retroSessionRegistry } from '../services/retro-session-registry';
import { RetroSession } from '../services/retro-session';
import { endRetroSession } from '../websocket/retro-handler';
import {
  RetroConfiguration,
  RetroSessionSummary,
  RetroSessionsResponse,
} from '../../../shared/types';

export const retroRouter = Router();

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
 * Validate the retro board configuration from the request body.
 * Returns an error message string if invalid, or null if valid.
 */
function validateConfig(config: any): string | null {
  if (!config || typeof config !== 'object') {
    return 'Configuration is required';
  }

  if (!config.boardName || typeof config.boardName !== 'string' || config.boardName.trim() === '') {
    return 'Board name is required and must be a non-empty string';
  }

  if (
    config.maxVotesPerUser === undefined ||
    typeof config.maxVotesPerUser !== 'number' ||
    !Number.isInteger(config.maxVotesPerUser) ||
    config.maxVotesPerUser <= 0
  ) {
    return 'Max votes per user must be a positive integer';
  }

  if (!config.templateId || typeof config.templateId !== 'string') {
    return 'Template ID is required';
  }

  return null;
}

/**
 * Compare two summaries by `lastActivityAt` descending, ties broken by
 * `createdAt` descending. Both fields are ISO 8601 UTC strings, so a plain
 * lexicographic comparison is chronological (R8.4).
 */
function compareRetroSummaries(a: RetroSessionSummary, b: RetroSessionSummary): number {
  if (a.lastActivityAt !== b.lastActivityAt) {
    return a.lastActivityAt < b.lastActivityAt ? 1 : -1;
  }
  if (a.createdAt !== b.createdAt) {
    return a.createdAt < b.createdAt ? 1 : -1;
  }
  return 0;
}

/**
 * Map retro sessions to `RetroSessionSummary` entries, most recently active
 * first. Purely reads the given sessions — no session is mutated and the input
 * array is left untouched (R8.8). Only retro modules are involved, so a
 * poker `GameSession` can never appear here (R8.7, R13.9).
 */
export function summariseRetroSessions(sessions: RetroSession[]): RetroSessionSummary[] {
  return sessions
    .map((session) => ({
      sessionId: session.sessionId,
      boardName: session.config.boardName,
      createdAt: session.createdAt,
      lastActivityAt: session.lastActivityAt,
      participantCount: session.getParticipantCount(),
      cardCount: session.getCardCount(),
      isCompleted: session.isBoardCompleted(),
    }))
    .sort(compareRetroSummaries);
}

/**
 * POST /sessions
 * Create a new retro session.
 * Body: { config: RetroConfiguration }
 * Returns: { sessionId, config } with status 201
 *
 * Requirements: 2.4, 5.1
 */
retroRouter.post('/sessions', (req: Request, res: Response) => {
  const user = authenticateRequest(req);
  if (!user) {
    res.status(401).json({ error: 'UNAUTHORIZED' });
    return;
  }

  const config = req.body.config as RetroConfiguration;
  const validationError = validateConfig(config);
  if (validationError) {
    res.status(400).json({ error: 'INVALID_CONFIG', message: validationError });
    return;
  }

  const sessionInfo = retroSessionRegistry.createSession(user.id, config);

  res.status(201).json({
    sessionId: sessionInfo.sessionId,
    config: sessionInfo.config,
  });
});

/**
 * GET /sessions/mine
 * List every retro session owned by the authenticated user.
 * Returns: { sessions: RetroSessionSummary[] } with status 200
 *
 * NOTE: This route is registered before GET /sessions/:sessionId so that
 * `mine` is never captured as a session id (R8.1).
 *
 * A missing, unverifiable or expired token yields 401 UNAUTHORIZED (R8.5).
 * The handler only reads the retro registry, so two consecutive calls return
 * the same entries and no session state changes (R8.8). It touches retro
 * modules only, so a poker session can never appear (R8.7, R13.9).
 *
 * Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.7, 8.8, 13.5, 13.9
 */
retroRouter.get('/sessions/mine', (req: Request, res: Response) => {
  const user = authenticateRequest(req);
  if (!user) {
    res.status(401).json({ error: 'UNAUTHORIZED' });
    return;
  }

  const sessions = summariseRetroSessions(retroSessionRegistry.getSessionsByOwner(user.id));

  const body: RetroSessionsResponse = { sessions };
  res.status(200).json(body);
});

/**
 * GET /sessions/:sessionId/exists
 * Lightweight existence check — no auth required.
 * Returns: { exists: boolean } with status 200
 *
 * NOTE: This route is registered before /:sessionId to prevent
 * "exists" from being captured as a sub-path conflict.
 *
 * Requirements: 5.1
 */
retroRouter.get('/sessions/:sessionId/exists', (req: Request, res: Response) => {
  const sessionId = req.params.sessionId as string;
  const exists = retroSessionRegistry.hasSession(sessionId);
  res.status(200).json({ exists });
});

/**
 * POST /sessions/:sessionId/verify-password
 * Verify the board password for a password-protected session.
 * Body: { password: string }
 * Returns: { valid: true } on success, 403 with INVALID_PASSWORD on failure
 *
 * Requirements: 5.4, 16.1, 16.2
 */
retroRouter.post('/sessions/:sessionId/verify-password', (req: Request, res: Response) => {
  const sessionId = req.params.sessionId as string;
  const session = retroSessionRegistry.getSession(sessionId);

  if (!session) {
    res.status(404).json({ error: 'SESSION_NOT_FOUND' });
    return;
  }

  // If session has no password, access is always valid
  if (!session.config.password) {
    res.status(200).json({ valid: true });
    return;
  }

  const { password } = req.body;
  if (!password || typeof password !== 'string') {
    res.status(403).json({ error: 'INVALID_PASSWORD', message: 'Password is required' });
    return;
  }

  if (password === session.config.password) {
    res.status(200).json({ valid: true });
  } else {
    res.status(403).json({ error: 'INVALID_PASSWORD', message: 'Incorrect password' });
  }
});

/**
 * GET /sessions/:sessionId/export
 * Export the board as CSV. Moderator (owner) only.
 * Returns: CSV text with content-type text/csv
 *
 * Requirements: 13.1, 13.2
 */
retroRouter.get('/sessions/:sessionId/export', (req: Request, res: Response) => {
  const user = authenticateRequest(req);
  if (!user) {
    res.status(401).json({ error: 'UNAUTHORIZED' });
    return;
  }

  const sessionId = req.params.sessionId as string;
  const session = retroSessionRegistry.getSession(sessionId);

  if (!session) {
    res.status(404).json({ error: 'SESSION_NOT_FOUND' });
    return;
  }

  // Only the session owner (moderator) can export
  if (session.ownerId !== user.id) {
    res.status(403).json({ error: 'FORBIDDEN', message: 'Only the moderator can export' });
    return;
  }

  const csv = session.exportCSV();
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="retrospective-export.csv"');
  res.status(200).send(csv);
});

/**
 * POST /sessions/:sessionId/import
 * Import cards from CSV. Moderator (owner) only.
 * Body: { csvData: string }
 * Returns: 200 on success, 400 with INVALID_CSV on parse failure
 *
 * Requirements: 14.1, 14.2, 14.3
 */
retroRouter.post('/sessions/:sessionId/import', (req: Request, res: Response) => {
  const user = authenticateRequest(req);
  if (!user) {
    res.status(401).json({ error: 'UNAUTHORIZED' });
    return;
  }

  const sessionId = req.params.sessionId as string;
  const session = retroSessionRegistry.getSession(sessionId);

  if (!session) {
    res.status(404).json({ error: 'SESSION_NOT_FOUND' });
    return;
  }

  // Only the session owner (moderator) can import
  if (session.ownerId !== user.id) {
    res.status(403).json({ error: 'FORBIDDEN', message: 'Only the moderator can import' });
    return;
  }

  const { csvData } = req.body;
  if (!csvData || typeof csvData !== 'string') {
    res.status(400).json({ error: 'INVALID_CSV', message: 'CSV data is required' });
    return;
  }

  try {
    session.importCSV(csvData);
    res.status(200).json({ success: true });
  } catch (error: any) {
    res.status(400).json({ error: 'INVALID_CSV', message: error.message });
  }
});

/**
 * DELETE /sessions/:sessionId
 * End a retro session. Moderator (owner) only.
 * Returns: { success: true } with status 200
 *
 * Checks run in a fixed order so a caller can never learn anything about a
 * session it may not touch:
 *   1. 401 UNAUTHORIZED for a missing, unverifiable or expired token — nothing
 *      is removed and no session changes, regardless of whether the registry
 *      holds the requested id (R9.9).
 *   2. 404 SESSION_NOT_FOUND when the registry does not hold the id; every
 *      other session is left as it was (R9.11).
 *   3. 403 FORBIDDEN when the authenticated user is not the owner; the
 *      session, its cards and its votes stay unchanged (R9.10).
 *   4. Otherwise the session is removed from the registry and
 *      `endRetroSession` broadcasts `retro:session:ended` to every connected
 *      participant — the moderator included — before closing their sockets
 *      (R9.7, R9.8).
 *
 * Only retro modules are imported here, so no poker `GameSession` is reachable
 * from this handler (R9.15, R13.9).
 *
 * Requirements: 9.7, 9.8, 9.9, 9.10, 9.11, 9.15, 13.5, 13.9
 */
retroRouter.delete('/sessions/:sessionId', (req: Request, res: Response) => {
  const user = authenticateRequest(req);
  if (!user) {
    res.status(401).json({ error: 'UNAUTHORIZED' });
    return;
  }

  const sessionId = req.params.sessionId as string;
  const session = retroSessionRegistry.getSession(sessionId);

  if (!session) {
    res.status(404).json({ error: 'SESSION_NOT_FOUND' });
    return;
  }

  // Only the session owner (moderator) can end the session
  if (session.ownerId !== user.id) {
    res.status(403).json({ error: 'FORBIDDEN', message: 'Only the moderator can end the session' });
    return;
  }

  retroSessionRegistry.removeSession(sessionId);
  endRetroSession(sessionId);

  res.status(200).json({ success: true });
});

/**
 * GET /sessions/:sessionId
 * Get session info. Requires auth.
 * Returns session state based on user's visibility permissions.
 *
 * Requirements: 2.4
 */
retroRouter.get('/sessions/:sessionId', (req: Request, res: Response) => {
  const user = authenticateRequest(req);
  if (!user) {
    res.status(401).json({ error: 'UNAUTHORIZED' });
    return;
  }

  const sessionId = req.params.sessionId as string;
  const session = retroSessionRegistry.getSession(sessionId);

  if (!session) {
    res.status(404).json({ error: 'SESSION_NOT_FOUND' });
    return;
  }

  const state = session.getVisibleState(user.id);
  res.status(200).json(state);
});
