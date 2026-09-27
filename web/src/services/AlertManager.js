/**
 * AlertManager.js - VisionX V1.3.1 Realtime Safety Alert Manager
 *
 * Mengorkestrasikan event keselamatan dari SafetyEngine ke UI dan VoiceEngine
 * secara terkontrol, hemat komputasi (event-driven), bebas spam, dan terisolasi.
 *
 * Fitur:
 * 1. Menerima structured event dari SafetyEngine
 * 2. State machine alert: CREATED -> QUEUED -> SPOKEN -> DISMISSED -> COOLED_DOWN
 * 3. Deduplikasi dan cooldown per-objek & per-tipe event
 * 4. Pemetaan tingkat keparahan (Severity Mapping) & integrasi prioritas VoiceEngine
 * 5. Konfigurasi tersimpan lokal (Safety Alerts ON/OFF, Voice Safety ON/OFF, Persistent Alerts ON/OFF, Cooldown)
 * 6. Manajemen riwayat alert (Dismiss, Clear, Max history limit)
 */

import { SafetyEventType, SafetySeverity } from './SafetyEngine.js';
import { SpeechPriority } from './VoiceEngine.js';

export const AlertState = {
  CREATED: 'CREATED',
  QUEUED: 'QUEUED',
  SPOKEN: 'SPOKEN',
  DISMISSED: 'DISMISSED',
  COOLED_DOWN: 'COOLED_DOWN'
};

export const DEFAULT_ALERT_CONFIG = {
  safetyAlertsEnabled: true,       // Mengaktifkan sistem alert keselamatan secara keseluruhan
  voiceSafetyAlertsEnabled: true,  // Mengizinkan notifikasi suara untuk alert berkepentingan tinggi
  persistentAlertsEnabled: false,  // Mengizinkan alert suara untuk objek yang diam/stasioner lama
  defaultCooldownMs: 10000,        // Cooldown default (10 detik)
  personalLeftCooldownMs: 10000,   // Cooldown khusus PERSONAL_OBJECT_LEFT (10 detik)
  objectReturnedCooldownMs: 5000,  // Cooldown khusus OBJECT_RETURNED (5 detik)
  anomalyCooldownMs: 10000,        // Cooldown khusus DUPLICATE_TRACK_ANOMALY (10 detik)
  maxAlertsHistory: 50             // Jumlah maksimum alert yang disimpan di memori UI
};

export class AlertManager {
  /**
   * @param {Object|null} voiceEngine Instance VoiceEngine untuk sintesis suara
   * @param {Object} [customConfig={}] Konfigurasi opsional atau tersimpan dari localStorage
   */
  constructor(voiceEngine = null, customConfig = {}) {
    this.voiceEngine = voiceEngine;
    this.config = { ...DEFAULT_ALERT_CONFIG, ...customConfig };
    this.alerts = [];
    this.listeners = new Set();
    this.cooldownTimers = new Map(); // key -> lastAlertTimestamp
    this.activeStateMap = new Map(); // alertId -> AlertState
  }

  /**
   * Daftarkan observer untuk perubahan daftar alert
   * @param {Function} listener () => void
   * @returns {Function} Unsubscribe function
   */
  onAlertUpdate(listener) {
    if (typeof listener !== 'function') return () => {};
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  _notifyUpdate() {
    for (const listener of this.listeners) {
      try {
        listener(this.getAlerts());
      } catch (err) {
        console.warn('[AlertManager] Listener error:', err);
      }
    }
  }

  /**
   * Ambil daftar alert aktif
   * @returns {Array<Object>}
   */
  getAlerts() {
    return [...this.alerts];
  }

  /**
   * Mengubah konfigurasi alert manager & simpan ke storage
   * @param {Object} newConfig
   */
  updateConfig(newConfig = {}) {
    this.config = { ...this.config, ...newConfig };
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('visionx_safety_alert_config', JSON.stringify({
          safetyAlertsEnabled: this.config.safetyAlertsEnabled,
          voiceSafetyAlertsEnabled: this.config.voiceSafetyAlertsEnabled,
          persistentAlertsEnabled: this.config.persistentAlertsEnabled,
          defaultCooldownMs: this.config.defaultCooldownMs
        }));
      }
    } catch (e) {
      console.warn('[AlertManager] Gagal menyimpan config ke localStorage:', e);
    }
    this._notifyUpdate();
  }

  /**
   * Memproses structured event yang di-emit oleh SafetyEngine
   * @param {Object} safetyEvent Event dari SafetyEngine
   * @returns {Object|null} Alert object jika berhasil dibuat, atau null jika di-throttle/disabled
   */
  processEvent(safetyEvent) {
    if (!this.config.safetyAlertsEnabled || !safetyEvent) {
      return null;
    }

    const { type, severity, objectName, className, trackId, lastZone, timestamp = Date.now(), details = {} } = safetyEvent;
    const personalId = details.personalObjectId || null;
    const isPersonal = Boolean(personalId || type === SafetyEventType.PERSONAL_OBJECT_LEFT);

    // 1. Identitas unik untuk Deduplikasi & Cooldown
    const identityKey = `${type}_${personalId || objectName || className}_${trackId || 'any'}`;
    const cooldownDuration = this._getCooldownDurationForType(type);

    if (this.cooldownTimers.has(identityKey)) {
      const lastTriggered = this.cooldownTimers.get(identityKey);
      if (timestamp - lastTriggered < cooldownDuration) {
        return null; // Suppressed by cooldown
      }
    }

    // Update cooldown timestamp
    this.cooldownTimers.set(identityKey, timestamp);

    // 2. Format Pesan Alert & Keputusan Suara
    const alertId = `alert_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    const { title, message, speechText, shouldSpeak, speechPriority } = this._formatAlertDetails({
      type,
      severity,
      objectName: objectName || className || 'Objek',
      lastZone: lastZone || 'tengah',
      isPersonal,
      details
    });

    const alertItem = {
      id: alertId,
      type,
      severity: severity || SafetySeverity.NORMAL,
      objectName: objectName || className || 'Objek',
      title,
      message,
      speechText,
      lastZone: lastZone || 'tengah',
      state: AlertState.CREATED,
      timestamp: Number(timestamp) || Date.now(),
      isPersonal,
      details
    };

    // 3. Masukkan ke State Machine
    alertItem.state = AlertState.QUEUED;
    this.activeStateMap.set(alertId, AlertState.QUEUED);

    // Tambahkan ke riwayat alert (terbaru di atas)
    this.alerts.unshift(alertItem);
    if (this.alerts.length > this.config.maxAlertsHistory) {
      const removed = this.alerts.pop();
      if (removed) this.activeStateMap.delete(removed.id);
    }

    // 4. Kirim ke VoiceEngine jika diizinkan
    if (shouldSpeak && this.config.voiceSafetyAlertsEnabled && this.voiceEngine && speechText) {
      try {
        if (typeof this.voiceEngine.speak === 'function') {
          this.voiceEngine.speak(speechText, {
            priority: speechPriority || SpeechPriority.HIGH
          });
          alertItem.state = AlertState.SPOKEN;
          this.activeStateMap.set(alertId, AlertState.SPOKEN);
        }
      } catch (voiceErr) {
        console.warn('[AlertManager] Voice speech warning (non-blocking):', voiceErr);
      }
    }

    this._notifyUpdate();
    return alertItem;
  }

  /**
   * Menghapus / mendismiss satu alert spesifik
   * @param {string} alertId
   */
  dismissAlert(alertId) {
    const index = this.alerts.findIndex(a => a.id === alertId);
    if (index !== -1) {
      this.alerts[index].state = AlertState.DISMISSED;
      this.activeStateMap.set(alertId, AlertState.DISMISSED);
      this.alerts.splice(index, 1);
      this._notifyUpdate();
      return true;
    }
    return false;
  }

  /**
   * Mengosongkan seluruh riwayat alert
   */
  clearAlerts() {
    for (const alert of this.alerts) {
      this.activeStateMap.set(alert.id, AlertState.DISMISSED);
    }
    this.alerts = [];
    this.cooldownTimers.clear();
    this._notifyUpdate();
  }

  /**
   * Menentukan durasi cooldown berdasarkan jenis event
   * @private
   */
  _getCooldownDurationForType(type) {
    switch (type) {
      case SafetyEventType.PERSONAL_OBJECT_LEFT:
        return this.config.personalLeftCooldownMs || this.config.defaultCooldownMs;
      case SafetyEventType.OBJECT_RETURNED:
        return this.config.objectReturnedCooldownMs || 5000;
      case SafetyEventType.DUPLICATE_TRACK_ANOMALY:
        return this.config.anomalyCooldownMs || 10000;
      case SafetyEventType.PERSISTENT_OBJECT:
        return 15000;
      case SafetyEventType.OBJECT_LEFT:
      default:
        return this.config.defaultCooldownMs || 5000;
    }
  }

  /**
   * Format teks tampilan dan suara dalam Bahasa Indonesia
   * @private
   */
  _formatAlertDetails({ type, severity, objectName, lastZone, isPersonal, details }) {
    let title = 'Peringatan Objek';
    let message = `${objectName} berada di ${lastZone}.`;
    let speechText = null;
    let shouldSpeak = false;
    let speechPriority = SpeechPriority.NORMAL;

    switch (type) {
      case SafetyEventType.PERSONAL_OBJECT_LEFT:
        title = `Barang Pribadi Tertinggal: ${objectName}`;
        message = `${objectName} lu keluar dari pandangan kamera (terakhir terlihat di zona ${lastZone}).`;
        speechText = `${objectName} lu terakhir terlihat di ${lastZone}.`;
        shouldSpeak = true;
        speechPriority = SpeechPriority.HIGH;
        break;

      case SafetyEventType.OBJECT_LEFT:
        title = `Objek Meninggalkan Frame: ${objectName}`;
        message = `${objectName} tidak lagi terlihat (zona terakhir: ${lastZone}).`;
        speechText = null; // Normal objects do not auto spam TTS
        shouldSpeak = false;
        speechPriority = SpeechPriority.NORMAL;
        break;

      case SafetyEventType.OBJECT_RETURNED:
        title = `Objek Kembali Terlihat: ${objectName}`;
        message = `${objectName} kembali terdeteksi di area ${lastZone}.`;
        if (isPersonal) {
          speechText = `${objectName} lu kembali terlihat.`;
          shouldSpeak = true;
          speechPriority = SpeechPriority.HIGH;
        } else {
          speechText = null;
          shouldSpeak = false;
          speechPriority = SpeechPriority.NORMAL;
        }
        break;

      case SafetyEventType.PERSISTENT_OBJECT:
        title = `Objek Diam (Stasioner): ${objectName}`;
        message = `${objectName} telah berada di zona ${lastZone} selama beberapa saat.`;
        if (this.config.persistentAlertsEnabled) {
          speechText = `${objectName} berada di ${lastZone} cukup lama.`;
          shouldSpeak = true;
          speechPriority = SpeechPriority.NORMAL;
        } else {
          shouldSpeak = false;
        }
        break;

      case SafetyEventType.DUPLICATE_TRACK_ANOMALY:
        title = `Anomali Pelacakan: ${objectName}`;
        message = `Terdeteksi duplikasi track untuk objek personal "${objectName}".`;
        speechText = `Terjadi anomali pelacakan objek personal.`;
        shouldSpeak = true;
        speechPriority = SpeechPriority.HIGH;
        break;

      default:
        title = `Event Keselamatan: ${objectName}`;
        message = `Pembaruan status untuk ${objectName}.`;
        shouldSpeak = false;
        break;
    }

    return { title, message, speechText, shouldSpeak, speechPriority };
  }

  /**
   * Diagnostik status AlertManager
   * @returns {Object}
   */
  getDiagnostics() {
    return {
      safetyAlertsEnabled: this.config.safetyAlertsEnabled,
      voiceSafetyAlertsEnabled: this.config.voiceSafetyAlertsEnabled,
      persistentAlertsEnabled: this.config.persistentAlertsEnabled,
      totalActiveAlerts: this.alerts.length,
      activeCooldownsCount: this.cooldownTimers.size,
      latestAlert: this.alerts[0] || null
    };
  }
}
