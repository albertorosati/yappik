import { DuelItem } from '../types/game';
import { blacklistService } from '../services/blacklistService';

const SEEN_ITEMS_STORAGE_KEY = 'yappik_seen_items_v1';
const LAST_PHOTO_STORAGE_KEY = 'yappik_last_photo_v1';
const MAX_SEEN_ENTRIES = 2500;

let seenSeq = 0;

function readStorageRecord(key: string): Record<string, string | number> {
  if (typeof window === 'undefined' || !window.localStorage) return {};
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeStorageRecord(key: string, map: Map<string, string | number>): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    const obj: Record<string, string | number> = {};
    map.forEach((val, k) => {
      obj[k] = val;
    });
    window.localStorage.setItem(key, JSON.stringify(obj));
  } catch {
    // Ignora errori quota localStorage
  }
}

// Mappa persistita itemId -> ultimo ordine di apparizione (per dare priorità ai soggetti mai visti)
const seenItemsMap = new Map<string, number>();
const rawSeen = readStorageRecord(SEEN_ITEMS_STORAGE_KEY);
for (const [id, val] of Object.entries(rawSeen)) {
  if (typeof val === 'number' && Number.isFinite(val)) {
    seenItemsMap.set(id, val);
    if (val > seenSeq) seenSeq = val;
  }
}

// Ultima foto usata per itemId (persistita per evitare ripetizioni anche tra sessioni diverse)
const lastPickedByItemId = new Map<string, string>();
const rawLastPhotos = readStorageRecord(LAST_PHOTO_STORAGE_KEY);
for (const [id, val] of Object.entries(rawLastPhotos)) {
  if (typeof val === 'string' && val) {
    lastPickedByItemId.set(id, val);
  }
}

function fisherYatesShuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Registra che un soggetto è appena comparso in arena, così le partite successive
 * daranno priorità ai soggetti ancora inediti nella categoria.
 */
export function markItemSeen(itemId: string): void {
  if (!itemId) return;
  seenSeq = Math.max(Date.now(), seenSeq + 1);
  seenItemsMap.set(itemId, seenSeq);

  if (seenItemsMap.size > MAX_SEEN_ENTRIES) {
    const sorted = Array.from(seenItemsMap.entries()).sort((a, b) => a[1] - b[1]);
    const excess = seenItemsMap.size - MAX_SEEN_ENTRIES;
    for (let i = 0; i < excess; i++) {
      seenItemsMap.delete(sorted[i][0]);
    }
  }

  writeStorageRecord(SEEN_ITEMS_STORAGE_KEY, seenItemsMap);
}

/**
 * Azzera la cronologia dei soggetti visti e delle ultime foto mostrate.
 */
export function clearSeenItemsHistory(): void {
  seenItemsMap.clear();
  lastPickedByItemId.clear();
  seenSeq = 0;
  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      window.localStorage.removeItem(SEEN_ITEMS_STORAGE_KEY);
      window.localStorage.removeItem(LAST_PHOTO_STORAGE_KEY);
    } catch {
      // Ignora errori localStorage
    }
  }
}

/**
 * Rimuove query di tracking (?utm_source=...) mantenendo pulito l'URL per cache/dedup.
 */
function sanitizePhotoUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.startsWith('data:') || trimmed.startsWith('blob:')) {
    return trimmed;
  }
  return trimmed.split('?')[0];
}

/**
 * Verifica a runtime che le dimensioni naturali e l'aspect ratio di un'immagine
 * caricata nel DOM siano adeguate (niente immagini minuscole, vuote o schiacciate).
 */
export function isRenderedImageHealthy(
  naturalWidth: number,
  naturalHeight: number
): boolean {
  if (!naturalWidth || !naturalHeight) return false;
  if (naturalWidth < 180 || naturalHeight < 140) return false;
  const ratio = naturalWidth / naturalHeight;
  return ratio >= 0.48 && ratio <= 2.35;
}

/**
 * Restituisce l'elenco completo e deduplicato delle URL fotografiche disponibili
 * per un dato soggetto, escludendo automaticamente tutte le immagini presenti nella blacklist
 * (sia statiche del catalogo che segnalate a runtime dall'utente).
 */
export function getItemImagePool(item: DuelItem): string[] {
  const pool = new Set<string>();

  if (item.imageUrl && typeof item.imageUrl === 'string') {
    const cleanPrimary = sanitizePhotoUrl(item.imageUrl);
    if (cleanPrimary && !blacklistService.isBlacklisted(cleanPrimary)) {
      pool.add(cleanPrimary);
    }
  }

  if (Array.isArray(item.imageUrls)) {
    for (const url of item.imageUrls) {
      if (url && typeof url === 'string') {
        const clean = sanitizePhotoUrl(url);
        if (clean && !blacklistService.isBlacklisted(clean)) {
          pool.add(clean);
        }
      }
    }
  }

  // Se tutte le foto sono in blacklist, restituisce array vuoto così
  // il chiamante sa che non ci sono più foto pulite disponibili.
  return Array.from(pool);
}

/**
 * Seleziona una fotografia casuale valida dal pool fotografico del soggetto,
 * preferendo uno scatto diverso dall'ultimo mostrato per evitare ripetizioni immediate.
 */
export function getRandomItemImage(item: DuelItem): string {
  const pool = getItemImagePool(item);
  if (pool.length === 0) return sanitizePhotoUrl(item.imageUrl || '');
  if (pool.length === 1) {
    lastPickedByItemId.set(item.id, pool[0]);
    writeStorageRecord(LAST_PHOTO_STORAGE_KEY, lastPickedByItemId);
    return pool[0];
  }

  const lastUrl = lastPickedByItemId.get(item.id);
  const freshChoices = lastUrl ? pool.filter((u) => u !== lastUrl) : pool;
  const candidates = freshChoices.length > 0 ? freshChoices : pool;
  const chosen = candidates[Math.floor(Math.random() * candidates.length)];
  lastPickedByItemId.set(item.id, chosen);
  writeStorageRecord(LAST_PHOTO_STORAGE_KEY, lastPickedByItemId);
  return chosen;
}

/**
 * Prepara il mazzo per l'arena del duello o l'allenamento:
 * 1. Esclude eventuali soggetti completamente blacklistati.
 * 2. Assegna a ciascun elemento una fotografia diversa dall'ultima mostrata.
 * 3. Dà priorità ai soggetti MAI visti di recente; quando tutta la categoria
 *    è stata completata, avvia un nuovo ciclo mantenendo gli ultimi visti in coda.
 */
export function prepareArenaDeck(items: DuelItem[]): DuelItem[] {
  const validItems = items.filter((item) => {
    if (blacklistService.isItemBlacklisted(item.id)) return false;
    const pool = getItemImagePool(item);
    return pool.some((url) => !blacklistService.isBlacklisted(url));
  });

  const sourceItems = validItems.length >= 1 ? validItems : items;

  const deckItems: DuelItem[] = sourceItems.map((item) => ({
    ...item,
    imageUrl: getRandomItemImage(item),
  }));

  let unseen = deckItems.filter((it) => !seenItemsMap.has(it.id));
  let seen = deckItems.filter((it) => seenItemsMap.has(it.id));

  // Se il giocatore ha esaurito l'intera categoria, resetta il ciclo preservando
  // gli ultimi soggetti appena visti in fondo al nuovo mazzo per zero ripetizioni consecutive.
  if (unseen.length === 0 && seen.length > 0) {
    const keepRecentCount = Math.min(8, Math.floor(seen.length / 3));
    const sortedByRecency = [...seen].sort(
      (a, b) => (seenItemsMap.get(b.id) ?? 0) - (seenItemsMap.get(a.id) ?? 0)
    );
    const keepSet = new Set(sortedByRecency.slice(0, keepRecentCount).map((it) => it.id));
    for (const it of seen) {
      if (!keepSet.has(it.id)) {
        seenItemsMap.delete(it.id);
      }
    }
    writeStorageRecord(SEEN_ITEMS_STORAGE_KEY, seenItemsMap);
    unseen = deckItems.filter((it) => !seenItemsMap.has(it.id));
    seen = deckItems.filter((it) => seenItemsMap.has(it.id));
  }

  fisherYatesShuffle(unseen);

  // Ordina i già visti dal meno recente al più recente, rimescolando dentro secchi da 5
  // per variare comunque l'ordine ai replay successivi.
  seen.sort((a, b) => (seenItemsMap.get(a.id) ?? 0) - (seenItemsMap.get(b.id) ?? 0));
  const mixedSeen: DuelItem[] = [];
  for (let i = 0; i < seen.length; i += 5) {
    mixedSeen.push(...fisherYatesShuffle(seen.slice(i, i + 5)));
  }

  return [...unseen, ...mixedSeen];
}
