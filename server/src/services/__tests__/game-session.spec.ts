import { GameSession } from '../game-session';
import {
  User,
  SessionConfiguration,
  DEFAULT_SESSION_CONFIG,
} from '../../../../shared/types';

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: overrides.id ?? 'user-1',
    displayName: overrides.displayName ?? 'Alice',
    role: overrides.role ?? 'participant',
    isAnonymous: overrides.isAnonymous ?? false,
  };
}

function makeConfig(overrides: Partial<SessionConfiguration> = {}): SessionConfiguration {
  return { ...DEFAULT_SESSION_CONFIG, ...overrides };
}

function createSession(configOverrides: Partial<SessionConfiguration> = {}): GameSession {
  return new GameSession('test-session', 'owner-1', makeConfig(configOverrides));
}

describe('GameSession - New Methods', () => {
  describe('removeParticipantByModerator', () => {
    it('removes participant from the participant list', () => {
      const session = createSession();
      session.addParticipant(makeUser({ id: 'u1', displayName: 'Alice' }));
      session.addParticipant(makeUser({ id: 'u2', displayName: 'Bob' }));

      session.removeParticipantByModerator('u1');

      const participants = session.getParticipants();
      expect(participants).toHaveLength(1);
      expect(participants[0].id).toBe('u2');
    });

    it('discards their card selection from the current round', () => {
      const session = createSession();
      session.addParticipant(makeUser({ id: 'u1', displayName: 'Alice' }));
      session.addParticipant(makeUser({ id: 'u2', displayName: 'Bob' }));
      session.startRound('Story');
      session.selectCard('u1', 5);
      session.selectCard('u2', 8);

      session.removeParticipantByModerator('u1');

      const selections = session.getSelections();
      expect(selections.has('u1')).toBe(false);
      expect(selections.get('u2')).toBe(8);
    });

    it('does not throw if user has no selection', () => {
      const session = createSession();
      session.addParticipant(makeUser({ id: 'u1', displayName: 'Alice' }));
      session.startRound('Story');
      // u1 has not voted

      expect(() => session.removeParticipantByModerator('u1')).not.toThrow();
      expect(session.getParticipants()).toHaveLength(0);
    });

    it('does not throw if no current round', () => {
      const session = createSession();
      session.addParticipant(makeUser({ id: 'u1', displayName: 'Alice' }));

      expect(() => session.removeParticipantByModerator('u1')).not.toThrow();
      expect(session.getParticipants()).toHaveLength(0);
    });

    it('does not affect other participants selections', () => {
      const session = createSession();
      session.addParticipant(makeUser({ id: 'u1', displayName: 'Alice' }));
      session.addParticipant(makeUser({ id: 'u2', displayName: 'Bob' }));
      session.addParticipant(makeUser({ id: 'u3', displayName: 'Charlie' }));
      session.startRound('Story');
      session.selectCard('u1', 3);
      session.selectCard('u2', 5);
      session.selectCard('u3', 8);

      session.removeParticipantByModerator('u2');

      const selections = session.getSelections();
      expect(selections.get('u1')).toBe(3);
      expect(selections.get('u3')).toBe(8);
      expect(selections.has('u2')).toBe(false);
    });

    it('does not throw when removing a non-existent user', () => {
      const session = createSession();
      session.addParticipant(makeUser({ id: 'u1', displayName: 'Alice' }));

      expect(() => session.removeParticipantByModerator('non-existent')).not.toThrow();
      expect(session.getParticipants()).toHaveLength(1);
    });
  });

  describe('hasDisplayName', () => {
    it('returns true for exact match', () => {
      const session = createSession();
      session.addParticipant(makeUser({ id: 'u1', displayName: 'Alice' }));

      expect(session.hasDisplayName('Alice')).toBe(true);
    });

    it('returns true for case-insensitive match', () => {
      const session = createSession();
      session.addParticipant(makeUser({ id: 'u1', displayName: 'Alice' }));

      expect(session.hasDisplayName('alice')).toBe(true);
      expect(session.hasDisplayName('ALICE')).toBe(true);
      expect(session.hasDisplayName('aLiCe')).toBe(true);
    });

    it('returns true with leading/trailing spaces', () => {
      const session = createSession();
      session.addParticipant(makeUser({ id: 'u1', displayName: 'Alice' }));

      expect(session.hasDisplayName('  Alice  ')).toBe(true);
      expect(session.hasDisplayName('  alice  ')).toBe(true);
    });

    it('returns false for non-matching name', () => {
      const session = createSession();
      session.addParticipant(makeUser({ id: 'u1', displayName: 'Alice' }));

      expect(session.hasDisplayName('Bob')).toBe(false);
      expect(session.hasDisplayName('Alic')).toBe(false);
      expect(session.hasDisplayName('Alicee')).toBe(false);
    });

    it('returns false after participant is removed', () => {
      const session = createSession();
      session.addParticipant(makeUser({ id: 'u1', displayName: 'Alice' }));

      expect(session.hasDisplayName('Alice')).toBe(true);

      session.removeParticipantByModerator('u1');

      expect(session.hasDisplayName('Alice')).toBe(false);
    });

    it('returns false when session has no participants', () => {
      const session = createSession();
      expect(session.hasDisplayName('Alice')).toBe(false);
    });
  });

  describe('revote', () => {
    it('preserves story description', () => {
      const session = createSession();
      session.startRound('Estimate login feature');
      session.selectCard('u1', 5);
      session.selectCard('u2', 8);
      session.revealCards();

      const newRound = session.revote();

      expect(newRound.storyDescription).toBe('Estimate login feature');
    });

    it('resets status to voting', () => {
      const session = createSession();
      session.startRound('Story');
      session.selectCard('u1', 5);
      session.revealCards();

      const newRound = session.revote();

      expect(newRound.status).toBe('voting');
    });

    it('empties selections', () => {
      const session = createSession();
      session.startRound('Story');
      session.selectCard('u1', 5);
      session.selectCard('u2', 8);
      session.revealCards();

      const newRound = session.revote();

      expect(newRound.selections.size).toBe(0);
    });

    it('does not save to history', () => {
      const session = createSession();
      session.addParticipant(makeUser({ id: 'u1' }));
      session.startRound('Story');
      session.selectCard('u1', 5);
      session.revealCards();

      const historyBefore = session.getHistory().length;
      session.revote();
      const historyAfter = session.getHistory().length;

      expect(historyAfter).toBe(historyBefore);
    });

    it('throws if no current round', () => {
      const session = createSession();

      expect(() => session.revote()).toThrow('No active round to re-vote');
    });

    it('throws if round not revealed', () => {
      const session = createSession();
      session.startRound('Story');
      session.selectCard('u1', 5);

      expect(() => session.revote()).toThrow('Can only re-vote after cards are revealed');
    });

    it('creates a new round with a different id', () => {
      const session = createSession();
      session.startRound('Story');
      session.selectCard('u1', 5);
      session.revealCards();
      const oldRoundId = session.getCurrentRound()!.id;

      const newRound = session.revote();

      expect(newRound.id).not.toBe(oldRoundId);
    });
  });

  describe('addIssue', () => {
    it('appends issue with correct fields', () => {
      const session = createSession();

      const issue = session.addIssue('Login feature');

      expect(issue.title).toBe('Login feature');
      expect(issue.status).toBe('pending');
      expect(issue.id).toBeDefined();
      expect(issue.createdAt).toBeDefined();
      expect(issue.historyEntryId).toBeUndefined();
    });

    it('appends to the end of the issue list', () => {
      const session = createSession();
      session.addIssue('Issue 1');
      session.addIssue('Issue 2');
      session.addIssue('Issue 3');

      const issues = session.getIssueList();
      expect(issues).toHaveLength(3);
      expect(issues[0].title).toBe('Issue 1');
      expect(issues[1].title).toBe('Issue 2');
      expect(issues[2].title).toBe('Issue 3');
    });

    it('trims whitespace from title', () => {
      const session = createSession();
      const issue = session.addIssue('  Padded title  ');
      expect(issue.title).toBe('Padded title');
    });

    it('throws on empty title', () => {
      const session = createSession();
      expect(() => session.addIssue('')).toThrow('Issue title must not be empty');
    });

    it('throws on whitespace-only title', () => {
      const session = createSession();
      expect(() => session.addIssue('   ')).toThrow('Issue title must not be empty');
    });
  });

  describe('addIssues', () => {
    it('filters empty titles and adds valid ones', () => {
      const session = createSession();

      const issues = session.addIssues(['Issue 1', '', 'Issue 2', '   ', 'Issue 3']);

      expect(issues).toHaveLength(3);
      expect(issues[0].title).toBe('Issue 1');
      expect(issues[1].title).toBe('Issue 2');
      expect(issues[2].title).toBe('Issue 3');
    });

    it('returns created items', () => {
      const session = createSession();

      const issues = session.addIssues(['Task A', 'Task B']);

      expect(issues).toHaveLength(2);
      expect(issues[0].title).toBe('Task A');
      expect(issues[0].status).toBe('pending');
      expect(issues[0].id).toBeDefined();
      expect(issues[1].title).toBe('Task B');
    });

    it('returns empty array when all titles are empty', () => {
      const session = createSession();

      const issues = session.addIssues(['', '   ', '']);

      expect(issues).toHaveLength(0);
      expect(session.getIssueList()).toHaveLength(0);
    });

    it('appends to existing issue list', () => {
      const session = createSession();
      session.addIssue('Existing issue');

      session.addIssues(['New 1', 'New 2']);

      const issues = session.getIssueList();
      expect(issues).toHaveLength(3);
      expect(issues[0].title).toBe('Existing issue');
      expect(issues[1].title).toBe('New 1');
      expect(issues[2].title).toBe('New 2');
    });
  });

  describe('reorderIssues', () => {
    it('reorders correctly', () => {
      const session = createSession();
      const i1 = session.addIssue('Issue 1');
      const i2 = session.addIssue('Issue 2');
      const i3 = session.addIssue('Issue 3');

      session.reorderIssues([i3.id, i1.id, i2.id]);

      const issues = session.getIssueList();
      expect(issues[0].title).toBe('Issue 3');
      expect(issues[1].title).toBe('Issue 1');
      expect(issues[2].title).toBe('Issue 2');
    });

    it('preserves issue data after reorder', () => {
      const session = createSession();
      const i1 = session.addIssue('Issue 1');
      const i2 = session.addIssue('Issue 2');

      session.reorderIssues([i2.id, i1.id]);

      const issues = session.getIssueList();
      expect(issues[0].id).toBe(i2.id);
      expect(issues[0].createdAt).toBe(i2.createdAt);
      expect(issues[1].id).toBe(i1.id);
      expect(issues[1].createdAt).toBe(i1.createdAt);
    });

    it('throws on mismatched IDs', () => {
      const session = createSession();
      const i1 = session.addIssue('Issue 1');
      session.addIssue('Issue 2');

      expect(() => session.reorderIssues([i1.id, 'non-existent-id'])).toThrow(
        'Reorder IDs must match current issue list'
      );
    });

    it('throws on wrong length', () => {
      const session = createSession();
      const i1 = session.addIssue('Issue 1');
      session.addIssue('Issue 2');

      expect(() => session.reorderIssues([i1.id])).toThrow(
        'Reorder IDs must match current issue list'
      );
    });

    it('throws on duplicate IDs in input', () => {
      const session = createSession();
      const i1 = session.addIssue('Issue 1');
      session.addIssue('Issue 2');

      expect(() => session.reorderIssues([i1.id, i1.id])).toThrow(
        'Reorder IDs must match current issue list'
      );
    });
  });

  describe('selectIssueForEstimation', () => {
    it('starts a round with the issue title', () => {
      const session = createSession();
      const issue = session.addIssue('Login feature');

      const round = session.selectIssueForEstimation(issue.id);

      expect(round.storyDescription).toBe('Login feature');
      expect(round.status).toBe('voting');
      expect(round.selections.size).toBe(0);
    });

    it('marks issue as estimating', () => {
      const session = createSession();
      const issue = session.addIssue('Login feature');

      session.selectIssueForEstimation(issue.id);

      const issues = session.getIssueList();
      const updated = issues.find(i => i.id === issue.id);
      expect(updated!.status).toBe('estimating');
    });

    it('throws if issue not found', () => {
      const session = createSession();

      expect(() => session.selectIssueForEstimation('non-existent')).toThrow(
        'Issue not found in list'
      );
    });

    it('does not affect other issues', () => {
      const session = createSession();
      const i1 = session.addIssue('Issue 1');
      const i2 = session.addIssue('Issue 2');

      session.selectIssueForEstimation(i1.id);

      const issues = session.getIssueList();
      const issue2 = issues.find(i => i.id === i2.id);
      expect(issue2!.status).toBe('pending');
    });
  });

  describe('getSessionState - issueList', () => {
    it('includes issueList in returned state', () => {
      const session = createSession();
      session.addIssue('Issue 1');
      session.addIssue('Issue 2');

      const state = session.getSessionState();

      expect(state.issueList).toBeDefined();
      expect(state.issueList).toHaveLength(2);
      expect(state.issueList[0].title).toBe('Issue 1');
      expect(state.issueList[1].title).toBe('Issue 2');
    });

    it('returns empty issueList when no issues exist', () => {
      const session = createSession();

      const state = session.getSessionState();

      expect(state.issueList).toEqual([]);
    });

    it('reflects issue status changes', () => {
      const session = createSession();
      const issue = session.addIssue('Issue 1');
      session.selectIssueForEstimation(issue.id);

      const state = session.getSessionState();

      expect(state.issueList[0].status).toBe('estimating');
    });
  });
});
