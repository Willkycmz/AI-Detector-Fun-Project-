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

/**
 * BackendAIProvider - Menghubungi backend proxy lokal VisionX (/api/ai/ask-vision)
 * Menjamin API key aman di sisi server/backend proxy dan tidak terekspos ke frontend browser.
 */
export class BackendAIProvider extends AIProvider {
  /**
   * @param {Object} [config={}]
   * @param {string} [config.endpoint='/api/ai/ask-vision']
   * @param {number} [config.timeoutMs=20000]
   */
  constructor(config = {}) {
    super();
    this.endpoint = config.endpoint || '/api/ai/ask-vision';
    this.timeoutMs = config.timeoutMs || 20000;
  }

  get name() {
    return 'BackendAIProvider';
  }

  async askVision({ image, context, question, conversationHistory = [] }) {
    if (!question || typeof question !== 'string' || question.trim().length === 0) {
      throw new Error('Pertanyaan tidak boleh kosong.');
    }

    const startTime = performance.now();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          image: image || null,
          context: context || null,
          question: question.trim(),
          conversation_history: Array.isArray(conversationHistory) ? conversationHistory : []
        }),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        let errorMsg = `Server error (${response.status})`;
        try {
          const errData = await response.json();
          if (errData && errData.error) errorMsg = errData.error;
        } catch (_) {}
        throw new Error(errorMsg);
      }

      const data = await response.json();
      const latencyMs = Math.round(performance.now() - startTime);

      return {
        answer: data.answer || 'Tidak ada jawaban dari AI Assistant.',
        provider: data.provider || 'visionx-backend',
        latencyMs: typeof data.latencyMs === 'number' ? data.latencyMs : latencyMs
      };
    } catch (err) {
      clearTimeout(timeoutId);
      if (err.name === 'AbortError') {
        throw new Error(`Permintaan ke AI Assistant timeout setelah ${this.timeoutMs / 1000} detik.`);
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

  async askVision({ image, context, question, conversationHistory = [] }) {
    this.callCount++;
    this.lastQuery = { image, context, question, conversationHistory };

    if (this.delayMs > 0) {
      await new Promise(res => setTimeout(res, this.delayMs));
    }

    if (this.shouldFail) {
      throw new Error(this.errorMessage);
    }

    if (this.mockAnswer) {
      return {
        answer: this.mockAnswer,
        provider: 'mock-ai-custom',
        latencyMs: this.delayMs
      };
    }

    // Heuristik kontekstual cerdas untuk testing tanpa mockAnswer kustom
    const qLower = (question || '').toLowerCase();
    const detections = context?.detections || [];
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
