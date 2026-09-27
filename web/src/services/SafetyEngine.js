/**
 * SafetyEngine.js - VisionX V1.3 Realtime Environmental & Personal Object Safety Engine
 *
 * Mengamati lifecycle objek dari TrackingEngine, ObjectMemory, dan PersonalObjectRecognizer,
 * lalu mengevaluasi rule keselamatan spasio-temporal untuk memproduksi structured safety events.
 *
 * Aturan (Rules) Awal:
 * 1. OBJECT_LEFT: Objek generik meninggalkan pandangan kamera.
 * 2. PERSONAL_OBJECT_LEFT: Objek terdaftar milik pengguna meninggalkan pandangan kamera (Severity: HIGH).
 * 3. OBJECT_RETURNED: Objek yang sempat hilang kembali terlihat di frame.
 * 4. PERSISTENT_OBJECT: Objek diam/stasioner di zona yang sama selama waktu melebihi ambang batas.
 * 5. DUPLICATE_TRACK_ANOMALY: Anomali di mana beberapa track aktif teridentifikasi sebagai objek personal unik yang sama.
 *
 * Bersifat decoupled, local-first, zero AI retraining, dan menyediakan interface event emitter
 * tanpa memaksakan spamming ke VoiceEngine kecuali dikonfigurasi.
 */

export const SafetyEventType = {
  OBJECT_LEFT: 'OBJECT_LEFT',
  PERSONAL_OBJECT_LEFT: 'PERSONAL_OBJECT_LEFT',
  OBJECT_RETURNED: 'OBJECT_RETURNED',
  PERSISTENT_OBJECT: 'PERSISTENT_OBJECT',
  DUPLICATE_TRACK_ANOMALY: 'DUPLICATE_TRACK_ANOMALY'
};

export const SafetySeverity = {
  LOW: 'LOW',
  NORMAL: 'NORMAL',
  HIGH: 'HIGH',
  CRITICAL: 'CRITICAL'
};

export const DEFAULT_SAFETY_CONFIG = {
  enabled: true,
  persistenceThresholdMs: 15000,    // Durasi stasioner untuk PERSISTENT_OBJECT (15 detik)
  duplicateAnomalyWindowMs: 4000,   // Window pengecekan duplikasi track
  cooldownPerObjectMs: 5000         // Cooldown per event tipe + object agar tidak spam
};

export class SafetyEngine {
  /**
   * @param {Object} [config={}]
   */
  constructor(config = {}) {
    this.config = { ...DEFAULT_SAFETY_CONFIG, ...config };
    this.listeners = new Set();
    this.eventHistory = [];
    this.maxHistoryLength = 100;

    // State tracking internal
    this.objectStationaryStates = new Map(); // trackId -> { firstZone, firstTimestamp, lastTimestamp, reported }
    this.lastEmittedEventTimestamps = new Map(); // key (type+trackId/name) -> timestamp
  }

  /**
   * Daftarkan observer untuk mendengarkan safety event
   * @param {Function} listener (event: Object) => void
   * @returns {Function} Unsubscribe function
   */
  onSafetyEvent(listener) {
    if (typeof listener !== 'function') return () => {};
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Subscribe ke event stream (alias onSafetyEvent)
   * @param {Function} listener
   * @returns {Function}
   */
  subscribe(listener) {
    return this.onSafetyEvent(listener);
  }

  /**
   * Reset seluruh riwayat dan state safety engine
   */
  reset() {
    this.objectStationaryStates.clear();
    this.lastEmittedEventTimestamps.clear();
    this.eventHistory = [];
  }

  /**
   * Evaluasi state terkini dari TrackingEngine, ObjectMemory, dan PersonalObjectRecognizer
   * @param {Object} params
   * @param {Array<Object>} [params.activeTracks=[]] Track aktif dari TrackingEngine
   * @param {Array<Object>} [params.memoryEvents=[]] Event transisi dari ObjectMemory
   * @param {Object|null} [params.personalRecognizer=null] Instance PersonalObjectRecognizer
   * @param {number} [params.timestamp=Date.now()]
   * @returns {Array<Object>} List of newly generated SafetyEvents
   */
  evaluate({ activeTracks = [], memoryEvents = [], personalRecognizer = null, timestamp = Date.now() }) {
    if (!this.config.enabled) return [];

    const generatedEvents = [];

    // 1. Evaluasi event transisi dari ObjectMemory (OBJECT_LEFT & OBJECT_RETURNED)
    if (Array.isArray(memoryEvents)) {
      for (const memEvt of memoryEvents) {
        const trackId = memEvt.trackId;
        const className = memEvt.className || 'object';
        const lastZone = memEvt.zone || memEvt.lastZone || 'tengah';
        const isPersonal = memEvt.isPersonal || Boolean(memEvt.personalObjectId);
        const objectName = memEvt.personalObjectName || memEvt.objectName || className;

        if (memEvt.type === 'OBJECT_LEFT' || memEvt.type === 'LEFT') {
          const evtType = isPersonal ? SafetyEventType.PERSONAL_OBJECT_LEFT : SafetyEventType.OBJECT_LEFT;
          const severity = isPersonal ? SafetySeverity.HIGH : SafetySeverity.NORMAL;
          
          const safetyEvt = this._createSafetyEvent({
            type: evtType,
            severity,
            objectName,
            className,
            trackId,
            lastZone,
            timestamp,
            details: {
              personalObjectId: memEvt.personalObjectId || null,
              durationVisibleMs: memEvt.durationMs || 0
            }
          });

          if (safetyEvt) {
            generatedEvents.push(safetyEvt);
          }
          // Bersihkan status stationary jika ada
          this.objectStationaryStates.delete(trackId);
        } else if (memEvt.type === 'OBJECT_RETURNED' || memEvt.type === 'RETURNED') {
          const severity = isPersonal ? SafetySeverity.HIGH : SafetySeverity.NORMAL;
          
          const safetyEvt = this._createSafetyEvent({
            type: SafetyEventType.OBJECT_RETURNED,
            severity,
            objectName,
            className,
            trackId,
            lastZone,
            timestamp,
            details: {
              personalObjectId: memEvt.personalObjectId || null,
              absentDurationMs: memEvt.absentDurationMs || 0
            }
          });

          if (safetyEvt) {
            generatedEvents.push(safetyEvt);
          }
        }
      }
    }

    // 2. Evaluasi PERSISTENT_OBJECT dari activeTracks
    if (Array.isArray(activeTracks)) {
      const activeTrackIds = new Set();

      for (const track of activeTracks) {
        const trackId = track.trackId || track.id;
        if (trackId === undefined || trackId === null) continue;
        activeTrackIds.add(trackId);

        const currentZone = track.spatialZone || track.zone || 'tengah';
        const className = track.className || track.class_name || 'object';
        const personalName = track.personalObjectName || track.personalName || null;
        const objectName = personalName || className;
        const isPersonal = Boolean(personalName || track.isPersonal);

        if (!this.objectStationaryStates.has(trackId)) {
          this.objectStationaryStates.set(trackId, {
            firstZone: currentZone,
            firstTimestamp: timestamp,
            lastTimestamp: timestamp,
            reported: false,
            className,
            objectName,
            isPersonal
          });
        } else {
          const state = this.objectStationaryStates.get(trackId);
          // Jika zona berpindah drastis, reset stationary counter
          if (state.firstZone !== currentZone) {
            state.firstZone = currentZone;
            state.firstTimestamp = timestamp;
            state.reported = false;
          }
          state.lastTimestamp = timestamp;

          const duration = timestamp - state.firstTimestamp;
          if (duration >= this.config.persistenceThresholdMs && !state.reported) {
            state.reported = true;

            const safetyEvt = this._createSafetyEvent({
              type: SafetyEventType.PERSISTENT_OBJECT,
              severity: isPersonal ? SafetySeverity.NORMAL : SafetySeverity.LOW,
              objectName,
              className,
              trackId,
              lastZone: currentZone,
              timestamp,
              details: {
                persistenceDurationMs: duration,
                isPersonal
              }
            });

            if (safetyEvt) {
              generatedEvents.push(safetyEvt);
            }
          }
        }
      }

      // Bersihkan track yang sudah tidak aktif
      for (const existingTrackId of this.objectStationaryStates.keys()) {
        if (!activeTrackIds.has(existingTrackId)) {
          this.objectStationaryStates.delete(existingTrackId);
        }
      }

      // 3. Evaluasi DUPLICATE_TRACK_ANOMALY (Personal Objects)
      // Jika dua track aktif yang berbeda memiliki personal object ID atau nama yang sama
      const personalObjectTrackMap = new Map();
      for (const track of activeTracks) {
        const pId = track.personalObjectId || (track.isPersonal ? track.personalObjectName : null);
        const trackId = track.trackId || track.id;
        if (pId && trackId !== undefined) {
          if (!personalObjectTrackMap.has(pId)) {
            personalObjectTrackMap.set(pId, []);
          }
          personalObjectTrackMap.get(pId).push(track);
        }
      }

      for (const [pId, tracks] of personalObjectTrackMap.entries()) {
        if (tracks.length > 1) {
          const objName = tracks[0].personalObjectName || tracks[0].personalName || 'Personal Object';
          const trackIds = tracks.map(t => t.trackId || t.id);

          const safetyEvt = this._createSafetyEvent({
            type: SafetyEventType.DUPLICATE_TRACK_ANOMALY,
            severity: SafetySeverity.HIGH,
            objectName: objName,
            className: tracks[0].className || tracks[0].class_name || 'object',
            trackId: trackIds[0],
            lastZone: tracks[0].spatialZone || 'tengah',
            timestamp,
            details: {
              conflictingTrackIds: trackIds,
              personalObjectId: pId
            }
          });

          if (safetyEvt) {
            generatedEvents.push(safetyEvt);
          }
        }
      }
    }

    // Emit all generated events to subscribers
    for (const evt of generatedEvents) {
      this._emit(evt);
    }

    return generatedEvents;
  }

  /**
   * Helper internal untuk memvalidasi cooldown dan membuat structured event
   * @private
   */
  _createSafetyEvent({ type, severity, objectName, className, trackId, lastZone, timestamp, details = {} }) {
    const cooldownKey = `${type}_${objectName}_${trackId}`;
    if (this.lastEmittedEventTimestamps.has(cooldownKey)) {
      const lastEmitted = this.lastEmittedEventTimestamps.get(cooldownKey);
      if (timestamp - lastEmitted < this.config.cooldownPerObjectMs) {
        return null; // Throttled
      }
    }

    this.lastEmittedEventTimestamps.set(cooldownKey, timestamp);

    const event = {
      type,
      severity,
      objectName: String(objectName || 'Objek'),
      className: String(className || 'object'),
      trackId: trackId !== undefined ? trackId : null,
      lastZone: String(lastZone || 'tengah'),
      timestamp: Number(timestamp) || Date.now(),
      details
    };

    // Tambahkan ke history log
    this.eventHistory.unshift(event);
    if (this.eventHistory.length > this.maxHistoryLength) {
      this.eventHistory.pop();
    }

    return event;
  }

  /**
   * Emit event ke seluruh listener
   * @private
   */
  _emit(event) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.warn('[SafetyEngine] Listener execution error:', err);
      }
    }
  }

  /**
   * Ambil log riwayat safety events
   * @returns {Array<Object>}
   */
  getEventHistory() {
    return [...this.eventHistory];
  }

  /**
   * Ambil ringkasan status SafetyEngine
   * @returns {Object}
   */
  getDiagnostics() {
    return {
      enabled: this.config.enabled,
      totalEventsEmitted: this.eventHistory.length,
      activeMonitoredTracks: this.objectStationaryStates.size,
      latestEvent: this.eventHistory[0] || null
    };
  }
}
