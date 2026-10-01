# VisionX 👁️⚡

> **Realtime Computer Vision & Deep Learning Object Detection System**

VisionX adalah fondasi sistem Computer Vision jangka panjang yang dirancang untuk mengenali berbagai objek dan informasi visual secara realtime dari video stream (webcam, kamera eksternal, CCTV/RTSP, hingga kamera smartphone).

Saat ini VisionX telah mencapai **Versi 0.4.1 (Dataset Management & Collection)** dengan tetap mempertahankan **V0.1 (Realtime Object Detection)**, **V0.2 (Python Dataset Collection)**, **V0.3 (Dataset Preparation Pipeline)**, dan **V0.4 (Web Dataset Collection)** secara modular, stabil, dan teruji.

---

## 🔄 End-to-End Dataset Workflow

```text
Camera Stream / File Import (PC / Folder)
      │
      ▼
Collection Mode (Web / Python CLI)
      │
      ▼
Select / Set Active Class & Source (e.g. 'glass', 'charger' / 'own_capture', 'own_import')
      │
      ▼
Deduplication Guard (SHA-256 Hash Check)
      │
      ▼
Capture Clean Raw Frame / Import Clean Images (Tanpa Bounding Box / Watermark / HUD)
      │
      ▼
Structured Dataset Storage & Metadata Logging:
  - datasets/raw/own/<class_name>/<class>_<source>_<timestamp>_<uuid>.jpg
  - datasets/raw/external/<source>/<class_name>/...
  - datasets/metadata/sources.yaml
      │
      ▼
Dataset Management (Single Delete, Multi-Delete, Gallery Inspection)
      │
      ▼
Annotation (Tahap Berikutnya)
      │
      ▼
Model Training (Tahap Berikutnya)
```

---

## ✨ Fitur VisionX

### 1. V0.1 - Realtime Object Detection
- **Pretrained YOLO Inference**: Deteksi instan berbagai objek menggunakan bobot `yolov8n.pt` (Python) dan `yolov8n.onnx` (Browser WASM).
- **Estetika UI & Visualisasi**: Bounding box beraksen sudut modern, label kelas, nilai confidence, dan badge realtime FPS yang dihaluskan (*smoothed*).
- **Arsitektur Modular**: Pemisahan tegas antara Camera Stream, AI Inference, dan UI Visualizer.

### 2. V0.2 - Python Dataset Collection System
- **Struktur Dataset Terstandarisasi**: Pengambilan citra asli mentah (*clean raw frames*) tanpa kontaminasi anotasi ke `datasets/raw/own/<class_name>/`.
- **Pengambilan Gambar Keyboard-Triggered**: Tekan tombol `SPACE` atau `c` untuk mengambil foto.
- **Nama File Otomatis & Unik**: Format `<class>_<timestamp>_<uuid>.jpg` tanpa risiko menimpa file lama (*collision-safe*).
- **Ganti Kelas Tanpa Restart**: Tekan tombol `n` untuk dialog penggantian nama kelas langsung di layar.

### 3. V0.3 - Dataset Preparation Pipeline
- **YOLO Annotation Support**: Validasi pasangan `image.jpg` dan `image.txt` (`class_id x_center y_center width height`).
- **Validasi Komprehensif (`DatasetValidator`)**: Pengecekan keterbacaan gambar, boundary box overflow, missing/orphaned labels, dan duplikasi via SHA256 image hash.
- **Class Registry Terpusat (`ClassRegistry`)**: Pemetaan konsisten di `datasets/metadata/classes.yaml`.
- **Reproducible Split & Anti Data-Leakage (`DatasetSplitter`)**: Train (80%), Val (10%), Test (10%) dengan random seed dan anti-leakage grouping.
- **Otomatisasi `dataset.yaml` & Statistik**: Pembuatan `dataset.yaml` resmi Ultralytics YOLO dan perintah statistik CLI.

### 4. V0.4 & V0.4.1 - Web Dataset Collection & Management *(Baru!)*
- **Structured Web Dataset Collection**: Mengambil frame kamera resolusi asli murni langsung dari browser web tanpa bounding box/HUD.
- **Single & Multi-Delete**: Hapus gambar satu per satu atau seleksi banyak (*multi-select*) dengan dialog konfirmasi aman dan update counter live.
- **Import Image(s) & Import Folder**: Impor file gambar lokal (JPG, JPEG, PNG, WEBP) atau seluruh folder ke target class dengan inspeksi jumlah sebelum impor.
- **SHA-256 Deduplication**: Pemeriksaan hash SHA-256 otomatis untuk mencegah redundansi dan salinan ganda file yang identik.
- **Source Metadata Tracking**: Membedakan dan mencatat sumber: `own_capture`, `own_import`, `huggingface`, `kaggle`, dan `other_external`.
- **Dual-Mode Switching**: Beralih instan antara **Detection Mode** dan **Dataset Collection Mode** tanpa me-restart stream kamera.
- **Storage Hierarchy**: Penyimpanan langsung ke `datasets/raw/own/<class>/` atau `datasets/raw/external/<source>/<class>/` via File System Access API atau direct browser download.

---

## 📁 Struktur Direktori

```text
VisionX/
├── app/
│   ├── __init__.py
│   ├── main.py          # Entry point aplikasi Python (Dual-Mode: Detect & Collect)
│   ├── config.py        # Dataclass AppConfig & CLI argument parser
│   ├── detector.py      # YOLOObjectDetector (AI) & Visualizer (HUD & UI)
│   ├── camera.py        # CameraStream lifecycle & error handling
│   ├── collector.py     # DatasetCollector, Delete, Import, & Hashing (V0.4.1)
│   └── dataset.py       # Dataset Preparation Pipeline, Validator & CLI (V0.3)
├── web/                 # Web Interface Frontend (V0.4.1)
│   ├── index.html       # Shell HTML5 (Mode Switcher, Stage, Controls & Gallery)
│   ├── package.json     # Konfigurasi dependensi Vite
│   ├── vite.config.js   # Server config (host: true untuk akses LAN/HP)
│   ├── README.md        # Dokumentasi khusus Web Interface
│   └── src/
│       ├── style.css    # Dark mode UI glassmorphism & collection styles
│       ├── main.js      # App Controller & requestAnimationFrame loop
│       └── services/
│           ├── CameraService.js        # Abstraction Web Camera API
│           ├── DatasetCaptureService.js# Raw capture, delete, import, & hashing
│           ├── InferenceService.js     # YOLOv8 ONNX web inference
│           └── DetectionRenderer.js    # Canvas bounding box renderer
├── models/              # Bobot model (*.pt, *.onnx)
│   ├── yolov8n.pt
│   └── yolov8n.onnx
├── datasets/            # Arsitektur dataset terstruktur
│   ├── raw/
│   │   ├── own/         # Citra hasil capture & import sendiri
│   │   │   ├── glass/
│   │   │   ├── bottle/
│   │   │   └── charger/
│   │   └── external/    # Citra dari sumber publik / eksternal
│   │       ├── huggingface/
│   │       └── kaggle/
│   ├── imported/
│   ├── processed/
│   ├── annotations/
│   └── metadata/
│       ├── classes.yaml
│       └── sources.yaml
├── tests/               # Automated unit testing suite (26 tests)
├── requirements.txt     # Dependensi Python
├── .gitignore           # Filter cache, venv, node_modules, model binary, & dataset
└── README.md            # Dokumentasi lengkap
```

---

## 🚀 Cara Menjalankan

### A. Menjalankan Web Interface (V0.4.1)

#### 1. Masuk ke Folder `web` dan Install Dependensi
```bash
cd web
npm install
```

#### 2. Jalankan Development Server
```bash
npm run dev
```

Output terminal:
```text
  VITE v5.4.21  ready in 280 ms

  ➜  Local:   http://localhost:5173/
  ➜  Network: http://192.168.1.65:5173/
```

#### 3. Buka di Browser
- **Di Laptop**: Buka [http://localhost:5173/](http://localhost:5173/)
- **Di Smartphone (Wi-Fi Lokal Sama)**: Buka browser HP dan ketik alamat IP Network yang tertera.

---

### B. Menjalankan Python Pipeline (V0.1 – V0.3)

#### 1. Realtime Object Detection (V0.1):
```powershell
.venv\Scripts\python app/main.py
```

#### 2. Dataset Collection System (V0.2):
```powershell
.venv\Scripts\python app/main.py --mode collect --class bottle
```

#### 3. Dataset Preparation Pipeline (V0.3):
```powershell
.venv\Scripts\python -m app.dataset prepare --source datasets/imported --dest datasets/processed --classes datasets/metadata/classes.yaml
```

---

### C. Menjalankan Backend Gateway & Auth Server (server.py)

Backend Flask bertindak sebagai API gateway untuk inferensi AI (`/api/chat`), penyimpanan dataset lokal di Android/Termux (`/sdcard/AI-Detector`), dan modul pengembang (`/api/manager/*`, `/api/dataset/*`, `/api/identity/*`).

```bash
# Menjalankan server gateway di PC atau Termux:
python server.py
```

---

## 🔐 Konfigurasi Supabase Authentication & Role Management

VisionX mengadopsi Supabase Auth sebagai Identity Provider & JWT Gatekeeper tanpa mengubah arsitektur penyimpanan fisik lokal di device Android (`/sdcard/AI-Detector`).

### 1. Daftar Variabel Lingkungan (Environment Variables)

#### Backend (`server.py` / `.env` root):
| Variabel | Wajib | Default | Deskripsi |
|---|---|---|---|
| `SUPABASE_URL` | Ya | `https://wnwaniiuflsuemyambuy.supabase.co` | URL Project Supabase |
| `SUPABASE_JWT_SECRET` | Ya | `""` | JWT Secret dari Dashboard Supabase (Project Settings -> API -> JWT Secret) |
| `SUPABASE_AUDIENCE` | Tidak | `authenticated` | Klaim audience JWT Supabase |
| `VISIONX_USER_DAILY_CHAT_LIMIT` | Tidak | `30` | Kuota pesan chat harian untuk role `user` |
| `VISIONX_LEGACY_PIN` | Tidak | `0` | `0` = Non-aktif (murni Supabase), `1` = Aktifkan fallback PIN lama |
| `VISIONX_DATASET_DIR` | Tidak | `/sdcard/AI-Detector` | Folder penyimpanan dataset fisik di device |
| `PORT` | Tidak | `5000` | Port listen server Flask |

#### Frontend (`web/.env.local`):
| Variabel | Wajib | Deskripsi |
|---|---|---|
| `VITE_SUPABASE_URL` | Ya | URL project Supabase untuk frontend client |
| `VITE_SUPABASE_ANON_KEY` | Ya | Public Anonymous Key Supabase (aman untuk browser) |
| `VITE_ENDPOINT_URL` | Tidak | Endpoint upload backend (default: `https://visionx.my.id/api/upload`) |

---

### 2. Panduan SQL Promosi Role Developer di Supabase

Secara default, pengguna yang mendaftar melalui form registrasi web akan mendapatkan role **"user"**. Untuk memberikan hak akses pengembang (**"developer"**) ke akun tertentu, jalankan perintah SQL berikut di **SQL Editor** pada Dashboard Supabase Anda:

```sql
-- 1. Promosi akun menjadi role 'developer'
UPDATE auth.users
SET raw_app_meta_data = raw_app_meta_data || '{"role": "developer"}'::jsonb
WHERE email = 'developer@yourdomain.com';

-- 2. Verifikasi status role akun
SELECT id, email, raw_app_meta_data->>'role' AS active_role, created_at
FROM auth.users
WHERE email = 'developer@yourdomain.com';

-- 3. (Opsional) Mengembalikan akun ke role 'user' biasa
UPDATE auth.users
SET raw_app_meta_data = raw_app_meta_data || '{"role": "user"}'::jsonb
WHERE email = 'developer@yourdomain.com';
```

> **Keamanan:** Klaim role pengembang disimpan secara eksklusif di dalam `app_metadata` (`raw_app_meta_data`), **BUKAN** `user_metadata`. Pengguna tidak dapat memodifikasi `app_metadata` dari browser, sehingga aman dari potensi *privilege escalation*.

---

---

## 🧪 Automated Testing

Menjalankan pengujian unit test modul Python (26 automated test cases):

```powershell
.venv\Scripts\python -m unittest discover tests
```

Output:
```text
Ran 26 tests in 2.821s
OK
```

---

## 🗺️ Roadmap Pengembangan VisionX

- [x] **V0.1 (MVP)**: Realtime object detection modular berbasis webcam + pretrained YOLO.
- [x] **V0.2**: Dataset Collection System terstruktur (Python CLI), keyboard capture, unique naming, class switching tanpa restart.
- [x] **V0.3**: Dataset Preparation Pipeline (YOLO validation, class registry, anti-leakage split, dataset.yaml, stats & CLI).
- [x] **V0.25**: Web Camera Interface (Browser Camera API, Detection Overlay Canvas, Localhost & LAN Access).
- [x] **V0.4**: Web Dataset Collection (Clean raw capture, class switching, storage management, dual-mode switcher).
- [x] **V0.4.1**: Dataset Management (Single Delete, Multi-Delete, Import Image & Folder, SHA-256 Deduplication, Source Metadata, Nested Structure).
- [ ] **V0.5**: Custom Model Training Pipeline (Fine-tuning Ultralytics YOLO pada custom dataset lokal).
- [ ] **V0.6**: Object Tracking & Model Optimization (ByteTrack / TensorRT / OpenVINO).
