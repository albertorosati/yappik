import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateImageQuality, normalizeImageUrl } from './image-quality-validator.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_CAT_DIR = path.resolve(__dirname, '../public/categories');
const OUT_CATALOG_FILE = path.resolve(__dirname, '../src/data/generatedCatalog.json');
const BLACKLIST_FILE = path.resolve(__dirname, '../src/data/blacklist.json');

const USER_AGENT = 'YappikImageAuditor/1.0 (https://github.com/albertorosati/yappik)';

async function fetchJson(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
      if (res.ok) return await res.json();
      if (res.status === 429) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return null;
}

/**
 * Cerca un'immagine alternativa di alta qualità e vivente per il soggetto
 */
async function findCleanReplacement(answer, categoryName = '') {
  const queries = [
    answer,
    `${answer} in nature`,
    `${answer} wildlife`,
    `${answer} underwater`,
  ];

  for (const query of queries) {
    // 1. Cerca su Wikipedia EN/IT
    for (const lang of ['en', 'it']) {
      const wikiUrl = `https://${lang}.wikipedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(
        query
      )}&gsrlimit=6&prop=pageimages|imageinfo&piprop=thumbnail|name&pithumbsize=960&pilicense=free&format=json`;

      const data = await fetchJson(wikiUrl);
      const pages = Object.values(data?.query?.pages || {});
      for (const p of pages) {
        if (!p?.thumbnail?.source) continue;
        const evalRes = evaluateImageQuality({
          url: p.thumbnail.source,
          title: p.pageimage || p.title,
          width: p.thumbnail.width,
          height: p.thumbnail.height,
        });

        if (evalRes.valid && evalRes.score >= 50) {
          return p.thumbnail.source;
        }
      }
    }

    // 2. Cerca su Wikimedia Commons con filtri rigorosi
    const commonsUrl = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrnamespace=6&gsrsearch=${encodeURIComponent(
      `filetype:bitmap ${query} -illustration -drawing -specimen -fossil -skeleton`
    )}&gsrlimit=8&prop=imageinfo&iiprop=url|size|dimensions&iiurlwidth=960&format=json`;

    const cData = await fetchJson(commonsUrl);
    const cPages = Object.values(cData?.query?.pages || {});
    for (const p of cPages) {
      const info = p?.imageinfo?.[0];
      if (!info) continue;
      const candidateUrl = info.thumburl || info.url;
      const evalRes = evaluateImageQuality({
        url: candidateUrl,
        title: p.title,
        width: info.thumbwidth || info.width,
        height: info.thumbheight || info.height,
      });

      if (evalRes.valid && evalRes.score >= 50) {
        return candidateUrl;
      }
    }
  }

  return null;
}

async function main() {
  console.log('🔍 Avvio Audit Automatico della Qualità delle Immagini...');

  let blacklistData = { version: 1, blacklistedUrls: [], blacklistedItemIds: [], forbiddenKeywords: [], reports: [] };
  try {
    const raw = await fs.readFile(BLACKLIST_FILE, 'utf8');
    blacklistData = JSON.parse(raw);
  } catch {}

  const blacklistedSet = new Set(
    (blacklistData.blacklistedUrls || []).map((u) => normalizeImageUrl(u))
  );

  const files = (await fs.readdir(PUBLIC_CAT_DIR)).filter(
    (f) => f.endsWith('.json') && f !== 'index.json'
  );

  let totalScanned = 0;
  let totalReplaced = 0;
  const replacedSummary = [];
  const allCategories = [];

  for (const file of files) {
    const filePath = path.join(PUBLIC_CAT_DIR, file);
    const catContent = await fs.readFile(filePath, 'utf8');
    let category;
    try {
      category = JSON.parse(catContent);
    } catch {
      continue;
    }

    if (!Array.isArray(category.items)) continue;
    let categoryChanged = false;

    for (let i = 0; i < category.items.length; i++) {
      totalScanned++;
      const item = category.items[i];
      const currentUrl = item.imageUrl || '';

      const evalResult = evaluateImageQuality({
        url: currentUrl,
        title: currentUrl.split('/').pop(),
      });

      // Controlla anche il pool multi-foto imageUrls e rimuovi query params o foto non conformi
      if (Array.isArray(item.imageUrls) && item.imageUrls.length > 0) {
        const cleanedPool = [];
        let poolChanged = false;
        for (const poolUrl of item.imageUrls) {
          const noQuery = (poolUrl || '').split('?')[0];
          if (noQuery !== poolUrl) poolChanged = true;
          const poolEval = evaluateImageQuality({
            url: noQuery,
            title: noQuery.split('/').pop(),
          });
          if (poolEval.valid) {
            if (!cleanedPool.includes(noQuery)) cleanedPool.push(noQuery);
          } else {
            poolChanged = true;
          }
        }
        if (cleanedPool.length > 0 && poolChanged) {
          item.imageUrls = cleanedPool;
          categoryChanged = true;
        }
      }

      if (!evalResult.valid) {
        console.log(
          `⚠️ [${category.name}] "${item.answer}" Foto non conforme: ${evalResult.reason}`
        );

        // Aggiungi alla blacklist
        const cleanOldUrl = currentUrl.split('?')[0];
        if (!blacklistedSet.has(normalizeImageUrl(cleanOldUrl))) {
          blacklistedSet.add(normalizeImageUrl(cleanOldUrl));
          blacklistData.blacklistedUrls.push(cleanOldUrl);
        }

        // Cerca sostituzione
        const cleanReplacement = await findCleanReplacement(item.answer, category.name);
        if (cleanReplacement) {
          console.log(`  ➔ Sostituita con nuova foto HD: ${cleanReplacement}`);
          item.imageUrl = cleanReplacement;
          if (Array.isArray(item.imageUrls)) {
            item.imageUrls = [cleanReplacement, ...item.imageUrls.filter((u) => u !== currentUrl)];
          }
          categoryChanged = true;
          totalReplaced++;
          replacedSummary.push({
            category: category.name,
            answer: item.answer,
            reason: evalResult.reason,
            newUrl: cleanReplacement,
          });
        } else {
          console.log(`  ❌ Nessuna sostituta trovata online per "${item.answer}"`);
        }
      }
    }

    if (categoryChanged) {
      await fs.writeFile(filePath, JSON.stringify(category, null, 2), 'utf8');
    }
    allCategories.push(category);
  }

  // Aggiorna il catalogo unificato generatedCatalog.json
  await fs.writeFile(OUT_CATALOG_FILE, JSON.stringify(allCategories, null, 2), 'utf8');

  // Salva blacklist aggiornata
  await fs.writeFile(BLACKLIST_FILE, JSON.stringify(blacklistData, null, 2), 'utf8');

  console.log('\n======================================================');
  console.log(`AUDIT COMPLETATO!`);
  console.log(`Foto totali analizzate: ${totalScanned}`);
  console.log(`Foto sgradevoli/non conformi rimosse e sostituite: ${totalReplaced}`);
  console.log('======================================================');

  if (replacedSummary.length > 0) {
    console.log('\nRiepilogo Bonifiche:');
    replacedSummary.forEach((r, idx) => {
      console.log(`${idx + 1}. [${r.category}] ${r.answer} (${r.reason})`);
    });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
