"""
VisionX Diagnostic Dataset Merge & Split Pipeline -> datasets/processed_v3_diag/
Controls for regression by excluding the newly added external co-occurrence images
for bottle, cup, and laptop, returning person/bottle/cup/laptop to V3 baseline counts,
while keeping keyboard additions and all 7 new V4 classes intact.
"""

import os
import shutil
import random
import yaml
from pathlib import Path
from collections import Counter, defaultdict

PROJECT_ROOT = Path(__file__).resolve().parent.parent
PROCESSED_DIAG = PROJECT_ROOT / "datasets" / "processed_v3_diag"
RAW_EXT = PROJECT_ROOT / "datasets" / "raw" / "external"
RAW_OWN = PROJECT_ROOT / "datasets" / "raw" / "own"
PROCESSED_V1 = PROJECT_ROOT / "datasets" / "processed"

ALL_CLASSES = {
    0: "person",
    1: "bottle",
    2: "cup",
    3: "laptop",
    4: "mouse",
    5: "keyboard",
    6: "cell_phone",
    7: "dompet",
    8: "kacamata",
    9: "sendal",
    10: "tisue",
    11: "uang_100rb",
    12: "cooler_hp",
    13: "kunci_cakram",
    14: "car",
    15: "motorcycle",
    16: "backpack",
    17: "umbrella",
    18: "book",
    19: "helm",
    20: "tanpa_helm",
}


def to_win_long_path(p: str) -> str:
    abs_p = os.path.abspath(p)
    if os.name == "nt" and not abs_p.startswith("\\\\?\\"):
        return "\\\\?\\" + abs_p
    return abs_p


def clean_dir(d: Path):
    long_d = to_win_long_path(str(d))
    if os.path.exists(long_d):
        for item in d.iterdir():
            target = to_win_long_path(str(item))
            if item.is_dir():
                shutil.rmtree(target)
            else:
                os.remove(target)
    d.mkdir(parents=True, exist_ok=True)


def split_items(items, train_ratio=0.8, val_ratio=0.1, seed=42):
    rng = random.Random(seed)
    shuffled = list(items)
    rng.shuffle(shuffled)
    n = len(shuffled)
    n_train = int(round(n * train_ratio))
    n_val = int(round(n * val_ratio))
    train_items = shuffled[:n_train]
    val_items = shuffled[n_train:n_train + n_val]
    test_items = shuffled[n_train + n_val:]
    return train_items, val_items, test_items


def sanitize_bbox(xc: float, yc: float, w: float, h: float):
    xc = max(0.0, min(1.0, xc))
    yc = max(0.0, min(1.0, yc))
    w = max(0.001, min(1.0, w))
    h = max(0.001, min(1.0, h))
    return xc, yc, w, h


def copy_image_and_sanitize_label(src_img: Path, src_lbl: Path, dst_img: Path, dst_lbl: Path):
    shutil.copy2(to_win_long_path(str(src_img)), to_win_long_path(str(dst_img)))
    
    sanitized_lines = []
    if src_lbl.exists():
        with open(to_win_long_path(str(src_lbl)), "r", encoding="utf-8") as f:
            for line in f:
                parts = line.strip().split()
                if len(parts) >= 5:
                    cid = int(parts[0])
                    xc, yc, w, h = [float(x) for x in parts[1:5]]
                    xc, yc, w, h = sanitize_bbox(xc, yc, w, h)
                    sanitized_lines.append(f"{cid} {xc:.6f} {yc:.6f} {w:.6f} {h:.6f}\n")
                    
    with open(to_win_long_path(str(dst_lbl)), "w", encoding="utf-8") as f:
        f.writelines(sanitized_lines)


def main():
    print("=" * 70, flush=True)
    print(" VisionX DIAGNOSTIC Merge & Split Pipeline -> datasets/processed_v3_diag/", flush=True)
    print("=" * 70, flush=True)

    # 1. Initialize destination directories
    for split in ["train", "val", "test"]:
        clean_dir(PROCESSED_DIAG / "images" / split)
        clean_dir(PROCESSED_DIAG / "labels" / split)

    # Remove any stray .cache files in labels root
    labels_root = PROCESSED_DIAG / "labels"
    for cache_f in labels_root.glob("*.cache"):
        os.remove(to_win_long_path(str(cache_f)))

    # ---------------------------------------------------------
    # PART A: COCO 2017 Subset (510 images)
    # ---------------------------------------------------------
    print("\n[Part A] Integrating COCO 2017 Subset (Preserving V1 test benchmark)...", flush=True)
    for split in ["train", "val", "test"]:
        src_img_dir = PROCESSED_V1 / "images" / split
        src_lbl_dir = PROCESSED_V1 / "labels" / split
        dest_img_dir = PROCESSED_DIAG / "images" / split
        dest_lbl_dir = PROCESSED_DIAG / "labels" / split

        count = 0
        for img_file in os.listdir(to_win_long_path(str(src_img_dir))):
            if not img_file.endswith(".jpg"):
                continue
            stem = Path(img_file).stem
            copy_image_and_sanitize_label(
                src_img_dir / img_file,
                src_lbl_dir / f"{stem}.txt",
                dest_img_dir / img_file,
                dest_lbl_dir / f"{stem}.txt"
            )
            count += 1
        print(f"  COCO {split:5}: {count} images", flush=True)

    # ---------------------------------------------------------
    # PART B: Own Real-World Captures (140 images)
    # ---------------------------------------------------------
    print("\n[Part B] Integrating Own Real-World Captures (140 images, 80/10/10 stratified)...", flush=True)
    own_img_dir = RAW_OWN / "images"
    own_lbl_dir = RAW_OWN / "labels"

    own_by_class = defaultdict(list)
    for img_file in sorted(os.listdir(to_win_long_path(str(own_img_dir)))):
        if not img_file.endswith(".jpg"):
            continue
        parts = img_file.split("_")
        cls_key = parts[2]
        own_by_class[cls_key].append(img_file)

    own_splits = {"train": [], "val": [], "test": []}
    for cls_key, files in sorted(own_by_class.items()):
        tr, vl, ts = split_items(files, train_ratio=0.8, val_ratio=0.1, seed=42)
        own_splits["train"].extend(tr)
        own_splits["val"].extend(vl)
        own_splits["test"].extend(ts)

    for split, files in own_splits.items():
        dest_img_dir = PROCESSED_DIAG / "images" / split
        dest_lbl_dir = PROCESSED_DIAG / "labels" / split
        for img_file in files:
            stem = Path(img_file).stem
            copy_image_and_sanitize_label(
                own_img_dir / img_file,
                own_lbl_dir / f"{stem}.txt",
                dest_img_dir / img_file,
                dest_lbl_dir / f"{stem}.txt"
            )
        print(f"  OWN {split:5}: {len(files)} images", flush=True)

    # ---------------------------------------------------------
    # PART C: External Standardized Datasets
    # EXCLUDING: bottle, cup, laptop
    # KEEPING: keyboard, cell_phone, mouse, dompet, kacamata, sendal, tisue, uang_100rb,
    #          car, motorcycle, backpack, umbrella, book, helm, tanpa_helm
    # ---------------------------------------------------------
    print("\n[Part C] Integrating External Classes (EXCLUDING bottle, cup, laptop)...", flush=True)
    ext_classes = [
        "keyboard",
        "cell_phone", "mouse", "dompet", "kacamata", "sendal", "tisue", "uang_100rb",
        "car", "motorcycle", "backpack", "umbrella", "book", "helm", "tanpa_helm"
    ]

    for cname in ext_classes:
        src_c_img_dir = RAW_EXT / cname / "images"
        src_c_lbl_dir = RAW_EXT / cname / "labels"

        c_files = sorted([f for f in os.listdir(to_win_long_path(str(src_c_img_dir))) if f.endswith((".jpg", ".png", ".jpeg"))])
        tr, vl, ts = split_items(c_files, train_ratio=0.8, val_ratio=0.1, seed=42)

        for split, files in [("train", tr), ("val", vl), ("test", ts)]:
            dest_img_dir = PROCESSED_DIAG / "images" / split
            dest_lbl_dir = PROCESSED_DIAG / "labels" / split
            for img_file in files:
                stem = Path(img_file).stem
                copy_image_and_sanitize_label(
                    src_c_img_dir / img_file,
                    src_c_lbl_dir / f"{stem}.txt",
                    dest_img_dir / img_file,
                    dest_lbl_dir / f"{stem}.txt"
                )

        print(f"  {cname:12}: total {len(c_files):5} -> train: {len(tr):4}, val: {len(vl):3}, test: {len(ts):3}", flush=True)

    # ---------------------------------------------------------
    # PART D: Write dataset.yaml
    # ---------------------------------------------------------
    dataset_yaml_data = {
        "path": "datasets/processed_v3_diag",
        "train": "images/train",
        "val": "images/val",
        "test": "images/test",
        "names": {i: name for i, name in ALL_CLASSES.items()},
    }

    yaml_out_path = PROCESSED_DIAG / "dataset.yaml"
    with open(to_win_long_path(str(yaml_out_path)), "w", encoding="utf-8") as f:
        yaml.dump(dataset_yaml_data, f, default_flow_style=False, sort_keys=False)

    print(f"\n[Part D] Written updated dataset.yaml for processed_v3_diag.", flush=True)

    # ---------------------------------------------------------
    # PART E: Comprehensive Audit & Per-Class Counting (21 Classes)
    # ---------------------------------------------------------
    print("\n" + "=" * 70, flush=True)
    print(" COMPREHENSIVE FINAL AUDIT FOR DIAGNOSTIC DATASET (21 CLASSES)", flush=True)
    print("=" * 70, flush=True)

    bbox_counts = {"train": Counter(), "val": Counter(), "test": Counter()}
    image_counts = {"train": Counter(), "val": Counter(), "test": Counter()}

    for split in ["train", "val", "test"]:
        lbl_dir = PROCESSED_DIAG / "labels" / split

        for lbl_file in os.listdir(to_win_long_path(str(lbl_dir))):
            if not lbl_file.endswith(".txt"):
                continue
            lbl_path = lbl_dir / lbl_file
            classes_in_image = set()
            with open(to_win_long_path(str(lbl_path)), "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    parts = line.split()
                    cid = int(parts[0])
                    bbox_counts[split][cid] += 1
                    classes_in_image.add(cid)
            for cid in classes_in_image:
                image_counts[split][cid] += 1

    total_images_train = len(os.listdir(to_win_long_path(str(PROCESSED_DIAG / "images" / "train"))))
    total_images_val = len(os.listdir(to_win_long_path(str(PROCESSED_DIAG / "images" / "val"))))
    total_images_test = len(os.listdir(to_win_long_path(str(PROCESSED_DIAG / "images" / "test"))))
    grand_total_images = total_images_train + total_images_val + total_images_test

    print(f"\nTotal Images Summary:", flush=True)
    print(f"  Train : {total_images_train:5} ({total_images_train / grand_total_images * 100:.2f}%)", flush=True)
    print(f"  Val   : {total_images_val:5} ({total_images_val / grand_total_images * 100:.2f}%)", flush=True)
    print(f"  Test  : {total_images_test:5} ({total_images_test / grand_total_images * 100:.2f}%)", flush=True)
    print(f"  Total : {grand_total_images:5} (100.00%)", flush=True)

    print("\n" + "-" * 88, flush=True)
    print(f"{'ID':2} | {'Class Name':14} | {'Train Imgs':10} | {'Val Imgs':8} | {'Test Imgs':9} | {'Total Imgs':10} | {'Total Boxes':11}", flush=True)
    print("-" * 88, flush=True)

    for cid in range(21):
        cname = ALL_CLASSES[cid]
        tr_im = image_counts["train"][cid]
        vl_im = image_counts["val"][cid]
        ts_im = image_counts["test"][cid]
        tot_im = tr_im + vl_im + ts_im
        tot_bx = (
            bbox_counts["train"][cid]
            + bbox_counts["val"][cid]
            + bbox_counts["test"][cid]
        )
        print(f"{cid:2} | {cname:14} | {tr_im:10} | {vl_im:8} | {ts_im:9} | {tot_im:10} | {tot_bx:11}", flush=True)

    print("-" * 88, flush=True)


if __name__ == "__main__":
    main()
