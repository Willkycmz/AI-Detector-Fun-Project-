"""
Unit tests for DatasetCollector and validate_class_name in app/collector.py.
"""

import unittest
import shutil
import tempfile
from pathlib import Path
import numpy as np
import cv2

from app.collector import (
    validate_class_name,
    DatasetCollector,
    InvalidClassNameError,
    DatasetSaveError
)


class TestDatasetCollector(unittest.TestCase):

    def setUp(self):
        """Membuat direktori temporer khusus untuk isolasi pengujian."""
        self.test_dir = tempfile.mkdtemp(prefix="visionx_test_datasets_")

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
        collector = DatasetCollector(base_dir=self.test_dir, current_class="glass")
        self.assertEqual(collector.get_count(), 0)

        # Buat dummy image
        dummy_frame = np.full((120, 160, 3), 128, dtype=np.uint8)

        # Simpan gambar pertama
        path1 = collector.save_image(dummy_frame)
        self.assertTrue(path1.exists())
        self.assertEqual(collector.get_count(), 1)
        self.assertTrue(path1.name.startswith("glass_"))

        # Simpan gambar kedua (harus menghasilkan file berbeda, tidak boleh menimpa)
        path2 = collector.save_image(dummy_frame)
        self.assertTrue(path2.exists())
        self.assertNotEqual(path1.name, path2.name)
        self.assertEqual(collector.get_count(), 2)

        # Verifikasi citra yang disimpan dapat dibaca kembali oleh OpenCV
        loaded_img = cv2.imread(str(path1))
        self.assertIsNotNone(loaded_img)
        self.assertEqual(loaded_img.shape, (120, 160, 3))

    def test_switch_class_without_restart(self):
        """Uji pergantian kelas aktif di runtime tanpa restart."""
        collector = DatasetCollector(base_dir=self.test_dir, current_class="bottle")
        dummy_frame = np.zeros((100, 100, 3), dtype=np.uint8)

        # Simpan 2 gambar di kelas 'bottle'
        collector.save_image(dummy_frame)
        collector.save_image(dummy_frame)
        self.assertEqual(collector.get_count(), 2)

        # Ganti kelas ke 'charger'
        collector.set_class("charger")
        self.assertEqual(collector.current_class, "charger")
        self.assertEqual(collector.get_count(), 0)

        # Simpan 1 gambar di kelas 'charger'
        collector.save_image(dummy_frame)
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
