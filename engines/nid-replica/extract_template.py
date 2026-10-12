# -*- coding: utf-8 -*-
"""
ব্যবহার: python extract_template.py output_template.pdf

NID কার্ড টেমপ্লেটের লেআউট মেপে work/ ফোল্ডারে রাখে:
  work/template.json   - পেজ সাইজ, পরিষ্কার টেক্সট (slot লেবেলসহ), ইমেজ স্লট,
                         ঠিকানার বিশেষ স্লট (address_slot)
  work/image_map.json  - কোন স্লটে কোন ছবি বসবে (photo/sign অটো, বাকি keep)
"""
import sys
import os
import json

if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

try:
    import pymupdf
except ImportError:
    import fitz as pymupdf



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
                              "color": s["color"]})
    return spans


def drop_contained(spans):
    """যে স্প্যান আরেকটার ভেতরে পুরো ঢুকে আছে, সেটা বাদ দাও (ডুপ্লিকেট ফন্ট লেয়ার)।"""
    ordered = sorted(spans, key=lambda s: (s["x1"] - s["x0"]) * (s["y1"] - s["y0"]),
                     reverse=True)
    kept = []
    for s in ordered:
        dup = False
        for t in kept:
            if (t["x0"] <= s["x0"] + 1 and t["x1"] >= s["x1"] - 1 and
                    t["y0"] <= s["y0"] + 2 and t["y1"] >= s["y1"] - 2 and
                    len(t["text"]) >= len(s["text"])):
                dup = True
                break
        if not dup:
            kept.append(s)
    return kept


def split_colon_lines(page, pno, spans):
    """লেবেল+মান এক লাইনে মিশে থাকা জায়গা ('জন্মস্থান: কুমিল্লা',
    'প্রদানের তারিখ: ১৬/০৮/২০২৬') ':'-এর ঠিক জায়গায় ভাগ করো।
    টেমপ্লেটের ToUnicode ভাঙা বলে rawdict-এর অক্ষর-বক্স ব্যবহার করা হয়;
    স্লট-নাম জোর করে সঠিক লেবেলে বসানো হয়।"""
    targets = [
        {"x0": (395, 450), "y0": (115, 140), "slot": "জন্মস্থান:"},
        {"x0": (435, 535), "y0": (150, 172), "slot": "প্রদানের তারিখ:"},
    ]
    try:
        rd = page.get_text("rawdict")
    except Exception:
        return spans
    chars = []
    for b in rd["blocks"]:
        if b["type"] != 0:
            continue
        for ln in b["lines"]:
            for s in ln["spans"]:
                for ch in s["chars"]:
                    if ch["c"].strip():
                        chars.append(ch)
    out = list(spans)
    for tg in targets:
        seed = [ch for ch in chars
                if tg["x0"][0] <= ch["bbox"][0] <= tg["x0"][1]
                and tg["y0"][0] <= ch["bbox"][1] <= tg["y0"][1]]
        if not seed:
            continue
        yc0 = sum((ch["bbox"][1] + ch["bbox"][3]) / 2 for ch in seed) / len(seed)
        x_lo = min(ch["bbox"][0] for ch in seed) - 8
        x_hi = max(ch["bbox"][2] for ch in seed) + 8
        line = [ch for ch in chars
                if abs((ch["bbox"][1] + ch["bbox"][3]) / 2 - yc0) < 6
                and x_lo <= ch["bbox"][0] <= x_hi]
        colons = sorted([ch for ch in line if ch["c"] == ":"],
                        key=lambda ch: ch["bbox"][0])
        if not colons:
            continue
        split_x = colons[0]["bbox"][2]
        xs = [ch["bbox"][0] for ch in line]
        xe = [ch["bbox"][2] for ch in line]
        ys = [ch["bbox"][1] for ch in line]
        ye = [ch["bbox"][3] for ch in line]
        size, color = 9.0, 0
        for s in spans:
            if (s["page"] == pno and abs(s["y0"] - min(ys)) < 4
                    and s["x0"] < split_x < s["x1"] + 40):
                size, color = s["size"], s["color"]
                break
        # লাইনের পুরনো স্প্যান সরিয়ে লেবেল+মান আলাদা করো
        out = [s for s in out if not (
            s["page"] == pno and s["x0"] >= min(xs) - 2
            and s["x1"] <= max(xe) + 2
            and abs((s["y0"] + s["y1"]) / 2 - yc0) < 6)]
        out.append({"page": pno, "text": tg["slot"],
                    "x0": round(min(xs), 2), "y0": round(min(ys), 2),
                    "x1": round(split_x, 2), "y1": round(max(ye), 2),
                    "size": size, "color": color, "is_label": True})
        out.append({"page": pno, "text": "",
                    "x0": round(split_x + 1, 2), "y0": round(min(ys), 2),
                    "x1": round(max(xe), 2), "y1": round(max(ye), 2),
                    "size": size, "color": color})
    return out


def detect_address_slot(spans, pno, page=None):
    """ঠিকানার লাইন খুঁজে বিশেষ স্লট বানাও। টেমপ্লেটে লেবেল+মান একই
    স্প্যানে মিশে থাকে ('িঠকানা: বাসা/...'), তাই পুরো লাইনটাই নতুন করে
    রেন্ডার করা হয় — inpaint rect + baseline তথ্যসহ।"""
    cands = [s for s in spans
             if s["page"] == pno and "ঠ" in s["text"] and ":" in s["text"]
             and 60 < s["y0"] < 140]
    if not cands:
        return None
    lab = sorted(cands, key=lambda s: (s["y0"], s["x0"]))[0]
    lx0, ly0 = lab["x0"], lab["y0"]
    line1 = [s for s in spans
             if s["page"] == pno and s["x0"] >= lx0 - 1
             and ly0 - 2 <= s["y0"] <= ly0 + 4]
    line2 = [s for s in spans
             if s["page"] == pno and s["x0"] >= lx0 - 40
             and ly0 + 6 < s["y0"] < ly0 + 26]
    if not line1:
        return None
    allx = line1 + line2
    x0 = min(s["x0"] for s in allx) - 2
    y0 = ly0 - 2.5
    x1 = max(s["x1"] for s in line1) + 2
    y1 = (max(s["y1"] for s in line2) + 2) if line2 else lab["y1"] + 2
    # baseline মাপার জানালা: লেবেল-কালির ঠিক বাম-ডান (মান শুরুর ৩০pt বামে)
    others = [s["x0"] for s in line1 if s is not lab]
    base_vx0 = max(others) if others else lab["x1"]
    # line_step: baseline-to-baseline (রেন্ডার থেকে মাপা — span-এর y0-to-y0
    # ভুল হয়, কারণ ফন্টের ascender ভেদে baseline সরে)
    # 300 DPI full-page render, 90th-percentile baseline
    if page is not None and line2:
        try:
            import numpy as _np
            _dpi, _s = 300, 300 / 72.0
            _pix = page.get_pixmap(dpi=_dpi)
            _img = _np.frombuffer(_pix.samples, dtype=_np.uint8).reshape(
                _pix.height, _pix.width, 3).astype(int)
            _x0, _x1 = int(340*_s), int(545*_s)
            _y0, _y1 = int(80*_s), int(108*_s)
            _crop = _img[_y0:_y1, _x0:_x1]
            _dark = _crop.sum(axis=2) < 384
            _prof = _dark.mean(axis=1)
            _rows = _np.where(_prof > 0.02)[0]
            if len(_rows) > 10:
                _lo, _hi = int(len(_prof)*0.3), int(len(_prof)*0.7)
                _v = _np.argmin(_prof[_lo:_hi]) + _lo
                _l1 = _rows[_rows < _v]; _l2 = _rows[_rows >= _v]
                if len(_l1) > 3 and len(_l2) > 3:
                    _b1 = 80 + _np.percentile(_l1, 90) / _s
                    _b2 = 80 + _np.percentile(_l2, 90) / _s
                    line_step = round(float(_b2 - _b1), 2)
                else:
                    line_step = round(line2[0]["y0"] - ly0, 2)
            else:
                line_step = round(line2[0]["y0"] - ly0, 2)
        except Exception:
            line_step = round(line2[0]["y0"] - ly0, 2)
    else:
        line_step = (round(line2[0]["y0"] - ly0, 2) if line2
                     else round(lab["size"] * 0.92, 2))
    # line_step: 9.2 — visual gap 6.7pt, template-এর 6.8pt-এর সাথে match (measured 2026-09-28)
    line_step = 9.2
    return {
        "label": "ঠিকানা:",
        "x0": round(lx0, 2), "y0": round(ly0, 2),
        "wrap_width": round(max(s["x1"] for s in line1) - lx0, 2),
        "size": lab["size"], "color": lab["color"],
        "rect": [round(x0, 2), round(y0, 2), round(x1, 2), round(y1, 2)],
        "line_step": line_step,
        "base_vx0": round(base_vx0, 2),
        "base_y0": round(ly0, 2), "base_y1": round(lab["y1"], 2),
    }


def is_label_text(t):
    return t.strip().endswith(":")


def merge_colon_labels(spans):
    """একা ':' কে বামের কাছের টেক্সটের সাথে জোড়া লাগিয়ে লেবেল বানাও।"""
    others = [s for s in spans if s["text"].strip() != ":"]
    colons = [s for s in spans if s["text"].strip() == ":"]
    used = set()
    result = []
    for col in sorted(colons, key=lambda s: (s["y0"], s["x0"])):
        yc = (col["y0"] + col["y1"]) / 2
        # বামে একই লাইনে, কাছাকাছি ফাঁকে চেইন ধরে এগোও
        chain = []
        cur_x = col["x0"]
        while True:
            best = None
            best_gap = 1e9
            for s in others:
                if id(s) in used or s["page"] != col["page"]:
                    continue
                syc = (s["y0"] + s["y1"]) / 2
                if abs(syc - yc) > col["size"] * 0.7:
                    continue
                gap = cur_x - s["x1"]
                if -1 <= gap < best_gap:
                    best, best_gap = s, gap
            if best is None or best_gap > col["size"] * 0.6:
                break
            chain.append(best)
            used.add(id(best))
            cur_x = best["x0"]
        if chain:
            chain = chain[::-1]
            x0 = min([c["x0"] for c in chain] + [col["x0"]])
            x1 = col["x1"]
            y0 = min([c["y0"] for c in chain] + [col["y0"]])
            y1 = max([c["y1"] for c in chain] + [col["y1"]])
            label = " ".join(c["text"].strip() for c in chain) + ":"
            base = chain[0]
            result.append({"page": col["page"], "text": label,
                           "x0": round(x0, 2), "y0": round(y0, 2),
                           "x1": round(x1, 2), "y1": round(y1, 2),
                           "size": base["size"], "color": base["color"],
                           "is_label": True})
        # ':' স্প্যানটা বাদ (লেবেলে ঢুকে গেছে বা একা ছিল)
    for s in others:
        if id(s) not in used:
            s["is_label"] = is_label_text(s["text"])
            result.append(s)
    return result


def join_fragments(cands):
    parts = []
    prev = None
    for c in cands:
        if prev is not None:
            gap = c["x0"] - prev["x1"]
            parts.append(" " if gap > c["size"] * 0.12 else "")
        parts.append(c["text"])
        prev = c
    return "".join(parts).strip()


def build_texts(spans):
    """লেবেল -> মান স্লট গ্রুপ করে পরিষ্কার টেক্সট তালিকা বানাও।"""
    labels = [s for s in spans if s.get("is_label")]
    values = [s for s in spans if not s.get("is_label")]
    groups = {}  # id(label) -> [spans]
    static = []
    for v in values:
        yc = (v["y0"] + v["y1"]) / 2
        best, best_dx = None, 1e9
        for L in labels:
            if L["page"] != v["page"]:
                continue
            lyc = (L["y0"] + L["y1"]) / 2
            if abs(lyc - yc) > L["size"] * 0.8:
                continue
            dx = v["x0"] - L["x1"]
            if -2 <= dx < best_dx:
                best, best_dx = L, dx
        if best is not None:
            groups.setdefault(id(best), []).append(v)
        else:
            static.append(v)
    texts = []
    for L in labels:
        g = sorted(groups.get(id(L), []), key=lambda s: s["x0"])
        # চেইন: পাশাপাশি টুকরোই মানের অংশ; দূরের টেক্সট static-এ ফেরত
        chained = []
        for s in g:
            if chained and s["x0"] - chained[-1]["x1"] > chained[-1]["size"] * 1.5:
                static.append(s)
            else:
                chained.append(s)
        if chained:
            first = chained[0]
            x1 = max(s["x1"] for s in chained)
            y1 = max(s["y1"] for s in chained)
            slot_name = L["text"].strip()
            if slot_name.startswith("িপতা"):  # ভাঙা ToUnicode: "িপতা:" = পিতা:
                slot_name = "পিতা:"
            texts.append({"text": join_fragments(chained), "slot": slot_name,
                          "x0": first["x0"], "y0": first["y0"],
                          "x1": round(x1, 2), "y1": round(y1, 2),
                          "size": first["size"], "color": first["color"]})
        # মানহীন লেবেল (যেমন Blood Group:) আঁকার দরকার নেই, লেবেল স্প্যানটাই আঁকা হবে নিচে
        texts.append({"text": L["text"], "slot": None,
                      "x0": L["x0"], "y0": L["y0"],
                      "size": L["size"], "color": L["color"]})
    for v in static:
        texts.append({"text": v["text"], "slot": None,
                      "x0": v["x0"], "y0": v["y0"],
                      "size": v["size"], "color": v["color"]})
    texts.sort(key=lambda t: (t["y0"], t["x0"]))
    return texts


def find_issue_sign():
    d = "shakkhor"
    if os.path.isdir(d):
        for fn in sorted(os.listdir(d)):
            if fn.lower().endswith(".png"):
                p = os.path.join(d, fn)
                if os.path.isfile(p):
                    return p
    return None


def classify_slot(bbox, W, H):
    x0, y0, x1, y1 = bbox
    w, h = x1 - x0, y1 - y0
    if w <= 0 or h <= 0:
        return "keep"
    r, area = w / h, w * h
    # Photo is around x=60, w=45, h=60 (ratio ~0.75)
    if x0 < 85 and 100 <= y0 <= 125 and 35 <= w <= 65 and 45 <= h <= 80:
        return "photo"
    # Applicant sign is under the photo around x=63, y=170, w=42, h=20
    if x0 < 85 and y0 >= 165 and h <= 35 and 1.3 <= r <= 4.0:
        return "sign"
    # Authority signature is on the back page around x=324, y=135, w=58, h=21.5
    if x0 > 250 and y0 > 120 and r > 1.8 and area < 3000:
        return "authority_sign"
    return "keep"



def extract_template_specs_from_stream(doc, page_no=0):
    page = doc[page_no]
    W, H = page.rect.width, page.rect.height
    import re
    stream = doc.xref_stream(page.get_contents()[0]).decode("latin1", errors="replace")
    
    text_blocks = re.findall(r'q\s+BT\b.*?ET\s+Q', stream, re.DOTALL)
    field_specs = {}
    
    for b in text_blocks:
        td = re.findall(r'([\d\.\-]+)\s+([\d\.\-]+)\s+Td', b)
        if not td:
            continue
        x, y = float(td[0][0]), float(td[0][1])
        font_m = re.findall(r'/(\w+)\s+([\d\.]+)\s+Tf', b)
        font_size = float(font_m[0][1]) if font_m else 0.0
        w_m = re.findall(r'([\d\.]+)\s+w', b)
        stroke_w = float(w_m[0]) if w_m else 0.0
        rg_m = re.findall(r'([\d\.]+)\s+([\d\.]+)\s+([\d\.]+)\s+rg', b)
        color = [float(c) for c in rg_m[0]] if rg_m else [0.0, 0.0, 0.0]
        color_hex = "#%02x%02x%02x" % (int(round(color[0]*255)), int(round(color[1]*255)), int(round(color[2]*255)))

        if abs(y - 674.09) < 1.0 and abs(x - 146.14) < 1.0:
            field_specs["নাম:"] = {"font": "fonts/Bangla.ttf", "size": font_size, "x0": x, "baseline": y, "y_top": round(H - y, 2), "stroke_pt": stroke_w, "color": color_hex}
        elif abs(y - 655.43) < 1.0 and abs(x - 146.14) < 1.0:
            field_specs["Name:"] = {"font": "fonts/ArialMT.ttf", "size": font_size, "x0": x, "baseline": y, "y_top": round(H - y, 2), "stroke_pt": stroke_w, "color": color_hex}
        elif abs(y - 639.69) < 1.0 and abs(x - 146.14) < 1.0:
            field_specs["পিতা:"] = {"font": "fonts/Bangla.ttf", "size": font_size, "x0": x, "baseline": y, "y_top": round(H - y, 2), "stroke_pt": stroke_w, "color": color_hex}
        elif abs(y - 623.69) < 1.0 and abs(x - 146.14) < 1.0:
            field_specs["মাতা:"] = {"font": "fonts/Bangla.ttf", "size": font_size, "x0": x, "baseline": y, "y_top": round(H - y, 2), "stroke_pt": stroke_w, "color": color_hex}
        elif abs(y - 609.10) < 1.0 and abs(x - 170.08) < 1.0:
            field_specs["Date of Birth:"] = {"font": "fonts/ArialMT.ttf", "size": font_size, "x0": x, "baseline": y, "y_top": round(H - y, 2), "stroke_pt": stroke_w, "color": color_hex}
        elif abs(y - 595.54) < 1.0 and abs(x - 145.09) < 1.0:
            field_specs["ID NO:"] = {"font": "fonts/ArialMT.ttf", "size": font_size, "x0": x, "baseline": y, "y_top": round(H - y, 2), "stroke_pt": stroke_w, "color": color_hex}
        elif abs(y - 661.86) < 1.0 and abs(x - 383.62) < 1.0:
            field_specs["/Blood Group:"] = {"font": "fonts/ArialMT.ttf", "size": font_size, "x0": x, "baseline": y, "y_top": round(H - y, 2), "stroke_pt": stroke_w, "color": color_hex}
        elif abs(y - 662.08) < 1.0 and abs(x - 426.08) < 1.0:
            field_specs["জন্মস্থান:"] = {"font": "fonts/Bangla.ttf", "size": font_size, "x0": x, "baseline": y, "y_top": round(H - y, 2), "stroke_pt": stroke_w, "color": color_hex}

    # Fallback / exact specs
    if "নাম:" not in field_specs:
        field_specs["নাম:"] = {"font": "fonts/Bangla.ttf", "size": 12.4, "x0": 146.14, "baseline": 674.09, "y_top": 117.91, "stroke_pt": 0.41333, "color": "#000000"}
    if "Name:" not in field_specs:
        field_specs["Name:"] = {"font": "fonts/ArialMT.ttf", "size": 10.3, "x0": 146.14, "baseline": 655.43, "y_top": 136.57, "stroke_pt": 0.0, "color": "#000000"}
    if "পিতা:" not in field_specs:
        field_specs["পিতা:"] = {"font": "fonts/Bangla.ttf", "size": 10.5, "x0": 146.14, "baseline": 639.69, "y_top": 152.31, "stroke_pt": 0.0, "color": "#000000"}
    if "মাতা:" not in field_specs:
        field_specs["মাতা:"] = {"font": "fonts/Bangla.ttf", "size": 10.5, "x0": 146.14, "baseline": 623.69, "y_top": 168.31, "stroke_pt": 0.0, "color": "#000000"}
    if "Date of Birth:" not in field_specs:
        field_specs["Date of Birth:"] = {"font": "fonts/ArialMT.ttf", "size": 9.0, "x0": 170.08, "baseline": 609.10, "y_top": 182.90, "stroke_pt": 0.0, "color": "#ff0000"}
    if "ID NO:" not in field_specs:
        field_specs["ID NO:"] = {"font": "fonts/ArialMT.ttf", "size": 9.0, "x0": 145.09, "baseline": 595.54, "y_top": 196.46, "stroke_pt": 0.3, "color": "#ff0000"}
    if "/Blood Group:" not in field_specs:
        field_specs["/Blood Group:"] = {"font": "fonts/ArialMT.ttf", "size": 7.0, "x0": 383.62, "baseline": 661.86, "y_top": 130.14, "stroke_pt": 0.23333, "color": "#ff0000"}
    if "জন্মস্থান:" not in field_specs:
        field_specs["জন্মস্থান:"] = {"font": "fonts/Bangla.ttf", "size": 8.0, "x0": 426.08, "baseline": 662.08, "y_top": 129.92, "stroke_pt": 0.0, "color": "#000000"}
    field_specs["প্রদানের তারিখ:"] = {"font": "fonts/Bangla.ttf", "size": 9.0, "x0": 490.40, "baseline": 628.16, "y_top": 163.84, "stroke_pt": 0.0, "color": "#000000"}

    address_spec = {
        "font": "fonts/Bangla.ttf",
        "size": 8.8,
        "x0": 332.72,
        "baseline_line1": 701.23,
        "baseline_line2": 693.23,
        "line_step": 8.00,
        "wrap_width": 207.0,
        "color": "#000000"
    }

    barcode_spec = {
        "x0": 310.73,
        "y0_top": 172.0,
        "baseline_y": 591.0,
        "w": 231.65,
        "h": 29.00,
        "columns": 8,
        "security_level": 4
    }

    return field_specs, address_spec, barcode_spec


def measure_ink_heights(pdf_path, pages):
    """প্রতিটি ASCII মান-স্লটের টেমপ্লেটে আসল রেন্ডার-হওয়া কালির উচ্চতা মাপো।"""
    try:
        import cv2
        import numpy as np
        doc = pymupdf.open(pdf_path)
        dpi = 150
        s = dpi / 72.0
        for pg in pages:
            pix = doc[pg["page"]].get_pixmap(dpi=dpi)
            img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(
                pix.height, pix.width, 3)
            for t in pg["texts"]:
                if not t.get("slot") or not (t.get("text") or "").strip():
                    continue
                if not all(ord(ch) < 128 for ch in t["text"]):
                    continue
                x0 = max(0, int(t["x0"] * s) - 2)
                x1 = int(t["x1"] * s) + 2
                y0 = max(0, int(t["y0"] * s) - 2)
                y1 = int(t["y1"] * s) + 2
                roi = img[y0:y1, x0:x1].astype(int)
                if (t.get("color") & 0xFFFFFF) == 0xFF0000:
                    dark = ((roi[:, :, 0] > 150) & (roi[:, :, 1] < 110)
                            & (roi[:, :, 2] < 110))
                else:
                    dark = roi.sum(axis=2) < 384
                ys = np.where(dark.any(axis=1))[0]
                if len(ys) > 1:
                    t["ink_h"] = round(float(ys.max() - ys.min()) / s, 2)
        doc.close()
    except Exception:
        pass


def main():
    pdf_path = sys.argv[1] if len(sys.argv) > 1 else "output_template.pdf"
    if not os.path.exists(pdf_path):
        print("NOT FOUND:", pdf_path)
        return
    os.makedirs("work/images", exist_ok=True)
    try:
        with open("work/input_images.json", encoding="utf-8") as f:
            in_images = json.load(f)
    except Exception:
        in_images = {}

    doc = pymupdf.open(pdf_path)
    pages = []
    imgmap = {}
    for pno, page in enumerate(doc):
        W, H = page.rect.width, page.rect.height
        spans = drop_contained(get_spans(page, pno))
        spans = split_colon_lines(page, pno, spans)
        addr_slot = detect_address_slot(spans, pno, page)
        spans = merge_colon_labels(spans)
        texts = build_texts(spans)
        slots = []
        for i, img in enumerate(page.get_images(full=True)):
            xref = img[0]
            try:
                r = page.get_image_bbox(img)
                bbox = [round(r.x0, 2), round(r.y0, 2),
                        round(r.x1, 2), round(r.y1, 2)]
            except Exception:
                continue
            kind = classify_slot(bbox, W, H)
            sid = "slot_p%d_%d" % (pno, i)
            slots.append({"id": sid, "page": pno, "xref": xref, "bbox": bbox, "kind": kind})
            
            rep = None
            if kind == "photo":
                rep = in_images.get("photo")
            elif kind == "sign":
                rep = in_images.get("sign")
            elif kind == "authority_sign":
                # টেমপ্লেটের আসল অফিসিয়াল স্বাক্ষর অক্ষত রাখো
                rep = None
            imgmap[sid] = {"kind": kind, "xref": xref, "bbox": bbox, "replace_with": rep}
            
        page_dict = {"page": pno, "width": W, "height": H,
                     "texts": texts, "slots": slots}
        if addr_slot:
            page_dict["address_slot"] = addr_slot
        pages.append(page_dict)

    field_specs, address_spec, barcode_spec = extract_template_specs_from_stream(doc, 0)
    doc.close()

    measure_ink_heights(pdf_path, pages)

    template_data = {
        "pages": pages,
        "template_pdf": os.path.abspath(pdf_path),
        "field_specs": field_specs,
        "address_spec": address_spec,
        "barcode_spec": barcode_spec,
    }

    with open("work/template.json", "w", encoding="utf-8") as f:
        json.dump(template_data, f, ensure_ascii=False, indent=1)
    with open("work/image_map.json", "w", encoding="utf-8") as f:
        json.dump(imgmap, f, ensure_ascii=False, indent=1)

    print("Done: %d pages, %d texts, %d slots -> work/template.json"
          % (len(pages), sum(len(p["texts"]) for p in pages),
             sum(len(p["slots"]) for p in pages)))
    for sid, m in imgmap.items():
        print("  %s kind=%s replace_with=%s" % (sid, m["kind"], m["replace_with"]))


if __name__ == "__main__":
    main()

