"""Ollama Vision critic + blind 2x2 candidate selector with resumable verdict cache."""

from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import re
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import requests
from PIL import Image, ImageDraw, ImageFont

from pixel_metrics import normalize_url
from spoiler_matcher import evaluate_spoiler_text

OLLAMA_BASE = os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434").rstrip("/")


class VerdictCache:
    """Atomic disk cache of Vision verdicts keyed by (promptVersion, itemId, normalizedUrl)."""

    def __init__(self, cache_path: Path, prompt_version: str) -> None:
        self.cache_path = cache_path
        self.prompt_version = prompt_version
        self._data: Dict[str, Any] = {}
        self._dirty = False
        self._lock = threading.Lock()
        if cache_path.exists():
            try:
                loaded = json.loads(cache_path.read_text("utf-8"))
                if isinstance(loaded, dict):
                    self._data = loaded
            except Exception:
                self._data = {}

    def _key(self, item_id: str, url: str) -> str:
        raw = f"{self.prompt_version}|{item_id}|{normalize_url(url).lower()}"
        return hashlib.sha1(raw.encode("utf-8")).hexdigest()

    def get(self, item_id: str, url: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            return self._data.get(self._key(item_id, url))

    def put(self, item_id: str, url: str, verdict: Dict[str, Any]) -> None:
        with self._lock:
            self._data[self._key(item_id, url)] = verdict
            self._dirty = True

    def flush(self) -> None:
        with self._lock:
            if not self._dirty:
                return
            self.cache_path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.cache_path.with_suffix(".tmp")
            tmp.write_text(json.dumps(self._data, indent=2, ensure_ascii=False), "utf-8")
            tmp.replace(self.cache_path)
            self._dirty = False


class ItemCheckpointCache:
    """
    Item-level resumable checkpoint cache so previously validated items (whose URLs have
    not changed and whose validation level meets or exceeds the current run) are skipped in O(1).
    Levels: 1 = technical, 2 = repair-failed-only, 3 = full_vision.
    """

    LEVEL_TECHNICAL = 1
    LEVEL_REPAIR = 2
    LEVEL_FULL_VISION = 4

    def __init__(self, cache_path: Path, prompt_version: str) -> None:
        self.cache_path = cache_path
        self.prompt_version = prompt_version
        self._data: Dict[str, Any] = {}
        self._dirty = False
        if cache_path.exists():
            try:
                loaded = json.loads(cache_path.read_text("utf-8"))
                if isinstance(loaded, dict):
                    self._data = loaded
            except Exception:
                self._data = {}

    def fingerprint(self, image_url: str, image_urls: List[str] | None) -> str:
        norm_primary = normalize_url(image_url).lower()
        norm_pool = [normalize_url(u).lower() for u in (image_urls or []) if u]
        raw = json.dumps([self.prompt_version, norm_primary, norm_pool], ensure_ascii=False)
        return hashlib.sha1(raw.encode("utf-8")).hexdigest()

    def should_skip(
        self,
        item_id: str,
        image_url: str,
        image_urls: List[str] | None,
        target_level: int,
        retry_needs_review: bool = False,
    ) -> Optional[Dict[str, Any]]:
        entry = self._data.get(item_id)
        if not isinstance(entry, dict):
            return None
        if entry.get("fingerprint") != self.fingerprint(image_url, image_urls):
            return None
        if int(entry.get("level", 0)) < target_level:
            return None
        if retry_needs_review and entry.get("status") == "NEEDS_REVIEW":
            return None
        return entry

    def mark_done(
        self,
        item_id: str,
        image_url: str,
        image_urls: List[str] | None,
        level: int,
        status: str,
        report: Dict[str, Any],
    ) -> None:
        prev = self._data.get(item_id)
        fp = self.fingerprint(image_url, image_urls)
        effective_level = level
        if isinstance(prev, dict) and prev.get("fingerprint") == fp:
            effective_level = max(level, int(prev.get("level", 0)))
        self._data[item_id] = {
            "fingerprint": fp,
            "level": effective_level,
            "status": status,
            "report": report,
        }
        self._dirty = True

    def flush(self) -> None:
        if not self._dirty:
            return
        self.cache_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.cache_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self._data, indent=2, ensure_ascii=False), "utf-8")
        tmp.replace(self.cache_path)
        self._dirty = False


def encode_image_for_vlm(image_bytes: bytes, max_edge: int = 512) -> str:
    """Resize image cleanly to bounded max edge JPEG and return base64."""
    with Image.open(io.BytesIO(image_bytes)) as im:
        rgb = im.convert("RGB")
        rgb.thumbnail((max_edge, max_edge), Image.Resampling.LANCZOS)
        buf = io.BytesIO()
        rgb.save(buf, format="JPEG", quality=86)
        return base64.b64encode(buf.getvalue()).decode("ascii")


def build_labeled_grid(candidate_images: List[bytes], tile_size: int = 380) -> bytes:
    """
    Build a high-contrast labeled 2x2 (or 1x2 / 2x2) contact sheet with Neo-Brutalist badges [1..4].
    """
    n = min(4, len(candidate_images))
    cols = 2
    rows = 1 if n <= 2 else 2
    pad = 12
    canvas_w = cols * tile_size + (cols + 1) * pad
    canvas_h = rows * tile_size + (rows + 1) * pad
    canvas = Image.new("RGB", (canvas_w, canvas_h), (20, 18, 31))
    draw = ImageDraw.Draw(canvas)

    try:
        font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 28)
    except Exception:
        font = ImageFont.load_default()

    for idx in range(n):
        r = idx // cols
        c = idx % cols
        ox = pad + c * (tile_size + pad)
        oy = pad + r * (tile_size + pad)

        # White card frame
        draw.rectangle((ox, oy, ox + tile_size, oy + tile_size), fill=(255, 249, 236))
        with Image.open(io.BytesIO(candidate_images[idx])) as raw_im:
            tile = raw_im.convert("RGB")
            tile.thumbnail((tile_size - 16, tile_size - 56), Image.Resampling.LANCZOS)
            px = ox + (tile_size - tile.width) // 2
            py = oy + 46 + ((tile_size - 54) - tile.height) // 2
            canvas.paste(tile, (px, py))

        # High-contrast yellow/ink slot badge at top-left
        draw.rectangle((ox + 8, oy + 6, ox + 108, oy + 42), fill=(255, 201, 51), outline=(20, 18, 31), width=3)
        draw.text((ox + 22, oy + 10), f"[{idx + 1}]", fill=(20, 18, 31), font=font)

    out = io.BytesIO()
    canvas.save(out, format="JPEG", quality=86)
    return out.getvalue()


def _extract_json_object(raw_text: str) -> Dict[str, Any]:
    """Robustly parse JSON returned by an LLM (handles fenced codeblocks or surrounding text)."""
    cleaned = (raw_text or "").strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned)
        cleaned = re.sub(r"\s*```$", "", cleaned)
    try:
        obj = json.loads(cleaned)
        if isinstance(obj, dict):
            return obj
    except Exception:
        pass
    match = re.search(r"\{.*\}", cleaned, flags=re.S)
    if match:
        try:
            obj = json.loads(match.group(0))
            if isinstance(obj, dict):
                return obj
        except Exception:
            pass
    return {}


class OllamaVisionClient:
    """Wrapper over local Ollama API with autonomous model verification & pulling."""

    def __init__(self, scout_model: str, arbiter_model: str, keep_alive: str = "15m") -> None:
        self.scout_model = scout_model
        self.arbiter_model = arbiter_model
        self.keep_alive = keep_alive
        self._verified_models: set[str] = set()
        self.gemini_api_key = self._load_env_key("GEMINI_API_KEY")
        self.groq_api_key = self._load_env_key("GROQ_API_KEY")
        self._gemini_models = [
            "gemini-3.5-flash-lite",
            "gemini-2.5-flash-lite",
            "gemini-2.5-flash",
            "gemini-3-flash",
            "gemini-3.6-flash",
            "gemini-3.8-flash",
        ]
        self._exhausted_gemini_models: set[str] = set()
        self._last_gemini_call_ts = 0.0
        self._groq_model = "qwen/qwen3.8-27b"
        self._groq_exhausted_until = 0.0
        self._last_groq_call_ts = 0.0
        self._groq_min_gap = 13.5  # ~4.4 RPM * ~1711 tok = ~7.5K TPM (< 8K TPM cap)
        self._gemini_lock = threading.Lock()
        self._groq_lock = threading.Lock()
        if self.gemini_api_key:
            print("☁️  GEMINI_API_KEY rilevata: uso Gemini Vision API.")
        if self.groq_api_key:
            print("⚡ GROQ_API_KEY rilevata: alterno Groq Vision (qwen/qwen3.8-27b) con Gemini (fallback Ollama).")

    @staticmethod
    def _load_env_key(var_name: str) -> str:
        env_k = (os.environ.get(var_name) or "").strip()
        if env_k:
            return env_k
        env_file = Path(__file__).resolve().parent.parent.parent / ".env"
        if env_file.exists():
            prefix = f"{var_name}="
            for line in env_file.read_text("utf-8").splitlines():
                if line.startswith(prefix):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
        return ""

    def list_installed_models(self) -> List[str]:
        resp = requests.get(f"{OLLAMA_BASE}/api/tags", timeout=10)
        resp.raise_for_status()
        models = resp.json().get("models", [])
        return [m.get("name", "") for m in models if m.get("name")]

    def ensure_model(self, model_name: str) -> None:
        """Check if model exists locally on Ollama; if missing, pull it autonomously."""
        if model_name in self._verified_models:
            return
        installed = self.list_installed_models()
        # Match exact tag or `:latest`
        if any(m == model_name or (":" not in model_name and m == f"{model_name}:latest") for m in installed):
            self._verified_models.add(model_name)
            return

        print(f"⬇️  Modello Ollama '{model_name}' non presente localmente. Avvio download autonomo...")
        with requests.post(
            f"{OLLAMA_BASE}/api/pull",
            json={"name": model_name, "stream": True},
            stream=True,
            timeout=1800,
        ) as resp:
            resp.raise_for_status()
            last_pct = -1
            for line in resp.iter_lines(decode_unicode=True):
                if not line:
                    continue
                try:
                    pkt = json.loads(line)
                except Exception:
                    continue
                total = pkt.get("total") or 0
                completed = pkt.get("completed") or 0
                if total > 0:
                    pct = int(100 * completed / total)
                    if pct >= last_pct + 10 or pct == 100:
                        last_pct = pct
                        print(f"   ... download {model_name}: {pct}%")
                elif pkt.get("status") == "success":
                    print(f"   ✅ Modello {model_name} pronto.")
        self._verified_models.add(model_name)

    def _chat_gemini_json(
        self,
        prompt: str,
        image_b64: str,
        num_predict: int = 320,
    ) -> Optional[Dict[str, Any]]:
        if not self.gemini_api_key:
            return None
        for g_model in self._gemini_models:
            if g_model in self._exhausted_gemini_models:
                continue
            min_gap = 4.1 if "lite" in g_model else 12.2
            with self._gemini_lock:
                if g_model in self._exhausted_gemini_models:
                    continue
                now = time.time()
                target_ts = max(now, self._last_gemini_call_ts + min_gap)
                wait_s = target_ts - now
                self._last_gemini_call_ts = target_ts
            if wait_s > 0:
                time.sleep(wait_s)
            url = f"https://generativelanguage.googleapis.com/v1beta/models/{g_model}:generateContent?key={self.gemini_api_key}"
            payload = {
                "contents": [
                    {
                        "parts": [
                            {"text": prompt},
                            {"inline_data": {"mime_type": "image/jpeg", "data": image_b64}},
                        ]
                    }
                ],
                "generationConfig": {
                    "temperature": 0.0,
                    "maxOutputTokens": max(300, num_predict),
                    "responseMimeType": "application/json",
                },
            }
            for attempt in range(2):
                try:
                    resp = requests.post(url, json=payload, timeout=30)
                    if resp.status_code == 200:
                        data = resp.json()
                        parts = (((data.get("candidates") or [{}])[0].get("content") or {}).get("parts") or [])
                        text = "".join(p.get("text", "") for p in parts if isinstance(p, dict))
                        parsed = _extract_json_object(text)
                        if parsed:
                            return parsed
                        break
                    if resp.status_code == 429:
                        if attempt == 0:
                            time.sleep(6.0)
                            continue
                        print(f"   ⚠️ Quota Gemini esaurita su {g_model} (HTTP 429), passo al modello successivo/fallback.")
                        self._exhausted_gemini_models.add(g_model)
                        break
                    if resp.status_code in (400, 404):
                        self._exhausted_gemini_models.add(g_model)
                        break
                except Exception:
                    if attempt == 0:
                        time.sleep(2.0)
                        continue
                    break
        return None

    def _groq_ready_in(self) -> Optional[float]:
        with self._groq_lock:
            now = time.time()
            if not self.groq_api_key or now < self._groq_exhausted_until:
                return None
            return max(0.0, self._groq_min_gap - (now - self._last_groq_call_ts))

    def _gemini_ready_in(self) -> Optional[float]:
        with self._gemini_lock:
            if not self.gemini_api_key:
                return None
            now = time.time()
            for g_model in self._gemini_models:
                if g_model not in self._exhausted_gemini_models:
                    min_gap = 4.1 if "lite" in g_model else 12.2
                    return max(0.0, min_gap - (now - self._last_gemini_call_ts))
            return None

    def _chat_groq_json(
        self,
        prompt: str,
        image_b64: str,
        num_predict: int = 320,
    ) -> Optional[Dict[str, Any]]:
        with self._groq_lock:
            now = time.time()
            if not self.groq_api_key or now < self._groq_exhausted_until:
                return None
            target_ts = max(now, self._last_groq_call_ts + self._groq_min_gap)
            ready_in = target_ts - now
            self._last_groq_call_ts = target_ts
        if ready_in > 0:
            time.sleep(ready_in)
        payload = {
            "model": self._groq_model,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt},
                        {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{image_b64}"}},
                    ],
                }
            ],
            "temperature": 0.0,
            "max_tokens": max(300, num_predict),
            "response_format": {"type": "json_object"},
        }
        headers = {
            "Authorization": f"Bearer {self.groq_api_key}",
            "Content-Type": "application/json",
            "User-Agent": "curl/8.0",
        }
        try:
            resp = requests.post(
                "https://api.groq.com/openai/v1/chat/completions",
                json=payload,
                headers=headers,
                timeout=30,
            )
            if resp.status_code == 200:
                content = (((resp.json().get("choices") or [{}])[0].get("message") or {}).get("content") or "")
                parsed = _extract_json_object(content)
                if parsed:
                    return parsed
                return None
            if resp.status_code == 429:
                body_low = resp.text.lower()
                if "per day" in body_low or "rpd" in body_low or "tpd" in body_low:
                    print("   ⚠️ Quota giornaliera Groq esaurita (HTTP 429), disabilito Groq per 1h.")
                    self._groq_exhausted_until = time.time() + 3600.0
                else:
                    retry_after = float(resp.headers.get("retry-after") or 16.0)
                    self._groq_exhausted_until = time.time() + max(10.0, min(retry_after, 60.0))
                return None
        except Exception:
            return None
        return None

    def _chat_json(
        self,
        model_name: str,
        prompt: str,
        image_b64: str,
        num_predict: int = 320,
        num_ctx: int = 2048,
    ) -> Dict[str, Any]:
        groq_wait = self._groq_ready_in()
        gem_wait = self._gemini_ready_in()

        # Prefer whichever cloud API is ready sooner (zero idle wait when alternating!)
        if groq_wait is not None and (gem_wait is None or groq_wait <= gem_wait):
            groq_res = self._chat_groq_json(prompt, image_b64, num_predict=num_predict)
            if groq_res is not None:
                return groq_res
            gem_wait = self._gemini_ready_in()

        if gem_wait is not None:
            gem = self._chat_gemini_json(prompt, image_b64, num_predict=num_predict)
            if gem is not None:
                return gem
            if self._groq_ready_in() is not None:
                groq_res = self._chat_groq_json(prompt, image_b64, num_predict=num_predict)
                if groq_res is not None:
                    return groq_res

        self.ensure_model(model_name)
        payload = {
            "model": model_name,
            "think": False,
            "keep_alive": self.keep_alive,
            "stream": False,
            "format": "json",
            "options": {
                "temperature": 0.0,
                "num_ctx": num_ctx,
                "num_predict": num_predict,
            },
            "messages": [
                {
                    "role": "user",
                    "content": prompt,
                    "images": [image_b64],
                }
            ],
        }
        resp = requests.post(f"{OLLAMA_BASE}/api/chat", json=payload, timeout=180)
        resp.raise_for_status()
        content = resp.json().get("message", {}).get("content", "")
        return _extract_json_object(content)

    def _build_single_prompt(self, item_ctx: Dict[str, Any], archetype_cfg: Dict[str, Any]) -> str:
        answer = item_ctx["answer"]
        aliases = item_ctx.get("aliases") or []
        cat_name = item_ctx.get("categoryName", "")
        hint = item_ctx.get("englishTitle") or ""
        rules = archetype_cfg.get("rules", "")

        return (
            f"Strict Photo Quality & Anti-Spoiler Director for a 1.5s TV photo trivia game.\n"
            f"Target: \"{answer}\" (alt: \"{hint}\", aliases: {aliases[:4]})\n"
            f"Category: \"{cat_name}\" ({archetype_cfg.get('label', '')}). Rules: {rules}\n"
            f"Note: Only reject actor red-carpet/press portraits when Target is a Movie/TV/Game TITLE — "
            f"if Target is an actual person/actor/comedian/director, a clear portrait IS valid.\n"
            f"Return ONLY JSON:\n"
            f"{{\n"
            f'  "depicts_target": boolean,\n'
            f'  "is_generic_celebrity_portrait": boolean,\n'
            f'  "match_confidence": number 0.0-1.0,\n'
            f'  "guessability_1_5s": integer 1-10,\n'
            f'  "visual_quality": integer 1-10,\n'
            f'  "frame_type": "live_photo|movie_still|gameplay|clean_artwork|poster_or_cover|red_carpet_or_press|collage|text_slide|logo|diagram|wrong_subject",\n'
            f'  "visible_text": array of up to 5 readable words ([] if none),\n'
            f'  "text_prominence": "none|minor_background|prominent_overlay_or_title",\n'
            f'  "issues": array of short tags,\n'
            f'  "verdict": "KEEP" | "UPGRADE_RECOMMENDED" | "REJECT",\n'
            f'  "visual_search_hints": array of 2 visual search queries if not KEEP\n'
            f"}}\n"
            f"Reject posters/DVD covers/title cards with the answer/title written visibly, collages, or wrong subjects."
        )

    def _finalize_verdict(
        self,
        raw: Dict[str, Any],
        item_ctx: Dict[str, Any],
        archetype_cfg: Dict[str, Any],
        tech_metrics: Dict[str, Any],
        used_model: str,
    ) -> Dict[str, Any]:
        """Apply deterministic anti-spoiler and threshold overrides to raw VLM JSON."""
        depicts = bool(raw.get("depicts_target", raw.get("ok", False)))
        guess = int(raw.get("guessability_1_5s", raw.get("guess", 0)) or 0)
        qual = int(raw.get("visual_quality", raw.get("qual", 7 if depicts else 3)) or 0)
        conf_raw = raw.get("match_confidence")
        if conf_raw is None:
            conf = 0.88 if depicts and guess >= 6 else (0.55 if depicts else 0.15)
        else:
            conf = float(conf_raw or 0.0)

        visible_text = raw.get("visible_text", raw.get("text")) or []
        has_spoiler_flag = bool(raw.get("spoiler", False))
        text_prom = str(
            raw.get("text_prominence")
            or ("prominent_overlay_or_title" if has_spoiler_flag else "none")
        )
        spoiler_res = evaluate_spoiler_text(
            visible_text=visible_text,
            text_prominence=text_prom,
            answer=item_ctx["answer"],
            aliases=item_ctx.get("aliases"),
            policy=str(archetype_cfg.get("spoilerPolicy", "strict_no_answer")),
        )
        if has_spoiler_flag and not spoiler_res["is_spoiler"]:
            spoiler_res = {**spoiler_res, "is_spoiler": True, "severity": "vlm_flagged_spoiler"}

        issues = list(raw.get("issues") or [])
        frame_type = str(raw.get("frame_type", raw.get("frame")) or ("live_photo" if depicts else "wrong_subject"))
        if spoiler_res["is_spoiler"] and spoiler_res["severity"] not in issues:
            issues.append(spoiler_res["severity"])
        if frame_type in ("poster_or_cover", "collage", "text_slide", "logo", "diagram", "wrong_subject"):
            if frame_type not in issues:
                issues.append(frame_type)

        min_guess = int(archetype_cfg.get("minGuessability", 7))
        min_qual = int(archetype_cfg.get("minVisualQuality", 6))
        min_conf = float(archetype_cfg.get("minMatchConfidence", 0.72))

        vlm_verdict = str(raw.get("verdict") or ("KEEP" if depicts and not has_spoiler_flag else "REJECT")).upper()
        is_red_carpet = bool(raw.get("is_generic_celebrity_portrait", False)) or frame_type == "red_carpet_or_press"
        arch_label = str(archetype_cfg.get("label") or "").lower()
        is_non_person_media = any(k in arch_label for k in ("movie", "video game", "animated"))

        if is_red_carpet and is_non_person_media and "red_carpet_not_movie" not in issues:
            issues.append("red_carpet_not_movie")

        if (
            not depicts
            or not tech_metrics.get("valid", False)
            or spoiler_res["is_spoiler"]
            or (is_red_carpet and is_non_person_media)
            or conf < 0.55
            or guess < max(4, min_guess - 2)
            or qual < 4
            or frame_type in ("wrong_subject", "text_slide", "collage")
        ):
            final_verdict = "REJECT"
        elif (
            vlm_verdict == "KEEP"
            and conf >= min_conf
            and guess >= min_guess
            and qual >= min_qual
            and frame_type not in ("poster_or_cover", "logo", "diagram")
        ):
            final_verdict = "KEEP"
        else:
            final_verdict = "UPGRADE_RECOMMENDED"

        composite = round(
            (conf * 35.0)
            + (guess * 4.0)
            + (qual * 2.0)
            + (tech_metrics.get("score", 50.0) * 0.15)
            - (45.0 if spoiler_res["is_spoiler"] else 0.0)
            - (25.0 if not tech_metrics.get("valid", True) else 0.0),
            2,
        )

        hints_raw = raw.get("visual_search_hints")
        if not hints_raw and raw.get("hint"):
            hints_raw = [raw.get("hint")]

        return {
            "verdict": final_verdict,
            "depicts_target": depicts,
            "match_confidence": round(conf, 3),
            "guessability_1_5s": guess,
            "visual_quality": qual,
            "frame_type": frame_type,
            "visible_text": list(visible_text)[:8],
            "text_prominence": text_prom,
            "spoiler": spoiler_res,
            "issues": issues,
            "visual_search_hints": [str(h) for h in (hints_raw or []) if h][:3],
            "composite_score": composite,
            "model": used_model,
        }

    def evaluate_single(
        self,
        item_ctx: Dict[str, Any],
        archetype_cfg: Dict[str, Any],
        image_bytes: bytes,
        tech_metrics: Dict[str, Any],
        max_edge: int = 320,
        allow_arbiter_escalation: bool = False,
    ) -> Dict[str, Any]:
        """Run Vision Critic + Deterministic Anti-Spoiler check on one image."""
        b64 = encode_image_for_vlm(image_bytes, max_edge=max_edge)
        prompt = self._build_single_prompt(item_ctx, archetype_cfg)
        raw = self._chat_json(self.scout_model, prompt, b64, num_predict=260, num_ctx=1280)

        conf = float(raw.get("match_confidence", 0.0) or 0.0)
        guess = int(raw.get("guessability_1_5s", 0) or 0)
        is_borderline = (
            allow_arbiter_escalation
            and self.arbiter_model
            and self.arbiter_model != self.scout_model
            and (not raw or (0.45 <= conf <= 0.78) or guess in (5, 6, 7))
        )
        used_model = self.scout_model
        if is_borderline:
            arb = self._chat_json(self.arbiter_model, prompt, b64, num_predict=260, num_ctx=1280)
            if arb:
                raw = arb
                used_model = self.arbiter_model

        return self._finalize_verdict(raw, item_ctx, archetype_cfg, tech_metrics, used_model)

    def evaluate_frontdoor_batch(
        self,
        batch_entries: List[Dict[str, Any]],
        archetype_cfg: Dict[str, Any],
    ) -> List[Dict[str, Any]]:
        """
        Evaluate 1..4 unrelated items together on a 2x2 labeled contact sheet in a single VLM call.
        Falls back to evaluate_single per entry if structured keys s1..sN are missing.
        """
        if not batch_entries:
            return []
        if len(batch_entries) == 1:
            e = batch_entries[0]
            return [
                self.evaluate_single(
                    item_ctx=e["item_ctx"],
                    archetype_cfg=archetype_cfg,
                    image_bytes=e["image_bytes"],
                    tech_metrics=e["tech_metrics"],
                )
            ]

        n = len(batch_entries)
        grid_bytes = build_labeled_grid([e["image_bytes"] for e in batch_entries], tile_size=240)
        b64 = base64.b64encode(grid_bytes).decode("ascii")

        cat_name = batch_entries[0]["item_ctx"].get("categoryName", "")
        rules = archetype_cfg.get("rules", "")
        target_lines = []
        schema_lines = []
        for idx, e in enumerate(batch_entries, start=1):
            ctx = e["item_ctx"]
            hint = ctx.get("englishTitle") or ""
            hint_str = f" (alt: {hint})" if hint and hint.lower() != ctx["answer"].lower() else ""
            target_lines.append(f'[{idx}] "{ctx["answer"]}"{hint_str}')
            schema_lines.append(
                f'  "s{idx}": {{"ok": true, "spoiler": false, "text": [], "guess": 8, "qual": 8}}'
            )

        prompt = (
            f"Trivia Photo Frontdoor. Category: \"{cat_name}\".\n"
            f"Rules: {rules}\n"
            f"Only reject actor red-carpet portraits if Target is a Movie/TV/Game TITLE — if Target is a person/actor/comedian/director, their portrait IS valid (ok=true).\n"
            f"Check numbered tiles [1]..[{n}]:\n"
            + "\n".join(target_lines)
            + "\nSet ok=true ONLY if tile depicts its target without title/answer text spoilers, movie posters, or collages.\n"
            + "Return ONLY JSON with keys "
            + ", ".join(f'"s{i}"' for i in range(1, n + 1))
            + ":\n{\n"
            + ",\n".join(schema_lines)
            + "\n}"
        )

        raw = self._chat_json(self.scout_model, prompt, b64, num_predict=320, num_ctx=1280)
        # Fallback if JSON missing expected slot keys
        if not isinstance(raw, dict) or not any(f"s{i}" in raw for i in range(1, n + 1)):
            return [
                self.evaluate_single(
                    item_ctx=e["item_ctx"],
                    archetype_cfg=archetype_cfg,
                    image_bytes=e["image_bytes"],
                    tech_metrics=e["tech_metrics"],
                )
                for e in batch_entries
            ]

        out: List[Dict[str, Any]] = []
        for idx, e in enumerate(batch_entries, start=1):
            slot_raw = raw.get(f"s{idx}")
            if not isinstance(slot_raw, dict):
                out.append(
                    self.evaluate_single(
                        item_ctx=e["item_ctx"],
                        archetype_cfg=archetype_cfg,
                        image_bytes=e["image_bytes"],
                        tech_metrics=e["tech_metrics"],
                    )
                )
            else:
                out.append(
                    self._finalize_verdict(
                        slot_raw,
                        e["item_ctx"],
                        archetype_cfg,
                        e["tech_metrics"],
                        self.scout_model,
                    )
                )
        return out

    def select_best_from_grid(
        self,
        item_ctx: Dict[str, Any],
        archetype_cfg: Dict[str, Any],
        candidate_bytes_list: List[bytes],
    ) -> Dict[str, Any]:
        """
        Inspect up to 4 candidate photos in one labeled contact sheet [1..4] using arbiter model,
        and rank clean winner + backups.
        """
        if not candidate_bytes_list:
            return {"winner_slot": 0, "approved_slots": [], "slots": []}

        grid_bytes = build_labeled_grid(candidate_images=candidate_bytes_list, tile_size=260)
        b64 = base64.b64encode(grid_bytes).decode("ascii")
        answer = item_ctx["answer"]
        aliases = item_ctx.get("aliases") or []
        cat_name = item_ctx.get("categoryName", "")
        rules = archetype_cfg.get("rules", "")

        prompt = (
            f"Select the BEST photo for a 1.5s trivia game.\n"
            f"Target: \"{answer}\" (Category: \"{cat_name}\", aliases: {aliases[:4]})\n"
            f"Rules: {rules}\n"
            f"Inspect slots [1]..[{len(candidate_bytes_list)}] in the grid. "
            f"Reject any poster/cover, title/answer text spoiler, collage, blurry pic, or wrong subject.\n"
            f"Return ONLY JSON:\n"
            f"{{\n"
            f'  "slots": [\n'
            f'    {{"slot": 1, "depicts_target": bool, "visible_text": [], "has_spoiler_text": bool, "guessability_1_5s": 1-10, "visual_quality": 1-10}}\n'
            f"  ],\n"
            f'  "winner_slot": integer (1..{len(candidate_bytes_list)}, or 0 if NONE are acceptable),\n'
            f'  "approved_slots": array of integers (best to worst)\n'
            f"}}"
        )

        selector_model = self.arbiter_model or self.scout_model
        raw = self._chat_json(selector_model, prompt, b64, num_predict=360, num_ctx=1408)
        slots = raw.get("slots") or []

        approved: List[int] = []
        for s in raw.get("approved_slots") or []:
            if isinstance(s, int) and 1 <= s <= len(candidate_bytes_list):
                slot_meta = next((x for x in slots if x.get("slot") == s), {})
                sp = evaluate_spoiler_text(
                    visible_text=slot_meta.get("visible_text") or [],
                    text_prominence="prominent_overlay_or_title" if slot_meta.get("has_spoiler_text") else "none",
                    answer=answer,
                    aliases=aliases,
                    policy=str(archetype_cfg.get("spoilerPolicy", "strict_no_answer")),
                )
                if (
                    slot_meta.get("depicts_target", True)
                    and not slot_meta.get("has_spoiler_text", False)
                    and not sp["is_spoiler"]
                    and int(slot_meta.get("guessability_1_5s", 7)) >= 6
                ):
                    approved.append(s)

        winner = int(raw.get("winner_slot") or 0)
        if winner not in approved:
            winner = approved[0] if approved else 0

        return {
            "winner_slot": winner,
            "approved_slots": approved,
            "slots": slots,
            "model": selector_model,
        }
