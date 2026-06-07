import { RetroSession } from '../retro-session';
import {
  RetroConfiguration,
  User,
  FeelingCategory,
  DEFAULT_ALLOWED_FEELINGS,
} from '../../../../shared/types';

function makeConfig(overrides: Partial<RetroConfiguration> = {}): RetroConfiguration {
  return {
    boardName: 'Test Retro',
    maxVotesPerUser: 6,
    templateId: 'start-stop-continue',
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

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: overrides.id ?? 'user-1',
    displayName: overrides.displayName ?? 'Alice',
    role: overrides.role ?? 'participant',
    isAnonymous: overrides.isAnonymous ?? false,
  };
}

function createSession(configOverrides: Partial<RetroConfiguration> = {}): RetroSession {
  return new RetroSession('retro-session-1', 'owner-1', makeConfig(configOverrides));
}

describe('RetroSession - Feelings Methods', () => {
  describe('setFeeling', () => {
    it('stores a valid feeling for a participant', () => {
      const session = createSession({ allowedFeelings: ['Happy', 'Sad', 'No_Feeling'] });
      session.addParticipant(makeUser({ id: 'user-1' }));

      session.setFeeling('user-1', 'Happy');

      expect(session.getFeeling('user-1')).toBe('Happy');
    });

    it('stores null to deselect a feeling', () => {
      const session = createSession({ allowedFeelings: ['Happy', 'Sad', 'No_Feeling'] });
      session.addParticipant(makeUser({ id: 'user-1' }));

      session.setFeeling('user-1', 'Happy');
      session.setFeeling('user-1', null);

      expect(session.getFeeling('user-1')).toBeNull();
    });

    it('replaces a previous feeling with a new one', () => {
      const session = createSession({ allowedFeelings: ['Happy', 'Sad', 'No_Feeling'] });
      session.addParticipant(makeUser({ id: 'user-1' }));

      session.setFeeling('user-1', 'Happy');
      session.setFeeling('user-1', 'Sad');

      expect(session.getFeeling('user-1')).toBe('Sad');
    });

    it('rejects a feeling category not in allowedFeelings', () => {
      const session = createSession({ allowedFeelings: ['Happy', 'Sad'] });
      session.addParticipant(makeUser({ id: 'user-1' }));

      expect(() => session.setFeeling('user-1', 'Mad')).toThrow('Invalid feeling category');
      expect(session.getFeeling('user-1')).toBeNull();
    });

    it('rejects feeling selection when board is completed', () => {
      const session = createSession({ allowedFeelings: ['Happy', 'Sad', 'No_Feeling'] });
      session.addParticipant(makeUser({ id: 'user-1' }));
      session.setFeeling('user-1', 'Happy');

      session.completeBoard();

      expect(() => session.setFeeling('user-1', 'Sad')).toThrow('Board is completed');
      // Previous feeling remains unchanged
      expect(session.getFeeling('user-1')).toBe('Happy');
    });

    it('rejects deselection (null) when board is completed', () => {
      const session = createSession({ allowedFeelings: ['Happy', 'Sad', 'No_Feeling'] });
      session.addParticipant(makeUser({ id: 'user-1' }));
      session.setFeeling('user-1', 'Happy');

      session.completeBoard();

      expect(() => session.setFeeling('user-1', null)).toThrow('Board is completed');
      expect(session.getFeeling('user-1')).toBe('Happy');
    });
  });

  describe('removeParticipant clears feeling entry', () => {
    it('removes feeling when participant is removed', () => {
      const session = createSession({ allowedFeelings: ['Happy', 'Sad', 'No_Feeling'] });
      session.addParticipant(makeUser({ id: 'user-1' }));
      session.setFeeling('user-1', 'Happy');

      session.removeParticipant('user-1');

      // Feeling should be gone (returns null as default)
      expect(session.getFeeling('user-1')).toBeNull();
      // Feelings map should not contain the user
      const feelingsMap = session.getFeelingsMap();
      expect(feelingsMap).not.toHaveProperty('user-1');
    });

    it('does not affect other participants feelings', () => {
      const session = createSession({ allowedFeelings: ['Happy', 'Sad', 'No_Feeling'] });
      session.addParticipant(makeUser({ id: 'user-1', displayName: 'Alice' }));
      session.addParticipant(makeUser({ id: 'user-2', displayName: 'Bob' }));
      session.setFeeling('user-1', 'Happy');
      session.setFeeling('user-2', 'Sad');

      session.removeParticipant('user-1');

      expect(session.getFeeling('user-2')).toBe('Sad');
    });
  });

  describe('updateConfig clears feelings for removed categories', () => {
    it('clears feelings when category is removed from allowedFeelings', () => {
      const session = createSession({ allowedFeelings: ['Happy', 'Sad', 'No_Feeling'] });
      session.addParticipant(makeUser({ id: 'user-1', displayName: 'Alice' }));
      session.addParticipant(makeUser({ id: 'user-2', displayName: 'Bob' }));
      session.setFeeling('user-1', 'Happy');
      session.setFeeling('user-2', 'Happy');

      const { affectedUserIds } = session.updateConfig({ allowedFeelings: ['Sad', 'No_Feeling'] });

      expect(affectedUserIds).toContain('user-1');
      expect(affectedUserIds).toContain('user-2');
      expect(session.getFeeling('user-1')).toBeNull();
      expect(session.getFeeling('user-2')).toBeNull();
    });

    it('does not clear feelings for categories still in allowedFeelings', () => {
      const session = createSession({ allowedFeelings: ['Happy', 'Sad', 'No_Feeling'] });
      session.addParticipant(makeUser({ id: 'user-1', displayName: 'Alice' }));
      session.addParticipant(makeUser({ id: 'user-2', displayName: 'Bob' }));
      session.setFeeling('user-1', 'Happy');
      session.setFeeling('user-2', 'Sad');

      const { affectedUserIds } = session.updateConfig({ allowedFeelings: ['Happy', 'No_Feeling'] });

      // Only user-2 (Sad removed) is affected
      expect(affectedUserIds).toEqual(['user-2']);
      expect(session.getFeeling('user-1')).toBe('Happy');
      expect(session.getFeeling('user-2')).toBeNull();
    });

    it('returns empty affectedUserIds when no feelings need clearing', () => {
      const session = createSession({ allowedFeelings: ['Happy', 'Sad', 'No_Feeling'] });
      session.addParticipant(makeUser({ id: 'user-1', displayName: 'Alice' }));
      session.setFeeling('user-1', 'Happy');

      const { affectedUserIds } = session.updateConfig({ allowedFeelings: ['Happy', 'Sad', 'Mad'] });

      expect(affectedUserIds).toEqual([]);
      expect(session.getFeeling('user-1')).toBe('Happy');
    });

    it('returns updated config alongside affectedUserIds', () => {
      const session = createSession({ allowedFeelings: ['Happy', 'Sad', 'No_Feeling'] });

      const { config } = session.updateConfig({ allowedFeelings: ['Glad', 'Mad'] });

      expect(config.allowedFeelings).toEqual(['Glad', 'Mad']);
    });
  });

  describe('getSessionState includes complete feelings map', () => {
    it('includes feelings in session state', () => {
      const session = createSession({ allowedFeelings: ['Happy', 'Sad', 'No_Feeling'] });
      session.addParticipant(makeUser({ id: 'user-1', displayName: 'Alice' }));
      session.addParticipant(makeUser({ id: 'user-2', displayName: 'Bob' }));
      session.setFeeling('user-1', 'Happy');
      session.setFeeling('user-2', 'Sad');

      const state = session.getSessionState();

      expect(state.feelings).toEqual({
        'user-1': 'Happy',
        'user-2': 'Sad',
      });
    });

    it('includes null feelings in session state', () => {
      const session = createSession({ allowedFeelings: ['Happy', 'Sad', 'No_Feeling'] });
      session.addParticipant(makeUser({ id: 'user-1', displayName: 'Alice' }));
      session.setFeeling('user-1', null);

      const state = session.getSessionState();

      expect(state.feelings).toEqual({ 'user-1': null });
    });

    it('returns empty feelings map when no feelings set', () => {
      const session = createSession();
      session.addParticipant(makeUser({ id: 'user-1', displayName: 'Alice' }));

      const state = session.getSessionState();

      expect(state.feelings).toEqual({});
    });
  });

  describe('default allowedFeelings applied on new session', () => {
    it('applies DEFAULT_ALLOWED_FEELINGS when config omits allowedFeelings', () => {
      const configWithoutFeelings: any = {
        boardName: 'Test Retro',
        maxVotesPerUser: 6,
        templateId: 'start-stop-continue',
        hideCardsInitially: false,
        disableVotingInitially: false,
        hideVoteCount: false,
        oneVotePerCard: false,
        showCardAuthor: false,
        password: null,
        enableGifEmoji: true,
        columnLayout: 'vertical',
        // allowedFeelings intentionally omitted
      };

      const session = new RetroSession('s1', 'o1', configWithoutFeelings);
      const state = session.getSessionState();

      expect(state.config.allowedFeelings).toEqual(DEFAULT_ALLOWED_FEELINGS);
      expect(state.config.allowedFeelings).toEqual(['Happy', 'Sad', 'No_Feeling']);
    });

    it('uses provided allowedFeelings when explicitly set in config', () => {
      const session = createSession({ allowedFeelings: ['Glad', 'Mad', 'Boredom'] });
      const state = session.getSessionState();

      expect(state.config.allowedFeelings).toEqual(['Glad', 'Mad', 'Boredom']);
    });

    it('DEFAULT_ALLOWED_FEELINGS constant has expected values', () => {
      expect(DEFAULT_ALLOWED_FEELINGS).toEqual(['Happy', 'Sad', 'No_Feeling']);
    });
  });
});
