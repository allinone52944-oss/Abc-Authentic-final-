# -*- coding: utf-8 -*-
"""
build_output_v2.py — NID smart card (front + back on one sheet) renderer.

Ei module ki kore:
  * output_template.pdf (notun NID card: front+back, MRZ, barcode) ke base dhore
  * template-er variable text (nam/pita/mata/DOB/NID/address/blood/birth place/
    issue date/MRZ) stream theke soriye fele — label/background/guilloche osomosto
  * notun man gulo template-er exact position, size, color-e bosay
  * photo (front + duita back photo), holder signature, barcode, DOB band replace kore

Smart-card engine (nid-smart-card) — v2 TEMPLATE ONLY. Purono template
(2-page card, "নাম:" / "ID NO:" style) ei engine-e nei.

Holder-signature slot (sample-proven): sample card
(output_template.pdf — user-er deya sample-er sathe byte-identical)
dekha jay card-er ekmatro swakkhor-ta front-e, photo-r niche
(xref 24) — seta HOLDER-er swakkhor; back panel-e kono swakkhor
nei, authority signature-o card-e kothao nei. Age eta authority
bole bhul kora hoto (shakkhor/ diye replace kora hoto) — ekhon
holder-er sign.png-i oi slot-e boshe; authority signature ei
engine-e ar render hoy na.

Fail-loudly rule (fix #3): photo / signature / barcode / DOB band
replace korte na parle build FAIL kore (Bengali error, kono PDF na) —
template-er sample-er chhobi/barcode kokhono customer-er card-e thake na.
Barcode-er `ds` (digital signature) form data theke ashe; na thakle omit
kora hoy — sample card-er ds kokhono fallback hisebe use hoy na (fix #4).
"""
import os
import re
import json
import html
import datetime

import pymupdf
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

import build_output as bo


def _log(msg):
    print(msg)

# ---------------------------------------------------------------------------
# Layout constants — output_template.pdf theke mepe neya (PDF points, top-origin)
# ---------------------------------------------------------------------------
FRONT_NAME_BN = {"x": 130.50, "baseline": 115.61, "size": 8.07, "bold": True}
FRONT_NAME_EN = {"x": 130.50, "baseline": 132.90, "size": 5.90}
FRONT_FATHER = {"x": 130.50, "baseline": 151.61, "size": 8.07}
FRONT_MOTHER = {"x": 130.50, "baseline": 169.61, "size": 8.07}
FRONT_DOB = {"x": 161.16, "baseline": 183.22, "size": 7.47}
FRONT_NID = {"x": 162.79, "baseline": 195.23, "size": 8.98}

ADDRESS = {"x": 313.50, "baseline1": 110.25, "line_step": 7.50,
           "size": 7.50, "min_size": 5.40, "max_right": 527.50,
           "max_lines": 3, "gap": 1.92, "bottom_limit": 132.00}

BACK_BLOOD = {"x": 343.20, "baseline": 144.18, "size": 6.29}
BACK_PLACE_LABEL = {"x": 363.00, "baseline": 142.65, "size": 4.88}
BACK_PLACE = {"x": 392.04, "baseline": 142.65, "size": 6.29}
BACK_ISSUE_LABEL = {"x": 479.25, "baseline": 142.65, "size": 4.88}
BACK_ISSUE = {"x": 503.17, "baseline": 142.65, "size": 6.29}

MRZ = {"x": 316.50, "y1": 171.75, "y2": 184.50, "y3": 197.25,
       "pitch": 7.2778, "size": 10.20, "vscale": 1.0}

PHOTO_XREFS = (18, 20, 26)     # front photo, back mini photo, back ghost photo
HOLDER_SIGN_XREF = 24          # holder (cardholder) signature — front, photo-r niche.
                               # Sample card (output_template.pdf) proman kore: card-e
                               # ekmatro swakkhor eitai, holder-er; back panel-e kono
                               # swakkhor nei, authority signature-o card-e nei.
BARCODE_XREF = 15
DOB_BAND_XREF = 66

# Shudhu value-draw kora XObjects (label gulo alada XObject-e, segulo thakbe)
VALUE_XOBJECTS = ("X49", "X52", "X57", "X62", "X64", "X65")
# Ei duita XObject-e label (MCID 0) + value (MCID 1) duitai ache —
# bhitore shudhu MCID 1 block-tuku bad dite hobe.
LABEL_VALUE_XREFS = (13, 14)

MONTHS = {1: "Jan", 2: "Feb", 3: "Mar", 4: "Apr", 5: "May", 6: "Jun",
          7: "Jul", 8: "Aug", 9: "Sep", 10: "Oct", 11: "Nov", 12: "Dec"}
BN_DIGITS = str.maketrans("0123456789", "০১২৩৪৫৬৭৮৯")
EN_DIGITS = str.maketrans("০১২৩৪৫৬৭৮৯", "0123456789")


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
def _has_bengali(txt):
    return any(0x0980 <= ord(ch) <= 0x09FF for ch in (txt or ""))


def _to_ascii(txt):
    return (txt or "").translate(EN_DIGITS)


def _parse_date(txt):
    """'16 May 1980' / '1980-05-16' / '16/05/1980' / '১৬/০৫/১৯৮০' -> date."""
    t = _to_ascii(txt).strip()
    if not t:
        return None
    m = re.match(r"(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})", t)
    if m:
        return datetime.date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    m = re.match(r"(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})", t)
    if m:
        return datetime.date(int(m.group(3)), int(m.group(2)), int(m.group(1)))
    m = re.match(r"(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})", t)
    if m:
        mon = m.group(2)[:3].title()
        for k, v in MONTHS.items():
            if v == mon:
                return datetime.date(int(m.group(3)), k, int(m.group(1)))
    return None


def _fmt_dob_en(d):
    return "%02d %s %d" % (d.day, MONTHS[d.month], d.year) if d else ""


def _mrz_checksum(txt):
    weights = (7, 3, 1)
    total = 0
    for i, ch in enumerate(txt):
        if ch.isdigit():
            v = int(ch)
        elif ch == "<":
            v = 0
        elif "A" <= ch <= "Z":
            v = ord(ch) - 55
        else:
            v = 0
        total += v * weights[i % 3]
    return str(total % 10)


def _mrz_name_split(name):
    words = [w for w in re.split(r"\s+", (name or "").strip().upper())
             if re.match(r"^[A-Z<]+$", w)]
    if not words:
        return "", ""
    if len(words) == 1:
        return words[0], ""
    return words[-1], " ".join(words[:-1])


# ---------------------------------------------------------------------------
# archaeology: ki vabe template-er variable text soriye felbo
# ---------------------------------------------------------------------------
def is_v2_template(doc):
    """Notun NID card (front+back, MRZ) kina."""
    try:
        txt = doc[0].get_text()
    except Exception:
        return False
    return ("NID No." in txt and "Blood Group:" in txt
            and "Place of Birth:" in txt and "Issue Date:" in txt)


def _q_ranges(stream):
    """Stream-er q...Q block ranges (nesting-aware)."""
    ranges, stack = [], []
    for m in re.finditer(r"(?<![A-Za-z0-9])([qQ])(?![A-Za-z0-9])", stream):
        if m.group(1) == "q":
            stack.append(m.start())
        elif stack:
            ranges.append((stack.pop(), m.end()))
    return ranges


def _strip_variable_text(doc):
    """Template-er nam/pita/mata/DOB/NID/address/place/issue/MRZ sorano.

    Goti: shudhu value-operator/BT-block gulo bad, label + background + photo +
    signature + barcode sob template-ei thake.
    """
    page = doc[0]
    xref = page.get_contents()[0]
    stream = doc.xref_stream(xref).decode("latin1", errors="replace")

    # 1) value XObjects ar MRZ-r per-character glyph image draw operator
    for name in VALUE_XOBJECTS:
        stream = stream.replace("/%s Do" % name, "")
    stream = stream.replace("/X34 Do", "")

    # 2) page-stream text blocks: address 3 line + MRZ Type3 text
    def drop_bt(m):
        body = m.group(0)
        if re.search(r"\b418 (147|157|167) Tm\b", body):
            return ""
        if "/F32" in body or "/F33" in body:   # MRZ Type3 glyph/spacing text
            return ""
        return body
    stream = re.sub(r"\bBT\b.*?\bET\b", drop_bt, stream, flags=re.S)

    doc.update_stream(xref, stream.encode("latin1"))

    # 3) Place of Birth / Issue Date XObject: label (MCID 0) rekhe value (MCID 1) bad
    for x in LABEL_VALUE_XREFS:
        s = doc.xref_stream(x).decode("latin1", errors="replace")
        s2 = re.sub(r"/NonStruct\s*<<\s*/MCID\s+1\s*>>\s*BDC.*?EMC", "",
                    s, flags=re.S)
        if s2 != s:
            doc.update_stream(x, s2.encode("latin1"))


# ---------------------------------------------------------------------------
# text drawing
# ---------------------------------------------------------------------------
_MEASURE_DOC = None
_BOX_L, _BOX_T = 20.0, 40.0   # measurement page-er htmlbox rect top-left


def _bn_css(fname, size, stroke_pt, color):
    css = ("@font-face {font-family: bn; src: url(%s);}\n"
           "div {font-family: bn; font-size: %.4fpx; color: %s;"
           " white-space: nowrap; line-height: 1.0;}\n"
           % (fname, size, color))
    if stroke_pt and stroke_pt > 0.01:
        css += "div {-webkit-text-stroke: %.4fpx %s;}\n" % (stroke_pt, color)
    return css


def _measure_bn(txt, font_path, size, stroke_pt=0.0):
    """Return (width_pt, dx, dy).

    dx = first glyph origin-er distance box-er left theke
    dy = baseline-er distance box-er top theke
    """
    global _MEASURE_DOC
    if _MEASURE_DOC is None:
        _MEASURE_DOC = pymupdf.open()
    fname = os.path.basename(font_path)
    arch = pymupdf.Archive(os.path.dirname(os.path.abspath(font_path)))
    body = "<div>%s</div>" % html.escape(txt)
    page = _MEASURE_DOC.new_page(width=700, height=160)
    try:
        page.insert_htmlbox(pymupdf.Rect(_BOX_L, _BOX_T, 680, 140), body,
                            css=_bn_css(fname, size, stroke_pt, "#000000"),
                            archive=arch, scale_low=1)
        d = page.get_text("rawdict")
        xs, ox, oy = [], None, None
        for blk in d["blocks"]:
            for ln in blk.get("lines", []):
                for sp in ln["spans"]:
                    for ch in sp["chars"]:
                        xs += [ch["bbox"][0], ch["bbox"][2]]
                        if ox is None:
                            ox, oy = ch["origin"]
        if not xs:
            return 0.0, 0.0, 0.0, 0.0
        # ink_dx: glyph-origin theke prothom ink column koto bame ( Bengali
        # 'ি' matra negative offset-e bose, tai eta negative hoy ).
        return (max(xs) - min(xs), ox - _BOX_L, oy - _BOX_T,
                min(xs) - ox)
    finally:
        _MEASURE_DOC.delete_page(-1)


# GSUB table na- thaka Bangla font (jemon Bangla Medium) HarfBuzz-e
# nukta/rra-phala thik moto join hoy na. Notun Noto Sans Bengali-te
# segulo thik. Tai Bangla Medium thakle o Noto diye render kori —
# sample card-eo SolaimanLipi (bhalo Bangla) use kora.
# Linux-e Windows font nei — bundled SolaimanLipi / TiroBangla age.
_HERE = os.path.dirname(os.path.abspath(__file__))
_BN_RENDER_CANDIDATES = (
    os.path.join(_HERE, "fonts", "SolaimanLipi.ttf"),
    os.path.join(_HERE, "fonts", "TiroBangla-Regular.ttf"),
    r"C:\Windows\Fonts\Nirmala.ttf",     # Windows Bangla (thik shape kore)
    r"C:\Windows\Fonts\NotoSerifBengali.ttf",
    r"C:\Windows\Fonts\NotoSansBengali-Regular.ttf",
    r"C:\Windows\Fonts\vrind.ttf",
    r"C:\Windows\Fonts\shonar.ttf",
)


def _bn_render_font(path):
    """Bangla text-er jonno GSUB-shuddho font (Noto/Nirmala) ba original."""
    try:
        from fontTools.ttLib import TTFont
        t = TTFont(path)
        has_gsub = "GSUB" in t
        # Bangla-nukta join thik moto hoy kina (shuddh Bangla Medium-e problem)
        bad_gsub = has_gsub and os.path.basename(path).lower().startswith("bangla")
        t.close()
    except Exception:
        bad_gsub = False
    if bad_gsub:
        for cand in _BN_RENDER_CANDIDATES:
            if os.path.exists(cand):
                _log("Bangla Medium GSUB durbol — Noto/Nirmala diye render: %s"
                     % os.path.basename(cand))
                return cand
    return path


def insert_bn(page, txt, font_path, size, x0, baseline,
              stroke_pt=0.0, color="#000000", max_width=None, bold=0.0):
    """Properly shaped Bangla text, exact baseline-e bosano.

    bold>0 hole same text ektu shift kore duibar draw kore (fake bold).
    """
    if not txt or not txt.strip():
        return 0.0
    # measure + render duitai SAME font path use korbo (Bangla Medium GSUB
    # durbol hole Noto/Nirmala-te render — tahole width match thake).
    font_path = _bn_render_font(font_path)
    if max_width and max_width > 5:
        w, _, _, _ = _measure_bn(txt, font_path, size, stroke_pt)
        if w > max_width:
            ratio = max_width / w
            size *= ratio
            stroke_pt *= ratio
    w, dx, dy, _ = _measure_bn(txt, font_path, size, stroke_pt)
    if not w:
        return 0.0
    fname = os.path.basename(font_path)
    arch = pymupdf.Archive(os.path.dirname(os.path.abspath(font_path)))
    body = "<div>%s</div>" % html.escape(txt)
    offsets = [0.0, bold] if bold and bold > 0 else [0.0]
    for off in offsets:
        rect = pymupdf.Rect(x0 - dx + off, baseline - dy,
                            x0 - dx + off + w + 40 + bold,
                            baseline - dy + size * 2.6)
        try:
            page.insert_htmlbox(rect, body,
                                css=_bn_css(fname, size, stroke_pt, color),
                                archive=arch, scale_low=1)
        except Exception as e:
            _log("BN insert fail (%s): %s" % (str(e)[:80], txt[:30]))
            return 0.0
    return w


def insert_latin(page, txt, x0, baseline, size, bold=False, color=(0, 0, 0),
                 max_width=None, tracking=0.0, font_path=None, resname=None,
                 vscale=1.0, stroke_chars="", border_width=0.0):
    if not txt:
        return
    fontfile = font_path or bo._font_for("A", bo.FONT_LAT)
    resname = resname or "NIDLAT"
    if bold and not font_path:
        cand = os.path.join(os.path.dirname(fontfile), "Arial_Bold.ttf")
        if os.path.exists(cand):
            fontfile = cand
        else:
            alt = bo._resolve_font("Arial-BoldMT") or \
                r"C:\Windows\Fonts\arialbd.ttf"
            if os.path.exists(str(alt)):
                fontfile = str(alt)
        resname = "NIDLATB"
    fnt = pymupdf.Font(fontfile=fontfile)
    if max_width and max_width > 5 and tracking == 0:
        w = fnt.text_length(txt, fontsize=size)
        if w > max_width:
            size *= max_width / w
    if tracking:
        x = x0
        for ch in txt:
            # Prottek char-ke tar nijer cell-er majhe bosiye dei — tahole
            # chhoto (I) ar boro (M) char-er gap soman hoy, sample-er moto.
            cw = fnt.text_length(ch, fontsize=size)
            dx = (tracking - cw) / 2.0 if tracking > cw else 0.0
            cx = x + dx
            if vscale and abs(vscale - 1.0) > 1e-3:
                morph = (pymupdf.Point(cx, baseline),
                         pymupdf.Matrix(1, 0, 0, vscale, 0, 0))
            else:
                morph = None
            page.insert_text((cx, baseline), ch, fontfile=fontfile,
                             fontname=resname, fontsize=size, color=color,
                             morph=morph,
                             render_mode=(2 if (border_width and ch in stroke_chars)
                                          else 0),
                             border_width=(border_width if border_width else 0))
            x += tracking
    else:
        page.insert_text((x0, baseline), txt, fontfile=fontfile,
                         fontname=resname, fontsize=size, color=color)


# ---------------------------------------------------------------------------
# address wrap
# ---------------------------------------------------------------------------
def _wrap_bn(parts, font_path, size, first_width, width, stroke_pt=0.0):
    """Word-wrap; first line-er available width alada (label baad diye)."""
    words = parts.split()
    lines, cur = [], ""
    limit = first_width
    for w in words:
        cand = (cur + " " + w).strip()
        cw, _, _, _ = _measure_bn(cand, font_path, size, stroke_pt)
        if cw <= limit or not cur:
            cur = cand
        else:
            lines.append(cur)
            cur = w
            limit = width
    if cur:
        lines.append(cur)
    return lines


def _layout_address(addr_val, label, font_path, box):
    """ঠিকানার auto-layout — kono hardcode adjust lage na.

    Sample card-er box (x / baseline / line_step / max_right / max_lines)
    dhore: joto boro size-te lekha ta box-er bhitor 3 line-e (ba kom-e)
    dhore, toto boro size rakha hoy; na hole 0.1pt kore chhoto kora hoy.

    Return dict: lines, size, label_w (ink), label_ink, inks (per-line ink
    offset), x0s, x1s, bottom.
    """
    gap = box["gap"]
    maxw = box["max_right"] - box["x"]
    max_lines = box["max_lines"]
    size = box["size"]
    min_size = box["min_size"]
    lw, _, _, l_ink = _measure_bn(label, font_path, size)

    for _ in range(80):
        lines = _wrap_bn(addr_val, font_path, size, maxw - lw - gap, maxw)
        widths, inks = [], []
        for ln in lines:
            w, _, _, ink = _measure_bn(ln, font_path, size)
            widths.append(w)
            inks.append(ink)
        first_w = (widths[0] + lw + gap) if widths else 0.0
        rest_w = max(widths[1:]) if len(widths) > 1 else 0.0
        bottom = (box["baseline1"] + (len(lines) - 1) * box["line_step"]
                  + 0.35 * size)
        if ((len(lines) <= max_lines and first_w <= maxw
             and rest_w <= maxw and bottom <= box["bottom_limit"])
                or size <= min_size):
            break
        size = max(min_size, round(size - 0.1, 2))
        lw, _, _, l_ink = _measure_bn(label, font_path, size)

    x1s = []
    for i, w in enumerate(widths):
        x1s.append(box["x"] + ((lw + gap + w) if i == 0 else w))
    rep = {
        "size": round(size, 2),
        "gap": gap,
        "label": label,
        "label_w": round(lw, 2),
        "label_ink": round(l_ink, 2),
        "lines": lines,
        "inks": [round(v, 2) for v in inks],
        "x0s": [round(box["x"], 2) for _ in lines],
        "x1s": [round(v, 2) for v in x1s],
        "top": round(box["baseline1"] - 0.965 * size, 2),
        "bottom": round(box["baseline1"] + (len(lines) - 1) * box["line_step"]
                        + 0.35 * size, 2),
        "max_right": box["max_right"],
        "max_lines": max_lines,
        "ok": bool(len(lines) <= max_lines and
                   all(v <= box["max_right"] + 0.05 for v in x1s)),
        "truncated": bool(len(lines) > max_lines),
    }
    return rep


def _address_debug(rep):
    """Auto-layout-er maap print + work/address_debug.json-e save."""
    _log("[address] size %.2f | lines %d/%d | gap %.2f | label ink %.2f"
         % (rep["size"], len(rep["lines"]), rep["max_lines"],
            rep["gap"], rep["label_w"]))
    for i, ln in enumerate(rep["lines"]):
        _log("[address]   L%d x %.2f..%.2f  %s"
             % (i + 1, rep["x0s"][i], rep["x1s"][i], ln[:52]))
    _log("[address] top %.2f bottom %.2f | right limit %.2f | %s"
         % (rep["top"], rep["bottom"], rep["max_right"],
            "OK" if rep["ok"] else "OVERFLOW"))
    if rep.get("truncated"):
        _log("[address] WARNING: %d line chilo, max %d — extra line bad "
             "(size already %.2f)" % (len(rep["lines"]),
                                      rep["max_lines"], rep["size"]))
    try:
        with open(bo._w("address_debug.json"), "w", encoding="utf-8") as f:
            json.dump(rep, f, ensure_ascii=False, indent=1)
    except Exception:
        pass


# ---------------------------------------------------------------------------
# images
# ---------------------------------------------------------------------------
def _fit_cover(path, w, h, gray=False, lighten=0.0):
    im = Image.open(path).convert("RGB")
    if gray:
        im = im.convert("L").convert("RGB")
    scale = max(w / im.width, h / im.height)
    nw = max(w, int(round(im.width * scale)))
    nh = max(h, int(round(im.height * scale)))
    im = im.resize((nw, nh), Image.LANCZOS)
    x0 = (nw - w) // 2
    y0 = (nh - h) // 2
    im = im.crop((x0, y0, x0 + w, y0 + h))
    if lighten > 0:
        im = Image.blend(im, Image.new("RGB", (w, h), (255, 255, 255)), lighten)
    return im


def _soft_alpha(w, h, peak=1.0):
    """Elliptical soft-edged alpha mask (mini/ghost photo-r jonno)."""
    from PIL import ImageFilter
    mask = Image.new("L", (w, h), 0)
    d = ImageDraw.Draw(mask)
    d.ellipse((w * 0.05, h * 0.05, w * 0.95, h * 0.95), fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(radius=max(1.0, min(w, h) * 0.07)))
    mask = mask.point(lambda v: int(v * peak))
    return mask


# Sample card-er photo-r motoi neutral gray, upore halka niche garha gradient
# + dan dike halka aro garha (sample photo-r corner maap theke).
SAMPLE_BG_TOP = 207
SAMPLE_BG_BOTTOM = 165
SAMPLE_BG_RIGHT_DROP = 12


def _photo_clean_path(photo_path, w=240, h=300):
    """Photo-r pichoner (nila/sada) background soriye sample card-er
    motoi neutral gray gradient-e bosha -> (path) return kore.

    cv2/grabcut na thakle, ba segmentation fail korle, original photo-i
    pathano hoy (safe fallback).
    """
    import tempfile
    try:
        import cv2
        import numpy as np
    except Exception:
        # Graceful degrade (fix #2): sanitize na hole original photo-i
        # use hoy, kintu WARNING log-e sposhto thake — kokhono chupchap
        # skip na. Server-e opencv-python-headless install korle ei
        # path-ta ar lagbe na (pip install opencv-python-headless).
        _log("WARNING: cv2/numpy nei — photo background sanitize holo na, "
             "original photo-i use holo.")
        return photo_path

    try:
        img = cv2.imread(photo_path, cv2.IMREAD_COLOR)
        if img is None:
            return photo_path
        h, w = img.shape[:2]

        # Sample card-er photo GRAYSCALE + neutral gray background.
        # 1) grayscale
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        g3 = np.dstack([gray] * 3).astype(np.float32)
        gf = gray.astype(np.float32)

        # 2a) NID scan-er moto photo: manush already sada background-e
        #     kata. Tokhon near-white area-ke background dhore 1px bhitore
        #     dhukeye matte banaï — tahole chul/r gorer sada rim (halo)
        #     ar thake na. (Sample photo-te halo nei.)
        white = (gray >= 228).astype(np.uint8)
        num, lab, stats, _ = cv2.connectedComponentsWithStats(white, 8)
        bg_mask = np.zeros((h, w), np.uint8)
        for i in range(1, num):
            x, y, ww, hh, area = stats[i]
            touch = (x <= 1 or y <= 1 or x + ww >= w - 1
                     or y + hh >= h - 1)
            if touch and area > 0.004 * w * h:
                bg_mask[lab == i] = 255
        bg_area = int((bg_mask > 0).sum())
        use_white = bg_area >= 0.08 * w * h

        if use_white:
            bg_mask = cv2.dilate(
                bg_mask,
                cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)))
            alpha = 1.0 - bg_mask.astype(np.float32) / 255.0
            alpha = cv2.GaussianBlur(alpha, (0, 0), 0.8)
        else:
            # 2b) Chobi-r real background (nila/sobuj/teksture) — light +
            #     flat area, border theke connected.
            blur = cv2.GaussianBlur(gf, (0, 0), 7)
            std = np.sqrt(cv2.blur((gf - blur) ** 2, (9, 9)))
            cand = ((gf >= 172) & (std < 10.0)).astype(np.uint8)
            cand = cv2.morphologyEx(
                cand, cv2.MORPH_CLOSE,
                cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7)))
            num, lab, stats, _ = cv2.connectedComponentsWithStats(cand, 8)
            keep = np.zeros((h, w), np.uint8)
            for i in range(1, num):
                x, y, ww, hh, area = stats[i]
                touch = (x <= 1 or y <= 1 or x + ww >= w - 1
                         or y + hh >= h - 1)
                if touch and area > 0.005 * w * h:
                    keep[lab == i] = 255
            alpha = keep.astype(np.float32) / 255.0
            alpha = 1.0 - cv2.GaussianBlur(alpha, (0, 0), sigmaX=2.2)

        alpha = np.clip(alpha, 0, 1)[..., None]

        # neutral gray gradient background (sample moto: upore halka, niche garha,
        # dan dike halka aro garha)
        gv = np.linspace(SAMPLE_BG_TOP, SAMPLE_BG_BOTTOM, h,
                         dtype=np.float32)[:, None]
        gh = np.linspace(0.0, SAMPLE_BG_RIGHT_DROP, w,
                         dtype=np.float32)[None, :]
        plane = np.clip(gv - gh, 0, 255)
        bg = np.dstack([plane] * 3).astype(np.float32)

        out = np.clip(g3 * alpha + bg * (1.0 - alpha), 0, 255).astype(np.uint8)

        _log("photo matte: %s (%d px bg)"
             % ("white-cutout" if use_white else "flat-bg", bg_area))

        tmp = os.path.join(tempfile.gettempdir(),
                           "nid_photoclean_%d.png" % abs(hash(photo_path)))
        cv2.imwrite(tmp, out)
        return tmp
    except Exception as e:
        _log("photo background change fail: %s" % str(e)[:120])
        return photo_path


def _fit_contain_rgba(path, w, h):
    im = Image.open(path).convert("RGBA")
    scale = min(w / im.width, h / im.height)
    nw = max(1, int(round(im.width * scale)))
    nh = max(1, int(round(im.height * scale)))
    im = im.resize((nw, nh), Image.LANCZOS)
    canvas = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    canvas.paste(im, ((w - nw) // 2, (h - nh) // 2), im)
    return canvas


def _clean_signature(path):
    """Scanned holder signature (dark ink on white paper) -> transparent-bg
    RGBA PNG, cropped to the ink bounding box.

    Form theke extract kora sign.png-er kagoj saada na — scan-er
    gradient (upore majhari gray, niche pray saada). Fixed white
    threshold dile kagoj-tai gray box hoye card-er guilloche dheke
    dito. Tai kagoj-ta per-pixel estimate kori (wide Gaussian blur)
    ar kali = kagoj - gray: kali onek dark, kagoj pray shoman —
    tai gradient thakleo kali alada hoy. Source-e alpha thakle
    setao manjo. Ink-er bbox-e crop kori jate slot-e signature
    chhoto na hoye jay.
    Returns the path of the cleaned temp PNG.
    Raises RuntimeError (Bengali) if the file cannot be read or has no ink.
    """
    try:
        im = Image.open(path)
    except Exception as e:
        raise RuntimeError("ধারকের স্বাক্ষর পড়া যায়নি: %s" % e)
    try:
        rgb = im.convert("RGB")
        gray = rgb.convert("L")
        # Background estimate: strokes wash out, paper gradient stays.
        radius = max(8, min(im.width, im.height) // 10)
        bg = gray.filter(ImageFilter.GaussianBlur(radius=radius))
        dark = ImageChops.subtract(bg, gray)
        # darkness <20 -> paper (transparent), >60 -> solid ink.
        alpha = dark.point(
            lambda d: 0 if d < 20 else (255 if d > 60 else
                                       int((d - 20) * 255 / 40)))
        if im.mode == "RGBA":
            try:
                alpha = ImageChops.darker(alpha, im.split()[3])
            except Exception:
                pass
        out = rgb.convert("RGBA")
        out.putalpha(alpha)
        bbox = alpha.getbbox()
        if not bbox:
            raise RuntimeError(
                "ধারকের স্বাক্ষরে কালি পাওয়া যায়নি — ফাঁকা ছবি। "
                "সঠিক স্বাক্ষরের ছবি দিন।")
        m = 2
        out = out.crop((max(0, bbox[0] - m), max(0, bbox[1] - m),
                        min(out.width, bbox[2] + m),
                        min(out.height, bbox[3] + m)))
        tmp = bo._w("temp_renders", "v2_holder_sign_clean.png")
        out.save(tmp)
        return tmp
    except RuntimeError:
        raise
    except Exception as e:
        raise RuntimeError("ধারকের স্বাক্ষর বসানো যায়নি: %s" % e)


def _blank_signature_image():
    """Fully transparent 146x73 PNG — holder signature na thakle slot-ta
    faka rakhar jonno. Template-er sample holder-er signature kokhono
    customer-er card-e thakte pare na (fix #3), tai blank diye replace
    korte hoy; khali rekhe dile sample-er swakkhor theke jeto."""
    im = Image.new("RGBA", (146, 73), (0, 0, 0, 0))
    out = bo._w("temp_renders", "v2_holder_sign_blank.png")
    im.save(out)
    return out


def _replace_photos(page, photo_path, holder_sign_path):
    """Photo (3 jaiga) + holder signature replace.

    FAIL LOUDLY (fix #3): photo replace korte na parle RuntimeError
    (Bengali) — build theme jay, kono PDF hoy na. Template-er sample-er
    chhobi kokhono customer-er card-e thakte pare na.

    Holder signature: deya thakle setai HOLDER_SIGN_XREF slot-e boshe
    (sample card-er hubohu jaiga — front, photo-r niche). Deya na
    thakle slot-ta blank (transparent) kore deya hoy — template-er
    sample holder-er signature kokhono thake na — ar build choltei
    thake. Deya signature porte / bosate na parle RuntimeError.
    """
    os.makedirs(bo._w("temp_renders"), exist_ok=True)
    if not photo_path or not os.path.exists(photo_path):
        raise RuntimeError(
            "ছবি পাওয়া যায়নি — টেমপ্লেটের ছবি রেখে কার্ড তৈরি করা যাবে না। "
            "সঠিক ছবিসহ NID ফর্ম PDF আপলোড করুন।")
    # sample card-er motoi background-sanitize kora photo (ekbar)
    clean = _photo_clean_path(photo_path)
    # front photo — full opacity
    for xref, (w, h) in ((18, (237, 303)),):
        im = _fit_cover(clean, w, h)
        out = bo._w("temp_renders", "v2_photo_%d.png" % xref)
        im.save(out)
        try:
            page.replace_image(xref, filename=out)
        except Exception as e:
            raise RuntimeError("সামনের ছবি বসানো যায়নি: %s" % e)
    # front hologram mini photo — sample-e ei chhobi-r upore card-er
    # nijer oval overlay thake; tai bitmap plain (alpha chara) rakhi,
    # overlay nijei fade kore. Halka tone match.
    im = _fit_cover(clean, 67, 86, gray=True, lighten=0.10)
    out = bo._w("temp_renders", "v2_photo_20.png")
    im.save(out)
    try:
        page.replace_image(20, filename=out)
    except Exception as e:
        raise RuntimeError("ছোট ছবি বসানো যায়নি: %s" % e)
    # back ghost photo — same: plain bitmap, page-er overlay fade korbe
    im = _fit_cover(clean, 65, 84, gray=True, lighten=0.10)
    out = bo._w("temp_renders", "v2_photo_26.png")
    im.save(out)
    try:
        page.replace_image(26, filename=out)
    except Exception as e:
        raise RuntimeError("পেছনের ছবি বসানো যায়নি: %s" % e)

    if holder_sign_path and os.path.exists(holder_sign_path):
        clean = _clean_signature(holder_sign_path)
        im = _fit_contain_rgba(clean, 146, 73)
        out = bo._w("temp_renders", "v2_holder_sign.png")
        im.save(out)
        try:
            page.replace_image(HOLDER_SIGN_XREF, filename=out)
        except Exception as e:
            raise RuntimeError("ধারকের স্বাক্ষর বসানো যায়নি: %s" % e)
    else:
        # Kono holder signature nei — slot blank rakho (sample-er
        # signature muchhe fela hoy), build theme jay na.
        blank = _blank_signature_image()
        try:
            page.replace_image(HOLDER_SIGN_XREF, filename=blank)
        except Exception as e:
            raise RuntimeError("স্বাক্ষরের জায়গা খালি করা যায়নি: %s" % e)


def _make_barcode(fields):
    """PDF417 barcode bitmap banay, temp_renders/v2_barcode.png-e save kore.

    FAIL LOUDLY (fix #3): pdf417gen na thakle / Pin-Name-DOB na thakle /
    encode fail korle RuntimeError (Bengali) — template-er sample
    barcode kokhono customer-er card-e thake na.

    `ds` (digital signature) form data theke ashle tobei XML-e jay;
    na thakle <ds> element-ta omit kora hoy (fix #4) — sample card-er
    ds hex kokhono fallback hisebe use hoy na.
    """
    try:
        from pdf417gen import encode
    except ImportError:
        raise RuntimeError("বারকোড তৈরি করা যায়নি — pdf417gen ইনস্টল নেই।")
    pin = (fields.get("Pin") or fields.get("ID NO:") or "").strip()
    nm = (fields.get("Name:") or "").strip().upper()
    dob = fields.get("Date of Birth:") or ""
    d = _parse_date(dob)
    dob = d.isoformat() if d else dob
    if not (pin and nm and dob):
        raise RuntimeError(
            "বারকোডের জন্য পিন, নাম ও জন্মতারিখ লাগে — তথ্য অসম্পূর্ণ।")
    ds = (fields.get("ds") or "").strip()
    ds_xml = "<ds>%s</ds>" % ds if ds else ""
    # Sample card-er format: name-e space-er bodole '+', DOB ISO, TYPE faka.
    xml = ("<pin>%s</pin><name>%s</name><DOB>%s</DOB><FP></FP>"
           "<F>Right Index</F><TYPE></TYPE><V>2.0</V>%s"
           % (pin, nm.replace(" ", "+"), dob, ds_xml))
    try:
        # Sample barcode-er hubohu geometry: 13 data column, 18 row,
        # module 2px x 2px, row height 6px -> 580x108 exact bitmap.
        codes = _pdf417_codes(xml, columns=13, security_level=4, rows=18)
    except Exception as e:
        raise RuntimeError("বারকোড তৈরি করা যায়নি: %s" % e)
    if not codes:
        raise RuntimeError("বারকোড তৈরি করা যায়নি।")
    # pdf417gen.modules() leading-zero bits fেলে dey -> vertikal white gap.
    # Tai nijerai 17/18-bit (stop symbol) fixed-width render kori.
    ncol = len(codes[0])
    nmod = ncol * 17 + 1          # start/stop soho total module
    nrow = len(codes)
    target_w, target_h = 580, 108
    if nmod != 290 or nrow != 18:      # data beshi hole exact ratio na-o hote pare
        target_w = nmod * 2
        target_h = nrow * 6
    im = Image.new("RGB", (target_w, target_h), (255, 255, 255))
    px = im.load()
    mx = target_w / float(nmod)
    my = target_h / float(nrow)
    for y, row in enumerate(codes):
        x = 0
        for i, v in enumerate(row):
            bits = format(v, "018b" if i == len(row) - 1 else "017b")
            for b in bits:
                if b == "1":
                    x0, x1 = int(round(x * mx)), int(round((x + 1) * mx))
                    y0, y1 = int(round(y * my)), int(round((y + 1) * my))
                    for yy in range(y0, max(y0 + 1, y1)):
                        for xx in range(x0, max(x0 + 1, x1)):
                            if 0 <= xx < target_w and 0 <= yy < target_h:
                                px[xx, yy] = (0, 0, 0)
                x += 1
    out = bo._w("temp_renders", "v2_barcode.png")
    im.save(out)
    return out


def _pdf417_codes(text, columns=13, security_level=5, rows=18):
    """pdf417gen-er moto, kintu row sonkha nirdisto (sample card-er moto).

    PDF417-e padding code word (900) diye row bhora hoy; tai fixed 18 row-e
    niye asha jay — module 2px, row 6px hoye sample-er sathe hubohu mile.
    """
    from pdf417gen.encoding import encode_rows, PADDING_CODE_WORD
    from pdf417gen.compaction import compact
    from pdf417gen.error_correction import compute_error_correction_code_words
    from pdf417gen.util import chunks, to_bytes

    data_words = list(compact(to_bytes(text, "utf-8")))
    ec_count = 2 ** (security_level + 1)
    need = len(data_words) + ec_count + 1          # length descriptor soho
    total_rows = rows if rows * columns >= need else -(-need // columns)
    pad = total_rows * columns - need
    length_descriptor = len(data_words) + pad + 1
    words = [length_descriptor] + data_words + [PADDING_CODE_WORD] * pad
    words += compute_error_correction_code_words(words, security_level)
    return list(encode_rows(list(chunks(words, columns)), columns,
                            security_level))


def _make_dob_band(dob_iso):
    im = Image.new("RGBA", (111, 27), (255, 255, 255, 0))
    d = ImageDraw.Draw(im)
    # Bundled Arial Bold age (Linux server-e Windows font nei) —
    # tarpor system resolve, tarpor Windows path, sheshe default.
    f = None
    for cand in (bo._a("fonts", "Arial_Bold.ttf"),
                 bo._resolve_font("Arial-BoldMT"),
                 "C:/Windows/Fonts/arialbd.ttf"):
        if cand and os.path.exists(str(cand)):
            try:
                f = ImageFont.truetype(str(cand), 16)
                break
            except Exception:
                continue
    if f is None:
        f = ImageFont.load_default()
    txt = dob_iso or ""
    bb = d.textbbox((0, 0), txt, font=f)
    d.text(((111 - (bb[2] - bb[0])) / 2, (27 - (bb[3] - bb[1])) / 2 - bb[1]),
           txt, font=f, fill=(105, 105, 105, 255))
    # dot-matrix look: chhoto kore nearest-neighbour upscale
    im = im.resize((56, 14), Image.LANCZOS).resize((111, 27), Image.NEAREST)
    out = bo._w("temp_renders", "v2_dob_band.png")
    im.save(out)
    return out


# ---------------------------------------------------------------------------
# main build
# ---------------------------------------------------------------------------
def build_v2_card(fields, template_pdf, out_pdf=None, photo_path=None,
                  holder_sign_path=None):
    # Caller (main / adapter) bo.configure(assets, work) kore — ekhane
    # work dir reset kora hoy na, karon adapter per-job absolute work
    # dir set kore (reset korle job-er file onno jaigay jeto).
    doc = pymupdf.open(template_pdf)
    if not is_v2_template(doc):
        doc.close()
        raise ValueError("v2 template na")

    page = doc[0]
    _strip_variable_text(doc)

    # Sample card-e SolaimanLipi use kora — sei font-ei Bangla likhi,
    # tai letterform sample-er sathe hubohu mile jay.
    bn_font = bo._a("fonts", "SolaimanLipi.ttf")
    if not os.path.exists(bn_font):
        bn_font = bo._font_for("অ", bo.FONT_BN)

    # ---- front ----
    name_bn = (fields.get("নাম:") or "").strip()
    insert_bn(page, name_bn, bn_font, FRONT_NAME_BN["size"],
              FRONT_NAME_BN["x"], FRONT_NAME_BN["baseline"],
              stroke_pt=0.14, max_width=140, bold=0.40)

    name_en = (fields.get("Name:") or "").strip().upper()
    insert_latin(page, name_en, FRONT_NAME_EN["x"], FRONT_NAME_EN["baseline"],
                 FRONT_NAME_EN["size"], bold=True, max_width=140)

    insert_bn(page, (fields.get("পিতা:") or "").strip(), bn_font,
              FRONT_FATHER["size"], FRONT_FATHER["x"],
              FRONT_FATHER["baseline"], max_width=140)
    insert_bn(page, (fields.get("মাতা:") or "").strip(), bn_font,
              FRONT_MOTHER["size"], FRONT_MOTHER["x"],
              FRONT_MOTHER["baseline"], max_width=140)

    dob = _parse_date(fields.get("Date of Birth:") or "")
    dob_en = _fmt_dob_en(dob)
    insert_latin(page, dob_en, FRONT_DOB["x"], FRONT_DOB["baseline"],
                 FRONT_DOB["size"], max_width=95)

    nid_raw = re.sub(r"\D", "", _to_ascii(fields.get("ID NO:") or ""))
    nid_fmt = ("%s %s %s" % (nid_raw[:3], nid_raw[3:6], nid_raw[6:])) \
        if len(nid_raw) >= 10 else (fields.get("ID NO:") or "")
    insert_latin(page, nid_fmt, FRONT_NID["x"], FRONT_NID["baseline"],
                 FRONT_NID["size"], bold=True, max_width=95)

    # ---- back: address (auto-layout) ----
    # Sample card-er maap e auto-fit: label ink x=313.50 theke, label ink
    # width-er por 1.92pt faka, tarpor value; line 2/3-o 313.50 theke;
    # baseline 110.25 + 7.5pt step; 3 line-er beshi hole size auto chhoto.
    addr_val = (fields.get("ঠিকানা:") or "").strip()
    label = "ঠিকানা:"
    lay = _layout_address(addr_val, label, bn_font, ADDRESS)
    _address_debug(lay)
    size, gap = lay["size"], ADDRESS["gap"]
    insert_bn(page, label, bn_font, size, ADDRESS["x"] - lay["label_ink"],
              ADDRESS["baseline1"])
    for i, ln in enumerate(lay["lines"][:ADDRESS["max_lines"]]):
        x = (ADDRESS["x"] + lay["label_w"] + gap) if i == 0 else ADDRESS["x"]
        insert_bn(page, ln, bn_font, size, x - lay["inks"][i],
                  ADDRESS["baseline1"] + i * ADDRESS["line_step"])

    # ---- back: blood / place / issue ----
    bg = (fields.get("/Blood Group:") or
          fields.get("Blood Group:") or "").strip()
    if bg:
        if _has_bengali(bg):
            insert_bn(page, bg, bn_font, BACK_BLOOD["size"],
                      BACK_BLOOD["x"], BACK_BLOOD["baseline"], max_width=38)
        else:
            insert_latin(page, bg, BACK_BLOOD["x"], BACK_BLOOD["baseline"],
                         BACK_BLOOD["size"], bold=True, max_width=38)

    place = (fields.get("জন্মস্থান:") or "").strip()
    if place:
        if _has_bengali(place):
            # Bangla glyph-er left bearing kom — label theke ektu fাঁকা lagiye dei
            insert_bn(page, place, bn_font, BACK_PLACE["size"],
                      BACK_PLACE["x"] + 2.2, BACK_PLACE["baseline"],
                      max_width=143, bold=0.18)
        else:
            insert_latin(page, place, BACK_PLACE["x"], BACK_PLACE["baseline"],
                         BACK_PLACE["size"], bold=True, max_width=145)

    issue_raw = (fields.get("প্রদানের তারিখ:") or "").strip()
    issue = _parse_date(issue_raw) if issue_raw else datetime.date.today()
    if not issue:
        issue = datetime.date.today()
    insert_latin(page, _fmt_dob_en(issue), BACK_ISSUE["x"],
                 BACK_ISSUE["baseline"], BACK_ISSUE["size"], bold=True,
                 max_width=58)

    # ---- MRZ ----
    mrz_lines = _build_mrz(fields, dob, issue)
    # Sample card-er MRZ OCR-B font-e chapa (I-er chora serif, slashed 0,
    # chhoto 1 — sob mile). Size 10.2 = cap height 5.85pt, cell 7.2778pt.
    mrz_font = bo._a("fonts", "OCR-B.ttf")
    if not os.path.exists(mrz_font):
        mrz_font = bo.FONT_LAT
        for cand in (r"C:\Windows\Fonts\consola.ttf",
                     r"C:\Windows\Fonts\arial.ttf"):
            if os.path.exists(cand):
                mrz_font = cand
                break
    for line, y in zip(mrz_lines, (MRZ["y1"], MRZ["y2"], MRZ["y3"])):
        insert_latin(page, line, MRZ["x"], y, MRZ["size"],
                     bold=False, tracking=MRZ["pitch"], font_path=mrz_font,
                     resname="NIDMRZ", vscale=MRZ["vscale"],
                     stroke_chars="<", border_width=0.035)

    # ---- images ----
    # photo_path None hole _replace_photos FAIL kore (fix #3) — kono
    # default work-dir photo use hoy na, template-er photo-o thake na.
    # holder_sign_path None hole signature slot blank thake, build
    # choltei thake.
    _replace_photos(page, photo_path, holder_sign_path)

    bc = _make_barcode(fields)  # fail hole RuntimeError (Bengali)
    try:
        page.replace_image(BARCODE_XREF, filename=bc)
    except Exception as e:
        raise RuntimeError("বারকোড বসানো যায়নি: %s" % e)

    band = _make_dob_band(dob.isoformat() if dob else "")
    try:
        page.replace_image(DOB_BAND_XREF, filename=band)
    except Exception as e:
        raise RuntimeError("জন্মতারিখের ব্যান্ড বসানো যায়নি: %s" % e)

    output_pdf = out_pdf or bo._w("output.pdf")
    doc.save(output_pdf, deflate=True, garbage=3)
    doc.close()
    return output_pdf


def _build_mrz(fields, dob, issue):
    nid = re.sub(r"\D", "", _to_ascii(fields.get("ID NO:") or ""))
    line1 = ("I<BGD" + nid + _mrz_checksum(nid)).ljust(30, "<")[:30]

    dob6 = dob.strftime("%y%m%d") if dob else "000000"
    sex = "M" if (fields.get("Gender") or "").lower().startswith("m") else \
        ("F" if (fields.get("Gender") or "").lower().startswith("f") else "<")
    iss6 = issue.strftime("%y%m%d") if issue else "000000"
    core = dob6 + _mrz_checksum(dob6) + sex + iss6 + _mrz_checksum(iss6) \
        + "BGD" + "<" * 11
    line2 = (core + _mrz_checksum(core))[:30]

    surname, given = _mrz_name_split(fields.get("Name:") or "")
    name = (surname + "<<" + given).replace(" ", "<")
    line3 = name.ljust(30, "<")[:30]
    return [line1, line2, line3]


# ---------------------------------------------------------------------------
# CLI — adapter theke call hoy:
#   python build_output_v2.py <fields.json> <template.pdf> <out.pdf>
#       [--photo <path>] [--holder-sign <path>] [--work <jobdir>] [--assets <enginedir>]
# stdout-e sheshe ek line JSON: {"ok": true, "output": ...} ba
# {"ok": false, "error": "<Bengali message>"}. Log line gulo tar age ashe.
# ---------------------------------------------------------------------------
def main(argv=None):
    import argparse
    ap = argparse.ArgumentParser(description="NID smart card (v2) builder")
    ap.add_argument("fields_json")
    ap.add_argument("template_pdf")
    ap.add_argument("out_pdf")
    ap.add_argument("--photo", default=None)
    ap.add_argument("--holder-sign", default=None)
    ap.add_argument("--work", default=None)
    ap.add_argument("--assets", default=None)
    args = ap.parse_args(argv)

    try:
        assets = args.assets or os.path.dirname(os.path.abspath(__file__))
        work = args.work or os.path.dirname(os.path.abspath(args.out_pdf))
        bo.configure(assets, work)
        with open(args.fields_json, encoding="utf-8") as fh:
            fields = json.load(fh)
        out = build_v2_card(fields, args.template_pdf, args.out_pdf,
                            photo_path=args.photo,
                            holder_sign_path=args.holder_sign)
        print(json.dumps({"ok": True, "output": out}, ensure_ascii=False))
        return 0
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
