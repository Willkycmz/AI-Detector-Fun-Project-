"""
Unit Tests untuk VisionX Identity Lab (V0.6)
Menguji:
- Inisialisasi detector (YuNet) & embedder (SFace)
- Registrasi profil pengembang ("VisionX Developer")
- Penambahan foto referensi & ekstraksi embeddings
- Pencocokan identitas (known face -> "VISIONX DEVELOPER", unknown face -> "PERSON • UNKNOWN")
- Penghapusan foto referensi & sinkronisasi ulang
- Aspek safety & privacy: unknown face tidak pernah diberi nama sembarangan
"""

import os
import shutil
import pytest
import numpy as np
import cv2
from pathlib import Path

from app.identity import (
    FaceDetector,
    FaceEmbedder,
    IdentityManager,
    DEFAULT_PROFILE_NAME,
    DEFAULT_THRESHOLD
)


@pytest.fixture
def temp_identity_dir(tmp_path):
    """Fixture direktori terisolasi untuk pengujian IdentityManager."""
    faces_dir = tmp_path / "faces" / "developer"
    faces_dir.mkdir(parents=True, exist_ok=True)
    return faces_dir


@pytest.fixture
def sample_faces():
    """Mencari citra yang memiliki deteksi wajah valid dari dataset train untuk pengujian."""
    processed_dir = Path("datasets/processed/images/train")
    detector = FaceDetector()

    found_images = []
    if processed_dir.exists():
        for p in processed_dir.glob("*.jpg"):
            img = cv2.imread(str(p))
            if img is not None:
                faces = detector.detect(img)
                if len(faces) >= 2:
                    found_images.append((p, img, faces))
                    break

    return found_images


def test_detector_initialization():
    """Memastikan FaceDetector dapat diinisialisasi dengan model YuNet."""
    detector = FaceDetector()
    assert detector is not None
    assert detector.conf_threshold == 0.5


def test_embedder_initialization():
    """Memastikan FaceEmbedder dapat diinisialisasi dengan model SFace."""
    embedder = FaceEmbedder()
    assert embedder is not None


def test_identity_manager_init(temp_identity_dir):
    """Memastikan IdentityManager dapat membuat file metadata identitas awal."""
    manager = IdentityManager(faces_dir=temp_identity_dir)
    assert manager.profile_name == DEFAULT_PROFILE_NAME
    assert (temp_identity_dir / "identity.json").exists()
    assert manager.metadata["profile_id"] == "developer"
    assert manager.metadata["registered"] is True


def test_register_profile(temp_identity_dir):
    """Memastikan pembaruan nama profil pengembang berhasil tersimpan."""
    manager = IdentityManager(faces_dir=temp_identity_dir)
    res = manager.register_profile("Lead VisionX Developer")
    assert res["profile_name"] == "Lead VisionX Developer"
    assert manager.profile_name == "Lead VisionX Developer"

    # Uji validasi nama kosong
    with pytest.raises(ValueError):
        manager.register_profile("")


def test_add_reference_and_match(temp_identity_dir, sample_faces):
    """
    Memastikan citra referensi dapat didaftarkan, embeddings terekstrak,
    dan pencocokan menghasilkan:
    - Known face -> 'VISIONX DEVELOPER'
    - Unknown face -> 'PERSON • UNKNOWN'
    """
    if not sample_faces:
        pytest.skip("Dataset pengujian citra wajah tidak tersedia.")

    path, img, faces = sample_faces[0]
    manager = IdentityManager(faces_dir=temp_identity_dir, threshold=DEFAULT_THRESHOLD)

    # Potong 2 wajah berbeda dari citra yang sama
    recognizer = cv2.FaceRecognizerSF.create(str(manager.embedder.model_path), "")

    # Daftarkan wajah 0 sebagai Developer
    aligned0 = recognizer.alignCrop(img, faces[0])
    add_res = manager.add_reference_image(aligned0, "dev_ref_01.jpg")
    assert add_res["success"] is True
    assert add_res["filename"] == "dev_ref_01.jpg"

    # Verifikasi list references
    refs = manager.list_reference_images()
    assert len(refs) == 1
    assert refs[0]["filename"] == "dev_ref_01.jpg"

    # 1. Uji pencocokan dengan wajah yang SAMA (wajah 0)
    match_same = manager.match_face(aligned0)
    assert match_same["detected"] is True
    assert match_same["primary_match"]["matched"] is True
    assert match_same["primary_match"]["label"] == "VISIONX DEVELOPER"
    assert match_same["primary_match"]["similarity"] >= 0.70

    # 2. Uji pencocokan dengan wajah yang BERBEDA (wajah 1)
    aligned1 = recognizer.alignCrop(img, faces[1])
    match_diff = manager.match_face(aligned1)
    assert match_diff["detected"] is True
    assert match_diff["primary_match"]["matched"] is False
    assert match_diff["primary_match"]["label"] == "PERSON • UNKNOWN"
    assert match_diff["primary_match"]["similarity"] < DEFAULT_THRESHOLD


def test_delete_reference(temp_identity_dir, sample_faces):
    """Memastikan penghapusan citra referensi menghapus file dan memperbarui embeddings."""
    if not sample_faces:
        pytest.skip("Dataset pengujian citra wajah tidak tersedia.")

    path, img, faces = sample_faces[0]
    manager = IdentityManager(faces_dir=temp_identity_dir)

    recognizer = cv2.FaceRecognizerSF.create(str(manager.embedder.model_path), "")
    aligned0 = recognizer.alignCrop(img, faces[0])
    manager.add_reference_image(aligned0, "dev_to_delete.jpg")
    assert len(manager.list_reference_images()) == 1

    # Hapus file
    deleted = manager.delete_reference_image("dev_to_delete.jpg")
    assert deleted is True
    assert len(manager.list_reference_images()) == 0


def test_safety_no_face_detected(temp_identity_dir):
    """Memastikan citra kosong / tanpa wajah ditangani secara aman."""
    manager = IdentityManager(faces_dir=temp_identity_dir)
    blank_img = np.zeros((200, 200, 3), dtype=np.uint8)

    # Menolak penambahan referensi jika tidak ada wajah
    with pytest.raises(ValueError):
        manager.add_reference_image(blank_img, "blank.jpg")

    # Match face pada gambar kosong
    res = manager.match_face(blank_img)
    assert res["detected"] is False
    assert res["primary_match"]["label"] == "NO FACE DETECTED"
