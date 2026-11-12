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
    upgraded = upgrade_wikimedia_thumb_url(url, 960)
    candidate_to_try = upgraded if upgraded != url else url

    dl = download_image_cached(candidate_to_try, CACHE_DIR, min_bytes=int(thresholds.get("minBytes", 5000)))
    actual_url = candidate_to_try
    if not dl.get("ok") and upgraded != url:
        dl = download_image_cached(url, CACHE_DIR, min_bytes=int(thresholds.get("minBytes", 5000)))
        actual_url = normalize_url(url)

    if not dl.get("ok"):
        return {
            "url": normalize_url(url),
            "actual_url": normalize_url(url),
            "verdict": "REJECT",
            "tech": {"valid": False, "score": 0, "fail_reasons": [dl.get("error", "download_failed")]},
            "vision": None,
            "composite_score": 0.0,
        }

    tech = analyze_image_pixels(dl["bytes"], thresholds)
    if not tech.get("valid", False):
        return {
            "url": normalize_url(url),
            "actual_url": actual_url,
            "verdict": "REJECT",
            "tech": tech,
            "vision": None,
            "composite_score": tech.get("score", 0.0) * 0.25,
        }

    if technical_only or judge is None:
        return {
            "url": normalize_url(url),
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
            image_bytes=dl["bytes"],
            tech_metrics=tech,
        )
        verdict_cache.put(item_ctx["id"], actual_url, vision)

    return {
        "url": normalize_url(url),
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
) -> List[Dict[str, Any]]:
    """
    Search multiple APIs, pre-filter candidates by pixel geometry, and use Vision 2x2 selector
    (up to 2 rounds) to find clean, iconic, text-free replacements.
    """
    hints = list(initial_hints)
    min_bytes = int(thresholds.get("minBytes", 5000))
    chosen_records: List[Dict[str, Any]] = []
    upgrade_fallback: List[Dict[str, Any]] = []

    for round_idx in range(2):
        candidates = gather_candidates(
            item_ctx=item_ctx,
            archetype_cfg=archetype_cfg,
            search_hints=hints,
            blacklisted_urls=blacklisted_urls,
            already_seen_urls=seen_urls,
            extra_forbidden=extra_forbidden,
            max_candidates=12,
        )
        if not candidates:
            break

        valid_pool: List[Dict[str, Any]] = []
        for cand in candidates:
            seen_urls.add(cand["url"])
            dl = download_image_cached(cand["url"], CACHE_DIR, min_bytes=min_bytes)
            if not dl.get("ok"):
                continue
            tech = analyze_image_pixels(dl["bytes"], thresholds)
            if not tech.get("valid"):
                continue
            valid_pool.append({"cand": cand, "bytes": dl["bytes"], "tech": tech})
            if len(valid_pool) >= 8:
                break

        if not valid_pool:
            if round_idx == 0:
                en = item_ctx.get("englishTitle") or item_ctx["answer"]
                hints = [en, item_ctx["answer"], f"{en} still"]
                continue
            break

        # Contact-sheet 2x2 blind selection across up to 2 chunks of 4 candidates
        for chunk_start in range(0, len(valid_pool), 4):
            chunk = valid_pool[chunk_start : chunk_start + 4]
            grid_res = judge.select_best_from_grid(
                item_ctx=item_ctx,
                archetype_cfg={**archetype_cfg, **thresholds},
                candidate_bytes_list=[v["bytes"] for v in chunk],
            )

            ordered_slots = grid_res.get("approved_slots") or []
            winner_slot = grid_res.get("winner_slot") or 0
            if winner_slot and winner_slot not in ordered_slots:
                ordered_slots = [winner_slot] + ordered_slots

            for slot_idx in ordered_slots:
                rec = chunk[slot_idx - 1]
                url = rec["cand"]["url"]
                vision = judge.evaluate_single(
                    item_ctx=item_ctx,
                    archetype_cfg={**archetype_cfg, **thresholds},
                    image_bytes=rec["bytes"],
                    tech_metrics=rec["tech"],
                    allow_arbiter_escalation=False,
                )
                verdict_cache.put(item_ctx["id"], url, vision)
                record = {
                    "url": url,
                    "source": rec["cand"]["source"],
                    "tech": rec["tech"],
                    "vision": vision,
                    "composite_score": float(vision.get("composite_score", 60.0)),
                }
                if vision["verdict"] == "KEEP":
                    chosen_records.append(record)
                elif vision["verdict"] == "UPGRADE_RECOMMENDED":
                    upgrade_fallback.append(record)
                elif vision["verdict"] == "REJECT":
                    blacklisted_urls.add(url.lower())

            if chosen_records:
                break

        if chosen_records:
            chosen_records.sort(key=lambda r: r["composite_score"], reverse=True)
            break

        if round_idx == 0:
            hints = [item_ctx.get("englishTitle") or item_ctx["answer"], f"{item_ctx['answer']} scene"]

    if not chosen_records and upgrade_fallback:
        upgrade_fallback.sort(key=lambda r: r["composite_score"], reverse=True)
        return upgrade_fallback[:2]

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

    t_start = time.time()
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
        item_reports: List[Dict[str, Any]] = []

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
                    item_reports.append(cached_cp.get("report") or {"id": item_id, "answer": item.get("answer", ""), "finalStatus": st_c, "oldUrl": old_primary, "newUrl": old_primary})
                    continue

            # Deduplicate preserving order
            pool_urls: List[str] = []
            for u in raw_pool:
                if u and u not in pool_urls:
                    pool_urls.append(u)

            item_ctx = {
                "id": item.get("id", f"{cid}-{idx}"),
                "answer": item.get("answer", ""),
                "aliases": item.get("aliases") or [],
                "englishTitle": item.get("englishTitle") or "",
                "categoryName": cat_data.get("name", cid),
            }

            evaluated: List[Dict[str, Any]] = []
            for u in pool_urls:
                res = evaluate_existing_url(
                    url=u,
                    item_ctx=item_ctx,
                    archetype_cfg=arch_cfg,
                    thresholds=thresholds,
                    judge=judge,
                    verdict_cache=verdict_cache,
                    technical_only=args.technical_only or args.repair_failed_only,
                )
                evaluated.append(res)

            keep_list = sorted([e for e in evaluated if e["verdict"] == "KEEP"], key=lambda x: x["composite_score"], reverse=True)
            upgrade_list = sorted(
                [e for e in evaluated if e["verdict"] == "UPGRADE_RECOMMENDED"],
                key=lambda x: x["composite_score"],
                reverse=True,
            )
            reject_list = [e for e in evaluated if e["verdict"] == "REJECT"]

            old_reasons: List[str] = []
            for rj in reject_list:
                if rj["url"] == old_primary:
                    old_reasons.extend(rj["tech"].get("fail_reasons") or [])
                    if rj.get("vision"):
                        old_reasons.extend(rj["vision"].get("issues") or [])
                u_norm = rj["url"].lower()
                if u_norm and u_norm not in blacklisted_set:
                    blacklisted_set.add(u_norm)
                    blacklisted_urls_raw.append(rj["url"])
                    summary["blacklistedAdded"] += 1

            chosen_list = keep_list
            final_status = "KEPT"

            if not chosen_list and not args.technical_only and not args.no_replace and judge is not None:
                hints: List[str] = []
                for cand_ev in evaluated:
                    if cand_ev.get("vision") and cand_ev["vision"].get("visual_search_hints"):
                        hints.extend(cand_ev["vision"]["visual_search_hints"])
                seen_urls = {normalize_url(u) for u in pool_urls} | {e["actual_url"] for e in evaluated}
                hunted = hunt_and_select_replacement(
                    item_ctx=item_ctx,
                    archetype_cfg=arch_cfg,
                    thresholds=thresholds,
                    judge=judge,
                    verdict_cache=verdict_cache,
                    initial_hints=hints,
                    blacklisted_urls=blacklisted_set,
                    seen_urls=seen_urls,
                    extra_forbidden=extra_forbidden,
                )
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
                # Keep best UPGRADE_RECOMMENDED if no clean replacement found, else flag NEEDS_REVIEW
                if upgrade_list:
                    chosen_list = upgrade_list
                    final_status = "NEEDS_REVIEW" if upgrade_list[0]["actual_url"] == old_primary else "UPGRADED_FROM_POOL"
                else:
                    chosen_list = [evaluated[0]] if evaluated else []
                    final_status = "NEEDS_REVIEW"
            elif chosen_list[0]["actual_url"] != old_primary and final_status == "KEPT":
                final_status = "UPGRADED_FROM_POOL"

            # Never let an active chosen URL sit inside blacklist.json
            best_url = chosen_list[0]["actual_url"] if chosen_list else old_primary
            clean_pool = []
            for ch in chosen_list:
                u = ch["actual_url"]
                if u and u not in clean_pool:
                    clean_pool.append(u)
                    blacklisted_set.discard(u.lower())
            # Also keep valid UPGRADE_RECOMMENDED backups only if chosen_list came from KEEP and has < 2 entries
            if len(clean_pool) == 1 and keep_list and upgrade_list:
                for up in upgrade_list[:1]:
                    if up["actual_url"] not in clean_pool and up["actual_url"].lower() not in blacklisted_set:
                        clean_pool.append(up["actual_url"])

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
            print(
                f"  {icon} [{idx+1}/{limit_n}] {item_ctx['answer']} -> {final_status} "
                f"(guess={top_v.get('guessability_1_5s', '-')}, text={top_v.get('visible_text', [])[:2]})"
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
            item_reports.append(item_report)
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
