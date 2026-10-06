# VisionX V4 — Google Colab GPU Training Guide

Panduan praktis menjalankan fine-tuning model **VisionX V4 (21 kelas)** menggunakan GPU gratis di Google Colab. Dengan GPU T4 gratis di Colab, 20 epoch tuntas dalam **~12 s/d 15 menit** (dibandingkan ~11.6 jam di CPU lokal).

---

## 1. File yang Perlu Disiapkan

Seluruh file yang dibutuhkan sudah disiapkan di folder `outputs/` pada repositori VisionX ini:

1. **`outputs/processed_v3.zip`** (Ukuran: ~1.13 GB) — Berisi seluruh dataset train/val/test 21 kelas (**15.097 citra** + anotasi label + `dataset.yaml`).
2. **`outputs/visionx_v3_best.pt`** (Ukuran: ~5.94 MB) — Checkpoint bobot dasar VisionX V3 (14 kelas) untuk transfer learning ke 21 kelas.
3. **`outputs/visionx_v4_colab_training.ipynb`** (atau di `notebooks/visionx_v4_colab_training.ipynb`) — Jupyter Notebook Colab siap pakai.

---

## 2. Langkah-Langkah di Google Drive & Google Colab

### Langkah A: Upload ke Google Drive
1. Buka [Google Drive](https://drive.google.com/).
2. Upload dua file berikut langsung ke root **My Drive** (atau folder mana saja):
   * `processed_v3.zip`
   * `visionx_v3_best.pt`

### Langkah B: Buka Notebook di Google Colab
1. Buka [Google Colab](https://colab.research.google.com/).
2. Pilih tab **Upload** lalu pilih file `outputs/visionx_v4_colab_training.ipynb` dari laptop Anda (atau upload notebook tersebut ke Drive lalu buka via Colab).

### Langkah C: Aktifkan Akselerator GPU
1. Di menu atas Colab, klik **Runtime** > **Change runtime type**.
2. Pada pilihan *Hardware accelerator*, pilih **T4 GPU**.
3. Klik **Save**.

### Langkah D: Jalankan Training (Run All)
1. Klik **Runtime** > **Run all** (atau tekan `Ctrl + F9`).
2. Pada **Cell 1**, Colab akan meminta izin menghubungkan Google Drive (*Permit this notebook to access your Google Drive files*), klik **Connect to Google Drive**.
3. Notebook akan berjalan otomatis:
   * **Cell 1:** Mount Drive & install Ultralytics YOLO.
   * **Cell 2:** Unzip `processed_v3.zip` ke SSD lokal Colab (`/content/datasets/processed_v3`) dan memetakan `dataset.yaml`.
   * **Cell 3:** Load checkpoint base `visionx_v3_best.pt` dan otomatis meremap detection head dari 14 kelas ke 21 kelas.
   * **Cell 4:** Menjalankan training 20 epoch di GPU T4 (`batch=16, imgsz=640, optimizer=auto, lr0=0.005, lrf=0.01, device=0`, ~35–45 detik per epoch, total ~12–15 menit).
   * **Cell 5:** Evaluasi otomatis pada Test Split (mAP50 & mAP50-95).
   * **Cell 6:** Mengompres folder hasil training dan otomatis menyimpannya kembali ke Google Drive Anda sebagai **`visionx_v4_results.zip`**.

---

## 3. Langkah Setelah Training Selesai

1. Buka kembali [Google Drive](https://drive.google.com/), temukan file **`visionx_v4_results.zip`**.
2. Download file tersebut ke laptop Anda.
3. Ekstrak file tersebut ke dalam folder:
   ```
   models/visionx_v4/
   ```
   *(Pastikan file bobot terbaik berada di `models/visionx_v4/weights/best.pt`).*
4. Model V4 (21 kelas) siap dievaluasi mAP-nya dan diuji pada web inference / live camera!
