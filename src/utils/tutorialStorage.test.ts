import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  TUTORIAL_DISMISSED_STORAGE_KEY,
  TUTORIAL_SESSION_STORAGE_KEY,
  isTutorialDismissedForever,
  setTutorialDismissedForever,
  markTutorialSeenThisSession,
  shouldAutoOpenTutorial,
} from './tutorialStorage';

function createMemoryStorage() {
  const store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value.toString();
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      for (const k of Object.keys(store)) delete store[k];
    },
  };
}

describe('tutorialStorage', () => {
  beforeEach(() => {
    (globalThis as unknown as { localStorage: unknown }).localStorage = createMemoryStorage();
    (globalThis as unknown as { sessionStorage: unknown }).sessionStorage = createMemoryStorage();
  });

  afterEach(() => {
    delete (globalThis as unknown as { localStorage?: unknown }).localStorage;
    delete (globalThis as unknown as { sessionStorage?: unknown }).sessionStorage;
  });

  it('auto-opens tutorial on first visit', () => {
    expect(isTutorialDismissedForever()).toBe(false);
    expect(shouldAutoOpenTutorial()).toBe(true);
  });

  it('stops auto-opening in the same session after markTutorialSeenThisSession', () => {
    markTutorialSeenThisSession();
    expect(sessionStorage.getItem(TUTORIAL_SESSION_STORAGE_KEY)).toBe('1');
    expect(shouldAutoOpenTutorial()).toBe(false);
    expect(isTutorialDismissedForever()).toBe(false);
  });

  it('persists permanent dismissal and allows re-enabling', () => {
    setTutorialDismissedForever(true);
    expect(localStorage.getItem(TUTORIAL_DISMISSED_STORAGE_KEY)).toBe('1');
    expect(isTutorialDismissedForever()).toBe(true);
    expect(shouldAutoOpenTutorial()).toBe(false);

    setTutorialDismissedForever(false);
    expect(isTutorialDismissedForever()).toBe(false);
    expect(shouldAutoOpenTutorial()).toBe(true);
  });
});
