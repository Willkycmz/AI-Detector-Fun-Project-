"""
VisionX - Object Detection & Visualization Module
Memisahkan proses inferensi AI (YOLO) dengan logika rendering visual (OpenCV).
"""

import logging
from dataclasses import dataclass
from typing import List, Optional, Tuple, Dict
import cv2
import numpy as np

logger = logging.getLogger(__name__)


class ModelLoadError(Exception):
    """Dilempar ketika model YOLO gagal dimuat."""
    pass


@dataclass
class Detection:
    """Representasi satu objek hasil deteksi."""
    bbox: Tuple[int, int, int, int]  # (x1, y1, x2, y2)
    confidence: float
    class_id: int
    class_name: str


class YOLOObjectDetector:
    """
    Wrapper untuk inferensi model Ultralytics YOLO.
    Fokus pada ekstraksi bounding box, confidence, dan label kelas.
    """

    def __init__(
        self,
        model_path: str = "models/yolov8n.pt",
        conf_threshold: float = 0.45,
        iou_threshold: float = 0.45,
        device: str = "auto"
    ) -> None:
        self.model_path = model_path
        self.conf_threshold = conf_threshold
        self.iou_threshold = iou_threshold
        self.device = device
        self.model = None
        self.class_names: Dict[int, str] = {}

        self._load_model()

    def _load_model(self) -> None:
        """Memuat bobot model YOLO dengan error handling komprehensif."""
        try:
            from ultralytics import YOLO
            import torch

            logger.info(f"Memuat model YOLO dari: {self.model_path}")
            self.model = YOLO(self.model_path)

            # Penentuan device acceleration
            if self.device == "auto":
                self.actual_device = "cuda" if torch.cuda.is_available() else "cpu"
            else:
                self.actual_device = self.device

            logger.info(f"Model berhasil dimuat pada device: {self.actual_device}")
            self.class_names = self.model.names if hasattr(self.model, "names") else {}

        except Exception as e:
            error_msg = f"Gagal memuat model YOLO dari '{self.model_path}'. Alasan: {str(e)}"
            logger.error(error_msg, exc_info=True)
            raise ModelLoadError(error_msg) from e

    def detect(self, frame: np.ndarray) -> List[Detection]:
        """
        Menjalankan inferensi deteksi objek pada satu frame gambar.

        Args:
            frame: Gambar dalam format BGR (OpenCV format).

        Returns:
            List of Detection objects.
        """
        if self.model is None:
            raise ModelLoadError("Model belum berhasil diinisialisasi.")

        results = self.model.predict(
            source=frame,
            conf=self.conf_threshold,
            iou=self.iou_threshold,
            device=self.actual_device,
            verbose=False
        )

        detections: List[Detection] = []
        if not results:
            return detections

        first_result = results[0]
        boxes = first_result.boxes
        if boxes is None or len(boxes) == 0:
            return detections

        # Parse boxes tensor ke list of Detection
        xyxy = boxes.xyxy.cpu().numpy()
        confs = boxes.conf.cpu().numpy()
        cls_ids = boxes.cls.cpu().numpy().astype(int)

        for box, conf, cls_id in zip(xyxy, confs, cls_ids):
            x1, y1, x2, y2 = map(int, box)
            name = self.class_names.get(cls_id, f"class_{cls_id}")
            detections.append(
                Detection(
                    bbox=(x1, y1, x2, y2),
                    confidence=float(conf),
                    class_id=cls_id,
                    class_name=name
                )
            )

        return detections


class Visualizer:
    """
    Menangani semua logika tampilan: bounding box, label kelas, confidence,
    dan FPS overlay dengan estetika bersih dan profesional.
    """

    # Palet warna BGR modern yang kontras & estetis
    COLOR_PALETTE = [
        (238, 104, 56),    # Biru Cyan cerah
        (50, 168, 82),     # Hijau Emerald
        (220, 150, 30),    # Biru Langit
        (60, 76, 231),     # Merah Koral
        (186, 85, 211),    # Ungu Anggrek
        (255, 140, 0),     # Oranye Amber
        (144, 238, 144),   # Hijau Muda
        (0, 215, 255),     # Kuning Emas
    ]

    @classmethod
    def get_color(cls, class_id: int) -> Tuple[int, int, int]:
        """Mendapatkan warna unik berdasarkan class_id."""
        return cls.COLOR_PALETTE[class_id % len(cls.COLOR_PALETTE)]

    @classmethod
    def draw(
        cls,
        frame: np.ndarray,
        detections: List[Detection],
        fps: Optional[float] = None,
        show_boxes: bool = True,
        show_labels: bool = True,
        show_fps: bool = True
    ) -> np.ndarray:
        """
        Menggambar anotasi deteksi dan info overlay ke frame.

        Args:
            frame: Frame citra BGR.
            detections: Daftar objek hasil deteksi.
            fps: Nilai frame rate realtime.
            show_boxes: Flag render kotak pembatas.
            show_labels: Flag render teks nama kelas & confidence.
            show_fps: Flag render kartu indikator FPS.

        Returns:
            Frame yang telah dianotasi.
        """
        annotated_frame = frame.copy()

        # 1. Gambar bounding box dan label
        for det in detections:
            color = cls.get_color(det.class_id)
            x1, y1, x2, y2 = det.bbox

            if show_boxes:
                # Kotak utama
                cv2.rectangle(annotated_frame, (x1, y1), (x2, y2), color, 2)

                # Aksen sudut untuk tampilan modern
                corner_len = min(20, (x2 - x1) // 4, (y2 - y1) // 4)
                if corner_len > 4:
                    cv2.line(annotated_frame, (x1, y1), (x1 + corner_len, y1), color, 4)
                    cv2.line(annotated_frame, (x1, y1), (x1, y1 + corner_len), color, 4)
                    cv2.line(annotated_frame, (x2, y1), (x2 - corner_len, y1), color, 4)
                    cv2.line(annotated_frame, (x2, y1), (x2, y1 + corner_len), color, 4)
                    cv2.line(annotated_frame, (x1, y2), (x1 + corner_len, y2), color, 4)
                    cv2.line(annotated_frame, (x1, y2), (x1, y2 - corner_len), color, 4)
                    cv2.line(annotated_frame, (x2, y2), (x2 - corner_len, y2), color, 4)
                    cv2.line(annotated_frame, (x2, y2), (x2, y2 - corner_len), color, 4)

            if show_labels:
                label = f"{det.class_name} {det.confidence:.2f}"
                font_scale = 0.55
                thickness = 1
                (txt_w, txt_h), baseline = cv2.getTextSize(
                    label, cv2.FONT_HERSHEY_SIMPLEX, font_scale, thickness
                )

                # Posisi tag di atas bounding box
                tag_y1 = max(0, y1 - txt_h - 8)
                tag_y2 = y1
                tag_x1 = x1
                tag_x2 = x1 + txt_w + 10

                # Latar belakang label tag
                cv2.rectangle(
                    annotated_frame,
                    (tag_x1, tag_y1),
                    (tag_x2, tag_y2),
                    color,
                    -1
                )
                # Teks label (putih)
                cv2.putText(
                    annotated_frame,
                    label,
                    (tag_x1 + 5, tag_y2 - baseline - 2),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    font_scale,
                    (255, 255, 255),
                    thickness,
                    cv2.LINE_AA
                )

        # 2. Render Panel Statistik & FPS
        if show_fps and fps is not None:
            cls._draw_fps_badge(annotated_frame, fps, len(detections))

        return annotated_frame

    @staticmethod
    def _draw_fps_badge(frame: np.ndarray, fps: float, count: int) -> None:
        """Menggambar badge FPS dan objek terdeteksi di sudut kiri atas."""
        badge_x, badge_y = 15, 15
        badge_w, badge_h = 220, 65

        overlay = frame.copy()
        cv2.rectangle(
            overlay,
            (badge_x, badge_y),
            (badge_x + badge_w, badge_y + badge_h),
            (25, 25, 30),
            -1
        )
        # Efek semi-transparan elegan
        alpha = 0.75
        cv2.addWeighted(overlay, alpha, frame, 1 - alpha, 0, frame)

        # Border halus badge
        cv2.rectangle(
            frame,
            (badge_x, badge_y),
            (badge_x + badge_w, badge_y + badge_h),
            (80, 80, 95),
            1
        )

        # Nilai FPS dan warna indikator (hijau jika >= 24, kuning jika >= 15, merah jika rendah)
        fps_color = (76, 217, 100) if fps >= 24 else (80, 210, 255) if fps >= 15 else (70, 70, 255)
        
        cv2.putText(
            frame,
            f"FPS: {fps:.1f}",
            (badge_x + 12, badge_y + 26),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.65,
            fps_color,
            2,
            cv2.LINE_AA
        )

        cv2.putText(
            frame,
            f"Objects: {count} | [M] Mode | [Q] Exit",
            (badge_x + 12, badge_y + 50),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.45,
            (200, 200, 200),
            1,
            cv2.LINE_AA
        )

    @classmethod
    def draw_collection_hud(
        cls,
        frame: np.ndarray,
        class_name: str,
        count: int,
        fps: Optional[float] = None,
        flash_message: Optional[str] = None
    ) -> np.ndarray:
        """
        Menggambar antarmuka visual khusus untuk Dataset Collection Mode.

        Args:
            frame: Citra yang akan dianotasi.
            class_name: Nama kelas dataset aktif.
            count: Total gambar yang sudah terkumpul pada kelas aktif.
            fps: Realtime FPS kamera.
            flash_message: Pesan konfirmasi simpan foto (jika baru saja mengambil foto).

        Returns:
            Frame dengan UI overlay koleksi dataset.
        """
        annotated_frame = frame.copy()
        h, w = annotated_frame.shape[:2]

        # 1. Panel Header Utama Koleksi di Kiri Atas
        panel_x, panel_y = 15, 15
        panel_w, panel_h = 320, 115

        overlay = annotated_frame.copy()
        cv2.rectangle(
            overlay,
            (panel_x, panel_y),
            (panel_x + panel_w, panel_y + panel_h),
            (20, 20, 28),
            -1
        )
        alpha = 0.82
        cv2.addWeighted(overlay, alpha, annotated_frame, 1 - alpha, 0, annotated_frame)

        # Border panel (warna magenta/violet modern untuk mode koleksi)
        cv2.rectangle(
            annotated_frame,
            (panel_x, panel_y),
            (panel_x + panel_w, panel_y + panel_h),
            (180, 80, 220),
            2
        )

        # Tag Judul Mode
        cv2.putText(
            annotated_frame,
            "[ MODE: DATASET COLLECTION ]",
            (panel_x + 14, panel_y + 24),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.55,
            (200, 120, 255),
            2,
            cv2.LINE_AA
        )

        # Informasi Kelas Aktif
        cv2.putText(
            annotated_frame,
            f"Class : {class_name}",
            (panel_x + 14, panel_y + 50),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.65,
            (0, 230, 255),
            2,
            cv2.LINE_AA
        )

        # Informasi Jumlah Terkumpul & FPS
        fps_text = f" | FPS: {fps:.1f}" if fps is not None else ""
        cv2.putText(
            annotated_frame,
            f"Terkumpul: {count} gambar{fps_text}",
            (panel_x + 14, panel_y + 75),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.52,
            (76, 217, 100),
            1,
            cv2.LINE_AA
        )

        # Shortcut panduan singkat
        cv2.putText(
            annotated_frame,
            "[SPACE/C] Foto  [N] Ganti Kelas  [M] Deteksi",
            (panel_x + 14, panel_y + 98),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.40,
            (200, 200, 200),
            1,
            cv2.LINE_AA
        )

        # 2. Flash Feedback Banner jika baru mengambil gambar
        if flash_message:
            cls._draw_flash_banner(annotated_frame, flash_message, w, h)

        return annotated_frame

    @staticmethod
    def _draw_flash_banner(frame: np.ndarray, message: str, w: int, h: int) -> None:
        """Menampilkan banner notifikasi hijau cerah saat gambar berhasil disimpan."""
        banner_h = 42
        banner_y = h - banner_h - 15
        banner_w = min(w - 30, 600)
        banner_x = (w - banner_w) // 2

        overlay = frame.copy()
        cv2.rectangle(
            overlay,
            (banner_x, banner_y),
            (banner_x + banner_w, banner_y + banner_h),
            (20, 80, 20),
            -1
        )
        cv2.addWeighted(overlay, 0.88, frame, 0.12, 0, frame)
        cv2.rectangle(
            frame,
            (banner_x, banner_y),
            (banner_x + banner_w, banner_y + banner_h),
            (50, 220, 80),
            2
        )
        cv2.putText(
            frame,
            f"BERHASIL: {message}",
            (banner_x + 15, banner_y + 27),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.55,
            (255, 255, 255),
            1,
            cv2.LINE_AA
        )

    @staticmethod
    def draw_class_input_modal(
        frame: np.ndarray,
        input_text: str,
        error_msg: Optional[str] = None
    ) -> np.ndarray:
        """
        Menampilkan dialog input on-screen saat pengguna ingin mengganti nama kelas.
        """
        modal_frame = frame.copy()
        h, w = modal_frame.shape[:2]

        box_w = min(480, w - 40)
        box_h = 160
        bx1 = (w - box_w) // 2
        by1 = (h - box_h) // 2
        bx2 = bx1 + box_w
        by2 = by1 + box_h

        overlay = modal_frame.copy()
        cv2.rectangle(overlay, (bx1, by1), (bx2, by2), (18, 18, 24), -1)
        cv2.addWeighted(overlay, 0.92, modal_frame, 0.08, 0, modal_frame)
        cv2.rectangle(modal_frame, (bx1, by1), (bx2, by2), (255, 160, 0), 2)

        # Judul Dialog
        cv2.putText(
            modal_frame,
            "GANTI KELAS DATASET",
            (bx1 + 20, by1 + 35),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.68,
            (255, 200, 50),
            2,
            cv2.LINE_AA
        )

        # Kotak Input Teks
        input_box_y1 = by1 + 55
        input_box_y2 = by1 + 95
        cv2.rectangle(
            modal_frame,
            (bx1 + 20, input_box_y1),
            (bx2 - 20, input_box_y2),
            (40, 40, 50),
            -1
        )
        cv2.rectangle(
            modal_frame,
            (bx1 + 20, input_box_y1),
            (bx2 - 20, input_box_y2),
            (140, 140, 160),
            1
        )

        # Teks input dengan kursor berkedip simulasi
        display_text = f"> {input_text}_"
        cv2.putText(
            modal_frame,
            display_text,
            (bx1 + 30, input_box_y1 + 27),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.7,
            (255, 255, 255),
            2,
            cv2.LINE_AA
        )

        # Petunjuk Tombol
        cv2.putText(
            modal_frame,
            "[ENTER] Simpan   |   [ESC] Batal",
            (bx1 + 20, by1 + 125),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.48,
            (180, 180, 180),
            1,
            cv2.LINE_AA
        )

        # Pesan Error jika ada
        if error_msg:
            cv2.putText(
                modal_frame,
                f"Error: {error_msg}",
                (bx1 + 20, by1 + 148),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.45,
                (70, 70, 255),
                1,
                cv2.LINE_AA
            )

        return modal_frame
