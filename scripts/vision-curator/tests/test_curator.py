"""Unit tests for Yappik AI Vision & Pixel Curation pipeline modules."""

from __future__ import annotations

import io
import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image, ImageDraw

CURATOR_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(CURATOR_DIR))

from pixel_metrics import analyze_image_pixels, upgrade_wikimedia_thumb_url
from spoiler_matcher import evaluate_spoiler_text
from vision_judge import ItemCheckpointCache, VerdictCache, build_labeled_grid


def _to_jpeg_bytes(im: Image.Image) -> bytes:
    buf = io.BytesIO()
    im.save(buf, format="JPEG", quality=90)
    return buf.getvalue()


def _to_png_bytes(im: Image.Image) -> bytes:
    buf = io.BytesIO()
    im.save(buf, format="PNG")
    return buf.getvalue()


DEFAULT_THRESH = {
    "minWidth": 480,
    "minHeight": 360,
    "minContentWidth": 260,
    "minContentHeight": 220,
    "minContentRatio": 0.28,
    "minAspectRatio": 0.56,
    "maxAspectRatio": 1.95,
    "minSharpness": 4.2,
    "minLumaStd": 14.0,
    "maxClipRatio": 0.65,
}


class PixelMetricsTests(unittest.TestCase):
    def test_upgrades_low_res_wikimedia_thumb_url(self) -> None:
        small = "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Sample.jpg/220px-Sample.jpg"
        self.assertEqual(
            upgrade_wikimedia_thumb_url(small, 960),
            "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Sample.jpg/960px-Sample.jpg",
        )
        already = "https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/Sample.jpg/1280px-Sample.jpg"
        self.assertEqual(upgrade_wikimedia_thumb_url(already, 960), already)

    def test_rejects_tiny_subject_inside_huge_white_padding(self) -> None:
        im = Image.new("RGB", (900, 700), (255, 255, 255))
        draw = ImageDraw.Draw(im)
        # Small 140x140 icon in center (< 5% of frame area)
        for y in range(280, 420, 10):
            draw.rectangle((380, y, 520, y + 5), fill=(30, 60, 200))
        res = analyze_image_pixels(_to_png_bytes(im), DEFAULT_THRESH)
        self.assertFalse(res["valid"])
        self.assertTrue(any("padding" in r or "tiny_subject" in r for r in res["fail_reasons"]))

    def test_rejects_flat_blurry_frame(self) -> None:
        im = Image.new("RGB", (800, 600), (120, 125, 130))
        res = analyze_image_pixels(_to_jpeg_bytes(im), DEFAULT_THRESH)
        self.assertFalse(res["valid"])
        self.assertTrue(any("flat_low_contrast" in r or "blurry" in r for r in res["fail_reasons"]))

    def test_approves_crisp_textured_high_res_scene(self) -> None:
        im = Image.new("RGB", (960, 640), (24, 32, 48))
        draw = ImageDraw.Draw(im)
        for x in range(20, 940, 28):
            for y in range(20, 620, 28):
                color = ((x * 3) % 255, (y * 5) % 255, ((x + y) * 2) % 255)
                draw.rectangle((x, y, x + 20, y + 20), fill=color, outline=(255, 240, 200))
        res = analyze_image_pixels(_to_jpeg_bytes(im), DEFAULT_THRESH)
        self.assertTrue(res["valid"], msg=f"Unexpected fail: {res['fail_reasons']}")
        self.assertGreaterEqual(res["score"], 60.0)

    def test_rejects_split_panel_collage(self) -> None:
        im = Image.new("RGB", (800, 600), (40, 100, 180))
        draw = ImageDraw.Draw(im)
        # Rich texture left and right separated by razor-sharp white vertical midline divider
        for x in range(10, 392, 24):
            for y in range(10, 590, 24):
                draw.rectangle((x, y, x + 16, y + 16), fill=(x % 255, y % 255, 80))
        for x in range(408, 790, 24):
            for y in range(10, 590, 24):
                draw.rectangle((x, y, x + 16, y + 16), fill=(200, (x + y) % 255, 40))
        draw.rectangle((396, 0, 404, 600), fill=(255, 255, 255))
        res = analyze_image_pixels(_to_jpeg_bytes(im), DEFAULT_THRESH)
        self.assertFalse(res["valid"])
        self.assertTrue(any("collage_split_seam" in r for r in res["fail_reasons"]))


class SpoilerMatcherTests(unittest.TestCase):
    def test_catches_exact_and_fuzzy_answer_leaks(self) -> None:
        r1 = evaluate_spoiler_text(["GHOSTBUSTERS"], "prominent_overlay_or_title", "Ghostbusters", [])
        self.assertTrue(r1["is_spoiler"])

        # Partial OCR typo ("STRANGER THING") still caught via fuzzy phrase match
        r2 = evaluate_spoiler_text(["STRANGER THING"], "prominent_overlay_or_title", "Stranger Things", [])
        self.assertTrue(r2["is_spoiler"])

        # Spaced/compact packaging logo ("N U T E L L A")
        r3 = evaluate_spoiler_text(["N U T E L L A", "FERRERO"], "prominent_overlay_or_title", "Nutella", [])
        self.assertTrue(r3["is_spoiler"])

    def test_allows_minor_non_answer_background_text(self) -> None:
        r = evaluate_spoiler_text(["RAKUTEN", "10"], "minor_background", "Lionel Messi", ["Leo Messi"])
        self.assertFalse(r["is_spoiler"])
        self.assertEqual(r["severity"], "minor_background")


class GridAndCacheTests(unittest.TestCase):
    def test_builds_grid_and_persists_verdict_cache(self) -> None:
        imgs = [
            _to_jpeg_bytes(Image.new("RGB", (400, 300), (255, 0, 0))),
            _to_jpeg_bytes(Image.new("RGB", (400, 300), (0, 255, 0))),
            _to_jpeg_bytes(Image.new("RGB", (400, 300), (0, 0, 255))),
        ]
        grid_bytes = build_labeled_grid(imgs, tile_size=300)
        with Image.open(io.BytesIO(grid_bytes)) as g:
            self.assertGreaterEqual(g.width, 600)
            self.assertGreaterEqual(g.height, 600)

        with tempfile.TemporaryDirectory() as tmp:
            cache_file = Path(tmp) / "verdicts.json"
            c1 = VerdictCache(cache_file, "v1")
            c1.put("cinema-cult-1", "https://example.org/a.jpg?width=100", {"verdict": "KEEP", "guessability_1_5s": 9})
            c1.flush()
            c2 = VerdictCache(cache_file, "v1")
            hit = c2.get("cinema-cult-1", "https://example.org/a.jpg")
            self.assertIsNotNone(hit)
            self.assertEqual(hit["verdict"], "KEEP")

            # Item-level checkpoint skips matching URLs unless higher level or changed URL
            cp_file = Path(tmp) / "checkpoints.json"
            ic1 = ItemCheckpointCache(cp_file, "v2")
            ic1.mark_done(
                "cinema-cult-1",
                "https://example.org/a.jpg",
                ["https://example.org/b.jpg"],
                ItemCheckpointCache.LEVEL_REPAIR,
                "KEPT",
                {"finalStatus": "KEPT"},
            )
            ic1.flush()

            ic2 = ItemCheckpointCache(cp_file, "v2")
            self.assertIsNotNone(
                ic2.should_skip("cinema-cult-1", "https://example.org/a.jpg", ["https://example.org/b.jpg"], ItemCheckpointCache.LEVEL_REPAIR)
            )
            # Must NOT skip when escalating to higher level (FULL_VISION) or when URL changed
            self.assertIsNone(
                ic2.should_skip("cinema-cult-1", "https://example.org/a.jpg", ["https://example.org/b.jpg"], ItemCheckpointCache.LEVEL_FULL_VISION)
            )
            self.assertIsNone(
                ic2.should_skip("cinema-cult-1", "https://example.org/NEW.jpg", ["https://example.org/b.jpg"], ItemCheckpointCache.LEVEL_REPAIR)
            )


if __name__ == "__main__":
    unittest.main()
