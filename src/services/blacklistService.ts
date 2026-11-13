import staticBlacklistData from '../data/blacklist.json';

export interface FlaggedImageRecord {
  url: string;
  canonicalKey: string;
  itemId?: string;
  answer?: string;
  timestamp: number;
  reason?: string;
}

export interface BlacklistSchema {
  version: number;
  blacklistedUrls: string[];
  blacklistedItemIds: string[];
  forbiddenKeywords: string[];
  reports?: Array<{
    url: string;
    itemId?: string;
    answer?: string;
    reason?: string;
    timestamp: number;
  }>;
}

const STORAGE_KEY = 'yappik_flagged_images_v1';

/**
 * Se l'URL è incapsulato nel proxy backup (wsrv.nl / /.proxy/wsrv), estrae l'URL originario.
 */
export function unwrapProxyImageUrl(rawUrl: string): string {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  let current = rawUrl.trim();
  for (let depth = 0; depth < 3; depth++) {
    try {
      const normalized = current.startsWith('/.proxy/wsrv')
        ? `https://wsrv.nl${current.slice('/.proxy/wsrv'.length)}`
        : current;
      const parsed = new URL(normalized);
      if (parsed.hostname === 'wsrv.nl') {
        const inner = parsed.searchParams.get('url');
        if (inner && inner !== current) {
          current = inner;
          continue;
        }
      }
    } catch {
      // Non è un URL completo o non è un proxy
    }
    break;
  }
  return current;
}

/**
 * Estrae una chiave canonica univoca per l'immagine.
 * Se è un URL di Wikimedia Commons o Wikipedia, estrae il nome file originale
 * (es. "Tetraodon-hispidus.jpg"), consentendo di intercettare sia i thumbnail
 * che i file diretti con un'unica voce di blacklist.
 */
export function getCanonicalImageKey(url: string): string {
  if (!url || typeof url !== 'string') return '';
  const unwrapped = unwrapProxyImageUrl(url);
  if (!unwrapped) return '';
  // Guard: non creare mai una chiave canonica per il root di wsrv.nl
  const cleanUrl = unwrapped.trim().split('?')[0].split('#')[0];
  if (!cleanUrl || /^https?:\/\/wsrv\.nl\/?$/i.test(cleanUrl)) return '';

  // Pattern Wikimedia Commons / Wikipedia:
  // upload.wikimedia.org/wikipedia/commons/thumb/c/ce/Tetraodon-hispidus.jpg/960px-Tetraodon-hispidus.jpg
  // upload.wikimedia.org/wikipedia/commons/c/ce/Tetraodon-hispidus.jpg
  const wikiMatch = cleanUrl.match(
    /\/wikipedia\/(?:commons|[a-z]{2,3})\/(?:thumb\/)?[0-9a-f]\/[0-9a-f]{2}\/([^/?#]+)/i
  );

  if (wikiMatch && wikiMatch[1]) {
    try {
      const decoded = decodeURIComponent(wikiMatch[1]).toLowerCase();
      return `commons:${decoded}`;
    } catch {
      return `commons:${wikiMatch[1].toLowerCase()}`;
    }
  }

  return cleanUrl.toLowerCase();
}

class BlacklistService {
  private staticKeys = new Set<string>();
  private staticItemIds = new Set<string>();
  private userFlags: Map<string, FlaggedImageRecord> = new Map();
  private listeners: Set<() => void> = new Set();
  private initialized = false;

  constructor() {
    this.initStaticData();
    this.loadUserFlags();
  }

  private initStaticData() {
    const data = staticBlacklistData as BlacklistSchema;
    if (Array.isArray(data.blacklistedUrls)) {
      for (const url of data.blacklistedUrls) {
        const key = getCanonicalImageKey(url);
        if (key) this.staticKeys.add(key);
      }
    }
    if (Array.isArray(data.blacklistedItemIds)) {
      for (const id of data.blacklistedItemIds) {
        if (id) this.staticItemIds.add(id);
      }
    }
  }

  private loadUserFlags() {
    if (typeof window === 'undefined' || !window.localStorage) {
      this.initialized = true;
      return;
    }

    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (item && item.canonicalKey) {
              this.userFlags.set(item.canonicalKey, item);
            } else if (item && item.url) {
              const key = getCanonicalImageKey(item.url);
              this.userFlags.set(key, {
                ...item,
                canonicalKey: key,
              });
            }
          }
        }
      }
    } catch (e) {
      console.warn('[BlacklistService] Error loading user flags from localStorage', e);
    }
    this.initialized = true;
  }

  private saveUserFlags() {
    if (typeof window === 'undefined' || !window.localStorage) return;
    try {
      const list = Array.from(this.userFlags.values());
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
      this.notifyListeners();
    } catch (e) {
      console.warn('[BlacklistService] Error saving user flags to localStorage', e);
    }
  }

  private notifyListeners() {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (e) {
        console.error('[BlacklistService] Error in change listener', e);
      }
    }
  }

  /**
   * Iscrive un listener per gli aggiornamenti di blacklist. Restituisce la funzione di disiscrizione.
   */
  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Verifica se un URL fotografico è presente nella blacklist (statica o runtime dell'utente).
   */
  public isBlacklisted(url: string): boolean {
    if (!url) return false;
    const key = getCanonicalImageKey(url);
    if (!key) return false;
    return this.staticKeys.has(key) || this.userFlags.has(key);
  }

  /**
   * Verifica se un ID elemento è presente nella blacklist.
   */
  public isItemBlacklisted(itemId: string): boolean {
    if (!itemId) return false;
    return this.staticItemIds.has(itemId);
  }

  /**
   * Segnala una foto inadatta o errata. La inserisce istantaneamente nella blacklist
   * locale così che non venga più mostrata durante le partite e persista in localStorage.
   */
  public flagImage(
    url: string,
    meta?: { itemId?: string; answer?: string; reason?: string }
  ): void {
    if (!url) return;
    const realUrl = unwrapProxyImageUrl(url);
    const key = getCanonicalImageKey(realUrl);
    if (!key) return;

    const record: FlaggedImageRecord = {
      url: realUrl.trim(),
      canonicalKey: key,
      itemId: meta?.itemId,
      answer: meta?.answer,
      reason: meta?.reason || 'user_reported',
      timestamp: Date.now(),
    };

    this.userFlags.set(key, record);
    this.saveUserFlags();
  }

  /**
   * Rimuove una segnalazione dell'utente per un dato URL.
   */
  public unflagImage(url: string): void {
    if (!url) return;
    const key = getCanonicalImageKey(url);
    if (this.userFlags.delete(key)) {
      this.saveUserFlags();
    }
  }

  /**
   * Restituisce il conteggio totale delle foto segnalate dall'utente in locale.
   */
  public getFlaggedCount(): number {
    return this.userFlags.size;
  }

  /**
   * Restituisce l'elenco delle segnalazioni effettuate dall'utente.
   */
  public getFlaggedImages(): FlaggedImageRecord[] {
    return Array.from(this.userFlags.values());
  }

  /**
   * Pulisce tutte le segnalazioni salvate in locale.
   */
  public clearUserFlags(): void {
    this.userFlags.clear();
    if (typeof window !== 'undefined' && window.localStorage) {
      try {
        window.localStorage.removeItem(STORAGE_KEY);
      } catch {
        // noop
      }
    }
    this.notifyListeners();
  }

  /**
   * Esporta il file JSON completo con blacklist statica + segnalazioni utente,
   * formattato per essere integrato direttamente nel repository.
   */
  public exportBlacklistJson(): string {
    const rawStatic = staticBlacklistData as BlacklistSchema;
    const combinedUrls = new Set<string>(rawStatic.blacklistedUrls || []);

    const userReports: BlacklistSchema['reports'] = [
      ...(rawStatic.reports || []),
    ];

    for (const record of this.userFlags.values()) {
      combinedUrls.add(record.url);
      userReports.push({
        url: record.url,
        itemId: record.itemId,
        answer: record.answer,
        reason: record.reason,
        timestamp: record.timestamp,
      });
    }

    const merged: BlacklistSchema = {
      version: 1,
      blacklistedUrls: Array.from(combinedUrls),
      blacklistedItemIds: Array.from(new Set(rawStatic.blacklistedItemIds || [])),
      forbiddenKeywords: rawStatic.forbiddenKeywords || [],
      reports: userReports,
    };

    return JSON.stringify(merged, null, 2);
  }
}

export const blacklistService = new BlacklistService();
