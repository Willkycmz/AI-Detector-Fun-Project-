# VisionX 👁️⚡

> **Realtime Computer Vision & Deep Learning Object Detection System**

VisionX adalah fondasi sistem Computer Vision jangka panjang yang dirancang untuk mengenali berbagai objek dan informasi visual secara realtime dari video stream (webcam, kamera eksternal, CCTV/RTSP, hingga kamera smartphone di masa depan).

Saat ini VisionX telah mencapai **Versi 0.25 (Web Interface for Local Development)** dengan tetap mempertahankan **V0.1 (Realtime Object Detection)**, **V0.2 (Dataset Collection System)**, dan **V0.3 (Dataset Preparation Pipeline)** secara modular, stabil, dan teruji.

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
- **Non-Breaking Dual-Mode**: Beralih mode deteksi $\leftrightarrow$ koleksi kapan saja dengan menekan tombol `m`.

### 3. V0.3 - Dataset Preparation Pipeline
- **YOLO Annotation Support**: Validasi pasangan `image.jpg` dan `image.txt` (`class_id x_center y_center width height`).
- **Validasi Komprehensif (`DatasetValidator`)**: Pengecekan keterbacaan gambar, boundary box overflow, missing/orphaned labels, dan duplikasi via SHA256 image hash.
- **Class Registry Terpusat (`ClassRegistry`)**: Pemetaan konsisten di `datasets/metadata/classes.yaml`.
- **Reproducible Split & Anti Data-Leakage (`DatasetSplitter`)**: Train (80%), Val (10%), Test (10%) dengan random seed dan anti-leakage grouping.
- **Otomatisasi `dataset.yaml` & Statistik**: Pembuatan `dataset.yaml` resmi Ultralytics YOLO dan perintah statistik CLI.

### 4. V0.25 - Web Interface for Local Development *(Baru!)*
- **Browser Camera API**: Penggunaan `navigator.mediaDevices.getUserMedia` langsung di sisi client.
- **Start / Stop & Device Selector**: Mengontrol status kamera dan memilih input kamera (webcam laptop, USB external camera, kamera HP).
- **Penanganan Izin Kamera**: Menangani status izin (*Granted*, *Denied*, *Not Found*, *Not Readable*) secara informatif.
- **Visual Rendering Canvas Overlay**: Bounding box beraksen sudut futuristik dan tag confidence score di atas `<canvas>`.
- **InferenceService Abstraction**: Disiapkan untuk integrasi ONNX Runtime Web (`ort.InferenceSession`) dengan objek `DetectionResult` (`class_name`, `confidence`, `x1`, `y1`, `x2`, `y2`).
- **Akses Jaringan Lokal (LAN / HP)**: Dapat dibuka langsung dari browser smartphone yang terhubung ke Wi-Fi lokal yang sama.

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
│   ├── collector.py     # DatasetCollector & validasi nama kelas (V0.2)
│   └── dataset.py       # Dataset Preparation Pipeline, Validator & CLI (V0.3)
├── web/                 # Web Interface Frontend (V0.25)
│   ├── index.html       # Shell HTML5
│   ├── package.json     # Konfigurasi dependensi Vite
│   ├── vite.config.js   # Server config (host: true untuk akses LAN/HP)
│   ├── README.md        # Dokumentasi khusus Web Interface
│   └── src/
│       ├── style.css    # Dark mode UI glassmorphism
│       ├── main.js      # App Controller & requestAnimationFrame loop
│       └── services/
│           ├── CameraService.js    # Abstraction Web Camera API
│           ├── InferenceService.js # Abstraction deteksi objek & DetectionResult
│           └── DetectionRenderer.js# Canvas drawing: corner accents, tags
├── models/              # Bobot model (*.pt, *.onnx)
│   └── yolov8n.pt
├── datasets/            # Arsitektur dataset terstruktur
│   ├── raw/
│   ├── imported/
│   ├── processed/
│   ├── annotations/
│   └── metadata/
│       └── classes.yaml
├── tests/               # Automated unit testing suite (21 tests)
├── requirements.txt     # Dependensi Python
├── .gitignore           # Filter cache, venv, node_modules, model binary, & dataset
└── README.md            # Dokumentasi lengkap
```

---

## 🚀 Cara Menjalankan

### A. Menjalankan Web Interface (V0.25)

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
  VITE v5.4.21  ready in 717 ms

  ➜  Local:   http://localhost:5173/
  ➜  Network: http://192.168.1.65:5173/
```

#### 3. Buka di Browser
- **Di Laptop**: Akses [http://localhost:5173/](http://localhost:5173/)
- **Di Smartphone (Wi-Fi Lokal Sama)**: Buka browser HP dan ketik alamat IP Network yang tertera (misal: `http://192.168.1.65:5173`).

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

## 🧪 Automated Testing

Menjalankan pengujian unit test modul Python:

```powershell
.venv\Scripts\python -m unittest discover tests
```

Output:
```text
Ran 21 tests in 10.754s
OK
```

---

## 🗺️ Roadmap Pengembangan VisionX

- [x] **V0.1 (MVP)**: Realtime object detection modular berbasis webcam + pretrained YOLO.
- [x] **V0.2**: Dataset Collection System terstruktur, keyboard capture, unique naming, class switching tanpa restart.
- [x] **V0.3**: Dataset Preparation Pipeline (YOLO validation, class registry, anti-leakage split, dataset.yaml, stats & CLI).
- [x] **V0.25**: Web Interface untuk pengembangan lokal (Browser Camera API, Detection Overlay Canvas, Localhost & LAN Access).
- [ ] **V0.4**: Custom Model Training Pipeline (Fine-tuning Ultralytics YOLO pada custom dataset lokal).
- [ ] **V0.5**: Integrasi ONNX Runtime Web di browser & Kamera HP Streaming.
- [ ] **V0.6**: Object Tracking & Model Optimization (ByteTrack / TensorRT / OpenVINO).
