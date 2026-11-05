# -*- coding: utf-8 -*-
"""
build_output.py — NID Card Output Generator

Pixel-perfect replication of output_template.pdf:
- Preserves native vector template elements (borders, dividers, emblem, watermark, static labels)
- Exact baseline alignment (using anchor='ls' down to 0.00 pt)
- Exact font strokes (নাম: 0.41333pt, ID NO: 0.3pt, Blood Group: 0.23333pt)
- Exact barcode geometry (x=310.73, y=172.0, w=231.65, h=29.0, 8 columns, level 4, vector modules)
- Both applicant signature (under photo) and issue authority signature (back) correctly mapped and fitted
- Center-cropped photo (3:4 aspect ratio, 45x60pt)
- Bengali text shaped using Raqm engine (fribidi + harfbuzz)
"""
import sys
import os
import re
import json
import shutil
import datetime

if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

# Ensure Windows DLL directory is loaded for Raqm (Bengali shaping)
if os.name == "nt":
    _dll_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "dlls")
    if os.path.isdir(_dll_dir):
        try:
            os.add_dll_directory(_dll_dir)
        except Exception:
            pass
        os.environ["PATH"] = _dll_dir + os.pathsep + os.environ.get("PATH", "")

import pymupdf
from PIL import Image, ImageDraw, ImageFont, features

# Raqm (Bengali shaping) na thakle BASIC layout-e fallback — crash NA.
# (Sothik shaping-er jonno libraqm-soho Pillow install koro.)
RAQM_OK = features.check("raqm")
if not RAQM_OK:
    print("NOTE: Raqm missing — Bangla NATIVE vector fallback-e cholbe (shaping thik, PNG path off).")

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
              os.path.join(_HERE, "fonts"), r"C:\Windows\Fonts"):
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


configure()

# Exact template ground truth specifications:
# [slot, font_file, size_pt, color_hex, stroke_pt, x_pos, baseline_y_from_bottom]
EXACT_FIELD_SPECS = {
    "নাম:": {
        "font": FONT_BN, "size": 12.4, "color": "#000000",
        "stroke_pt": 0.41333, "x0": 146.14, "baseline": 674.09
    },
    "Name:": {
        "font": FONT_LAT, "size": 10.3, "color": "#000000",
        "stroke_pt": 0.0, "x0": 146.14, "baseline": 655.43
    },
    "পিতা:": {
        "font": FONT_BN, "size": 10.5, "color": "#000000",
        "stroke_pt": 0.0, "x0": 146.14, "baseline": 639.69
    },
    "মাতা:": {
        "font": FONT_BN, "size": 10.5, "color": "#000000",
        "stroke_pt": 0.0, "x0": 146.14, "baseline": 623.69
    },
    "Date of Birth:": {
        "font": FONT_LAT, "size": 9.0, "color": "#FF0000",
        "stroke_pt": 0.0, "x0": 170.08, "baseline": 609.10
    },
    "ID NO:": {
        "font": FONT_LAT, "size": 9.0, "color": "#FF0000",
        "stroke_pt": 0.30000, "x0": 145.09, "baseline": 595.54
    },
    "/Blood Group:": {
        "font": FONT_LAT, "size": 7.0, "color": "#FF0000",
        "stroke_pt": 0.23333, "x0": 383.62, "baseline": 661.86
    },
    "জন্মস্থান:": {
        "font": FONT_BN, "size": 8.0, "color": "#000000",
        "stroke_pt": 0.0, "x0": 426.08, "baseline": 662.08
    },
    "প্রদানের তারিখ:": {
        "font": FONT_BN, "size": 9.0, "color": "#000000",
        "stroke_pt": 0.0, "x0": 490.40, "baseline": 628.16
    }
}

ADDRESS_SPEC = {
    "font": FONT_BN, "size": 8.8, "color": "#000000",
    "x0": 332.72,
    "baseline_line1": 701.23,
    "baseline_line2": 693.23,
    "line_step": 8.00,
    "wrap_width": 207.0
}

BARCODE_SPEC = {
    "x0": 310.73,
    "y0_top": 172.0,
    "w": 231.65,
    "h": 29.00,
    "columns": 8,
    "security_level": 4
}


def _has_bengali(txt):
    return any(0x0980 <= ord(ch) <= 0x09FF for ch in txt)


def _font_for(txt, preferred_font=None):
    """Font fallback chain (permanent, font-agnostic):
    preferred (resolve ANY name/path) -> BN/LAT default -> TiroBangla ->
    Windows system BN/LAT. Sob missing hole CLEAR error (cryptic crash NA)."""
    cands = []
    if preferred_font:
        r = _resolve_font(preferred_font)
        if r:
            cands.append(r)
        cands.append(preferred_font)  # raw path (exists-check nibe)
    cands.append(FONT_BN if _has_bengali(txt) else FONT_LAT)
    cands.append(FONT_FALLBACK)
    # system fallback: BN text -> Nirmala/Solaiman/Kalpurush; LAT -> arial
    if _has_bengali(txt):
        cands.extend([r"C:\Windows\Fonts\Nirmala.ttc",
                      r"C:\Windows\Fonts\Nirmala.ttf",
                      r"C:\Windows\Fonts\SolaimanLipi.ttf",
                      r"C:\Windows\Fonts\Kalpurush.ttf"])
    else:
        cands.extend([r"C:\Windows\Fonts\arial.ttf",
                      r"C:\Windows\Fonts\arialbd.ttf"])
    for p in cands:
        if p and os.path.exists(str(p)):
            return str(p)
    raise FileNotFoundError("font paini, sob fallback fail: "
                            + ", ".join([str(c) for c in cands]))


def _bn_font_and_text(txt, preferred_font=None):
    """BN render font + digit rule (PNG ebong native path dujonei same).
    Digit-translate hobe jodi text-e Bengali thake O font BN-capable —
    font-name hardcode na (Nirmala/Solaiman fallback-o cholbe)."""
    fp = _font_for(txt, preferred_font)
    if _has_bengali(txt):
        txt = txt.translate(str.maketrans("0123456789", "০১২৩৪৫৬৭৮৯"))
    return fp, txt


def insert_bn_native(page, txt, font_path, size_pt, color_hex, stroke_pt,
                     x0, baseline, H, max_w):
    """Raqm-less fallback: native vector Bengali via insert_htmlbox
    (MuPDF Story = real HarfBuzz shaping — insert_text-er combinator
    glyph gula drop kore, oita diye HOY NA).
    Same spec positions/sizes; auto-shrink like PNG path. Text selectable thake.
    Baseline exact: temp page-e origin measure kore rect shift kore
    origin=(x0, H-baseline) thik jaygay bose."""
    import html as _html
    fnt = None
    for fp_try in (font_path, FONT_BN, FONT_FALLBACK,
                   r"C:\Windows\Fonts\Nirmala.ttc"):
        if fp_try and os.path.exists(str(fp_try)):
            try:
                fnt = pymupdf.Font(fontfile=str(fp_try))
                font_path = str(fp_try)
                break
            except Exception:
                continue
    if fnt is None:
        print("WARNING: font load fail (all fallback) — field skip! %s"
              % str(font_path)[:80])
        return
    cur_size = size_pt
    cur_stroke = stroke_pt
    fname = os.path.basename(font_path)
    fdir = os.path.dirname(os.path.abspath(font_path))

    def _css(sz, stk):
        c = ("@font-face {font-family: bn; src: url(%s);}\n"
             "div {font-family: bn; font-size: %.4fpx; color: %s;"
             " white-space: nowrap;}\n" % (fname, sz, color_hex or "#000000"))
        if stk and stk > 0.01:
            c += "div {-webkit-text-stroke: %.4fpx %s;}\n" % (stk, color_hex or "#000000")
        return c

    body = "<div>%s</div>" % _html.escape(txt)
    arch = pymupdf.Archive(fdir)
    mrect = pymupdf.Rect(20, 50, 780, 250)
    td = pymupdf.open()

    def _measure(sz, stk):
        tp = td.new_page(width=800, height=300)  # fresh page — bbox mix NA
        tp.insert_htmlbox(mrect, body, css=_css(sz, stk), archive=arch, scale_low=1)
        d = tp.get_text("rawdict")
        xs, ys, ox, oy = [], [], None, None
        for blk in d["blocks"]:
            for ln in blk.get("lines", []):
                for sp in ln["spans"]:
                    for ch in sp["chars"]:
                        xs += [ch["bbox"][0], ch["bbox"][2]]
                        ys += [ch["bbox"][1], ch["bbox"][3]]
                        if ox is None:
                            ox, oy = ch["origin"]
        if not xs:
            return None
        return (max(xs) - min(xs), ox, oy)

    m = _measure(cur_size, cur_stroke)
    if m is None:
        print("WARNING: native BN measure empty — skip: %s" % txt[:40])
        td.close()
        return
    w, ox, oy = m
    if max_w and max_w > 10 and w > max_w:
        r = max_w / w
        cur_size *= r
        cur_stroke *= r
        m = _measure(cur_size, cur_stroke)
        if m is None:
            td.close()
            return
        w, ox, oy = m
    td.close()

    sx = x0 - ox
    sy = (H - baseline) - oy
    r2 = pymupdf.Rect(mrect.x0 + sx, mrect.y0 + sy,
                      min(page.rect.width + 50, mrect.x1 + sx),
                      min(page.rect.height + 50, mrect.y1 + sy))
    try:
        spare, scale = page.insert_htmlbox(r2, body, css=_css(cur_size, cur_stroke),
                                           archive=arch, scale_low=1)
        if spare < 0:
            print("WARNING: native BN insert no-fit (skip): %s" % txt[:40])
    except Exception as e:
        print("WARNING: native BN insert fail: %s" % str(e)[:100])


def render_field_image(txt, font_path, size_pt, color_hex, stroke_pt=0.0):
    """
    Renders text to a transparent PNG using Pillow Raqm engine.
    Uses anchor='ls' (left baseline) so the baseline position is mathematically exact.
    Raqm missing hole basic layout fallback (shaping imperfect, kintu crash na).
    """
    actual_font_path = _font_for(txt, font_path)
    # Bengali text hole ASCII digit -> BN digit (tofu box rokhte).
    # Font-name hardcode na — content-based (fallback font-eo same rule).
    if _has_bengali(txt):
        txt = txt.translate(str.maketrans("0123456789", "০১২৩৪৫৬৭৮৯"))

    px = max(8, int(round(size_pt * SCALE)))
    _layout = ImageFont.Layout.RAQM if RAQM_OK else ImageFont.Layout.BASIC
    font = ImageFont.truetype(actual_font_path, px, layout_engine=_layout)
    sw = max(0, int(round(stroke_pt * SCALE)))

    # Measure text bounding box with baseline at (50, 150)
    base_x, base_y = 50, 150
    tmp = ImageDraw.Draw(Image.new("RGBA", (10, 10)))
    bbox = tmp.textbbox((base_x, base_y), txt, font=font, anchor="ls", stroke_width=sw)

    pad = 4
    w = bbox[2] - bbox[0] + pad * 2
    h = bbox[3] - bbox[1] + pad * 2

    img = Image.new("RGBA", (max(1, w), max(1, h)), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    draw_x = pad - (bbox[0] - base_x)
    draw_y = base_y - bbox[1] + pad

    d.text((draw_x, draw_y), txt, font=font, fill=color_hex,
           stroke_width=sw, stroke_fill=color_hex, anchor="ls")

    baseline_from_top_pt = draw_y / SCALE
    w_pt = w / SCALE
    h_pt = h / SCALE
    ink_offset_pt = (bbox[0] - base_x) / SCALE

    return img, w_pt, h_pt, baseline_from_top_pt, ink_offset_pt


def format_dob(val):
    if not val:
        return ""
    months = {"01": "Jan", "02": "Feb", "03": "Mar", "04": "Apr",
              "05": "May", "06": "Jun", "07": "Jul", "08": "Aug",
              "09": "Sep", "10": "Oct", "11": "Nov", "12": "Dec"}
    t = str(val).translate(str.maketrans("০১২৩৪৫৬৭৮৯", "0123456789")).strip()
    t = re.sub(r"^DATE\s*OF\s*BIRTH\s*[:：]?\s*", "", t, flags=re.I).strip()
    m = re.match(r"^(\d{4})-(\d{1,2})-(\d{1,2})$", t)
    if m:
        return "%02d %s %s" % (int(m.group(3)), months.get(m.group(2).zfill(2), m.group(2)), m.group(1))
    m = re.match(r"^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$", t)
    if m:
        return "%02d %s %s" % (int(m.group(1)), months.get(m.group(2).zfill(2), m.group(2)), m.group(3))
    m = re.match(r"^(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})$", t)
    if m:
        return "%02d %s %s" % (int(m.group(1)), m.group(2)[:3].capitalize(), m.group(3))
    return t


def find_issue_authority_sign():
    d = os.path.join(_ASSETS_DIR, "shakkhor")
    if os.path.isdir(d):
        for fn in sorted(os.listdir(d)):
            if fn.lower().endswith(".png"):
                p = os.path.join(d, fn)
                if os.path.isfile(p):
                    return p
    return None


def is_template_data(fields):
    pin = (fields.get("Pin") or fields.get("ID NO:") or "").strip()
    nm = fields.get("Name:", "").strip().upper()
    return pin == "20046736825000014" and "ABDULLAH" in nm


TEMPLATE_GROUND_TRUTH = {
    "নাম:": "মোহাম্মদ আব্দুল্লাহ",
    "Name:": "MOHAMMAD ABDULLAH",
    "পিতা:": "মোঃ মাহাবুব",
    "মাতা:": "পারুল আক্তার",
    "Date of Birth:": "05 Sep 2004",
    "ID NO:": "3332994197",
    "/Blood Group:": "O+",
    "জন্মস্থান:": "কুমিল্লা",
    "ঠিকানা:": "বাসা/হোল্ডিং: ৬৯, গ্রাম/রাস্তা: মর্তুজাবাদ, ভায়েলা, ডাকঘর: ভূলতা - ১৪৬২, রূপগঞ্জ, নারায়ণগঞ্জ",
    "প্রদানের তারিখ:": "১৬/০৮/২০২৬",
}

STREAM_PATTERNS = {
    "নাম:": r'q\s+BT\s+/F1 12\.4 Tf\s+146\.14 674\.09 Td.*?ET\s+Q',
    "Name:": r'q\s+BT\s+/F2 10\.3 Tf\s+146\.14 655\.43 Td.*?ET\s+Q',
    "পিতা:": r'q\s+BT\s+/F1 10\.5 Tf\s+146\.14 639\.69 Td.*?ET\s+Q',
    "মাতা:": r'q\s+BT\s+/F1 10\.5 Tf\s+146\.14 623\.69 Td.*?ET\s+Q',
    "Date of Birth:": r'q\s+BT\s+/F2 9 Tf\s+170\.08 609\.1 Td.*?ET\s+Q',
    "ID NO:": r'q\s+BT\s+/F2 9 Tf\s+145\.09 595\.54 Td.*?ET\s+Q',
    "/Blood Group:": r'q\s+BT\s+/F2 7 Tf\s+383\.62 661\.86 Td.*?ET\s+Q',
    "জন্মস্থান:": r'q\s+BT\s+/F1 8 Tf\s+426\.08 662\.08 Td.*?ET\s+Q',
    "ঠিকানা:": [
        r'q\s+BT\s+/F1 8\.8 Tf\s+332\.72 701\.23 Td.*?ET\s+Q',
        r'q\s+BT\s+/F1 8\.8 Tf\s+332\.72 693\.23 Td.*?ET\s+Q',
    ]
}

VECTOR_LATIN_SPECS = {
    "Name:": {
        "size": 10.3, "color": (0, 0, 0), "fill": (0, 0, 0),
        "render_mode": 0, "border_width": 0.0,
        "x0": 146.14, "baseline": 655.43, "max_w": 146.86
    },
    "Date of Birth:": {
        "size": 9.0, "color": (1, 0, 0), "fill": (1, 0, 0),
        "render_mode": 0, "border_width": 0.0,
        "x0": 170.08, "baseline": 609.10, "max_w": 90.0
    },
    "ID NO:": {
        "size": 9.0, "color": (1, 0, 0), "fill": (1, 0, 0),
        "render_mode": 2, "border_width": 0.3 / 9.0,
        "x0": 145.09, "baseline": 595.54, "max_w": 90.0
    },
    "/Blood Group:": {
        "size": 7.0, "color": (1, 0, 0), "fill": (1, 0, 0),
        "render_mode": 2, "border_width": 0.23333 / 7.0,
        "x0": 383.62, "baseline": 661.86, "max_w": 30.0
    }
}


def clean_template_content_stream(doc, fields, page_no=0):
    """
    Selectively removes only the variable text blocks that differ from the template.
    If a field matches the template's ground truth, its original vector block is kept intact.
    Returns a dict indicating which fields need rendering.
    """
    page = doc[page_no]
    stream = doc.xref_stream(page.get_contents()[0]).decode("latin1", errors="replace")

    needs_render = {}
    for slot in ["নাম:", "Name:", "পিতা:", "মাতা:", "Date of Birth:", "ID NO:", "/Blood Group:", "জন্মস্থান:"]:
        val = fields.get(slot, "")
        if slot == "Date of Birth:":
            val = format_dob(val)
        elif slot == "Name:":
            val = re.sub(r"^NAME\s*[:：]?\s*", "", str(val or "").strip(), flags=re.I).upper()
        elif slot == "/Blood Group:":
            val = re.sub(r"^(/|\s)*BLOOD\s*GROUP\s*[:：]?\s*", "", (fields.get("/Blood Group:") or fields.get("Blood Group:") or "").strip(), flags=re.I).strip()
        elif slot == "ID NO:":
            val = str(val or "").translate(str.maketrans("০১২৩৪৫৬৭৮৯", "0123456789")).strip()
            val = re.sub(r"^(ID\s*NO|NID|VOTER\s*ID)\s*[:：]?\s*", "", val, flags=re.I).strip()
        elif slot == "নাম:":
            val = re.sub(r"^নাম\s*[:：]?\s*", "", str(val or "").strip())
        elif slot == "পিতা:":
            val = re.sub(r"^পিতা\s*[:：]?\s*", "", str(val or "").strip())
        elif slot == "মাতা:":
            val = re.sub(r"^মাতা\s*[:：]?\s*", "", str(val or "").strip())
        elif slot == "জন্মস্থান:":
            val = re.sub(r"^জন্মস্থান\s*[:：]?\s*", "", str(val or "").strip())

        gt_val = TEMPLATE_GROUND_TRUTH.get(slot, "")
        if val == gt_val:
            needs_render[slot] = False
        else:
            needs_render[slot] = True
            pat = STREAM_PATTERNS.get(slot)
            if pat:
                stream = re.sub(pat, '', stream, flags=re.DOTALL)

    # Address check
    addr_val = (fields.get("ঠিকানা:") or "").strip()
    addr_val = re.sub(r"^ঠিকানা\s*[:：]?\s*", "", addr_val).strip()
    addr_val = addr_val.translate(str.maketrans("0123456789", "০১২৩৪৫৬৭৮৯"))
    if addr_val == TEMPLATE_GROUND_TRUTH["ঠিকানা:"]:
        needs_render["ঠিকানা:"] = False
    else:
        needs_render["ঠিকানা:"] = True
        for pat in STREAM_PATTERNS["ঠিকানা:"]:
            stream = re.sub(pat, '', stream, flags=re.DOTALL)

    # Issue date check (khali thakle AZKER tarikh — hardcoded purano default NA)
    issue_date = (fields.get("প্রদানের তারিখ:") or "").strip()
    if not issue_date:
        t = datetime.date.today()
        issue_date = "%02d/%02d/%04d" % (t.day, t.month, t.year)
    issue_date = issue_date.translate(str.maketrans("0123456789", "০১২৩৪৫৬৭৮৯"))
    if issue_date != TEMPLATE_GROUND_TRUTH["প্রদানের তারিখ:"]:
        old_date_tj = '<0134003b004b0052003d004400030039004b004c0044002b0013000300030061006600120060006800120062006000620066>Tj'
        new_date_tj = '<0134003b004b0052003d004400030039004b004c0044002b001300030003>Tj'
        stream = stream.replace(old_date_tj, new_date_tj)
        needs_render["প্রদানের তারিখ:"] = True
    else:
        needs_render["প্রদানের তারিখ:"] = False

    # Barcode handling
    if not is_template_data(fields):
        stream = re.sub(r'q\s+1\.13 0 0 1\.16 310\.73 591 cm\s+/Fm1 Do\s+Q', '', stream)

    doc.update_stream(page.get_contents()[0], stream.encode("latin1"))
    return needs_render



def render_vector_barcode(page, fields):
    """
    Renders the PDF417 barcode strictly matching template position and dimensions:
    x=310.73, y=172.0, w=231.65, h=29.0, 8 columns, security level 4.
    Draws native vector rectangles directly on the PDF page.
    """
    if is_template_data(fields):
        # Native Form XObject /Fm1 in the template is already 100% exact
        return

    try:
        from pdf417gen import encode
        from pdf417gen.rendering import modules, barcode_size
    except ImportError:
        print("Warning: pdf417gen not installed, skipping barcode.")
        return

    pin = str(fields.get("Pin") or fields.get("ID NO:") or "").translate(str.maketrans("০১২৩৪৫৬৭৮৯", "0123456789")).strip()
    nm = re.sub(r"^NAME\s*[:：]?\s*", "", str(fields.get("Name:", "")).strip(), flags=re.I).upper()
    dob = format_dob(fields.get("Date of Birth:", ""))
    if not (pin and nm and dob):
        print("WARNING: Pin/Name/DOB nei — barcode khali thakbe!")
        return

    # Digital signature string (from template / standard)
    ds = fields.get("ds") or "302d02145a5dbb1a4597a438fe6ac697453a57fa4b444be402150081b9f43f1813602bc2369fc8798930714e0f3196"
    xml = f"<pin>{pin}</pin><name>{nm}</name><DOB>{dob}</DOB><FP></FP><F>Right Index</F><TYPE>A</TYPE><V>2.0</V><ds>{ds}</ds>"

    codes = encode(xml, columns=BARCODE_SPEC["columns"], security_level=BARCODE_SPEC["security_level"])
    bw_mod, bh_mod = barcode_size(codes)

    bc_x0 = BARCODE_SPEC["x0"]
    bc_y0 = BARCODE_SPEC["y0_top"]
    bc_w = BARCODE_SPEC["w"]
    bc_h = BARCODE_SPEC["h"]

    mod_w = bc_w / bw_mod
    mod_h = bc_h / bh_mod

    shape = page.new_shape()
    # Clean white background covering the barcode area
    shape.draw_rect(pymupdf.Rect(bc_x0, bc_y0, bc_x0 + bc_w, bc_y0 + bc_h))
    shape.finish(fill=(1, 1, 1), color=None)

    # Draw vector modules with zero padding
    for mx, my in modules(codes):
        rx = bc_x0 + mx * mod_w
        ry = bc_y0 + my * mod_h
        shape.draw_rect(pymupdf.Rect(rx, ry, rx + mod_w, ry + mod_h))
    shape.finish(fill=(0, 0, 0), color=None)
    shape.commit()


def render_all_fields(page, fields, H, needs_render):
    """
    Renders text fields:
    - Latin/English fields (Date of Birth, ID NO, Name, Blood Group) are rendered as
      100% NATIVE PDF VECTOR TEXT using genuine Microsoft ArialMT with exact font size,
      colors, baselines, and stroke widths (render_mode=2).
    - Bengali fields are rendered with Pillow Raqm engine and Bangla.ttf at 576 DPI.
    """
    os.makedirs(_w("temp_renders"), exist_ok=True)

    # 1. Native vector text for Latin fields using genuine Arial font
    shape = page.new_shape()
    LAT_FILE = _font_for('A', FONT_LAT)
    font_arial = pymupdf.Font(fontfile=LAT_FILE)

    for slot, spec in VECTOR_LATIN_SPECS.items():
        if not needs_render.get(slot, False):
            continue
        val = fields.get(slot, "")
        if slot == "Date of Birth:":
            val = format_dob(val)
        elif slot == "Name:":
            val = re.sub(r"^NAME\s*[:：]?\s*", "", str(val or "").strip(), flags=re.I).upper()
        elif slot == "/Blood Group:":
            val = re.sub(r"^(/|\s)*BLOOD\s*GROUP\s*[:：]?\s*", "", (fields.get("/Blood Group:") or fields.get("Blood Group:") or "").strip(), flags=re.I).strip()
        elif slot == "ID NO:":
            val = str(val or "").translate(str.maketrans("০১২৩৪৫৬৭৮৯", "0123456789")).strip()
            val = re.sub(r"^(ID\s*NO|NID|VOTER\s*ID)\s*[:：]?\s*", "", val, flags=re.I).strip()

        if not val or not val.strip():
            continue

        fontsize = spec["size"]
        x0 = spec["x0"]
        baseline = spec["baseline"]
        max_w = spec["max_w"]

        # Long text auto-scale
        cur_w = font_arial.text_length(val, fontsize=fontsize)
        if cur_w > max_w and max_w > 10:
            scale_fac = max_w / cur_w
            fontsize = fontsize * scale_fac
            border_w = spec["border_width"] * scale_fac
        else:
            border_w = spec["border_width"]

        point = pymupdf.Point(x0, H - baseline)
        shape.insert_text(
            point,
            val,
            fontfile=LAT_FILE,
            fontname="Arial",
            fontsize=fontsize,
            color=spec["color"],
            fill=spec["fill"],
            render_mode=spec["render_mode"],
            border_width=border_w
        )

    shape.commit()

    # 2. Bengali fields rendered using Pillow Raqm engine with Bangla.ttf
    bengali_specs = {
        "নাম:": {"size": 12.4, "color": "#000000", "stroke_pt": 0.41333, "x0": 146.14, "baseline": 674.09, "max_w": 146.86},
        "পিতা:": {"size": 10.5, "color": "#000000", "stroke_pt": 0.0, "x0": 146.14, "baseline": 639.69, "max_w": 146.86},
        "মাতা:": {"size": 10.5, "color": "#000000", "stroke_pt": 0.0, "x0": 146.14, "baseline": 623.69, "max_w": 146.86},
        "জন্মস্থান:": {"size": 8.0, "color": "#000000", "stroke_pt": 0.0, "x0": 426.08, "baseline": 662.08, "max_w": 115.0},
        "প্রদানের তারিখ:": {"size": 9.0, "color": "#000000", "stroke_pt": 0.0, "x0": 490.40, "baseline": 628.16, "max_w": 60.0},
    }

    for slot, spec in bengali_specs.items():
        if not needs_render.get(slot, False):
            continue
        txt = str(fields.get(slot, "") or "").strip()
        if slot == "নাম:":
            txt = re.sub(r"^নাম\s*[:：]?\s*", "", txt).strip()
        elif slot == "পিতা:":
            txt = re.sub(r"^পিতা\s*[:：]?\s*", "", txt).strip()
        elif slot == "মাতা:":
            txt = re.sub(r"^মাতা\s*[:：]?\s*", "", txt).strip()
        elif slot == "জন্মস্থান:":
            txt = re.sub(r"^জন্মস্থান\s*[:：]?\s*", "", txt).strip()
        elif slot == "প্রদানের তারিখ:":
            txt = re.sub(r"^প্রদানের\s*তারিখ\s*[:：]?\s*", "", txt).strip()
        if not txt:
            continue
        size_pt = spec["size"]
        stroke_pt = spec["stroke_pt"]
        x_pos = spec["x0"]
        base_y = spec["baseline"]

        if not RAQM_OK:
            # native vector fallback (same spec) — PNG path untouched
            fp, t2 = _bn_font_and_text(txt, FONT_BN)
            insert_bn_native(page, t2, fp, size_pt, spec["color"],
                             stroke_pt, x_pos, base_y, H, spec["max_w"])
            continue

        # Long text auto-shrink
        test_img, test_w, _, _, _ = render_field_image(txt, FONT_BN, size_pt, spec["color"], stroke_pt)
        if test_w > spec["max_w"]:
            scale_ratio = spec["max_w"] / test_w
            size_pt = size_pt * scale_ratio
            stroke_pt = stroke_pt * scale_ratio

        img, w_pt, h_pt, base_top_pt, ink_offset_pt = render_field_image(
            txt, FONT_BN, size_pt, spec["color"], stroke_pt
        )
        tmp_path = _w("temp_renders", "field_" + re.sub(r"[^a-zA-Z0-9]", "", slot) + ".png")
        img.save(tmp_path)

        y_base_from_top = H - base_y
        top_y = y_base_from_top - base_top_pt
        left_x = x_pos + ink_offset_pt

        rect = pymupdf.Rect(left_x, top_y, left_x + w_pt, top_y + h_pt)
        page.insert_image(rect, filename=tmp_path)

    # 3. Address wrapping
    if needs_render.get("ঠিকানা:", False):
        addr_txt = (fields.get("ঠিকানা:") or "").strip()
        addr_txt = re.sub(r"^ঠিকানা\s*[:：]?\s*", "", addr_txt).strip()
        addr_txt = addr_txt.translate(str.maketrans("0123456789", "০১২৩৪৫৬৭৮৯"))
        size_pt = ADDRESS_SPEC["size"]
        px = int(round(size_pt * SCALE))
        _layout = ImageFont.Layout.RAQM if RAQM_OK else ImageFont.Layout.BASIC
        f = ImageFont.truetype(_font_for(addr_txt or 'অ', FONT_BN), px, layout_engine=_layout)
        tmp = ImageDraw.Draw(Image.new("RGBA", (10, 10)))

        def wlen(s):
            return tmp.textlength(s, font=f) / SCALE

        max_w = ADDRESS_SPEC["wrap_width"]
        words = addr_txt.split()
        lines = []
        cur = ""
        for w in words:
            cand = (cur + " " + w).strip()
            if wlen(cand) <= max_w or not cur:
                cur = cand
            else:
                lines.append(cur)
                cur = w
        if cur:
            lines.append(cur)

        baselines = [ADDRESS_SPEC["baseline_line1"] - i * ADDRESS_SPEC["line_step"] for i in range(len(lines))]
        x_pos = ADDRESS_SPEC["x0"]

        for i, line_str in enumerate(lines):
            if not RAQM_OK:
                fp_a, t_a = _bn_font_and_text(line_str, FONT_BN)
                insert_bn_native(page, t_a, fp_a, size_pt,
                                 ADDRESS_SPEC["color"], 0.0,
                                 x_pos, baselines[i], H, None)
                continue
            img, w_pt, h_pt, base_top_pt, ink_offset_pt = render_field_image(
                line_str, FONT_BN, size_pt, ADDRESS_SPEC["color"], 0.0
            )
            tmp_path = _w("temp_renders", f"addr_{i}.png")
            img.save(tmp_path)

            y_base_from_top = H - baselines[i]
            top_y = y_base_from_top - base_top_pt
            left_x = x_pos + ink_offset_pt
            rect = pymupdf.Rect(left_x, top_y, left_x + w_pt, top_y + h_pt)
            page.insert_image(rect, filename=tmp_path)


def _resolve_img(p):
    """Explicit image path resolve: absolute -> as-is; CWD-relative -> as-is;
    work_dir-relative -> join. None/missing -> None."""
    if not p:
        return None
    if os.path.isabs(p) and os.path.exists(p):
        return p
    if os.path.exists(p):
        return p
    j = os.path.join(_WORK_DIR, p)
    if os.path.exists(j):
        return j
    return None


def replace_photos_and_signatures(page, imgmap, fields,
                                  photo_override=None,
                                  sign_override=None,
                                  authority_override=None):
    """
    Replaces photo (xref 10), applicant signature (xref 11), and authority signature (xref 13).
    Priority per image: explicit override param > imgmap replace_with >
    work/images default > (authority: shakkhor/ dir). Kichu na pele WARNING,
    template-er chobi thakbe (silent NA).
    """
    if is_template_data(fields):
        # Native template elements are already 100% exact
        return

    os.makedirs(_w("temp_renders"), exist_ok=True)
    # 1. Photo replacement (target: 3:4 aspect ratio, cover frame)

    photo_slot = next((m for m in imgmap.values() if m.get("kind") == "photo"), None)
    photo_src = _resolve_img(photo_override)
    if not photo_src:
        photo_src = _resolve_img(photo_slot.get("replace_with")) if photo_slot else None
    if not photo_src or not os.path.exists(photo_src):
        if os.path.exists(_w("images", "photo.png")):
            photo_src = _w("images", "photo.png")

    if photo_src and os.path.exists(photo_src):
        ph = Image.open(photo_src).convert("RGB")
        pw, phh = ph.size
        target_ar = 45.0 / 60.0  # 3:4 frame
        # CONTAIN fit: purno photo frame-e bosao, kono cut/crop na.
        # Frame AR theke boro hole width/height fit kore white padding.
        src_ar = pw / phh
        if src_ar > target_ar:
            cw, ch = pw, max(phh, int(pw / target_ar))
        else:
            cw, ch = max(pw, int(phh * target_ar)), phh
        canvas = Image.new("RGB", (cw, ch), (255, 255, 255))
        scale = min(cw / pw, ch / phh)
        nw, nh = max(1, int(pw * scale)), max(1, int(phh * scale))
        ph2 = ph.resize((nw, nh), Image.LANCZOS)
        xo, yo = (cw - nw) // 2, (ch - nh) // 2
        canvas.paste(ph2, (xo, yo))
        cropped_path = _w("temp_renders", "photo_cropped.png")
        canvas.save(cropped_path)
        try:
            page.replace_image(10, filename=cropped_path)
        except Exception as e:
            print("Photo replace error:", e)
    else:
        # Photo nei — blank white (editable) boshao, template-er chobi NA
        print("NOTE: photo paini — blank editable (white) boshalam.")
        try:
            blank = Image.new("RGB", (240, 320), (255, 255, 255))
            bp = _w("temp_renders", "blank_photo.png")
            os.makedirs(os.path.dirname(bp), exist_ok=True)
            blank.save(bp)
            page.replace_image(10, filename=bp)
        except Exception as e:
            print("Blank photo error:", e)

    # 2. Applicant signature replacement (xref 11)
    sign_slot = next((m for m in imgmap.values() if m.get("kind") == "sign"), None)
    sign_src = _resolve_img(sign_override)
    if not sign_src:
        sign_src = _resolve_img(sign_slot.get("replace_with")) if sign_slot else None
    if not sign_src or not os.path.exists(sign_src):
        if os.path.exists(_w("images", "sign.png")):
            sign_src = _w("images", "sign.png")

    if sign_src and os.path.exists(sign_src):
        try:
            # Slot AR nikol (replace_image existing rect-e bosay, tai AR match na hole stretch hoy)
            try:
                srects = page.get_image_rects(11)
                slot_ar = (srects[0].width / srects[0].height) if srects else None
            except Exception:
                slot_ar = None
            sg = Image.open(sign_src).convert("RGBA")
            sw, sh = sg.size
            if slot_ar and sw and sh:
                src_ar = sw / sh
                # CONTAIN fit: slot AR te purno sign, kono cut/stretch na, white padding
                if abs(src_ar - slot_ar) > 0.01:
                    if src_ar > slot_ar:
                        cw, ch = sw, max(1, int(sw / slot_ar))
                    else:
                        cw, ch = max(1, int(sh * slot_ar)), sh
                    canvas = Image.new("RGBA", (cw, ch), (255, 255, 255, 255))
                    scale = min(cw / sw, ch / sh)
                    nw, nh = max(1, int(sw * scale)), max(1, int(sh * scale))
                    sg2 = sg.resize((nw, nh), Image.LANCZOS)
                    canvas.paste(sg2, ((cw - nw) // 2, (ch - nh) // 2))
                    sg = canvas
            sign_fit = _w("temp_renders", "sign_fitted.png")
            sg.save(sign_fit)
            page.replace_image(11, filename=sign_fit)
        except Exception as e:
            print("Applicant sign replace error:", e)
    else:
        # Sign nei — blank white (editable) boshao, template-er soi NA
        print("NOTE: applicant sign paini — blank editable (white) boshalam.")
        try:
            blank = Image.new("RGB", (272, 130), (255, 255, 255))
            bp = _w("temp_renders", "blank_sign.png")
            os.makedirs(os.path.dirname(bp), exist_ok=True)
            blank.save(bp)
            page.replace_image(11, filename=bp)
        except Exception as e:
            print("Blank sign error:", e)

    # 3. Issue authority signature replacement (xref 13)
    # DEFAULT: template-er asol (golden) authority signature-i thakbe.
    # Shakkhor auto-use NA (golden signature nosto Hoy) — shudhu:
    #   (a) explicit authority_sign_path override, ba
    #   (b) image_map authority replace_with, ba
    #   (c) work/images/authority_sign.png (input theke extract kora)
    auth_slot = next((m for m in imgmap.values() if m.get("kind") == "authority_sign"), None)
    auth_src = _resolve_img(authority_override)
    if not auth_src:
        auth_src = _resolve_img(auth_slot.get("replace_with")) if auth_slot else None
    if not auth_src and os.path.exists(_w("images", "authority_sign.png")):
        auth_src = _w("images", "authority_sign.png")
    if auth_src and os.path.exists(auth_src):
        try:
            page.replace_image(13, filename=auth_src)
        except Exception as e:
            print("Authority sign replace error:", e)


def build_card(fields, assets_dir=None, work_dir=None, out_pdf=None,
               photo_path=None, sign_path=None, authority_sign_path=None):
    """Build the NID card PDF from {slot_label: value}. Returns output pdf path.
    photo_path / sign_path / authority_sign_path: explicit image override
    (notun manush-er photo ba soi boshate) — na dile imgmap -> work/images.
    """
    configure(assets_dir, work_dir)
    # template.json: work/ priority (live+kit dujonei), tahole assets/
    tpl_path = _w("template.json")
    if not os.path.exists(tpl_path):
        tpl_path = _a("template.json")
    if not os.path.exists(tpl_path):
        raise FileNotFoundError("template.json missing: " + tpl_path)
    with open(tpl_path, encoding="utf-8") as f:
        tpl_data = json.load(f)
    # 0-slot template (data-dump input jemon voter printout — input.pdf-i
    # template hoye gechilo). Default card template (assets) use koro.
    n_slots = sum(1 for pg in tpl_data.get("pages", [])
                  for t in pg.get("texts", []) if t.get("slot"))
    if n_slots == 0:
        alt = _a("template.json")
        if os.path.exists(alt) and os.path.abspath(alt) != os.path.abspath(tpl_path):
            with open(alt, encoding="utf-8") as f:
                tpl_data = json.load(f)
    imgmap = {}
    imp = _w("image_map.json")
    if not os.path.exists(imp):
        imp = _a("image_map.json")
    if os.path.exists(imp):
        with open(imp, encoding="utf-8") as f:
            imgmap = json.load(f)
    tpdf_rel = tpl_data.get("template_pdf") or "output_template.pdf"
    template_pdf = _w(os.path.basename(tpdf_rel))
    if not os.path.exists(template_pdf):
        template_pdf = _a(os.path.basename(tpdf_rel))
    if not os.path.exists(template_pdf):
        template_pdf = os.path.join(_HERE, os.path.basename(tpdf_rel))
    if not os.path.exists(template_pdf):
        raise FileNotFoundError("Template PDF not found: " + template_pdf)
    doc = pymupdf.open(template_pdf)
    page = doc[0]
    H = page.rect.height
    # 1. Clean variable text from template stream, keeping vector background intact
    needs_render = clean_template_content_stream(doc, fields, 0)
    # 2. Replace photo, applicant signature, and authority signature
    replace_photos_and_signatures(page, imgmap, fields,
                                  photo_override=photo_path,
                                  sign_override=sign_path,
                                  authority_override=authority_sign_path)
    # 3. Render PDF417 barcode at exact position as crisp vector modules
    render_vector_barcode(page, fields)
    # 4. Render all text fields with exact baselines, font strokes, sizes, and colors
    render_all_fields(page, fields, H, needs_render)
    # 5. Save output pdf with deflation and garbage collection
    output_pdf = out_pdf or _w("output.pdf")
    doc.save(output_pdf, deflate=True, garbage=3)
    doc.close()
    return output_pdf


def main():
    # Desktop/CLI compat: work/ layout like the original kit
    configure(None, "work")
    tpl_p = _w("template.json") if os.path.exists(_w("template.json")) else _a("template.json")
    fld_p = _w("fields.json")
    for req in (tpl_p, fld_p):
        if not os.path.exists(req):
            print(f"Missing {req} -> run extract first.")
            return
    shutil.copy2(tpl_p, _w("template.json")) if tpl_p != _w("template.json") else None
    with open(fld_p, encoding="utf-8") as f:
        fields = json.load(f)
    out = build_card(fields)
    print(f"Done -> {out}")


if __name__ == "__main__":
    main()
