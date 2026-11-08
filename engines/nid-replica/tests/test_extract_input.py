# -*- coding: utf-8 -*-
"""Regression tests for multi-line address-value joining in extract_input.py.

`right_value` (multi_line mode, address-table path only) must join a value
that wraps onto the line directly below the label's line, and must NOT join
unrelated rows. All fixtures use obviously fake values (Alpha/Beta/...) —
never real personal data.

Run:  python -m unittest discover -s tests -v        (from engines/nid-replica)
      or: python -m unittest tests.test_extract_input -v
Requires pymupdf (imported by extract_input); no PDF file is needed —
`_DOC` stays None so the phantom-sign fix is skipped.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import extract_input as ei  # noqa: E402

STOP = ei.ADDR_LABELS | ei.ADDR_STOP_EXTRA
LBL = ei.ADDR_LABELS
SIZE = 12.0


def span(text, x0, x1, yc, size=SIZE, page=0):
    """One fake text span centred on yc."""
    return {"text": text, "x0": x0, "x1": x1,
            "y0": yc - size / 2, "y1": yc + size / 2,
            "size": size, "page": page}


def word(text, x0, yc, w=22.0, size=SIZE):
    """One fake value word starting at x0 (width w)."""
    return span(text, x0, x0 + w, yc, size)


class TestRightValueMultiLine(unittest.TestCase):
    def test_holding_joins_continuation(self):
        """Right-column value wraps: 2 words on label line + 1 below."""
        label = span("Home/Holding", 411.1, 490.3, 772.0)
        spans = [
            label,
            word("Alpha", 510.6, 772.0), word("Beta", 544.8, 772.0),
            # continuation line: left-column label + 'No' fragment of
            # this label + the wrapped word — none of them may stop it.
            span("Village/Road", 212.2, 290.0, 790.0),
            span("No", 411.1, 425.0, 790.0),
            word("Gamma", 510.6, 790.0),
            # next row must stop the join.
            span("Postal Code", 411.1, 473.7, 809.5),
            word("Delta", 510.6, 809.5),
        ]
        got = ei.right_value(label, spans, STOP, multi_line=True,
                             multi_line_labels=LBL)
        self.assertEqual(got, "Alpha Beta Gamma")

    def test_post_office_joins_then_stops_at_region(self):
        """Left-column value wraps; 'Region' (stop word, not a fragment
        of this label) on the next line must stop the join."""
        label = span("Post Office", 212.2, 280.0, 809.5)
        spans = [
            label,
            word("Delta", 311.6, 809.5), word("Epsilon", 338.1, 809.5),
            word("Zeta", 311.6, 828.0),  # continuation line, no labels
            span("Region", 212.2, 260.0, 847.0),
            word("Eta", 311.6, 847.0),
        ]
        got = ei.right_value(label, spans, STOP, multi_line=True,
                             multi_line_labels=LBL)
        self.assertEqual(got, "Delta Epsilon Zeta")

    def test_value_left_of_label_on_continuation_line_not_joined(self):
        """RMO regression: orphan spans on the line below, sitting LEFT of
        that line's 'Corporation' label, are another field's value —
        they must NOT be joined to RMO."""
        label = span("RMO", 212.2, 239.2, 586.0)
        spans = [
            label,
            word("Metro", 311.6, 586.0),
            # line below: orphan words left of the Corporation label
            word("Orphan", 311.6, 604.0), word("Words", 336.8, 604.0),
            span("Corporation", 411.1, 490.0, 604.0),
            word("City", 510.6, 604.0),
        ]
        got = ei.right_value(label, spans, STOP, multi_line=True,
                             multi_line_labels=LBL)
        self.assertEqual(got, "Metro")

    def test_single_line_mode_unchanged(self):
        """Default (multi_line=False) reads only the label's own line —
        the behaviour every non-address caller relies on."""
        label = span("Home/Holding", 411.1, 490.3, 772.0)
        spans = [
            label,
            word("Alpha", 510.6, 772.0), word("Beta", 544.8, 772.0),
            span("Village/Road", 212.2, 290.0, 790.0),
            word("Gamma", 510.6, 790.0),
        ]
        got = ei.right_value(label, spans, STOP)
        self.assertEqual(got, "Alpha Beta")

    def test_single_line_value_never_grabs_next_row(self):
        """A complete single-line value must stay complete even when the
        next line holds another field's value in the same column."""
        label = span("RMO", 212.2, 239.2, 586.0)
        spans = [
            label,
            word("Metro", 311.6, 586.0),
            span("Upozila", 212.2, 260.0, 659.5),
            word("North", 311.6, 659.5),
        ]
        got = ei.right_value(label, spans, STOP, multi_line=True,
                             multi_line_labels=LBL)
        self.assertEqual(got, "Metro")


if __name__ == "__main__":
    unittest.main()
