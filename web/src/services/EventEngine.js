/**
 * EventEngine.js - VisionX V0.8 Object Lifecycle Event & Voice Dispatcher
 *
 * Menganalisis perubahan status track dari TrackingEngine untuk mendeteksi event:
 * - OBJECT_ENTERED: Objek baru terkonfirmasi masuk ke frame
 * - OBJECT_RETURNED: Objek yang sempat hilang kembali terlihat (dengan syarat cooldown)
 * - OBJECT_LEFT: Objek hilang/keluar dari bidang pandang (tidak diumumkan ke suara)
 *
 * Mengatur:
 * - Deduplikasi berbasis trackId (objek yang tetap terlihat 100+ frame tidak diulang)
 * - Pengaturan cooldown terpusat (default: 5000 ms)
 * - Batching / debounce jika beberapa objek masuk bersamaan ("3 objek terdeteksi: laptop, mouse, dan botol.")
 * - Pengiriman ke VoiceEngine dengan priority normal
 */

import { MessageFormatter } from './MessageFormatter.js';
import { SpeechPriority, VoiceMode } from './VoiceEngine.js';

export const ObjectEventType = {
  OBJECT_ENTERED: 'OBJECT_ENTERED',
  OBJECT_RETURNED: 'OBJECT_RETURNED',
  OBJECT_LEFT: 'OBJECT_LEFT'
};

export const DEFAULT_EVENT_CONFIG = {
  cooldownMs: 5000,     // Cooldown antar pengumuman ulang objek yang kembali (5 detik)
  batchWindowMs: 300,   // Jendela waktu (ms) pengelompokan batching objek masuk simultan
  announceReturned: true
};

export class EventEngine {
  /**
   * @param {Object} voiceEngine Instance VoiceEngine untuk berbicara (opsional)
   * @param {Object} customConfig Konfigurasi event & cooldown
   */
  constructor(voiceEngine = null, customConfig = {}) {
    this.voiceEngine = voiceEngine;
    this.config = { ...DEFAULT_EVENT_CONFIG, ...customConfig };

    // Map histori track: trackId -> { trackId, className, state, lastAnnouncedTime, hasEntered }
    this.trackHistory = new Map();

    // Buffer batching objek masuk: Array<{ trackId, className, timestamp }>
    this.pendingBatch = [];
    this.batchTimer = null;

    // Callback event listener eksternal
    this.eventListeners = new Set();
  }

  /**
   * Daftarkan listener event
   * @param {Function} listener ({ type, track, message, timestamp }) => void
   * @returns {Function} Unsubscribe
   */
  onEvent(listener) {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /**
   * Emit event ke semua listener
   */
  _emitEvent(event) {
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch (err) {
        console.warn('[EventEngine] Error in event listener:', err);
      }
    }
  }

  /**
   * Perbarui konfigurasi runtime
   */
  updateConfig(newConfig = {}) {
    this.config = { ...this.config, ...newConfig };
  }

  /**
   * Reset seluruh histori tracking event
   */
  reset() {
    this.trackHistory.clear();
    this.pendingBatch = [];
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
  }

  /**
   * Proses hasil update TrackingEngine untuk frame aktif
   * @param {Array<Object>} activeTracks Daftar track dari TrackingEngine (termasuk visible & lost)
   * @param {number|null} nowTimestamp Waktu eksekusi (default Date.now())
   * @returns {Array<Object>} Daftar event yang dihasilkan pada siklus ini
   */
  processTracks(activeTracks = [], nowTimestamp = null) {
    const now = nowTimestamp !== null ? nowTimestamp : Date.now();
    const generatedEvents = [];
    const currentEnteredInThisFrame = [];

    // Kumpulkan track ID aktif pada frame saat ini
    const presentTrackIds = new Set();

    for (const track of activeTracks) {
      const trackId = track.trackId;
      const state = track.state; // 'tentative' | 'confirmed' | 'lost' | 'removed'
      const isVisible = track.missedFrames === 0 && state === 'confirmed';
      const className = track.className;

      presentTrackIds.add(trackId);

      let record = this.trackHistory.get(trackId);

      if (!record) {
        // Track baru pertama kali didaftarkan
        record = {
          trackId,
          className,
          state,
          lastAnnouncedTime: 0,
          hasEntered: false,
          hasLeft: false
        };
        this.trackHistory.set(trackId, record);
      }

      // KASUS 1: Objek Baru Dikonfirmasi (OBJECT_ENTERED)
      if (isVisible && !record.hasEntered) {
        record.hasEntered = true;
        record.state = 'confirmed';
        record.hasLeft = false;

        const event = {
          type: ObjectEventType.OBJECT_ENTERED,
          trackId,
          className,
          timestamp: now
        };
        generatedEvents.push(event);
        currentEnteredInThisFrame.push({ trackId, className, timestamp: now });
        this._emitEvent(event);
      }
      // KASUS 2: Objek yang sempat hilang kembali terlihat (OBJECT_RETURNED)
      else if (isVisible && record.hasEntered && record.hasLeft) {
        record.hasLeft = false;
        record.state = 'confirmed';

        // Periksa batasan Cooldown: hanya boleh diumumkan kembali jika sudah melebihi cooldownMs
        const timeSinceLastAnnouncement = now - record.lastAnnouncedTime;
        if (timeSinceLastAnnouncement >= this.config.cooldownMs) {
          record.lastAnnouncedTime = now;
          const message = MessageFormatter.formatObjectReturned(className);
          const event = {
            type: ObjectEventType.OBJECT_RETURNED,
            trackId,
            className,
            message,
            timestamp: now
          };
          generatedEvents.push(event);
          this._emitEvent(event);

          // Bicara langsung untuk objek kembali
          if (this.voiceEngine && this.voiceEngine.speak) {
            this.voiceEngine.speak(message, { priority: SpeechPriority.NORMAL });
          }
        }
      }
      // KASUS 3: Objek yang sedang terlihat tetap terlihat (Deduplikasi)
      else if (isVisible) {
        // Tetap terlihat, JANGAN bicara lagi (suppress repetition)
        record.state = 'confirmed';
      }
      // KASUS 4: Objek hilang sementara (state === 'lost')
      else if (state === 'lost' || track.missedFrames > 0) {
        if (!record.hasLeft && record.hasEntered) {
          record.hasLeft = true;
          record.state = 'lost';
          const event = {
            type: ObjectEventType.OBJECT_LEFT,
            trackId,
            className,
            timestamp: now
          };
          generatedEvents.push(event);
          this._emitEvent(event);
          // CATATAN: Laptop hilang TIDAK diumumkan via suara sesuai spesifikasi
        }
      }
    }

    // KASUS 5: Track yang dihapus permanen atau tidak ada lagi di activeTracks
    for (const [trackId, record] of this.trackHistory.entries()) {
      if (!presentTrackIds.has(trackId)) {
        if (!record.hasLeft && record.hasEntered) {
          record.hasLeft = true;
          record.state = 'removed';
          const event = {
            type: ObjectEventType.OBJECT_LEFT,
            trackId,
            className: record.className,
            timestamp: now
          };
          generatedEvents.push(event);
          this._emitEvent(event);
        }
      }
    }

    // Penanganan BATCHING untuk objek masuk:
    if (currentEnteredInThisFrame.length > 0) {
      this._handleEnteredObjectsBatch(currentEnteredInThisFrame, now);
    }

    return generatedEvents;
  }

  /**
   * Kelola batching untuk objek-objek yang baru masuk
   */
  _handleEnteredObjectsBatch(enteredObjects, now) {
    // Jika lebih dari 1 objek terdeteksi masuk pada frame yang sama,
    // langsung bentuk batch tanpa jeda
    if (enteredObjects.length > 1 && (!this.config.batchWindowMs || this.config.batchWindowMs <= 0)) {
      this._announceBatch(enteredObjects, now);
      return;
    }

    // Masukkan ke buffer pending batch
    this.pendingBatch.push(...enteredObjects);

    // Jika batchWindowMs == 0, proses langsung
    if (!this.config.batchWindowMs || this.config.batchWindowMs <= 0) {
      this.flushBatch(now);
      return;
    }

    // Jika sudah ada banyak objek di pendingBatch (>= 2), jadwalkan flush segera
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
    }

    this.batchTimer = setTimeout(() => {
      this.flushBatch();
    }, this.config.batchWindowMs);
  }

  /**
   * Flush pending batch objek yang masuk dan umumkan via VoiceEngine
   * @param {number|null} nowTimestamp
   */
  flushBatch(nowTimestamp = null) {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }

    if (this.pendingBatch.length === 0) return;

    const itemsToAnnounce = [...this.pendingBatch];
    this.pendingBatch = [];

    const now = nowTimestamp !== null ? nowTimestamp : Date.now();
    this._announceBatch(itemsToAnnounce, now);
  }

  /**
   * Bentuk kalimat ucapan dari daftar objek dan kirim ke VoiceEngine
   */
  _announceBatch(items, now) {
    if (!items || items.length === 0) return;

    // Perbarui waktu pengumuman pada histori setiap track
    for (const item of items) {
      const rec = this.trackHistory.get(item.trackId);
      if (rec) {
        rec.lastAnnouncedTime = now;
      }
    }

    let message = '';
    if (items.length === 1) {
      message = MessageFormatter.formatObjectEntered(items[0].className);
    } else {
      message = MessageFormatter.formatMultipleObjects(items.map(it => it.className));
    }

    if (this.voiceEngine && this.voiceEngine.speak) {
      this.voiceEngine.speak(message, { priority: SpeechPriority.NORMAL });
    }

    return message;
  }
}
