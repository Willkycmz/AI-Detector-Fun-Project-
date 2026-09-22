# VisionX 👁️⚡

> **Realtime Computer Vision & Deep Learning Object Detection System**

VisionX adalah fondasi sistem Computer Vision jangka panjang yang dirancang untuk mengenali berbagai objek dan informasi visual secara realtime dari video stream (webcam, kamera eksternal, CCTV/RTSP, hingga kamera smartphone di masa depan).

Saat ini VisionX telah mencapai **Versi 0.2 (Dataset Collection System)** dengan tetap mempertahankan **V0.1 (Realtime Object Detection)** secara utuh dan modular.

---

## ✨ Fitur VisionX

### 1. V0.1 - Realtime Object Detection
- **Pretrained YOLO Inference**: Deteksi instan berbagai objek menggunakan bobot `yolov8n.pt`.
- **Estetika UI & Visualisasi**: Bounding box beraksen sudut modern, label kelas, nilai confidence, dan badge realtime FPS yang dihaluskan (*smoothed*).
- **Arsitektur Modular**: Pemisahan tegas antara Camera Stream, AI Inference, dan UI Visualizer.

### 2. V0.2 - Dataset Collection System *(Baru!)*
- **Struktur Dataset Terstandarisasi**:
  - `datasets/raw/<class_name>/`: Gambar mentah asli (*clean frames*) tanpa anotasi / bounding box.
  - `datasets/processed/`: Dataset siap olah (resizing/augmentasi).
  - `datasets/annotations/`: Label anotasi (format YOLO txt / Pascal VOC xml).
  - `datasets/metadata/`: Metadata kelas dan konfigurasi split dataset.
- **Pengambilan Gambar Keyboard-Triggered**: Tekan tombol `SPACE` atau `c` untuk menyimpan frame kamera bersih.
- **Nama File Otomatis & Unik**: Format `<class>_<timestamp>_<uuid>.jpg` tanpa risiko menimpa file lama.
- **Ganti Kelas Tanpa Restart**: Tekan tombol `n` untuk membuka dialog pengetikan nama kelas langsung di layar (*on-screen modal dialog*).
- **Validasi Nama Kelas Aman**: Sanitasi nama folder otomatis (mencegah karakter ilegal dan nama reserved sistem).
- **Monitoring Koleksi di Layar**: Menampilkan status mode koleksi, nama kelas aktif, jumlah foto terkumpul, dan flash notifikasi keberhasilan simpan.
- **Non-Breaking Dual-Mode**: Beralih mode deteksi $\leftrightarrow$ koleksi kapan saja dengan menekan tombol `m`.

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
│   └── collector.py     # DatasetCollector & validasi nama kelas (V0.2)
├── models/              # Bobot model (*.pt, *.onnx)
│   ├── README.md
│   └── yolov8n.pt
├── datasets/            # Arsitektur dataset terstruktur
│   ├── raw/             # Gambar mentah per kelas (diabaikan git)
│   │   ├── README.md
│   │   ├── bottle/
│   │   ├── glass/
│   │   └── charger/
│   ├── processed/       # Dataset hasil pra-pemrosesan
│   │   └── README.md
│   ├── annotations/     # File anotasi (YOLO / VOC / COCO)
│   │   └── README.md
│   └── metadata/        # Konfigurasi data.yaml & classes
│       └── README.md
├── tests/               # Automated unit testing suite (11 tests)
│   ├── test_camera.py
│   ├── test_detector.py
│   └── test_collector.py
├── requirements.txt     # Dependensi Python
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

## 💻 Cara Menjalankan Aplikasi

### 1. Menjalankan Mode Deteksi Objek (V0.1 Default)
```powershell
python app/main.py
```
*Gunakan kamera default (0) dengan model YOLO pretrained.*

### 2. Menjalankan Mode Koleksi Dataset (V0.2)
Anda dapat langsung memulai di mode koleksi dan menentukan nama kelas objek:
```powershell
python app/main.py --mode collect --class bottle
```
Contoh kelas lain:
```powershell
python app/main.py --mode collect --class glass
python app/main.py --mode collect --class charger
```

### 3. Menjalankan Mode Simulasi / Synthetic (Tanpa Webcam Fisik)
```powershell
python app/main.py --source synthetic --mode collect --class bottle
```

---

## ⌨️ Kontrol Keyboard Interaktif

Saat jendela preview aktif, Anda dapat menggunakan tombol-tombol berikut:

| Tombol | Fungsi |
|---|---|
| **`SPACE`** atau **`c`** | **Ambil Foto**: Menyimpan frame kamera asli (*clean raw frame*) ke `datasets/raw/<class_name>/` |
| **`n`** | **Ganti Kelas**: Membuka kotak dialog on-screen untuk mengetik nama kelas baru (tekan **ENTER** untuk simpan, **ESC** untuk batal) |
| **`m`** | **Ganti Mode**: Berpindah secara instan antara mode **Deteksi Objek** dan **Koleksi Dataset** |
| **`q`** atau **`ESC`** | **Keluar**: Menutup preview dan membebaskan resource kamera secara aman |

---

## ⚙️ Opsi Perintah CLI

| Argumen | Default | Deskripsi |
|---|---|---|
| `--mode` | `detect` | Mode awal: `detect` (deteksi objek) atau `collect` (koleksi dataset) |
| `--class` | `object` | Nama kelas awal untuk mode koleksi dataset |
| `--source` | `0` | Indeks webcam (0, 1, ...), path file video, atau `synthetic` |
| `--model` | `models/yolov8n.pt` | Path ke bobot model YOLO |
| `--conf` | `0.45` | Confidence threshold deteksi objek (0.0 s/d 1.0) |
| `--iou` | `0.45` | IoU / NMS threshold (0.0 s/d 1.0) |
| `--save-dir` | `datasets/raw` | Direktori tujuan penyimpanan foto mentah |
| `--width` | `640` | Lebar resolusi frame kamera |
| `--height` | `480` | Tinggi resolusi frame kamera |
| `--device` | `auto` | Pilihan akselerasi: `auto`, `cpu`, atau `cuda` |
| `--no-fps` | `False` | Menyembunyikan badge counter FPS |

---

## 🧪 Menjalankan Automated Testing

Untuk memvalidasi seluruh fungsionalitas modul kamera, detektor YOLO, visualizer, serta subsistem koleksi dataset:

```powershell
.venv\Scripts\python -m unittest discover tests
```

Output:
```text
Ran 11 tests in ...s
OK
```

Semua pengujian mencakup:
- Validasi nama kelas (sanitasi, penanganan spasi, penolakan karakter ilegal & reserved names).
- Penyimpanan file citra mentah dengan penamaan unik tanpa overwriting.
- Penghitungan dan pergantian kelas runtime tanpa restart aplikasi.
- Lifecycle camera stream & synthetic frame generator.
- Penanganan error model corrupt / invalid weights path.
- Konsistensi rendering visualizer.

---

## 🗺️ Roadmap Pengembangan Berikutnya

- [x] **V0.1 (MVP)**: Realtime object detection modular berbasis webcam + pretrained YOLO.
- [x] **V0.2**: Dataset Collection System terstruktur, keyboard capture, unique naming, class switching tanpa restart.
- [ ] **V0.3**: Auto-Annotation Assistant & Dataset Preparation (integrasi semi-automated bounding box labeling).
- [ ] **V0.4**: Custom Model Training Pipeline (Fine-tuning YOLO pada custom dataset lokal).
- [ ] **V0.5**: Integrasi kamera smartphone (IP Webcam / RTSP stream / DroidCam).
- [ ] **V0.6**: Object Tracking & Model Optimization (ONNX / TensorRT / OpenVINO).
