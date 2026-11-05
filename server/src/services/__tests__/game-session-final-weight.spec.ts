import * as fc from 'fast-check';
import { DEFAULT_SESSION_CONFIG, ExtendedCardValue } from '../../../../shared/types';
import { GameSession } from '../game-session';

const CARDS: ExtendedCardValue[] = [0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89];

function newSession(votingSystem?: 'fibonacci' | 't-shirt'): GameSession {
  const s = new GameSession('s1', 'owner', {
    ...DEFAULT_SESSION_CONFIG,
    ...(votingSystem ? { votingSystem } : {}),
  });
  s.addParticipant({ id: 'u1', displayName: 'U1', role: 'participant', isAnonymous: false });
  return s;
}

function revealedSession(story = 'Story'): { s: GameSession; roundId: string } {
  const s = newSession();
  const round = s.startRound(story);
  s.selectCard('u1', 5);
  s.revealCards();
  return { s, roundId: round.id };
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return 'NO_THROW';
}

describe('GameSession final weight', () => {
  // Feature: final-weight-accuracy, Property 7: History entry carries the weight only when set
  // **Validates: Requirements 4.15, 11.7, 11.8**
  it('Property 7: history entry carries the weight only when set', () => {
    fc.assert(
      fc.property(
        fc.option(
          fc.record({
            value: fc.constantFrom(...CARDS),
            showFunniest: fc.boolean(),
          }),
          { nil: undefined },
        ),
        fc.string({ minLength: 1 }).filter((x) => x.trim().length > 0),
        (weight, story) => {
          const { s, roundId } = (() => {
            const sess = newSession();
            const r = sess.startRound(story);
            sess.selectCard('u1', 5);
            sess.revealCards();
            return { s: sess, roundId: r.id };
          })();
          let record;
          if (weight) {
            record = s.setFinalWeight(roundId, weight.value, weight.showFunniest).record;
          }
          const entry = s.clearBoard();
          if (record) {
            expect(entry.finalWeight).toEqual(record);
          } else {
            expect('finalWeight' in entry).toBe(false);
          }
          expect(s.getHistory()[0]).toBe(entry);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('accepts and keeps weight 0', () => {
    const { s, roundId } = revealedSession();
    s.setFinalWeight(roundId, 0, false);
    expect(s.getCurrentRound()!.finalWeight?.value).toBe(0);
    const entry = s.clearBoard();
    expect(entry.finalWeight?.value).toBe(0);
    expect('finalWeight' in entry).toBe(true);
  });

  it('last valid submit wins', () => {
    const { s, roundId } = revealedSession();
    s.setFinalWeight(roundId, 3, false);
    s.setFinalWeight(roundId, 8, true);
    const entry = s.clearBoard();
    expect(entry.finalWeight).toEqual({ value: 8, votingSystem: 'fibonacci', showFunniest: true });
  });

  it('sets on the newest history entry after clear', () => {
    const { s, roundId } = revealedSession();
    s.clearBoard();
    const res = s.setFinalWeight(roundId, 13, false);
    expect(res.target).toBe('history');
    expect(s.getHistory()[0].finalWeight?.value).toBe(13);
  });

  it('rejects older history entries with ROUND_NOT_FOUND', () => {
    const { s, roundId: oldId } = revealedSession('A');
    s.clearBoard();
    s.startRound('B');
    s.selectCard('u1', 3);
    s.revealCards();
    s.clearBoard();
    expect(codeOf(() => s.setFinalWeight(oldId, 5, false))).toBe('ROUND_NOT_FOUND');
    expect(s.getHistory()[1].finalWeight).toBeUndefined();
  });

  it('rejects unknown round ids', () => {
    const { s } = revealedSession();
    expect(codeOf(() => s.setFinalWeight('nope', 5, false))).toBe('ROUND_NOT_FOUND');
  });

  it('rejects a round still in voting state', () => {
    const s = newSession();
    const round = s.startRound('Story');
    expect(codeOf(() => s.setFinalWeight(round.id, 5, false))).toBe('ROUND_NOT_FOUND');
    expect(s.getCurrentRound()!.finalWeight).toBeUndefined();
  });

  it('copies the weight to the issue for a current round', () => {
    const s = newSession();
    const issue = s.addIssue('Issue 1');
    const round = s.selectIssueForEstimation(issue.id);
    s.selectCard('u1', 5);
    s.revealCards();
    const res = s.setFinalWeight(round.id, 8, false);
    expect(res.target).toBe('current');
    expect(res.issue?.finalWeight).toBe(8);
    expect(s.getIssueList()[0].finalWeight).toBe(8);
  });

  it('copies the weight to the issue for a history entry', () => {
    const s = newSession();
    const issue = s.addIssue('Issue 1');
    const round = s.selectIssueForEstimation(issue.id);
    s.selectCard('u1', 5);
    s.revealCards();
    const entry = s.clearBoard();
    s.markIssueEstimated(issue.id, entry.roundId);
    const res = s.setFinalWeight(round.id, 21, false);
    expect(res.target).toBe('history');
    expect(res.issue?.finalWeight).toBe(21);
    expect(s.getIssueList()[0].finalWeight).toBe(21);
  });

  it('revote clears the issue finalWeight', () => {
    const s = newSession();
    const issue = s.addIssue('Issue 1');
    const round = s.selectIssueForEstimation(issue.id);
    s.selectCard('u1', 5);
    s.revealCards();
    s.setFinalWeight(round.id, 8, false);
    expect(s.getIssueList()[0].finalWeight).toBe(8);
    const next = s.revote();
    expect('finalWeight' in s.getIssueList()[0]).toBe(false);
    expect(next.finalWeight).toBeUndefined();
  });

  it('stores the votingSystem in force at set time', () => {
    const { s, roundId } = revealedSession();
    const { record } = s.setFinalWeight(roundId, 5, true);
    expect(record).toEqual({ value: 5, votingSystem: 'fibonacci', showFunniest: true });
    s.updateConfig({ votingSystem: 't-shirt' });
    const { record: r2 } = s.setFinalWeight(roundId, 5, false);
    expect(r2.votingSystem).toBe('t-shirt');
    expect(s.clearBoard().finalWeight?.votingSystem).toBe('t-shirt');
  });
});
