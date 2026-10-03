/**
 * PersonalObjectRegistry.js - VisionX V1.2 Local-First Personal Object Registry
 *
 * Mengelola penyimpanan lokal data objek personal milik user:
 * - CRUD registered objects (Nama unik, Base YOLO class, Gambar referensi, Metadata visual embedding)
 * - Local-first persistence via localStorage (tanpa cloud upload / zero-backend)
 * - Toggle enable/disable per objek
 * - Konfigurasi threshold pencocokan visual similarity
 */

export const DEFAULT_PERSONAL_OBJECT_CONFIG = {
  storageKey: 'visionx_personal_objects_v1',
  defaultThreshold: 0.75,
  minReferences: 1,
  maxReferencesPerObject: 10,
  maxObjects: 50
};

export class PersonalObjectRegistry {
  /**
   * @param {Object} [config={}]
   * @param {string} [config.userId='guest'] User ID / namespace unik akun
   */
  constructor(config = {}) {
    this.config = { ...DEFAULT_PERSONAL_OBJECT_CONFIG, ...config };
    this.userId = config.userId || 'guest';
    this.objects = new Map(); // id -> PersonalObjectRecord
    this.listeners = new Set();

    this.loadFromStorage();
  }

  /**
   * Mendapatkan storage key terisolasi per akun user
   * @returns {string}
   */
  getStorageKey() {
    // Jika config.storageKey di-override secara eksplisit oleh tes atau caller luar
    if (this.config.storageKey && this.config.storageKey !== DEFAULT_PERSONAL_OBJECT_CONFIG.storageKey) {
      return this.config.storageKey;
    }
    const uid = this.userId || 'guest';
    return `visionx_personal_objects_${uid}`;
  }

  /**
   * Mengganti namespace user aktif secara dinamis (misal saat login / logout / switch account)
   * Menyimpan objek user sebelumnya dan memuat database user baru tanpa tabrakan.
   * @param {string|null} userId
   */
  setUserId(userId) {
    const cleanId = (userId && typeof userId === 'string') ? userId.trim() : 'guest';
    if (this.userId === cleanId) return;

    // Simpan objek user saat ini sebelum berpindah
    this.saveToStorage();

    this.userId = cleanId;
    this.loadFromStorage();
    this._notifyListeners('USER_CHANGED', { userId: this.userId });
  }

  /**
   * Mengambil namespace user ID saat ini
   * @returns {string}
   */
  getUserId() {
    return this.userId || 'guest';
  }

  /**
   * Safe storage provider accessor (Browser window.localStorage atau injected mock storage)
   * @private
   */
  _getStorage() {
    if (this.config.storage) return this.config.storage;
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
    if (typeof globalThis !== 'undefined' && globalThis.localStorage) return globalThis.localStorage;
    return null;
  }

  /**
   * Daftarkan listener event update registry
   * @param {Function} callback
   */
  onRegistryUpdate(callback) {
    if (typeof callback === 'function') {
      this.listeners.add(callback);
    }
    return () => this.listeners.delete(callback);
  }

  _notifyListeners(action, data = null) {
    for (const listener of this.listeners) {
      try {
        listener({ action, data, totalCount: this.objects.size });
      } catch (err) {
        console.warn('[PersonalObjectRegistry] Listener error:', err);
      }
    }
  }

  /**
   * Ambil seluruh objek personal yang terdaftar
   * @param {string|null} [baseClass=null] Filter opsional berdasarkan base YOLO class
   * @returns {Array<Object>}
   */
  getAll(baseClass = null) {
    const list = Array.from(this.objects.values());
    if (!baseClass) return list;
    const qClass = String(baseClass).toLowerCase().trim();
    return list.filter(o => o.baseClass.toLowerCase() === qClass);
  }

  /**
   * Ambil objek yang aktif / enabled saja
   * @param {string|null} [baseClass=null]
   * @returns {Array<Object>}
   */
  getEnabled(baseClass = null) {
    return this.getAll(baseClass).filter(o => o.enabled);
  }

  /**
   * Ambil objek berdasarkan ID
   * @param {string} id
   * @returns {Object|null}
   */
  getById(id) {
    return this.objects.get(id) || null;
  }

  /**
   * Cari objek berdasarkan nama (case-insensitive)
   * @param {string} name
   * @returns {Object|null}
   */
  findByName(name) {
    const qName = String(name || '').toLowerCase().trim();
    for (const obj of this.objects.values()) {
      if (obj.name.toLowerCase() === qName) {
        return obj;
      }
    }
    return null;
  }

  /**
   * Mendaftarkan objek personal baru
   * @param {Object} payload
   * @param {string} payload.name Nama personal objek (e.g. "My Laptop", "Mouse Merah")
   * @param {string} payload.baseClass Kelas dasar YOLO (e.g. "laptop", "mouse", "bottle")
   * @param {Array<Object>} [payload.references=[]] Array gambar referensi dengan embedding
   * @param {number} [payload.threshold] Threshold kemiripan khusus objek
   * @param {boolean} [payload.enabled=true]
   * @returns {Object} Objek yang baru didaftarkan
   */
  register({
    id = null,
    name,
    baseClass,
    references = [],
    threshold = null,
    enabled = true
  }) {
    const cleanName = String(name || '').trim();
    if (!cleanName) {
      throw new Error('Nama objek personal tidak boleh kosong.');
    }

    const cleanBaseClass = String(baseClass || '').toLowerCase().trim();
    if (!cleanBaseClass) {
      throw new Error('Base class YOLO harus ditentukan.');
    }

    // Cegah duplikasi nama yang persis sama
    const existing = this.findByName(cleanName);
    if (existing && existing.id !== id) {
      throw new Error(`Objek dengan nama "${cleanName}" sudah terdaftar.`);
    }

    const objectId = id || `po_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const now = Date.now();

    const record = {
      id: objectId,
      name: cleanName,
      baseClass: cleanBaseClass,
      references: Array.isArray(references) ? references : [],
      threshold: typeof threshold === 'number' ? threshold : this.config.defaultThreshold,
      enabled: enabled !== false,
      createdAt: now,
      updatedAt: now,
      embeddingMetadata: {
        dimensions: 128,
        method: 'spatial_color_gradient_v1',
        referenceCount: references.length
      }
    };

    this.objects.set(objectId, record);
    this.saveToStorage();
    this._notifyListeners('REGISTER', record);

    return record;
  }

  /**
   * Update data objek personal
   * @param {string} id
   * @param {Object} partialUpdates
   * @returns {Object}
   */
  update(id, partialUpdates = {}) {
    const record = this.objects.get(id);
    if (!record) {
      throw new Error(`Objek personal #${id} tidak ditemukan.`);
    }

    if (partialUpdates.name !== undefined) {
      const cleanName = String(partialUpdates.name).trim();
      if (!cleanName) throw new Error('Nama objek tidak boleh kosong.');
      const dup = this.findByName(cleanName);
      if (dup && dup.id !== id) {
        throw new Error(`Objek dengan nama "${cleanName}" sudah terdaftar.`);
      }
      record.name = cleanName;
    }

    if (partialUpdates.baseClass !== undefined) {
      record.baseClass = String(partialUpdates.baseClass).toLowerCase().trim();
    }

    if (typeof partialUpdates.threshold === 'number') {
      record.threshold = Math.max(0.1, Math.min(1.0, partialUpdates.threshold));
    }

    if (typeof partialUpdates.enabled === 'boolean') {
      record.enabled = partialUpdates.enabled;
    }

    if (Array.isArray(partialUpdates.references)) {
      record.references = partialUpdates.references;
      record.embeddingMetadata.referenceCount = record.references.length;
    }

    record.updatedAt = Date.now();
    this.saveToStorage();
    this._notifyListeners('UPDATE', record);

    return record;
  }

  /**
   * Hapus objek personal
   * @param {string} id
   * @returns {boolean}
   */
  delete(id) {
    if (!this.objects.has(id)) return false;
    const removed = this.objects.get(id);
    this.objects.delete(id);
    this.saveToStorage();
    this._notifyListeners('DELETE', removed);
    return true;
  }

  /**
   * Set status aktif / non-aktif
   * @param {string} id
   * @param {boolean} enabled
   */
  setEnabled(id, enabled) {
    return this.update(id, { enabled: Boolean(enabled) });
  }

  /**
   * Tambah referensi visual baru ke objek yang sudah terdaftar
   * @param {string} id
   * @param {Object} reference { angle, dataUrl, embedding }
   */
  addReference(id, reference) {
    const record = this.objects.get(id);
    if (!record) throw new Error(`Objek personal #${id} tidak ditemukan.`);

    if (record.references.length >= this.config.maxReferencesPerObject) {
      throw new Error(`Maksimum ${this.config.maxReferencesPerObject} gambar referensi per objek.`);
    }

    const refId = reference.id || `ref_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const newRef = {
      id: refId,
      angle: reference.angle || 'default',
      dataUrl: reference.dataUrl || null,
      embedding: Array.isArray(reference.embedding) ? reference.embedding : [],
      createdAt: Date.now()
    };

    record.references.push(newRef);
    record.embeddingMetadata.referenceCount = record.references.length;
    record.updatedAt = Date.now();

    this.saveToStorage();
    this._notifyListeners('REFERENCE_ADDED', { objectId: id, reference: newRef });

    return newRef;
  }

  /**
   * Hapus gambar referensi berdasarkan refId
   * @param {string} id
   * @param {string} refId
   * @returns {boolean}
   */
  removeReference(id, refId) {
    const record = this.objects.get(id);
    if (!record) return false;

    const initialLen = record.references.length;
    record.references = record.references.filter(r => r.id !== refId);
    if (record.references.length === initialLen) return false;

    record.embeddingMetadata.referenceCount = record.references.length;
    record.updatedAt = Date.now();

    this.saveToStorage();
    this._notifyListeners('REFERENCE_REMOVED', { objectId: id, refId });

    return true;
  }

  /**
   * Simpan data ke localStorage terisolasi per akun user
   */
  saveToStorage() {
    const storage = this._getStorage();
    if (!storage) return;

    try {
      const payload = {
        version: '2.0',
        userId: this.userId || 'guest',
        updatedAt: Date.now(),
        objects: Array.from(this.objects.values())
      };
      storage.setItem(this.getStorageKey(), JSON.stringify(payload));
    } catch (err) {
      console.warn('[PersonalObjectRegistry] Gagal menyimpan ke storage:', err);
    }
  }

  /**
   * Muat data dari localStorage terisolasi per akun user
   * Jika user belum punya data baru, cek dan migrasikan data legacy jika tersedia.
   */
  loadFromStorage() {
    const storage = this._getStorage();
    if (!storage) return false;

    const key = this.getStorageKey();
    try {
      let raw = storage.getItem(key);

      // Auto-migration: Jika key user belum ada data, cek key legacy global
      if (!raw && key !== DEFAULT_PERSONAL_OBJECT_CONFIG.storageKey) {
        const legacyRaw = storage.getItem(DEFAULT_PERSONAL_OBJECT_CONFIG.storageKey);
        if (legacyRaw) {
          raw = legacyRaw;
          // Salin ke database akun user saat ini
          try {
            storage.setItem(key, legacyRaw);
          } catch (e) {}
        }
      }

      if (!raw) {
        this.objects.clear();
        return false;
      }

      const payload = JSON.parse(raw);
      if (Array.isArray(payload.objects)) {
        this.objects.clear();
        for (const obj of payload.objects) {
          if (obj && obj.id && obj.name && obj.baseClass) {
            this.objects.set(obj.id, obj);
          }
        }
        return true;
      }
    } catch (err) {
      console.warn('[PersonalObjectRegistry] Gagal memuat dari storage:', err);
    }
    return false;
  }

  /**
   * Kosongkan seluruh registry lokal akun saat ini
   */
  clear() {
    this.objects.clear();
    const storage = this._getStorage();
    if (storage) {
      try {
        storage.removeItem(this.getStorageKey());
      } catch (e) {}
    }
    this._notifyListeners('CLEAR');
  }

  /**
   * Statistik registry untuk telemetry & UI
   */
  getStats() {
    let enabledCount = 0;
    let totalRefs = 0;
    const perBaseClass = {};

    for (const obj of this.objects.values()) {
      if (obj.enabled) enabledCount++;
      const refs = obj.references?.length || 0;
      totalRefs += refs;
      perBaseClass[obj.baseClass] = (perBaseClass[obj.baseClass] || 0) + 1;
    }

    return {
      totalObjects: this.objects.size,
      enabledObjects: enabledCount,
      totalReferences: totalRefs,
      perBaseClass
    };
  }
}
