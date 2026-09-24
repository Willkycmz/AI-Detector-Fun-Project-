"""
Unit tests for VisionX V0.5 Custom Training Pipeline (app/trainer.py).
"""

import unittest
import tempfile
import shutil
from pathlib import Path
import yaml
import numpy as np
import cv2

from app.trainer import TrainingConfig, VisionXTrainer, TrainingPipelineError
from app.dataset import ClassRegistry


class TestTrainingConfigAndTrainer(unittest.TestCase):

    def setUp(self):
        self.temp_dir = Path(tempfile.mkdtemp(prefix="vx_test_trainer_"))

    def tearDown(self):
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_default_config(self):
        """Uji parameter default konfigurasi training pilot."""
        cfg = TrainingConfig()
        self.assertEqual(cfg.epochs, 50)
        self.assertEqual(cfg.batch, 16)
        self.assertEqual(cfg.imgsz, 640)
        self.assertEqual(cfg.seed, 42)
        self.assertEqual(cfg.patience, 15)
        self.assertEqual(cfg.name, "visionx_v1")

    def test_device_resolution(self):
        """Uji resolusi hardware device (CPU fallback)."""
        dev_cpu = VisionXTrainer.resolve_device("cpu")
        self.assertEqual(dev_cpu, "cpu")

        dev_auto = VisionXTrainer.resolve_device("auto")
        self.assertIn(dev_auto, ["0", "cpu"])

    def test_missing_prerequisites_error(self):
        """Uji penanganan error jika dataset atau model tidak ditemukan."""
        cfg = TrainingConfig(
            model="models/non_existent_model_123.pt",
            data="datasets/non_existent_data.yaml"
        )
        with self.assertRaises(TrainingPipelineError):
            VisionXTrainer(cfg)

    def test_extract_best_epoch_from_csv(self):
        """Uji parsing nomor epoch terbaik dari results.csv."""
        run_dir = self.temp_dir / "run_sample"
        run_dir.mkdir(parents=True)
        csv_file = run_dir / "results.csv"

        content = (
            "                  epoch,         train/box_loss,metrics/mAP50(B),metrics/mAP50-95(B)\n"
            "                      1,                 1.2000,        0.3000,           0.2000\n"
            "                      2,                 0.9500,        0.6500,           0.4800\n"
            "                      3,                 0.8000,        0.6000,           0.4500\n"
        )
        with open(csv_file, "w", encoding="utf-8") as f:
            f.write(content)

        best_ep = VisionXTrainer._extract_best_epoch(run_dir)
        self.assertEqual(best_ep, 2)

    def test_package_model_artifacts(self):
        """Uji pembungkusan model best.pt, last.pt, dan metadata.yaml."""
        run_dir = self.temp_dir / "run_detect"
        weights_dir = run_dir / "weights"
        weights_dir.mkdir(parents=True)

        best_pt = weights_dir / "best.pt"
        last_pt = weights_dir / "last.pt"
        best_pt.write_bytes(b"FAKE_WEIGHTS_BEST")
        last_pt.write_bytes(b"FAKE_WEIGHTS_LAST")

        target_model_dir = self.temp_dir / "models" / "visionx_v1"
        train_meta = {
            "training_duration_sec": 120.5,
            "training_duration_min": 2.01,
            "best_epoch": 12,
            "actual_device": "cpu"
        }
        val_meta = {
            "map50": 0.85,
            "map50_95": 0.62,
            "precision": 0.80,
            "recall": 0.78,
            "per_class": {"person": {"precision": 0.82, "recall": 0.80, "map50_95": 0.65}}
        }
        test_meta = {
            "map50": 0.83,
            "map50_95": 0.60,
            "precision": 0.79,
            "recall": 0.77,
            "per_class": {"person": {"precision": 0.80, "recall": 0.79, "map50_95": 0.63}}
        }

        registry = ClassRegistry({0: "person", 1: "bottle"})

        pkg_path = VisionXTrainer.package_model(
            run_dir=run_dir,
            target_dir=target_model_dir,
            train_metadata=train_meta,
            val_metrics=val_meta,
            test_metrics=test_meta,
            class_registry=registry
        )

        self.assertTrue((target_model_dir / "best.pt").exists())
        self.assertTrue((target_model_dir / "last.pt").exists())
        self.assertTrue((target_model_dir / "metadata.yaml").exists())

        with open(target_model_dir / "metadata.yaml", "r", encoding="utf-8") as f:
            saved_yaml = yaml.safe_load(f)

        self.assertEqual(saved_yaml["classes"][0], "person")
        self.assertEqual(saved_yaml["validation_metrics"]["mAP50"], 0.85)
        self.assertEqual(saved_yaml["test_metrics"]["mAP50"], 0.83)


if __name__ == "__main__":
    unittest.main()
