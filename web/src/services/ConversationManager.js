/**
 * ConversationManager.js - VisionX V1.6 Phase D
 * Multi-Turn Conversational Vision Session Manager
 *
 * Mengelola riwayat percakapan bertingkat (multi-turn) antara pengguna dan VisionAssistant.
 * - Menjaga batas kapasitas riwayat (Bounded 10 turns).
 * - Menyediakan sliding window konteks untuk AI (Default 6 turns).
 * - Menyimpan metadata konteks terstruktur ringan (tanpa citra mentah/raw frames).
 * - Mendukung pelacakan referensi deterministik ("tadi", "sebelumnya", "posisinya").
 */

export class ConversationManager {
  /**
   * @param {Object} [config={}]
   * @param {number} [config.maxTurns=10] Batas maksimum giliran percakapan yang disimpan
   * @param {number} [config.defaultWindow=6] Jendela default untuk permintaan AI
   */
  constructor({ maxTurns = 10, defaultWindow = 6 } = {}) {
    this.maxTurns = Math.max(2, Number(maxTurns) || 10);
    this.defaultWindow = Math.max(1, Number(defaultWindow) || 6);

    this.sessionId = this._generateSessionId();
    this.turns = [];
    this.createdAt = Date.now();
  }

  /**
   * Membuat atau me-reset sesi percakapan baru
   * @param {string|null} [customSessionId=null]
   * @returns {string} sessionId
   */
  createSession(customSessionId = null) {
    this.sessionId = customSessionId || this._generateSessionId();
    this.turns = [];
    this.createdAt = Date.now();
    return this.sessionId;
  }

  /**
   * Menambahkan pesan pengguna (User Turn)
   * @param {string} content Teks pertanyaan pengguna
   * @param {Object|null} [context=null] Snapshot VisionContext saat pertanyaan diajukan
   * @returns {Object} Turn yang disimpan
   */
  appendUserMessage(content, context = null) {
    const text = String(content || '').trim();
    if (!text) {
      throw new Error('Pesan pengguna tidak boleh kosong.');
    }

    const contextRef = context ? ConversationManager.extractContextRef(context) : null;
    const turn = {
      id: `turn_u_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
      role: 'user',
      content: text,
      timestamp: Date.now(),
      contextRef
    };

    this.turns.push(turn);
    this._enforceLimit();
    return turn;
  }

  /**
   * Menambahkan pesan asisten (Assistant Turn)
   * @param {string} content Teks jawaban asisten
   * @param {Object} [metadata={}] Metadata pelengkap (provider, latencyMs, contextRef)
   * @returns {Object} Turn yang disimpan
   */
  appendAssistantMessage(content, metadata = {}) {
    const text = String(content || '').trim();
    if (!text) {
      throw new Error('Pesan asisten tidak boleh kosong.');
    }

    let contextRef = null;
    if (metadata.contextRef) {
      contextRef = metadata.contextRef;
    } else if (metadata.context) {
      contextRef = ConversationManager.extractContextRef(metadata.context);
    }

    const turn = {
      id: `turn_a_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
      role: 'assistant',
      content: text,
      timestamp: Date.now(),
      provider: metadata.provider || 'visionx-assistant',
      latencyMs: typeof metadata.latencyMs === 'number' ? metadata.latencyMs : 0,
      contextRef
    };

    this.turns.push(turn);
    this._enforceLimit();
    return turn;
  }

  /**
   * Mengambil giliran percakapan terkini dalam batas sliding window
   * @param {number} [count=this.defaultWindow] Jumlah giliran yang diambil
   * @returns {Array<Object>}
   */
  getRecentTurns(count = this.defaultWindow) {
    const windowSize = Math.max(1, Number(count) || this.defaultWindow);
    return this.turns.slice(-windowSize);
  }

  /**
   * Mengambil semua giliran percakapan dalam sesi aktif
   * @returns {Array<Object>}
   */
  getAllTurns() {
    return [...this.turns];
  }

  /**
   * Mengambil turn terakhir dalam riwayat
   * @returns {Object|null}
   */
  getLastTurn() {
    return this.turns.length > 0 ? this.turns[this.turns.length - 1] : null;
  }

  /**
   * Mengambil turn terakhir yang memiliki referensi context visual
   * @returns {Object|null}
   */
  getLastTurnWithContext() {
    for (let i = this.turns.length - 1; i >= 0; i--) {
      if (this.turns[i].contextRef) {
        return this.turns[i];
      }
    }
    return null;
  }

  /**
   * Menemukan objek yang menjadi fokus atau dibahas pada percakapan sebelumnya
   * Digunakan untuk resolusi referensi deterministik ("yang mana", "posisinya", dll)
   * @returns {Object|null} { className, zone, bbox, isLargest }
   */
  getReferencedObjectFromHistory() {
    const lastWithCtx = this.getLastTurnWithContext();
    if (!lastWithCtx || !lastWithCtx.contextRef) return null;

    const ctx = lastWithCtx.contextRef;
    const detections = ctx.detections || [];
    if (detections.length === 0) return null;

    // 1. Jika ada focal object di konteks sebelumnya
    if (ctx.focalObject) {
      const match = detections.find(d => d.className === ctx.focalObject);
      if (match) return match;
    }

    // 2. Cari objek dengan luas bounding box terbesar
    let largest = detections[0];
    let maxArea = -1;

    for (const d of detections) {
      if (Array.isArray(d.bbox) && d.bbox.length === 4) {
        const area = Math.abs((d.bbox[2] - d.bbox[0]) * (d.bbox[3] - d.bbox[1]));
        if (area > maxArea) {
          maxArea = area;
          largest = d;
        }
      }
    }

    return largest;
  }

  /**
   * Reset seluruh percakapan
   */
  clear() {
    this.turns = [];
    this.sessionId = this._generateSessionId();
    this.createdAt = Date.now();
  }

  /**
   * Mengambil ringkasan diagnostik sesi percakapan
   * @returns {Object}
   */
  getDiagnostics() {
    const userTurns = this.turns.filter(t => t.role === 'user').length;
    const assistantTurns = this.turns.filter(t => t.role === 'assistant').length;
    const oldestTimestamp = this.turns.length > 0 ? this.turns[0].timestamp : null;
    const latestTimestamp = this.turns.length > 0 ? this.turns[this.turns.length - 1].timestamp : null;

    return {
      sessionId: this.sessionId,
      totalTurns: this.turns.length,
      turnCount: this.turns.length,
      maxTurns: this.maxTurns,
      userTurns,
      assistantTurns,
      oldestTimestamp,
      latestTimestamp
    };
  }

  /**
   * Ekstraksi metadata konteks ringan (tanpa data gambar / frame)
   * @param {Object} context Output dari VisionContextBuilder
   * @returns {Object}
   */
  static extractContextRef(context) {
    if (!context) return null;

    const detections = (context.detections || []).map(d => ({
      id: d.id,
      trackId: d.track_id !== undefined ? d.track_id : (typeof d.id === 'number' ? d.id : null),
      className: String(d.class_name || d.className || 'object').toLowerCase(),
      zone: d.relative_position || d.spatialZone || 'tengah',
      confidence: typeof d.confidence === 'number' ? d.confidence : 0,
      bbox: Array.isArray(d.bbox) ? [...d.bbox] : null
    }));

    const focal = context.sceneUnderstanding?.focal_object?.class_name || context.summary?.focal_object || null;
    const clutter = context.sceneUnderstanding?.clutter_level || context.summary?.clutter_level || 'EMPTY';
    const ocrText = context.ocr?.text || '';
    const safetyRisk = context.safety?.risk_level || context.summary?.safety_risk_level || 'LOW';

    return {
      timestamp: typeof context.timestamp === 'number' ? context.timestamp : Date.now(),
      totalObjects: detections.length,
      detectedClasses: detections.map(d => d.className),
      focalObject: focal,
      clutterLevel: clutter,
      detections,
      ocrText,
      safetyRisk
    };
  }

  /**
   * Helper internal pembuat session ID unik
   * @private
   */
  _generateSessionId() {
    return `sess_${Date.now()}_${Math.random().toString(36).substr(2, 7)}`;
  }

  /**
   * Memastikan kapasitas turns tidak melampaui maxTurns (FIFO sliding buffer)
   * @private
   */
  _enforceLimit() {
    while (this.turns.length > this.maxTurns) {
      this.turns.shift();
    }
  }
}
