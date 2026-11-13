#!/usr/bin/env python3
"""
Massively expand Yappik category items and multi-photo imageUrls across 40+ categories
while strictly enforcing URL cleanliness, aspect ratio, dimension, and blacklist invariants.

Usage:
  python3 scripts/expand_catalog_massive.py
"""

from __future__ import annotations

import json
import re
import sys
import time
import unicodedata
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple
from urllib.parse import quote, unquote

import requests

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts" / "vision-curator"))

from pixel_metrics import normalize_url, upgrade_wikimedia_thumb_url  # noqa: E402
from source_fetchers import COMMONS_BAD_META  # noqa: E402

CATEGORIES_DIR = ROOT / "public" / "categories"
INDEX_PATH = CATEGORIES_DIR / "index.json"
GENERATED_CATALOG_PATH = ROOT / "src" / "data" / "generatedCatalog.json"
BLACKLIST_PATH = ROOT / "src" / "data" / "blacklist.json"

USER_AGENT = "YappikCatalogExpander/1.0 (https://github.com/albertorosati/yappik; trivia curation bot)"

_HTTP = requests.Session()
_HTTP.headers.update({"User-Agent": USER_AGENT})


# ---------------------------------------------------------------------------
# Helpers: Normalization, Blacklist & Quality Guards
# ---------------------------------------------------------------------------

def norm_text(s: str) -> str:
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    s = s.lower().strip()
    s = re.sub(r"[’'`\"“”\-–—:.,!?()&/+]", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def make_aliases(answer: str, extra: Iterable[str] = (), answer_en: str = "") -> Tuple[List[str], List[str]]:
    aliases: List[str] = []
    seen = {norm_text(answer)}
    for raw in list(extra):
        val = (raw or "").strip()
        n = norm_text(val)
        if val and n and n not in seen:
            seen.add(n)
            aliases.append(val)
    ascii_ans = "".join(
        ch for ch in unicodedata.normalize("NFKD", answer) if not unicodedata.combining(ch)
    ).replace("’", "'")
    if norm_text(ascii_ans) == norm_text(answer) and ascii_ans.lower() != answer.lower():
        if ascii_ans.lower() not in [a.lower() for a in aliases]:
            aliases.append(ascii_ans)

    aliases_en: List[str] = []
    if answer_en and norm_text(answer_en) != norm_text(answer):
        aliases_en = []
    return aliases, aliases_en


def load_blacklist() -> Tuple[set[str], set[str], List[str]]:
    data = json.loads(BLACKLIST_PATH.read_text(encoding="utf-8"))
    bad_urls: set[str] = set()
    bad_filenames: set[str] = set()
    for u in data.get("blacklistedUrls") or []:
        n = normalize_url(u).lower()
        if n:
            bad_urls.add(n)
            fname = unquote(n.rsplit("/", 1)[-1])
            fname = re.sub(r"^\d+px-", "", fname)
            if fname:
                bad_filenames.add(fname)
    keywords = [k.lower() for k in (data.get("forbiddenKeywords") or []) if isinstance(k, str) and len(k) >= 3]
    return bad_urls, bad_filenames, keywords


BLACKLISTED_URLS, BLACKLISTED_FILENAMES, FORBIDDEN_KEYWORDS = load_blacklist()


def is_clean_url(
    url: str,
    title_or_meta: str = "",
    width: int = 0,
    height: int = 0,
    min_ar: float = 0.60,
    max_ar: float = 1.90,
) -> Optional[str]:
    clean = upgrade_wikimedia_thumb_url(normalize_url(url), 960)
    if not clean or not clean.startswith("https://") or "?" in clean:
        return None
    low = clean.lower()
    if "twemoji" in low:
        return None
    # Reject bad Steam hero/capsule banners that always have logos/titles
    if any(b in low for b in ("library_hero", "hero_capsule", "header_capsule", "capsule_616x353", "capsule_231x87")):
        return None
    # Check extension strictly on path end (allows Flag_of_X.svg/960px-Flag_of_X.svg.png!)
    if not any(low.endswith(ext) for ext in (".jpg", ".jpeg", ".png", ".webp")):
        return None
    if low in BLACKLISTED_URLS:
        return None
    fname = unquote(low.rsplit("/", 1)[-1])
    fname_base = re.sub(r"^\d+px-", "", fname)
    if fname_base in BLACKLISTED_FILENAMES or fname in BLACKLISTED_FILENAMES:
        return None

    meta_low = f"{clean} {title_or_meta}".lower()
    for bad in COMMONS_BAD_META:
        if bad in meta_low:
            return None
    for bad in FORBIDDEN_KEYWORDS:
        if bad in meta_low:
            return None

    if width > 0 and height > 0:
        if width < 360 or height < 260:
            return None
        ar = width / max(1, height)
        if ar < min_ar or ar > max_ar:
            return None
    return clean


def _get_json(url: str, timeout: int = 10) -> Any:
    for attempt in range(3):
        try:
            r = _HTTP.get(url, timeout=timeout)
            if r.status_code == 200:
                return r.json()
            if r.status_code == 429:
                time.sleep(0.8 * (attempt + 1))
        except Exception:
            time.sleep(0.25)
    return None


def _head_ok(url: str, timeout: int = 8) -> bool:
    try:
        r = _HTTP.head(url, timeout=timeout, allow_redirects=True)
        if r.status_code == 200:
            ct = (r.headers.get("content-type") or "").lower()
            return ("image/" in ct) or url.endswith(".png") or url.endswith(".jpg")
        if r.status_code == 405:
            r2 = _HTTP.get(url, timeout=timeout, stream=True)
            return r2.status_code == 200
    except Exception:
        return False
    return False


# ---------------------------------------------------------------------------
# Source Fetchers (Disambiguated & Fast)
# ---------------------------------------------------------------------------

def token_similarity(a: str, b: str) -> float:
    ta = set(norm_text(a).split())
    tb = set(norm_text(b).split())
    if not ta or not tb:
        return 0.0
    inter = len(ta & tb)
    return inter / max(1, min(len(ta), len(tb)))


def fetch_steam_screenshots(query: str, appid_hint: Optional[int] = None, limit: int = 4) -> List[str]:
    urls: List[str] = []
    seen: set[str] = set()
    appids: List[int] = []
    if appid_hint:
        appids.append(appid_hint)
    else:
        data = _get_json(f"https://store.steampowered.com/api/storesearch/?term={quote(query)}&l=english&cc=US")
        items = (data or {}).get("items") or []
        # Pick closest matching game name
        scored: List[Tuple[float, int]] = []
        for entry in items[:5]:
            name = entry.get("name") or ""
            aid = entry.get("id")
            if not aid:
                continue
            sim = token_similarity(query, name)
            if sim >= 0.5 or norm_text(query) in norm_text(name):
                scored.append((sim, int(aid)))
        scored.sort(key=lambda x: -x[0])
        appids = [aid for _, aid in scored[:2]]

    for aid in appids:
        detail = _get_json(f"https://store.steampowered.com/api/appdetails?appids={aid}")
        app_info = ((detail or {}).get(str(aid)) or {}).get("data") or {}
        if not app_info:
            continue
        for ss in (app_info.get("screenshots") or [])[: limit + 2]:
            c = is_clean_url(ss.get("path_full") or "", f"{query} screenshot", 1920, 1080)
            if c and c not in seen:
                seen.add(c)
                urls.append(c)
                if len(urls) >= limit:
                    return urls
    return urls


def fetch_tvmaze_images(query: str, limit: int = 4) -> List[str]:
    urls: List[str] = []
    seen: set[str] = set()
    shows = _get_json(f"https://api.tvmaze.com/search/shows?q={quote(query)}")
    if not isinstance(shows, list):
        return urls
    for entry in shows[:3]:
        show = entry.get("show") or {}
        name = show.get("name") or ""
        if token_similarity(query, name) < 0.5 and norm_text(query) not in norm_text(name):
            continue
        sid = show.get("id")
        if not sid:
            continue
        imgs = _get_json(f"https://api.tvmaze.com/shows/{sid}/images")
        if isinstance(imgs, list):
            bgs = [im for im in imgs if im.get("type") == "background"]
            for bg in bgs[:limit]:
                orig = (bg.get("resolutions") or {}).get("original") or {}
                c = is_clean_url(
                    orig.get("url") or "",
                    f"{name} background",
                    int(orig.get("width") or 1280),
                    int(orig.get("height") or 720),
                )
                if c and c not in seen:
                    seen.add(c)
                    urls.append(c)
                    if len(urls) >= limit:
                        return urls
        cast = _get_json(f"https://api.tvmaze.com/shows/{sid}/cast")
        if isinstance(cast, list):
            for c_entry in cast[:limit]:
                img = ((c_entry.get("character") or {}).get("image") or {}) or (
                    (c_entry.get("person") or {}).get("image") or {}
                )
                c = is_clean_url(img.get("original") or "", f"{name} cast", 600, 800)
                if c and c not in seen:
                    seen.add(c)
                    urls.append(c)
                    if len(urls) >= limit:
                        return urls
    return urls


def fetch_anilist_images(query: str, series_hint: str = "", limit: int = 3) -> List[str]:
    urls: List[str] = []
    seen: set[str] = set()
    gql = """
    query ($search: String) {
      Character(search: $search) {
        name { full }
        image { large }
        media(sort: POPULARITY_DESC, perPage: 2) {
          nodes {
            title { romaji english }
            characters(sort: ROLE, perPage: 3) {
              nodes { name { full } image { large } }
            }
          }
        }
      }
    }
    """
    try:
        r = _HTTP.post("https://graphql.anilist.co", json={"query": gql, "variables": {"search": query}}, timeout=10)
        if r.status_code == 200:
            ch = ((r.json() or {}).get("data") or {}).get("Character")
            if ch:
                cname = (ch.get("name") or {}).get("full") or ""
                if token_similarity(query, cname) >= 0.45 or norm_text(query) in norm_text(cname):
                    img = (ch.get("image") or {}).get("large") or ""
                    c = is_clean_url(img, f"{cname} anime character", 460, 650)
                    if c and c not in seen:
                        seen.add(c)
                        urls.append(c)
    except Exception:
        pass
    if series_hint and len(urls) < limit:
        # Try Wikipedia/Commons fallback with series hint
        for u in fetch_commons_images(f"{query} {series_hint} cosplay OR anime", limit=limit):
            if u not in seen:
                seen.add(u)
                urls.append(u)
                if len(urls) >= limit:
                    break
    return urls[:limit]


def fetch_wikipedia_pageimages_batch(titles: List[str], lang: str = "en") -> Dict[str, str]:
    """Batch up to 40 Wikipedia titles in one request to get clean pageimages thumbnails."""
    out: Dict[str, str] = {}
    if not titles:
        return out
    for i in range(0, len(titles), 35):
        chunk = titles[i : i + 35]
        joined = "|".join(chunk)
        url = (
            f"https://{lang}.wikipedia.org/w/api.php?action=query&titles={quote(joined)}"
            "&prop=pageimages&pithumbsize=960&pilicense=free&redirects=1&format=json"
        )
        data = _get_json(url)
        query_obj = (data or {}).get("query") or {}
        norm_map = {n["from"]: n["to"] for n in (query_obj.get("normalized") or []) if "from" in n and "to" in n}
        redir_map = {r["from"]: r["to"] for r in (query_obj.get("redirects") or []) if "from" in r and "to" in r}
        pages_by_title: Dict[str, Dict[str, Any]] = {}
        for p in (query_obj.get("pages") or {}).values():
            if "title" in p:
                pages_by_title[p["title"]] = p
        for orig_t in chunk:
            cur = norm_map.get(orig_t, orig_t)
            cur = redir_map.get(cur, cur)
            page = pages_by_title.get(cur)
            if not page:
                continue
            th = page.get("thumbnail") or {}
            src = th.get("source") or ""
            w = int(th.get("width") or 0)
            h = int(th.get("height") or 0)
            clean = is_clean_url(src, orig_t, w, h)
            if clean:
                out[orig_t] = clean
    return out


def fetch_commons_images(query: str, limit: int = 4) -> List[str]:
    urls: List[str] = []
    seen: set[str] = set()
    url = (
        "https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrnamespace=6"
        f"&gsrsearch={quote(f'filetype:bitmap {query}')}&gsrlimit=12"
        "&prop=imageinfo&iiprop=url|size|mime|extmetadata&iiurlwidth=960&format=json"
    )
    data = _get_json(url)
    pages = list(((data or {}).get("query") or {}).get("pages", {}).values())
    for p in pages:
        info = (p.get("imageinfo") or [None])[0]
        if not info:
            continue
        mime = (info.get("mime") or "").lower()
        if mime not in ("image/jpeg", "image/png", "image/webp"):
            continue
        ext = info.get("extmetadata") or {}
        desc = (ext.get("ImageDescription") or {}).get("value") or ""
        cats = (ext.get("Categories") or {}).get("value") or ""
        meta = re.sub(r"<[^>]+>", " ", f"{p.get('title', '')} {desc} {cats}")
        cand = info.get("thumburl") or info.get("url") or ""
        w = int(info.get("thumbwidth") or info.get("width") or 0)
        h = int(info.get("thumbheight") or info.get("height") or 0)
        c = is_clean_url(cand, meta, w, h)
        if c and c not in seen:
            seen.add(c)
            urls.append(c)
            if len(urls) >= limit:
                return urls
    return urls


def fetch_wikipedia_media_extras(title_queries: List[str], limit: int = 3) -> List[str]:
    urls: List[str] = []
    seen: set[str] = set()
    for q in title_queries[:2]:
        for lang in ("en", "it"):
            sdata = _get_json(
                f"https://{lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch={quote(q)}&srlimit=2&format=json"
            )
            hits = ((sdata or {}).get("query") or {}).get("search") or []
            for h in hits[:1]:
                title = h.get("title") or ""
                if not title:
                    continue
                if any(b in title.lower() for b in ("(disambiguation)", "(song)", "(album)", "(soundtrack)")):
                    continue
                slug = quote(title.replace(" ", "_"), safe="")
                ml = _get_json(f"https://{lang}.wikipedia.org/api/rest_v1/page/media-list/{slug}")
                for idx, m in enumerate((ml or {}).get("items") or []):
                    if m.get("type") != "image":
                        continue
                    srcset = m.get("srcset") or []
                    best_src = ""
                    for s in srcset:
                        src = s.get("src") or ""
                        if src.startswith("//"):
                            src = f"https:{src}"
                        best_src = src
                    if not best_src:
                        continue
                    cap = ((m.get("caption") or {}).get("text") or "") + " " + (m.get("title") or "")
                    if idx == 0 and "/wikipedia/en/" in best_src and any(
                        kw in cap.lower() for kw in ("poster", "cover", "logo", "title")
                    ):
                        continue
                    c = is_clean_url(best_src, f"{title} {cap}")
                    if c and c not in seen:
                        seen.add(c)
                        urls.append(c)
                        if len(urls) >= limit:
                            return urls
    return urls


# ---------------------------------------------------------------------------
# Curated Massive Expansion Datasets
# ---------------------------------------------------------------------------

# Format for videogiochi: (answer, steam_query, appid_or_None, commons_fallback_query, aliases)
NEW_VIDEOGIOCHI: List[Tuple[str, str, Optional[int], str, List[str]]] = [
    ("Fortnite", "", None, "Fortnite gameplay battle royale", ["fortnite battle royale"]),
    ("League of Legends", "", None, "League of Legends Summoner's Rift gameplay", ["lol"]),
    ("Valorant", "", None, "Valorant Riot Games gameplay", []),
    ("Overwatch 2", "Overwatch 2", 2357570, "Overwatch video game gameplay", ["overwatch"]),
    ("Call of Duty: Warzone", "Call of Duty: Warzone", None, "Call of Duty gameplay", ["warzone", "call of duty", "cod"]),
    ("EA Sports FC 25", "EA SPORTS FC 25", None, "FIFA football video game", ["fifa", "ea fc", "fc 25", "ea sports fc"]),
    ("Rocket League", "Rocket League", 252950, "Rocket League arena soccer", []),
    ("Hogwarts Legacy", "Hogwarts Legacy", 990080, "", []),
    ("Diablo IV", "Diablo IV", 2344520, "", ["diablo 4", "diablo"]),
    ("Palworld", "Palworld", 1623730, "", []),
    ("Helldivers 2", "HELLDIVERS 2", 553850, "", ["helldivers"]),
    ("Black Myth: Wukong", "Black Myth: Wukong", 2358720, "", ["wukong", "black myth"]),
    ("Ghost of Tsushima", "Ghost of Tsushima", 2215430, "", ["tsushima"]),
    ("Spider-Man Remastered", "Marvel’s Spider-Man Remastered", 1817070, "", ["spider-man ps4", "spiderman game"]),
    ("Uncharted 4", "UNCHARTED: Legacy of Thieves Collection", 1659420, "Uncharted Nathan Drake", ["uncharted"]),
    ("The Last of Us Part I", "The Last of Us Part I", 1888930, "", ["the last of us game"]),
    ("Bloodborne", "", None, "Bloodborne Yharnam cosplay OR video game", []),
    ("Starfield", "Starfield", 1716740, "", []),
    ("Assassin’s Creed Valhalla", "Assassin's Creed Valhalla", 2208920, "", ["assassins creed", "assassin's creed"]),
    ("Assassin’s Creed II", "Assassin's Creed II", 33230, "", ["ezio auditore", "ac2"]),
    ("Far Cry 6", "Far Cry 6", 2369390, "", ["far cry"]),
    ("Watch Dogs 2", "Watch Dogs 2", 447040, "", ["watch dogs"]),
    ("BioShock Infinite", "BioShock Infinite", 8870, "", ["bioshock"]),
    ("Mass Effect", "Mass Effect Legendary Edition", 1328670, "", ["mass effect 2", "mass effect 3"]),
    ("Dragon Age: Inquisition", "Dragon Age Inquisition", 1222690, "", ["dragon age"]),
    ("Persona 5 Royal", "Persona 5 Royal", 1687950, "", ["persona 5"]),
    ("Final Fantasy VII Remake", "FINAL FANTASY VII REMAKE INTERGRADE", 1462040, "", ["final fantasy vii", "final fantasy 7", "ff7"]),
    ("Final Fantasy XVI", "FINAL FANTASY XVI", 2515020, "", ["ff16"]),
    ("Kingdom Hearts III", "KINGDOM HEARTS III", 2552450, "", ["kingdom hearts"]),
    ("Metal Gear Solid V", "METAL GEAR SOLID V: THE PHANTOM PAIN", 287700, "", ["metal gear solid", "mgs", "solid snake"]),
    ("Death Stranding", "DEATH STRANDING DIRECTOR'S CUT", 1850570, "", []),
    ("Devil May Cry 5", "Devil May Cry 5", 601150, "", ["devil may cry", "dmc 5"]),
    ("Nier: Automata", "NieR:Automata", 524220, "", ["nier automata"]),
    ("Silent Hill 2", "SILENT HILL 2", 2124490, "", ["silent hill"]),
    ("Outlast", "Outlast", 238320, "", []),
    ("Phasmophobia", "Phasmophobia", 739630, "", []),
    ("Lethal Company", "Lethal Company", 1966720, "", []),
    ("Paladins", "Paladins", 444090, "", []),
    ("Smite", "SMITE", 386360, "", []),
    ("Path of Exile 2", "Path of Exile 2", 2694490, "", ["path of exile", "poe"]),
    ("World of Warcraft", "", None, "World of Warcraft Azeroth Orgrimmar", ["wow"]),
    ("Roblox", "", None, "Roblox avatar obby", []),
    ("Genshin Impact", "", None, "Genshin Impact Teyvat Mondstadt", ["genshin"]),
    ("Brawl Stars", "", None, "Brawl Stars Supercell mobile game", []),
    ("Clash Royale", "", None, "Clash Royale arena game", ["clash of clans"]),
    ("Age of Empires IV", "Age of Empires IV", 1466860, "", ["age of empires"]),
    ("Civilization VI", "Sid Meier’s Civilization VI", 289070, "", ["civilization", "civ 6"]),
    ("Cities: Skylines", "Cities: Skylines", 255710, "", ["cities skylines"]),
    ("Planet Coaster", "Planet Coaster", 493340, "", []),
    ("RollerCoaster Tycoon", "RollerCoaster Tycoon Classic", 683900, "", []),
    ("Frostpunk", "Frostpunk", 323190, "", []),
    ("Factorio", "Factorio", 427520, "", []),
    ("RimWorld", "RimWorld", 294100, "", []),
    ("Valheim", "Valheim", 892970, "", []),
    ("ARK: Survival Evolved", "ARK: Survival Evolved", 346110, "", ["ark"]),
    ("No Man’s Sky", "No Man's Sky", 275850, "", ["no mans sky"]),
    ("Outer Wilds", "Outer Wilds", 753640, "", []),
    ("Celeste", "Celeste", 504230, "", []),
    ("Dead Cells", "Dead Cells", 588650, "", []),
    ("Ori and the Will of the Wisps", "Ori and the Will of the Wisps", 1057090, "", ["ori"]),
    ("Slay the Spire", "Slay the Spire", 646570, "", []),
    ("Balatro", "Balatro", 2379780, "", []),
    ("Vampire Survivors", "Vampire Survivors", 1794680, "", []),
    ("The Binding of Isaac", "The Binding of Isaac: Rebirth", 250900, "", ["binding of isaac"]),
    ("Don’t Starve Together", "Don't Starve Together", 322330, "", ["dont starve", "don't starve"]),
    ("Project Zomboid", "Project Zomboid", 108600, "", []),
    ("DayZ", "DayZ", 221100, "", []),
    ("Escape from Tarkov", "", None, "Escape from Tarkov tactical shooter", ["tarkov"]),
    ("PAYDAY 2", "PAYDAY 2", 218620, "", ["payday"]),
    ("Deep Rock Galactic", "Deep Rock Galactic", 548430, "", []),
    ("Warframe", "Warframe", 230410, "", []),
    ("Forza Horizon 5", "Forza Horizon 5", 1551360, "", ["forza horizon", "forza"]),
    ("Assetto Corsa", "Assetto Corsa", 244210, "", []),
    ("Gran Turismo 7", "", None, "Gran Turismo PlayStation racing", ["gran turismo"]),
    ("Mario Kart 8", "", None, "Mario Kart racing Nintendo", ["mario kart"]),
    ("Super Smash Bros.", "", None, "Super Smash Bros Ultimate Nintendo", ["smash bros", "super smash bros"]),
    ("Animal Crossing", "", None, "Animal Crossing New Horizons villager", ["animal crossing new horizons"]),
    ("Crash Bandicoot", "Crash Bandicoot N. Sane Trilogy", 731490, "", []),
    ("Spyro", "Spyro Reignited Trilogy", 996580, "", ["spyro the dragon"]),
    ("Ratchet & Clank", "Ratchet & Clank: Rift Apart", 1895880, "", ["ratchet and clank"]),
    ("It Takes Two", "It Takes Two", 1426210, "", []),
    ("A Way Out", "A Way Out", 1222700, "", []),
    ("Life is Strange", "Life is Strange", 319630, "", []),
    ("Detroit: Become Human", "Detroit: Become Human", 1222140, "", ["detroit become human"]),
    ("Heavy Rain", "Heavy Rain", 960910, "", []),
    ("Disco Elysium", "Disco Elysium - The Final Cut", 632470, "", []),
    ("XCOM 2", "XCOM 2", 268500, "", ["xcom"]),
    ("Total War: Warhammer III", "Total War: WARHAMMER III", 1142710, "", ["total war"]),
    ("Mount & Blade II: Bannerlord", "Mount & Blade II: Bannerlord", 261550, "", ["bannerlord", "mount and blade"]),
    ("Crusader Kings III", "Crusader Kings III", 1158310, "", ["crusader kings"]),
    ("Hearts of Iron IV", "Hearts of Iron IV", 394360, "", ["hearts of iron"]),
    ("Dying Light", "Dying Light", 239140, "", []),
    ("Dead Space", "Dead Space", 1693980, "", []),
    ("Metro Exodus", "Metro Exodus", 412020, "", ["metro"]),
    ("S.T.A.L.K.E.R. 2", "S.T.A.L.K.E.R. 2: Heart of Chornobyl", 1643320, "", ["stalker"]),
    ("Half-Life 2", "Half-Life 2", 220, "", ["half life", "gordon freeman"]),
    ("Garry’s Mod", "Garry's Mod", 4000, "", ["gmod", "garrys mod"]),
    ("Geometry Dash", "Geometry Dash", 322170, "", []),
    ("Rocket League", "Rocket League", 252950, "", []),
    ("Brawlhalla", "Brawlhalla", 291550, "", []),
    ("Mortal Kombat 11", "Mortal Kombat 11", 976310, "", ["mortal kombat"]),
    ("Dragon Ball FighterZ", "DRAGON BALL FighterZ", 678950, "", ["dragon ball z kakarot"]),
    ("Persona 3 Reload", "Persona 3 Reload", 2161700, "", ["persona 3"]),
    ("Lies of P", "Lies of P", 1627720, "", []),
    ("Armored Core VI", "ARMORED CORE VI FIRES OF RUBICON", 1888160, "", ["armored core"]),
    ("Control", "Control Ultimate Edition", 870780, "", []),
    ("Alan Wake 2", "", None, "Alan Wake Bright Falls Remedy", ["alan wake"]),
    ("Batman: Arkham Knight", "Batman: Arkham Knight", 208650, "", ["arkham knight", "batman arkham"]),
    ("Shadow of Mordor", "Middle-earth: Shadow of Mordor", 241930, "", ["shadow of war"]),
    ("Hitman 3", "HITMAN World of Assassination", 1659040, "", ["hitman"]),
    ("Dishonored", "Dishonored", 205100, "", []),
    ("Borderlands 2", "Borderlands 2", 49520, "", ["borderlands"]),
    ("Little Nightmares", "Little Nightmares", 424840, "", []),
    ("Inside", "INSIDE", 304430, "", ["limbo"]),
    ("Journey", "Journey", 638230, "", []),
    ("Stray", "Stray", 1332010, "", []),
    ("Goat Simulator", "Goat Simulator", 265930, "", []),
    ("Kerbal Space Program", "Kerbal Space Program", 220200, "", []),
    ("Satisfactory", "Satisfactory", 526870, "", []),
    ("Slime Rancher", "Slime Rancher", 433340, "", []),
    ("Overcooked! 2", "Overcooked! 2", 728880, "", ["overcooked"]),
    ("Phogs!", "PHOGS!", 850320, "", []),
    ("Human: Fall Flat", "Human Fall Flat", 477160, "", ["human fall flat"]),
    ("Gang Beasts", "Gang Beasts", 285900, "", []),
    ("Donkey Kong", "", None, "Donkey Kong Nintendo arcade game", []),
    ("Kirby", "", None, "Kirby Nintendo pink character", []),
    ("Pac-Man", "PAC-MAN MUSEUM+", 1665130, "Pac-Man arcade cabinet", []),
]

# Format for pokemon: (answer, national_dex_id, aliases)
NEW_POKEMON: List[Tuple[str, int, List[str]]] = [
    ("Garchomp", 445, []),
    ("Gardevoir", 282, []),
    ("Greninja", 658, []),
    ("Umbreon", 197, []),
    ("Espeon", 196, []),
    ("Sylveon", 700, []),
    ("Leafeon", 470, []),
    ("Glaceon", 471, []),
    ("Tyranitar", 248, []),
    ("Metagross", 376, []),
    ("Salamence", 373, []),
    ("Blaziken", 257, []),
    ("Sceptile", 254, []),
    ("Swampert", 260, []),
    ("Infernape", 392, []),
    ("Empoleon", 395, []),
    ("Torterra", 389, []),
    ("Typhlosion", 157, []),
    ("Feraligatr", 160, []),
    ("Meganium", 154, []),
    ("Cyndaquil", 155, []),
    ("Totodile", 158, []),
    ("Chikorita", 152, []),
    ("Mudkip", 258, []),
    ("Torchic", 255, []),
    ("Treecko", 252, []),
    ("Piplup", 393, []),
    ("Chimchar", 390, []),
    ("Turtwig", 387, []),
    ("Rowlet", 722, []),
    ("Litten", 725, []),
    ("Popplio", 728, []),
    ("Scorbunny", 813, []),
    ("Sobble", 816, []),
    ("Grookey", 810, []),
    ("Sprigatito", 906, []),
    ("Fuecoco", 909, []),
    ("Quaxly", 912, []),
    ("Mimikyu", 778, []),
    ("Zoroark", 571, []),
    ("Haxorus", 612, []),
    ("Hydreigon", 635, []),
    ("Volcarona", 637, []),
    ("Chandelure", 609, []),
    ("Bisharp", 625, []),
    ("Aegislash", 681, []),
    ("Talonflame", 663, []),
    ("Noivern", 715, []),
    ("Goodra", 706, []),
    ("Decidueye", 724, []),
    ("Incineroar", 727, []),
    ("Lycanroc", 745, []),
    ("Toxtricity", 849, []),
    ("Corviknight", 823, []),
    ("Dragapult", 887, []),
    ("Tinkaton", 959, []),
    ("Ceruledge", 937, []),
    ("Armarouge", 936, []),
    ("Ho-Oh", 250, ["ho oh"]),
    ("Suicune", 245, []),
    ("Entei", 244, []),
    ("Raikou", 243, []),
    ("Celebi", 251, []),
    ("Kyogre", 382, []),
    ("Groudon", 383, []),
    ("Jirachi", 385, []),
    ("Deoxys", 386, []),
    ("Dialga", 483, []),
    ("Palkia", 484, []),
    ("Giratina", 487, []),
    ("Arceus", 493, []),
    ("Darkrai", 491, []),
    ("Zekrom", 644, []),
    ("Reshiram", 643, []),
    ("Kyurem", 646, []),
    ("Xerneas", 716, []),
    ("Yveltal", 717, []),
    ("Zygarde", 718, []),
    ("Solgaleo", 791, []),
    ("Lunala", 792, []),
    ("Necrozma", 800, []),
    ("Zacian", 888, []),
    ("Zamazenta", 889, []),
    ("Eternatus", 890, []),
    ("Koraidon", 1007, []),
    ("Miraidon", 1008, []),
    ("Pichu", 172, []),
    ("Riolu", 447, []),
    ("Bidoof", 399, []),
    ("Mudbray", 749, []),
    ("Wobbuffet", 202, []),
    ("Heracross", 214, []),
    ("Scizor", 212, []),
    ("Ampharos", 181, []),
    ("houndoom", 229, []),
    ("Absol", 359, []),
    ("Flygon", 330, []),
    ("Milotic", 350, []),
    ("Aggron", 306, []),
    ("Sableye", 302, []),
    ("Mawile", 303, []),
    ("Altaria", 334, []),
    ("Luxray", 405, []),
    ("Staraptor", 398, []),
    ("Roserade", 407, []),
    ("Gallade", 475, []),
    ("Electivire", 466, []),
    ("Magmortar", 467, []),
    ("Togekiss", 468, []),
    ("Weavile", 461, []),
    ("Porygon", 137, []),
    ("Aerodactyl", 142, []),
    ("Kabutops", 141, []),
    ("Omastar", 139, []),
    ("Chansey", 113, []),
    ("Blissey", 242, []),
    ("Kangaskhan", 115, []),
    ("Electabuzz", 125, []),
    ("Magmar", 126, []),
    ("Nidoking", 34, []),
    ("Nidoqueen", 31, []),
    ("Arbok", 24, []),
    ("Weezing", 110, []),
    ("Muk", 89, []),
    ("Cloyster", 91, []),
    ("Rhydon", 112, []),
    ("Exeggutor", 103, []),
    ("Starmie", 121, []),
    ("Golem", 76, []),
    ("Victreebel", 71, []),
    ("Vileplume", 45, []),
    ("Rapidash", 78, []),
    ("Dewgong", 87, []),
]

# Format for bandiere: (answer_it, iso2, answer_en, aliases_it)
NEW_BANDIERE: List[Tuple[str, str, str, List[str]]] = [
    ("Corea del Nord", "kp", "North Korea", []),
    ("Pakistan", "pk", "Pakistan", []),
    ("Bangladesh", "bd", "Bangladesh", []),
    ("Filippine", "ph", "Philippines", []),
    ("Malesia", "my", "Malaysia", []),
    ("Singapore", "sg", "Singapore", []),
    ("Emirati Arabi Uniti", "ae", "United Arab Emirates", ["emirati arabi", "uae", "dubai"]),
    ("Qatar", "qa", "Qatar", []),
    ("Kuwait", "kw", "Kuwait", []),
    ("Iran", "ir", "Iran", []),
    ("Iraq", "iq", "Iraq", []),
    ("Giordania", "jo", "Jordan", []),
    ("Libano", "lb", "Lebanon", []),
    ("Afghanistan", "af", "Afghanistan", []),
    ("Kazakistan", "kz", "Kazakhstan", []),
    ("Georgia", "ge", "Georgia", []),
    ("Armenia", "am", "Armenia", []),
    ("Azerbaigian", "az", "Azerbaijan", []),
    ("Repubblica Ceca", "cz", "Czech Republic", ["cechia"]),
    ("Slovacchia", "sk", "Slovakia", []),
    ("Ungheria", "hu", "Hungary", []),
    ("Bulgaria", "bg", "Bulgaria", []),
    ("Lituania", "lt", "Lithuania", []),
    ("Lettonia", "lv", "Latvia", []),
    ("Estonia", "ee", "Estonia", []),
    ("Slovenia", "si", "Slovenia", []),
    ("Bosnia ed Erzegovina", "ba", "Bosnia and Herzegovina", ["bosnia"]),
    ("Macedonia del Nord", "mk", "North Macedonia", ["macedonia"]),
    ("Montenegro", "me", "Montenegro", []),
    ("Malta", "mt", "Malta", []),
    ("Cipro", "cy", "Cyprus", []),
    ("Lussemburgo", "lu", "Luxembourg", []),
    ("Monaco", "mc", "Monaco", ["principato di monaco"]),
    ("Andorra", "ad", "Andorra", []),
    ("Venezuela", "ve", "Venezuela", []),
    ("Ecuador", "ec", "Ecuador", []),
    ("Bolivia", "bo", "Bolivia", []),
    ("Paraguay", "py", "Paraguay", []),
    ("Costa Rica", "cr", "Costa Rica", []),
    ("Panama", "pa", "Panama", []),
    ("Guatemala", "gt", "Guatemala", []),
    ("Repubblica Dominicana", "do", "Dominican Republic", []),
    ("Kenya", "ke", "Kenya", []),
    ("Etiopia", "et", "Ethiopia", []),
    ("Ghana", "gh", "Ghana", []),
    ("Costa d’Avorio", "ci", "Ivory Coast", ["costa d'avorio"]),
    ("Algeria", "dz", "Algeria", []),
    ("Tanzania", "tz", "Tanzania", []),
    ("Madagascar", "mg", "Madagascar", []),
    ("Nepal", "np", "Nepal", []),
    ("Sri Lanka", "lk", "Sri Lanka", []),
    ("Mongolia", "mn", "Mongolia", []),
    ("Cambogia", "kh", "Cambodia", []),
    ("Moldavia", "md", "Moldova", []),
    ("Bielorussia", "by", "Belarus", []),
    ("Kosovo", "xk", "Kosovo", []),
    ("Mali", "ml", "Mali", []),
    ("Congo", "cg", "Republic of the Congo", []),
    ("Angola", "ao", "Angola", []),
    ("Giordania", "jo", "Jordan", []),
]

NEW_SERIE_TV: List[Tuple[str, str, List[str]]] = [
    ("Dark", "Dark Netflix series", []),
    ("Black Mirror", "Black Mirror", []),
    ("Mindhunter", "Mindhunter", []),
    ("Chernobyl", "Chernobyl", []),
    ("The Crown", "The Crown", []),
    ("Succession", "Succession", []),
    ("Severance", "Severance", ["scissione"]),
    ("Ted Lasso", "Ted Lasso", []),
    ("Modern Family", "Modern Family", []),
    ("Brooklyn Nine-Nine", "Brooklyn Nine-Nine", ["brooklyn 99"]),
    ("Rick and Morty", "Rick and Morty", []),
    ("Arcane", "Arcane", []),
    ("Fallout", "Fallout", []),
    ("The Bear", "The Bear", []),
    ("The White Lotus", "The White Lotus", ["white lotus"]),
    ("True Detective", "True Detective", []),
    ("Fargo", "Fargo", []),
    ("Mr. Robot", "Mr. Robot", ["mr robot"]),
    ("Cobra Kai", "Cobra Kai", []),
    ("Sex Education", "Sex Education", []),
    ("Euphoria", "Euphoria", []),
    ("Gossip Girl", "Gossip Girl", []),
    ("Grey’s Anatomy", "Grey's Anatomy", ["greys anatomy"]),
    ("Suits", "Suits", []),
    ("Mad Men", "Mad Men", []),
    ("House of Cards", "House of Cards", []),
    ("Supernatural", "Supernatural", []),
    ("Smallville", "Smallville", []),
    ("Buffy l’ammazzavampiri", "Buffy the Vampire Slayer", ["buffy"]),
    ("La Regina degli Scacchi", "The Queen's Gambit", ["queens gambit"]),
    ("Westworld", "Westworld", []),
    ("The Mandalorian", "The Mandalorian", ["mandalorian"]),
    ("House of the Dragon", "House of the Dragon", []),
    ("Ozark", "Ozark", []),
    ("You", "You", []),
    ("The Umbrella Academy", "The Umbrella Academy", ["umbrella academy"]),
    ("Stranger", "The Witcher", ["the witcher"]),  # replaced below
    ("The Witcher", "The Witcher", []),
    ("Squid", "Suburra", ["suburra"]),  # cleanup below
    ("Suburra", "Suburra: Blood on Rome", ["suburra la serie"]),
    ("SKAM Italia", "SKAM Italia", ["skam"]),
    ("L’Amica Geniale", "My Brilliant Friend", ["amica geniale"]),
    ("ZeroCalcare", "Tear Along the Dotted Line", ["strappare lungo i bordi"]),
    ("Band of Brothers", "Band of Brothers", []),
    ("Lost in Space", "Lost in Space", []),
    ("The Good Place", "The Good Place", []),
    ("Community", "Community", []),
    ("Malcolm in the Middle", "Malcolm", ["malcolm"]),
    ("Tutto in Famiglia", "My Wife and Kids", []),
    ("Una Mamma per Amica", "Gilmore Girls", ["gilmore girls"]),
    ("Dawson’s Creek", "Dawson's Creek", ["dawsons creek"]),
    ("The O.C.", "The O.C.", ["the oc"]),
    ("One Tree Hill", "One Tree Hill", []),
    ("Desperate Housewives", "Desperate Housewives", []),
]

NEW_ANIME_MANGA: List[Tuple[str, str, List[str]]] = [
    ("Killua Zoldyck", "Hunter x Hunter", ["killua"]),
    ("Gon Freecss", "Hunter x Hunter", ["gon"]),
    ("Hisoka Morow", "Hunter x Hunter", ["hisoka"]),
    ("Roy Mustang", "Fullmetal Alchemist", []),
    ("Alphonse Elric", "Fullmetal Alchemist", ["alphonse"]),
    ("Spike Spiegel", "Cowboy Bebop", []),
    ("All Might", "My Hero Academia", []),
    ("Katsuki Bakugo", "My Hero Academia", ["bakugo"]),
    ("Shoto Todoroki", "My Hero Academia", ["todoroki"]),
    ("Yuji Itadori", "Jujutsu Kaisen", ["itadori"]),
    ("Megumi Fushiguro", "Jujutsu Kaisen", ["fushiguro"]),
    ("Sukuna", "Jujutsu Kaisen", ["ryomen sukuna"]),
    ("Zenitsu Agatsuma", "Demon Slayer", ["zenitsu"]),
    ("Inosuke Hashibira", "Demon Slayer", ["inosuke"]),
    ("Kyojuro Rengoku", "Demon Slayer", ["rengoku"]),
    ("Trunks", "Dragon Ball", []),
    ("Bulma", "Dragon Ball", []),
    ("Crilin", "Dragon Ball", ["krillin"]),
    ("Jiraiya", "Naruto", []),
    ("Tsunade", "Naruto", []),
    ("Gaara", "Naruto", []),
    ("Madara Uchiha", "Naruto", ["madara"]),
    ("Portgas D. Ace", "One Piece", ["ace", "portgas d ace"]),
    ("Trafalgar Law", "One Piece", ["law"]),
    ("TonyTony Chopper", "One Piece", ["chopper", "tony tony chopper"]),
    ("Nico Robin", "One Piece", ["robin"]),
    ("Shanks", "One Piece", []),
    ("Frieren", "Frieren", []),
    ("Denji", "Chainsaw Man", ["chainsaw man"]),
    ("Makima", "Chainsaw Man", []),
    ("Anya Forger", "Spy x Family", ["anya"]),
    ("Loid Forger", "Spy x Family", ["twilight"]),
    ("Shinji Ikari", "Neon Genesis Evangelion", ["shinji"]),
    ("Asuka Langley", "Neon Genesis Evangelion", ["asuka"]),
    ("Rei Ayanami", "Neon Genesis Evangelion", ["rei"]),
    ("Pegasus", "Saint Seiya", ["seiya", "cavalieri dello zodiaco"]),
    ("Holly", "Captain Tsubasa", ["oliver hutton", "tsubasa ozora"]),
    ("Mazinga Z", "Mazinger Z", ["mazinga"]),
    ("Goldrake", "Grendizer", ["ufo robot"]),
    ("Rem", "Re:Zero", []),
    ("Kirito", "Sword Art Online", []),
    ("Asuna Yuuki", "Sword Art Online", ["asuna"]),
    ("Lelouch Lamperouge", "Code Geass", ["lelouch"]),
    ("Ken Kaneki", "Tokyo Ghoul", ["kaneki"]),
    ("Shigeo Kageyama", "Mob Psycho 100", ["mob"]),
    ("Misa Amane", "Death Note", ["misa"]),
    ("Minato Namikaze", "Naruto", ["minato"]),
    ("Genos", "One Punch Man", []),
    ("Armin Arlert", "Attack on Titan", ["armin"]),
    ("Rukia Kuchiki", "Bleach", ["rukia"]),
]

# Wikipedia + Commons expansion map: category -> list of (answer_it, wiki_title_en_or_it, aliases_it)
WIKI_EXPANSIONS: Dict[str, List[Tuple[str, str, List[str]]]] = {
    "cinema-cult": [
        ("Alien", "Alien (1979 film)", []),
        ("Il Quinto Elemento", "The Fifth Element", []),
        ("Le Iene", "Reservoir Dogs", []),
        ("Bastardi senza Gloria", "Inglourious Basterds", []),
        ("Django Unchained", "Django Unchained", []),
        ("Inception", "Inception", []),
        ("Interstellar", "Interstellar (film)", []),
        ("Il Cavaliere Oscuro", "The Dark Knight", ["cavaliere oscuro"]),
        ("Il Silenzio degli Innocenti", "The Silence of the Lambs (film)", []),
        ("Scarface", "Scarface (1983 film)", []),
        ("Quei Bravi Ragazzi", "Goodfellas", []),
        ("C’era una Volta in America", "Once Upon a Time in America", []),
        ("La Vita è Bella", "Life Is Beautiful", []),
        ("Nuovo Cinema Paradiso", "Cinema Paradiso", []),
        ("La Dolce Vita", "La Dolce Vita", []),
        ("Il Buono, il Brutto, il Cattivo", "The Good, the Bad and the Ugly", []),
        ("Schindler’s List", "Schindler's List", []),
        ("Salvate il Soldato Ryan", "Saving Private Ryan", []),
        ("Braveheart", "Braveheart", []),
        ("Taxi Driver", "Taxi Driver", []),
        ("Arancia Meccanica", "A Clockwork Orange (film)", []),
        ("2001: Odissea nello Spazio", "2001: A Space Odyssey", ["odissea nello spazio"]),
        ("Il Grande Lebowski", "The Big Lebowski", ["grande lebowski"]),
        ("Blade Runner", "Blade Runner", []),
        ("Mad Max: Fury Road", "Mad Max: Fury Road", ["mad max"]),
        ("La La Land", "La La Land", []),
        ("Dune", "Dune (2021 film)", []),
        ("Parasite", "Parasite (2019 film)", []),
        ("Amici Miei", "Amici miei", []),
        ("Febbre da Cavallo", "Febbre da cavallo", []),
        ("Bianco, Rosso e Verdone", "Bianco, rosso e Verdone", []),
        ("Ricomincio da Tre", "Ricomincio da tre", []),
        ("Borat", "Borat", []),
        ("Una Notte da Leoni", "The Hangover", ["notte da leoni"]),
        ("L’Attimo Fuggente", "Dead Poets Society", ["attimo fuggente"]),
    ],
    "supereroi": [
        ("Ciclope", "Cyclops (Marvel Comics)", ["cyclops"]),
        ("Tempesta", "Storm (Marvel Comics)", ["storm"]),
        ("Jean Grey", "Jean Grey", ["fenice"]),
        ("Professor X", "Professor X", ["charles xavier"]),
        ("Gambit", "Gambit (Marvel Comics)", []),
        ("Nightcrawler", "Nightcrawler (character)", []),
        ("Bestia", "Beast (Marvel Comics)", ["hank mccoy"]),
        ("Colosso", "Colossus (character)", []),
        ("Mystica", "Mystique (character)", ["mystique"]),
        ("Occhio di Falco", "Hawkeye (Clint Barton)", ["hawkeye"]),
        ("Visione", "Vision (Marvel Comics)", ["vision"]),
        ("Falcon", "Sam Wilson (Marvel Comics)", []),
        ("Soldato d’Inverno", "Bucky Barnes", ["winter soldier", "bucky barnes"]),
        ("Nick Fury", "Nick Fury", []),
        ("War Machine", "War Machine", []),
        ("Wasp", "Wasp (character)", []),
        ("Shang-Chi", "Shang-Chi", []),
        ("Moon Knight", "Moon Knight", []),
        ("Blade", "Blade (character)", []),
        ("Ghost Rider", "Ghost Rider", []),
        ("Ultron", "Ultron", []),
        ("Galactus", "Galactus", []),
        ("Dottor Destino", "Doctor Doom", ["doctor doom"]),
        ("Kingpin", "Kingpin (character)", []),
        ("Mysterio", "Mysterio", []),
        ("Freccia Verde", "Green Arrow", ["green arrow"]),
        ("Lanterna Verde", "Green Lantern", ["green lantern"]),
        ("Cyborg", "Cyborg (DC Comics)", []),
        ("Shazam", "Captain Marvel (DC Comics)", []),
        ("Nightwing", "Nightwing", []),
        ("Robin", "Robin (character)", []),
        ("Bane", "Bane (DC Comics)", []),
        ("Spaventapasseri", "Scarecrow (DC Comics)", ["scarecrow"]),
        ("Poison Ivy", "Poison Ivy (character)", ["edera velenosa"]),
        ("Darkseid", "Darkseid", []),
        ("Homelander", "Homelander", ["patriota"]),
        ("Omni-Man", "Omni-Man", []),
    ],
    "cartoni-animati": [
        ("Marge Simpson", "Marge Simpson", []),
        ("Maggie Simpson", "Maggie Simpson", []),
        ("Sandy Cheeks", "Sandy Cheeks", ["sandy"]),
        ("Mr. Krabs", "Mr. Krabs", ["krabs"]),
        ("Plankton", "Plankton and Karen", []),
        ("Brian Griffin", "Brian Griffin", []),
        ("Lois Griffin", "Lois Griffin", []),
        ("Stan Marsh", "Stan Marsh", []),
        ("Kenny McCormick", "Kenny McCormick", ["kenny"]),
        ("Fry", "Philip J. Fry", ["philip j fry"]),
        ("Leela", "Turanga Leela", []),
        ("BoJack Horseman", "BoJack Horseman", []),
        ("Morty Smith", "Morty Smith", ["morty"]),
        ("Jake il Cane", "Jake the Dog", ["adventure time"]),
        ("Finn l’Avventuriero", "Finn the Human", ["finn"]),
        ("Gumball Watterson", "The Amazing World of Gumball", ["gumball"]),
        ("Ben 10", "Ben 10", []),
        ("Le Superchicche", "The Powerpuff Girls", ["superchicche"]),
        ("Johnny Bravo", "Johnny Bravo", []),
        ("Il Laboratorio di Dexter", "Dexter's Laboratory", ["dexter"]),
        ("Leone il Cane Fifone", "Courage the Cowardly Dog", []),
        ("Taz", "Tasmanian Devil (Looney Tunes)", ["diavolo della tasmania"]),
        ("Gatto Silvestro", "Sylvester the Cat", ["silvestro"]),
        ("Titti", "Tweety", ["tweety"]),
        ("Wile E. Coyote", "Wile E. Coyote and the Road Runner", ["willy il coyote", "beep beep"]),
        ("Asterix", "Asterix", []),
        ("Obelix", "Obelix", []),
        ("Lucky Luke", "Lucky Luke", []),
        ("Peppa Pig", "Peppa Pig", []),
        ("Pimpa", "La Pimpa", ["la pimpa"]),
        ("Bluey", "Bluey (TV series)", []),
    ],
    "personaggi-disney": [
        ("Paperoga", "Fethry Duck", []),
        ("Gastone", "Gladstone Gander", []),
        ("Archimede Pitagorico", "Gyro Gearloose", ["archimede"]),
        ("Amelia", "Magica De Spell", []),
        ("Rockerduck", "John D. Rockerduck", []),
        ("Gambadilegno", "Pete (Disney)", ["pietro gambadilegno"]),
        ("Qui, Quo, Qua", "Huey, Dewey, and Louie", ["qui quo qua"]),
        ("Nonna Papera", "Grandma Duck", []),
        ("Ciccio", "Gus Goose", []),
        ("Saetta McQueen", "Lightning McQueen", ["mcqueen", "cars"]),
        ("Carlotta", "Carl Fredricksen", ["carl fredricksen", "up"]),
        ("Wall-E", "WALL-E", []),
        ("Remy", "Remy (Ratatouille)", ["ratatouille"]),
        ("Nemo", "Finding Nemo", []),
        ("Dory", "Dory (Finding Nemo)", []),
        ("Mike Wazowski", "Mike Wazowski", []),
        ("Sulley", "James P. Sullivan", ["monsters inc"]),
        ("Mr. Incredibile", "Mr. Incredible", ["gli incredibili"]),
        ("Bing Bong", "Inside Out (2015 film)", ["gioia inside out"]),
        ("Olaf", "Olaf (Frozen)", []),
        ("Mushu", "Mushu", []),
        ("Genio", "Genie (Disney)", ["genio di aladdin"]),
        ("Timon e Pumbaa", "Timon and Pumbaa", ["timon", "pumbaa"]),
        ("Baloo", "Baloo", []),
        ("Lillo", "Lilo Pelekai", ["lilo"]),
        ("Gaston", "Gaston (Beauty and the Beast)", []),
        ("Madre Gothel", "Mother Gothel", ["gothel"]),
        ("Yzma", "Yzma", []),
        ("Kronk", "Kronk", []),
        ("Kuzco", "Kuzco", ["follie dell'imperatore"]),
    ],
    "calciatori": [
        ("Rodri", "Rodri (footballer, born 1996)", []),
        ("Bukayo Saka", "Bukayo Saka", []),
        ("Phil Foden", "Phil Foden", []),
        ("Cole Palmer", "Cole Palmer", []),
        ("Pedri", "Pedri", []),
        ("Gavi", "Gavi (footballer)", []),
        ("Jamal Musiala", "Jamal Musiala", []),
        ("Florian Wirtz", "Florian Wirtz", []),
        ("Federico Valverde", "Federico Valverde", []),
        ("Thibaut Courtois", "Thibaut Courtois", []),
        ("Alisson Becker", "Alisson", ["alisson"]),
        ("Virgil van Dijk", "Virgil van Dijk", ["van dijk"]),
        ("Trent Alexander-Arnold", "Trent Alexander-Arnold", []),
        ("Son Heung-min", "Son Heung-min", ["heung min son"]),
        ("Victor Osimhen", "Victor Osimhen", ["osimhen"]),
        ("Khvicha Kvaratskhelia", "Khvicha Kvaratskhelia", ["kvaratskhelia"]),
        ("Rafael Leão", "Rafael Leão", ["leao"]),
        ("Theo Hernández", "Theo Hernandez", []),
        ("Dusan Vlahović", "Dušan Vlahović", ["vlahovic"]),
        ("Federico Dimarco", "Federico Dimarco", ["dimarco"]),
        ("Alessandro Bastoni", "Alessandro Bastoni", ["bastoni"]),
        ("Sandro Tonali", "Sandro Tonali", ["tonali"]),
        ("Ciro Immobile", "Ciro Immobile", ["immobile"]),
        ("Lorenzo Insigne", "Lorenzo Insigne", ["insigne"]),
        ("Marco Verratti", "Marco Verratti", ["verratti"]),
        ("Daniele De Rossi", "Daniele De Rossi", ["de rossi"]),
        ("Luca Toni", "Luca Toni", []),
        ("Antonio Cassano", "Antonio Cassano", ["cassano"]),
        ("Christian Vieri", "Christian Vieri", ["bobo vieri", "vieri"]),
        ("Franco Baresi", "Franco Baresi", ["baresi"]),
        ("Dino Zoff", "Dino Zoff", ["zoff"]),
        ("Michel Platini", "Michel Platini", ["platini"]),
        ("Marco van Basten", "Marco van Basten", ["van basten"]),
        ("Ruud Gullit", "Ruud Gullit", ["gullit"]),
        ("Sergio Ramos", "Sergio Ramos", []),
        ("Andrés Iniesta", "Andrés Iniesta", ["iniesta"]),
        ("Xavi", "Xavi", ["xavi hernandez"]),
        ("Carles Puyol", "Carles Puyol", ["puyol"]),
        ("Iker Casillas", "Iker Casillas", ["casillas"]),
        ("Manuel Neuer", "Manuel Neuer", ["neuer"]),
        ("Thomas Müller", "Thomas Müller", ["muller"]),
        ("Gareth Bale", "Gareth Bale", ["bale"]),
        ("Eden Hazard", "Eden Hazard", ["hazard"]),
        ("Luis Suárez", "Luis Suárez", ["suarez"]),
        ("Didier Drogba", "Didier Drogba", ["drogba"]),
    ],
    "leggende-sport": [
        ("Lorenzo Musetti", "Lorenzo Musetti", ["musetti"]),
        ("Jasmine Paolini", "Jasmine Paolini", ["paolini"]),
        ("Flavio Cobolli", "Flavio Cobolli", []),
        ("Andre Agassi", "Andre Agassi", ["agassi"]),
        ("Pete Sampras", "Pete Sampras", ["sampras"]),
        ("Björn Borg", "Björn Borg", ["borg"]),
        ("Maria Sharapova", "Maria Sharapova", ["sharapova"]),
        ("Venus Williams", "Venus Williams", []),
        ("Coco Gauff", "Coco Gauff", []),
        ("Iga Świątek", "Iga Świątek", ["swiatek"]),
        ("Luka Dončić", "Luka Dončić", ["doncic"]),
        ("Nikola Jokić", "Nikola Jokić", ["jokic"]),
        ("Giannis Antetokounmpo", "Giannis Antetokounmpo", ["giannis"]),
        ("Victor Wembanyama", "Victor Wembanyama", ["wembanyama"]),
        ("Magic Johnson", "Magic Johnson", []),
        ("Larry Bird", "Larry Bird", []),
        ("Tim Duncan", "Tim Duncan", []),
        ("Dirk Nowitzki", "Dirk Nowitzki", []),
        ("Marco Belinelli", "Marco Belinelli", ["belinelli"]),
        ("Danilo Gallinari", "Danilo Gallinari", ["gallinari"]),
        ("Paolo Banchero", "Paolo Banchero", []),
        ("Niki Lauda", "Niki Lauda", ["lauda"]),
        ("Alain Prost", "Alain Prost", ["prost"]),
        ("Sebastian Vettel", "Sebastian Vettel", ["vettel"]),
        ("Kimi Räikkönen", "Kimi Räikkönen", ["raikkonen"]),
        ("Lando Norris", "Lando Norris", ["norris"]),
        ("Oscar Piastri", "Oscar Piastri", ["piastri"]),
        ("Kimi Antonelli", "Kimi Antonelli", []),
        ("Giacomo Agostini", "Giacomo Agostini", ["agostini"]),
        ("Jorge Martín", "Jorge Martín", []),
        ("Carl Lewis", "Carl Lewis", []),
        ("Armand Duplantis", "Armand Duplantis", ["duplantis"]),
        ("Thomas Ceccon", "Thomas Ceccon", ["ceccon"]),
        ("Gregorio Paltrinieri", "Gregorio Paltrinieri", ["paltrinieri"]),
        ("Tom Brady", "Tom Brady", []),
        ("Wayne Gretzky", "Wayne Gretzky", ["gretzky"]),
        ("Floyd Mayweather", "Floyd Mayweather Jr.", ["mayweather"]),
        ("Manny Pacquiao", "Manny Pacquiao", ["pacquiao"]),
        ("Khabib Nurmagomedov", "Khabib Nurmagomedov", ["khabib"]),
        ("Jon Jones", "Jon Jones", []),
        ("Jonas Vingegaard", "Jonas Vingegaard", ["vingegaard"]),
        ("Mathieu van der Poel", "Mathieu van der Poel", ["van der poel"]),
        ("Filippo Ganna", "Filippo Ganna", ["ganna"]),
    ],
    "attori-hollywood": [
        ("Matthew McConaughey", "Matthew McConaughey", []),
        ("Jake Gyllenhaal", "Jake Gyllenhaal", []),
        ("Matt Damon", "Matt Damon", []),
        ("Ben Affleck", "Ben Affleck", []),
        ("George Clooney", "George Clooney", []),
        ("Denzel Washington", "Denzel Washington", []),
        ("Anthony Hopkins", "Anthony Hopkins", []),
        ("Gary Oldman", "Gary Oldman", []),
        ("Clint Eastwood", "Clint Eastwood", []),
        ("Liam Neeson", "Liam Neeson", []),
        ("Ewan McGregor", "Ewan McGregor", []),
        ("Henry Cavill", "Henry Cavill", []),
        ("Chris Hemsworth", "Chris Hemsworth", []),
        ("Chris Evans", "Chris Evans", []),
        ("Mark Ruffalo", "Mark Ruffalo", []),
        ("Benedict Cumberbatch", "Benedict Cumberbatch", []),
        ("Andrew Garfield", "Andrew Garfield", []),
        ("Tobey Maguire", "Tobey Maguire", []),
        ("Austin Butler", "Austin Butler", []),
        ("Jacob Elordi", "Jacob Elordi", []),
        ("Barry Keoghan", "Barry Keoghan", []),
        ("Paul Mescal", "Paul Mescal", []),
        ("Florence Pugh", "Florence Pugh", []),
        ("Saoirse Ronan", "Saoirse Ronan", []),
        ("Cate Blanchett", "Cate Blanchett", []),
        ("Kate Winslet", "Kate Winslet", []),
        ("Nicole Kidman", "Nicole Kidman", []),
        ("Charlize Theron", "Charlize Theron", []),
        ("Sandra Bullock", "Sandra Bullock", []),
        ("Reese Witherspoon", "Reese Witherspoon", []),
        ("Cameron Diaz", "Cameron Diaz", []),
        ("Salma Hayek", "Salma Hayek", []),
        ("Penélope Cruz", "Penélope Cruz", ["penelope cruz"]),
        ("Gal Gadot", "Gal Gadot", []),
        ("Ana de Armas", "Ana de Armas", []),
        ("Millie Bobby Brown", "Millie Bobby Brown", []),
        ("Sadie Sink", "Sadie Sink", []),
        ("Jack Black", "Jack Black", []),
        ("Steve Carell", "Steve Carell", []),
        ("Bryan Cranston", "Bryan Cranston", []),
        ("Giancarlo Esposito", "Giancarlo Esposito", []),
        ("Viggo Mortensen", "Viggo Mortensen", []),
        ("Orlando Bloom", "Orlando Bloom", []),
        ("Ian McKellen", "Ian McKellen", []),
    ],
    "attori-italiani": [
        ("Luca Zingaretti", "Luca Zingaretti", ["montalbano"]),
        ("Marco D’Amore", "Marco D'Amore", ["ciro di marzio"]),
        ("Salvatore Esposito", "Salvatore Esposito (actor)", ["genny savastano"]),
        ("Giacomo Poretti", "Giacomo Poretti", []),
        ("Giovanni Storti", "Giovanni Storti", []),
        ("Aldo Baglio", "Aldo Baglio", []),
        ("Carlo Campanini", "Claudio Bisio", ["bisio"]),
        ("Fabio De Luigi", "Fabio De Luigi", ["de luigi"]),
        ("Claudio Santamaria", "Claudio Santamaria", ["santamaria"]),
        ("Pietro Castellitto", "Pietro Castellitto", []),
        ("Francesco Pannofino", "Francesco Pannofino", ["renè ferretti", "pannofino"]),
        ("Paolo Villaggio", "Paolo Villaggio", ["fantozzi"]),
        ("Vittorio De Sica", "Vittorio De Sica", []),
        ("Totò", "Totò", ["antonio de curtis"]),
        ("Eduardo De Filippo", "Eduardo De Filippo", []),
        ("Franco Franchi", "Franco Franchi", []),
        ("Ciccio Ingrassia", "Ciccio Ingrassia", []),
        ("Nino Frassica", "Nino Frassica", ["frassica"]),
        ("Massimo Ghini", "Massimo Ghini", []),
        ("Giuseppe Battiston", "Giuseppe Battiston", []),
        ("Rocco Papaleo", "Rocco Papaleo", ["papaleo"]),
        ("Riccardo Scamarcio", "Riccardo Scamarcio", ["scamarcio"]),
        ("Alessandro Gassmann", "Alessandro Gassmann", ["gassmann"]),
        ("Valeria Golino", "Valeria Golino", ["golino"]),
        ("Jasmine Trinca", "Jasmine Trinca", ["trinca"]),
        ("Kasia Smutniak", "Kasia Smutniak", ["smutniak"]),
        ("Laura Chiatti", "Laura Chiatti", []),
        ("Cristiana Capotondi", "Cristiana Capotondi", ["capotondi"]),
        ("Micaela Ramazzotti", "Micaela Ramazzotti", ["ramazzotti"]),
        ("Anna Foglietta", "Anna Foglietta", ["foglietta"]),
        ("Virna Lisi", "Virna Lisi", []),
        ("Silvana Mangano", "Silvana Mangano", []),
    ],
    "artisti-pop": [
        ("Charli XCX", "Charli XCX", ["charli xcx"]),
        ("Chappell Roan", "Chappell Roan", []),
        ("SZA", "SZA", []),
        ("Frank Ocean", "Frank Ocean", []),
        ("Tyler, the Creator", "Tyler, the Creator", ["tyler the creator"]),
        ("Kanye West", "Kanye West", ["ye"]),
        ("A$AP Rocky", "ASAP Rocky", ["asap rocky"]),
        ("Future", "Future (rapper)", []),
        ("Metro Boomin", "Metro Boomin", []),
        ("Central Cee", "Central Cee", []),
        ("Stormzy", "Stormzy", []),
        ("Fred again..", "Fred Again", ["fred again"]),
        ("Calvin Harris", "Calvin Harris", []),
        ("David Guetta", "David Guetta", []),
        ("Martin Garrix", "Martin Garrix", []),
        ("Avicii", "Avicii", []),
        ("Skrillex", "Skrillex", []),
        ("Daft Punk", "Daft Punk", []),
        ("Imagine Dragons", "Imagine Dragons", []),
        ("Maroon 5", "Maroon 5", []),
        ("OneRepublic", "OneRepublic", []),
        ("Linkin Park", "Linkin Park", []),
        ("Green Day", "Green Day", []),
        ("Foo Fighters", "Foo Fighters", []),
        ("Red Hot Chili Peppers", "Red Hot Chili Peppers", ["rhcp"]),
        ("Muse", "Muse (band)", []),
        ("Arctic Monkeys", "Arctic Monkeys", ["alex turner"]),
        ("Radiohead", "Radiohead", ["thom yorke"]),
        ("Tame Impala", "Tame Impala", []),
        ("Gorillaz", "Gorillaz", []),
        ("Camila Cabello", "Camila Cabello", []),
        ("Halsey", "Halsey (singer)", []),
        ("Lorde", "Lorde", []),
        ("Kylie Minogue", "Kylie Minogue", []),
        ("Alicia Keys", "Alicia Keys", []),
        ("Usher", "Usher (musician)", []),
        ("Pitbull", "Pitbull (rapper)", []),
        ("Maluma", "Maluma", []),
        ("J Balvin", "J Balvin", []),
        ("Daddy Yankee", "Daddy Yankee", []),
        ("Peso Pluma", "Peso Pluma", []),
        ("Lisa", "Lisa (rapper)", ["lisa blackpink"]),
        ("Jungkook", "Jungkook", ["bts jungkook"]),
    ],
    "musica-italiana": [
        ("Olly", "Olly (singer)", []),
        ("Lucio Corsi", "Lucio Corsi", []),
        ("Brunori Sas", "Brunori Sas", []),
        ("Giorgio Gaber", "Giorgio Gaber", ["gaber"]),
        ("Rino Gaetano", "Rino Gaetano", ["gaetano"]),
        ("Francesco De Gregori", "Francesco De Gregori", ["de gregori"]),
        ("Antonello Venditti", "Antonello Venditti", ["venditti"]),
        ("Franco Battiato", "Franco Battiato", ["battiato"]),
        ("Ivano Fossati", "Ivano Fossati", ["fossati"]),
        ("Roberto Vecchioni", "Roberto Vecchioni", ["vecchioni"]),
        ("Zucchero", "Zucchero Fornaciari", ["zucchero fornaciari"]),
        ("Biagio Antonacci", "Biagio Antonacci", ["antonacci"]),
        ("Gianna Nannini", "Gianna Nannini", ["nannini"]),
        ("Loredana Bertè", "Loredana Bertè", ["loredana berte"]),
        ("Mia Martini", "Mia Martini", []),
        ("Mina", "Mina (Italian singer)", ["mina mazzini"]),
        ("Ornella Vanoni", "Ornella Vanoni", ["vanoni"]),
        ("Patty Pravo", "Patty Pravo", []),
        ("Carmen Consoli", "Carmen Consoli", ["consoli"]),
        ("Fiorella Mannoia", "Fiorella Mannoia", ["mannoia"]),
        ("Arisa", "Arisa", []),
        ("Noemi", "Noemi (singer)", []),
        ("Francesca Michielin", "Francesca Michielin", ["michielin"]),
        ("Levante", "Levante (singer)", []),
        ("Gazzelle", "Gazzelle", []),
        ("Calcutta", "Calcutta (singer)", []),
        ("Carl Brave", "Carl Brave", []),
        ("Pinguini Tattici Nucleari", "Pinguini Tattici Nucleari", ["ptn"]),
        ("Måneskin", "Måneskin", ["maneskin"]),
        ("Negramaro", "Negramaro", ["giuliano sangiorgi"]),
        ("Modà", "Modà", ["moda"]),
        ("883", "883 (band)", []),
        ("Articolo 31", "Articolo 31", ["j-ax", "j ax"]),
        ("Club Dogo", "Club Dogo", ["jake la furia"]),
        ("Noyz Narcos", "Noyz Narcos", []),
        ("Marracash", "Marracash", []),
        ("Rkomi", "Rkomi", []),
        ("Bresh", "Bresh", []),
        ("Tony Effe", "Tony Effe", []),
        ("Shiva", "Shiva (rapper)", []),
        ("Ernia", "Ernia", []),
        ("Alfa", "Alfa (singer)", []),
        ("Gigi D’Alessio", "Gigi D'Alessio", ["gigi dalessio"]),
        ("Nino D’Angelo", "Nino D'Angelo", ["nino dangelo"]),
        ("Andrea Bocelli", "Andrea Bocelli", ["bocelli"]),
    ],
    "animali-selvatici": [
        ("Canguro", "Kangaroo", []),
        ("Tasso del Miele", "Honey badger", ["tasso"]),
        ("Puzzola", "Skunk", []),
        ("Castoro", "Beaver", []),
        ("Istrice", "Porcupine", []),
        ("Riccio", "Hedgehog", []),
        ("Formichiere", "Anteater", []),
        ("Armadillo", "Armadillo", []),
        ("Pangolino", "Pangolin", []),
        ("Tapir", "Tapir", ["tapiro"]),
        ("Capibara", "Capybara", []),
        ("Cinicilla", "Chinchilla", ["cincilla"]),
        ("Alce", "Moose", []),
        ("Renna", "Reindeer", ["caribu"]),
        ("Cervo", "Red deer", []),
        ("Stambecco", "Alpine ibex", []),
        ("Camoscio", "Chamois", []),
        ("Bisonte", "American bison", ["bisonte americano"]),
        ("Bufalo Africano", "African buffalo", ["bufalo"]),
        ("Gnu", "Wildebeest", []),
        ("Gazzella", "Gazelle", []),
        ("Okapi", "Okapi", []),
        ("Dromedario", "Dromedary", []),
        ("Cammello", "Bactrian camel", []),
        ("Vigogna", "Vicuña", ["alpaca"]),
        ("Iena", "Spotted hyena", []),
        ("Licaone", "African wild dog", []),
        ("Scacal", "Jackal", ["sciacallo"]),
        ("Lince", "Eurasian lynx", []),
        ("Puma", "Cougar", ["leone di montagna"]),
        ("Giaguaro", "Jaguar", []),
        ("Pantera Nera", "Black panther", []),
        ("Caracal", "Caracal", []),
        ("Serval", "Serval", []),
        ("Diavolo della Tasmania", "Tasmanian devil", []),
        ("Vombato", "Wombat", []),
        ("Opossum", "Opossum", []),
        ("Mandrillo", "Mandrill", []),
        ("Babbuino", "Baboon", []),
        ("Nasica", "Proboscis monkey", []),
        ("Narvalo", "Narwhal", []),
        ("Beluga", "Beluga whale", []),
        ("Megattera", "Humpback whale", ["balena"]),
        ("Capodoglio", "Sperm whale", []),
        ("Lamantino", "Manatee", []),
    ],
    "cucina-italiana": [
        ("Spaghetti alla Nerano", "Spaghetti alla Nerano", ["nerano"]),
        ("Pasta alla Norma", "Pasta alla Norma", ["norma"]),
        ("Penne all’Arrabbiata", "Penne all'arrabbiata", ["arrabbiata"]),
        ("Pasta e Fagioli", "Pasta e fagioli", []),
        ("Pasta e Patate", "Pasta e patate", []),
        ("Trofie al Pesto", "Trofie", []),
        ("Pizzoccheri", "Pizzoccheri", []),
        ("Canederli", "Knödel", []),
        ("Risotto ai Funghi Porcini", "Risotto", ["risotto ai funghi"]),
        ("Polenta e Osei", "Polenta", ["polenta taragna"]),
        ("Saltimbocca alla Romana", "Saltimbocca", ["saltimbocca"]),
        ("Abbacchio", "Abbacchio", []),
        ("Trippa alla Romana", "Trippa alla romana", ["trippa"]),
        ("Lampredotto", "Lampredotto", []),
        ("Ribollita", "Ribollita", []),
        ("Pappa al Pomodoro", "Pappa al pomodoro", []),
        ("Panzanella", "Panzanella", []),
        ("Frico", "Frico", []),
        ("Culurgiones", "Culurgiones", []),
        ("Malloreddus", "Malloreddus", []),
        ("Seadas", "Seada", []),
        ("Frittata di Spaghetti", "Frittata", []),
        ("Fiori di Zucca Fritti", "Squash blossom", ["fiori di zucca"]),
        ("Carciofi alla Romana", "Carciofi alla romana", ["carciofi alla giudia"]),
        ("Bagna Cauda", "Bagna càuda", []),
        ("Agnolotti", "Agnolotti", []),
        ("Cappelletti", "Cappelletti", []),
        ("Tigelle", "Crescentina modenese", ["gnocco fritto"]),
        ("Torta al Testo", "Torta al testo", []),
        ("Farinata", "Farinata", []),
    ],
    "cucina-mondo": [
        ("Pho", "Pho", ["phở"]),
        ("Bibimbap", "Bibimbap", []),
        ("Kimchi", "Kimchi", []),
        ("Bulgogi", "Bulgogi", []),
        ("Udon", "Udon", []),
        ("Takoyaki", "Takoyaki", []),
        ("Okonomiyaki", "Okonomiyaki", []),
        ("Onigiri", "Onigiri", []),
        ("Tonkatsu", "Tonkatsu", ["katsu"]),
        ("Dim Sum", "Dim sum", []),
        ("Anatra alla Pechinese", "Peking duck", ["peking duck"]),
        ("Riso alla Cantonese", "Fried rice", ["riso fritto"]),
        ("Samosa", "Samosa", []),
        ("Naan", "Naan", []),
        ("Biryani", "Biryani", []),
        ("Pollo Tikka Masala", "Chicken tikka masala", ["tikka masala"]),
        ("Empanada", "Empanada", ["empanadas"]),
        ("Ceviche", "Ceviche", []),
        ("Arepa", "Arepa", []),
        ("Chili con Carne", "Chili con carne", []),
        ("Poutine", "Poutine", []),
        ("Clam Chowder", "Clam chowder", []),
        ("Lobster Roll", "Lobster roll", []),
        ("Poke", "Poke (Hawaiian dish)", ["poke bowl"]),
        ("Gyros", "Gyros", []),
        ("Tzatziki", "Tzatziki", []),
        ("Shakshuka", "Shakshuka", []),
        ("Tajine", "Tagine", ["tagine"]),
        ("Pierogi", "Pierogi", []),
        ("Borscht", "Borscht", []),
    ],
    "dolci-pasticceria": [
        ("Saint Honoré", "St. Honoré cake", ["torta saint honore"]),
        ("Mille-feuille", "Mille-feuille", ["millefoglie francese"]),
        ("Paris-Brest", "Paris–Brest", []),
        ("Tarte Tatin", "Tarte Tatin", []),
        ("Clafoutis", "Clafoutis", []),
        ("Kouign-amann", "Kouign-amann", []),
        ("Madeleine", "Madeleine (cake)", ["madeleines"]),
        ("Canelé", "Canelé", []),
        ("Krapfen", "Berliner (doughnut)", ["bombolone", "bomba alla crema"]),
        ("Apfelstrudel", "Apple strudel", ["strudel"]),
        ("Kaiserschmarrn", "Kaiserschmarrn", []),
        ("Pavlova", "Pavlova (cake)", []),
        ("Banoffee Pie", "Banoffee pie", []),
        ("Key Lime Pie", "Key lime pie", []),
        ("Pumpkin Pie", "Pumpkin pie", []),
        ("Pecan Pie", "Pecan pie", []),
        ("Torta Mimosa", "Torta mimosa", []),
        ("Torta Caprese", "Torta caprese", []),
        ("Delizia al Limone", "Delizia al limone", []),
        ("Pasticciotto", "Pasticciotto", []),
        ("Mustazzoli", "Mustazzoli", []),
        ("Mochi", "Mochi", []),
        ("Dorayaki", "Dorayaki", []),
        ("Taiyaki", "Taiyaki", []),
        ("Pastel de Nata", "Pastel de nata", []),
        ("Alfajor", "Alfajor", []),
        ("Dulce de Leche", "Dulce de leche", []),
        ("Tres Leches", "Tres leches cake", []),
        ("Chiacchiere", "Chiacchiere", ["frappe", "bugie"]),
    ],
    "auto-moto": [
        ("Ferrari Enzo", "Enzo Ferrari (car)", ["enzo"]),
        ("Ferrari LaFerrari", "LaFerrari", ["laferrari"]),
        ("Ferrari 250 GTO", "Ferrari 250 GTO", []),
        ("Lamborghini Aventador", "Lamborghini Aventador", ["aventador"]),
        ("Lamborghini Huracán", "Lamborghini Huracán", ["huracan"]),
        ("Lamborghini Miura", "Lamborghini Miura", ["miura"]),
        ("Lamborghini Urus", "Lamborghini Urus", ["urus"]),
        ("Pagani Zonda", "Pagani Zonda", ["zonda"]),
        ("Pagani Huayra", "Pagani Huayra", ["huayra"]),
        ("Maserati GranTurismo", "Maserati GranTurismo", ["maserati"]),
        ("Alfa Romeo 4C", "Alfa Romeo 4C", []),
        ("Alfa Romeo Spider", "Alfa Romeo Spider", ["duetto"]),
        ("Lancia Stratos", "Lancia Stratos", ["stratos"]),
        ("Fiat Multipla", "Fiat Multipla", ["multipla"]),
        ("Fiat Uno", "Fiat Uno", []),
        ("Abarth 595", "Abarth 500", ["abarth"]),
        ("Bugatti Veyron", "Bugatti Veyron", ["veyron"]),
        ("Koenigsegg Jesko", "Koenigsegg Jesko", ["koenigsegg"]),
        ("McLaren P1", "McLaren P1", []),
        ("Porsche Carrera GT", "Porsche Carrera GT", []),
        ("BMW E30 M3", "BMW M3", []),
        ("Mercedes 300 SL", "Mercedes-Benz 300 SL", ["ali di gabbiano"]),
        ("Ford GT40", "Ford GT40", ["ford gt"]),
        ("Shelby Cobra", "AC Cobra", ["cobra"]),
        ("Dodge Viper", "Dodge Viper", ["viper"]),
        ("Nissan Skyline GT-R R34", "Nissan Skyline GT-R", ["skyline r34"]),
        ("Mazda RX-7", "Mazda RX-7", ["rx7"]),
        ("Mazda MX-5", "Mazda MX-5", ["miata"]),
        ("Honda NSX", "Honda NSX", ["nsx"]),
        ("Ducati Panigale V4", "Ducati Panigale V4", ["panigale"]),
        ("Yamaha YZF-R1", "Yamaha YZF-R1", ["yamaha r1"]),
        ("Kawasaki Ninja", "Kawasaki Ninja ZX-10R", ["ninja"]),
        ("Honda Africa Twin", "Honda Africa Twin", ["africa twin"]),
        ("BMW GS", "BMW R1250GS", ["bmw r1200gs"]),
    ],
    "monumenti": [
        ("Piazza San Marco", "Piazza San Marco", ["san marco"]),
        ("Altare della Patria", "Victor Emmanuel II National Monument", ["vittoriano"]),
        ("Pantheon", "Pantheon, Rome", ["pantheon roma"]),
        ("Castel Sant’Angelo", "Castel Sant'Angelo", ["castel sant angelo"]),
        ("Piazza del Campo", "Piazza del Campo", []),
        ("Valle dei Templi", "Valle dei Templi", ["agrigento"]),
        ("Pompei", "Pompeii", []),
        ("Trulli di Alberobello", "Trullo", []),
        ("Notre-Dame di Parigi", "Notre-Dame de Paris", ["notre dame"]),
        ("Reggia di Versailles", "Palace of Versailles", ["versailles"]),
        ("Sacré-Cœur", "Sacré-Cœur, Paris", ["sacre coeur"]),
        ("Buckingham Palace", "Buckingham Palace", []),
        ("Cattedrale di San Paolo", "St Paul's Cathedral", []),
        ("Alhambra", "Alhambra", []),
        ("Mezquita di Cordova", "Mosque–Cathedral of Córdoba", []),
        ("Park Güell", "Park Güell", ["parc guell"]),
        ("Acropoli di Atene", "Acropolis of Athens", []),
        ("Torre di Belém", "Belém Tower", ["belem"]),
        ("Castello di Neuschwanstein", "Neuschwanstein Castle", ["neuschwanstein"]),
        ("Cattedrale di Colonia", "Cologne Cathedral", []),
        ("Castello di Praga", "Prague Castle", []),
        ("Hagia Sophia", "Hagia Sophia", ["santa sofia"]),
        ("Moschea Blu", "Blue Mosque, Istanbul", []),
        ("Grande Moschea di Cordova", "Sheikh Zayed Grand Mosque", ["moschea abu dhabi"]),
        ("Lincoln Memorial", "Lincoln Memorial", []),
        ("Capitolio di Washington", "United States Capitol", ["capitol hill"]),
        ("Hollywood Sign", "Hollywood Sign", ["scritta hollywood"]),
        ("Teotihuacán", "Teotihuacan", []),
        ("Tikal", "Tikal", []),
        ("Fushimi Inari", "Fushimi Inari-taisha", []),
        ("Kinkaku-ji", "Kinkaku-ji", ["padiglione d'oro"]),
        ("Castello di Himeji", "Himeji Castle", []),
    ],
    "citta-mondo": [
        ("Milano", "Milan", []),
        ("Torino", "Turin", []),
        ("Bologna", "Bologna", []),
        ("Palermo", "Palermo", []),
        ("Verona", "Verona", []),
        ("Matera", "Matera", ["sassi di matera"]),
        ("Lecce", "Lecce", []),
        ("Taormina", "Taormina", []),
        ("Amalfi", "Amalfi", []),
        ("Madrid", "Madrid", []),
        ("Siviglia", "Seville", []),
        ("Valencia", "Valencia", []),
        ("Berlino", "Berlin", []),
        ("Monaco di Baviera", "Munich", []),
        ("Amburgo", "Hamburg", []),
        ("Zurigo", "Zurich", []),
        ("Ginevra", "Geneva", []),
        ("Bruges", "Bruges", []),
        ("Bruxelles", "Brussels", []),
        ("Dublino", "Dublin", []),
        ("Oslo", "Oslo", []),
        ("Helsinki", "Helsinki", []),
        ("Reykjavik", "Reykjavík", []),
        ("Cracovia", "Kraków", []),
        ("Dubrovnik", "Dubrovnik", []),
        ("Atene", "Athens", []),
        ("Mosca", "Moscow", []),
        ("San Pietroburgo", "Saint Petersburg", []),
        ("Gerusalemme", "Jerusalem", []),
        ("Tel Aviv", "Tel Aviv", []),
        ("Miami", "Miami", []),
        ("Los Angeles", "Los Angeles", []),
        ("Chicago", "Chicago", []),
        ("New Orleans", "New Orleans", []),
        ("Toronto", "Toronto", []),
        ("Vancouver", "Vancouver", []),
        ("Città del Messico", "Mexico City", []),
        ("Cartagena", "Cartagena, Colombia", []),
        ("Cusco", "Cusco", []),
        ("Santiago del Cile", "Santiago", []),
        ("Kyoto", "Kyoto", []),
        ("Osaka", "Osaka", []),
        ("Shanghai", "Shanghai", []),
        ("Pechino", "Beijing", []),
        ("Melbourne", "Melbourne", []),
        ("Auckland", "Auckland", []),
    ],
    "personaggi-storici": [
        ("Alessandro Magno", "Alexander the Great", []),
        ("Cleopatra", "Cleopatra", []),
        ("Carlo Magno", "Charlemagne", []),
        ("Marco Polo", "Marco Polo", []),
        ("Cristoforo Colombo", "Christopher Columbus", []),
        ("Amerigo Vespucci", "Amerigo Vespucci", []),
        ("Michelangelo Buonarroti", "Michelangelo", ["michelangelo"]),
        ("Raffaello Sanzio", "Raphael", ["raffaello"]),
        ("Niccolò Machiavelli", "Niccolò Machiavelli", ["machiavelli"]),
        ("William Shakespeare", "William Shakespeare", ["shakespeare"]),
        ("Isaac Newton", "Isaac Newton", ["newton"]),
        ("Charles Darwin", "Charles Darwin", ["darwin"]),
        ("Louis Pasteur", "Louis Pasteur", ["pasteur"]),
        ("Thomas Edison", "Thomas Edison", ["edison"]),
        ("Fratelli Wright", "Wright brothers", ["wright brothers"]),
        ("Alan Turing", "Alan Turing", ["turing"]),
        ("Ada Lovelace", "Ada Lovelace", []),
        ("Rosalind Franklin", "Rosalind Franklin", []),
        ("Rita Levi-Montalcini", "Rita Levi-Montalcini", ["montalcini"]),
        ("Margherita Hack", "Margherita Hack", ["hack"]),
        ("Guglielmo Marconi", "Guglielmo Marconi", ["marconi"]),
        ("Enrico Fermi", "Enrico Fermi", ["fermi"]),
        ("Maria Montessori", "Maria Montessori", ["montessori"]),
        ("Giovanni Falcone", "Giovanni Falcone", ["falcone"]),
        ("Paolo Borsellino", "Paolo Borsellino", ["borsellino"]),
        ("Sandro Pertini", "Sandro Pertini", ["pertini"]),
        ("Camillo Benso di Cavour", "Camillo Benso, Count of Cavour", ["cavour"]),
        ("Giuseppe Mazzini", "Giuseppe Mazzini", ["mazzini"]),
        ("Giovanna d’Arco", "Joan of Arc", ["giovanna d'arco"]),
        ("Regina Vittoria", "Queen Victoria", []),
        ("Elisabetta I", "Elizabeth I", []),
        ("George Washington", "George Washington", ["washington"]),
        ("Franklin D. Roosevelt", "Franklin D. Roosevelt", ["roosevelt"]),
        ("Fidel Castro", "Fidel Castro", []),
        ("Muhammad Ali", "Muhammad Ali", []),
        ("Audrey Hepburn", "Audrey Hepburn", []),
        ("Charlie Chaplin", "Charlie Chaplin", []),
        ("Steve Wozniak", "Steve Wozniak", []),
    ],
    "oggetti-casa": [
        ("Forbici", "Scissors", []),
        ("Coltello da Cucina", "Chef's knife", ["coltello"]),
        ("Cucchiaio di Legno", "Wooden spoon", []),
        ("Colino", "Colander", ["passino"]),
        ("Bilancia da Cucina", "Kitchen scale", ["bilancia"]),
        ("Termometro da Cucina", "Meat thermometer", []),
        ("Cavatappi Elettrico", "Bottle opener", ["apribottiglie"]),
        ("Apriscatole", "Can opener", []),
        ("Spremiaglio", "Garlic press", []),
        ("Passaverdure", "Food mill", []),
        ("Macinacaffè", "Coffee grinder", []),
        ("Bollitore Elettrico", "Electric kettle", ["bollitore"]),
        ("Microonde", "Microwave oven", ["forno a microonde"]),
        ("Fornetto Elettrico", "Toaster oven", []),
        ("Lavastoviglie", "Dishwasher", []),
        ("Scopa", "Broom", []),
        ("Paletta", "Dustpan", []),
        ("Mocio", "Mop", []),
        ("Secchio", "Bucket", []),
        ("Stendibiancheria", "Clothes horse", ["stendino"]),
        ("Asse da Stiro", "Ironing board", []),
        ("Gruccia", "Clothes hanger", ["appendiabiti"]),
        ("Sveglia", "Alarm clock", []),
        ("Torcia Elettrica", "Flashlight", ["pila"]),
        ("Batteria Stilo", "AA battery", ["pila stilo"]),
        ("Prolunga Elettrica", "Extension cord", ["ciabatta elettrica"]),
        ("Nastro Isolante", "Electrical tape", []),
        ("Nastro Adesivo", "Duct tape", ["scotch"]),
        ("Colla a Caldo", "Hot-melt adhesive", ["pistola colla a caldo"]),
        ("Brugola", "Hex key", ["chiave a brugola"]),
        ("Smerigliatrice", "Angle grinder", ["flessibile", "frullino"]),
        ("Avvitatore", "Cordless drill", []),
        ("Cazzuola", "Trowel", []),
        ("Spatola", "Putty knife", []),
    ],
    "strumenti-musicali": [
        ("Clavicembalo", "Harpsichord", []),
        ("Mandoloncello", "Mandola", []),
        ("Balalaica", "Balalaika", ["balalaika"]),
        ("Bouzouki", "Bouzouki", []),
        ("Lira", "Lyre", []),
        ("Liuto", "Lute", []),
        ("Violino Elettrico", "Electric violin", []),
        ("Viola", "Viola", []),
        ("Ottavino", "Piccolo", []),
        ("Fagotto", "Bassoon", []),
        ("Corno Inglese", "Cor anglais", []),
        ("Flauto Dolce", "Recorder (musical instrument)", []),
        ("Ocarina", "Ocarina", []),
        ("Vuvuzela", "Vuvuzela", []),
        ("Theremin", "Theremin", []),
        ("Keytar", "Keytar", []),
        ("Drum Machine", "Drum machine", []),
        ("Hang Drum", "Hang (instrument)", ["handpan"]),
        ("Djembe", "Djembe", []),
        ("Cajón", "Cajón", ["cajon"]),
        ("Congas", "Conga", []),
        ("Timpani", "Timpani", []),
        ("Nacchere", "Castanets", ["castagnette"]),
        ("Campanaccio", "Cowbell (instrument)", []),
        ("Vibrafono", "Vibraphone", []),
        ("Marimba", "Marimba", []),
        ("Celesta", "Celesta", []),
    ],
    "giochi-tavolo": [
        ("Risiko", "Risk (game)", ["risk"]),
        ("Catan", "Catan", ["coloni di catan"]),
        ("Carcassonne", "Carcassonne (board game)", []),
        ("Ticket to Ride", "Ticket to Ride (board game)", []),
        ("Dixit", "Dixit (card game)", []),
        ("Uno", "Uno (card game)", ["carte uno"]),
        ("Cluedo", "Cluedo", ["clue"]),
        ("Taboo", "Taboo (game)", []),
        ("Pictionary", "Pictionary", []),
        ("Trivial Pursuit", "Trivial Pursuit", []),
        ("Mercante in Fiera", "Mercante in fiera", []),
        ("Tombola", "Tombola (game)", []),
        ("Othello", "Reversi", ["reversi"]),
        ("Tris", "Tic-tac-toe", []),
        ("Indovina Chi?", "Guess Who?", ["indovina chi"]),
        ("Salta Pirata", "Pop-Up Pirate", []),
        ("Dama Cinese", "Chinese checkers", []),
        ("Mikado", "Mikado (game)", []),
        ("Ludo", "Ludo", ["non t'arrabbiare"]),
        ("Dobble", "Dobble", []),
        ("7 Wonders", "7 Wonders", []),
        ("Codenames", "Codenames (board game)", ["nome in codice"]),
    ],
    "razze-cani": [
        ("Pastore Australiano", "Australian Shepherd", ["aussie"]),
        ("Pastore Belga Malinois", "Malinois", ["malinois"]),
        ("Cocker Americano", "American Cocker Spaniel", []),
        ("Golden Doodle", "Goldendoodle", []),
        ("Spitz Giapponese", "Japanese Spitz", []),
        ("Lagotto Romagnolo", "Lagotto Romagnolo", ["lagotto"]),
        ("Bracco Italiano", "Bracco Italiano", ["bracco"]),
        ("Segugio Italiano", "Segugio Italiano", []),
        ("Spinone Italiano", "Spinone Italiano", ["spinone"]),
        ("Mastino Napoletano", "Neapolitan Mastiff", []),
        ("Mastino Tibetano", "Tibetan Mastiff", []),
        ("Cane da Pastore Caucasico", "Caucasian Shepherd Dog", []),
        ("Dogo Argentino", "Dogo Argentino", []),
        ("Cane Corso Italiano", "Cane Corso", []),  # dup-safe
        ("Pitbull", "American Pit Bull Terrier", []),
        ("Staffordshire Bull Terrier", "Staffordshire Bull Terrier", ["staffy"]),
        ("Bearded Collie", "Bearded Collie", []),
        ("Bobtail", "Old English Sheepdog", []),
        ("Shetland Sheepdog", "Shetland Sheepdog", []),
        ("Bichon Frisé", "Bichon Frise", ["bichon"]),
        ("Cavalier King", "Cavalier King Charles Spaniel", []),
        ("Shih Tzu", "Shih Tzu", []),
        ("Pechinese", "Pekingese", []),
        ("Lhasa Apso", "Lhasa Apso", []),
        ("Chow", "Eurasier", ["eurasier"]),
        ("Basenji", "Basenji", []),
        ("Whippet", "Whippet", []),
        ("Borzoi", "Borzoi", []),
        ("Levriero Afgano", "Afghan Hound", []),
        ("Rhodesian Ridgeback", "Rhodesian Ridgeback", []),
        ("Weimaraner", "Weimaraner", []),
        ("Vizsla", "Vizsla", []),
    ],
    "razze-gatti": [
        ("Pixie-bob", "Pixie-bob", []),
        ("American Curl", "American Curl", []),
        ("American Shorthair", "American Shorthair", []),
        ("Bombay", "Bombay cat", ["gatto bombay"]),
        ("Havana Brown", "Havana Brown", []),
        ("Singapura", "Singapura cat", []),
        ("Selkirk Rex", "Selkirk Rex", []),
        ("LaPerm", "LaPerm", []),
        ("Nebelung", "Nebelung", []),
        ("Peterbald", "Peterbald", []),
        ("Tonchinese", "Tonkinese cat", []),
        ("Snowshoe", "Snowshoe cat", []),
        ("Ragamuffin", "Ragamuffin cat", []),
        ("Khao Manee", "Khao Manee", []),
        ("Lykoi", "Lykoi", ["gatto lupo"]),
        ("Savannah", "Savannah cat", []),
        ("Chausie", "Chausie", []),
        ("Turco Van", "Turkish Van", []),
        ("Chartreux", "Chartreux", []),
    ],
    "cocktail-bevande": [
        ("Hugo Spritz", "Hugo (cocktail)", ["hugo"]),
        ("Americano", "Americano (cocktail)", []),
        ("Negroni Sbagliato", "Negroni sbagliato", []),
        ("Boulevardier", "Boulevardier (cocktail)", []),
        ("Whiskey Sour", "Whiskey sour", []),
        ("Pisco Sour", "Pisco sour", []),
        ("Paloma", "Paloma (cocktail)", []),
        ("Long Island Iced Tea", "Long Island iced tea", ["long island"]),
        ("Sex on the Beach", "Sex on the beach", []),
        ("Tequila Boom Boom", "Tequila Slammer", []),
        ("B-52", "B-52 (cocktail)", ["b52"]),
        ("White Russian", "White Russian (cocktail)", []),
        ("Black Russian", "Black Russian", []),
        ("Gin Fizz", "Gin fizz", []),
        ("Tom Collins", "Tom Collins", []),
        ("Mint Julep", "Mint julep", []),
        ("Mimosa", "Mimosa (cocktail)", []),
        ("Rossini", "Rossini (cocktail)", []),
        ("Prosecco", "Prosecco", []),
        ("Franciacorta", "Franciacorta DOCG", []),
        ("Barolo", "Barolo", []),
        ("Chianti", "Chianti", []),
        ("Amaro Montenegro", "Amaro (liqueur)", ["amaro"]),
        ("Sambuca", "Sambuca", []),
        ("Grappa", "Grappa", []),
        ("Cidra", "Cider", ["sidro"]),
        ("Kombucha", "Kombucha", []),
        ("Chinotto", "Chinotto (drink)", []),
    ],
    "frutta-verdura": [
        ("Pesca", "Peach", []),
        ("Albicocca", "Apricot", []),
        ("Susina", "Plum", ["prugna"]),
        ("Nectarina", "Nectarine", ["pesca noce"]),
        ("Mela Verde", "Granny Smith", ["mela"]),
        ("Pera", "Pear", []),
        ("Arancia Rossa", "Blood orange", ["arancia"]),
        ("Mandarino", "Mandarin orange", ["clementina"]),
        ("Bergamotto", "Bergamot orange", []),
        ("Cedro", "Citron", []),
        ("Kaki", "Persimmon", ["cachi"]),
        ("Nespola", "Loquat", []),
        ("Giuggiola", "Jujube", []),
        ("Ribes Rosso", "Redcurrant", ["ribes"]),
        ("Uva Spina", "Gooseberry", []),
        ("Mirtillo Rosso", "Cranberry", ["cranberry"]),
        ("Carambola", "Carambola", ["frutto stella"]),
        ("Durian", "Durian", []),
        ("Jackfruit", "Jackfruit", []),
        ("Rambutan", "Rambutan", []),
        ("Guava", "Guava", []),
        ("Pomodoro San Marzano", "San Marzano tomato", ["pomodoro"]),
        ("Patata Viola", "Vitelotte", ["patata"]),
        ("Patata Dolce", "Sweet potato", ["batata"]),
        ("Carota", "Carrot", []),
        ("Bietola", "Chard", []),
        ("Spinacio", "Spinach", ["spinaci"]),
        ("Rucola", "Eruca vesicaria", []),
        ("Lattuga", "Lettuce", []),
        ("Cavolo Nero", "Lacinato kale", ["cavolo"]),
        ("Cavolo Rosso", "Red cabbage", []),
        ("Porro", "Leek", []),
        ("Scalogno", "Shallot", []),
        ("Origano", "Oregano", []),
        ("Salvia", "Salvia officinalis", []),
        ("Timo", "Thyme", []),
    ],
    "fiori-piante": [
        ("Gelsomino", "Jasmine", []),
        ("Gardenia", "Gardenia", []),
        ("Camelia", "Camellia", []),
        ("Azalea", "Azalea", []),
        ("Rododendro", "Rhododendron", []),
        ("Begonia", "Begonia", []),
        ("Geranio", "Pelargonium", []),
        ("Cicoria Selvatica", "Cichorium intybus", []),
        ("Fiordaliso", "Centaurea cyanus", []),
        ("Narciso", "Narcissus (plant)", ["giunchiglia"]),
        ("Giacinto", "Hyacinthus", []),
        ("Iris", "Iris (plant)", ["giaggiolo"]),
        ("Giglo", "Lilium", ["giglio"]),
        ("Calla", "Zantedeschia aethiopica", []),
        ("Dalia", "Dahlia", []),
        ("Crisantemo", "Chrysanthemum", []),
        ("Bouganville", "Bougainvillea", []),
        ("Glicine", "Wisteria", []),
        ("Passiflora", "Passiflora", ["fiore della passione"]),
        ("Magnolia", "Magnolia", []),
        ("Acero Rosso", "Acer palmatum", ["acero giapponese"]),
        ("Betulla", "Birch", []),
        ("Cipresso", "Cupressus sempervirens", []),
        ("Pino Marittimo", "Pinus pinaster", ["pino"]),
        ("Abete Rosso", "Picea abies", ["abete"]),
        ("Ficus", "Ficus elastica", []),
        ("Monstera", "Monstera deliciosa", []),
    ],
    "capolavori-arte": [
        ("Le Ninfee", "Water Lilies (Monet series)", ["ninfee monet"]),
        ("Impressione, Sole Nascente", "Impression, Sunrise", []),
        ("Colazione sull’Erba", "Le Déjeuner sur l'herbe", []),
        ("Olympia", "Olympia (Manet)", []),
        ("Il Bar delle Folies-Bergère", "A Bar at the Folies-Bergère", []),
        ("Ballo al Moulin de la Galette", "Bal du moulin de la Galette", []),
        ("La Classe di Danza", "The Ballet Class (Degas, Musée d'Orsay)", []),
        ("Gli Amanti", "The Lovers (Magritte)", ["magritte gli amanti"]),
        ("Il Figlio dell’Uomo", "The Son of Man", ["mela magritte"]),
        ("Questa non è una Pipa", "The Treachery of Images", ["tradimento delle immagini"]),
        ("La Grande Odalisca", "Grande Odalisque", []),
        ("Il Giuramento degli Orazi", "Oath of the Horatii", []),
        ("La Morte di Marat", "The Death of Marat", []),
        ("Le Tres de Mayo", "The Third of May 1808", ["fucilazione del 3 maggio"]),
        ("Saturno che Divora i suoi Figli", "Saturn Devouring His Son", []),
        ("Il Giardino delle Delizie", "The Garden of Earthly Delights", []),
        ("I Coniugi Arnolfini", "Arnolfini Portrait", []),
        ("Las Meninas", "Las Meninas", []),
        ("La Ragazza con l’Orecchino di Perla", "Girl with a Pearl Earring", []),
        ("Il Lattaio", "The Milkmaid (Vermeer)", ["la lattaia"]),
        ("Il Bacio di Klimt", "The Kiss (Klimt)", []),
        ("Giuditta I", "Judith and the Head of Holofernes", []),
        ("L’Origine del Mondo", "L'Origine du monde", []),
        ("Cappella Sistina", "Sistine Chapel ceiling", []),
        ("Estasi di Santa Teresa", "Ecstasy of Saint Teresa", []),
        ("Apollo e Dafne", "Apollo and Daphne (Bernini)", []),
    ],
    "meraviglie-natura": [
        ("Parco Nazionale dei Laghi di Plitvice", "Plitvice Lakes National Park", ["laghi di plitvice"]),
        ("Isola di Skye", "Skye", []),
        ("Blue Lagoon", "Blue Lagoon (geothermal spa)", ["laguna blu islanda"]),
        ("Kirkjufell", "Kirkjufell", []),
        ("Reynisfjara", "Reynisfjara", ["spiaggia nera islanda"]),
        ("Gole di Verdon", "Verdon Gorge", []),
        ("Caminito del Rey", "Caminito del Rey", []),
        ("Duna di Pilat", "Dune of Pilat", []),
        ("Monte Fitz Roy", "Fitz Roy", []),
        ("Torres del Paine", "Torres del Paine National Park", []),
        ("Deserto di Atacama", "Atacama Desert", []),
        ("Lago Titicaca", "Lake Titicaca", []),
        ("Canyon del Colca", "Colca Canyon", []),
        ("Isola di Pasqua", "Easter Island", ["rapa nui"]),
        ("Bora Bora", "Bora Bora", []),
        ("Milford Sound", "Milford Sound", []),
        ("Waitomo Glowworm Caves", "Waitomo Glowworm Caves", []),
        ("Monte Fuji", "Mount Fuji", []),
        ("Foresta di Bambù di Arashiyama", "Arashiyama", []),
        ("Zhangjiajie", "Zhangjiajie National Forest Park", ["montagne di avatar"]),
        ("Guilin", "Guilin", []),
        ("Monte Roraima", "Mount Roraima", []),
        ("Lençóis Maranhenses", "Lençóis Maranhenses National Park", []),
        ("Delta dell’Okavango", "Okavango Delta", []),
        ("Sossusvlei", "Sossusvlei", []),
    ],
    "spazio-natura": [
        ("Mercurio", "Mercury (planet)", []),
        ("Venere", "Venus", []),
        ("Terra", "Earth", ["pianeta terra"]),
        ("Urano", "Uranus", []),
        ("Nettuno", "Neptune", []),
        ("Plutone", "Pluto", []),
        ("Sole", "Sun", []),
        ("Galassia di Andromeda", "Andromeda Galaxy", ["andromeda"]),
        ("Nebulosa di Orione", "Orion Nebula", []),
        ("Pilastri della Creazione", "Pillars of Creation", []),
        ("Telescopio James Webb", "James Webb Space Telescope", ["jwst", "james webb"]),
        ("Voyager 1", "Voyager 1", []),
        ("Razzo Falcon 9", "Falcon 9", ["spacex falcon"]),
        ("Saturno V", "Saturn V", []),
        ("Supernova", "Supernova", []),
        ("Cometa", "Comet", ["cometa di halley"]),
        ("Eclissi Lunare", "Lunar eclipse", ["luna rossa"]),
        ("Tsunami", "Tsunami", []),
        ("Valanga", "Avalanche", []),
        ("Arcipelago", "Archipelago", []),
        ("Stalagmite", "Stalagmite", []),
        ("Cristallo di Quarzo", "Quartz", []),
    ],
    "creature-mitologiche": [
        ("Era", "Hera", ["giunone"]),
        ("Demetra", "Demeter", ["cerere"]),
        ("Estia", "Hestia", []),
        ("Efesto", "Hephaestus", ["vulcano"]),
        ("Dioniso", "Dionysus", ["bacco"]),
        ("Artemide", "Artemis", ["diana"]),
        ("Crono", "Cronus", []),
        ("Prometeo", "Prometheus", []),
        ("Atlante", "Atlas (mythology)", []),
        ("Icaro", "Icarus", []),
        ("Ulisse", "Odysseus", ["odisseo"]),
        ("Polifemo", "Polyphemus", ["ciclope"]),
        ("Arpie", "Harpy", ["arpia"]),
        ("Gorgone", "Gorgon", []),
        ("Fauno", "Faun", ["satiro"]),
        ("Ninfa", "Nymph", []),
        ("Loki Mitologico", "Loki", []),
        ("Fenrir", "Fenrir", []),
        ("Jörmungandr", "Jörmungandr", []),
        ("Ra", "Ra", ["dio ra"]),
        ("Iside", "Isis", []),
        ("Bastet", "Bastet", []),
        ("Banshee", "Banshee", []),
        ("Leprecauno", "Leprechaun", []),
        ("Troll", "Troll", []),
    ],
    "uccelli-mondo": [
        ("Quetzal", "Resplendent quetzal", []),
        ("Uccello del Paradiso", "Bird-of-paradise", []),
        ("Aquila Reale", "Golden eagle", ["aquila"]),
        ("Aquila Calva", "Bald eagle", ["aquila americana"]),
        ("Poiana", "Common buzzard", []),
        ("Gheppio", "Common kestrel", []),
        ("Barbagianni Comune", "Barn owl", []),
        ("Civetta", "Little owl", []),
        ("Gufo Comune", "Long-eared owl", []),
        ("Avvoltoio Grifone", "Griffon vulture", ["avvoltoio"]),
        ("Ibis Scarlatto", "Scarlet ibis", ["ibis"]),
        ("Spatola", "Eurasian spoonbill", []),
        ("Marabù", "Marabou stork", []),
        ("Gru Giapponese", "Red-crowned crane", ["gru"]),
        ("Cormorano", "Great cormorant", []),
        ("Sula", "Northern gannet", ["sula bassana"]),
        ("Fregata", "Frigatebird", []),
        ("Alca", "Razorbill", []),
        ("Uria", "Common murre", []),
        ("Pappagallo Cenerino", "Grey parrot", ["cenerino"]),
        ("Ara Giacinto", "Hyacinth macaw", []),
        ("Lorichetto", "Rainbow lorikeet", []),
        ("Calao", "Hornbill", ["bucero"]),
        ("Casuario", "Cassowary", []),
    ],
    "rettili-abissi": [
        ("Varanus", "Monitor lizard", ["varano"]),
        ("Basilisco", "Basilisk (lizard)", ["lucertola gesu"]),
        ("Lucertola Collare", "Frilled lizard", ["clamidosauro"]),
        ("Mostro di Gila", "Gila monster", []),
        ("Anaconda Verde", "Green anaconda", ["anaconda"]),
        ("Mamba Nero", "Black mamba", []),
        ("Vipera", "Vipera aspis", []),
        ("Boa Constrictor", "Boa constrictor", ["boa"]),
        ("Testuggine delle Galapagos", "Galápagos tortoise", []),
        ("Tartaruga Azzannatrice", "Common snapping turtle", []),
        ("Coccodrillo Marino", "Saltwater crocodile", []),
        ("Alligatore", "American alligator", []),
        ("Gaviale", "Gharial", []),
        ("Squalo Tigre", "Tiger shark", []),
        ("Squalo Volpe", "Thresher shark", []),
        ("Manta Oceanica", "Giant oceanic manta ray", ["manta"]),
        ("Pesce Vela", "Sailfish", []),
        ("Barracuda", "Barracuda", []),
        ("Pesce Abissale", "Anglerfish", ["rana pescatrice"]),
        ("Calamaro Gigante", "Giant squid", ["calamaro"]),
        ("Polpo dagli Anelli Blu", "Blue-ringed octopus", []),
        ("Granchio Gigante del Giappone", "Japanese spider crab", []),
        ("Narvalo Artico", "Narwhal", []),
    ],
    "insetti-artropodi": [
        ("Farfalla Morpho", "Morpho", ["morpho blu"]),
        ("Falena Atlante", "Attacus atlas", []),
        ("Sfinge Testa di Morto", "Death's-head hawkmoth", []),
        ("Scarabeo Rinoceronte", "Rhinoceros beetle", []),
        ("Scarabeo Golia", "Goliathus", []),
        ("Cetonia Dorata", "Cetonia aurata", []),
        ("Calabrone", "European hornet", []),
        ("Calabrone Asiatico", "Asian giant hornet", []),
        ("Vespa Vasaia", "Mud dauber", []),
        ("Bombo Terrestre", "Bombus terrestris", []),
        ("Formica Tagliafoglie", "Leafcutter ant", []),
        ("Mantide Orchidea", "Hymenopus coronatus", []),
        ("Locusta Migratrice", "Locust", ["locusta"]),
        ("Gerride", "Gerridae", ["insetto pattinatore"]),
        ("Scolopendra", "Scolopendra", ["centopiedi"]),
        ("Ragno Pavone", "Maratus volans", []),
        ("Ragno Lupo", "Wolf spider", []),
        ("Scorpione Imperatore", "Emperor scorpion", []),
        ("Astice", "European lobster", []),
        ("Scampo", "Nephrops norvegicus", []),
    ],
}


# ---------------------------------------------------------------------------
# Main Pipeline
# ---------------------------------------------------------------------------

def next_item_id(cat_id: str, existing_items: List[Dict[str, Any]]) -> int:
    max_n = 0
    prefix = f"{cat_id}-"
    for it in existing_items:
        iid = it.get("id") or ""
        if iid.startswith(prefix):
            tail = iid[len(prefix) :]
            if tail.isdigit():
                max_n = max(max_n, int(tail))
    return max_n + 1


def expand_videogiochi(cat_data: Dict[str, Any]) -> int:
    items = cat_data["items"]
    existing_norm = {norm_text(it["answer"]) for it in items}
    idx = next_item_id("videogiochi", items)
    added = 0

    # First, enrich existing items with < 3 URLs (Minecraft, Super Mario, Zelda, Sonic, Pac-Man)
    def enrich_existing_vg(it: Dict[str, Any]) -> None:
        cur = list(dict.fromkeys([normalize_url(u) for u in (it.get("imageUrls") or [it["imageUrl"]]) if u]))
        if len(cur) >= 3:
            return
        extra = fetch_steam_screenshots(it["answer"], limit=3)
        if len(cur) + len(extra) < 3:
            extra.extend(fetch_commons_images(f"{it['answer']} video game", limit=4))
        for u in extra:
            if u not in cur:
                cur.append(u)
            if len(cur) >= 4:
                break
        if cur:
            it["imageUrl"] = cur[0]
            if len(cur) > 1:
                it["imageUrls"] = cur

    with ThreadPoolExecutor(max_workers=6) as pool:
        futs = [pool.submit(enrich_existing_vg, it) for it in items if len(it.get("imageUrls") or [it["imageUrl"]]) < 3]
        for f in as_completed(futs):
            f.result()

    # Add NEW_VIDEOGIOCHI concurrently
    candidates_to_add = [row for row in NEW_VIDEOGIOCHI if norm_text(row[0]) not in existing_norm]

    def resolve_vg(row: Tuple[str, str, Optional[int], str, List[str]]) -> Optional[Dict[str, Any]]:
        ans, steam_q, aid, commons_q, extra_aliases = row
        urls: List[str] = []
        if steam_q or aid:
            urls.extend(fetch_steam_screenshots(steam_q or ans, aid, limit=4))
        if len(urls) < 2 and commons_q:
            for u in fetch_commons_images(commons_q, limit=4):
                if u not in urls:
                    urls.append(u)
        if len(urls) < 2:
            for u in fetch_wikipedia_media_extras([ans], limit=3):
                if u not in urls:
                    urls.append(u)
        if not urls:
            return None
        aliases, _ = make_aliases(ans, extra_aliases)
        obj: Dict[str, Any] = {
            "id": "",
            "answer": ans,
            "aliases": aliases,
            "imageUrl": urls[0],
        }
        if len(urls) > 1:
            obj["imageUrls"] = urls[:4]
        return obj

    results: List[Dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=8) as pool:
        futs = [pool.submit(resolve_vg, r) for r in candidates_to_add]
        for f in as_completed(futs):
            res = f.result()
            if res:
                results.append(res)

    # Preserve input ordering from NEW_VIDEOGIOCHI
    by_norm = {norm_text(r["answer"]): r for r in results}
    for row in candidates_to_add:
        n = norm_text(row[0])
        if n in by_norm and n not in existing_norm:
            obj = by_norm[n]
            obj["id"] = f"videogiochi-{idx}"
            idx += 1
            items.append(obj)
            existing_norm.add(n)
            added += 1
    return added


def expand_pokemon(cat_data: Dict[str, Any]) -> int:
    items = cat_data["items"]
    existing_norm = {norm_text(it["answer"]) for it in items}
    idx = next_item_id("pokemon", items)
    added = 0

    # Also add shiny URL to existing pokemon items if verified HTTP 200
    def enrich_shiny(it: Dict[str, Any]) -> None:
        cur = list(dict.fromkeys([normalize_url(u) for u in (it.get("imageUrls") or [it["imageUrl"]]) if u]))
        if len(cur) >= 2:
            return
        m = re.search(r"/official-artwork/(\d+)\.png$", cur[0])
        if not m:
            return
        shiny_url = f"https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/shiny/{m.group(1)}.png"
        c = is_clean_url(shiny_url, it["answer"])
        if c and _head_ok(c):
            cur.append(c)
            it["imageUrl"] = cur[0]
            it["imageUrls"] = cur

    with ThreadPoolExecutor(max_workers=12) as pool:
        for f in [pool.submit(enrich_shiny, it) for it in items]:
            f.result()

    to_add = [r for r in NEW_POKEMON if norm_text(r[0]) not in existing_norm]

    def resolve_poke(row: Tuple[str, int, List[str]]) -> Optional[Dict[str, Any]]:
        ans, dex_id, extra_aliases = row
        # Capitalize cleanly if typo in raw list (like houndoom -> Houndoom)
        ans_clean = ans[0].upper() + ans[1:] if ans else ans
        base_url = f"https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/{dex_id}.png"
        shiny_url = f"https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/shiny/{dex_id}.png"
        c_base = is_clean_url(base_url, ans_clean)
        if not c_base or not _head_ok(c_base):
            return None
        urls = [c_base]
        c_shiny = is_clean_url(shiny_url, ans_clean)
        if c_shiny and _head_ok(c_shiny):
            urls.append(c_shiny)
        aliases, _ = make_aliases(ans_clean, extra_aliases)
        obj: Dict[str, Any] = {
            "id": "",
            "answer": ans_clean,
            "aliases": aliases,
            "imageUrl": urls[0],
        }
        if len(urls) > 1:
            obj["imageUrls"] = urls
        return obj

    resolved: Dict[str, Dict[str, Any]] = {}
    with ThreadPoolExecutor(max_workers=16) as pool:
        futs = {pool.submit(resolve_poke, r): r for r in to_add}
        for f in as_completed(futs):
            res = f.result()
            if res:
                resolved[norm_text(res["answer"])] = res

    for row in to_add:
        n = norm_text(row[0])
        if n in resolved and n not in existing_norm:
            obj = resolved[n]
            obj["id"] = f"pokemon-{idx}"
            idx += 1
            items.append(obj)
            existing_norm.add(n)
            added += 1
    return added


def expand_bandiere(cat_data: Dict[str, Any]) -> int:
    items = cat_data["items"]
    existing_norm = {norm_text(it["answer"]) for it in items}
    idx = next_item_id("bandiere", items)
    added = 0

    to_add = [r for r in NEW_BANDIERE if norm_text(r[0]) not in existing_norm]

    def resolve_flag(row: Tuple[str, str, str, List[str]]) -> Optional[Dict[str, Any]]:
        ans_it, iso2, ans_en, extra = row
        url = f"https://flagcdn.com/w640/{iso2.lower()}.png"
        c = is_clean_url(url, f"{ans_en} flag")
        if not c or not _head_ok(c):
            return None
        aliases, _ = make_aliases(ans_it, extra)
        obj: Dict[str, Any] = {
            "id": "",
            "answer": ans_it,
            "aliases": aliases,
            "imageUrl": c,
            "answerEn": ans_en,
            "aliasesEn": [],
        }
        return obj

    resolved: Dict[str, Dict[str, Any]] = {}
    with ThreadPoolExecutor(max_workers=16) as pool:
        for f in [pool.submit(resolve_flag, r) for r in to_add]:
            res = f.result()
            if res:
                resolved[norm_text(res["answer"])] = res

    for row in to_add:
        n = norm_text(row[0])
        if n in resolved and n not in existing_norm:
            obj = resolved[n]
            obj["id"] = f"bandiere-{idx}"
            idx += 1
            items.append(obj)
            existing_norm.add(n)
            added += 1
    return added


def expand_serie_tv(cat_data: Dict[str, Any]) -> int:
    items = cat_data["items"]
    existing_norm = {norm_text(it["answer"]) for it in items}
    idx = next_item_id("serie-tv", items)
    added = 0

    to_add = [r for r in NEW_SERIE_TV if norm_text(r[0]) not in existing_norm and r[0] not in ("Stranger", "Squid")]

    def resolve_tv(row: Tuple[str, str, List[str]]) -> Optional[Dict[str, Any]]:
        ans, q, extra = row
        urls = fetch_tvmaze_images(q or ans, limit=4)
        if len(urls) < 2:
            for u in fetch_wikipedia_media_extras([q or ans], limit=3):
                if u not in urls:
                    urls.append(u)
        if not urls:
            return None
        aliases, _ = make_aliases(ans, extra)
        obj: Dict[str, Any] = {
            "id": "",
            "answer": ans,
            "aliases": aliases,
            "imageUrl": urls[0],
        }
        if len(urls) > 1:
            obj["imageUrls"] = urls[:4]
        return obj

    resolved: Dict[str, Dict[str, Any]] = {}
    with ThreadPoolExecutor(max_workers=8) as pool:
        for f in [pool.submit(resolve_tv, r) for r in to_add]:
            res = f.result()
            if res:
                resolved[norm_text(res["answer"])] = res

    for row in to_add:
        n = norm_text(row[0])
        if n in resolved and n not in existing_norm:
            obj = resolved[n]
            obj["id"] = f"serie-tv-{idx}"
            idx += 1
            items.append(obj)
            existing_norm.add(n)
            added += 1
    return added


def expand_anime(cat_data: Dict[str, Any]) -> int:
    items = cat_data["items"]
    existing_norm = {norm_text(it["answer"]) for it in items}
    idx = next_item_id("anime-manga", items)
    added = 0

    to_add = [r for r in NEW_ANIME_MANGA if norm_text(r[0]) not in existing_norm]

    def resolve_an(row: Tuple[str, str, List[str]]) -> Optional[Dict[str, Any]]:
        ans, series, extra = row
        urls = fetch_anilist_images(ans, series_hint=series, limit=3)
        if not urls:
            urls = fetch_wikipedia_media_extras([f"{ans} {series}"], limit=2)
        if not urls:
            return None
        aliases, _ = make_aliases(ans, extra)
        obj: Dict[str, Any] = {
            "id": "",
            "answer": ans,
            "aliases": aliases,
            "imageUrl": urls[0],
        }
        if len(urls) > 1:
            obj["imageUrls"] = urls[:3]
        return obj

    resolved: Dict[str, Dict[str, Any]] = {}
    with ThreadPoolExecutor(max_workers=8) as pool:
        for f in [pool.submit(resolve_an, r) for r in to_add]:
            res = f.result()
            if res:
                resolved[norm_text(res["answer"])] = res

    for row in to_add:
        n = norm_text(row[0])
        if n in resolved and n not in existing_norm:
            obj = resolved[n]
            obj["id"] = f"anime-manga-{idx}"
            idx += 1
            items.append(obj)
            existing_norm.add(n)
            added += 1
    return added


def expand_wiki_category(cat_id: str, cat_data: Dict[str, Any], rows: List[Tuple[str, str, List[str]]]) -> int:
    items = cat_data["items"]
    existing_norm = {norm_text(it["answer"]) for it in items}
    idx = next_item_id(cat_id, items)

    to_add = [r for r in rows if norm_text(r[0]) not in existing_norm]
    if not to_add:
        return 0

    # Step 1: fast batched Wikipedia EN + IT pageimages
    wiki_titles = [r[1] for r in to_add if r[1]]
    en_imgs = fetch_wikipedia_pageimages_batch(wiki_titles, lang="en")
    it_imgs = fetch_wikipedia_pageimages_batch([r[0] for r in to_add], lang="it")

    # Step 2: per-item Commons extra photos (target 2-3 photos per item where available!)
    def resolve_row(row: Tuple[str, str, List[str]]) -> Optional[Dict[str, Any]]:
        ans, wiki_t, extra = row
        urls: List[str] = []
        for candidate in (en_imgs.get(wiki_t), it_imgs.get(ans)):
            if candidate and candidate not in urls:
                urls.append(candidate)
        if len(urls) < 3:
            search_q = wiki_t.split("(")[0].strip() if wiki_t else ans
            for u in fetch_commons_images(search_q, limit=4):
                if u not in urls:
                    urls.append(u)
                if len(urls) >= 3:
                    break
        if not urls:
            for u in fetch_wikipedia_media_extras([wiki_t, ans], limit=2):
                if u not in urls:
                    urls.append(u)
        if not urls:
            return None
        aliases, _ = make_aliases(ans, extra)
        obj: Dict[str, Any] = {
            "id": "",
            "answer": ans,
            "aliases": aliases,
            "imageUrl": urls[0],
        }
        if len(urls) > 1:
            obj["imageUrls"] = urls[:3]
        return obj

    resolved: Dict[str, Dict[str, Any]] = {}
    with ThreadPoolExecutor(max_workers=10) as pool:
        for f in [pool.submit(resolve_row, r) for r in to_add]:
            res = f.result()
            if res:
                resolved[norm_text(res["answer"])] = res

    added = 0
    for row in to_add:
        n = norm_text(row[0])
        if n in resolved and n not in existing_norm:
            obj = resolved[n]
            obj["id"] = f"{cat_id}-{idx}"
            idx += 1
            items.append(obj)
            existing_norm.add(n)
            added += 1
    return added


# Categories where multi-photo rotation makes matches feel 3x fresher without breaking iconic logos/flags
MULTI_PHOTO_TARGETS = {
    "animali-selvatici",
    "auto-moto",
    "citta-mondo",
    "cocktail-bevande",
    "cucina-italiana",
    "cucina-mondo",
    "discipline-sportive",
    "dolci-pasticceria",
    "fiori-piante",
    "formaggi-salumi",
    "frutta-verdura",
    "insetti-artropodi",
    "meraviglie-natura",
    "minerali-gemme",
    "monumenti",
    "oggetti-casa",
    "ponti-architetture",
    "razze-cani",
    "razze-gatti",
    "rettili-abissi",
    "spazio-natura",
    "sport-invernali-estremi",
    "strumenti-musicali",
    "strumenti-scientifici",
    "uccelli-mondo",
    "serie-tv",
    "cinema-cult",
    "supereroi",
    "personaggi-storici",
    "mestieri",
    "mezzi-lavoro-soccorso",
    "moda-accessori",
}


def enrich_multi_photos(cat_id: str, cat_data: Dict[str, Any], target_photos: int = 3) -> int:
    """Append additional clean photos to existing single-photo items so rotation works every round."""
    if cat_id not in MULTI_PHOTO_TARGETS:
        return 0
    items = cat_data["items"]
    need = [it for it in items if len(it.get("imageUrls") or [it["imageUrl"]]) < 2]
    if not need:
        return 0

    added_urls = 0

    def fetch_extra(it: Dict[str, Any]) -> int:
        cur = list(dict.fromkeys([normalize_url(u) for u in (it.get("imageUrls") or [it["imageUrl"]]) if u]))
        before = len(cur)
        q = (it.get("answerEn") or it["answer"]).strip()
        extra: List[str] = []
        if cat_id == "serie-tv":
            extra = fetch_tvmaze_images(q, limit=target_photos)
        if len(extra) < 2:
            for u in fetch_commons_images(q, limit=target_photos + 1):
                if u not in extra:
                    extra.append(u)
        for u in extra:
            if u not in cur:
                cur.append(u)
            if len(cur) >= target_photos:
                break
        if len(cur) > before:
            it["imageUrl"] = cur[0]
            it["imageUrls"] = cur
            return len(cur) - before
        return 0

    with ThreadPoolExecutor(max_workers=10) as pool:
        for f in [pool.submit(fetch_extra, it) for it in need]:
            added_urls += f.result()
    return added_urls


def sync_all_and_verify() -> None:
    index_data = json.loads(INDEX_PATH.read_text(encoding="utf-8"))
    gen_catalog = json.loads(GENERATED_CATALOG_PATH.read_text(encoding="utf-8"))
    cat_order = [c["id"] for c in gen_catalog]

    total_items_added = 0
    total_urls_added = 0
    grand_items = 0
    grand_urls = 0

    updated_by_id: Dict[str, Dict[str, Any]] = {}

    for cid in cat_order:
        cat_file = CATEGORIES_DIR / f"{cid}.json"
        cat_data = json.loads(cat_file.read_text(encoding="utf-8"))
        before_items = len(cat_data["items"])
        before_urls = sum(len(it.get("imageUrls") or [it["imageUrl"]]) for it in cat_data["items"])

        added_items = 0
        if cid == "videogiochi":
            added_items = expand_videogiochi(cat_data)
        elif cid == "pokemon":
            added_items = expand_pokemon(cat_data)
        elif cid == "bandiere":
            added_items = expand_bandiere(cat_data)
        elif cid == "serie-tv":
            added_items = expand_serie_tv(cat_data)
        elif cid == "anime-manga":
            added_items = expand_anime(cat_data)
        elif cid in WIKI_EXPANSIONS:
            added_items = expand_wiki_category(cid, cat_data, WIKI_EXPANSIONS[cid])

        enrich_multi_photos(cid, cat_data, target_photos=3)

        # Final invariant scrub per item
        for it in cat_data["items"]:
            raw_list = it.get("imageUrls") or [it["imageUrl"]]
            cleaned_list: List[str] = []
            for u in raw_list:
                nu = normalize_url(u)
                if nu and nu.startswith("https://") and "?" not in nu and "twemoji" not in nu.lower():
                    if nu not in cleaned_list:
                        cleaned_list.append(nu)
            if not cleaned_list:
                cleaned_list = [normalize_url(it["imageUrl"])]
            it["imageUrl"] = cleaned_list[0]
            if len(cleaned_list) > 1:
                it["imageUrls"] = cleaned_list
            elif "imageUrls" in it and len(cleaned_list) == 1:
                it["imageUrls"] = cleaned_list

        after_items = len(cat_data["items"])
        after_urls = sum(len(it.get("imageUrls") or [it["imageUrl"]]) for it in cat_data["items"])

        total_items_added += added_items
        total_urls_added += after_urls - before_urls
        grand_items += after_items
        grand_urls += after_urls

        cat_file.write_text(json.dumps(cat_data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        updated_by_id[cid] = cat_data

        if added_items > 0 or after_urls > before_urls:
            print(
                f"[EXPAND] {cid:24s} items: {before_items:3d} -> {after_items:3d} (+{added_items:2d}) | "
                f"urls: {before_urls:3d} -> {after_urls:3d} (+{after_urls - before_urls:3d})",
                flush=True,
            )

    # Update index.json & generatedCatalog.json
    index_data["totalCategories"] = len(cat_order)
    index_data["totalPhotos"] = grand_items
    for meta in index_data["categories"]:
        cid = meta["id"]
        if cid in updated_by_id:
            meta["itemCount"] = len(updated_by_id[cid]["items"])
    INDEX_PATH.write_text(json.dumps(index_data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    new_gen = [updated_by_id[cid] for cid in cat_order]
    GENERATED_CATALOG_PATH.write_text(json.dumps(new_gen, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print("\n=== MASSIVE CATALOG EXPANSION COMPLETE ===", flush=True)
    print(f"Categories synced : {len(cat_order)}", flush=True)
    print(f"Total items       : {grand_items} (+{total_items_added})", flush=True)
    print(f"Total imageUrls   : {grand_urls} (+{total_urls_added})", flush=True)


if __name__ == "__main__":
    sync_all_and_verify()
