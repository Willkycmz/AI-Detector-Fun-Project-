"""
Unit tests for DatasetCollector and validate_class_name in app/collector.py.
Covers V0.2, V0.4, and V0.4.1 Dataset Management (Delete, Import, Deduplication, Metadata).
"""

import unittest
import shutil
import tempfile
from pathlib import Path
import numpy as np
import cv2
import yaml

from app.collector import (
    validate_class_name,
    DatasetCollector,
    InvalidClassNameError,
    DatasetSaveError,
    DuplicateImageError,
    compute_image_hash
)


class TestDatasetCollector(unittest.TestCase):

    def setUp(self):
        """Membuat direktori temporer khusus untuk isolasi pengujian."""
        self.test_dir = tempfile.mkdtemp(prefix="visionx_test_datasets_")
        self.metadata_file = Path(self.test_dir) / "metadata" / "sources.yaml"

    def tearDown(self):
        """Membersihkan direktori temporer setelah pengujian."""
        shutil.rmtree(self.test_dir, ignore_errors=True)

    def test_validate_class_name_valid(self):
        """Uji berbagai nama kelas yang valid."""
        self.assertEqual(validate_class_name("bottle"), "bottle")
        self.assertEqual(validate_class_name("Water Bottle"), "water_bottle")
        self.assertEqual(validate_class_name("  glass_cup  "), "glass_cup")
        self.assertEqual(validate_class_name("USB-C_Charger_01"), "usb-c_charger_01")

    def test_validate_class_name_invalid(self):
        """Uji penolakan nama kelas ilegal atau terlarang."""
        # String kosong / spasi
        with self.assertRaises(InvalidClassNameError):
            validate_class_name("")
        with self.assertRaises(InvalidClassNameError):
            validate_class_name("   ")

        # Karakter terlarang
        with self.assertRaises(InvalidClassNameError):
            validate_class_name("bottle/glass")
        with self.assertRaises(InvalidClassNameError):
            validate_class_name("object*1")
        with self.assertRaises(InvalidClassNameError):
            validate_class_name("item:box")

        # Nama sistem reserved Windows
        with self.assertRaises(InvalidClassNameError):
            validate_class_name("con")
        with self.assertRaises(InvalidClassNameError):
            validate_class_name("NUL")
        with self.assertRaises(InvalidClassNameError):
            validate_class_name("aux")
        with self.assertRaises(InvalidClassNameError):
            validate_class_name("com1")

    def test_collector_save_image_and_count(self):
        """Uji penyimpanan citra mentah, keunikan nama file, dan penghitungan."""
        collector = DatasetCollector(
            base_dir=self.test_dir,
            current_class="glass",
            metadata_file=str(self.metadata_file)
        )
        self.assertEqual(collector.get_count(), 0)

        # Buat dummy image 1 & 2 (berbeda isi)
        frame1 = np.full((120, 160, 3), 100, dtype=np.uint8)
        frame2 = np.full((120, 160, 3), 200, dtype=np.uint8)

        # Simpan gambar pertama
        path1 = collector.save_image(frame1)
        self.assertTrue(path1.exists())
        self.assertEqual(collector.get_count(), 1)
        self.assertTrue(path1.name.startswith("glass_"))

        # Simpan gambar kedua (harus menghasilkan file berbeda, tidak boleh menimpa)
        path2 = collector.save_image(frame2)
        self.assertTrue(path2.exists())
        self.assertNotEqual(path1.name, path2.name)
        self.assertEqual(collector.get_count(), 2)

        # Verifikasi citra yang disimpan dapat dibaca kembali oleh OpenCV
        loaded_img = cv2.imread(str(path1))
        self.assertIsNotNone(loaded_img)
        self.assertEqual(loaded_img.shape, (120, 160, 3))

    def test_duplicate_prevention(self):
        """Uji penolakan citra duplikat (SHA-256 hash)."""
        collector = DatasetCollector(base_dir=self.test_dir, current_class="bottle", enable_deduplication=True)
        frame = np.full((100, 100, 3), 150, dtype=np.uint8)

        # Simpan frame pertama berhasil
        path1 = collector.save_image(frame)
        self.assertTrue(path1.exists())
        self.assertEqual(collector.get_count(), 1)

        # Simpan frame identik kedua harus melempar DuplicateImageError
        with self.assertRaises(DuplicateImageError):
            collector.save_image(frame, check_duplicate=True)

        # Counter tidak boleh bertambah
        self.assertEqual(collector.get_count(), 1)

    def test_delete_single_and_multi_image(self):
        """Uji penghapusan satu gambar dan multi-gambar."""
        collector = DatasetCollector(base_dir=self.test_dir, current_class="glass")
        frame1 = np.full((80, 80, 3), 10, dtype=np.uint8)
        frame2 = np.full((80, 80, 3), 20, dtype=np.uint8)
        frame3 = np.full((80, 80, 3), 30, dtype=np.uint8)

        p1 = collector.save_image(frame1)
        p2 = collector.save_image(frame2)
        p3 = collector.save_image(frame3)
        self.assertEqual(collector.get_count(), 3)

        # Hapus 1 gambar
        success = collector.delete_image(p1)
        self.assertTrue(success)
        self.assertFalse(p1.exists())
        self.assertEqual(collector.get_count(), 2)

        # Multi-delete sisa gambar
        deleted = collector.delete_images([p2, p3])
        self.assertEqual(deleted, 2)
        self.assertEqual(collector.get_count(), 0)

    def test_import_single_image(self):
        """Uji impor file citra dari PC ke target class dataset."""
        collector = DatasetCollector(base_dir=self.test_dir, current_class="charger")

        # Buat file gambar sumber di luar folder dataset
        ext_dir = Path(self.test_dir) / "temp_external"
        ext_dir.mkdir(parents=True, exist_ok=True)
        sample_img_path = ext_dir / "sample_charger.jpg"
        cv2.imwrite(str(sample_img_path), np.full((100, 100, 3), 55, dtype=np.uint8))

        imported_path = collector.import_image(sample_img_path, target_class="charger", source="own_import")
        self.assertTrue(imported_path.exists())
        self.assertEqual(collector.get_count(), 1)
        self.assertTrue(imported_path.name.startswith("charger_import_"))

    def test_import_folder(self):
        """Uji impor folder berisi beberapa gambar ke target class."""
        collector = DatasetCollector(base_dir=self.test_dir, current_class="bottle")

        # Buat folder sumber berisi 3 gambar unik dan 1 file non-gambar
        ext_dir = Path(self.test_dir) / "source_folder"
        ext_dir.mkdir(parents=True, exist_ok=True)
        for i in range(3):
            cv2.imwrite(str(ext_dir / f"img_{i}.png"), np.full((80, 80, 3), i * 50 + 10, dtype=np.uint8))
        (ext_dir / "readme.txt").write_text("dummy text file")

        result = collector.import_folder(ext_dir, target_class="bottle", source="own_import")
        self.assertEqual(result["imported"], 3)
        self.assertEqual(result["skipped"], 0)
        self.assertEqual(collector.get_count(), 3)

    def test_source_metadata_logging(self):
        """Uji pencatatan metadata sumber ke sources.yaml."""
        collector = DatasetCollector(
            base_dir=self.test_dir,
            current_class="glass",
            metadata_file=str(self.metadata_file)
        )
        frame = np.full((100, 100, 3), 77, dtype=np.uint8)
        p = collector.save_image(frame, source="own_capture")

        self.assertTrue(self.metadata_file.exists())
        with open(self.metadata_file, "r", encoding="utf-8") as f:
            meta = yaml.safe_load(f)

        self.assertIn("items", meta)
        self.assertIn(p.name, meta["items"])
        self.assertEqual(meta["items"][p.name]["class"], "glass")
        self.assertEqual(meta["items"][p.name]["source"], "own_capture")

    def test_switch_class_without_restart(self):
        """Uji pergantian kelas aktif di runtime tanpa restart."""
        collector = DatasetCollector(base_dir=self.test_dir, current_class="bottle")
        f1 = np.full((100, 100, 3), 10, dtype=np.uint8)
        f2 = np.full((100, 100, 3), 20, dtype=np.uint8)

        # Simpan 2 gambar di kelas 'bottle'
        collector.save_image(f1)
        collector.save_image(f2)
        self.assertEqual(collector.get_count(), 2)

        # Ganti kelas ke 'charger'
        collector.set_class("charger")
        self.assertEqual(collector.current_class, "charger")
        self.assertEqual(collector.get_count(), 0)

        # Simpan 1 gambar di kelas 'charger'
        f3 = np.full((100, 100, 3), 30, dtype=np.uint8)
        collector.save_image(f3)
        self.assertEqual(collector.get_count(), 1)

        # Beralih kembali ke 'bottle', counter harus tetap 2
        collector.set_class("bottle")
        self.assertEqual(collector.get_count(), 2)

        # Verifikasi folder classes
        classes = collector.list_classes()
        self.assertIn("bottle", classes)
        self.assertIn("charger", classes)

    def test_save_empty_frame_raises_error(self):
        """Uji proteksi saat frame kosong / corrupt."""
        collector = DatasetCollector(base_dir=self.test_dir, current_class="test_obj")
        with self.assertRaises(DatasetSaveError):
            collector.save_image(np.array([]))


if __name__ == "__main__":
    unittest.main()
