"""
VisionX - Camera & Video Stream Module
Bertanggung jawab atas koneksi, pengambilan frame realtime, dan error handling kamera.
"""

import time
import logging
from typing import Optional, Tuple, Union
import cv2
import numpy as np

logger = logging.getLogger(__name__)


class CameraError(Exception):
    """Base exception class untuk error pada kamera."""
    pass


class CameraNotFoundError(CameraError):
    """Dilempar ketika perangkat kamera atau stream tidak dapat diakses."""
    pass


class FrameReadError(CameraError):
    """Dilempar ketika pembacaan frame gagal berulang kali."""
    pass


class CameraStream:
    """
    Mengelola lifecycle streaming video dari webcam, video file, RTSP,
    atau synthetic generator frame untuk testing.
    """

    def __init__(
        self,
        source: Union[int, str] = 0,
        width: int = 640,
        height: int = 480
    ) -> None:
        """
        Inisialisasi CameraStream.

        Args:
            source: Indeks kamera (0, 1) atau path file video atau 'synthetic'.
            width: Resolusi lebar yang diinginkan.
            height: Resolusi tinggi yang diinginkan.
        """
        self.source = source
        self.width = width
        self.height = height
        self.cap: Optional[cv2.VideoCapture] = None
        self._is_synthetic = (str(source).lower() == "synthetic")
        self._synthetic_step = 0

    def start(self) -> "CameraStream":
        """
        Membuka koneksi ke kamera / sumber video.

        Returns:
            self untuk chaining.

        Raises:
            CameraNotFoundError: Jika sumber video tidak dapat dibuka.
        """
        if self._is_synthetic:
            logger.info("Menggunakan mode Synthetic Camera Stream (mock frame generator).")
            return self

        logger.info(f"Membuka kamera/sumber video: {self.source}")
        
        # Pada Windows dengan direct index, cv2.CAP_DSHOW memberikan startup lebih cepat
        if isinstance(self.source, int):
            self.cap = cv2.VideoCapture(self.source, cv2.CAP_DSHOW)
            if not self.cap.isOpened():
                # Fallback ke default backend jika CAP_DSHOW gagal
                self.cap = cv2.VideoCapture(self.source)
        else:
            self.cap = cv2.VideoCapture(self.source)

        if not self.cap or not self.cap.isOpened():
            raise CameraNotFoundError(
                f"Gagal membuka kamera/sumber video '{self.source}'. "
                "Pastikan kamera terpasang, tidak sedang digunakan oleh aplikasi lain, "
                "atau periksa nomor index/path file."
            )

        # Atur resolusi jika sumber adalah hardware webcam
        if isinstance(self.source, int):
            self.cap.set(cv2.CAP_PROP_FRAME_WIDTH, self.width)
            self.cap.set(cv2.CAP_PROP_FRAME_HEIGHT, self.height)

        actual_w = int(self.cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        actual_h = int(self.cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        logger.info(f"Kamera aktif pada resolusi: {actual_w}x{actual_h}")
        return self

    def read(self) -> Tuple[bool, Optional[np.ndarray]]:
        """
        Membaca frame berikutnya dari stream.

        Returns:
            Tuple (status: bool, frame: Optional[np.ndarray])
        """
        if self._is_synthetic:
            return True, self._generate_synthetic_frame()

        if self.cap is None or not self.cap.isOpened():
            return False, None

        ret, frame = self.cap.read()
        if not ret or frame is None:
            return False, None

        return True, frame

    def _generate_synthetic_frame(self) -> np.ndarray:
        """Menghasilkan frame sintetis untuk kebutuhan automated test / mock."""
        self._synthetic_step = (self._synthetic_step + 1) % 360
        frame = np.full((self.height, self.width, 3), 30, dtype=np.uint8)

        # Buat visual dinamis sederhana
        cx = int(self.width / 2 + 100 * np.sin(np.radians(self._synthetic_step * 2)))
        cy = int(self.height / 2 + 60 * np.cos(np.radians(self._synthetic_step * 2)))
        cv2.circle(frame, (cx, cy), 45, (0, 200, 255), -1)
        cv2.rectangle(frame, (50, 50), (200, 180), (70, 70, 220), -1)
        cv2.putText(
            frame,
            "VisionX Synthetic Stream",
            (30, 40),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.8,
            (255, 255, 255),
            2
        )
        return frame

    def release(self) -> None:
        """Menutup dan membebaskan resource kamera."""
        if self.cap is not None:
            logger.info("Menutup koneksi kamera...")
            self.cap.release()
            self.cap = None

    def is_opened(self) -> bool:
        """Memeriksa status aktif kamera."""
        if self._is_synthetic:
            return True
        return self.cap is not None and self.cap.isOpened()

    def __enter__(self) -> "CameraStream":
        return self.start()

    def __exit__(self, exc_type, exc_val, exc_tb) -> None:
        self.release()
