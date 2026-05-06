import { v4 as uuidv4 } from 'uuid';
import jwt from 'jsonwebtoken';
import { User } from '../../../shared/types';

const JWT_SECRET = process.env.JWT_SECRET || 'scrum-poker-secret-key';
const TOKEN_EXPIRY = '24h';

export interface AuthResult {
  token: string;
  user: User;
}

interface TokenPayload {
  userId: string;
  displayName: string;
  role: 'moderator' | 'participant';
  isAnonymous: boolean;
}

// In-memory store: userId -> Set of active tokens
const activeTokens = new Map<string, Set<string>>();

export function login(username: string, isAnonymous: boolean): AuthResult {
  const trimmed = username.trim();
  if (!trimmed) {
    throw new Error(isAnonymous ? 'DISPLAY_NAME_REQUIRED' : 'USERNAME_REQUIRED');
  }

  const userId = uuidv4();
  const user: User = {
    id: userId,
    displayName: trimmed,
    role: 'participant',
    isAnonymous,
  };

  const payload: TokenPayload = {
    userId: user.id,
    displayName: user.displayName,
    role: user.role,
    isAnonymous: user.isAnonymous,
  };

  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: TOKEN_EXPIRY });

  // Track active token
  if (!activeTokens.has(userId)) {
    activeTokens.set(userId, new Set());
  }
  activeTokens.get(userId)!.add(token);

  return { token, user };
}

export function validateToken(token: string): User | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as TokenPayload & { iat: number; exp: number };

    // Check if token is still in active sessions
    const userTokens = activeTokens.get(decoded.userId);
    if (!userTokens || !userTokens.has(token)) {
      return null;
    }

    return {
      id: decoded.userId,
      displayName: decoded.displayName,
      role: decoded.role,
      isAnonymous: decoded.isAnonymous,
    };
  } catch {
    return null;
  }
}

export function logout(token: string): void {
  try {
    const decoded = jwt.verify(token, JWT_SECRET, { ignoreExpiration: true }) as TokenPayload;
    const userTokens = activeTokens.get(decoded.userId);
    if (userTokens) {
      userTokens.delete(token);
      if (userTokens.size === 0) {
        activeTokens.delete(decoded.userId);
      }
    }
  } catch {
    // Token is invalid or malformed — nothing to invalidate
  }
}

export function getActiveTokens(userId: string): string[] {
  const userTokens = activeTokens.get(userId);
  return userTokens ? Array.from(userTokens) : [];
}

// Exported for testing — allows resetting state between tests
export function _resetStore(): void {
  activeTokens.clear();
}
