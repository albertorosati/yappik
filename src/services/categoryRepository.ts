import { Category } from '../types/game';
import { gameConfig } from './configService';
import generatedCatalog from '../data/generatedCatalog.json';
import { remapDiscordImageUrl } from '../utils/discordUrlMapper';

export const DEFAULT_CATEGORIES: Category[] = generatedCatalog as Category[];

const CUSTOM_CATEGORIES_STORAGE_KEY = 'the_floor_custom_categories_v2';
const MAX_DECODED_IMAGE_CACHE = 80;
const CATEGORY_FETCH_TIMEOUT_MS = 2500;
const IMAGE_PRIME_TIMEOUT_MS = 6000;

export class CategoryRepository {
  private static fetchedCategoryCache = new Map<string, Category>();
  private static inFlightCategoryFetches = new Map<string, Promise<Category | null>>();

  public static getAllCategories(): Category[] {
    try {
      const saved = localStorage.getItem(CUSTOM_CATEGORIES_STORAGE_KEY);
      if (!saved) return DEFAULT_CATEGORIES;
      const parsed: Category[] = JSON.parse(saved);
      if (!Array.isArray(parsed)) return DEFAULT_CATEGORIES;
      return [...parsed, ...DEFAULT_CATEGORIES];
    } catch {
      return DEFAULT_CATEGORIES;
    }
  }

  /**
   * Carica i dati aggiornati della singola categoria dal suo file JSON modulare
   * (`./categories/<id>.json`), con cache in memoria, timeout breve (2.5s) e
   * fallback immediato al catalogo in memoria.
   */
  public static async fetchCategoryById(id: string): Promise<Category | null> {
    if (!id) return null;
    const localMatch = this.getAllCategories().find((c) => c.id === id) || null;
    if (localMatch?.isCustom) {
      return localMatch;
    }
    const cached = this.fetchedCategoryCache.get(id);
    if (cached) {
      return cached;
    }
    const pending = this.inFlightCategoryFetches.get(id);
    if (pending) {
      return pending;
    }

    const reqPromise = (async () => {
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), CATEGORY_FETCH_TIMEOUT_MS) : null;
      try {
        const res = await fetch(`./categories/${id}.json`, controller ? { signal: controller.signal } : undefined);
        if (res.ok) {
          const data = (await res.json()) as Category;
          if (data && Array.isArray(data.items) && data.items.length > 0) {
            this.fetchedCategoryCache.set(id, data);
            return data;
          }
        }
      } catch {
        // Fallback al catalogo locale precaricato
      } finally {
        if (timer) clearTimeout(timer);
        this.inFlightCategoryFetches.delete(id);
      }
      return localMatch;
    })();

    this.inFlightCategoryFetches.set(id, reqPromise);
    return reqPromise;
  }

  public static saveCustomCategories(customCategories: Category[]): void {
    try {
      localStorage.setItem(
        CUSTOM_CATEGORIES_STORAGE_KEY,
        JSON.stringify(customCategories)
      );
    } catch {
      // Ignora errori di quota localStorage
    }
  }

  public static getCustomCategoriesOnly(): Category[] {
    try {
      const saved = localStorage.getItem(CUSTOM_CATEGORIES_STORAGE_KEY);
      if (!saved) return [];
      const parsed: Category[] = JSON.parse(saved);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  public static getBackupImageUrl(originalUrl: string): string {
    if (
      !originalUrl ||
      originalUrl.startsWith('data:') ||
      originalUrl.startsWith('blob:') ||
      originalUrl.includes('wsrv.nl/') ||
      originalUrl.startsWith('/.proxy/wsrv')
    ) {
      return originalUrl;
    }
    const rawBackup = gameConfig.network.imageBackupProxyTemplate.replace(
      '{url}',
      encodeURIComponent(originalUrl.trim())
    );
    return remapDiscordImageUrl(rawBackup);
  }

  private static decodedCache = new Map<string, HTMLImageElement>();
  private static resolvedUrlCache = new Map<string, string>();
  private static inFlightPrimes = new Map<string, Promise<string>>();

  private static storeDecodedImage(keyUrl: string, loadedImg: HTMLImageElement, finalSrc: string): void {
    // LRU touch & eviction per evitare accumulo bitmap OOM su mobile
    this.decodedCache.delete(keyUrl);
    this.decodedCache.set(keyUrl, loadedImg);
    this.resolvedUrlCache.set(keyUrl, finalSrc);
    if (finalSrc !== keyUrl) {
      this.decodedCache.delete(finalSrc);
      this.decodedCache.set(finalSrc, loadedImg);
      this.resolvedUrlCache.set(finalSrc, finalSrc);
    }
    while (this.decodedCache.size > MAX_DECODED_IMAGE_CACHE) {
      const oldestKey = this.decodedCache.keys().next().value;
      if (oldestKey !== undefined) {
        this.decodedCache.delete(oldestKey);
        this.resolvedUrlCache.delete(oldestKey);
      } else {
        break;
      }
    }
  }

  public static isImageCached(url: string): boolean {
    if (!url) return false;
    return this.decodedCache.has(url);
  }

  public static getResolvedImageUrl(url: string): string {
    if (!url) return url;
    return this.resolvedUrlCache.get(url) || url;
  }

  public static primeImage(url: string): Promise<string> {
    if (!url || typeof window === 'undefined') return Promise.resolve(url);
    if (this.decodedCache.has(url)) {
      return Promise.resolve(this.resolvedUrlCache.get(url) || url);
    }
    const existingFlight = this.inFlightPrimes.get(url);
    if (existingFlight) {
      return existingFlight;
    }

    const promise = new Promise<string>((resolve, reject) => {
      const cleanUrl = url.trim();
      const targetUrl = remapDiscordImageUrl(cleanUrl);
      const img = new Image();
      img.decoding = 'async';
      let settled = false;

      const timeoutId = setTimeout(() => {
        if (settled) return;
        settled = true;
        img.onload = null;
        img.onerror = null;
        reject(new Error('image_load_timeout'));
      }, IMAGE_PRIME_TIMEOUT_MS);

      const doneResolve = (finalSrc: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        resolve(finalSrc);
      };

      const doneReject = (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        reject(err);
      };

      const finish = (loadedImg: HTMLImageElement, finalSrc: string) => {
        CategoryRepository.storeDecodedImage(url, loadedImg, finalSrc);
        if ('decode' in loadedImg && typeof loadedImg.decode === 'function') {
          loadedImg.decode().then(() => doneResolve(finalSrc)).catch(() => doneResolve(finalSrc));
        } else {
          doneResolve(finalSrc);
        }
      };

      img.onload = () => {
        if (settled) return;
        if (img.naturalWidth > 0 && img.naturalHeight > 0) {
          finish(img, targetUrl);
        } else {
          img.onerror?.(new Event('error'));
        }
      };
      img.onerror = () => {
        if (settled) return;
        const backup = CategoryRepository.getBackupImageUrl(cleanUrl);
        if (backup && backup !== targetUrl && backup !== cleanUrl) {
          const img2 = new Image();
          img2.decoding = 'async';
          img2.onload = () => {
            if (settled) return;
            if (img2.naturalWidth > 0 && img2.naturalHeight > 0) {
              finish(img2, backup);
            } else {
              doneReject(new Error('empty_image_dimensions'));
            }
          };
          img2.onerror = () => doneReject(new Error('image_load_failed'));
          img2.src = backup;
        } else {
          doneReject(new Error('image_load_failed'));
        }
      };
      img.src = targetUrl;
    }).finally(() => {
      CategoryRepository.inFlightPrimes.delete(url);
    });

    this.inFlightPrimes.set(url, promise);
    return promise;
  }

  public static preloadCategoryImages(
    category: Category,
    count = 6
  ): void {
    if (typeof window === 'undefined') return;
    // Precarica in ordine leggero solo le foto principali dei primi item (mai 60-80 alt URL insieme)
    const targets = category.items.slice(0, count);
    targets.forEach((item) => {
      if (item.imageUrl) {
        CategoryRepository.primeImage(item.imageUrl).catch(() => {});
      }
    });
  }
}
