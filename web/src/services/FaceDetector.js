/**
 * FaceDetector.js - Realtime Face Detection Service (V0.6.2)
 *
 * Mengelola deteksi wajah pada rate realtime menggunakan YuNet backend service:
 * - Menerima frame terstandarisasi dari FrameSource (letterbox 640x640)
 * - Mentransformasi koordinat kembali ke ruang video menggunakan CoordinateMapper
 * - Melakukan tracking posisi kotak wajah frame-by-frame
 * - Sepenuhnya terisolasi dari ObjectDetector (YOLO) — kegagalan FaceDetector tidak menghentikan YOLO
 */

import { CoordinateMapper } from './CoordinateMapper.js';
import { isLocalDev } from './apiConfig.js';

export class FaceDetector {
  constructor(identityService, frameSource) {
    this.identityService = identityService;
    this.frameSource = frameSource;

    this.isActive = true;
    this.status = 'ready'; // 'ready' | 'detecting' | 'error' | 'disabled'
    this.errorMessage = null;

    this.currentFaces = [];
    this.lastLatencyMs = 0;
    this.totalDetectionsCount = 0;
    this.isDetecting = false;
    this.lastDetectTime = 0;

    // Tracking face ID & smoothing
    this._nextFaceId = 1;
    this._trackedFaces = new Map();
  }

  /**
   * Menjalankan deteksi wajah pada frame aktif secara non-blocking.
   * Mengembalikan deteksi wajah aktif terakhir secara instan dan memperbarui deteksi di latar belakang
   * sehingga render loop utama (YOLO) tetap berjalan mulus pada 60 FPS tanpa drop frame.
   * @param {Object} letterboxedFrame Frame dari FrameSource.getLetterboxedFrame()
   */
  async detect(letterboxedFrame) {
    if (!this.isActive) {
      this.status = 'disabled';
      this.currentFaces = [];
      return [];
    }

    if (!letterboxedFrame) {
      return this.currentFaces;
    }

    const now = performance.now();
    // Non-blocking throttling: 600ms lokal dev, 2000ms di remote/tunnel agar tidak membebani jaringan/FPS
    const minIntervalMs = isLocalDev ? 600 : 2000;
    if (!this.isDetecting && (now - this.lastDetectTime >= minIntervalMs)) {
      this.isDetecting = true;
      this.lastDetectTime = now;
      this._runDetectAsync(letterboxedFrame).finally(() => {
        this.isDetecting = false;
      });
    }

    // Selalu kembalikan hasil aktif terakhir secara instan tanpa memblokir render loop
    return this.currentFaces;
  }

  async _runDetectAsync(letterboxedFrame) {
    const startTime = performance.now();
    try {
      const { canvas, params, isMirrored } = letterboxedFrame;
      const dataUrl = canvas.toDataURL('image/jpeg', 0.65);

      const res = await this.identityService.detectFaces(dataUrl);
      this.lastLatencyMs = Math.round(performance.now() - startTime);

      if (res && res.success && Array.isArray(res.faces)) {
        this.status = 'ready';
        this.errorMessage = null;

        // Transformasi koordinat dari letterbox 640x640 ke resolusi video asli
        const mappedFaces = res.faces.map((f, idx) => {
          const modelBox = f.bbox || {
            x1: f.box[0],
            y1: f.box[1],
            x2: f.box[0] + f.box[2],
            y2: f.box[1] + f.box[3]
          };

          const videoBbox = CoordinateMapper.modelToVideo(modelBox, params, isMirrored);

          return {
            id: `face_${idx + 1}`,
            bbox: videoBbox,
            confidence: f.confidence || 0.9,
            timestamp: Date.now()
          };
        });

        this.currentFaces = mappedFaces;
        this.totalDetectionsCount = mappedFaces.length;
      } else {
        this.currentFaces = [];
        this.totalDetectionsCount = 0;
        this.status = 'ready';
      }
    } catch (err) {
      this.status = 'error';
      this.errorMessage = err.message || 'Face detection error';
      // Terapkan cooldown 5 detik bila terjadi error jaringan/backend
      this.lastDetectTime = performance.now() + 5000;
      console.warn('[VisionX FaceDetector Warning]', err.message);
    }
  }

  /**
   * Mengatur status aktif/nonaktif deteksi wajah.
   */
  setEnabled(enabled) {
    this.isActive = Boolean(enabled);
    if (!this.isActive) {
      this.status = 'disabled';
      this.currentFaces = [];
    } else {
      this.status = 'ready';
    }
  }
}
