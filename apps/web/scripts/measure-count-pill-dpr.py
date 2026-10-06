#!/usr/bin/env python3
"""Compare candidate vertical corrections for the count chip across real DPRs.

Reports, per DPR and candidate, how far the numeral ink sits from the chip's
vertical centre. Positive = ink low, negative = ink high. A correction tuned at
an unrealistically high DPR over-shoots once rasterisation quantises it, which
is why this sweeps 1/2/3 instead of trusting one capture.
"""
import glob
import json
import re
import sys
from collections import defaultdict

import numpy as np
from PIL import Image

BASE = sys.argv[1] if len(sys.argv) > 1 else "artifacts/design-qa"
rows = defaultdict(dict)

for meta_path in sorted(glob.glob(f"{BASE}/count-pill-dpr*-*.json")):
    meta = json.load(open(meta_path))
    dpr = meta["dpr"]
    candidate = meta["candidate"]
    clip = meta["clip"]
    img = np.asarray(Image.open(re.sub(r"\.json$", ".png", meta_path)).convert("RGB")).astype(float)
    lum = img.mean(axis=2)

    offsets = []
    for rect in meta["rects"]:
        x0 = (rect["x"] - clip["x"]) * dpr
        y0 = (rect["y"] - clip["y"]) * dpr
        sub = lum[
            int(round(y0)):int(round(y0 + rect["h"] * dpr)),
            int(round(x0)):int(round(x0 + rect["w"] * dpr)),
        ]
        thr = sub.min() + (sub.max() - sub.min()) * 0.35
        ink = sub < thr
        ys, _ = np.nonzero(ink)
        if len(ys) == 0:
            continue
        h = sub.shape[0]
        # in CSS px; positive means the ink sits below the chip's centre
        offsets.append(((ys.min() + ys.max() + 1) / 2 - h / 2) / dpr)

    rows[candidate][dpr] = offsets

print(f"{'candidate':>18} " + " ".join(f"{'dpr'+str(d):>26}" for d in (1, 2, 3)))
print(f"{'':>18} " + " ".join(f"{'per-digit dy      worst':>26}" for _ in (1, 2, 3)))
for candidate, per_dpr in rows.items():
    cells = []
    for dpr in (1, 2, 3):
        offs = per_dpr.get(dpr, [])
        if not offs:
            cells.append(f"{'-':>26}")
            continue
        worst = max(offs, key=abs)
        listed = ",".join(f"{o:+.2f}" for o in offs)
        cells.append(f"{listed:>19} {worst:+6.3f}")
    print(f"{candidate:>18} " + " ".join(cells))
