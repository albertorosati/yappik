"""Deterministic anti-spoiler matcher for text detected inside candidate images."""

from __future__ import annotations

import re
import unicodedata
from difflib import SequenceMatcher
from typing import Iterable, List, Dict, Any


STOPWORDS = {
    "the", "and", "for", "with", "from", "into", "that", "this", "of", "in", "on", "at", "to",
    "il", "lo", "la", "i", "gli", "le", "un", "uno", "una", "del", "dello", "della", "dei",
    "degli", "delle", "di", "da", "con", "su", "per", "tra", "fra", "che", "san", "santa",
    "film", "movie", "series", "show", "game", "edition", "part", "season", "episode",
}


def normalize_text(raw: str) -> str:
    """Fold accents, lowercase, strip punctuation while keeping alphanumeric spaces."""
    if not raw:
        return ""
    # Replace common leet/OCR confusables inside words when clearly alphanumeric
    decomposed = unicodedata.normalize("NFD", raw)
    stripped = "".join(ch for ch in decomposed if unicodedata.category(ch) != "Mn")
    lowered = stripped.lower()
    cleaned = re.sub(r"[^a-z0-9\s]", " ", lowered)
    return re.sub(r"\s+", " ", cleaned).strip()


def normalize_compact(raw: str) -> str:
    """Alphanumeric compact form without whitespace to catch spaced/joined logos (e.g. 'CO CA COLA')."""
    return re.sub(r"\s+", "", normalize_text(raw))


def build_sensitive_targets(answer: str, aliases: Iterable[str] | None = None) -> Dict[str, Any]:
    """Extract normalized full targets and distinctive single tokens (>= 4 chars)."""
    full_phrases: List[str] = []
    tokens: List[str] = []

    raw_phrases = [answer] + list(aliases or [])
    for phrase in raw_phrases:
        norm = normalize_text(str(phrase))
        if len(norm) >= 3 and norm not in full_phrases:
            full_phrases.append(norm)
        for tok in norm.split():
            # Skip generic stopwords or pure short roman/arabic numbers
            if len(tok) >= 4 and tok not in STOPWORDS and not tok.isdigit():
                if tok not in tokens:
                    tokens.append(tok)

    return {
        "phrases": full_phrases,
        "compact_phrases": [p.replace(" ", "") for p in full_phrases if len(p.replace(" ", "")) >= 4],
        "tokens": tokens,
    }


def _fuzzy_contains(haystack_words: List[str], target_token: str) -> bool:
    """Check exact or high-similarity fuzzy match (tolerating 1-2 OCR typos)."""
    if len(target_token) < 4:
        return False
    min_ratio = 0.84 if len(target_token) <= 5 else 0.80
    for word in haystack_words:
        if len(word) < 4:
            continue
        if target_token in word or word in target_token:
            if min(len(word), len(target_token)) >= 4 and abs(len(word) - len(target_token)) <= 3:
                return True
        if SequenceMatcher(None, word, target_token).ratio() >= min_ratio:
            return True
    return False


def evaluate_spoiler_text(
    visible_text: Iterable[str] | str | None,
    text_prominence: str,
    answer: str,
    aliases: Iterable[str] | None = None,
    policy: str = "strict_no_answer",
) -> Dict[str, Any]:
    """
    Compare visible image text extracted by Vision/OCR against answer + aliases + distinctive tokens.

    Returns:
      {
        "is_spoiler": bool,
        "severity": "none" | "minor_background" | "critical_answer_leak" | "prominent_title_leak",
        "matched_targets": [...],
        "normalized_visible": "..."
      }
    """
    if isinstance(visible_text, str):
        joined = visible_text
    elif visible_text:
        joined = " ".join(str(t) for t in visible_text if t)
    else:
        joined = ""

    norm_visible = normalize_text(joined)
    compact_visible = norm_visible.replace(" ", "")
    if not norm_visible:
        return {
            "is_spoiler": False,
            "severity": "none",
            "matched_targets": [],
            "normalized_visible": "",
        }

    targets = build_sensitive_targets(answer, aliases)
    matched: List[str] = []

    # 1. Exact/compact phrase match (handles split logos or missing spaces)
    for phrase, compact_phrase in zip(targets["phrases"], targets["compact_phrases"]):
        if phrase in norm_visible or compact_phrase in compact_visible:
            matched.append(phrase)

    # 2. Sliding window fuzzy phrase check on OCR fragments
    visible_words = norm_visible.split()
    for phrase in targets["phrases"]:
        p_words = phrase.split()
        if len(p_words) >= 2 and len(visible_words) >= len(p_words):
            for i in range(len(visible_words) - len(p_words) + 1):
                window = " ".join(visible_words[i : i + len(p_words)])
                if SequenceMatcher(None, window, phrase).ratio() >= 0.80:
                    if phrase not in matched:
                        matched.append(phrase)

    # 3. Single distinctive token leak (>= 4 chars non-stopword)
    for tok in targets["tokens"]:
        if _fuzzy_contains(visible_words, tok):
            if tok not in matched:
                matched.append(tok)

    if matched:
        return {
            "is_spoiler": True,
            "severity": "critical_answer_leak",
            "matched_targets": matched,
            "normalized_visible": norm_visible,
        }

    # Even if OCR partially garbled the name, prominent overlaid title graphics in strict mode fail
    if policy == "strict_no_answer" and text_prominence == "prominent_overlay_or_title" and len(compact_visible) >= 4:
        return {
            "is_spoiler": True,
            "severity": "prominent_title_leak",
            "matched_targets": [],
            "normalized_visible": norm_visible,
        }

    return {
        "is_spoiler": False,
        "severity": "minor_background" if norm_visible else "none",
        "matched_targets": [],
        "normalized_visible": norm_visible,
    }
