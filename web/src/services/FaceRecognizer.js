/**
 * FaceRecognizer.js - Face Recognition & Identity Matching Service (V0.6.2)
 *
 * Mengelola ekstraksi feature embeddings SFace dan pencocokan cosine similarity
 * terhadap foto referensi pengembang ("VisionX Developer"):
 *
 * Aturan Performa:
 * - Tidak dijalankan pada setiap frame; dijalankan pada rate terkonfigurasi (misal setiap N frame atau ~280ms)
 * - Hasil identitas terakhir disimpan dan digunakan kembali (reused) oleh DetectionFusion
 *   antara tick inferensi, sementara kotak wajah tetap bergerak realtime frame-by-frame.
 *
 * Aturan Privasi & Keamanan:
 * - Wajah yang terdaftar dan skor >= threshold diberi label "VISIONX DEVELOPER <score_percent>"
 * - Wajah tidak cocok atau tidak terdaftar diberi label "PERSON • UNKNOWN"
 * - Tidak pernah menyimpulkan nama untuk orang yang tidak terdaftar.
 */

import { isLocalDev } from './apiConfig.js';

export class FaceRecognizer {
  constructor(identityService, frameSource) {
    this.identityService = identityService;
    this.frameSource = frameSource;

    this.isActive = true;
    this.status = 'ready'; // 'ready' | 'matching' | 'error' | 'disabled'
    this.errorMessage = null;

    // Konfigurasi performa: 1000ms lokal dev, 2500ms di remote/tunnel
    this.frameCounter = 0;
    this.lastMatchTime = 0;
    this.isMatching = false;
    this.lastLatencyMs = 0;

    // Cache identitas terakhir per wajah { label, score_percent, similarity, identityStatus, matched }
    this.latestIdentity = {
      label: 'Person',
      score_percent: '',
      similarity: 0.0,
      identityStatus: 'UNREGISTERED',
      matched: false,
      timestamp: 0
    };

    // Statistik diagnostik
    this.identityMatchesCount = 0;
    this.totalFacesCheckedCount = 0;
  }

  /**
   * Mengambil identitas terakhir yang disimpan di cache (untuk digunakan frame-by-frame).
   */
  getLatestIdentity() {
    return { ...this.latestIdentity };
  }

  /**
   * Menjalankan pengenalan identitas wajah secara non-blocking di latar belakang.
   * Mengembalikan identitas terakhir seketika tanpa menahan render loop.
   * @param {Array} detectedFaces Hasil deteksi bounding box dari FaceDetector
   * @param {Object} letterboxedFrame Frame terstandarisasi dari FrameSource
   */
  async recognize(detectedFaces, letterboxedFrame) {
    if (!this.isActive) {
      this.status = 'disabled';
      return this.latestIdentity;
    }

    if (!letterboxedFrame) {
      return this.latestIdentity;
    }

    const hasFaces = Array.isArray(detectedFaces) && detectedFaces.length > 0;
    const now = performance.now();

    // Grace period: jangan langsung reset identitas jika wajah sempat hilang 1-2 frame
    if (!hasFaces) {
      if (Date.now() - (this.latestIdentity.timestamp || 0) > 4000) {
        this.latestIdentity = {
          label: 'Person',
          score_percent: '',
          similarity: 0.0,
          identityStatus: 'UNREGISTERED',
          matched: false,
          timestamp: Date.now()
        };
      }
      return this.latestIdentity;
    }

    this.frameCounter++;

    // Throttled matching interval: 1000ms lokal, 2500ms remote
    const minIntervalMs = isLocalDev ? 1000 : 2500;
    const shouldRun = (now - this.lastMatchTime >= minIntervalMs);
    if (shouldRun && !this.isMatching) {
      this.isMatching = true;
      this.lastMatchTime = now;
      this._runMatchAsync(letterboxedFrame).finally(() => {
        this.isMatching = false;
      });
    }

    return this.latestIdentity;
  }

  async _runMatchAsync(letterboxedFrame) {
    const startTime = performance.now();
    try {
      this.status = 'matching';
      const dataUrl = letterboxedFrame.canvas.toDataURL('image/jpeg', 0.65);

      const res = await this.identityService.matchFace(dataUrl, this.identityService.threshold);
      this.lastLatencyMs = Math.round(performance.now() - startTime);
      this.totalFacesCheckedCount++;

      if (res && res.detected && res.primary_match) {
        const pm = res.primary_match;
        const isMatch = Boolean(pm.matched);
        const scorePercent = pm.score_percent || `${Math.round((pm.similarity || 0) * 100)}%`;
        const similarity = Number(pm.similarity) || 0;

        let label = 'Person';
        let identityStatus = 'UNREGISTERED';

        if (isMatch) {
          label = `Person — Developer VisionX (${scorePercent})`.trim();
          identityStatus = 'REGISTERED';
          this.identityMatchesCount++;
        } else {
          label = 'Person';
          identityStatus = 'UNREGISTERED';
        }

        this.latestIdentity = {
          label,
          score_percent: scorePercent,
          similarity,
          identityStatus,
          matched: isMatch,
          timestamp: Date.now()
        };
        this.status = 'ready';
        this.errorMessage = null;
      } else {
        this.status = 'ready';
      }
    } catch (err) {
      this.status = 'error';
      this.errorMessage = err.message || 'Identity matching error';
      // Cooldown 5 detik bila terjadi error
      this.lastMatchTime = performance.now() + 5000;
      console.warn('[VisionX FaceRecognizer Warning]', err.message);
    }
  }

  /**
   * Mengaktifkan atau menonaktifkan Face Recognizer.
   */
  setEnabled(enabled) {
    this.isActive = Boolean(enabled);
    if (!this.isActive) {
      this.status = 'disabled';
    } else {
      this.status = 'ready';
    }
  }
}
