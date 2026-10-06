"""
Download and Spot-Check Motorcycle Helmet Candidates from Roboflow Universe to Staging.
DOES NOT STANDARDIZE OR MERGE.
"""

import os
import shutil
import zipfile
import yaml
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
from roboflow import Roboflow

PROJECT_ROOT = Path(__file__).resolve().parent.parent
STAGING_ROOT = PROJECT_ROOT / "datasets" / "raw" / "external" / "_roboflow_staging"
SPOTCHECK_HELM_ROOT = PROJECT_ROOT / "scratch" / "spotcheck_helm"
API_KEY = "KVgl877alif7q5NbBuOc"

CANDIDATES = [
    {
        "id": "project-inem2_pengendara-motor_v3",
        "workspace": "project-inem2",
        "project": "pengendara-motor",
        "version": 3,
        "name": "Pengendara Motor (Helm / NoHelm)",
        "license": "CC BY 4.0",
        "url": "https://universe.roboflow.com/project-inem2/pengendara-motor/dataset/3"
    },
    {
        "id": "deteksi-plat-nomor-pengendara-tanpa-helm_pengendara-helm-kepala_v3",
        "workspace": "deteksi-plat-nomor-pengendara-tanpa-helm",
        "project": "pengendara-helm-kepala",
        "version": 3,
        "name": "Pengendara - Helm - Kepala",
        "license": "CC BY 4.0",
        "url": "https://universe.roboflow.com/deteksi-plat-nomor-pengendara-tanpa-helm/pengendara-helm-kepala/dataset/3"
    },
    {
        "id": "deep-learning-project-fvusu_helmet-detection-j0oa1_v10",
        "workspace": "deep-learning-project-fvusu",
        "project": "helmet-detection-j0oa1",
        "version": 10,
        "name": "Helmet Detection (Pakai Helm / Tanpa Helm)",
        "license": "CC BY 4.0",
        "url": "https://universe.roboflow.com/deep-learning-project-fvusu/helmet-detection-j0oa1/dataset/10"
    },
    {
        "id": "mapua-university-n7qm7_motorcycle-helmet-7d2gr_v2",
        "workspace": "mapua-university-n7qm7",
        "project": "motorcycle-helmet-7d2gr",
        "version": 2,
        "name": "Motorcycle Helmet (Full-Faced / Half-Faced / No-Helmet)",
        "license": "CC BY 4.0",
        "url": "https://universe.roboflow.com/mapua-university-n7qm7/motorcycle-helmet-7d2gr/dataset/2"
    }
]

COLORS = [
    (255, 50, 50),
    (50, 205, 50),
    (30, 144, 255),
    (255, 165, 0),
    (148, 0, 211),
    (255, 215, 0)
]


def to_win_long_path(p: str) -> str:
    abs_p = os.path.abspath(p)
    if os.name == "nt" and not abs_p.startswith("\\\\?\\"):
        return "\\\\?\\" + abs_p
    return abs_p


def ensure_unzipped(staging_dir: Path):
    zip_path = staging_dir / "roboflow.zip"
    if zip_path.exists():
        print(f"  [Unzipping with long path support] {staging_dir.name}...")
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


def download_candidates():
    rf = Roboflow(api_key=API_KEY)
    STAGING_ROOT.mkdir(parents=True, exist_ok=True)

    for cand in CANDIDATES:
        cand_id = cand["id"]
        target_dir = STAGING_ROOT / cand_id
        if (target_dir / "train" / "images").exists() or (target_dir / "train").exists():
            ensure_unzipped(target_dir)
            print(f"[Ready in Staging] {cand_id}")
            continue

        print(f"\n[Downloading to Staging] {cand['workspace']}/{cand['project']} v{cand['version']}...")
        try:
            proj = rf.workspace(cand["workspace"]).project(cand["project"])
            version = proj.version(cand["version"])
            version.download("yolov8", location=str(target_dir), overwrite=True)
            ensure_unzipped(target_dir)
            print(f"  -> Successfully downloaded to {target_dir}")
        except Exception as e:
            print(f"  -> ERROR downloading {cand_id}: {e}")


def render_spotchecks():
    SPOTCHECK_HELM_ROOT.mkdir(parents=True, exist_ok=True)

    summary_reports = []

    for cand in CANDIDATES:
        cand_id = cand["id"]
        target_dir = STAGING_ROOT / cand_id
        ensure_unzipped(target_dir)

        spot_dir = SPOTCHECK_HELM_ROOT / cand_id
        spot_dir.mkdir(parents=True, exist_ok=True)

        data_yaml_path = target_dir / "data.yaml"
        if not data_yaml_path.exists():
            print(f"[Warn] No data.yaml for {cand_id}")
            continue

        with open(to_win_long_path(str(data_yaml_path)), "r", encoding="utf-8") as f:
            cfg = yaml.safe_load(f)

        raw_names = cfg.get("names", [])
        if isinstance(raw_names, dict):
            raw_names = [raw_names[k] for k in sorted(raw_names.keys())]

        # Gather images across splits
        all_imgs = []
        for split in ["train", "valid", "test"]:
            img_dir = target_dir / split / "images"
            lbl_dir = target_dir / split / "labels"
            if not os.path.exists(to_win_long_path(str(img_dir))):
                continue
            for img_name in os.listdir(to_win_long_path(str(img_dir))):
                if any(img_name.lower().endswith(ext) for ext in [".jpg", ".jpeg", ".png", ".webp"]):
                    stem = os.path.splitext(img_name)[0]
                    img_path = str(img_dir / img_name)
                    lbl_path = str(lbl_dir / f"{stem}.txt")
                    if os.path.exists(to_win_long_path(lbl_path)):
                        all_imgs.append((img_path, lbl_path, split, img_name))

        print(f"\n[{cand_id}] Total annotated images found: {len(all_imgs)}")
        print(f"  Classes: {raw_names}")

        # Count total annotations across all images
        class_box_totals = {c: 0 for c in raw_names}
        res_list = []

        # Sample 20 images with diverse annotations
        sampled = all_imgs[:20]

        for idx, (img_path, lbl_path, split, img_name) in enumerate(sampled):
            try:
                with Image.open(to_win_long_path(img_path)).convert("RGB") as im:
                    w_px, h_px = im.size
                    res_list.append((w_px, h_px))
                    draw = ImageDraw.Draw(im)

                    with open(to_win_long_path(lbl_path), "r", encoding="utf-8") as lf:
                        lines = lf.readlines()

                    for line in lines:
                        parts = line.strip().split()
                        if not parts:
                            continue
                        cls_idx = int(parts[0])
                        cls_name = raw_names[cls_idx] if cls_idx < len(raw_names) else str(cls_idx)
                        if cls_name in class_box_totals:
                            class_box_totals[cls_name] += 1

                        if len(parts) == 5:
                            xc, yc, w, h = [float(p) for p in parts[1:5]]
                            x1 = (xc - w / 2.0) * w_px
                            y1 = (yc - h / 2.0) * h_px
                            x2 = (xc + w / 2.0) * w_px
                            y2 = (yc + h / 2.0) * h_px
                        elif len(parts) > 5:
                            coords = [float(p) for p in parts[1:]]
                            xs = coords[0::2]
                            ys = coords[1::2]
                            x1, x2 = min(xs) * w_px, max(xs) * w_px
                            y1, y2 = min(ys) * h_px, max(ys) * h_px
                        else:
                            continue

                        color = COLORS[cls_idx % len(COLORS)]
                        draw.rectangle([x1, y1, x2, y2], outline=color, width=3)
                        draw.text((x1 + 3, y1 + 3), f"{cls_name}", fill=color)

                    out_name = f"sample_{idx+1:02d}_{split}_{img_name}"
                    im.save(to_win_long_path(str(spot_dir / out_name)), quality=90)
            except Exception as e:
                print(f"  Error rendering {img_name}: {e}")

        summary_reports.append({
            "candidate": cand,
            "total_images": len(all_imgs),
            "classes": raw_names,
            "sampled_count": len(sampled),
            "spotcheck_dir": str(spot_dir),
            "sample_resolutions": res_list[:5]
        })

    print("\n" + "=" * 60)
    print(" HELM AUDIT & SPOTCHECK SUMMARY")
    print("=" * 60)
    for rep in summary_reports:
        c = rep["candidate"]
        print(f"\nCandidate: {c['name']}")
        print(f"  ID (Staging) : {c['id']}")
        print(f"  URL          : {c['url']}")
        print(f"  License      : {c['license']}")
        print(f"  Total Images : {rep['total_images']}")
        print(f"  Classes      : {rep['classes']}")
        print(f"  Spotchecks   : {rep['sampled_count']} rendered to {rep['spotcheck_dir']}")
        print(f"  Sample Res   : {rep['sample_resolutions']}")

    return summary_reports


if __name__ == "__main__":
    download_candidates()
    render_spotchecks()
