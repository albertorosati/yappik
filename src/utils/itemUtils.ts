import { DuelItem } from '../types/game';
import { blacklistService } from '../services/blacklistService';

// Ultima foto usata per itemId nella sessione corrente (evita ripetizioni consecutive su pool multi-foto)
const lastPickedByItemId = new Map<string, string>();

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
    return pool[0];
  }

  const lastUrl = lastPickedByItemId.get(item.id);
  const freshChoices = lastUrl ? pool.filter((u) => u !== lastUrl) : pool;
  const candidates = freshChoices.length > 0 ? freshChoices : pool;
  const chosen = candidates[Math.floor(Math.random() * candidates.length)];
  lastPickedByItemId.set(item.id, chosen);
  return chosen;
}

/**
 * Prepara il mazzo per l'arena del duello o l'allenamento:
 * 1. Esclude eventuali soggetti completamente blacktlistati.
 * 2. Per ciascun elemento assegna una fotografia valida non blacktlistata.
 * 3. Rimescola l'ordine degli elementi (Fisher-Yates).
 */
export function prepareArenaDeck(items: DuelItem[]): DuelItem[] {
  const validItems = items.filter((item) => {
    if (blacklistService.isItemBlacklisted(item.id)) return false;
    const pool = getItemImagePool(item);
    return pool.some((url) => !blacklistService.isBlacklisted(url));
  });

  const sourceItems = validItems.length >= 1 ? validItems : items;

  const copy: DuelItem[] = sourceItems.map((item) => {
    const chosenPhoto = getRandomItemImage(item);
    return {
      ...item,
      imageUrl: chosenPhoto,
    };
  });

  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }

  return copy;
}
