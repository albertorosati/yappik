"""Fast deterministic pixel, geometry, padding, blur, and collage analyzer using Pillow."""

from __future__ import annotations

import hashlib
import io
import json
import re
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import requests
from PIL import Image, ImageChops, ImageFilter, ImageOps, ImageStat

USER_AGENT = "YappikVisionCurator/1.0 (https://github.com/albertorosati/yappik; image quality auditor)"

_SESSION = requests.Session()
_SESSION.headers.update({"User-Agent": USER_AGENT})


def normalize_url(url: str) -> str:
    """Normalize an image URL by stripping query parameters and trimming."""
    if not url or not isinstance(url, str):
        return ""
    return url.split("?")[0].strip()


def upgrade_wikimedia_thumb_url(url: str, target_width: int = 960) -> str:
    """
    Attempt lossless step-up of Wikimedia thumb URLs (e.g. /220px- -> /960px-).
    Only modifies `/wikipedia/commons/thumb/.../<N>px-...` or `/wikipedia/en|it/thumb/...`.
    """
    clean = normalize_url(url)
    if "/thumb/" not in clean:
        return clean
    match = re.search(r"/(\d{2,4})px-([^/]+)$", clean)
    if not match:
        return clean
    current_px = int(match.group(1))
    if current_px >= target_width:
        return clean
    return re.sub(r"/(\d{2,4})px-([^/]+)$", f"/{target_width}px-\\2", clean)


def download_image_cached(
    url: str,
    cache_dir: Path,
    timeout: int = 15,
    min_bytes: int = 2000,
) -> Dict[str, Any]:
    """
    Fetch image bytes with persistent local cache and Wikimedia 429 retry/backoff.
    Returns dict: {ok, url, bytes, status, content_type, error}
    """
    clean_url = normalize_url(url)
    if not clean_url.startswith("http"):
        return {"ok": False, "url": clean_url, "status": 0, "error": "invalid_scheme"}

    img_cache = cache_dir / "images"
    img_cache.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha1(clean_url.encode("utf-8")).hexdigest()
    bin_path = img_cache / f"{digest}.bin"
    meta_path = img_cache / f"{digest}.json"

    if bin_path.exists() and meta_path.exists():
        try:
            meta = json.loads(meta_path.read_text("utf-8"))
            if meta.get("ok") and bin_path.stat().st_size >= min_bytes:
                return {
                    "ok": True,
                    "url": clean_url,
                    "bytes": bin_path.read_bytes(),
                    "status": meta.get("status", 200),
                    "content_type": meta.get("content_type", ""),
                    "cached": True,
                }
            if not meta.get("ok") and meta.get("permanent"):
                return {
                    "ok": False,
                    "url": clean_url,
                    "status": meta.get("status", 404),
                    "error": meta.get("error", "cached_failure"),
                    "cached": True,
                }
        except Exception:
            pass

    last_err = "fetch_failed"
    last_status = 0
    for attempt in range(3):
        try:
            resp = _SESSION.get(clean_url, timeout=timeout, allow_redirects=True)
            last_status = resp.status_code
            ctype = (resp.headers.get("Content-Type") or "").lower()
            if resp.status_code == 200:
                if "text/html" in ctype or "application/json" in ctype or "svg" in ctype:
                    meta_path.write_text(
                        json.dumps({"ok": False, "status": 200, "error": f"bad_content_type:{ctype}", "permanent": True}),
                        "utf-8",
                    )
                    return {"ok": False, "url": clean_url, "status": 200, "error": f"bad_content_type:{ctype}"}
                raw = resp.content
                if len(raw) < min_bytes:
                    meta_path.write_text(
                        json.dumps({"ok": False, "status": 200, "error": f"too_small_bytes:{len(raw)}", "permanent": True}),
                        "utf-8",
                    )
                    return {"ok": False, "url": clean_url, "status": 200, "error": f"too_small_bytes:{len(raw)}"}
                bin_path.write_bytes(raw)
                meta_path.write_text(
                    json.dumps({"ok": True, "status": 200, "content_type": ctype, "url": clean_url}),
                    "utf-8",
                )
                return {
                    "ok": True,
                    "url": clean_url,
                    "bytes": raw,
                    "status": 200,
                    "content_type": ctype,
                    "cached": False,
                }
            if resp.status_code in (429, 502, 503, 504):
                last_err = f"http_{resp.status_code}"
                time.sleep(1.2 * (attempt + 1))
                continue
            if resp.status_code in (403, 404, 410):
                meta_path.write_text(
                    json.dumps({"ok": False, "status": resp.status_code, "error": f"http_{resp.status_code}", "permanent": True}),
                    "utf-8",
                )
                return {"ok": False, "url": clean_url, "status": resp.status_code, "error": f"http_{resp.status_code}"}
            last_err = f"http_{resp.status_code}"
        except Exception as exc:
            last_err = f"exc:{type(exc).__name__}"
            time.sleep(0.7 * (attempt + 1))

    return {"ok": False, "url": clean_url, "status": last_status, "error": last_err}


def _composite_rgb(img: Image.Image) -> Image.Image:
    """Normalize EXIF orientation and composite alpha onto a crisp white background."""
    img = ImageOps.exif_transpose(img)
    if img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info):
        rgba = img.convert("RGBA")
        bg = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
        return Image.alpha_composite(bg, rgba).convert("RGB")
    return img.convert("RGB")


def _compute_content_bbox(rgb: Image.Image, tol: int = 16) -> Tuple[int, int, int, int]:
    """
    Estimate the tight foreground bounding box by subtracting uniform outer border color.
    Helps detect tiny logos/sprites floating in giant white or black canvases.
    """
    w, h = rgb.size
    corner_tl = rgb.getpixel((0, 0))
    corner_br = rgb.getpixel((w - 1, h - 1))
    bg_tl = Image.new("RGB", rgb.size, corner_tl)
    diff_tl = ImageChops.difference(rgb, bg_tl).convert("L")
    mask = diff_tl.point(lambda p: 255 if p > tol else 0)
    bbox = mask.getbbox()
    if bbox is None:
        return (0, 0, w, h)
    # Also intersect check if opposite corner matches a different matte (e.g. half border)
    if corner_tl != corner_br:
        bg_br = Image.new("RGB", rgb.size, corner_br)
        diff_br = ImageChops.difference(rgb, bg_br).convert("L")
        mask_br = diff_br.point(lambda p: 255 if p > tol else 0)
        bbox2 = mask_br.getbbox()
        if bbox2:
            x0 = max(bbox[0], bbox2[0])
            y0 = max(bbox[1], bbox2[1])
            x1 = min(bbox[2], bbox2[2])
            y1 = min(bbox[3], bbox2[3])
            if x1 > x0 + 16 and y1 > y0 + 16:
                return (x0, y0, x1, y1)
    return bbox


def _detect_split_collage_seam(gray_thumb: Image.Image) -> float:
    """
    Detect straight artificial divider seams (e.g. 2-panel or 4-panel collages) near
    midlines (50%) or thirds (33%, 67%). Returns max seam score in [0..1].
    """
    w, h = gray_thumb.size
    if w < 120 or h < 120:
        return 0.0
    px = gray_thumb.load()

    def line_seam_score(is_vertical: bool, pos: int) -> float:
        uniform_span = 0
        samples = h if is_vertical else w
        step = max(1, samples // 90)
        count = 0
        vals = []
        edge_jumps = 0
        for t in range(0, samples, step):
            v = px[pos, t] if is_vertical else px[t, pos]
            vals.append(v)
            prev_v = px[max(0, pos - 3), t] if is_vertical else px[t, max(0, pos - 3)]
            next_v = px[min(w - 1, pos + 3), t] if is_vertical else px[t, min(h - 1, pos + 3)]
            if abs(v - prev_v) > 25 or abs(v - next_v) > 25:
                edge_jumps += 1
            count += 1
        if not vals:
            return 0.0
        mean_v = sum(vals) / len(vals)
        flat_pixels = sum(1 for v in vals if abs(v - mean_v) <= 6)
        uniform_frac = flat_pixels / len(vals)
        # An artificial divider line is razor-flat along the whole axis AND borders high contrast edges
        if uniform_frac >= 0.90 and (mean_v >= 235 or mean_v <= 25):
            if edge_jumps / max(1, count) >= 0.45:
                return uniform_frac
        return 0.0

    best = 0.0
    for frac in (0.5, 0.333, 0.667):
        vx = int(w * frac)
        for dx in range(-2, 3):
            if 10 < vx + dx < w - 10:
                best = max(best, line_seam_score(True, vx + dx))
        hy = int(h * frac)
        for dy in range(-2, 3):
            if 10 < hy + dy < h - 10:
                best = max(best, line_seam_score(False, hy + dy))
    return best


def analyze_image_pixels(image_bytes: bytes, thresholds: Dict[str, Any]) -> Dict[str, Any]:
    """
    Inspect decoded pixels for resolution, aspect ratio, padding/tiny-subject framing,
    sharpness, dynamic range, and artificial collage seams.
    """
    fail_reasons: List[str] = []
    try:
        with Image.open(io.BytesIO(image_bytes)) as raw_im:
            fmt = (raw_im.format or "").upper()
            rgb = _composite_rgb(raw_im)
    except Exception as exc:
        return {
            "valid": False,
            "score": 0,
            "fail_reasons": [f"decode_error:{type(exc).__name__}"],
            "width": 0,
            "height": 0,
        }

    w, h = rgb.size
    ratio = round(w / max(1, h), 3)

    min_w = int(thresholds.get("minWidth", 480))
    min_h = int(thresholds.get("minHeight", 360))
    min_ar = float(thresholds.get("minAspectRatio", 0.56))
    max_ar = float(thresholds.get("maxAspectRatio", 1.95))

    if w < min_w and h < min_h:
        fail_reasons.append(f"resolution_too_low:{w}x{h}")
    elif w < int(min_w * 0.72) or h < int(min_h * 0.68):
        fail_reasons.append(f"dimension_too_small:{w}x{h}")

    if ratio < min_ar or ratio > max_ar:
        fail_reasons.append(f"extreme_aspect_ratio:{ratio}")

    # Foreground bounding box check (detect huge empty margins / small sprite inside canvas)
    x0, y0, x1, y1 = _compute_content_bbox(rgb)
    cw, ch = max(1, x1 - x0), max(1, y1 - y0)
    content_ratio = round((cw * ch) / max(1, w * h), 3)

    min_cw = int(thresholds.get("minContentWidth", 260))
    min_ch = int(thresholds.get("minContentHeight", 220))
    min_c_ratio = float(thresholds.get("minContentRatio", 0.28))

    if cw < min_cw and ch < min_ch:
        fail_reasons.append(f"tiny_subject_inside_padding:{cw}x{ch}")
    if content_ratio < min_c_ratio:
        fail_reasons.append(f"excessive_border_padding:{content_ratio}")

    # Work on 320px normalized copy for fast sharpness / contrast / seam metrics
    work = rgb.copy()
    work.thumbnail((320, 320), Image.Resampling.BILINEAR)
    gray = work.convert("L")

    luma_stat = ImageStat.Stat(gray)
    luma_std = round(luma_stat.stddev[0], 2)
    min_luma_std = float(thresholds.get("minLumaStd", 14.0))
    if luma_std < min_luma_std:
        fail_reasons.append(f"flat_low_contrast:{luma_std}")

    hist = gray.histogram()
    total_px = max(1, sum(hist))
    dark_clip = round(sum(hist[:10]) / total_px, 3)
    bright_clip = round(sum(hist[248:]) / total_px, 3)
    max_clip = float(thresholds.get("maxClipRatio", 0.84))
    if not thresholds.get("skipExposureClip", False):
        if dark_clip > max_clip or bright_clip > max_clip:
            fail_reasons.append(f"exposure_clipped:dark={dark_clip},bright={bright_clip}")

    # Edge energy / sharpness
    edges = gray.filter(ImageFilter.FIND_EDGES)
    edge_stat = ImageStat.Stat(edges)
    # Crop 6px border so outer canvas borders don't inflate edge stat
    ew, eh = edges.size
    if ew > 24 and eh > 24:
        inner_edges = edges.crop((6, 6, ew - 6, eh - 6))
        edge_stat = ImageStat.Stat(inner_edges)
    sharpness = round(edge_stat.rms[0] * 0.35 + edge_stat.stddev[0] * 0.45, 2)
    min_sharp = float(thresholds.get("minSharpness", 4.2))
    if sharpness < min_sharp:
        fail_reasons.append(f"blurry_low_detail:{sharpness}")

    seam_score = 0.0 if thresholds.get("skipCollageSeam", False) else round(_detect_split_collage_seam(gray), 3)
    if seam_score >= 0.96:
        fail_reasons.append(f"collage_split_seam:{seam_score}")

    # Score [0..100]
    score = 55.0
    if w >= 900 and h >= 650:
        score += 18.0
    elif w >= 640 and h >= 480:
        score += 10.0
    score += min(15.0, max(0.0, (sharpness - min_sharp) * 1.1))
    score += min(12.0, content_ratio * 12.0)
    if fail_reasons:
        score = max(0.0, min(40.0, score - 35.0 * len(fail_reasons)))

    return {
        "valid": len(fail_reasons) == 0,
        "score": round(score, 1),
        "fail_reasons": fail_reasons,
        "format": fmt,
        "width": w,
        "height": h,
        "content_width": cw,
        "content_height": ch,
        "content_ratio": content_ratio,
        "aspect_ratio": ratio,
        "sharpness": sharpness,
        "luma_std": luma_std,
        "seam_score": seam_score,
        "bytes": len(image_bytes),
    }
