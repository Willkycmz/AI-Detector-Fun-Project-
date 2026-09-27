/**
 * ObjectMemory.js - VisionX V1.1 Local-First Temporal & Spatial Object Memory
 *
 * Bertanggung jawab melacak dan menyimpan siklus hidup (lifecycle) objek-objek
 * yang terdeteksi dan di-track oleh TrackingEngine selama aplikasi berjalan.
 *
 * Fitur:
 * - Local-first session persistence (localStorage) tanpa ketergantungan cloud.
 * - Pencatatan lifecycle lengkap: trackId, className, firstSeen, lastSeen, confidence,
 *   bbox, titik pusat, zona spasial relatif, kecepatan, dan status.
 * - Event history ter-sampling/throttled: OBJECT_ENTERED, OBJECT_UPDATED, OBJECT_LEFT, OBJECT_RETURNED.
 * - Pemetaan zona spasial relatif ('kiri atas', 'tengah', 'kanan', dsb.).
 * - API pembersihan memori sesi (clear memory).
 * - Proteksi kapasitas maksimum (auto-pruning) agar tidak membebani memori browser.
 */

export const MemoryEventType = {
  OBJECT_ENTERED: 'OBJECT_ENTERED',
  OBJECT_UPDATED: 'OBJECT_UPDATED',
  OBJECT_LEFT: 'OBJECT_LEFT',
  OBJECT_RETURNED: 'OBJECT_RETURNED'
};

export const TrackMemoryState = {
  ACTIVE: 'ACTIVE',
  LOST: 'LOST',
  LEFT: 'LEFT'
};

const DEFAULT_CONFIG = {
  storageKey: 'visionx_object_memory_v1',
  maxEventHistory: 100,         // Maksimal log event tersimpan
  maxKnownObjects: 60,          // Maksimal objek unik tersimpan dalam memori
  updateThrottleMs: 1500,       // Interval minimal pencatatan OBJECT_UPDATED
  leftTimeoutMs: 3000,          // Waktu toleransi track hilang sebelum dinyatakan OBJECT_LEFT
  enableStoragePersistence: true
};

export class ObjectMemory {
  /**
   * @param {Object} [customConfig={}]
   */
  constructor(customConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...customConfig };
    
    // Memory State
    // Map<trackId, ObjectRecord>
    this.knownObjects = new Map();
    // Array<EventRecord>
    this.eventHistory = [];
    
    // Internal cache untuk throttling
    this.lastUpdateTimestamps = new Map();
    this.listeners = new Set();
    this._saveTimeout = null;

    // Muat session memory sebelumnya jika diizinkan
    if (this.config.enableStoragePersistence) {
      this.loadFromStorage();
    }
  }

  /**
   * Daftarkan listener saat ada update memory
   * @param {Function} listener ({ type, event, memoryStats }) => void
   * @returns {Function} Unsubscribe
   */
  onMemoryUpdate(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  _notifyListeners(type, event) {
    const stats = this.getStats();
    for (const listener of this.listeners) {
      try {
        listener({ type, event, stats });
      } catch (err) {
        console.warn('[ObjectMemory] Listener error:', err);
      }
    }
  }

  /**
   * Menentukan zona spasial relatif objek dalam frame kamera
   * @param {Array<number>} bbox [x1, y1, x2, y2]
   * @param {number} [frameWidth=640]
   * @param {number} [frameHeight=480]
   * @returns {string} Contoh: 'kiri', 'tengah', 'kanan atas', 'kanan bawah'
   */
  static getSpatialZone(bbox, frameWidth = 640, frameHeight = 480) {
    if (!bbox || bbox.length < 4 || frameWidth <= 0 || frameHeight <= 0) {
      return 'tengah';
    }

    const [x1, y1, x2, y2] = bbox;
    const cx = (x1 + x2) / 2;
    const cy = (y1 + y2) / 2;

    const normX = cx / frameWidth;
    const normY = cy / frameHeight;

    let hPos = 'tengah';
    if (normX < 0.35) hPos = 'kiri';
    else if (normX > 0.65) hPos = 'kanan';

    let vPos = 'tengah';
    if (normY < 0.35) vPos = 'atas';
    else if (normY > 0.65) vPos = 'bawah';

    if (hPos === 'tengah' && vPos === 'tengah') {
      return 'tengah';
    }
    if (vPos === 'tengah') return hPos;
    if (hPos === 'tengah') return vPos;
    return `${hPos} ${vPos}`.trim();
  }

  /**
   * Update memory berdasarkan snapshot tracks aktif dari TrackingEngine
   * @param {Array<Object>} activeTracks Array visible/active tracks dari TrackingEngine
   * @param {Object} [frameMeta={}] { frameWidth, frameHeight, timestamp }
   */
  update(activeTracks = [], frameMeta = {}) {
    const now = Date.now();
    const frameW = frameMeta.frameWidth || 640;
    const frameH = frameMeta.frameHeight || 480;
    const safeTracks = Array.isArray(activeTracks) ? activeTracks : [];

    const currentTrackIds = new Set();

    // 1. Proses setiap active track yang terlihat
    for (const track of safeTracks) {
      const trackId = track.trackId;
      if (trackId === undefined || trackId === null) continue;
      currentTrackIds.add(trackId);

      const className = track.className || 'object';
      const bbox = Array.isArray(track.bbox) ? track.bbox : [0, 0, 0, 0];
      const zone = ObjectMemory.getSpatialZone(bbox, frameW, frameH);
      const cx = Math.round((bbox[0] + bbox[2]) / 2);
      const cy = Math.round((bbox[1] + bbox[3]) / 2);
      const confidence = typeof track.confidence === 'number' ? Math.round(track.confidence * 100) / 100 : 0.8;
      const vx = track.velocity?.vx || 0;
      const vy = track.velocity?.vy || 0;
      const personalizedName = track.personalizedName || null;
      const identityStatus = track.identityStatus || 'GENERIC';
      const matchConfidence = typeof track.matchConfidence === 'number' ? track.matchConfidence : null;
      const personalObjectId = track.personalObjectId || null;

      let record = this.knownObjects.get(trackId);

      if (!record) {
        // Objek baru masuk pertama kali (OBJECT_ENTERED)
        record = {
          trackId,
          className,
          personalizedName,
          identityStatus,
          matchConfidence,
          personalObjectId,
          firstSeen: now,
          lastSeen: now,
          firstSeenIso: new Date(now).toISOString(),
          lastSeenIso: new Date(now).toISOString(),
          confidence,
          lastBbox: bbox,
          lastCenter: { x: cx, y: cy },
          lastSpatialPosition: zone,
          velocity: { vx, vy, speed: Math.round(Math.hypot(vx, vy) * 100) / 100 },
          state: TrackMemoryState.ACTIVE,
          seenCount: 1
        };

        this.knownObjects.set(trackId, record);
        this.lastUpdateTimestamps.set(trackId, now);

        const displayName = personalizedName ? `${personalizedName} (#${trackId})` : `${className} #${trackId}`;
        this._recordEvent({
          type: MemoryEventType.OBJECT_ENTERED,
          trackId,
          className,
          personalizedName,
          identityStatus,
          zone,
          timestamp: now,
          description: `${displayName} masuk di area ${zone}`
        });
      } else {
        // Objek sudah pernah dikenal
        const previousState = record.state;
        const lastZone = record.lastSpatialPosition;
        record.lastSeen = now;
        record.lastSeenIso = new Date(now).toISOString();
        record.lastBbox = bbox;
        record.lastCenter = { x: cx, y: cy };
        record.lastSpatialPosition = zone;
        record.velocity = { vx, vy, speed: Math.round(Math.hypot(vx, vy) * 100) / 100 };
        record.confidence = confidence;
        record.seenCount = (record.seenCount || 0) + 1;

        if (personalizedName) record.personalizedName = personalizedName;
        if (identityStatus) record.identityStatus = identityStatus;
        if (matchConfidence !== null) record.matchConfidence = matchConfidence;
        if (personalObjectId) record.personalObjectId = personalObjectId;

        const displayName = record.personalizedName ? `${record.personalizedName} (#${trackId})` : `${className} #${trackId}`;

        // Cek apakah objek baru saja kembali setelah sempat hilang (OBJECT_RETURNED)
        if (previousState === TrackMemoryState.LOST || previousState === TrackMemoryState.LEFT) {
          record.state = TrackMemoryState.ACTIVE;
          this._recordEvent({
            type: MemoryEventType.OBJECT_RETURNED,
            trackId,
            className,
            personalizedName: record.personalizedName,
            identityStatus: record.identityStatus,
            zone,
            timestamp: now,
            description: `${displayName} kembali terlihat di area ${zone}`
          });
          this.lastUpdateTimestamps.set(trackId, now);
        } else {
          record.state = TrackMemoryState.ACTIVE;

          // Throttled OBJECT_UPDATED: catat hanya jika zona spasial berubah atau cooldown terlewati
          const lastUpdate = this.lastUpdateTimestamps.get(trackId) || 0;
          const zoneChanged = (lastZone !== zone);

          if (zoneChanged || (now - lastUpdate >= this.config.updateThrottleMs)) {
            this.lastUpdateTimestamps.set(trackId, now);
            this._recordEvent({
              type: MemoryEventType.OBJECT_UPDATED,
              trackId,
              className,
              personalizedName: record.personalizedName,
              identityStatus: record.identityStatus,
              zone,
              timestamp: now,
              description: zoneChanged 
                ? `${displayName} berpindah ke area ${zone}`
                : `${displayName} aktif di area ${zone}`
            });
          }
        }
      }
    }

    // 2. Deteksi objek yang tidak lagi terlihat (OBJECT_LEFT)
    for (const [trackId, record] of this.knownObjects.entries()) {
      if (!currentTrackIds.has(trackId) && record.state === TrackMemoryState.ACTIVE) {
        const timeSinceLastSeen = now - record.lastSeen;
        if (timeSinceLastSeen >= this.config.leftTimeoutMs) {
          record.state = TrackMemoryState.LEFT;
          this._recordEvent({
            type: MemoryEventType.OBJECT_LEFT,
            trackId,
            className: record.className,
            zone: record.lastSpatialPosition,
            timestamp: now,
            description: `${record.className} #${trackId} tidak lagi terlihat (terakhir di area ${record.lastSpatialPosition})`
          });
        }
      }
    }

    // 3. Batasi memori & jadwalkan penyimpanan debounced
    this._pruneMemory();
    this._scheduleSave();
  }

  /**
   * Catat event ke log histori
   * @private
   */
  _recordEvent(eventData) {
    const event = {
      id: `evt_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      timeString: new Date(eventData.timestamp).toLocaleTimeString(),
      ...eventData
    };

    this.eventHistory.unshift(event);
    if (this.eventHistory.length > this.config.maxEventHistory) {
      this.eventHistory.pop();
    }

    this._notifyListeners(event.type, event);
  }

  /**
   * Pangkas memori lama jika melebihi batas kapasitas
   * @private
   */
  _pruneMemory() {
    if (this.knownObjects.size > this.config.maxKnownObjects) {
      // Urutkan berdasarkan lastSeen terlama
      const entries = Array.from(this.knownObjects.entries())
        .sort((a, b) => a[1].lastSeen - b[1].lastSeen);
      
      const toRemoveCount = this.knownObjects.size - this.config.maxKnownObjects;
      for (let i = 0; i < toRemoveCount; i++) {
        this.knownObjects.delete(entries[i][0]);
        this.lastUpdateTimestamps.delete(entries[i][0]);
      }
    }
  }

  /**
   * Jadwalkan auto-save ke localStorage dengan debounce 500ms
   * @private
   */
  _scheduleSave() {
    if (!this.config.enableStoragePersistence || typeof window === 'undefined' || !window.localStorage) {
      return;
    }
    if (this._saveTimeout) clearTimeout(this._saveTimeout);
    this._saveTimeout = setTimeout(() => {
      this.saveToStorage();
    }, 500);
  }

  /**
   * Mengambil storage provider yang tersedia
   * @private
   */
  _getStorage() {
    if (this.config.storage) return this.config.storage;
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
    if (typeof globalThis !== 'undefined' && globalThis.localStorage) return globalThis.localStorage;
    return null;
  }

  /**
   * Simpan session memory ke localStorage
   */
  saveToStorage() {
    const storage = this._getStorage();
    if (!storage) return;
    try {
      const payload = {
        version: '1.1',
        savedAt: Date.now(),
        knownObjects: Array.from(this.knownObjects.entries()),
        eventHistory: this.eventHistory.slice(0, 50)
      };
      storage.setItem(this.config.storageKey, JSON.stringify(payload));
    } catch (err) {
      console.warn('[ObjectMemory] Gagal menyimpan ke localStorage:', err);
    }
  }

  /**
   * Muat session memory dari localStorage
   */
  loadFromStorage() {
    const storage = this._getStorage();
    if (!storage) return false;
    try {
      const raw = storage.getItem(this.config.storageKey);
      if (!raw) return false;

      const payload = JSON.parse(raw);
      if (Array.isArray(payload.knownObjects)) {
        this.knownObjects = new Map(payload.knownObjects);
      }
      if (Array.isArray(payload.eventHistory)) {
        this.eventHistory = payload.eventHistory;
      }
      return true;
    } catch (err) {
      console.warn('[ObjectMemory] Gagal memuat dari localStorage:', err);
      return false;
    }
  }

  /**
   * Hapus seluruh memori sesi (bersihkan state & localStorage)
   */
  clear() {
    this.knownObjects.clear();
    this.eventHistory = [];
    this.lastUpdateTimestamps.clear();

    const storage = this._getStorage();
    if (storage) {
      try {
        storage.removeItem(this.config.storageKey);
      } catch (e) {}
    }

    this._notifyListeners('MEMORY_CLEARED', { description: 'Memori sesi dikosongkan.' });
  }

  /**
   * Ambil daftar objek yang sedang aktif terlihat saat ini
   * @returns {Array<Object>}
   */
  getActiveObjects() {
    return Array.from(this.knownObjects.values())
      .filter(o => o.state === TrackMemoryState.ACTIVE);
  }

  /**
   * Ambil seluruh objek yang tersimpan dalam histori memori
   * @returns {Array<Object>}
   */
  getAllObjects() {
    return Array.from(this.knownObjects.values());
  }

  /**
   * Ambil objek berdasarkan kelas tertentu
   * @param {string} className
   * @returns {Array<Object>}
   */
  getObjectsByClass(className) {
    const qClass = String(className || '').toLowerCase().trim();
    return Array.from(this.knownObjects.values())
      .filter(o => o.className.toLowerCase() === qClass);
  }

  /**
   * Ambil seluruh objek personal terkonfirmasi dalam memori
   * @returns {Array<Object>}
   */
  getPersonalizedObjects() {
    return Array.from(this.knownObjects.values())
      .filter(o => o.identityStatus === 'PERSONALIZED' || Boolean(o.personalizedName));
  }

  /**
   * Ambil objek personal terakhir terlihat berdasarkan nama atau kelas
   * @param {string} personalNameOrClass
   * @returns {Object|null}
   */
  getLastSeenPersonalObject(personalNameOrClass) {
    const q = String(personalNameOrClass || '').toLowerCase().trim();
    const matching = Array.from(this.knownObjects.values())
      .filter(o => {
        const pName = String(o.personalizedName || '').toLowerCase();
        const cName = String(o.className || '').toLowerCase();
        return pName.includes(q) || q.includes(pName) || cName === q;
      })
      .sort((a, b) => b.lastSeen - a.lastSeen);
    return matching.length > 0 ? matching[0] : null;
  }

  /**
   * Ambil objek terakhir yang terlihat untuk suatu kelas
   * @param {string} className
   * @returns {Object|null}
   */
  getLastSeenObject(className) {
    const matching = this.getObjectsByClass(className)
      .sort((a, b) => b.lastSeen - a.lastSeen);
    return matching.length > 0 ? matching[0] : null;
  }

  /**
   * Ambil log event terbaru
   * @param {number} [limit=10]
   * @returns {Array<Object>}
   */
  getRecentEvents(limit = 10) {
    return this.eventHistory.slice(0, limit);
  }

  /**
   * Ambil statistik ringkas memori
   */
  getStats() {
    const all = Array.from(this.knownObjects.values());
    const active = all.filter(o => o.state === TrackMemoryState.ACTIVE);
    const left = all.filter(o => o.state === TrackMemoryState.LEFT);

    const classCounts = {};
    for (const o of all) {
      classCounts[o.className] = (classCounts[o.className] || 0) + 1;
    }

    return {
      totalRecords: all.length,
      activeCount: active.length,
      leftCount: left.length,
      totalEvents: this.eventHistory.length,
      lastEventTime: this.eventHistory.length > 0 ? this.eventHistory[0].timeString : '--:--:--',
      classCounts
    };
  }
}
