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

// --- Retrospective Board Types ---

// Column layout type
export type ColumnLayout = 'vertical' | 'horizontal';

// --- Retro Participant Feelings Types ---

// Feeling categories available for selection
export type FeelingCategory =
  | 'Satisfaction'
  | 'Frustration'
  | 'Confidence'
  | 'Confusion'
  | 'Boredom'
  | 'Happy'
  | 'No_Feeling'
  | 'Glad'
  | 'Sad'
  | 'Mad';

export const ALL_FEELING_CATEGORIES: FeelingCategory[] = [
  'Satisfaction', 'Frustration', 'Confidence', 'Confusion',
  'Boredom', 'Happy', 'No_Feeling', 'Glad', 'Sad', 'Mad',
];

// Emoji mapping for each feeling category
export const FEELING_EMOJI_MAP: Record<FeelingCategory, string> = {
  Satisfaction: '😌',
  Frustration: '😤',
  Confidence: '💪',
  Confusion: '😕',
  Boredom: '😴',
  Happy: '😊',
  No_Feeling: '😶',
  Glad: '😄',
  Sad: '😢',
  Mad: '😠',
};

export const DEFAULT_ALLOWED_FEELINGS: FeelingCategory[] = ['Happy', 'Sad', 'No_Feeling'];

// WebSocket event type constants for feelings
export const RETRO_FEELING_SELECT = 'retro:feeling:select';
export const RETRO_FEELING_UPDATED = 'retro:feeling:updated';

// Retrospective board configuration
export interface RetroConfiguration {
  boardName: string;
  maxVotesPerUser: number;                // default: 6, positive integer
  templateId: string;                     // references a template
  hideCardsInitially: boolean;            // default: false
  disableVotingInitially: boolean;        // default: false
  hideVoteCount: boolean;                 // default: false
  oneVotePerCard: boolean;                // default: false
  showCardAuthor: boolean;                // default: false
  password: string | null;                // null = no password
  enableGifEmoji: boolean;               // default: true
  columnLayout: ColumnLayout;             // default: 'vertical'
  allowedFeelings: FeelingCategory[];     // ordered list of allowed feelings, min 1, max 10
}

// Retrospective template definition
export interface RetroTemplate {
  id: string;           // kebab-case identifier
  name: string;         // display name
  columns: string[];    // ordered column names
}

// Retrospective board state
export interface RetroBoard {
  columns: RetroColumn[];
  context: string;                        // sprint context description
  cardsRevealed: boolean;                 // moderator has revealed cards
  votingEnabled: boolean;                 // moderator has enabled voting
  isCompleted: boolean;                   // board is locked
}

// Retrospective column
export interface RetroColumn {
  id: string;           // UUID
  name: string;
  cards: RetroCard[];
  order: number;        // position index
}

// Retrospective card
export interface RetroCard {
  id: string;           // UUID
  text: string;
  authorId: string;     // userId of creator
  authorName: string;   // display name of creator
  votes: number;        // total vote count
  votedBy: string[];    // userIds who voted on this card
  comments: RetroComment[];
  columnId: string;     // parent column reference
  order: number;        // position within column
  createdAt: string;    // ISO 8601
}

// Retrospective comment
export interface RetroComment {
  id: string;           // UUID
  text: string;
  authorId: string;
  authorName: string;
  createdAt: string;    // ISO 8601
}

// Retrospective session state (full state for sync)
export interface RetroSessionState {
  sessionId: string;
  config: RetroConfiguration;
  board: RetroBoard;
  participants: User[];              // reuses existing User type
  ownerId: string;
  createdAt: string;
  votesRemaining: Record<string, number>; // userId -> remaining votes
  feelings: Record<string, FeelingCategory | null>; // userId -> selected feeling or null
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
