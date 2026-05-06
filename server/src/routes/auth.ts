import { Router, Request, Response } from 'express';
import { login, validateToken, logout } from '../services/auth-service';

export const authRouter = Router();

/**
 * POST /api/auth/login
 * Authenticate user with username and anonymous flag.
 * Body: { username: string, isAnonymous: boolean }
 * Returns: { token: string, user: User }
 */
authRouter.post('/login', (req: Request, res: Response) => {
  const { username, isAnonymous } = req.body;

  if (!username || typeof username !== 'string') {
    res.status(400).json({
      error: isAnonymous ? 'DISPLAY_NAME_REQUIRED' : 'USERNAME_REQUIRED',
    });
    return;
  }

  try {
    const result = login(username, !!isAnonymous);
    res.status(200).json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * GET /api/auth/validate
 * Validate an existing session token from the Authorization header.
 * Header: Authorization: Bearer <token>
 * Returns: { user: User }
 */
authRouter.get('/validate', (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'TOKEN_REQUIRED' });
    return;
  }

  const token = authHeader.slice(7);
  const user = validateToken(token);

  if (!user) {
    res.status(401).json({ error: 'INVALID_TOKEN' });
    return;
  }

  res.status(200).json({ user });
});

/**
 * POST /api/auth/logout
 * Invalidate the session token from the Authorization header.
 * Header: Authorization: Bearer <token>
 * Returns: { success: boolean }
 */
authRouter.post('/logout', (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'TOKEN_REQUIRED' });
    return;
  }

  const token = authHeader.slice(7);
  logout(token);

  res.status(200).json({ success: true });
});
