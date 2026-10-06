"""
VisionX Dataset Ingestion & Standardization Script (Enhanced)
Audits, normalizes, deduplicates, and standardizes Roboflow and Kaggle datasets.

Features:
- Windows Long-Path support (\\?\)
- Supports both standard YOLO bboxes (5 elements) and Polygon segmentations (>5 elements)
- Multi-class routing per dataset
- SHA256 image-level deduplication
- Resolution audit (min 200x200)
- Bounding box boundary sanity checks & normalization
"""

import os
import sys
import shutil
import hashlib
import yaml
from pathlib import Path
from typing import Dict, List, Tuple, Set, Optional, Any
from PIL import Image

PROJECT_ROOT = Path(__file__).resolve().parent.parent
EXTERNAL_RAW_ROOT = PROJECT_ROOT / "datasets" / "raw" / "external"
ROBOFLOW_STAGING = EXTERNAL_RAW_ROOT / "_roboflow_staging"
KAGGLE_STAGING = EXTERNAL_RAW_ROOT / "_kaggle_staging"

TARGET_CLASSES = {
    "cell_phone": 6,
    "mouse": 4,
    "dompet": 7,
    "kacamata": 8,
    "sendal": 9,
    "tisue": 10,
    "uang_100rb": 11,
}

ID_TO_CLASS_NAME = {v: k for k, v in TARGET_CLASSES.items()}

KEYWORD_MAPPING = {
    # cell_phone (6)
    "cell_phone": 6,
    "cellphone": 6,
    "cell phone": 6,
    "handphone": 6,
    "smartphone": 6,
    "mobile": 6,
    "phone": 6,

    # mouse (4)
    "mouse": 4,
    "computer-mouse": 4,
    "computer mouse": 4,
    "black-mouse": 4,
    "white-mouse": 4,
    "mice": 4,

    # dompet (7)
    "dompet": 7,
    "wallet": 7,

    # kacamata (8)
    "kacamata": 8,
    "kacamata-model": 8,
    "glasses": 8,
    "sunglass": 8,
    "sunglasses": 8,

    # sendal (9)
    "sendal": 9,
    "sandal": 9,
    "sandals": 9,
    "black sandal": 9,
    "blue sandal": 9,
    "brown sandal": 9,
    "green sandal": 9,
    "orangesandal": 9,
    "pink sandal": 9,
    "red sandal": 9,

    # tisue (10)
    "tissue": 10,
    "tisue": 10,

    # uang_100rb (11)
    "100.000 rupiah": 11,
    "seratus ribu": 11,
    "seratus ribu rupiah": 11,
    "100.000": 11,
    "100000": 11,
    "100rb": 11,
    "100 p": 11,
    "100": 11,
}


def to_win_long_path(p: str) -> str:
    abs_p = os.path.abspath(p)
    if os.name == "nt" and not abs_p.startswith("\\\\?\\"):
        return "\\\\?\\" + abs_p
    return abs_p


def get_image_hash(filepath: str) -> str:
    with open(to_win_long_path(filepath), "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def sanitize_bbox(xc: float, yc: float, w: float, h: float) -> Optional[Tuple[float, float, float, float]]:
    xc = max(0.0, min(1.0, xc))
    yc = max(0.0, min(1.0, yc))
    w = max(0.005, min(1.0, w))
    h = max(0.005, min(1.0, h))

    if w <= 0.005 or h <= 0.005 or (w * h) < 0.0001:
        return None
    return (round(xc, 6), round(yc, 6), round(w, 6), round(h, 6))


def parse_label_line(line: str, idx_to_target_id: Dict[int, int]) -> Optional[Tuple[int, float, float, float, float]]:
    parts = line.strip().split()
    if not parts:
        return None

    try:
        orig_cls = int(parts[0])
    except ValueError:
        return None

    if orig_cls not in idx_to_target_id:
        return None

    target_id = idx_to_target_id[orig_cls]

    # Standard 5-element YOLO bbox: class_id xc yc w h
    if len(parts) == 5:
        try:
            xc = float(parts[1])
            yc = float(parts[2])
            w = float(parts[3])
            h = float(parts[4])
        except ValueError:
            return None
    # Polygon segmentation: class_id x1 y1 x2 y2 ...
    elif len(parts) > 5 and len(parts) % 2 == 1:
        try:
            coords = [float(p) for p in parts[1:]]
            xs = coords[0::2]
            ys = coords[1::2]
            min_x, max_x = min(xs), max(xs)
            min_y, max_y = min(ys), max(ys)
            xc = (min_x + max_x) / 2.0
            yc = (min_y + max_y) / 2.0
            w = max_x - min_x
            h = max_y - min_y
        except ValueError:
            return None
    else:
        return None

    sanitized = sanitize_bbox(xc, yc, w, h)
    if sanitized is None:
        return None
    return (target_id, *sanitized)


def process_staged_dataset(
    dataset_dir: str,
    source_name: str,
    global_hashes: Set[str],
    stats: Dict[str, Any]
):
    dataset_path = Path(dataset_dir)
    data_yaml_path = dataset_path / "data.yaml"
    if not data_yaml_path.exists():
        return

    try:
        with open(to_win_long_path(str(data_yaml_path)), "r", encoding="utf-8") as f:
            data_cfg = yaml.safe_load(f)
    except Exception as e:
        print(f"    WARN: Failed to read data.yaml in {source_name}: {e}")
        return

    raw_names = data_cfg.get("names", [])
    if isinstance(raw_names, dict):
        raw_names = [raw_names[k] for k in sorted(raw_names.keys())]

    idx_to_target_id: Dict[int, int] = {}
    for orig_idx, cname in enumerate(raw_names):
        norm = str(cname).strip().lower()
        if norm in KEYWORD_MAPPING:
            idx_to_target_id[orig_idx] = KEYWORD_MAPPING[norm]

    if not idx_to_target_id:
        print(f"    [{source_name}] No matching classes in: {raw_names}")
        return

    mapped_info = [(raw_names[i], ID_TO_CLASS_NAME[tid], tid) for i, tid in idx_to_target_id.items()]
    print(f"    [{source_name}] Mapped classes: {mapped_info}")

    imported_per_class: Dict[str, int] = {c: 0 for c in TARGET_CLASSES.keys()}
    duplicate_count = 0
    rejected_res_count = 0

    for split in ["train", "valid", "test"]:
        split_img_dir = dataset_path / split / "images"
        split_lbl_dir = dataset_path / split / "labels"
        if not split_img_dir.exists():
            continue

        for img_file in os.listdir(to_win_long_path(str(split_img_dir))):
            if not img_file.lower().endswith((".jpg", ".jpeg", ".png", ".webp")):
                continue

            img_path = str(split_img_dir / img_file)
            stem = os.path.splitext(img_file)[0]
            lbl_path = str(split_lbl_dir / f"{stem}.txt")

            if not os.path.exists(to_win_long_path(lbl_path)):
                continue

            # 1. Audit resolution
            try:
                with Image.open(to_win_long_path(img_path)) as im:
                    w, h = im.size
                    if w < 200 or h < 200:
                        rejected_res_count += 1
                        continue
            except Exception:
                continue

            # 2. Audit duplicates
            try:
                im_hash = get_image_hash(img_path)
                if im_hash in global_hashes:
                    duplicate_count += 1
                    continue
            except Exception:
                continue

            # 3. Audit annotations & route boxes
            valid_boxes = []
            try:
                with open(to_win_long_path(lbl_path), "r", encoding="utf-8") as lf:
                    for line in lf:
                        parsed = parse_label_line(line, idx_to_target_id)
                        if parsed is not None:
                            valid_boxes.append(parsed)
            except Exception:
                continue

            if not valid_boxes:
                continue

            # Determine dominant target class for multi-class image routing
            class_counts = {}
            for tid, _, _, _, _ in valid_boxes:
                class_counts[tid] = class_counts.get(tid, 0) + 1
            primary_tid = max(class_counts, key=class_counts.get)
            target_cls_name = ID_TO_CLASS_NAME[primary_tid]

            out_class_dir = EXTERNAL_RAW_ROOT / target_cls_name
            out_images_dir = out_class_dir / "images"
            out_labels_dir = out_class_dir / "labels"
            out_images_dir.mkdir(parents=True, exist_ok=True)
            out_labels_dir.mkdir(parents=True, exist_ok=True)

            dest_stem = f"{target_cls_name}_{source_name}_{imported_per_class[target_cls_name]:05d}"
            dest_img = str(out_images_dir / f"{dest_stem}.jpg")
            dest_lbl = str(out_labels_dir / f"{dest_stem}.txt")

            shutil.copy2(to_win_long_path(img_path), to_win_long_path(dest_img))
            with open(to_win_long_path(dest_lbl), "w", encoding="utf-8") as out_lf:
                for tid, xc, yc, w, h in valid_boxes:
                    out_lf.write(f"{tid} {xc:.6f} {yc:.6f} {w:.6f} {h:.6f}\n")

            global_hashes.add(im_hash)
            imported_per_class[target_cls_name] += 1

    stats[source_name] = {
        "imported": imported_per_class,
        "duplicates": duplicate_count,
        "rejected_res": rejected_res_count,
    }
    total_imp = sum(imported_per_class.values())
    print(f"      -> Ingested {total_imp} images: {[(k, v) for k, v in imported_per_class.items() if v > 0]} (skipped {duplicate_count} dups)")


def process_kaggle_datasets(global_hashes: Set[str], stats: Dict[str, Any]):
    print("\n=== Processing Kaggle Datasets for uang_100rb ===")
    target_cls_name = "uang_100rb"
    target_id = TARGET_CLASSES[target_cls_name]

    out_class_dir = EXTERNAL_RAW_ROOT / target_cls_name
    out_images_dir = out_class_dir / "images"
    out_labels_dir = out_class_dir / "labels"
    out_images_dir.mkdir(parents=True, exist_ok=True)
    out_labels_dir.mkdir(parents=True, exist_ok=True)

    # 1. hashimatulzaria/data-uang-rupiah (folders: MONEY/100 and MONEY/100 P)
    hashim_dir = KAGGLE_STAGING / "hashimatulzaria" / "MONEY"
    hashim_imported = 0
    hashim_dups = 0
    if hashim_dir.exists():
        for sub in ["100", "100 P"]:
            folder = hashim_dir / sub
            if not folder.exists():
                continue
            for img_file in os.listdir(to_win_long_path(str(folder))):
                if not img_file.lower().endswith((".jpg", ".jpeg", ".png")):
                    continue
                img_path = str(folder / img_file)
                try:
                    with Image.open(to_win_long_path(img_path)) as im:
                        w, h = im.size
                        if w < 200 or h < 200:
                            continue
                except Exception:
                    continue

                im_hash = get_image_hash(img_path)
                if im_hash in global_hashes:
                    hashim_dups += 1
                    continue

                dest_stem = f"uang_100rb_kaggle_hashim_{hashim_imported:04d}"
                dest_img = str(out_images_dir / f"{dest_stem}.jpg")
                dest_lbl = str(out_labels_dir / f"{dest_stem}.txt")

                shutil.copy2(to_win_long_path(img_path), to_win_long_path(dest_img))
                with open(to_win_long_path(dest_lbl), "w", encoding="utf-8") as out_lf:
                    out_lf.write(f"{target_id} 0.500000 0.500000 0.880000 0.880000\n")

                global_hashes.add(im_hash)
                hashim_imported += 1

    stats["kaggle_hashimatulzaria"] = {
        "target": "uang_100rb",
        "imported": {"uang_100rb": hashim_imported},
        "duplicates": hashim_dups,
    }
    print(f"  -> Kaggle hashimatulzaria: {hashim_imported} images imported (filtered only 100/100P)")

    # 2. nurulalfiyyah/rupiah-banknotes (folders: 2016-100B, 2016-100D, 2022-100B, 2022-100D)
    nurul_dir = KAGGLE_STAGING / "nurulalfiyyah" / "rupiah-banknotes"
    nurul_imported = 0
    nurul_dups = 0
    if nurul_dir.exists():
        for sub in ["2016-100B", "2016-100D", "2022-100B", "2022-100D"]:
            folder = nurul_dir / sub
            if not folder.exists():
                continue
            for img_file in os.listdir(to_win_long_path(str(folder))):
                if not img_file.lower().endswith((".jpg", ".jpeg", ".png")):
                    continue
                img_path = str(folder / img_file)
                try:
                    with Image.open(to_win_long_path(img_path)) as im:
                        w, h = im.size
                        if w < 200 or h < 200:
                            continue
                except Exception:
                    continue

                im_hash = get_image_hash(img_path)
                if im_hash in global_hashes:
                    nurul_dups += 1
                    continue

                dest_stem = f"uang_100rb_kaggle_nurul_{nurul_imported:04d}"
                dest_img = str(out_images_dir / f"{dest_stem}.jpg")
                dest_lbl = str(out_labels_dir / f"{dest_stem}.txt")

                shutil.copy2(to_win_long_path(img_path), to_win_long_path(dest_img))
                with open(to_win_long_path(dest_lbl), "w", encoding="utf-8") as out_lf:
                    out_lf.write(f"{target_id} 0.500000 0.500000 0.900000 0.900000\n")

                global_hashes.add(im_hash)
                nurul_imported += 1

    stats["kaggle_nurulalfiyyah"] = {
        "target": "uang_100rb",
        "imported": {"uang_100rb": nurul_imported},
        "duplicates": nurul_dups,
    }
    print(f"  -> Kaggle nurulalfiyyah: {nurul_imported} images imported (filtered only 100B/100D)")


def main():
    print("==================================================")
    print(" VisionX External Dataset Standardization Pipeline")
    print("==================================================")

    # Clean existing external standardized outputs to re-standardize cleanly
    for cls_name in TARGET_CLASSES.keys():
        cls_dir = EXTERNAL_RAW_ROOT / cls_name
        if cls_dir.exists():
            shutil.rmtree(to_win_long_path(str(cls_dir)))
        (cls_dir / "images").mkdir(parents=True, exist_ok=True)
        (cls_dir / "labels").mkdir(parents=True, exist_ok=True)

    global_hashes: Set[str] = set()
    stats: Dict[str, Any] = {}

    # Scan and process all staged Roboflow datasets
    staged_dirs = sorted([d for d in os.listdir(str(ROBOFLOW_STAGING)) if os.path.isdir(str(ROBOFLOW_STAGING / d))])
    print(f"Found {len(staged_dirs)} staged Roboflow directories.")

    for d in staged_dirs:
        ds_path = str(ROBOFLOW_STAGING / d)
        print(f"\nProcessing Roboflow staged dataset: {d}...")
        process_staged_dataset(ds_path, d, global_hashes, stats)

    # Process Kaggle datasets
    process_kaggle_datasets(global_hashes, stats)

    # Summary
    print("\n================ FINAL STANDARDIZED DATASET TOTALS ================")
    class_totals: Dict[str, int] = {}
    for cls_name in TARGET_CLASSES.keys():
        cls_img_dir = EXTERNAL_RAW_ROOT / cls_name / "images"
        cnt = len(list(cls_img_dir.glob("*.jpg"))) if cls_img_dir.exists() else 0
        class_totals[cls_name] = cnt
        print(f"  Class {cls_name:12} (ID {TARGET_CLASSES[cls_name]:2}): {cnt:5} external images")

    print("\nTotal external images across all classes:", sum(class_totals.values()))


if __name__ == "__main__":
    main()
