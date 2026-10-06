"""
VisionX:
1. Re-extract Mapua:
   - ALL 246 frames with No-Helmet (ID 3) taken WITHOUT stride -> datasets/raw/external/tanpa_helm/
   - Only-helm frames taken with stride 12 -> datasets/raw/external/helm/
2. Download 3 new helmet violation candidates to staging:
   - safrudin/helm-oby2v v4 (604 img)
   - shubham-pvcsg/helm-n0xvu v2 (629 img)
   - ilhamfazri3rd-gmail-com/helmet-violation-deteection v2 (202 img)
3. Render 15 spot-checks per candidate to scratch/spotcheck_tanpa_helm_hunt/{candidate_id}/
"""

import os
import shutil
import zipfile
import yaml
import hashlib
from pathlib import Path
from typing import Dict, List, Set, Tuple
from PIL import Image, ImageDraw, ImageFont
from roboflow import Roboflow

PROJECT_ROOT = Path(__file__).resolve().parent.parent
STAGING_ROOT = PROJECT_ROOT / "datasets" / "raw" / "external" / "_roboflow_staging"
RAW_EXT_ROOT = PROJECT_ROOT / "datasets" / "raw" / "external"
SPOTCHECK_HUNT_ROOT = PROJECT_ROOT / "scratch" / "spotcheck_tanpa_helm_hunt"

MAPUA_DIR = STAGING_ROOT / "mapua-university-n7qm7_motorcycle-helmet-7d2gr_v2"
TARGET_HELM_DIR = RAW_EXT_ROOT / "helm"
TARGET_NO_HELM_DIR = RAW_EXT_ROOT / "tanpa_helm"

API_KEY = "KVgl877alif7q5NbBuOc"

NEW_CANDIDATES = [
    {
        "id": "safrudin_helm-oby2v_v4",
        "workspace": "safrudin",
        "project": "helm-oby2v",
        "version": 4,
        "name": "Helm (Helm / No - Helm)",
        "license": "CC BY 4.0",
        "url": "https://universe.roboflow.com/safrudin/helm-oby2v/dataset/4"
    },
    {
        "id": "shubham-pvcsg_helm-n0xvu_v2",
        "workspace": "shubham-pvcsg",
        "project": "helm-n0xvu",
        "version": 2,
        "name": "Helm (With Helmet / Without Helmet)",
        "license": "Public Domain",
        "url": "https://universe.roboflow.com/shubham-pvcsg/helm-n0xvu/dataset/2"
    },
    {
        "id": "ilhamfazri3rd_helmet-violation-deteection_v2",
        "workspace": "ilhamfazri3rd-gmail-com",
        "project": "helmet-violation-deteection",
        "version": 2,
        "name": "Helmet Violation Detection (WithHelmet / Without Helmet)",
        "license": "MIT",
        "url": "https://universe.roboflow.com/ilhamfazri3rd-gmail-com/helmet-violation-deteection/dataset/2"
    }
]


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


def ensure_unzipped(staging_dir: Path):
    zip_path = staging_dir / "roboflow.zip"
    if zip_path.exists():
        print(f"  [Unzipping] {staging_dir.name}...")
        with zipfile.ZipFile(to_win_long_path(str(zip_path)), "r") as zf:
            for member in zf.infolist():
                target = staging_dir / member.filename
                target_str = to_win_long_path(str(target))
                if member.is_dir():
                    os.makedirs(target_str, exist_ok=True)
                else:
                    os.makedirs(os.path.dirname(target_str), exist_ok=True)
                    with zf.open(member) as src, open(target_str, "wb") as dst:
                        dst.write(src.read())
        print(f"  [Extracted] {staging_dir.name} successfully.")
        try:
            os.remove(to_win_long_path(str(zip_path)))
        except Exception:
            pass


# ============================================================
# LANGKAH 1: RE-EXTRACT MAPUA
# ============================================================
def reextract_mapua():
    print("=" * 70)
    print(" LANGKAH 1: RE-EXTRACT MAPUA (ALL NO-HELMET WITHOUT STRIDE)")
    print("=" * 70)

    # Clean existing tanpa_helm and helm_mapua files
    th_long = to_win_long_path(str(TARGET_NO_HELM_DIR))
    if os.path.exists(th_long):
        shutil.rmtree(th_long)
    (TARGET_NO_HELM_DIR / "images").mkdir(parents=True, exist_ok=True)
    (TARGET_NO_HELM_DIR / "labels").mkdir(parents=True, exist_ok=True)

    # Clean only helm_mapua files from helm/ (preserve helm_dpn files!)
    h_img_dir = TARGET_HELM_DIR / "images"
    h_lbl_dir = TARGET_HELM_DIR / "labels"
    for f in list(h_img_dir.glob("helm_mapua_*.jpg")):
        f.unlink()
    for f in list(h_lbl_dir.glob("helm_mapua_*.txt")):
        f.unlink()

    # Collect all items from mapua
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

    print(f"Total images found in Mapua: {len(all_items)}")

    # Classify into:
    # 1. Frames containing No-Helmet (ID 3): TAKE ALL, NO STRIDE
    # 2. Frames containing ONLY helm (ID 0 or 1): APPLY STRIDE 12
    no_helmet_frames = []
    only_helm_frames = []

    for img_p, lbl_p, fname in all_items:
        with open(to_win_long_path(lbl_p), "r", encoding="utf-8") as f:
            lines = f.read().splitlines()
        has_nh = False
        has_h = False
        for l in lines:
            parts = l.strip().split()
            if not parts:
                continue
            cid = int(parts[0])
            if cid == 3:
                has_nh = True
            elif cid in [0, 1]:
                has_h = True
        if has_nh:
            no_helmet_frames.append((img_p, lbl_p, fname))
        elif has_h:
            only_helm_frames.append((img_p, lbl_p, fname))

    print(f"Total raw frames with No-Helmet in Mapua : {len(no_helmet_frames)} (ALL will be taken!)")
    print(f"Total raw frames with Only-Helm in Mapua : {len(only_helm_frames)} (Stride 12 will be applied)")

    sampled_only_helm = only_helm_frames[::12]
    print(f"Sampled Only-Helm with Stride 12         : {len(sampled_only_helm)}")

    global_hashes: Set[str] = set()
    # Populate existing dpn hashes in helm/
    for img_f in h_img_dir.glob("helm_dpn_*.jpg"):
        try:
            global_hashes.add(hashlib.sha256(img_f.read_bytes()).hexdigest())
        except Exception:
            pass

    # 1. Process ALL No-Helmet frames -> datasets/raw/external/tanpa_helm/
    saved_th_count = 0
    th_box_nh = 0
    th_box_h = 0
    th_dups = 0

    for idx, (img_p, lbl_p, fname) in enumerate(no_helmet_frames):
        with open(to_win_long_path(img_p), "rb") as f:
            img_bytes = f.read()
        im_hash = hashlib.sha256(img_bytes).hexdigest()
        if im_hash in global_hashes:
            th_dups += 1
            continue

        valid_boxes = []
        with open(to_win_long_path(lbl_p), "r", encoding="utf-8") as lf:
            for line in lf:
                parts = line.strip().split()
                if len(parts) < 5:
                    continue
                orig_cid = int(parts[0])
                if orig_cid in [0, 1]:
                    target_id = 19
                elif orig_cid == 3:
                    target_id = 20
                else:
                    continue
                xc, yc, w, h = [float(p) for p in parts[1:5]]
                xc, yc, w, h = sanitize_bbox(xc, yc, w, h)
                valid_boxes.append((target_id, xc, yc, w, h))

        if not valid_boxes:
            continue

        dest_stem = f"tanpa_helm_mapua_{saved_th_count:05d}"
        dest_img = TARGET_NO_HELM_DIR / "images" / f"{dest_stem}.jpg"
        dest_lbl = TARGET_NO_HELM_DIR / "labels" / f"{dest_stem}.txt"

        dest_img.write_bytes(img_bytes)
        with open(to_win_long_path(str(dest_lbl)), "w", encoding="utf-8") as out_lf:
            for tid, xc, yc, w, h in valid_boxes:
                out_lf.write(f"{tid} {xc:.6f} {yc:.6f} {w:.6f} {h:.6f}\n")

        saved_th_count += 1
        th_box_nh += sum(1 for b in valid_boxes if b[0] == 20)
        th_box_h += sum(1 for b in valid_boxes if b[0] == 19)
        global_hashes.add(im_hash)

    # 2. Process Stride-12 Only-Helm frames -> datasets/raw/external/helm/
    saved_h_mapua_count = 0
    h_box_count = 0
    h_dups = 0

    for idx, (img_p, lbl_p, fname) in enumerate(sampled_only_helm):
        with open(to_win_long_path(img_p), "rb") as f:
            img_bytes = f.read()
        im_hash = hashlib.sha256(img_bytes).hexdigest()
        if im_hash in global_hashes:
            h_dups += 1
            continue

        valid_boxes = []
        with open(to_win_long_path(lbl_p), "r", encoding="utf-8") as lf:
            for line in lf:
                parts = line.strip().split()
                if len(parts) < 5:
                    continue
                orig_cid = int(parts[0])
                if orig_cid in [0, 1]:
                    target_id = 19
                else:
                    continue
                xc, yc, w, h = [float(p) for p in parts[1:5]]
                xc, yc, w, h = sanitize_bbox(xc, yc, w, h)
                valid_boxes.append((target_id, xc, yc, w, h))

        if not valid_boxes:
            continue

        dest_stem = f"helm_mapua_{saved_h_mapua_count:05d}"
        dest_img = TARGET_HELM_DIR / "images" / f"{dest_stem}.jpg"
        dest_lbl = TARGET_HELM_DIR / "labels" / f"{dest_stem}.txt"

        dest_img.write_bytes(img_bytes)
        with open(to_win_long_path(str(dest_lbl)), "w", encoding="utf-8") as out_lf:
            for tid, xc, yc, w, h in valid_boxes:
                out_lf.write(f"{tid} {xc:.6f} {yc:.6f} {w:.6f} {h:.6f}\n")

        saved_h_mapua_count += 1
        h_box_count += len(valid_boxes)
        global_hashes.add(im_hash)

    total_helm_imgs = len(list(h_img_dir.glob("*.jpg")))

    print("\n--- HASIL LANGKAH 1 (SETELAH RESCUE NO-HELMET MAPUA) ---")
    print(f"  tanpa_helm images (ALL rescued from Mapua) : {saved_th_count} images (naik dari 22)")
    print(f"  tanpa_helm boxes (ID 20)                   : {th_box_nh} boxes")
    print(f"  helm boxes di dalam frame tanpa_helm (ID 19): {th_box_h} boxes")
    print(f"  helm_mapua images (stride 12)               : {saved_h_mapua_count} images")
    print(f"  helm_dpn images (deteksi-plat-nomor)       : 1614 images")
    print(f"  TOTAL helm images di external/helm/         : {total_helm_imgs} images")
    print(f"  Rasio gambar helm : tanpa_helm              : {total_helm_imgs / saved_th_count:.2f} : 1  (Turun drastis dari 80:1)")


# ============================================================
# LANGKAH 2: DOWNLOAD DAN SPOT-CHECK KANDIDAT PELANGGARAN
# ============================================================
def download_and_spotcheck_violation_candidates():
    print("\n" + "=" * 70)
    print(" LANGKAH 2: DOWNLOAD & SPOT-CHECK 3 KANDIDAT PELANGGARAN HELM")
    print("=" * 70)

    rf = Roboflow(api_key=API_KEY)
    STAGING_ROOT.mkdir(parents=True, exist_ok=True)
    SPOTCHECK_HUNT_ROOT.mkdir(parents=True, exist_ok=True)

    cand_reports = []

    for cand in NEW_CANDIDATES:
        cand_id = cand["id"]
        target_dir = STAGING_ROOT / cand_id
        spot_dir = SPOTCHECK_HUNT_ROOT / cand_id
        spot_dir.mkdir(parents=True, exist_ok=True)

        if not (target_dir / "data.yaml").exists():
            print(f"\n[Downloading to Staging] {cand['workspace']}/{cand['project']} v{cand['version']}...")
            try:
                proj = rf.workspace(cand["workspace"]).project(cand["project"])
                version = proj.version(cand["version"])
                version.download("yolov8", location=str(target_dir), overwrite=True)
                ensure_unzipped(target_dir)
                print(f"  -> Downloaded successfully to {target_dir}")
            except Exception as e:
                print(f"  -> ERROR downloading {cand_id}: {e}")
                ensure_unzipped(target_dir)
        else:
            ensure_unzipped(target_dir)
            print(f"[Already Staged] {cand_id}")

        data_yaml_p = target_dir / "data.yaml"
        if not data_yaml_p.exists():
            print(f"WARN: No data.yaml for {cand_id}")
            continue

        with open(to_win_long_path(str(data_yaml_p)), "r", encoding="utf-8") as f:
            cfg = yaml.safe_load(f)

        raw_names = cfg.get("names", [])
        if isinstance(raw_names, dict):
            raw_names = [raw_names[k] for k in sorted(raw_names.keys())]

        # Scan images across splits
        all_imgs = []
        for split in ["train", "valid", "test"]:
            img_dir = target_dir / split / "images"
            lbl_dir = target_dir / split / "labels"
            if not os.path.exists(to_win_long_path(str(img_dir))):
                continue
            for img_name in sorted(os.listdir(to_win_long_path(str(img_dir)))):
                if any(img_name.lower().endswith(ext) for ext in [".jpg", ".jpeg", ".png", ".webp"]):
                    stem = os.path.splitext(img_name)[0]
                    lbl_path = str(lbl_dir / f"{stem}.txt")
                    img_path = str(img_dir / img_name)
                    if os.path.exists(to_win_long_path(lbl_path)):
                        all_imgs.append((img_path, lbl_path, split, img_name))

        print(f"\nCandidate: {cand['name']} ({cand_id})")
        print(f"  Total Annotated Images : {len(all_imgs)}")
        print(f"  Classes                : {raw_names}")

        # Count boxes per class in dataset
        class_box_counts = {c: 0 for c in raw_names}
        images_with_without_helmet = 0
        images_with_helmet = 0

        for img_p, lbl_p, _, _ in all_imgs:
            with open(to_win_long_path(lbl_p), "r", encoding="utf-8") as lf:
                lines = lf.readlines()
            has_nh = False
            has_h = False
            for line in lines:
                parts = line.strip().split()
                if len(parts) >= 5:
                    cidx = int(parts[0])
                    if cidx < len(raw_names):
                        cname = raw_names[cidx]
                        class_box_counts[cname] += 1
                        norm = cname.lower().replace(" ", "").replace("-", "").replace("_", "")
                        if "without" in norm or "no" in norm or "tidak" in norm or "tanpa" in norm:
                            has_nh = True
                        elif "with" in norm or "helm" in norm or "menggunakan" in norm or "pakai" in norm:
                            has_h = True
            if has_nh:
                images_with_without_helmet += 1
            if has_h:
                images_with_helmet += 1

        print(f"  Box distribution       : {class_box_counts}")
        print(f"  Images with No-Helmet  : {images_with_without_helmet}")
        print(f"  Images with Helmet     : {images_with_helmet}")

        # Render 15 spotchecks (preferring images containing No-Helmet)
        nh_imgs = [item for item in all_imgs if any(
            ("without" in raw_names[int(line.split()[0])].lower() or "no" in raw_names[int(line.split()[0])].lower() or "tidak" in raw_names[int(line.split()[0])].lower())
            for line in open(to_win_long_path(item[1]), 'r', encoding='utf-8').readlines() if line.strip() and int(line.split()[0]) < len(raw_names)
        )]

        sampled_spot = (nh_imgs + all_imgs)[:15]
        colors = [(255, 50, 50), (50, 205, 50), (30, 144, 255), (255, 165, 0)]

        for idx, (img_p, lbl_p, split, img_name) in enumerate(sampled_spot):
            try:
                with Image.open(to_win_long_path(img_p)).convert("RGB") as im:
                    w_px, h_px = im.size
                    draw = ImageDraw.Draw(im)

                    with open(to_win_long_path(lbl_p), "r", encoding="utf-8") as lf:
                        lines = lf.readlines()

                    for line in lines:
                        parts = line.strip().split()
                        if len(parts) >= 5:
                            cidx = int(parts[0])
                            cname = raw_names[cidx] if cidx < len(raw_names) else str(cidx)
                            xc, yc, w, h = [float(p) for p in parts[1:5]]
                            x1 = (xc - w / 2.0) * w_px
                            y1 = (yc - h / 2.0) * h_px
                            x2 = (xc + w / 2.0) * w_px
                            y2 = (yc + h / 2.0) * h_px

                            color = colors[cidx % len(colors)]
                            draw.rectangle([x1, y1, x2, y2], outline=color, width=3)
                            draw.text((x1 + 3, y1 + 3), f"{cname}", fill=color)

                    out_name = f"spotcheck_{idx+1:02d}.jpg"
                    im.save(to_win_long_path(str(spot_dir / out_name)), quality=90)
            except Exception as e:
                print(f"    Error rendering spotcheck {img_name}: {e}")

        print(f"  Spotchecks rendered    : {len(sampled_spot)} to {spot_dir}")

        cand_reports.append({
            "cand": cand,
            "total_images": len(all_imgs),
            "classes": raw_names,
            "box_counts": class_box_counts,
            "images_with_nh": images_with_without_helmet,
            "images_with_h": images_with_helmet,
            "spot_dir": str(spot_dir)
        })

    return cand_reports


def main():
    # 1. Langkah 1
    reextract_mapua()

    # 2. Langkah 2
    cand_reports = download_and_spotcheck_violation_candidates()

    print("\n" + "=" * 70)
    print(" ALL TASKS EXECUTED SUCCESSFULLY.")
    print("=" * 70)


if __name__ == "__main__":
    main()
