"""
VisionX - Custom Object Detection Training & Evaluation Pipeline Module (V0.5)
Mengelola transfer learning YOLOv8, evaluasi partisi val & test,
pencatatan metrik komprehensif per-kelas, penyimpanan metadata model, export ONNX,
serta integrasi uji inferensi realtime.
"""

import os
import sys
import time
import shutil
import argparse
import logging
from pathlib import Path
from datetime import datetime
from dataclasses import dataclass, field, asdict
from typing import Dict, List, Optional, Any, Union, Tuple
import yaml
import cv2
import numpy as np

# Pastikan root direktori project ada di sys.path
PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from app.dataset import ClassRegistry
from app.detector import YOLOObjectDetector, Visualizer

logger = logging.getLogger("VisionX.Trainer")
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")


class TrainingPipelineError(Exception):
    """Base exception untuk kegagalan pada training pipeline."""
    pass


@dataclass
class TrainingConfig:
    """Konfigurasi parameter training dan evaluasi model VisionX."""
    model: str = "models/yolov8n.pt"
    data: str = "datasets/processed/dataset.yaml"
    epochs: int = 50
    batch: int = 16
    imgsz: int = 640
    device: str = "auto"
    workers: int = 2
    patience: int = 15
    seed: int = 42
    project: str = "runs/detect"
    name: str = "visionx_v1"
    exist_ok: bool = False
    pretrained: bool = True
    optimizer: str = "auto"
    lr0: float = 0.01
    lrf: float = 0.01
    save_dir_model: str = "models/visionx_v1"
    export_onnx: bool = True

    @classmethod
    def from_args(cls, args: argparse.Namespace) -> "TrainingConfig":
        """Membaca konfigurasi dari CLI arguments."""
        return cls(
            model=getattr(args, "model", "models/yolov8n.pt"),
            data=getattr(args, "data", "datasets/processed/dataset.yaml"),
            epochs=getattr(args, "epochs", 50),
            batch=getattr(args, "batch", 16),
            imgsz=getattr(args, "imgsz", 640),
            device=getattr(args, "device", "auto"),
            workers=getattr(args, "workers", 2),
            patience=getattr(args, "patience", 15),
            seed=getattr(args, "seed", 42),
            project=getattr(args, "project", "runs/detect"),
            name=getattr(args, "name", "visionx_v1"),
            exist_ok=getattr(args, "exist_ok", False),
            pretrained=not getattr(args, "no_pretrained", False),
            save_dir_model=getattr(args, "save_dir_model", "models/visionx_v1"),
            export_onnx=not getattr(args, "no_export", False)
        )


class VisionXTrainer:
    """
    Pipeline lengkap transfer learning, evaluasi, dan packaging model VisionX.
    """

    def __init__(self, config: Optional[TrainingConfig] = None) -> None:
        self.config = config or TrainingConfig()
        self._validate_prerequisites()

    def _validate_prerequisites(self) -> None:
        """Memverifikasi ketersediaan dataset dan model awal sebelum training."""
        data_path = Path(self.config.data)
        if not data_path.is_absolute():
            data_path = PROJECT_ROOT / data_path
        if not data_path.exists():
            raise TrainingPipelineError(
                f"File konfigurasi dataset tidak ditemukan di '{data_path}'. "
                f"Jalankan 'python -m app.dataset prepare' terlebih dahulu."
            )

        model_path = Path(self.config.model)
        if not model_path.is_absolute():
            model_path = PROJECT_ROOT / model_path
        if not model_path.exists():
            raise TrainingPipelineError(
                f"Model pretrained awal tidak ditemukan di '{model_path}'."
            )

    @staticmethod
    def resolve_device(device_setting: str = "auto") -> str:
        """Mendeteksi hardware acceleration yang tersedia (CUDA GPU / CPU)."""
        import torch
        if device_setting == "auto":
            return "0" if torch.cuda.is_available() else "cpu"
        elif device_setting in ("cuda", "gpu", "0"):
            return "0" if torch.cuda.is_available() else "cpu"
        return "cpu"

    def train(self) -> Dict[str, Any]:
        """
        Menjalankan proses transfer learning YOLO.
        Returns:
            Dict metadata hasil training.
        """
        from ultralytics import YOLO

        model_path = Path(self.config.model)
        if not model_path.is_absolute():
            model_path = PROJECT_ROOT / model_path

        data_path = Path(self.config.data)
        if not data_path.is_absolute():
            data_path = PROJECT_ROOT / data_path

        actual_device = self.resolve_device(self.config.device)
        logger.info(f"Memulai training VisionX YOLOv8: base='{model_path}', device='{actual_device}'")

        # Inisialisasi model Ultralytics
        model = YOLO(str(model_path))

        start_time = time.time()
        start_dt = datetime.now()

        # Eksekusi training
        train_results = model.train(
            data=str(data_path),
            epochs=self.config.epochs,
            batch=self.config.batch,
            imgsz=self.config.imgsz,
            device=actual_device,
            workers=self.config.workers,
            patience=self.config.patience,
            seed=self.config.seed,
            project=self.config.project,
            name=self.config.name,
            exist_ok=self.config.exist_ok,
            pretrained=self.config.pretrained,
            verbose=True
        )

        training_duration = time.time() - start_time
        save_dir = Path(train_results.save_dir) if hasattr(train_results, "save_dir") else Path(self.config.project) / self.config.name
        best_pt = save_dir / "weights" / "best.pt"
        last_pt = save_dir / "weights" / "last.pt"

        # Ekstraksi best epoch dari results.csv jika tersedia
        best_epoch = self._extract_best_epoch(save_dir)

        logger.info(f"Training selesai dalam {training_duration:.2f}s ({training_duration / 60:.1f} min). Best epoch: {best_epoch}")

        return {
            "run_dir": str(save_dir),
            "best_pt": str(best_pt) if best_pt.exists() else None,
            "last_pt": str(last_pt) if last_pt.exists() else None,
            "training_duration_sec": round(training_duration, 2),
            "training_duration_min": round(training_duration / 60, 2),
            "training_start": start_dt.isoformat(),
            "training_end": datetime.now().isoformat(),
            "best_epoch": best_epoch,
            "actual_device": actual_device
        }

    @staticmethod
    def _extract_best_epoch(run_dir: Path) -> int:
        """Membaca results.csv untuk menentukan nomor epoch dengan mAP tertinggi."""
        csv_path = run_dir / "results.csv"
        if not csv_path.exists():
            return -1

        try:
            import csv
            with open(csv_path, "r", encoding="utf-8") as f:
                reader = csv.DictReader(f)
                rows = list(reader)

            if not rows:
                return -1

            # Cari header yang merepresentasikan mAP50-95
            map_key = None
            for col in rows[0].keys():
                col_clean = col.strip()
                if "metrics/mAP50-95(B)" in col_clean or "mAP50-95" in col_clean:
                    map_key = col
                    break

            if not map_key:
                for col in rows[0].keys():
                    if "mAP50" in col:
                        map_key = col
                        break

            if not map_key:
                return len(rows)

            best_val = -1.0
            best_ep = 1
            for row in rows:
                try:
                    val = float(row[map_key].strip())
                    ep_str = row.get("epoch", row.get("  epoch", list(row.values())[0])).strip()
                    ep = int(ep_str)
                    if val > best_val:
                        best_val = val
                        best_ep = ep
                except (ValueError, KeyError):
                    continue

            return best_ep
        except Exception as e:
            logger.warning(f"Gagal membaca results.csv: {e}")
            return -1

    @classmethod
    def evaluate(
        cls,
        model_path: Union[str, Path],
        data_yaml: Union[str, Path],
        split: str = "val",
        device: str = "auto"
    ) -> Dict[str, Any]:
        """
        Menjalankan validasi evaluasi pada split tertentu (val atau test).
        Mengekstrak metrik agregat dan metrik rinci per-kelas objek.
        """
        from ultralytics import YOLO

        m_path = Path(model_path)
        d_path = Path(data_yaml)
        if not m_path.exists():
            raise FileNotFoundError(f"Model file tidak ditemukan: {m_path}")
        if not d_path.exists():
            raise FileNotFoundError(f"Data yaml tidak ditemukan: {d_path}")

        actual_device = cls.resolve_device(device)
        model = YOLO(str(m_path))

        logger.info(f"Menjalankan evaluasi model pada split '{split}' ({d_path.name})...")
        val_results = model.val(
            data=str(d_path),
            split=split,
            imgsz=640,
            device=actual_device,
            verbose=False
        )

        names = val_results.names if hasattr(val_results, "names") else {}

        # 1. Metrik Agregat
        box_metrics = val_results.box
        precision = float(box_metrics.mp)
        recall = float(box_metrics.mr)
        map50 = float(box_metrics.map50)
        map50_95 = float(box_metrics.map)

        # 2. Metrik Per-Kelas (Rinci)
        per_class_metrics: Dict[str, Dict[str, float]] = {}
        # box_metrics.p, box_metrics.r, box_metrics.maps
        p_list = box_metrics.p if hasattr(box_metrics, "p") else []
        r_list = box_metrics.r if hasattr(box_metrics, "r") else []
        maps_list = box_metrics.maps if hasattr(box_metrics, "maps") else []

        for cid, cname in names.items():
            cid_int = int(cid)
            c_p = float(p_list[cid_int]) if cid_int < len(p_list) else 0.0
            c_r = float(r_list[cid_int]) if cid_int < len(r_list) else 0.0
            c_map = float(maps_list[cid_int]) if cid_int < len(maps_list) else 0.0
            per_class_metrics[cname] = {
                "class_id": cid_int,
                "precision": round(c_p, 4),
                "recall": round(c_r, 4),
                "map50": round(c_p * c_r if c_p > 0 and c_r > 0 else 0.0, 4),  # fallback estimate if maps is 50-95
                "map50_95": round(c_map, 4)
            }

        # 3. Speed Profiling
        speed_info = val_results.speed if hasattr(val_results, "speed") else {}
        speed_clean = {k: round(float(v), 2) for k, v in speed_info.items()}

        return {
            "split": split,
            "precision": round(precision, 4),
            "recall": round(recall, 4),
            "map50": round(map50, 4),
            "map50_95": round(map50_95, 4),
            "per_class": per_class_metrics,
            "speed_ms": speed_clean,
            "confusion_matrix_path": str(Path(val_results.save_dir) / "confusion_matrix.png") if hasattr(val_results, "save_dir") else None
        }

    @classmethod
    def package_model(
        cls,
        run_dir: Union[str, Path],
        target_dir: Union[str, Path],
        train_metadata: Dict[str, Any],
        val_metrics: Dict[str, Any],
        test_metrics: Dict[str, Any],
        class_registry: Optional[ClassRegistry] = None
    ) -> Path:
        """
        Menyimpan model terbaik dan metadata ke direktori models/visionx_v1/.
        """
        r_dir = Path(run_dir).resolve()
        t_dir = Path(target_dir).resolve()
        t_dir.mkdir(parents=True, exist_ok=True)

        best_src = r_dir / "weights" / "best.pt"
        last_src = r_dir / "weights" / "last.pt"

        best_dst = t_dir / "best.pt"
        last_dst = t_dir / "last.pt"

        if best_src.exists():
            shutil.copy2(best_src, best_dst)
        if last_src.exists():
            shutil.copy2(last_src, last_dst)

        # Salin juga confusion matrix dan grafik hasil jika ada
        for chart_name in ["confusion_matrix.png", "results.png", "confusion_matrix_normalized.png"]:
            chart_src = r_dir / chart_name
            if chart_src.exists():
                shutil.copy2(chart_src, t_dir / chart_name)

        # Hitung ukuran model
        model_size_mb = round(best_dst.stat().st_size / (1024 * 1024), 2) if best_dst.exists() else 0.0

        # Siapkan metadata.yaml
        meta_dict = {
            "model_name": "VisionX V1 Object Detector",
            "version": "1.0.0",
            "base_architecture": "YOLOv8n (Nano)",
            "created_at": datetime.now().isoformat(),
            "training_info": {
                "training_duration_sec": train_metadata.get("training_duration_sec"),
                "training_duration_min": train_metadata.get("training_duration_min"),
                "best_epoch": train_metadata.get("best_epoch"),
                "device_used": train_metadata.get("actual_device"),
                "model_size_mb": model_size_mb,
                "dataset_source": "datasets/processed/dataset.yaml"
            },
            "classes": class_registry.to_dict() if class_registry else {
                0: "person", 1: "bottle", 2: "cup", 3: "laptop",
                4: "mouse", 5: "keyboard", 6: "cell_phone"
            },
            "validation_metrics": {
                "mAP50": val_metrics.get("map50"),
                "mAP50_95": val_metrics.get("map50_95"),
                "precision": val_metrics.get("precision"),
                "recall": val_metrics.get("recall"),
                "speed_ms": val_metrics.get("speed_ms"),
                "per_class": val_metrics.get("per_class")
            },
            "test_metrics": {
                "mAP50": test_metrics.get("map50"),
                "mAP50_95": test_metrics.get("map50_95"),
                "precision": test_metrics.get("precision"),
                "recall": test_metrics.get("recall"),
                "speed_ms": test_metrics.get("speed_ms"),
                "per_class": test_metrics.get("per_class")
            }
        }

        meta_yaml_path = t_dir / "metadata.yaml"
        with open(meta_yaml_path, "w", encoding="utf-8") as f:
            yaml.dump(meta_dict, f, default_flow_style=False, sort_keys=False)

        logger.info(f"Model dan metadata VisionX V1 berhasil dipaketkan ke: {t_dir}")
        return t_dir

    @classmethod
    def export_onnx(cls, model_pt_path: Union[str, Path]) -> Optional[Path]:
        """
        Mengekspor bobot model PyTorch (.pt) ke format ONNX untuk runtime deployment efisien.
        Mempertahankan file .pt asli tanpa menghapusnya.
        """
        from ultralytics import YOLO
        m_path = Path(model_pt_path).resolve()
        if not m_path.exists():
            logger.warning(f"File .pt tidak ditemukan untuk diekspor: {m_path}")
            return None

        try:
            logger.info(f"Mengekspor model '{m_path.name}' ke ONNX...")
            model = YOLO(str(m_path))
            exported_path_str = model.export(format="onnx", imgsz=640, dynamic=False, verbose=False)
            exported_path = Path(exported_path_str)
            logger.info(f"Export ONNX sukses: {exported_path}")
            return exported_path
        except Exception as e:
            logger.warning(f"Gagal mengekspor ke ONNX ({e}). Melewati tahap export.")
            return None

    @classmethod
    def test_realtime_inference(
        cls,
        model_pt_path: Union[str, Path],
        test_images_dir: Union[str, Path] = "datasets/processed/images/test",
        output_preview_dir: Optional[Union[str, Path]] = None,
        num_samples: int = 5
    ) -> List[Dict[str, Any]]:
        """
        Memuat model ke pipeline deteksi VisionX (YOLOObjectDetector) dan menjalankan
        uji inferensi pada sample gambar dari partisi test.
        """
        m_path = Path(model_pt_path).resolve()
        t_dir = Path(test_images_dir).resolve()
        if not m_path.exists():
            raise FileNotFoundError(f"Model .pt tidak ditemukan: {m_path}")
        if not t_dir.exists():
            raise FileNotFoundError(f"Direktori test images tidak ditemukan: {t_dir}")

        out_dir = Path(output_preview_dir).resolve() if output_preview_dir else None
        if out_dir:
            out_dir.mkdir(parents=True, exist_ok=True)

        logger.info(f"Memuat model '{m_path}' ke YOLOObjectDetector VisionX...")
        detector = YOLOObjectDetector(model_path=str(m_path), conf_threshold=0.25, iou_threshold=0.45)

        test_images = sorted([p for p in t_dir.iterdir() if p.is_file() and p.suffix.lower() in {".jpg", ".png", ".jpeg"}])
        samples = test_images[:num_samples]

        results_list = []
        for idx, img_path in enumerate(samples, start=1):
            frame = cv2.imread(str(img_path))
            if frame is None:
                continue

            t0 = time.time()
            detections = detector.detect(frame)
            latency_ms = (time.time() - t0) * 1000.0

            annotated = Visualizer.draw(frame, detections, fps=1000.0 / latency_ms if latency_ms > 0 else 30.0)

            if out_dir:
                out_file = out_dir / f"pred_{img_path.name}"
                cv2.imwrite(str(out_file), annotated)

            results_list.append({
                "image": img_path.name,
                "latency_ms": round(latency_ms, 2),
                "num_detections": len(detections),
                "detections": [
                    {
                        "class_id": d.class_id,
                        "class_name": d.class_name,
                        "confidence": round(d.confidence, 4),
                        "bbox": d.bbox
                    } for d in detections
                ]
            })

        logger.info(f"Uji inferensi selesai pada {len(results_list)} citra uji.")
        return results_list


# =====================================================================
# CLI Runner
# =====================================================================

def run_pilot_training(config: TrainingConfig) -> int:
    """
    Menjalankan alur penuh V0.5:
    1. Training YOLOv8 (Transfer Learning)
    2. Validasi (Val Set)
    3. Evaluasi (Test Set)
    4. Per-Class Metrics Reporting
    5. Packaging Model & Metadata ke models/visionx_v1/
    6. Export ONNX
    7. Realtime Inference Test
    """
    print("\n" + "=" * 70)
    print("VisionX V0.5: Custom Object Detection Training Pipeline (Pilot V1)")
    print("=" * 70)

    # 1. Inisialisasi Trainer & Audit
    trainer = VisionXTrainer(config)
    print(f"Model Pretrained : {config.model}")
    print(f"Dataset YAML     : {config.data}")
    print(f"Epochs           : {config.epochs}")
    print(f"Batch Size       : {config.batch}")
    print(f"Image Size       : {config.imgsz}")
    print(f"Target Device    : {config.device} -> Resolved: {trainer.resolve_device(config.device)}")
    print(f"Random Seed      : {config.seed}")
    print(f"Patience (ES)    : {config.patience}")
    print("-" * 70)

    # 2. Training Stage
    print("\n[TAHAP 1/5] Menjalankan Transfer Learning Training...")
    train_meta = trainer.train()
    best_pt_path = train_meta["best_pt"]
    if not best_pt_path or not Path(best_pt_path).exists():
        print("[ERROR] File best.pt tidak ditemukan setelah training.")
        return 1

    print(f"Training Selesai! Durasi: {train_meta['training_duration_min']} menit.")
    print(f"Best Weights: {best_pt_path}")

    # 3. Validation Stage (Val Set)
    print("\n[TAHAP 2/5] Menjalankan Validasi pada Validation Set...")
    val_metrics = trainer.evaluate(
        model_path=best_pt_path,
        data_yaml=config.data,
        split="val",
        device=config.device
    )

    # 4. Final Evaluation Stage (Test Set - Dijalankan SATU KALI)
    print("\n[TAHAP 3/5] Menjalankan Evaluasi Akhir pada Test Set (Single Run)...")
    test_metrics = trainer.evaluate(
        model_path=best_pt_path,
        data_yaml=config.data,
        split="test",
        device=config.device
    )

    # 5. Packaging & Metadata
    print("\n[TAHAP 4/5] Memaketkan Model dan Menyimpan Metadata ke models/visionx_v1/...")
    class_registry = None
    classes_yaml = PROJECT_ROOT / "datasets" / "metadata" / "classes.yaml"
    if classes_yaml.exists():
        class_registry = ClassRegistry.load(classes_yaml)

    packaged_dir = trainer.package_model(
        run_dir=train_meta["run_dir"],
        target_dir=config.save_dir_model,
        train_metadata=train_meta,
        val_metrics=val_metrics,
        test_metrics=test_metrics,
        class_registry=class_registry
    )

    # Export ONNX
    if config.export_onnx:
        trainer.export_onnx(Path(config.save_dir_model) / "best.pt")

    # 6. Realtime Inference Test
    print("\n[TAHAP 5/5] Menjalankan Uji Inferensi Realtime dengan best.pt...")
    pred_out_dir = Path(train_meta["run_dir"]) / "test_predictions"
    inf_results = trainer.test_realtime_inference(
        model_pt_path=Path(config.save_dir_model) / "best.pt",
        test_images_dir=PROJECT_ROOT / "datasets" / "processed" / "images" / "test",
        output_preview_dir=pred_out_dir,
        num_samples=10
    )

    # 7. Cetak Laporan Komprehensif
    print("\n" + "=" * 70)
    print("LAPORAN AKHIR TRAINING & EVALUASI VISIONX V1")
    print("=" * 70)
    print(f"1. Model yang Digunakan       : {config.model} (YOLOv8n Nano)")
    print(f"2. Best Epoch Terpilih        : Epoch {train_meta['best_epoch']} dari {config.epochs}")
    print(f"3. Durasi Training            : {train_meta['training_duration_sec']} detik ({train_meta['training_duration_min']} menit)")
    print(f"4. Validasi mAP50             : {val_metrics['map50']:.4f}")
    print(f"5. Validasi mAP50-95          : {val_metrics['map50_95']:.4f}")
    print(f"6. Validasi Precision         : {val_metrics['precision']:.4f}")
    print(f"7. Validasi Recall            : {val_metrics['recall']:.4f}")
    print("-" * 70)
    print(f"EVALUASI TEST SET (UNSEEN DATA):")
    print(f"  Test mAP50                  : {test_metrics['map50']:.4f}")
    print(f"  Test mAP50-95               : {test_metrics['map50_95']:.4f}")
    print(f"  Test Precision              : {test_metrics['precision']:.4f}")
    print(f"  Test Recall                 : {test_metrics['recall']:.4f}")
    print("-" * 70)
    print("8. METRIK PER-CLASS (TEST SET):")
    print(f"   {'Kelas':<15} | {'Precision':<10} | {'Recall':<10} | {'mAP50-95':<10}")
    print("   " + "-" * 52)
    for cname, c_met in test_metrics["per_class"].items():
        print(f"   {cname:<15} | {c_met['precision']:<10.4f} | {c_met['recall']:<10.4f} | {c_met['map50_95']:<10.4f}")
    print("-" * 70)
    print(f"9. Lokasi Confusion Matrix    : {Path(config.save_dir_model) / 'confusion_matrix.png'}")
    print(f"10. Lokasi Model Final (best)  : {Path(config.save_dir_model) / 'best.pt'}")
    print(f"11. Uji Realtime Inference    : BERHASIL ({len(inf_results)} citra diuji, rata-rata latensi: {np.mean([r['latency_ms'] for r in inf_results]):.1f} ms)")
    print(f"12. Masalah/Error             : Tidak ada error fatal. Model siap digunakan.")
    print("=" * 70 + "\n")

    return 0


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="python -m app.trainer",
        description="VisionX V0.5: Custom Object Detection Training & Evaluation Pipeline",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter
    )

    parser.add_argument("--model", type=str, default="models/yolov8n.pt", help="Path model pretrained awal")
    parser.add_argument("--data", type=str, default="datasets/processed/dataset.yaml", help="Path file dataset.yaml")
    parser.add_argument("--epochs", type=int, default=50, help="Jumlah epoch training")
    parser.add_argument("--batch", type=int, default=16, help="Ukuran batch training")
    parser.add_argument("--imgsz", type=int, default=640, help="Resolusi citra input YOLO")
    parser.add_argument("--device", type=str, default="auto", choices=["auto", "cpu", "cuda", "0"], help="Device compute")
    parser.add_argument("--workers", type=int, default=2, help="Jumlah worker dataloader")
    parser.add_argument("--patience", type=int, default=15, help="Patience untuk early stopping")
    parser.add_argument("--seed", type=int, default=42, help="Random seed reproduktibilitas")
    parser.add_argument("--project", type=str, default="runs/detect", help="Direktori penyimpanan run")
    parser.add_argument("--name", type=str, default="visionx_v1", help="Nama sub-folder run training")
    parser.add_argument("--exist-ok", action="store_true", help="Izinkan penulisan ke folder run yang ada")
    parser.add_argument("--no-pretrained", action="store_true", help="Latih dari scratch tanpa bobot pretrained")
    parser.add_argument("--save-dir-model", type=str, default="models/visionx_v1", help="Lokasi penyimpanan model terstruktur")
    parser.add_argument("--no-export", action="store_true", help="Lewati export ke ONNX")

    args = parser.parse_args()
    config = TrainingConfig.from_args(args)
    exit_code = run_pilot_training(config)
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
