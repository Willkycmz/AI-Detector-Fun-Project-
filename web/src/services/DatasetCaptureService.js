/**
 * DatasetCaptureService.js - Service Pengambilan & Pengelolaan Dataset (V0.4.1)
 * Mengelola validasi nama kelas, penamaan file unik, penangkapan frame asli tanpa HUD/bounding box,
 * penghapusan tunggal & multi-delete, impor citra & folder, pencegahan duplikasi (SHA-256),
 * struktur direktori berjenjang (own/external), serta pelacakan metadata sumber.
 */

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
  // Ganti spasi atau tab berurutan dengan underscore
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
    this.currentClass = 'object';
    this.currentSource = 'own_capture'; // Default source
    this.dirHandle = null; // FileSystemDirectoryHandle (jika user memilih folder via File System Access API)
    this.dirName = null;
    this.recentCaptures = []; // Thumbnail & metadata capture sesi aktif
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

  /**
   * Mendaftarkan event listener.
   */
  on(event, callback) {
    if (this.listeners[event]) {
      this.listeners[event].push(callback);
    }
  }

  _notify(event, data) {
    if (this.listeners[event]) {
      this.listeners[event].forEach(cb => cb(data));
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
   * Mengatur nama kelas aktif dengan validasi.
   * @param {string} className 
   * @returns {string} Sanitized class name
   */
  setClass(className) {
    const sanitized = validateClassName(className);
    this.currentClass = sanitized;
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
   * Mendapatkan jumlah gambar yang telah diambil untuk kelas aktif.
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
      throw new Error('File System Access API tidak didukung pada browser ini. Gambar akan disimpan via unduhan browser.');
    }

    try {
      this.dirHandle = await window.showDirectoryPicker({
        mode: 'readwrite',
        startIn: 'documents'
      });
      this.dirName = this.dirHandle.name;
      this._notify('directoryChange', { dirName: this.dirName, isSupported: true });
      return this.dirName;
    } catch (err) {
      if (err.name === 'AbortError') {
        return null; // Pengguna membatalkan pemilihan folder
      }
      throw err;
    }
  }

  /**
   * Generate nama file unik sesuai standar VisionX V0.4.1.
   * Format: <class_name>_<source_tag>_YYYYMMDD_HHMMSS_<short_uuid>.<ext>
   * @param {string} className 
   * @param {string} source 
   * @param {string} ext 
   * @returns {string}
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
   * Menangkap frame asli (clean raw frame) dari video element.
   * 
   * @param {HTMLVideoElement} videoElement Elemen video sumber stream
   * @returns {Promise<{ filename: string, className: string, count: number, blob: Blob, previewUrl: string, hash: string, storageType: string }>}
   */
  async captureFrame(videoElement) {
    if (!videoElement || videoElement.readyState < 2) {
      throw new Error('Video stream kamera belum siap untuk diambil.');
    }

    const vw = videoElement.videoWidth;
    const vh = videoElement.videoHeight;

    if (vw === 0 || vh === 0) {
      throw new Error('Resolusi frame video tidak valid (0x0).');
    }

    // 1. Gambar frame video murni ke offscreen canvas pada resolusi aslinya
    this.offscreenCanvas.width = vw;
    this.offscreenCanvas.height = vh;
    this.offscreenCtx.drawImage(videoElement, 0, 0, vw, vh);

    // 2. Konversi ke Blob JPEG berkualitas tinggi (0.95)
    const blob = await new Promise((resolve, reject) => {
      this.offscreenCanvas.toBlob(
        (b) => {
          if (b) resolve(b);
          else reject(new Error('Gagal mengonversi frame ke Blob format JPEG.'));
        },
        'image/jpeg',
        0.95
      );
    });

    // 3. Hitung SHA-256 Hash untuk pencegahan duplikasi
    const arrayBuffer = await blob.arrayBuffer();
    const imageHash = await computeBufferHash(arrayBuffer);

    if (this.knownHashes.has(imageHash)) {
      throw new Error(`Citra identik/duplikat terdeteksi (SHA256: ${imageHash.slice(0, 10)}...). Pengambilan dibatalkan.`);
    }

    const filename = this.generateFilename(this.currentClass, 'own_capture', 'jpg');
    let storageType = 'download';

    // 4. Simpan gambar ke folder tujuan berjenjang: own/<class_name>/
    if (this.dirHandle) {
      try {
        const ownDirHandle = await this.dirHandle.getDirectoryHandle('own', { create: true });
        const classDirHandle = await ownDirHandle.getDirectoryHandle(this.currentClass, { create: true });
        const fileHandle = await classDirHandle.getFileHandle(filename, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(blob);
        await writable.close();
        storageType = 'direct_fs';
      } catch (fsErr) {
        console.warn('Gagal menyimpan via File System Access API, fallback ke unduhan browser:', fsErr);
        this._triggerDownload(blob, filename);
        storageType = 'download_fallback';
      }
    } else {
      this._triggerDownload(blob, filename);
      storageType = 'download';
    }

    // 5. Catat hash & update count
    this.knownHashes.add(imageHash);
    this._saveHashes();

    this.classCounts[this.currentClass] = (this.classCounts[this.currentClass] || 0) + 1;
    const newCount = this.classCounts[this.currentClass];
    this._saveCounts();

    // 6. Catat metadata sumber
    this.sourcesMetadata.items[filename] = {
      class: this.currentClass,
      source: 'own_capture',
      hash_sha256: imageHash,
      resolution: `${vw}x${vh}`,
      size_bytes: blob.size,
      recorded_at: new Date().toISOString()
    };
    this._saveMetadata();

    // 7. Simpan thumbnail preview
    const previewUrl = URL.createObjectURL(blob);
    const captureRecord = {
      id: filename,
      filename,
      className: this.currentClass,
      source: 'own_capture',
      count: newCount,
      timestamp: new Date().toLocaleTimeString(),
      previewUrl,
      hash: imageHash,
      resolution: `${vw}x${vh}`,
      sizeBytes: blob.size,
      storageType
    };

    this.recentCaptures.unshift(captureRecord);
    if (this.recentCaptures.length > 50) {
      const removed = this.recentCaptures.pop();
      if (removed && removed.previewUrl) {
        URL.revokeObjectURL(removed.previewUrl);
      }
    }

    this._notify('capture', captureRecord);
    this._notify('countChange', { currentClass: this.currentClass, count: newCount });

    return captureRecord;
  }

  /**
   * Menghapus satu citra dari dataset dan membebaskan counter.
   * @param {string} filename 
   * @param {string} [className] 
   */
  async deleteImage(filename, className = this.currentClass) {
    const targetClass = className || this.currentClass;

    // 1. Hapus dari FileSystem jika ada dirHandle
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
        console.warn(`Gagal menghapus file ${filename} dari disk:`, err);
      }
    }

    // 2. Hapus dari recentCaptures
    const idx = this.recentCaptures.findIndex(c => c.filename === filename);
    if (idx !== -1) {
      const item = this.recentCaptures[idx];
      if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      if (item.hash) this.knownHashes.delete(item.hash);
      this.recentCaptures.splice(idx, 1);
    }

    // 3. Hapus dari metadata
    if (this.sourcesMetadata.items[filename]) {
      const itemMeta = this.sourcesMetadata.items[filename];
      if (itemMeta.hash_sha256) this.knownHashes.delete(itemMeta.hash_sha256);
      delete this.sourcesMetadata.items[filename];
      this._saveMetadata();
    }
    this._saveHashes();

    // 4. Update counter (kurang 1 jika > 0)
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

        let storageType = 'download';
        if (this.dirHandle) {
          try {
            const folderCategory = source.startsWith('own') ? 'own' : `external/${source}`;
            const subFolders = folderCategory.split('/');
            let currentFolderHandle = this.dirHandle;
            for (const sf of subFolders) {
              currentFolderHandle = await currentFolderHandle.getDirectoryHandle(sf, { create: true });
            }
            const classDirHandle = await currentFolderHandle.getDirectoryHandle(validClass, { create: true });
            const fileHandle = await classDirHandle.getFileHandle(filename, { create: true });
            const writable = await fileHandle.createWritable();
            await writable.write(blob);
            await writable.close();
            storageType = 'direct_fs';
          } catch (e) {
            this._triggerDownload(blob, filename);
            storageType = 'download_fallback';
          }
        } else {
          this._triggerDownload(blob, filename);
          storageType = 'download';
        }

        this.knownHashes.add(hash);
        this.classCounts[validClass] = (this.classCounts[validClass] || 0) + 1;

        this.sourcesMetadata.items[filename] = {
          class: validClass,
          source: source,
          hash_sha256: hash,
          original_name: file.name,
          size_bytes: file.size,
          recorded_at: new Date().toISOString()
        };

        const previewUrl = URL.createObjectURL(blob);
        const record = {
          id: filename,
          filename,
          className: validClass,
          source,
          count: this.classCounts[validClass],
          timestamp: new Date().toLocaleTimeString(),
          previewUrl,
          hash,
          sizeBytes: file.size,
          storageType
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
   * @param {FileList|Array<File>} fileList 
   * @param {string} targetClass 
   * @param {string} source 
   */
  async importFolder(fileList, targetClass = this.currentClass, source = 'own_import') {
    return await this.importImages(fileList, targetClass, source);
  }

  /**
   * Memicu download browser standar.
   */
  _triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  destroy() {
    this.recentCaptures.forEach(c => {
      if (c.previewUrl) URL.revokeObjectURL(c.previewUrl);
    });
    this.recentCaptures = [];
  }
}
