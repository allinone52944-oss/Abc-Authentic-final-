# -*- coding: utf-8 -*-
"""Smart-card (v2) shared helpers — font resolution, asset/work paths,
authority-signature lookup.

This module is the v2 renderer's helper library ONLY. It contains NO
card-building logic and NO old-template (v1) path: the old
TEMPLATE_GROUND_TRUTH / is_template_data / _build_card /
_validate_output code was deliberately NOT ported (smart-card fix #7 —
no hardcoded sample-person comparison anywhere in this engine).
The v2 renderer lives in build_output_v2.py and imports from here.
"""
import sys
import os
import re

if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

import pymupdf
from PIL import Image, ImageDraw, ImageFont, features

# Raqm (Bengali shaping) na thakle BASIC layout-e fallback — crash NA.
# (Sothik shaping-er jonno libraqm-soho Pillow install koro.)
# NOTE goes to stderr so stdout stays clean for the adapter's JSON.
RAQM_OK = features.check("raqm")
if not RAQM_OK:
    print("NOTE: Raqm missing — Bangla NATIVE vector fallback-e cholbe (shaping thik, PNG path off).",
          file=sys.stderr)

SCALE = 8  # 576 DPI for ultra-sharp, anti-aliased font rendering

FONT_BN = "fonts/Bangla.ttf"
FONT_LAT = "fonts/ArialMT.ttf"
FONT_FALLBACK = "fonts/TiroBangla-Regular.ttf"

# ---- ShebaHub serverless adaptation: configurable asset/work dirs ----
_HERE = os.path.dirname(os.path.abspath(__file__))
# auto-detect layout: kit (assets/fonts) vs live flat (fonts/ next to file)
_ASSETS_DIR = (os.path.join(_HERE, "assets")
               if os.path.isdir(os.path.join(_HERE, "assets", "fonts"))
               else _HERE)
_WORK_DIR = "work"
_FONT_INDEX = None


def _scan_fonts():
    """Ekbar scan all font dirs -> {lower_stem: path}. ANY font name match."""
    global _FONT_INDEX
    if _FONT_INDEX is not None:
        return _FONT_INDEX
    idx = {}
    for d in (os.path.join(_ASSETS_DIR, "fonts"), _HERE,
              os.path.join(_HERE, "fonts")):
        if not os.path.isdir(d):
            continue
        try:
            for fn in os.listdir(d):
                low = fn.lower()
                if low.endswith((".ttf", ".ttc", ".otf")):
                    stem = os.path.splitext(fn)[0].lower()
                    idx.setdefault(stem, os.path.join(d, fn))
        except OSError:
            pass
    _FONT_INDEX = idx
    return idx


def _resolve_font(pref):
    """Template font ref (relative 'fonts/X.ttf' / absolute / bare name /
    subset 'ABCDEF+Nirmala-Bold') -> real file path or None."""
    if not pref:
        return None
    p = str(pref).strip()
    if not p:
        return None
    # absolute existing
    if os.path.isabs(p) and os.path.exists(p):
        return p
    # relative to assets or file dir
    for base in (_ASSETS_DIR, _HERE):
        c = os.path.join(base, p.replace("/", os.sep))
        if os.path.exists(c):
            return c
        c2 = os.path.join(base, os.path.basename(p))
        if os.path.exists(c2):
            return c2
    # bare/stem name -> index scan
    raw = p.split(",")[0].strip()
    if "+" in raw:
        raw = raw.split("+", 1)[1]
    stem = os.path.splitext(os.path.basename(raw))[0].split("-")[0].strip().lower()
    idx = _scan_fonts()
    if stem in idx:
        return idx[stem]
    for k, v in idx.items():
        if stem and len(stem) >= 3 and (k.startswith(stem) or stem.startswith(k)
                                        or stem in k or k in stem):
            return v
    return None


def configure(assets_dir=None, work_dir=None):
    """Override asset/work dirs. Serverless: assets=bundled, work=/tmp/xxx."""
    global _ASSETS_DIR, _WORK_DIR, FONT_BN, FONT_LAT, FONT_FALLBACK, _FONT_INDEX
    if assets_dir:
        _ASSETS_DIR = assets_dir
    if work_dir:
        _WORK_DIR = work_dir
    _FONT_INDEX = None  # rescan on reconfigure
    FONT_BN = os.path.join(_ASSETS_DIR, "fonts", "Bangla.ttf")
    FONT_LAT = os.path.join(_ASSETS_DIR, "fonts", "ArialMT.ttf")
    FONT_FALLBACK = os.path.join(_ASSETS_DIR, "fonts", "TiroBangla-Regular.ttf")
    # bundled missing -> best available (permanent fallback, crash NA)
    if not os.path.exists(FONT_BN):
        FONT_BN = _resolve_font("Bangla") or FONT_BN
    if not os.path.exists(FONT_LAT):
        FONT_LAT = _resolve_font("ArialMT") or FONT_LAT
    if not os.path.exists(FONT_FALLBACK):
        FONT_FALLBACK = _resolve_font("TiroBangla") or FONT_FALLBACK


def _w(*parts):
    return os.path.join(_WORK_DIR, *parts)


def _a(*parts):
    return os.path.join(_ASSETS_DIR, *parts)


def _has_bengali(txt):
    return any(0x0980 <= ord(ch) <= 0x09FF for ch in txt)


def _font_for(txt, preferred_font=None):
    """Font fallback chain (permanent, font-agnostic):
    preferred (resolve ANY name/path) -> BN/LAT default -> TiroBangla.
    Sob missing hole CLEAR error (cryptic crash NA)."""
    cands = []
    if preferred_font:
        r = _resolve_font(preferred_font)
        if r:
            cands.append(r)
        cands.append(preferred_font)  # raw path (exists-check nibe)
    cands.append(FONT_BN if _has_bengali(txt) else FONT_LAT)
    cands.append(FONT_FALLBACK)
    for p in cands:
        if p and os.path.exists(str(p)):
            return str(p)
    raise FileNotFoundError("font paini, sob fallback fail: "
                            + ", ".join([str(c) for c in cands]))


def find_issue_authority_sign():
    """Authority signature (shakkhor/ folder) — the issuing authority's
    signature, NOT the applicant's. Returns the first PNG or None."""
    d = os.path.join(_ASSETS_DIR, "shakkhor")
    if os.path.isdir(d):
        for fn in sorted(os.listdir(d)):
            if fn.lower().endswith(".png"):
                p = os.path.join(d, fn)
                if os.path.isfile(p):
                    return p
    return None


configure()
