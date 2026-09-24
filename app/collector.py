"""
VisionX - Dataset Collection & Management Module (V0.4.1)
Mengelola pembuatan folder kelas, validasi nama, penyimpanan citra bersih (clean raw frames),
penghapusan (single/multi-delete), impor citra/folder, pencegahan duplikasi (SHA-256 hash),
dan pelacakan metadata sumber (own_capture, own_import, huggingface, kaggle, other_external).
"""

import os
import re
import uuid
import yaml
import hashlib
import logging
from datetime import datetime
from pathlib import Path
from typing import List, Optional, Set, Dict, Any, Union
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
SUPPORTED_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}

# Kategori sumber data yang didukung
VALID_SOURCES = {
    "own_capture",
    "own_import",
    "huggingface",
    "kaggle",
    "other_external"
}


class DatasetCollectionError(Exception):
    """Base exception untuk error pada proses pengumpulan dataset."""
    pass


class InvalidClassNameError(DatasetCollectionError):
    """Dilempar ketika nama kelas tidak valid atau tidak aman sebagai folder."""
    pass


class DatasetSaveError(DatasetCollectionError):
    """Dilempar ketika penyimpanan citra ke disk gagal."""
    pass


class DuplicateImageError(DatasetCollectionError):
    """Dilempar ketika citra duplikat terdeteksi dan penolakan duplikat aktif."""
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


def compute_image_hash(image_or_path: Union[np.ndarray, str, Path], ext: str = ".jpg") -> str:
    """
    Menghitung hash SHA-256 dari array gambar atau file gambar.
    Digunakan untuk deteksi duplikasi citra yang cepat dan akurat.
    """
    if isinstance(image_or_path, (str, Path)):
        p = Path(image_or_path)
        if not p.exists():
            raise FileNotFoundError(f"File tidak ditemukan: {p}")
        hasher = hashlib.sha256()
        with open(p, "rb") as f:
            while chunk := f.read(65536):
                hasher.update(chunk)
        return hasher.hexdigest()
    elif isinstance(image_or_path, np.ndarray):
        clean_ext = ext if ext.startswith(".") else f".{ext}"
        success, buf = cv2.imencode(clean_ext, image_or_path)
        if success:
            return hashlib.sha256(buf).hexdigest()
        return hashlib.sha256(image_or_path.tobytes()).hexdigest()
    else:
        raise ValueError("Input harus berupa np.ndarray, str, atau Path.")


class DatasetCollector:
    """
    Mengelola proses pengumpulan citra mentah untuk satu atau beberapa kelas objek.
    Menyimpan citra asli tanpa bounding box / watermark untuk ground-truth dataset.
    Mendukung penghapusan, impor, deteksi duplikasi, dan pencatatan sumber metadata.
    """

    def __init__(
        self,
        base_dir: str = "datasets/raw/own",
        current_class: str = "object",
        metadata_file: Optional[str] = "datasets/metadata/sources.yaml",
        enable_deduplication: bool = True
    ) -> None:
        """
        Inisialisasi DatasetCollector.

        Args:
            base_dir: Direktori dasar penyimpanan data mentah (default: 'datasets/raw/own').
            current_class: Nama kelas awal yang akan dikumpulkan.
            metadata_file: Lokasi file metadata sumber (opsional).
            enable_deduplication: Aktifkan pencegahan duplikasi berbasis SHA-256.
        """
        self.base_dir = Path(base_dir).resolve()
        self.base_dir.mkdir(parents=True, exist_ok=True)
        self.current_class: str = ""
        self.current_dir: Optional[Path] = None
        self._count: int = 0
        self.enable_deduplication = enable_deduplication
        self.metadata_file = Path(metadata_file).resolve() if metadata_file else None

        # Hash registry untuk pencegahan duplikasi
        self._known_hashes: Set[str] = set()

        self.set_class(current_class)
        self._build_hash_index()

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

    def _build_hash_index(self) -> None:
        """Membangun indeks hash dari file yang sudah ada di direktori dasar."""
        if not self.enable_deduplication or not self.base_dir.exists():
            return

        self._known_hashes.clear()
        for img_path in self.base_dir.rglob("*"):
            if img_path.is_file() and img_path.suffix.lower() in SUPPORTED_EXTENSIONS:
                try:
                    h = compute_image_hash(img_path)
                    self._known_hashes.add(h)
                except Exception as e:
                    logger.debug(f"Gagal menghitung hash untuk {img_path}: {e}")

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

    def save_image(
        self,
        frame: np.ndarray,
        ext: str = "jpg",
        source: str = "own_capture",
        check_duplicate: bool = True
    ) -> Path:
        """
        Menyimpan satu frame citra bersih (un-annotated) ke disk dengan nama unik.

        Args:
            frame: Citra format BGR (OpenCV).
            ext: Ekstensi file gambar ('jpg', 'png', atau 'webp').
            source: Kategori sumber data (default: 'own_capture').
            check_duplicate: Cek duplikasi menggunakan SHA-256 hash.

        Returns:
            Path lokasi file yang baru disimpan.

        Raises:
            DatasetSaveError: Jika penulisan file ke disk gagal.
            DuplicateImageError: Jika citra sudah ada di dataset.
        """
        if frame is None or not isinstance(frame, np.ndarray) or frame.size == 0:
            raise DatasetSaveError("Frame tidak valid atau kosong untuk disimpan.")

        if not self.current_dir:
            raise DatasetSaveError("Direktori kelas aktif belum diatur.")

        clean_ext = ext.lstrip(".").lower()
        if f".{clean_ext}" not in SUPPORTED_EXTENSIONS:
            raise DatasetSaveError(f"Ekstensi '.{clean_ext}' tidak didukung. Gunakan salah satu dari {SUPPORTED_EXTENSIONS}")

        if source not in VALID_SOURCES:
            source = "own_capture"

        # Cek duplikasi hash jika aktif
        if check_duplicate and self.enable_deduplication:
            img_hash = compute_image_hash(frame, ext=clean_ext)
            if img_hash in self._known_hashes:
                raise DuplicateImageError(f"Citra duplikat terdeteksi (SHA256: {img_hash[:12]}...). Penyimpanan dibatalkan.")

        # Format penamaan unik: <class>_<source_prefix>_YYYYMMDD_HHMMSS_<short_uuid>.<ext>
        now = datetime.now()
        timestamp_str = now.strftime("%Y%m%d_%H%M%S")
        unique_suffix = uuid.uuid4().hex[:6]
        source_tag = source.replace("own_", "")

        filename = f"{self.current_class}_{source_tag}_{timestamp_str}_{unique_suffix}.{clean_ext}"
        filepath = self.current_dir / filename

        # Cegah penimpaan file jika ada nama yang bertabrakan
        counter = 1
        while filepath.exists():
            filename = f"{self.current_class}_{source_tag}_{timestamp_str}_{unique_suffix}_{counter}.{clean_ext}"
            filepath = self.current_dir / filename
            counter += 1

        # Tulis citra menggunakan OpenCV
        success = cv2.imwrite(str(filepath), frame)
        if not success:
            raise DatasetSaveError(f"Gagal menulis file gambar ke: {filepath}")

        # Daftarkan hash baru
        if self.enable_deduplication:
            new_hash = compute_image_hash(filepath)
            self._known_hashes.add(new_hash)

        # Catat metadata sumber
        self._record_metadata(filepath.name, self.current_class, source, filepath)

        self._count += 1
        logger.info(f"Gambar tersimpan [{self.current_class}]: {filepath.name} (Total: {self._count})")
        return filepath

    def delete_image(self, filepath: Union[str, Path]) -> bool:
        """
        Menghapus satu file gambar dari folder kelas aktif.

        Args:
            filepath: Path file gambar yang ingin dihapus.

        Returns:
            True jika berhasil dihapus.
        """
        target = Path(filepath).resolve()
        if not target.exists() or not target.is_file():
            logger.warning(f"File tidak ditemukan untuk dihapus: {target}")
            return False

        # Pastikan file berada di dalam direktori dataset
        try:
            target.relative_to(self.base_dir)
        except ValueError:
            raise DatasetCollectionError(f"Operasi ditolak: {target} berada di luar {self.base_dir}")

        # Hapus hash dari registry
        if self.enable_deduplication:
            try:
                h = compute_image_hash(target)
                self._known_hashes.discard(h)
            except Exception:
                pass

        target.unlink()
        self._refresh_count()
        logger.info(f"Gambar berhasil dihapus: {target.name} (Sisa di kelas {self.current_class}: {self._count})")
        return True

    def delete_images(self, filepaths: List[Union[str, Path]]) -> int:
        """
        Menghapus beberapa file gambar sekaligus.

        Args:
            filepaths: Daftar path file yang ingin dihapus.

        Returns:
            Jumlah file yang berhasil dihapus.
        """
        deleted_count = 0
        for fp in filepaths:
            if self.delete_image(fp):
                deleted_count += 1
        return deleted_count

    def import_image(
        self,
        image_path: Union[str, Path],
        target_class: Optional[str] = None,
        source: str = "own_import",
        check_duplicate: bool = True
    ) -> Path:
        """
        Mengimpor satu file gambar dari lokasi lokal mana pun ke dataset target class.

        Args:
            image_path: Path file gambar asal.
            target_class: Nama kelas target (default: kelas aktif).
            source: Kategori sumber data (default: 'own_import').
            check_duplicate: Cek duplikasi menggunakan hash.

        Returns:
            Path file baru di folder dataset.
        """
        src_path = Path(image_path).resolve()
        if not src_path.exists() or not src_path.is_file():
            raise FileNotFoundError(f"File gambar tidak ditemukan: {src_path}")

        if src_path.suffix.lower() not in SUPPORTED_EXTENSIONS:
            raise DatasetSaveError(f"Format gambar {src_path.suffix} tidak didukung.")

        dest_class = target_class or self.current_class
        dest_class = validate_class_name(dest_class)
        dest_dir = self.base_dir / dest_class
        dest_dir.mkdir(parents=True, exist_ok=True)

        if check_duplicate and self.enable_deduplication:
            file_hash = compute_image_hash(src_path)
            if file_hash in self._known_hashes:
                raise DuplicateImageError(f"Gambar {src_path.name} duplikat (SHA256: {file_hash[:12]}...).")

        # Baca dan tulis ulang untuk memastikan integritas
        img = cv2.imread(str(src_path))
        if img is None or img.size == 0:
            raise DatasetSaveError(f"Gagal membaca citra dari: {src_path}")

        # Simpan ke target
        prev_class = self.current_class
        if dest_class != self.current_class:
            self.set_class(dest_class)

        saved_path = self.save_image(
            img,
            ext=src_path.suffix.lstrip("."),
            source=source,
            check_duplicate=check_duplicate
        )

        if prev_class != dest_class:
            self.set_class(prev_class)

        return saved_path

    def import_folder(
        self,
        folder_path: Union[str, Path],
        target_class: Optional[str] = None,
        source: str = "own_import",
        check_duplicate: bool = True
    ) -> Dict[str, Any]:
        """
        Mengimpor seluruh citra valid dari sebuah folder.

        Args:
            folder_path: Path direktori folder asal.
            target_class: Nama kelas target (default: kelas aktif).
            source: Kategori sumber data (default: 'own_import').
            check_duplicate: Cek duplikasi.

        Returns:
            Dictionary rekap hasil impor {imported, duplicates, skipped, files}.
        """
        folder = Path(folder_path).resolve()
        if not folder.exists() or not folder.is_dir():
            raise FileNotFoundError(f"Folder tidak ditemukan: {folder}")

        target_cls = target_class or self.current_class
        target_cls = validate_class_name(target_cls)

        imported_files: List[Path] = []
        duplicate_count = 0
        skipped_count = 0

        for file_path in folder.iterdir():
            if file_path.is_file() and file_path.suffix.lower() in SUPPORTED_EXTENSIONS:
                try:
                    new_path = self.import_image(
                        file_path,
                        target_class=target_cls,
                        source=source,
                        check_duplicate=check_duplicate
                    )
                    imported_files.append(new_path)
                except DuplicateImageError:
                    duplicate_count += 1
                except Exception as e:
                    logger.warning(f"Lewati file {file_path.name}: {e}")
                    skipped_count += 1

        self._refresh_count()
        return {
            "imported": len(imported_files),
            "duplicates": duplicate_count,
            "skipped": skipped_count,
            "files": imported_files,
            "target_class": target_cls
        }

    def _record_metadata(self, filename: str, class_name: str, source: str, filepath: Path) -> None:
        """Mencatat informasi sumber dan hash ke metadata file."""
        if not self.metadata_file:
            return

        try:
            self.metadata_file.parent.mkdir(parents=True, exist_ok=True)
            existing_data = {}
            if self.metadata_file.exists():
                try:
                    with open(self.metadata_file, "r", encoding="utf-8") as f:
                        loaded = yaml.safe_load(f)
                        if isinstance(loaded, dict):
                            existing_data = loaded
                except Exception:
                    existing_data = {}

            if "items" not in existing_data:
                existing_data["items"] = {}

            h = compute_image_hash(filepath) if filepath.exists() else ""
            existing_data["items"][filename] = {
                "class": class_name,
                "source": source,
                "hash_sha256": h,
                "recorded_at": datetime.now().isoformat()
            }

            with open(self.metadata_file, "w", encoding="utf-8") as f:
                yaml.dump(existing_data, f, default_flow_style=False, sort_keys=False)
        except Exception as err:
            logger.debug(f"Gagal mencatat metadata: {err}")
