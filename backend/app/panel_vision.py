"""Panel photo soiling check with OpenCV (prototype of a fixed plant camera).

A real plant would have a fixed camera photographing the same panels every day and comparing each capture with a
"clean reference" taken right after cleaning. Here an uploaded photo simulates a capture.

Per photo
  1. panel area   – dark photovoltaic cells (+ dirt lying on them); sky, frames, ground excluded
  2. grid lines   – thin bright lines between cells (busbars/gaps) are removed, they are not dirt
  3. dirt pixels  – compared with the panel's own clean-cell colour (darkest quarter of the panel):
                    dust/sand = lighter AND yellower/browner; droppings = much lighter, low colour (white blobs)
  4. soiled area % = dirt pixels ÷ panel pixels, severity, rough power-loss estimate, red overlay
With a reference
  * same camera position (features match → homography): photos are aligned and only NEW dirt is counted
  * otherwise: soiled area % of both photos are compared (soiled − reference)
"""
from __future__ import annotations

import base64

import cv2
import numpy as np

MAX_SIDE = 1024
SEVERITY = [(6, "clean"), (12, "light"), (25, "moderate"), (101, "heavy")]   # soiled % limits
DENSITY = 0.5                # panel = at least 50 % dark/blue cell pixels nearby
DUST_L, DUST_B = 14, 4       # dust: this much lighter (L*) and yellower (b*) than the clean cells
FILM_PER_B = 1.5             # dust film: every +1 of yellow-brown shift (b*) ≈ 1.5 % soiled-equivalent
CLEAN_B = 112                # typical b* of clean blue/black cells (no reference available)
LOSS_PER_AREA = 0.6          # assumption: ≈ 0.6 % power loss per 1 % of area soiled (partly translucent dust)


class PhotoError(ValueError):
    """Shown to the user (bad or unusable image)."""


def decode(data: bytes) -> np.ndarray:
    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)   # applies EXIF rotation
    if img is None:
        raise PhotoError("The file is not a readable image (use JPG or PNG).")
    h, w = img.shape[:2]
    if min(h, w) < 120:
        raise PhotoError("The image is too small to analyse.")
    scale = MAX_SIDE / max(h, w)
    if scale < 1:
        img = cv2.resize(img, (round(w * scale), round(h * scale)), interpolation=cv2.INTER_AREA)
    return img


def _odd(n: float) -> int:
    n = max(3, int(n))
    return n if n % 2 else n + 1


def panel_mask(img: np.ndarray) -> np.ndarray:
    """Pixels that belong to the panel surface (cells, including dirt lying on them).
    A pixel is "panel" when many pixels around it are dark/blue PV cells. Dusty cells still have dark cell surface
    around the dust; sky, white frames and sand/ground do not."""
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    h, s, v = cv2.split(hsv)
    size = max(img.shape[:2])
    otsu, _ = cv2.threshold(v, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    dark = v <= min(otsu, 130)
    blue = (h >= 95) & (h <= 135) & (s >= 60) & (v <= 170)
    cells = (dark | blue).astype(np.float32)
    win = _odd(size / 12)
    density = cv2.blur(cells, (win, win))                       # share of cell pixels in the neighbourhood
    mask = (density >= DENSITY).astype(np.uint8) * 255
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (_odd(size / 30),) * 2))
    n, labels, stats, _ = cv2.connectedComponentsWithStats(mask)
    area = img.shape[0] * img.shape[1]
    keep = [i for i in range(1, n) if stats[i, cv2.CC_STAT_AREA] >= 0.05 * area]
    if not keep:
        raise PhotoError("No solar panel surface found in the photo – take it closer and in daylight.")
    mask = np.isin(labels, keep).astype(np.uint8) * 255
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    filled = np.zeros_like(mask)
    cv2.drawContours(filled, contours, -1, 255, thickness=cv2.FILLED)   # holes = heavy dirt patches → keep
    sky = (h >= 90) & (h <= 135) & (s >= 40) & (v >= 190)
    filled[sky] = 0
    return cv2.erode(filled, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (_odd(size / 60),) * 2))


def grid_lines(img: np.ndarray, panel: np.ndarray) -> np.ndarray:
    """Thin bright lines (cell gaps, busbars, glare streaks)."""
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    size = max(img.shape[:2])
    lines = np.zeros_like(gray)
    for kshape in [(_odd(size / 25), 1), (1, _odd(size / 25))]:              # long thin horizontal / vertical
        k = cv2.getStructuringElement(cv2.MORPH_RECT, kshape)
        opened = cv2.morphologyEx(gray, cv2.MORPH_OPEN, k)                     # bright things longer than k
        tophat = cv2.morphologyEx(opened, cv2.MORPH_TOPHAT,
                                  cv2.getStructuringElement(cv2.MORPH_RECT, (_odd(size / 60),) * 2))
        lines |= (tophat > 25).astype(np.uint8) * 255
    # diagonal lines in perspective photos: thin bright structures via a small white top-hat + thinness test
    small = cv2.morphologyEx(gray, cv2.MORPH_TOPHAT, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (_odd(size / 150),) * 2))
    thin = (small > 30).astype(np.uint8) * 255
    n, labels, stats, _ = cv2.connectedComponentsWithStats(thin)
    elongated = np.zeros(n, bool)
    for i in range(1, n):
        w, h, a = stats[i, cv2.CC_STAT_WIDTH], stats[i, cv2.CC_STAT_HEIGHT], stats[i, cv2.CC_STAT_AREA]
        elongated[i] = max(w, h) >= size / 15 and a <= 0.35 * w * h            # long and sparse = a line
    lines |= elongated[labels].astype(np.uint8) * 255
    return cv2.dilate(lines, np.ones((3, 3), np.uint8)) & panel


def dirt_mask(img: np.ndarray, panel: np.ndarray, lines: np.ndarray) -> np.ndarray:
    lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB).astype(np.int16)
    L, _, b = lab[..., 0], lab[..., 1], lab[..., 2]
    area = (panel > 0) & (lines == 0)
    if area.sum() < 500:
        raise PhotoError("The panel area is too small in this photo – take it closer.")
    # clean-cell colour: the darkest quarter of the panel (dirt only makes cells lighter)
    l_ref = np.percentile(L[area], 25)
    b_ref = np.median(b[area & (L <= l_ref)])
    sat = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)[..., 1].astype(np.int16)
    dust = (L - l_ref > DUST_L) & (b - b_ref > DUST_B)         # lighter and yellower/browner
    white = (L - l_ref > 70) & (sat < 60)                      # droppings, thick dust
    m = ((dust | white) & area).astype(np.uint8) * 255
    return cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))


def _severity(pct: float) -> str:
    return next(name for limit, name in SEVERITY if pct < limit)


def _overlay(img: np.ndarray, panel: np.ndarray, dirt: np.ndarray, new: np.ndarray | None = None) -> str:
    out = img.copy()
    red = np.zeros_like(out)
    red[..., 2] = 255
    m = dirt > 0
    out[m] = cv2.addWeighted(out, 0.35, red, 0.65, 0)[m]
    if new is not None:                                         # newly appeared dirt in orange
        orange = np.zeros_like(out)
        orange[..., 1], orange[..., 2] = 140, 255
        n = new > 0
        out[n] = cv2.addWeighted(img, 0.3, orange, 0.7, 0)[n]
    contours, _ = cv2.findContours(panel, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    cv2.drawContours(out, contours, -1, (80, 200, 60), max(2, max(img.shape[:2]) // 400))
    ok, buf = cv2.imencode(".jpg", out, [cv2.IMWRITE_JPEG_QUALITY, 82])
    return base64.b64encode(buf.tobytes()).decode()


def analyse_image(img: np.ndarray) -> dict:
    panel = panel_mask(img)
    lines = grid_lines(img, panel)
    dirt = dirt_mask(img, panel, lines)
    surface_mask = (panel > 0) & (lines == 0)
    pct = 100 * float((dirt > 0).sum()) / int(surface_mask.sum())
    b = cv2.cvtColor(img, cv2.COLOR_BGR2LAB)[..., 2]
    return {"panel": panel, "lines": lines, "dirt": dirt, "soiled_pct": pct, "median_b": float(np.median(b[surface_mask])),
            "panel_share_pct": 100 * float((panel > 0).sum()) / panel.size}


def _align(ref: np.ndarray, img: np.ndarray) -> tuple[np.ndarray | None, int]:
    """Homography mapping `img` onto `ref` if both show the same scene (fixed camera)."""
    sift = cv2.SIFT_create(4000)
    g1, g2 = cv2.cvtColor(ref, cv2.COLOR_BGR2GRAY), cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    k1, d1 = sift.detectAndCompute(g1, None)
    k2, d2 = sift.detectAndCompute(g2, None)
    if d1 is None or d2 is None or len(k1) < 50 or len(k2) < 50:
        return None, 0
    matches = cv2.BFMatcher().knnMatch(d2, d1, k=2)
    good = [m for m, n in (p for p in matches if len(p) == 2) if m.distance < 0.75 * n.distance]
    if len(good) < 30:
        return None, len(good)
    src = np.float32([k2[m.queryIdx].pt for m in good]).reshape(-1, 1, 2)
    dst = np.float32([k1[m.trainIdx].pt for m in good]).reshape(-1, 1, 2)
    H, inl = cv2.findHomography(src, dst, cv2.RANSAC, 5.0)
    inliers = int(inl.sum()) if inl is not None else 0
    if H is None or inliers < 40 or inliers < 0.25 * len(good):
        return None, inliers
    # reject wild warps (a real fixed camera moves only slightly)
    corners = np.float32([[0, 0], [img.shape[1], 0], [img.shape[1], img.shape[0]], [0, img.shape[0]]]).reshape(-1, 1, 2)
    warped = cv2.perspectiveTransform(corners, H).reshape(-1, 2)
    area = cv2.contourArea(warped)
    if not (0.5 < area / (ref.shape[0] * ref.shape[1]) < 2.0):
        return None, inliers
    return H, inliers


def analyse(data: bytes, reference: bytes | None = None) -> dict:
    """Analyse a capture (optionally against a clean reference). Returns scores + overlay (base64 JPEG)."""
    img = decode(data)
    cur = analyse_image(img)
    result = {"raw_soiled_pct": round(cur["soiled_pct"], 1), "panel_share_pct": round(cur["panel_share_pct"], 1),
              "method": "single photo", "aligned": False}
    new_mask = None
    soiled = cur["soiled_pct"]
    film = max(0.0, (cur["median_b"] - CLEAN_B) * FILM_PER_B)            # uniform dust film (colour shift)
    if reference is not None:
        ref_img = decode(reference)
        ref = analyse_image(ref_img)
        result["reference_soiled_pct"] = round(ref["soiled_pct"], 1)
        film = max(0.0, (cur["median_b"] - ref["median_b"]) * FILM_PER_B)   # colour shift vs the clean reference
        result["colour_shift"] = round(cur["median_b"] - ref["median_b"], 1)
        H, inliers = _align(ref_img, img)
        result["match_points"] = inliers
        if H is not None:
            # same camera view: dirt in the capture that was NOT dirt in the reference
            h, w = ref_img.shape[:2]
            hi = np.linalg.inv(H)
            ref_dirt_on_img = cv2.warpPerspective(ref["dirt"], hi, (img.shape[1], img.shape[0]))
            ref_panel_on_img = cv2.warpPerspective(ref["panel"], hi, (img.shape[1], img.shape[0]))
            common = (cur["panel"] > 0) & (ref_panel_on_img > 0) & (cur["lines"] == 0)
            if common.sum() > 0.3 * (cur["panel"] > 0).sum():
                new = (cur["dirt"] > 0) & (cv2.dilate(ref_dirt_on_img, np.ones((5, 5), np.uint8)) == 0) & common
                new_mask = new.astype(np.uint8) * 255
                soiled = 100 * float(new.sum()) / float(common.sum())
                result.update(method="aligned comparison (same camera view)", aligned=True)
        if not result["aligned"]:
            soiled = max(0.0, cur["soiled_pct"] - ref["soiled_pct"])
            result["method"] = "compared with reference statistics (different view)"
    result["spots_pct"] = round(soiled, 1)                          # dirt spots/patches (area)
    result["film_pct"] = round(min(60.0, film), 1)                   # dust film (colour)
    soiled = max(soiled, min(60.0, film))
    result["soiled_pct"] = round(soiled, 1)
    result["severity"] = _severity(soiled)
    result["est_loss_pct"] = round(min(30.0, soiled * LOSS_PER_AREA), 1)
    result["overlay_jpeg_b64"] = _overlay(img, cur["panel"], cur["dirt"], new_mask)
    return result
