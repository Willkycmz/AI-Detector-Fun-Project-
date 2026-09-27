"""
VisionX Identity Lab - Face Recognition & Identification Module (V0.6)
Mengimplementasikan pipeline pengenalan wajah:
Camera -> Face Detection (YuNet) -> Face Alignment -> Face Embedding (SFace) -> Similarity Matching -> Identity Decision

Fitur Privasi & Keamanan:
- Hanya mencocokkan profil terdaftar eksplisit: "VisionX Developer".
- Wajah yang tidak cocok atau tidak terdaftar diberi label "PERSON • UNKNOWN".
- Tidak melakukan identifikasi liar terhadap orang yang tidak terdaftar.
- Data referensi citra dan embeddings disimpan lokal secara terpisah: datasets/faces/developer/.
- 100% lokal, tanpa upload ke cloud.
"""

import os
import json
import base64
import logging
from pathlib import Path
from typing import List, Dict, Any, Optional, Tuple, Union
import cv2
import numpy as np

logger = logging.getLogger(__name__)

DEFAULT_PROFILE_NAME = "VisionX Developer"
DEFAULT_PROFILE_ID = "developer"
DEFAULT_FACES_DIR = Path("datasets/faces/developer")
DEFAULT_THRESHOLD = 0.60

YUNET_MODEL_PATH = Path("models/face/face_detection_yunet.onnx")
SFACE_MODEL_PATH = Path("models/face/face_recognition_sface.onnx")


class FaceDetector:
    """Mengelola deteksi wajah dan ekstraksi 5 landmark wajah menggunakan YuNet."""

    def __init__(self, model_path: Union[str, Path] = YUNET_MODEL_PATH, conf_threshold: float = 0.5):
        self.model_path = Path(model_path).resolve()
        self.conf_threshold = conf_threshold
        self._detector: Optional[cv2.FaceDetectorYN] = None
        self._current_size = (320, 320)
        self._init_model()

    def _init_model(self) -> None:
        if not self.model_path.exists():
            raise FileNotFoundError(f"Model YuNet tidak ditemukan di: {self.model_path}")
        self._detector = cv2.FaceDetectorYN.create(
            str(self.model_path),
            "",
            self._current_size,
            self.conf_threshold,
            0.3,  # NMS threshold
            5000  # Top K
        )

    def detect(self, image: np.ndarray) -> List[np.ndarray]:
        """
        Mendeteksi wajah pada citra dan mengembalikan array wajah + landmark.
        Format per wajah: [x, y, w, h, x_re, y_re, x_le, y_le, x_nt, y_nt, x_rcm, y_rcm, x_lcm, y_lcm, score]
        """
        if self._detector is None:
            self._init_model()

        h, w = image.shape[:2]
        if (w, h) != self._current_size:
            self._current_size = (w, h)
            self._detector.setInputSize((w, h))

        _, faces = self._detector.detect(image)
        if faces is None or len(faces) == 0:
            return []
        return [f for f in faces]


class FaceEmbedder:
    """Mengelola face alignment dan ekstraksi feature embedding 128-d menggunakan SFace."""

    def __init__(self, model_path: Union[str, Path] = SFACE_MODEL_PATH):
        self.model_path = Path(model_path).resolve()
        self._recognizer: Optional[cv2.FaceRecognizerSF] = None
        self._init_model()

    def _init_model(self) -> None:
        if not self.model_path.exists():
            raise FileNotFoundError(f"Model SFace tidak ditemukan di: {self.model_path}")
        self._recognizer = cv2.FaceRecognizerSF.create(str(self.model_path), "")

    def align_and_embed(self, image: np.ndarray, face_data: np.ndarray) -> Tuple[np.ndarray, np.ndarray]:
        """
        Menyelaraskan wajah (alignment) dan mengekstrak embedding fitur (128-d).
        Returns: (aligned_crop_image, feature_embedding)
        """
        if self._recognizer is None:
            self._init_model()

        aligned = self._recognizer.alignCrop(image, face_data)
        embedding = self._recognizer.feature(aligned)
        return aligned, embedding

    def match(self, embedding1: np.ndarray, embedding2: np.ndarray) -> float:
        """Menghitung cosine similarity antara dua embedding wajah."""
        if self._recognizer is None:
            self._init_model()

        score = self._recognizer.match(embedding1, embedding2, cv2.FaceRecognizerSF_FR_COSINE)
        return float(score)


class IdentityManager:
    """
    Mengelola registrasi identitas, penyimpanan foto referensi pengembang,
    ekstraksi embeddings, dan pencocokan wajah secara realtime.
    """

    def __init__(
        self,
        profile_name: str = DEFAULT_PROFILE_NAME,
        profile_id: str = DEFAULT_PROFILE_ID,
        faces_dir: Union[str, Path] = DEFAULT_FACES_DIR,
        threshold: float = DEFAULT_THRESHOLD
    ):
        self.profile_name = profile_name
        self.profile_id = profile_id
        self.faces_dir = Path(faces_dir).resolve()
        self.faces_dir.mkdir(parents=True, exist_ok=True)
        self.threshold = threshold

        self.metadata_file = self.faces_dir / "identity.json"
        self.embeddings_file = self.faces_dir / "embeddings.npy"

        self.detector = FaceDetector()
        self.embedder = FaceEmbedder()

        self._load_or_create_identity()

    def _load_or_create_identity(self) -> None:
        """Memuat atau menginisialisasi metadata identitas."""
        if not self.metadata_file.exists():
            data = {
                "profile_id": self.profile_id,
                "profile_name": self.profile_name,
                "registered": True,
                "created_at": cv2.getTickCount(),
                "reference_count": 0,
                "references": []
            }
            with open(self.metadata_file, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2)
            self.metadata = data
        else:
            try:
                with open(self.metadata_file, "r", encoding="utf-8") as f:
                    self.metadata = json.load(f)
            except Exception as e:
                logger.error(f"Gagal membaca identity.json: {e}")
                self.metadata = {
                    "profile_id": self.profile_id,
                    "profile_name": self.profile_name,
                    "registered": True,
                    "references": []
                }

    def _save_metadata(self) -> None:
        """Menyimpan pembaruan metadata ke identity.json."""
        with open(self.metadata_file, "w", encoding="utf-8") as f:
            json.dump(self.metadata, f, indent=2)

    def register_profile(self, name: str) -> Dict[str, Any]:
        """Mendaftarkan atau memperbarui nama profil pengembang."""
        if not name or not name.strip():
            raise ValueError("Nama profil tidak boleh kosong.")
        self.profile_name = name.strip()
        self.metadata["profile_name"] = self.profile_name
        self.metadata["registered"] = True
        self._save_metadata()
        return self.metadata

    def list_reference_images(self) -> List[Dict[str, Any]]:
        """Mengembalikan daftar foto referensi yang terdaftar di disk."""
        supported_exts = {".jpg", ".jpeg", ".png", ".webp"}
        files = []
        for p in self.faces_dir.iterdir():
            if p.is_file() and p.suffix.lower() in supported_exts:
                stat = p.stat()
                files.append({
                    "filename": p.name,
                    "path": str(p),
                    "size_bytes": stat.st_size,
                    "formatted_size": f"{stat.st_size / 1024:.1f} KB",
                    "mtime": stat.st_mtime
                })
        files.sort(key=lambda x: x["mtime"], reverse=True)
        return files

    def add_reference_image(
        self,
        image_or_path: Union[str, Path, np.ndarray],
        filename: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Menambahkan foto wajah referensi pengembang, memverifikasi wajah terdeteksi,
        mengekstrak embedding, dan menyimpannya di datasets/faces/developer/.
        """
        if isinstance(image_or_path, (str, Path)):
            p = Path(image_or_path)
            if not p.exists():
                raise FileNotFoundError(f"File citra tidak ditemukan: {p}")
            img = cv2.imread(str(p))
            if img is None:
                raise ValueError("Format citra tidak dapat dibaca oleh OpenCV.")
            if filename is None:
                filename = p.name
        elif isinstance(image_or_path, np.ndarray):
            img = image_or_path
            if filename is None:
                now_str = cv2.getTickCount()
                filename = f"developer_ref_{now_str}.jpg"
        else:
            raise TypeError("Input harus berupa path file atau np.ndarray.")

        # Deteksi wajah pada foto referensi
        faces = self.detector.detect(img)
        if len(faces) == 0:
            raise ValueError("Tidak ada wajah yang terdeteksi pada citra referensi ini. Pastikan wajah terlihat jelas.")

        # Pilih wajah terbesar jika ada lebih dari satu
        primary_face = max(faces, key=lambda f: f[2] * f[3])
        aligned_face, embedding = self.embedder.align_and_embed(img, primary_face)

        # Simpan citra referensi ke folder developer
        target_path = self.faces_dir / filename
        cv2.imwrite(str(target_path), img)

        # Perbarui metadata & simpan embeddings
        self._rebuild_embeddings_index()
        self.metadata["reference_count"] = len(self.list_reference_images())
        self._save_metadata()

        return {
            "success": True,
            "filename": filename,
            "saved_path": str(target_path),
            "face_box": [int(primary_face[0]), int(primary_face[1]), int(primary_face[2]), int(primary_face[3])],
            "confidence": float(primary_face[-1]),
            "total_references": self.metadata["reference_count"]
        }

    def delete_reference_image(self, filename: str) -> bool:
        """Menghapus foto referensi tertentu dan menyinkronkan ulang embeddings."""
        target_path = self.faces_dir / filename
        deleted = False
        if target_path.exists() and target_path.is_file():
            target_path.unlink()
            deleted = True

        self._rebuild_embeddings_index()
        self.metadata["reference_count"] = len(self.list_reference_images())
        self._save_metadata()
        return deleted

    def _rebuild_embeddings_index(self) -> None:
        """Mengekstrak dan menyimpan matriks embeddings dari seluruh foto referensi."""
        refs = self.list_reference_images()
        embeddings_list = []
        valid_refs = []

        for ref in refs:
            img = cv2.imread(ref["path"])
            if img is None:
                continue
            faces = self.detector.detect(img)
            if len(faces) > 0:
                primary_face = max(faces, key=lambda f: f[2] * f[3])
                _, emb = self.embedder.align_and_embed(img, primary_face)
                embeddings_list.append(emb)
                valid_refs.append(ref["filename"])

        if len(embeddings_list) > 0:
            stacked = np.vstack(embeddings_list)
            np.save(str(self.embeddings_file), stacked)
        else:
            if self.embeddings_file.exists():
                self.embeddings_file.unlink()

        self.metadata["enrolled_references"] = valid_refs
        self._save_metadata()

    def get_enrolled_embeddings(self) -> Optional[np.ndarray]:
        """Mengembalikan matriks embeddings terdaftar dari disk."""
        if not self.embeddings_file.exists():
            self._rebuild_embeddings_index()

        if self.embeddings_file.exists():
            try:
                return np.load(str(self.embeddings_file))
            except Exception as e:
                logger.error(f"Gagal memuat embeddings.npy: {e}")
                return None
        return None

    def detect_faces(self, query_image: np.ndarray) -> Dict[str, Any]:
        """
        Deteksi wajah realtime berkecepatan tinggi (~5ms) murni menggunakan YuNet.
        Tidak menjalankan ekstraksi embedding SFace atau pencocokan identitas.
        """
        faces = self.detector.detect(query_image)
        if len(faces) == 0:
            return {
                "success": True,
                "detected": False,
                "faces_count": 0,
                "faces": []
            }

        results = []
        for face in faces:
            box = [int(face[0]), int(face[1]), int(face[2]), int(face[3])]
            conf = float(face[-1])
            results.append({
                "box": box,
                "bbox": {
                    "x1": box[0],
                    "y1": box[1],
                    "x2": box[0] + box[2],
                    "y2": box[1] + box[3]
                },
                "confidence": conf
            })

        results.sort(key=lambda r: r["box"][2] * r["box"][3], reverse=True)
        return {
            "success": True,
            "detected": True,
            "faces_count": len(results),
            "faces": results
        }

    def match_face(
        self,
        query_image: np.ndarray,
        threshold: Optional[float] = None
    ) -> Dict[str, Any]:
        """
        Mendeteksi wajah pada query image dan mencocokkan dengan profil terdaftar.
        
        Aturan Keputusan (Safety & Privacy):
        - Jika similarity >= threshold: label = "VISIONX DEVELOPER", matching_score = score
        - Jika similarity < threshold atau tidak cocok: label = "PERSON • UNKNOWN"
        - Jangan pernah menyimpulkan nama orang selain yang terdaftar.
        """
        thresh = threshold if threshold is not None else self.threshold
        faces = self.detector.detect(query_image)

        if len(faces) == 0:
            return {
                "detected": False,
                "faces_count": 0,
                "faces": [],
                "primary_match": {
                    "matched": False,
                    "label": "NO FACE DETECTED",
                    "similarity": 0.0,
                    "score_percent": "0%",
                    "identityStatus": "UNREGISTERED"
                }
            }

        enrolled_embs = self.get_enrolled_embeddings()
        results = []

        for face in faces:
            box = [int(face[0]), int(face[1]), int(face[2]), int(face[3])]
            conf = float(face[-1])
            _, emb = self.embedder.align_and_embed(query_image, face)

            max_similarity = 0.0
            if enrolled_embs is not None and len(enrolled_embs) > 0:
                for ref_emb in enrolled_embs:
                    score = self.embedder.match(emb, ref_emb.reshape(1, -1))
                    if score > max_similarity:
                        max_similarity = score

            # Evaluasi keputusan
            is_match = max_similarity >= thresh
            if is_match:
                label = "VISIONX DEVELOPER"
                identity_status = "REGISTERED"
            else:
                label = "PERSON • UNKNOWN"
                identity_status = "UNREGISTERED"

            score_percent = f"{max(0.0, min(100.0, max_similarity * 100)):.1f}%"
            results.append({
                "box": box,
                "bbox": {
                    "x1": box[0],
                    "y1": box[1],
                    "x2": box[0] + box[2],
                    "y2": box[1] + box[3]
                },
                "confidence": conf,
                "matched": is_match,
                "label": label,
                "identityStatus": identity_status,
                "similarity": float(max_similarity),
                "score_percent": score_percent
            })

        # Urutkan berdasarkan ukuran kotak wajah (terbesar lebih dulu)
        results.sort(key=lambda r: r["box"][2] * r["box"][3], reverse=True)
        primary = results[0]

        return {
            "detected": True,
            "faces_count": len(results),
            "faces": results,
            "primary_match": primary
        }


def main():
    """CLI untuk pengujian langsung dan administrasi Identity Lab."""
    import argparse

    parser = argparse.ArgumentParser(description="VisionX Identity Lab CLI (V0.6)")
    subparsers = parser.add_subparsers(dest="command", help="Perintah")

    # Status
    subparsers.add_parser("status", help="Menampilkan status profil pengembang")

    # Register
    reg_parser = subparsers.add_parser("register", help="Mendaftarkan nama profil pengembang")
    reg_parser.add_argument("--name", default=DEFAULT_PROFILE_NAME, help="Nama profil")

    # Add Reference
    add_parser = subparsers.add_parser("add-reference", help="Menambahkan citra referensi pengembang")
    add_parser.add_argument("--image", required=True, help="Path citra referensi")

    # List References
    subparsers.add_parser("list", help="Melihat daftar citra referensi terdaftar")

    # Delete Reference
    del_parser = subparsers.add_parser("delete-reference", help="Menghapus citra referensi")
    del_parser.add_argument("--filename", required=True, help="Nama file citra referensi")

    # Match Face
    match_parser = subparsers.add_parser("match", help="Mencocokkan citra wajah dengan profil pengembang")
    match_parser.add_argument("--image", required=True, help="Path citra yang ingin diuji")
    match_parser.add_argument("--threshold", type=float, default=DEFAULT_THRESHOLD, help="Threshold kemiripan")

    args = parser.parse_args()
    manager = IdentityManager()

    if args.command == "status":
        print(json.dumps(manager.metadata, indent=2))
    elif args.command == "register":
        res = manager.register_profile(args.name)
        print(f"Profil berhasil didaftarkan: {res['profile_name']}")
    elif args.command == "add-reference":
        res = manager.add_reference_image(args.image)
        print(f"Foto referensi berhasil ditambahkan: {res['filename']} (Total: {res['total_references']})")
    elif args.command == "list":
        refs = manager.list_reference_images()
        print(f"Total referensi terdaftar: {len(refs)}")
        for r in refs:
            print(f"- {r['filename']} ({r['formatted_size']})")
    elif args.command == "delete-reference":
        ok = manager.delete_reference_image(args.filename)
        print(f"Hapus {args.filename}: {'Berhasil' if ok else 'File tidak ditemukan'}")
    elif args.command == "match":
        img = cv2.imread(args.image)
        if img is None:
            print(f"Error: Tidak dapat membaca citra {args.image}")
            return
        res = manager.match_face(img, args.threshold)
        print(json.dumps(res, indent=2))
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
