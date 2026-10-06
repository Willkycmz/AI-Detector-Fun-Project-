# VisionX V4 Final — Google Colab GPU Training Guide (Frozen Backbone)

Panduan menjalankan training model **VisionX V4 Final (21 kelas)** dengan teknik **Frozen Backbone (`freeze=10`)** untuk mengunci fitur V3 (mencegah regresi `person`, `laptop`, `cup`, `bottle`) sekaligus mengintegrasikan 7 kelas baru (`helm`, `tanpa_helm`, dll.).

---

## 1. File di Google Drive

Kabar baik: **Anda TIDAK PERLU meng-upload ulang dataset besar!**
File berikut **sudah ada di Google Drive Anda** dari sesi training sebelumnya:
1. `processed_v3.zip` (Dataset 15.097 citra, 21 kelas)
2. `visionx_v3_best.pt` (Checkpoint bobot dasar V3)

---

## 2. Langkah Eksekusi di Google Colab

1. Buka [Google Colab](https://colab.research.google.com/).
2. Upload notebook baru:
   [`outputs/visionx_v4_final_colab_training.ipynb`](file:///c:/Users/advan/Documents/VisionX/outputs/visionx_v4_final_colab_training.ipynb)
3. Pastikan GPU aktif:
   - Menu **Runtime** > **Change runtime type** > Pilih **T4 GPU** > **Save**.
4. Klik **Runtime** > **Run all** (atau tekan `Ctrl + F9`).
5. Sambungkan akun Google Drive saat diminta pada **Cell 1**.
6. Duduk santai selama **~12–14 menit**:
   - Training berjalan 20 epoch dengan `freeze=10` dan `lr0=0.001`.
   - **Cell 5** akan otomatis mencetak tabel evaluasi per-kelas lengkap 21 kelas (Val & Test).
   - **Cell 6** otomatis mengompres hasil dan menyimpannya ke Google Drive sebagai **`visionx_v4_final_results.zip`**.

---

## 3. Langkah Setelah Selesai

Setelah training selesai di Colab:
1. Download file **`visionx_v4_final_results.zip`** dari Google Drive Anda.
2. Beritahu saya di chat, saya yang akan otomatis ekstrak, evaluasi, dan siapkan export ONNX untuk deployment web!
