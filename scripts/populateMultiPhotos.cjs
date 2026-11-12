const fs = require('fs');
const path = require('path');

const BLACKLIST_FILE = path.resolve(__dirname, '../src/data/blacklist.json');
let blacklistData = { blacklistedUrls: [], forbiddenKeywords: [] };
try {
  if (fs.existsSync(BLACKLIST_FILE)) {
    blacklistData = JSON.parse(fs.readFileSync(BLACKLIST_FILE, 'utf-8'));
  }
} catch {
  // fallback
}

const HEADERS = {
  'User-Agent': 'YappikCelebrityBot/1.0 (https://github.com/albertorosati/yappik; info@yappik.app)',
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isTitleValid(title, name) {
  const t = title.toLowerCase();
  const badKeywords = [
    'star', 'walk of fame', 'grave', 'tomba', 'tomb', 'statua', 'statue',
    'busto', 'bust', 'plaque', 'targa', 'monumento', 'monument', 'signed',
    'signature', 'firma', 'autograph', 'wax', 'cera', 'grevin', 'tussaud',
    'locandina', 'poster', 'logo', 'flag', 'bandiera', 'map', 'schema',
    'chart', 'diagram', 'stamps', 'francobollo', 'drawing', 'disegno', 'coas',
    'coin', 'moneta', 'doll', 'action figure', 'cosplay', 'waxwork', 'wax museum',
    ...(blacklistData.forbiddenKeywords || [])
  ];
  if (badKeywords.some((k) => t.includes(k))) return false;

  // Richiedi il match di almeno 2 token principali (quando presenti) per evitare omonimi ("Fiorello La Guardia", "S. Costanzo")
  const parts = name.toLowerCase().split(/\s+/).filter((p) => p.length >= 3 && !['del', 'dei', 'della', 'san', 'von', 'van', 'the'].includes(p));
  if (parts.length === 0) return true;
  const hits = parts.filter((p) => t.includes(p)).length;
  return hits >= Math.min(2, parts.length);
}

async function findAlternatePhotos(name, currentUrl, limit = 3) {
  const query = encodeURIComponent(name);
  const url = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${query}&gsrnamespace=6&gsrlimit=12&prop=imageinfo&iiprop=url|size|mime&iiurlwidth=960&format=json`;

  try {
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) return [];
    const data = await res.json();
    const pages = Object.values(data.query?.pages || {});
    const cleanCurrent = (currentUrl || '').split('?')[0];

    const candidates = [];
    for (const p of pages) {
      const info = p.imageinfo?.[0];
      if (!info) continue;
      if (!isTitleValid(p.title, name)) continue;
      if (info.mime !== 'image/jpeg' && info.mime !== 'image/png') continue;
      const w = info.thumbwidth || info.width || 0;
      const h = info.thumbheight || info.height || 0;
      if (w < 360 || h < 260) continue;
      const ratio = w / h;
      if (ratio < 0.62 || ratio > 1.85) continue;

      const cleanCandidate = String(info.thumburl || info.url || '').split('?')[0];
      if (!cleanCandidate || cleanCandidate === cleanCurrent || candidates.includes(cleanCandidate)) {
        continue;
      }
      if (Array.isArray(blacklistData.blacklistedUrls)) {
        if (blacklistData.blacklistedUrls.some((b) => cleanCandidate.includes(b) || b.includes(cleanCandidate))) {
          continue;
        }
      }
      candidates.push(cleanCandidate);
      if (candidates.length >= limit) break;
    }

    return candidates;
  } catch (err) {
    return [];
  }
}

async function processCategoryFile(catPath) {
  const fullPath = path.resolve(catPath);
  if (!fs.existsSync(fullPath)) {
    console.error(`File non trovato: ${fullPath}`);
    return;
  }

  const catData = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
  console.log(`\n========================================`);
  console.log(`Processando: ${catData.name} (${catData.items.length} items)...`);
  console.log(`========================================`);

  let enrichedCount = 0;
  let totalPhotosAdded = 0;

  for (let i = 0; i < catData.items.length; i++) {
    const item = catData.items[i];
    // Se ha già più di una foto, passa oltre
    if (Array.isArray(item.imageUrls) && item.imageUrls.length > 1) {
      continue;
    }

    const current = item.imageUrl;
    const alts = await findAlternatePhotos(item.answer, current, 3);

    const pool = Array.from(new Set([current, ...alts].filter(Boolean)));
    if (pool.length > 1) {
      item.imageUrls = pool;
      enrichedCount++;
      totalPhotosAdded += (pool.length - 1);
      console.log(`[${i + 1}/${catData.items.length}] ${item.answer} -> +${pool.length - 1} foto alternate (Totale: ${pool.length})`);
    } else {
      item.imageUrls = [current];
      console.log(`[${i + 1}/${catData.items.length}] ${item.answer} -> 1 foto (nessuna alternata trovata)`);
    }

    await sleep(150); // Rispetta il rate-limit di Wikimedia
  }

  fs.writeFileSync(fullPath, JSON.stringify(catData, null, 2), 'utf8');
  console.log(`Salvataggio completato per ${catData.id}: ${enrichedCount} soggetti arricchiti con ${totalPhotosAdded} nuove foto!`);
}

async function run() {
  const args = process.argv.slice(2);
  const categories = args.length > 0 ? args : [
    'attori-italiani',
    'attori-hollywood',
    'calciatori',
    'tv-italiana',
    'artisti-pop',
    'musica-italiana',
    'icone-musica-70-80-90',
    'leggende-sport',
    'registi-cinema',
    'personaggi-storici',
    'youtuber-streamer'
  ];

  for (const catId of categories) {
    const catFile = `./public/categories/${catId}.json`;
    await processCategoryFile(catFile);
  }

  // Sincronizza anche src/data/generatedCatalog.json
  console.log(`\nSincronizzazione finale di src/data/generatedCatalog.json...`);
  const catalogPath = './src/data/generatedCatalog.json';
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));

  for (let i = 0; i < catalog.length; i++) {
    const c = catalog[i];
    const modularPath = `./public/categories/${c.id}.json`;
    if (fs.existsSync(modularPath)) {
      const modularData = JSON.parse(fs.readFileSync(modularPath, 'utf8'));
      catalog[i] = modularData;
    }
  }

  fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2), 'utf8');
  console.log(`Catalogo globale aggiornato con successo!`);
}

run().catch((err) => {
  console.error('Errore durante l\'arricchimento:', err);
  process.exit(1);
});
