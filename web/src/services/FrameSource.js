/**
 * FrameSource.js - Frame Provider & Preprocessing Abstraction (V0.6.2)
 *
 * Mengabstraksikan sumber frame kamera dari CameraService untuk diproses oleh:
 * - ObjectDetector (YOLO)
 * - FaceDetector (YuNet)
 * - FaceRecognizer (SFace)
 *
 * Menyediakan canvas letterbox 640x640 terpadu yang digunakan bersama oleh YOLO dan Face Engine,
 * menjamin sinkronisasi koordinat frame-by-frame.
 */

import { CoordinateMapper } from './CoordinateMapper.js';

export class FrameSource {
  constructor(cameraService) {
    this.cameraService = cameraService;
    this.videoElement = cameraService?.videoElement || null;
    this._isMirrored = false;

    // Canvas pre-processing bersama 640x640 (standard YOLO & YuNet input)
    this.letterboxCanvas = document.createElement('canvas');
    this.letterboxCanvas.width = 640;
    this.letterboxCanvas.height = 640;
    this.letterboxCtx = this.letterboxCanvas.getContext('2d', { willReadFrequently: true });

    // Canvas kecil terpisah untuk ekstraksi citra wajah/crop
    this.faceCropCanvas = document.createElement('canvas');
    this.faceCropCtx = this.faceCropCanvas.getContext('2d', { willReadFrequently: true });
  }

  attachVideoElement(videoEl) {
    this.videoElement = videoEl;
  }

  get isMirrored() {
    return this._isMirrored;
  }

  set isMirrored(val) {
    this._isMirrored = Boolean(val);
    
    // Toggle class scale-x-[-1] pada CONTAINER wrapper video dan canvas secara bersamaan
    const containers = [
      document.getElementById('stageVideoContainer'),
      document.querySelector('.camera-modal-viewport'),
      this.videoElement?.parentElement
    ];
    containers.forEach(container => {
      if (container) {
        container.classList.toggle('scale-x-[-1]', this._isMirrored);
        container.classList.toggle('mirrored', this._isMirrored);
      }
    });

    if (this.videoElement) {
      if (this._isMirrored) {
        this.videoElement.classList.add('mirrored');
      } else {
        this.videoElement.classList.remove('mirrored');
      }
    }
  }

  toggleMirror() {
    this.isMirrored = !this.isMirrored;
    return this.isMirrored;
  }

  /**
   * Memeriksa apakah video aktif dan siap dibaca frame-nya.
   */
  isReady() {
    if (!this.videoElement) return false;
    return (
      this.videoElement.readyState >= 2 &&
      !this.videoElement.paused &&
      !this.videoElement.ended &&
      this.videoElement.videoWidth > 0 &&
      this.videoElement.videoHeight > 0
    );
  }

  /**
   * Mendapatkan dimensi asli resolusi kamera video.
   */
  getDimensions() {
    if (!this.videoElement) return { width: 0, height: 0, aspect: 1, aspectLabel: 'Unknown' };
    const w = this.videoElement.videoWidth || 640;
    const h = this.videoElement.videoHeight || 480;
    const aspect = w / h;
    const letterboxParams = CoordinateMapper.computeLetterboxParams(w, h, 640);
    return {
      width: w,
      height: h,
      aspect,
      aspectLabel: letterboxParams.aspectLabel
    };
  }

  /**
   * Menghasilkan frame yang di-letterbox ke 640x640 dengan padding abu-abu standar YOLO (rgb(114,114,114)).
   * Frame ini dipakai bersama oleh YOLO dan Face Detection agar transformasi koordinatnya 100% identik.
   */
  getLetterboxedFrame(targetDim = 640) {
    if (!this.isReady()) return null;

    const vw = this.videoElement.videoWidth;
    const vh = this.videoElement.videoHeight;
    const params = CoordinateMapper.computeLetterboxParams(vw, vh, targetDim);

    if (this.letterboxCanvas.width !== targetDim || this.letterboxCanvas.height !== targetDim) {
      this.letterboxCanvas.width = targetDim;
      this.letterboxCanvas.height = targetDim;
    }

    const ctx = this.letterboxCtx;
    // Standar YOLO background padding rgb(114, 114, 114)
    ctx.fillStyle = 'rgb(114, 114, 114)';
    ctx.fillRect(0, 0, targetDim, targetDim);

    ctx.save();
    // Gambar frame murni tanpa flipping software karena container wrapper (video + canvas)
    // sudah dibalik secara visual oleh CSS transform scale-x-[-1]
    ctx.drawImage(this.videoElement, params.padX, params.padY, params.nw, params.nh);
    ctx.restore();

    return {
      canvas: this.letterboxCanvas,
      ctx,
      params,
      isMirrored: false // Koordinat tetap presisi dalam koordinat video asli
    };
  }

  /**
   * Mengambil cuplikan Data URL base64 JPEG dari canvas letterbox aktif atau video asli.
   */
  captureDataUrl(quality = 0.85) {
    const frame = this.getLetterboxedFrame(640);
    if (!frame) return null;
    return frame.canvas.toDataURL('image/jpeg', quality);
  }

  /**
   * Mengambil crop area wajah tertentu dalam resolusi aslinya.
   */
  cropBboxDataUrl(bbox, quality = 0.90) {
    if (!this.isReady() || !bbox) return null;
    const { x1, y1, x2, y2 } = CoordinateMapper.normalizeBbox(bbox);
    const w = Math.max(1, x2 - x1);
    const h = Math.max(1, y2 - y1);

    this.faceCropCanvas.width = w;
    this.faceCropCanvas.height = h;

    this.faceCropCtx.drawImage(
      this.videoElement,
      x1, y1, w, h,
      0, 0, w, h
    );

    return this.faceCropCanvas.toDataURL('image/jpeg', quality);
  }
}
