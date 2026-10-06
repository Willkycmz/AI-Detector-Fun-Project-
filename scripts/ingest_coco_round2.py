"""
Ingest and standardize 5 new COCO classes for VisionX:
  14: car
  15: motorcycle
  16: backpack
  17: umbrella
  18: book

Source: HuggingFace benjamintli/coco2017-10k
Target: datasets/raw/external/{class_name}/
"""

import os
import io
import time
import hashlib
import requests
import concurrent.futures
from pathlib import Path
from typing import Dict, List, Set, Tuple
from PIL import Image, ImageDraw, ImageFont
import polars as pl
import cv2
import numpy as np

PROJECT_ROOT = Path(__file__).resolve().parent.parent
RAW_EXT_ROOT = PROJECT_ROOT / "datasets" / "raw" / "external"
CACHE_DIR = PROJECT_ROOT / "scratch" / "hf_cache"
SPOTCHECK_DIR = PROJECT_ROOT / "scratch" / "spotcheck_coco_round2"

TARGET_CLASSES = {
    2: ("car", 14),
    3: ("motorcycle", 15),
    24: ("backpack", 16),
    25: ("umbrella", 17),
    73: ("book", 18),
}

TARGET_MAX = 800  # Up to 800 images per class

PARQUET_URLS = [
    ("val_0", "https://huggingface.co/api/datasets/benjamintli/coco2017-10k/parquet/default/validation/0.parquet"),
    ("train_0", "https://huggingface.co/api/datasets/benjamintli/coco2017-10k/parquet/default/train/0.parquet"),
    ("train_1", "https://huggingface.co/api/datasets/benjamintli/coco2017-10k/parquet/default/train/1.parquet"),
    ("train_2", "https://huggingface.co/api/datasets/benjamintli/coco2017-10k/parquet/default/train/2.parquet"),
    ("train_3", "https://huggingface.co/api/datasets/benjamintli/coco2017-10k/parquet/default/train/3.parquet"),
]


def download_file_multithreaded(url: str, dest_path: Path, num_threads: int = 4):
    if dest_path.exists() and dest_path.stat().st_size > 1024 * 1024:
        print(f"  [Cache hit] {dest_path.name} already exists ({dest_path.stat().st_size / 1024 / 1024:.2f} MB).")
        return

    print(f"  [Resolving] {dest_path.name}...", flush=True)
    r = requests.head(url, allow_redirects=True, timeout=30)
    cdn_url = r.url
    total_size = int(r.headers.get("content-length", 0))
    print(f"  [Downloading] {dest_path.name} ({total_size / 1024 / 1024:.2f} MB) using {num_threads} threads...", flush=True)

    dest_path.parent.mkdir(parents=True, exist_ok=True)
    part_path = dest_path.with_suffix(".part")

    chunk_size = total_size // num_threads
    ranges = []
    for i in range(num_threads):
        start = i * chunk_size
        end = total_size - 1 if i == num_threads - 1 else (i + 1) * chunk_size - 1
        ranges.append((start, end, i))

    def fetch_chunk(start, end, idx):
        headers = {"Range": f"bytes={start}-{end}"}
        res = requests.get(cdn_url, headers=headers, timeout=60)
        return idx, start, res.content

    parts_data = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=num_threads) as executor:
        futures = [executor.submit(fetch_chunk, s, e, idx) for s, e, idx in ranges]
        for f in concurrent.futures.as_completed(futures):
            idx, start, content = f.result()
            parts_data[idx] = content
            print(f"    -> Thread {idx+1}/{num_threads} completed ({len(content) / 1024 / 1024:.2f} MB)", flush=True)

    with open(part_path, "wb") as f:
        for idx in range(num_threads):
            f.write(parts_data[idx])

    part_path.replace(dest_path)
    print(f"  [Done] {dest_path.name} saved successfully.")


def sanitize_bbox(xc: float, yc: float, w: float, h: float) -> Tuple[float, float, float, float]:
    xc = max(0.0, min(1.0, xc))
    yc = max(0.0, min(1.0, yc))
    w = max(0.002, min(1.0, w))
    h = max(0.002, min(1.0, h))
    return round(xc, 6), round(yc, 6), round(w, 6), round(h, 6)


def main():
    print("=" * 60)
    print(" VisionX Phase 1: Ingesting COCO Classes (car, motorcycle, backpack, umbrella, book)")
    print("=" * 60)

    # Initialize folders
    for _, (cname, _) in TARGET_CLASSES.items():
        cdir = RAW_EXT_ROOT / cname
        (cdir / "images").mkdir(parents=True, exist_ok=True)
        (cdir / "labels").mkdir(parents=True, exist_ok=True)

    class_counts = {cname: 0 for _, (cname, _) in TARGET_CLASSES.items()}
    seen_hashes: Set[str] = set()

    # Track already existing files if script re-runs
    for _, (cname, _) in TARGET_CLASSES.items():
        img_dir = RAW_EXT_ROOT / cname / "images"
        for f in img_dir.glob("*.jpg"):
            class_counts[cname] += 1
            try:
                seen_hashes.add(hashlib.sha256(f.read_bytes()).hexdigest())
            except Exception:
                pass

    print(f"Existing counts: {class_counts}")

    for file_id, url in PARQUET_URLS:
        # Check if all reached target
        if all(cnt >= TARGET_MAX for cnt in class_counts.values()):
            print("All classes reached target quota!")
            break

        pq_file = CACHE_DIR / f"{file_id}.parquet"
        download_file_multithreaded(url, pq_file)

        print(f"\nProcessing {pq_file.name}...")
        df = pl.read_parquet(str(pq_file))
        print(f"Loaded {len(df)} rows from {pq_file.name}.")

        for row in df.iter_rows(named=True):
            if all(cnt >= TARGET_MAX for cnt in class_counts.values()):
                break

            objects = row.get("objects", {})
            cats = objects.get("category", [])
            bboxes = objects.get("bbox", [])
            if not cats or not bboxes or len(cats) != len(bboxes):
                continue

            # Check if image contains any target class we still need
            present_target_cats = {}
            for cat_id, bbox in zip(cats, bboxes):
                if cat_id in TARGET_CLASSES:
                    cname, vx_id = TARGET_CLASSES[cat_id]
                    if class_counts[cname] < TARGET_MAX:
                        if cname not in present_target_cats:
                            present_target_cats[cname] = []
                        present_target_cats[cname].append((vx_id, bbox))

            if not present_target_cats:
                continue

            # Read image
            img_data = row.get("image", {})
            img_bytes = img_data.get("bytes")
            if not img_bytes:
                continue

            img_hash = hashlib.sha256(img_bytes).hexdigest()
            if img_hash in seen_hashes:
                continue

            # Decode image dimensions
            img_arr = np.frombuffer(img_bytes, dtype=np.uint8)
            img = cv2.imdecode(img_arr, cv2.IMREAD_COLOR)
            if img is None:
                continue
            h_img, w_img = img.shape[:2]
            if w_img < 200 or h_img < 200:
                continue

            # Save per target class present in this image
            # For each target class that needs images, write into its own folder
            for cname, items in present_target_cats.items():
                if class_counts[cname] >= TARGET_MAX:
                    continue

                out_img_dir = RAW_EXT_ROOT / cname / "images"
                out_lbl_dir = RAW_EXT_ROOT / cname / "labels"

                idx = class_counts[cname]
                file_stem = f"{cname}_coco_{idx:05d}"
                out_img_path = out_img_dir / f"{file_stem}.jpg"
                out_lbl_path = out_lbl_dir / f"{file_stem}.txt"

                # Convert boxes
                yolo_lines = []
                for vx_id, bbox in items:
                    x_min, y_min, w, h = bbox
                    if w <= 0 or h <= 0:
                        continue
                    xc = (x_min + w / 2.0) / w_img
                    yc = (y_min + h / 2.0) / h_img
                    nw = w / w_img
                    nh = h / h_img
                    xc, yc, nw, nh = sanitize_bbox(xc, yc, nw, nh)
                    yolo_lines.append(f"{vx_id} {xc:.6f} {yc:.6f} {nw:.6f} {nh:.6f}")

                if not yolo_lines:
                    continue

                out_img_path.write_bytes(img_bytes)
                out_lbl_path.write_text("\n".join(yolo_lines) + "\n", encoding="utf-8")
                class_counts[cname] += 1

            seen_hashes.add(img_hash)

        print(f"Current progress: {class_counts}")

    print("\n" + "=" * 60)
    print(" EXTRACTION COMPLETE. RUNNING AUDIT...")
    print("=" * 60)

    # 1. Audit orphan images / labels
    total_imgs = 0
    total_lbls = 0
    audit_results = {}

    for _, (cname, vx_id) in TARGET_CLASSES.items():
        img_dir = RAW_EXT_ROOT / cname / "images"
        lbl_dir = RAW_EXT_ROOT / cname / "labels"

        imgs = {f.stem for f in img_dir.glob("*.jpg")}
        lbls = {f.stem for f in lbl_dir.glob("*.txt")}

        orphan_imgs = imgs - lbls
        orphan_lbls = lbls - imgs

        # Verify bbox sanity
        invalid_boxes = 0
        box_count = 0
        for lf in lbl_dir.glob("*.txt"):
            for line in lf.read_text(encoding="utf-8").splitlines():
                if not line.strip():
                    continue
                parts = line.split()
                cid = int(parts[0])
                coords = [float(p) for p in parts[1:5]]
                box_count += 1
                if cid != vx_id or any(c < 0 or c > 1 for c in coords):
                    invalid_boxes += 1

        audit_results[cname] = {
            "images": len(imgs),
            "labels": len(lbls),
            "boxes": box_count,
            "orphan_images": len(orphan_imgs),
            "orphan_labels": len(orphan_lbls),
            "invalid_boxes": invalid_boxes,
        }
        total_imgs += len(imgs)
        total_lbls += len(lbls)

    print(f"\nAudit Summary:")
    print(f"{'Class':12} | {'Images':7} | {'Labels':7} | {'Boxes':7} | {'Orphans':7} | {'Invalid':7}")
    print("-" * 60)
    for cname, res in audit_results.items():
        print(f"{cname:12} | {res['images']:7} | {res['labels']:7} | {res['boxes']:7} | {res['orphan_images'] + res['orphan_labels']:7} | {res['invalid_boxes']:7}")
    print("-" * 60)
    print(f"Total Images: {total_imgs}, Total Labels: {total_lbls}")

    # 2. Spot-check Rendering: sample 10 images per class with bboxes
    print("\nRendering 10 spot-check images per class into scratch/spotcheck_coco_round2/...")
    SPOTCHECK_DIR.mkdir(parents=True, exist_ok=True)

    CLASS_COLORS = {
        14: (230, 25, 75),    # Car: Red
        15: (60, 180, 75),    # Motorcycle: Green
        16: (255, 225, 25),   # Backpack: Yellow
        17: (0, 130, 200),    # Umbrella: Blue
        18: (245, 130, 48),   # Book: Orange
    }

    for _, (cname, vx_id) in TARGET_CLASSES.items():
        cls_spot_dir = SPOTCHECK_DIR / cname
        cls_spot_dir.mkdir(parents=True, exist_ok=True)

        img_dir = RAW_EXT_ROOT / cname / "images"
        lbl_dir = RAW_EXT_ROOT / cname / "labels"

        sample_imgs = sorted(list(img_dir.glob("*.jpg")))[:10]
        for img_path in sample_imgs:
            lbl_path = lbl_dir / f"{img_path.stem}.txt"
            if not lbl_path.exists():
                continue

            with Image.open(img_path).convert("RGB") as pil_img:
                draw = ImageDraw.Draw(pil_img)
                w_px, h_px = pil_img.size

                for line in lbl_path.read_text(encoding="utf-8").splitlines():
                    if not line.strip():
                        continue
                    parts = line.split()
                    cid = int(parts[0])
                    xc, yc, bw, bh = [float(p) for p in parts[1:5]]

                    x1 = (xc - bw / 2.0) * w_px
                    y1 = (yc - bh / 2.0) * h_px
                    x2 = (xc + bw / 2.0) * w_px
                    y2 = (yc + bh / 2.0) * h_px

                    color = CLASS_COLORS.get(cid, (255, 0, 0))
                    draw.rectangle([x1, y1, x2, y2], outline=color, width=3)
                    draw.text((x1 + 4, y1 + 4), f"{cname} (ID {cid})", fill=color)

                out_spot = cls_spot_dir / f"spot_{img_path.name}"
                pil_img.save(out_spot, quality=90)

    print("Spot checks rendered successfully.")
    print("PHASE 1 COMPLETE.")


if __name__ == "__main__":
    main()
