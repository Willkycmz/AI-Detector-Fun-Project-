"""
Ingest and standardize additional COCO images for 5 under-represented classes:
  - keyboard (COCO 66 -> VisionX 5)
  - laptop   (COCO 63 -> VisionX 3)
  - bottle   (COCO 39 -> VisionX 1)
  - cup      (COCO 41 -> VisionX 2)
  - person   (COCO 0  -> VisionX 0, naturally enriched via co-occurrence)

Source: HuggingFace benjamintli/coco2017-10k (local parquet cache in scratch/hf_cache/)
Target: datasets/raw/external/{keyboard, laptop, bottle, cup}/
Deduplication: SHA-256 against all existing images in V1, OWN, and external datasets.
"""

import os
import hashlib
from pathlib import Path
from collections import Counter
import cv2
import numpy as np
import pyarrow.parquet as pq

PROJECT_ROOT = Path(__file__).resolve().parent.parent
RAW_EXT = PROJECT_ROOT / "datasets" / "raw" / "external"
RAW_OWN = PROJECT_ROOT / "datasets" / "raw" / "own"
PROCESSED_V1 = PROJECT_ROOT / "datasets" / "processed"
CACHE_DIR = PROJECT_ROOT / "scratch" / "hf_cache"

# All COCO categories supported by VisionX
COCO_TO_VISIONX = {
    0: 0,    # person
    39: 1,   # bottle
    41: 2,   # cup
    63: 3,   # laptop
    64: 4,   # mouse
    66: 5,   # keyboard
    67: 6,   # cell_phone
    2: 14,   # car
    3: 15,   # motorcycle
    24: 16,  # backpack
    25: 17,  # umbrella
    73: 18,  # book
}

# The 4 target folders (priority order: rarest first)
PRIORITY_FOLDERS = [
    (66, "keyboard"),
    (63, "laptop"),
    (39, "bottle"),
    (41, "cup"),
]


def sanitize_bbox(xc: float, yc: float, w: float, h: float):
    xc = max(0.0, min(1.0, xc))
    yc = max(0.0, min(1.0, yc))
    w = max(0.002, min(1.0, w))
    h = max(0.002, min(1.0, h))
    return round(xc, 6), round(yc, 6), round(w, 6), round(h, 6)


def main():
    print("=" * 70)
    print(" VisionX: Ingesting COCO Images for 5 Classes (keyboard, laptop, bottle, cup, person)")
    print("=" * 70)

    # 1. Collect all existing SHA-256 hashes across all dataset folders
    existing_hashes = set()
    print("\n[Step 1] Scanning existing images for SHA-256 deduplication...")

    # Processed V1
    for split in ["train", "val", "test"]:
        p = PROCESSED_V1 / "images" / split
        if p.exists():
            for f in os.listdir(p):
                if f.endswith((".jpg", ".png", ".jpeg")):
                    existing_hashes.add(hashlib.sha256((p / f).read_bytes()).hexdigest())

    # Raw Own
    p = RAW_OWN / "images"
    if p.exists():
        for f in os.listdir(p):
            if f.endswith((".jpg", ".png", ".jpeg")):
                existing_hashes.add(hashlib.sha256((p / f).read_bytes()).hexdigest())

    # Raw External
    for ext_dir in RAW_EXT.iterdir():
        if ext_dir.is_dir() and not ext_dir.name.startswith("_"):
            img_dir = ext_dir / "images"
            if img_dir.exists():
                for f in os.listdir(img_dir):
                    if f.endswith((".jpg", ".png", ".jpeg")):
                        existing_hashes.add(hashlib.sha256((img_dir / f).read_bytes()).hexdigest())

    print(f"  Total existing image hashes: {len(existing_hashes)}")

    # 2. Setup destination directories
    print("\n[Step 2] Setting up destination folders...")
    for _, folder_name in PRIORITY_FOLDERS:
        img_out = RAW_EXT / folder_name / "images"
        lbl_out = RAW_EXT / folder_name / "labels"
        img_out.mkdir(parents=True, exist_ok=True)
        lbl_out.mkdir(parents=True, exist_ok=True)
        # Clear any existing files in these 4 folders if re-running
        for f in img_out.glob("*.*"):
            f.unlink()
        for f in lbl_out.glob("*.*"):
            f.unlink()
        print(f"  Cleaned & ready: datasets/raw/external/{folder_name}/")

    # 3. Process Parquet Files
    print("\n[Step 3] Processing Parquet Files from scratch/hf_cache/...")
    parquet_files = [
        CACHE_DIR / "val_0.parquet",
        CACHE_DIR / "train_0.parquet",
        CACHE_DIR / "train_1.parquet",
        CACHE_DIR / "train_2.parquet",
        CACHE_DIR / "train_3.parquet",
    ]

    folder_counts = {folder: 0 for _, folder in PRIORITY_FOLDERS}
    extracted_hashes = set()
    total_boxes_written = Counter()

    for pq_file in parquet_files:
        if not pq_file.exists():
            print(f"  Warning: {pq_file.name} does not exist, skipping.")
            continue

        print(f"  Reading {pq_file.name}...", flush=True)
        table = pq.read_table(str(pq_file), columns=["image", "objects"])
        num_rows = len(table)

        for row_idx in range(num_rows):
            img_dict = table["image"][row_idx].as_py()
            obj_dict = table["objects"][row_idx].as_py()

            img_bytes = img_dict.get("bytes")
            if not img_bytes:
                continue

            h = hashlib.sha256(img_bytes).hexdigest()
            if h in existing_hashes or h in extracted_hashes:
                continue

            cats = obj_dict.get("category", [])
            bboxes = obj_dict.get("bbox", [])
            if not cats or not bboxes or len(cats) != len(bboxes):
                continue

            cat_set = set(cats)

            # Determine target folder by priority
            assigned_folder = None
            for coco_id, folder_name in PRIORITY_FOLDERS:
                if coco_id in cat_set:
                    assigned_folder = folder_name
                    break

            if assigned_folder is None:
                continue

            # Decode image to get dimensions
            img_arr = np.frombuffer(img_bytes, dtype=np.uint8)
            img = cv2.imdecode(img_arr, cv2.IMREAD_COLOR)
            if img is None:
                continue
            h_img, w_img = img.shape[:2]
            if w_img < 100 or h_img < 100:
                continue

            # Extract ALL VisionX bounding boxes present in this image
            yolo_lines = []
            for cat_id, bbox in zip(cats, bboxes):
                if cat_id in COCO_TO_VISIONX:
                    vx_id = COCO_TO_VISIONX[cat_id]
                    x_min, y_min, w, h_box = bbox
                    if w <= 0 or h_box <= 0:
                        continue
                    xc = (x_min + w / 2.0) / w_img
                    yc = (y_min + h_box / 2.0) / h_img
                    nw = w / w_img
                    nh = h_box / h_img
                    xc, yc, nw, nh = sanitize_bbox(xc, yc, nw, nh)
                    yolo_lines.append(f"{vx_id} {xc:.6f} {yc:.6f} {nw:.6f} {nh:.6f}")
                    total_boxes_written[vx_id] += 1

            if not yolo_lines:
                continue

            # Write image and label
            idx = folder_counts[assigned_folder]
            file_stem = f"{assigned_folder}_coco_{idx:05d}"

            out_img = RAW_EXT / assigned_folder / "images" / f"{file_stem}.jpg"
            out_lbl = RAW_EXT / assigned_folder / "labels" / f"{file_stem}.txt"

            out_img.write_bytes(img_bytes)
            out_lbl.write_text("\n".join(yolo_lines) + "\n", encoding="utf-8")

            folder_counts[assigned_folder] += 1
            extracted_hashes.add(h)

        print(f"    Current counts after {pq_file.name}: {folder_counts}")

    print("\n" + "=" * 70)
    print(" EXTRACTION RESULTS SUMMARY")
    print("=" * 70)
    for _, folder_name in PRIORITY_FOLDERS:
        print(f"  datasets/raw/external/{folder_name:10s} : {folder_counts[folder_name]:5d} images")
    print(f"  Total new unique images added    : {sum(folder_counts.values()):5d}")

    print("\nBounding Boxes extracted per VisionX Class:")
    vx_names = {
        0: "person", 1: "bottle", 2: "cup", 3: "laptop", 4: "mouse",
        5: "keyboard", 6: "cell_phone", 14: "car", 15: "motorcycle",
        16: "backpack", 17: "umbrella", 18: "book"
    }
    for vx_id in sorted(total_boxes_written.keys()):
        print(f"  VisionX ID {vx_id:2d} ({vx_names.get(vx_id, 'unknown'):12s}): {total_boxes_written[vx_id]:5d} boxes")

    print("\nExtraction finished successfully!")


if __name__ == "__main__":
    main()
