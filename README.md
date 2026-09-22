# VisionX 👁️⚡

> **Realtime Computer Vision & Deep Learning Object Detection System**

VisionX adalah fondasi sistem Computer Vision jangka panjang yang dirancang untuk mengenali berbagai objek dan informasi visual secara realtime dari video stream (webcam, kamera eksternal, CCTV/RTSP, hingga kamera smartphone di masa depan).

Saat ini VisionX telah mencapai **Versi 0.3 (Dataset Preparation Pipeline)** dengan tetap mempertahankan **V0.1 (Realtime Object Detection)** dan **V0.2 (Dataset Collection System)** secara modular, stabil, dan teruji.

---

## ✨ Fitur VisionX

### 1. V0.1 - Realtime Object Detection
- **Pretrained YOLO Inference**: Deteksi instan berbagai objek menggunakan bobot `yolov8n.pt`.
- **Estetika UI & Visualisasi**: Bounding box beraksen sudut modern, label kelas, nilai confidence, dan badge realtime FPS yang dihaluskan (*smoothed*).
- **Arsitektur Modular**: Pemisahan tegas antara Camera Stream, AI Inference, dan UI Visualizer.

### 2. V0.2 - Dataset Collection System
- **Struktur Dataset Terstandarisasi**: Pengambilan citra asli mentah (*clean raw frames*) tanpa kontaminasi anotasi ke `datasets/raw/<class_name>/`.
- **Pengambilan Gambar Keyboard-Triggered**: Tekan tombol `SPACE` atau `c` untuk mengambil foto.
- **Nama File Otomatis & Unik**: Format `<class>_<timestamp>_<uuid>.jpg` tanpa risiko menimpa file lama (*collision-safe*).
- **Ganti Kelas Tanpa Restart**: Tekan tombol `n` untuk membuka dialog pengetikan nama kelas langsung di layar (*on-screen modal dialog*).
- **Validasi Nama Kelas Aman**: Sanitasi nama folder otomatis (mencegah karakter ilegal dan nama reserved sistem Windows).
- **Non-Breaking Dual-Mode**: Beralih mode deteksi $\leftrightarrow$ koleksi kapan saja dengan menekan tombol `m`.

### 3. V0.3 - Dataset Preparation Pipeline *(Baru!)*
- **End-to-End Preparation Workflow**:
  ```text
  Capture (V0.2) 
    ↳ Annotate using CVAT / Label Studio 
        ↳ Export YOLO 
            ↳ Import 
                ↳ Validate 
                    ↳ Split (Train/Val/Test) 
                        ↳ Prepare 
                            ↳ Generate dataset.yaml 
                                ↳ Ready for V0.4 Training
  ```
- **YOLO Annotation Support**: Mendukung pasangan `image.jpg` dan `image.txt` dengan format normalisasi standar:
  `class_id x_center y_center width height` (nilai float $[0.0, 1.0]$).
- **Validasi Komprehensif (`DatasetValidator`)**:
  - Pengecekan keterbacaan citra (resolusi $> 0$ via OpenCV).
  - Pengecekan keterbacaan dan struktur file anotasi.
  - Validasi koordinat bounding box agar berada di dalam batas citra ($[0.0, 1.0]$).
  - Deteksi citra tanpa label (*missing labels*) dan label tanpa citra (*orphaned labels*).
  - Deteksi file anotasi kosong (*empty labels*) atau rusak (*corrupted annotations*).
  - Deteksi citra duplikat berbasis SHA256 image hash.
  - Perhitungan jumlah objek dan citra per kelas.
- **Class Registry Terpusat (`ClassRegistry`)**:
  - Pemetaan konsisten antara `class_id` dan `class_name` via `datasets/metadata/classes.yaml`.
  - Menjamin ID kelas tidak bergeser saat dataset diproses ulang atau ditambah kelas baru.
- **Reproducible Split & Anti Data-Leakage (`DatasetSplitter`)**:
  - Pembagian partisi `train` (80%), `val` (10%), dan `test` (10%) yang dapat dikonfigurasi.
  - Random seed yang dapat ditentukan (misal `--seed 42`) untuk reproduktibilitas 100%.
  - **Anti-Leakage Grouping**: Citra dengan hash identik dikelompokkan ke partisi yang sama sehingga tidak bocor antar train, val, dan test.
- **Otomatisasi `dataset.yaml` (`DatasetYAMLGenerator`)**:
  - Membuat file konfigurasi resmi Ultralytics YOLO (`dataset.yaml`) berisi path relatif/absolut dan daftar nama kelas.
- **Statistik Dataset Mendalam (`DatasetStats`)**:
  - Menampilkan ringkasan total citra, total objek, sebaran per kelas, perbandingan split, serta audit integritas dataset.
- **Antarmuka CLI Terpadu**: Tersedia melalui perintah `python -m app.dataset <subcommand>`.

---

## 📁 Struktur Direktori

```text
VisionX/
├── app/
│   ├── __init__.py
│   ├── main.py          # Entry point aplikasi (Dual-Mode: Detect & Collect)
│   ├── config.py        # Dataclass AppConfig & CLI argument parser
│   ├── detector.py      # YOLOObjectDetector (AI) & Visualizer (HUD & UI)
│   ├── camera.py        # CameraStream lifecycle & error handling
│   ├── collector.py     # DatasetCollector & validasi nama kelas (V0.2)
│   └── dataset.py       # Dataset Preparation Pipeline, Validator & CLI (V0.3)
├── models/              # Bobot model (*.pt, *.onnx)
│   ├── README.md
│   └── yolov8n.pt
├── datasets/            # Arsitektur dataset terstruktur
│   ├── raw/             # Foto mentah per kelas dari V0.2 (diabaikan git)
│   │   ├── README.md
│   │   ├── bottle/
│   │   ├── glass/
│   │   └── charger/
│   ├── imported/        # Pasangan gambar + label YOLO hasil export CVAT/Label Studio
│   │   └── README.md
│   ├── processed/       # Dataset hasil split siap training YOLO
│   │   ├── README.md
│   │   ├── dataset.yaml # Konfigurasi resmi YOLO (dihasilkan otomatis)
│   │   ├── images/
│   │   │   ├── train/
│   │   │   ├── val/
│   │   │   └── test/
│   │   └── labels/
│   │       ├── train/
│   │       ├── val/
│   │       └── test/
│   ├── annotations/     # Arsip label anotasi
│   │   └── README.md
│   └── metadata/        # Konfigurasi registry kelas
│       ├── classes.yaml # Mapping stabil: 0: glass, 1: bottle, 2: charger
│       └── README.md
├── tests/               # Automated unit testing suite (21 tests)
│   ├── test_camera.py
│   ├── test_detector.py
│   ├── test_collector.py
│   └── test_dataset.py  # Unit tests pipeline V0.3
├── requirements.txt     # Dependensi Python (PyTorch, Ultralytics, OpenCV, NumPy, PyYAML)
├── .gitignore           # Filter cache, venv, model binary, & dataset
└── README.md            # Dokumentasi lengkap
```

---

## 🛠️ Prasyarat Sistem

* **Python**: Versi 3.11 atau lebih baru
* **Sistem Operasi**: Windows 10/11, macOS, atau Linux
* **Akselerasi Hardware**: CPU atau GPU NVIDIA (CUDA)

---

## 🚀 Panduan Instalasi

### 1. Masuk ke Direktori Project
```bash
cd VisionX
```

### 2. Buat Virtual Environment
**Windows (PowerShell):**
```powershell
python -m venv .venv
.venv\Scripts\activate
```

**macOS/Linux:**
```bash
python3 -m venv .venv
source .venv/bin/activate
```

### 3. Install Dependensi
```bash
pip install -r requirements.txt
```

---

## 💻 Panduan Penggunaan

### A. Realtime Object Detection (V0.1)
```powershell
# Jalankan deteksi objek realtime dengan webcam
python app/main.py

# Menggunakan parameter custom
python app/main.py --conf 0.50 --model models/yolov8n.pt
```

### B. Dataset Collection (V0.2)
```powershell
# Jalankan mode koleksi foto untuk kelas tertentu
python app/main.py --mode collect --class bottle

# Tombol interaktif saat preview:
# [SPACE] / [C] : Ambil foto bersih (disimpan ke datasets/raw/<class>/)
# [N]           : Buka dialog pengetikan ganti kelas on-screen
# [M]           : Toggle mode deteksi <-> koleksi
# [Q] / [ESC]   : Keluar
```

---

### C. Dataset Preparation Pipeline (V0.3)

#### Alur Kerja Lengkap:
1. **Kumpulkan Foto**: Ambil foto objek menggunakan V0.2 (`datasets/raw/<class>/`).
2. **Anotasi Eksternal**: Anotasi gambar menggunakan **CVAT**, **Label Studio**, atau **Roboflow**.
3. **Ekspor YOLO**: Ekspor hasil anotasi dalam format **YOLO 1.0** (pasangan file `.jpg` dan `.txt`).
4. **Impor / Letakkan**: Letakkan pasangan gambar & label ke folder sumber (misal `datasets/imported/`).
5. **Jalankan Pipeline VisionX**:

#### 1. Validasi Integritas Dataset (`validate`)
Memeriksa keterbacaan file, format koordinat YOLO, missing/orphaned labels, dan duplikasi:
```powershell
python -m app.dataset validate --source datasets/imported --classes datasets/metadata/classes.yaml
```

#### 2. Menjalankan Alur Lengkap Persiapan Dataset (`prepare`)
Menjalankan validasi $\rightarrow$ class registry $\rightarrow$ train/val/test split anti data-leakage $\rightarrow$ generate `dataset.yaml` $\rightarrow$ menampilkan statistik:
```powershell
python -m app.dataset prepare --source datasets/imported --dest datasets/processed --classes datasets/metadata/classes.yaml --train 0.8 --val 0.1 --test 0.1 --seed 42
```

#### 3. Membagi Dataset Saja (`split`)
```powershell
python -m app.dataset split --source datasets/imported --dest datasets/processed --train 0.8 --val 0.1 --test 0.1 --seed 42
```

#### 4. Menampilkan Statistik Dataset (`stats`)
```powershell
python -m app.dataset stats --source datasets/processed
```
*Contoh Output Statistik:*
```text
=============================================
Dataset Statistics
=============================================
Images: 1500
Objects: 2340

Objects per Class:
  glass: 700
  bottle: 500
  charger: 300

Splits:
  Train: 1200
  Val: 150
  Test: 150

Quality & Integrity:
  Invalid annotations: 0
  Missing labels: 0
=============================================
```

#### 5. Mengimpor Pasangan Citra & Label dari Direktori Eksternal (`import`)
```powershell
python -m app.dataset import --source "D:/Downloads/my_annotated_batch" --dest datasets/imported
```

---

## ⚙️ Ringkasan Opsi CLI `app.dataset`

| Subcommand | Argumen | Default | Deskripsi |
|---|---|---|---|
| `validate` | `--source` | *wajib* | Direktori dataset yang akan diperiksa |
| | `--classes` | `None` | Path file `classes.yaml` untuk validasi class ID |
| `split` | `--source` | *wajib* | Direktori dataset sumber |
| | `--dest` | `datasets/processed` | Direktori tujuan output YOLO |
| | `--train` / `--val` / `--test` | `0.8` / `0.1` / `0.1` | Proporsi pembagian dataset |
| | `--seed` | `42` | Random seed untuk reproduktibilitas |
| | `--allow-leakage` | `False` | Nonaktifkan pengelompokan hash anti-leakage |
| `stats` | `--source` | `datasets/processed` | Direktori dataset yang ingin dihitung statistiknya |
| `prepare` | `--source` | *wajib* | Menjalankan seluruh alur validasi, split, yaml, stats |
| `import` | `--source` / `--dest` | *wajib* / `datasets/imported` | Menyalin pasangan gambar + label |

---

## 🧪 Menjalankan Automated Testing

Untuk memvalidasi seluruh fungsionalitas modul V0.1, V0.2, dan V0.3:

```powershell
.venv\Scripts\python -m unittest discover tests
```

Output:
```text
Ran 21 tests in ...s
OK
```

Cakupan pengujian (21 unit tests):
- `test_dataset.py`:
  - Validasi format baris YOLO valid & boundary overflow check.
  - Penolakan token invalid, koordinat out-of-bounds ($<0$ atau $>1$), dan class ID negatif.
  - Class Registry persistence (YAML save/load) & pencegahan class ID shift.
  - Deteksi missing label, orphaned label, empty label, dan corrupted image.
  - Split reproducibility via random seed & pengelompokan citra duplikat (anti-leakage).
  - Pembuatan `dataset.yaml` format standar Ultralytics.
  - Perhitungan metrik statistik dataset.
- `test_collector.py`: Validasi nama kelas, counter, runtime class switching, dan unique naming.
- `test_camera.py`: Lifecycle camera stream, synthetic stream, dan context manager.
- `test_detector.py`: Inferensi YOLO, error handling model, dan visualizer HUD.

---

## 🗺️ Roadmap Pengembangan VisionX

- [x] **V0.1 (MVP)**: Realtime object detection modular berbasis webcam + pretrained YOLO.
- [x] **V0.2**: Dataset Collection System terstruktur, keyboard capture, unique naming, class switching tanpa restart.
- [x] **V0.3**: Dataset Preparation Pipeline (YOLO validation, class registry, anti-leakage split, dataset.yaml, stats & CLI).
- [ ] **V0.4**: Custom Model Training Pipeline (Fine-tuning Ultralytics YOLO menggunakan `datasets/processed/dataset.yaml`).
- [ ] **V0.5**: Integrasi kamera smartphone (IP Webcam / RTSP stream / DroidCam).
- [ ] **V0.6**: Object Tracking & Model Optimization (ByteTrack / ONNX / TensorRT / OpenVINO).
