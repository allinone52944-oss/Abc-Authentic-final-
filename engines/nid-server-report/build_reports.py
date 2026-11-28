# -*- coding: utf-8 -*-
"""BEC 'server copy' report generator (v1 + v2) — card-er bodole.

Input : work/input_data.json (+ work/images/photo.png)
Output: output/<NID>-v1.pdf  (everything-bd server_download_v1 style)
        output/<NID>-v2.pdf  (NIDW website print style)

Duita sample report PDF-i template hisebe use hoy — tar upor notun manusher
data bosano hoy (purono text redact kore, chobi/QR replace kore).
"""
import os
import sys
import json
import html
import datetime

import pymupdf

ROOT = os.path.dirname(os.path.abspath(__file__))
FONT_BN = r"C:\Windows\Fonts\Nirmala.ttc"
FONT_SOL = os.path.join(ROOT, "fonts", "SolaimanLipi.ttf")
FONT_LAT = os.path.join(ROOT, "fonts", "Arial.ttf")
FONT_ROB = os.path.join(ROOT, "fonts", "Roboto-Regular.ttf")
if not os.path.exists(FONT_BN):
    FONT_BN = os.path.join(ROOT, "fonts", "SolaimanLipi.ttf")
if not os.path.exists(FONT_LAT):
    FONT_LAT = r"C:\Windows\Fonts\arial.ttf"

BN_DIG = str.maketrans("0123456789", "০১২৩৪৫৬৭৮৯")


def bn_num(s):
    return str(s or "").translate(BN_DIG)


def pick_css_font(path):
    d, f = os.path.split(path)
    return d, f


def hb(page, rect, text, size, fontfile, color="#000000", align="left",
       line_height=1.32):
    """Harfbuzz-shaped text bosao (Story -> real Bangla shaping)."""
    fdir, fname = pick_css_font(fontfile)
    css = ("@font-face{font-family:f;src:url('%s');}"
           "*{margin:0;padding:0;}"
           "div{font-family:f;font-size:%.2fpx;line-height:%.3f;"
           "color:%s;text-align:%s;}") % (fname, size, line_height,
                                          color, align)
    arch = pymupdf.Archive(fdir)
    page.insert_htmlbox(pymupdf.Rect(rect),
                        "<div>%s</div>" % html.escape(text),
                        css=css, archive=arch, scale_low=1)


def redact_text(page, rects):
    for r in rects:
        page.add_redact_annot(pymupdf.Rect(r), fill=None)
    page.apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_NONE,
                          graphics=pymupdf.PDF_REDACT_LINE_ART_NONE,
                          text=pymupdf.PDF_REDACT_TEXT_REMOVE)


ADDR_EMPTY = {"", "-", "--", "—", "–", "n/a", "na", "none", "null", "না", "০"}


def addr_clean(v):
    """Faka / placeholder (-, N/A) value bad diye dey."""
    s = str(v or "").strip()
    if s.lower() in ADDR_EMPTY or s in ADDR_EMPTY:
        return ""
    return s


def addr_parts(ad):
    # A single-line address (typed/edited in the review form) is
    # used verbatim as the one-liner — no labels, no re-joining.
    if isinstance(ad, str):
        return ad.strip()
    ad = ad or {}
    parts = []

    def digits(v):
        return bn_num(v)

    h = addr_clean(ad.get("holding"))
    if h:
        parts.append("বাসা/হোল্ডিংঃ " + digits(h))
    vill = []
    for k in ("village", "additional_village"):
        v = addr_clean(ad.get(k))
        if v and v not in vill:
            vill.append(digits(v))
    if vill:
        parts.append("গ্রাম/রাস্তাঃ " + ", ".join(vill))
    w = addr_clean(ad.get("ward_porishod"))
    if w:
        parts.append("ওয়ার্ড নংঃ " + digits(w))
    mou = []
    for k in ("mouza", "additional_mouza"):
        v = addr_clean(ad.get(k))
        if v and v not in vill and v not in mou:
            mou.append(v)
    if mou:
        parts.append("মৌজা/মহল্লাঃ " + ", ".join(mou))
    pc = addr_clean(ad.get("postal_code"))
    if pc:
        parts.append("পোস্ট কোডঃ " + digits(pc))
    th = addr_clean(ad.get("thana"))
    if th:
        parts.append("থানাঃ " + th)
    up = addr_clean(ad.get("upozila"))
    if up:
        parts.append("উপজেলাঃ " + up)
    di = addr_clean(ad.get("district"))
    if di:
        parts.append("জেলাঃ " + di)
    dv = addr_clean(ad.get("division"))
    if dv:
        parts.append("বিভাগঃ " + dv)
    return ", ".join(parts) + ("।" if parts else "")


def norm_gender(g):
    g = (g or "").strip()
    gl = g.lower()
    if gl.startswith("m") or "পুরুষ" in g:
        return "পুরুষ"
    if gl.startswith("f") or "মহিলা" in g or "নারী" in g:
        return "মহিলা"
    return g


def norm_religion(r):
    r = (r or "").strip()
    if r.lower() in ("islam", "muslim", "ইসলাম"):
        return "ইসলাম"
    if r.lower() in ("hindu", "হিন্দু"):
        return "হিন্দু"
    if r.lower() in ("buddhist", "buddhism", "বৌদ্ধ"):
        return "বৌদ্ধ"
    if r.lower() in ("christian", "খ্রিস্টান"):
        return "খ্রিস্টান"
    return r


def serial_from_voter(voter):
    v = str(voter or "").strip()
    return v[-13:] if len(v) >= 14 else v


def bn_bold():
    """Nirmala.ttc theke Bold face ber kore cache kore (label-er jonno)."""
    if not FONT_BN.lower().endswith(".ttc"):
        return FONT_BN
    p = os.path.join(ROOT, "work", "_Nirmala-Bold.ttf")
    if os.path.exists(p):
        return p
    try:
        from fontTools.ttLib import TTCollection
        col = TTCollection(FONT_BN)
        for f in col.fonts:
            name = f["name"].getDebugName(1) or ""
            style = f["name"].getDebugName(2) or ""
            if "Nirmala" in name and style == "Bold":
                os.makedirs(os.path.dirname(p), exist_ok=True)
                f.save(p)
                return p
    except Exception:
        pass
    return FONT_BN


# Template-er bhanga Bangla label (sample PDF theke asha) — build-er somoy
# thik kore deya hoy, jate prottek output-e shuddho Bangla thake.
LABEL_FIX_V1 = [
    ((74.0, 378.5, 111.5, 396.5), "ভোটার", 10.19),
    ((71.7, 555.7, 205.0, 574.7), "অন্যান্য তথ্য", 11.55),
    ((74.0, 606.8, 205.0, 624.8), "জন্মস্থান", 10.19),
    # header: "নির্বাাচন" -> "নির্বাচন"
    ((215.0, 87.5, 382.0, 103.2), "বাংলাদেশ নির্বাচন কমিশন", 10.87,
     "reg", "center"),
    ((215.0, 103.2, 382.0, 118.8), "নির্বাচন কমিশন সচিবালয়", 10.87,
     "reg", "center"),
    # "ব্যক্তি গত তথ্য" -> "ব্যক্তিগত তথ্য"
    ((71.7, 400.9, 205.0, 418.6), "ব্যক্তিগত তথ্য", 11.55),
    # "স্থাায়ী ঠিকানা" -> "স্থায়ী ঠিকানা"
    ((71.7, 704.7, 205.0, 722.4), "স্থায়ী ঠিকানা", 11.55),
]
LABEL_FIX_V2 = [
    ((229.6, 474.5, 334.0, 492.5), "স্বামী/স্ত্রীর নাম", 10.59, "sol"),
    ((230.8, 497.2, 330.0, 515.2), "অন্যান্য তথ্য", 12.1, "sol"),
    ((229.6, 522.9, 300.0, 540.9), "ধর্ম", 10.59, "sol"),
    ((229.6, 587.9, 300.0, 605.9), "জন্মস্থান", 10.59, "sol"),
    # "ব্যক্তি গত তথ্য" -> "ব্যক্তিগত তথ্য"
    ((230.8, 346.1, 400.0, 364.2), "ব্যক্তিগত তথ্য", 12.1, "sol"),
    # "স্থাায়ী ঠিকানা" -> "স্থায়ী ঠিকানা"
    ((230.8, 693.9, 400.0, 712.2), "স্থায়ী ঠিকানা", 12.1, "sol"),
]

# v2 grid — sample-er image-e je border ache, sei same coordinate-e crisp
# vector line (JPEG background-er line ghola/soft, tai vector overlay).
V2_GRID_L, V2_GRID_R, V2_GRID_M = 227.0, 518.4, 333.5
V2_GRID_TOP, V2_GRID_BOT = 211.9, 774.2
V2_GRID_ROWS = [
    235.0, 256.35, 277.6, 298.95, 320.2, 341.4, 364.4, 385.6, 407.0,
    428.2, 449.6, 470.8, 491.95, 515.0, 539.8, 561.15, 582.4, 603.6,
    626.65, 688.75, 711.95,
]


def draw_v2_borders(page):
    """v2 table-er border gulo crisp kore draw kore (design same thake)."""
    col = (0.84, 0.86, 0.86)          # light gray, sample-er cheye ektu clear
    w = 0.55
    for y in V2_GRID_ROWS:
        page.draw_line((V2_GRID_L, y), (V2_GRID_R, y),
                       color=col, width=w, overlay=True)
    page.draw_line((V2_GRID_L, V2_GRID_TOP), (V2_GRID_L, V2_GRID_BOT),
                   color=col, width=w, overlay=True)
    page.draw_line((V2_GRID_R, V2_GRID_TOP), (V2_GRID_R, V2_GRID_BOT),
                   color=col, width=w, overlay=True)
    # mid divider band-row gulo-te jay na (sample-er moto)
    for y0, y1 in ((235.0, 341.4), (364.4, 491.95), (515.0, 603.6)):
        page.draw_line((V2_GRID_M, y0), (V2_GRID_M, y1),
                       color=col, width=w, overlay=True)


def fix_labels(page, fixes):
    redact_text(page, [f[0] for f in fixes])
    for f in fixes:
        r, txt, sz = f[0], f[1], f[2]
        kind = f[3] if len(f) > 3 else "bold"
        align = f[4] if len(f) > 4 else "left"
        if kind == "sol":
            fnt = FONT_SOL
        elif kind == "reg":
            fnt = FONT_BN
        else:
            fnt = bn_bold()
        hb(page, r, txt, sz, fnt, align=align, line_height=1.2)


def main(data_path="work/input_data.json", out_dir="output"):
    if not os.path.exists(data_path):
        print("NOT FOUND:", data_path)
        return 1
    data = json.load(open(data_path, encoding="utf-8"))
    imgs = {}
    ip = os.path.join(os.path.dirname(data_path), "input_images.json")
    if os.path.exists(ip):
        imgs = json.load(open(ip, encoding="utf-8"))
    os.makedirs(out_dir, exist_ok=True)

    nid = str(data.get("National ID", "") or "").strip()
    pin = str(data.get("Pin", "") or "").strip()
    voter = str(data.get("Voter No", "") or "").strip()
    area = str(data.get("Voter Area", "") or "").strip()
    name_bn = str(data.get("Name(Bangla)", "") or "").strip()
    name_en = str(data.get("Name(English)", "") or "").strip()
    dob = str(data.get("Date of Birth", "") or "").strip()
    father = str(data.get("Father Name", "") or "").strip()
    mother = str(data.get("Mother Name", "") or "").strip()
    spouse = str(data.get("Spouse Name", "") or "").strip()
    gender = norm_gender(data.get("Gender"))
    birth = str(data.get("Birth Place", "") or "").strip()
    religion = norm_religion(data.get("Religion"))
    occ = str(data.get("Occupation", "") or "").strip()
    serial = serial_from_voter(voter)
    rid = str(data.get("Report Id", "") or "").strip()
    p_addr = addr_parts(data.get("Present Address"))
    m_addr = addr_parts(data.get("Permanent Address"))
    name_en = name_en.upper()
    photo = imgs.get("photo") or os.path.join(os.path.dirname(data_path),
                                              "images", "photo.png")
    if not os.path.exists(photo):
        photo = None

    base = nid if nid else "report"
    v1_path = os.path.join(out_dir, base + "-v1.pdf")
    v2_path = os.path.join(out_dir, base + "-v2.pdf")
    print("v1 report ...")
    make_v1(nid, pin, voter, area, serial, name_bn, name_en, dob, father,
            mother, gender, birth, p_addr, m_addr, photo, v1_path, rid)
    print("v2 report ...")
    make_v2(nid, pin, voter, area, serial, name_bn, name_en, dob, father,
            mother, spouse, gender, birth, religion, occ, p_addr, m_addr,
            photo, v2_path)
    print("Done -> %s, %s" % (v1_path, v2_path))
    return 0


def make_v1(nid, pin, voter, area, serial, name_bn, name_en, dob, father,
            mother, gender, birth, p_addr, m_addr, photo, out_pdf, rid=""):
    doc = pymupdf.open(os.path.join(ROOT, "report_v1_template.pdf"))
    page = doc[0]
    # Span-bbox diye redact korle majhkhane glyph bachiya jay (template-er
    # bhanga lekha theke ghost glyph ashe). Tai puro block area redact kori.
    rects = [
        (205, 250, 582, 622),     # value column (sob row)
        (66, 651, 560, 700),      # present address
        (66, 726, 560, 780),      # permanent address
        (0, 812, 582, 838),       # footer URL + page number (v1-e chai na)
    ]
    for b in page.get_text("dict")["blocks"]:      # header (logo-r pashe)
        for l in b.get("lines", []):
            for s in l["spans"]:
                x0, y0, x1, y1 = s["bbox"]
                if s["text"].strip() and y0 < 25 and (x0 > 300 or x0 < 200):
                    rects.append((x0 - 1, y0 - 1, x1 + 1, y1 + 1))
    redact_text(page, rects)
    fix_labels(page, LABEL_FIX_V1)

    # photo (kona gol + frame-r vitore bosao)
    if photo:
        ph = rounded_photo(photo,
                           os.path.join(os.path.dirname(out_pdf), "_ph1.png"),
                           (260.9, 148.1, 335.6, 229.6), radius=3.6)
        page.insert_image(pymupdf.Rect(260.9, 148.1, 335.6, 229.6),
                          filename=ph, keep_proportion=False)
        if ph != photo:
            try:
                os.remove(ph)
            except OSError:
                pass

    # values — x=212.1, row tops (bbox y0)
    rows = [
        (274.3, nid, FONT_LAT),
        (300.1, pin, FONT_LAT),
        (326.0, voter, FONT_LAT),
        (351.8, area, FONT_BN),
        (377.6, serial, FONT_LAT),
        (427.2, name_bn, FONT_BN),
        (453.0, name_en, FONT_LAT),
        (478.8, dob, FONT_LAT),
        (504.6, father, FONT_BN),
        (530.5, mother, FONT_BN),
        (580.1, gender, FONT_BN),
        (605.9, birth, FONT_BN),
    ]
    for y, txt, fnt in rows:
        if txt:
            hb(page, (211.1, y + 0.3, 522.5, y + 15.0), txt, 10.2, fnt,
               line_height=1.3)

    # addresses (sample-er moto bold, NirmalaUI-Bold 10.19)
    hb(page, (74.9, 654.8, 523.0, 698.0), p_addr, 10.1, bn_bold(),
       line_height=1.335)
    hb(page, (74.9, 730.2, 523.0, 773.5), m_addr, 10.1, bn_bold(),
       line_height=1.335)

    # upor-er chuto print-header (time / v1_<nid>) ar nicher chuto
    # link/page-number v1 report-e dekhate hobe na.

    doc.save(out_pdf, garbage=4, deflate=True)
    doc.close()


def make_qr(text, path):
    import qrcode
    img = qrcode.make(text, box_size=8, border=0)
    img.save(path)


def rounded_photo(src, dst, rect, radius=4.0):
    """Chhobi-r kona gol kore (sample report-er moto). Fail hole original."""
    try:
        from PIL import Image, ImageDraw
        w_pt, h_pt = rect[2] - rect[0], rect[3] - rect[1]
        scale = 8
        W, H = max(2, int(w_pt * scale)), max(2, int(h_pt * scale))
        r = max(1, int(radius * scale))
        im = Image.open(src).convert("RGB").resize((W, H), Image.LANCZOS)
        mask = Image.new("L", (W, H), 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, W - 1, H - 1],
                                               radius=r, fill=255)
        out = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        out.paste(im, (0, 0), mask)
        out.save(dst)
        return dst
    except Exception:
        return src


def make_v2(nid, pin, voter, area, serial, name_bn, name_en, dob, father,
            mother, spouse, gender, birth, religion, occ, p_addr, m_addr,
            photo, out_pdf):
    doc = pymupdf.open(os.path.join(ROOT, "report_v2_template.pdf"))
    page = doc[0]
    # puro block area — ghost glyph/jogfnog kichu na thake
    redact_text(page, [
        (330, 228, 582, 602),      # value column
        (225, 626, 582, 668),      # present address
        (225, 711.2, 582, 752),    # permanent address
        (94, 310, 206, 342),       # QR caption
    ])
    fix_labels(page, LABEL_FIX_V2)

    if photo:
        ph = rounded_photo(photo,
                           os.path.join(os.path.dirname(out_pdf), "_ph2.png"),
                           (103.1, 205.4, 194.6, 311.3), radius=4.0)
        page.insert_image(pymupdf.Rect(103.1, 205.4, 194.6, 311.3),
                          filename=ph, keep_proportion=False)
        if ph != photo:
            try:
                os.remove(ph)
            except OSError:
                pass

    # QR
    qr_txt = ("%s %s %s" % (name_en, nid, dob)).strip()
    qp = os.path.join(os.path.dirname(out_pdf), "_qr.png")
    make_qr(qr_txt, qp)
    page.insert_image(pymupdf.Rect(118.2, 344.5, 182.5, 408.8), filename=qp)
    try:
        os.remove(qp)
    except OSError:
        pass

    rows = [
        (240.4, nid, FONT_LAT, 10.6),
        (262.4, pin, FONT_LAT, 10.6),
        (282.8, voter, FONT_LAT, 10.6),
        (303.2, serial, FONT_BN, 10.6),
        (324.4, area, FONT_BN, 10.6),
        (369.0, name_bn, FONT_BN, 10.6),
        (391.7, name_en, FONT_LAT, 10.6),
        (412.9, dob, FONT_LAT, 10.6),
        (434.1, father, FONT_BN, 10.6),
        (455.2, mother, FONT_BN, 10.6),
        (474.9, spouse, FONT_BN, 10.6),
        (523.3, religion, FONT_BN, 10.6),
        (546.0, gender, FONT_BN, 10.6),
        (567.9, occ, FONT_BN, 10.6),
        (588.3, birth, FONT_BN, 10.6),
    ]
    for y, txt, fnt, sz in rows:
        if txt:
            latin = fnt == FONT_LAT
            fnt = FONT_SOL if fnt == FONT_BN else fnt
            if latin and os.path.exists(FONT_ROB):
                fnt = FONT_ROB
            top = y - (1.5 if fnt == FONT_ROB else 1.0)
            hb(page, (335.4, top, 514, top + 15.0), txt, sz, fnt,
               line_height=1.3)

    # addresses (sample-er moto SolaimanLipi 9.45)
    hb(page, (227.8, 627.0, 514.0, 667.0), p_addr, 9.45, FONT_SOL,
       line_height=1.28)
    hb(page, (227.8, 711.8, 514.0, 751.8), m_addr, 9.45, FONT_SOL,
       line_height=1.28)

    # QR-er niche naam
    hb(page, (98.0, 323.3, 201.0, 341.0), name_en, 9.4, FONT_LAT,
       align="center", line_height=1.2)

    # crisp grid (sample-er same coordinate, sudhu border)
    draw_v2_borders(page)

    doc.save(out_pdf, garbage=4, deflate=True)
    doc.close()


if __name__ == "__main__":
    sys.exit(main(*sys.argv[1:]))
