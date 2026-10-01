/**
 * AIProvider.js - VisionX V1.0 AI Provider Abstraction Interface
 *
 * Mengabstraksikan layer penyedia kecerdasan buatan (Vision LLM / Multimodal AI).
 * UI dan controller VisionAssistant TIDAK bergantung pada satu provider tertentu.

 *
 * Implementasi:
 * - AIProvider (Base abstract class)
 * - BackendAIProvider (Default: Mengirim query ke proxy backend lokal /api/ai/ask-vision tanpa membocorkan API key di browser)
 * - MockAIProvider (Untuk automated tests deterministik & simulasi offline)
 */

export class AIProvider {
  /**
   * Mengirim pertanyaan multimodal berbasis gambar snapshot dan context vision
   * @param {Object} options
   * @param {string} options.image Snapshot citra kamera (Base64 data URL JPEG/PNG)
   * @param {Object} options.context Objek context JSON dari VisionContextBuilder
   * @param {string} options.question Pertanyaan teks pengguna
   * @param {Array<Object>} [options.conversationHistory=[]] Riwayat giliran percakapan sebelumnya
   * @returns {Promise<{ answer: string, provider: string, latencyMs: number }>}
   */
  async askVision({ image, context, question, conversationHistory = [] }) {
    throw new Error('Metode askVision() harus diimplementasikan oleh kelas turunan AIProvider.');
  }

  /**
   * Nama identitas penyedia AI
   */
  get name() {
    return 'BaseAIProvider';
  }
}

import { API_BASE_URL, ENDPOINTS } from './apiConfig.js';
import { authService } from './AuthService.js';

/**
 * BackendAIProvider - Menghubungi backend gateway produksi VisionX (https://visionx.my.id/api/chat)
 * Fitur:
 * - Autentikasi server-side berbasis signed expiring Bearer token (sessionStorage)
 * - Server-Sent Events (SSE) streaming respons progresif
 * - Penanganan error komprehensif: 401 (auth), 403, 413 (size), 429 (rate limit/lockout), 500
 */
export class BackendAIProvider extends AIProvider {
  /**
   * @param {Object} [config={}]
   * @param {string} [config.baseUrl] URL backend (default: from apiConfig.js)
   * @param {string} [config.endpoint] Endpoint chat (default: {baseUrl}/api/chat)
   * @param {string} [config.loginEndpoint] Endpoint login (default: {baseUrl}/api/login)
   * @param {number} [config.timeoutMs=35000] Timeout permintaan (ms)
   * @param {Function} [config.onAuthRequired] Callback saat token kosong / 401
   */
  constructor(config = {}) {
    super();
    this.baseUrl = config.baseUrl || API_BASE_URL;
    this.endpoint = config.endpoint || ENDPOINTS.CHAT;
    this.loginEndpoint = config.loginEndpoint || ENDPOINTS.LOGIN;
    this.timeoutMs = config.timeoutMs || 35000;
    this.onAuthRequired = config.onAuthRequired || null;
    this.sessionStorageKey = 'visionx_session_token';
    this._memoryToken = null;
  }

  get name() {
    return 'BackendAIProvider';
  }

  /**
   * Mendapatkan token sesi dari AuthService
   * @returns {string|null}
   */
  getToken() {
    return authService.getAccessToken() || this._memoryToken;
  }

  /**
   * Menyimpan token sesi
   * @param {string} token
   */
  setToken(token) {
    this._memoryToken = token;
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('visionx_auth_token', token);
      }
    } catch (_) {}
  }

  /**
   * Menghapus token sesi
   */
  clearToken() {
    this._memoryToken = null;
    authService.signOut();
  }

  /**
   * Memeriksa apakah sesi telah terautentikasi
   * @returns {boolean}
   */
  isAuthenticated() {
    return authService.isAuthenticated() || Boolean(this._memoryToken);
  }

  /**
   * Melakukan login server-side menggunakan PIN
   * @param {string} pin
   * @returns {Promise<{ success: boolean, token: string }>}
   */
  async login(pin) {
    if (!pin || typeof pin !== 'string' || pin.trim().length === 0) {
      throw new Error('PIN tidak boleh kosong.');
    }

    try {
      const response = await fetch(this.loginEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({ pin: pin.trim() })
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        if (response.status === 429) {
          throw new Error(data.error || 'Terlalu banyak percobaan gagal. Akun terkunci sementara (15 menit).');
        }
        if (response.status === 401) {
          throw new Error('PIN akses VisionX salah. Silakan coba lagi.');
        }
        throw new Error(data.error || `Gagal login (HTTP ${response.status}).`);
      }

      if (!data.token) {
        throw new Error('Server tidak mengembalikan token autentikasi.');
      }

      this.setToken(data.token);
      return { success: true, token: data.token };
    } catch (err) {
      if (err.name === 'TypeError' && err.message && err.message.includes('fetch')) {
        throw new Error(`Tidak dapat terhubung ke server autentikasi (${this.loginEndpoint}). Pastikan backend Termux online.`);
      }
      throw err;
    }
  }

  /**
   * Mengirim query vision ke /api/chat dengan dukungan SSE streaming
   */
  async askVision({ image, context, question, detections = null, conversationHistory = [], onChunk = null, signal = null }) {
    if (!question || typeof question !== 'string' || question.trim().length === 0) {
      throw new Error('Pertanyaan tidak boleh kosong.');
    }

    const startTime = performance.now();
    const token = this.getToken();

    if (!token && typeof this.onAuthRequired === 'function') {
      await this.onAuthRequired();
    }

    const activeToken = this.getToken();
    if (!activeToken) {
      throw new Error('Autentikasi diperlukan. Masukkan PIN akses VisionX untuk menggunakan AI Assistant.');
    }

    const controller = new AbortController();
    let isUserAborted = false;
    if (signal) {
      if (signal.aborted) {
        throw new Error('Permintaan dibatalkan.');
      }
      signal.addEventListener('abort', () => {
        isUserAborted = true;
        controller.abort();
      }, { once: true });
    }
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    // Format riwayat percakapan yang bersih
    const formattedHistory = Array.isArray(conversationHistory)
      ? conversationHistory.map(turn => ({
          role: turn.role || (turn.isUser ? 'user' : 'assistant'),
          text: turn.text || turn.content || turn.message || ''
        })).filter(t => Boolean(t.text))
      : [];

    // Format payload sesuai spesifikasi backend gateway
    const payload = {
      message: question.trim(),
      image: image || null,
      vision_context: context || null,
      detections: (detections !== undefined && detections !== null) ? detections : (context?.detections || null),
      history: formattedHistory
    };

    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream, application/json',
          'Authorization': `Bearer ${activeToken}`
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      // Handle HTTP errors
      if (!response.ok) {
        let errorMsg = `Server error (${response.status})`;
        let errData = null;
        try {
          errData = await response.json();
          if (errData && errData.error) errorMsg = errData.error;
        } catch (_) {}

        if (response.status === 401) {
          this.clearToken();
          throw new Error('Sesi autentikasi telah kedaluwarsa atau tidak valid. Silakan masukkan PIN kembali.');
        }
        if (response.status === 403) {
          throw new Error('Akses ditolak (403).');
        }
        if (response.status === 413) {
          throw new Error('Ukuran snapshot citra terlalu besar (maksimal 2MB).');
        }
        if (response.status === 429) {
          throw new Error(errorMsg || 'Terlalu banyak permintaan ke AI Assistant (Rate limit). Harap tunggu beberapa detik.');
        }
        if (response.status >= 500) {
          throw new Error('Server VisionX sedang mengalami kendala internal. Silakan coba kembali sesaat lagi.');
        }
        throw new Error(errorMsg);
      }

      // Check Content-Type untuk menentukan SSE streaming vs JSON response
      const contentType = response.headers.get('content-type') || '';
      let fullAnswer = '';

      if (contentType.includes('text/event-stream') && response.body) {
        // SSE Stream Reader
        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop(); // Pertahankan baris terakhir yang belum lengkap

          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('data: ')) {
              const dataPayload = trimmed.slice(6).trim();
              if (dataPayload === '[DONE]') {
                continue;
              }
              try {
                const parsed = JSON.parse(dataPayload);
                if (parsed.error) {
                  throw new Error(parsed.error);
                }
                if (parsed.text) {
                  fullAnswer += parsed.text;
                  if (typeof onChunk === 'function') {
                    onChunk(parsed.text, fullAnswer);
                  }
                }
              } catch (jsonErr) {
                if (jsonErr.message && !jsonErr.message.includes('JSON')) {
                  throw jsonErr;
                }
              }
            }
          }
        }

        const latencyMs = Math.round(performance.now() - startTime);
        return {
          answer: fullAnswer.trim() || 'Tidak ada teks jawaban yang diterima dari server.',
          provider: 'visionx-gateway',
          latencyMs
        };
      } else {
        // Fallback JSON parser jika server mengembalikan application/json
        const data = await response.json();
        const latencyMs = Math.round(performance.now() - startTime);
        return {
          answer: data.answer || data.message || 'Tidak ada respons dari AI Assistant.',
          provider: data.provider || 'visionx-gateway',
          latencyMs: typeof data.latencyMs === 'number' ? data.latencyMs : latencyMs
        };
      }
    } catch (err) {
      clearTimeout(timeoutId);
      if (err.name === 'AbortError') {
        if (isUserAborted) {
          throw new Error('Permintaan dihentikan oleh pengguna.');
        }
        throw new Error(`Permintaan ke AI Assistant timeout setelah ${this.timeoutMs / 1000} detik.`);
      }
      if (err.name === 'TypeError' && err.message && err.message.includes('fetch')) {
        throw new Error(`Gagal menghubungi gateway VisionX (${this.endpoint}). Pastikan backend server aktif.`);
      }
      throw err;
    }
  }
}

/**
 * MockAIProvider - Mock cerdas untuk pengujian otomatis, evaluasi regresi, dan mode offline
 */
export class MockAIProvider extends AIProvider {
  /**
   * @param {Object} [options={}]
   * @param {string|null} [options.mockAnswer=null] Jawaban kustom jika ingin override
   * @param {number} [options.delayMs=20] Simulasi latensi jaringan (ms)
   * @param {boolean} [options.shouldFail=false] Flag simulasi kegagalan
   * @param {string} [options.errorMessage='Simulated AI Error']
   */
  constructor({ mockAnswer = null, delayMs = 20, shouldFail = false, errorMessage = 'Simulated AI Error' } = {}) {
    super();
    this.mockAnswer = mockAnswer;
    this.delayMs = delayMs;
    this.shouldFail = shouldFail;
    this.errorMessage = errorMessage;
    this.callCount = 0;
    this.lastQuery = null;
  }

  get name() {
    return 'MockAIProvider';
  }

  async askVision({ image, context, question, detections = null, conversationHistory = [], onChunk = null, signal = null }) {
    this.callCount++;
    this.lastQuery = { image, context, question, detections, conversationHistory };

    if (signal && signal.aborted) {
      throw new Error('Permintaan dibatalkan.');
    }

    if (this.delayMs > 0) {
      await new Promise(res => setTimeout(res, this.delayMs));
    }

    if (this.shouldFail) {
      throw new Error(this.errorMessage);
    }

    if (this.mockAnswer) {
      if (typeof onChunk === 'function') {
        const words = this.mockAnswer.split(' ');
        let acc = '';
        for (let i = 0; i < words.length; i++) {
          const piece = words[i] + (i < words.length - 1 ? ' ' : '');
          acc += piece;
          onChunk(piece, acc);
        }
      }
      return {
        answer: this.mockAnswer,
        provider: 'mock-ai-custom',
        latencyMs: this.delayMs
      };
    }

    // Heuristik kontekstual cerdas untuk testing tanpa mockAnswer kustom
    const qLower = (question || '').toLowerCase();
    detections = (detections && detections.length > 0) ? detections : (context?.detections || []);
    const totalObj = detections.length;
    const ocrText = context?.ocr?.text || '';
    const isDeveloper = context?.identity?.is_developer_verified || false;

    let answer = '';

    // Resolusi Komparasi / Ukuran Relatif Objek (Phase D Multi-Turn)
    if (qLower.includes('besar') || qLower.includes('terbesar')) {
      if (totalObj === 0) {
        answer = 'Tidak ada objek yang terdeteksi untuk dibandingkan.';
      } else {
        let largest = detections[0];
        let maxArea = -1;
        for (const d of detections) {
          const b = d.bbox || [0, 0, 0, 0];
          const area = Math.abs((b[2] - b[0]) * (b[3] - b[1]));
          if (area > maxArea) {
            maxArea = area;
            largest = d;
          }
        }
        answer = `Objek dengan ukuran paling besar adalah ${largest.class_name} di area ${largest.relative_position || 'tengah'}.`;
      }
    } else if (qLower.includes('kecil') || qLower.includes('terkecil')) {
      if (totalObj === 0) {
        answer = 'Tidak ada objek yang terdeteksi untuk dibandingkan.';
      } else {
        let smallest = detections[0];
        let minArea = Infinity;
        for (const d of detections) {
          const b = d.bbox || [0, 0, 0, 0];
          const area = Math.abs((b[2] - b[0]) * (b[3] - b[1]));
          if (area < minArea) {
            minArea = area;
            smallest = d;
          }
        }
        answer = `Objek dengan ukuran paling kecil adalah ${smallest.class_name} di area ${smallest.relative_position || 'tengah'}.`;
      }
    } else if (qLower.includes('posisinya') || qLower.includes('posisi di mana') || qLower.includes('di mana letaknya')) {
      // Pertanyaan posisi merujuk ke topik sebelumnya dalam percakapan
      let refClass = null;
      if (conversationHistory && conversationHistory.length > 0) {
        for (let i = conversationHistory.length - 1; i >= 0; i--) {
          const turnContent = conversationHistory[i].content.toLowerCase();
          for (const d of detections) {
            if (turnContent.includes(d.class_name.toLowerCase())) {
              refClass = d.class_name;
              break;
            }
          }
          if (refClass) break;
        }
      }
      if (!refClass && context?.sceneUnderstanding?.focal_object) {
        refClass = context.sceneUnderstanding.focal_object.class_name;
      }

      if (refClass) {
        const found = detections.find(d => d.class_name.toLowerCase() === refClass.toLowerCase());
        const zone = found ? found.relative_position : 'tengah';
        answer = `Posisi ${refClass} berada di area ${zone} layar.`;
      } else {
        answer = 'Belum ada objek spesifik yang menjadi topik rujukan sebelumnya.';
      }
    } else if ((qLower.includes('tadi') || qLower.includes('sebelumnya') || qLower.includes('barusan')) && !qLower.includes('berubah')) {
      // Pertanyaan retrospektif percakapan ("apa yang tadi dibahas?", "tadi ada apa?")
      if (!conversationHistory || conversationHistory.length === 0) {
        answer = 'Belum ada percakapan atau objek sebelumnya yang tercatat dalam sesi ini.';
      } else {
        const lastUser = conversationHistory.find(t => t.role === 'user');
        const lastAssistant = conversationHistory.slice().reverse().find(t => t.role === 'assistant');
        if (lastAssistant) {
          answer = `Sebelumnya kita membahas pertanyaan "${lastUser?.content || ''}" dengan ringkasan: ${lastAssistant.content}`;
        } else {
          answer = 'Belum ada riwayat percakapan yang cukup untuk dirujuk.';
        }
      }
    } else if (qLower.includes('teks') || qLower.includes('baca') || qLower.includes('tulisan')) {
      if (ocrText) {
        answer = `Teks yang terbaca pada kamera adalah: "${ocrText}".`;
      } else {
        answer = 'Saat ini tidak terdeteksi teks atau tulisan pada objek di depan kamera.';
      }
    } else if (qLower.includes('siapa') || qLower.includes('orang') || qLower.includes('wajah')) {
      if (isDeveloper) {
        answer = `Saya mengenali Anda sebagai ${context.identity.profile_name} (terverifikasi dengan skor ${(context.identity.similarity_score * 100).toFixed(0)}%).`;
      } else if (detections.some(d => d.class_name === 'person')) {
        answer = 'Terdeteksi seseorang di depan kamera, namun wajah belum terverifikasi sebagai pengembang.';
      } else {
        answer = 'Tidak terdeteksi ada orang atau wajah di depan kamera.';
      }
    } else if (qLower.includes('berapa') || qLower.includes('jumlah')) {
      if (totalObj === 0) {
        answer = 'Tidak ada objek yang terdeteksi saat ini.';
      } else {
        const counts = context?.summary?.class_counts || {};
        const countDesc = Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ');
        answer = `Ada total ${totalObj} objek yang terdeteksi: ${countDesc}.`;
      }
    } else if (qLower.includes('aman') || qLower.includes('bahaya') || qLower.includes('keselamatan') || qLower.includes('peringatan') || qLower.includes('alert')) {
      const safety = context?.safety;
      if (!safety || !safety.is_enabled) {
        answer = 'Sistem keselamatan (Safety Engine) sedang tidak aktif atau tidak tersedia.';
      } else if (safety.active_alerts_count > 0) {
        const alertDesc = safety.active_alerts.map(a => `${a.title} (${a.message})`).join('; ');
        answer = `Perhatian: Tingkat risiko saat ini ${safety.risk_level}. Terdapat ${safety.active_alerts_count} peringatan: ${alertDesc}.`;
      } else {
        answer = `Situasi terpantau aman (Tingkat risiko: ${safety.risk_level}). Tidak ada peringatan keselamatan aktif saat ini.`;
      }
    } else if (qLower.includes('situasi') || qLower.includes('kondisi') || qLower.includes('suasana') || qLower.includes('padat') || qLower.includes('fokus') || qLower.includes('sebelah') || qLower.includes('posisi')) {
      const su = context?.sceneUnderstanding;
      if (su && su.spatial_narrative) {
        answer = su.spatial_narrative;
      } else {
        answer = 'Analisis situasi spasial belum tersedia.';
      }
    } else {
      // Pertanyaan umum ("ada apa", "apa di depan")
      if (totalObj === 0 && !ocrText) {
        answer = 'Saya melihat ke arah kamera dan saat ini tidak ada objek atau teks yang terdeteksi dengan jelas.';
      } else {
        const parts = [];
        if (totalObj > 0) {
          const objNames = detections.map(d => `${d.class_name} di bagian ${d.relative_position}`).join(', ');
          parts.push(`Saya melihat ${totalObj} objek: ${objNames}`);
        }
        if (ocrText) {
          parts.push(`Terdapat juga teks bertuliskan "${ocrText}"`);
        }
        if (isDeveloper) {
          parts.push('dan saya mendeteksi kehadiran Anda sebagai VisionX Developer');
        }
        answer = parts.join(', ') + '.';
      }
    }

    if (typeof onChunk === 'function') {
      const words = answer.split(' ');
      let acc = '';
      for (let i = 0; i < words.length; i++) {
        const piece = words[i] + (i < words.length - 1 ? ' ' : '');
        acc += piece;
        onChunk(piece, acc);
      }
    }

    return {
      answer,
      provider: 'mock-ai-assistant',
      latencyMs: this.delayMs
    };
  }
}

/**
 * Factory helper pembuatan AI Provider
 */
export function createAIProvider(type = 'backend', options = {}) {
  switch (type.toLowerCase()) {
    case 'mock':
      return new MockAIProvider(options);
    case 'backend':
    default:
      return new BackendAIProvider(options);
  }
}
