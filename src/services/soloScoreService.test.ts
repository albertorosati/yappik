import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { soloScoreService } from './soloScoreService';

describe('soloScoreService', () => {
  let store: Record<string, string> = {};

  beforeEach(() => {
    store = {};
    const mockLocalStorage = {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => {
        store[key] = value.toString();
      },
      removeItem: (key: string) => {
        delete store[key];
      },
      clear: () => {
        store = {};
      },
      get length() {
        return Object.keys(store).length;
      },
      key: (i: number) => Object.keys(store)[i] ?? null,
    };

    (globalThis as unknown as { window: unknown }).window = {
      localStorage: mockLocalStorage,
    };
    (globalThis as unknown as { localStorage: unknown }).localStorage = mockLocalStorage;
  });

  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window;
  });

  it('returns 0 when no record is stored', () => {
    expect(soloScoreService.getSoloBest('bandiere-del-mondo')).toBe(0);
  });

  it('saves new personal best and returns true for isNewBest', () => {
    const res = soloScoreService.saveSoloBest('bandiere-del-mondo', 12);
    expect(res.isNewBest).toBe(true);
    expect(res.previousBest).toBe(0);
    expect(soloScoreService.getSoloBest('bandiere-del-mondo')).toBe(12);
  });

  it('does not overwrite higher record with a lower score', () => {
    soloScoreService.saveSoloBest('bandiere-del-mondo', 15);
    const res = soloScoreService.saveSoloBest('bandiere-del-mondo', 10);
    expect(res.isNewBest).toBe(false);
    expect(res.previousBest).toBe(15);
    expect(soloScoreService.getSoloBest('bandiere-del-mondo')).toBe(15);
  });

  it('updates when a strictly higher score is achieved', () => {
    soloScoreService.saveSoloBest('calciatori', 8);
    const res = soloScoreService.saveSoloBest('calciatori', 14);
    expect(res.isNewBest).toBe(true);
    expect(res.previousBest).toBe(8);
    expect(soloScoreService.getSoloBest('calciatori')).toBe(14);
  });

  it('scopes records separately per duration while preserving 60s legacy fallback', () => {
    soloScoreService.saveSoloBest('calcio', 20);
    expect(soloScoreService.getSoloBest('calcio', 60)).toBe(20);
    expect(soloScoreService.getSoloBest('calcio', 45)).toBe(0);

    soloScoreService.saveSoloBest('calcio', 11, 30);
    soloScoreService.saveSoloBest('calcio', 25, 90);
    expect(soloScoreService.getSoloBest('calcio', 30)).toBe(11);
    expect(soloScoreService.getSoloBest('calcio', 90)).toBe(25);
    expect(soloScoreService.getSoloBest('calcio', 60)).toBe(20);
  });
});
