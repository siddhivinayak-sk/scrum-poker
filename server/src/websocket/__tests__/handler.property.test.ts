import * as fc from 'fast-check';
import { EventEmitter } from 'events';
import WebSocket from 'ws';
import {
  handleWebSocket,
  _reset as resetHandler,
  getSessionClients,
  broadcastConfigUpdate,
} from '../handler';
import * as authService from '../../services/auth-service';
import { sessionRegistry } from '../../services/session-registry';
import {
  User,
  WebSocketMessage,
  DEFAULT_SESSION_CONFIG,
  SessionConfiguration,
} from '../../../../shared/types';
import { IncomingMessage } from 'http';

// --- Helpers (same patterns as handler.test.ts) ---

/** Create a mock WebSocket that captures sent messages and supports events. */
function createMockWs(): WebSocket & {
  sentMessages: string[];
  closedWith?: { code: number; reason: string };
} {
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

/** Create a mock IncomingMessage with a given URL. */
function createMockRequest(url: string): IncomingMessage {
  return {
    url,
    headers: { host: 'localhost:3000' },
  } as unknown as IncomingMessage;
}

/** Parse a sent WebSocket message. */
function parseMessage(raw: string): WebSocketMessage {
  return JSON.parse(raw);
}

/** Create a valid JSON envelope for a client event. */
function clientMessage(event: string, data: any = {}): string {
  return JSON.stringify({
    event,
    data,
    timestamp: new Date().toISOString(),
  });
}

// --- Generators ---

/**
 * Arbitrary generator for a valid SessionConfiguration.
 */
function arbSessionConfig(): fc.Arbitrary<SessionConfiguration> {
  return fc.record({
    votingSystem: fc.constantFrom(
      'fibonacci' as const,
      'modified-fibonacci' as const,
      't-shirt' as const,
      'power-of-2' as const,
    ),
    revealPermission: fc.record({
      mode: fc.constantFrom(
        'moderator-only' as const,
        'all-players' as const,
        'select-specific' as const,
      ),
      allowedUserIds: fc.array(fc.uuid(), { minLength: 0, maxLength: 3 }),
    }),
    issuePermission: fc.record({
      mode: fc.constantFrom(
        'moderator-only' as const,
        'all-players' as const,
        'select-specific' as const,
      ),
      allowedUserIds: fc.array(fc.uuid(), { minLength: 0, maxLength: 3 }),
    }),
    autoReveal: fc.boolean(),
    countdownAnimation: fc.boolean(),
  });
}

/**
 * Arbitrary generator for session definitions with random client counts.
 * Each session has a unique owner and a random number of additional clients.
 */
function arbSessionSetup(): fc.Arbitrary<
  Array<{
    ownerId: string;
    config: SessionConfiguration;
    clientCount: number; // additional clients beyond the owner
  }>
> {
  return fc.array(
    fc.record({
      ownerId: fc.uuid(),
      config: arbSessionConfig(),
      clientCount: fc.integer({ min: 0, max: 5 }),
    }),
    { minLength: 2, maxLength: 6 },
  );
}

// --- Property Test ---

/**
 * Property 3: WebSocket broadcast isolation
 *
 * For any event broadcast within a session, only connections in that session
 * receive it; connections in other sessions do not.
 *
 * **Validates: Requirements 5.4, 5.5, 15.4, 15.5**
 */
describe('Property 3: WebSocket broadcast isolation', () => {
  beforeEach(() => {
    resetHandler();
    sessionRegistry._reset();
    jest.restoreAllMocks();
  });

  it('for any event broadcast within a session, only connections in that session receive it; connections in other sessions do not', () => {
    fc.assert(
      fc.property(
        arbSessionSetup(),
        fc.nat({ max: 100 }), // used to pick which session to broadcast to
        (sessionSetups, broadcastSelector) => {
          // Reset state for each property run
          resetHandler();
          sessionRegistry._reset();

          // Track all sessions and their connected WebSocket mocks
          const sessions: Array<{
            sessionId: string;
            ownerId: string;
            sockets: Array<WebSocket & { sentMessages: string[] }>;
          }> = [];

          // Create sessions and connect clients
          let validateTokenCallIndex = 0;
          const allUsers: User[] = [];

          // Pre-generate all users for all sessions
          for (const setup of sessionSetups) {
            // Owner user (moderator)
            const ownerUser: User = {
              id: setup.ownerId,
              displayName: `Owner-${setup.ownerId.slice(0, 4)}`,
              role: 'moderator',
              isAnonymous: false,
            };
            allUsers.push(ownerUser);

            // Additional client users
            for (let i = 0; i < setup.clientCount; i++) {
              const clientUser: User = {
                id: `${setup.ownerId}-client-${i}`,
                displayName: `Client-${i}`,
                role: 'participant',
                isAnonymous: false,
              };
              allUsers.push(clientUser);
            }
          }

          // Mock validateToken to return users in order
          let userIndex = 0;
          jest.spyOn(authService, 'validateToken').mockImplementation(() => {
            return allUsers[userIndex++] || null;
          });

          // Create sessions and connect all clients
          for (const setup of sessionSetups) {
            const info = sessionRegistry.createSession(setup.ownerId, setup.config);
            const sessionSockets: Array<WebSocket & { sentMessages: string[] }> = [];

            // Connect owner
            const ownerWs = createMockWs();
            handleWebSocket(
              ownerWs,
              createMockRequest(`/?token=token-owner&sessionId=${info.sessionId}`),
            );
            sessionSockets.push(ownerWs);

            // Connect additional clients
            for (let i = 0; i < setup.clientCount; i++) {
              const clientWs = createMockWs();
              handleWebSocket(
                clientWs,
                createMockRequest(`/?token=token-client-${i}&sessionId=${info.sessionId}`),
              );
              sessionSockets.push(clientWs);
            }

            sessions.push({
              sessionId: info.sessionId,
              ownerId: setup.ownerId,
              sockets: sessionSockets,
            });
          }

          // Pick a target session to broadcast to
          const targetIndex = broadcastSelector % sessions.length;
          const targetSession = sessions[targetIndex];

          // Record message counts before broadcast
          const messageCountsBefore = new Map<WebSocket, number>();
          for (const session of sessions) {
            for (const ws of session.sockets) {
              messageCountsBefore.set(ws, ws.sentMessages.length);
            }
          }

          // Broadcast an event to the target session using broadcastConfigUpdate
          // (a public function that calls broadcastToSession internally)
          broadcastConfigUpdate(targetSession.sessionId, { test: 'broadcast-isolation-check' });

          // Verify: only sockets in the target session received the new message
          for (const session of sessions) {
            for (const ws of session.sockets) {
              const before = messageCountsBefore.get(ws)!;
              const after = ws.sentMessages.length;
              const newMessages = after - before;

              if (session.sessionId === targetSession.sessionId) {
                // Target session sockets should have received exactly 1 new message
                expect(newMessages).toBe(1);

                // Verify the message content
                const lastMsg = parseMessage(ws.sentMessages[ws.sentMessages.length - 1]);
                expect(lastMsg.event).toBe('session:config-updated');
              } else {
                // Other session sockets should NOT have received any new messages
                expect(newMessages).toBe(0);
              }
            }
          }

          // Cleanup
          resetHandler();
          sessionRegistry._reset();
        },
      ),
      { numRuns: 100 },
    );
  });
});
