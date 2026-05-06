import { login, validateToken, logout, getActiveTokens, _resetStore, AuthResult } from '../auth-service';

describe('Auth Service', () => {
  beforeEach(() => {
    _resetStore();
  });

  // --- Login with valid username ---
  describe('login with valid username', () => {
    it('returns a token and user with role participant', () => {
      const result: AuthResult = login('alice', false);

      expect(result.token).toBeDefined();
      expect(typeof result.token).toBe('string');
      expect(result.user.displayName).toBe('alice');
      expect(result.user.role).toBe('participant');
      expect(result.user.isAnonymous).toBe(false);
      expect(result.user.id).toBeDefined();
    });

    it('trims whitespace from the username', () => {
      const result = login('  bob  ', false);
      expect(result.user.displayName).toBe('bob');
    });
  });

  // --- Login with empty / whitespace-only username ---
  describe('login with empty username', () => {
    it('throws USERNAME_REQUIRED for empty string', () => {
      expect(() => login('', false)).toThrow('USERNAME_REQUIRED');
    });

    it('throws USERNAME_REQUIRED for whitespace-only string', () => {
      expect(() => login('   ', false)).toThrow('USERNAME_REQUIRED');
    });
  });

  // --- Anonymous login ---
  describe('anonymous login', () => {
    it('returns user with isAnonymous true for valid display name', () => {
      const result = login('Guest42', true);

      expect(result.user.isAnonymous).toBe(true);
      expect(result.user.displayName).toBe('Guest42');
      expect(result.user.role).toBe('participant');
      expect(result.token).toBeDefined();
    });

    it('throws DISPLAY_NAME_REQUIRED for empty display name', () => {
      expect(() => login('', true)).toThrow('DISPLAY_NAME_REQUIRED');
    });

    it('throws DISPLAY_NAME_REQUIRED for whitespace-only display name', () => {
      expect(() => login('   ', true)).toThrow('DISPLAY_NAME_REQUIRED');
    });
  });

  // --- Token validation ---
  describe('validateToken', () => {
    it('returns user for a valid token', () => {
      const { token, user } = login('charlie', false);
      const validated = validateToken(token);

      expect(validated).not.toBeNull();
      expect(validated!.id).toBe(user.id);
      expect(validated!.displayName).toBe('charlie');
      expect(validated!.role).toBe('participant');
      expect(validated!.isAnonymous).toBe(false);
    });

    it('returns null for an invalid token', () => {
      expect(validateToken('not-a-real-token')).toBeNull();
    });

    it('returns null for a malformed JWT', () => {
      expect(validateToken('abc.def.ghi')).toBeNull();
    });

    it('returns null for an empty string', () => {
      expect(validateToken('')).toBeNull();
    });
  });

  // --- Logout invalidation ---
  describe('logout', () => {
    it('invalidates the token so validateToken returns null', () => {
      const { token } = login('dave', false);
      expect(validateToken(token)).not.toBeNull();

      logout(token);
      expect(validateToken(token)).toBeNull();
    });

    it('does not throw for an invalid token', () => {
      expect(() => logout('garbage-token')).not.toThrow();
    });

    it('only invalidates the logged-out token, not other tokens for the same user', () => {
      // Two separate logins create different user IDs, so this tests
      // that logout of one token doesn't affect unrelated tokens
      const result1 = login('eve', false);
      const result2 = login('eve', false);

      logout(result1.token);

      expect(validateToken(result1.token)).toBeNull();
      expect(validateToken(result2.token)).not.toBeNull();
    });
  });

  // --- getActiveTokens (cross-tab support) ---
  describe('getActiveTokens', () => {
    it('returns all active tokens for a user', () => {
      const result = login('frank', false);
      const tokens = getActiveTokens(result.user.id);

      expect(tokens).toHaveLength(1);
      expect(tokens).toContain(result.token);
    });

    it('returns empty array for unknown userId', () => {
      expect(getActiveTokens('non-existent-user-id')).toEqual([]);
    });

    it('removes token from active list after logout', () => {
      const result = login('grace', false);
      logout(result.token);

      expect(getActiveTokens(result.user.id)).toEqual([]);
    });
  });

  // --- Multiple logins for same username ---
  describe('multiple logins for same username', () => {
    it('creates separate user IDs for each login', () => {
      const result1 = login('heidi', false);
      const result2 = login('heidi', false);

      expect(result1.user.id).not.toBe(result2.user.id);
      expect(result1.token).not.toBe(result2.token);
    });

    it('each session is independently valid', () => {
      const result1 = login('ivan', false);
      const result2 = login('ivan', false);

      expect(validateToken(result1.token)).not.toBeNull();
      expect(validateToken(result2.token)).not.toBeNull();
    });
  });
});
