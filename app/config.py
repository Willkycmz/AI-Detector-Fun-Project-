"""
VisionX - Application Configuration Module
Mengelola konfigurasi sistem, parameter model, sumber kamera, dan CLI arguments.
"""

from dataclasses import dataclass
import argparse
import os
from typing import Union


@dataclass
class AppConfig:
    """Konfigurasi runtime untuk aplikasi VisionX."""
    source: Union[int, str] = 0
    model_path: str = "models/yolov8n.pt"
    confidence_threshold: float = 0.45
    iou_threshold: float = 0.45
    frame_width: int = 640
    frame_height: int = 480
    device: str = "auto"
    show_fps: bool = True
    show_labels: bool = True
    show_boxes: bool = True
    mode: str = "detect"  # 'detect' atau 'collect'
    class_name: str = "object"
    save_dir: str = "datasets/raw"
    window_title: str = "VisionX - Computer Vision System"


def parse_arguments() -> AppConfig:
    """
    Membaca CLI arguments dan menghasilkan objek AppConfig.
    Contoh:
        python app/main.py --source 0 --conf 0.5 --model models/yolov8n.pt
    """
    parser = argparse.ArgumentParser(
        description="VisionX: Realtime Object Detection MVP using OpenCV & YOLO",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter
    )

    parser.add_argument(
        "--source",
        type=str,
        default="0",
        help="Indeks webcam (0, 1, dll.) atau path ke file video / 'synthetic' untuk mock test"
    )
    parser.add_argument(
        "--model",
        type=str,
        default="models/yolov8n.pt",
        help="Path ke file model YOLO (misal models/yolov8n.pt atau yolov8n.pt)"
    )
    parser.add_argument(
        "--conf",
        type=float,
        default=0.45,
        help="Confidence threshold untuk deteksi objek (0.0 - 1.0)"
    )
    parser.add_argument(
        "--iou",
        type=float,
        default=0.45,
        help="IoU / NMS threshold (0.0 - 1.0)"
    )
    parser.add_argument(
        "--width",
        type=int,
        default=640,
        help="Lebar resolusi frame kamera"
    )
    parser.add_argument(
        "--height",
        type=int,
        default=480,
        help="Tinggi resolusi frame kamera"
    )
    parser.add_argument(
        "--device",
        type=str,
        default="auto",
        choices=["auto", "cpu", "cuda"],
        help="Device acceleration yang digunakan untuk inference"
    )
    parser.add_argument(
        "--no-fps",
        action="store_true",
        help="Sembunyikan tampilan FPS pada layar"
    )
    parser.add_argument(
        "--mode",
        type=str,
        default="detect",
        choices=["detect", "collect"],
        help="Mode operasi aplikasi: 'detect' (deteksi objek V0.1) atau 'collect' (pengumpulan dataset V0.2)"
    )
    parser.add_argument(
        "--class",
        dest="class_name",
        type=str,
        default="object",
        help="Nama kelas objek untuk dataset collection (misal: bottle, glass, charger)"
    )
    parser.add_argument(
        "--save-dir",
        type=str,
        default="datasets/raw",
        help="Direktori penyimpanan gambar mentah (raw)"
    )

    args = parser.parse_args()

    # Parsing source: jika berupa angka numerik, konversi ke integer (misal "0" -> 0)
    source_val: Union[int, str]
    if args.source.isdigit():
        source_val = int(args.source)
    else:
        source_val = args.source

    return AppConfig(
        source=source_val,
        model_path=args.model,
        confidence_threshold=args.conf,
        iou_threshold=args.iou,
        frame_width=args.width,
        frame_height=args.height,
        device=args.device,
        show_fps=not args.no_fps,
        mode=args.mode,
        class_name=args.class_name,
        save_dir=args.save_dir
    )
