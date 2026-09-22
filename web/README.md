# VisionX Web Interface (V0.25) 🌐👁️

> **Browser-Based Local Computer Vision Interface for Development & Mobile Testing**

VisionX Web Interface (V0.25) adalah antarmuka web modern berbasis browser untuk pengembangan sistem Computer Vision secara lokal di laptop dan pengujian langsung dari smartphone melalui jaringan Wi-Fi lokal (LAN).

---

## ⚡ Fitur Utama V0.25

1. **Browser Camera API (`getUserMedia`)**:
   - Kontrol penuh **Start Camera** dan **Stop Camera**.
   - Penanganan izin (*Permission Handling*) untuk status *Granted*, *Denied*, *Not Found*, dan *Not Readable*.
   - Pemilihan perangkat kamera (*Camera Device Selector*) untuk beralih antara webcam laptop, kamera eksternal USB, atau kamera depan/belakang smartphone.
2. **Live Video Preview & Overlay Canvas**:
   - Preview streaming video realtime berlatar belakang responsif.
   - Canvas overlay presisi tinggi yang menyelaraskan dimensi visual dengan resolusi kamera asli.
3. **Realtime FPS Counter**:
   - Pengukuran frame rate yang dihaluskan (*smoothed*) dengan pembaruan dinamis per detik.
4. **AI Inference Abstraction & Demo**:
   - Modul `InferenceService` yang disiapkan untuk integrasi **ONNX Runtime Web** (`ort.InferenceSession`).
   - Mendukung format output `DetectionResult`: `{ class_name, confidence, x1, y1, x2, y2 }`.
   - Fitur toggle **AI Inference (Active / Inactive)**.
5. **Modern Aesthetic Interface**:
   - Desain Dark Mode futuristik dengan aksen neon cyan dan purple.
   - Bounding box beraksen sudut (*corner accents*) dan tag label confidence.
   - Badge indikator status (*Connected / Disconnected / Inference Active*).

---

## 🏗️ Struktur Modul Frontend

```text
web/
├── index.html                  # Shell aplikasi HTML5 & viewport responsif
├── package.json                # Konfigurasi dependensi Vite
├── vite.config.js              # Server config (host: true untuk akses LAN/HP)
├── README.md                   # Petunjuk menjalankan web interface
├── public/
│   └── favicon.svg             # Logo VisionX Web
└── src/
    ├── style.css               # Vanilla CSS modern, dark mode glassmorphism
    ├── main.js                 # App Controller & requestAnimationFrame loop
    └── services/
        ├── CameraService.js    # Abstraction Web Camera API & device enumeration
        ├── InferenceService.js # Abstraction deteksi objek & kontrak DetectionResult
        └── DetectionRenderer.js# Canvas drawing: corner accents, tags, confidence
```

---

## 🚀 Cara Menjalankan Frontend

### 1. Masuk ke Folder `web`
```bash
cd web
```

### 2. Install Dependensi
```bash
npm install
```

### 3. Jalankan Development Server
```bash
npm run dev
```

Output pada terminal akan menampilkan URL akses:
```text
  VITE v5.2.0  ready in 240 ms

  ➜  Local:   http://localhost:5173/
  ➜  Network: http://192.168.1.5:5173/
```

---

## 📱 Cara Membuka Aplikasi

### A. Di Laptop (Browser Lokal)
Buka browser favorit Anda (Chrome, Edge, Firefox, Safari) lalu akses:
[http://localhost:5173/](http://localhost:5173/)

### B. Di HP / Smartphone (Jaringan Wi-Fi Lokal yang Sama)
1. Pastikan HP dan Laptop terhubung ke **Wi-Fi yang sama**.
2. Lihat **Network IP** yang tertera di terminal saat menjalankan `npm run dev` (misal: `http://192.168.1.5:5173`).
3. Buka browser HP (Chrome / Safari) dan ketik URL IP tersebut.
4. Berikan izin akses kamera saat diminta oleh browser.

---

## ⚙️ Panduan Penggunaan Antarmuka

1. **Start Camera**: Klik tombol **Start Camera** untuk meminta izin kamera dan memulai streaming video.
2. **Stop Camera**: Klik tombol **Stop Camera** untuk mematikan streaming dan membebaskan hardware kamera.
3. **Pilih Kamera**: Gunakan dropdown **Pilih Kamera** untuk berpindah antar input kamera yang tersedia.
4. **AI Inference**: Gunakan toggle switch **AI Inference** untuk mengaktifkan atau menonaktifkan rendering bounding box dan deteksi objek.
