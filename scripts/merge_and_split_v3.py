"""
VisionX Merge & Split Pipeline for V4 Model (21 Classes) -> datasets/processed_v3/
Integrates:
1. COCO 2017 subset (510 images) -> 408 train, 51 val, 51 test
2. Own real-world captures (140 images) -> 112 train, 14 val, 14 test (stratified 80/10/10)
3. 14 External standardized classes:
   - cell_phone (620)
   - mouse (929)
   - dompet (896)
   - kacamata (1,131)
   - sendal (1,169)
   - tisue (585)
   - uang_100rb (2,836)
   - car (800)
   - motorcycle (358)
   - backpack (562)
   - umbrella (416)
   - book (562)
   - helm (1,782)
   - tanpa_helm (595)
4. Classes 12 (cooler_hp) and 13 (kunci_cakram) preserved with 0 samples.
Total: ~13,891 images -> 80% train, 10% val, 10% test.
"""

import os
import shutil
import random
import yaml
from pathlib import Path
from collections import Counter, defaultdict

PROJECT_ROOT = Path(__file__).resolve().parent.parent
PROCESSED_V3 = PROJECT_ROOT / "datasets" / "processed_v3"
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
    print("=" * 70)
    print(" VisionX V4 (21 Classes) Merge & Split Pipeline -> datasets/processed_v3/")
    print("=" * 70)

    # 1. Initialize destination directories
    for split in ["train", "val", "test"]:
        clean_dir(PROCESSED_V3 / "images" / split)
        clean_dir(PROCESSED_V3 / "labels" / split)

    # Remove any stray .cache files in labels root
    labels_root = PROCESSED_V3 / "labels"
    for cache_f in labels_root.glob("*.cache"):
        os.remove(to_win_long_path(str(cache_f)))

    # ---------------------------------------------------------
    # PART A: COCO 2017 Subset (510 images)
    # ---------------------------------------------------------
    print("\n[Part A] Integrating COCO 2017 Subset (Preserving V1 test benchmark)...")
    for split in ["train", "val", "test"]:
        src_img_dir = PROCESSED_V1 / "images" / split
        src_lbl_dir = PROCESSED_V1 / "labels" / split
        dest_img_dir = PROCESSED_V3 / "images" / split
        dest_lbl_dir = PROCESSED_V3 / "labels" / split

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
        print(f"  COCO {split:5}: {count} images")

    # ---------------------------------------------------------
    # PART B: Own Real-World Captures (140 images)
    # ---------------------------------------------------------
    print("\n[Part B] Integrating Own Real-World Captures (140 images, 80/10/10 stratified)...")
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
        dest_img_dir = PROCESSED_V3 / "images" / split
        dest_lbl_dir = PROCESSED_V3 / "labels" / split
        for img_file in files:
            stem = Path(img_file).stem
            copy_image_and_sanitize_label(
                own_img_dir / img_file,
                own_lbl_dir / f"{stem}.txt",
                dest_img_dir / img_file,
                dest_lbl_dir / f"{stem}.txt"
            )
        print(f"  OWN {split:5}: {len(files)} images")

    # ---------------------------------------------------------
    # PART C: External Standardized Datasets (18 classes)
    # ---------------------------------------------------------
    print("\n[Part C] Integrating 18 External Classes (80/10/10 split)...")
    ext_classes = [
        "keyboard", "laptop", "bottle", "cup",
        "cell_phone", "mouse", "dompet", "kacamata", "sendal", "tisue", "uang_100rb",
        "car", "motorcycle", "backpack", "umbrella", "book", "helm", "tanpa_helm"
    ]

    for cname in ext_classes:
        src_c_img_dir = RAW_EXT / cname / "images"
        src_c_lbl_dir = RAW_EXT / cname / "labels"

        c_files = sorted([f for f in os.listdir(to_win_long_path(str(src_c_img_dir))) if f.endswith((".jpg", ".png", ".jpeg"))])
        tr, vl, ts = split_items(c_files, train_ratio=0.8, val_ratio=0.1, seed=42)

        for split, files in [("train", tr), ("val", vl), ("test", ts)]:
            dest_img_dir = PROCESSED_V3 / "images" / split
            dest_lbl_dir = PROCESSED_V3 / "labels" / split
            for img_file in files:
                stem = Path(img_file).stem
                copy_image_and_sanitize_label(
                    src_c_img_dir / img_file,
                    src_c_lbl_dir / f"{stem}.txt",
                    dest_img_dir / img_file,
                    dest_lbl_dir / f"{stem}.txt"
                )

        print(f"  {cname:12}: total {len(c_files):5} -> train: {len(tr):4}, val: {len(vl):3}, test: {len(ts):3}")

    # ---------------------------------------------------------
    # PART D: Write dataset.yaml
    # ---------------------------------------------------------
    dataset_yaml_data = {
        "path": "datasets/processed_v3",
        "train": "images/train",
        "val": "images/val",
        "test": "images/test",
        "names": {i: name for i, name in ALL_CLASSES.items()},
    }

    yaml_out_path = PROCESSED_V3 / "dataset.yaml"
    with open(to_win_long_path(str(yaml_out_path)), "w", encoding="utf-8") as f:
        yaml.dump(dataset_yaml_data, f, default_flow_style=False, sort_keys=False)

    print(f"\n[Part D] Written updated dataset.yaml with all 21 classes (IDs 0-20).")

    # ---------------------------------------------------------
    # PART E: Comprehensive Audit & Per-Class Counting (21 Classes)
    # ---------------------------------------------------------
    print("\n" + "=" * 70)
    print(" COMPREHENSIVE FINAL AUDIT & DATASET VERIFICATION (21 CLASSES)")
    print("=" * 70)

    bbox_counts = {"train": Counter(), "val": Counter(), "test": Counter()}
    image_counts = {"train": Counter(), "val": Counter(), "test": Counter()}

    for split in ["train", "val", "test"]:
        lbl_dir = PROCESSED_V3 / "labels" / split

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

    total_images_train = len(os.listdir(to_win_long_path(str(PROCESSED_V3 / "images" / "train"))))
    total_images_val = len(os.listdir(to_win_long_path(str(PROCESSED_V3 / "images" / "val"))))
    total_images_test = len(os.listdir(to_win_long_path(str(PROCESSED_V3 / "images" / "test"))))
    grand_total_images = total_images_train + total_images_val + total_images_test

    print(f"\nTotal Images Summary:")
    print(f"  Train : {total_images_train:5} ({total_images_train / grand_total_images * 100:.2f}%)")
    print(f"  Val   : {total_images_val:5} ({total_images_val / grand_total_images * 100:.2f}%)")
    print(f"  Test  : {total_images_test:5} ({total_images_test / grand_total_images * 100:.2f}%)")
    print(f"  Total : {grand_total_images:5} (100.00%)")

    print("\n" + "-" * 88)
    print(f"{'ID':2} | {'Class Name':14} | {'Train Imgs':10} | {'Val Imgs':8} | {'Test Imgs':9} | {'Total Imgs':10} | {'Total Boxes':11}")
    print("-" * 88)

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
        print(f"{cid:2} | {cname:14} | {tr_im:10} | {vl_im:8} | {ts_im:9} | {tot_im:10} | {tot_bx:11}")

    print("-" * 88)


if __name__ == "__main__":
    main()
