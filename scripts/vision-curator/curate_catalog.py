#!/usr/bin/env python3
"""
Yappik AI Vision + Pixel Quality Curation Orchestrator.

Runs a resumable, 4-stage pipeline across public/categories/*.json:
  1. Technical Pixel Triage (real resolution, padding/content-ratio, sharpness, collage detection, Wikimedia upscaling)
  2. Deterministic Anti-Spoiler Gate (answer/aliases leak check on extracted visible text)
  3. Ollama AI Vision Critic (category-archetype evaluation + automatic model pull + verdict caching)
  4. Multi-Source Hunter + Blind 2x2 Grid Selector (Steam, TVMaze, AniList, Wiki media-list, Wikidata, Commons)
  5. Atomic sync of category JSONs, index.json, generatedCatalog.json, blacklist.json, and HTML review gallery
"""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import html
import json
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

CURATOR_DIR = Path(__file__).resolve().parent
REPO_ROOT = CURATOR_DIR.parent.parent
sys.path.insert(0, str(CURATOR_DIR))

from pixel_metrics import (
    analyze_image_pixels,
    download_image_cached,
    normalize_url,
    upgrade_wikimedia_thumb_url,
)
from source_fetchers import gather_candidates
from vision_judge import ItemCheckpointCache, OllamaVisionClient, VerdictCache

PUBLIC_CAT_DIR = REPO_ROOT / "public" / "categories"
INDEX_FILE = PUBLIC_CAT_DIR / "index.json"
CATALOG_FILE = REPO_ROOT / "src" / "data" / "generatedCatalog.json"
BLACKLIST_FILE = REPO_ROOT / "src" / "data" / "blacklist.json"
CONFIG_FILE = REPO_ROOT / "src" / "config" / "vision-audit.config.json"
CACHE_DIR = REPO_ROOT / ".cache" / "vision-curator"
REPORTS_DIR = REPO_ROOT / "reports"
GALLERY_HTML = REPORTS_DIR / "vision-gallery.html"
REPORT_JSON = REPORTS_DIR / "vision-audit-report.json"


def load_json(path: Path, default: Any) -> Any:
    if path.exists():
        try:
            return json.loads(path.read_text("utf-8"))
        except Exception:
            pass
    return default


def write_json_atomic(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", "utf-8")
    tmp.replace(path)


def merge_thresholds(defaults: Dict[str, Any], archetype_cfg: Dict[str, Any]) -> Dict[str, Any]:
    merged = dict(defaults)
    for k, v in archetype_cfg.items():
        if k in merged or k.startswith(("min", "max", "skip")) or k == "spoilerPolicy":
            merged[k] = v
    return merged


def _download_and_analyze_url(
    url: str,
    thresholds: Dict[str, Any],
) -> Dict[str, Any]:
    """Download URL (stepping up Wikimedia thumbs if possible) and compute technical pixel metrics."""
    upgraded = upgrade_wikimedia_thumb_url(url, 960)
    candidate_to_try = upgraded if upgraded != url else url
    min_b = int(thresholds.get("minBytes", 5000))

    dl = download_image_cached(candidate_to_try, CACHE_DIR, min_bytes=min_b)
    actual_url = candidate_to_try
    if not dl.get("ok") and upgraded != url:
        dl = download_image_cached(url, CACHE_DIR, min_bytes=min_b)
        actual_url = normalize_url(url)

    if not dl.get("ok"):
        return {
            "ok": False,
            "url": normalize_url(url),
            "actual_url": normalize_url(url),
            "bytes": None,
            "tech": {"valid": False, "score": 0, "fail_reasons": [dl.get("error", "download_failed")]},
        }

    tech = analyze_image_pixels(dl["bytes"], thresholds)
    return {
        "ok": bool(tech.get("valid", False)),
        "url": normalize_url(url),
        "actual_url": actual_url,
        "bytes": dl["bytes"],
        "tech": tech,
    }


def evaluate_existing_url(
    url: str,
    item_ctx: Dict[str, Any],
    archetype_cfg: Dict[str, Any],
    thresholds: Dict[str, Any],
    judge: Optional[OllamaVisionClient],
    verdict_cache: VerdictCache,
    technical_only: bool,
) -> Dict[str, Any]:
    """Download, upscale-attempt Wikimedia thumbs if needed, inspect pixels, and run Vision Critic."""
    dl_res = _download_and_analyze_url(url, thresholds)
    actual_url = dl_res["actual_url"]
    tech = dl_res["tech"]

    if not dl_res["ok"]:
        return {
            "url": dl_res["url"],
            "actual_url": actual_url,
            "verdict": "REJECT",
            "tech": tech,
            "vision": None,
            "composite_score": tech.get("score", 0.0) * 0.25 if dl_res["bytes"] else 0.0,
        }

    if technical_only or judge is None:
        return {
            "url": dl_res["url"],
            "actual_url": actual_url,
            "verdict": "KEEP",
            "tech": tech,
            "vision": None,
            "composite_score": float(tech.get("score", 60.0)),
        }

    cached = verdict_cache.get(item_ctx["id"], actual_url)
    if cached:
        vision = cached
    else:
        vision = judge.evaluate_single(
            item_ctx=item_ctx,
            archetype_cfg={**archetype_cfg, **thresholds},
            image_bytes=dl_res["bytes"],
            tech_metrics=tech,
        )
        verdict_cache.put(item_ctx["id"], actual_url, vision)

    return {
        "url": dl_res["url"],
        "actual_url": actual_url,
        "verdict": vision["verdict"],
        "tech": tech,
        "vision": vision,
        "composite_score": float(vision.get("composite_score", 0.0)),
    }


def hunt_and_select_replacement(
    item_ctx: Dict[str, Any],
    archetype_cfg: Dict[str, Any],
    thresholds: Dict[str, Any],
    judge: OllamaVisionClient,
    verdict_cache: VerdictCache,
    initial_hints: List[str],
    blacklisted_urls: set[str],
    seen_urls: set[str],
    extra_forbidden: List[str],
    pre_candidates: List[Dict[str, Any]] | None = None,
) -> List[Dict[str, Any]]:
    """
    Collect up to 4 technically valid candidates (existing backups + 1 search round) and run ONE
    2x2 Vision selector grid without redundant follow-up single evaluations.
    """
    valid_pool: List[Dict[str, Any]] = list(pre_candidates or [])[:4]
    seen_local = set(seen_urls) | {r["cand"]["url"] for r in valid_pool}

    if len(valid_pool) < 4:
        en = item_ctx.get("englishTitle") or item_ctx["answer"]
        hints = [h for h in initial_hints if h] or [en, item_ctx["answer"]]
        candidates = gather_candidates(
            item_ctx=item_ctx,
            archetype_cfg=archetype_cfg,
            search_hints=hints,
            blacklisted_urls=blacklisted_urls,
            already_seen_urls=seen_local,
            extra_forbidden=extra_forbidden,
            max_candidates=8,
        )
        new_cands = [c for c in candidates if c["url"] not in seen_local]
        for c in new_cands:
            seen_local.add(c["url"])

        if new_cands:
            def _prep(cand: Dict[str, Any]) -> Optional[Dict[str, Any]]:
                dl_res = _download_and_analyze_url(cand["url"], thresholds)
                if not dl_res["ok"]:
                    return None
                return {"cand": {**cand, "url": dl_res["actual_url"]}, "bytes": dl_res["bytes"], "tech": dl_res["tech"]}

            with ThreadPoolExecutor(max_workers=8) as pool:
                prepped = list(pool.map(_prep, new_cands))
            for item_p in prepped:
                if item_p and all(v["cand"]["url"] != item_p["cand"]["url"] for v in valid_pool):
                    valid_pool.append(item_p)
                    if len(valid_pool) >= 4:
                        break

    if not valid_pool:
        return []

    chunk = valid_pool[:4]
    grid_res = judge.select_best_from_grid(
        item_ctx=item_ctx,
        archetype_cfg={**archetype_cfg, **thresholds},
        candidate_bytes_list=[v["bytes"] for v in chunk],
    )

    slots_by_num = {int(s.get("slot", 0)): s for s in (grid_res.get("slots") or []) if isinstance(s, dict)}
    ordered_slots = list(grid_res.get("approved_slots") or [])
    winner_slot = int(grid_res.get("winner_slot") or 0)
    if winner_slot and winner_slot not in ordered_slots:
        ordered_slots = [winner_slot] + ordered_slots

    chosen_records: List[Dict[str, Any]] = []
    for idx_s, rec in enumerate(chunk, start=1):
        slot_meta = slots_by_num.get(idx_s, {})
        url = rec["cand"]["url"]
        depicts = bool(slot_meta.get("depicts_target", idx_s in ordered_slots))
        guess = int(slot_meta.get("guessability_1_5s", 7 if idx_s in ordered_slots else 3) or 0)
        qual = int(slot_meta.get("visual_quality", 7 if idx_s in ordered_slots else 4) or 0)
        has_sp = bool(slot_meta.get("has_spoiler_text", False))
        vis_text = list(slot_meta.get("visible_text") or [])

        is_approved = idx_s in ordered_slots and not has_sp and depicts
        verdict_str = "KEEP" if is_approved else ("REJECT" if (not depicts or has_sp) else "UPGRADE_RECOMMENDED")
        composite = round(
            (0.9 * 35.0 if is_approved else 12.0) + (guess * 4.0) + (qual * 2.0) + rec["tech"].get("score", 50.0) * 0.15,
            2,
        )
        vision_obj = {
            "verdict": verdict_str,
            "depicts_target": depicts,
            "match_confidence": 0.9 if is_approved else 0.3,
            "guessability_1_5s": guess,
            "visual_quality": qual,
            "frame_type": "live_photo" if is_approved else "wrong_subject",
            "visible_text": vis_text[:8],
            "text_prominence": "prominent_overlay_or_title" if has_sp else "none",
            "spoiler": {"is_spoiler": has_sp, "severity": "grid_spoiler" if has_sp else "none"},
            "issues": [] if is_approved else ["rejected_by_grid"],
            "visual_search_hints": [],
            "composite_score": composite,
            "model": grid_res.get("model") or judge.arbiter_model,
        }
        verdict_cache.put(item_ctx["id"], url, vision_obj)
        if is_approved:
            chosen_records.append(
                {
                    "url": url,
                    "source": rec["cand"]["source"],
                    "tech": rec["tech"],
                    "vision": vision_obj,
                    "composite_score": composite,
                }
            )
        elif verdict_str == "REJECT":
            blacklisted_urls.add(url.lower())

    # Put winner_slot first, then sort remaining by composite score
    if chosen_records and winner_slot and 1 <= winner_slot <= len(chunk):
        win_url = chunk[winner_slot - 1]["cand"]["url"]
        chosen_records.sort(key=lambda r: (0 if r["url"] == win_url else 1, -r["composite_score"]))
    else:
        chosen_records.sort(key=lambda r: -r["composite_score"])

    return chosen_records


def render_gallery_html(report: Dict[str, Any], out_path: Path) -> None:
    """Write a sleek static Neo-Brutalist inspection dashboard for every audited item."""
    out_path.parent.mkdir(parents=True, exist_ok=True)
    sections = []
    for cat_rep in report.get("categories", []):
        cards = []
        for it in cat_rep.get("items", []):
            status = it.get("finalStatus", "KEPT")
            badge_bg = {
                "KEPT": "#19C37D",
                "UPGRADED_FROM_POOL": "#2F6BFF",
                "REPLACED": "#FFC933",
                "NEEDS_REVIEW": "#FF3D6E",
            }.get(status, "#E5E7EB")
            badge_fg = "#FFFFFF" if status in ("UPGRADED_FROM_POOL", "NEEDS_REVIEW") else "#14121F"
            v = it.get("vision") or {}
            tech = it.get("tech") or {}
            old_block = ""
            if it.get("oldUrl") and it["oldUrl"] != it["newUrl"]:
                old_block = (
                    f'<div class="old-link">Prima: <a href="{html.escape(it["oldUrl"])}" target="_blank">vecchia foto</a> '
                    f'({html.escape(", ".join(it.get("oldReasons") or []))})</div>'
                )
            cards.append(
                f"""
                <div class="card">
                  <div class="card-head">
                    <strong>{html.escape(it['answer'])}</strong>
                    <span class="badge" style="background:{badge_bg};color:{badge_fg}">{html.escape(status)}</span>
                  </div>
                  <div class="thumb-wrap">
                    <img src="{html.escape(it['newUrl'])}" loading="lazy" alt="{html.escape(it['answer'])}" />
                  </div>
                  <div class="meta">
                    <span>📐 {tech.get('width', '?')}×{tech.get('height', '?')} (crop {int((tech.get('content_ratio') or 1)*100)}%)</span>
                    <span>👁️ Match: {v.get('match_confidence', '-')} | Guess: {v.get('guessability_1_5s', '-')}/10 | Qual: {v.get('visual_quality', '-')}/10</span>
                    <span>🔤 Testo: {html.escape(', '.join(v.get('visible_text') or []) or 'nessuno')}</span>
                    {old_block}
                  </div>
                </div>
                """
            )
        sections.append(
            f"""
            <section>
              <h2>{html.escape(cat_rep.get('icon', ''))} {html.escape(cat_rep['categoryName'])} <small>({cat_rep['categoryId']} — {len(cat_rep.get('items', []))} item)</small></h2>
              <div class="grid">{''.join(cards)}</div>
            </section>
            """
        )

    doc = f"""<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8" />
<title>Yappik AI Vision Photo Curation Gallery</title>
<style>
  body {{ font-family: system-ui, sans-serif; background: #14121F; color: #FFF9EC; margin: 0; padding: 24px; }}
  h1 {{ margin-top: 0; color: #FFC933; }}
  .stats {{ display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 24px; }}
  .stat {{ background: #1E1B2E; border: 2px solid #FFC933; padding: 10px 16px; border-radius: 12px; font-weight: 700; }}
  section {{ margin-bottom: 42px; }}
  h2 {{ border-bottom: 3px solid #2F6BFF; padding-bottom: 8px; }}
  .grid {{ display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 16px; }}
  .card {{ background: #FFF9EC; color: #14121F; border: 3px solid #14121F; border-radius: 14px; overflow: hidden; box-shadow: 4px 4px 0 #000; display: flex; flex-direction: column; }}
  .card-head {{ padding: 10px 12px; display: flex; justify-content: space-between; align-items: center; gap: 8px; border-bottom: 2px solid #14121F; }}
  .badge {{ font-size: 11px; font-weight: 800; padding: 3px 8px; border-radius: 999px; border: 2px solid #14121F; white-space: nowrap; }}
  .thumb-wrap {{ height: 185px; background: #E5E0D0; display: flex; align-items: center; justify-content: center; overflow: hidden; }}
  .thumb-wrap img {{ max-width: 100%; max-height: 100%; object-fit: contain; }}
  .meta {{ padding: 10px 12px; font-size: 12px; display: flex; flex-direction: column; gap: 4px; }}
  .old-link {{ color: #B91C1C; font-weight: 600; }}
  .old-link a {{ color: #2F6BFF; }}
</style>
</head>
<body>
  <h1>👁️ Yappik AI Vision Photo Curation Gallery</h1>
  <div class="stats">
    <div class="stat">Model: {html.escape(report.get('models', {}).get('scout', ''))} + {html.escape(report.get('models', {}).get('arbiter', ''))}</div>
    <div class="stat">Scanned: {report.get('summary', {}).get('scanned', 0)}</div>
    <div class="stat">Kept Clean: {report.get('summary', {}).get('kept', 0)}</div>
    <div class="stat">Upgraded from Pool: {report.get('summary', {}).get('upgradedFromPool', 0)}</div>
    <div class="stat">Replaced via Hunter: {report.get('summary', {}).get('replaced', 0)}</div>
    <div class="stat">Needs Manual Review: {report.get('summary', {}).get('needsReview', 0)}</div>
  </div>
  {''.join(sections)}
</body>
</html>"""
    out_path.write_text(doc, "utf-8")


def sync_derived_catalog_files() -> None:
    """Rebuild src/data/generatedCatalog.json and public/categories/index.json cleanly from category JSONs."""
    cfg = load_json(CONFIG_FILE, {})
    order = cfg.get("priorityOrder") or []
    cat_files = [p for p in PUBLIC_CAT_DIR.glob("*.json") if p.name != "index.json"]

    # Sort deterministically preserving existing index order first
    existing_index = load_json(INDEX_FILE, {})
    existing_order = [c["id"] for c in existing_index.get("categories", []) if c.get("id")]
    order_rank = {cid: idx for idx, cid in enumerate(existing_order or order)}
    cat_files.sort(key=lambda p: (order_rank.get(p.stem, 9999), p.stem))

    all_categories = []
    index_entries = []
    total_photos = 0

    for fp in cat_files:
        cat_obj = load_json(fp, None)
        if not cat_obj or not isinstance(cat_obj.get("items"), list):
            continue
        all_categories.append(cat_obj)
        items = cat_obj["items"]
        total_photos += len(items)
        cover = items[0].get("imageUrl", "") if items else cat_obj.get("coverImage", "")
        index_entries.append(
            {
                "id": cat_obj["id"],
                "name": cat_obj.get("name", cat_obj["id"]),
                "subtitle": cat_obj.get("subtitle", ""),
                "icon": cat_obj.get("icon", "📷"),
                "themeHex": cat_obj.get("themeHex", "#FFC933"),
                "coverImage": cover,
                "itemCount": len(items),
                "dataUrl": f"./categories/{cat_obj['id']}.json",
            }
        )

    write_json_atomic(CATALOG_FILE, all_categories)
    write_json_atomic(
        INDEX_FILE,
        {
            "totalCategories": len(all_categories),
            "totalPhotos": total_photos,
            "categories": index_entries,
        },
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Yappik AI Vision & Pixel Curation Pipeline")
    parser.add_argument("--category", nargs="*", help="One or more category IDs to curate (default: all in priorityOrder)")
    parser.add_argument("--priority-first", type=int, default=0, help="Run only top N priority categories")
    parser.add_argument("--max-items", type=int, default=0, help="Cap items processed per category (useful for quick validation)")
    parser.add_argument("--technical-only", action="store_true", help="Run fast Pixel & Geometry Triage only without calling Ollama")
    parser.add_argument("--repair-failed-only", action="store_true", help="Skip Vision on technically valid items; use Vision + Hunter on technically failing items")
    parser.add_argument("--no-replace", action="store_true", help="Audit and rank existing pool without fetching external replacements")
    parser.add_argument("--dry-run", action="store_true", help="Do not modify category JSONs or blacklist.json")
    parser.add_argument("--force", action="store_true", help="Ignore item-level checkpoint cache and re-evaluate all items")
    parser.add_argument("--retry-needs-review", action="store_true", help="Re-attempt items previously checkpointed as NEEDS_REVIEW")
    parser.add_argument("--sync-only", action="store_true", help="Only resync generatedCatalog.json and public/categories/index.json cleanly")
    parser.add_argument("--gallery-only", action="store_true", help="Regenerate HTML gallery from latest vision-audit-report.json")
    parser.add_argument("--scout-model", default=None, help="Override fast Vision scout Ollama model")
    parser.add_argument("--arbiter-model", default=None, help="Override deep Vision arbiter/selector Ollama model")
    args = parser.parse_args()

    cfg = load_json(CONFIG_FILE, {})
    if args.sync_only:
        sync_derived_catalog_files()
        print("✅ Catalogo derivato sincronizzato (generatedCatalog.json + index.json).")
        return 0
    if args.gallery_only:
        existing_rep = load_json(REPORT_JSON, None)
        if not existing_rep:
            print("❌ Nessun report trovato in reports/vision-audit-report.json")
            return 1
        render_gallery_html(existing_rep, GALLERY_HTML)
        print(f"✅ Galleria rigenerata in {GALLERY_HTML}")
        return 0

    models_cfg = cfg.get("models") or {}
    scout_model = args.scout_model or models_cfg.get("scout", "gemma4:12b")
    arbiter_model = args.arbiter_model or models_cfg.get("arbiter", "gemma4:12b")
    keep_alive = models_cfg.get("keepAlive", "15m")

    target_level = (
        ItemCheckpointCache.LEVEL_TECHNICAL
        if args.technical_only
        else ItemCheckpointCache.LEVEL_REPAIR
        if args.repair_failed_only
        else ItemCheckpointCache.LEVEL_FULL_VISION
    )

    judge: Optional[OllamaVisionClient] = None
    if not args.technical_only:
        judge = OllamaVisionClient(scout_model=scout_model, arbiter_model=arbiter_model, keep_alive=keep_alive)
        judge.ensure_model(scout_model)
        if arbiter_model and arbiter_model != scout_model:
            judge.ensure_model(arbiter_model)

    prompt_version = cfg.get("promptVersion", "v2")
    verdict_cache = VerdictCache(CACHE_DIR / f"verdicts-{prompt_version}.json", prompt_version)
    checkpoint_cache = ItemCheckpointCache(CACHE_DIR / f"item-checkpoints-{prompt_version}.json", prompt_version)

    blacklist_data = load_json(
        BLACKLIST_FILE, {"version": 3, "blacklistedUrls": [], "blacklistedItemIds": [], "forbiddenKeywords": [], "reports": []}
    )
    blacklisted_urls_raw: List[str] = list(blacklist_data.get("blacklistedUrls") or [])
    blacklisted_set = {normalize_url(u).lower() for u in blacklisted_urls_raw if u}
    extra_forbidden: List[str] = list(blacklist_data.get("forbiddenKeywords") or [])

    if args.category:
        target_cats = args.category
    else:
        target_cats = list(cfg.get("priorityOrder") or [])
        # Append any category file not listed explicitly in priorityOrder
        for fp in sorted(PUBLIC_CAT_DIR.glob("*.json")):
            if fp.name != "index.json" and fp.stem not in target_cats:
                target_cats.append(fp.stem)
        if args.priority_first > 0:
            target_cats = target_cats[: args.priority_first]

    defaults = cfg.get("defaults") or {}
    archetypes = cfg.get("archetypes") or {}
    cat_map = cfg.get("categoryArchetypes") or {}

    summary = {
        "scanned": 0,
        "skippedCached": 0,
        "kept": 0,
        "upgradedFromPool": 0,
        "replaced": 0,
        "needsReview": 0,
        "blacklistedAdded": 0,
    }
    cat_reports: List[Dict[str, Any]] = []
    any_cat_changed = False

    total_global_items = 0
    total_live_todo = 0
    for cid_cnt in target_cats:
        cp = PUBLIC_CAT_DIR / f"{cid_cnt}.json"
        if not cp.exists():
            continue
        cd = load_json(cp, None)
        if not cd or not isinstance(cd.get("items"), list):
            continue
        its = cd["items"]
        lim = args.max_items if args.max_items > 0 else len(its)
        total_global_items += lim
        for i_cnt, it_cnt in enumerate(its[:lim]):
            iid_cnt = it_cnt.get("id", f"{cid_cnt}-{i_cnt}")
            if args.force or not checkpoint_cache.should_skip(
                iid_cnt,
                it_cnt.get("imageUrl") or "",
                it_cnt.get("imageUrls") or [],
                target_level,
                retry_needs_review=args.retry_needs_review,
            ):
                total_live_todo += 1

    print(
        f"📊 Totale catalogo: {total_global_items} item | "
        f"Già in cache: {total_global_items - total_live_todo} | "
        f"Da analizzare ora: {total_live_todo}"
    )

    t_start = time.time()
    live_done = 0
    for cid in target_cats:
        cat_path = PUBLIC_CAT_DIR / f"{cid}.json"
        if not cat_path.exists():
            print(f"⚠️  Categoria inesistente: {cid}")
            continue
        cat_data = load_json(cat_path, None)
        if not cat_data or not isinstance(cat_data.get("items"), list):
            continue

        arch_key = cat_map.get(cid, "product_or_object")
        arch_cfg = archetypes.get(arch_key, {})
        thresholds = merge_thresholds(defaults, arch_cfg)
        if cid == "giochi-tavolo":
            thresholds["skipCollageSeam"] = True
        items = cat_data["items"]
        limit_n = args.max_items if args.max_items > 0 else len(items)

        # Concurrent image pre-download only for items NOT already skipped by checkpoint cache
        prefetch_urls: List[str] = []
        for idx_p, it in enumerate(items[:limit_n]):
            item_id_p = it.get("id", f"{cid}-{idx_p}")
            if not args.force and checkpoint_cache.should_skip(
                item_id_p,
                it.get("imageUrl") or "",
                it.get("imageUrls") or [],
                target_level,
                retry_needs_review=args.retry_needs_review,
            ):
                continue
            for raw_u in [it.get("imageUrl"), *(it.get("imageUrls") or [])]:
                if raw_u:
                    up = upgrade_wikimedia_thumb_url(raw_u, 960)
                    if up not in prefetch_urls:
                        prefetch_urls.append(up)
        if prefetch_urls:
            min_b = int(thresholds.get("minBytes", 5000))
            with ThreadPoolExecutor(max_workers=12) as pool:
                list(pool.map(lambda u: download_image_cached(u, CACHE_DIR, min_bytes=min_b), prefetch_urls))

        print(f"\n🔎 [{cid}] {cat_data.get('name')} ({arch_key}) — analizzo {limit_n}/{len(items)} item...")
        cat_changed = False
        dirty_count = 0
        item_reports_slots: List[Optional[Dict[str, Any]]] = [None] * limit_n
        uncached_work: List[Dict[str, Any]] = []
        is_deterministic_source = cid in ("bandiere", "pokemon")
        use_tech_only = bool(args.technical_only or args.repair_failed_only or is_deterministic_source or judge is None)

        for idx, item in enumerate(items[:limit_n]):
            summary["scanned"] += 1
            old_primary = normalize_url(item.get("imageUrl") or "")
            raw_pool = [old_primary] + [normalize_url(u) for u in (item.get("imageUrls") or []) if u]
            item_id = item.get("id", f"{cid}-{idx}")

            if not args.force:
                cached_cp = checkpoint_cache.should_skip(
                    item_id,
                    old_primary,
                    item.get("imageUrls") or [],
                    target_level,
                    retry_needs_review=args.retry_needs_review,
                )
                if cached_cp:
                    summary["skippedCached"] += 1
                    st_c = cached_cp.get("status", "KEPT")
                    if st_c == "KEPT":
                        summary["kept"] += 1
                    elif st_c == "UPGRADED_FROM_POOL":
                        summary["upgradedFromPool"] += 1
                    elif st_c == "REPLACED":
                        summary["replaced"] += 1
                    else:
                        summary["needsReview"] += 1
                    item_reports_slots[idx] = cached_cp.get("report") or {
                        "id": item_id,
                        "answer": item.get("answer", ""),
                        "finalStatus": st_c,
                        "oldUrl": old_primary,
                        "newUrl": old_primary,
                    }
                    continue

            pool_urls: List[str] = []
            for u in raw_pool:
                if u and u not in pool_urls:
                    pool_urls.append(u)

            item_ctx = {
                "id": item_id,
                "answer": item.get("answer", ""),
                "aliases": item.get("aliases") or [],
                "englishTitle": item.get("englishTitle") or "",
                "categoryName": cat_data.get("name", cid),
            }
            uncached_work.append(
                {
                    "idx": idx,
                    "item": item,
                    "old_primary": old_primary,
                    "pool_urls": pool_urls,
                    "item_ctx": item_ctx,
                }
            )

        # Process uncached items in chunks of 8, downloading & evaluating ALL imageUrls in parallel across Groq + Gemini (zero same-item bias!)
        for chunk_start in range(0, len(uncached_work), 8):
            work_chunk = uncached_work[chunk_start : chunk_start + 8]
            prepped_chunk: List[Dict[str, Any]] = []
            max_pool_len = 0

            # 1) Parallel download & technical pixel triage for all URLs in the 8-item chunk
            flat_tasks = [
                (w_idx, u)
                for w_idx, w in enumerate(work_chunk)
                for u in w["pool_urls"]
            ]
            dl_results_by_w: Dict[int, List[Dict[str, Any]]] = {i: [] for i in range(len(work_chunk))}
            if flat_tasks:
                with ThreadPoolExecutor(max_workers=12) as dl_pool:
                    mapped = list(dl_pool.map(lambda t: (t[0], _download_and_analyze_url(t[1], thresholds)), flat_tasks))
                for w_idx, dl_res in mapped:
                    dl_results_by_w[w_idx].append(dl_res)

            for w_idx, w in enumerate(work_chunk):
                valid_dls: List[Dict[str, Any]] = []
                reject_list: List[Dict[str, Any]] = []
                for dl_res in dl_results_by_w[w_idx]:
                    if not dl_res["ok"]:
                        reject_list.append(
                            {
                                "url": dl_res["url"],
                                "actual_url": dl_res["actual_url"],
                                "verdict": "REJECT",
                                "tech": dl_res["tech"],
                                "vision": None,
                                "composite_score": dl_res["tech"].get("score", 0.0) * 0.25 if dl_res["bytes"] else 0.0,
                            }
                        )
                    else:
                        valid_dls.append(dl_res)
                max_pool_len = max(max_pool_len, len(valid_dls))
                prepped_chunk.append(
                    {
                        **w,
                        "valid_dls": valid_dls,
                        "visions": [None] * len(valid_dls),
                        "reject_list": reject_list,
                    }
                )

            # 2) Parallel column-major Vision frontdoor batches (2x2 grids run simultaneously on Groq & Gemini)
            if judge is not None and not use_tech_only:
                vlm_sub_batches: List[List[Dict[str, Any]]] = []
                for slot_i in range(max_pool_len):
                    slot_entries: List[Dict[str, Any]] = []
                    for w_idx, p in enumerate(prepped_chunk):
                        if slot_i >= len(p["valid_dls"]):
                            continue
                        dl_res = p["valid_dls"][slot_i]
                        cached_v = verdict_cache.get(p["item_ctx"]["id"], dl_res["actual_url"])
                        if cached_v:
                            p["visions"][slot_i] = cached_v
                        else:
                            slot_entries.append(
                                {
                                    "work_idx": w_idx,
                                    "slot_i": slot_i,
                                    "item_ctx": p["item_ctx"],
                                    "image_bytes": dl_res["bytes"],
                                    "tech_metrics": dl_res["tech"],
                                    "url": dl_res["actual_url"],
                                }
                            )
                    for sub_start in range(0, len(slot_entries), 4):
                        vlm_sub_batches.append(slot_entries[sub_start : sub_start + 4])

                if vlm_sub_batches:
                    arch_merged = {**arch_cfg, **thresholds}
                    with ThreadPoolExecutor(max_workers=2) as vlm_pool:
                        sub_results = list(
                            vlm_pool.map(lambda b: (b, judge.evaluate_frontdoor_batch(b, arch_merged)), vlm_sub_batches)
                        )
                    for b_list, batch_verdicts in sub_results:
                        for b_entry, v_obj in zip(b_list, batch_verdicts):
                            verdict_cache.put(b_entry["item_ctx"]["id"], b_entry["url"], v_obj)
                            prepped_chunk[b_entry["work_idx"]]["visions"][b_entry["slot_i"]] = v_obj

            # 3) Pre-triage & parallel replacement hunting across the 8-item chunk
            chunk_meta: List[Dict[str, Any]] = []
            hunt_jobs: List[tuple[int, Dict[str, Any], List[str], set[str]]] = []
            for p_idx, p in enumerate(prepped_chunk):
                idx = p["idx"]
                item = p["item"]
                old_primary = p["old_primary"]
                pool_urls = p["pool_urls"]
                item_ctx = p["item_ctx"]
                valid_dls = p["valid_dls"]
                visions = p["visions"]
                reject_list = p["reject_list"]

                evaluated: List[Dict[str, Any]] = []
                for dl_res, vision in zip(valid_dls, visions):
                    if use_tech_only:
                        evaluated.append(
                            {
                                "url": dl_res["url"],
                                "actual_url": dl_res["actual_url"],
                                "verdict": "KEEP",
                                "tech": dl_res["tech"],
                                "vision": None,
                                "composite_score": float(dl_res["tech"].get("score", 60.0)),
                            }
                        )
                    elif vision is not None:
                        ev = {
                            "url": dl_res["url"],
                            "actual_url": dl_res["actual_url"],
                            "verdict": vision["verdict"],
                            "tech": dl_res["tech"],
                            "vision": vision,
                            "composite_score": float(vision.get("composite_score", 0.0)),
                        }
                        evaluated.append(ev)
                        if vision["verdict"] == "REJECT":
                            reject_list.append(ev)
                evaluated.extend(reject_list)

                old_reasons: List[str] = []
                for rj in reject_list:
                    if rj["url"] == old_primary or rj["actual_url"] == old_primary:
                        old_reasons.extend(rj["tech"].get("fail_reasons") or [])
                        if rj.get("vision"):
                            old_reasons.extend(rj["vision"].get("issues") or [])
                    u_norm = rj["url"].lower()
                    if u_norm and u_norm not in blacklisted_set:
                        blacklisted_set.add(u_norm)
                        blacklisted_urls_raw.append(rj["url"])
                        summary["blacklistedAdded"] += 1

                keep_list = sorted([e for e in evaluated if e["verdict"] == "KEEP"], key=lambda x: x["composite_score"], reverse=True)
                upgrade_list = sorted(
                    [e for e in evaluated if e["verdict"] == "UPGRADE_RECOMMENDED"],
                    key=lambda x: x["composite_score"],
                    reverse=True,
                )
                if not keep_list and not args.technical_only and not args.no_replace and judge is not None and not is_deterministic_source:
                    hints: List[str] = []
                    for ev in evaluated:
                        if ev.get("vision") and ev["vision"].get("visual_search_hints"):
                            hints.extend(ev["vision"]["visual_search_hints"])
                    seen_urls = {normalize_url(u) for u in pool_urls} | {e["actual_url"] for e in evaluated}
                    hunt_jobs.append((p_idx, item_ctx, hints, seen_urls))

                chunk_meta.append(
                    {
                        "p": p,
                        "evaluated": evaluated,
                        "old_reasons": old_reasons,
                        "keep_list": keep_list,
                        "upgrade_list": upgrade_list,
                    }
                )

            hunted_by_p: Dict[int, List[Dict[str, Any]]] = {}
            if hunt_jobs:
                bl_snapshot = set(blacklisted_set)
                with ThreadPoolExecutor(max_workers=3) as hunt_pool:
                    hunt_res = list(
                        hunt_pool.map(
                            lambda job: (
                                job[0],
                                hunt_and_select_replacement(
                                    item_ctx=job[1],
                                    archetype_cfg=arch_cfg,
                                    thresholds=thresholds,
                                    judge=judge,
                                    verdict_cache=verdict_cache,
                                    initial_hints=job[2],
                                    blacklisted_urls=bl_snapshot,
                                    seen_urls=job[3],
                                    extra_forbidden=extra_forbidden,
                                    pre_candidates=None,
                                ),
                            ),
                            hunt_jobs,
                        )
                    )
                for p_idx, h_list in hunt_res:
                    hunted_by_p[p_idx] = h_list

            for p_idx, cm in enumerate(chunk_meta):
                p = cm["p"]
                idx = p["idx"]
                item = p["item"]
                old_primary = p["old_primary"]
                pool_urls = p["pool_urls"]
                item_ctx = p["item_ctx"]
                evaluated = cm["evaluated"]
                old_reasons = cm["old_reasons"]
                keep_list = cm["keep_list"]
                upgrade_list = cm["upgrade_list"]

                chosen_list = keep_list
                final_status = "KEPT"
                hunted = hunted_by_p.get(p_idx)
                if hunted:
                    chosen_list = [
                        {
                            "url": h["url"],
                            "actual_url": h["url"],
                            "verdict": h["vision"]["verdict"],
                            "tech": h["tech"],
                            "vision": h["vision"],
                            "composite_score": h["composite_score"],
                        }
                        for h in hunted
                    ]
                    final_status = "REPLACED"

                if not chosen_list:
                    if upgrade_list:
                        chosen_list = upgrade_list
                        final_status = "NEEDS_REVIEW" if upgrade_list[0]["actual_url"] == old_primary else "UPGRADED_FROM_POOL"
                    else:
                        chosen_list = [evaluated[0]] if evaluated else []
                        final_status = "NEEDS_REVIEW"
                elif chosen_list[0]["actual_url"] != old_primary and final_status == "KEPT":
                    final_status = "UPGRADED_FROM_POOL"

                best_url = chosen_list[0]["actual_url"] if chosen_list else old_primary
                clean_pool: List[str] = []
                for ch in chosen_list:
                    u = ch["actual_url"]
                    if u and u not in clean_pool:
                        clean_pool.append(u)
                        blacklisted_set.discard(u.lower())
                    if len(clean_pool) >= 4:
                        break

                if final_status == "KEPT":
                    summary["kept"] += 1
                elif final_status == "UPGRADED_FROM_POOL":
                    summary["upgradedFromPool"] += 1
                elif final_status == "REPLACED":
                    summary["replaced"] += 1
                else:
                    summary["needsReview"] += 1

                icon = {"KEPT": "✅", "UPGRADED_FROM_POOL": "🔄", "REPLACED": "✨", "NEEDS_REVIEW": "⚠️"}[final_status]
                top_v = (chosen_list[0].get("vision") or {}) if chosen_list else {}
                live_done += 1
                elapsed = max(0.001, time.time() - t_start)
                rate = live_done / elapsed
                rem_live = max(0, total_live_todo - live_done)
                eta_sec = int(rem_live / rate) if rate > 0 else 0
                eta_h, eta_rem = divmod(eta_sec, 3600)
                eta_m, eta_s = divmod(eta_rem, 60)
                eta_str = f"{eta_h}h {eta_m:02d}m" if eta_h > 0 else f"{eta_m}m {eta_s:02d}s"
                global_done_now = total_global_items - total_live_todo + live_done
                pct = (global_done_now / total_global_items * 100.0) if total_global_items > 0 else 0.0
                print(
                    f"  {icon} [{idx+1}/{limit_n}] {item_ctx['answer']} -> {final_status} "
                    f"(guess={top_v.get('guessability_1_5s', '-')}, text={top_v.get('visible_text', [])[:2]}) "
                    f"| Globale {global_done_now}/{total_global_items} ({pct:.1f}%) | Live {live_done}/{total_live_todo} | ETA ~{eta_str}"
                )

                if not args.dry_run and best_url:
                    if item.get("imageUrl") != best_url or (item.get("imageUrls") or []) != clean_pool:
                        item["imageUrl"] = best_url
                        item["imageUrls"] = clean_pool
                        cat_changed = True
                        any_cat_changed = True
                        dirty_count += 1
                        if dirty_count % 5 == 0:
                            write_json_atomic(cat_path, cat_data)

                item_report = {
                    "id": item_ctx["id"],
                    "answer": item_ctx["answer"],
                    "finalStatus": final_status,
                    "oldUrl": old_primary,
                    "newUrl": best_url,
                    "oldReasons": old_reasons[:4],
                    "tech": chosen_list[0].get("tech") if chosen_list else {},
                    "vision": chosen_list[0].get("vision") if chosen_list else {},
                }
                item_reports_slots[idx] = item_report
                if not args.dry_run:
                    checkpoint_cache.mark_done(
                        item_id=item_ctx["id"],
                        image_url=best_url,
                        image_urls=clean_pool if clean_pool else (item.get("imageUrls") or []),
                        level=target_level,
                        status=final_status,
                        report=item_report,
                    )
                verdict_cache.flush()
                checkpoint_cache.flush()

        item_reports: List[Dict[str, Any]] = [r for r in item_reports_slots if r is not None]

        if cat_changed and not args.dry_run:
            write_json_atomic(cat_path, cat_data)
            sync_derived_catalog_files()
            print(f"  💾 Salvato {cat_path.name} e sincronizzato catalogo")
        if summary["skippedCached"] > 0 and item_reports:
            cat_skips = sum(1 for it in items[:limit_n] if checkpoint_cache.should_skip(it.get("id", ""), it.get("imageUrl") or "", it.get("imageUrls") or [], target_level, args.retry_needs_review))
            if cat_skips == limit_n:
                print(f"  ⏭️  Tutta la categoria saltata da cache ({limit_n}/{limit_n} già validati)")

        cat_reports.append(
            {
                "categoryId": cid,
                "categoryName": cat_data.get("name", cid),
                "icon": cat_data.get("icon", "📷"),
                "archetype": arch_key,
                "items": item_reports,
            }
        )

    if not args.dry_run:
        # Remove any active catalog URLs from blacklistedUrls to guarantee zero overlap
        all_active = set()
        for fp in PUBLIC_CAT_DIR.glob("*.json"):
            if fp.name == "index.json":
                continue
            c = load_json(fp, {})
            for it in c.get("items") or []:
                for u in [it.get("imageUrl"), *(it.get("imageUrls") or [])]:
                    if u:
                        all_active.add(normalize_url(u).lower())
        cleaned_bl = []
        seen_bl = set()
        for u in blacklisted_urls_raw:
            nu = normalize_url(u)
            if nu and nu.lower() not in all_active and nu.lower() not in seen_bl:
                seen_bl.add(nu.lower())
                cleaned_bl.append(nu)
        blacklist_data["blacklistedUrls"] = cleaned_bl
        write_json_atomic(BLACKLIST_FILE, blacklist_data)
        sync_derived_catalog_files()

    verdict_cache.flush()
    checkpoint_cache.flush()
    full_report = {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "elapsedSec": round(time.time() - t_start, 1),
        "models": {"scout": scout_model, "arbiter": arbiter_model},
        "summary": summary,
        "categories": cat_reports,
    }
    write_json_atomic(REPORT_JSON, full_report)
    render_gallery_html(full_report, GALLERY_HTML)

    print("\n============================================================")
    print(f"✅ CURATELA COMPLETATA in {full_report['elapsedSec']}s!")
    print(f"   Summary: {json.dumps(summary)}")
    print(f"   Report JSON: {REPORT_JSON}")
    print(f"   Galleria HTML: {GALLERY_HTML}")
    print("============================================================")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
