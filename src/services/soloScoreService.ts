/**
 * Servizio per il salvataggio e recupero dei record personali (High Scores)
 * per ciascuna categoria nella modalità Allenamento Solitario.
 */

const STORAGE_PREFIX = 'the_floor_solo_best_';

function makeBestKey(categoryId: string, durationSeconds?: number): string {
  if (typeof durationSeconds === 'number') {
    return `${STORAGE_PREFIX}${categoryId}_${durationSeconds}s`;
  }
  return `${STORAGE_PREFIX}${categoryId}`;
}

export const soloScoreService = {
  getSoloBest(categoryId: string, durationSeconds?: number): number {
    if (typeof window === 'undefined' || !window.localStorage) return 0;
    try {
      const val = localStorage.getItem(makeBestKey(categoryId, durationSeconds));
      if (val !== null) {
        return parseInt(val, 10) || 0;
      }
      // Fallback legacy solo per la durata classica 60s (così 30s/45s/90s/0s partono puliti)
      if (durationSeconds === 60) {
        const legacy = localStorage.getItem(`${STORAGE_PREFIX}${categoryId}`);
        return legacy ? parseInt(legacy, 10) || 0 : 0;
      }
      return 0;
    } catch {
      return 0;
    }
  },

  saveSoloBest(
    categoryId: string,
    score: number,
    durationSeconds?: number
  ): { isNewBest: boolean; previousBest: number } {
    const previousBest = this.getSoloBest(categoryId, durationSeconds);
    const isNewBest = score > previousBest;

    if (isNewBest && typeof window !== 'undefined' && window.localStorage) {
      try {
        localStorage.setItem(makeBestKey(categoryId, durationSeconds), String(score));
      } catch (err) {
        console.warn('Impossibile salvare il record personale su localStorage:', err);
      }
    }

    return { isNewBest, previousBest };
  },

  getAllSoloBests(): Record<string, number> {
    const results: Record<string, number> = {};
    if (typeof window === 'undefined' || !window.localStorage) return results;

    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith(STORAGE_PREFIX)) {
          const categoryId = key.substring(STORAGE_PREFIX.length);
          const score = parseInt(localStorage.getItem(key) || '0', 10);
          if (!isNaN(score)) {
            results[categoryId] = score;
          }
        }
      }
    } catch {
      // Ignore errors in sandboxed storage
    }

    return results;
  },

  resetSoloBests(): void {
    if (typeof window === 'undefined' || !window.localStorage) return;
    try {
      const keysToRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith(STORAGE_PREFIX)) {
          keysToRemove.push(key);
        }
      }
      keysToRemove.forEach((k) => localStorage.removeItem(k));
    } catch {
      // Ignore
    }
  },
};
