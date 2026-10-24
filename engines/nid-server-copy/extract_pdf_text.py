#!/usr/bin/env python3
"""Print the full text layer of a PDF (argv[1]) to stdout.

Used by pdf-id.js to recover the National ID / PIN from the
official card PDF the portal issued. Same pymupdf the NID
card pipeline (build_output.py) already depends on.
"""
import sys

import pymupdf


def main() -> int:
    doc = pymupdf.open(sys.argv[1])
    out = []
    for page in doc:
        out.append(page.get_text())
    sys.stdout.write("\n".join(out))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
