# VisionX V1 vs V2 — Comprehensive Benchmark & Diagnostic Evaluation Report

## 1. Executive Summary

Evaluasi komparatif benchmarking komprehensif dilakukan antara **Model V1 (Baseline)** dan **Model V2 (Real-World & Targeted Improvements)** pada dua dataset pengujian terpisah:
1. **V1 Standard Test Set** (`datasets/processed/images/test`, 51 citra, 219 GT boxes, COCO-derived).
2. **Real-World Holdout Benchmark** (`datasets/real_world_holdout/images`, 40 citra, 63 GT boxes, 100% unseen, real camera conditions: webcam laptop, smartphone, low-light, oblique angles, clutter, occlusion).

### Key Takeaway:
Model V1 mengalami **domain collapse parah** pada kondisi kamera nyata dunia nyata (mAP50 hanya **4.06%**, recall hanya **7.02%**). 
Sebaliknya, **Model V2 berhasil menutup domain gap secara spektakuler**, meraih **mAP50 77.42%** dan **Recall 92.96%** pada Real-World Holdout Set, sekaligus meningkatkan mAP50 pada V1 Test Set dari 33.29% ke **37.05%** dan presisi dari 45.52% ke **55.44%**.

---

## 2. Tabel Komparasi Utama: V1 vs V2

| Metrik Evaluasi | V1 Test Set (COCO Domain) | | Real-World Holdout (Camera Domain) | |
| :--- | :---: | :---: | :---: | :---: |
| | **Model V1** | **Model V2** | **Model V1** | **Model V2** |
| **mAP@50** | 33.29% | **37.05%** (+3.76%) | 4.06% | **77.42% (+73.36%)** 🚀 |
| **Macro Precision** | 45.52% | **55.44%** (+9.92%) | 19.64% | **79.29% (+59.65%)** |
| **Macro Recall** | 38.87% | 38.40% | 7.02% | **92.96% (+85.94%)** |
| **Mean Inference Latency** | **47.4 ms** | 47.7 ms (~sama) | 48.8 ms | **46.5 ms** |
| **Model Binary Size** | 11.70 MB | 11.70 MB | 11.70 MB | 11.70 MB |
| **Total Test Images** | 51 citra | 51 citra | 40 citra | 40 citra |
| **Total GT Bounding Boxes**| 219 kotak | 219 kotak | 63 kotak | 63 kotak |

---

## 3. Evaluasi Performa Real-World Holdout Set (Kondisi Kamera Nyata)

Dataset holdout merepresentasikan webcam laptop dan smartphone pada meja kerja pengguna (pencahayaan redup, backlight, sudut 45°, oklusi tangan, dan clutter).

| Kelas Objek | GT Boxes | V1 Recall | V2 Recall | V1 AP@50 | V2 AP@50 | Peningkatan Performa |
| :--- | :---: | :---: | :---: | :---: | :---: | :--- |
| **cell_phone** | 16 | 6.25% | **100.00%** | 0.0909 | **0.7596** | **+735% AP50**, nol miss detection |
| **cup** | 7 | 0.00% | **100.00%** | 0.0000 | **0.8182** | Mengatasi pantulan & sudut miring |
| **bottle** | 10 | 0.00% | **90.00%** | 0.0000 | **0.9091** | Deteksi botol bening & stainless stabil |
| **laptop** | 6 | 0.00% | **100.00%** | 0.0000 | **0.4416** | Mampu mengenali laptop di meja padat |
| **mouse** | 7 | 42.86% | **85.71%** | 0.1932 | **0.8182** | Recall naik 2x lipat pada mousepad |
| **keyboard** | 4 | 0.00% | **100.00%** | 0.0000 | **0.9455** | Membedakan keyboard laptop & eksternal |
| **person** | 4 | 0.00% | **75.00%** | 0.0000 | **0.7273** | Deteksi pengguna depan webcam |
| **Rata-rata (Macro)** | **63** | **7.02%** | **92.96%** | **0.0406** | **0.7742** | **Kenaikan mAP50: +1800% relatif** |

---

## 4. Evaluasi Skala Objek (Object Scale Sensitivity)

### A. V1 Standard Test Set (COCO Domain):
| Skala | GT Count | V1 Recall | V2 Recall | Analisis |
| :--- | :---: | :---: | :---: | :--- |
| **Small (< 32² px)** | 67 | 13.43% (9) | 8.96% (6) | Sedikit trade-off pada web images COCO |
| **Medium (32²–96² px)**| 65 | 46.15% (30) | **50.77% (33)** | Peningkatan deteksi jarak menengah meja |
| **Large (> 96² px)** | 87 | 68.97% (60) | 65.52% (57) | Tetap stabil untuk objek dominan |

### B. Real-World Holdout Set (Workspace Camera Domain):
| Skala | GT Count | V1 Recall | V2 Recall | Analisis |
| :--- | :---: | :---: | :---: | :--- |
| **Medium (32²–96² px)**| 16 | 0.00% (0/16) | **87.50% (14/16)** | V1 gagal total, V2 mendeteksi 14 dari 16 |
| **Large (> 96² px)** | 47 | 8.51% (4/47) | **80.85% (38/47)** | V1 hanya mendeteksi 4 objek, V2 mendeteksi 38 |

---

## 5. False Positive & Clutter Suppression Analysis

Pada audit error Model V1, terdapat **22 false positive background pada cell_phone** dan **20 pada laptop** akibat tekstur meja.
Pada Model V2:
- False positive rate pada background berkurang drastis di data kamera nyata.
- Macro precision di kamera nyata melonjak dari **19.64%** ke **79.29%**, membuktikan ketahanan terhadap background clutter (buku, kabel, karpet).

---

## 6. Model Decision & Rekomendasi Deployment

### Rekomendasi: **Gunakan Model V2 sebagai Default Model VisionX**

**Alasan Berdasarkan Data Multi-Metrik (Bukan Satu Metrik Saja):**
1. **Real-World Robustness**: Pada webcam dan kamera nyata, Model V1 hampir tidak berguna (mAP50 4.06%), sedangkan Model V2 mencapai **77.42%** mAP50 dengan **92.96%** recall.
2. **COCO Domain Retention**: Pada test set V1 asli, Model V2 tidak mengalami catastrophic forgetting, bahkan mAP50 meningkat (+3.76%) dan presisi meningkat (+9.92%).
3. **Zero Latency Penalty**: Rata-rata waktu inferensi tetap identik (~46.5–47.7 ms), memungkinkan 20+ FPS realtime di CPU/WASM browser.
4. **Zero Memory Footprint Increase**: Ukuran ONNX tetap 11.7 MB (cocok untuk client-side browser deployment).
5. **Backwards Compatibility**: VisionX UI menyediakan tombol switch V1/V2 secara instan di dropdown model selector.
