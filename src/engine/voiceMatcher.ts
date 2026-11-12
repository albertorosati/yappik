import { DuelItem, VoiceMatchResult } from '../types/game';
import { voiceConfig } from '../services/configService';

const STOPWORDS = new Set([
  ...voiceConfig.stopwords,
  'the',
  'a',
  'an',
  'of',
  'in',
  'on',
  'at',
  'to',
  'for',
  'with',
  'by',
  'it',
  'is',
  'and',
  'this',
  'that',
]);

const NUMBER_MAP: Record<string, string> = {
  ...voiceConfig.numberMap,
  zero: '0',
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
  ten: '10',
};

const PASS_KEYWORDS = new Set([
  ...voiceConfig.passKeywords,
  'pass',
  'skip',
  'next',
]);

const GENERIC_TOKENS = new Set(
  (voiceConfig.genericTokens || []).map((t) => t.toLowerCase())
);

export interface EvaluateVoiceOptions {
  isFinal?: boolean;
}

interface CandidateEntry {
  text: string;
  isPartial: boolean;
}

export function normalizeText(raw: string): string {
  if (!raw) return '';
  let text = raw
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['’`\-_.,!?;:()/\\"+]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (voiceConfig.romanNumeralsMap) {
    for (const [roman, num] of Object.entries(voiceConfig.romanNumeralsMap)) {
      text = text.replace(new RegExp(`\\b${roman}\\b`, 'g'), num);
    }
  }

  const tokens = text
    .split(' ')
    .map((t) => NUMBER_MAP[t] ?? t)
    .filter((t) => t.length > 0 && t !== 'l' && !STOPWORDS.has(t));

  return tokens.join(' ');
}

export function phoneticSkeleton(normalized: string): string {
  if (!normalized) return '';
  let out = normalized;
  for (const [from, to] of voiceConfig.phoneticReplacements) {
    try {
      out = out.replace(new RegExp(from, 'g'), to);
    } catch {
      // Fallback per caratteri speciali
      out = out.split(from).join(to);
    }
  }
  return out.replace(/([a-z0-9])\1+/g, '$1');
}

export function italianStem(word: string): string {
  if (word.length < 4) return word;
  return word.replace(/[aeio]$/, '');
}

function isItalianPluralInflection(a: string, b: string): boolean {
  if (a.length < 4 || b.length < 4 || Math.abs(a.length - b.length) > 0) {
    return false;
  }
  if (a.slice(0, -1) !== b.slice(0, -1)) return false;
  const endA = a[a.length - 1];
  const endB = b[b.length - 1];
  const pair = [endA, endB].sort().join('');
  return pair === 'ae' || pair === 'ei' || pair === 'io';
}

function buildCandidateEntries(item: DuelItem): CandidateEntry[] {
  const byText = new Map<string, CandidateEntry>();
  const addCandidate = (rawText: string, isPartial: boolean) => {
    const trimmed = rawText.trim();
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    const existing = byText.get(key);
    if (!existing) {
      byText.set(key, { text: trimmed, isPartial });
    } else if (existing.isPartial && !isPartial) {
      // Un alias o risposta esplicita ha sempre priorità su una frammentazione parziale
      byText.set(key, { text: existing.text, isPartial: false });
    }
  };

  const rawList = [
    item.answer,
    ...(item.aliases || []),
    ...(item.answerEn ? [item.answerEn] : []),
    ...(item.aliasesEn || []),
  ];

  for (const raw of rawList) {
    if (!raw) continue;
    addCandidate(raw, false);

    // Sottotitoli delimitati da ":", "-", "–"
    const subParts = raw
      .split(/[:\-–]/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 3);
    for (const p of subParts) {
      addCandidate(p, false);
    }

    // Rimozione numeri o numeri romani in coda (es. "Titolo 3" -> "Titolo")
    const strippedTail = raw.replace(/\s+(?:[0-9]+|[ivxIVX]+)$/, '').trim();
    if (strippedTail && strippedTail !== raw && strippedTail.length >= 4) {
      addCandidate(strippedTail, false);
    }

    // Estrazione selettiva di singole parole SOLO se sufficientemente lunghe (>= 6)
    // e non presenti nella stop-list di token generici (evita falsi positivi di categoria/nomi comuni)
    const cleanWords = raw
      .split(/\s+/)
      .map((w) => w.replace(/[^a-zA-Z0-9]/g, ''))
      .filter((w) => {
        const lower = w.toLowerCase();
        return (
          w.length >= 6 &&
          !STOPWORDS.has(lower) &&
          !GENERIC_TOKENS.has(lower) &&
          !/^\d+$/.test(lower)
        );
      });
    for (const w of cleanWords) {
      addCandidate(w, true);
    }
  }

  // Generazione automatica acronimi se la risposta principale è composta da 3+ parole significative
  const mainTokens = item.answer
    .split(/\s+/)
    .map((w) => w.replace(/[^a-zA-Z0-9]/g, ''))
    .filter((w) => w.length > 1 && !STOPWORDS.has(w.toLowerCase()));
  if (mainTokens.length >= 3) {
    const acronym = mainTokens.map((w) => w[0].toLowerCase()).join('');
    if (acronym.length >= 3) {
      addCandidate(acronym, false);
    }
  }

  return Array.from(byText.values());
}

export function expandItemCandidates(item: DuelItem): string[] {
  return buildCandidateEntries(item).map((c) => c.text);
}

export function damerauLevenshtein(a: string, b: string): number {
  const lenA = a.length;
  const lenB = b.length;
  if (lenA === 0) return lenB;
  if (lenB === 0) return lenA;

  const dp: number[][] = Array.from({ length: lenA + 1 }, () =>
    new Array(lenB + 1).fill(0)
  );

  for (let i = 0; i <= lenA; i++) dp[i][0] = i;
  for (let j = 0; j <= lenB; j++) dp[0][j] = j;

  for (let i = 1; i <= lenA; i++) {
    for (let j = 1; j <= lenB; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
      if (
        i > 1 &&
        j > 1 &&
        a[i - 1] === b[j - 2] &&
        a[i - 2] === b[j - 1]
      ) {
        dp[i][j] = Math.min(dp[i][j], dp[i - 2][j - 2] + cost);
      }
    }
  }
  return dp[lenA][lenB];
}

function scoreCandidateMatch(spokenChunk: string, targetNorm: string): number {
  if (!spokenChunk || !targetNorm) return 0;

  if (spokenChunk === targetNorm) return 1.0;

  const spokenCompact = spokenChunk.replace(/\s+/g, '');
  const targetCompact = targetNorm.replace(/\s+/g, '');
  if (spokenCompact === targetCompact && targetCompact.length >= 3) {
    return 0.98;
  }

  // Flessione plurale/singolare stretta in italiano (es. cane/cani, forbice/forbici, mela/mele)
  if (isItalianPluralInflection(spokenCompact, targetCompact)) {
    return 0.95;
  }

  // Parole brevi (<= shortWordMaxLength, es. <= 4 lettere) non ammettono errori fuzzy: solo match esatto o plurale
  if (targetCompact.length <= voiceConfig.thresholds.shortWordMaxLength) {
    return 0;
  }

  if (
    targetCompact.length >= 6 &&
    italianStem(spokenCompact) === italianStem(targetCompact)
  ) {
    return 0.94;
  }

  const spokenPhon = phoneticSkeleton(spokenCompact);
  const targetPhon = phoneticSkeleton(targetCompact);
  if (spokenPhon === targetPhon && targetPhon.length >= 4) {
    return 0.95;
  }
  if (
    targetPhon.length >= 6 &&
    italianStem(spokenPhon) === italianStem(targetPhon)
  ) {
    return 0.92;
  }

  const fuzzyMinLen = voiceConfig.thresholds.fuzzyMinLength ?? 6;
  if (targetCompact.length < fuzzyMinLen) {
    return 0;
  }

  const distCompact = damerauLevenshtein(spokenCompact, targetCompact);
  const distPhon = damerauLevenshtein(spokenPhon, targetPhon);
  const minLen = Math.min(spokenCompact.length, targetCompact.length);
  const maxLen = Math.max(spokenCompact.length, targetCompact.length);

  const relativeRatio = voiceConfig.thresholds.relativeLengthRatio ?? 0.3;
  const maxDiff = Math.max(
    voiceConfig.thresholds.maxLengthDifference,
    Math.floor(maxLen * relativeRatio)
  );

  if (Math.abs(spokenCompact.length - targetCompact.length) > maxDiff) {
    return 0;
  }

  if (targetCompact.length <= voiceConfig.thresholds.mediumWordMaxLength) {
    if (
      (distCompact <= 1 || (distPhon <= 1 && minLen >= 5)) &&
      minLen >= fuzzyMinLen - 1
    ) {
      return 0.86;
    }
  } else {
    if (distCompact <= 2 || distPhon <= 2) {
      const bestDist = Math.min(distCompact, distPhon);
      return 1 - bestDist / maxLen;
    }
  }

  return 0;
}

export function evaluateVoiceInput(
  transcripts: string[],
  item: DuelItem,
  options?: EvaluateVoiceOptions
): VoiceMatchResult {
  const rawEntries = buildCandidateEntries(item);
  const candMap = new Map<string, CandidateEntry>();
  for (const entry of rawEntries) {
    const norm = normalizeText(entry.text);
    if (!norm) continue;
    const prev = candMap.get(norm);
    if (!prev || (prev.isPartial && !entry.isPartial)) {
      candMap.set(norm, { text: norm, isPartial: entry.isPartial });
    }
  }
  const candidates = Array.from(candMap.values());

  const acceptThreshold =
    options?.isFinal === false
      ? (voiceConfig.thresholds.interimAcceptConfidence ?? 0.91)
      : voiceConfig.thresholds.acceptConfidence;
  const rankPenalties = voiceConfig.thresholds.alternativeRankPenalties || [
    0, 0.02, 0.05, 0.09, 0.14,
  ];
  const partialPenalty = voiceConfig.thresholds.partialMatchPenalty ?? 0.06;

  let bestScore = 0;
  let bestAlias: string | undefined;
  let primaryNormalized = '';
  let passCommandDetected = false;

  for (let idx = 0; idx < transcripts.length; idx++) {
    const raw = transcripts[idx];
    if (!raw) continue;

    const cleanTokens = raw
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .trim()
      .split(/\s+/)
      .filter(Boolean);

    if (idx === 0) {
      primaryNormalized = cleanTokens.join(' ');
    }

    // Rileva comando PASSO solo nelle prime 2 ipotesi ASR (e solo in coda alla frase)
    // così ipotesi rumorose alt[3]/alt[4] non causano mai penalità -3s accidentali
    if (idx <= 1 && cleanTokens.length > 0 && !passCommandDetected) {
      const lastTok = cleanTokens[cleanTokens.length - 1];
      const tailTokens = cleanTokens.slice(-2);
      const isTailPass =
        PASS_KEYWORDS.has(lastTok) ||
        (cleanTokens.length <= 4 && tailTokens.some((tok) => PASS_KEYWORDS.has(tok)));
      if (isTailPass) {
        const targetHasPass = candidates.some((c) => c.text.includes('pass'));
        if (!targetHasPass) {
          passCommandDetected = true;
        }
      }
    }

    const normSpoken = normalizeText(raw);
    const spokenWords = normSpoken ? normSpoken.split(' ') : [];
    const rawCleanWords = cleanTokens;
    const altPenalty =
      rankPenalties[Math.min(idx, rankPenalties.length - 1)] ?? 0.14;

    const windows = new Set<string>();
    if (normSpoken) windows.add(normSpoken);
    if (primaryNormalized) windows.add(primaryNormalized);

    // Finestre dai token normalizzati
    for (let wSize = 1; wSize <= Math.min(5, spokenWords.length); wSize++) {
      for (let start = 0; start <= spokenWords.length - wSize; start++) {
        windows.add(spokenWords.slice(start, start + wSize).join(' '));
      }
    }

    // Finestre dai token raw prima del drop delle stopwords (es. "il the ring")
    for (let wSize = 1; wSize <= Math.min(5, rawCleanWords.length); wSize++) {
      for (let start = 0; start <= rawCleanWords.length - wSize; start++) {
        const chunk = rawCleanWords.slice(start, start + wSize).join(' ');
        if (wSize === 1 && STOPWORDS.has(chunk)) continue;
        windows.add(chunk);
      }
    }

    for (const candidate of candidates) {
      // Token ultra-brevi (<= 2 caratteri, es. acronimi "r6", "u2") validi solo su frasi concise
      const isUltraShort = candidate.text.replace(/\s+/g, '').length <= 2;
      if (isUltraShort && spokenWords.length > 2) {
        continue;
      }

      const specificityPenalty = candidate.isPartial ? partialPenalty : 0;

      for (const win of windows) {
        const rawScore = scoreCandidateMatch(win, candidate.text);
        if (rawScore <= 0) continue;

        const score = Math.max(0, rawScore - altPenalty - specificityPenalty);
        if (score > bestScore) {
          bestScore = score;
          bestAlias = candidate.text;
        }
        if (bestScore >= voiceConfig.thresholds.instantConfidence) {
          return {
            matched: true,
            isPassCommand: false,
            matchedAlias: bestAlias,
            confidenceScore: bestScore,
            normalizedHeard: primaryNormalized || normSpoken,
          };
        }
      }
    }
  }

  const accepted = bestScore >= acceptThreshold;
  if (!accepted && passCommandDetected) {
    return {
      matched: false,
      isPassCommand: true,
      confidenceScore: 1,
      normalizedHeard: primaryNormalized,
    };
  }

  return {
    matched: accepted,
    isPassCommand: false,
    matchedAlias: accepted ? bestAlias : undefined,
    confidenceScore: bestScore,
    normalizedHeard: primaryNormalized,
  };
}
