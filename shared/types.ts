// Card value types
export type NumericCardValue = 0 | 1 | 2 | 3 | 5 | 8 | 13 | 21 | 34 | 55 | 89;
export type SpecialCardValue = 'coffee' | 'no-clue' | 'break';
export type CardValue = NumericCardValue | SpecialCardValue;

// Card value constants
export const FIBONACCI_SEQUENCE: NumericCardValue[] = [0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89];
export const SPECIAL_CARDS: SpecialCardValue[] = ['coffee', 'no-clue', 'break'];
export const ALL_CARDS: CardValue[] = [...FIBONACCI_SEQUENCE, ...SPECIAL_CARDS];

// User
export interface User {
  id: string;           // UUID
  displayName: string;
  role: 'moderator' | 'participant';
  isAnonymous: boolean;
}

// Voting Round
export interface VotingRound {
  id: string;           // UUID
  storyDescription: string;
  status: 'voting' | 'revealed' | 'completed';
  selections: Map<string, CardValue>;  // userId -> cardValue
  startedAt: string;    // ISO 8601
  revealedAt?: string;  // ISO 8601
  votingDurationMs?: number; // computed on reveal: revealedAt - startedAt
}

// Participant Vote
export interface ParticipantVote {
  userId: string;
  displayName: string;
  cardValue: CardValue | null;  // null = no vote
}

// Voting Metrics
export interface VotingMetrics {
  average: number | null;
  mode: CardValue | null;
  spread: number | null;
  distribution: Record<string, number>;  // cardValue -> count
  outliers: string[];                     // userIds
  numericVoteCount: number;
  insufficientData: boolean;
}

// History Entry
export interface HistoryEntry {
  roundId: string;
  storyDescription: string;
  participants: ParticipantVote[];
  metrics: VotingMetrics;
  completedAt: string;  // ISO 8601
  votingDurationMs?: number; // total voting time for this round
}

// Session State (full state for sync on reconnect)
export interface SessionState {
  currentRound: VotingRound | null;
  participants: User[];
  history: HistoryEntry[];
  isRevealed: boolean;
}

// WebSocket Message
export interface WebSocketMessage {
  event: string;
  data: any;
  timestamp: string;  // ISO 8601
}

// --- Multi-Team Session Types ---

// Voting system types
export type VotingSystemType = 'fibonacci' | 'modified-fibonacci' | 't-shirt' | 'power-of-2';

// Extended CardValue to support all voting systems
export type ExtendedCardValue =
  | NumericCardValue
  | SpecialCardValue
  | '½'
  | 20 | 40 | 100
  | 4 | 16 | 32 | 64
  | 'XS' | 'S' | 'M' | 'L' | 'XL' | 'XXL';

// Voting system card value mappings
export const VOTING_SYSTEMS: Record<VotingSystemType, ExtendedCardValue[]> = {
  'fibonacci': [0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89],
  'modified-fibonacci': [0, '½', 1, 2, 3, 5, 8, 13, 20, 40, 100],
  't-shirt': ['XS', 'S', 'M', 'L', 'XL', 'XXL'],
  'power-of-2': [0, 1, 2, 4, 8, 16, 32, 64],
};

// Permission types
export type PermissionMode = 'moderator-only' | 'all-players' | 'select-specific';

export interface PermissionConfig {
  mode: PermissionMode;
  allowedUserIds: string[]; // only used when mode is 'select-specific'
}

// Session configuration
export interface SessionConfiguration {
  votingSystem: VotingSystemType;
  revealPermission: PermissionConfig;
  issuePermission: PermissionConfig;
  autoReveal: boolean;
  countdownAnimation: boolean;
  gameName?: string;
}

// Default session configuration
export const DEFAULT_SESSION_CONFIG: SessionConfiguration = {
  votingSystem: 'fibonacci',
  revealPermission: { mode: 'moderator-only', allowedUserIds: [] },
  issuePermission: { mode: 'moderator-only', allowedUserIds: [] },
  autoReveal: false,
  countdownAnimation: true,
};

// Issue item in the session's issue list
export interface IssueItem {
  id: string;           // UUID
  title: string;
  status: 'pending' | 'estimating' | 'estimated';
  historyEntryId?: string;  // Links to the HistoryEntry when estimated
  createdAt: string;    // ISO 8601
}

// Session summary for the "my sessions" list
export interface SessionSummary {
  sessionId: string;
  createdAt: string;
  lastActivityAt: string;
  completedRounds: number;
  participantCount: number;
  config: SessionConfiguration;
}

// Consensus level type
export type ConsensusLevel = 'full' | 'partial' | 'high-divergence' | 'none';

// Game session state (extends existing SessionState)
export interface GameSessionState extends SessionState {
  sessionId: string;
  config: SessionConfiguration;
  ownerId: string;
  createdAt: string;
  issueList: IssueItem[];
}

// Session info (returned by REST API)
export interface SessionInfo {
  sessionId: string;
  config: SessionConfiguration;
  participantCount: number;
  createdAt: string;
  ownerId: string;
}

// --- Helper Functions ---

/**
 * Returns the card values for a given voting system, including special cards.
 */
export function getCardsForVotingSystem(system: VotingSystemType): ExtendedCardValue[] {
  const systemCards = VOTING_SYSTEMS[system];
  return [...systemCards, ...SPECIAL_CARDS];
}

/**
 * Evaluates whether a user has permission based on their role and the permission configuration.
 */
export function hasPermission(
  userId: string,
  userRole: 'moderator' | 'participant',
  permissionConfig: PermissionConfig
): boolean {
  switch (permissionConfig.mode) {
    case 'moderator-only':
      return userRole === 'moderator';
    case 'all-players':
      return true;
    case 'select-specific':
      return userRole === 'moderator' || permissionConfig.allowedUserIds.includes(userId);
  }
}

/**
 * Formats a duration in milliseconds as MM:SS.
 */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/**
 * Compute consensus level from voting metrics.
 * - 'full': all numeric voters agree (spread === 0, numericVoteCount >= 2)
 * - 'high-divergence': spread > 5 for numeric systems, or position diff > 2 for t-shirt
 * - 'partial': between full and high-divergence
 * - 'none': insufficient data or no metrics
 */
export function computeConsensusLevel(
  metrics: VotingMetrics | null,
  votingSystem: VotingSystemType
): ConsensusLevel {
  if (!metrics || metrics.insufficientData) return 'none';
  if (metrics.spread === null) return 'none';
  if (metrics.numericVoteCount < 2) return 'none';
  if (metrics.spread === 0) return 'full';

  if (votingSystem === 't-shirt') {
    const T_SHIRT_ORDER = ['XS', 'S', 'M', 'L', 'XL', 'XXL'];
    const votedPositions = Object.keys(metrics.distribution)
      .filter(k => T_SHIRT_ORDER.includes(k))
      .map(k => T_SHIRT_ORDER.indexOf(k));
    if (votedPositions.length < 2) return 'none';
    const posSpread = Math.max(...votedPositions) - Math.min(...votedPositions);
    return posSpread > 2 ? 'high-divergence' : 'partial';
  }

  return metrics.spread > 5 ? 'high-divergence' : 'partial';
}
