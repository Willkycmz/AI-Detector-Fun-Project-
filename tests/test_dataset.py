"""
Unit tests for VisionX V0.3 Dataset Preparation Pipeline (app/dataset.py).
"""

import unittest
import shutil
import tempfile
from pathlib import Path
import numpy as np
import cv2
import yaml

from app.dataset import (
    YOLOAnnotation,
    ClassRegistry,
    DatasetValidator,
    DatasetSplitter,
    DatasetYAMLGenerator,
    DatasetStats,
    AnnotationFormatError
)


class TestYOLOAnnotation(unittest.TestCase):

    def test_valid_annotation(self):
        """Uji parsing baris anotasi YOLO yang valid."""
        line = "0 0.500000 0.500000 0.200000 0.400000"
        annot = YOLOAnnotation.from_line(line)
        self.assertEqual(annot.class_id, 0)
        self.assertAlmostEqual(annot.x_center, 0.5)
        self.assertAlmostEqual(annot.y_center, 0.5)
        self.assertAlmostEqual(annot.width, 0.2)
        self.assertAlmostEqual(annot.height, 0.4)
        self.assertEqual(annot.to_line(), "0 0.500000 0.500000 0.200000 0.400000")

    def test_invalid_tokens_count(self):
        """Uji penolakan baris dengan jumlah token tidak sama dengan 5."""
        with self.assertRaises(AnnotationFormatError):
            YOLOAnnotation.from_line("0 0.5 0.5 0.2")  # Hanya 4 token
        with self.assertRaises(AnnotationFormatError):
            YOLOAnnotation.from_line("0 0.5 0.5 0.2 0.3 0.9")  # 6 token
        with self.assertRaises(AnnotationFormatError):
            YOLOAnnotation.from_line("")  # Kosong

    def test_invalid_class_id(self):
        """Uji penolakan class_id non-integer atau negatif."""
        with self.assertRaises(AnnotationFormatError):
            YOLOAnnotation.from_line("abc 0.5 0.5 0.2 0.2")
        with self.assertRaises(AnnotationFormatError):
            YOLOAnnotation.from_line("-1 0.5 0.5 0.2 0.2")

    def test_coordinates_out_of_bounds(self):
        """Uji penolakan koordinat di luar rentang normalisasi [0.0, 1.0]."""
        with self.assertRaises(AnnotationFormatError):
            YOLOAnnotation.from_line("0 1.5 0.5 0.2 0.2")  # x_center > 1
        with self.assertRaises(AnnotationFormatError):
            YOLOAnnotation.from_line("0 -0.1 0.5 0.2 0.2")  # x_center < 0
        with self.assertRaises(AnnotationFormatError):
            YOLOAnnotation.from_line("0 0.5 0.5 0.0 0.2")  # width == 0

    def test_bounding_box_overflow(self):
        """Uji penolakan jika batas kotak pembatas melampaui batas tepi gambar."""
        # x_center=0.9, width=0.4 -> x_max = 1.1 (melebihi 1.0)
        with self.assertRaises(AnnotationFormatError):
            YOLOAnnotation.from_line("0 0.900000 0.500000 0.400000 0.200000")


class TestClassRegistry(unittest.TestCase):

    def test_registration_and_persistence(self):
        """Uji konsistensi mapping nama <-> ID."""
        reg = ClassRegistry()
        id_glass = reg.register("glass")
        id_bottle = reg.register("bottle")
        id_charger = reg.register("charger")

        self.assertEqual(id_glass, 0)
        self.assertEqual(id_bottle, 1)
        self.assertEqual(id_charger, 2)

        # Mendaftar ulang nama yang sama harus mengembalikan ID yang sama
        self.assertEqual(reg.register("glass"), 0)
        self.assertEqual(reg.get_id("bottle"), 1)
        self.assertEqual(reg.get_name(2), "charger")

    def test_save_and_load_yaml(self):
        """Uji penyimpanan ke YAML dan pembacaan kembali."""
        temp_dir = tempfile.mkdtemp()
        yaml_file = Path(temp_dir) / "test_classes.yaml"
        try:
            reg = ClassRegistry.from_list(["cat", "dog", "bird"])
            reg.save(yaml_file)

            loaded = ClassRegistry.load(yaml_file)
            self.assertEqual(loaded.get_id("cat"), 0)
            self.assertEqual(loaded.get_id("dog"), 1)
            self.assertEqual(loaded.get_id("bird"), 2)
            self.assertEqual(loaded.get_name(1), "dog")
        finally:
            shutil.rmtree(temp_dir, ignore_errors=True)


class TestDatasetValidatorAndSplitter(unittest.TestCase):

    def setUp(self):
        self.temp_dir = Path(tempfile.mkdtemp(prefix="vx_test_dataset_"))
        self.src_dir = self.temp_dir / "raw_annotated"
        self.dest_dir = self.temp_dir / "processed"
        self.src_dir.mkdir(parents=True)

    def tearDown(self):
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def _create_sample_image(self, name: str, color=(100, 150, 200)) -> Path:
        img_path = self.src_dir / name
        img = np.full((100, 100, 3), color, dtype=np.uint8)
        cv2.imwrite(str(img_path), img)
        return img_path

    def _create_sample_label(self, name: str, content: str) -> Path:
        lbl_path = self.src_dir / name
        with open(lbl_path, "w", encoding="utf-8") as f:
            f.write(content)
        return lbl_path

    def test_validator_with_valid_and_invalid_data(self):
        """Uji validator menemukan missing labels, orphaned labels, dan corrupted annotations."""
        # 1. Pasangan valid
        self._create_sample_image("img1.jpg", (50, 50, 50))
        self._create_sample_label("img1.txt", "0 0.5 0.5 0.3 0.3\n1 0.2 0.2 0.1 0.1")

        # 2. Gambar tanpa label (missing label)
        self._create_sample_image("img2.jpg", (70, 70, 70))

        # 3. Label tanpa gambar (orphaned label)
        self._create_sample_label("img3.txt", "0 0.4 0.4 0.2 0.2")

        # 4. Label dengan anotasi invalid
        self._create_sample_image("img4.jpg", (90, 90, 90))
        self._create_sample_label("img4.txt", "0 0.9 0.9 0.4 0.4")  # overflow boundary

        # Jalankan validasi
        registry = ClassRegistry({0: "glass", 1: "bottle"})
        report = DatasetValidator.validate(self.src_dir, class_registry=registry)

        self.assertEqual(len(report.valid_pairs), 1)
        self.assertEqual(len(report.missing_labels), 1)
        self.assertEqual(len(report.orphaned_labels), 1)
        self.assertEqual(len(report.invalid_annotations), 1)
        self.assertFalse(report.is_valid)

    def test_splitter_reproducibility_and_leakage(self):
        """Uji pembagian train/val/test reproducible dan perlindungan leakage."""
        # Buat 10 pasangan valid
        for i in range(10):
            self._create_sample_image(f"sample_{i:02d}.jpg", (i * 20, 100, 100))
            self._create_sample_label(f"sample_{i:02d}.txt", f"0 0.5 0.5 0.2 0.2")

        report = DatasetValidator.validate(self.src_dir)
        self.assertTrue(report.is_valid)
        self.assertEqual(len(report.valid_pairs), 10)

        # Split 80 / 10 / 10
        counts1 = DatasetSplitter.split(
            valid_pairs=report.valid_pairs,
            dest_dir=self.dest_dir,
            train_ratio=0.8,
            val_ratio=0.1,
            test_ratio=0.1,
            seed=123
        )
        self.assertEqual(counts1["train"], 8)
        self.assertEqual(counts1["val"], 1)
        self.assertEqual(counts1["test"], 1)

        # Verifikasi folder dan file ada di disk
        train_imgs = list((self.dest_dir / "images" / "train").glob("*.jpg"))
        self.assertEqual(len(train_imgs), 8)

    def test_yaml_generation_and_stats(self):
        """Uji pembuatan dataset.yaml dan perhitungan statistik."""
        for i in range(5):
            self._create_sample_image(f"item_{i}.jpg", (50, 50, 50))
            self._create_sample_label(f"item_{i}.txt", "0 0.5 0.5 0.2 0.2\n1 0.3 0.3 0.1 0.1")

        report = DatasetValidator.validate(self.src_dir)
        registry = ClassRegistry({0: "glass", 1: "bottle"})

        DatasetSplitter.split(
            valid_pairs=report.valid_pairs,
            dest_dir=self.dest_dir,
            train_ratio=0.6,
            val_ratio=0.2,
            test_ratio=0.2,
            seed=42
        )

        yaml_path = DatasetYAMLGenerator.generate(self.dest_dir, class_registry=registry)
        self.assertTrue(yaml_path.exists())

        # Cek isi dataset.yaml
        with open(yaml_path, "r", encoding="utf-8") as yf:
            cfg = yaml.safe_load(yf)
        self.assertIn("names", cfg)
        self.assertEqual(cfg["names"][0], "glass")
        self.assertEqual(cfg["names"][1], "bottle")

        # Cek kalkulasi statistik
        stats = DatasetStats.calculate(self.dest_dir)
        self.assertEqual(stats["total_images"], 5)
        self.assertEqual(stats["total_objects"], 10)  # 2 objek per gambar x 5


if __name__ == "__main__":
    unittest.main()
