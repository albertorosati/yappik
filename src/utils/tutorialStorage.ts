export const TUTORIAL_DISMISSED_STORAGE_KEY = 'yappik_tutorial_dismissed';
export const TUTORIAL_SESSION_STORAGE_KEY = 'yappik_tutorial_seen_session';

/** Returns true if the user previously opted to hide the startup tutorial. */
export function isTutorialDismissedForever(): boolean {
  try {
    return localStorage.getItem(TUTORIAL_DISMISSED_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

/** Persists or clears permanent startup tutorial dismissal. */
export function setTutorialDismissedForever(dismissed: boolean): void {
  try {
    if (dismissed) {
      localStorage.setItem(TUTORIAL_DISMISSED_STORAGE_KEY, '1');
    } else {
      localStorage.removeItem(TUTORIAL_DISMISSED_STORAGE_KEY);
    }
  } catch {
    // Ignore storage errors in restricted contexts
  }
}

/** Marks the tutorial as already shown during the active browser tab session. */
export function markTutorialSeenThisSession(): void {
  try {
    sessionStorage.setItem(TUTORIAL_SESSION_STORAGE_KEY, '1');
  } catch {
    // Ignore sessionStorage errors
  }
}

/** Returns true when the tutorial should automatically appear on first load. */
export function shouldAutoOpenTutorial(): boolean {
  if (isTutorialDismissedForever()) return false;
  try {
    return sessionStorage.getItem(TUTORIAL_SESSION_STORAGE_KEY) !== '1';
  } catch {
    return true;
  }
}
