"""
Standardize and Audit Final Helmet Datasets for VisionX:
- mapua-university (stride 12, Full-Faced + Half-Faced -> 19, No-Helmet -> 20, Invalid -> dropped)
- deteksi-plat-nomor (filter ONLY 'helm' -> 19, discard 'kepala' & 'pengendara')
- Clean up rejected staging (project-inem2, deep-learning-project)
- Spot-check 15 samples per source to scratch/spotcheck_helm_final/
- Output to datasets/raw/external/helm/ and datasets/raw/external/tanpa_helm/
"""

import os
import shutil
import hashlib
import yaml
from pathlib import Path
from typing import Dict, List, Set, Tuple
from PIL import Image, ImageDraw, ImageFont

PROJECT_ROOT = Path(__file__).resolve().parent.parent
STAGING_ROOT = PROJECT_ROOT / "datasets" / "raw" / "external" / "_roboflow_staging"
RAW_EXT_ROOT = PROJECT_ROOT / "datasets" / "raw" / "external"
SPOTCHECK_FINAL_ROOT = PROJECT_ROOT / "scratch" / "spotcheck_helm_final"

MAPUA_DIR = STAGING_ROOT / "mapua-university-n7qm7_motorcycle-helmet-7d2gr_v2"
DPN_DIR = STAGING_ROOT / "deteksi-plat-nomor-pengendara-tanpa-helm_pengendara-helm-kepala_v3"

TARGET_HELM_DIR = RAW_EXT_ROOT / "helm"
TARGET_NO_HELM_DIR = RAW_EXT_ROOT / "tanpa_helm"

COLORS = {
    19: (30, 200, 30),   # Helm: Green
    20: (230, 30, 30),   # Tanpa Helm: Red
}


def to_win_long_path(p: str) -> str:
    abs_p = os.path.abspath(p)
    if os.name == "nt" and not abs_p.startswith("\\\\?\\"):
        return "\\\\?\\" + abs_p
    return abs_p


def sanitize_bbox(xc: float, yc: float, w: float, h: float) -> Tuple[float, float, float, float]:
    xc = max(0.0, min(1.0, xc))
    yc = max(0.0, min(1.0, yc))
    w = max(0.002, min(1.0, w))
    h = max(0.002, min(1.0, h))
    return round(xc, 6), round(yc, 6), round(w, 6), round(h, 6)


def update_classes_yaml():
    yaml_paths = [
        PROJECT_ROOT / "datasets" / "metadata" / "classes.yaml",
        PROJECT_ROOT / "classes.yaml"
    ]
    for yp in yaml_paths:
        with open(to_win_long_path(str(yp)), "r", encoding="utf-8") as f:
            cfg = yaml.safe_load(f)
        names = cfg.get("names", {})
        if isinstance(names, list):
            names = {i: n for i, n in enumerate(names)}
        names[19] = "helm"
        names[20] = "tanpa_helm"
        cfg["names"] = names
        with open(to_win_long_path(str(yp)), "w", encoding="utf-8") as f:
            yaml.dump(cfg, f, default_flow_style=False, sort_keys=False)
        print(f"Updated {yp} with ID 19 (helm) & ID 20 (tanpa_helm).")


def remove_rejected_staging():
    rejected = [
        STAGING_ROOT / "project-inem2_pengendara-motor_v3",
        STAGING_ROOT / "deep-learning-project-fvusu_helmet-detection-j0oa1_v10"
    ]
    for r in rejected:
        r_long = to_win_long_path(str(r))
        if os.path.exists(r_long):
            print(f"Removing rejected staging: {r.name}...")
            shutil.rmtree(r_long)
            print(f"  -> Deleted {r.name}")


def process_mapua_university(global_hashes: Set[str]) -> Dict[str, any]:
    print("\n" + "=" * 60)
    print(" 1. PROCESSING MAPUA-UNIVERSITY (STRIDE 12)")
    print("=" * 60)

    # In mapua:
    # 0: Full-Faced -> 19 (helm)
    # 1: Half-Faced -> 19 (helm)
    # 2: Invalid -> Drop
    # 3: No-Helmet -> 20 (tanpa_helm)

    all_items = []
    for split in ["train", "valid", "test"]:
        s_img = MAPUA_DIR / split / "images"
        s_lbl = MAPUA_DIR / split / "labels"
        if not os.path.exists(to_win_long_path(str(s_img))):
            continue
        for fname in sorted(os.listdir(to_win_long_path(str(s_img)))):
            if fname.lower().endswith((".jpg", ".jpeg", ".png", ".webp")):
                stem = os.path.splitext(fname)[0]
                lbl_file = str(s_lbl / f"{stem}.txt")
                img_file = str(s_img / fname)
                if os.path.exists(to_win_long_path(lbl_file)):
                    all_items.append((img_file, lbl_file, fname))

    total_source = len(all_items)
    print(f"Total images found in Mapua: {total_source}")

    # Stride 12 sampling
    stride = 12
    sampled_items = all_items[::stride]
    print(f"Sampled with stride {stride}: {len(sampled_items)} images.")

    stats = {
        "sampled": len(sampled_items),
        "saved_helm_dir": 0,
        "saved_tanpa_helm_dir": 0,
        "box_helm_count": 0,
        "box_tanpa_helm_count": 0,
        "duplicates": 0,
        "processed_samples": []
    }

    for idx, (img_p, lbl_p, fname) in enumerate(sampled_items):
        with open(to_win_long_path(img_p), "rb") as f:
            img_bytes = f.read()
        im_hash = hashlib.sha256(img_bytes).hexdigest()
        if im_hash in global_hashes:
            stats["duplicates"] += 1
            continue

        valid_boxes = []
        with open(to_win_long_path(lbl_p), "r", encoding="utf-8") as lf:
            for line in lf:
                parts = line.strip().split()
                if len(parts) < 5:
                    continue
                orig_cid = int(parts[0])
                if orig_cid in [0, 1]:  # Full-Faced, Half-Faced
                    target_id = 19
                elif orig_cid == 3:     # No-Helmet
                    target_id = 20
                else:                   # Invalid or other
                    continue

                xc, yc, w, h = [float(p) for p in parts[1:5]]
                xc, yc, w, h = sanitize_bbox(xc, yc, w, h)
                valid_boxes.append((target_id, xc, yc, w, h))

        if not valid_boxes:
            continue

        cids_in_img = {b[0] for b in valid_boxes}
        helm_boxes = sum(1 for b in valid_boxes if b[0] == 19)
        no_helm_boxes = sum(1 for b in valid_boxes if b[0] == 20)

        stats["box_helm_count"] += helm_boxes
        stats["box_tanpa_helm_count"] += no_helm_boxes

        # Routing:
        # If contains tanpa_helm (20), save to tanpa_helm folder (capturing all rare without-helmet images)
        # If contains only helm (19), save to helm folder
        if 20 in cids_in_img:
            dest_folder = TARGET_NO_HELM_DIR
            prefix = "tanpa_helm_mapua"
            dest_count = stats["saved_tanpa_helm_dir"]
            stats["saved_tanpa_helm_dir"] += 1
        else:
            dest_folder = TARGET_HELM_DIR
            prefix = "helm_mapua"
            dest_count = stats["saved_helm_dir"]
            stats["saved_helm_dir"] += 1

        dest_stem = f"{prefix}_{dest_count:05d}"
        dest_img = dest_folder / "images" / f"{dest_stem}.jpg"
        dest_lbl = dest_folder / "labels" / f"{dest_stem}.txt"

        dest_img.parent.mkdir(parents=True, exist_ok=True)
        dest_lbl.parent.mkdir(parents=True, exist_ok=True)

        with open(to_win_long_path(str(dest_img)), "wb") as f:
            f.write(img_bytes)

        with open(to_win_long_path(str(dest_lbl)), "w", encoding="utf-8") as f:
            for tid, xc, yc, w, h in valid_boxes:
                f.write(f"{tid} {xc:.6f} {yc:.6f} {w:.6f} {h:.6f}\n")

        global_hashes.add(im_hash)
        stats["processed_samples"].append((str(dest_img), str(dest_lbl), valid_boxes))

    print(f"Mapua processing done:")
    print(f"  Images in helm/       : {stats['saved_helm_dir']}")
    print(f"  Images in tanpa_helm/ : {stats['saved_tanpa_helm_dir']}")
    print(f"  Total Images          : {stats['saved_helm_dir'] + stats['saved_tanpa_helm_dir']}")
    print(f"  Boxes helm (19)       : {stats['box_helm_count']}")
    print(f"  Boxes tanpa_helm (20) : {stats['box_tanpa_helm_count']}")
    return stats


def process_deteksi_plat_nomor(global_hashes: Set[str]) -> Dict[str, any]:
    print("\n" + "=" * 60)
    print(" 2. PROCESSING DETEKSI-PLAT-NOMOR (FILTER KEEP HANYA HELM -> 19)")
    print("=" * 60)

    # In deteksi-plat-nomor:
    # 0: helm -> 19
    # 1: kepala -> DISCARD
    # 2: pengendara -> DISCARD

    stats = {
        "scanned": 0,
        "saved_helm_dir": 0,
        "box_helm_count": 0,
        "dropped_no_helm": 0,
        "duplicates": 0,
        "processed_samples": []
    }

    for split in ["train", "valid", "test"]:
        s_img = DPN_DIR / split / "images"
        s_lbl = DPN_DIR / split / "labels"
        if not os.path.exists(to_win_long_path(str(s_lbl))):
            continue

        for lf_name in sorted(os.listdir(to_win_long_path(str(s_lbl)))):
            if not lf_name.endswith(".txt"):
                continue
            stats["scanned"] += 1

            lbl_p = str(s_lbl / lf_name)
            stem = os.path.splitext(lf_name)[0]
            img_p = str(s_img / f"{stem}.jpg")

            if not os.path.exists(to_win_long_path(img_p)):
                continue

            valid_boxes = []
            with open(to_win_long_path(lbl_p), "r", encoding="utf-8") as lf:
                for line in lf:
                    parts = line.strip().split()
                    if len(parts) < 5:
                        continue
                    orig_cid = int(parts[0])
                    # KEEP HANYA 0 ('helm') -> map to 19
                    if orig_cid == 0:
                        xc, yc, w, h = [float(p) for p in parts[1:5]]
                        xc, yc, w, h = sanitize_bbox(xc, yc, w, h)
                        valid_boxes.append((19, xc, yc, w, h))

            if not valid_boxes:
                stats["dropped_no_helm"] += 1
                continue

            with open(to_win_long_path(img_p), "rb") as f:
                img_bytes = f.read()
            im_hash = hashlib.sha256(img_bytes).hexdigest()
            if im_hash in global_hashes:
                stats["duplicates"] += 1
                continue

            dest_folder = TARGET_HELM_DIR
            dest_count = stats["saved_helm_dir"]
            dest_stem = f"helm_dpn_{dest_count:05d}"
            dest_img = dest_folder / "images" / f"{dest_stem}.jpg"
            dest_lbl = dest_folder / "labels" / f"{dest_stem}.txt"

            dest_img.parent.mkdir(parents=True, exist_ok=True)
            dest_lbl.parent.mkdir(parents=True, exist_ok=True)

            with open(to_win_long_path(str(dest_img)), "wb") as f:
                f.write(img_bytes)

            with open(to_win_long_path(str(dest_lbl)), "w", encoding="utf-8") as f:
                for tid, xc, yc, w, h in valid_boxes:
                    f.write(f"{tid} {xc:.6f} {yc:.6f} {w:.6f} {h:.6f}\n")

            global_hashes.add(im_hash)
            stats["saved_helm_dir"] += 1
            stats["box_helm_count"] += len(valid_boxes)
            stats["processed_samples"].append((str(dest_img), str(dest_lbl), valid_boxes))

    print(f"Deteksi-plat-nomor processing done:")
    print(f"  Scanned               : {stats['scanned']}")
    print(f"  Dropped (no helm box) : {stats['dropped_no_helm']}")
    print(f"  Duplicates skipped    : {stats['duplicates']}")
    print(f"  Saved to helm/        : {stats['saved_helm_dir']}")
    print(f"  Total helm (19) boxes : {stats['box_helm_count']}")
    return stats


def render_final_spotchecks(mapua_samples, dpn_samples):
    print("\n" + "=" * 60)
    print(" 3. RENDERING SPOTCHECKS (15 PER SOURCE) TO scratch/spotcheck_helm_final/")
    print("=" * 60)

    out_mapua = SPOTCHECK_FINAL_ROOT / "mapua_university"
    out_dpn = SPOTCHECK_FINAL_ROOT / "deteksi_plat_nomor"
    out_mapua.mkdir(parents=True, exist_ok=True)
    out_dpn.mkdir(parents=True, exist_ok=True)

    sources = [
        ("mapua_university", mapua_samples, out_mapua),
        ("deteksi_plat_nomor", dpn_samples, out_dpn),
    ]

    names_map = {19: "helm", 20: "tanpa_helm"}

    for src_name, samples, out_dir in sources:
        # Take 15 diverse samples
        step = max(1, len(samples) // 15)
        selected = samples[::step][:15]

        for idx, (img_p, lbl_p, boxes) in enumerate(selected):
            with Image.open(to_win_long_path(img_p)).convert("RGB") as im:
                w_px, h_px = im.size
                draw = ImageDraw.Draw(im)

                for tid, xc, yc, w, h in boxes:
                    x1 = (xc - w / 2.0) * w_px
                    y1 = (yc - h / 2.0) * h_px
                    x2 = (xc + w / 2.0) * w_px
                    y2 = (yc + h / 2.0) * h_px

                    color = COLORS.get(tid, (255, 255, 0))
                    cname = names_map.get(tid, str(tid))

                    draw.rectangle([x1, y1, x2, y2], outline=color, width=3)
                    draw.text((x1 + 3, y1 + 3), f"{cname} ({tid})", fill=color)

                out_file = out_dir / f"spotcheck_{idx+1:02d}.jpg"
                im.save(to_win_long_path(str(out_file)), quality=90)

        print(f"Rendered {len(selected)} spotchecks in {out_dir}")


def verify_no_orphan_files():
    print("\n" + "=" * 60)
    print(" 4. SANITY AUDIT: ORPHANS & BBOX INTEGRITY")
    print("=" * 60)

    for cname, target_dir in [("helm", TARGET_HELM_DIR), ("tanpa_helm", TARGET_NO_HELM_DIR)]:
        img_dir = target_dir / "images"
        lbl_dir = target_dir / "labels"

        imgs = {os.path.splitext(f)[0] for f in os.listdir(to_win_long_path(str(img_dir)))}
        lbls = {os.path.splitext(f)[0] for f in os.listdir(to_win_long_path(str(lbl_dir)))}

        orphans = (imgs - lbls) | (lbls - imgs)
        invalid_cids = set()
        box_count = 0

        for lf in os.listdir(to_win_long_path(str(lbl_dir))):
            with open(to_win_long_path(str(lbl_dir / lf)), "r", encoding="utf-8") as f:
                for line in f:
                    parts = line.strip().split()
                    if not parts:
                        continue
                    cid = int(parts[0])
                    box_count += 1
                    if cid not in [19, 20]:
                        invalid_cids.add(cid)

        print(f"Folder datasets/raw/external/{cname}/:")
        print(f"  Images       : {len(imgs)}")
        print(f"  Labels       : {len(lbls)}")
        print(f"  Orphans      : {len(orphans)}")
        print(f"  Total Boxes  : {box_count}")
        print(f"  Invalid CIDs : {invalid_cids} (Expected: None / empty)")


def main():
    print("=" * 70)
    print(" VisionX: Filter & Standardize Helmet Sources (Mapua + DPN)")
    print("=" * 70)

    # 1. Update classes.yaml
    update_classes_yaml()

    # 2. Delete rejected staging folders
    remove_rejected_staging()

    # Clean existing destination folders for clean ingestion
    for d in [TARGET_HELM_DIR, TARGET_NO_HELM_DIR]:
        d_long = to_win_long_path(str(d))
        if os.path.exists(d_long):
            shutil.rmtree(d_long)
        (d / "images").mkdir(parents=True, exist_ok=True)
        (d / "labels").mkdir(parents=True, exist_ok=True)

    global_hashes: Set[str] = set()

    # 3. Process Mapua
    mapua_stats = process_mapua_university(global_hashes)

    # 4. Process Deteksi Plat Nomor
    dpn_stats = process_deteksi_plat_nomor(global_hashes)

    # 5. Render final spotchecks
    render_final_spotchecks(mapua_stats["processed_samples"], dpn_stats["processed_samples"])

    # 6. Verify orphans
    verify_no_orphan_files()

    print("\n" + "=" * 70)
    print(" ALL TASKS COMPLETED SUCCESSFULLY.")
    print("=" * 70)


if __name__ == "__main__":
    main()
