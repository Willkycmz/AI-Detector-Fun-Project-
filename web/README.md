# VisionX Web Interface (V1.5 Mobile-First Release) 🌐👁️

> **Browser-Based Realtime AI Vision Assistant & Mobile-First Interface**

VisionX Web Interface (V0.4.1) memungkinkan pengguna untuk menjalankan inferensi deteksi objek YOLOv8 secara realtime dan mengelola siklus hidup dataset gambar mentah (*clean raw frames*) secara aman, terstruktur, dan praktis untuk dataset skala besar langsung dari browser.

---

## 🔄 Alur Kerja Pengumpulan & Pengelolaan Dataset (Workflow)

```text
Camera Stream / Import PC (Files / Folder)
      │
      ▼
Collection Mode (Tab 'Dataset Collection' atau tombol [M])
      │
      ▼
Select Class & Source Metadata (misal: 'glass', 'charger' / 'own_capture', 'own_import')
      │
      ▼
Deduplication Guard (SHA-256 Hash Verification)
      │
      ▼
Capture Clean Raw Frame / Import (Tanpa Bounding Box / Watermark / HUD)
      │
      ▼
Nested Dataset Storage:
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

## ⚡ Fitur Utama V0.4.1

1. **Dual-Mode Operation (Detection Mode $\leftrightarrow$ Collection Mode)**:
   - **Detection Mode**: Inferensi realtime YOLOv8 ONNX WebAssembly, rendering bounding box interaktif, threshold sliders, dan debug inspector.
   - **Collection Mode**: Mengambil frame kamera resolusi asli tanpa bounding box, tanpa watermark, dan tanpa teks HUD. Kamera tetap berjalan mulus tanpa reload/restart.

2. **Single Delete & Multi-Delete**:
   - **Hapus Tunggal**: Tombol hapus pada setiap kartu galeri dilengkapi dialog konfirmasi (*confirmation modal*) untuk mencegah penghapusan yang tidak disengaja.
   - **Multi-Delete**: Beralih ke mode seleksi (*Pilih Banyak*), pilih gambar satu per satu atau *Pilih Semua*, dan hapus seluruh gambar yang dipilih sekaligus.
   - Counter jumlah gambar per kelas langsung diperbarui secara akurat (*live decrement*).

3. **Import Image(s) & Import Folder**:
   - **Impor Gambar**: Memilih satu atau beberapa file dari PC (mendukung `.jpg`, `.jpeg`, `.png`, `.webp`) langsung ke target class.
   - **Impor Folder**: Memilih seluruh folder di PC, memindai jumlah gambar yang valid, menampilkan konfirmasi sebelum impor, dan mengalokasikan gambar ke target class tanpa menimpa file yang ada (*unique naming*).

4. **SHA-256 Deduplication**:
   - Menghitung hash SHA-256 secara realtime menggunakan Web Cryptography API.
   - Mencegah salinan ganda dari gambar identik pada proses capture maupun impor.

5. **Source Metadata Tracking**:
   - Membedakan sumber data secara terstruktur:
     * `own_capture` (pengambilan kamera langsung)
     * `own_import` (file lokal)
     * `huggingface` (dataset publik)
     * `kaggle` (dataset publik)
     * `other_external`
   - Tersimpan rapi di metadata sistem.

6. **Storage Structure Berjenjang**:
   - `datasets/raw/own/<class_name>/`
   - `datasets/raw/external/<source>/<class_name>/`
   - Kompatibel penuh dengan pipeline persiapan dataset Python V0.3.

7. **Shortcut Keyboard Ergonomis**:
   - `SPACE` atau `C`: Mengambil frame citra bersih (Capture).
   - `N`: Fokus ke input nama kelas baru.
   - `M`: Beralih antara Detection Mode dan Collection Mode.

---

## 🚀 Cara Menjalankan

```bash
cd web
npm install
npm run dev
```

Buka URL yang ditampilkan pada terminal:
- **Laptop**: [http://localhost:5173/](http://localhost:5173/)
- **Smartphone**: Akses alamat IP Network (misal: `http://192.168.1.65:5173/`) pada jaringan Wi-Fi yang sama.
