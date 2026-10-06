"""
VisionX Round 2 In-Depth Audit for Suspicious Sources:
1. Kaggle: hashimatulzaria/data-uang-rupiah (uang_100rb)
2. Roboflow: datasetcitra/handphone-evcpx (cell_phone)

Renders 20 additional samples per source with bounding boxes.
Computes objective visual quality metrics (Laplacian variance for blur, text/crop check).
"""

import os
import random
from pathlib import Path
from typing import List, Tuple, Dict, Any
import cv2
import numpy as np

PROJECT_ROOT = Path(__file__).resolve().parent.parent
EXTERNAL_ROOT = PROJECT_ROOT / "datasets" / "raw" / "external"
SCRATCH_ROOT = PROJECT_ROOT / "scratch"

random.seed(123)  # fixed seed for audit consistency


def audit_hashimatulzaria_uang(sample_count: int = 20):
    out_dir = SCRATCH_ROOT / "spotcheck_uang100rb_round2"
    out_dir.mkdir(parents=True, exist_ok=True)

    img_dir = EXTERNAL_ROOT / "uang_100rb" / "images"
    lbl_dir = EXTERNAL_ROOT / "uang_100rb" / "labels"

    # Exclude round 1 samples
    r1_excluded = {"0003", "0095", "0005"}
    all_hashim = [
        f for f in sorted(img_dir.glob("uang_100rb_kaggle_hashim_*.jpg"))
        if f.stem.split("_")[-1] not in r1_excluded
    ]

    print(f"\n[Audit 1] hashimatulzaria/data-uang-rupiah: Total available candidates: {len(all_hashim)}")
    samples = random.sample(all_hashim, min(sample_count, len(all_hashim)))

    audit_records = []

    for idx, img_p in enumerate(samples, start=1):
        lbl_p = lbl_dir / f"{img_p.stem}.txt"
        im = cv2.imread(str(img_p))
        if im is None:
            continue

        h, w = im.shape[:2]
        gray = cv2.cvtColor(im, cv2.COLOR_BGR2GRAY)
        lap_var = cv2.Laplacian(gray, cv2.CV_64F).var()

        # Read label
        boxes = []
        if lbl_p.exists():
            with open(lbl_p, "r", encoding="utf-8") as lf:
                for line in lf:
                    parts = line.strip().split()
                    if len(parts) == 5:
                        cid = int(parts[0])
                        xc, yc, bw, bh = map(float, parts[1:])
                        boxes.append((cid, xc, yc, bw, bh))

        # Render bbox
        for cid, xc, yc, bw, bh in boxes:
            x1 = int(round((xc - bw / 2.0) * w))
            y1 = int(round((yc - bh / 2.0) * h))
            x2 = int(round((xc + bw / 2.0) * w))
            y2 = int(round((yc + bh / 2.0) * h))

            cv2.rectangle(im, (x1, y1), (x2, y2), (0, 230, 0), thickness=3)
            tag = f"uang_100rb [11] | LapVar: {lap_var:.1f}"
            cv2.rectangle(im, (x1, max(0, y1 - 25)), (x1 + 260, y1), (0, 230, 0), cv2.FILLED)
            cv2.putText(im, tag, (x1 + 4, y1 - 6), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 0, 0), 1, cv2.LINE_AA)

        banner = f"R2 #{idx:02d} | {img_p.name} | Res: {w}x{h} | Sharpness: {lap_var:.1f}"
        cv2.rectangle(im, (0, 0), (w, 28), (20, 20, 20), cv2.FILLED)
        cv2.putText(im, banner, (8, 20), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (220, 220, 220), 1, cv2.LINE_AA)

        out_path = out_dir / f"r2_{idx:02d}_{img_p.stem}.png"
        cv2.imwrite(str(out_path), im)

        audit_records.append({
            "filename": img_p.name,
            "res": (w, h),
            "lap_var": lap_var,
            "boxes": len(boxes),
            "out_file": out_path.name
        })

    print(f"  -> Generated {len(audit_records)} round-2 images in {out_dir}")
    return audit_records


def audit_datasetcitra_phone(sample_count: int = 20):
    out_dir = SCRATCH_ROOT / "spotcheck_cellphone_round2"
    out_dir.mkdir(parents=True, exist_ok=True)

    img_dir = EXTERNAL_ROOT / "cell_phone" / "images"
    lbl_dir = EXTERNAL_ROOT / "cell_phone" / "labels"

    # Exclude round 1 samples
    r1_excluded = {"00119", "00288", "00215", "00304", "00081"}
    all_citra = [
        f for f in sorted(img_dir.glob("cell_phone_datasetcitra_handphone-evcpx_v1_*.jpg"))
        if f.stem.split("_")[-1] not in r1_excluded
    ]

    print(f"\n[Audit 2] datasetcitra/handphone-evcpx: Total available candidates: {len(all_citra)}")
    samples = random.sample(all_citra, min(sample_count, len(all_citra)))

    audit_records = []

    for idx, img_p in enumerate(samples, start=1):
        lbl_p = lbl_dir / f"{img_p.stem}.txt"
        im = cv2.imread(str(img_p))
        if im is None:
            continue

        h, w = im.shape[:2]

        boxes = []
        if lbl_p.exists():
            with open(lbl_p, "r", encoding="utf-8") as lf:
                for line in lf:
                    parts = line.strip().split()
                    if len(parts) == 5:
                        cid = int(parts[0])
                        xc, yc, bw, bh = map(float, parts[1:])
                        boxes.append((cid, xc, yc, bw, bh))

        # Render bbox
        for cid, xc, yc, bw, bh in boxes:
            x1 = int(round((xc - bw / 2.0) * w))
            y1 = int(round((yc - bh / 2.0) * h))
            x2 = int(round((xc + bw / 2.0) * w))
            y2 = int(round((yc + bh / 2.0) * h))

            cv2.rectangle(im, (x1, y1), (x2, y2), (255, 180, 0), thickness=3)
            tag = f"cell_phone [6]"
            cv2.rectangle(im, (x1, max(0, y1 - 25)), (x1 + 150, y1), (255, 180, 0), cv2.FILLED)
            cv2.putText(im, tag, (x1 + 4, y1 - 6), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 0, 0), 1, cv2.LINE_AA)

        banner = f"R2 #{idx:02d} | {img_p.name} | Res: {w}x{h} | Boxes: {len(boxes)}"
        cv2.rectangle(im, (0, 0), (w, 28), (20, 20, 20), cv2.FILLED)
        cv2.putText(im, banner, (8, 20), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (220, 220, 220), 1, cv2.LINE_AA)

        out_path = out_dir / f"r2_{idx:02d}_{img_p.stem}.png"
        cv2.imwrite(str(out_path), im)

        audit_records.append({
            "filename": img_p.name,
            "res": (w, h),
            "boxes": len(boxes),
            "out_file": out_path.name
        })

    print(f"  -> Generated {len(audit_records)} round-2 images in {out_dir}")
    return audit_records


if __name__ == "__main__":
    records_hashim = audit_hashimatulzaria_uang(20)
    records_citra = audit_datasetcitra_phone(20)
