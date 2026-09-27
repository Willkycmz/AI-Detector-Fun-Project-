# VisionX V1.4 — Real-World Targeted Data Collection Plan

## 1. Latar Belakang & Rationale
Berdasarkan hasil diagnostic audit pada Model V1 (`reports/v1_error_analysis.md`), Model V1 memiliki kelemahan kritis:
1. **Deteksi Objek Kecil Gagal Total**: Recall objek skala kecil hanya **13.43%** (86.6% missed).
2. **Kelas Terburuk**:
   - `cell_phone`: Recall 13.33%, AP50 0.0843, 22 background FP (meja/buku keliru dideteksi).
   - `cup`: Recall 21.05%, AP50 0.3163.
   - `bottle`: Recall 35.29%, AP50 0.3164.
   - `laptop`: Recall 46.67%, AP50 0.3718, 20 background FP.
3. **Domain Gap**: Dataset V1 (COCO web images) tidak merepresentasikan sudut pandang webcam laptop dan kamera HP pada workspace nyata (meja kerja berantakan, pencahayaan minim, jarak ekstrem, oklusi tangan).

Target pengumpulan data V1.4 dirancang secara **targeted, terstruktur, non-random**, untuk menutup domain gap dan failure mode tersebut.

---

## 2. Matriks Kondisi Target Pengumpulan Data

Setiap sampel data wajib diklasifikasikan ke dalam matriks taksonomi berikut:

| Kategori | Parameter Kondisi | Deskripsi Spesifik | Target Kelas Utama |
| :--- | :--- | :--- | :--- |
| **Pencahayaan** | `indoor_bright` | Ruangan kantor/kamar dengan lampu LED terang (>300 lux) | Semua kelas |
| | `indoor_low_light` | Ruangan remang/malam hari dengan pencahayaan minim (<50 lux) | `cell_phone`, `cup`, `laptop` |
| | `daylight` | Cahaya alami jendela matahari, bayangan kuat, backlight | `bottle`, `cup`, `person` |
| **Sudut Pandang** | `different_angles` | Oblique 45°, top-down (dari atas meja), low-angle, profile 90° | `laptop`, `keyboard`, `mouse` |
| **Jarak/Skala** | `near` | Jarak dekat (0.3m – 0.6m), objek mengisi >40% frame | `keyboard`, `mouse`, `bottle` |
| | `far` | Jarak jauh (1.5m – 3.0m), objek berukuran kecil (<32x32px) | `cell_phone`, `cup`, `mouse` |
| | `small_object` | Objek di kejauhan atau di latar belakang dengan area < 1024 px² | `cell_phone`, `cup`, `mouse` |
| **Konteks Lingkungan**| `partial_occlusion`| Objek terhalang tangan, tertutup sebagian buku/kertas, di balik laptop | `cell_phone`, `cup`, `bottle` |
| | `cluttered_background`| Meja kerja padat: kabel, kertas, pulpen, botol lain, tekstur kayu/karpet | `mouse`, `cell_phone`, `laptop`|
| **Perangkat Sensor** | `laptop_webcam` | Kamera internal laptop (FOV lebar, dynamic range rendah, sensor noise) | Semua kelas |
| | `mobile_camera` | Kamera smartphone (sensor tajam, aspek rasio variatif, depth of field) | Semua kelas |

---

## 3. Protokol & Format Metadata Setiap Capture

Pengumpulan data **DILARANG RANDOM**. Setiap capture wajib memiliki metadata terstruktur yang dicatat pada `datasets/metadata/sources_v2.yaml`.

### Skema Metadata Capture:
```yaml
image_id: "own_webcam_20260926_001_cell_phone.jpg"
class: "cell_phone"             # Kelas target sesuai classes.yaml
source: "own"                   # Wajib 'own' untuk data internal
device: "laptop_webcam"         # 'laptop_webcam' | 'mobile_camera'
conditions:
  - "indoor_low_light"
  - "partial_occlusion"
  - "near"
  - "cluttered_background"
notes: "HP dipegang tangan kiri di atas meja berantakan dengan backlight monitor"
resolution: [1280, 720]
timestamp: "2026-09-26T10:45:00"
```

---

## 4. Alokasi Target Sampel Data Tambahan (Own Real-World)

| Kelas | Target Sampel Baru | Fokus Skenario | Failure Mode yang Ditargetkan |
| :--- | :---: | :--- | :--- |
| `cell_phone` | 35 | Layar mati/hidup, dipegang tangan, di atas meja, sudut miring | Recall 13.3% -> Minimal 60%, eliminasi background FP |
| `cup` | 30 | Cangkir kopi, mug keramik, tumbler, sudut atas dan samping | Recall 21.0% -> Minimal 55% |
| `bottle` | 25 | Botol plastik bening, botol stainless, kondisi backlight | Recall 35.3% -> Minimal 65% |
| `laptop` | 25 | Laptop terbuka, setengah tertutup, sudut miring, meja kerja | Eliminasi 20 background FP, bedakan keyboard vs laptop |
| `mouse` | 20 | Mouse kabel/wireless di mousepad bermotif / meja kayu | Deteksi mouse kecil di sudut meja |
| `keyboard` | 20 | Keyboard mekanik, keyboard laptop, sudut miring | Mengurangi overlap klasifikasi dengan laptop |
| `person` | 25 | Duduk depan webcam, backlit jendela, pencahayaan temaram | False positive bayangan berkurang |
| **Total Baru** | **180** | **Kombinasi Webcam Laptop & Mobile Camera** | **Tercatat di `datasets/raw/own/`** |

---

## 5. Pemisahan Direktori & Proteksi Anti-Leakage

Struktur direktori dijaga terpisah secara ketat:
```
datasets/
├── raw/
│   ├── own/                     <-- Seluruh data baru berlabel sumber 'own' disimpan di sini
│   │   ├── images/
│   │   └── labels/
│   └── external/                <-- Data eksternal COCO (terisolasi)
├── metadata/
│   ├── sources_v2.yaml          <-- Manifest lengkap dengan conditions & hashes
│   └── classes.yaml             <-- 7 kelas standar VisionX
├── real_world_holdout/          <-- 100% unseen real-world benchmark (TIDAK BOLEH masuk training)
│   ├── images/
│   └── labels/
└── processed_v2/                <-- Pipeline output untuk training V2
    ├── dataset.yaml
    ├── images/ {train, val, test}
    └── labels/ {train, val, test}
```

### Aturan Anti-Leakage V1/V2:
1. **Test Set V1 Imutabilitas**: Test set V1 (`datasets/processed/images/test`, 51 citra) disimpan hash SHA-256 nya. Tidak ada citra dari test set V1 yang boleh masuk ke dalam `train` maupun `val` pada `processed_v2`.
2. **Real-World Holdout Isolasi**: Dibuat test set baru (`datasets/real_world_holdout/`) yang **eksklusif** diambil dari kondisi kamera nyata dan **TIDAK PERNAH** dimasukkan ke dalam folder `processed_v2/images/train` ataupun `processed_v2/images/val`.
