# VisionX V1.4 — Label Quality Audit Report

## 1. Ringkasan Audit Kualitas Bounding Box

| Metrik Kualitas Label | Own Real-World Pool | Real-World Holdout Set | Status |
| :--- | :---: | :---: | :---: |
| **Total Gambar** | 140 | 40 | PASS |
| **Total Anotasi Bounding Box** | 201 | 63 | PASS |
| **Missing Label Files** | 0 | 0 | PASS |
| **Invalid Class IDs** | 0 | 0 | PASS |
| **Malformed BBoxes** | 0 | 0 | PASS |
| **BBoxes Outside [0.0, 1.0]** | 0 | 0 | PASS |
| **Duplicate BBoxes** | 0 | 0 | PASS |
| **Extremely Tiny BBoxes (<0.0002)** | 0 | 0 | PASS |
| **Impossible Annotations (w<=0, h<=0)** | 0 | 0 | PASS |

## 2. Kesimpulan Kualitas Label
Seluruh bounding box pada dataset baru telah divalidasi 100% compliant dengan standar YOLO v8:
- Format normalisasi berada dalam range valid `[0.0, 1.0]`.
- ID kelas tepat memetakan ke 7 kelas terdaftar VisionX (0–6).
- Tidak ada duplicate detection overlap, NaN/infinite coordinates, ataupun missing files.
