# -*- coding: utf-8 -*-
"""
ব্যবহার: python make_fields.py

work/input_data.json (ফর্মের ডেটা) + work/template.json (কার্ডের স্লট)
থেকে work/fields.json বানায় — এটাই এডিট করা যায়।
সাথে work/preview.html প্রিভিউ।
"""
import sys
import json
import os
import re
import html

if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

# কার্ডের লেবেল -> ফর্মের ফিল্ড
FIELD_MAP = {
    "নাম:": "Name(Bangla)",
    "Name:": "Name(English)",
    "পিতা:": "Father Name",
    "মাতা:": "Mother Name",
    "Date of Birth:": "Date of Birth",
    "ID NO:": "National ID",
    "জন্মস্থান:": "Birth Place",
}


MONTHS = {"01": "Jan", "02": "Feb", "03": "Mar", "04": "Apr",
          "05": "May", "06": "Jun", "07": "Jul", "08": "Aug",
          "09": "Sep", "10": "Oct", "11": "Nov", "12": "Dec"}


def clean_bn(text):
    """ডাবল মাত্রা এবং ওয়েব-প্রিন্ট ফন্ট-আর্টিফ্যাক্ট সাফ করো।"""
    if not text:
        return ""
    s = text
    # control/NUL bytes (ligature-cmap artifact) — kono field-e leak NA
    s = re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f]', '', s)
    s = s.replace("No Documents Available", "").strip()
    s = s.replace("Holding No", "").strip()
    # শুধুমাত্র যদি ওয়েব-প্রিন্টের বিশেষ গ্লিফ থাকে, তখন কনভার্ট করো
    if any(ch in s for ch in ('ĺ', 'Ƶ', 'Ȱ', 'ǻ', 'ɨ')):
        s = re.sub(r'ĺ([\u0995-\u09B9])', r'\1ে', s)
        s = re.sub(r'([\u0995-\u09B9])ৌ', r'\1ৌ', s)
        rep = {'Ƶ': 'প্রি', 'Ȱ': 'ন্দ্র', 'ǻ': 'ঞ্জ', 'ɨ': 'ল্ল', 'ĺ': 'ে'}
        for k, v in rep.items():
            s = s.replace(k, v)

    for bad, good in [("ুু", "ু"), ("ূূ", "ূ"), ("াা", "া"), ("িি", "ি"),
                      ("ীী", "ী"), ("েে", "ে"), ("োো", "ো"), ("ঃঃ", "ঃ"),
                      ("্্", "্"), ("ঁঁ", "ঁ")]:
        while bad in s:
            s = s.replace(bad, good)
            
    # Smart spacing for specific words
    s = s.replace("ওয়াসিমউদ্দিন", "ওয়াসিম উদ্দিন")
    s = s.replace("ওয়াসিমউদ্দিন", "ওয়াসিম উদ্দিন")
    s = s.replace("আলীআজগর", "আলী আজগর")
    s = s.replace("কুলছুমাখাতুন", "কুলছুমা খাতুন")
    s = s.replace("  ", " ")
    
    return s.strip()


def fmt_dob(s):
    """1977-02-02 -> 02 Feb 1977"""
    m = re.match(r"\s*(\d{4})-(\d{2})-(\d{2})\s*", s or "")
    if m:
        return "%s %s %s" % (m.group(3), MONTHS.get(m.group(2), m.group(2)), m.group(1))
    return (s or "").strip()


def bn_digits(s):
    """English digits -> Bengali digits: 30/08/2026 -> ৩০/০৮/২০২৬"""
    return (s or "").translate(str.maketrans("0123456789", "০১২৩৪৫৬৭৮৯"))


def compose_address(pa, data=None):
    """Present Address টেবিলের অংশ থেকে কার্ডের ঠিকানা বানাও:
    খালি অংশ বাদ যাবে — কোনো "-" চিহ্ন বসবে না।
    (আগে ফিক্সড ফরম্যাটে "-" বসত; এখন শুধু যা আছে তাই, কমা দিয়ে।)"""
    pa = pa or {}
    data = data or {}
    parts = []

    # ১. বাসা/হোল্ডিং (label সবসময় থাকবে)
    h = bn_digits(clean_bn(pa.get("holding", "")).strip())
    if h == "-":
        h = ""
    parts.append("বাসা/হোল্ডিং: " + h)

    # ২. গ্রাম/রাস্তা (label সবসময় থাকবে)
    #    গ্রাম ও মৌজা একই হলে শুধু গ্রাম; মৌজা ভিন্ন হলে গ্রামের পর কমা দিয়ে মৌজা
    vill_parts = []
    for k in ("village", "additional_village"):
        v = clean_bn(pa.get(k, "")).strip()
        if v and v not in vill_parts and v != "-":
            vill_parts.append(v)
    for k in ("mouza", "additional_mouza"):
        v = clean_bn(pa.get(k, "")).strip()
        if v and v not in vill_parts and v != "-":
            vill_parts.append(v)
    parts.append("গ্রাম/রাস্তা: " + ", ".join(vill_parts))

    # ৩. ডাকঘর ও পোস্টাল কোড (label সবসময় থাকবে)
    po = clean_bn(pa.get("post_office", "")).strip()
    pc = bn_digits(clean_bn(pa.get("postal_code", "")).strip())
    if pc == "-":
        pc = ""
    if po and pc:
        parts.append("ডাকঘর: %s - %s" % (po, pc))
    elif po:
        parts.append("ডাকঘর: " + po)
    elif pc:
        parts.append("ডাকঘর: " + pc)
    else:
        parts.append("ডাকঘর: ")

    # ৪. উপজেলা
    upozila = clean_bn(pa.get("upozila", "")).strip() or clean_bn(data.get("Upozila", "")).strip()
    # ৫. শহর (RMO সিটি/পৌরসভা হলে) — উপজেলার পরে, জেলার আগে
    #    city_corp field-e full name (যেমন "চট্টগ্রাম সিটি কর্পোরেশন") থাকবে;
    #    খালি হলে শুধু skip — RMO থেকে নাম নেওয়া হবে না।
    city_full = ""
    rmo_val = clean_bn(pa.get("rmo", "")).strip()
    if "সিটি" in rmo_val or "পৌরসভা" in rmo_val:
        c_parts = [clean_bn(pa.get(k, "")).strip()
                   for k in ("city_corp", "city_corp2", "city_corp3")]
        c_parts = [c for c in c_parts if c and c != "-"]
        city_full = " ".join(c_parts)
    # ৬. জেলা
    district = clean_bn(pa.get("district", "")).strip() or clean_bn(data.get("District", "")).strip()

    if upozila:
        parts.append(upozila)
    if city_full:
        parts.append(city_full)
    if district:
        parts.append(district)

    return bn_digits(", ".join(parts))


def main():
    for need in ("work/input_data.json", "work/template.json"):
        if not os.path.exists(need):
            print("পাওয়া যায়নি:", need, "-> আগে extract চালাও")
            return
    with open("work/input_data.json", encoding="utf-8") as f:
        data = json.load(f)
    with open("work/template.json", encoding="utf-8") as f:
        tpl = json.load(f)
    fields = build_fields(data, tpl)

    with open("work/fields.json", "w", encoding="utf-8") as f:
        json.dump(fields, f, ensure_ascii=False, indent=1)


    try:
        with open("work/input_images.json", encoding="utf-8") as f:
            in_images = json.load(f)
    except Exception:
        in_images = {}
    rows = "".join(
        "<tr><td><b>%s</b></td><td>%s</td></tr>" % (html.escape(k), html.escape(v))
        for k, v in fields.items())
    thumbs = "".join(
        "<div style='display:inline-block;text-align:center;margin:6px'>"
        "<img src='%s' style='max-height:140px;border:1px solid #ccc'><br><small>%s</small></div>"
        % (html.escape(v.replace("work/", "", 1)), html.escape(k))
        for k, v in in_images.items())
    addr_dbg = ""
    pa = data.get("Present Address")
    if isinstance(pa, dict) and pa:
        addr_dbg = ("<h2>ঠিকানার অংশ (input-এর Present Address টেবিল থেকে)</h2>"
                    "<table border='1' cellpadding='8' cellspacing='0'>" +
                    "".join("<tr><td><b>%s</b></td><td>%s</td></tr>"
                            % (html.escape(k), html.escape(v))
                            for k, v in pa.items()) + "</table>")
    preview = """<html><head><meta charset="utf-8">
<title>Fields Preview</title></head>
<body style="font-family:sans-serif;max-width:900px;margin:auto;padding:16px">
<h2>কার্ডে বসবে (edit: work/fields.json)</h2>
<table border="1" cellpadding="8" cellspacing="0">%s</table>
%s
<h2>ছবি</h2>%s
<p style="color:#666">মান ভুল থাকলে work/fields.json নোটপ্যাডে খুলে ঠিক করে সেভ করো।</p>
</body></html>""" % (rows, addr_dbg, thumbs)
    with open("work/preview.html", "w", encoding="utf-8") as f:
        f.write(preview)

    print("Done -> work/fields.json")
    for k, v in fields.items():
        print("  [%s] = %s" % (k, v))


def build_fields(data, tpl):
    """Build editable card fields from extracted input data + template.
    Returns {slot_label: value} (same as work/fields.json)."""
    tpl_slots = set()
    has_address_slot = False
    for pg in tpl["pages"]:
        for t in pg["texts"]:
            if t.get("slot"):
                tpl_slots.add(t["slot"])
        if pg.get("address_slot"):
            has_address_slot = True

    # Data-dump input (voter printout) — template-e 0 slot. Default card
    # labels diye fields banao; build_output default template-e place korbe.
    if not tpl_slots:
        tpl_slots = set(FIELD_MAP) | {"/Blood Group:", "ঠিকানা:",
                                      "প্রদানের তারিখ:"}
        has_address_slot = True

    fields = {}
    for tpl_label, in_field in FIELD_MAP.items():
        if tpl_label not in tpl_slots:
            print("  সতর্কতা: টেমপ্লেটে স্লট পাওয়া যায়নি:", tpl_label)
            continue
        val = data.get(in_field, "")
        if in_field == "Date of Birth":
            val = fmt_dob(val)
        else:
            val = clean_bn(val)
        fields[tpl_label] = val

    # ঠিকানা: Present Address টেবিল থেকে অটো-কম্পোজ (টেমপ্লেটে address_slot থাকলে);
    # Present na thakle Permanent table fallback
    if has_address_slot:
        pa_tbl = data.get("Present Address") or data.get("Permanent Address")
        fields["ঠিকানা:"] = compose_address(pa_tbl, data)

    # প্রদানের তারিখ: ডিফল্ট টেমপ্লেটের তারিখ ১৬/০৮/২০২৬ বসাও; নির্দিষ্ট তারিখ চাইলে fields.json-এ বদলে নেওয়া যায়
    if "প্রদানের তারিখ:" in tpl_slots and not fields.get("প্রদানের তারিখ:"):
        fields["প্রদানের তারিখ:"] = "১৬/০৮/২০২৬"

    # রক্তের গ্রুপ: টেমপ্লেটের স্লট-নাম অনুযায়ী (নতুন টেমপ্লেটে "/Blood Group:")
    bg = ""
    for k in ("Blood Group", "Blood", "BG"):
        if data.get(k):
            bg = data[k]
            break
    bg_slot = next((s for s in ("/Blood Group:", "Blood Group:")
                    if s in tpl_slots), None)
    if bg_slot:
        fields[bg_slot] = clean_bn(bg)
    elif bg:
        print("  সতর্কতা: টেমপ্লেটে রক্তের গ্রুপের স্লট পাওয়া যায়নি")

    # Pin: ১৭ সংখ্যার পিন থাকলে বারকোডের জন্য রাখো
    if data.get("Pin"):
        fields["Pin"] = data["Pin"]

    return fields


if __name__ == "__main__":
    main()
