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
    DatasetVisualQA,
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
        self.assertEqual(stats["split_counts"]["train"], 3)
        self.assertEqual(stats["split_counts"]["val"], 1)
        self.assertEqual(stats["split_counts"]["test"], 1)
        self.assertEqual(stats["split_object_counts"]["train"], 6)
        self.assertEqual(stats["split_object_counts"]["val"], 2)
        self.assertEqual(stats["split_object_counts"]["test"], 2)

    def test_split_anti_leakage_and_clean_destination(self):
        """Uji anti-leakage dan tidak ada citra yang beririsan antar train/val/test."""
        for i in range(20):
            self._create_sample_image(f"item_{i:02d}.jpg", (50, 50, 50))
            self._create_sample_label(f"item_{i:02d}.txt", "0 0.5 0.5 0.2 0.2")

        report = DatasetValidator.validate(self.src_dir)
        counts = DatasetSplitter.split(
            valid_pairs=report.valid_pairs,
            dest_dir=self.dest_dir,
            train_ratio=0.8,
            val_ratio=0.1,
            test_ratio=0.1,
            seed=42
        )
        self.assertEqual(counts["train"], 16)
        self.assertEqual(counts["val"], 2)
        self.assertEqual(counts["test"], 2)

        train_imgs = {p.name for p in (self.dest_dir / "images" / "train").glob("*.jpg")}
        val_imgs = {p.name for p in (self.dest_dir / "images" / "val").glob("*.jpg")}
        test_imgs = {p.name for p in (self.dest_dir / "images" / "test").glob("*.jpg")}

        # Tidak ada citra yang beririsan
        self.assertEqual(len(train_imgs & val_imgs), 0)
        self.assertEqual(len(train_imgs & test_imgs), 0)
        self.assertEqual(len(val_imgs & test_imgs), 0)
        self.assertEqual(len(train_imgs | val_imgs | test_imgs), 20)



class TestYOLOCoordinateConversion(unittest.TestCase):
    """Pengujian akurasi konversi koordinat YOLO (normalisasi) <-> Pixel."""

    def test_to_pixel_coords_centered_box(self):
        """Uji konversi bounding box di tengah gambar."""
        # Gambar 640x480, box di tengah (xc=0.5, yc=0.5, w=0.5, h=0.5)
        annot = YOLOAnnotation(class_id=0, x_center=0.5, y_center=0.5, width=0.5, height=0.5)
        x1, y1, x2, y2 = annot.to_pixel_coords(img_width=640, img_height=480)

        self.assertEqual(x1, 160)
        self.assertEqual(y1, 120)
        self.assertEqual(x2, 480)
        self.assertEqual(y2, 360)

    def test_to_pixel_coords_boundary_clamping(self):
        """Uji clamping koordinat di tepi citra."""
        # Box penuh mencakup seluruh gambar
        annot = YOLOAnnotation(class_id=1, x_center=0.5, y_center=0.5, width=1.0, height=1.0)
        x1, y1, x2, y2 = annot.to_pixel_coords(img_width=100, img_height=200)

        self.assertEqual(x1, 0)
        self.assertEqual(y1, 0)
        self.assertEqual(x2, 100)
        self.assertEqual(y2, 200)

    def test_from_pixel_coords_and_roundtrip(self):
        """Uji konversi dua arah (pixel -> yolo -> pixel) konsisten."""
        img_w, img_h = 800, 600
        x1_in, y1_in, x2_in, y2_in = 100, 150, 500, 450

        annot = YOLOAnnotation.from_pixel_coords(
            class_id=3,
            x1=x1_in,
            y1=y1_in,
            x2=x2_in,
            y2=y2_in,
            img_width=img_w,
            img_height=img_h
        )

        self.assertEqual(annot.class_id, 3)
        self.assertAlmostEqual(annot.x_center, 300.0 / 800.0)
        self.assertAlmostEqual(annot.y_center, 300.0 / 600.0)
        self.assertAlmostEqual(annot.width, 400.0 / 800.0)
        self.assertAlmostEqual(annot.height, 300.0 / 600.0)

        # Konversi kembali ke pixel
        x1_out, y1_out, x2_out, y2_out = annot.to_pixel_coords(img_w, img_h)
        self.assertEqual(x1_out, x1_in)
        self.assertEqual(y1_out, y1_in)
        self.assertEqual(x2_out, x2_in)
        self.assertEqual(y2_out, y2_in)

    def test_invalid_dimensions(self):
        """Uji penolakan dimensi citra non-positif."""
        annot = YOLOAnnotation(class_id=0, x_center=0.5, y_center=0.5, width=0.2, height=0.2)
        with self.assertRaises(ValueError):
            annot.to_pixel_coords(img_width=0, img_height=100)
        with self.assertRaises(ValueError):
            YOLOAnnotation.from_pixel_coords(0, 10, 10, 50, 50, img_width=-100, img_height=100)


class TestDatasetVisualQA(unittest.TestCase):
    """Pengujian modul DatasetVisualQA: rendering, integritas citra asli, dan reproducibility."""

    def setUp(self):
        self.temp_dir = Path(tempfile.mkdtemp(prefix="vx_test_qa_"))
        self.src_dir = self.temp_dir / "src_dataset"
        self.dest_dir = self.temp_dir / "preview"
        self.src_dir.mkdir(parents=True)

    def tearDown(self):
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def _create_sample(self, name: str, annotations: str, color=(80, 80, 80)):
        img_path = self.src_dir / f"{name}.jpg"
        lbl_path = self.src_dir / f"{name}.txt"
        img = np.full((120, 160, 3), color, dtype=np.uint8)
        cv2.imwrite(str(img_path), img)
        with open(lbl_path, "w", encoding="utf-8") as f:
            f.write(annotations)
        return img_path, lbl_path

    def test_draw_annotations_preserves_original_image(self):
        """Uji bahwa citra asli tidak pernah termodifikasi saat rendering."""
        orig_img = np.zeros((100, 100, 3), dtype=np.uint8)
        orig_hash = orig_img.copy()

        annots = [
            YOLOAnnotation(class_id=0, x_center=0.5, y_center=0.5, width=0.4, height=0.4)
        ]
        registry = ClassRegistry({0: "person"})

        rendered = DatasetVisualQA.draw_annotations(orig_img, annots, class_registry=registry)

        # Citra asli tetap 0 semua (tidak tersentuh)
        self.assertTrue(np.all(orig_img == 0))
        self.assertTrue(np.array_equal(orig_img, orig_hash))

        # Citra hasil render memiliki bounding box & teks yang digambar
        self.assertFalse(np.all(rendered == 0))

    def test_class_name_displayed_not_just_id(self):
        """Uji bahwa nama kelas diambil dari ClassRegistry, bukan hanya ID."""
        registry = ClassRegistry({0: "person", 1: "laptop"})
        img = np.full((200, 200, 3), 50, dtype=np.uint8)
        annots = [
            YOLOAnnotation(class_id=0, x_center=0.3, y_center=0.3, width=0.2, height=0.2),
            YOLOAnnotation(class_id=1, x_center=0.7, y_center=0.7, width=0.2, height=0.2)
        ]

        rendered = DatasetVisualQA.draw_annotations(img, annots, class_registry=registry)
        self.assertIsNotNone(rendered)
        self.assertEqual(rendered.shape, img.shape)

    def test_reproducible_sampling_with_seed(self):
        """Uji bahwa sampling dengan random seed yang sama selalu menghasilkan citra identik."""
        # Buat 10 file citra & label
        for i in range(10):
            self._create_sample(f"train_img_{i:02d}", f"0 0.5 0.5 0.2 0.2")

        dest1 = self.temp_dir / "preview1"
        dest2 = self.temp_dir / "preview2"
        dest3 = self.temp_dir / "preview3"

        res1 = DatasetVisualQA.preview(
            source_dir=self.src_dir,
            dest_dir=dest1,
            split="train",
            samples=4,
            seed=42
        )
        res2 = DatasetVisualQA.preview(
            source_dir=self.src_dir,
            dest_dir=dest2,
            split="train",
            samples=4,
            seed=42
        )
        res3 = DatasetVisualQA.preview(
            source_dir=self.src_dir,
            dest_dir=dest3,
            split="train",
            samples=4,
            seed=999
        )

        files1 = [s["filename"] for s in res1["samples"]]
        files2 = [s["filename"] for s in res2["samples"]]
        files3 = [s["filename"] for s in res3["samples"]]

        # Seed 42 menghasilkan daftar sampel yang 100% identik
        self.assertEqual(files1, files2)
        # Seed berbeda menghasilkan sampling yang berbeda
        self.assertNotEqual(files1, files3)

    def test_full_preview_generation_and_summary_files(self):
        """Uji proses lengkap preview: membuat file preview, summary.json, dan README.md."""
        for i in range(5):
            self._create_sample(f"coco_train_{i:04d}", f"0 0.5 0.5 0.3 0.3\n1 0.2 0.2 0.1 0.1")

        classes_file = self.temp_dir / "classes.yaml"
        registry = ClassRegistry({0: "person", 1: "bottle"})
        registry.save(classes_file)

        summary = DatasetVisualQA.preview(
            source_dir=self.src_dir,
            dest_dir=self.dest_dir,
            split="train",
            samples=3,
            seed=123,
            classes_path=classes_file
        )

        self.assertEqual(summary["samples_rendered"], 3)
        self.assertEqual(summary["total_objects_rendered"], 6)  # 2 per gambar x 3
        self.assertEqual(summary["class_distribution"]["person"], 3)
        self.assertEqual(summary["class_distribution"]["bottle"], 3)

        # Verifikasi file ada di direktori preview
        rendered_images = list(self.dest_dir.glob("*.jpg"))
        self.assertEqual(len(rendered_images), 3)

        summary_json = self.dest_dir / "summary.json"
        readme_md = self.dest_dir / "README.md"
        self.assertTrue(summary_json.exists())
        self.assertTrue(readme_md.exists())

        # Pastikan dataset asli tidak termodifikasi
        original_images = list(self.src_dir.glob("*.jpg"))
        self.assertEqual(len(original_images), 5)


if __name__ == "__main__":
    unittest.main()

