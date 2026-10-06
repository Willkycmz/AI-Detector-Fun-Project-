# VisionX V4 Diagnostic — Google Colab GPU Training Guide

Panduan menjalankan eksperimen kontrol diagnostik untuk memverifikasi akar penyebab regresi performa kelas `person`, `bottle`, `cup`, dan `laptop` di VisionX V4.

---

## 1. Latar Belakang & Hipotesis Eksperimen

Pada evaluasi V4:
- 7 kelas baru (`helm`, `tanpa_helm`, `car`, `motorcycle`, dll.) dan kelas core lama (`uang_100rb`, `tisue`, `dompet`, `kacamata`, `sendal`, `mouse`, `keyboard`) berkinerja **sangat stabil atau solid**.
- Namun kelas `person`, `bottle`, `cup`, `laptop` mengalami **regresi >10 poin**.

**Dua Kemungkinan Penyebab:**
1. **Hipotesis A (Data Co-occurrence Jelek):** Penambahan ribuan bounding box `person`, `bottle`, `cup` dari citra kompleks/parsial COCO pada sesi data balancing merusak representasi fitur yang sudah dipelajari model V3.
2. **Hipotesis B (Catastrophic Forgetting):** Penambahan 7 kelas baru sekaligus mendegradasi deteksi kelas lama terlepas dari datanya.

**Desain Kontrol (`processed_v3_diag`):**
- `person`, `bottle`, `cup`, `laptop` dikembalikan murni ke jumlah data V3 (**~334 person, ~164 bottle, ~183 cup, ~186 laptop**).
- `keyboard` tetap mempertahankan kuota tambahan (karena di V4 stabil/naik +3.2%).
- 7 kelas baru (`car`, `motorcycle`, `backpack`, `umbrella`, `book`, `helm`, `tanpa_helm`) **100% tetap diikutsertakan**.
- Checkpoint awal: `models/visionx_v3/weights/best.pt` (sama persis seperti saat melatih V4).
- Parameter training: 20 epoch, `lr0=0.005`, `batch=16`, `imgsz=640`, `seed=42` (identik dengan V4).

---

## 2. File yang Diperlukan di Google Drive

Upload 2 file berikut ke **Google Drive (My Drive / root)**:

1. **`outputs/processed_v3_diag.zip`** (Dataset diagnostik kontrol, 13.965 citra)
2. **`outputs/visionx_v3_best.pt`** (Checkpoint dasar VisionX V3)

---

## 3. Langkah Menjalankan di Google Colab

1. Buka [Google Colab](https://colab.research.google.com/).
2. Upload notebook:
   [`outputs/visionx_v4_diag_colab_training.ipynb`](file:///c:/Users/advan/Documents/VisionX/outputs/visionx_v4_diag_colab_training.ipynb)
3. Aktifkan GPU T4: **Runtime** > **Change runtime type** > Pilih **T4 GPU** > **Save**.
4. Klik **Runtime** > **Run all** (atau tekan `Ctrl + F9`).
5. Sambungkan Google Drive saat diminta pada **Cell 1**.
6. Tunggu proses selesai (~12-14 menit):
   - **Cell 1–3:** Ekstraksi dataset diagnostik & pemuatan checkpoint V3.
   - **Cell 4:** Training 20 epoch.
   - **Cell 5:** Menghasilkan tabel evaluasi otomatis 21 kelas untuk split `val` dan `test` lengkap dengan perbandingan terhadap baseline V3.
   - **Cell 6:** Menyimpan arsip hasil ke Google Drive Anda sebagai **`visionx_v4_diag_results.zip`**.

---

## 4. Cara Membaca Hasil Evaluasi (Interpretasi Kunci)

Perhatikan metrik pada tabel output **Cell 5**:

| Skenario Hasil | Kesimpulan & Solusi |
|:---|:---|
| **`person`, `bottle`, `cup`, `laptop` KEMBALI NAIK** mendekati angka V3 (~72%, ~50%, ~54%, ~70%) | **Hipotesis A Terbukti:** Masalahnya adalah data co-occurrence COCO yang kotor/cluttered. Solusi: Kita lakukan kurasi data bersih khusus kelas tersebut (bukan mengurangi 7 kelas baru). |
| **`person`, `bottle`, `cup`, `laptop` TETAP REGRESI** | **Hipotesis B Terbukti:** Terjadi catastrophic forgetting akibat transfer learning 7 kelas baru sekaligus. Solusi: Freeze backbone layers lebih dalam, gunakan learning rate lebih rendah (`lr0=0.001`), atau tambah epoch. |

---

## 5. Status Produksi & Web App

- `models/visionx_v3` **tetap menjadi model aktif default** di aplikasi web.
- Tidak ada file frontend / web yang diubah dan tidak ada export ONNX sampai hasil diagnostik ini direview.
