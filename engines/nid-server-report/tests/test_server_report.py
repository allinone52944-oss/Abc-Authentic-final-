# -*- coding: utf-8 -*-
"""Regression tests for the Sign to Server Copy engine (nid-server-report).

Covers: Bengali spelling repair, address composition, gender/
religion normalisation, extract on the template reports (fixtures),
and build (redact + overlay) producing both v1 + v2 PDFs with the
right fields — including a round-trip extract of a built report.

All person values are OBVIOUSLY FAKE (Test Name / 1010101010 / ...).
The template PDFs are the engine's own sample-report assets; tests
assert STRUCTURE (field presence, digit shape, v1/v2 consistency)
and never hard-code the sample person's values.

Run (from engines/nid-server-report):
  python -m unittest discover -s tests -v
Requires pymupdf, Pillow, qrcode (see requirements.txt).
"""
import json
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import extract_input as ei  # noqa: E402
import build_reports as br  # noqa: E402
from review_addresses import review_addresses  # noqa: E402

ENGINE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
V1_TEMPLATE = os.path.join(ENGINE_DIR, "report_v1_template.pdf")
V2_TEMPLATE = os.path.join(ENGINE_DIR, "report_v2_template.pdf")

# Obviously fake person — never a real person's data.
FAKE = {
    "National ID": "1010101010",
    "Pin": "10101010101010101",
    "Voter No": "10101010101010101",
    "Voter Area": "101",
    "Name(Bangla)": "পরীক্ষা নাম",
    "Name(English)": "Test Name",
    "Date of Birth": "01/01/1990",
    "Father Name": "পরীক্ষা পিতা",
    "Mother Name": "পরীক্ষা মাতা",
    "Spouse Name": "",
    "Gender": "Male",
    "Religion": "Islam",
    "Occupation": "পরীক্ষা পেশা",
    "Birth Place": "ঢাকা",
    "Blood Group": "O+",
    "Present Address": {
        "holding": "১২",
        "village": "পরীক্ষা গ্রাম",
        "post_office": "পরীক্ষা ডাকঘর",
        "postal_code": "১২০০",
        "upozila": "পরীক্ষা উপজেলা",
        "district": "ঢাকা",
        "division": "ঢাকা",
    },
    "Permanent Address": {
        "holding": "১২",
        "village": "পরীক্ষা গ্রাম",
        "post_office": "পরীক্ষা ডাকঘর",
        "postal_code": "১২০০",
        "upozila": "পরীক্ষা উপজেলা",
        "district": "ঢাকা",
        "division": "ঢাকা",
    },
}


class TestReviewAddresses(unittest.TestCase):
    def test_nid_address_format_with_independent_current_and_permanent_fields(self):
        addresses = review_addresses({
            "District": "ঢাকা",
            "Upozila": "মিরপুর",
            "Present Address": {
                "holding": "12",
                "village": "পরীক্ষা গ্রাম",
                "mouza": "পরীক্ষা গ্রাম",
                "post_office": "পরীক্ষা ডাকঘর",
                "postal_code": "1200",
            },
            "Permanent Address": {"district": "চট্টগ্রাম", "holding": "-"},
        })
        self.assertEqual(
            addresses["Present Address"],
            "বাসা/হোল্ডিং: ১২, গ্রাম/রাস্তা: পরীক্ষা গ্রাম, ডাকঘর: পরীক্ষা ডাকঘর - ১২০০, মিরপুর, ঢাকা",
        )
        self.assertEqual(addresses["Permanent Address"], "চট্টগ্রাম")

    def test_report_city_and_ward_are_kept_without_filling_a_missing_address(self):
        addresses = review_addresses({"Present Address": {
            "union_ward": "5", "city_corp": "ঢাকা সিটি কর্পোরেশন",
        }})
        self.assertEqual(addresses["Present Address"], "ঢাকা সিটি কর্পোরেশন, ইউনিয়ন/ওয়ার্ড: ৫")
        self.assertEqual(addresses["Permanent Address"], "")


class TestSpellingRepair(unittest.TestCase):
    def test_reph_at_word_start_swaps(self):
        self.assertEqual(ei._bn_repair("র্ধম"), "ধর্ম")

    def test_double_matra_collapses(self):
        self.assertEqual(ei._bn_repair("পেকুয়াার"), "পেকুয়ার")
        self.assertEqual(ei._bn_repair("চট্টগ্রাাম"), "চট্টগ্রাম")
        self.assertEqual(ei._bn_repair("জন্মস্থাান"), "জন্মস্থান")
        self.assertEqual(ei._bn_repair("গ্রাাম"), "গ্রাম")

    def test_broken_o_shape(self):
        self.assertEqual(ei._bn_tidy("ভোাটার"), "ভোটার")

    def test_district_typo_canonicalised(self):
        self.assertEqual(ei._bn_place_canon("ককসবাজার"), "কক্সবাজার")
        self.assertEqual(ei._bn_place_canon("চট্রগ্রাম"), "চট্টগ্রাম")

    def test_unknown_place_word_unchanged(self):
        self.assertEqual(ei._bn_place_canon("পরীক্ষা গ্রাম"), "পরীক্ষা গ্রাম")

    def test_english_tidy(self):
        self.assertEqual(ei._en_tidy("  Test   Name  "), "Test Name")


class TestNormalise(unittest.TestCase):
    def test_gender(self):
        self.assertEqual(br.norm_gender("Male"), "পুরুষ")
        self.assertEqual(br.norm_gender("male"), "পুরুষ")
        self.assertEqual(br.norm_gender("Female"), "মহিলা")
        self.assertEqual(br.norm_gender("মহিলা"), "মহিলা")
        self.assertEqual(br.norm_gender(""), "")

    def test_religion(self):
        self.assertEqual(br.norm_religion("Islam"), "ইসলাম")
        self.assertEqual(br.norm_religion("islam"), "ইসলাম")
        self.assertEqual(br.norm_religion("Hindu"), "হিন্দু")
        self.assertEqual(br.norm_religion(""), "")

    def test_serial_from_voter(self):
        # 17-digit voter -> last 13 chars.
        self.assertEqual(br.serial_from_voter("10101010101010101"), "1010101010101")
        self.assertEqual(br.serial_from_voter("123"), "123")
        self.assertEqual(br.serial_from_voter(""), "")


class TestAddressCompose(unittest.TestCase):
    def test_addr_parts_one_liner(self):
        got = br.addr_parts(FAKE["Present Address"])
        self.assertIn("বাসা/হোল্ডিংঃ ১২", got)
        self.assertIn("গ্রাম/রাস্তাঃ পরীক্ষা গ্রাম", got)
        self.assertIn("জেলাঃ ঢাকা", got)
        self.assertTrue(got.endswith("।"))

    def test_addr_parts_empty(self):
        self.assertEqual(br.addr_parts({}), "")
        self.assertEqual(br.addr_parts({"holding": "-"}), "")

    def test_addr_parts_string_passes_through_verbatim(self):
        # The review form now sends each address as ONE string; the
        # builders print it verbatim as the one-liner.
        self.assertEqual(br.addr_parts("12, Mirpur, Dhaka 1200"),
                         "12, Mirpur, Dhaka 1200")
        self.assertEqual(br.addr_parts("  spaced  "), "spaced")
        self.assertEqual(br.addr_parts(""), "")
        self.assertEqual(br.addr_parts(None), "")

    def test_parse_bn_address_text(self):
        # Same segment order the composer emits (addr_parts): no
        # "ডাকঘর:" segment — the composer never writes one.
        txt = ("বাসা/হোল্ডিং: ১২, গ্রাম/রাস্তা: পরীক্ষা গ্রাম, "
               "পোস্ট কোড: ১২০০, "
               "উপজেলা: পরীক্ষা উপজেলা, জেলা: ঢাকা, বিভাগ: ঢাকা।")
        got = ei.parse_bn_address_text(txt)
        self.assertEqual(got["holding"], "১২")
        self.assertEqual(got["village"], "পরীক্ষা গ্রাম")
        self.assertEqual(got["district"], "ঢাকা")
        self.assertEqual(got["division"], "ঢাকা")


class TestExtractTemplates(unittest.TestCase):
    """The template PDFs ARE sample v1/v2 reports — extracting them
    must yield the same person's fields from both, with a photo."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="nsr-test-")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _extract(self, pdf_path):
        work = os.path.join(self.tmp, "work")
        data, images = ei.extract(pdf_path, work)
        return data, images

    def _assert_shape(self, data, images):
        nid = str(data.get("National ID", "") or "").strip()
        self.assertRegex(nid, r"^\d{10}$|^\d{13}$|^\d{17}$")
        self.assertTrue(str(data.get("Name(Bangla)", "") or "").strip())
        self.assertTrue(str(data.get("Date of Birth", "") or "").strip())
        self.assertIsInstance(data.get("Present Address", {}), dict)
        self.assertEqual(data["_address_lines"], review_addresses(data))
        self.assertIn("photo", images)

    def test_extract_v1_template_shape(self):
        data, images = self._extract(V1_TEMPLATE)
        self._assert_shape(data, images)

    def test_extract_v2_template_shape(self):
        data, images = self._extract(V2_TEMPLATE)
        self._assert_shape(data, images)

    def test_v1_and_v2_extract_same_person(self):
        d1, _ = self._extract(V1_TEMPLATE)
        d2, _ = self._extract(V2_TEMPLATE)
        self.assertEqual(str(d1.get("National ID", "")).strip(),
                         str(d2.get("National ID", "")).strip())
        self.assertEqual(str(d1.get("Name(Bangla)", "")).strip(),
                         str(d2.get("Name(Bangla)", "")).strip())


class TestBuildReports(unittest.TestCase):
    """Build from a synthetic input_data.json -> both PDFs, then
    round-trip extract the built v1 and check the fake values."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="nsr-build-")
        self.work = os.path.join(self.tmp, "work")
        self.out = os.path.join(self.tmp, "output")
        os.makedirs(os.path.join(self.work, "images"), exist_ok=True)
        # Fake photo: a plain square PNG (PIL only, no real image).
        from PIL import Image
        img = Image.new("RGB", (200, 200), (120, 130, 140))
        img.save(os.path.join(self.work, "images", "photo.png"))
        with open(os.path.join(self.work, "input_data.json"), "w",
                  encoding="utf-8") as fh:
            json.dump(FAKE, fh, ensure_ascii=False, indent=1)
        with open(os.path.join(self.work, "input_images.json"), "w",
                  encoding="utf-8") as fh:
            json.dump({"photo": os.path.join(self.work, "images", "photo.png")},
                      fh, ensure_ascii=False, indent=1)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_build_produces_both_pdfs(self):
        rc = br.main(os.path.join(self.work, "input_data.json"), self.out)
        self.assertEqual(rc, 0)
        v1 = os.path.join(self.out, "1010101010-v1.pdf")
        v2 = os.path.join(self.out, "1010101010-v2.pdf")
        self.assertTrue(os.path.exists(v1), "v1 PDF missing")
        self.assertTrue(os.path.exists(v2), "v2 PDF missing")
        for p in (v1, v2):
            self.assertGreater(os.path.getsize(p), 5000)
            import pymupdf
            with pymupdf.open(p) as doc:
                self.assertEqual(doc.page_count, 1)

    def test_built_v1_round_trips_fake_values(self):
        # NOTE (text layer): the overlay is HarfBuzz-shaped via
        # PyMuPDF insert_htmlbox, whose subset-font ToUnicode garbles
        # Bengali conjuncts (e.g. 'ক্ষ' in 'পরীক্ষা') in the TEXT
        # layer — all bundled fonts behave the same, and the paint
        # is correct. So the round-trip asserts the exact values
        # that survive the text layer (digits + English name) and
        # proves the Bengali name PAINTED (ink in its value row)
        # instead of asserting its extracted text.
        br.main(os.path.join(self.work, "input_data.json"), self.out)
        v1 = os.path.join(self.out, "1010101010-v1.pdf")
        work2 = os.path.join(self.tmp, "work2")
        data, _images = ei.extract(v1, work2)
        self.assertEqual(str(data.get("National ID", "")).strip(), "1010101010")
        self.assertEqual(str(data.get("Name(English)", "")).strip(), "TEST NAME")
        import pymupdf
        with pymupdf.open(v1) as doc:
            page = doc[0]
            pix = page.get_pixmap(matrix=pymupdf.Matrix(2, 2),
                                  clip=pymupdf.Rect(211, 427, 522, 443))
            buf, n = pix.samples, pix.n
            ink = sum(1 for i in range(0, len(buf), n)
                      if min(buf[i], buf[i + 1], buf[i + 2]) < 170)
        self.assertGreater(ink, 50, "Bengali name row has no ink")

    def test_built_v2_has_photo_and_qr_images(self):
        br.main(os.path.join(self.work, "input_data.json"), self.out)
        v2 = os.path.join(self.out, "1010101010-v2.pdf")
        import pymupdf
        with pymupdf.open(v2) as doc:
            page = doc[0]
            inside = page.get_pixmap(clip=pymupdf.Rect(148, 250, 149, 251))
            self.assertEqual(inside.pixel(0, 0), (120, 130, 140))
            self.assertNotIn((480, 640), [(image["width"], image["height"])
                                          for image in page.get_image_info()])

    def test_v2_without_a_photo_has_an_empty_portrait_and_one_qr(self):
        os.remove(os.path.join(self.work, "images", "photo.png"))
        self.assertEqual(br.main(os.path.join(self.work, "input_data.json"), self.out), 0)
        import pymupdf
        with pymupdf.open(os.path.join(self.out, "1010101010-v2.pdf")) as doc:
            page = doc[0]
            inside = page.get_pixmap(clip=pymupdf.Rect(109, 212, 189, 304))
            self.assertTrue(all(channel == 255 for channel in inside.samples))
            qr_images = [image for image in page.get_image_info()
                         if image["width"] > 1 and all(
                             abs(actual - expected) < 0.5
                             for actual, expected in zip(image["bbox"], br.V2_QR_BOX))]
            self.assertEqual(len(qr_images), 1)
            self.assertNotIn((480, 640), [(image["width"], image["height"])
                                          for image in page.get_image_info()])

    def test_build_string_address_prints_verbatim(self):
        # String addresses (from the single-line review inputs) reach
        # BOTH built PDFs as the one-liner, verbatim.
        import copy
        data = copy.deepcopy(FAKE)
        data["Present Address"] = "12, Mirpur, Dhaka 1200"
        data["Permanent Address"] = "34, Uttara, Dhaka 1230"
        with open(os.path.join(self.work, "input_data.json"), "w",
                  encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=1)
        self.assertEqual(br.main(os.path.join(self.work, "input_data.json"),
                                 self.out), 0)
        import pymupdf
        for suffix in ("-v1.pdf", "-v2.pdf"):
            with pymupdf.open(os.path.join(self.out, "1010101010" + suffix)) as doc:
                # The PDF text layer can represent a visible space as
                # a non-breaking space, depending on the font engine.
                text = doc[0].get_text().replace("\u00a0", " ")
            self.assertIn("12, Mirpur, Dhaka 1200", text)
            self.assertIn("34, Uttara, Dhaka 1230", text)


if __name__ == "__main__":
    unittest.main()
