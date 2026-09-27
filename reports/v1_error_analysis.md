# VisionX Model V1 — Error Analysis & Diagnostic Audit Report

## 1. Executive Summary
Audit evaluasi komprehensif dilakukan terhadap model baseline **VisionX V1 (YOLOv8n)** pada test set resmi (`datasets/processed/images/test`, 51 citra, 219 ground-truth bounding boxes) menggunakan standard COCO 1-to-1 matching (IoU threshold = 0.50).

Hasil evaluasi menunjukkan bahwa meskipun model memiliki presisi makro yang wajar pada kelas dominan (`person`), terdapat **degradasi performa yang parah pada objek berukuran kecil (small scale objects)** dan **kegagalan deteksi ekstrem pada kelas esensial sehari-hari (`cell_phone`, `cup`, `bottle`)**.

---

## 2. Metrik Evaluasi Komparatif V1 (Operational Thresholds)

| Metrik | Default Standard (Conf = 0.25) | Web Runtime Default (Conf = 0.45) |
| :--- | :---: | :---: |
| **mAP@50** | **0.3655 (36.55%)** | **0.3655 (36.55%)** |
| **mAP@50-95** | **0.2542 (25.42%)** | **0.2542 (25.42%)** |
| **Macro Precision** | 0.4650 (46.50%) | 0.5963 (59.63%) |
| **Macro Recall** | 0.3938 (39.38%) | 0.3297 (32.97%) |
| **Total Test Images** | 51 citra | 51 citra |
| **Total GT BBoxes** | 219 kotak | 219 kotak |

---

## 3. Analisis Performa Per-Kelas (Conf = 0.25, IoU = 0.50)

| Kelas | Ground Truth | Prediksi | TP | FP | FN | Precision | Recall | AP@50 | AP@50-95 |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **person** | 132 | 103 | 71 | 32 | 61 | 0.6893 | 0.5379 | 0.5667 | 0.3680 |
| **bottle** | 17 | 12 | 6 | 6 | 11 | 0.5000 | 0.3529 | 0.3164 | 0.2409 |
| **cup** | 19 | 8 | 4 | 4 | 15 | 0.5000 | 0.2105 | 0.3163 | 0.1719 |
| **laptop** | 15 | 17 | 7 | 10 | 8 | 0.4118 | 0.4667 | 0.3718 | 0.2636 |
| **mouse** | 9 | 10 | 5 | 5 | 4 | 0.5000 | 0.5556 | 0.5185 | 0.4296 |
| **keyboard** | 12 | 12 | 6 | 6 | 6 | 0.5000 | 0.5000 | 0.3844 | 0.2775 |
| **cell_phone** | 15 | 13 | 2 | 11 | 13 | 0.1538 | 0.1333 | 0.0843 | 0.0280 |

---

## 4. Analisis Skala Objek (Small, Medium, Large)

Evaluasi bounding box berdasarkan area piksel (COCO standard: Small < 32², Medium 32²–96², Large > 96²):

| Skala Objek | Ground Truth | True Positive | Recall Rate | Analisis Kegagalan |
| :--- | :---: | :---: | :---: | :--- |
| **SMALL (< 1024 px²)** | 67 | 9 | **13.43%** | **Kritis.** 86.6% objek kecil tidak terdeteksi. Fitur spasial hilang di feature map stride 32. |
| **MEDIUM (1024–9216 px²)** | 65 | 30 | **46.15%** | Kurang optimal. Objek meja pada jarak menengah sering terlewat. |
| **LARGE (> 9216 px²)** | 87 | 60 | **68.97%** | Cukup baik untuk subjek jarak dekat / objek besar. |

### Distribusi Ukuran per Kelas pada Test Set:
- `cell_phone`: 9 Small, 5 Medium, 1 Large (60% adalah small objek handheld!).
- `bottle`: 8 Small, 7 Medium, 2 Large.
- `cup`: 5 Small, 11 Medium, 3 Large.
- `person`: 37 Small, 30 Medium, 65 Large.

---

## 5. Analisis False Positives & False Negatives (Failure Modes)

### A. False Positives (Deteksi Palsu):
1. **Background Clutter sebagai Objek (95%+ FP)**:
   - `cell_phone`: 22 background FP (meja, buku, benda persegi panjang keliru dideteksi HP).
   - `person`: 64 background FP (bayangan, poster, pakaian).
   - `laptop`: 20 background FP (keyboard dan monitor eksternal ganda membingungkan model).
2. **Misklasifikasi Antar-Kelas (< 5% FP)**:
   - Hanya 1 kasus `cell_phone` keliru diklasifikasikan sebagai `laptop`.
   - Hanya 1 kasus `laptop` keliru diklasifikasikan sebagai `person`.
   - **Kesimpulan**: Masalah utama V1 bukan membedakan kelas, melainkan membedakan objek dari tekstur latar belakang (background discrimination).

### B. False Negatives (Objek Terlewat):
1. **Handheld & Angle Variation**: HP yang dipegang miring atau dilihat dari samping tidak dikenali (Recall HP = 13.3%).
2. **Low Contrast / Shadow**: Cangkir dan botol di pencahayaan redup terlewat (Recall Cup = 21.1%).
3. **Occlusion & Clutter**: Laptop tertutup sebagian atau kabel di sekitar keyboard menyebabkan bounding box hilang.

---

## 6. Rekomendasi Targeted Dataset Improvement (V1.4)
Untuk mengatasi kelemahan Model V1:
1. **Fokus Tambahan Data**: Prioritas utama pada `cell_phone` (+100%), `cup` (+80%), `bottle` (+75%), `keyboard` (+60%), `laptop` (+50%).
2. **Kondisi Kamera Nyata**:
   - Pencahayaan: Indoor low-light, indoor bright, daylight.
   - Jarak & Sudut: Near macro, medium desk, far (small object), sudut miring 45°, top-down.
   - Perangkat: Webcam laptop dan kamera ponsel.
   - Oklusi: Objek dipegang tangan (handheld), terhalang sebagian (partial occlusion), dan latar belakang meja penuh barang (cluttered desk).
