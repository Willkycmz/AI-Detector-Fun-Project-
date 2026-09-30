/**
 * DatasetCaptureService.js - Service Pengambilan & Pengelolaan Dataset (V0.5.1)
 * Mengelola validasi nama kelas, penamaan file unik, penangkapan frame asli (clean raw frames),
 * penyimpanan persisten langsung ke disk (datasets/raw/own/<class>/),
 * sinkronisasi API dev server, File System Access API, penghapusan tunggal & multi-delete,
 * impor citra & folder, pencegahan duplikasi (SHA-256), serta metadata presisi.
 */

import { ENDPOINTS } from './apiConfig.js';

// Daftar nama reserved Windows yang dilarang (kompatibel dengan app/collector.py)
export const WINDOWS_RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'
]);

// Ekstensi citra yang didukung untuk impor
export const SUPPORTED_IMPORT_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'];

// Kategori sumber dataset yang didukung
export const DATASET_SOURCES = [
  { id: 'own_capture', label: 'Own Live Camera Capture', folder: 'own' },
  { id: 'own_import', label: 'Own Local Import', folder: 'own' },
  { id: 'huggingface', label: 'HuggingFace Dataset', folder: 'external/huggingface' },
  { id: 'kaggle', label: 'Kaggle Dataset', folder: 'external/kaggle' },
  { id: 'other_external', label: 'Other External Source', folder: 'external/other' }
];

/**
 * Validasi dan sanitasi nama kelas agar aman sebagai nama direktori dan file.
 * Kompatibel 100% dengan validasi Python di app/collector.py.
 * @param {string} name 
 * @returns {string} Sanitized class name
 */
export function validateClassName(name) {
  if (!name || typeof name !== 'string') {
    throw new Error('Nama kelas tidak boleh kosong.');
  }

  let cleaned = name.trim().toLowerCase();
  cleaned = cleaned.replace(/\s+/g, '_');

  if (!cleaned) {
    throw new Error('Nama kelas tidak boleh hanya berisi spasi.');
  }

  if (WINDOWS_RESERVED_NAMES.has(cleaned.toUpperCase())) {
    throw new Error(`'${name}' adalah nama sistem terlarang di Windows. Silakan gunakan nama lain.`);
  }

  if (!/^[a-z0-9_\-]+$/.test(cleaned)) {
    throw new Error(`Nama kelas '${name}' mengandung karakter ilegal. Gunakan hanya huruf, angka, underscore (_), dan tanda hubung (-).`);
  }

  return cleaned;
}

/**
 * Menghitung hash SHA-256 dari ArrayBuffer menggunakan Web Crypto API.
 * @param {ArrayBuffer} buffer 
 * @returns {Promise<string>} 64-character hex hash string
 */
export async function computeBufferHash(buffer) {
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

export class DatasetCaptureService {
  constructor() {
    this.currentClass = this._loadCurrentClass();
    this.currentSource = 'own_capture';
    this.dirHandle = null;
    this.dirName = null;
    this.recentCaptures = [];
    this.classCounts = this._loadCounts();
    this.knownHashes = this._loadHashes();
    this.sourcesMetadata = this._loadMetadata();

    this.offscreenCanvas = document.createElement('canvas');
    this.offscreenCtx = this.offscreenCanvas.getContext('2d', { willReadFrequently: true });

    this.listeners = {
      capture: [],
      delete: [],
      import: [],
      classChange: [],
      countChange: [],
      sourceChange: [],
      directoryChange: []
    };
  }

  on(event, callback) {
    if (this.listeners[event]) {
      this.listeners[event].push(callback);
    }
  }

  _notify(event, data) {
    if (this.listeners[event]) {
      this.listeners[event].forEach(cb => {
        try {
          cb(data);
        } catch (e) {
          console.error(`[DatasetCaptureService] Error in listener '${event}':`, e);
        }
      });
    }
  }

  _loadCurrentClass() {
    try {
      const saved = localStorage.getItem('visionx_dataset_current_class');
      return saved ? validateClassName(saved) : 'earphone';
    } catch (e) {
      return 'earphone';
    }
  }

  _loadCounts() {
    try {
      const saved = localStorage.getItem('visionx_dataset_class_counts');
      return saved ? JSON.parse(saved) : {};
    } catch (e) {
      return {};
    }
  }

  _saveCounts() {
    try {
      localStorage.setItem('visionx_dataset_class_counts', JSON.stringify(this.classCounts));
    } catch (e) {
      console.warn('Gagal menyimpan count ke localStorage:', e);
    }
  }

  _loadHashes() {
    try {
      const saved = localStorage.getItem('visionx_dataset_known_hashes');
      return saved ? new Set(JSON.parse(saved)) : new Set();
    } catch (e) {
      return new Set();
    }
  }

  _saveHashes() {
    try {
      localStorage.setItem('visionx_dataset_known_hashes', JSON.stringify(Array.from(this.knownHashes)));
    } catch (e) {
      console.warn('Gagal menyimpan hashes ke localStorage:', e);
    }
  }

  _loadMetadata() {
    try {
      const saved = localStorage.getItem('visionx_dataset_sources_metadata');
      return saved ? JSON.parse(saved) : { items: {} };
    } catch (e) {
      return { items: {} };
    }
  }

  _saveMetadata() {
    try {
      localStorage.setItem('visionx_dataset_sources_metadata', JSON.stringify(this.sourcesMetadata));
    } catch (e) {
      console.warn('Gagal menyimpan metadata ke localStorage:', e);
    }
  }

  /**
   * Mengatur nama kelas aktif dengan validasi & persistensi.
   * @param {string} className 
   * @returns {string} Sanitized class name
   */
  setClass(className) {
    const sanitized = validateClassName(className);
    this.currentClass = sanitized;
    try {
      localStorage.setItem('visionx_dataset_current_class', sanitized);
    } catch (e) {
      console.warn('Gagal menyimpan current class ke localStorage:', e);
    }

    if (this.classCounts[sanitized] === undefined) {
      this.classCounts[sanitized] = 0;
    }
    this._saveCounts();
    this._notify('classChange', { currentClass: this.currentClass, count: this.getCount() });
    return sanitized;
  }

  /**
   * Mengatur sumber dataset aktif.
   * @param {string} sourceId 
   */
  setSource(sourceId) {
    const found = DATASET_SOURCES.find(s => s.id === sourceId);
    if (found) {
      this.currentSource = sourceId;
      this._notify('sourceChange', { source: this.currentSource, info: found });
    }
  }

  /**
   * Mendapatkan jumlah gambar yang telah diambil untuk kelas tertentu.
   * @param {string} [className]
   * @returns {number}
   */
  getCount(className = this.currentClass) {
    return this.classCounts[className] || 0;
  }

  /**
   * Reset count untuk kelas tertentu.
   * @param {string} className 
   */
  resetCount(className = this.currentClass) {
    this.classCounts[className] = 0;
    this._saveCounts();
    this._notify('countChange', { currentClass: className, count: 0 });
  }

  /**
   * Membuka dialog pemilih folder direktori dataset (File System Access API).
   */
  async selectDirectory() {
    if (!('showDirectoryPicker' in window)) {
      throw new Error('File System Access API tidak didukung pada browser ini. Data otomatis disimpan langsung ke server disk.');
    }

    try {
      this.dirHandle = await window.showDirectoryPicker({
        mode: 'readwrite',
        startIn: 'documents'
      });
      this.dirName = this.dirHandle.name;
      this._notify('directoryChange', { dirName: this.dirName, hasDirectoryHandle: true, isSupported: true });
      return this.dirName;
    } catch (err) {
      if (err.name === 'AbortError') {
        return null;
      }
      throw err;
    }
  }

  /**
   * Generate nama file unik sesuai standar VisionX V0.4.1 / V0.5.1.
   * Format: <class_name>_<source_tag>_YYYYMMDD_HHMMSS_<short_uuid>.<ext>
   */
  generateFilename(className = this.currentClass, source = this.currentSource, ext = 'jpg') {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    const timestampStr = `${year}${month}${day}_${hours}${minutes}${seconds}`;

    const uuidPart = Math.random().toString(16).substring(2, 8);
    const sourceTag = source.replace('own_', '');
    const cleanExt = ext.replace(/^\./, '');

    return `${className}_${sourceTag}_${timestampStr}_${uuidPart}.${cleanExt}`;
  }

  /**
   * Memuat dataset yang telah tersimpan pada disk melalui endpoint API dev server.
   */
  async loadExistingDataset() {
    try {
      const response = await fetch(ENDPOINTS.DATASET_LIST);
      if (!response.ok) {
        console.info('[DatasetCaptureService] /api/dataset/list tidak tersedia di backend production — memuat dari cache lokal.');
        return;
      }
      const data = await response.json();
      if (!data.success || !Array.isArray(data.items)) return;

      // Update hitungan kelas nyata dari disk
      const newCounts = {};
      data.items.forEach(item => {
        const cls = item.className || 'object';
        newCounts[cls] = (newCounts[cls] || 0) + 1;
      });
      this.classCounts = { ...this.classCounts, ...newCounts };
      this._saveCounts();

      // Transform items ke format recentCaptures standar
      this.recentCaptures = data.items.map(item => {
        const meta = this.sourcesMetadata.items ? this.sourcesMetadata.items[item.filename] : null;
        const width = (meta && meta.width) || (item.width) || 0;
        const height = (meta && meta.height) || (item.height) || 0;
        const resolution = (width && height) ? `${width}x${height}` : (meta && meta.resolution) || '-';

        return {
          id: item.filename,
          filename: item.filename,
          className: item.className,
          source: item.source || 'own_capture',
          width: width,
          height: height,
          resolution: resolution,
          sizeBytes: item.sizeBytes || 0,
          formattedSize: item.formattedSize || (item.sizeBytes ? `${(item.sizeBytes / 1024).toFixed(1)} KB` : '-'),
          timestamp: item.timestamp || '-',
          previewUrl: item.url,
          dataUrl: item.url,
          url: item.url,
          storageType: 'disk'
        };
      });

      this._notify('countChange', { currentClass: this.currentClass, count: this.getCount() });
      return this.recentCaptures;
    } catch (err) {
      console.warn('[DatasetCaptureService] Gagal memuat dataset dari disk API:', err);
    }
  }

  /**
   * Menangkap frame asli (clean raw frame) dari video element tanpa overlay atau HUD.
   * 
   * @param {HTMLVideoElement} videoElement Elemen video sumber stream
   */
  async captureFrame(videoElement) {
    if (!videoElement || videoElement.readyState < 2) {
      throw new Error('Video stream kamera belum siap untuk diambil.');
    }

    const vw = videoElement.videoWidth;
    const vh = videoElement.videoHeight;

    if (!vw || !vh || vw <= 0 || vh <= 0) {
      throw new Error('Resolusi frame video tidak valid (0x0).');
    }

    // 1. Gambar frame video murni ke offscreen canvas pada resolusi aslinya (tanpa canvasOverlay / HUD)
    this.offscreenCanvas.width = vw;
    this.offscreenCanvas.height = vh;
    this.offscreenCtx.drawImage(videoElement, 0, 0, vw, vh);

    // 2. Konversi ke Blob JPEG berkualitas tinggi (0.95)
    const blob = await new Promise((resolve, reject) => {
      this.offscreenCanvas.toBlob(
        (b) => {
          if (b && b.size > 0) resolve(b);
          else reject(new Error('Gagal mengonversi frame ke Blob format JPEG (ukuran 0 bytes).'));
        },
        'image/jpeg',
        0.95
      );
    });

    if (blob.size === 0) {
      throw new Error('Citra yang diambil kosong (0 bytes).');
    }

    // 3. Konversi ke base64 dataUrl untuk transmisi & preview instan
    const dataUrl = this.offscreenCanvas.toDataURL('image/jpeg', 0.95);

    // 4. Hitung SHA-256 Hash untuk pencegahan duplikasi
    const arrayBuffer = await blob.arrayBuffer();
    const imageHash = await computeBufferHash(arrayBuffer);

    if (this.knownHashes.has(imageHash)) {
      throw new Error(`Citra identik/duplikat terdeteksi (SHA256: ${imageHash.slice(0, 10)}...). Pengambilan dibatalkan.`);
    }

    const captureClass = this.currentClass;
    const filename = this.generateFilename(captureClass, 'own_capture', 'jpg');

    // 5. Upload ke backend production via multipart/form-data
    let saveResult = null;
    let storageType = 'disk';

    try {
      const formData = new FormData();
      formData.append('image', blob, filename);
      formData.append('info', JSON.stringify({
        filename,
        className: captureClass,
        source: 'own_capture',
        width: vw,
        height: vh
      }));

      const apiRes = await fetch(ENDPOINTS.UPLOAD, {
        method: 'POST',
        body: formData
        // Note: NO 'Content-Type' header — browser sets multipart boundary automatically
      });

      if (!apiRes.ok) {
        const errorText = await apiRes.text();
        throw new Error(`Server API upload gagal (${apiRes.status}): ${errorText}`);
      }

      const uploadResult = await apiRes.json();
      if (uploadResult.status !== 'success') {
        throw new Error(uploadResult.message || 'Server gagal menyimpan citra.');
      }
      saveResult = { success: true, url: null, ...uploadResult };
    } catch (saveErr) {
      console.error('[DatasetCaptureService] Gagal upload ke backend:', saveErr);
      throw new Error(`Penyimpanan dataset gagal: ${saveErr.message}`);
    }

    // 6. Jika user juga menghubungkan File System Access API, tulis juga ke directory handle
    if (this.dirHandle) {
      try {
        const ownDirHandle = await this.dirHandle.getDirectoryHandle('own', { create: true });
        const classDirHandle = await ownDirHandle.getDirectoryHandle(captureClass, { create: true });
        const fileHandle = await classDirHandle.getFileHandle(filename, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(blob);
        await writable.close();
        storageType = 'disk_and_fsa';
      } catch (fsErr) {
        console.warn('Peringatan: Gagal sinkronisasi ke File System Access API:', fsErr);
      }
    }

    // 7. Catat hash & update count
    this.knownHashes.add(imageHash);
    this._saveHashes();

    this.classCounts[captureClass] = (this.classCounts[captureClass] || 0) + 1;
    const newCount = this.classCounts[captureClass];
    this._saveCounts();

    const formattedSize = `${(blob.size / 1024).toFixed(1)} KB`;

    // 8. Catat metadata sumber
    this.sourcesMetadata.items[filename] = {
      class: captureClass,
      source: 'own_capture',
      hash_sha256: imageHash,
      width: vw,
      height: vh,
      resolution: `${vw}x${vh}`,
      size_bytes: blob.size,
      formatted_size: formattedSize,
      recorded_at: new Date().toISOString()
    };
    this._saveMetadata();

    // 9. Simpan record galeri dengan semua properti yang lengkap dan konsisten
    const captureRecord = {
      id: filename,
      filename,
      className: captureClass,
      source: 'own_capture',
      count: newCount,
      timestamp: new Date().toLocaleTimeString(),
      previewUrl: dataUrl,
      dataUrl: dataUrl,
      url: saveResult.url || `/datasets/raw/own/${captureClass}/${filename}`,
      hash: imageHash,
      width: vw,
      height: vh,
      resolution: `${vw}x${vh}`,
      sizeBytes: blob.size,
      formattedSize: formattedSize,
      storageType
    };

    this.recentCaptures.unshift(captureRecord);
    if (this.recentCaptures.length > 100) {
      this.recentCaptures.pop();
    }

    this._notify('capture', captureRecord);
    this._notify('countChange', { currentClass: captureClass, count: newCount });

    return captureRecord;
  }

  /**
   * Menghapus satu citra dari dataset dan mengupdate counter.
   * @param {string} filename 
   * @param {string} [className] 
   */
  async deleteImage(filename, className = this.currentClass) {
    const targetClass = className || this.currentClass;

    // 1. Hapus dari disk via server API
    try {
      const res = await fetch(ENDPOINTS.DATASET_DELETE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename,
          className: targetClass,
          source: 'own_capture'
        })
      });
      if (!res.ok) {
        console.warn('[DatasetCaptureService] Response delete tidak OK:', res.status);
      }
    } catch (err) {
      console.error('[DatasetCaptureService] Gagal request delete API:', err);
    }

    // 2. Hapus dari FileSystem handle jika aktif
    if (this.dirHandle) {
      try {
        const ownDirHandle = await this.dirHandle.getDirectoryHandle('own', { create: false }).catch(() => null);
        if (ownDirHandle) {
          const classDirHandle = await ownDirHandle.getDirectoryHandle(targetClass, { create: false }).catch(() => null);
          if (classDirHandle) {
            await classDirHandle.removeEntry(filename);
          }
        }
      } catch (err) {
        console.warn(`Gagal menghapus file ${filename} dari directory handle:`, err);
      }
    }

    // 3. Hapus dari recentCaptures
    const idx = this.recentCaptures.findIndex(c => c.filename === filename);
    if (idx !== -1) {
      const item = this.recentCaptures[idx];
      if (item.hash) this.knownHashes.delete(item.hash);
      this.recentCaptures.splice(idx, 1);
    }

    // 4. Hapus dari metadata
    if (this.sourcesMetadata.items[filename]) {
      const itemMeta = this.sourcesMetadata.items[filename];
      if (itemMeta.hash_sha256) this.knownHashes.delete(itemMeta.hash_sha256);
      delete this.sourcesMetadata.items[filename];
      this._saveMetadata();
    }
    this._saveHashes();

    // 5. Update counter
    if (this.classCounts[targetClass] && this.classCounts[targetClass] > 0) {
      this.classCounts[targetClass] -= 1;
      this._saveCounts();
    }

    const currentClassCount = this.getCount(targetClass);
    this._notify('delete', { filename, className: targetClass, count: currentClassCount });
    this._notify('countChange', { currentClass: targetClass, count: currentClassCount });

    return true;
  }

  /**
   * Menghapus beberapa citra sekaligus (Multi-Delete).
   * @param {Array<{ filename: string, className: string }>} items 
   */
  async deleteMultipleImages(items = []) {
    let deletedCount = 0;
    for (const item of items) {
      try {
        await this.deleteImage(item.filename, item.className);
        deletedCount++;
      } catch (e) {
        console.error(`Gagal delete ${item.filename}:`, e);
      }
    }
    return deletedCount;
  }

  /**
   * Mengimpor satu atau beberapa file citra dari PC.
   * @param {FileList|Array<File>} fileList 
   * @param {string} targetClass 
   * @param {string} source 
   */
  async importImages(fileList, targetClass = this.currentClass, source = 'own_import') {
    const validClass = validateClassName(targetClass);
    const files = Array.from(fileList);
    let imported = 0;
    let duplicates = 0;
    let skipped = 0;
    const importedRecords = [];

    for (const file of files) {
      const ext = '.' + file.name.split('.').pop().toLowerCase();
      if (!SUPPORTED_IMPORT_EXTENSIONS.includes(ext)) {
        skipped++;
        continue;
      }

      try {
        const arrayBuffer = await file.arrayBuffer();
        const hash = await computeBufferHash(arrayBuffer);

        if (this.knownHashes.has(hash)) {
          duplicates++;
          continue;
        }

        const blob = new Blob([arrayBuffer], { type: file.type || 'image/jpeg' });
        const cleanExt = ext.replace(/^\./, '');
        const filename = this.generateFilename(validClass, source, cleanExt);

        // Baca dimensi gambar
        let width = 0;
        let height = 0;
        try {
          const imgBitmap = await createImageBitmap(blob);
          width = imgBitmap.width;
          height = imgBitmap.height;
          imgBitmap.close();
        } catch (e) {
          // Fallback image dimensions
        }

        // Konversi ke base64 dataUrl untuk pengiriman ke server
        const reader = new FileReader();
        const dataUrlPromise = new Promise((res, rej) => {
          reader.onload = () => res(reader.result);
          reader.onerror = rej;
          reader.readAsDataURL(blob);
        });
        const dataUrl = await dataUrlPromise;

        // Upload via production backend (multipart/form-data)
        const formData = new FormData();
        formData.append('image', blob, filename);
        formData.append('info', JSON.stringify({
          filename,
          className: validClass,
          source,
          width,
          height
        }));

        const apiRes = await fetch(ENDPOINTS.UPLOAD, {
          method: 'POST',
          body: formData
        });

        const saveRes = (apiRes.ok) ? await apiRes.json() : null;
        const formattedSize = `${(file.size / 1024).toFixed(1)} KB`;

        this.knownHashes.add(hash);
        this.classCounts[validClass] = (this.classCounts[validClass] || 0) + 1;

        this.sourcesMetadata.items[filename] = {
          class: validClass,
          source: source,
          hash_sha256: hash,
          original_name: file.name,
          width: width,
          height: height,
          resolution: (width && height) ? `${width}x${height}` : '-',
          size_bytes: file.size,
          formatted_size: formattedSize,
          recorded_at: new Date().toISOString()
        };

        const record = {
          id: filename,
          filename,
          className: validClass,
          source,
          count: this.classCounts[validClass],
          timestamp: new Date().toLocaleTimeString(),
          previewUrl: dataUrl,
          dataUrl: dataUrl,
          url: (saveRes && saveRes.url) || `/datasets/raw/own/${validClass}/${filename}`,
          hash,
          width,
          height,
          resolution: (width && height) ? `${width}x${height}` : '-',
          sizeBytes: file.size,
          formattedSize: formattedSize,
          storageType: 'disk'
        };

        this.recentCaptures.unshift(record);
        importedRecords.push(record);
        imported++;
      } catch (err) {
        console.error(`Gagal mengimpor file ${file.name}:`, err);
        skipped++;
      }
    }

    this._saveHashes();
    this._saveCounts();
    this._saveMetadata();

    this._notify('import', { imported, duplicates, skipped, targetClass: validClass });
    this._notify('countChange', { currentClass: this.currentClass, count: this.getCount() });

    return { imported, duplicates, skipped, records: importedRecords };
  }

  /**
   * Mengimpor seluruh isi folder gambar.
   */
  async importFolder(fileList, targetClass = this.currentClass, source = 'own_import') {
    return await this.importImages(fileList, targetClass, source);
  }

  /**
   * Mengambil daftar capture
   */
  getRecentCaptures() {
    return this.recentCaptures || [];
  }

  /**
   * Alias untuk deleteImage
   */
  async deleteItem(filename, className = this.currentClass) {
    return await this.deleteImage(filename, className);
  }

  /**
   * Menghapus banyak item berdasarkan daftar nama file
   */
  async deleteMultiple(filenames = []) {
    const items = filenames.map(fn => {
      const meta = this.sourcesMetadata.items ? this.sourcesMetadata.items[fn] : null;
      const rec = this.recentCaptures.find(c => c.filename === fn);
      const cls = (meta && meta.class) ? meta.class : (rec ? rec.className : this.currentClass);
      return { filename: fn, className: cls };
    });
    const deleted = await this.deleteMultipleImages(items);
    return { deleted };
  }

  /**
   * Alias untuk selectDirectory
   */
  async requestDirectoryAccess() {
    return await this.selectDirectory();
  }

  destroy() {
    this.recentCaptures = [];
  }
}
