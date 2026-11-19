# -*- coding: utf-8 -*-
"""Regression tests for the NID Smart Card engine (nid-smart-card).

Covers: clean_bn name pass-through (fix #6), Voter No never
standing in for the National ID (fix #2), v2 fixed slots + Gender
helper, extract on the sample input fixture, build producing the
card (MRZ recompute == rendered MRZ, barcode pixels == regenerated
barcode), fail-loudly behaviour (fix #3: missing photo / barcode
data raises, never keeps the template sample), barcode `ds` only
from form data (fix #4), issue-date today default visible in the
fields (fix #5), address bound (max 3 lines).

The sample input.pdf is the engine's own sample-form asset; tests
assert STRUCTURE (field presence, digit shape, MRZ/barcode
consistency) and never hard-code the sample person's values.
The zip's sample output.pdf is a DIFFERENT person than input.pdf,
so it is NOT used as a matched pair — the expected output is built
from the sample input itself.

Run (from engines/nid-smart-card):
  python -m unittest discover -s tests -v
Requires pymupdf, Pillow, pdf417gen, fontTools (see requirements.txt).
opencv-python-headless is used when present (photo sanitize); the
build degrades to the original photo with a WARNING log without it.
"""
import datetime
import json
import os
import re
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import extract_input as ei  # noqa: E402
import make_fields as mf  # noqa: E402
import build_output_v2 as v2  # noqa: E402
import build_output as bo  # noqa: E402

ENGINE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEMPLATE_PDF = os.path.join(ENGINE_DIR, "output_template.pdf")
SAMPLE_INPUT = os.path.join(ENGINE_DIR, "tests", "fixtures", "sample-input.pdf")

# Obviously fake person — never a real person's data.
FAKE_FIELDS = {
    "নাম:": "পরীক্ষা নাম",
    "Name:": "TEST NAME",
    "পিতা:": "পরীক্ষা পিতা",
    "মাতা:": "পরীক্ষা মাতা",
    "Date of Birth:": "01 Jan 1990",
    "ID NO:": "1010101010",
    "Pin": "10101010101010101",
    "Gender": "male",
    "জন্মস্থান:": "ঢাকা",
    "/Blood Group:": "O+",
    "প্রদানের তারিখ:": "19 Nov 2026",
    "ঠিকানা:": "বাসা/হোল্ডিং: ১২, গ্রাম/রাস্তা: পরীক্ষা গ্রাম, উপজেলা: পরীক্ষা উপজেলা, জেলা: ঢাকা",
}


def _fake_photo(path, size=(200, 250)):
    from PIL import Image
    img = Image.new("RGB", size, (120, 130, 140))
    img.save(path)


class TestCleanBn(unittest.TestCase):
    """Fix #6: names pass through unaltered apart from glyph /
    double-matra repairs — no hardcoded name spacings."""

    def test_hardcoded_spacings_gone(self):
        # The old table rewrote these names; now they pass through.
        self.assertEqual(mf.clean_bn("ফয়জুলুহক"), "ফয়জুলুহক")
        self.assertEqual(mf.clean_bn("জুনাবআলী"), "জুনাবআলী")
        self.assertEqual(mf.clean_bn("আমিরুননেছা"), "আমিরুননেছা")
        self.assertEqual(mf.clean_bn("ওয়াসিমউদ্দিন"), "ওয়াসিমউদ্দিন")
        self.assertEqual(mf.clean_bn("কুলছুমাখাতুন"), "কুলছুমাখাতুন")

    def test_double_matra_collapse_kept(self):
        self.assertEqual(mf.clean_bn("পেকুয়াার"), "পেকুয়ার")
        self.assertEqual(mf.clean_bn("চট্টগ্রাাম"), "চট্টগ্রাম")

    def test_glyph_conversion_kept(self):
        # Web-print glyph artifacts still convert.
        self.assertEqual(mf.clean_bn("প্রি"), "প্রি")
        self.assertIn("ঞ্জ", mf.clean_bn("ǻ"))

    def test_control_bytes_stripped(self):
        self.assertEqual(mf.clean_bn("নাম\x00\x01"), "নাম")


class TestVoterNoFix(unittest.TestCase):
    """Fix #2: Voter No must NEVER stand in for the National ID."""

    def _tpl(self):
        return {"layout": "nid_card_v2", "pages": [{"texts": []}]}

    def test_voter_no_alone_leaves_id_empty(self):
        data = {"Pin": "", "Voter No": "12345678901234567",
                "National ID": "", "Name(Bangla)": "পরীক্ষা নাম",
                "Date of Birth": "01 Jan 1990"}
        fields = mf.build_fields(data, self._tpl())
        self.assertEqual(fields.get("ID NO:", ""), "")

    def test_national_id_used_when_present(self):
        data = {"Pin": "", "Voter No": "12345678901234567",
                "National ID": "1010101010", "Name(Bangla)": "পরীক্ষা নাম",
                "Date of Birth": "01 Jan 1990"}
        fields = mf.build_fields(data, self._tpl())
        self.assertEqual(fields.get("ID NO:"), "1010101010")


class TestV2Slots(unittest.TestCase):
    """v2 fixed slot set + Gender helper (layout nid_card_v2)."""

    def test_v2_layout_emits_all_slots(self):
        tpl = {"layout": "nid_card_v2", "pages": [{"texts": []}]}
        data = {"Name(Bangla)": "পরীক্ষা নাম", "Name(English)": "Test Name",
                "Father Name": "পরীক্ষা পিতা", "Mother Name": "পরীক্ষা মাতা",
                "Date of Birth": "01 Jan 1990", "National ID": "1010101010",
                "Pin": "10101010101010101", "Gender": "Female",
                "Birth Place": "ঢাকা", "Blood Group": "O+",
                "Present Address": {"village": "পরীক্ষা গ্রাম",
                                    "district": "ঢাকা"}}
        fields = mf.build_fields(data, tpl)
        for slot in ("নাম:", "Name:", "পিতা:", "মাতা:", "Date of Birth:",
                     "ID NO:", "জন্মস্থান:", "/Blood Group:",
                     "প্রদানের তারিখ:", "ঠিকানা:", "Pin"):
            self.assertIn(slot, fields, "missing slot %s" % slot)
        self.assertEqual(fields["Gender"], "Female")
        self.assertEqual(fields["ID NO:"], "1010101010")

    def test_issue_date_defaults_to_today_bn_digits(self):
        # Fix #5: the default is today, shown in the fields (the
        # frontend review step displays it editable).
        tpl = {"layout": "nid_card_v2", "pages": [{"texts": []}]}
        fields = mf.build_fields({}, tpl)
        today = datetime.date.today()
        expect = ("%02d/%02d/%04d" % (today.day, today.month, today.year)
                  ).translate(str.maketrans("0123456789", "০১২৩৪৫৬৭৮৯"))
        self.assertEqual(fields.get("প্রদানের তারিখ:"), expect)

    def test_address_bound_max_three_lines(self):
        long_addr = ("বাসা/হোল্ডিং: ১২৩, গ্রাম/রাস্তা: অনেক লম্বা গ্রামের নাম "
                     "যেটা অনেক শব্দ দিয়ে লেখা, ডাকঘর: অনেক লম্বা ডাকঘর, "
                     "উপজেলা: অনেক লম্বা উপজেলা, জেলা: অনেক লম্বা জেলা, "
                     "বিভাগ: অনেক লম্বা বিভাগ")
        bn_font = os.path.join(ENGINE_DIR, "fonts", "SolaimanLipi.ttf")
        lay = v2._layout_address(long_addr, "ঠিকানা:", bn_font, v2.ADDRESS)
        self.assertLessEqual(len(lay["lines"]), 3)


class TestExtractSample(unittest.TestCase):
    """Extract the sample input fixture — structure only, never the
    sample person's values."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="nsc-test-")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_extract_sample_shape(self):
        work = os.path.join(self.tmp, "work")
        data, images = ei.extract(SAMPLE_INPUT, work)
        nid = str(data.get("National ID", "") or "").strip()
        self.assertRegex(nid, r"^\d{10}$|^\d{13}$|^\d{17}$")
        self.assertTrue(str(data.get("Name(Bangla)", "") or "").strip())
        self.assertTrue(str(data.get("Date of Birth", "") or "").strip())
        self.assertIn("photo", images)

    def test_template_layout_is_v2(self):
        # extract_template.py writes template.json in the job work dir.
        import subprocess
        r = subprocess.run(
            [sys.executable,
             os.path.join(ENGINE_DIR, "extract_template.py"),
             TEMPLATE_PDF],
            cwd=self.tmp, capture_output=True, text=True, timeout=120)
        self.assertEqual(r.returncode, 0)
        tpl = json.load(open(os.path.join(self.tmp, "work", "template.json"),
                             encoding="utf-8"))
        self.assertEqual(tpl.get("layout"), "nid_card_v2")

    def test_fields_id_is_national_id_not_voter_no(self):
        # Dynamic check: whatever the extract found, the card's ID NO
        # must be the National ID (or Pin), never the Voter No.
        work = os.path.join(self.tmp, "work")
        data, _images = ei.extract(SAMPLE_INPUT, work)
        import subprocess
        subprocess.run(
            [sys.executable,
             os.path.join(ENGINE_DIR, "extract_template.py"),
             TEMPLATE_PDF],
            cwd=self.tmp, capture_output=True, text=True, timeout=120)
        subprocess.run(
            [sys.executable, os.path.join(ENGINE_DIR, "make_fields.py")],
            cwd=self.tmp, capture_output=True, text=True, timeout=120)
        fields = json.load(open(os.path.join(work, "fields.json"),
                                encoding="utf-8"))
        voter = str(data.get("Voter No", "") or "").strip()
        national = str(data.get("National ID", "") or "").strip()
        pin = str(data.get("Pin", "") or "").strip()
        expect = national or pin
        self.assertEqual(str(fields.get("ID NO:", "")).strip(), expect)
        if voter and voter != expect:
            self.assertNotEqual(str(fields.get("ID NO:", "")).strip(), voter)


class TestBuildCard(unittest.TestCase):
    """Build from the sample fields; verify the card structure."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="nsc-build-")
        self.work = os.path.join(self.tmp, "work")
        os.makedirs(os.path.join(self.work, "images"), exist_ok=True)
        _fake_photo(os.path.join(self.work, "images", "photo.png"))
        self.fields_path = os.path.join(self.work, "fields.json")
        with open(self.fields_path, "w", encoding="utf-8") as fh:
            json.dump(FAKE_FIELDS, fh, ensure_ascii=False, indent=1)
        self.out = os.path.join(self.tmp, "output.pdf")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _build(self, fields=None, photo=True):
        if fields is not None:
            with open(self.fields_path, "w", encoding="utf-8") as fh:
                json.dump(fields, fh, ensure_ascii=False, indent=1)
        bo.configure(ENGINE_DIR, self.work)
        return v2.build_v2_card(
            fields if fields is not None else FAKE_FIELDS,
            TEMPLATE_PDF, self.out,
            photo_path=(os.path.join(self.work, "images", "photo.png")
                        if photo else None))

    def test_build_produces_one_page_card(self):
        out = self._build()
        self.assertTrue(os.path.exists(out))
        self.assertGreater(os.path.getsize(out), 100000)
        import pymupdf
        with pymupdf.open(out) as doc:
            self.assertEqual(doc.page_count, 1)
            self.assertEqual((doc[0].rect.width, doc[0].rect.height),
                             (612.0, 792.0))

    def test_mrz_recompute_equals_rendered_mrz(self):
        out = self._build()
        dob = v2._parse_date(FAKE_FIELDS["Date of Birth:"])
        issue = v2._parse_date(FAKE_FIELDS["প্রদানের তারিখ:"])
        expect = v2._build_mrz(FAKE_FIELDS, dob, issue)
        self.assertEqual(len(expect), 3)
        for line in expect:
            self.assertEqual(len(line), 30)
        import pymupdf
        with pymupdf.open(out) as doc:
            txt = doc[0].get_text()
        for line in expect:
            self.assertIn(line, txt, "MRZ line not rendered: %s" % line)

    def test_barcode_pixels_equal_regenerated_barcode(self):
        out = self._build()
        fresh = v2._make_barcode(FAKE_FIELDS)
        self.assertTrue(fresh and os.path.exists(fresh))
        import pymupdf
        from PIL import Image
        fresh_im = Image.open(fresh).convert("RGB")
        with pymupdf.open(out) as doc:
            infos = doc[0].get_image_info(xrefs=True)
            # The barcode is the image whose pixel size matches the
            # freshly generated barcode PNG (580x108 for this data).
            cands = [i for i in infos
                     if i["width"] == fresh_im.width
                     and i["height"] == fresh_im.height]
            self.assertEqual(len(cands), 1, "barcode image not found: %s"
                             % [(i["width"], i["height"]) for i in infos])
            xref = cands[0]["xref"]
            pix = pymupdf.Pixmap(doc, xref)
            if pix.n > 3:
                pix = pymupdf.Pixmap(pymupdf.csRGB, pix)
            built_im = Image.frombytes("RGB", (pix.width, pix.height),
                                       pix.samples)
        self.assertEqual(built_im.size, fresh_im.size,
                         "barcode size mismatch (template slot changed?)")
        self.assertEqual(list(built_im.getdata()), list(fresh_im.getdata()),
                         "barcode pixels differ from regenerated barcode")

    def test_build_fails_loudly_without_photo(self):
        # Fix #3: no photo -> RuntimeError, no PDF — the template's
        # sample photo is never kept.
        with self.assertRaises(RuntimeError) as cm:
            self._build(photo=False)
        self.assertIn("ছবি", str(cm.exception))
        self.assertFalse(os.path.exists(self.out))

    def test_build_fails_loudly_without_barcode_data(self):
        # Fix #3: Pin/Name/DOB missing -> barcode cannot build -> fail.
        bad = dict(FAKE_FIELDS)
        bad["Pin"] = ""
        bad["ID NO:"] = ""
        with self.assertRaises(RuntimeError) as cm:
            self._build(fields=bad)
        self.assertIn("বারকোড", str(cm.exception))
        self.assertFalse(os.path.exists(self.out))


class TestBarcodeDs(unittest.TestCase):
    """Fix #4: `ds` comes only from form data; absent -> omitted."""

    def _capture_xml(self, fields):
        seen = {}
        orig = v2._pdf417_codes

        def fake_codes(text, columns=13, security_level=5, rows=18):
            seen["xml"] = text
            return orig(text, columns, security_level, rows)

        v2._pdf417_codes = fake_codes
        try:
            work = tempfile.mkdtemp(prefix="nsc-ds-")
            os.makedirs(os.path.join(work, "temp_renders"), exist_ok=True)
            bo.configure(ENGINE_DIR, work)
            v2._make_barcode(fields)
        finally:
            v2._pdf417_codes = orig
        return seen.get("xml", "")

    def test_ds_absent_means_no_ds_element(self):
        xml = self._capture_xml(FAKE_FIELDS)
        self.assertNotIn("<ds>", xml)
        self.assertNotIn("</ds>", xml)
        self.assertIn("<pin>10101010101010101</pin>", xml)

    def test_ds_present_is_used_verbatim(self):
        fields = dict(FAKE_FIELDS)
        fields["ds"] = "TESTDS123"
        xml = self._capture_xml(fields)
        self.assertIn("<ds>TESTDS123</ds>", xml)

    def test_barcode_uses_level_5_and_right_index(self):
        # Sample card-er row indicator diye promanito: security level 5
        # (level 4 noy); F-er man "Right INDEX" ("Right Index" noy).
        seen = {}
        orig = v2._pdf417_codes

        def fake_codes(text, columns=13, security_level=5, rows=18):
            seen["xml"] = text
            seen["level"] = security_level
            seen["columns"] = columns
            seen["rows"] = rows
            return orig(text, columns, security_level, rows)

        v2._pdf417_codes = fake_codes
        try:
            work = tempfile.mkdtemp(prefix="nsc-lvl5-")
            os.makedirs(os.path.join(work, "temp_renders"), exist_ok=True)
            bo.configure(ENGINE_DIR, work)
            v2._make_barcode(FAKE_FIELDS)
        finally:
            v2._pdf417_codes = orig
        self.assertEqual(seen.get("level"), 5,
                         "barcode must use security level 5 (sample)")
        self.assertEqual(seen.get("columns"), 13)
        self.assertEqual(seen.get("rows"), 18)
        self.assertIn("<F>Right INDEX</F>", seen.get("xml", ""))
        self.assertNotIn("<F>Right Index</F>", seen.get("xml", ""))


class TestPhotoSanitize(unittest.TestCase):
    """Fix #2 (photo): cv2 present -> sanitize runs; absent -> the
    original photo is used with a visible WARNING log."""

    def test_sanitize_runs_with_cv2(self):
        from PIL import Image
        p = os.path.join(tempfile.mkdtemp(prefix="nsc-photo-"), "p.png")
        Image.new("RGB", (200, 250), (30, 60, 200)).save(p)
        bo.configure(ENGINE_DIR, tempfile.mkdtemp(prefix="nsc-photo-"))
        out = v2._photo_clean_path(p)
        self.assertTrue(os.path.exists(out))
        # Sanitized copy is a different file (gradient background).
        self.assertNotEqual(os.path.abspath(out), os.path.abspath(p))


class TestHolderSignature(unittest.TestCase):
    """Holder-signature slot (sample-proven): the card's only signature
    is the HOLDER's, front below the photo (xref 24, bbox
    65.2/174.0/124.5/204.0). The old code rendered the AUTHORITY
    signature there — the sample card (output_template.pdf, byte-
    identical to the user's sample) proves that slot is the holder's,
    and the back panel has no signature at all."""

    SLOT = (65.2, 174.0, 124.5, 204.0)  # xref 24 bbox, top-origin pt

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="nsc-sign-")
        self.work = os.path.join(self.tmp, "work")
        os.makedirs(os.path.join(self.work, "images"), exist_ok=True)
        _fake_photo(os.path.join(self.work, "images", "photo.png"))
        self.fields_path = os.path.join(self.work, "fields.json")
        with open(self.fields_path, "w", encoding="utf-8") as fh:
            json.dump(FAKE_FIELDS, fh, ensure_ascii=False, indent=1)
        self.out = os.path.join(self.tmp, "output.pdf")
        self.sign_path = os.path.join(self.work, "images", "sign.png")
        self._fake_sign(self.sign_path)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    @staticmethod
    def _fake_sign(path, size=(260, 130)):
        # Black scribble on white paper, like a scanned signature.
        from PIL import Image, ImageDraw
        img = Image.new("RGB", size, (255, 255, 255))
        d = ImageDraw.Draw(img)
        d.line([(20, 90), (60, 40), (90, 100), (130, 50), (170, 95),
                (210, 45), (240, 80)], fill=(10, 10, 10), width=6)
        d.line([(30, 110), (120, 115), (230, 105)], fill=(20, 20, 20),
               width=4)
        img.save(path)

    def _build(self, holder_sign=True):
        bo.configure(ENGINE_DIR, self.work)
        return v2.build_v2_card(
            FAKE_FIELDS, TEMPLATE_PDF, self.out,
            photo_path=os.path.join(self.work, "images", "photo.png"),
            holder_sign_path=(self.sign_path if holder_sign else None))

    def _slot_gray(self, pdf_path):
        import pymupdf
        with pymupdf.open(pdf_path) as doc:
            pix = doc[0].get_pixmap(dpi=150,
                                     clip=pymupdf.Rect(*self.SLOT))
        from PIL import Image
        im = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
        return im.convert("L")

    @staticmethod
    def _ink_pixels(gray, threshold=80):
        return sum(1 for v in gray.getdata() if v < threshold)

    def test_holder_sign_rendered_at_slot(self):
        out = self._build(holder_sign=True)
        self.assertTrue(os.path.exists(out))
        ink = self._ink_pixels(self._slot_gray(out))
        self.assertGreater(ink, 100, "holder signature ink missing at slot")
        # The template's sample signature must be gone — the slot
        # render differs from the template's slot render.
        self.assertNotEqual(list(self._slot_gray(out).getdata()),
                            list(self._slot_gray(TEMPLATE_PDF).getdata()))

    def test_no_holder_sign_leaves_slot_blank(self):
        out = self._build(holder_sign=False)
        self.assertTrue(os.path.exists(out))
        ink = self._ink_pixels(self._slot_gray(out))
        self.assertEqual(ink, 0, "slot not blank without holder signature")

    def test_corrupt_holder_sign_fails_loudly(self):
        bad = os.path.join(self.work, "bad-sign.png")
        with open(bad, "wb") as fh:
            fh.write(b"this is not an image at all")
        bo.configure(ENGINE_DIR, self.work)
        with self.assertRaises(RuntimeError) as cm:
            v2.build_v2_card(
                FAKE_FIELDS, TEMPLATE_PDF, self.out,
                photo_path=os.path.join(self.work, "images", "photo.png"),
                holder_sign_path=bad)
        self.assertIn("স্বাক্ষর", str(cm.exception))
        self.assertFalse(os.path.exists(self.out))

    def test_slot_holds_holder_sign_not_authority(self):
        out = self._build(holder_sign=True)
        import pymupdf
        from PIL import Image
        with pymupdf.open(out) as doc:
            infos = doc[0].get_image_info(xrefs=True)
            slot = [i for i in infos
                    if [round(v, 1) for v in i["bbox"]] ==
                    [round(v, 1) for v in self.SLOT]]
            self.assertEqual(len(slot), 1, "slot image not found")
            pix = pymupdf.Pixmap(doc, slot[0]["xref"])
            if pix.n > 3:
                pix = pymupdf.Pixmap(pymupdf.csRGB, pix)
            built = Image.frombytes("RGB", (pix.width, pix.height),
                                    pix.samples)
        expect = v2._fit_holder_signature(
            v2._clean_signature(self.sign_path)).convert("RGB")
        # PyMuPDF re-encodes the PNG on replace_image — pixel values
        # round by a few levels, so compare with a tolerance instead
        # of exact equality (the barcode test can be exact because
        # its image is opaque; this one has an alpha mask).
        def _diffs(a, b):
            return [max(abs(x[0] - y[0]), abs(x[1] - y[1]),
                        abs(x[2] - y[2])) for x, y in zip(a, b)]
        diffs = _diffs(list(built.getdata()), list(expect.getdata()))
        self.assertLessEqual(max(diffs), 10,
                             "slot image is not the holder signature")
        self.assertEqual(sum(1 for v in diffs if v > 10), 0,
                         "slot image is not the holder signature")
        auth = v2._fit_holder_signature(
            os.path.join(ENGINE_DIR, "shakkhor", "prodankari-shakkhor.png")
        ).convert("RGB")
        auth_diffs = _diffs(list(built.getdata()), list(auth.getdata()))
        self.assertGreater(sum(1 for v in auth_diffs if v > 10), 100,
                           "slot image is the authority signature")

    def test_holder_sign_fit_matches_sample_ink_box(self):
        # Sample card-er holder-er kalir bbox 116x51 px (146x73 slot-er
        # bhitore, margin soho). Fit-ta kali-ke oi box-er bhitore rakhe
        # — slot bhore na, kinara chhoy na.
        bo.configure(ENGINE_DIR, self.work)
        os.makedirs(bo._w("temp_renders"), exist_ok=True)
        clean = v2._clean_signature(self.sign_path)
        fitted = v2._fit_holder_signature(clean)
        self.assertEqual(fitted.size, (146, 73))
        alpha = list(fitted.split()[3].getdata())
        gray = list(fitted.convert("L").getdata())
        w, h = fitted.size
        ink = [(x, y) for y in range(h) for x in range(w)
               if gray[y * w + x] < 160 and alpha[y * w + x] > 128]
        self.assertTrue(ink, "no ink in fitted signature")
        xs = [p[0] for p in ink]
        ys = [p[1] for p in ink]
        self.assertLessEqual(max(xs) - min(xs) + 1, 118,
                             "ink wider than the sample's ink box")
        self.assertLessEqual(max(ys) - min(ys) + 1, 53,
                             "ink taller than the sample's ink box")
        self.assertGreaterEqual(min(xs), 5, "ink touches the left edge")
        self.assertGreaterEqual(min(ys), 3, "ink touches the top edge")

    def test_cli_holder_sign_flag(self):
        # The --holder-sign CLI flag builds OK and the JSON ok line
        # is the last JSON object on stdout.
        import subprocess
        r = subprocess.run(
            [sys.executable,
             os.path.join(ENGINE_DIR, "build_output_v2.py"),
             self.fields_path, TEMPLATE_PDF, self.out,
             "--photo", os.path.join(self.work, "images", "photo.png"),
             "--holder-sign", self.sign_path,
             "--work", self.work, "--assets", ENGINE_DIR],
            capture_output=True, text=True, timeout=120)
        self.assertEqual(r.returncode, 0, r.stderr[-500:])
        last = [ln for ln in r.stdout.splitlines()
                if ln.strip().startswith("{")][-1]
        self.assertEqual(json.loads(last).get("ok"), True)
        self.assertTrue(os.path.exists(self.out))


if __name__ == "__main__":
    unittest.main()
