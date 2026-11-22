# -*- coding: utf-8 -*-
"""
ব্যবহার: python extract_input.py input.pdf

NID ফর্ম (input.pdf) থেকে নাম-ধরা ফিল্ডগুলো পড়ে work/input_data.json-এ রাখে,
ছবি (ফটো/সই) আলাদা করে work/images/ ফোল্ডারে সেভ করে।
Present Address টেবিল থেকে ঠিকানার অংশগুলো আলাদা করে পড়ে
(data["Present Address"] ডিকশনারি হিসেবে)।
"""
import sys
import os
import re
import json
import difflib
import unicodedata

from review_addresses import review_addresses

if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

try:
    import pymupdf
except ImportError:
    import fitz as pymupdf


# --- Phantom-sign detector (permanent) --------------------------------------
# NID site-er PDF-e generator /Span <<ActualText>> diye Unicode dey, kintu
# glyph paint-e kichu combining-sign (া/ে/ু...) ANPLOT hoy (font-GSUB er
# phantom). Extraction-e oi char ASHE, card-e dile NAME GARBAGE dekhabe.
# Fix: value-er ink-width (paint-sotto) compare koro — kono ek ekta sign
# char bad dile width melbe, oitai real string.
_BN_COMB = set("ািীুূৃৄেৈোৌঁংঃਁ")
_DOC = None          # extract()-er dokan e active doc
_FONT_CACHE = {}
_MEAS_DOC = None
_FONT_INDEX = None   # {lower_stem: path} — scan once, reuse

# Known Bangla-capable font stems (input ja dao — match + fallback)
_KNOWN_BN = ("nirmala", "solaiman", "kalpurush", "nikosh", "hind",
             "baloo", "mina", "tiro", "bangla", "bengali", "likhan",
             "siyam", "rupali", "adwaita", "galada", "mitra", "lklug")


def _font_dirs():
    here = os.path.dirname(os.path.abspath(__file__))
    dirs = [os.path.join(here, "assets", "fonts"),   # kit layout
            os.path.join(here, "fonts"),              # live flat layout
            r"C:\Windows\Fonts"]
    return [d for d in dirs if os.path.isdir(d)]


def _scan_fonts():
    """Ekbar scan: {lower_stem: path} — subset/exotic font name-o match hobe."""
    global _FONT_INDEX
    if _FONT_INDEX is not None:
        return _FONT_INDEX
    idx = {}
    for d in _font_dirs():
        try:
            for fn in os.listdir(d):
                low = fn.lower()
                if not low.endswith((".ttf", ".ttc", ".otf")):
                    continue
                stem = os.path.splitext(fn)[0].lower()
                # earlier dirs priority (kit assets > live fonts > Windows)
                idx.setdefault(stem, os.path.join(d, fn))
        except OSError:
            pass
    _FONT_INDEX = idx
    return idx


def _font_file_for(span_font):
    """ANY span font name -> best font file (permanent logic + fallback).
    Nirmala/Solaiman/Kalpurush/Nikosh/Hind... jai asuk, stem-match kore
    file ber koro; na pelle None (caller fallback nibe). Subset names
    ('NirmalaUI-Bold-...', 'ABCDEF+Nirmala') o chole."""
    if not span_font:
        return None
    key = span_font.lower()
    if key in _FONT_CACHE:
        return _FONT_CACHE[key]
    idx = _scan_fonts()
    # normalize: subset prefix (ABCDEF+), style suffix (-Bold), commas
    raw = span_font.split(",")[0].strip()
    if "+" in raw:
        raw = raw.split("+", 1)[1]
    stem = raw.split("-")[0].split(" ")[0].strip().lower()
    hit = None
    # 1) exact stem
    if stem in idx:
        hit = idx[stem]
    # 2) known-BN alias (nirmala -> nirmalaui/nirmala...)
    if not hit:
        for kpath_stem, p in idx.items():
            if stem and len(stem) >= 3 and (
                    kpath_stem.startswith(stem) or stem.startswith(kpath_stem)):
                hit = p
                break
    # 3) known BN family substring match
    if not hit:
        for bn in _KNOWN_BN:
            if bn in key:
                for kpath_stem, p in idx.items():
                    if bn in kpath_stem:
                        hit = p
                        break
            if hit:
                break
    _FONT_CACHE[key] = hit
    return hit


def _ink_matrix(page, bbox, zoom=4.0):
    """Crop render kore ink-matrix (paint-sotto). Text-extract NA — tar
    phantom-char ashe. Returns (rows, w, h) — rows[r][c]=True hole ink."""
    try:
        r = pymupdf.Rect(bbox.x0 - 0.5, bbox.y0 - 0.5,
                         bbox.x1 + 0.5, bbox.y1 + 0.5)
        pix = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), clip=r)
        w, h, n = pix.width, pix.height, pix.n
        buf = pix.samples
        grid = [[False] * w for _ in range(h)]
        for y in range(h):
            row = grid[y]
            base = y * w * n
            for x in range(w):
                o = base + x * n
                if min(buf[o], buf[o + 1], buf[o + 2]) < 170:
                    row[x] = True
        # ink-er actual extent diye crop (padding 1px)
        cols = [x for x in range(w) if any(grid[y][x] for y in range(h))]
        rows_ = [y for y in range(h) if any(grid[y])]
        if not cols or not rows_:
            return None
        c0, c1 = max(0, cols[0] - 1), min(w - 1, cols[-1] + 1)
        r0, r1 = max(0, rows_[0] - 1), min(h - 1, rows_[-1] + 1)
        m = [row[c0:c1 + 1] for row in grid[r0:r1 + 1]]
        return m, len(m[0]), len(m)
    except Exception:
        return None


def _rendered_ink_matrix(text, font_path, size_pt):
    """Candidate string-er ink-matrix (same font diye nijer PDF-e render)."""
    global _MEAS_DOC
    try:
        import html as _html
        if _MEAS_DOC is None:
            _MEAS_DOC = pymupdf.open()
        page = _MEAS_DOC.new_page(width=600, height=200)
        fdir = os.path.dirname(font_path)
        fname = os.path.basename(font_path)
        arch = pymupdf.Archive(fdir)
        css = ("@font-face {font-family: bn; src: url(%s);}\n"
               "div {font-family: bn; font-size: %.4fpx; white-space: nowrap;}\n"
               % (fname, size_pt))
        page.insert_htmlbox(pymupdf.Rect(30, 50, 570, 150),
                            "<div>%s</div>" % _html.escape(text),
                            css=css, archive=arch, scale_low=1)
        d = page.get_text("rawdict")
        xs, ys = [], []
        for blk in d["blocks"]:
            for ln in blk.get("lines", []):
                for sp in ln["spans"]:
                    for ch in sp["chars"]:
                        xs += [ch["bbox"][0], ch["bbox"][2]]
                        ys += [ch["bbox"][1], ch["bbox"][3]]
        if not xs:
            return None
        return _ink_matrix(page, pymupdf.Rect(min(xs) - 0.5, min(ys) - 0.5,
                                              max(xs) + 0.5, max(ys) + 0.5))
    except Exception:
        return None
    finally:
        try:
            _MEAS_DOC.delete_page(-1)
        except Exception:
            pass


def _match_score(crop, cand):
    """crop/cand ink-matrix pixel-compare. Left-top align + ±2px dy search.
    Score = min XOR-ink / union-ink (0 = perfect paint-match)."""
    if not crop or not cand:
        return 1.0
    (cm, cw, chh), (dm, dw, dh) = crop, cand
    best = 1.0
    for dy in (-2, -1, 0, 1, 2):
        W = max(cw, dw)
        H = max(chh, dh) + 4
        union = xor = 0
        for y in range(H):
            for x in range(W):
                a = False
                if 0 <= y < chh and 0 <= x < cw:
                    a = cm[y][x]
                y2 = y - 2 - dy  # cand placed with center align (2px slack)
                b = False
                if 0 <= y2 < dh and 0 <= x < dw:
                    b = dm[y2][x]
                if a or b:
                    union += 1
                if a != b:
                    xor += 1
        if union:
            s = xor / union
            if s < best:
                best = s
    return best


def _phantom_fix(text, cands, page):
    """BN value theke unpainted ActualText-phantom sign sorao.
    (1) Deterministic: consecutive DUPLICATE matra (ুু/াা/িি...) kokhono
        valid Bengali na — strip koro (input generator-er ActualText bug).
    (2) Pixel-refine baki single sign-er jonno: crop (input paint, Nirmala)
        sathe Nirmala-render compare — sign-ti paint hocche kina check.
        Input er sathe match korle (legit) touch NA; mismatch + big
        improvement hole remove. Output font na — INPUT paint sathe
        compare (same font = apples-to-apples)."""
    if not text or not page:
        return text
    if not any(0x0980 <= ord(ch) <= 0x09FF for ch in text):
        return text

    # (1) duplicate consecutive combining strip (deterministic)
    out, prev_comb = [], None
    for ch in text:
        if ch in _BN_COMB and ch == prev_comb:
            continue  # phantom dup
        out.append(ch)
        prev_comb = ch if ch in _BN_COMB else None
    cur = "".join(out)

    # (2) pixel-refine for remaining single phantom signs
    if not cands:
        return cur
    idxs = [i for i, ch in enumerate(cur) if ch in _BN_COMB]
    if not idxs:
        return cur
    fpath = _font_file_for(cands[0].get("font"))
    if not fpath:
        return cur
    size_pt = max(c.get("size") or 10 for c in cands)
    try:
        bb = pymupdf.Rect(min(c["x0"] for c in cands),
                          min(c["y0"] for c in cands),
                          max(c["x1"] for c in cands),
                          max(c["y1"] for c in cands))
    except Exception:
        return cur
    crop = _ink_matrix(page, bb)
    if not crop:
        return cur
    for _round in range(3):  # multiple phantom hole ekbar-e jabe na
        s_orig = _match_score(crop, _rendered_ink_matrix(cur, fpath, size_pt))
        if s_orig < 0.06:
            break  # original paint sathe-mili — kono phantom NA
        best, best_s = cur, s_orig
        for i, ch in enumerate(cur):
            if ch not in _BN_COMB:
                continue
            cand = cur[:i] + cur[i + 1:]
            if not cand.strip():
                continue
            s = _match_score(crop, _rendered_ink_matrix(cand, fpath, size_pt))
            if s < best_s:
                best, best_s = cand, s
        if best != cur and best_s < 0.08 and (s_orig - best_s) > 0.03:
            cur = best
        else:
            break
    return cur


# ফর্মে যে লেবেলগুলো খোঁজা হবে
KNOWN_LABELS = [
    "National ID", "Pin", "Status", "Afis Status", "Lock Flag", "Voter No",
    "Form No", "Sl No", "Tag",
    "Name(Bangla)", "Name(English)", "Date of Birth", "Birth Place",
    "Birth Registration No", "Father Name", "Mother Name", "Spouse Name",
    "Gender", "Marital", "Occupation", "Mobile", "Voter Area", "Voter At",
    "Division", "District", "City", "RMO", "Upozila", "Union/Ward",
    "Present Address", "Permanent Address", "Birth Other", "Disability", "Disability Other",
    "Phone", "Email", "Religion", "Religion Other",
    "Education", "Education Other", "Education Sub", "Identification",
    "TIN", "Driving", "Passport", "Laptop ID",
    "NID Father", "NID Mother", "Nid Spouse",
    "Death Date Of Father", "Death Date Of Mother", "Death Date Of Spouse",
    "No Finger", "No Finger Print",
    "Voter No Father", "Voter No Mother", "Voter No Spouse",
    "Blood Group", "Blood", "BG",
    # Voter printout (vertical label->value) sub-labels
    "Ward For Union Porishod", "Village/Road", "Additional Village/Road",
    "Home/Holding No", "Post Office", "Postal Code", "Region",
    "Mouza/Moholla", "Additional Mouza/Moholla",
    "City Corporation Or Municipality",
]
LABEL_SET = set(KNOWN_LABELS)

# এই লেবেলগুলো টেবিল-সেকশন — ডানপাশের সাধারণ ক্যাপচারে নেওয়া হবে না
SKIP_GENERIC = {"Present Address", "Permanent Address", "Foreign Address"}

# --- OCR fallback (scanned/image PDF — text layer nei) -----------------------
# Page-e 5-tar kom text span thakle OCR chalao. Words span-dict akare ashe,
# tai baki pipeline (coalesce/label/address) same thake.
# Backend: 1) easyocr (bn+en, jodi installed) -> 2) ddddocr det+ocr.
# Kono backend na thakle [] (skip, crash NA).
_ocr_reader = None
_dd_det = None
_dd_ocr = None


def _easyocr_words(png_bytes):
    """easyocr word boxes -> [(x0,y0,x1,y1,text)] (image px). None = unavailable."""
    try:
        global _ocr_reader
        import easyocr
        if _ocr_reader is None:
            _ocr_reader = easyocr.Reader(['bn', 'en'], gpu=False)
        import numpy as np
        from PIL import Image as _I
        import io as _io
        arr = np.array(_I.open(_io.BytesIO(png_bytes)).convert('RGB'))
        out = []
        for box, text, conf in _ocr_reader.readtext(arr):
            try:
                xs = [p[0] for p in box]
                ys = [p[1] for p in box]
                if (conf or 0) < 0.25:
                    continue
                t = str(text or '').strip()
                if t:
                    out.append((min(xs), min(ys), max(xs), max(ys), t))
            except Exception:
                continue
        return out
    except Exception:
        return None


def _is_cid_mojibake_span(s):
    """Anonymous CID font (broken ToUnicode) + Bengali codepoints = text
    layer untrusted (paint thik, extract garbage — 'ছুȵুিময়া' class)."""
    fn = (s.get("font") or "").lower()
    if "cidfont" not in fn and not fn.startswith("cid"):
        return False
    t = s.get("text") or ""
    return any(0x0980 <= ord(c) <= 0x09FF for c in t)


def _ocr_crop(page, bbox, zoom=6.0):
    """Span bbox crop render + easyocr/ddddocr (dui engine, jater Bengali
    letter beshi setai nio — small BN word-e easyocr partial dey)."""
    try:
        r = pymupdf.Rect(bbox[0] - 1, bbox[1] - 1, bbox[2] + 1, bbox[3] + 1)
        pix = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), clip=r)
        png = pix.tobytes("png")
    except Exception:
        return None

    def _join(words):
        if not words:
            return ""
        words = sorted(words, key=lambda w: (round(w[1] / 10), w[0]))
        return " ".join(w[4] for w in words).strip()

    def _bn_count(t):
        return sum(1 for c in t if 0x0980 <= ord(c) <= 0x09FF)

    def _clean(t):
        # CJK/misc garbage (easyocr kabhikhe Chinese dey) sorao; BN+Latin+rakho
        return "".join(c for c in t
                       if 0x0980 <= ord(c) <= 0x09FF
                       or 0x0020 <= ord(c) <= 0x007E
                       or c in "ঃঁৗ-").strip()

    c1 = _clean(_join(_easyocr_words(png)))
    c2 = _clean(_join(_ddddocr_words(png)))
    cands = [c for c in (c1, c2) if c]
    if not cands:
        return None
    return max(cands, key=lambda t: (_bn_count(t), len(t)))


def _repair_cid_spans(page, spans):
    """CID-mojibake span -> crop+OCR replace (paint sathe OCR, text-layer na).
    Replace rule (permanent): OCR result-er Bengali letter original-er
    theke kom na hole, ba original-e class-A junk (non-Bengali char) thakle
    (>=2 BN letter hole). All-Bengali original + weak OCR hole ORIGINAL
    thake (jemon 'সুিপ্রিয়া' > '3T')."""
    for s in spans:
        if not _is_cid_mojibake_span(s):
            continue
        t = _ocr_crop(page, (s["x0"], s["y0"], s["x1"], s["y1"]))
        if not t:
            continue
        old = s["text"]
        old_bn = sum(1 for c in old if 0x0980 <= ord(c) <= 0x09FF)
        new_bn = sum(1 for c in t if 0x0980 <= ord(c) <= 0x09FF)
        old_junk = any(
            not (0x0980 <= ord(c) <= 0x09FF or 0x0020 <= ord(c) <= 0x007E
                 or c in " .,:/-()&'\"") for c in old)
        if new_bn >= old_bn or (old_junk and new_bn >= 2):
            s["text"] = t
            s["ocr"] = True
    return spans


def _ddddocr_words(png_bytes):
    """ddddocr det (char boxes) + ocr -> [(x0,y0,x1,y1,text)]. None = unavailable.
    Dense page-e detector blind hoy — tai overlapping horizontal strip-e
    vag kore detect (full-page-e 0-2 box, strip-e shoto box)."""
    try:
        global _dd_det, _dd_ocr
        from ddddocr import DdddOcr
        from PIL import Image as _I
        import io as _io
        if _dd_det is None:
            _dd_det = DdddOcr(det=True, show_ad=False)
        if _dd_ocr is None:
            _dd_ocr = DdddOcr(det=False, ocr=True, show_ad=False)
        img = _I.open(_io.BytesIO(png_bytes)).convert('RGB')
        W, H = img.size
        strips = []
        n = max(1, H // 400)
        ov = 40
        for i in range(n):
            y0 = max(0, (H // n) * i - ov)
            y1 = min(H, (H // n) * (i + 1) + ov)
            if y1 - y0 < 60:
                continue
            strips.append((y0, img.crop((0, y0, W, y1))))
        if not strips:
            strips = [(0, img)]
        out = []
        seen = set()
        for (sy, part) in strips:
            cb = _io.BytesIO()
            part.save(cb, format='PNG')
            try:
                boxes = _dd_det.detection(cb.getvalue()) or []
            except Exception:
                continue
            for b in boxes:
                try:
                    x1, y1, x2, y2 = [int(v) for v in b]
                    if x2 <= x1 or y2 <= y1:
                        continue
                    key = (x1 // 4, (y1 + sy) // 4, x2 // 4, (y2 + sy) // 4)
                    if key in seen:
                        continue
                    seen.add(key)
                    crop = part.crop((x1, y1, x2, y2))
                    cbb = _io.BytesIO()
                    crop.save(cbb, format='PNG')
                    t = _dd_ocr.classification(cbb.getvalue())
                    if t and str(t).strip():
                        out.append((x1, y1 + sy, x2, y2 + sy, str(t).strip()))
                except Exception:
                    continue
        return out
    except Exception:
        return None


def ocr_page_spans(page, pno, dpi=200):
    """Scanned page -> OCR span-dicts (get_spans-compat shape + 'ocr': True)."""
    try:
        pix = page.get_pixmap(dpi=dpi)
    except Exception:
        return []
    try:
        png = pix.tobytes("png")
    except Exception:
        return []
    sx = (page.rect.width / pix.width) if pix.width else 1.0
    words = _easyocr_words(png)
    if words is None:
        words = _ddddocr_words(png)
    if not words:
        return []
    out = []
    for (x0, y0, x1, y1, t) in words:
        t = (t or '').strip()
        if not t:
            continue
        out.append({"page": pno, "text": t,
                    "x0": round(x0 * sx, 2), "y0": round(y0 * sx, 2),
                    "x1": round(x1 * sx, 2), "y1": round(y1 * sx, 2),
                    "size": round(max(6.0, (y1 - y0) * sx), 2),
                    "ocr": True})
    return out

# ফর্মের ডান-সাইডবারের লেখা — মান পড়ার সময় এগুলো এলে থামো
SIDEBAR_STOP = {"License Documents", "BIRTH_CERTIFICATE", "DATA ENTRY PROOF COPY",
                "VOTER FORM PAGE ONE", "VOTER FORM PAGE TWO", "Smart Card Info",
                "No Documents", "Documents", "No", "Available", "No Documents Available"}


def std_label(text, candidates, is_ocr):
    """Label canonicalize: exact match first; OCR span hole fuzzy (typo
    tolerate: 'Date of Birtn'->'Date of Birth'). Clean path exact-i thake."""
    t = (text or "").strip()
    if t in candidates:
        return t
    if is_ocr:
        try:
            m = difflib.get_close_matches(t, list(candidates), n=1, cutoff=0.78)
        except Exception:
            m = None
        if m:
            return m[0]
    return None

# Present Address টেবিলের উপ-লেবেল পড়ার সময় থামার শর্ত (সব টুকরো লেবেলসহ)
ADDR_STOP_EXTRA = {"Additional", "Union/Ward",
                   "Or", "Ward", "For", "Union", "Porishod",
                   "No", "Region", "Home/", "Holding No", "Home/Holding No", "Mouza/", "Moholla"}

# Present Address টেবিলের যে উপ-লেবেলগুলো দরকার (কার্ডের ঠিকানা বানাতে)
# ফর্মে "Home/Holding No" দুই লাইনে ভাঙা থাকে, তাই "Home/Holding" দিয়ে মেলানো হয়
ADDR_WANT = [
    ("RMO", "rmo"),
    ("City", "city_corp"),
    ("Corporation", "city_corp2"),
    ("Municipality", "city_corp3"),
    ("Division", "division"),
    ("District", "district"),
    ("Upozila", "upozila"),
    ("Union/Ward", "union_ward"),
    ("Mouza/Moholla", "mouza"),
    ("Village/Road", "village"),
    ("Home/Holding", "holding"),
    ("Home/Holding No", "holding"),
    ("Holding", "holding"),
    ("Post Office", "post_office"),
    ("Postal Code", "postal_code"),
]
ADDR_LABELS = set(l for l, _ in ADDR_WANT)


def get_spans(page, pno):
    spans = []
    d = page.get_text("dict")
    for b in d["blocks"]:
        if b["type"] != 0:
            continue
        for line in b["lines"]:
            for s in line["spans"]:
                txt = s["text"]
                if not txt.strip():
                    continue
                x0, y0, x1, y1 = [round(v, 2) for v in s["bbox"]]
                spans.append({"page": pno, "text": txt,
                              "x0": x0, "y0": y0, "x1": x1, "y1": y1,
                              "size": round(s["size"], 2),
                              "font": s.get("font", "")})
    return _coalesce_fragments(spans)


def _coalesce_fragments(spans):
    """কাছাকাছি single-character টুকরোগুলোকে শব্দে জোড়া দাও।

    কিছু PDF generator (যেমন এই NID ফর্মের) প্রতিটি অক্ষরকে আলাদা span
    হিসেবে রাখে — তখন "Name(Bangla)" ১১টা টুকরো হয়ে label-match ব্যর্থ হয়।
    একই baseline-এ খুব কাছাকাছি (character spacing) টুকরো জোড়া হয়;
    স্বাভাবিক word-gap আলাদা span-ই থাকে, তাই পুরনো PDF-এ আচরণ বদলায় না।
    """
    if not spans:
        return spans
    ordered = sorted(spans, key=lambda s: (s["page"], (s["y0"] + s["y1"]) / 2, s["x0"]))
    out = []
    i = 0
    n = len(ordered)
    while i < n:
        yc = (ordered[i]["y0"] + ordered[i]["y1"]) / 2
        size = ordered[i]["size"] or 10
        pg = ordered[i]["page"]
        line = [ordered[i]]
        j = i + 1
        while j < n:
            o = ordered[j]
            if o["page"] != pg:
                break
            if abs((o["y0"] + o["y1"]) / 2 - yc) > size * 0.6:
                break
            line.append(o)
            j += 1
        line.sort(key=lambda s: s["x0"])
        merged = []
        for s in line:
            if merged:
                prev = merged[-1]
                gap = s["x0"] - prev["x1"]
                # শুধু অক্ষরের টুকরো (gap ~0) জোড়া হবে; word-gap (join_fragments-এর
                # 0.12 নিয়মের মতো) আলাদা থাকবে যাতে "আবদুল লতিফ" space না হারায়
                if gap < prev["size"] * 0.12 and gap < s["size"] * 0.12:
                    prev["text"] += s["text"]
                    prev["x1"] = max(prev["x1"], s["x1"])
                    prev["y0"] = min(prev["y0"], s["y0"])
                    prev["y1"] = max(prev["y1"], s["y1"])
                    continue
            merged.append(dict(s))
        out.extend(merged)
        i = j
    return out


def join_fragments(cands):
    parts = []
    prev = None
    for c in cands:
        if prev is not None:
            gap = c["x0"] - prev["x1"]
            # শব্দের মাঝের ফাঁকা (~0.25em) থাকলে স্পেস, যুক্তাক্ষরের টুকরো (ফাঁকা ~0) হলে নয়
            parts.append(" " if gap > c["size"] * 0.12 else "")
        parts.append(c["text"])
        prev = c
    
    text = "".join(parts).strip()
    
    # 1. Dictionary Mapping for common font garbling issues
    replacements = {
        "চǾƣাম": "চট্টগ্রাম",
        "িসǅ": "সিটি",
        "কেপŪােরশন": "কর্পোরেশন",
        "মাঃ": "মোঃ ",
        "উিțন": "উদ্দিন ",
        "ওয়ািসম": "ওয়াসিম",
        "লছুমা": "কুলছুমা",
        "রাǩামাǅয়া": "রাঙ্গামাটিয়া",
        "হািমদচর": "হামিদচর",
        "ওয়াডŪ": "ওয়ার্ড",
        "চালাদক্ষি ন": "চালাদক্ষিন",
        "দক্ষি ন": "দক্ষিন",
        "মোঃঃ": "মোঃ",
        "ংং": "ং",
        "ংাং": "ং",
        "ĺ": "",  # Remove weird artifacts
        "ʛ": "",  # Remove weird artifacts
        "  ": " ", # Double space to single
    }
    for bad, good in replacements.items():
        text = text.replace(bad, good)

    text = text.strip()

    # Phantom-sign fix: ActualText-e ache kintu paint-e nei — ink-width
    # proof diye sorao (permanently; Nirmala-web-print PDF-er jonno).
    if _DOC is not None:
        try:
            page = _DOC[cands[0]["page"]] if cands else None
        except Exception:
            page = None
        if page is not None and cands:
            text = _phantom_fix(text, cands, page)

    return text.strip()


def right_value(label_span, spans, stop_set, max_x0=600, multiline=False,
                y_range=None):
    """লেবেলের ডান পাশে একই লাইনের মান পড়ো; পরের লেবেল/সাইডবার এলে থামো।
    multiline=True hole ei column-e niche-wrap kora extra line-o join hoy
    (যেমন Home/Holding-এর মান ৩ লাইনে ভাঙা: জালাল / চেয়ারম্যান / বাড়ী)।
    y_range=(lo,hi) dile shudhu oi y-window-er value line neowa hoy
    (Additional-এর মান label-er dui line-er moddhe thake)."""
    b = label_span
    yc = (b["y0"] + b["y1"]) / 2
    cands = []
    for c in sorted(spans, key=lambda s: s["x0"]):
        if c["page"] != b["page"] or c is b or c is b.get("_orig"):
            continue
        if abs((c["y0"] + c["y1"]) / 2 - yc) > b["size"] * 0.7:
            continue
        if y_range and not (y_range[0] <= (c["y0"] + c["y1"]) / 2 <= y_range[1]):
            continue
        if c["x0"] < b["x1"] - 15:
            continue
        if c["x0"] > max_x0:
            break  # সাইডবার-কলামে ঢুকে গেছে, থামো
        if c["text"].strip() in stop_set:
            break  # পরের লেবেল এসে গেছে, থামো
        cands.append(c)
    if not cands:
        return ""
    if y_range:
        # ekadhik value-line (Additional-এর মান 2 line-e bhanga) — line
        # gulo space diye joro, fragment gulo line-er vitore joro
        lines = []
        for c in sorted(cands, key=lambda s: (s["y0"], s["x0"])):
            cy = (c["y0"] + c["y1"]) / 2
            if lines and abs(cy - lines[-1][0]) < 7:
                lines[-1][1].append(c)
            else:
                lines.append((cy, [c]))
        val = " ".join(join_fragments(x) for _y, x in lines).strip()
    else:
        val = join_fragments(cands)
    if multiline:
        vx = min(c["x0"] for c in cands)
        yb = max(c["y1"] for c in cands)
        for _ in range(4):
            nxt = [c for c in sorted(spans, key=lambda s: (s["y0"], s["x0"]))
                   if c["page"] == b["page"] and abs(c["x0"] - vx) <= 12
                   and (c["y0"] + c["y1"]) / 2 > yb - 1
                   and c["y0"] - yb <= 26]
            if not nxt:
                break
            # shudhu nearest line-ta nao (porer line next iteration-e)
            line_cy = (nxt[0]["y0"] + nxt[0]["y1"]) / 2
            nxt = [c for c in nxt
                   if abs((c["y0"] + c["y1"]) / 2 - line_cy) < 7]
            cy = line_cy
            # notun label line (Postal Code/Post Office...) ele theme jao —
            # label value-column-er dane ba bame jei dikei thakuk. Bame hole
            # shudhu puro label dhori (No/Additional-er moto label-er bhanga
            # ongsho noy), nahole 3-line holding bhange jay.
            blocked = any(
                c["page"] == b["page"] and c is not b
                and abs((c["y0"] + c["y1"]) / 2 - cy) < 7
                and ((380 <= c["x0"] <= 505)
                     or (c["x1"] < vx - 2 and vx - c["x1"] <= 90))
                and c["text"].strip() in ADDR_LABELS
                for c in spans)
            if blocked:
                break
            val = (val + " " + join_fragments(nxt)).strip()
            yb = max(c["y1"] for c in nxt)
    return val


def parse_present_address(all_spans, page_heights):
    """Present Address টেবিল (Present Address লেবেল থেকে Permanent Address
    লেবেল পর্যন্ত) থেকে ঠিকানার অংশগুলো পড়ো।"""
    return parse_address_table(all_spans, page_heights,
                               anchor="Present Address",
                               end_anchor="Permanent Address")


def parse_address_table(all_spans, page_heights, anchor, end_anchor=None):
    """Address table reader (Present ba Permanent): anchor লেবেল থেকে
    end_anchor (ba page-shesh) porjonto ঠিকানার অংশগুলো পড়ো।"""
    aw = anchor.split()
    pa = []
    for i, s in enumerate(all_spans):
        text = s["text"].strip()
        if std_label(text, {anchor}, bool(s.get("ocr"))) == anchor:
            pa.append(s)
        elif len(aw) > 1 and text == aw[0]:
            if i + 1 < len(all_spans) and aw[1] in all_spans[i+1]["text"]:
                pa.append(s)

    if not pa:
        return {}
    pa = sorted(pa, key=lambda s: (s["page"], s["y0"]))[0]
    pno = pa["page"]

    # সেকশনের শেষ: একই পেজে end_anchor (thakle)
    ends = []
    ew = end_anchor.split() if end_anchor else []
    for i, s in enumerate(all_spans):
        text = s["text"].strip()
        if s["page"] == pno and s["y0"] > pa["y0"]:
            if end_anchor and std_label(text, {end_anchor}, bool(s.get("ocr"))) == end_anchor:
                ends.append(s)
            elif len(ew) > 1 and text == ew[0]:
                if i + 1 < len(all_spans) and ew[1] in all_spans[i+1]["text"]:
                    ends.append(s)
                    
    y_end = (sorted(ends, key=lambda s: s["y0"])[0]["y0"]
             if ends else page_heights.get(pno, 1e9))
    band = [s for s in all_spans
            if s["page"] == pno and pa["y0"] - 2 <= s["y0"] < y_end]

    def has_additional_above(cand):
        for s in band:
            if (s["text"].strip() == "Additional"
                    and abs(s["x0"] - cand["x0"]) < 12
                    and cand["y0"] - 30 < s["y0"] < cand["y0"] - 2):
                return True
        return False

    band.sort(key=lambda s: (s["y0"], s["x0"]))
    # canonical label per span (OCR typo tolerate: 'Jpozila'->'Upozila')
    canon = {}
    for s in band:
        canon[id(s)] = std_label(s["text"], ADDR_LABELS, bool(s.get("ocr")))
    merged_band = []
    i = 0
    while i < len(band):
        s = band[i]
        text = canon[id(s)] or s["text"].strip()

        # Merge "Mouza/" + "Moholla" (value 2nd line-e thake, tai geometry-o
        # 2nd line-er ta neowa hoy — nahole right_value line mismatch-e reject kore)
        if text == "Mouza/" and i+1 < len(band) and (canon.get(id(band[i+1])) or band[i+1]["text"].strip()) == "Moholla":
            s_new = s.copy()
            s_new["text"] = "Mouza/Moholla"
            s_new["y0"] = band[i+1]["y0"]
            s_new["y1"] = band[i+1]["y1"]
            s_new["size"] = band[i+1]["size"]
            merged_band.append(s_new)
            i += 2
            continue

        # Merge "Home/" + "Holding No" (same: 2nd line geometry)
        if text == "Home/" and i+1 < len(band) and (canon.get(id(band[i+1])) or band[i+1]["text"].strip()) == "Holding No":
            s_new = s.copy()
            s_new["text"] = "Home/Holding No"
            s_new["y0"] = band[i+1]["y0"]
            s_new["y1"] = band[i+1]["y1"]
            s_new["size"] = band[i+1]["size"]
            merged_band.append(s_new)
            i += 2
            continue
            
        merged_band.append(s)
        i += 1
        
    band = merged_band

    addr = {}
    for label_text, key in ADDR_WANT:
        cands = [s for s in band if (canon.get(id(s)) or s["text"].strip()) == label_text]
        cands.sort(key=lambda s: (s["y0"], s["x0"]))
        for c in cands:
            is_add = (key in ("village", "mouza")) and has_additional_above(c)
            target_key = ("additional_" + key) if is_add else key
            if target_key in addr:
                continue
                
            if is_add:
                search_c = c.copy()
                search_c["_orig"] = c
                # Expand the bounding box upwards to catch values on the "Additional" line
                search_c["y0"] -= 16
                search_c["size"] = 28
            else:
                search_c = c
                
            val = right_value(search_c, band, ADDR_LABELS | ADDR_STOP_EXTRA,
                              multiline=(key == "holding"),
                              y_range=((c["y0"] - 18, c["y0"] + 8)
                                       if is_add else None))
            if val:
                addr[target_key] = val
    return addr


# Voter printout: vertical label-line -> value-line. Sub-label -> compose_address key.
_VERT_ADDR_MAP = {
    "Home/Holding No": "holding",
    "Village/Road": "village",
    "Additional Village/Road": "additional_village",
    "Mouza/Moholla": "mouza",
    "Additional Mouza/Moholla": "additional_mouza",
    "Post Office": "post_office",
    "Postal Code": "postal_code",
    "Upozila": "upozila",
    "District": "district",
    "RMO": "rmo",
    "Division": "division",
    "Union/Ward": "union_ward",
    "City Corporation Or Municipality": "city_corp",
    "Ward For Union Porishod": "ward_porishod",
    "Region": "region",
}


def parse_vertical_kv_pages(pages_spans):
    """Voter printout style (label line, value line below, not side-by-side).
    Returns (flat, present_addr, perm_addr). Cross-page value support:
    page-shesher label-er value hote pare next page-r 1st line."""
    flat, present, perm = {}, {}, {}
    section = None  # None | "present" | "perm"
    pending = None  # (label, section) awaiting value across page boundary
    for spans in pages_spans:
        # group into lines by y
        spans = sorted(spans, key=lambda s: (s["y0"], s["x0"]))
        lines, cur = [], []
        for s in spans:
            if cur and abs(s["y0"] - cur[-1]["y0"]) > 6:
                lines.append(cur)
                cur = []
            cur.append(s)
        if cur:
            lines.append(cur)
        texts = [" ".join(s["text"].strip() for s in ln
                          if s["text"].strip()).strip() for ln in lines]
        i = 0
        while i < len(texts):
            lt = texts[i]
            if not lt:
                i += 1
                continue
            lab = std_label(lt, LABEL_SET, False)
            if pending and lab is None:
                # cross-page value for last-page label
                _vert_store(pending[0], lt, flat, present, perm, pending[1])
                pending = None
                i += 1
                continue
            pending = None
            if lab is None:
                i += 1
                continue
            if lab in SKIP_GENERIC:
                section = ("present" if lab == "Present Address"
                           else "perm" if lab == "Permanent Address" else None)
                i += 1
                continue
            # value = next non-empty line if not itself a label
            val = ""
            j = i + 1
            while j < len(texts) and not texts[j]:
                j += 1
            if j < len(texts) and std_label(texts[j], LABEL_SET, False) is None:
                val = texts[j]
            if val:
                _vert_store(lab, val, flat, present, perm, section)
                i = j + 1
            else:
                if j >= len(texts):
                    pending = (lab, section)  # last line of page
                i = j if j < len(texts) else i + 1
    return flat, present, perm


def _vert_store(lab, val, flat, present, perm, section=None):
    if section == "present" and lab in _VERT_ADDR_MAP:
        present.setdefault(_VERT_ADDR_MAP[lab], val)
    elif section == "perm" and lab in _VERT_ADDR_MAP:
        perm.setdefault(_VERT_ADDR_MAP[lab], val)
    else:
        flat.setdefault(lab, val)


# --- BEC report printouts (v1: server download, v2: NIDW site print) -------
# Ekhane label Bangla, value SAME line-e table-er dan cell-e. Span text-e
# broken shaping (গ্রাাম/রাস্তাঃাঃ, জন্মস্থাান, বাসা/হোল্ডিংঃংঃ) — tidy koro.
_REPORT_LABELS = {
    "জাতীয় পরিচয় পত্র নম্বর": "National ID",
    "জাতীয় পরিচয়পত্র নম্বর": "National ID",
    "পিন নম্বর": "Pin",
    "ভোটার নম্বর": "Voter No",
    "ভোটার এরিয়া কোড": "Voter Area",
    "এরিয়া কোড": "Voter Area",
    "নাম (বাংলা)": "Name(Bangla)",
    "নাম (ইংরেজি)": "Name(English)",
    "জন্ম তারিখ": "Date of Birth",
    "পিতার নাম": "Father Name",
    "মাতার নাম": "Mother Name",
    "স্বামী/স্ত্রীর নাম": "Spouse Name",
    "ধর্ম": "Religion",
    "লিঙ্গ": "Gender",
    "পেশা": "Occupation",
    "জন্মস্থান": "Birth Place",
    "রক্তের গ্রুপ": "Blood Group",
}

_BN_DOUBLES = [("ুু", "ু"), ("ূূ", "ূ"), ("াা", "া"), ("িি", "ি"),
               ("ীী", "ী"), ("েে", "ে"), ("োো", "ো"), ("ঃঃ", "ঃ"),
               ("্্", "্"), ("ঁঁ", "ঁ"), ("োা", "ো"), ("ৌা", "ৌ")]


def _bn_tidy(s):
    """Report printout-er broken shaping thik koro + space normalize."""
    s = re.sub(r"\s+", " ", s or "")
    # 'বাসা/হোল্ডিংঃংঃ' / '...ঃ ংঃ' — extra visarga-artifact
    s = s.replace("ঃ ংঃ", "ঃ").replace("ঃংঃ", "ঃ")
    s = s.replace("ঃাঃ", "ঃ")
    # 'ে'+'া' (v1-e ো-র bodole) — label/address matching-er jonno
    s = s.replace("ো", "ো")
    for bad, good in _BN_DOUBLES:
        while bad in s:
            s = s.replace(bad, good)
    return s.strip()


def _bn_label_norm(s):
    s = _bn_tidy(s)
    # য় (09DF) vs য় (09AF+09BC): NFD-e duijon same hoy
    s = unicodedata.normalize("NFD", s)
    s = re.sub(r"\s*\(\s*", "(", s)
    s = re.sub(r"\s*\)\s*", ")", s)
    s = re.sub(r"\s+", " ", s)
    return s.strip(" :ঃ,।")


# --- Spelling repair (sample-e bhul spelling/shaping thakleo thik koro) -----
# BEC printout-e font artifact: 'র্ধম' (reph shuru-te), 'ভোাটার' (ো + extra া),
# 'পেকুয়াার'/'চট্টগ্রাাম' (double া) — sob value-e apply hoy, শুধু ঠিকানা না।
_BN_DIVISIONS = ["ঢাকা", "চট্টগ্রাম", "রাজশাহী", "খুলনা", "বরিশাল",
                 "সিলেট", "রংপুর", "ময়মনসিংহ"]

_BN_DISTRICTS = [
    "ঢাকা", "গাজীপুর", "কিশোরগঞ্জ", "মানিকগঞ্জ", "মুন্সিগঞ্জ",
    "নারায়ণগঞ্জ", "নরসিংদী", "টাঙ্গাইল", "ফরিদপুর", "গোপালগঞ্জ",
    "মাদারীপুর", "রাজবাড়ী", "শরীয়তপুর",
    "চট্টগ্রাম", "কক্সবাজার", "কুমিল্লা", "ব্রাহ্মণবাড়িয়া", "চাঁদপুর",
    "ফেনী", "লক্ষ্মীপুর", "নোয়াখালী", "খাগড়াছড়ি", "রাঙ্গামাটি", "বান্দরবান",
    "রাজশাহী", "বগুড়া", "জয়পুরহাট", "নওগাঁ", "নাটোর", "চাঁপাইনবাবগঞ্জ",
    "পাবনা", "সিরাজগঞ্জ",
    "খুলনা", "বাগেরহাট", "চুয়াডাঙ্গা", "যশোর", "ঝিনাইদহ", "কুষ্টিয়া",
    "মাগুরা", "মেহেরপুর", "নড়াইল", "সাতক্ষীরা",
    "বরিশাল", "বরগুনা", "ভোলা", "ঝালকাঠি", "পটুয়াখালী", "পিরোজপুর",
    "সিলেট", "হবিগঞ্জ", "মৌলভীবাজার", "সুনামগঞ্জ",
    "রংপুর", "দিনাজপুর", "গাইবান্ধা", "কুড়িগ্রাম", "লালমনিরহাট",
    "নীলফামারী", "পঞ্চগড়", "ঠাকুরগাঁও",
    "ময়মনসিংহ", "জামালপুর", "নেত্রকোণা", "শেরপুর",
]
_BN_GAZ = sorted(set(_BN_DIVISIONS + _BN_DISTRICTS))
_BN_GAZ_NFD = {unicodedata.normalize("NFD", g): g for g in _BN_GAZ}


def _bn_repair(s):
    """Font-artifact + common spelling repair on a VALUE (label noy)."""
    s = _bn_tidy(s)
    if not s:
        return s
    # reph word-er shuru-te boshe gele (র্ধম -> ধর্ম) — Bangla-e শুরুর reph
    # kokhono valid noy, tai e swap ta safe
    s = re.sub(r"(^|\s)র্([\u0995-\u09B9])", r"\1\2র্", s)
    # 'ঃং' residue + punctuation-er age extra space
    s = s.replace("ঃং", "ঃ")
    s = re.sub(r"\s+([,।;:])", r"\1", s)
    s = re.sub(r"\s{2,}", " ", s)
    return s.strip()


def _bn_place_canon(word):
    """Known district/division name hole spelling thik koro (sample-e typo
    thakleo), nahole word ta jemon ache temon return koro."""
    w = _bn_repair(word)
    if not w:
        return w
    key = unicodedata.normalize("NFD", w)
    if key in _BN_GAZ_NFD:
        return _BN_GAZ_NFD[key]
    if len(w) < 4 or re.search(r"[,/()]", w):
        return w
    best, best_r = None, 0.0
    for g in _BN_GAZ:
        r = difflib.SequenceMatcher(
            None, key, unicodedata.normalize("NFD", g)).ratio()
        if r > best_r:
            best, best_r = g, r
    if best and best_r >= 0.88 and \
            abs(len(key) - len(unicodedata.normalize("NFD", best))) <= 2:
        return best
    return w


def _en_tidy(s):
    """English name/field cleanup: extra space, stray punctuation artifacts."""
    orig = re.sub(r"\s+", " ", s or "").strip()
    s = re.sub(r"[^A-Za-z .'\-]", "", orig)
    s = re.sub(r"\s+", " ", s).strip()
    # Latin kichu na thakle (Bengali value dhukhe geche) original-i rakho
    return s or orig


_PLACE_KEYS = ("district", "division", "upozila", "thana")


def _clean_data(data):
    """Extraction-er por sob string value-e spelling repair (form + report
    duijoner jonno), jate sample-er bhul spelling output-e na jay."""
    for k, v in list(data.items()):
        if isinstance(v, str):
            if k == "Name(English)":
                data[k] = _en_tidy(v)
            elif k == "Birth Place":
                data[k] = _bn_place_canon(v)
            else:
                data[k] = _bn_repair(v)
        elif isinstance(v, dict):
            for kk, vv in list(v.items()):
                if not isinstance(vv, str):
                    continue
                v[kk] = _bn_place_canon(vv) if kk in _PLACE_KEYS \
                    else _bn_repair(vv)
    return data


def _report_rows(spans):
    """Span-gulo ke same-line row-e group koro (report table-er moto)."""
    sp = sorted(spans, key=lambda s: (s["y0"], s["x0"]))
    rows = []
    for s in sp:
        yc = (s["y0"] + s["y1"]) / 2
        if rows and abs(yc - rows[-1]["yc"]) <= 6.0:
            rows[-1]["spans"].append(s)
        else:
            rows.append({"yc": yc, "spans": [s]})
    for r in rows:
        r["spans"].sort(key=lambda s: s["x0"])
    return rows


def _row_cells(rowspans, gap=18.0):
    """Row-er bhitore boro x-fanka = column split (label | value)."""
    cells, cur = [], []
    for s in rowspans:
        if cur and s["x0"] - max(c["x1"] for c in cur) > gap:
            cells.append(cur)
            cur = [s]
        else:
            cur.append(s)
    if cur:
        cells.append(cur)
    out = []
    for c in cells:
        out.append({"text": _bn_tidy(join_fragments(c)),
                    "x0": c[0]["x0"],
                    "x1": max(x["x1"] for x in c)})
    return out


def parse_bn_address_text(text):
    """'বাসা/হোল্ডিং: ..., গ্রাম/রাস্তা: ...' ek-line address -> dict
    (compose_address-er key: holding/village/mouza/post_office/postal_code
    /upozila/district)."""
    s = _bn_tidy(text)

    def grab(pat):
        m = re.search(pat, s)
        return (m.group(1).strip(" ,।;") if m else "")

    addr = {}
    holding = grab(r"বাসা\s*/\s*হোল্ডিং\s*[:ঃ]*\s*(.*?)"
                   r"(?=\s*,\s*গ্রাম\s*/\s*রাস্তা|$)")
    village = grab(r"গ্রাম\s*/\s*রাস্তা\s*[:ঃ]*\s*(.*?)"
                   r"(?=\s*,\s*(?:ওয়ার্ড|মৌজা|পোস্ট|থানা)|$)")
    ward = grab(r"ওয়ার্ড\s*নং\s*[:ঃ]*\s*([0-9০-৯]+)")
    mouza = grab(r"মৌজা\s*/\s*মহল্লা\s*[:ঃ]*\s*(.*?)"
                 r"(?=\s*,\s*(?:পোস্ট|থানা|উপজেলা)|$)")
    postal = grab(r"পোস্ট\s*কোড\s*[:ঃ]*\s*([0-9০-৯]+)")
    # ডাকঘর na thakle post office khali — থানা ke ডাকঘর dhoro NA
    post_office = grab(r"ডাকঘর\s*[:ঃ]*\s*(.*?)"
                       r"(?=\s*,\s*|\s+-\s*|\s*[0-9০-৯]|$)")
    thana = grab(r"থানা\s*[:ঃ]*\s*(.*?)(?=\s*,\s*উপজেলা|$)")
    upozila = grab(r"উপজেলা\s*[:ঃ]*\s*(.*?)(?=\s*,\s*জেলা|$)")
    district = grab(r"(?<![\u0980-\u09FF])জেলা\s*[:ঃ]*\s*(.*?)"
                    r"(?=\s*,\s*বিভাগ|[।]|$)")
    division = grab(r"বিভাগ\s*[:ঃ]*\s*(.*?)(?=[।]|$)")

    # parenthetical ward-note (e.g. "(৫ নং ওয়ার্ড ... অংশ)") গ্রামের
    # স্ট্রিং-এই থাকে — sample রিপোর্টেও এটা গ্রাম/রাস্তার সাথেই বসে
    if mouza and mouza in [p.strip() for p in village.split(",")]:
        # গ্রামের স্ট্রিংয়েই মৌজা আছে — আবার বসালে ডুপ্লিকেট হবে
        mouza = ""

    if holding:
        addr["holding"] = holding
    if village:
        addr["village"] = village
    if ward:
        addr["ward_porishod"] = ward
    if mouza:
        addr["mouza"] = mouza
    if post_office:
        addr["post_office"] = post_office
    if postal:
        addr["postal_code"] = postal
    if thana:
        addr["thana"] = thana
    if upozila:
        addr["upozila"] = upozila
    if district:
        addr["district"] = district
    if division:
        addr["division"] = division
    return addr


def parse_report_pages(pages_spans):
    """BEC report printout (v1/v2) reader: Bangla label cell -> right value.
    Returns (flat, present_addr, perm_addr)."""
    norm_map = {_bn_label_norm(k): v for k, v in _REPORT_LABELS.items()}
    addr_heads = {"বর্তমান ঠিকানা": "present", "স্থায়ী ঠিকানা": "perm"}
    flat, present, perm = {}, {}, {}
    for spans in pages_spans:
        rows = _report_rows(spans)
        n = len(rows)
        i = 0
        while i < n:
            cells = _row_cells(rows[i]["spans"])
            head = _bn_label_norm(cells[0]["text"]) if cells else ""
            if head in addr_heads:
                j = i + 1
                lines = []
                while j < n:
                    cs = _row_cells(rows[j]["spans"])
                    t0 = _bn_label_norm(cs[0]["text"]) if cs else ""
                    if t0 in addr_heads or t0.startswith("উপরে"):
                        break
                    line = " ".join(c["text"] for c in cs).strip()
                    if line.startswith("This is Software Generated"):
                        break
                    if line:
                        lines.append(line)
                    j += 1
                addr = parse_bn_address_text(" ".join(lines))
                if addr:
                    (present if addr_heads[head] == "present" else perm).update(addr)
                i = j
                continue
            if head in norm_map and len(cells) > 1:
                val = " ".join(c["text"] for c in cells[1:]).strip()
                if val:
                    flat.setdefault(norm_map[head], val)
            else:
                # row-er 1st cell value-o hote pare (v2: ছবির নিচে নাম,
                # তারপর লেবেল, তারপর মান) — row-er ভিতরে label খুঁজো
                lab_i = next((ci for ci, c in enumerate(cells)
                              if _bn_label_norm(c["text"]) in norm_map), None)
                if lab_i is not None and lab_i + 1 < len(cells):
                    key = norm_map[_bn_label_norm(cells[lab_i]["text"])]
                    val = " ".join(c["text"] for c in cells[lab_i + 1:]).strip()
                    if val:
                        flat.setdefault(key, val)
            i += 1
    return flat, present, perm


def classify_input_image(w, h):
    if w <= 0 or h <= 0:
        return "other"
    r = w / h
    if 0.5 <= r < 1.3:
        return "photo"
    if 1.3 <= r <= 4.5:
        return "sign"
    return "other"


def extract(pdf_path="input.pdf", work_dir="work"):
    """Extract form fields + photo/signature. Returns (data_dict, images_dict)."""
    if not os.path.exists(pdf_path):
        raise FileNotFoundError("NOT FOUND: " + pdf_path)
    img_dir = os.path.join(work_dir, "images")
    os.makedirs(img_dir, exist_ok=True)
    # Stale image leak fix: ager PDF-er photo/sign ekhane thake gele notun
    # card-e oi chobi chole ashe — protyek extract-e age clear koro.
    for fn in os.listdir(img_dir):
        if fn.lower().endswith(".png"):
            try:
                os.remove(os.path.join(img_dir, fn))
            except OSError:
                pass
    doc = pymupdf.open(pdf_path)
    global _DOC
    _DOC = doc

    data = {}
    n_text = 0
    all_spans = []
    pages_spans = []
    page_heights = {}
    for pno, page in enumerate(doc):
        spans = get_spans(page, pno)
        if len(spans) < 5:
            # scanned page (text layer nei) -> OCR fallback
            ocr_spans = ocr_page_spans(page, pno)
            if ocr_spans:
                spans = _coalesce_fragments(spans + ocr_spans)
        # CID-font mojibake repair: broken ToUnicode-e Bengali paint thik
        # kintu text garbage — crop+OCR diye real text boshao (permanent)
        spans = _repair_cid_spans(page, spans)
        all_spans.extend(spans)
        pages_spans.append(spans)
        page_heights[pno] = page.rect.height
        n_text += len(spans)
        for i, b in enumerate(spans):
            label = b["text"].strip()
            is_ocr = bool(b.get("ocr"))

            # Label-alone check FIRST (complete 'Father Name' etc). Comb
            # agekhe thakle short VALUE ('ময়া') false-comb label-e match
            # kore field skip kore — oi bug fix.
            anchor = b
            label_std = std_label(label, LABEL_SET, is_ocr)
            if not label_std and i + 1 < len(spans):
                # 2-span split label (e.g. "Mother" + "Name")
                comb = label + " " + spans[i+1]["text"].strip()
                comb_std = std_label(comb, LABEL_SET,
                                     is_ocr or bool(spans[i+1].get("ocr")))
                if comb_std:
                    label_std = comb_std
                    anchor = spans[i+1]
            if not label_std and i + 2 < len(spans):
                # 3-span split label
                comb2 = (label + " " + spans[i+1]["text"].strip()
                         + " " + spans[i+2]["text"].strip())
                comb2_std = std_label(comb2, LABEL_SET, is_ocr)
                if comb2_std:
                    label_std = comb2_std
                    anchor = spans[i+2]
            if not label_std or label_std in data:
                continue
            if label_std in SKIP_GENERIC:
                continue  # টেবিল-সেকশন: আলাদা পার্স হবে
            val = right_value(anchor, spans, LABEL_SET | SIDEBAR_STOP)
            if val:
                data[label_std] = val

    # Present Address টেবিল -> ঠিকানার অংশ (+ Permanent fallback)
    addr = parse_present_address(all_spans, page_heights)
    if addr:
        data["Present Address"] = addr
    perm = parse_address_table(all_spans, page_heights,
                               anchor="Permanent Address")
    if perm:
        data["Permanent Address"] = perm

    # Voter printout fallback (vertical label->value, side-by-side na):
    # shudhu MISSING key fill koro — main extraction thakle oi data-i thakbe.
    try:
        vflat, vpresent, vperm = parse_vertical_kv_pages(pages_spans)
        for k, v in vflat.items():
            if k not in data or not data[k]:
                data[k] = v
        for key, vdict in (("Present Address", vpresent),
                           ("Permanent Address", vperm)):
            if not vdict:
                continue
            cur = data.get(key)
            if not cur:
                data[key] = vdict
            else:
                for k, v in vdict.items():
                    if not cur.get(k):
                        cur[k] = v
    except Exception:
        pass

    # BEC report printout (v1/v2) — Bangla label table, value same line-e.
    # Shudhu MISSING key fill koro (form extraction thakle oi data-i thakbe).
    try:
        rflat, rpresent, rperm = parse_report_pages(pages_spans)
        for k, v in rflat.items():
            if k not in data or not data[k]:
                data[k] = v
        for key, vdict in (("Present Address", rpresent),
                           ("Permanent Address", rperm)):
            if not vdict:
                continue
            cur = data.get(key)
            if not cur:
                data[key] = vdict
            else:
                for k, v in vdict.items():
                    if not cur.get(k):
                        cur[k] = v
    except Exception:
        pass

    images = {}
    for pno, page in enumerate(doc):
        try:
            pg_area = page.rect.width * page.rect.height
        except Exception:
            pg_area = 0
        for i, img in enumerate(page.get_images(full=True)):
            xref, smask = img[0], img[1]
            w_px = img[2] if len(img) > 2 else 0
            h_px = img[3] if len(img) > 3 else 0
            # full-page scan image-ke photo/sign dhoro NA (80%+ area)
            # (get_image_bbox-e tuple lage — int xref-e "bad image name" dey)
            try:
                ibb = page.get_image_bbox(img)
                if ibb and pg_area and (ibb.width * ibb.height) / pg_area > 0.8:
                    continue
            except Exception:
                pass
            kind = classify_input_image(w_px, h_px)
            if kind == "other" or kind in images:
                continue
            pix = pymupdf.Pixmap(doc, xref)
            if smask:  # soft-mask থাকলে স্বচ্ছতা (alpha) ধরে রাখো
                m = pymupdf.Pixmap(doc, smask)
                if m.n > 1:
                    m = pymupdf.Pixmap(pymupdf.csGRAY, m)
                if pix.n > 4:
                    pix = pymupdf.Pixmap(pymupdf.csRGB, pix)
                pix = pymupdf.Pixmap(pix, m)
            elif pix.n > 4:
                pix = pymupdf.Pixmap(pymupdf.csRGB, pix)
            fname = os.path.join(work_dir, "images", "%s.png" % kind)
            pix.save(fname)
            images[kind] = fname

    # v1 report input hole footer URL theke server id-o nao (v1 URL-e &id= thake)
    try:
        for p in doc:
            mt = re.search(r"[?&]id=(\d+)", p.get_text())
            if mt:
                data.setdefault("Report Id", mt.group(1))
                break
    except Exception:
        pass

    # Spelling repair pass — sample PDF-er bhul spelling/shaping thakleo
    # output value canonical hobe (name, address, place sob).
    data = _clean_data(data)
    data["_address_lines"] = review_addresses(data)

    with open(os.path.join(work_dir, "input_data.json"), "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    with open(os.path.join(work_dir, "input_images.json"), "w", encoding="utf-8") as f:
        json.dump(images, f, ensure_ascii=False, indent=1)

    return data, images


def main():
    pdf_path = sys.argv[1] if len(sys.argv) > 1 else "input.pdf"
    data, images = extract(pdf_path, "work")
    print("Done: images=%s -> work/input_data.json" % list(images))


if __name__ == "__main__":
    main()
