# VisionX V0.6 Dataset Structure & Migration Plan

## 1. Directory Structure Standards
Sesuai arsitektur VisionX V0.6, dataset diatur dalam struktur hirarkis berikut:

```text
datasets/
├── objects/               # Object detection datasets
│   ├── own/               # Live camera captures & local imports
│   └── external/          # HuggingFace, Kaggle, external datasets
├── faces/                 # Face recognition reference datasets (Isolated & Private)
│   └── developer/         # Reference images & embeddings profil "VisionX Developer"
├── processed/             # Formatted YOLO train/val/test splits & dataset.yaml
├── annotations/           # Ground-truth annotations & manifests
├── metadata/              # Sources & dataset provenance tracking
└── .trash/                # Recycle Bin for non-destructive soft deletion
```

## 2. Non-Destructive Migration Strategy
1. **Preservasi Jalur Lama**:
   - Direktori `datasets/raw/own/` dan `datasets/raw/external/` tetap dipertahankan secara utuh agar seluruh pipeline pelatihan, validasi, dan skrip existing (`app/collector.py`, `app/dataset.py`) tetap bekerja 100% tanpa regresi.
2. **Sinkronisasi `datasets/objects/`**:
   - `datasets/objects/` dibuat untuk memfasilitasi pengorganisasian modern VisionX V0.6, dengan bridging otomatis ke `datasets/raw/` tanpa duplikasi penyimpanan yang destruktif.
3. **Isolasi Penuh Face Dataset**:
   - Citra wajah untuk Identity Lab disimpan secara eksklusif di `datasets/faces/developer/`.
   - Citra wajah tidak pernah dicampur dengan dataset deteksi objek atau diekspor ke cloud.
