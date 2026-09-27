/**
 * SceneHistoryEngine.js - VisionX V1.6 Phase C Deterministic Temporal Scene Comparison Engine
 *
 * Mengelola riwayat ringkas pemandangan (Scene Snapshots) dalam jendela waktu melingkar (Circular Buffer 60 detik)
 * untuk mendeteksi dan menjelaskan perubahan pemandangan dari waktu ke waktu secara deterministik (ZERO HALLUCINATION).
 *
 * Fitur Utama:
 * 1. Penyimpanan snapshot ringan (Lightweight normalized state, TANPA menyimpan citra kamera mentah).
 * 2. Bounded circular buffer: Maksimal 60 snapshot (~1 Hz) dengan batas usia maksimum 60 detik.
 * 3. computeDelta(windowSeconds = 15): Membandingkan pemandangan saat ini (T_now) dengan pemandangan di masa lalu (T_past).
 * 4. Deteksi perubahan deterministik:
 *    - Objek baru muncul (Appeared)
 *    - Objek hilang / diambil (Disappeared)
 *    - Objek bergeser signifikan (Moved, pergeseran koordinat normalisasi >= 0.12)
 *    - Perubahan teks OCR (teks baru, teks hilang, atau teks berganti)
 *    - Perubahan status keselamatan (Tingkat risiko bertambah/berkurang, alert aktif baru)
 * 5. Narasi spasio-temporal komprehensif dalam Bahasa Indonesia.
 *
 * PENTING:
 * - Menggunakan koordinat ternormalisasi [0..1], bukan pixel absolut.
 * - Track ID diperlakukan sebagai tracking sesi, bukan klaim identitas permanen dunia nyata.
 * - Berjalan di luar render loop processFrame() pada interval ~1 Hz tanpa memblokir rendering.
 */

export const DEFAULT_TEMPORAL_CONFIG = {
  maxSnapshots: 60,              // Maksimal 60 entri riwayat
  maxHistoryWindowMs: 60000,     // 60 detik
  movementThresholdNorm: 0.12,   // Ambang pergeseran signifikan (12% dimensi kanvas)
  proximityMatchThreshold: 0.25  // Ambang pencocokan spasial objek sejenis tanpa Track ID
};

export class SceneHistoryEngine {
  /**
   * @param {Object} [config={}]
   */
  constructor(config = {}) {
    this.config = { ...DEFAULT_TEMPORAL_CONFIG, ...config };
    this.snapshots = []; // Disimpan urut kronologis: indeks 0 paling lama, indeks terakhir paling baru
  }

  /**
   * Mengosongkan seluruh riwayat snapshot
   */
  clear() {
    this.snapshots = [];
  }

  /**
   * Merekam satu snapshot pemandangan ke dalam buffer riwayat
   * @param {Object} snapshot
   * @param {number} [snapshot.timestamp=Date.now()]
   * @param {Array<Object>} [snapshot.objects=[]] List objek ternormalisasi
   * @param {string} [snapshot.ocrText=''] Teks OCR saat ini
   * @param {string} [snapshot.safetyRisk='LOW'] Tingkat risiko keselamatan
   * @param {number} [snapshot.activeAlertsCount=0]
   * @param {Array<string>} [snapshot.activeAlertTitles=[]]
   * @returns {Object} Snapshot yang berhasil direkam
   */
  record(snapshot = {}) {
    const now = typeof snapshot.timestamp === 'number' ? snapshot.timestamp : Date.now();

    const normalizedSnapshot = {
      timestamp: now,
      objects: Array.isArray(snapshot.objects) ? snapshot.objects.map(o => {
        const cx = typeof o.normCenter?.x === 'number' ? o.normCenter.x : (typeof o.centroid?.x === 'number' ? o.centroid.x : (o.center?.x || 0));
        const cy = typeof o.normCenter?.y === 'number' ? o.normCenter.y : (typeof o.centroid?.y === 'number' ? o.centroid.y : (o.center?.y || 0));
        return {
          id: o.id || o.track_id || `obj_${Math.random().toString(36).substr(2, 5)}`,
          trackId: (o.trackId !== undefined && o.trackId !== null) ? o.trackId : (o.track_id ?? null),
          className: String(o.className || o.class_name || 'object').toLowerCase(),
          normCenter: {
            x: Math.max(0, Math.min(1, cx)),
            y: Math.max(0, Math.min(1, cy))
          },
          spatialZone: o.spatialZone || o.zone || o.relative_position || 'tengah',
          isPersonal: Boolean(o.isPersonal || o.is_personal),
          personalName: o.personalName || o.personalized_name || null
        };
      }) : [],
      ocrText: String(snapshot.ocrText || '').trim(),
      hasOcrText: Boolean(snapshot.ocrText && String(snapshot.ocrText).trim().length > 0),
      safetyRisk: snapshot.safetyRisk || snapshot.safetyState?.riskLevel || 'LOW',
      activeAlertsCount: Number(snapshot.activeAlertsCount !== undefined ? snapshot.activeAlertsCount : snapshot.safetyState?.activeAlertsCount) || 0,
      activeAlertTitles: Array.isArray(snapshot.activeAlertTitles) ? [...snapshot.activeAlertTitles] : (Array.isArray(snapshot.safetyState?.criticalAlerts) ? [...snapshot.safetyState.criticalAlerts] : [])
    };

    // Tambahkan snapshot baru ke akhir array
    this.snapshots.push(normalizedSnapshot);

    // Enforce circular buffer limits: buang yang lebih tua dari batas kapasitas atau jendela waktu
    if (this.snapshots.length > this.config.maxSnapshots) {
      this.snapshots.shift();
    }

    const minAllowedTime = now - this.config.maxHistoryWindowMs;
    while (this.snapshots.length > 1 && this.snapshots[0].timestamp < minAllowedTime) {
      this.snapshots.shift();
    }

    return normalizedSnapshot;
  }

  /**
   * Mengambil snapshot terbaru (T_now)
   * @returns {Object|null}
   */
  getCurrent() {
    return this.snapshots.length > 0 ? this.snapshots[this.snapshots.length - 1] : null;
  }

  /**
   * Mengambil seluruh snapshot dalam buffer (urut terlama ke terbaru)
   * @returns {Array<Object>}
   */
  getHistory() {
    return [...this.snapshots];
  }

  /**
   * Mengambil snapshot yang paling mendekati waktu target (T_target)
   * @param {number} targetTimestamp
   * @returns {Object|null}
   */
  getSnapshotAt(targetTimestamp) {
    if (this.snapshots.length === 0) return null;

    let closest = this.snapshots[0];
    let minDiff = Math.abs(closest.timestamp - targetTimestamp);

    for (let i = 1; i < this.snapshots.length; i++) {
      const diff = Math.abs(this.snapshots[i].timestamp - targetTimestamp);
      if (diff < minDiff) {
        minDiff = diff;
        closest = this.snapshots[i];
      }
    }

    return closest;
  }

  /**
   * Menghitung perbedaan (Delta) antara pemandangan masa lalu dengan pemandangan saat ini
   * @param {number} [windowSeconds=15] Jendela waktu komparasi (default 15 detik, max 60)
   * @returns {Object} Structured Temporal Delta
   */
  computeDelta(windowSeconds = 15) {
    const effectiveWindowSec = Math.max(1, Math.min(60, Number(windowSeconds) || 15));
    const current = this.getCurrent();

    // 1. Skenario Riwayat Kosong / Kurang Data
    if (!current || this.snapshots.length < 2) {
      const emptyOcr = { has_changed: false, hasChanged: false, past_text: '', previousText: '', current_text: '', currentText: '', description: null };
      const emptySafety = { has_changed: false, hasChanged: false, past_risk: 'LOW', previousRisk: 'LOW', current_risk: 'LOW', currentRisk: 'LOW', description: null };
      return {
        has_changes: false,
        hasChanges: false,
        window_seconds: effectiveWindowSec,
        windowSeconds: effectiveWindowSec,
        elapsed_seconds: 0,
        elapsedSeconds: 0,
        appeared_objects: [],
        appeared: [],
        disappeared_objects: [],
        disappeared: [],
        moved_objects: [],
        moved: [],
        ocr_changes: emptyOcr,
        ocr: emptyOcr,
        safety_changes: emptySafety,
        safety: emptySafety,
        narrative: `Belum ada riwayat rekaman pemandangan yang cukup untuk jendela ${effectiveWindowSec} detik terakhir. Seluruh pemandangan dianggap stabil.`
      };
    }

    // 2. Cari snapshot masa lalu pada T_target = T_now - (windowSeconds * 1000)
    const targetTime = current.timestamp - (effectiveWindowSec * 1000);
    const past = this.getSnapshotAt(targetTime);
    const actualElapsedSec = Math.max(1, Math.round((current.timestamp - past.timestamp) / 1000));

    // Jika snapshot masa lalu identik referensinya dengan saat ini (hanya 1 snapshot di buffer)
    if (past === current) {
      const stableOcr = { has_changed: false, hasChanged: false, past_text: current.ocrText, previousText: current.ocrText, current_text: current.ocrText, currentText: current.ocrText, description: null };
      const stableSafety = { has_changed: false, hasChanged: false, past_risk: current.safetyRisk, previousRisk: current.safetyRisk, current_risk: current.safetyRisk, currentRisk: current.safetyRisk, description: null };
      return {
        has_changes: false,
        hasChanges: false,
        window_seconds: effectiveWindowSec,
        windowSeconds: effectiveWindowSec,
        elapsed_seconds: 0,
        elapsedSeconds: 0,
        appeared_objects: [],
        appeared: [],
        disappeared_objects: [],
        disappeared: [],
        moved_objects: [],
        moved: [],
        ocr_changes: stableOcr,
        ocr: stableOcr,
        safety_changes: stableSafety,
        safety: stableSafety,
        narrative: `Pemandangan terpantau stabil selama ${actualElapsedSec} detik terakhir. Tidak ada perubahan yang terdeteksi.`
      };
    }

    // 3. Pencocokan Objek Spasial-Temporal (Matching Strategy)
    const pastObjects = [...past.objects];
    const currObjects = [...current.objects];

    const matchedPairs = []; // [{ past: Object, curr: Object }]
    const matchedPastIndices = new Set();
    const matchedCurrIndices = new Set();

    // Langkah A: Cocokkan berdasarkan persistensi Track ID yang valid
    for (let c = 0; c < currObjects.length; c++) {
      const co = currObjects[c];
      if (co.trackId !== null && co.trackId !== undefined) {
        for (let p = 0; p < pastObjects.length; p++) {
          if (matchedPastIndices.has(p)) continue;
          const po = pastObjects[p];
          if (po.trackId === co.trackId && po.className === co.className) {
            matchedPairs.push({ past: po, curr: co });
            matchedPastIndices.add(p);
            matchedCurrIndices.add(c);
            break;
          }
        }
      }
    }

    // Helper ekstraksi koordinat pusat ternormalisasi yang tangguh
    const getCenter = (obj) => {
      if (obj.normCenter && typeof obj.normCenter.x === 'number') return obj.normCenter;
      if (obj.centroid && typeof obj.centroid.x === 'number') return obj.centroid;
      if (Array.isArray(obj.normBbox) && obj.normBbox.length === 4) {
        return { x: (obj.normBbox[0] + obj.normBbox[2]) / 2, y: (obj.normBbox[1] + obj.normBbox[3]) / 2 };
      }
      return { x: 0.5, y: 0.5 };
    };

    // Langkah B: Cocokkan sisa objek dari kelas yang sama berdasarkan kedekatan spasial ternormalisasi
    for (let c = 0; c < currObjects.length; c++) {
      if (matchedCurrIndices.has(c)) continue;
      const co = currObjects[c];
      const cCenter = getCenter(co);

      let bestPastIdx = -1;
      let minDistance = Infinity;

      for (let p = 0; p < pastObjects.length; p++) {
        if (matchedPastIndices.has(p)) continue;
        const po = pastObjects[p];
        if (po.className === co.className) {
          const pCenter = getCenter(po);
          const dist = Math.hypot(cCenter.x - pCenter.x, cCenter.y - pCenter.y);
          if (dist < minDistance && dist <= this.config.proximityMatchThreshold) {
            minDistance = dist;
            bestPastIdx = p;
          }
        }
      }

      if (bestPastIdx !== -1) {
        matchedPairs.push({ past: pastObjects[bestPastIdx], curr: co });
        matchedPastIndices.add(bestPastIdx);
        matchedCurrIndices.add(c);
      }
    }

    // 4. Klasifikasikan Perubahan Objek
    // 4a. Objek yang Muncul Baru (Appeared)
    const appearedObjects = [];
    for (let c = 0; c < currObjects.length; c++) {
      if (!matchedCurrIndices.has(c)) {
        const co = currObjects[c];
        appearedObjects.push({
          id: co.id,
          track_id: co.trackId,
          trackId: co.trackId,
          class_name: co.className,
          className: co.className,
          spatial_zone: co.spatialZone,
          spatialZone: co.spatialZone,
          is_personal: co.isPersonal,
          personal_name: co.personalName
        });
      }
    }

    // 4b. Objek yang Menghilang / Diambil (Disappeared)
    const disappearedObjects = [];
    for (let p = 0; p < pastObjects.length; p++) {
      if (!matchedPastIndices.has(p)) {
        const po = pastObjects[p];
        disappearedObjects.push({
          id: po.id,
          track_id: po.trackId,
          trackId: po.trackId,
          class_name: po.className,
          className: po.className,
          last_spatial_zone: po.spatialZone,
          lastSpatialZone: po.spatialZone,
          is_personal: po.isPersonal,
          personal_name: po.personalName
        });
      }
    }

    // 4c. Objek yang Berpindah Signifikan (Moved)
    const movedObjects = [];
    for (const pair of matchedPairs) {
      const { past: po, curr: co } = pair;
      const pCenter = getCenter(po);
      const cCenter = getCenter(co);
      const dx = cCenter.x - pCenter.x;
      const dy = cCenter.y - pCenter.y;
      const displacement = Math.hypot(dx, dy);

      if (displacement >= this.config.movementThresholdNorm) {
        // Tentukan arah pergeseran
        const directions = [];
        if (dx > 0.04) directions.push('kanan');
        else if (dx < -0.04) directions.push('kiri');
        if (dy > 0.04) directions.push('bawah');
        else if (dy < -0.04) directions.push('atas');

        const dirStr = directions.length > 0 ? `ke arah ${directions.join(' ')}` : 'posisi baru';
        const zoneChange = po.spatialZone !== co.spatialZone ? `dari area ${po.spatialZone} ke ${co.spatialZone}` : `di area ${co.spatialZone}`;

        movedObjects.push({
          id: co.id,
          track_id: co.trackId,
          trackId: co.trackId,
          class_name: co.className,
          className: co.className,
          displacement: Math.round(displacement * 100) / 100,
          from_zone: po.spatialZone,
          to_zone: co.spatialZone,
          movement_description: `bergeser ${dirStr} ${zoneChange}`,
          is_personal: co.isPersonal,
          personal_name: co.personalName
        });
      }
    }

    // 5. Evaluasi Perubahan Teks OCR
    const ocrChanges = {
      has_changed: false,
      hasChanged: false,
      past_text: past.ocrText,
      previousText: past.ocrText,
      current_text: current.ocrText,
      currentText: current.ocrText,
      description: null
    };

    if (past.ocrText !== current.ocrText) {
      ocrChanges.has_changed = true;
      ocrChanges.hasChanged = true;
      if (!past.ocrText && current.ocrText) {
        ocrChanges.description = `Muncul teks baru yang terbaca: "${current.ocrText}".`;
      } else if (past.ocrText && !current.ocrText) {
        ocrChanges.description = `Teks sebelumnya "${past.ocrText}" sudah tidak lagi terbaca.`;
      } else {
        ocrChanges.description = `Teks terbaca berubah dari "${past.ocrText}" menjadi "${current.ocrText}".`;
      }
    }

    // 6. Evaluasi Perubahan Status Keselamatan
    const safetyChanges = {
      has_changed: false,
      hasChanged: false,
      past_risk: past.safetyRisk,
      previousRisk: past.safetyRisk,
      current_risk: current.safetyRisk,
      currentRisk: current.safetyRisk,
      description: null
    };

    if (past.safetyRisk !== current.safetyRisk || past.activeAlertsCount !== current.activeAlertsCount) {
      safetyChanges.has_changed = true;
      safetyChanges.hasChanged = true;
      if (current.activeAlertsCount > past.activeAlertsCount) {
        safetyChanges.description = `Muncul peringatan keselamatan baru (Tingkat risiko naik menjadi ${current.safetyRisk}).`;
      } else if (current.activeAlertsCount < past.activeAlertsCount) {
        safetyChanges.description = `Peringatan keselamatan sebelumnya telah terselesaikan (Tingkat risiko kini ${current.safetyRisk}).`;
      } else {
        safetyChanges.description = `Status risiko keselamatan berubah dari ${past.safetyRisk} menjadi ${current.safetyRisk}.`;
      }
    }

    // 7. Konstruksi Narasi Perubahan Deterministik dalam Bahasa Indonesia
    const hasAnyChange = (
      appearedObjects.length > 0 ||
      disappearedObjects.length > 0 ||
      movedObjects.length > 0 ||
      ocrChanges.has_changed ||
      safetyChanges.has_changed
    );

    let narrative = '';
    if (!hasAnyChange) {
      narrative = `Dalam ${actualElapsedSec} detik terakhir, pemandangan terpantau stabil. Tidak ada objek yang muncul, hilang, atau berpindah secara signifikan.`;
    } else {
      const parts = [];

      if (appearedObjects.length > 0) {
        const appDesc = appearedObjects.map(o => (o.personal_name || o.class_name) + ` di area ${o.spatial_zone}`).join(', ');
        parts.push(`Objek baru muncul: ${appDesc}`);
      }

      if (disappearedObjects.length > 0) {
        const disDesc = disappearedObjects.map(o => (o.personal_name || o.class_name) + ` (sebelumnya di area ${o.last_spatial_zone})`).join(', ');
        parts.push(`Objek tidak lagi terlihat: ${disDesc}`);
      }

      if (movedObjects.length > 0) {
        const movDesc = movedObjects.map(o => `${o.personal_name || o.class_name} ${o.movement_description}`).join(', ');
        parts.push(`Perpindahan objek: ${movDesc}`);
      }

      if (ocrChanges.has_changed && ocrChanges.description) {
        parts.push(ocrChanges.description);
      }

      if (safetyChanges.has_changed && safetyChanges.description) {
        parts.push(safetyChanges.description);
      }

      narrative = `Dalam ${actualElapsedSec} detik terakhir, terdeteksi beberapa perubahan: ` + parts.join('. ') + '.';
    }

    return {
      has_changes: hasAnyChange,
      hasChanges: hasAnyChange,
      window_seconds: effectiveWindowSec,
      windowSeconds: effectiveWindowSec,
      elapsed_seconds: actualElapsedSec,
      elapsedSeconds: actualElapsedSec,
      appeared_objects: appearedObjects,
      appeared: appearedObjects,
      disappeared_objects: disappearedObjects,
      disappeared: disappearedObjects,
      moved_objects: movedObjects,
      moved: movedObjects,
      ocr_changes: ocrChanges,
      ocr: ocrChanges,
      safety_changes: safetyChanges,
      safety: safetyChanges,
      narrative
    };
  }

  /**
   * Helper pembuatan snapshot ternormalisasi dari VisionContext
   * @param {Object} context Output VisionContextBuilder.build()
   * @param {number} [timestamp=Date.now()]
   * @returns {Object}
   */
  static createSnapshotFromContext(context, timestamp = Date.now()) {
    if (!context) return { timestamp, objects: [], ocrText: '', safetyRisk: 'LOW', activeAlertsCount: 0 };

    const frameW = context.camera?.width || 640;
    const frameH = context.camera?.height || 480;

    const objects = (context.detections || []).map((d) => {
      const bbox = Array.isArray(d.bbox) && d.bbox.length === 4 ? d.bbox : [0, 0, 0, 0];
      const cx = (bbox[0] + bbox[2]) / 2;
      const cy = (bbox[1] + bbox[3]) / 2;

      // Cek apakah ada matching personalized object
      const personalMatch = (context.personalizedObjects || []).find(p => p.track_id === d.id || p.track_id === d.track_id);

      return {
        id: d.id,
        trackId: d.track_id !== undefined ? d.track_id : (typeof d.id === 'number' ? d.id : null),
        className: d.class_name,
        normCenter: {
          x: Math.max(0, Math.min(1, cx / frameW)),
          y: Math.max(0, Math.min(1, cy / frameH))
        },
        normBbox: [
          Math.max(0, Math.min(1, bbox[0] / frameW)),
          Math.max(0, Math.min(1, bbox[1] / frameH)),
          Math.max(0, Math.min(1, bbox[2] / frameW)),
          Math.max(0, Math.min(1, bbox[3] / frameH))
        ],
        spatialZone: d.relative_position || 'tengah',
        isPersonal: Boolean(personalMatch),
        personalName: personalMatch ? personalMatch.personalized_name : null
      };
    });

    const activeAlerts = context.safety?.active_alerts || [];

    return {
      timestamp,
      objects,
      ocrText: context.ocr?.text || '',
      hasOcrText: !!context.ocr?.has_text,
      safetyRisk: context.safety?.risk_level || 'LOW',
      activeAlertsCount: context.safety?.active_alerts_count || 0,
      activeAlertTitles: activeAlerts.map(a => a.title)
    };
  }

  /**
   * Mengembalikan status diagnostik
   * @returns {Object}
   */
  getDiagnostics() {
    const curr = this.getCurrent();
    const oldest = this.snapshots.length > 0 ? this.snapshots[0] : null;
    const totalDurationSec = (curr && oldest) ? Math.round((curr.timestamp - oldest.timestamp) / 1000) : 0;

    return {
      totalSnapshots: this.snapshots.length,
      maxSnapshots: this.config.maxSnapshots,
      historyDurationSec: totalDurationSec,
      latestSnapshotTimestamp: curr ? curr.timestamp : null,
      oldestSnapshotTimestamp: oldest ? oldest.timestamp : null
    };
  }
}
