import { Router, Request, Response } from 'express';
import { validateToken } from '../services/auth-service';
import { retroSessionRegistry } from '../services/retro-session-registry';
import { RetroConfiguration } from '../../../shared/types';

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
