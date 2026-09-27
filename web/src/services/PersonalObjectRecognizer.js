/**
 * PersonalObjectRecognizer.js - VisionX V1.2 Lightweight Visual Embedding & Personal Recognition
 *
 * Mengidentifikasi apakah objek hasil deteksi YOLO merupakan objek personal milik user:
 * - Menghasilkan 128-d L2-normalized visual embedding berbasis Spatial Color & Texture Gradient.
 * - Menghitung Cosine Similarity terhadap reference embeddings yang terdaftar di PersonalObjectRegistry.
 * - Status Identitas:
 *     - 'PERSONALIZED': Similarity >= Threshold (e.g. "My Laptop")
 *     - 'UNKNOWN_MATCH': Threshold - 0.15 <= Similarity < Threshold (e.g. "Laptop • possible match")
 *     - 'GENERIC': Similarity < Threshold - 0.15 atau belum terdaftar (e.g. "Laptop")
 * - Caching & Throttling berbasis Track ID:
 *     - Tidak melakukan ekstraksi embedding setiap frame.
 *     - Identitas personal melekat pada Track ID dan di-cache selama interval tertentu (1500ms).
 * - Zero Forced Match: Jika kemiripan tidak memenuhi threshold, tidak pernah memaksakan match.
 */

export const PersonalIdentityStatus = {
  GENERIC: 'GENERIC',
  PERSONALIZED: 'PERSONALIZED',
  UNKNOWN_MATCH: 'UNKNOWN_MATCH'
};

export class PersonalObjectRecognizer {
  /**
   * @param {Object} personalObjectRegistry Instance PersonalObjectRegistry
   * @param {Object} [config={}]
   */
  constructor(personalObjectRegistry, config = {}) {
    this.registry = personalObjectRegistry;
    this.config = {
      defaultThreshold: 0.75,
      unknownMatchMargin: 0.15,
      throttleIntervalMs: 1500, // Cek embedding per track setiap 1500ms
      standardSize: 64,         // Normalisasi ukuran crop 64x64 pixel
      gridSize: 4,              // 4x4 spatial grid (16 cells)
      ...config
    };

    // Cache per trackId: trackId -> { identityStatus, personalizedName, matchConfidence, matchedObject, lastCheckTime }
    this.trackIdentityCache = new Map();
    this.totalRecognitions = 0;
    this.totalMatches = 0;
  }

  /**
   * Helper: Konversi RGB ke HSV
   * @private
   */
  static rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    let h = 0;
    const s = max === 0 ? 0 : d / max;
    const v = max;

    if (max !== min) {
      switch (max) {
        case r: h = (g - b) / d + (g < b ? 6 : 0); break;
        case g: h = (b - r) / d + 2; break;
        case b: h = (r - g) / d + 4; break;
      }
      h /= 6;
    }
    return [h, s, v];
  }

  /**
   * Ekstraksi 128-dimensional L2-normalized embedding dari array piksel RGBA.
   * Bersifat murni JavaScript sehingga dapat berjalan di browser maupun Node.js (unit tests).
   * @param {Uint8ClampedArray|Array<number>} pixels Data piksel RGBA (w * h * 4)
   * @param {number} width Lebar gambar
   * @param {number} height Tinggi gambar
   * @returns {Array<number>} 128-dimensional normalized embedding
   */
  static extractEmbeddingFromPixels(pixels, width, height) {
    if (!pixels || width <= 0 || height <= 0) {
      return new Array(128).fill(0);
    }

    const gridSize = 4; // 4x4 cells
    const cellW = width / gridSize;
    const cellH = height / gridSize;
    const features = [];

    // 1. Ekstraksi Fitur Warna & Tekstur per Cell (8 fitur x 16 cell = 128 dimensi)
    for (let gy = 0; gy < gridSize; gy++) {
      for (let gx = 0; gx < gridSize; gx++) {
        const startX = Math.floor(gx * cellW);
        const endX = Math.floor((gx + 1) * cellW);
        const startY = Math.floor(gy * cellH);
        const endY = Math.floor((gy + 1) * cellH);

        let sumSinH = 0;
        let sumCosH = 0;
        let sumS = 0;
        let sumV = 0;
        let count = 0;
        const vValues = [];

        // Sobel gradient energy horizontal & vertical
        let gradH = 0;
        let gradV = 0;

        for (let y = startY; y < endY; y++) {
          for (let x = startX; x < endX; x++) {
            const idx = (y * width + x) * 4;
            const r = pixels[idx];
            const g = pixels[idx + 1];
            const b = pixels[idx + 2];

            const [h, s, v] = PersonalObjectRecognizer.rgbToHsv(r, g, b);
            const angle = h * 2 * Math.PI;
            sumSinH += Math.sin(angle);
            sumCosH += Math.cos(angle);
            sumS += s;
            sumV += v;
            vValues.push(v);
            count++;

            // Simple gradient calculation
            if (x < width - 1) {
              const rRight = pixels[(y * width + (x + 1)) * 4];
              gradH += Math.abs(r - rRight) / 255;
            }
            if (y < height - 1) {
              const rDown = pixels[((y + 1) * width + x) * 4];
              gradV += Math.abs(r - rDown) / 255;
            }
          }
        }

        if (count === 0) {
          features.push(0, 0, 0, 0, 0, 0, 0, 0);
          continue;
        }

        const avgSinH = sumSinH / count;
        const avgCosH = sumCosH / count;
        const avgS = sumS / count;
        const avgV = sumV / count;

        // V variance / contrast
        let varV = 0;
        for (const val of vValues) {
          varV += Math.pow(val - avgV, 2);
        }
        const stdV = Math.sqrt(varV / count);

        // Brightness histogram bin (low vs high)
        const highRatio = vValues.filter(v => v > 0.6).length / count;

        const avgGradH = gradH / count;
        const avgGradV = gradV / count;

        // 8 fitur per cell
        features.push(
          avgSinH,
          avgCosH,
          avgS,
          avgV,
          stdV,
          highRatio,
          avgGradH,
          avgGradV
        );
      }
    }

    // 2. L2 Normalization: ||features|| = 1.0
    let sumSq = 0;
    for (let i = 0; i < features.length; i++) {
      sumSq += features[i] * features[i];
    }
    const norm = Math.sqrt(sumSq) + 1e-7;

    const normalized = new Array(features.length);
    for (let i = 0; i < features.length; i++) {
      normalized[i] = Math.round((features[i] / norm) * 10000) / 10000;
    }

    return normalized;
  }

  /**
   * Ekstraksi visual embedding dari elemen Canvas atau Video
   * @param {HTMLCanvasElement|HTMLVideoElement|Object} source Element sumber
   * @param {Array<number>} [bbox=null] [x1, y1, x2, y2]
   * @returns {Array<number>}
   */
  static extractEmbeddingFromCanvas(source, bbox = null) {
    if (typeof document === 'undefined') {
      // Fallback jika dijalankan di environment Node.js tanpa DOM
      return new Array(128).fill(0);
    }

    try {
      const sw = source.videoWidth || source.width || 640;
      const sh = source.videoHeight || source.height || 480;

      let sx = 0, sy = 0, sCropW = sw, sCropH = sh;
      if (Array.isArray(bbox) && bbox.length === 4) {
        sx = Math.max(0, Math.floor(bbox[0]));
        sy = Math.max(0, Math.floor(bbox[1]));
        sCropW = Math.min(sw - sx, Math.max(1, Math.floor(bbox[2] - bbox[0])));
        sCropH = Math.min(sh - sy, Math.max(1, Math.floor(bbox[3] - bbox[1])));
      }

      // Gunakan offscreen canvas berukuran standar 64x64
      const canvas = document.createElement('canvas');
      canvas.width = 64;
      canvas.height = 64;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return new Array(128).fill(0);

      ctx.drawImage(source, sx, sy, sCropW, sCropH, 0, 0, 64, 64);
      const imgData = ctx.getImageData(0, 0, 64, 64);

      return PersonalObjectRecognizer.extractEmbeddingFromPixels(imgData.data, 64, 64);
    } catch (err) {
      console.warn('[PersonalObjectRecognizer] Gagal ekstraksi embedding dari canvas:', err);
      return new Array(128).fill(0);
    }
  }

  /**
   * Menghitung Cosine Similarity antara dua embedding vector yang ternormalisasi
   * @param {Array<number>} vecA
   * @param {Array<number>} vecB
   * @returns {number} Nilai kemiripan antara -1.0 dan 1.0 (biasanya 0.0 - 1.0)
   */
  static cosineSimilarity(vecA, vecB) {
    if (!Array.isArray(vecA) || !Array.isArray(vecB) || vecA.length === 0 || vecB.length === 0) {
      return 0;
    }

    const len = Math.min(vecA.length, vecB.length);
    let dot = 0;
    for (let i = 0; i < len; i++) {
      dot += vecA[i] * vecB[i];
    }

    return Math.max(-1.0, Math.min(1.0, dot));
  }

  /**
   * Evaluasi kemiripan visual sebuah deteksi terhadap objek yang terdaftar di registry
   * @param {Object} detection { class_name, bbox, confidence, trackId }
   * @param {Array<number>} [cropEmbedding=null] Embedding yang sudah diekstrak (atau diekstrak dari canvas)
   * @param {HTMLCanvasElement|HTMLVideoElement|null} [frameSource=null]
   * @returns {Object} { identityStatus, personalizedName, matchConfidence, matchedObject }
   */
  recognizeDetection(detection, cropEmbedding = null, frameSource = null) {
    this.totalRecognitions++;

    const baseClass = String(detection.class_name || detection.className || '').toLowerCase().trim();
    if (!baseClass || !this.registry) {
      return {
        identityStatus: PersonalIdentityStatus.GENERIC,
        personalizedName: null,
        matchConfidence: 0,
        matchedObject: null
      };
    }

    // Ambil kandidat terdaftar yang aktif dan memiliki baseClass yang sama
    const candidates = this.registry.getEnabled(baseClass);
    if (candidates.length === 0) {
      return {
        identityStatus: PersonalIdentityStatus.GENERIC,
        personalizedName: null,
        matchConfidence: 0,
        matchedObject: null
      };
    }

    // Ekstraksi embedding jika belum tersedia
    let embedding = cropEmbedding;
    if (!embedding && frameSource) {
      embedding = PersonalObjectRecognizer.extractEmbeddingFromCanvas(frameSource, detection.bbox);
    }

    if (!Array.isArray(embedding) || embedding.length === 0) {
      return {
        identityStatus: PersonalIdentityStatus.GENERIC,
        personalizedName: null,
        matchConfidence: 0,
        matchedObject: null
      };
    }

    // Cari kandidat dengan similarity tertinggi di antara semua foto referensinya
    let bestCandidate = null;
    let bestSim = -1;

    for (const candidate of candidates) {
      if (!Array.isArray(candidate.references) || candidate.references.length === 0) {
        continue;
      }

      for (const ref of candidate.references) {
        if (!Array.isArray(ref.embedding) || ref.embedding.length === 0) continue;
        const sim = PersonalObjectRecognizer.cosineSimilarity(embedding, ref.embedding);
        if (sim > bestSim) {
          bestSim = sim;
          bestCandidate = candidate;
        }
      }
    }

    if (!bestCandidate || bestSim < 0) {
      return {
        identityStatus: PersonalIdentityStatus.GENERIC,
        personalizedName: null,
        matchConfidence: 0,
        matchedObject: null
      };
    }

    const threshold = typeof bestCandidate.threshold === 'number'
      ? bestCandidate.threshold
      : this.config.defaultThreshold;

    const roundedSim = Math.round(bestSim * 100) / 100;

    // Evaluasi Ambang Batas Identitas (Zero Forced Match)
    if (bestSim >= threshold) {
      this.totalMatches++;
      return {
        identityStatus: PersonalIdentityStatus.PERSONALIZED,
        personalizedName: bestCandidate.name,
        matchConfidence: roundedSim,
        matchedObject: {
          id: bestCandidate.id,
          name: bestCandidate.name,
          baseClass: bestCandidate.baseClass
        }
      };
    } else if (bestSim >= (threshold - this.config.unknownMatchMargin)) {
      // Possible match (kemiripan mendekati threshold namun belum yakin)
      const genericClassLabel = baseClass.charAt(0).toUpperCase() + baseClass.slice(1).replace('_', ' ');
      return {
        identityStatus: PersonalIdentityStatus.UNKNOWN_MATCH,
        personalizedName: `${genericClassLabel} • possible match`,
        matchConfidence: roundedSim,
        matchedObject: null
      };
    }

    // Similarity di bawah margin -> Tetap Generic
    return {
      identityStatus: PersonalIdentityStatus.GENERIC,
      personalizedName: null,
      matchConfidence: roundedSim,
      matchedObject: null
    };
  }

  /**
   * Integrasi dengan TrackingEngine:
   * Mengenali dan melampirkan identitas personal pada list objek yang sedang ditrack.
   * Menggunakan caching dan throttling agar tidak memberatkan realtime frame loop.
   *
   * @param {Array<Object>} tracks List TrackedObject aktif
   * @param {HTMLCanvasElement|HTMLVideoElement|null} frameSource
   * @returns {Array<Object>} List tracks yang telah diperkaya dengan identitas personal
   */
  processTracks(tracks = [], frameSource = null) {
    if (!Array.isArray(tracks) || tracks.length === 0) {
      return [];
    }

    const now = Date.now();
    const currentTrackIds = new Set();

    for (const track of tracks) {
      const trackId = track.trackId;
      if (trackId === undefined || trackId === null) continue;
      currentTrackIds.add(trackId);

      const cached = this.trackIdentityCache.get(trackId);
      const isThrottled = cached && (now - cached.lastCheckTime < this.config.throttleIntervalMs);

      if (isThrottled) {
        // Gunakan identitas yang tersimpan di cache
        track.identityStatus = cached.identityStatus;
        track.personalizedName = cached.personalizedName;
        track.matchConfidence = cached.matchConfidence;
        track.personalObjectId = cached.matchedObject ? cached.matchedObject.id : null;
      } else {
        // Waktunya melakukan inferensi visual embedding
        const result = this.recognizeDetection(track, null, frameSource);

        const cacheEntry = {
          ...result,
          lastCheckTime: now
        };
        this.trackIdentityCache.set(trackId, cacheEntry);

        track.identityStatus = result.identityStatus;
        track.personalizedName = result.personalizedName;
        track.matchConfidence = result.matchConfidence;
        track.personalObjectId = result.matchedObject ? result.matchedObject.id : null;
      }
    }

    // Bersihkan cache dari track yang sudah tidak aktif
    for (const cachedTrackId of this.trackIdentityCache.keys()) {
      if (!currentTrackIds.has(cachedTrackId)) {
        this.trackIdentityCache.delete(cachedTrackId);
      }
    }

    return tracks;
  }

  /**
   * Reset cache identitas tracking
   */
  resetCache() {
    this.trackIdentityCache.clear();
  }

  /**
   * Statistik performa recognizer
   */
  getDiagnostics() {
    return {
      activeCachedTracks: this.trackIdentityCache.size,
      totalRecognitions: this.totalRecognitions,
      totalMatches: this.totalMatches,
      throttleIntervalMs: this.config.throttleIntervalMs
    };
  }
}
