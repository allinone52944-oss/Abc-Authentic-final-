# solve_local.py - OFFLINE captcha solver: OpenCV geometry + ddddocr ensemble.
# BDRIS math captcha "73-15=?" -> prints computed answer, exit 0.
# Letter captcha -> prints the string, exit 0. No answer -> exit 1 (caller falls back).
# Zero network. Deps: opencv, numpy, pillow, ddddocr (pip install ddddocr).
import sys, os, re, json

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import cv2
import numpy as np
from PIL import Image

try:
    import ddddocr
except Exception:
    sys.exit(1)

HERE = os.path.dirname(os.path.abspath(__file__))
TEMPLATES_PATH = os.path.join(HERE, "templates.json")
OCR = None
OCR_B = None


def get_ocr(beta=False):
    global OCR, OCR_B
    if beta:
        if OCR_B is None:
            OCR_B = ddddocr.DdddOcr(det=False, show_ad=False, beta=True)
        return OCR_B
    if OCR is None:
        OCR = ddddocr.DdddOcr(det=False, show_ad=False)
    return OCR


def load_templates():
    try:
        with open(TEMPLATES_PATH, "r", encoding="utf-8") as f:
            raw = json.load(f)
        out = []
        for item in raw:
            d, v = item[0], item[1]
            if d and len(v) == 1024:
                out.append((d, np.array(v, np.uint8).reshape(32, 32)))
        return out
    except Exception:
        return []


TEMPLATES = load_templates()


def iou(a, b):
    a = (a > 90).astype(np.uint8)
    b = (b > 90).astype(np.uint8)
    return np.logical_and(a, b).sum() / max(1, np.logical_or(a, b).sum())


def harvest(digit, vec):
    """Grow template bank from high-confidence glyph reads (local learning)."""
    if len(TEMPLATES) >= 120:
        return
    arr = np.asarray(vec, np.uint8)
    if arr.size != 1024:
        return
    # never store a glyph that already looks like anything in the bank
    # (keeps the bank diverse: one shape per look, cross-digit poison stays out)
    arr32 = arr.reshape(32, 32)
    for d2, t2 in TEMPLATES:
        if iou(arr32, t2) >= 0.55:
            return
    TEMPLATES.append((digit, arr32))
    try:
        with open(TEMPLATES_PATH, "w", encoding="utf-8") as f:
            json.dump([[d, v.flatten().tolist()] for d, v in TEMPLATES], f)
    except Exception:
        pass


def load_mask(path):
    rgb = np.array(Image.open(path).convert("RGB"))
    bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    _, m = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    return bgr, m


def glyph_boxes(m):
    n, lab, stats, _ = cv2.connectedComponentsWithStats((m > 0).astype(np.uint8), 8)
    comps = []
    for i in range(1, n):
        x, y, w, h, a = [int(v) for v in stats[i]]
        # small area but tall-thin = digit leg ('7' diagonal); round noise dots stay out
        if a >= 15 or (w <= 5 and h >= 6 and a >= 10):
                # [x,y,w,h,area, sub_h, sx,sy,sw,sh, thin_wide, thin_tall]
                comps.append([x, y, w, h, a, h, x, y, w, h,
                              1 if (w >= 8 and h <= 6) else 0,
                              1 if (w <= 5 and h >= 10) else 0])
    # over-wide raw comps = touching glyph pair ('24' bridged by stipple):
    # split at the lowest-density column of the middle third when it is a valley
    changed = True
    while changed:
        changed = False
        for c in list(comps):
            if c[2] <= 36:
                continue
            x, y, w, h = c[0], c[1], c[2], c[3]
            reg = (m[y:y + h, x:x + w] > 0)
            colsum = reg.sum(axis=0)
            lo, hi = int(0.3 * w), max(int(0.3 * w) + 1, int(0.7 * w))
            k = int(np.argmin(colsum[lo:hi])) + lo
            if colsum[k] <= 4 and 8 <= k <= w - 8:
                comps.remove(c)
                for px, pw in ((x, k), (x + k, w - k)):
                    sub = reg[:, px - x:px - x + pw]
                    comps.append([px, y, pw, h, int(sub.sum()), h, px, y, pw, h, 0, 0])
                changed = True
                break
    comps.sort(key=lambda c: c[0])
    merged = []
    for c in comps:
        if merged:
            last = merged[-1]
            xgap = c[0] - (last[0] + last[2])
            ygap = c[1] - (last[1] + last[3])
            ygap2 = last[1] - (c[1] + c[3])
            cx1, cy1 = last[0] + last[2] / 2.0, last[1] + last[3] / 2.0
            cx2, cy2 = c[0] + c[2] / 2.0, c[1] + c[3] / 2.0
            cdist = ((cx1 - cx2) ** 2 + (cy1 - cy2) ** 2) ** 0.5
            hmin = min(last[3], c[3])
            near = (xgap <= 3 and ((-3 <= ygap <= 5) or (-3 <= ygap2 <= 5)
                                   or (-6 <= ygap <= 5 and hmin >= 7)      # split digit halves
                                   or (-6 <= ygap2 <= 5 and hmin >= 7)
                                   or (6 <= ygap <= 17 and xgap <= 0)      # stacked leg under bar ('7')
                                   or (6 <= ygap2 <= 17 and xgap <= 0)
                                   or (xgap <= 0 and cdist <= 13)))
            if near:
                x2 = max(last[0] + last[2], c[0] + c[2])
                y1 = min(last[1], c[1])
                y2 = max(last[1] + last[3], c[1] + c[3])
                nx, nw = min(last[0], c[0]), x2 - min(last[0], c[0])
                nh = y2 - y1
                if (nw <= 30 or (min(last[0] + last[2], c[0] + c[2]) - max(last[0], c[0]) >= 4
                                 and nw <= 36)) and nh <= 34:
                    # wide-but-stacked ('7' bar+leg) may exceed 30; side-by-side
                    # glyph pairs ('+2', '42') must stay split
                    last[0], last[2] = nx, nw
                    last[1], last[3] = y1, nh
                    last[4] += c[4]
                    last[10] = last[10] or c[10]
                    last[11] = last[11] or c[11]
                    # keep the LARGEST sub-component (op reads come from its core)
                    if (c[8] * c[9]) > (last[8] * last[9]):
                        last[5], last[6], last[7], last[8], last[9] = c[5], c[6], c[7], c[8], c[9]
                    continue
        merged.append(list(c))
    # keep glyphs; but never drop a wide-thin stroke (the '-' operator is area~25)
    return [c for c in merged
            if c[4] >= 28 or (c[3] <= 8 and c[2] >= 8 and c[4] >= 18)]


def cls_box(m, bgr, c, xlo=0, xhi=10 ** 9):
    """Read a glyph's core (largest sub) + full box -> (ndSub, nmSub, npSub, ndFull).
       xlo/xhi clamp the full-box crop to the gutters between neighbours so a
       wide merged box cannot read the NEXT digit as its own value."""
    sx, sy, sw, sh = c[6], c[7], max(2, c[8]), max(2, c[9])
    pad = 2
    ys, ye, xs, xe = max(0, sy - pad), sy + sh + pad, max(0, sx - pad), sx + sw + pad
    fx, fy, fw, fh = c[0], c[1], c[2], c[3]
    fpad = 5
    fys, fye = max(0, fy - fpad), fy + fh + fpad
    fxs, fxe = max(0, fx - fpad, xlo), min(fx + fw + fpad, xhi)
    if fxe <= fxs:
        fxs, fxe = max(0, fx - fpad), fx + fw + fpad
    if fye <= fys:
        fys, fye = max(0, fy - fpad), fy + fh + fpad
    if xe <= xs or ye <= ys or fxe <= fxs or fye <= fys:
        return 0, 0, 0, 0
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    variants = [
        (255 - m[ys:ye, xs:xe], 56),
        (gray[ys:ye, xs:xe], 56),
        (255 - gray[ys:ye, xs:xe], 56),
    ]
    fvariants = [
        (255 - m[fys:fye, fxs:fxe], 60),
        (gray[fys:fye, fxs:fxe], 60),
    ]
    nd = nminus = nplus = ndf = 0

    def tally(base, hgt):
        nonlocal nd, nminus, nplus, ndf
        sc = hgt / max(1, base.shape[0])
        up = cv2.resize(base, None, fx=sc, fy=sc, interpolation=cv2.INTER_CUBIC)
        up = cv2.copyMakeBorder(up, 8, 8, 8, 8, cv2.BORDER_CONSTANT, value=255)
        up3 = cv2.cvtColor(up, cv2.COLOR_GRAY2BGR) if up.ndim == 2 else up
        ok, buf = cv2.imencode(".png", up3)
        if not ok:
            return
        for beta in (False, True):
            try:
                t = get_ocr(beta).classification(buf.tobytes())
            except Exception:
                t = ""
            t = (t or "").strip()
            isdig = bool(re.fullmatch(r"[0-9]", t))
            if isdig:
                nd += 1
            if "-" in t or "~" in t or "_" in t:
                nminus += 1
            if any(ch in t for ch in "+*xX"):
                nplus += 1

    for base, hgt in variants:
        tally(base, hgt)
    for base, hgt in fvariants:
        sc = hgt / max(1, base.shape[0])
        up = cv2.resize(base, None, fx=sc, fy=sc, interpolation=cv2.INTER_CUBIC)
        up = cv2.copyMakeBorder(up, 8, 8, 8, 8, cv2.BORDER_CONSTANT, value=255)
        up3 = cv2.cvtColor(up, cv2.COLOR_GRAY2BGR) if up.ndim == 2 else up
        ok, buf = cv2.imencode(".png", up3)
        if ok:
            for beta in (False, True):
                try:
                    t = get_ocr(beta).classification(buf.tobytes())
                except Exception:
                    t = ""
                if re.fullmatch(r"[0-9]", (t or "").strip()):
                    ndf += 1
    return nd, nminus, nplus, ndf


def classify(bgr, text=None, best_of=None):
    """dddocr classification on one image (or list of them)."""
    multi = isinstance(text, list)
    imgs = text if multi else [text]
    out = []
    for im in imgs:
        if im is None:
            out.append("")
            continue
        if im.ndim == 2:
            im = cv2.cvtColor(im, cv2.COLOR_GRAY2BGR)
        ok, buf = cv2.imencode(".png", im)
        if not ok:
            out.append("")
            continue
        got = ""
        for beta in (False, True):
            try:
                t = get_ocr(beta).classification(buf.tobytes())
            except Exception:
                t = ""
            if len(t or "") > len(got):
                got = t or ""
        out.append(got)
    if best_of:
        return max(out, key=len)
    return out if multi else out[0]


def digits_of(s):
    return re.sub(r"[^0-9]", "", s or "")


def line_views(bgr, m):
    """Full-line preprocessing variants for digit-sequence reads."""
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    views = [bgr, cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR),
             cv2.cvtColor(255 - gray, cv2.COLOR_GRAY2BGR),
             cv2.resize(bgr, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC)]
    _, otsu = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    for k in (0, 3, 5):
        mm = otsu if k == 0 else cv2.morphologyEx(
            otsu, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
        for variant in (mm, 255 - mm):
            v = cv2.copyMakeBorder(variant, 15, 15, 15, 15, cv2.BORDER_CONSTANT, value=255)
            views.append(cv2.cvtColor(v, cv2.COLOR_GRAY2BGR))
            views.append(cv2.resize(v, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC))
    for t in (100, 120, 140, 150, 160, 180):
        _, b = cv2.threshold(gray, t, 255, cv2.THRESH_BINARY_INV)
        views.append(cv2.cvtColor(b, cv2.COLOR_GRAY2BGR))
        views.append(cv2.resize(b, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC))
    views.append(cv2.resize(m, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC))
    views.append(255 - m)
    return views


def full_line_digits(bgr, m, total):
    """Digit strings from full-line views (std + beta models); exact = len==total."""
    exact = []
    longest = ""
    for im in line_views(bgr, m):
        if im.ndim == 2:
            im = cv2.cvtColor(im, cv2.COLOR_GRAY2BGR)
        ok, buf = cv2.imencode(".png", im)
        if not ok:
            continue
        for beta in (False, True):
            try:
                t = get_ocr(beta).classification(buf.tobytes())
            except Exception:
                t = ""
            d = digits_of(t)
            if len(d) > len(longest):
                longest = d
            if len(d) == total:
                exact.append(d)
    return exact, longest


def glyph_reads(m, bgr, c):
    """Multi-variant reads of one glyph -> list of digit strings."""
    x, y, w, h = c[0], c[1], c[2], c[3]
    pad = 6
    ys, ye, xs, xe = max(0, y - pad), y + h + pad, max(0, x - pad), x + w + pad
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    srcs = {"bin": m[ys:ye, xs:xe], "gray": gray[ys:ye, xs:xe]}
    outs = []
    for k in (0, 5, 7):
        for name, base in list(srcs.items()):
            cr = base if k == 0 else cv2.morphologyEx(
                base, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
            for poln, pol in (("d", cr), ("l", 255 - cr)):
                for hgt in (50, 70):
                    sc = hgt / max(1, pol.shape[0])
                    up = cv2.resize(pol, None, fx=sc, fy=sc, interpolation=cv2.INTER_CUBIC)
                    up = cv2.copyMakeBorder(up, 8, 8, 8, 8, cv2.BORDER_CONSTANT, value=255)
                    t = classify(None, up)
                    if t and t.strip().lower() in ("l", "i", "!", "|"):
                        t = "1"
                    d = digits_of(t)
                    if d:
                        outs.append(d[:1])
    return outs


def norm_vec(m, c, k=5):
    x, y, w, h = c[0], c[1], c[2], c[3]
    pad = 6
    crop = m[max(0, y - pad):y + h + pad, max(0, x - pad):x + w + pad]
    if k:
        crop = cv2.morphologyEx(crop, cv2.MORPH_CLOSE,
                                cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
    n, lab, stats, _ = cv2.connectedComponentsWithStats((crop > 0).astype(np.uint8), 8)
    areas = sorted([stats[i, cv2.CC_STAT_AREA] for i in range(1, n)], reverse=True)
    big = areas[1] if len(areas) > 1 else 1
    keep = np.zeros_like(crop)
    for i in range(1, n):
        if stats[i, cv2.CC_STAT_AREA] >= big * 0.35:
            keep[lab == i] = 255
    ys, xs = np.where(keep > 0)
    if len(ys) == 0:
        return np.zeros((32, 32), np.uint8)
    crop = keep[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
    return cv2.resize(crop, (32, 32), interpolation=cv2.INTER_AREA)


def templ_match(vec):
    if not TEMPLATES:
        return None, 0.0
    best_per = {}
    for d, t in TEMPLATES:
        s = float(iou(vec, t))
        if s > best_per.get(d, -1.0):
            best_per[d] = s
    if not best_per:
        return None, 0.0
    bd, bs = max(best_per.items(), key=lambda kv: kv[1])
    second = max((s for d, s in best_per.items() if d != bd), default=0.0)
    # ambiguous cross-digit match (e.g. 8 vs 9 at 0.54/0.51) -> caller falls back
    if bs < 0.30 or bs - second < 0.08:
        return None, bs
    return bd, bs


def majority(reads, min_votes=3):
    if not reads:
        return None, 0

    def mode(rs):
        tally, first = {}, {}
        for idx, r in enumerate(rs):
            tally[r] = tally.get(r, 0) + 1
            first.setdefault(r, idx)
        cnt = max(tally.values())
        # ties: the earliest plain read is the least-processed variant ('7' vs '2')
        dig = min((r for r, c in tally.items() if c == cnt), key=lambda r: first[r])
        return (dig, cnt) if cnt >= min_votes else (None, cnt)

    # plain (k=0) reads come first in glyph_reads; morph-close variants turn an
    # open '3' into '8', so trust plain reads whenever they agree strongly
    if len(reads) > 8:
        d, cnt = mode(reads[:8])
        if d:
            return d, cnt
    return mode(reads)


def solve(path):
    bgr, m = load_mask(path)
    boxes = glyph_boxes(m)
    if not boxes:
        return None
    boxes.sort(key=lambda c: c[0])
    hs = sorted(c[3] for c in boxes)
    H90 = float(np.percentile(hs, 90)) if hs else 24.0
    Hdig = max(17.0, 0.68 * H90)
    # classify every glyph (size-independent fusion of reads + relative geometry)
    classes = []
    for i, c in enumerate(boxes):
        xlo = boxes[i - 1][0] + boxes[i - 1][2] + 1 if i else 0
        xhi = boxes[i + 1][0] - 1 if i + 1 < len(boxes) else 10 ** 9
        classes.append(cls_box(m, bgr, c, xlo, xhi))
    is_dig = []
    is_opc = []
    max_h = max(c[3] for c in boxes)

    def longest_run(vec):
        best = cur = 0
        for v in vec:
            cur = cur + 1 if v else 0
            if cur > best:
                best = cur
        return best

    for c, cl in zip(boxes, classes):
        nd, nm, np_, ndf = cl
        is_dig.append(c[3] >= Hdig or nd + ndf >= 3)
        x, y, w, h = c[0], c[1], c[2], c[3]
        crop = (m[y:y + h, x:x + w] > 0).astype(np.uint8)
        rows, cols = crop.sum(axis=1), crop.sum(axis=0)
        # '=': >=2 separated LONG horizontal runs AND no vertical arm through
        # the centre (a '+' has the arm -> survives for the OPC conditions)
        closed = cv2.morphologyEx(crop * 255, cv2.MORPH_CLOSE,
                                  cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7))) > 0
        bar = [longest_run(closed[ri]) >= 0.55 * w for ri in range(h)]
        groups, last_end = 0, -99
        for ri, b in enumerate(bar):
            if b:
                if ri - last_end > 3:
                    groups += 1
                last_end = ri
        c0, c1 = int(0.35 * w), max(int(0.65 * w) + 1, int(0.35 * w) + 1)
        vbar_arm = max((longest_run(closed[:, ci]) for ci in range(c0, c1)), default=0)
        if groups >= 2 and h > 9 and vbar_arm < 0.45 * h:
            is_opc.append(False)          # '=' -> never an operator
            continue
        # geometric '+' : both arms cross the box centre, box is not digit-tall
        # and the glyph has no confident digit reads ('4' etc. stay out)
        r0, r1 = int(0.35 * h), int(0.65 * h) + 1
        c0, c1 = int(0.35 * w), int(0.65 * w) + 1
        cross = (rows[r0:r1].max() >= 0.45 * w and cols[c0:c1].max() >= 0.45 * h
                 and nd + ndf <= 2 and c[5] >= 0.55 * h)
        # operator-shaped: core reads op-ish (and full box shows no digit),
        # a thin horizontal stroke, or a short glyph with no digit reads
        is_opc.append((np_ >= 1 and nd <= 1 and ndf <= 1)
                      or (c[5] <= 9 and ndf <= 1)
                      or (c[3] < Hdig and ndf <= 3)
                      or (h <= 0.82 * max_h and cross))
    # leftmost op-shaped glyph with a digit IMMEDIATELY on both sides = operator
    op_idx = -1
    for i in range(1, len(boxes) - 1):
        if is_opc[i] and is_dig[i - 1] and is_dig[i + 1]:
            op_idx = i
            break
    if op_idx < 0:
        t = re.sub(r"[=?\s]", "", classify(None, bgr)).strip()
        # letter-captcha only: a bare digit string here is a misparsed math
        # captcha -> must fall back, never submit garbage
        if re.search(r"[A-Za-z]", t or "") and re.fullmatch(r"[A-Za-z0-9]{4,8}", t or ""):
            return {"answer": t, "expr": t, "method": "letters"}
        return None
    # operator char: a '+' has a vertical arm spanning the box; a '-' (or noise)
    # never does. subh is unreliable (a stipple-broken cross core can be tiny).
    oc = boxes[op_idx]
    ox, oy, ow, oh = oc[0], oc[1], oc[2], oc[3]
    if oh <= 9:
        opch = "-"
    else:
        crop = (m[oy:oy + oh, ox:ox + ow] > 0).astype(np.uint8)
        closed = cv2.morphologyEx(crop * 255, cv2.MORPH_CLOSE,
                                  cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7))) > 0
        hbar = max(longest_run(row) for row in closed) >= 0.5 * ow
        arm = False
        for ci in range(int(0.35 * ow), max(int(0.65 * ow) + 1, int(0.35 * ow) + 1)):
            col = closed[:, ci]
            best = cur = be = bs = 0
            for ri, v in enumerate(col):
                if v:
                    if cur == 0:
                        bs = ri
                    cur += 1
                    if cur > best:
                        best, be = cur, ri
                else:
                    cur = 0
            if best >= max(7, 0.5 * oh) and bs <= 0.3 * oh and be >= 0.7 * oh:
                arm = True
                break
        opch = "+" if (hbar and arm) else "-"
    # <=2 digit glyphs per side, contiguous from the operator
    untrusted = [False]

    def walkable(i):
        """(keep|None=stop, box): digits yes; thin fragments only if confidently
           a digit — and any fragment decision flags the result untrusted so a
           stray '+ foot'/'7 bar' can never produce a confidently-wrong answer."""
        c = boxes[i]
        if c[2] > 36:              # unsplit touching pair -> never answer locally
            untrusted[0] = True
            return None, c
        if is_dig[i]:
            return True, c
        if c[3] <= 8:
            rd = glyph_reads(m, bgr, c)
            d, cnt = majority(rd, min_votes=3)
            if d:
                return True, c
            t, s = templ_match(norm_vec(m, c))
            if t:
                untrusted[0] = True
                return True, c
            untrusted[0] = True
            return False, c          # fragment of nothing -> invisible
        return None, c               # real separator ('=', '?', op) -> stop

    left_boxes = []
    for i in range(op_idx - 1, -1, -1):
        keep, c = walkable(i)
        if keep is None:
            break
        if keep:
            left_boxes.append(c)
        if len(left_boxes) == 2:
            break
    left_boxes.reverse()
    right_boxes = []
    for i in range(op_idx + 1, len(boxes)):
        keep, c = walkable(i)
        if keep is None:
            break
        if keep:
            right_boxes.append(c)
        if len(right_boxes) == 2:
            break
    if untrusted[0]:
        return None
    if not left_boxes or not right_boxes:
        return None
    nL, nR = len(left_boxes), len(right_boxes)
    total = nL + nR
    all_boxes = left_boxes + right_boxes
    reads = [glyph_reads(m, bgr, c) for c in all_boxes]
    votes = []
    for rd in reads:
        d, _ = majority(rd, min_votes=3)
        votes.append(d)
    # 1) full-line exact digit string, only if it agrees with EVERY known glyph vote
    exact, longest = full_line_digits(bgr, m, total)
    left = right = None
    mode = None
    consensus = False
    matched = 0
    if exact:
        known = sum(1 for v in votes if v)
        tally = {}
        for d in exact:
            tally[d] = tally.get(d, 0) + 1
        mode, mode_cnt = max(tally.items(), key=lambda kv: kv[1])
        consensus = mode_cnt * 4 >= len(exact) * 3
        matched = sum(1 for i, ch in enumerate(mode) if votes[i] and votes[i] == ch)
        # trust the line-read only when it is a consensus AND agrees with votes
        # (a single wrong glyph vote must not veto a unanimous line read)
        if consensus and matched >= max(0, known - 1):
            left, right = mode[:nL], mode[nL:]
    # 2) per-glyph majority
    if left is None and all(votes):
        left, right = "".join(votes[:nL]), "".join(votes[nL:])
    # 3) template matching for unresolved glyphs
    if left is None:
        vecs = [norm_vec(m, c) for c in all_boxes]
        for i, v in enumerate(vecs):
            if votes[i] is None:
                d, s = templ_match(v)
                votes[i] = d if d and s >= 0.28 else None
        if all(votes):
            left, right = "".join(votes[:nL]), "".join(votes[nL:])
    if not left or not right:
        return None
    # a confident glyph vote must not be contradicted by the template bank
    # (stipple makes ddddocr read a clear '5' as '3' -> bank says otherwise)
    for rd, c in zip(reads, all_boxes):
        d, cnt = majority(rd, min_votes=5)
        if d:
            t, s = templ_match(norm_vec(m, c))
            if t and t != d:
                return None
    # safety: unanimous line-read that contradicts the per-glyph answer (same
    # digit count, at least one position agrees) -> one reader misread
    if consensus and mode and len(mode) == nL + nR and mode != left + right and matched >= 1:
        return None
    a, b = int(left), int(right)
    val = a + b if opch == "+" else a - b
    if not -999 <= val <= 9999:
        return None
    # harvest high-confidence glyphs into the local template bank
    for rd, c in zip(reads, all_boxes):
        d, cnt = majority(rd, min_votes=8)
        if d:
            harvest(d, norm_vec(m, c).flatten().tolist())
    return {"answer": str(val), "expr": "%d%s%d" % (a, opch, b), "method": "local"}


def main():
    if len(sys.argv) < 2 or not os.path.exists(sys.argv[1]):
        sys.exit(1)
    res = solve(sys.argv[1])
    if not res:
        sys.exit(1)
    print(json.dumps(res))


if __name__ == "__main__":
    main()
