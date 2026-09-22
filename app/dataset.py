"""
VisionX - Dataset Preparation Pipeline Module
Menangani impor dataset, validasi YOLO annotation, registrasi class terpusat,
train/val/test split anti data-leakage, pembuatan dataset.yaml, dan statistik dataset.
"""

import os
import sys
import re
import yaml
import shutil
import hashlib
import random
import logging
import argparse
from pathlib import Path
from dataclasses import dataclass, field
from typing import List, Dict, Tuple, Optional, Set, Union
import cv2
import numpy as np

# Pastikan root direktori project ada di sys.path
PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

logger = logging.getLogger("VisionX.Dataset")

# Format ekstensi yang didukung
SUPPORTED_IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}
EPSILON = 1e-4  # Toleransi kecil untuk floating point boundaries


class DatasetError(Exception):
    """Base exception untuk error pada dataset pipeline."""
    pass


class AnnotationFormatError(DatasetError):
    """Dilempar ketika format anotasi YOLO tidak valid."""
    pass


@dataclass
class YOLOAnnotation:
    """Representasi satu baris anotasi objek dalam format YOLO (ter-normalisasi 0.0 - 1.0)."""
    class_id: int
    x_center: float
    y_center: float
    width: float
    height: float

    @classmethod
    def from_line(cls, line: str, line_num: int = 1) -> "YOLOAnnotation":
        """
        Melakukan parsing dan validasi satu baris teks anotasi YOLO.
        Format: class_id x_center y_center width height
        """
        line_clean = line.strip()
        if not line_clean:
            raise AnnotationFormatError(f"Baris {line_num}: Baris anotasi kosong.")

        tokens = line_clean.split()
        if len(tokens) != 5:
            raise AnnotationFormatError(
                f"Baris {line_num}: Harus memiliki tepat 5 elemen (class_id x y w h), ditemukan {len(tokens)}: '{line_clean}'"
            )

        try:
            class_id = int(tokens[0])
        except ValueError:
            raise AnnotationFormatError(f"Baris {line_num}: class_id harus bilangan bulat: '{tokens[0]}'")

        if class_id < 0:
            raise AnnotationFormatError(f"Baris {line_num}: class_id tidak boleh negatif: {class_id}")

        try:
            x_center = float(tokens[1])
            y_center = float(tokens[2])
            width = float(tokens[3])
            height = float(tokens[4])
        except ValueError:
            raise AnnotationFormatError(f"Baris {line_num}: Koordinat bounding box harus berupa angka float.")

        # Validasi batas nilai normalisasi (0.0 - 1.0)
        if not (0.0 <= x_center <= 1.0):
            raise AnnotationFormatError(f"Baris {line_num}: x_center ({x_center}) berada di luar range [0.0, 1.0].")
        if not (0.0 <= y_center <= 1.0):
            raise AnnotationFormatError(f"Baris {line_num}: y_center ({y_center}) berada di luar range [0.0, 1.0].")
        if not (0.0 < width <= 1.0 + EPSILON):
            raise AnnotationFormatError(f"Baris {line_num}: width ({width}) harus bernilai > 0 dan <= 1.0.")
        if not (0.0 < height <= 1.0 + EPSILON):
            raise AnnotationFormatError(f"Baris {line_num}: height ({height}) harus bernilai > 0 dan <= 1.0.")

        # Validasi batas luar kotak (x_min, y_min >= 0, x_max, y_max <= 1)
        x_min = x_center - (width / 2.0)
        x_max = x_center + (width / 2.0)
        y_min = y_center - (height / 2.0)
        y_max = y_center + (height / 2.0)

        if x_min < -EPSILON or y_min < -EPSILON or x_max > (1.0 + EPSILON) or y_max > (1.0 + EPSILON):
            raise AnnotationFormatError(
                f"Baris {line_num}: Bounding box melampaui batas citra "
                f"[xmin={x_min:.3f}, ymin={y_min:.3f}, xmax={x_max:.3f}, ymax={y_max:.3f}]."
            )

        return cls(
            class_id=class_id,
            x_center=x_center,
            y_center=y_center,
            width=width,
            height=height
        )

    def to_line(self) -> str:
        """Mengonversi kembali ke string baris YOLO format."""
        return f"{self.class_id} {self.x_center:.6f} {self.y_center:.6f} {self.width:.6f} {self.height:.6f}"


class ClassRegistry:
    """
    Mengelola mapping kelas terpusat (class_id <-> class_name)
    agar pemetaan konsisten dan tidak berubah saat dataset diproses ulang.
    """

    def __init__(self, mapping: Optional[Dict[int, str]] = None) -> None:
        self._id_to_name: Dict[int, str] = {}
        self._name_to_id: Dict[str, int] = {}
        if mapping:
            for cid, name in mapping.items():
                self.register(name, class_id=int(cid))

    def register(self, name: str, class_id: Optional[int] = None) -> int:
        """Mendaftarkan kelas baru atau mengembalikan ID yang sudah ada."""
        name_clean = name.strip()
        if name_clean in self._name_to_id:
            existing_id = self._name_to_id[name_clean]
            if class_id is not None and class_id != existing_id:
                raise ValueError(
                    f"Kelas '{name_clean}' sudah terdaftar dengan ID {existing_id}, tidak bisa diubah ke {class_id}."
                )
            return existing_id

        if class_id is None:
            # Gunakan ID berikutnya yang belum terpakai
            class_id = 0 if not self._id_to_name else max(self._id_to_name.keys()) + 1

        if class_id in self._id_to_name:
            raise ValueError(
                f"ID {class_id} sudah digunakan oleh kelas '{self._id_to_name[class_id]}'."
            )

        self._id_to_name[class_id] = name_clean
        self._name_to_id[name_clean] = class_id
        return class_id

    def get_name(self, class_id: int) -> Optional[str]:
        return self._id_to_name.get(class_id)

    def get_id(self, name: str) -> Optional[int]:
        return self._name_to_id.get(name.strip())

    def to_dict(self) -> Dict[int, str]:
        """Mengembalikan mapping dalam urutan ID terurut."""
        return {cid: self._id_to_name[cid] for cid in sorted(self._id_to_name.keys())}

    def save(self, filepath: Union[str, Path]) -> None:
        """Menyimpan registrasi kelas ke file YAML."""
        path = Path(filepath)
        path.parent.mkdir(parents=True, exist_ok=True)
        data = {"names": self.to_dict()}
        with open(path, "w", encoding="utf-8") as f:
            yaml.dump(data, f, sort_keys=False, default_flow_style=False)
        logger.info(f"Class registry disimpan ke: {path}")

    @classmethod
    def load(cls, filepath: Union[str, Path]) -> "ClassRegistry":
        """Memuat registrasi kelas dari file YAML atau txt (satu baris per nama)."""
        path = Path(filepath)
        if not path.exists():
            raise FileNotFoundError(f"File class registry tidak ditemukan: {path}")

        registry = cls()
        if path.suffix.lower() in {".yaml", ".yml"}:
            with open(path, "r", encoding="utf-8") as f:
                data = yaml.safe_load(f) or {}
            names = data.get("names", data)
            if isinstance(names, dict):
                for cid, name in names.items():
                    registry.register(str(name), class_id=int(cid))
            elif isinstance(names, list):
                for cid, name in enumerate(names):
                    registry.register(str(name), class_id=cid)
        else:
            # File text biasa, 1 baris per nama kelas
            with open(path, "r", encoding="utf-8") as f:
                lines = [line.strip() for line in f if line.strip()]
            for cid, name in enumerate(lines):
                registry.register(name, class_id=cid)

        return registry

    @classmethod
    def from_list(cls, names: List[str]) -> "ClassRegistry":
        registry = cls()
        for idx, name in enumerate(names):
            registry.register(name, class_id=idx)
        return registry


@dataclass
class ValidationReport:
    """Hasil laporan pengecekan validitas dataset."""
    total_images_found: int = 0
    total_labels_found: int = 0
    valid_pairs: List[Tuple[Path, Path, List[YOLOAnnotation]]] = field(default_factory=list)
    missing_labels: List[Path] = field(default_factory=list)
    orphaned_labels: List[Path] = field(default_factory=list)
    empty_labels: List[Path] = field(default_factory=list)
    corrupted_images: List[Path] = field(default_factory=list)
    invalid_annotations: List[Tuple[Path, int, str, str]] = field(default_factory=list)
    duplicate_images: Dict[str, List[Path]] = field(default_factory=dict)
    class_object_counts: Dict[int, int] = field(default_factory=dict)
    class_image_counts: Dict[int, int] = field(default_factory=dict)

    @property
    def is_valid(self) -> bool:
        """Mengembalikan True jika dataset valid tanpa file corrupt/rusak."""
        return (
            len(self.valid_pairs) > 0 and
            len(self.corrupted_images) == 0 and
            len(self.invalid_annotations) == 0
        )

    def print_summary(self, class_registry: Optional[ClassRegistry] = None) -> None:
        """Mencetak ringkasan laporan validasi ke console."""
        print("=" * 60)
        print("VisionX Dataset Validation Report")
        print("=" * 60)
        print(f"Total Citra Ditemukan      : {self.total_images_found}")
        print(f"Total Label Ditemukan      : {self.total_labels_found}")
        print(f"Pasangan Valid (Siap Split): {len(self.valid_pairs)}")
        total_objs = sum(self.class_object_counts.values())
        print(f"Total Objek Terdeteksi     : {total_objs}")

        if self.class_object_counts:
            print("\nDistribusi Objek per Kelas:")
            for cid in sorted(self.class_object_counts.keys()):
                cname = class_registry.get_name(cid) if class_registry else f"Class_{cid}"
                objs = self.class_object_counts[cid]
                imgs = self.class_image_counts.get(cid, 0)
                print(f"  [{cid}] {cname:<18}: {objs:>5} objek (di {imgs} gambar)")

        # Peringatan Masalah
        has_issues = False
        if self.missing_labels:
            has_issues = True
            print(f"\n[PERINGATAN] Citra tanpa file label  : {len(self.missing_labels)}")
        if self.orphaned_labels:
            has_issues = True
            print(f"[PERINGATAN] Label tanpa file citra : {len(self.orphaned_labels)}")
        if self.empty_labels:
            has_issues = True
            print(f"[PERINGATAN] Label kosong (tanpa objek): {len(self.empty_labels)}")
        if self.corrupted_images:
            has_issues = True
            print(f"[ERROR] Citra rusak / tidak terbaca : {len(self.corrupted_images)}")
        if self.invalid_annotations:
            has_issues = True
            print(f"[ERROR] Anotasi tidak valid         : {len(self.invalid_annotations)}")
            for fpath, lnum, ltxt, err in self.invalid_annotations[:5]:
                print(f"   -> {fpath.name} line {lnum}: {err}")
            if len(self.invalid_annotations) > 5:
                print(f"   -> ... dan {len(self.invalid_annotations) - 5} baris lainnya.")

        if self.duplicate_images:
            dup_count = sum(len(paths) - 1 for paths in self.duplicate_images.values())
            print(f"\n[INFO] Citra duplikat (hash identik): {dup_count} duplikasi")

        print("=" * 60)
        status = "PASSED (VALID)" if self.is_valid else "FAILED (MEMERLUKAN PERBAIKAN)"
        print(f"Status Validasi: {status}")
        print("=" * 60)


class DatasetValidator:
    """
    Melakukan pemeriksaan mendalam terhadap integritas dataset YOLO:
    keterbacaan gambar, validitas pasangan file, pengecekan format bounding box,
    dan deteksi duplikasi citra.
    """

    @staticmethod
    def _compute_hash(file_path: Path) -> str:
        """Menghitung SHA256 hash untuk mendeteksi file gambar identik."""
        hasher = hashlib.sha256()
        with open(file_path, "rb") as f:
            for chunk in iter(lambda: f.read(65536), b""):
                hasher.update(chunk)
        return hasher.hexdigest()

    @classmethod
    def validate(
        cls,
        source_dir: Union[str, Path],
        class_registry: Optional[ClassRegistry] = None,
        check_images_readable: bool = True
    ) -> ValidationReport:
        """
        Menjalankan validasi menyeluruh pada folder sumber.
        Mendukung folder berstruktur datar maupun subfolder bertingkat.
        """
        source = Path(source_dir).resolve()
        if not source.exists():
            raise FileNotFoundError(f"Direktori sumber tidak ditemukan: {source}")

        report = ValidationReport()

        # 1. Kumpulkan semua file gambar dan file anotasi
        image_files: Dict[str, Path] = {}
        label_files: Dict[str, Path] = {}

        for p in source.rglob("*"):
            if not p.is_file():
                continue
            ext = p.suffix.lower()
            if ext in SUPPORTED_IMAGE_EXTS:
                # Key: stem (misal: "sample_01")
                image_files[p.stem] = p
            elif ext == ".txt" and p.name != "classes.txt":
                label_files[p.stem] = p

        report.total_images_found = len(image_files)
        report.total_labels_found = len(label_files)

        # 2. Cek Orphaned Labels (label tanpa gambar)
        for stem, lpath in label_files.items():
            if stem not in image_files:
                report.orphaned_labels.append(lpath)

        # 3. Hash map untuk mendeteksi citra duplikat
        hash_to_paths: Dict[str, List[Path]] = {}

        # 4. Validasi setiap gambar dan pasangannya
        for stem, ipath in sorted(image_files.items()):
            # Periksa keterbacaan gambar
            if check_images_readable:
                try:
                    img = cv2.imread(str(ipath))
                    if img is None or img.size == 0 or img.shape[0] == 0 or img.shape[1] == 0:
                        report.corrupted_images.append(ipath)
                        continue
                except Exception:
                    report.corrupted_images.append(ipath)
                    continue

            # Hitung hash citra
            img_hash = cls._compute_hash(ipath)
            hash_to_paths.setdefault(img_hash, []).append(ipath)

            # Cek ketersediaan file label
            if stem not in label_files:
                report.missing_labels.append(ipath)
                continue

            lpath = label_files[stem]

            # Baca file label
            try:
                with open(lpath, "r", encoding="utf-8") as lf:
                    lines = lf.readlines()
            except Exception as e:
                report.invalid_annotations.append((lpath, 0, "", f"Gagal membaca file: {str(e)}"))
                continue

            # Cek jika file label kosong
            if not lines or all(not line.strip() for line in lines):
                report.empty_labels.append(lpath)
                continue

            file_annotations: List[YOLOAnnotation] = []
            file_has_error = False
            classes_in_image: Set[int] = set()

            for line_idx, line in enumerate(lines, start=1):
                line_str = line.strip()
                if not line_str:
                    continue
                try:
                    annot = YOLOAnnotation.from_line(line_str, line_num=line_idx)
                    # Jika ada class_registry, validasi apakah class_id ada dalam registry
                    if class_registry and class_registry.get_name(annot.class_id) is None:
                        raise AnnotationFormatError(
                            f"Baris {line_idx}: class_id {annot.class_id} tidak terdaftar di ClassRegistry."
                        )
                    file_annotations.append(annot)
                    classes_in_image.add(annot.class_id)
                    report.class_object_counts[annot.class_id] = report.class_object_counts.get(annot.class_id, 0) + 1
                except AnnotationFormatError as err:
                    report.invalid_annotations.append((lpath, line_idx, line_str, str(err)))
                    file_has_error = True

            if not file_has_error and file_annotations:
                report.valid_pairs.append((ipath, lpath, file_annotations))
                for cid in classes_in_image:
                    report.class_image_counts[cid] = report.class_image_counts.get(cid, 0) + 1

        # Simpan citra duplikat yang memiliki > 1 kemunculan
        report.duplicate_images = {h: paths for h, paths in hash_to_paths.items() if len(paths) > 1}

        return report


class DatasetSplitter:
    """
    Membagi dataset valid ke dalam partisi train, val, dan test.
    Mendukung konfigurasi random seed untuk reproduktibilitas
    serta pengelompokan hash anti data-leakage.
    """

    @classmethod
    def split(
        cls,
        valid_pairs: List[Tuple[Path, Path, List[YOLOAnnotation]]],
        dest_dir: Union[str, Path],
        train_ratio: float = 0.8,
        val_ratio: float = 0.1,
        test_ratio: float = 0.1,
        seed: int = 42,
        avoid_leakage: bool = True
    ) -> Dict[str, int]:
        """
        Membagi data dan menyalin file ke struktur YOLO standar.

        Returns:
            Dict berisi jumlah gambar pada tiap split: {'train': x, 'val': y, 'test': z}
        """
        if not valid_pairs:
            raise DatasetError("Tidak ada pasangan gambar-label yang valid untuk dibagi.")

        total_ratio = train_ratio + val_ratio + test_ratio
        if abs(total_ratio - 1.0) > 1e-4:
            raise ValueError(f"Total rasio harus 1.0, saat ini {total_ratio:.2f}.")

        dest = Path(dest_dir).resolve()
        # Siapkan folder tujuan
        for split_name in ["train", "val", "test"]:
            (dest / "images" / split_name).mkdir(parents=True, exist_ok=True)
            (dest / "labels" / split_name).mkdir(parents=True, exist_ok=True)

        rng = random.Random(seed)

        # Anti Data-Leakage Grouping:
        # Kelompokkan citra yang memiliki hash identik ke dalam unit yang sama
        if avoid_leakage:
            hash_groups: Dict[str, List[Tuple[Path, Path, List[YOLOAnnotation]]]] = {}
            for item in valid_pairs:
                ipath = item[0]
                h = DatasetValidator._compute_hash(ipath)
                hash_groups.setdefault(h, []).append(item)

            groups = list(hash_groups.values())
            rng.shuffle(groups)

            # Ratakan ke urutan split berdasarkan jumlah item
            ordered_items: List[Tuple[Path, Path, List[YOLOAnnotation]]] = []
            for g in groups:
                ordered_items.extend(g)
        else:
            ordered_items = list(valid_pairs)
            rng.shuffle(ordered_items)

        total_items = len(ordered_items)
        n_train = int(round(total_items * train_ratio))
        n_val = int(round(total_items * val_ratio))

        # Penyesuaian agar total pas
        if n_train + n_val > total_items:
            n_train = total_items - n_val

        train_items = ordered_items[:n_train]
        val_items = ordered_items[n_train:n_train + n_val]
        test_items = ordered_items[n_train + n_val:]

        splits = {
            "train": train_items,
            "val": val_items,
            "test": test_items
        }

        # Salin file ke direktori tujuan
        counts = {}
        for split_name, items in splits.items():
            for ipath, lpath, _ in items:
                dest_img = dest / "images" / split_name / ipath.name
                dest_lbl = dest / "labels" / split_name / lpath.name

                shutil.copy2(ipath, dest_img)
                shutil.copy2(lpath, dest_lbl)

            counts[split_name] = len(items)
            logger.info(f"Split '{split_name}': {len(items)} gambar disalin ke {dest / 'images' / split_name}")

        return counts


class DatasetYAMLGenerator:
    """Menghasilkan file dataset.yaml / data.yaml standar Ultralytics YOLO."""

    @staticmethod
    def generate(
        dest_dir: Union[str, Path],
        class_registry: ClassRegistry,
        dataset_yaml_path: Optional[Union[str, Path]] = None,
        use_relative_paths: bool = True
    ) -> Path:
        dest = Path(dest_dir).resolve()
        target_path = Path(dataset_yaml_path) if dataset_yaml_path else dest / "dataset.yaml"
        target_path.parent.mkdir(parents=True, exist_ok=True)

        if use_relative_paths:
            base_path = str(dest).replace("\\", "/")
            train_path = "images/train"
            val_path = "images/val"
            test_path = "images/test"
        else:
            base_path = str(dest).replace("\\", "/")
            train_path = str(dest / "images" / "train").replace("\\", "/")
            val_path = str(dest / "images" / "val").replace("\\", "/")
            test_path = str(dest / "images" / "test").replace("\\", "/")

        data = {
            "path": base_path,
            "train": train_path,
            "val": val_path,
            "test": test_path,
            "names": class_registry.to_dict()
        }

        with open(target_path, "w", encoding="utf-8") as f:
            yaml.dump(data, f, sort_keys=False, default_flow_style=False)

        logger.info(f"File konfigurasi YOLO dibuat di: {target_path}")
        return target_path


class DatasetStats:
    """Menghitung dan memformat statistik dataset yang telah diproses."""

    @classmethod
    def calculate(cls, dataset_dir: Union[str, Path]) -> Dict[str, Union[int, Dict[str, int]]]:
        """Menghitung statistik gambar, objek, dan pembagian kelas dari dataset YOLO."""
        base = Path(dataset_dir).resolve()
        
        # Cek apakah ini folder processed dengan struktur images/{train,val,test}
        is_processed_structure = (base / "images" / "train").exists()

        stats = {
            "total_images": 0,
            "total_objects": 0,
            "objects_per_class": {},
            "images_per_class": {},
            "split_counts": {"train": 0, "val": 0, "test": 0},
            "images_without_objects": 0,
            "invalid_annotations": 0,
            "missing_labels": 0
        }

        # Cek nama kelas jika dataset.yaml tersedia
        yaml_path = base / "dataset.yaml"
        class_names: Dict[int, str] = {}
        if yaml_path.exists():
            try:
                with open(yaml_path, "r", encoding="utf-8") as f:
                    cfg = yaml.safe_load(f) or {}
                class_names = {int(k): str(v) for k, v in cfg.get("names", {}).items()}
            except Exception:
                pass

        if is_processed_structure:
            for split_name in ["train", "val", "test"]:
                img_dir = base / "images" / split_name
                lbl_dir = base / "labels" / split_name
                if not img_dir.exists():
                    continue

                for ipath in img_dir.iterdir():
                    if not ipath.is_file() or ipath.suffix.lower() not in SUPPORTED_IMAGE_EXTS:
                        continue
                    stats["total_images"] += 1
                    stats["split_counts"][split_name] += 1

                    lpath = lbl_dir / f"{ipath.stem}.txt"
                    if not lpath.exists():
                        stats["missing_labels"] += 1
                        continue

                    try:
                        with open(lpath, "r", encoding="utf-8") as lf:
                            lines = [ln.strip() for ln in lf if ln.strip()]
                    except Exception:
                        stats["invalid_annotations"] += 1
                        continue

                    if not lines:
                        stats["images_without_objects"] += 1
                        continue

                    classes_in_img = set()
                    for lnum, line in enumerate(lines, 1):
                        try:
                            annot = YOLOAnnotation.from_line(line, line_num=lnum)
                            cname = class_names.get(annot.class_id, f"class_{annot.class_id}")
                            stats["total_objects"] += 1
                            stats["objects_per_class"][cname] = stats["objects_per_class"].get(cname, 0) + 1
                            classes_in_img.add(cname)
                        except AnnotationFormatError:
                            stats["invalid_annotations"] += 1

                    for cname in classes_in_img:
                        stats["images_per_class"][cname] = stats["images_per_class"].get(cname, 0) + 1

        else:
            # Folder biasa
            report = DatasetValidator.validate(base, check_images_readable=False)
            stats["total_images"] = report.total_images_found
            stats["missing_labels"] = len(report.missing_labels)
            stats["invalid_annotations"] = len(report.invalid_annotations)
            stats["images_without_objects"] = len(report.empty_labels)
            for cid, count in report.class_object_counts.items():
                cname = class_names.get(cid, f"class_{cid}")
                stats["total_objects"] += count
                stats["objects_per_class"][cname] = count
            for cid, count in report.class_image_counts.items():
                cname = class_names.get(cid, f"class_{cid}")
                stats["images_per_class"][cname] = count

        return stats

    @classmethod
    def print_stats(cls, dataset_dir: Union[str, Path]) -> None:
        """Mencetak statistik dataset dengan format bersih dan mudah dibaca."""
        stats = cls.calculate(dataset_dir)
        print("\n" + "=" * 45)
        print("Dataset Statistics")
        print("=" * 45)
        print(f"Images: {stats['total_images']}")
        print(f"Objects: {stats['total_objects']}")

        if stats["objects_per_class"]:
            print("\nObjects per Class:")
            for cname, count in stats["objects_per_class"].items():
                print(f"  {cname}: {count}")

        if any(stats["split_counts"].values()):
            print("\nSplits:")
            print(f"  Train: {stats['split_counts']['train']}")
            print(f"  Val: {stats['split_counts']['val']}")
            print(f"  Test: {stats['split_counts']['test']}")

        print("\nQuality & Integrity:")
        print(f"  Invalid annotations: {stats['invalid_annotations']}")
        print(f"  Missing labels: {stats['missing_labels']}")
        if stats["images_without_objects"]:
            print(f"  Images without objects: {stats['images_without_objects']}")
        print("=" * 45 + "\n")


class DatasetImporter:
    """Mengimpor pasangan gambar dan anotasi dari direktori eksternal ke datasets/imported/."""

    @staticmethod
    def import_pairs(
        source_dir: Union[str, Path],
        dest_dir: Union[str, Path] = "datasets/imported"
    ) -> int:
        src = Path(source_dir).resolve()
        dest = Path(dest_dir).resolve()
        dest.mkdir(parents=True, exist_ok=True)

        imported_count = 0
        for p in src.rglob("*"):
            if not p.is_file() or p.suffix.lower() not in SUPPORTED_IMAGE_EXTS:
                continue

            lbl = p.with_suffix(".txt")
            if lbl.exists():
                shutil.copy2(p, dest / p.name)
                shutil.copy2(lbl, dest / lbl.name)
                imported_count += 1

        logger.info(f"Berhasil mengimpor {imported_count} pasangan gambar & label ke {dest}")
        return imported_count


# =====================================================================
# CLI Interface & Subcommands
# =====================================================================

def cmd_validate(args: argparse.Namespace) -> int:
    registry = ClassRegistry.load(args.classes) if args.classes else None
    report = DatasetValidator.validate(args.source, class_registry=registry)
    report.print_summary(class_registry=registry)
    return 0 if report.is_valid else 1


def cmd_split(args: argparse.Namespace) -> int:
    registry = ClassRegistry.load(args.classes) if args.classes else None
    report = DatasetValidator.validate(args.source, class_registry=registry)
    if not report.valid_pairs:
        print("[ERROR] Tidak ada pasangan citra & label yang valid untuk di-split.")
        return 1

    counts = DatasetSplitter.split(
        valid_pairs=report.valid_pairs,
        dest_dir=args.dest,
        train_ratio=args.train,
        val_ratio=args.val,
        test_ratio=args.test,
        seed=args.seed,
        avoid_leakage=not args.allow_leakage
    )
    print(f"Split Berhasil! Train: {counts['train']}, Val: {counts['val']}, Test: {counts['test']}")
    return 0


def cmd_stats(args: argparse.Namespace) -> int:
    DatasetStats.print_stats(args.source)
    return 0


def cmd_prepare(args: argparse.Namespace) -> int:
    """
    Eksekusi alur penuh persiapan dataset:
    Validasi -> Registrasi Kelas -> Train/Val/Test Split -> Generate dataset.yaml -> Cetak Statistik.
    """
    print("\n[1/5] Memvalidasi Dataset Sumber...")
    registry = None
    if args.classes and Path(args.classes).exists():
        registry = ClassRegistry.load(args.classes)
        print(f"Memuat kelas dari: {args.classes}")
    elif Path("datasets/metadata/classes.yaml").exists():
        registry = ClassRegistry.load("datasets/metadata/classes.yaml")
        print("Memuat kelas dari default: datasets/metadata/classes.yaml")

    report = DatasetValidator.validate(args.source, class_registry=registry)
    report.print_summary(class_registry=registry)

    if not report.is_valid:
        print("\n[ERROR] Dataset memiliki file rusak atau anotasi invalid. Harap perbaiki sebelum prepare.")
        return 1

    # Jika registry belum ada, bangun registry otomatis dari class_id yang ditemukan
    if registry is None:
        print("\n[2/5] Membangun Class Registry Otomatis...")
        registry = ClassRegistry()
        for cid in sorted(report.class_object_counts.keys()):
            registry.register(f"class_{cid}", class_id=cid)
        registry.save("datasets/metadata/classes.yaml")
    else:
        print("\n[2/5] Menggunakan Class Registry Terdaftar.")

    print(f"\n[3/5] Membagi Dataset (Train: {args.train}, Val: {args.val}, Test: {args.test}, Seed: {args.seed})...")
    counts = DatasetSplitter.split(
        valid_pairs=report.valid_pairs,
        dest_dir=args.dest,
        train_ratio=args.train,
        val_ratio=args.val,
        test_ratio=args.test,
        seed=args.seed,
        avoid_leakage=not args.allow_leakage
    )

    print("\n[4/5] Membuat File dataset.yaml...")
    yaml_file = DatasetYAMLGenerator.generate(
        dest_dir=args.dest,
        class_registry=registry,
        dataset_yaml_path=Path(args.dest) / "dataset.yaml"
    )
    print(f"dataset.yaml berhasil dibuat: {yaml_file}")

    print("\n[5/5] Statistik Akhir Dataset Siap Pakai:")
    DatasetStats.print_stats(args.dest)
    print("Selamat! Dataset siap digunakan untuk training YOLO (V0.4).\n")
    return 0


def cmd_import(args: argparse.Namespace) -> int:
    count = DatasetImporter.import_pairs(args.source, args.dest)
    print(f"Selesai mengimpor {count} pasang citra & label ke {args.dest}.")
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="python -m app.dataset",
        description="VisionX V0.3: Dataset Preparation Pipeline for YOLO Object Detection",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter
    )

    subparsers = parser.add_subparsers(dest="subcommand", help="Perintah operasi dataset")

    # Subcommand: validate
    p_val = subparsers.add_parser("validate", help="Validasi integritas citra dan anotasi YOLO")
    p_val.add_argument("--source", type=str, required=True, help="Direktori dataset yang akan diperiksa")
    p_val.add_argument("--classes", type=str, default=None, help="File classes.yaml atau classes.txt")

    # Subcommand: split
    p_split = subparsers.add_parser("split", help="Membagi dataset valid ke train/val/test")
    p_split.add_argument("--source", type=str, required=True, help="Direktori dataset sumber")
    p_split.add_argument("--dest", type=str, default="datasets/processed", help="Direktori output")
    p_split.add_argument("--classes", type=str, default=None, help="File classes.yaml")
    p_split.add_argument("--train", type=float, default=0.8, help="Rasio train")
    p_split.add_argument("--val", type=float, default=0.1, help="Rasio val")
    p_split.add_argument("--test", type=float, default=0.1, help="Rasio test")
    p_split.add_argument("--seed", type=int, default=42, help="Random seed untuk reproduktibilitas")
    p_split.add_argument("--allow-leakage", action="store_true", help="Nonaktifkan anti-leakage grouping")

    # Subcommand: stats
    p_stats = subparsers.add_parser("stats", help="Menampilkan statistik dataset")
    p_stats.add_argument("--source", type=str, default="datasets/processed", help="Direktori dataset")

    # Subcommand: prepare
    p_prep = subparsers.add_parser("prepare", help="Alur lengkap: Validasi -> Split -> dataset.yaml -> Stats")
    p_prep.add_argument("--source", type=str, required=True, help="Direktori dataset sumber")
    p_prep.add_argument("--dest", type=str, default="datasets/processed", help="Direktori output")
    p_prep.add_argument("--classes", type=str, default=None, help="File classes.yaml (opsional)")
    p_prep.add_argument("--train", type=float, default=0.8, help="Rasio train")
    p_prep.add_argument("--val", type=float, default=0.1, help="Rasio val")
    p_prep.add_argument("--test", type=float, default=0.1, help="Rasio test")
    p_prep.add_argument("--seed", type=int, default=42, help="Random seed")
    p_prep.add_argument("--allow-leakage", action="store_true", help="Nonaktifkan anti-leakage grouping")

    # Subcommand: import
    p_imp = subparsers.add_parser("import", help="Impor pasangan gambar & teks ke direktori staging")
    p_imp.add_argument("--source", type=str, required=True, help="Direktori asal dataset")
    p_imp.add_argument("--dest", type=str, default="datasets/imported", help="Direktori tujuan")

    args = parser.parse_args()

    if not args.subcommand:
        parser.print_help()
        sys.exit(0)

    handlers = {
        "validate": cmd_validate,
        "split": cmd_split,
        "stats": cmd_stats,
        "prepare": cmd_prepare,
        "import": cmd_import
    }

    exit_code = handlers[args.subcommand](args)
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
