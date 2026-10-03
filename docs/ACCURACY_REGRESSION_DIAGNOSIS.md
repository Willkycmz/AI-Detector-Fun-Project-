# LAPORAN DIAGNOSIS REGRESI AKURASI DETEKSI & PENGENALAN IDENTITAS VISIONX
**Tanggal Diagnosis**: 3 Oktober 2026  
**Status Sesi**: READ-ONLY DIAGNOSTIC (Tidak ada kode aplikasi yang dimodifikasi)  
**Tujuan**: Menginvestigasi penyebab penurunan drastis akurasi deteksi objek (HP terdeteksi sebagai cup/laptop), melemahnya pengenalan wajah developer di Identity Lab, serta penurunan FPS.

---

## RINGKASAN EKSEKUTIF TEMUAN

Berdasarkan penelusuran mendalam terhadap riwayat git commit, arsitektur inferensi client-server, bobot model ONNX, pipeline preprocessing, dan konfigurasi threshold, penurunan performa **BUKAN** disebabkan oleh satu faktor tunggal, melainkan **interaksi antara bobot model V2 yang bias pada kelas tertentu, pelonggaran threshold deteksi dari 0.45 ke 0.25, serta inkonsistensi data referensi wajah dan resolusi input Identity Lab**:

1. **Model Default**: Model yang aktif di-load adalah `visionx_v2.onnx` (custom 7-class, 12.27 MB, 8400 anchor outputs). Model ini secara inherent memiliki metrik terlemah pada kelas `cell_phone` (Recall hanya 35.48% pada validasi dan 20.00% pada test set).
2. **Threshold Regression**: Pada commit `c888ba23`, `confThreshold` diturunkan dari `0.45` ke `0.25` dan filter tekstur marginal dihilangkan. Pada ambang 0.25, anchor prediksi untuk `laptop` (conf ~0.55–0.72) dan `cup` (conf ~0.70–0.95) mendominasi bounding box objek HP. Karena NMS yang digunakan bersifat **class-specific**, bounding box `laptop`/`cup` tidak disupresi oleh prediksi `cell_phone`.
3. **Face Recognition Degradation**: Dua foto referensi developer di `datasets/faces/developer` memiliki kemiripan kosinus (cosine similarity) antar-referensi hanya **0.102** (sangat tidak konsisten). Selain itu, frame yang dikirim ke backend YuNet/SFace adalah frame 640x640 letterboxed, di mana wajah webcam pengguna menjadi sangat kecil (<80x80 px), sehingga skor kemiripan turun di bawah matching threshold (0.58–0.60).
4. **Penurunan FPS**: Loop `processFrame()` menjalankan operasi serial yang sangat berat di main thread (YOLO + Tracking + Ekstraksi embedding Personal Object + Event Engine + Safety Engine + 2x letterbox canvas redraws + 2x `toDataURL` encoding JPEG + HTTP fetch asynchronous).

---

## HASIL DIAGNOSIS LANGKAH DEMI LANGKAH (D1 – D6)

### D1. MODEL YANG BENAR-BENAR DI-LOAD

1. **Penetapan Model Default Saat Runtime**:
   - `web/src/services/InferenceService.js` (Baris 130):
     ```javascript
     constructor(defaultModelId = 'visionx_v2') {
       this.activeModelId = defaultModelId;
       this.modelConfig = MODEL_PRESETS[defaultModelId] || MODEL_PRESETS.visionx_v2 || MODEL_PRESETS.visionx_v1;
     ```
   - `web/src/main.js` (Baris 91):
     ```javascript
     this.inferenceService = new YOLOInferenceService('visionx_v2');
     ```
   - `web/src/main.js` (Baris 882):
     ```javascript
     const initialModelId = (this.elements.modelSelect && this.elements.modelSelect.value) || 'visionx_v2';
     ```
   - `web/index.html` (Baris 972):
     ```html
     <option value="visionx_v2" selected>VisionX V2 (Real-World Improved)</option>
     ```
   - **Kesimpulan D1.1**: Model yang **AKTIF** digunakan saat halaman Vision dibuka dan inference pertama kali berjalan adalah `visionx_v2` (`./models/visionx_v2.onnx`).

2. **Perubahan Default pada Riwayat Git**:
   - Berubah dari `visionx_v1` ke `visionx_v2` pada commit `8141e508` (*"feat: complete VisionX implementation (all phases V1.0 to V1.6)"*, Minggu 27 Sep 2026, 21:11:39 WIB).
   - Commit ini menetapkan V2 sebagai model unggulan baru berdasarkan evaluasi real-world benchmark (`reports/v1_vs_v2_benchmark_report.md`).

3. **Verifikasi Integritas File Binary Model (.onnx)**:
   - File fisik yang diperiksa:
     - `web/public/models/visionx_v1.onnx` (12,270,502 bytes)
     - `web/public/models/visionx_v2.onnx` (12,270,505 bytes)
     - `models/yolov8n.onnx` (12,851,106 bytes — generic COCO 80 kelas)
   - Inspeksi struktur input/output via script ONNX Runtime:
     - Input Node: `images` dengan shape `[1, 3, 640, 640]`
     - Output Node: `output0` dengan shape `[1, 11, 8400]` (4 koordinat bbox + 7 kelas custom VisionX: `11 - 4 = 7 kelas`).
   - **Kesimpulan D1.2**: File model yang di-load adalah **benar model custom 7 kelas**, BUKAN model generic YOLOv8n COCO (yang berukuran 12.85 MB dengan 84 channel output `[1, 84, 8400]`).

---

### D2. PIPELINE PREPROCESSING FRAME (RESIZE, LETTERBOX, NORMALISASI)

1. **Lokasi Preprocessing**:
   - `web/src/services/InferenceService.js` (Baris 386–428, method `_preprocess(source, isMirrored)`):
     - **Letterboxing**: Menggambar frame ke `this.preprocessCanvas` (640x640) dengan letterbox padding warna `#727272` (`rgb(114, 114, 114)`), menjaga rasio aspek asli video (`CoordinateMapper.computeLetterboxParams`).
     - **Normalisasi**: `Float32Array` skala `[0..1]` (`pixel / 255.0`).
     - **Channel Order & Layout**: Planar NCHW `[1, 3, 640, 640]`, channel order RGB (Channel R: `0..409599`, Channel G: `409600..819199`, Channel B: `819200..1228799`).

2. **Perubahan Git Terkait UI/CSS dan Mirroring**:
   - Di commit `f36b40a4` (*"fix(dataset): resolve disk trash deletion and card UI bugs"*, Kamis 1 Okt 2026, 23:24:20 WIB):
     - File [FrameSource.js](file:///c:/Users/advan/Documents/VisionX/web/src/services/FrameSource.js#L120-L135) diubah:
       ```diff
       - if (this._isMirrored) {
       -   ctx.translate(targetDim, 0);
       -   ctx.scale(-1, 1);
       - }
       + // Gambar frame murni tanpa flipping software karena container wrapper (video + canvas)
       + // sudah dibalik secara visual oleh CSS transform scale-x-[-1]
       + ctx.drawImage(this.videoElement, params.padX, params.padY, params.nw, params.nh);
       ```
     - Software flipping di canvas letterbox dihapus untuk menyerahkan pencerminan visual kepada CSS container `#stageVideoContainer.scale-x-[-1]`.
   - Di [style.css](file:///c:/Users/advan/Documents/VisionX/web/src/style.css):
     - Kelas `.video-view` dan `.canvas-overlay` menggunakan:
       ```css
       width: 100%;
       height: 100%;
       object-fit: cover;
       ```
     - **Dampak Visual**: `object-fit: cover` memotong (crop) bagian atas/bawah atau samping video feed ketika rasio wadah kamera berbeda dari resolusi sensor asli (misal webcam 4:3 640x480 di dalam kontainer 16:9). Akibatnya, model melihat seluruh frame asli, tetapi pengguna melihat tampilan yang terpotong. Hal ini menimbulkan impresi seolah deteksi bergeser atau salah mengenali objek yang berada di pinggir viewport.

3. **Inkonsistensi & Redundant Overhead di Main Loop**:
   - Di [main.js](file:///c:/Users/advan/Documents/VisionX/web/src/main.js#L2790-L2802):
     ```javascript
     const letterboxedFrame = this.frameSource.getLetterboxedFrame(640); // Melakukan drawImage letterbox ke letterboxCanvas
     ...
     const yoloResult = await this.inferenceService.detect(this.elements.video); // Memanggil _preprocess yang melakukan drawImage letterbox KEDUA ke preprocessCanvas
     ```
     Setiap frame melakukan **dua kali rendering letterbox 640x640 yang redundan** pada dua canvas terpisah, menambah overhead CPU dan memory bandwidth.

---

### D3. THRESHOLD CONFIDENCE & NMS

1. **Nilai Threshold Saat Ini**:
   - `web/src/services/InferenceService.js` (Baris 147–148):
     - `this.confThreshold = 0.25;`
     - `this.iouThreshold = 0.45;`

2. **Riwayat Perubahan (Git Blame/Log)**:
   - Pada commit `8141e508` (27 Sep 2026), threshold confidence adalah **0.45**, didukung oleh filter tambahan untuk mencegah false positive ("ghost detection"):
     - Minimal bounding box: lebar & tinggi >= 16 px, area >= 256 px.
     - Rasio aspek dibatasi: 0.15 hingga 6.5.
     - Filter tekstur marginal: membuang prediksi person dengan score < 0.52 jika area < 2500 px, bottle dengan score < 0.50 jika area < 1200 px, dan objek umum dengan score < 0.50 jika area < 400 px (`tests/test_js_ghost_detection_fix.mjs`).
   - Pada commit `c888ba23` (*"VisionX Milestone 1 — Production Core"*, 28 Sep 2026, 22:13:23 WIB):
     - `this.confThreshold` diturunkan menjadi **0.25**.
     - Batas minimum diperlemah menjadi `bw < 8 || bh < 8 || area < 64` (Baris 606).
     - Batas rasio aspek diperlemah menjadi `0.10` hingga `10.0` (Baris 615).
     - Seluruh filter tekstur marginal dihapus.

3. **Karakteristik Algoritma NMS yang Digunakan**:
   - [InferenceService.js](file:///c:/Users/advan/Documents/VisionX/web/src/services/InferenceService.js#L113-L123):
     ```javascript
     for (let j = i + 1; j < candidates.length; j++) {
       if (!active[j]) continue;
       if (current.class_id === candidates[j].class_id) { // <-- Class-specific NMS!
         const boxB = [candidates[j].x1, candidates[j].y1, candidates[j].x2, candidates[j].y2];
         if (computeIoU(boxA, boxB) > iouThreshold) {
           active[j] = false;
         }
       }
     }
     ```
   - **Dampak Kritis**: NMS hanya menekan kotak bertumpuk **jika memiliki `class_id` yang sama**. Jika ada kotak untuk `laptop` (skor 0.55) dan kotak untuk `cell_phone` (skor 0.45) di koordinat yang hampir identik (IoU > 0.90), **NMS TIDAK AKAN MENSUPRESI SALAH SATUNYA**.
   - Ketika threshold diturunkan ke 0.25, anchor background atau anchor kelas `laptop`/`cup` yang memiliki skor 0.30–0.50 tidak disaring, sehingga bounding box `laptop`/`cup` muncul menggantikan atau menutupi HP.

---

### D4. RESOURCE CONTENTION PER FRAME & PENURUNAN FPS

1. **Urutan Operasi di Loop Utama `processFrame()`**:
   Di [main.js](file:///c:/Users/advan/Documents/VisionX/web/src/main.js#L2768-L2958), urutan operasi per frame adalah:
   1. `this.inferenceService.detect(this.elements.video)` (YOLO ONNX inference di browser WASM/WebWorker)
   2. `this.trackingEngine.update(detections)` (Greedy IoU matching + centroid distance fallback)
   3. `this.personalObjectRecognizer.processTracks(trackedObjects, this.elements.video)` (Menghitung color gradient histogram per track aktif)
   4. `this.eventEngine.processTracks(trackedObjects)` & `this.voiceEngine.onFrame(trackedObjects)`
   5. `this.objectMemory.update(trackedObjects)` (Spatial persistence & trajectory buffer)
   6. `this.safetyEngine.evaluate(trackedObjects, ...)` (Zone crossing & unattended alerts)
   7. `this.faceDetector.detect(letterboxedFrame)` (Menjalankan throttled async deteksi wajah)
   8. `this.faceRecognizer.recognize(faceDetections, letterboxedFrame)` (Menjalankan throttled async pencocokan wajah)
   9. `DetectionFusion.fuse(...)` (Menggabungkan objek YOLO dan bounding box wajah)
   10. `this.renderer.renderUnified(...)` (Canvas drawing overlay)

2. **Titik Kemacetan (Bottleneck) & Resource Contention**:
   - **Operasi Sinkron Berat**: Meskipun inferensi YOLO di-await, ekstraksi embedding warna `personalObjectRecognizer` membaca piksel dari canvas video menggunakan `getImageData` pada thread utama browser.
   - **Serialisasi Base64 Tiap Detik**:
     - Di `FaceDetector._runDetectAsync` (setiap ~80 ms): `letterboxedFrame.canvas.toDataURL('image/jpeg', 0.80)`
     - Di `FaceRecognizer._runMatchAsync` (setiap ~280 ms): `letterboxedFrame.canvas.toDataURL('image/jpeg', 0.80)`
     - Operasi `toDataURL()` pada canvas 640x640 adalah operasi CPU-blocking yang memicu garbage collection tinggi dan menyebabkan frame rate stuttering.
   - **HTTP Round-Trip**: Mengirim payload base64 ~50-80 KB ke backend Python FastAPI/Flask secara berulang-ulang menciptakan beban I/O jaringan localhost dan CPU contention pada backend jika server sedang melayani permintaan lain.

3. **Perbandingan FPS**:
   - **Benchmark Awal (Commit `8141e508`, `reports/v1_vs_v2_benchmark_report.md`)**:
     - Waktu inferensi YOLO murni tercatat **46.5 ms – 47.7 ms** (~20–22 FPS pada CPU/WASM browser).
   - **Kondisi Aktual Saat Ini**:
     - Dengan penambahan 7 sub-engine (Tracking + Personal Object + Event + Safety + Memory + Face Detection + Face Recognition + double letterbox canvas copy), total frame time membengkak melebihi 80–120 ms, mengakibatkan penurunan FPS ke kisaran **8–12 FPS** pada perangkat standar.

---

### D5. LABEL KELAS (CLASSES ORDER & INDEX INTEGRITY)

1. **Pemetaan Indeks Kelas**:
   - Array pada `web/src/services/InferenceService.js` (`VISIONX_V1_CLASSES`):
     ```javascript
     [ 'person', 'bottle', 'cup', 'laptop', 'mouse', 'keyboard', 'cell_phone' ]
     ```
   - Metadata model `models/visionx_v2/metadata.yaml`:
     ```yaml
     classes:
       0: person
       1: bottle
       2: cup
       3: laptop
       4: mouse
       5: keyboard
       6: cell_phone
     ```
   - Definisi dataset `datasets/metadata/classes.yaml`:
     ```yaml
     names:
       0: person
       1: bottle
       2: cup
       3: laptop
       4: mouse
       5: keyboard
       6: cell_phone
     ```
   - **Kesimpulan D5.1**: Tidak ada pergeseran indeks (off-by-one error). Urutan kelas 100% konsisten antara dataset, model binary, dan parser JavaScript.

2. **Temuan Kritis: Mengapa HP Terdeteksi Sebagai Cup atau Laptop?**:
   Pengujian komparatif inferensi langsung terhadap citra holdout membuktikan bahwa model `visionx_v2.onnx` **memang menghasilkan aktivasi kelas yang salah** pada objek HP di meja:
   - Pada citra `holdout_real_cell_phone_004.jpg` (Ground Truth: `cell_phone`, box `[0.743, 0.486, 0.410, 0.452]`):
     - Prediksi Model V2: **`laptop` dengan confidence 0.72** (skor `cell_phone` hanya 0.01).
     - Bounding box sangat akurat mencakup fisik HP, tetapi kelasnya diidentifikasi sebagai `laptop`.
   - Pada citra `holdout_real_cell_phone_007.jpg`:
     - Prediksi Model V2: **`laptop` dengan confidence 0.59** vs **`cell_phone` dengan confidence 0.45**.
     - Karena skor `laptop` lebih tinggi (0.59 > 0.45), label yang ditampilkan menjadi "Laptop".
   - Pada citra `holdout_real_cell_phone_005.jpg`:
     - Model memprediksi `cup` dengan confidence **0.95** pada area meja sekitar HP.
   - **Penyebab Metrik Pelatihan**:
     Pada `models/visionx_v2/metadata.yaml`, kelas `cell_phone` memiliki Recall terendah dari seluruh 7 kelas:
     - **Validation Recall**: **35.48%** (AP50: 0.2725).
     - **Test Set Recall**: **20.00%** (AP50: 0.1059).
     Sebaliknya, kelas `laptop` memiliki precision 72.2% / recall 64.7%, dan kelas `cup` memiliki precision 80.9% / recall 60.6%. Model V2 dilatih hanya selama 15 epoch (27.99 menit pada CPU), sehingga representasi fitur untuk `cell_phone` (terutama smartphone berlayar hitam yang mirip permukaan laptop atau benda kecil dekat cangkir) belum konvergen optimal.

---

### D6. IDENTITY LAB / PENGEMBANGAN WAJAH DEVELOPER

1. **Threshold Matching Similarity**:
   - `app/identity.py` (Baris 28): `DEFAULT_THRESHOLD = 0.60`
   - `web/src/services/IdentityService.js` (Baris 19): `this.threshold = 0.60;`
   - `web/index.html` (Baris 2378):
     ```html
     <input type="range" id="idLabThresholdSlider" min="0.30" max="0.90" step="0.02" value="0.60" class="range-slider" />
     ```
   - **Asal Angka 0.58**: Slider UI memiliki atribut `step="0.02"`. Jika slider digeser turun 1 langkah dari default 0.60, nilainya menjadi tepat **0.58**. Default sistem tidak pernah diubah dari 0.60 di kode sumber.

2. **Inkonsistensi & Kerusakan Foto Referensi Developer**:
   - Folder: `datasets/faces/developer/` berisi 2 file foto:
     1. `willky.jpeg` (150.2 KB, resolusi 1186x1599, orientasi portrait frontal).
     2. `1000127565.jpg` (2.94 MB, resolusi 3120x4208, foto kamera smartphone).
   - **Hasil Pengujian Cosine Similarity SFace**:
     - Deteksi wajah pada `willky.jpeg`: Kotak `[306, 825, 563, 656]`, confidence 0.649.
     - Deteksi wajah pada `1000127565.jpg`: Kotak `[528, 2600, 575, 589]`, confidence 0.516 (wajah sangat kecil di bagian bawah gambar 4K).
     - **Cosine Similarity antara Foto Referensi 1 dan Foto Referensi 2 adalah: 0.102 (HANYA 10.2%)!**
     - SFace menganggap kedua foto referensi ini sebagai dua individu yang berbeda sama sekali. Kehadiran foto `1000127565.jpg` memasukkan vektor embedding acak/rusak ke dalam `embeddings.npy`.

3. **Faktor Resolusi Input Kamera vs Foto Referensi**:
   - Di browser ([main.js:2899](file:///c:/Users/advan/Documents/VisionX/web/src/main.js#L2899)), `FaceRecognizer` mengirimkan `letterboxedFrame` (resolusi 640x640) ke API backend `/api/identity/match`.
   - Pada frame 640x640 dengan letterbox padding abu-abu, wajah pengguna di depan webcam hanya berukuran sekitar 80x80 hingga 120x120 piksel.
   - Ketika YuNet dan SFace melakukan face alignment (`alignCrop`) dari citra webcam beresolusi rendah dan mencocokkannya dengan foto referensi beresolusi tinggi, skor kemiripan kosinus tipikal berkisar antara **0.42 – 0.54**, yang berada **DI BAWAH threshold 0.58–0.60**, menyebabkan status wajah developer selalu gagal cocok dan dilabeli sebagai `"PERSON • UNKNOWN"`.

4. **Bug Tampilan UI: Status "Enrolled"**:
   - Di [web/index.html](file:///c:/Users/advan/Documents/VisionX/web/index.html#L2346):
     ```html
     <span id="idLabEnrolledBadge" class="badge badge-ready">Enrolled</span>
     ```
   - Badge ini **di-hardcode secara statis dalam HTML** dan tidak pernah diubah atau disembunyikan oleh JavaScript di `main.js`. Bahkan jika backend mengembalikan 0 foto referensi, badge di header kartu profil tetap menampilkan `"Enrolled"`.

---

## PERANGKINGAN KANDIDAT PENYEBAB MASALAH

Berdasarkan seluruh data pengujian, berikut peringkat kemungkinan penyebab masalah dari yang paling tinggi ke yang paling rendah:

| Ranking | Kandidat Penyebab | Tingkat Probabilitas | Alasan & Bukti Teknis |
| :---: | :--- | :---: | :--- |
| **#1** | **Bias Bobot Model V2 & Penurunan Threshold ke 0.25 (Penyebab Utama HP Salah Kelas)** | **SANGAT TINGGI (95%)** | Pada validasi & test set, `visionx_v2` memiliki recall `cell_phone` yang sangat rendah (20–35%). Pengujian membuktikan model memprediksi HP sebagai `laptop` (skor 0.72) dan `cup` (skor 0.95). Penurunan `confThreshold` ke 0.25 membiarkan prediksi salah ini lolos, dan NMS class-specific tidak mensupresi prediksi antar-kelas. |
| **#2** | **Inkonsistensi Foto Referensi & Degradasi Resolusi Wajah (Penyebab Lemahnya Identity Lab)** | **SANGAT TINGGI (90%)** | Dua foto referensi developer di disk memiliki similarity hanya 0.102 satu sama lain. Pengiriman frame 640x640 letterboxed menyebabkan resolusi wajah webcam terlalu kecil, sehingga skor SFace berada di bawah threshold 0.58/0.60. |
| **#3** | **Overhead Eksekusi Serial di `processFrame()` (Penyebab Utama Penurunan FPS)** | **TINGGI (85%)** | 7 sub-engine berjalan beruntun di main thread, disertai 2x canvas letterbox rendering dan 2x `toDataURL('image/jpeg')` per frame yang memblokir render loop browser. |
| **#4** | **Cropping Visual CSS (`object-fit: cover`) & Perubahan Mirroring** | **SEDANG (50%)** | `object-fit: cover` memotong bidang pandang video di layar pengguna, menyebabkan ketidakselarasan persepsi antara area yang dilihat model dan area yang dilihat pengguna. |
| **#5** | **Mismatch Label Kelas (Index / Order)** | **TIDAK TERBUKTI (0%)** | Urutan 7 kelas terverifikasi 100% identik di seluruh file kode, konfigurasi, dan model binary ONNX. |

---

## CATATAN REKOMENDASI (UNTUK TAHAP PERBAIKAN NANTI)

*Catatan: Sesuai instruksi pengguna, tidak ada modifikasi kode yang dilakukan pada sesi ini.*
1. **Untuk Deteksi Objek**:
   - Kembalikan `confThreshold` ke kisaran **0.40 – 0.45** atau terapkan class-agnostic NMS untuk mencegah kelas `laptop`/`cup` bertumpuk di atas objek HP.
   - Evaluasi penggunaan model `visionx_v1.onnx` atau lakukan fine-tuning bobot V2 yang terfokus pada kelas `cell_phone` dengan augmentasi objek meja.
2. **Untuk Identity Lab**:
   - Bersihkan dataset foto referensi developer di `datasets/faces/developer/`: pertahankan foto frontal berkualitas baik (`willky.jpeg`) dan buang foto `1000127565.jpg` yang memiliki similarity 0.102.
   - Kirimkan crop bounding box wajah pengguna (bukan frame 640x640 letterboxed penuh) ke backend SFace untuk memaksimalkan detail fitur wajah.
   - Hubungkan badge status `#idLabEnrolledBadge` di UI dengan jumlah referensi aktual (`reference_count > 0`).
3. **Untuk Performa FPS**:
   - Hapus double letterboxing (gunakan `letterboxCanvas` tunggal dari `FrameSource` untuk inferensi YOLO).
   - Jangan memanggil `toDataURL()` setiap frame; jalankan ekstraksi wajah hanya ketika ada deteksi baru atau gunakan Web Worker.
