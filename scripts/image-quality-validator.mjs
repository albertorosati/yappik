import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BLACKLIST_FILE = path.resolve(__dirname, '../src/data/blacklist.json');

let blacklistData = { blacklistedUrls: [], forbiddenKeywords: [] };
try {
  if (fs.existsSync(BLACKLIST_FILE)) {
    blacklistData = JSON.parse(fs.readFileSync(BLACKLIST_FILE, 'utf8'));
  }
} catch {
  // Use defaults if missing
}

const BLACKLISTED_URL_SET = new Set(
  (blacklistData.blacklistedUrls || []).map((u) => u.split('?')[0].toLowerCase())
);

export const FORBIDDEN_SEMANTIC_KEYWORDS = [
  // Antique / Hand-drawn / Book illustrations
  'illustration',
  'illustrations',
  'drawing',
  'drawings',
  'sketch',
  'disegno',
  'engraving',
  'lithograph',
  'woodcut',
  'painting',
  'shore fishes of the hawaiian islands (1905)',
  'illustrations of',
  '_drawing',
  '_sketch',
  '_illustration',

  // Biological specimen jars, dissections, lab specimens, fossils
  'specimen',
  'specimens',
  'dissection',
  'dissected',
  'holotype',
  'paratype',
  'fossil',
  'fossile',
  'skeleton',
  'scheletro',
  'skull',
  'cranio',
  'microscope',
  'microscopic',
  'histology',
  'tissue slice',
  'specimen jar',
  'preserved in',
  'carcass',
  'anatomy of',
  'anatomical',
  'internal organs',

  // Collages, maps, diagrams
  'montage',
  'collage',
  'composite',
  'diagram',
  'schema',
  'chart',
  'infographic',
  'map of',
  'distribution map',
  'locator map',
  'internet_map',
  'x-ray',
  'radiografia',
  'grave',
  'headstone',
  'cemetery',
  'tomba',
  'coronavirus',
  'sars-cov-2',
  'morphological_variation',
  'labeled_',
  'cosplay',
  'waxwork',
  'grevin',

  // Branding / Flags / Placeholders / Spoilers
  '.svg',
  '.gif',
  '.pdf',
  '.tif',
  '.tiff',
  'question_book',
  'no_free_image',
  'replace_this_image',
  'disambig',
  'commons-logo',
  'flag_of_',
  '_wordmark',
  'wordmark',
  '_logo',
  'logo_',
  '_poster',
  'poster_',
  'movie_poster',
  'film_poster',
  'theatrical_poster',
  'locandina',
  'title_card',
  'titlecard',
  'title_screen',
  'title_logo',
  'intertitle',
  'box_art',
  'promo_poster',
  'masthead',
  'album_cover',
  'copertina',
  'comic_cover',
  'comicbook_cover',
  'comic_book_cover',
  'variant_cover',
  'variant',
  'issue_',
  'panini_comics',
  'stemma',
  'coat_of_arms',
  'signature',
  'autograph',

  // Flat banners, ribbons, pancake ultra-wide crops
  'library_hero',
  'hero_capsule',
  'header_capsule',
  'capsule_616x353',
  'banner',
  'panoramica',
];

/**
 * Normalizza un URL per il controllo della blacklist
 */
export function normalizeImageUrl(url) {
  if (!url || typeof url !== 'string') return '';
  return url.split('?')[0].trim().toLowerCase();
}

/**
 * Valuta l'idoneità di un'immagine secondo i 5 criteri semantici e qualitativi.
 * @param {Object} candidate - { url, title, categories, width, height }
 * @returns {{ valid: boolean, score: number, reason?: string }}
 */
export function evaluateImageQuality(candidate) {
  if (!candidate || !candidate.url) {
    return { valid: false, score: 0, reason: 'missing_url' };
  }

  const cleanUrl = normalizeImageUrl(candidate.url);

  // 1. Controllo Blacklist Esplicita
  if (BLACKLISTED_URL_SET.has(cleanUrl)) {
    return { valid: false, score: 0, reason: 'explicitly_blacklisted' };
  }

  // 2. Controllo parole chiave vietate su URL, Titolo e Categorie
  const combinedText = [
    cleanUrl,
    candidate.title || '',
    Array.isArray(candidate.categories)
      ? candidate.categories.join(' ')
      : candidate.categories || '',
  ]
    .join(' ')
    .toLowerCase();

  // 2. Anti-Spoiler: Rilevamento nome risposta associato a copertine, poster o loghi
  if (candidate.answer && typeof candidate.answer === 'string') {
    const normAnswer = candidate.answer.toLowerCase().trim();
    if (
      normAnswer.length >= 3 &&
      combinedText.includes(normAnswer) &&
      (combinedText.includes('cover') ||
        combinedText.includes('copertina') ||
        combinedText.includes('poster') ||
        combinedText.includes('issue') ||
        combinedText.includes('variant') ||
        combinedText.includes('comic') ||
        combinedText.includes('film'))
    ) {
      return { valid: false, score: 0, reason: `spoiler_cover_or_poster_for_${normAnswer}` };
    }
  }

  // 3. Controllo parole chiave vietate su URL, Titolo e Categorie
  for (const bad of FORBIDDEN_SEMANTIC_KEYWORDS) {
    if (combinedText.includes(bad)) {
      return { valid: false, score: 0, reason: `forbidden_keyword: ${bad}` };
    }
  }

  // 3. Controllo Tecnico (Risoluzione e Aspetto)
  const w = candidate.width || 0;
  const h = candidate.height || 0;
  if (w > 0 && h > 0) {
    if (w < 480 && h < 360) {
      return { valid: false, score: 10, reason: 'resolution_too_low' };
    }
    const ratio = w / h;
    if (ratio < 0.65 || ratio > 1.85) {
      return { valid: false, score: 15, reason: `extreme_aspect_ratio: ${ratio.toFixed(2)}` };
    }
  }

  // 4. Calcolo Punteggio Qualitativo
  let score = 50;

  // Bonus natura viva / foto subacquea / wildlife
  if (
    combinedText.includes('underwater') ||
    combinedText.includes('wildlife') ||
    combinedText.includes('in nature') ||
    combinedText.includes('national park') ||
    combinedText.includes('living')
  ) {
    score += 25;
  }

  // Bonus risoluzione HD
  if (w >= 960 && h >= 720) {
    score += 15;
  }

  // Bonus qualità riconosciuta da Wikimedia Commons
  if (
    combinedText.includes('quality image') ||
    combinedText.includes('featured picture') ||
    combinedText.includes('valued image')
  ) {
    score += 10;
  }

  return { valid: true, score, reason: 'approved' };
}
