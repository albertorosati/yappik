export type PlayerId = string;
export type AppLanguage = 'it' | 'en';
export type CategoryScope = 'all' | 'intl' | 'it-only';
export type GameMode = 'solo' | 'duel' | 'party';

export interface PlayerConfig {
  id: PlayerId;
  name: string;
  avatar: string;
  score?: number;
}

export interface PartyPlayer extends PlayerConfig {
  wins: number;
  duelsPlayed: number;
  colorIndex?: number;
}

export interface SoloTrainingSummary {
  categoryId: string;
  categoryName: string;
  categoryIcon: string;
  totalCorrect: number;
  totalPasses: number;
  bestStreak: number;
  durationSeconds: number;
  timeLeft: number;
  isNewPersonalBest: boolean;
  previousBest: number;
}

export interface DuelItem {
  id: string;
  answer: string;
  aliases: string[];
  imageUrl: string;
  /** Pool di foto alternative per lo stesso soggetto (anti-memorizzazione del singolo scatto) */
  imageUrls?: string[];
  /** Risposta in inglese per duelli in lingua inglese */
  answerEn?: string;
  /** Sinonimi in lingua inglese */
  aliasesEn?: string[];
}

export interface Category {
  id: string;
  name: string;
  subtitle: string;
  nameEn?: string;
  subtitleEn?: string;
  icon: string;
  themeHex: string;
  coverImage?: string;
  previewImages?: string[];
  items: DuelItem[];
  isCustom?: boolean;
  /** 'intl' = internazionale disponibile in tutte le lingue; 'it-only' = esclusiva italiana (esclusa in inglese) */
  scope?: CategoryScope;
}

export type MicMode = 'local-shared' | 'discord-p2p';

/** 0 = Partita libera senza limite di punti */
export type TargetWinsOption = 3 | 5 | 7 | 0;

export interface GameSettings {
  mode: GameMode;
  targetWins: TargetWinsOption;
  duelDurationSeconds: number;
  soloDurationSeconds: number;
  passPenaltySeconds: number;
  micMode: MicMode;
  soundEnabled: boolean;
  announcerEnabled: boolean;
  hapticsEnabled: boolean;
  language: AppLanguage;
}

export interface DuelSummary {
  roundNumber: number;
  winner: PlayerId;
  loser: PlayerId;
  p1PlayerId?: string;
  p2PlayerId?: string;
  categoryId: string;
  categoryName: string;
  categoryIcon: string;
  winnerTimeLeft: number;
  p1Correct: number;
  p2Correct: number;
  p1Passes: number;
  p2Passes: number;
}

export interface VoiceMatchResult {
  matched: boolean;
  isPassCommand: boolean;
  matchedAlias?: string;
  confidenceScore: number;
  normalizedHeard: string;
}

export interface RemoteMicPacket {
  type:
    | 'TRANSCRIPT'
    | 'PASS_BUTTON'
    | 'MIC_LEVEL'
    | 'PING'
    | 'BYE'
    | 'STATE_UPDATE'
    | 'PLAYER_UPDATE';
  slot?: 'p1' | 'p2';
  transcript?: string;
  alternatives?: string[];
  isFinal?: boolean;
  micLevel?: number;
  activePlayer?: PlayerId;
  p1Name?: string;
  p2Name?: string;
  p1Avatar?: string;
  p2Avatar?: string;
  p1Connected?: boolean;
  p2Connected?: boolean;
  categoryName?: string;
  inDuel?: boolean;
  timeLeftP1?: number;
  timeLeftP2?: number;
  language?: AppLanguage;
  vocabulary?: string[];
  clearBufferSeq?: number;
}
