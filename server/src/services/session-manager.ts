import { v4 as uuidv4 } from 'uuid';
import {
  User,
  VotingRound,
  CardValue,
  VotingMetrics,
  HistoryEntry,
  ParticipantVote,
  SessionState,
} from '../../../shared/types';
import { calculate } from './metrics-engine';

/**
 * Result returned when cards are revealed.
 * Contains the selections map and the computed voting metrics.
 */
export interface RevealResult {
  selections: Map<string, CardValue>;
  metrics: VotingMetrics;
}

// Internal state
let participants: Map<string, User> = new Map();
let currentRound: VotingRound | null = null;
let history: HistoryEntry[] = [];

/**
 * Add a participant to the session.
 * If a participant with the same id already exists, they are replaced (reconnect scenario).
 */
export function addParticipant(user: User): void {
  participants.set(user.id, user);
}

/**
 * Remove a participant from the session by userId.
 */
export function removeParticipant(userId: string): void {
  participants.delete(userId);
}

/**
 * Get the list of all current participants.
 */
export function getParticipants(): User[] {
  return Array.from(participants.values());
}

/**
 * Start a new voting round with the given story description.
 * Throws if the story description is empty or whitespace-only.
 */
export function startRound(storyDescription: string): VotingRound {
  const trimmed = storyDescription.trim();
  if (trimmed.length === 0) {
    throw new Error('Story description must not be empty');
  }

  currentRound = {
    id: uuidv4(),
    storyDescription: trimmed,
    status: 'voting',
    selections: new Map(),
    startedAt: new Date().toISOString(),
  };

  return currentRound;
}

/**
 * Get the current voting round, or null if none is active.
 */
export function getCurrentRound(): VotingRound | null {
  return currentRound;
}

/**
 * Record a card selection for a user.
 * Ignored if there is no active round or the round is already revealed.
 * Last-write-wins: selecting again replaces the previous selection.
 */
export function selectCard(userId: string, cardValue: CardValue): void {
  if (!currentRound || currentRound.status !== 'voting') {
    return;
  }
  currentRound.selections.set(userId, cardValue);
}

/**
 * Get the current selections map.
 * Returns an empty map if no round is active.
 */
export function getSelections(): Map<string, CardValue> {
  if (!currentRound) {
    return new Map();
  }
  return currentRound.selections;
}

/**
 * Reveal all cards for the current round.
 * Changes round status to 'revealed' and computes metrics via MetricsEngine.
 * Throws if there is no active round or the round is already revealed.
 */
export function revealCards(): RevealResult {
  if (!currentRound) {
    throw new Error('No active voting round');
  }
  if (currentRound.status === 'revealed') {
    throw new Error('Cards have already been revealed');
  }

  currentRound.status = 'revealed';
  currentRound.revealedAt = new Date().toISOString();

  const metrics = calculate(currentRound.selections);

  return {
    selections: currentRound.selections,
    metrics,
  };
}

/**
 * Clear the board: save the current round to history (newest-first)
 * and reset the current round to null.
 * Throws if there is no current round.
 */
export function clearBoard(): HistoryEntry {
  if (!currentRound) {
    throw new Error('No active voting round to clear');
  }

  // Build participant votes from current participants and selections
  const participantVotes: ParticipantVote[] = getParticipants().map((user) => ({
    userId: user.id,
    displayName: user.displayName,
    cardValue: currentRound!.selections.get(user.id) ?? null,
  }));

  const metrics = calculate(currentRound.selections);

  const entry: HistoryEntry = {
    roundId: currentRound.id,
    storyDescription: currentRound.storyDescription,
    participants: participantVotes,
    metrics,
    completedAt: new Date().toISOString(),
  };

  // Prepend to history (newest-first)
  history.unshift(entry);

  // Reset current round
  currentRound = null;

  return entry;
}

/**
 * Get the session history (newest-first ordering).
 */
export function getHistory(): HistoryEntry[] {
  return history;
}

/**
 * Clear all session history entries.
 */
export function clearHistory(): void {
  history = [];
}

/**
 * Get the full session state for reconnect sync.
 */
export function getSessionState(): SessionState {
  return {
    currentRound,
    participants: getParticipants(),
    history,
    isRevealed: currentRound?.status === 'revealed',
  };
}

/**
 * Reset all session state. Used for test isolation.
 */
export function _reset(): void {
  participants = new Map();
  currentRound = null;
  history = [];
}
