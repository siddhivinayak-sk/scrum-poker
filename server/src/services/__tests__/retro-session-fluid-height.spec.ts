import { IncomingMessage } from 'http';
import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { RetroSession } from '../retro-session';
import { retroSessionRegistry } from '../retro-session-registry';
import { handleRetroWebSocket, _resetRetroHandler } from '../../websocket/retro-handler';
import * as authService from '../auth-service';
import { User, RetroConfiguration, WebSocketMessage } from '../../../../shared/types';

/**
 * A retro configuration as it existed before the fluidCardHeight feature:
 * the key is entirely absent from the record (R6.1, R13.10).
 */
const legacyConfig: RetroConfiguration = {
  boardName: 'Fluid Height Retro',
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
};

/** Build a config carrying an arbitrary (possibly invalid) fluidCardHeight value. */
function configWithFluid(value: unknown): RetroConfiguration {
  return { ...legacyConfig, fluidCardHeight: value } as unknown as RetroConfiguration;
}

/** Build a config-update partial carrying an arbitrary fluidCardHeight value. */
function partialWithFluid(value: unknown): Partial<RetroConfiguration> {
  return { fluidCardHeight: value } as unknown as Partial<RetroConfiguration>;
}

const NON_BOOLEAN_VALUES: { label: string; value: unknown }[] = [
  { label: 'a string', value: 'true' },
  { label: 'an empty string', value: '' },
  { label: 'the number 0', value: 0 },
  { label: 'the number 1', value: 1 },
  { label: 'null', value: null },
  { label: 'an object', value: {} },
  { label: 'an array', value: [] },
];

// --- WebSocket handler test helpers (mirrors retro-handler.spec.ts) ---

type MockWs = WebSocket & { sentMessages: string[] };

function createMockWs(): MockWs {
  const emitter = new EventEmitter();
  const mock = emitter as any;
  mock.readyState = WebSocket.OPEN;
  mock.sentMessages = [];
  mock.send = jest.fn((data: string) => {
    mock.sentMessages.push(data);
  });
  mock.close = jest.fn();
  return mock as MockWs;
}

function createRetroRequest(token: string, sessionId: string): IncomingMessage {
  return {
    url: `/retro?token=${token}&sessionId=${sessionId}`,
    headers: { host: 'localhost:3000' },
  } as unknown as IncomingMessage;
}

function clientMessage(event: string, data: unknown): Buffer {
  return Buffer.from(JSON.stringify({ event, data, timestamp: new Date().toISOString() }));
}

function messagesSince(ws: MockWs, from: number): WebSocketMessage[] {
  return ws.sentMessages.slice(from).map((raw) => JSON.parse(raw) as WebSocketMessage);
}

const moderatorUser: User = {
  id: 'mod-1',
  displayName: 'Moderator',
  role: 'moderator',
  isAnonymous: false,
};

const participantUser: User = {
  id: 'user-a',
  displayName: 'Alice',
  role: 'participant',
  isAnonymous: false,
};

// --- RetroSession creation (R6.2, R13.10) ---

describe('RetroSession creation normalises fluidCardHeight (R6.2)', () => {
  it('defaults to true when the creation config omits the field', () => {
    const session = new RetroSession('s1', 'owner-1', legacyConfig);
    expect(session.config.fluidCardHeight).toBe(true);
  });

  it('keeps a boolean true from the creation config', () => {
    const session = new RetroSession('s1', 'owner-1', configWithFluid(true));
    expect(session.config.fluidCardHeight).toBe(true);
  });

  it('keeps a boolean false from the creation config', () => {
    const session = new RetroSession('s1', 'owner-1', configWithFluid(false));
    expect(session.config.fluidCardHeight).toBe(false);
  });

  it.each(NON_BOOLEAN_VALUES)(
    'defaults to true when the creation config carries $label',
    ({ value }) => {
      const session = new RetroSession('s1', 'owner-1', configWithFluid(value));
      expect(session.config.fluidCardHeight).toBe(true);
    }
  );

  it('never mutates the caller config object', () => {
    const supplied = { ...legacyConfig };
    new RetroSession('s1', 'owner-1', supplied);
    expect('fluidCardHeight' in supplied).toBe(false);
  });
});

describe('Broadcast state always carries a boolean fluidCardHeight (R13.10)', () => {
  it('reports true for a legacy config that omits the field', () => {
    const session = new RetroSession('s1', 'owner-1', legacyConfig);
    const state = session.getSessionState();
    expect(state.config.fluidCardHeight).toBe(true);
  });

  it('survives JSON serialisation as a boolean for a legacy config', () => {
    const session = new RetroSession('s1', 'owner-1', legacyConfig);
    const serialised = JSON.parse(JSON.stringify(session.getSessionState())) as {
      config: Record<string, unknown>;
    };
    expect(serialised.config).toHaveProperty('fluidCardHeight');
    expect(serialised.config.fluidCardHeight).toBe(true);
  });

  it('reports a boolean for every creation input', () => {
    const inputs: unknown[] = [true, false, undefined, ...NON_BOOLEAN_VALUES.map((v) => v.value)];
    for (const input of inputs) {
      const config =
        input === undefined ? legacyConfig : configWithFluid(input);
      const session = new RetroSession('s1', 'owner-1', config);
      expect(typeof session.getSessionState().config.fluidCardHeight).toBe('boolean');
    }
  });
});

// --- updateConfig (R6.11, R6.17) ---

describe('RetroSession.updateConfig fluidCardHeight (R6.11, R6.17)', () => {
  let session: RetroSession;

  beforeEach(() => {
    session = new RetroSession('s1', 'owner-1', configWithFluid(true));
  });

  it('accepts a boolean update and reports no rejected keys', () => {
    const result = session.updateConfig(partialWithFluid(false));

    expect(result.rejectedKeys).toEqual([]);
    expect(result.config.fluidCardHeight).toBe(false);
    expect(session.getSessionState().config.fluidCardHeight).toBe(false);
  });

  it('accepts a boolean update back to true', () => {
    session.updateConfig(partialWithFluid(false));
    const result = session.updateConfig(partialWithFluid(true));

    expect(result.rejectedKeys).toEqual([]);
    expect(session.getSessionState().config.fluidCardHeight).toBe(true);
  });

  it.each(NON_BOOLEAN_VALUES)(
    'rejects $label and leaves the stored value unchanged',
    ({ value }) => {
      session.updateConfig(partialWithFluid(false));
      const result = session.updateConfig(partialWithFluid(value));

      expect(result.rejectedKeys).toEqual(['fluidCardHeight']);
      expect(result.config.fluidCardHeight).toBe(false);
      expect(session.getSessionState().config.fluidCardHeight).toBe(false);
    }
  );

  it('still merges the valid keys of a partial that carries a rejected one', () => {
    const result = session.updateConfig({
      ...partialWithFluid('nope'),
      hideVoteCount: true,
    });

    expect(result.rejectedKeys).toEqual(['fluidCardHeight']);
    expect(result.config.fluidCardHeight).toBe(true);
    expect(result.config.hideVoteCount).toBe(true);
  });

  it('does not mutate the caller partial when rejecting a value', () => {
    const partial = partialWithFluid('nope');
    session.updateConfig(partial);
    expect(partial.fluidCardHeight).toBe('nope' as unknown as boolean);
  });
});

// --- WebSocket handler surface (R6.11, R6.17) ---

describe('retro:config:update handling of fluidCardHeight (R6.11, R6.17)', () => {
  let sessionId: string;
  let modWs: MockWs;
  let participantWs: MockWs;

  function connect(user: User): MockWs {
    jest.spyOn(authService, 'validateToken').mockReturnValueOnce(user);
    const ws = createMockWs();
    handleRetroWebSocket(ws, createRetroRequest(`token-${user.id}`, sessionId));
    return ws;
  }

  beforeEach(() => {
    _resetRetroHandler();
    retroSessionRegistry._reset();
    jest.restoreAllMocks();
    sessionId = retroSessionRegistry.createSession(
      moderatorUser.id,
      configWithFluid(true)
    ).sessionId;
    modWs = connect(moderatorUser);
    participantWs = connect(participantUser);
  });

  afterEach(() => {
    _resetRetroHandler();
    retroSessionRegistry._reset();
  });

  it('broadcasts the updated config when a moderator sends a boolean value', () => {
    const modFrom = modWs.sentMessages.length;
    const participantFrom = participantWs.sentMessages.length;

    modWs.emit(
      'message',
      clientMessage('retro:config:update', { config: partialWithFluid(false) })
    );

    const modMsgs = messagesSince(modWs, modFrom);
    const updated = modMsgs.find((m) => m.event === 'retro:config:updated');
    expect(updated).toBeDefined();
    expect(updated!.data.config.fluidCardHeight).toBe(false);
    expect(modMsgs.find((m) => m.event === 'retro:error')).toBeUndefined();

    // Every connected participant, including the requesting moderator, is told.
    const participantUpdated = messagesSince(participantWs, participantFrom).find(
      (m) => m.event === 'retro:config:updated'
    );
    expect(participantUpdated).toBeDefined();
    expect(participantUpdated!.data.config.fluidCardHeight).toBe(false);

    expect(
      retroSessionRegistry.getSession(sessionId)!.config.fluidCardHeight
    ).toBe(false);
  });

  it('replies retro:error with INVALID_CONFIG and sends no broadcast for a non-boolean value', () => {
    const modFrom = modWs.sentMessages.length;
    const participantFrom = participantWs.sentMessages.length;

    modWs.emit(
      'message',
      clientMessage('retro:config:update', { config: partialWithFluid('yes') })
    );

    const modMsgs = messagesSince(modWs, modFrom);
    const error = modMsgs.find((m) => m.event === 'retro:error');
    expect(error).toBeDefined();
    expect(error!.data.code).toBe('INVALID_CONFIG');

    expect(modMsgs.find((m) => m.event === 'retro:config:updated')).toBeUndefined();
    expect(
      messagesSince(participantWs, participantFrom).find(
        (m) => m.event === 'retro:config:updated'
      )
    ).toBeUndefined();

    expect(
      retroSessionRegistry.getSession(sessionId)!.config.fluidCardHeight
    ).toBe(true);
  });

  it('replies retro:error with UNAUTHORIZED and sends no broadcast for a non-moderator sender', () => {
    const modFrom = modWs.sentMessages.length;
    const participantFrom = participantWs.sentMessages.length;

    participantWs.emit(
      'message',
      clientMessage('retro:config:update', { config: partialWithFluid(false) })
    );

    const participantMsgs = messagesSince(participantWs, participantFrom);
    const error = participantMsgs.find((m) => m.event === 'retro:error');
    expect(error).toBeDefined();
    expect(error!.data.code).toBe('UNAUTHORIZED');

    expect(
      participantMsgs.find((m) => m.event === 'retro:config:updated')
    ).toBeUndefined();
    expect(
      messagesSince(modWs, modFrom).find((m) => m.event === 'retro:config:updated')
    ).toBeUndefined();

    expect(
      retroSessionRegistry.getSession(sessionId)!.config.fluidCardHeight
    ).toBe(true);
  });
});
