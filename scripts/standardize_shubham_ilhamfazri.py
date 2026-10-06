"""
Standardize and merge shubham-pvcsg and ilhamfazri3rd datasets into
datasets/raw/external/tanpa_helm/

Rules:
- Standard class IDs: 19 = helm, 20 = tanpa_helm
- Extract all frames containing without-helmet (No-Helm) annotations
- Sanitize coordinates to valid YOLO format [0, 1]
- Preserve sha256 deduplication
"""

import os
import shutil
import hashlib
from pathlib import Path
from typing import Tuple

PROJECT_ROOT = Path(__file__).resolve().parent.parent
STAGING_ROOT = PROJECT_ROOT / "datasets" / "raw" / "external" / "_roboflow_staging"
TARGET_TH_DIR = PROJECT_ROOT / "datasets" / "raw" / "external" / "tanpa_helm"
TH_IMG_DIR = TARGET_TH_DIR / "images"
TH_LBL_DIR = TARGET_TH_DIR / "labels"

SHUBHAM_DIR = STAGING_ROOT / "shubham-pvcsg_helm-n0xvu_v2"
ILHAMFAZRI_DIR = STAGING_ROOT / "ilhamfazri3rd_helmet-violation-deteection_v2"


def sanitize_bbox(xc: float, yc: float, w: float, h: float) -> Tuple[float, float, float, float]:
    xc = max(0.0, min(1.0, xc))
    yc = max(0.0, min(1.0, yc))
    w = max(0.002, min(1.0, w))
    h = max(0.002, min(1.0, h))
    return round(xc, 6), round(yc, 6), round(w, 6), round(h, 6)


def main():
    TH_IMG_DIR.mkdir(parents=True, exist_ok=True)
    TH_LBL_DIR.mkdir(parents=True, exist_ok=True)

    # Collect existing hashes in tanpa_helm
    existing_hashes = set()
    for f in TH_IMG_DIR.glob("*.jpg"):
        try:
            existing_hashes.add(hashlib.sha256(f.read_bytes()).hexdigest())
        except Exception:
            pass

    print(f"[Baseline] Existing tanpa_helm images: {len(existing_hashes)}")

    sources_to_merge = [
        ("shubham", SHUBHAM_DIR),
        ("ilhamfazri", ILHAMFAZRI_DIR)
    ]

    total_added_images = 0
    total_added_nh_boxes = 0
    total_added_h_boxes = 0

    for src_tag, src_path in sources_to_merge:
        print(f"\nProcessing {src_tag} from {src_path.name}...")
        all_candidates = []
        for split in ["train", "valid", "test"]:
            s_img = src_path / split / "images"
            s_lbl = src_path / split / "labels"
            if not s_img.exists():
                continue
            for fn in sorted(os.listdir(s_img)):
                if fn.lower().endswith((".jpg", ".jpeg", ".png", ".webp")):
                    stem = Path(fn).stem
                    lf = s_lbl / f"{stem}.txt"
                    if lf.exists():
                        all_candidates.append((s_img / fn, lf, fn))

        src_added = 0
        src_nh_boxes = 0
        src_h_boxes = 0

        for img_p, lbl_p, fn in all_candidates:
            # Check if has without-helmet (class index 1 in both datasets)
            with open(lbl_p, "r", encoding="utf-8") as f:
                lines = f.read().splitlines()

            has_nh = False
            boxes = []
            for line in lines:
                parts = line.strip().split()
                if len(parts) >= 5:
                    orig_cid = int(parts[0])
                    xc, yc, w, h = [float(p) for p in parts[1:5]]
                    xc, yc, w, h = sanitize_bbox(xc, yc, w, h)
                    if orig_cid == 1: # Without Helmet -> 20
                        has_nh = True
                        boxes.append((20, xc, yc, w, h))
                    elif orig_cid == 0: # With Helmet -> 19
                        boxes.append((19, xc, yc, w, h))

            if not has_nh or not boxes:
                continue

            img_bytes = img_p.read_bytes()
            im_hash = hashlib.sha256(img_bytes).hexdigest()
            if im_hash in existing_hashes:
                continue

            dest_stem = f"tanpa_helm_{src_tag}_{src_added:05d}"
            dest_img = TH_IMG_DIR / f"{dest_stem}.jpg"
            dest_lbl = TH_LBL_DIR / f"{dest_stem}.txt"

            dest_img.write_bytes(img_bytes)
            with open(dest_lbl, "w", encoding="utf-8") as out_f:
                for cid, xc, yc, w, h in boxes:
                    out_f.write(f"{cid} {xc:.6f} {yc:.6f} {w:.6f} {h:.6f}\n")

            existing_hashes.add(im_hash)
            src_added += 1
            src_nh_boxes += sum(1 for b in boxes if b[0] == 20)
            src_h_boxes += sum(1 for b in boxes if b[0] == 19)

        print(f"  -> Added {src_added} images, {src_nh_boxes} no-helm boxes, {src_h_boxes} helm boxes.")
        total_added_images += src_added
        total_added_nh_boxes += src_nh_boxes
        total_added_h_boxes += src_h_boxes

    print("\n" + "=" * 60)
    print("STANDARDIZATION SUMMARY")
    print(f"Total new images added  : {total_added_images}")
    print(f"Total new no-helm boxes : {total_added_nh_boxes}")
    print(f"Total new helm boxes    : {total_added_h_boxes}")
    print(f"Final tanpa_helm images : {len(list(TH_IMG_DIR.glob('*.jpg')))}")
    print("=" * 60)


if __name__ == "__main__":
    main()
