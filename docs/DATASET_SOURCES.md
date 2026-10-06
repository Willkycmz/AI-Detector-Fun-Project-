# VisionX — External Dataset Sources & Licensing Attribution

Dokumen ini mencatat seluruh dataset publik eksternal yang diintegrasikan ke dalam VisionX untuk melengkapi data deteksi objek, beserta lisensi resmi dan tautan atribusinya untuk kepatuhan lisensi open-source pada repositori publik GitHub.

---

## 1. Ringkasan Lisensi & Kepatuhan (Compliance)

- **Roboflow Universe Datasets:** Seluruh dataset yang ditarik dari Roboflow Universe dilisensikan di bawah **Creative Commons Attribution 4.0 International (CC BY 4.0)**. Lisensi ini mengizinkan penggunaan, adaptasi, dan distribusi dengan syarat atribusi yang sesuai dan pencantuman perubahan yang dilakukan (konversi poligon ke bounding box YOLO, filter kelas target, deduplikasi hash).
- **Kaggle Datasets:** Dataset yang ditarik dari Kaggle merupakan Open Community Data yang dipublikasikan secara publik untuk keperluan riset dan pengembangan machine learning.

---

## 2. Tabel Atribusi Dataset Sumber Aktif Per Kelas

| Target Class (VisionX ID) | Nama Dataset / Workspace | Platform | URL Sumber | Lisensi | Kontribusi Gambar | Keterangan Preprocessing |
| :--- | :--- | :---: | :--- | :---: | :---: | :--- |
| **cell_phone** (ID 6) | `zohona/smartphone-detectation` (v1) | Roboflow | [Roboflow Universe](https://universe.roboflow.com/zohona/smartphone-detectation/dataset/1) | CC BY 4.0 | 350 | Seleksi representatif 350 frame video webcam dengan diversity sampling |
| **cell_phone** (ID 6) | `perangkat-digital/handphone-rdeqa` (v1) | Roboflow | [Roboflow Universe](https://universe.roboflow.com/perangkat-digital/handphone-rdeqa/dataset/1) | CC BY 4.0 | 193 | Filter kelas `handphone`, resolusi min 200px |
| **cell_phone** (ID 6) | `cellphone-t7lxi/cellphone-pr6a7` (v2) | Roboflow | [Roboflow Universe](https://universe.roboflow.com/cellphone-t7lxi/cellphone-pr6a7/dataset/2) | CC BY 4.0 | 77 | Filter kelas `cellphone` |
| **mouse** (ID 4) | `machine-learning-chipg/computer-mouse-tqzgh` (v2) | Roboflow | [Roboflow Universe](https://universe.roboflow.com/machine-learning-chipg/computer-mouse-tqzgh/dataset/2) | CC BY 4.0 | 653 | Pemetaan `black-mouse` & `white-mouse` ke ID 4 |
| **mouse** (ID 4) | `practicas-eoqqx/computer-mouse-ojgea` (v1) | Roboflow | [Roboflow Universe](https://universe.roboflow.com/practicas-eoqqx/computer-mouse-ojgea/dataset/1) | CC BY 4.0 | 200 | Filter kelas `Computer-mouse` |
| **mouse** (ID 4) | `muhammad-arifin/mouse-as1lg` (v2) | Roboflow | [Roboflow Universe](https://universe.roboflow.com/muhammad-arifin/mouse-as1lg/dataset/2) | CC BY 4.0 | 57 | Filter kelas `mouse`, penanganan long-path Windows |
| **mouse** (ID 4) | `barang-di-kelas` (v1) | Roboflow | [Roboflow Universe](https://universe.roboflow.com/latihancustomdatasetsabtubersamapakdadang/barang-di-kelas/dataset/1) | CC BY 4.0 | 19 | Ekstraksi kelas `Mouse` dari multi-class dataset |
| **dompet** (ID 7) | `rasyidlfruq/dompet-vm6zp` (v2) | Roboflow | [Roboflow Universe](https://universe.roboflow.com/rasyidlfruq/dompet-vm6zp/dataset/2) | CC BY 4.0 | 360 | Filter kelas `Dompet` |
| **dompet** (ID 7) | `leonie-xwnrf/wallet-4lirl` (v1) | Roboflow | [Roboflow Universe](https://universe.roboflow.com/leonie-xwnrf/wallet-4lirl/dataset/1) | CC BY 4.0 | 290 | Konversi poligon segmentasi ke tight bounding box YOLO |
| **dompet** (ID 7) | `gak-jelas/dompet-ziipf` (v1) | Roboflow | [Roboflow Universe](https://universe.roboflow.com/gak-jelas/dompet-ziipf/dataset/1) | CC BY 4.0 | 147 | Konversi poligon segmentasi ke bounding box |
| **dompet** (ID 7) | `fitria-astuti/dompet-zrblt` (v4) | Roboflow | [Roboflow Universe](https://universe.roboflow.com/fitria-astuti/dompet-zrblt/dataset/4) | CC BY 4.0 | 99 | Filter kelas `dompet` (membuang kelas lain) |
| **kacamata** (ID 8) | `objek-dalam-ayunda/kacamata-model` (v2) | Roboflow | [Roboflow Universe](https://universe.roboflow.com/objek-dalam-ayunda/kacamata-model/dataset/2) | CC BY 4.0 | 1.037 | Filter kelas `kacamata`, pembersihan duplikat |
| **kacamata** (ID 8) | `aini/kacamata` (v1) | Roboflow | [Roboflow Universe](https://universe.roboflow.com/aini/kacamata/dataset/1) | CC BY 4.0 | 78 | Filter kelas `Kacamata` |
| **kacamata** (ID 8) | `barang-di-kelas` (v1) | Roboflow | [Roboflow Universe](https://universe.roboflow.com/latihancustomdatasetsabtubersamapakdadang/barang-di-kelas/dataset/1) | CC BY 4.0 | 16 | Ekstraksi kelas `Kacamata` dari multi-class dataset |
| **sendal** (ID 9) | `project-b99pz/sandal-hxhtk` (v4) | Roboflow | [Roboflow Universe](https://universe.roboflow.com/project-b99pz/sandal-hxhtk/dataset/4) | CC BY 4.0 | 559 | Filter kelas `sandal` (membuang `objects`) |
| **sendal** (ID 9) | `arjon-del-rosario/sandals-fnnnf` (v3) | Roboflow | [Roboflow Universe](https://universe.roboflow.com/arjon-del-rosario/sandals-fnnnf/dataset/3) | CC BY 4.0 | 416 | Pemetaan seluruh varian warna sandal ke ID 9 |
| **sendal** (ID 9) | `2024-2nd-sem-nurshiera-atari-3c/sandals-qytxp` (v1) | Roboflow | [Roboflow Universe](https://universe.roboflow.com/2024-2nd-sem-nurshiera-atari-3c/sandals-qytxp/dataset/1) | CC BY 4.0 | 100 | Filter kelas `sandals` |
| **sendal** (ID 9) | `uas-ml-p8ban/deteksi-sendal` (v2) | Roboflow | [Roboflow Universe](https://universe.roboflow.com/uas-ml-p8ban/deteksi-sendal/dataset/2) | CC BY 4.0 | 94 | Filter kelas `Sendal` |
| **tisue** (ID 10) | `kenneths-workspace-byjcc/tissue-zs5pf` (v1) | Roboflow | [Roboflow Universe](https://universe.roboflow.com/kenneths-workspace-byjcc/tissue-zs5pf/dataset/1) | CC BY 4.0 | 517 | Konversi poligon segmentasi ke bounding box YOLO |
| **tisue** (ID 10) | `morris-kbgym/tissue-i7dq2` (v3) | Roboflow | [Roboflow Universe](https://universe.roboflow.com/morris-kbgym/tissue-i7dq2/dataset/3) | CC BY 4.0 | 68 | Filter kelas `tissue` |
| **uang_100rb** (ID 11) | `nurulalfiyyah/rupiah-banknotes` | Kaggle | [Kaggle Dataset](https://www.kaggle.com/datasets/nurulalfiyyah/rupiah-banknotes) | Open Community / DbCL | 2.302 | **Filter ketat hanya folder 100rb** (`2016-100B`, `2016-100D`, `2022-100B`, `2022-100D`), nominal lain dibuang |
| **uang_100rb** (ID 11) | `skripsi-3kth2/deteksi-mata-uang-rupiah-nerog` (v8) | Roboflow | [Roboflow Universe](https://universe.roboflow.com/skripsi-3kth2/deteksi-mata-uang-rupiah-nerog/dataset/8) | CC BY 4.0 | 278 | Real-world scene bbox, **filter hanya label `seratus ribu rupiah`** |
| **uang_100rb** (ID 11) | `agil-skripsi-3/rupiah-banknote-7-cls` (v4) | Roboflow | [Roboflow Universe](https://universe.roboflow.com/agil-skripsi-3/rupiah-banknote-7-cls/dataset/4) | CC BY 4.0 | 176 | Real-world scene bbox, **filter hanya label `seratus ribu`** |
| **uang_100rb** (ID 11) | `deteksi-mata-uang-rupiah-ktdf0/deteksi-mata-uang-rupiah-ej7la` (v2) | Roboflow | [Roboflow Universe](https://universe.roboflow.com/deteksi-mata-uang-rupiah-ktdf0/deteksi-mata-uang-rupiah-ej7la/dataset/2) | CC BY 4.0 | 80 | **Filter hanya label `100.000 Rupiah`**, konversi poligon ke bbox |
| **car** (ID 14) | `benjamintli/coco2017-10k` | HuggingFace | [HuggingFace COCO](https://huggingface.co/datasets/benjamintli/coco2017-10k) | CC BY 4.0 | 800 | Subset COCO 2017, filter kategori `car`, resolusi min 200px |
| **motorcycle** (ID 15) | `benjamintli/coco2017-10k` | HuggingFace | [HuggingFace COCO](https://huggingface.co/datasets/benjamintli/coco2017-10k) | CC BY 4.0 | 358 | Subset COCO 2017, filter kategori `motorcycle`, resolusi min 200px |
| **backpack** (ID 16) | `benjamintli/coco2017-10k` | HuggingFace | [HuggingFace COCO](https://huggingface.co/datasets/benjamintli/coco2017-10k) | CC BY 4.0 | 562 | Subset COCO 2017, filter kategori `backpack`, resolusi min 200px |
| **umbrella** (ID 17) | `benjamintli/coco2017-10k` | HuggingFace | [HuggingFace COCO](https://huggingface.co/datasets/benjamintli/coco2017-10k) | CC BY 4.0 | 416 | Subset COCO 2017, filter kategori `umbrella`, resolusi min 200px |
| **book** (ID 18) | `benjamintli/coco2017-10k` | HuggingFace | [HuggingFace COCO](https://huggingface.co/datasets/benjamintli/coco2017-10k) | CC BY 4.0 | 562 | Subset COCO 2017, filter kategori `book`, resolusi min 200px |

---

## 3. Sumber yang Dibuang Pasca Audit Kualitas (Deprecations)

Berdasarkan audit visual lanjutan (Round 2 Spot-Check), dua sumber berikut secara permanen **dikeluarkan dan dihapus** dari pipeline VisionX:
1. **`datasetcitra/handphone-evcpx` (Roboflow - 352 gambar):** Dibuang karena 90% sampel berupa infografis katalog e-commerce, render 3D studio, dan tablet/iPad, serta 20% kolase memiliki objek handphone yang tidak dilabel (menyebabkan false negative dan regresi akurasi).
2. **`hashimatulzaria/data-uang-rupiah` (Kaggle - 100 gambar):** Dibuang karena 70% sampel berupa potongan makro (ROI) forensik ber-rasio 1:1 di mana angka nominal uang tidak terlihat, bukan gambar uang utuh di dunia nyata.

---

## 4. Catatan Hak Cipta & Disclaimer
Semua hak cipta dan kepemilikan data asli tetap berada pada para pembuat / kontributor masing-masing dataset di Roboflow Universe dan Kaggle. Penggunaan dalam VisionX adalah untuk tujuan pelatihan model deteksi objek terbuka (open-source edge AI).
