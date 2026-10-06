"""
VisionX Final Dataset Merge & Split Pipeline (V2.0)
Merges:
1. COCO 2017 subset (510 images) -> 408 train, 51 val, 51 test (preserves V1 test benchmark)
2. Own real-world captures (140 images) -> 112 train, 14 val, 14 test (stratified 80/10/10)
3. External standardized datasets (8,166 images across 7 classes):
   - cell_phone (620) -> 496 train, 62 val, 62 test
   - mouse (929) -> 743 train, 93 val, 93 test
   - dompet (896) -> 716 train, 90 val, 90 test
   - kacamata (1,131) -> 904 train, 113 val, 114 test
   - sendal (1,169) -> 935 train, 117 val, 117 test
   - tisue (585) -> 468 train, 58 val, 59 test
   - uang_100rb (2,836) -> 2,268 train, 284 val, 284 test
4. Handles classes 12 (cooler_hp) and 13 (kunci_cakram) with 0 samples.
Total: 8,816 images -> 7,050 train (80.0%), 882 val (10.0%), 884 test (10.0%)
"""

import os
import shutil
import random
import yaml
from pathlib import Path
from collections import Counter, defaultdict

PROJECT_ROOT = Path(__file__).resolve().parent.parent
PROCESSED_V2 = PROJECT_ROOT / "datasets" / "processed_v2"
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
}


def to_win_long_path(p: str) -> str:
    abs_p = os.path.abspath(p)
    if os.name == "nt" and not abs_p.startswith("\\\\?\\"):
        return "\\\\?\\" + abs_p
    return abs_p


def clean_dir(d: Path):
    if d.exists():
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


def main():
    print("=" * 60)
    print(" VisionX Final Dataset Merge & Split Pipeline (80/10/10)")
    print("=" * 60)

    # 1. Initialize destination directories
    for split in ["train", "val", "test"]:
        clean_dir(PROCESSED_V2 / "images" / split)
        clean_dir(PROCESSED_V2 / "labels" / split)

    # Remove any stray .cache files in labels root
    labels_root = PROCESSED_V2 / "labels"
    for cache_f in labels_root.glob("*.cache"):
        os.remove(to_win_long_path(str(cache_f)))

    # Track merged files
    split_manifest = {"train": [], "val": [], "test": []}

    # ---------------------------------------------------------
    # PART A: COCO 2017 Subset (510 images)
    # ---------------------------------------------------------
    print("\n[Part A] Integrating COCO 2017 Subset (Preserving V1 test benchmark)...")
    for split in ["train", "val", "test"]:
        src_img_dir = PROCESSED_V1 / "images" / split
        src_lbl_dir = PROCESSED_V1 / "labels" / split
        dest_img_dir = PROCESSED_V2 / "images" / split
        dest_lbl_dir = PROCESSED_V2 / "labels" / split

        for img_file in os.listdir(to_win_long_path(str(src_img_dir))):
            if not img_file.endswith(".jpg"):
                continue
            stem = os.path.splitext(img_file)[0]
            lbl_file = f"{stem}.txt"

            shutil.copy2(
                to_win_long_path(str(src_img_dir / img_file)),
                to_win_long_path(str(dest_img_dir / img_file))
            )
            shutil.copy2(
                to_win_long_path(str(src_lbl_dir / lbl_file)),
                to_win_long_path(str(dest_lbl_dir / lbl_file))
            )
            split_manifest[split].append(("COCO", img_file, str(dest_lbl_dir / lbl_file)))

        print(f"  COCO {split:5}: {len(os.listdir(to_win_long_path(str(dest_img_dir))))} images")

    # ---------------------------------------------------------
    # PART B: Own Real-World Captures (140 images)
    # Stratified by primary class (person, bottle, cup, laptop, mouse, keyboard, cell_phone)
    # ---------------------------------------------------------
    print("\n[Part B] Integrating Own Real-World Captures (140 images, 80/10/10 stratified)...")
    own_img_dir = RAW_OWN / "images"
    own_lbl_dir = RAW_OWN / "labels"

    # Group own files by prefix class
    own_by_class = defaultdict(list)
    for img_file in sorted(os.listdir(to_win_long_path(str(own_img_dir)))):
        if not img_file.endswith(".jpg"):
            continue
        parts = img_file.split("_")
        # format: own_v2_<cls>_001.jpg
        cls_key = parts[2]
        own_by_class[cls_key].append(img_file)

    own_splits = {"train": [], "val": [], "test": []}
    for cls_key, files in sorted(own_by_class.items()):
        tr, vl, ts = split_items(files, train_ratio=0.8, val_ratio=0.1, seed=42)
        own_splits["train"].extend(tr)
        own_splits["val"].extend(vl)
        own_splits["test"].extend(ts)

    for split, files in own_splits.items():
        dest_img_dir = PROCESSED_V2 / "images" / split
        dest_lbl_dir = PROCESSED_V2 / "labels" / split
        for img_file in files:
            stem = os.path.splitext(img_file)[0]
            lbl_file = f"{stem}.txt"
            shutil.copy2(
                to_win_long_path(str(own_img_dir / img_file)),
                to_win_long_path(str(dest_img_dir / img_file))
            )
            shutil.copy2(
                to_win_long_path(str(own_lbl_dir / lbl_file)),
                to_win_long_path(str(dest_lbl_dir / lbl_file))
            )
            split_manifest[split].append(("OWN", img_file, str(dest_lbl_dir / lbl_file)))
        print(f"  OWN {split:5}: {len(files)} images")

    # ---------------------------------------------------------
    # PART C: External Standardized Datasets (8,166 images across 7 classes)
    # ---------------------------------------------------------
    print("\n[Part C] Integrating External Datasets (8,166 images, 80/10/10 split)...")
    ext_classes = ["cell_phone", "mouse", "dompet", "kacamata", "sendal", "tisue", "uang_100rb"]

    for cname in ext_classes:
        src_c_img_dir = RAW_EXT / cname / "images"
        src_c_lbl_dir = RAW_EXT / cname / "labels"

        c_files = sorted([f for f in os.listdir(to_win_long_path(str(src_c_img_dir))) if f.endswith(".jpg")])
        tr, vl, ts = split_items(c_files, train_ratio=0.8, val_ratio=0.1, seed=42)

        for split, files in [("train", tr), ("val", vl), ("test", ts)]:
            dest_img_dir = PROCESSED_V2 / "images" / split
            dest_lbl_dir = PROCESSED_V2 / "labels" / split
            for img_file in files:
                stem = os.path.splitext(img_file)[0]
                lbl_file = f"{stem}.txt"
                shutil.copy2(
                    to_win_long_path(str(src_c_img_dir / img_file)),
                    to_win_long_path(str(dest_img_dir / img_file))
                )
                shutil.copy2(
                    to_win_long_path(str(src_c_lbl_dir / lbl_file)),
                    to_win_long_path(str(dest_lbl_dir / lbl_file))
                )
                split_manifest[split].append((cname, img_file, str(dest_lbl_dir / lbl_file)))

        print(f"  {cname:12}: total {len(c_files):5} -> train: {len(tr):4}, val: {len(vl):3}, test: {len(ts):3}")

    # ---------------------------------------------------------
    # PART D: Write dataset.yaml
    # ---------------------------------------------------------
    dataset_yaml_data = {
        "path": "C:/Users/advan/Documents/VisionX/datasets/processed_v2",
        "train": "images/train",
        "val": "images/val",
        "test": "images/test",
        "names": {i: name for i, name in ALL_CLASSES.items()},
    }

    yaml_out_path = PROCESSED_V2 / "dataset.yaml"
    with open(to_win_long_path(str(yaml_out_path)), "w", encoding="utf-8") as f:
        yaml.dump(dataset_yaml_data, f, default_flow_style=False, sort_keys=False)

    print(f"\n[Part D] Written updated dataset.yaml with all 14 classes (IDs 0-13).")

    # ---------------------------------------------------------
    # PART E: Comprehensive Audit & Per-Class Counting
    # ---------------------------------------------------------
    print("\n" + "=" * 60)
    print(" COMPREHENSIVE FINAL AUDIT & DATASET VERIFICATION")
    print("=" * 60)

    # Count bboxes and image appearances per class across splits
    bbox_counts = {"train": Counter(), "val": Counter(), "test": Counter()}
    image_counts = {"train": Counter(), "val": Counter(), "test": Counter()}

    for split in ["train", "val", "test"]:
        lbl_dir = PROCESSED_V2 / "labels" / split
        img_dir = PROCESSED_V2 / "images" / split

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

    total_images_train = len(os.listdir(to_win_long_path(str(PROCESSED_V2 / "images" / "train"))))
    total_images_val = len(os.listdir(to_win_long_path(str(PROCESSED_V2 / "images" / "val"))))
    total_images_test = len(os.listdir(to_win_long_path(str(PROCESSED_V2 / "images" / "test"))))
    grand_total_images = total_images_train + total_images_val + total_images_test

    print(f"\nTotal Images Summary:")
    print(f"  Train : {total_images_train:5} ({total_images_train / grand_total_images * 100:.2f}%)")
    print(f"  Val   : {total_images_val:5} ({total_images_val / grand_total_images * 100:.2f}%)")
    print(f"  Test  : {total_images_test:5} ({total_images_test / grand_total_images * 100:.2f}%)")
    print(f"  Total : {grand_total_images:5} (100.00%)")

    print("\n" + "-" * 75)
    print(f"{'ID':2} | {'Class Name':14} | {'Train Imgs':10} | {'Val Imgs':8} | {'Test Imgs':9} | {'Total Imgs':10} | {'Total Boxes':11}")
    print("-" * 75)

    for cid in range(14):
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
        print(f"{cid:2} | {cname:14} | {tr_im:10} | {vl_im:8} | {ts_im:9} | {tot_im:10} | {tot_bx:11}")

    print("-" * 75)


if __name__ == "__main__":
    main()
