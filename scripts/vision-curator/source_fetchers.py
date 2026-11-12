"""Multi-source image candidate fetcher with entity disambiguation and metadata filtering."""

from __future__ import annotations

import re
import time
from typing import Any, Dict, Iterable, List, Optional
from urllib.parse import quote

import requests

from pixel_metrics import normalize_url, upgrade_wikimedia_thumb_url

USER_AGENT = "YappikVisionCurator/1.0 (https://github.com/albertorosati/yappik; trivia curation bot)"

_HTTP = requests.Session()
_HTTP.headers.update({"User-Agent": USER_AGENT})

COMMONS_BAD_META = (
    "logo", "wordmark", "poster", "locandina", "title card", "titlecard", "title screen",
    "album cover", "book cover", "dvd cover", "box art", "comic cover", "variant cover",
    "grave", "headstone", "tomb", "cemetery", "tomba", "waxwork", "wax museum", "grevin",
    "tussaud", "plaque", "signature", "autograph", "coat of arms", "stemma", "map of",
    "locator map", "diagram", "infographic", "skeleton", "skull", "fossil", "specimen jar",
    "preserved in", "illustration", "engraving", "lithograph", "woodcut", "disambig",
    "walk of fame", "newspaper", "screenshot of title", "capsule_616x353", "library_hero",
)


def _get_json(url: str, timeout: int = 10) -> Any:
    for attempt in range(2):
        try:
            r = _HTTP.get(url, timeout=timeout)
            if r.status_code == 200:
                return r.json()
            if r.status_code == 429:
                time.sleep(1.0 * (attempt + 1))
        except Exception:
            time.sleep(0.3)
    return None


def _is_meta_clean(text: str, extra_forbidden: Iterable[str]) -> bool:
    low = (text or "").lower()
    if any(ext in low for ext in (".svg", ".gif", ".tif", ".tiff", ".pdf", ".ogg", ".webm", ".ogv")):
        return False
    for bad in COMMONS_BAD_META:
        if bad in low:
            return False
    for bad in extra_forbidden:
        if bad and len(bad) >= 3 and bad.lower() in low:
            return False
    return True


def _push_candidate(
    out: List[Dict[str, Any]],
    url: str,
    source: str,
    title: str,
    width: int,
    height: int,
    seen: set[str],
    blacklisted: set[str],
    extra_forbidden: Iterable[str],
) -> None:
    clean = upgrade_wikimedia_thumb_url(normalize_url(url), 960)
    if not clean or clean in seen or clean.lower() in blacklisted:
        return
    if not _is_meta_clean(f"{clean} {title}", extra_forbidden):
        return
    if width > 0 and height > 0:
        if width < 320 and height < 240:
            return
        ar = width / max(1, height)
        if ar < 0.50 or ar > 2.25:
            return
    seen.add(clean)
    out.append(
        {
            "url": clean,
            "source": source,
            "title": title,
            "width": width,
            "height": height,
        }
    )


def fetch_steam_candidates(
    queries: List[str], seen: set[str], blacklisted: set[str], extra_forbidden: Iterable[str], limit: int = 6
) -> List[Dict[str, Any]]:
    results: List[Dict[str, Any]] = []
    for q in queries[:2]:
        data = _get_json(f"https://store.steampowered.com/api/storesearch/?term={quote(q)}&l=english&cc=US")
        items = (data or {}).get("items") or []
        for entry in items[:2]:
            appid = entry.get("id")
            if not appid:
                continue
            detail = _get_json(f"https://store.steampowered.com/api/appdetails?appids={appid}")
            app_info = ((detail or {}).get(str(appid)) or {}).get("data") or {}
            for ss in (app_info.get("screenshots") or [])[:limit]:
                _push_candidate(
                    results,
                    ss.get("path_full") or "",
                    "steam",
                    f"{entry.get('name', q)} screenshot",
                    1920,
                    1080,
                    seen,
                    blacklisted,
                    extra_forbidden,
                )
            if len(results) >= limit:
                return results[:limit]
    return results[:limit]


def fetch_tvmaze_candidates(
    queries: List[str], seen: set[str], blacklisted: set[str], extra_forbidden: Iterable[str], limit: int = 6
) -> List[Dict[str, Any]]:
    results: List[Dict[str, Any]] = []
    for q in queries[:2]:
        shows = _get_json(f"https://api.tvmaze.com/search/shows?q={quote(q)}")
        if not isinstance(shows, list):
            continue
        for item in shows[:2]:
            show = item.get("show") or {}
            sid = show.get("id")
            if not sid:
                continue
            imgs = _get_json(f"https://api.tvmaze.com/shows/{sid}/images")
            if isinstance(imgs, list):
                # Strongly prefer text-free 'background' stills over title posters
                backgrounds = [im for im in imgs if im.get("type") == "background"]
                for bg in backgrounds[:limit]:
                    orig = (bg.get("resolutions") or {}).get("original") or {}
                    _push_candidate(
                        results,
                        orig.get("url") or "",
                        "tvmaze_bg",
                        f"{show.get('name', q)} scene background",
                        int(orig.get("width") or 1280),
                        int(orig.get("height") or 720),
                        seen,
                        blacklisted,
                        extra_forbidden,
                    )
            if len(results) >= limit:
                return results[:limit]
            # Fallback to lead cast portraits (clear actor face from show)
            cast = _get_json(f"https://api.tvmaze.com/shows/{sid}/cast")
            if isinstance(cast, list):
                for c in cast[:3]:
                    img = ((c.get("character") or {}).get("image") or {}) or ((c.get("person") or {}).get("image") or {})
                    _push_candidate(
                        results,
                        img.get("original") or "",
                        "tvmaze_cast",
                        f"{show.get('name', q)} character",
                        600,
                        800,
                        seen,
                        blacklisted,
                        extra_forbidden,
                    )
            if len(results) >= limit:
                return results[:limit]
    return results[:limit]


def fetch_anilist_candidates(
    queries: List[str], seen: set[str], blacklisted: set[str], extra_forbidden: Iterable[str], limit: int = 6
) -> List[Dict[str, Any]]:
    results: List[Dict[str, Any]] = []
    gql = """
    query ($search: String) {
      Character(search: $search) {
        name { full }
        image { large }
      }
      Media(search: $search, type: ANIME) {
        title { romaji english }
        characters(sort: ROLE, perPage: 3) {
          nodes {
            name { full }
            image { large }
          }
        }
      }
    }
    """
    for q in queries[:2]:
        try:
            r = _HTTP.post("https://graphql.anilist.co", json={"query": gql, "variables": {"search": q}}, timeout=8)
            if r.status_code != 200:
                continue
            data = (r.json() or {}).get("data") or {}
            ch = data.get("Character")
            if ch and (ch.get("image") or {}).get("large"):
                _push_candidate(
                    results,
                    ch["image"]["large"],
                    "anilist_char",
                    f"{(ch.get('name') or {}).get('full', q)} character portrait",
                    460,
                    650,
                    seen,
                    blacklisted,
                    extra_forbidden,
                )
            media = data.get("Media")
            for node in ((media or {}).get("characters") or {}).get("nodes") or []:
                img = (node.get("image") or {}).get("large") or ""
                if img:
                    _push_candidate(
                        results,
                        img,
                        "anilist_cast",
                        f"{(node.get('name') or {}).get('full', q)} character",
                        460,
                        650,
                        seen,
                        blacklisted,
                        extra_forbidden,
                    )
        except Exception:
            continue
        if len(results) >= limit:
            break
    return results[:limit]


def fetch_wikipedia_media_list(
    queries: List[str], seen: set[str], blacklisted: set[str], extra_forbidden: Iterable[str], limit: int = 8
) -> List[Dict[str, Any]]:
    """
    Fetch ALL images embedded inside matching EN & IT Wikipedia articles (skipping title/logo infobox art),
    giving scenes, cast stills, real food plates, monuments, and objects in HD.
    """
    results: List[Dict[str, Any]] = []
    for q in queries[:3]:
        q_low = q.lower()
        for lang in ("en", "it"):
            search_data = _get_json(
                f"https://{lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch={quote(q)}&srlimit=4&format=json"
            )
            raw_hits = ((search_data or {}).get("query") or {}).get("search") or []
            # Skip song/soundtrack/disambiguation pages unless explicitly queried
            bad_suffixes = ("(song)", "(album)", "(soundtrack)", "(single)", "(ep)", "(disambiguation)", "(surname)")
            filtered_hits = [
                h for h in raw_hits
                if not any(s in (h.get("title") or "").lower() for s in bad_suffixes if s.strip("()") not in q_low)
            ]
            # Prefer shortest / closest title match first
            filtered_hits.sort(key=lambda h: (0 if (h.get("title") or "").lower() == q_low else 1, len(h.get("title") or "")))
            for hit in filtered_hits[:2]:
                title = hit.get("title")
                if not title:
                    continue
                slug = quote(title.replace(" ", "_"), safe="")
                media_list = _get_json(f"https://{lang}.wikipedia.org/api/rest_v1/page/media-list/{slug}")
                items = (media_list or {}).get("items") or []
                for idx, m in enumerate(items):
                    if m.get("type") != "image":
                        continue
                    srcset = m.get("srcset") or []
                    best_src = ""
                    best_w = 0
                    best_h = 0
                    # Choose largest non-tiny src (or upgrade Wikimedia URL)
                    for s in srcset:
                        src = s.get("src") or ""
                        if src.startswith("//"):
                            src = f"https:{src}"
                        best_src = src
                    if not best_src:
                        continue
                    caption = ((m.get("caption") or {}).get("text") or "") + " " + (m.get("title") or "")
                    # Skip fair-use /wikipedia/en/ lead image on slot 0 when likely a poster/cover
                    if idx == 0 and "/wikipedia/en/" in best_src and any(
                        kw in caption.lower() for kw in ("poster", "cover", "logo", "title")
                    ):
                        continue
                    _push_candidate(
                        results,
                        best_src,
                        f"wiki_media_{lang}",
                        f"{title} {caption}".strip()[:160],
                        best_w,
                        best_h,
                        seen,
                        blacklisted,
                        extra_forbidden,
                    )
                    if len(results) >= limit:
                        return results[:limit]
    return results[:limit]


def fetch_commons_candidates(
    queries: List[str], seen: set[str], blacklisted: set[str], extra_forbidden: Iterable[str], limit: int = 8
) -> List[Dict[str, Any]]:
    """Query Wikimedia Commons API with full extmetadata inspection (description & categories)."""
    results: List[Dict[str, Any]] = []
    for q in queries[:4]:
        url = (
            "https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrnamespace=6"
            f"&gsrsearch={quote(f'filetype:bitmap {q}')}&gsrlimit=12"
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
            clean_desc = re.sub(r"<[^>]+>", " ", f"{p.get('title', '')} {desc} {cats}")
            cand_url = info.get("thumburl") or info.get("url") or ""
            w = int(info.get("thumbwidth") or info.get("width") or 0)
            h = int(info.get("thumbheight") or info.get("height") or 0)
            _push_candidate(
                results,
                cand_url,
                "commons",
                clean_desc[:180],
                w,
                h,
                seen,
                blacklisted,
                extra_forbidden,
            )
            if len(results) >= limit:
                return results[:limit]
    return results[:limit]


def fetch_wikidata_p18_candidates(
    queries: List[str],
    item_ctx: Dict[str, Any],
    seen: set[str],
    blacklisted: set[str],
    extra_forbidden: Iterable[str],
    limit: int = 4,
) -> List[Dict[str, Any]]:
    """Lookup entity in Wikidata to verify description match and pull canonical P18 Commons image."""
    results: List[Dict[str, Any]] = []
    q = queries[0] if queries else item_ctx["answer"]
    for lang in ("it", "en"):
        data = _get_json(
            f"https://www.wikidata.org/w/api.php?action=wbsearchentities&search={quote(q)}&language={lang}&format=json&limit=4"
        )
        hits = (data or {}).get("search") or []
        if not hits:
            continue
        ids = "|".join(h["id"] for h in hits if h.get("id"))
        ents = _get_json(
            f"https://www.wikidata.org/w/api.php?action=wbgetentities&ids={ids}&props=claims|descriptions&format=json"
        )
        for qid, ent in ((ents or {}).get("entities") or {}).items():
            claims = ent.get("claims") or {}
            p18 = (claims.get("P18") or [None])[0]
            if not p18:
                continue
            fname = ((p18.get("mainsnak") or {}).get("datavalue") or {}).get("value")
            if not fname or not isinstance(fname, str):
                continue
            # Resolve Commons file info at 960px
            file_info = _get_json(
                f"https://commons.wikimedia.org/w/api.php?action=query&titles=File:{quote(fname)}&prop=imageinfo&iiprop=url|size|mime|extmetadata&iiurlwidth=960&format=json"
            )
            for fp in ((file_info or {}).get("query") or {}).get("pages", {}).values():
                info = (fp.get("imageinfo") or [None])[0]
                if not info:
                    continue
                cand_url = info.get("thumburl") or info.get("url") or ""
                w = int(info.get("thumbwidth") or info.get("width") or 0)
                h = int(info.get("thumbheight") or info.get("height") or 0)
                desc_text = ""
                for d_obj in (ent.get("descriptions") or {}).values():
                    desc_text += " " + d_obj.get("value", "")
                _push_candidate(
                    results,
                    cand_url,
                    f"wikidata_{qid}",
                    f"{fname} {desc_text}".strip()[:160],
                    w,
                    h,
                    seen,
                    blacklisted,
                    extra_forbidden,
                )
                if len(results) >= limit:
                    return results[:limit]
    return results[:limit]


def gather_candidates(
    item_ctx: Dict[str, Any],
    archetype_cfg: Dict[str, Any],
    search_hints: List[str],
    blacklisted_urls: set[str],
    already_seen_urls: set[str],
    extra_forbidden: Iterable[str],
    max_candidates: int = 10,
) -> List[Dict[str, Any]]:
    """Build ordered, disambiguated, non-duplicate candidate URLs tailored to the category archetype."""
    answer = item_ctx["answer"]
    en_title = item_ctx.get("englishTitle") or ""
    seen = set(already_seen_urls)

    # Deduplicated ordered search queries: VLM hints first, then base answer & English context + templates
    raw_queries: List[str] = []
    for q in list(search_hints) + [en_title, answer]:
        q_s = (q or "").strip()
        if q_s and q_s not in raw_queries:
            raw_queries.append(q_s)
    for tmpl in archetype_cfg.get("searchHintsTemplate") or []:
        formatted = tmpl.format(answer=en_title or answer).strip()
        if formatted and formatted not in raw_queries:
            raw_queries.append(formatted)

    source_order = archetype_cfg.get("sources") or ["wikipedia_media", "wikidata", "commons"]
    collected: List[Dict[str, Any]] = []

    for src in source_order:
        if len(collected) >= max_candidates:
            break
        remaining = max_candidates - len(collected)
        if src == "steam":
            collected.extend(fetch_steam_candidates(raw_queries, seen, blacklisted_urls, extra_forbidden, limit=min(6, remaining)))
        elif src == "tvmaze":
            collected.extend(fetch_tvmaze_candidates(raw_queries, seen, blacklisted_urls, extra_forbidden, limit=min(6, remaining)))
        elif src == "anilist":
            collected.extend(fetch_anilist_candidates(raw_queries, seen, blacklisted_urls, extra_forbidden, limit=min(6, remaining)))
        elif src == "wikipedia_media":
            collected.extend(fetch_wikipedia_media_list(raw_queries, seen, blacklisted_urls, extra_forbidden, limit=min(6, remaining)))
        elif src == "wikidata":
            collected.extend(fetch_wikidata_p18_candidates(raw_queries, item_ctx, seen, blacklisted_urls, extra_forbidden, limit=min(4, remaining)))
        elif src == "commons":
            collected.extend(fetch_commons_candidates(raw_queries, seen, blacklisted_urls, extra_forbidden, limit=min(6, remaining)))

    # Universal Wikipedia Media + Commons safety pass if specialized APIs came up dry
    if len(collected) < 4:
        collected.extend(fetch_wikipedia_media_list(raw_queries, seen, blacklisted_urls, extra_forbidden, limit=4))
    if len(collected) < 4:
        collected.extend(fetch_commons_candidates(raw_queries, seen, blacklisted_urls, extra_forbidden, limit=6))

    return collected[:max_candidates]
