"""
VisionX - Dataset Collection Module
Mengelola pembuatan folder kelas, validasi nama, penyimpanan citra bersih (clean raw frames),
dan penomoran/penamaan file unik untuk persiapan training custom model.
"""

import os
import re
import uuid
import logging
from datetime import datetime
from pathlib import Path
from typing import List, Optional
import cv2
import numpy as np

logger = logging.getLogger(__name__)

# Daftar nama perangkat/folder yang dilarang di Windows
WINDOWS_RESERVED_NAMES = {
    "CON", "PRN", "AUX", "NUL",
    "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
    "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"
}

# Ekstensi citra yang didukung
SUPPORTED_EXTENSIONS = {".jpg", ".jpeg", ".png"}


class DatasetCollectionError(Exception):
    """Base exception untuk error pada proses pengumpulan dataset."""
    pass


class InvalidClassNameError(DatasetCollectionError):
    """Dilempar ketika nama kelas tidak valid atau tidak aman sebagai folder."""
    pass


class DatasetSaveError(DatasetCollectionError):
    """Dilempar ketika penyimpanan citra ke disk gagal."""
    pass


def validate_class_name(name: str) -> str:
    """
    Memvalidasi dan mensanitasi nama kelas agar aman digunakan sebagai nama folder.

    Aturan:
    - Tidak boleh kosong / hanya whitespace.
    - Dikonversi ke huruf kecil (lowercase).
    - Spasi diubah menjadi underscore (_).
    - Hanya boleh berisi karakter alfanumerik, underscore (_), dan tanda hubung (-).
    - Tidak boleh menggunakan nama reserved Windows (CON, PRN, AUX, NUL, COM1-9, LPT1-9).

    Args:
        name: String nama kelas yang ingin divalidasi.

    Returns:
        Nama kelas yang telah disanitasi.

    Raises:
        InvalidClassNameError: Jika nama kelas melanggar aturan di atas.
    """
    if not name or not isinstance(name, str):
        raise InvalidClassNameError("Nama kelas tidak boleh kosong.")

    cleaned = name.strip().lower()
    # Ganti spasi atau tab dengan underscore
    cleaned = re.sub(r"\s+", "_", cleaned)

    if not cleaned:
        raise InvalidClassNameError("Nama kelas tidak boleh hanya berisi spasi.")

    # Cek nama reserved Windows
    if cleaned.upper() in WINDOWS_RESERVED_NAMES:
        raise InvalidClassNameError(
            f"'{name}' adalah nama sistem terlarang di Windows. Silakan pilih nama lain."
        )

    # Validasi hanya karakter alfanumerik, underscore, dan hyphen
    if not re.match(r"^[a-z0-9_\-]+$", cleaned):
        raise InvalidClassNameError(
            f"Nama kelas '{name}' mengandung karakter ilegal. "
            "Gunakan hanya huruf, angka, underscore (_), dan tanda hubung (-)."
        )

    return cleaned


class DatasetCollector:
    """
    Mengelola proses pengumpulan citra mentah untuk satu atau beberapa kelas objek.
    Menyimpan citra asli tanpa bounding box / watermark untuk ground-truth dataset.
    """

    def __init__(
        self,
        base_dir: str = "datasets/raw",
        current_class: str = "object"
    ) -> None:
        """
        Inisialisasi DatasetCollector.

        Args:
            base_dir: Direktori dasar penyimpanan data mentah (default: 'datasets/raw').
            current_class: Nama kelas awal yang akan dikumpulkan.
        """
        self.base_dir = Path(base_dir).resolve()
        self.base_dir.mkdir(parents=True, exist_ok=True)
        self.current_class: str = ""
        self.current_dir: Optional[Path] = None
        self._count: int = 0

        self.set_class(current_class)

    def set_class(self, class_name: str) -> str:
        """
        Mengganti kelas aktif tanpa perlu me-restart aplikasi.

        Args:
            class_name: Nama kelas baru.

        Returns:
            Nama kelas yang telah disanitasi.
        """
        sanitized = validate_class_name(class_name)
        self.current_class = sanitized
        self.current_dir = self.base_dir / self.current_class
        self.current_dir.mkdir(parents=True, exist_ok=True)

        self._refresh_count()
        logger.info(
            f"Kelas dataset aktif: '{self.current_class}' (Sudah terkumpul: {self._count} gambar)"
        )
        return self.current_class

    def _refresh_count(self) -> None:
        """Menghitung ulang jumlah file gambar pada folder kelas aktif."""
        if not self.current_dir or not self.current_dir.exists():
            self._count = 0
            return

        self._count = sum(
            1 for p in self.current_dir.iterdir()
            if p.is_file() and p.suffix.lower() in SUPPORTED_EXTENSIONS
        )

    def get_count(self) -> int:
        """Mendapatkan total gambar yang tersimpan untuk kelas aktif."""
        return self._count

    def list_classes(self) -> List[str]:
        """Menampilkan daftar semua kelas yang sudah memiliki folder di base_dir."""
        if not self.base_dir.exists():
            return []
        return sorted([
            d.name for d in self.base_dir.iterdir()
            if d.is_dir() and not d.name.startswith(".")
        ])

    def save_image(self, frame: np.ndarray, ext: str = "jpg") -> Path:
        """
        Menyimpan satu frame citra bersih (un-annotated) ke disk dengan nama unik.

        Args:
            frame: Citra format BGR (OpenCV).
            ext: Ekstensi file gambar ('jpg' atau 'png').

        Returns:
            Path lokasi file yang baru disimpan.

        Raises:
            DatasetSaveError: Jika penulisan file ke disk gagal.
        """
        if frame is None or not isinstance(frame, np.ndarray) or frame.size == 0:
            raise DatasetSaveError("Frame tidak valid atau kosong untuk disimpan.")

        if not self.current_dir:
            raise DatasetSaveError("Direktori kelas aktif belum diatur.")

        # Format penamaan unik: <class>_YYYYMMDD_HHMMSS_<short_uuid>.<ext>
        now = datetime.now()
        timestamp_str = now.strftime("%Y%m%d_%H%M%S")
        unique_suffix = uuid.uuid4().hex[:6]

        filename = f"{self.current_class}_{timestamp_str}_{unique_suffix}.{ext}"
        filepath = self.current_dir / filename

        # Cegah penimpaan file jika ada nama yang bertabrakan
        counter = 1
        while filepath.exists():
            filename = f"{self.current_class}_{timestamp_str}_{unique_suffix}_{counter}.{ext}"
            filepath = self.current_dir / filename
            counter += 1

        # Tulis citra menggunakan OpenCV
        success = cv2.imwrite(str(filepath), frame)
        if not success:
            raise DatasetSaveError(f"Gagal menulis file gambar ke: {filepath}")

        self._count += 1
        logger.info(f"Gambar tersimpan [{self.current_class}]: {filepath.name} (Total: {self._count})")
        return filepath
