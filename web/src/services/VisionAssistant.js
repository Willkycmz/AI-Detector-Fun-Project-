/**
 * VisionAssistant.js - VisionX V1.0 AI Vision Assistant Orchestrator
 *
 * Mengoordinasikan interaksi pengguna dengan AI Vision Multimodal:
 * 1. Menerima pertanyaan teks pengguna.
 * 2. Mengambil snapshot citra kamera pada saat pertanyaan diajukan (on-demand snapshot, tidak streaming).
 * 3. Membangun context visual terstruktur melalui VisionContextBuilder.
 * 4. Mengirimkan snapshot dan context ke AIProvider yang terabstraksi.
 * 5. Mengelola state loading/sukses/error secara asinkron tanpa memblokir thread rendering YOLO.
 * 6. Opsional meneruskan jawaban ke VoiceEngine untuk aksesibilitas suara.
 */

import { BackendAIProvider } from './AIProvider.js';
import { VisionContextBuilder } from './VisionContextBuilder.js';
import { MemoryQueryEngine } from './MemoryQueryEngine.js';
import { ConversationManager } from './ConversationManager.js';

export const AssistantState = {
  IDLE: 'IDLE',
  LOADING: 'LOADING',
  SUCCESS: 'SUCCESS',
  ERROR: 'ERROR'
};

export class VisionAssistant {
  /**
   * @param {Object} [config={}]
   * @param {import('./AIProvider.js').AIProvider} [config.aiProvider] Provider AI (default: BackendAIProvider)
   * @param {import('./VoiceEngine.js').VoiceEngine|null} [config.voiceEngine] VoiceEngine opsional
   * @param {import('./ObjectMemory.js').ObjectMemory|null} [config.objectMemory] ObjectMemory opsional (V1.1)
   * @param {Object|null} [config.personalObjectRegistry] PersonalObjectRegistry opsional (V1.2)
   * @param {Object|null} [config.safetyEngine] SafetyEngine opsional (V1.6)
   * @param {Object|null} [config.alertManager] AlertManager opsional (V1.6)
   * @param {Object|null} [config.sceneHistoryEngine] SceneHistoryEngine opsional (V1.6 Phase C)
   * @param {ConversationManager|null} [config.conversationManager] ConversationManager opsional (V1.6 Phase D)
   * @param {Function} [config.snapshotFn] Fungsi pengambil snapshot frame kamera saat ini () => string | null
   * @param {Function} [config.contextFn] Fungsi pembangun context vision saat ini () => Object
   * @param {boolean} [config.autoSpeak=true] Apakah otomatis membaca suara jika VoiceEngine aktif
   */
  constructor({
    aiProvider = null,
    voiceEngine = null,
    objectMemory = null,
    personalObjectRegistry = null,
    safetyEngine = null,
    alertManager = null,
    sceneHistoryEngine = null,
    conversationManager = null,
    snapshotFn = null,
    contextFn = null,
    autoSpeak = true
  } = {}) {
    this.aiProvider = aiProvider || new BackendAIProvider();
    this.voiceEngine = voiceEngine || null;
    this.objectMemory = objectMemory || null;
    this.personalObjectRegistry = personalObjectRegistry || null;
    this.safetyEngine = safetyEngine || null;
    this.alertManager = alertManager || null;
    this.sceneHistoryEngine = sceneHistoryEngine || null;
    this.conversationManager = conversationManager || new ConversationManager({ maxTurns: 10, defaultWindow: 6 });
    this.snapshotFn = snapshotFn || (() => null);
    this.contextFn = contextFn || (() => VisionContextBuilder.build({
      objectMemory: this.objectMemory,
      personalObjectRegistry: this.personalObjectRegistry,
      safetyEngine: this.safetyEngine,
      alertManager: this.alertManager,
      sceneHistoryEngine: this.sceneHistoryEngine
    }));
    this.autoSpeak = autoSpeak;

    // State Internal
    this.state = AssistantState.IDLE;
    this.isLoading = false;
    this.lastResult = null;
    this.lastError = null;
    this.lastLatencyMs = 0;
    this.history = [];

    // Event Listeners
    this.listeners = new Map();
  }

  /**
   * Mengganti atau update AIProvider runtime
   * @param {import('./AIProvider.js').AIProvider} provider
   */
  setAIProvider(provider) {
    if (!provider || typeof provider.askVision !== 'function') {
      throw new Error('Provider tidak valid: harus mengimplementasikan askVision()');
    }
    this.aiProvider = provider;
    this._emit('providerChange', provider);
  }

  /**
   * Daftarkan listener event ('stateChange' | 'loading' | 'success' | 'error')
   */
  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event).add(callback);
    return () => this.listeners.get(event)?.delete(callback);
  }

  /**
   * Daftarkan listener perubahan state
   */
  onStateChange(callback) {
    return this.on('stateChange', callback);
  }

  _emit(event, data) {
    const callbacks = this.listeners.get(event);
    if (callbacks) {
      for (const cb of callbacks) {
        try {
          cb(data);
        } catch (err) {
          console.warn(`[VisionAssistant] Listener error on event '${event}':`, err);
        }
      }
    }
  }

  _setState(newState, error = null) {
    this.state = newState;
    this.isLoading = (newState === AssistantState.LOADING);
    if (error) {
      this.lastError = typeof error === 'string' ? error : error.message || 'Terjadi kesalahan pada AI Assistant';
    } else if (newState === AssistantState.SUCCESS || newState === AssistantState.IDLE) {
      this.lastError = null;
    }

    const statePayload = {
      state: this.state,
      isLoading: this.isLoading,
      lastResult: this.lastResult,
      lastError: this.lastError,
      latencyMs: this.lastLatencyMs
    };

    this._emit('stateChange', statePayload);
  }

  /**
   * Mengajukan pertanyaan ke AI Vision Assistant
   * @param {string} question Pertanyaan pengguna
   * @param {Object} [options={}]
   * @param {boolean} [options.autoSpeak] Override konfigurasi autoSpeak
   * @returns {Promise<{ success: boolean, answer?: string, error?: string, latencyMs: number }>}
   */
  async ask(question, { autoSpeak = null } = {}) {
    const trimmedQuestion = String(question || '').trim();
    if (!trimmedQuestion) {
      const err = new Error('Pertanyaan tidak boleh kosong.');
      this._setState(AssistantState.ERROR, err);
      this._emit('error', { error: err.message });
      throw err;
    }

    // 1. Set State Loading
    this._setState(AssistantState.LOADING);
    this._emit('loading', { question: trimmedQuestion });

    const startTime = performance.now();

    try {
      // 1. Ambil context vision terstruktur saat ini (Fresh Context)
      let context = null;
      try {
        context = await Promise.resolve(this.contextFn());
      } catch (ctxErr) {
        console.warn('[VisionAssistant] Gagal mengambil context builder:', ctxErr);
        context = VisionContextBuilder.build();
      }

      // 1.4. Cek referensi retrospektif ("tadi", "sebelumnya", "barusan")
      const qLow = trimmedQuestion.toLowerCase();
      const hasRetrospectiveRef = (qLow.includes('tadi') || qLow.includes('sebelumnya') || qLow.includes('barusan')) && !qLow.includes('berubah');
      if (hasRetrospectiveRef && this.conversationManager && this.conversationManager.getAllTurns().length === 0) {
        const latencyMs = Math.round(performance.now() - startTime);
        this.lastLatencyMs = latencyMs;

        const result = {
          question: trimmedQuestion,
          answer: 'Belum ada konteks percakapan atau objek sebelumnya yang tercatat dalam sesi ini.',
          provider: 'visionx-conversation-manager',
          timestamp: new Date().toISOString(),
          latencyMs,
          contextSummary: context?.summary || null
        };

        this._recordSuccess(result, autoSpeak, context);

        return {
          success: true,
          answer: result.answer,
          provider: result.provider,
          latencyMs
        };
      }

      // 1.5. Cek apakah pertanyaan adalah query perbandingan temporal pemandangan (ZERO HALLUCINATION)
      if (this.sceneHistoryEngine && this.isTemporalQuestion(trimmedQuestion)) {
        const windowSec = this.extractTemporalWindow(trimmedQuestion) || 15;
        const delta = this.sceneHistoryEngine.computeDelta(windowSec);
        if (delta && delta.narrative) {
          const latencyMs = Math.round(performance.now() - startTime);
          this.lastLatencyMs = latencyMs;

          // Sesuaikan narasi jika pertanyaan menanyakan sub-aspek spesifik
          let specificAnswer = delta.narrative;
          if (qLow.includes('baru muncul') || qLow.includes('muncul')) {
            if (delta.appeared_objects && delta.appeared_objects.length > 0) {
              const names = delta.appeared_objects.map(o => (o.personal_name || o.class_name) + ` di area ${o.spatial_zone}`).join(', ');
              specificAnswer = `Objek yang baru muncul dalam ${delta.elapsed_seconds || windowSec} detik terakhir: ${names}.`;
            } else {
              specificAnswer = `Tidak ada objek baru yang muncul dalam ${delta.elapsed_seconds || windowSec} detik terakhir.`;
            }
          } else if (qLow.includes('hilang') || qLow.includes('tidak terlihat')) {
            if (delta.disappeared_objects && delta.disappeared_objects.length > 0) {
              const names = delta.disappeared_objects.map(o => (o.personal_name || o.class_name) + ` (terakhir di area ${o.last_spatial_zone})`).join(', ');
              specificAnswer = `Objek yang hilang atau tidak lagi terlihat: ${names}.`;
            } else {
              specificAnswer = `Tidak ada objek yang hilang dalam ${delta.elapsed_seconds || windowSec} detik terakhir.`;
            }
          } else if (qLow.includes('pindah') || qLow.includes('berpindah') || qLow.includes('bergerak')) {
            if (delta.moved_objects && delta.moved_objects.length > 0) {
              const names = delta.moved_objects.map(o => `${o.personal_name || o.class_name} ${o.movement_description || 'berpindah posisi'}`).join(', ');
              specificAnswer = `Ya, terdeteksi perpindahan: ${names}.`;
            } else {
              specificAnswer = `Tidak ada benda yang berpindah posisi secara signifikan dalam ${delta.elapsed_seconds || windowSec} detik terakhir.`;
            }
          } else if (qLow.includes('ocr') || qLow.includes('teks') || qLow.includes('tulisan')) {
            if (delta.ocr_changes && delta.ocr_changes.has_changed) {
              specificAnswer = delta.ocr_changes.description || `Teks OCR berubah dari "${delta.ocr_changes.past_text}" menjadi "${delta.ocr_changes.current_text}".`;
            } else {
              specificAnswer = `Tidak ada perubahan teks OCR dalam ${delta.elapsed_seconds || windowSec} detik terakhir.`;
            }
          } else if (qLow.includes('safety') || qLow.includes('keselamatan') || qLow.includes('bahaya')) {
            if (delta.safety_changes && delta.safety_changes.has_changed) {
              specificAnswer = delta.safety_changes.description || `Status safety berubah dari ${delta.safety_changes.past_risk} menjadi ${delta.safety_changes.current_risk}.`;
            } else {
              specificAnswer = `Status keselamatan tetap stabil (${delta.safety_changes ? delta.safety_changes.current_risk : 'NORMAL'}).`;
            }
          }

          const result = {
            question: trimmedQuestion,
            answer: specificAnswer,
            provider: 'visionx-temporal-engine',
            timestamp: new Date().toISOString(),
            latencyMs,
            contextSummary: {
              windowSeconds: delta.window_seconds,
              hasChanges: delta.has_changes,
              appearedCount: delta.appeared_objects ? delta.appeared_objects.length : 0,
              disappearedCount: delta.disappeared_objects ? delta.disappeared_objects.length : 0,
              movedCount: delta.moved_objects ? delta.moved_objects.length : 0
            }
          };

          this._recordSuccess(result, autoSpeak, context);

          return {
            success: true,
            answer: result.answer,
            provider: result.provider,
            latencyMs
          };
        }
      }

      // 1.6. Cek apakah pertanyaan adalah query memori objek deterministik (ZERO HALLUCINATION)
      if (this.objectMemory && MemoryQueryEngine.isMemoryQuestion(trimmedQuestion)) {
        const memRes = MemoryQueryEngine.query(trimmedQuestion, this.objectMemory, this.personalObjectRegistry);
        if (memRes && memRes.isMemoryQuery && memRes.answer) {
          const latencyMs = Math.round(performance.now() - startTime);
          this.lastLatencyMs = latencyMs;

          const result = {
            question: trimmedQuestion,
            answer: memRes.answer,
            provider: 'visionx-object-memory',
            timestamp: new Date().toISOString(),
            latencyMs,
            contextSummary: { memoryIntent: memRes.intent, matchedObjects: memRes.matchedObjects }
          };

          this._recordSuccess(result, autoSpeak, context);

          return {
            success: true,
            answer: result.answer,
            provider: result.provider,
            latencyMs
          };
        }
      }

      // 2. Ambil snapshot kamera HANYA saat user bertanya (tidak streaming)
      let snapshotDataUrl = null;
      try {
        snapshotDataUrl = await Promise.resolve(this.snapshotFn());
      } catch (snapErr) {
        console.warn('[VisionAssistant] Gagal mengambil snapshot kamera (fallback ke context only):', snapErr);
      }

      // 3. Ambil riwayat percakapan terkini (Sliding Window 6 turns)
      const conversationHistory = this.conversationManager ? this.conversationManager.getRecentTurns(6) : [];

      // 4. Kirim ke AIProvider bersama riwayat percakapan
      const aiResponse = await this.aiProvider.askVision({
        image: snapshotDataUrl,
        context,
        question: trimmedQuestion,
        conversationHistory
      });

      const latencyMs = Math.round(performance.now() - startTime);
      this.lastLatencyMs = latencyMs;

      // 5. Format hasil sukses
      const result = {
        question: trimmedQuestion,
        answer: aiResponse.answer || 'Tidak ada respons yang diterima.',
        provider: aiResponse.provider || this.aiProvider.name,
        timestamp: new Date().toISOString(),
        latencyMs,
        contextSummary: context?.summary || null
      };

      this._recordSuccess(result, autoSpeak, context);

      return {
        success: true,
        answer: result.answer,
        provider: result.provider,
        latencyMs
      };
    } catch (err) {
      const latencyMs = Math.round(performance.now() - startTime);
      this.lastLatencyMs = latencyMs;
      const errorMsg = err.message || 'Gagal berkomunikasi dengan AI Assistant.';

      this._setState(AssistantState.ERROR, err);
      this._emit('error', { error: errorMsg, question: trimmedQuestion });

      return {
        success: false,
        error: errorMsg,
        latencyMs
      };
    }
  }

  /**
   * Helper internal pencatatan hasil sukses ke riwayat & ConversationManager
   * @private
   */
  _recordSuccess(result, autoSpeak, context) {
    if (this.conversationManager && typeof this.conversationManager.appendUserMessage === 'function') {
      try {
        this.conversationManager.appendUserMessage(result.question, context);
        this.conversationManager.appendAssistantMessage(result.answer, {
          provider: result.provider,
          latencyMs: result.latencyMs,
          context
        });
      } catch (convErr) {
        console.warn('[VisionAssistant] Gagal mencatat giliran percakapan:', convErr);
      }
    }

    this.lastResult = result;
    this.history.unshift(result);
    if (this.history.length > 20) this.history.pop();

    this._setState(AssistantState.SUCCESS);
    this._emit('success', result);

    const shouldSpeak = (autoSpeak !== null) ? autoSpeak : this.autoSpeak;
    if (shouldSpeak && this.voiceEngine && this.voiceEngine.config && this.voiceEngine.config.enabled) {
      this.speakResponse(result.answer);
    }
  }

  /**
   * Membacakan teks jawaban dengan suara melalui VoiceEngine
   * @param {string} [text] Teks yang akan dibacakan (default: lastResult.answer)
   */
  speakResponse(text = null) {
    const textToSpeak = text || this.lastResult?.answer;
    if (!textToSpeak) return;

    if (this.voiceEngine && typeof this.voiceEngine.speak === 'function') {
      // Gunakan prioritas tinggi agar langsung membacakan respons AI
      this.voiceEngine.speak(textToSpeak, { priority: 2 }); // HIGH priority
    }
  }

  /**
   * Menghentikan pembacaan suara
   */
  stopSpeech() {
    if (this.voiceEngine && typeof this.voiceEngine.stop === 'function') {
      this.voiceEngine.stop();
    }
  }

  /**
   * Reset state dan clear jawaban terakhir & percakapan
   */
  clear() {
    this.stopSpeech();
    this.lastResult = null;
    this.lastError = null;
    if (this.conversationManager && typeof this.conversationManager.clear === 'function') {
      this.conversationManager.clear();
    }
    this._setState(AssistantState.IDLE);
  }

  /**
   * Mengecek apakah pertanyaan pengguna terkait perubahan temporal pemandangan
   * @param {string} question
   * @returns {boolean}
   */
  isTemporalQuestion(question) {
    const q = String(question || '').toLowerCase().trim();
    if (!q) return false;

    const temporalKeywords = [
      'berubah', 'perubahan', 'berpindah', 'bergeser', 'baru muncul',
      'hilang', 'yang hilang', 'detik terakhir', 'menit terakhir',
      'tadi ke mana', 'pindah ke mana', 'geser ke mana', 'apa yang baru'
    ];

    return temporalKeywords.some(kw => q.includes(kw));
  }

  /**
   * Ekstraksi estimasi durasi jendela detik dari pertanyaan (misal "15 detik", "30 detik")
   * @param {string} question
   * @returns {number}
   */
  extractTemporalWindow(question) {
    const q = String(question || '').toLowerCase();
    const match = q.match(/(\d+)\s*(detik|second|sec)/);
    if (match) {
      return parseInt(match[1], 10);
    }
    const minMatch = q.match(/(\d+)\s*(menit|minute|min)/);
    if (minMatch) {
      return Math.min(60, parseInt(minMatch[1], 10) * 60);
    }
    return 15; // Default window 15 detik
  }

  /**
   * Mengambil snapshot state lengkap
   */
  getDiagnostics() {
    return {
      state: this.state,
      isLoading: this.isLoading,
      provider: this.aiProvider?.name || 'none',
      hasVoiceEngine: !!this.voiceEngine,
      hasObjectMemory: !!this.objectMemory,
      hasPersonalObjectRegistry: !!this.personalObjectRegistry,
      hasSafetyEngine: !!this.safetyEngine,
      hasAlertManager: !!this.alertManager,
      hasSceneHistoryEngine: !!this.sceneHistoryEngine,
      hasConversationManager: !!this.conversationManager,
      conversationDiagnostics: this.conversationManager ? this.conversationManager.getDiagnostics() : null,
      lastLatencyMs: this.lastLatencyMs,
      historyCount: this.history.length,
      lastQuestion: this.lastResult?.question || null,
      lastAnswer: this.lastResult?.answer || null,
      lastError: this.lastError
    };
  }
}
