import { Category } from '../types/game';
import {
  CategoryRepository,
  DEFAULT_CATEGORIES,
} from '../services/categoryRepository';

export {
  getItemImagePool,
  getRandomItemImage,
  prepareArenaDeck,
  markItemSeen,
  clearSeenItemsHistory,
} from '../utils/itemUtils';

export { DEFAULT_CATEGORIES };

export function loadAllCategories(): Category[] {
  return CategoryRepository.getAllCategories();
}

export function saveCustomCategories(customCategories: Category[]): void {
  CategoryRepository.saveCustomCategories(customCategories);
}

export function getCustomCategoriesOnly(): Category[] {
  return CategoryRepository.getCustomCategoriesOnly();
}

export function getBackupImageUrl(originalUrl: string): string {
  return CategoryRepository.getBackupImageUrl(originalUrl);
}

export function isImageCached(url: string): boolean {
  return CategoryRepository.isImageCached(url);
}

export function getResolvedImageUrl(url: string): string {
  return CategoryRepository.getResolvedImageUrl(url);
}

export function primeImage(url: string): Promise<string> {
  return CategoryRepository.primeImage(url);
}

export function preloadCategoryImages(category: Category, count = 20): void {
  CategoryRepository.preloadCategoryImages(category, count);
}
