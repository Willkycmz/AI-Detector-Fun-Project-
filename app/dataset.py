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
from datetime import datetime
from pathlib import Path
from dataclasses import dataclass, field
from typing import List, Dict, Tuple, Optional, Set, Union, Any
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

    def to_pixel_coords(self, img_width: int, img_height: int) -> Tuple[int, int, int, int]:
        """
        Mengonversi koordinat YOLO normalized (center_x, center_y, width, height)
        ke koordinat piksel bounding box (x1, y1, x2, y2).
        Memastikan koordinat di-clamp dalam rentang dimensi citra [0, img_width] & [0, img_height].
        """
        if img_width <= 0 or img_height <= 0:
            raise ValueError(f"Dimensi citra harus positif: {img_width}x{img_height}")

        x_min = (self.x_center - (self.width / 2.0)) * img_width
        y_min = (self.y_center - (self.height / 2.0)) * img_height
        x_max = (self.x_center + (self.width / 2.0)) * img_width
        y_max = (self.y_center + (self.height / 2.0)) * img_height

        x1 = max(0, min(img_width, int(round(x_min))))
        y1 = max(0, min(img_height, int(round(y_min))))
        x2 = max(0, min(img_width, int(round(x_max))))
        y2 = max(0, min(img_height, int(round(y_max))))

        return x1, y1, x2, y2

    to_xyxy = to_pixel_coords

    @classmethod
    def from_pixel_coords(
        cls,
        class_id: int,
        x1: float,
        y1: float,
        x2: float,
        y2: float,
        img_width: int,
        img_height: int
    ) -> "YOLOAnnotation":
        """
        Mengonversi koordinat piksel (x1, y1, x2, y2) ke anotasi YOLO ternormalisasi [0.0 - 1.0].
        """
        if img_width <= 0 or img_height <= 0:
            raise ValueError(f"Dimensi citra harus positif: {img_width}x{img_height}")

        xmin, xmax = min(x1, x2), max(x1, x2)
        ymin, ymax = min(y1, y2), max(y1, y2)

        box_w = max(1e-6, xmax - xmin)
        box_h = max(1e-6, ymax - ymin)
        x_c = xmin + (box_w / 2.0)
        y_c = ymin + (box_h / 2.0)

        norm_xc = max(0.0, min(1.0, x_c / img_width))
        norm_yc = max(0.0, min(1.0, y_c / img_height))
        norm_w = max(1e-6, min(1.0, box_w / img_width))
        norm_h = max(1e-6, min(1.0, box_h / img_height))

        return cls(
            class_id=class_id,
            x_center=norm_xc,
            y_center=norm_yc,
            width=norm_w,
            height=norm_h
        )

    from_xyxy = from_pixel_coords



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
        # Siapkan & bersihkan folder tujuan per split
        for split_name in ["train", "val", "test"]:
            img_split_dir = dest / "images" / split_name
            lbl_split_dir = dest / "labels" / split_name
            img_split_dir.mkdir(parents=True, exist_ok=True)
            lbl_split_dir.mkdir(parents=True, exist_ok=True)

            # Bersihkan file sisa jika ada dari proses sebelumnya
            for existing_f in img_split_dir.glob("*"):
                if existing_f.is_file():
                    existing_f.unlink()
            for existing_f in lbl_split_dir.glob("*"):
                if existing_f.is_file():
                    existing_f.unlink()

        # Urutkan secara deterministik sebelum pengelompokan dan shuffle
        sorted_pairs = sorted(valid_pairs, key=lambda x: x[0].name)
        rng = random.Random(seed)

        # Anti Data-Leakage Grouping:
        # Kelompokkan citra yang memiliki hash identik ke dalam unit yang sama
        if avoid_leakage:
            hash_groups: Dict[str, List[Tuple[Path, Path, List[YOLOAnnotation]]]] = {}
            for item in sorted_pairs:
                ipath = item[0]
                h = DatasetValidator._compute_hash(ipath)
                hash_groups.setdefault(h, []).append(item)

            # Urutkan grup berdasarkan key hash agar urutan awal selalu stabil
            groups = [hash_groups[h] for h in sorted(hash_groups.keys())]
            rng.shuffle(groups)

            # Ratakan ke urutan split berdasarkan unit grup
            ordered_items: List[Tuple[Path, Path, List[YOLOAnnotation]]] = []
            for g in groups:
                ordered_items.extend(g)
        else:
            ordered_items = list(sorted_pairs)
            rng.shuffle(ordered_items)

        total_items = len(ordered_items)
        n_train = int(round(total_items * train_ratio))
        n_val = int(round(total_items * val_ratio))

        # Penyesuaian agar total tepat sama dengan total_items
        if n_train + n_val > total_items:
            n_train = total_items - n_val
        n_test = total_items - n_train - n_val

        train_items = ordered_items[:n_train]
        val_items = ordered_items[n_train:n_train + n_val]
        test_items = ordered_items[n_train + n_val:]

        # Validasi ketat: pastikan tidak ada citra yang beririsan antar split
        train_stems = {item[0].stem for item in train_items}
        val_stems = {item[0].stem for item in val_items}
        test_stems = {item[0].stem for item in test_items}

        overlap_tv = train_stems & val_stems
        overlap_tt = train_stems & test_stems
        overlap_vt = val_stems & test_stems

        if overlap_tv or overlap_tt or overlap_vt:
            raise DatasetError(
                f"Terdeteksi overlap citra antar split! "
                f"Train-Val: {len(overlap_tv)}, Train-Test: {len(overlap_tt)}, Val-Test: {len(overlap_vt)}"
            )

        splits = {
            "train": train_items,
            "val": val_items,
            "test": test_items
        }

        # Salin file citra dan label ke direktori tujuan
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
            "split_object_counts": {"train": 0, "val": 0, "test": 0},
            "split_class_counts": {"train": {}, "val": {}, "test": {}},
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

                for ipath in sorted(img_dir.iterdir()):
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
                            stats["split_object_counts"][split_name] += 1
                            stats["objects_per_class"][cname] = stats["objects_per_class"].get(cname, 0) + 1
                            stats["split_class_counts"][split_name][cname] = stats["split_class_counts"][split_name].get(cname, 0) + 1
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
        print("\n" + "=" * 50)
        print("VisionX Dataset Statistics Report")
        print("=" * 50)
        print(f"Total Images         : {stats['total_images']}")
        print(f"Total Objects        : {stats['total_objects']}")

        if any(stats["split_counts"].values()):
            print("\nImages per Split:")
            for sp in ["train", "val", "test"]:
                pct = (stats['split_counts'][sp] / stats['total_images'] * 100) if stats['total_images'] else 0
                print(f"  {sp.capitalize():<6} : {stats['split_counts'][sp]:>4} images ({pct:.1f}%)")

            print("\nObjects per Split:")
            for sp in ["train", "val", "test"]:
                pct = (stats['split_object_counts'][sp] / stats['total_objects'] * 100) if stats['total_objects'] else 0
                print(f"  {sp.capitalize():<6} : {stats['split_object_counts'][sp]:>4} objects ({pct:.1f}%)")

        if stats["objects_per_class"]:
            print("\nClass Distribution (Total Objects):")
            for cname in sorted(stats["objects_per_class"].keys()):
                objs = stats["objects_per_class"][cname]
                imgs = stats["images_per_class"].get(cname, 0)
                print(f"  {cname:<14} : {objs:>5} objects (di {imgs} images)")

        print("\nQuality & Integrity:")
        print(f"  Missing labels         : {stats['missing_labels']}")
        print(f"  Invalid annotations    : {stats['invalid_annotations']}")
        print(f"  Images without objects : {stats['images_without_objects']}")
        print("=" * 50 + "\n")



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


# Daftar 80 Kelas Standar COCO Dataset (HuggingFace Format)
COCO_80_CLASSES = [
    "person", "bicycle", "car", "motorcycle", "airplane", "bus", "train", "truck", "boat",
    "traffic light", "fire hydrant", "stop sign", "parking meter", "bench", "bird", "cat",
    "dog", "horse", "sheep", "cow", "elephant", "bear", "zebra", "giraffe", "backpack",
    "umbrella", "handbag", "tie", "suitcase", "frisbee", "skis", "snowboard", "sports ball",
    "kite", "baseball bat", "baseball glove", "skateboard", "surfboard", "tennis racket",
    "bottle", "wine glass", "cup", "fork", "knife", "spoon", "bowl", "banana", "apple",
    "sandwich", "orange", "broccoli", "carrot", "hot dog", "pizza", "donut", "cake", "chair",
    "couch", "potted plant", "bed", "dining table", "toilet", "tv", "laptop", "mouse",
    "remote", "keyboard", "cell phone", "microwave", "oven", "toaster", "sink", "refrigerator",
    "book", "clock", "vase", "scissors", "teddy bear", "hair drier", "toothbrush"
]

DEFAULT_TARGET_CLASSES = [
    "person",
    "bottle",
    "cup",
    "laptop",
    "mouse",
    "keyboard",
    "cell_phone"
]


def normalize_class_name(name: str) -> str:
    """Normalisasi nama kelas (misal: 'cell phone' -> 'cell_phone')."""
    return name.strip().lower().replace(" ", "_").replace("-", "_")


class HuggingFaceDatasetImporter:
    """
    Mengunduh dan mengimpor subset kelas objek tertentu dari dataset Hugging Face
    (misal: benjamintli/coco2017-10k) langsung ke format YOLO terstandarisasi VisionX.
    """

    @staticmethod
    def download_file_resilient(url: str, dest_path: Path, chunk_size: int = 1024 * 1024) -> Path:
        """Mengunduh file besar dengan dukungan auto-resume jika koneksi terputus."""
        import requests
        import time

        dest_path.parent.mkdir(parents=True, exist_ok=True)
        temp_path = dest_path.with_suffix(dest_path.suffix + ".part")
        total_size = None
        max_retries = 15
        retries = 0

        while retries < max_retries:
            try:
                downloaded = temp_path.stat().st_size if temp_path.exists() else 0
                if total_size and downloaded >= total_size:
                    break

                headers = {"Range": f"bytes={downloaded}-"} if downloaded > 0 else {}
                r = requests.get(url, headers=headers, stream=True, timeout=35)

                if r.status_code not in (200, 206):
                    time.sleep(2)
                    retries += 1
                    continue

                if total_size is None:
                    total_size = int(r.headers.get("content-length", 0)) + downloaded

                print(f"  [Unduh] {dest_path.name}: {downloaded / 1024 / 1024:.1f} MB / {total_size / 1024 / 1024:.1f} MB...", flush=True)

                mode = "ab" if downloaded > 0 else "wb"
                with open(temp_path, mode) as f:
                    for chunk in r.iter_content(chunk_size=chunk_size):
                        if chunk:
                            f.write(chunk)

                if temp_path.exists() and total_size and temp_path.stat().st_size >= total_size:
                    break
            except Exception as e:
                retries += 1
                logger.warning(f"Koneksi unduh terputus ({e}), mencoba kembali ({retries}/{max_retries})...")
                time.sleep(2)

        if temp_path.exists():
            temp_path.replace(dest_path)

        return dest_path

    @classmethod
    def get_parquet_urls(cls, dataset_name: str, split: str = "train") -> List[str]:
        """Mendapatkan daftar URL parquet untuk split dataset dari HuggingFace API."""
        import requests
        api_url = f"https://huggingface.co/api/datasets/{dataset_name}/parquet"
        try:
            r = requests.get(api_url, timeout=20)
            if r.status_code == 200:
                data = r.json()
                if "default" in data and split in data["default"]:
                    return data["default"][split]
                elif split in data:
                    return data[split]
        except Exception as e:
            logger.warning(f"Gagal membaca API parquet HuggingFace: {e}")

        # Fallback default URLs untuk benjamintli/coco2017-10k
        if "coco2017-10k" in dataset_name:
            if split == "train":
                return [
                    f"https://huggingface.co/api/datasets/{dataset_name}/parquet/default/train/{i}.parquet"
                    for i in range(4)
                ]
            elif split in ("val", "validation"):
                return [
                    f"https://huggingface.co/api/datasets/{dataset_name}/parquet/default/validation/0.parquet"
                ]
        return []

    @classmethod
    def import_subset(
        cls,
        dataset_name: str = "benjamintli/coco2017-10k",
        split: str = "train",
        target_classes: Optional[List[str]] = None,
        max_per_class: int = 100,
        output_dir: Union[str, Path] = "datasets/raw/external/huggingface/benjamintli_coco2017-10k",
        cache_dir: Union[str, Path] = "scratch/hf_cache",
        metadata_file: Union[str, Path] = "datasets/metadata/sources.yaml"
    ) -> Dict[str, Any]:
        """
        Mengimpor subset target class dari HuggingFace COCO dataset.
        """
        import polars as pl

        out_path = Path(output_dir).resolve()
        images_dir = out_path / "images"
        labels_dir = out_path / "labels"
        images_dir.mkdir(parents=True, exist_ok=True)
        labels_dir.mkdir(parents=True, exist_ok=True)

        cache_path = Path(cache_dir).resolve()
        cache_path.mkdir(parents=True, exist_ok=True)

        # 1. Bangun Class Registry VisionX yang stabil
        raw_classes = target_classes or DEFAULT_TARGET_CLASSES
        normalized_targets = [normalize_class_name(c) for c in raw_classes]

        class_registry = ClassRegistry()
        for idx, cname in enumerate(normalized_targets):
            class_registry.register(cname, class_id=idx)

        # Simpan/update classes.yaml terpusat
        classes_yaml_path = Path("datasets/metadata/classes.yaml")
        class_registry.save(classes_yaml_path)

        target_set = set(normalized_targets)
        logger.info(f"Target VisionX classes: {class_registry.to_dict()}")

        # 2. Tracking counts & duplicate prevention
        class_image_counts: Dict[str, int] = {c: 0 for c in normalized_targets}
        class_object_counts: Dict[str, int] = {c: 0 for c in normalized_targets}
        known_hashes: Set[str] = set()

        # Baca hash yang sudah ada di output images dir
        for existing_img in images_dir.glob("*.jpg"):
            try:
                with open(existing_img, "rb") as f:
                    known_hashes.add(hashlib.sha256(f.read()).hexdigest())
            except Exception:
                pass

        # 3. Dapatkan daftar parquet files
        print(f"\n[HuggingFace Importer] Membaca metadata dataset '{dataset_name}' (Split: {split})...")
        parquet_urls = cls.get_parquet_urls(dataset_name, split=split)
        if not parquet_urls:
            raise RuntimeError(f"Tidak dapat menemukan URL file parquet untuk {dataset_name} split {split}.")

        print(f"Ditemukan {len(parquet_urls)} file data parquet. Target: {max_per_class} citra per kelas.")

        total_images = 0
        total_objects = 0
        invalid_labels = 0
        duplicates_skipped = 0

        # Siapkan struktur metadata sumber
        meta_path = Path(metadata_file).resolve()
        meta_path.parent.mkdir(parents=True, exist_ok=True)
        sources_meta = {"items": {}}
        if meta_path.exists():
            try:
                with open(meta_path, "r", encoding="utf-8") as f:
                    loaded = yaml.safe_load(f)
                    if isinstance(loaded, dict):
                        sources_meta = loaded
            except Exception:
                pass
        if "items" not in sources_meta:
            sources_meta["items"] = {}

        # 4. Iterasi setiap parquet file
        for pq_idx, pq_url in enumerate(parquet_urls):
            # Cek apakah semua target class sudah terpenuhi
            if all(class_image_counts[c] >= max_per_class for c in normalized_targets):
                print("Semua target class telah mencapai batas maksimum. Pengunduhan selesai.")
                break

            local_pq_path = cache_path / f"{split}_{pq_idx}.parquet"
            if not local_pq_path.exists():
                print(f"\nMengunduh file parquet [{pq_idx + 1}/{len(parquet_urls)}]...")
                cls.download_file_resilient(pq_url, local_pq_path)
            else:
                print(f"\nMenggunakan cache parquet lokal: {local_pq_path.name}")

            print(f"Memproses baris data pada {local_pq_path.name}...")
            try:
                df = pl.read_parquet(str(local_pq_path))
            except Exception as read_err:
                logger.error(f"Gagal membaca parquet {local_pq_path}: {read_err}")
                continue

            rows = df.to_dicts()
            for row in rows:
                if all(class_image_counts[c] >= max_per_class for c in normalized_targets):
                    break

                objects_data = row.get("objects", {})
                categories = objects_data.get("category", [])
                bboxes = objects_data.get("bbox", [])

                if not categories or not bboxes or len(categories) != len(bboxes):
                    continue

                # Cek apakah baris ini memiliki target class yang masih kita butuhkan
                row_target_classes = set()
                for cat_id in categories:
                    if 0 <= cat_id < len(COCO_80_CLASSES):
                        cname = normalize_class_name(COCO_80_CLASSES[cat_id])
                        if cname in target_set:
                            row_target_classes.add(cname)

                if not row_target_classes:
                    continue

                # Hanya ambil gambar jika ada kelas di gambar ini yang BELUM mencapai quota max_per_class
                needs_image = any(class_image_counts[c] < max_per_class for c in row_target_classes)
                if not needs_image:
                    continue

                # Ambil image bytes
                img_dict = row.get("image", {})
                img_bytes = img_dict.get("bytes")
                if not img_bytes or not isinstance(img_bytes, bytes):
                    continue

                # Cek duplikasi SHA-256
                img_hash = hashlib.sha256(img_bytes).hexdigest()
                if img_hash in known_hashes:
                    duplicates_skipped += 1
                    continue

                # Decode dimensi gambar tanpa mengubah gambar
                img_array = np.frombuffer(img_bytes, dtype=np.uint8)
                img_bgr = cv2.imdecode(img_array, cv2.IMREAD_COLOR)
                if img_bgr is None or img_bgr.size == 0:
                    continue

                img_height, img_width = img_bgr.shape[:2]
                if img_width <= 0 or img_height <= 0:
                    continue

                # Konversi Bounding Box ke YOLO format
                yolo_annotations: List[YOLOAnnotation] = []
                matched_classes_in_image: Set[str] = set()
                original_coco_classes: List[str] = []

                for cat_id, bbox in zip(categories, bboxes):
                    if not (0 <= cat_id < len(COCO_80_CLASSES)):
                        continue

                    raw_coco_name = COCO_80_CLASSES[cat_id]
                    cname = normalize_class_name(raw_coco_name)
                    if cname not in target_set:
                        continue

                    vx_class_id = class_registry.get_id(cname)
                    if vx_class_id is None:
                        continue

                    # COCO bbox format: [x_min, y_min, width, height]
                    if len(bbox) != 4:
                        invalid_labels += 1
                        continue

                    x_min, y_min, w, h = [float(v) for v in bbox]
                    if w <= 0 or h <= 0:
                        invalid_labels += 1
                        continue

                    # Normalisasi koordinat ke [0.0, 1.0]
                    x_center = (x_min + (w / 2.0)) / float(img_width)
                    y_center = (y_min + (h / 2.0)) / float(img_height)
                    norm_w = w / float(img_width)
                    norm_h = h / float(img_height)

                    # Clamp toleransi batas
                    x_center = max(0.0, min(1.0, x_center))
                    y_center = max(0.0, min(1.0, y_center))
                    norm_w = max(1e-4, min(1.0, norm_w))
                    norm_h = max(1e-4, min(1.0, norm_h))

                    try:
                        annot = YOLOAnnotation(
                            class_id=vx_class_id,
                            x_center=x_center,
                            y_center=y_center,
                            width=norm_w,
                            height=norm_h
                        )
                        yolo_annotations.append(annot)
                        matched_classes_in_image.add(cname)
                        original_coco_classes.append(raw_coco_name)
                        class_object_counts[cname] += 1
                    except AnnotationFormatError:
                        invalid_labels += 1

                if not yolo_annotations:
                    continue

                # Simpan image & YOLO label file
                img_filename = f"coco_{split}_{total_images + 1:06d}_{img_hash[:6]}.jpg"
                lbl_filename = f"coco_{split}_{total_images + 1:06d}_{img_hash[:6]}.txt"

                img_file_path = images_dir / img_filename
                lbl_file_path = labels_dir / lbl_filename

                with open(img_file_path, "wb") as f:
                    f.write(img_bytes)

                with open(lbl_file_path, "w", encoding="utf-8") as f:
                    for annot in yolo_annotations:
                        f.write(annot.to_line() + "\n")

                # Daftarkan hash
                known_hashes.add(img_hash)
                total_images += 1
                total_objects += len(yolo_annotations)

                # Update count per class untuk gambar ini
                for c in matched_classes_in_image:
                    class_image_counts[c] += 1

                # Catat metadata sumber
                sources_meta["items"][img_filename] = {
                    "source": "huggingface",
                    "dataset": dataset_name,
                    "split": split,
                    "original_classes": sorted(list(set(original_coco_classes))),
                    "visionx_classes": sorted(list(matched_classes_in_image)),
                    "bbox_format": "yolo_normalized (class_id x_center y_center width height)",
                    "resolution": f"{img_width}x{img_height}",
                    "license": "Creative Commons Attribution 4.0 International (CC BY 4.0)",
                    "hash_sha256": img_hash,
                    "recorded_at": datetime.now().isoformat()
                }

        # 5. Simpan metadata sumber
        with open(meta_path, "w", encoding="utf-8") as f:
            yaml.dump(sources_meta, f, default_flow_style=False, sort_keys=False)

        # 6. Validasi Dataset V0.3
        print("\n" + "=" * 60)
        print("Menjalankan Validasi Dataset VisionX V0.3...")
        print("=" * 60)
        val_report = DatasetValidator.validate(out_path, class_registry=class_registry)
        val_report.print_summary(class_registry=class_registry)

        # 7. Tampilkan Rekapitulasi Akhir
        print("\n" + "=" * 60)
        print("HuggingFace Import Summary Report")
        print("=" * 60)
        for cname in normalized_targets:
            print(f"  {cname}: {class_image_counts.get(cname, 0)}")

        print(f"\nTotal images       : {total_images}")
        print(f"Total objects      : {total_objects}")
        print(f"Invalid labels     : {invalid_labels}")
        print(f"Duplicates skipped : {duplicates_skipped}")
        print(f"Validation status  : {'PASS (100% Valid)' if val_report.is_valid else 'FAIL'}")
        print("=" * 60 + "\n")

        return {
            "total_images": total_images,
            "total_objects": total_objects,
            "invalid_labels": invalid_labels,
            "duplicates_skipped": duplicates_skipped,
            "class_image_counts": class_image_counts,
            "class_object_counts": class_object_counts,
            "is_valid": val_report.is_valid
        }


class DatasetVisualQA:
    """
    Sistem Visual QA untuk validasi anotasi YOLO dan pemetaan kelas sebelum training model.
    Merender bounding box ground-truth beserta nama kelas (tanpa confidence score)
    ke citra preview di direktori terpisah, menjamin dataset asli tidak dimodifikasi.
    """

    COLOR_PALETTE: List[Tuple[int, int, int]] = [
        (238, 104, 56),    # Biru Cyan cerah
        (50, 168, 82),     # Hijau Emerald
        (220, 150, 30),    # Biru Langit
        (60, 76, 231),     # Merah Koral
        (186, 85, 211),    # Ungu Anggrek
        (255, 140, 0),     # Oranye Amber
        (144, 238, 144),   # Hijau Muda
        (0, 215, 255),     # Kuning Emas
        (205, 92, 92),     # Indian Red
        (72, 61, 139),     # Dark Slate Blue
    ]

    @classmethod
    def get_color(cls, class_id: int) -> Tuple[int, int, int]:
        """Mendapatkan warna BGR unik berdasarkan class_id."""
        return cls.COLOR_PALETTE[class_id % len(cls.COLOR_PALETTE)]

    @classmethod
    def draw_annotations(
        cls,
        image: np.ndarray,
        annotations: List[YOLOAnnotation],
        class_registry: Optional[ClassRegistry] = None,
        draw_corners: bool = True
    ) -> np.ndarray:
        """
        Merender bounding box dan nama kelas (ground-truth) ke atas salinan citra.
        Menampilkan class name (bukan hanya class ID).
        Tidak menampilkan confidence score karena anotasi adalah ground-truth.
        Tidak memodifikasi array citra asli.
        """
        canvas = image.copy()
        img_h, img_w = canvas.shape[:2]

        for annot in annotations:
            color = cls.get_color(annot.class_id)
            x1, y1, x2, y2 = annot.to_pixel_coords(img_w, img_h)

            # 1. Bounding box utama
            cv2.rectangle(canvas, (x1, y1), (x2, y2), color, 2)

            # 2. Aksen sudut visual (modern styling)
            if draw_corners:
                corner_len = min(18, max(5, (x2 - x1) // 5), max(5, (y2 - y1) // 5))
                if corner_len > 4:
                    cv2.line(canvas, (x1, y1), (x1 + corner_len, y1), color, 4)
                    cv2.line(canvas, (x1, y1), (x1, y1 + corner_len), color, 4)
                    cv2.line(canvas, (x2, y1), (x2 - corner_len, y1), color, 4)
                    cv2.line(canvas, (x2, y1), (x2, y1 + corner_len), color, 4)
                    cv2.line(canvas, (x1, y2), (x1 + corner_len, y2), color, 4)
                    cv2.line(canvas, (x1, y2), (x1, y2 - corner_len), color, 4)
                    cv2.line(canvas, (x2, y2), (x2 - corner_len, y2), color, 4)
                    cv2.line(canvas, (x2, y2), (x2, y2 - corner_len), color, 4)

            # 3. Resolusi nama kelas dari Class Registry
            class_name = class_registry.get_name(annot.class_id) if class_registry else None
            if not class_name:
                class_name = f"class_{annot.class_id}"

            label_text = f"{class_name}"
            font_scale = 0.55
            thickness = 1
            (txt_w, txt_h), baseline = cv2.getTextSize(
                label_text, cv2.FONT_HERSHEY_SIMPLEX, font_scale, thickness
            )

            # Penempatan tag label di atas box jika muat, atau di dalam kotak jika mepet batas atas
            if y1 - txt_h - 8 >= 0:
                tag_y1 = y1 - txt_h - 8
                tag_y2 = y1
            else:
                tag_y1 = y1
                tag_y2 = min(img_h, y1 + txt_h + 8)

            tag_x1 = x1
            tag_x2 = min(img_w, x1 + txt_w + 10)

            # Background solid untuk label
            cv2.rectangle(canvas, (tag_x1, tag_y1), (tag_x2, tag_y2), color, -1)

            # Teks label warna putih
            text_baseline_y = tag_y2 - baseline - 2
            cv2.putText(
                canvas,
                label_text,
                (tag_x1 + 5, text_baseline_y),
                cv2.FONT_HERSHEY_SIMPLEX,
                font_scale,
                (255, 255, 255),
                thickness,
                cv2.LINE_AA
            )

        # 4. Badge semi-transparan Visual QA di pojok kiri atas
        overlay = canvas.copy()
        badge_w, badge_h = 250, 32
        cv2.rectangle(overlay, (10, 10), (10 + badge_w, 10 + badge_h), (25, 25, 30), -1)
        cv2.addWeighted(overlay, 0.75, canvas, 0.25, 0, canvas)
        cv2.putText(
            canvas,
            f"VisionX QA | {len(annotations)} obj | {img_w}x{img_h}",
            (18, 31),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.45,
            (220, 220, 220),
            1,
            cv2.LINE_AA
        )

        return canvas

    @classmethod
    def resolve_source(
        cls,
        source_dir: Optional[Union[str, Path]] = None,
        split: str = "train"
    ) -> Tuple[Path, List[Tuple[Path, Path]]]:
        """
        Menemukan pasangan citra dan label yang sesuai untuk split tertentu.
        Mencari secara otomatis pada beberapa lokasi default jika source_dir tidak ditentukan.
        """
        candidate_roots: List[Path] = []
        if source_dir:
            candidate_roots.append(Path(source_dir).resolve())
        else:
            # Urutan prioritas pencarian otomatis
            candidate_roots.extend([
                PROJECT_ROOT / "datasets" / "processed",
                PROJECT_ROOT / "datasets" / "raw" / "external" / "huggingface" / "benjamintli_coco2017-10k",
                PROJECT_ROOT / "datasets" / "imported",
                PROJECT_ROOT / "datasets" / "raw"
            ])
            hf_dir = PROJECT_ROOT / "datasets" / "raw" / "external" / "huggingface"
            if hf_dir.exists():
                for sub in hf_dir.iterdir():
                    if sub.is_dir() and sub not in candidate_roots:
                        candidate_roots.append(sub)

        chosen_root: Optional[Path] = None
        pairs: List[Tuple[Path, Path]] = []

        for root in candidate_roots:
            if not root.exists():
                continue

            found_pairs = cls._find_pairs_in_root(root, split=split)
            if found_pairs:
                chosen_root = root
                pairs = found_pairs
                break

        if not chosen_root or not pairs:
            # Coba pencarian tanpa filter split jika split tidak menemukan pasangan
            for root in candidate_roots:
                if not root.exists():
                    continue
                found_pairs = cls._find_pairs_in_root(root, split="all")
                if found_pairs:
                    chosen_root = root
                    pairs = found_pairs
                    logger.info(f"Split '{split}' tidak memiliki citra khusus, menggunakan {len(pairs)} citra dari: {root}")
                    break

        if not chosen_root or not pairs:
            raise DatasetError(
                f"Tidak ditemukan pasangan citra & label untuk split '{split}'. "
                f"Periksa direktori dataset atau tentukan path secara manual dengan --source."
            )

        return chosen_root, pairs

    @classmethod
    def _find_pairs_in_root(cls, root: Path, split: str = "train") -> List[Tuple[Path, Path]]:
        """Membantu pencarian pasangan citra dan label di dalam sebuah root folder."""
        pairs: List[Tuple[Path, Path]] = []
        images_dir = root / "images"
        labels_dir = root / "labels"

        # 1. Struktur terbagi subfolder: images/{split} & labels/{split}
        split_img_dir = images_dir / split
        split_lbl_dir = labels_dir / split
        if split_img_dir.exists() and split_lbl_dir.exists():
            for ipath in sorted(split_img_dir.iterdir()):
                if ipath.is_file() and ipath.suffix.lower() in SUPPORTED_IMAGE_EXTS:
                    lpath = split_lbl_dir / f"{ipath.stem}.txt"
                    if lpath.exists():
                        pairs.append((ipath, lpath))
            if pairs:
                return pairs

        # 2. Struktur folder images & labels bersamaan
        if images_dir.exists() and labels_dir.exists():
            for ipath in sorted(images_dir.iterdir()):
                if not ipath.is_file() or ipath.suffix.lower() not in SUPPORTED_IMAGE_EXTS:
                    continue
                if split != "all":
                    name_lower = ipath.name.lower()
                    if f"_{split}_" not in name_lower and not name_lower.startswith(f"{split}_") and f"{split}" not in name_lower:
                        continue
                lpath = labels_dir / f"{ipath.stem}.txt"
                if lpath.exists():
                    pairs.append((ipath, lpath))
            if pairs:
                return pairs

        # 3. Struktur dataset flat / direktori tunggal
        for ipath in sorted(root.rglob("*")):
            if not ipath.is_file() or ipath.suffix.lower() not in SUPPORTED_IMAGE_EXTS:
                continue
            if split != "all":
                name_lower = ipath.name.lower()
                if f"_{split}_" not in name_lower and not name_lower.startswith(f"{split}_") and f"{split}" not in name_lower:
                    continue
            lpath = ipath.with_suffix(".txt")
            if lpath.exists():
                pairs.append((ipath, lpath))

        return pairs

    @classmethod
    def preview(
        cls,
        source_dir: Optional[Union[str, Path]] = None,
        dest_dir: Union[str, Path] = "datasets/preview",
        split: str = "train",
        samples: int = 20,
        seed: int = 42,
        classes_path: Optional[Union[str, Path]] = "datasets/metadata/classes.yaml"
    ) -> Dict[str, Any]:
        """
        Menghasilkan preview dataset dengan bounding box YOLO yang dirender ke direktori terpisah.
        Menjamin reproducibility dengan seed, resolusi nama kelas dari class registry,
        dan tidak menyentuh dataset asli.
        """
        dest = Path(dest_dir).resolve()
        dest.mkdir(parents=True, exist_ok=True)

        # 1. Muat Class Registry
        registry: Optional[ClassRegistry] = None
        if classes_path:
            cpath = Path(classes_path)
            if not cpath.is_absolute():
                cpath = PROJECT_ROOT / cpath
            if cpath.exists():
                registry = ClassRegistry.load(cpath)
                logger.info(f"Class registry dimuat dari: {cpath}")
            else:
                logger.warning(f"File classes.yaml tidak ditemukan di {cpath}, menggunakan fallback id.")

        # 2. Temukan pasangan citra & label
        chosen_root, pairs = cls.resolve_source(source_dir=source_dir, split=split)
        total_available = len(pairs)
        logger.info(f"Ditemukan {total_available} citra pada: {chosen_root} (split: {split})")

        # 3. Sampling Reproducible
        pairs.sort(key=lambda p: p[0].name)
        rng = random.Random(seed)
        num_to_sample = min(samples, total_available)
        sampled_pairs = rng.sample(pairs, num_to_sample)
        sampled_pairs.sort(key=lambda p: p[0].name)

        # 4. Render Bounding Box & Class Name
        rendered_files: List[Path] = []
        total_objects = 0
        class_counter: Dict[str, int] = {}
        sample_meta: List[Dict[str, Any]] = []

        print("\n" + "=" * 65)
        print("VisionX Dataset Visual QA Generator")
        print("=" * 65)
        print(f"Sumber Dataset    : {chosen_root}")
        print(f"Split             : {split}")
        print(f"Total Citra Asal  : {total_available}")
        print(f"Jumlah Sampel     : {num_to_sample}")
        print(f"Random Seed       : {seed}")
        print(f"Output Direktori  : {dest}")
        print("-" * 65)

        for idx, (ipath, lpath) in enumerate(sampled_pairs, start=1):
            img = cv2.imread(str(ipath))
            if img is None:
                logger.warning(f"Gagal membaca citra: {ipath}")
                continue

            # Baca anotasi dari file label
            annotations: List[YOLOAnnotation] = []
            with open(lpath, "r", encoding="utf-8") as lf:
                for lnum, line in enumerate(lf, 1):
                    line_clean = line.strip()
                    if not line_clean:
                        continue
                    try:
                        annot = YOLOAnnotation.from_line(line_clean, line_num=lnum)
                        annotations.append(annot)
                    except AnnotationFormatError as err:
                        logger.warning(f"Anotasi invalid di {lpath.name}:{lnum}: {err}")

            # Render anotasi pada salinan citra (jangan ubah dataset asli)
            annotated_canvas = cls.draw_annotations(
                image=img,
                annotations=annotations,
                class_registry=registry
            )

            # Hitung statistik per kelas
            classes_in_sample: List[str] = []
            for a in annotations:
                cname = registry.get_name(a.class_id) if registry else f"class_{a.class_id}"
                if not cname:
                    cname = f"class_{a.class_id}"
                class_counter[cname] = class_counter.get(cname, 0) + 1
                classes_in_sample.append(cname)

            total_objects += len(annotations)

            # Simpan citra preview ke folder terpisah
            out_img_name = ipath.name
            out_path = dest / out_img_name
            cv2.imwrite(str(out_path), annotated_canvas)
            rendered_files.append(out_path)

            sample_meta.append({
                "filename": out_img_name,
                "original_path": str(ipath),
                "resolution": f"{img.shape[1]}x{img.shape[0]}",
                "object_count": len(annotations),
                "classes": sorted(list(set(classes_in_sample)))
            })

            print(f"  [{idx:02d}/{num_to_sample:02d}] {out_img_name:<32} -> {len(annotations):>2} objek {sorted(list(set(classes_in_sample)))}")

        # 5. Simpan Ringkasan QA (JSON & Markdown)
        summary_info = {
            "title": "VisionX Dataset Visual QA Report",
            "generated_at": datetime.now().isoformat(),
            "source_directory": str(chosen_root),
            "output_directory": str(dest),
            "split": split,
            "seed": seed,
            "total_available_images": total_available,
            "samples_rendered": len(rendered_files),
            "total_objects_rendered": total_objects,
            "class_distribution": class_counter,
            "samples": sample_meta
        }

        json_summary_path = dest / "summary.json"
        with open(json_summary_path, "w", encoding="utf-8") as jf:
            import json
            json.dump(summary_info, jf, indent=2)

        md_summary_path = dest / "README.md"
        with open(md_summary_path, "w", encoding="utf-8") as mf:
            mf.write("# VisionX Dataset Visual QA Preview\n\n")
            mf.write(f"- **Waktu Dibuat**: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n")
            mf.write(f"- **Sumber Dataset**: `{chosen_root}`\n")
            mf.write(f"- **Split**: `{split}`\n")
            mf.write(f"- **Seed**: `{seed}` (Reproducible)\n")
            mf.write(f"- **Jumlah Sampel**: {len(rendered_files)}\n")
            mf.write(f"- **Total Objek Dirender**: {total_objects}\n\n")
            mf.write("### Distribusi Kelas pada Sampel Visual QA:\n\n")
            mf.write("| Kelas | Jumlah Objek |\n|---|---|\n")
            for cname in sorted(class_counter.keys()):
                mf.write(f"| `{cname}` | {class_counter[cname]} |\n")
            mf.write("\n### Daftar Citra Preview:\n\n")
            mf.write("| No | Nama File | Resolusi | Objek | Kelas Terkandung |\n|---|---|---|---|---|\n")
            for i, s in enumerate(sample_meta, 1):
                c_str = ", ".join(s["classes"])
                mf.write(f"| {i} | `{s['filename']}` | {s['resolution']} | {s['object_count']} | {c_str} |\n")

        print("-" * 65)
        print("Distribusi Objek pada Sampel QA:")
        for cname, count in sorted(class_counter.items()):
            print(f"  {cname:<16}: {count} objek")
        print(f"\nTotal Sampel Berhasil Dirender : {len(rendered_files)}")
        print(f"Total Objek Dirender           : {total_objects}")
        print(f"Lokasi Hasil Preview           : {dest}")
        print(f"Laporan QA Tersimpan           : {json_summary_path}")
        print("=" * 65 + "\n")

        return summary_info


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
    Validasi Sumber -> Registrasi Kelas -> Train/Val/Test Split -> Generate dataset.yaml -> Validasi Pasca-Split -> Cetak Statistik.
    """
    print("\n" + "=" * 60)
    print("VisionX Final Dataset Preparation Pipeline")
    print("=" * 60)

    print("\n[1/6] Memvalidasi Dataset Sumber...")
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
        print("\n[2/6] Membangun Class Registry Otomatis...")
        registry = ClassRegistry()
        for cid in sorted(report.class_object_counts.keys()):
            registry.register(f"class_{cid}", class_id=cid)
        registry.save("datasets/metadata/classes.yaml")
    else:
        print(f"\n[2/6] Menggunakan Class Registry Terdaftar ({len(registry.to_dict())} kelas):")
        for cid, cname in registry.to_dict().items():
            print(f"  {cid}: {cname}")

    print(f"\n[3/6] Membagi Dataset (Train: {args.train:.1f}, Val: {args.val:.1f}, Test: {args.test:.1f}, Seed: {args.seed})...")
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

    print("\n[4/6] Membuat File dataset.yaml...")
    yaml_file = DatasetYAMLGenerator.generate(
        dest_dir=args.dest,
        class_registry=registry,
        dataset_yaml_path=Path(args.dest) / "dataset.yaml"
    )
    print(f"dataset.yaml berhasil dibuat: {yaml_file}")

    print("\n[5/6] Menjalankan Validasi Pasca-Split (Post-Split Validation)...")
    val_report = DatasetValidator.validate(args.dest, class_registry=registry)
    if not val_report.is_valid:
        print("\n[ERROR] Validasi pasca-split gagal! Ditemukan anomali pada hasil split.")
        val_report.print_summary(class_registry=registry)
        return 1
    print("Validasi Pasca-Split: PASSED (100% Valid, tanpa error/anomali).")

    # Verifikasi ketat integritas split individual
    dest_path = Path(args.dest).resolve()
    train_imgs = {p.name for p in (dest_path / "images" / "train").glob("*") if p.is_file()}
    val_imgs = {p.name for p in (dest_path / "images" / "val").glob("*") if p.is_file()}
    test_imgs = {p.name for p in (dest_path / "images" / "test").glob("*") if p.is_file()}

    assert len(train_imgs & val_imgs) == 0, "Leakage terdeteksi antara Train dan Val!"
    assert len(train_imgs & test_imgs) == 0, "Leakage terdeteksi antara Train dan Test!"
    assert len(val_imgs & test_imgs) == 0, "Leakage terdeteksi antara Val dan Test!"
    print("Verifikasi Anti-Leakage: PASSED (0% citra beririsan antar partisi).")

    print("\n[6/6] Statistik Lengkap Dataset Final:")
    stats = DatasetStats.calculate(args.dest)
    DatasetStats.print_stats(args.dest)

    # Simpan dokumentasi README di processed directory
    readme_path = dest_path / "README.md"
    with open(readme_path, "w", encoding="utf-8") as rf:
        rf.write("# VisionX Processed Dataset (V0.3 Final)\n\n")
        rf.write(f"- **Terakhir Diproses**: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n")
        rf.write(f"- **Sumber**: `{args.source}`\n")
        rf.write(f"- **Seed**: `{args.seed}`\n")
        rf.write(f"- **Total Citra**: {stats['total_images']}\n")
        rf.write(f"- **Total Objek**: {stats['total_objects']}\n\n")
        rf.write("### Partisi Dataset:\n\n")
        rf.write("| Split | Jumlah Citra | Rasio | Jumlah Objek |\n|---|---|---|---|\n")
        for sp in ["train", "val", "test"]:
            im_cnt = stats['split_counts'][sp]
            ob_cnt = stats['split_object_counts'][sp]
            pct = (im_cnt / stats['total_images'] * 100) if stats['total_images'] else 0
            rf.write(f"| `{sp}` | {im_cnt} | {pct:.1f}% | {ob_cnt} |\n")
        rf.write("\n### Distribusi Kelas:\n\n")
        rf.write("| ID | Nama Kelas | Jumlah Objek | Jumlah Citra |\n|---|---|---|---|\n")
        for cid, cname in registry.to_dict().items():
            objs = stats["objects_per_class"].get(cname, 0)
            imgs = stats["images_per_class"].get(cname, 0)
            rf.write(f"| {cid} | `{cname}` | {objs} | {imgs} |\n")
        rf.write("\n### File Konfigurasi YOLO:\n")
        rf.write(f"- [`dataset.yaml`](dataset.yaml)\n")

    print(f"Dataset final siap digunakan untuk training YOLO: {args.dest}\n")
    return 0



def cmd_import(args: argparse.Namespace) -> int:
    count = DatasetImporter.import_pairs(args.source, args.dest)
    print(f"Selesai mengimpor {count} pasang citra & label ke {args.dest}.")
    return 0


def cmd_import_hf(args: argparse.Namespace) -> int:
    output_dir = args.output_dir or f"datasets/raw/external/huggingface/{args.dataset.replace('/', '_')}"
    res = HuggingFaceDatasetImporter.import_subset(
        dataset_name=args.dataset,
        split=args.split,
        target_classes=args.classes,
        max_per_class=args.max_per_class,
        output_dir=output_dir
    )
    return 0 if res["is_valid"] else 1


def cmd_preview(args: argparse.Namespace) -> int:
    """Handler CLI untuk visual QA dataset preview."""
    try:
        summary = DatasetVisualQA.preview(
            source_dir=args.source,
            dest_dir=args.dest,
            split=args.split,
            samples=args.samples,
            seed=args.seed,
            classes_path=args.classes
        )
        return 0 if summary.get("samples_rendered", 0) > 0 else 1
    except Exception as e:
        print(f"\n[ERROR] Gagal membuat visual QA preview: {e}")
        logger.error("Error pada cmd_preview", exc_info=True)
        return 1


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
    p_prep.add_argument("--source", type=str, default="datasets/raw/external/huggingface/benjamintli_coco2017-10k", help="Direktori dataset sumber")
    p_prep.add_argument("--dest", type=str, default="datasets/processed", help="Direktori output")
    p_prep.add_argument("--classes", type=str, default="datasets/metadata/classes.yaml", help="File classes.yaml (opsional)")
    p_prep.add_argument("--train", type=float, default=0.8, help="Rasio train")
    p_prep.add_argument("--val", type=float, default=0.1, help="Rasio val")
    p_prep.add_argument("--test", type=float, default=0.1, help="Rasio test")
    p_prep.add_argument("--seed", type=int, default=42, help="Random seed")
    p_prep.add_argument("--allow-leakage", action="store_true", help="Nonaktifkan anti-leakage grouping")


    # Subcommand: import
    p_imp = subparsers.add_parser("import", help="Impor pasangan gambar & teks ke direktori staging")
    p_imp.add_argument("--source", type=str, required=True, help="Direktori asal dataset")
    p_imp.add_argument("--dest", type=str, default="datasets/imported", help="Direktori tujuan")

    # Subcommand: import-hf
    p_imphf = subparsers.add_parser("import-hf", help="Impor subset dataset dari HuggingFace (COCO format)")
    p_imphf.add_argument("--dataset", type=str, default="benjamintli/coco2017-10k", help="Nama repository dataset HuggingFace")
    p_imphf.add_argument("--split", type=str, default="train", help="Split dataset (train, validation, test)")
    p_imphf.add_argument("--classes", nargs="+", default=DEFAULT_TARGET_CLASSES, help="Daftar target class yang ingin diimpor")
    p_imphf.add_argument("--max-per-class", type=int, default=100, help="Batas maksimum jumlah citra per kelas")
    p_imphf.add_argument("--output-dir", type=str, default=None, help="Direktori tujuan penyimpanan dataset")

    # Subcommand: preview (Visual QA)
    p_prev = subparsers.add_parser("preview", help="Visual QA: Render bounding box YOLO ke gambar preview terpisah")
    p_prev.add_argument("--source", type=str, default=None, help="Direktori dataset sumber (otomatis mencari jika tidak diisi)")
    p_prev.add_argument("--dest", "--output-dir", dest="dest", type=str, default="datasets/preview", help="Direktori output preview visual QA")
    p_prev.add_argument("--split", type=str, default="train", help="Split dataset yang akan di-preview (train, val, test, all)")
    p_prev.add_argument("--samples", "-n", type=int, default=20, help="Jumlah sampel gambar yang akan dirender")
    p_prev.add_argument("--seed", type=int, default=42, help="Random seed untuk sampling reproducible")
    p_prev.add_argument("--classes", type=str, default="datasets/metadata/classes.yaml", help="File class registry YAML")

    args = parser.parse_args()

    if not args.subcommand:
        parser.print_help()
        sys.exit(0)

    handlers = {
        "validate": cmd_validate,
        "split": cmd_split,
        "stats": cmd_stats,
        "prepare": cmd_prepare,
        "import": cmd_import,
        "import-hf": cmd_import_hf,
        "preview": cmd_preview
    }

    exit_code = handlers[args.subcommand](args)
    sys.exit(exit_code)



if __name__ == "__main__":
    main()

