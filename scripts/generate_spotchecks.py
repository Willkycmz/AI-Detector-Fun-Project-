"""
VisionX Dataset Visual Spot-Check Generator
Renders bounding boxes directly onto image samples and saves to scratch/spotcheck_*/
"""

import os
import random
from pathlib import Path
from typing import List, Tuple
import cv2
import numpy as np

PROJECT_ROOT = Path(__file__).resolve().parent.parent
EXTERNAL_ROOT = PROJECT_ROOT / "datasets" / "raw" / "external"
SCRATCH_ROOT = PROJECT_ROOT / "scratch"

random.seed(42)  # reproducible spot-check


def render_and_save_samples(
    class_name: str,
    target_id: int,
    sample_count: int,
    output_dir_name: str,
    color: Tuple[int, int, int] = (0, 255, 0)  # BGR
):
    out_dir = SCRATCH_ROOT / output_dir_name
    out_dir.mkdir(parents=True, exist_ok=True)

    img_dir = EXTERNAL_ROOT / class_name / "images"
    lbl_dir = EXTERNAL_ROOT / class_name / "labels"

    all_imgs = sorted(list(img_dir.glob("*.jpg")))
    if not all_imgs:
        print(f"WARN: No images found for {class_name}")
        return

    # Group by source prefix to ensure diversified sampling
    by_source = {}
    for img_p in all_imgs:
        parts = img_p.stem.split("_")
        # stem format: {target_cls}_{source_name}_{imported_idx}
        # e.g., uang_100rb_kaggle_hashim_0001 or uang_100rb_agil-skripsi-3_rupiah-banknote-7-cls_00010
        source = "_".join(parts[2:-1]) if len(parts) >= 4 else "source"
        by_source.setdefault(source, []).append(img_p)

    print(f"\nSampling {sample_count} images for [{class_name}] from {len(by_source)} sources: {list(by_source.keys())}")

    selected = []
    # Stratified sample from each source first
    sources = list(by_source.keys())
    while len(selected) < sample_count and any(by_source.values()):
        for src in sources:
            if by_source[src] and len(selected) < sample_count:
                idx = random.randrange(len(by_source[src]))
                selected.append(by_source[src].pop(idx))

    # If still not enough, pick randomly from remaining
    if len(selected) < sample_count:
        remaining = [p for p in all_imgs if p not in selected]
        selected.extend(random.sample(remaining, min(sample_count - len(selected), len(remaining))))

    print(f"  Rendering {len(selected)} samples to {out_dir}...")

    for i, img_p in enumerate(selected, start=1):
        lbl_p = lbl_dir / f"{img_p.stem}.txt"
        if not lbl_p.exists():
            continue

        im = cv2.imread(str(img_p))
        if im is None:
            continue

        h, w = im.shape[:2]

        with open(lbl_p, "r", encoding="utf-8") as f:
            for line in f:
                parts = line.strip().split()
                if len(parts) != 5:
                    continue
                cid = int(parts[0])
                xc, yc, bw, bh = float(parts[1]), float(parts[2]), float(parts[3]), float(parts[4])

                # Convert normalized YOLO to pixel coords
                x1 = int(round((xc - bw / 2.0) * w))
                y1 = int(round((yc - bh / 2.0) * h))
                x2 = int(round((xc + bw / 2.0) * w))
                y2 = int(round((yc + bh / 2.0) * h))

                x1 = max(0, min(w - 1, x1))
                y1 = max(0, min(h - 1, y1))
                x2 = max(0, min(w - 1, x2))
                y2 = max(0, min(h - 1, y2))

                # Draw bounding box
                cv2.rectangle(im, (x1, y1), (x2, y2), color, thickness=3)

                # Label background & text
                label_text = f"{class_name} [{cid}]"
                font = cv2.FONT_HERSHEY_SIMPLEX
                font_scale = 0.55
                font_thick = 2
                (tw, th), baseline = cv2.getTextSize(label_text, font, font_scale, font_thick)

                # Background banner for text
                tag_y1 = max(0, y1 - th - 8)
                tag_y2 = y1
                tag_x1 = x1
                tag_x2 = min(w, x1 + tw + 8)

                cv2.rectangle(im, (tag_x1, tag_y1), (tag_x2, tag_y2), color, cv2.FILLED)
                cv2.putText(
                    im,
                    label_text,
                    (tag_x1 + 4, tag_y2 - 4),
                    font,
                    font_scale,
                    (0, 0, 0),
                    font_thick,
                    cv2.LINE_AA
                )

        # Add image source info banner at top
        banner_text = f"Sample #{i:02d} | {img_p.stem} | {w}x{h}"
        cv2.rectangle(im, (0, 0), (w, 24), (20, 20, 20), cv2.FILLED)
        cv2.putText(im, banner_text, (8, 17), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (220, 220, 220), 1, cv2.LINE_AA)

        out_file = out_dir / f"spotcheck_{i:02d}_{img_p.stem}.png"
        cv2.imwrite(str(out_file), im)

    print(f"  -> Successfully generated {len(selected)} spot-check images in {out_dir}")


def main():
    print("==================================================")
    print(" VisionX Visual Spot-Check Generator")
    print("==================================================")

    # 1. uang_100rb (15 samples)
    render_and_save_samples(
        class_name="uang_100rb",
        target_id=11,
        sample_count=15,
        output_dir_name="spotcheck_uang100rb",
        color=(0, 230, 0)  # Bright Green in BGR
    )

    # 2. cell_phone (15 samples)
    render_and_save_samples(
        class_name="cell_phone",
        target_id=6,
        sample_count=15,
        output_dir_name="spotcheck_cellphone",
        color=(255, 180, 0)  # Cyan/Sky blue in BGR
    )

    # 3. dompet (10 samples)
    render_and_save_samples(
        class_name="dompet",
        target_id=7,
        sample_count=10,
        output_dir_name="spotcheck_dompet",
        color=(0, 140, 255)  # Orange in BGR
    )

    print("\nVisual Spot-Check generation complete!")


if __name__ == "__main__":
    main()
