import rawGameConfig from '../config/game.config.json';
import rawVoiceConfig from '../config/voice.config.json';
import { GameSettings, PlayerConfig, TargetWinsOption } from '../types/game';

export interface AppGameConfig {
  appTitle: string;
  appSubtitle: string;
  defaults: GameSettings;
  options: {
    targetWins: TargetWinsOption[];
    duelDurations: number[];
    soloDurations: number[];
    draftCardsCount: number;
    preloaderWindowSize: number;
    correctFlashDurationMs: number;
    voiceCooldownMs: number;
    urgentThresholdSeconds: number;
  };
  players: {
    defaultP1: PlayerConfig;
    defaultP2: PlayerConfig;
    avatars: string[];
  };
  network: {
    peerPrefix: string;
    roomCodeLength: number;
    roomCodeAlphabet: string;
    imageBackupProxyTemplate: string;
  };
}

export interface AppVoiceConfig {
  language: string;
  maxAlternatives: number;
  stopwords: string[];
  genericTokens?: string[];
  numberMap: Record<string, string>;
  romanNumeralsMap?: Record<string, string>;
  passKeywords: string[];
  phoneticReplacements: [string, string][];
  thresholds: {
    acceptConfidence: number;
    interimAcceptConfidence?: number;
    instantConfidence: number;
    shortWordMaxLength: number;
    mediumWordMaxLength: number;
    fuzzyMinLength?: number;
    maxLengthDifference: number;
    relativeLengthRatio?: number;
    partialMatchPenalty?: number;
    alternativeRankPenalties?: number[];
  };
}

export const gameConfig: AppGameConfig = rawGameConfig as unknown as AppGameConfig;
export const voiceConfig: AppVoiceConfig = rawVoiceConfig as unknown as AppVoiceConfig;
