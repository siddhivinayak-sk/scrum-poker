import { Request, Response } from 'express';
import fc from 'fast-check';
import { retroRouter } from '../retro-routes';
import { retroSessionRegistry } from '../../services/retro-session-registry';
import { _resetStore, login } from '../../services/auth-service';
import { RetroConfiguration } from '../../../../shared/types';

/**
 * Since supertest has a `mime.getType` compatibility issue in this project,
 * we test route handlers directly by invoking the Express router with
 * mock Request/Response objects.
 */

/** Helper: login a user and return their token and user info */
function loginUser(name: string) {
  return login(name, false);
}

/** Helper: create a valid retro configuration */
function validConfig(overrides: Partial<RetroConfiguration> = {}): RetroConfiguration {
  return {
    boardName: 'Test Board',
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
    ...overrides,
  };
}

/** Helper: create a mock Express Request */
function mockRequest(options: {
  method?: string;
  path?: string;
  params?: Record<string, string>;
  body?: any;
  headers?: Record<string, string>;
}): Partial<Request> {
  return {
    method: options.method || 'GET',
    path: options.path || '/',
    params: (options.params || {}) as any,
    body: options.body || {},
    headers: options.headers || {},
    get: function (name: string) {
      const lower = name.toLowerCase();
      return (options.headers || {})[lower] || (options.headers || {})[name] || undefined;
    } as any,
  };
}

/** Helper: create a mock Express Response with chainable methods */
function mockResponse(): Response & { _status: number; _json: any; _headers: Record<string, string>; _body: string } {
  const res: any = {
    _status: 200,
    _json: null,
    _headers: {},
    _body: '',
  };
  res.status = jest.fn((code: number) => {
    res._status = code;
    return res;
  });
  res.json = jest.fn((data: any) => {
    res._json = data;
    return res;
  });
  res.send = jest.fn((data: any) => {
    res._body = data;
    return res;
  });
  res.setHeader = jest.fn((name: string, value: string) => {
    res._headers[name.toLowerCase()] = value;
    return res;
  });
  return res;
}

/**
 * Helper: invoke a route handler on the retroRouter by simulating
 * Express routing. We find the matching route layer and call its handler.
 */
function findRouteHandler(method: string, path: string): Function | null {
  const stack = (retroRouter as any).stack;
  for (const layer of stack) {
    if (layer.route) {
      const route = layer.route;
      const routeMethod = Object.keys(route.methods)[0];
      if (routeMethod === method.toLowerCase() && matchPath(layer.regexp, layer.keys, path)) {
        return { handler: route.stack[0].handle, keys: layer.keys, regexp: layer.regexp } as any;
      }
    }
  }
  return null;
}

function matchPath(regexp: RegExp, keys: any[], path: string): boolean {
  return regexp.test(path);
}

function extractParams(regexp: RegExp, keys: any[], path: string): Record<string, string> {
  const match = regexp.exec(path);
  if (!match) return {};
  const params: Record<string, string> = {};
  keys.forEach((key: any, index: number) => {
    params[key.name] = match[index + 1];
  });
  return params;
}

/**
 * Helper: invoke a route on the retroRouter.
 * Simulates Express routing by matching the path against registered routes.
 */
async function invokeRoute(
  method: string,
  path: string,
  options: { body?: any; headers?: Record<string, string> } = {}
): Promise<{ status: number; json: any; headers: Record<string, string>; body: string }> {
  const stack = (retroRouter as any).stack;

  for (const layer of stack) {
    if (layer.route) {
      const route = layer.route;
      const routeMethod = Object.keys(route.methods)[0];
      if (routeMethod !== method.toLowerCase()) continue;

      const match = layer.regexp.exec(path);
      if (!match) continue;

      // Extract params
      const params: Record<string, string> = {};
      layer.keys.forEach((key: any, index: number) => {
        params[key.name] = match[index + 1];
      });

      const req = mockRequest({
        method: method.toUpperCase(),
        path,
        params,
        body: options.body || {},
        headers: options.headers || {},
      });

      const res = mockResponse();
      const handler = route.stack[0].handle;
      
      // Call the handler
      const result = handler(req, res);
      if (result && typeof result.then === 'function') {
        await result;
      }

      return {
        status: res._status,
        json: res._json,
        headers: res._headers,
        body: res._body,
      };
    }
  }

  throw new Error(`No route found for ${method} ${path}`);
}

beforeEach(() => {
  _resetStore();
  retroSessionRegistry._reset();
});

// ---------------------------------------------------------------------------
// POST /sessions — Create a new retro session
// ---------------------------------------------------------------------------
describe('POST /api/retro/sessions', () => {
  it('should create a session with valid config and return 201', async () => {
    const { token } = loginUser('alice');

    const result = await invokeRoute('POST', '/sessions', {
      body: { config: validConfig() },
      headers: { authorization: `Bearer ${token}` },
    });

    expect(result.status).toBe(201);
    expect(result.json).toHaveProperty('sessionId');
    expect(result.json).toHaveProperty('config');
    expect(result.json.config.boardName).toBe('Test Board');
  });

  it('should return 400 when boardName is missing', async () => {
    const { token } = loginUser('alice');

    const result = await invokeRoute('POST', '/sessions', {
      body: { config: { ...validConfig(), boardName: '' } },
      headers: { authorization: `Bearer ${token}` },
    });

    expect(result.status).toBe(400);
    expect(result.json.error).toBe('INVALID_CONFIG');
  });

  it('should return 400 when maxVotesPerUser is invalid (zero)', async () => {
    const { token } = loginUser('alice');

    const result = await invokeRoute('POST', '/sessions', {
      body: { config: { ...validConfig(), maxVotesPerUser: 0 } },
      headers: { authorization: `Bearer ${token}` },
    });

    expect(result.status).toBe(400);
    expect(result.json.error).toBe('INVALID_CONFIG');
  });

  it('should return 400 when maxVotesPerUser is negative', async () => {
    const { token } = loginUser('alice');

    const result = await invokeRoute('POST', '/sessions', {
      body: { config: { ...validConfig(), maxVotesPerUser: -3 } },
      headers: { authorization: `Bearer ${token}` },
    });

    expect(result.status).toBe(400);
    expect(result.json.error).toBe('INVALID_CONFIG');
  });

  it('should return 400 when maxVotesPerUser is a decimal', async () => {
    const { token } = loginUser('alice');

    const result = await invokeRoute('POST', '/sessions', {
      body: { config: { ...validConfig(), maxVotesPerUser: 3.5 } },
      headers: { authorization: `Bearer ${token}` },
    });

    expect(result.status).toBe(400);
    expect(result.json.error).toBe('INVALID_CONFIG');
  });

  it('should return 401 when no auth token is provided', async () => {
    const result = await invokeRoute('POST', '/sessions', {
      body: { config: validConfig() },
      headers: {},
    });

    expect(result.status).toBe(401);
    expect(result.json.error).toBe('UNAUTHORIZED');
  });

  it('should return 401 when auth token is invalid', async () => {
    const result = await invokeRoute('POST', '/sessions', {
      body: { config: validConfig() },
      headers: { authorization: 'Bearer invalid-token' },
    });

    expect(result.status).toBe(401);
    expect(result.json.error).toBe('UNAUTHORIZED');
  });
});

// ---------------------------------------------------------------------------
// GET /sessions/:sessionId/exists — Check session existence
// ---------------------------------------------------------------------------
describe('GET /api/retro/sessions/:sessionId/exists', () => {
  it('should return exists: true for an existing session', async () => {
    const { token, user } = loginUser('alice');

    // Create a session directly via registry
    const sessionInfo = retroSessionRegistry.createSession(user.id, validConfig());

    const result = await invokeRoute('GET', `/sessions/${sessionInfo.sessionId}/exists`);

    expect(result.status).toBe(200);
    expect(result.json.exists).toBe(true);
  });

  it('should return exists: false for a non-existing session', async () => {
    const result = await invokeRoute('GET', '/sessions/nonexist/exists');

    expect(result.status).toBe(200);
    expect(result.json.exists).toBe(false);
  });

  it('should not require authentication', async () => {
    const result = await invokeRoute('GET', '/sessions/anysession/exists', {
      headers: {},
    });

    expect(result.status).toBe(200);
    expect(result.json).toHaveProperty('exists');
  });
});

// ---------------------------------------------------------------------------
// POST /sessions/:sessionId/verify-password — Password verification
// ---------------------------------------------------------------------------
describe('POST /api/retro/sessions/:sessionId/verify-password', () => {
  it('should return valid: true when correct password is provided', async () => {
    const { user } = loginUser('alice');

    const sessionInfo = retroSessionRegistry.createSession(user.id, validConfig({ password: 'secret123' }));

    const result = await invokeRoute('POST', `/sessions/${sessionInfo.sessionId}/verify-password`, {
      body: { password: 'secret123' },
    });

    expect(result.status).toBe(200);
    expect(result.json.valid).toBe(true);
  });

  it('should return 403 when incorrect password is provided', async () => {
    const { user } = loginUser('alice');

    const sessionInfo = retroSessionRegistry.createSession(user.id, validConfig({ password: 'secret123' }));

    const result = await invokeRoute('POST', `/sessions/${sessionInfo.sessionId}/verify-password`, {
      body: { password: 'wrongpassword' },
    });

    expect(result.status).toBe(403);
    expect(result.json.error).toBe('INVALID_PASSWORD');
  });

  it('should return valid: true when board has no password', async () => {
    const { user } = loginUser('alice');

    const sessionInfo = retroSessionRegistry.createSession(user.id, validConfig({ password: null }));

    const result = await invokeRoute('POST', `/sessions/${sessionInfo.sessionId}/verify-password`, {
      body: { password: '' },
    });

    expect(result.status).toBe(200);
    expect(result.json.valid).toBe(true);
  });

  it('should return 404 when session does not exist', async () => {
    const result = await invokeRoute('POST', '/sessions/nonexist/verify-password', {
      body: { password: 'test' },
    });

    expect(result.status).toBe(404);
    expect(result.json.error).toBe('SESSION_NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// GET /sessions/:sessionId/export — CSV export
// ---------------------------------------------------------------------------
describe('GET /api/retro/sessions/:sessionId/export', () => {
  it('should return CSV when moderator (owner) requests export', async () => {
    const { token, user } = loginUser('alice');

    const sessionInfo = retroSessionRegistry.createSession(user.id, validConfig());
    const session = retroSessionRegistry.getSession(sessionInfo.sessionId)!;
    const column = session.getSessionState().board.columns[0];
    session.addCard(column.id, 'Test card', user.id, user.displayName);

    const result = await invokeRoute('GET', `/sessions/${sessionInfo.sessionId}/export`, {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(result.status).toBe(200);
    expect(result.headers['content-type']).toContain('text/csv');
    expect(result.body).toContain('Column');
    expect(result.body).toContain('Card Text');
    expect(result.body).toContain('Test card');
  });

  it('should return 403 when non-moderator requests export', async () => {
    const { user: owner } = loginUser('alice');
    const { token: participantToken } = loginUser('bob');

    const sessionInfo = retroSessionRegistry.createSession(owner.id, validConfig());

    const result = await invokeRoute('GET', `/sessions/${sessionInfo.sessionId}/export`, {
      headers: { authorization: `Bearer ${participantToken}` },
    });

    expect(result.status).toBe(403);
    expect(result.json.error).toBe('FORBIDDEN');
  });

  it('should return 401 when no auth token is provided', async () => {
    const { user } = loginUser('alice');
    const sessionInfo = retroSessionRegistry.createSession(user.id, validConfig());

    const result = await invokeRoute('GET', `/sessions/${sessionInfo.sessionId}/export`, {
      headers: {},
    });

    expect(result.status).toBe(401);
    expect(result.json.error).toBe('UNAUTHORIZED');
  });
});

// ---------------------------------------------------------------------------
// POST /sessions/:sessionId/import — CSV import
// ---------------------------------------------------------------------------
describe('POST /api/retro/sessions/:sessionId/import', () => {
  it('should return 200 when valid CSV is imported', async () => {
    const { token, user } = loginUser('alice');

    const sessionInfo = retroSessionRegistry.createSession(user.id, validConfig());
    const session = retroSessionRegistry.getSession(sessionInfo.sessionId)!;
    const columnName = session.getSessionState().board.columns[0].name;

    const csvData = `Column,Card Text,Votes,Author,Comments\n${columnName},Imported card,0,Alice,`;

    const result = await invokeRoute('POST', `/sessions/${sessionInfo.sessionId}/import`, {
      body: { csvData },
      headers: { authorization: `Bearer ${token}` },
    });

    expect(result.status).toBe(200);
    expect(result.json.success).toBe(true);
  });

  it('should return 400 when CSV is missing required headers', async () => {
    const { token, user } = loginUser('alice');

    const sessionInfo = retroSessionRegistry.createSession(user.id, validConfig());

    const csvData = 'InvalidHeader1,InvalidHeader2\ndata1,data2';

    const result = await invokeRoute('POST', `/sessions/${sessionInfo.sessionId}/import`, {
      body: { csvData },
      headers: { authorization: `Bearer ${token}` },
    });

    expect(result.status).toBe(400);
    expect(result.json.error).toBe('INVALID_CSV');
  });

  it('should return 400 when csvData is empty', async () => {
    const { token, user } = loginUser('alice');

    const sessionInfo = retroSessionRegistry.createSession(user.id, validConfig());

    const result = await invokeRoute('POST', `/sessions/${sessionInfo.sessionId}/import`, {
      body: { csvData: '' },
      headers: { authorization: `Bearer ${token}` },
    });

    expect(result.status).toBe(400);
    expect(result.json.error).toBe('INVALID_CSV');
  });

  it('should return 403 when non-moderator attempts import', async () => {
    const { user: owner } = loginUser('alice');
    const { token: participantToken } = loginUser('bob');

    const sessionInfo = retroSessionRegistry.createSession(owner.id, validConfig());

    const result = await invokeRoute('POST', `/sessions/${sessionInfo.sessionId}/import`, {
      body: { csvData: 'Column,Card Text\nTest,Test' },
      headers: { authorization: `Bearer ${participantToken}` },
    });

    expect(result.status).toBe(403);
    expect(result.json.error).toBe('FORBIDDEN');
  });

  it('should return 401 when no auth token is provided', async () => {
    const { user } = loginUser('alice');
    const sessionInfo = retroSessionRegistry.createSession(user.id, validConfig());

    const result = await invokeRoute('POST', `/sessions/${sessionInfo.sessionId}/import`, {
      body: { csvData: 'Column,Card Text\nTest,Test' },
      headers: {},
    });

    expect(result.status).toBe(401);
    expect(result.json.error).toBe('UNAUTHORIZED');
  });
});

// ---------------------------------------------------------------------------
// Property 6: Password authentication
// **Validates: Requirements 5.4, 16.1, 16.2**
// ---------------------------------------------------------------------------
describe('Property 6: Password authentication', () => {
  it('for any password P set on a board, verify-password with P returns valid: true', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 50 }),
        async (password) => {
          _resetStore();
          retroSessionRegistry._reset();

          const { user } = loginUser('propuser');

          // Create a session with the generated password
          const sessionInfo = retroSessionRegistry.createSession(user.id, validConfig({ password }));

          // Verify with the correct password
          const result = await invokeRoute('POST', `/sessions/${sessionInfo.sessionId}/verify-password`, {
            body: { password },
          });

          expect(result.status).toBe(200);
          expect(result.json.valid).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('for any password P and any different password A, verify-password with A returns 403', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 50 }),
        fc.string({ minLength: 1, maxLength: 50 }),
        async (password, attempt) => {
          // Only test when passwords are different
          fc.pre(password !== attempt);

          _resetStore();
          retroSessionRegistry._reset();

          const { user } = loginUser('propuser');

          // Create a session with the generated password
          const sessionInfo = retroSessionRegistry.createSession(user.id, validConfig({ password }));

          // Verify with a different password
          const result = await invokeRoute('POST', `/sessions/${sessionInfo.sessionId}/verify-password`, {
            body: { password: attempt },
          });

          expect(result.status).toBe(403);
          expect(result.json.error).toBe('INVALID_PASSWORD');
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 23: Invalid CSV rejection
// **Validates: Requirements 14.3**
// ---------------------------------------------------------------------------
describe('Property 23: Invalid CSV rejection', () => {
  it('for any malformed CSV (missing required headers), import returns 400 with INVALID_CSV', async () => {
    // Generate CSV-like strings that are missing the required "Column" and "Card Text" headers
    const malformedCsvArb = fc.oneof(
      // Random headers that don't include required ones
      fc.array(
        fc.string({ minLength: 1, maxLength: 20 }).filter(
          (s) => s !== 'Column' && s !== 'Card Text' && !s.includes(',') && !s.includes('\n')
        ),
        { minLength: 1, maxLength: 5 }
      ).map((headers) => headers.join(',') + '\n' + headers.map(() => 'data').join(',')),
      // Empty strings
      fc.constant(''),
      // Whitespace only
      fc.stringOf(fc.constantFrom(' ', '\t', '\n'), { minLength: 1, maxLength: 10 })
    );

    await fc.assert(
      fc.asyncProperty(malformedCsvArb, async (csvData) => {
        _resetStore();
        retroSessionRegistry._reset();

        const { token, user } = loginUser('propuser');

        // Create a session
        const sessionInfo = retroSessionRegistry.createSession(user.id, validConfig());

        // Attempt import with malformed CSV
        const result = await invokeRoute('POST', `/sessions/${sessionInfo.sessionId}/import`, {
          body: { csvData },
          headers: { authorization: `Bearer ${token}` },
        });

        expect(result.status).toBe(400);
        expect(result.json.error).toBe('INVALID_CSV');
      }),
      { numRuns: 100 }
    );
  });
});
