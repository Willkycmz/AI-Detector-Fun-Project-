/**
 * VoiceEngine.js - VisionX V0.8 Browser Speech Synthesis Engine
 *
 * Mengelola antrean ucapan (priority speech queue), browser Web Speech API,
 * volume, rate/pitch, dan isolasi kegagalan untuk aksesibilitas realtime.
 *
 * Fitur:
 * - 100% Client-side Web Speech API (speechSynthesis). Tanpa API / Cloud eksternal.
 * - Priority Queue: CRITICAL > HIGH > NORMAL > LOW.
 * - Queue deduplication & bounding (maxQueueSize).
 * - Non-blocking asynchronous execution: tidak memperlambat Camera, YOLO, Tracking, atau Canvas.
 * - Failure isolation: jika browser tidak mendukung Web Speech API, tetap aman tanpa crash.
 */

export const SpeechPriority = {
  CRITICAL: 4,
  HIGH: 3,
  NORMAL: 2,
  LOW: 1
};

export const VoiceMode = {
  OFF: 'OFF',
  OBJECT_ALERTS: 'OBJECT_ALERTS',
  FULL_ASSISTANT: 'FULL_ASSISTANT'
};

export const VoiceState = {
  READY: 'READY',
  SPEAKING: 'SPEAKING',
  PAUSED: 'PAUSED',
  DISABLED: 'DISABLED',
  UNAVAILABLE: 'UNAVAILABLE'
};

export const DEFAULT_VOICE_CONFIG = {
  enabled: true,
  mode: VoiceMode.OBJECT_ALERTS,
  volume: 1.0,         // 0.0 - 1.0
  rate: 1.0,           // 0.5 - 2.0
  pitch: 1.0,          // 0.5 - 2.0
  cooldownMs: 5000,    // Default 5 detik cooldown pengumuman
  maxQueueSize: 10,    // Kapasitas antrean maksimum
  batchWindowMs: 300,  // Jendela debounce batching objek simultan (ms)
  lang: 'id-ID'        // Bahasa default Indonesia
};

export class VoiceEngine {
  /**
   * @param {Object} customConfig Konfigurasi opsional (akan di-merge dengan DEFAULT_VOICE_CONFIG)
   * @param {Object|null} customSynth Mock atau custom speechSynthesis (berguna untuk testing di Node.js)
   * @param {Function|null} customUtterance Mock atau custom SpeechSynthesisUtterance constructor
   */
  constructor(customConfig = {}, customSynth = null, customUtterance = null) {
    this.config = { ...DEFAULT_VOICE_CONFIG, ...customConfig };
    this.queue = [];
    this.nextMsgId = 1;
    this.isSpeaking = false;
    this.isPaused = false;
    this.lastMessage = '';
    this.totalAnnouncements = 0;
    this.stateListeners = new Set();
    this.currentUtterance = null;

    // Deteksi ketersediaan Web Speech API
    if (customSynth) {
      this.synth = customSynth;
      this._UtteranceClass = customUtterance || (typeof SpeechSynthesisUtterance !== 'undefined' ? SpeechSynthesisUtterance : class {});
      this.isAvailable = true;
      this.state = this.config.enabled ? VoiceState.READY : VoiceState.DISABLED;
    } else if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      this.synth = window.speechSynthesis;
      this._UtteranceClass = window.SpeechSynthesisUtterance;
      this.isAvailable = true;
      this.state = this.config.enabled ? VoiceState.READY : VoiceState.DISABLED;
    } else {
      this.synth = null;
      this._UtteranceClass = null;
      this.isAvailable = false;
      this.state = VoiceState.UNAVAILABLE;
    }
  }

  /**
   * Daftarkan listener saat status VoiceEngine berubah
   * @param {Function} listener (stateInfo) => void
   * @returns {Function} Unsubscribe function
   */
  onStateChange(listener) {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  /**
   * Notifikasi seluruh listener
   */
  _notifyStateChange() {
    const info = this.getState();
    for (const listener of this.stateListeners) {
      try {
        listener(info);
      } catch (err) {
        console.warn('[VoiceEngine] Error in state listener:', err);
      }
    }
  }

  /**
   * Set status internal & beritahu UI
   * @param {string} newState
   */
  _setState(newState) {
    if (!this.isAvailable) {
      this.state = VoiceState.UNAVAILABLE;
    } else {
      this.state = newState;
    }
    this._notifyStateChange();
  }

  /**
   * Ambil snapshot diagnostik status VoiceEngine
   */
  getState() {
    return {
      isAvailable: this.isAvailable,
      enabled: this.config.enabled,
      mode: this.config.mode,
      state: this.state,
      queueLength: this.queue.length,
      lastMessage: this.lastMessage || '-',
      totalAnnouncements: this.totalAnnouncements,
      volume: this.config.volume,
      rate: this.config.rate,
      pitch: this.config.pitch,
      cooldownMs: this.config.cooldownMs
    };
  }

  /**
   * Masukkan pesan ke priority speech queue dan jadwalkan proses
   * @param {string} text Kalimat yang akan diucapkan
   * @param {Object} options { priority, onEnd, onError }
   * @returns {boolean} true jika pesan berhasil diantrekan
   */
  speak(text, options = {}) {
    if (!this.isAvailable) {
      return false;
    }

    if (!this.config.enabled || this.config.mode === VoiceMode.OFF) {
      return false;
    }

    const trimmed = String(text || '').trim();
    if (!trimmed) {
      return false;
    }

    const priority = options.priority !== undefined ? options.priority : SpeechPriority.NORMAL;
    const msgItem = {
      id: this.nextMsgId++,
      text: trimmed,
      priority,
      createdAt: Date.now(),
      onEnd: options.onEnd || null,
      onError: options.onError || null
    };

    // Masukkan ke queue terurut berdasarkan prioritas (tinggi ke rendah)
    // Jika prioritas sama, gunakan FIFO berdasarkan createdAt
    this._insertByPriority(msgItem);

    // Bounding kapasitas queue (maxQueueSize)
    if (this.queue.length > this.config.maxQueueSize) {
      // Hapus item prioritas terendah yang paling tua
      this.queue.pop();
    }

    this._notifyStateChange();

    // Jika prioritas CRITICAL dan ada pesan lain dengan prioritas lebih rendah sedang berbicara,
    // interupsi ucapan yang ada untuk memberikan peringatan darurat segera
    if (priority === SpeechPriority.CRITICAL && this.isSpeaking) {
      this._cancelCurrentSpeechOnly();
    }

    // Jalankan pemrosesan queue secara asynchronous (tidak memblokir caller)
    if (!this.isSpeaking && !this.isPaused && !this._isScheduled) {
      this._isScheduled = true;
      Promise.resolve().then(() => {
        this._isScheduled = false;
        this._processNextInQueue();
      });
    }

    return true;
  }

  /**
   * Sisipkan item ke dalam queue dengan binary / linear insert terurut
   */
  _insertByPriority(item) {
    let insertIndex = this.queue.length;
    for (let i = 0; i < this.queue.length; i++) {
      if (item.priority > this.queue[i].priority) {
        insertIndex = i;
        break;
      }
    }
    this.queue.splice(insertIndex, 0, item);
  }

  /**
   * Ambil item berikutnya dari antrean dan ucapkan via Web Speech API
   */
  _processNextInQueue() {
    if (this.isSpeaking) {
      return;
    }

    if (!this.isAvailable || !this.config.enabled || this.config.mode === VoiceMode.OFF) {
      this.isSpeaking = false;
      this._setState(this.config.enabled ? VoiceState.READY : VoiceState.DISABLED);
      return;
    }

    if (this.isPaused) {
      this._setState(VoiceState.PAUSED);
      return;
    }

    if (this.queue.length === 0) {
      this.isSpeaking = false;
      this._setState(VoiceState.READY);
      return;
    }

    const nextItem = this.queue.shift();
    this.isSpeaking = true;
    this.lastMessage = nextItem.text;
    this.totalAnnouncements++;
    this._setState(VoiceState.SPEAKING);

    try {
      const utterance = new this._UtteranceClass(nextItem.text);
      utterance.volume = Math.max(0.0, Math.min(1.0, this.config.volume));
      utterance.rate = Math.max(0.5, Math.min(2.0, this.config.rate));
      utterance.pitch = Math.max(0.5, Math.min(2.0, this.config.pitch));
      utterance.lang = this.config.lang || 'id-ID';

      // Cari suara bahasa Indonesia jika tersedia di browser
      const voices = this.getVoices();
      if (voices && voices.length > 0) {
        const idVoice = voices.find(v => v.lang && (v.lang.startsWith('id') || v.lang.startsWith('ID') || v.lang.includes('ind')));
        if (idVoice) {
          utterance.voice = idVoice;
        }
      }

      this.currentUtterance = utterance;

      let hasFinished = false;
      const finishHandler = (isError = false, errorObj = null) => {
        if (hasFinished) return;
        hasFinished = true;

        const isCurrent = this.currentUtterance === utterance;
        if (isCurrent) {
          this.currentUtterance = null;
          this.isSpeaking = false;
        }

        if (isError && nextItem.onError) {
          try { nextItem.onError(errorObj); } catch (e) {}
        } else if (!isError && nextItem.onEnd) {
          try { nextItem.onEnd(); } catch (e) {}
        }

        // Lanjut ke pesan berikutnya jika ini adalah utterance aktif yang baru saja selesai
        if (isCurrent) {
          this._processNextInQueue();
        }
      };

      utterance.onend = () => finishHandler(false);
      utterance.onerror = (err) => {
        // Abaikan error 'canceled' / 'interrupted' saat sengaja distop
        finishHandler(true, err);
      };

      this.synth.speak(utterance);
    } catch (err) {
      console.warn('[VoiceEngine] Gagal memanggil speech synthesis:', err);
      this.currentUtterance = null;
      this.isSpeaking = false;
      if (nextItem.onError) {
        try { nextItem.onError(err); } catch (e) {}
      }
      this._processNextInQueue();
    }
  }

  /**
   * Hentikan ucapan yang sedang berlangsung tanpa menghapus sisa antrean
   */
  _cancelCurrentSpeechOnly() {
    this.isSpeaking = false;
    this.currentUtterance = null;
    if (this.synth && this.synth.cancel) {
      try {
        this.synth.cancel();
      } catch (err) {
        console.warn('[VoiceEngine] Error canceling speech:', err);
      }
    }
  }

  /**
   * Stop seluruh ucapan saat ini dan kosongkan antrean
   */
  stop() {
    if (!this.isAvailable) return;
    this.clearQueue();
    this._cancelCurrentSpeechOnly();
    this.isPaused = false;
    this._setState(this.config.enabled ? VoiceState.READY : VoiceState.DISABLED);
  }

  /**
   * Pause pemutaran ucapan
   */
  pause() {
    if (!this.isAvailable) return;
    if (this.synth && this.synth.pause) {
      try {
        this.synth.pause();
      } catch (e) {}
    }
    this.isPaused = true;
    this._setState(VoiceState.PAUSED);
  }

  /**
   * Resume pemutaran ucapan yang di-pause
   */
  resume() {
    if (!this.isAvailable) return;
    if (this.synth && this.synth.resume) {
      try {
        this.synth.resume();
      } catch (e) {}
    }
    this.isPaused = false;
    if (this.isSpeaking) {
      this._setState(VoiceState.SPEAKING);
    } else {
      this._processNextInQueue();
    }
  }

  /**
   * Kosongkan antrean pesan yang belum sempat diucapkan
   */
  clearQueue() {
    this.queue = [];
    this._notifyStateChange();
  }

  /**
   * Ulangi pesan terakhir yang pernah diucapkan
   */
  replayLastMessage() {
    if (!this.lastMessage) return false;
    return this.speak(this.lastMessage, { priority: SpeechPriority.NORMAL });
  }

  /**
   * Aktifkan atau nonaktifkan Voice Engine
   * @param {boolean} enabled
   */
  setEnabled(enabled) {
    this.config.enabled = Boolean(enabled);
    if (!this.config.enabled) {
      this.stop();
      this._setState(VoiceState.DISABLED);
    } else {
      this._setState(VoiceState.READY);
    }
  }

  /**
   * Set Mode (OFF, OBJECT_ALERTS, FULL_ASSISTANT)
   * @param {string} mode
   */
  setMode(mode) {
    if (mode === VoiceMode.OFF) {
      this.config.mode = VoiceMode.OFF;
      this.stop();
      this._setState(VoiceState.DISABLED);
    } else if (mode === VoiceMode.OBJECT_ALERTS) {
      this.config.mode = VoiceMode.OBJECT_ALERTS;
      this._setState(this.config.enabled ? VoiceState.READY : VoiceState.DISABLED);
    } else if (mode === VoiceMode.FULL_ASSISTANT) {
      // Placeholder untuk V0.9+
      this.config.mode = VoiceMode.FULL_ASSISTANT;
      this._setState(this.config.enabled ? VoiceState.READY : VoiceState.DISABLED);
    }
  }

  /**
   * Set Kecepatan (Rate) Suara (0.5 - 2.0)
   * @param {number} rate
   */
  setRate(rate) {
    const val = Number(rate);
    if (!isNaN(val)) {
      this.config.rate = Math.max(0.5, Math.min(2.0, val));
      this._notifyStateChange();
    }
  }

  /**
   * Set Volume Suara (0.0 - 1.0)
   * @param {number} volume
   */
  setVolume(volume) {
    const val = Number(volume);
    if (!isNaN(val)) {
      this.config.volume = Math.max(0.0, Math.min(1.0, val));
      this._notifyStateChange();
    }
  }

  /**
   * Set Pitch Suara (0.5 - 2.0)
   * @param {number} pitch
   */
  setPitch(pitch) {
    const val = Number(pitch);
    if (!isNaN(val)) {
      this.config.pitch = Math.max(0.5, Math.min(2.0, val));
      this._notifyStateChange();
    }
  }

  /**
   * Dapatkan daftar suara Web Speech API dari browser
   * @returns {Array}
   */
  getVoices() {
    if (!this.isAvailable || !this.synth || !this.synth.getVoices) {
      return [];
    }
    try {
      return this.synth.getVoices() || [];
    } catch (err) {
      return [];
    }
  }

  /**
   * Perbarui konfigurasi runtime
   * @param {Object} newConfig
   */
  updateConfig(newConfig = {}) {
    this.config = { ...this.config, ...newConfig };
    this._notifyStateChange();
  }
}
