#!/usr/bin/env python3
"""Extract the holder's photo from an official card PDF (argv[1])
and write it as PNG to argv[2].

The card front carries the holder's photo plus emblems, a QR
and a signature strip. The photo is the largest portrait image
that is not in the top strip (where the emblem sits). Prints
"OK <w> <h>" on success, "NONE" otherwise. Same pymupdf the
NID card pipeline (build_output.py) already depends on.
"""
import sys

import pymupdf


def main() -> int:
    src, dst = sys.argv[1], sys.argv[2]
    doc = pymupdf.open(src)
    page = doc[0]
    ph, pw = float(page.rect.height), float(page.rect.width)
    best = None  # (area, xref)
    for img in page.get_images(full=True):
        xref = img[0]
        try:
            pix = pymupdf.Pixmap(doc, xref)
        except Exception:
            continue
        w, h = pix.w, pix.h
        if w < 80 or h < w * 1.05:
            continue  # not a portrait photo (QR is square, signature is wide)
        rects = page.get_image_rects(xref)
        if not rects:
            continue
        y0 = min(r.y0 for r in rects)
        if y0 < ph * 0.10:
            continue  # top strip: emblem/logo zone
        area = w * h
        if best is None or area > best[0]:
            best = (area, xref)
    if best is None:
        print("NONE")
        return 0
    pix = pymupdf.Pixmap(doc, best[1])
    if pix.n > 3:
        pix = pymupdf.Pixmap(pymupdf.csRGB, pix)
    pix.save(dst)
    print(f"OK {pix.w} {pix.h}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
