"""Panel photo soiling check on the sample photo pairs (clean / dirty). Run with pytest."""
from pathlib import Path

import pytest

from app import panel_vision as pv

SAMPLES = Path(__file__).resolve().parents[2] / "frontend" / "public" / "samples" / "panels"
PAIRS = "abcde"


def photo(pair, kind):
    return (SAMPLES / f"pair_{pair}_{kind}.jpg").read_bytes()


@pytest.mark.parametrize("pair", PAIRS)
def test_dirty_photo_scores_much_higher_than_clean(pair):
    clean, dirty = pv.analyse(photo(pair, "clean")), pv.analyse(photo(pair, "dirty"))
    assert dirty["soiled_pct"] >= clean["soiled_pct"] + 10
    assert clean["severity"] in ("clean", "light") and dirty["severity"] in ("moderate", "heavy")


@pytest.mark.parametrize("pair", PAIRS)
def test_comparison_with_the_clean_reference(pair):
    r = pv.analyse(photo(pair, "dirty"), photo(pair, "clean"))
    assert r["soiled_pct"] >= 20 and "reference_soiled_pct" in r and r["overlay_jpeg_b64"]
    same = pv.analyse(photo(pair, "clean"), photo(pair, "clean"))   # a fixed camera seeing no change
    assert same["aligned"] and same["soiled_pct"] < 3


def test_unreadable_file_is_rejected():
    with pytest.raises(pv.PhotoError):
        pv.analyse(b"not an image")
