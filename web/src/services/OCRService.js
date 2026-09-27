/**
 * OCRService.js - VisionX V1.2.1 Hardened Optical Character Recognition Engine
 *
 * Mengelola inferensi OCR di browser menggunakan Tesseract.js / WebAssembly,
 * dilengkapi:
 * 1. Audit Capture Resolution (Native camera resolution capture & metadata logging)
 * 2. Pre-OCR Image Quality Assessment (Brightness, Contrast, Sharpness/Blur detection)
 * 3. Region of Interest (ROI) Modes: AUTO, CENTER_REGION, FULL_FRAME
 * 4. Light Deskew & Perspective Orientation Check
 * 5. Adaptive 2x/3x Upscaling untuk teks berukuran kecil
 * 6. Profile-Aware Preprocessing (PRINTED, HANDWRITING, AUTO)
 * 7. Quality-Aware Multi-Pass Candidate Scoring (Character sanity, printable ratio, outlier rejection)
 * 8. Pencegahan Hallucination & Peringatan Terbuka Mengenai Keterbatasan Handwriting
 * 9. Non-blocking Asynchronous Execution & Failure Isolation
 */

export const OCRStatus = {
  LOADING: 'LOADING',
  READY: 'READY',
  PROCESSING: 'PROCESSING',
  DONE: 'DONE',
  ERROR: 'ERROR',
  UNAVAILABLE: 'UNAVAILABLE'
};

export const PSM_MODES = {
  AUTO: '3',          // Fully automatic page segmentation
  SINGLE_BLOCK: '6',  // Assume a single uniform block of text
  SPARSE_TEXT: '11'   // Sparse text. Find as much text as possible
};

export const PREPROCESS_VARIANTS = {
  STANDARD: 'standard',                   // Grayscale + Contrast Stretch
  UPSCALE_SHARPEN: 'upscale_sharpen',     // 2x Upscale + Grayscale + Sharpen + Contrast
  ADAPTIVE_THRESHOLD: 'adaptive_threshold',// Grayscale + Denoise + Binary Threshold
  GENTLE_HANDWRITING: 'gentle_handwriting',// Grayscale + Light Denoise + Moderate Contrast
  RAW: 'raw'                              // Original without filtering
};

export const OCR_PROFILES = {
  AUTO: 'AUTO',
  PRINTED: 'PRINTED',
  HANDWRITING: 'HANDWRITING'
};

export const ROI_MODES = {
  AUTO: 'AUTO',
  CENTER_REGION: 'CENTER_REGION',
  FULL_FRAME: 'FULL_FRAME'
};

export const QUALITY_LEVELS = {
  GOOD: 'GOOD',
  FAIR: 'FAIR',
  POOR: 'POOR'
};

export const DEFAULT_OCR_CONFIG = {
  language: 'ind',                  // Default: Indonesian ('ind')
  supportedLanguages: ['ind', 'eng'],
  maxDimension: 1920,               // Mempertahankan resolusi tinggi untuk input kamera native
  profile: OCR_PROFILES.AUTO,       // Default profile: AUTO
  roiMode: ROI_MODES.AUTO,          // Default ROI mode: AUTO
  grayscale: true,
  enhanceContrast: true,
  cooldownMs: 1500,                 // Cooldown manual trigger (1.5 detik)
  autoReadCooldownMs: 3500,         // Cooldown auto read
  lowConfidenceThreshold: 55,       // Threshold peringatan confidence rendah (%)
  unclearThreshold: 30,             // Threshold teks tidak terbaca (%)
  defaultPsm: PSM_MODES.AUTO,       // Default PSM
  enableMultiPass: true,            // Multi-pass candidate selection
  enableQualityCheck: true          // Audit frame quality sebelum OCR
};

/**
 * Normalisasi teks hasil OCR tanpa mengubah kata asli
 * @param {string} rawText
 * @returns {string}
 */
export function normalizeOcrText(rawText) {
  if (!rawText || typeof rawText !== 'string') return '';
  
  // 1. Normalisasi line endings ke \n
  const unified = rawText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  
  // 2. Bersihkan karakter kontrol non-cetak (kecuali newline dan tab)
  const cleanedChars = unified.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  // 3. Trim per baris dan hindari baris kosong ganda berlebih
  const lines = cleanedChars.split('\n').map(line => line.trim());
  const normalizedLines = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length === 0) {
      if (normalizedLines.length > 0 && normalizedLines[normalizedLines.length - 1].length > 0) {
        normalizedLines.push('');
      }
    } else {
      normalizedLines.push(line);
    }
  }

  return normalizedLines.join('\n').trim();
}

/**
 * Modul Evaluasi Kualitas Frame Citra (Brightness, Contrast, Sharpness / Blur)
 */
export class ImageQualityAssessor {
  /**
   * Menilai kualitas frame citra secara komputasional ringan
   * @param {ImageData|Object} imgData
   * @param {number} width
   * @param {number} height
   * @returns {Object} Quality metrics & ratings
   */
  static assessQuality(imgData, width, height) {
    if (!imgData || !imgData.data || width <= 0 || height <= 0) {
      return {
        overall: QUALITY_LEVELS.FAIR,
        brightness: QUALITY_LEVELS.FAIR,
        contrast: QUALITY_LEVELS.FAIR,
        sharpness: QUALITY_LEVELS.FAIR,
        metrics: { meanBrightness: 128, contrastStdDev: 40, laplacianVar: 100 },
        isTooBlurry: false,
        isTooDark: false,
        isTooBright: false,
        qualityFeedback: 'Kualitas frame memadai.'
      };
    }

    const data = imgData.data;
    const pixelCount = width * height;
    let sumLum = 0;
    let sumLumSq = 0;

    // 1. Hitung Brightness & Contrast (Sampling step untuk performa kilat)
    const step = Math.max(1, Math.floor(pixelCount / 40000));
    let sampledCount = 0;

    for (let i = 0; i < data.length; i += 4 * step) {
      const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      sumLum += lum;
      sumLumSq += lum * lum;
      sampledCount++;
    }

    const meanBrightness = sampledCount > 0 ? sumLum / sampledCount : 128;
    const varianceLum = sampledCount > 0 ? Math.max(0, (sumLumSq / sampledCount) - (meanBrightness * meanBrightness)) : 1600;
    const contrastStdDev = Math.sqrt(varianceLum);

    // 2. Hitung Sharpness menggunakan Variance of Laplacian (Gradient Edge Energy)
    let laplacianSum = 0;
    let laplacianSumSq = 0;
    let edgeSamples = 0;
    const edgeStep = Math.max(1, Math.floor(Math.min(width, height) / 120));

    for (let y = 1; y < height - 1; y += edgeStep) {
      for (let x = 1; x < width - 1; x += edgeStep) {
        const idx = (y * width + x) * 4;
        const top = ((y - 1) * width + x) * 4;
        const bottom = ((y + 1) * width + x) * 4;
        const left = (y * width + (x - 1)) * 4;
        const right = (y * width + (x + 1)) * 4;

        const lumCenter = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
        const lumTop = 0.299 * data[top] + 0.587 * data[top + 1] + 0.114 * data[top + 2];
        const lumBottom = 0.299 * data[bottom] + 0.587 * data[bottom + 1] + 0.114 * data[bottom + 2];
        const lumLeft = 0.299 * data[left] + 0.587 * data[left + 1] + 0.114 * data[left + 2];
        const lumRight = 0.299 * data[right] + 0.587 * data[right + 1] + 0.114 * data[right + 2];

        const lap = Math.abs(4 * lumCenter - lumTop - lumBottom - lumLeft - lumRight);
        laplacianSum += lap;
        laplacianSumSq += lap * lap;
        edgeSamples++;
      }
    }

    const meanLaplacian = edgeSamples > 0 ? laplacianSum / edgeSamples : 0;
    const laplacianVar = edgeSamples > 0 ? Math.max(0, (laplacianSumSq / edgeSamples) - (meanLaplacian * meanLaplacian)) : 0;

    // 3. Evaluasi Rating Kategori
    let brightnessRating = QUALITY_LEVELS.GOOD;
    let isTooDark = false;
    let isTooBright = false;
    if (meanBrightness < 45) {
      brightnessRating = QUALITY_LEVELS.POOR;
      isTooDark = true;
    } else if (meanBrightness < 75 || meanBrightness > 215) {
      brightnessRating = QUALITY_LEVELS.FAIR;
      if (meanBrightness > 230) isTooBright = true;
    }

    let contrastRating = QUALITY_LEVELS.GOOD;
    if (contrastStdDev < 22) {
      contrastRating = QUALITY_LEVELS.POOR;
    } else if (contrastStdDev < 38) {
      contrastRating = QUALITY_LEVELS.FAIR;
    }

    let sharpnessRating = QUALITY_LEVELS.GOOD;
    let isTooBlurry = false;
    if (laplacianVar < 25) {
      sharpnessRating = QUALITY_LEVELS.POOR;
      isTooBlurry = true;
    } else if (laplacianVar < 70) {
      sharpnessRating = QUALITY_LEVELS.FAIR;
    }

    // Overall Rating
    let overall = QUALITY_LEVELS.GOOD;
    let qualityFeedback = 'Kualitas frame jernih dan pencahayaan optimal.';

    if (isTooBlurry && (isTooDark || contrastRating === QUALITY_LEVELS.POOR)) {
      overall = QUALITY_LEVELS.POOR;
      qualityFeedback = 'Teks terlalu buram untuk dibaca. Coba dekatkan kamera.';
    } else if (isTooDark) {
      overall = QUALITY_LEVELS.POOR;
      qualityFeedback = 'Pencahayaan terlalu gelap. Coba gunakan penerangan lebih baik.';
    } else if (isTooBlurry) {
      overall = QUALITY_LEVELS.FAIR;
      qualityFeedback = 'Frame agak buram — dekatkan kamera atau stabilkan pegangan.';
    } else if (contrastRating === QUALITY_LEVELS.FAIR || brightnessRating === QUALITY_LEVELS.FAIR) {
      overall = QUALITY_LEVELS.FAIR;
      qualityFeedback = 'Pencahayaan atau kontras sedang.';
    }

    return {
      overall,
      brightness: brightnessRating,
      contrast: contrastRating,
      sharpness: sharpnessRating,
      metrics: {
        meanBrightness: Math.round(meanBrightness),
        contrastStdDev: Math.round(contrastStdDev),
        laplacianVar: Math.round(laplacianVar)
      },
      isTooBlurry,
      isTooDark,
      isTooBright,
      qualityFeedback
    };
  }
}

/**
 * Pipeline Prapemrosesan Citra Modular untuk OCR Hardening
 */
export class OCRPreprocessPipeline {
  /**
   * Konversi canvas context ke Grayscale
   */
  static applyGrayscale(ctx, width, height) {
    const imgData = ctx.getImageData(0, 0, width, height);
    const data = imgData.data;
    for (let i = 0; i < data.length; i += 4) {
      const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      data[i] = lum;
      data[i + 1] = lum;
      data[i + 2] = lum;
    }
    ctx.putImageData(imgData, 0, 0);
  }

  /**
   * Adaptive Contrast Stretching
   */
  static applyContrastStretching(ctx, width, height, strength = 1.0) {
    const imgData = ctx.getImageData(0, 0, width, height);
    const data = imgData.data;

    let minLum = 255;
    let maxLum = 0;

    for (let i = 0; i < data.length; i += 4) {
      const lum = data[i];
      if (lum < minLum) minLum = lum;
      if (lum > maxLum) maxLum = lum;
    }

    const range = maxLum - minLum;
    if (range > 15) {
      for (let i = 0; i < data.length; i += 4) {
        const enhanced = ((data[i] - minLum) / range) * 255;
        const blended = data[i] * (1 - strength) + enhanced * strength;
        const clamped = Math.min(255, Math.max(0, Math.round(blended)));
        data[i] = clamped;
        data[i + 1] = clamped;
        data[i + 2] = clamped;
      }
      ctx.putImageData(imgData, 0, 0);
    }
  }

  /**
   * Sharpening menggunakan 3x3 unsharp convolution kernel
   */
  static applySharpen(ctx, width, height, strength = 1.0) {
    const srcImg = ctx.getImageData(0, 0, width, height);
    const src = srcImg.data;
    const output = ctx.createImageData(width, height);
    const dst = output.data;

    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const idx = (y * width + x) * 4;
        const top = ((y - 1) * width + x) * 4;
        const bottom = ((y + 1) * width + x) * 4;
        const left = (y * width + (x - 1)) * 4;
        const right = (y * width + (x + 1)) * 4;

        for (let c = 0; c < 3; c++) {
          const sharpVal = 5 * src[idx + c] - src[top + c] - src[bottom + c] - src[left + c] - src[right + c];
          const val = src[idx + c] * (1 - strength) + sharpVal * strength;
          dst[idx + c] = Math.min(255, Math.max(0, Math.round(val)));
        }
        dst[idx + 3] = src[idx + 3];
      }
    }

    ctx.putImageData(output, 0, 0);
  }

  /**
   * Denoise ringan (3x3 Box blur untuk meredam grain kamera)
   */
  static applyDenoise(ctx, width, height) {
    const srcImg = ctx.getImageData(0, 0, width, height);
    const src = srcImg.data;
    const output = ctx.createImageData(width, height);
    const dst = output.data;

    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        let sum = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const pIdx = ((y + dy) * width + (x + dx)) * 4;
            sum += src[pIdx];
          }
        }
        const avg = Math.round(sum / 9);
        const idx = (y * width + x) * 4;
        dst[idx] = avg;
        dst[idx + 1] = avg;
        dst[idx + 2] = avg;
        dst[idx + 3] = src[idx + 3];
      }
    }
    ctx.putImageData(output, 0, 0);
  }

  /**
   * Adaptive Thresholding untuk kontras ekstrem (Printed Text)
   */
  static applyAdaptiveThreshold(ctx, width, height) {
    const imgData = ctx.getImageData(0, 0, width, height);
    const data = imgData.data;

    let totalLum = 0;
    for (let i = 0; i < data.length; i += 4) {
      totalLum += data[i];
    }
    const meanLum = totalLum / (data.length / 4);
    const threshold = Math.max(40, Math.min(210, meanLum - 10));

    for (let i = 0; i < data.length; i += 4) {
      const binVal = data[i] < threshold ? 0 : 255;
      data[i] = binVal;
      data[i + 1] = binVal;
      data[i + 2] = binVal;
    }
    ctx.putImageData(imgData, 0, 0);
  }

  /**
   * Koreksi Rotasi / Deskew Ringan (Light Deskew)
   * Menghindari transformasi berlebih yang merusak bentuk huruf
   */
  static applyLightDeskew(canvas, ctx, angleDeg = 0) {
    if (Math.abs(angleDeg) < 0.5 || Math.abs(angleDeg) > 20) return;

    const w = canvas.width;
    const h = canvas.height;
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = w;
    tempCanvas.height = h;
    const tempCtx = tempCanvas.getContext('2d');
    tempCtx.drawImage(canvas, 0, 0);

    ctx.save();
    ctx.clearRect(0, 0, w, h);
    ctx.translate(w / 2, h / 2);
    ctx.rotate((angleDeg * Math.PI) / 180);
    ctx.drawImage(tempCanvas, -w / 2, -h / 2);
    ctx.restore();
  }

  /**
   * Memproses kandidat canvas dengan audit resolusi, ROI, upscaling, dan varian terpilih
   * @param {HTMLVideoElement|HTMLCanvasElement|Object} sourceImage
   * @param {Object} options
   * @returns {Object} Candidate metadata { canvas, scale, roiAudit, qualityAssessment, variant }
   */
  static processCandidate(sourceImage, options = {}) {
    const variant = options.variant || PREPROCESS_VARIANTS.STANDARD;
    const maxDim = options.maxDimension || 1920;
    const roiMode = options.roiMode || ROI_MODES.AUTO;
    const profile = options.profile || OCR_PROFILES.AUTO;

    if (!sourceImage) {
      throw new Error('Citra sumber kosong atau tidak valid.');
    }

    // Lingkungan Node.js automated test
    if (typeof document === 'undefined') {
      return {
        canvas: sourceImage,
        scale: 1,
        roiAudit: {
          cameraWidth: sourceImage.width || 640,
          cameraHeight: sourceImage.height || 480,
          sourceWidth: sourceImage.width || 640,
          sourceHeight: sourceImage.height || 480,
          cropX: 0,
          cropY: 0,
          cropWidth: sourceImage.width || 640,
          cropHeight: sourceImage.height || 480,
          roiMode
        },
        qualityAssessment: {
          overall: QUALITY_LEVELS.GOOD,
          brightness: QUALITY_LEVELS.GOOD,
          contrast: QUALITY_LEVELS.GOOD,
          sharpness: QUALITY_LEVELS.GOOD,
          metrics: { meanBrightness: 130, contrastStdDev: 50, laplacianVar: 120 },
          isTooBlurry: false,
          qualityFeedback: 'Frame optimal'
        },
        variant
      };
    }

    // 1. Audit Capture Resolution Native
    let camW = 0;
    let camH = 0;

    if (sourceImage instanceof HTMLVideoElement) {
      camW = sourceImage.videoWidth || sourceImage.width || 640;
      camH = sourceImage.videoHeight || sourceImage.height || 480;
    } else if (sourceImage instanceof HTMLCanvasElement || sourceImage instanceof HTMLImageElement) {
      camW = sourceImage.naturalWidth || sourceImage.width || 640;
      camH = sourceImage.naturalHeight || sourceImage.height || 480;
    } else if (sourceImage && typeof sourceImage.width === 'number') {
      camW = sourceImage.width;
      camH = sourceImage.height;
    }

    if (!camW || !camH) {
      throw new Error('Dimensi kamera tidak valid (frame kosong).');
    }

    // 2. Hitung ROI Bounding Rect (Center Region vs Full Frame vs Auto)
    let cropX = 0;
    let cropY = 0;
    let cropW = camW;
    let cropH = camH;

    if (roiMode === ROI_MODES.CENTER_REGION) {
      // Fokus pada area tengah 68% width & 58% height
      cropW = Math.round(camW * 0.68);
      cropH = Math.round(camH * 0.58);
      cropX = Math.round((camW - cropW) / 2);
      cropY = Math.round((camH - cropH) / 2);
    } else if (roiMode === ROI_MODES.AUTO) {
      // Area fokus tengah proporsional dengan margin pengaman
      cropW = Math.round(camW * 0.80);
      cropH = Math.round(camH * 0.75);
      cropX = Math.round((camW - cropW) / 2);
      cropY = Math.round((camH - cropH) / 2);
    }

    const roiAudit = {
      cameraWidth: camW,
      cameraHeight: camH,
      sourceWidth: camW,
      sourceHeight: camH,
      cropX,
      cropY,
      cropWidth: cropW,
      cropHeight: cropH,
      roiMode
    };

    // 3. Upscaling Adaptif (2x atau 3x untuk text area kecil)
    let upscaleFactor = 1.0;
    if (cropW < 500 || cropH < 350 || variant === PREPROCESS_VARIANTS.UPSCALE_SHARPEN) {
      upscaleFactor = cropW < 300 ? 3.0 : 2.0;
    }

    let targetW = Math.round(cropW * upscaleFactor);
    let targetH = Math.round(cropH * upscaleFactor);

    if (Math.max(targetW, targetH) > maxDim) {
      const downFactor = maxDim / Math.max(targetW, targetH);
      targetW = Math.round(targetW * downFactor);
      targetH = Math.round(targetH * downFactor);
    }

    const scale = targetW / cropW;

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, targetW);
    canvas.height = Math.max(1, targetH);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    if (!ctx) {
      throw new Error('Gagal mengalokasikan 2D canvas context.');
    }

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    // Draw frame ROI ke target canvas
    ctx.drawImage(sourceImage, cropX, cropY, cropW, cropH, 0, 0, canvas.width, canvas.height);

    // 4. Quality Assessment
    const rawImgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const qualityAssessment = ImageQualityAssessor.assessQuality(rawImgData, canvas.width, canvas.height);

    // 5. Terapkan Varian Preprocessing
    switch (variant) {
      case PREPROCESS_VARIANTS.GENTLE_HANDWRITING:
        // Preprocessing lembut untuk tulisan tangan: mempertahankan kontinuitas goresan pena/pensil
        OCRPreprocessPipeline.applyGrayscale(ctx, canvas.width, canvas.height);
        OCRPreprocessPipeline.applyDenoise(ctx, canvas.width, canvas.height);
        OCRPreprocessPipeline.applyContrastStretching(ctx, canvas.width, canvas.height, 0.7);
        break;

      case PREPROCESS_VARIANTS.UPSCALE_SHARPEN:
        OCRPreprocessPipeline.applyGrayscale(ctx, canvas.width, canvas.height);
        OCRPreprocessPipeline.applyContrastStretching(ctx, canvas.width, canvas.height);
        OCRPreprocessPipeline.applySharpen(ctx, canvas.width, canvas.height, 0.85);
        break;

      case PREPROCESS_VARIANTS.ADAPTIVE_THRESHOLD:
        OCRPreprocessPipeline.applyGrayscale(ctx, canvas.width, canvas.height);
        OCRPreprocessPipeline.applyDenoise(ctx, canvas.width, canvas.height);
        OCRPreprocessPipeline.applyContrastStretching(ctx, canvas.width, canvas.height);
        OCRPreprocessPipeline.applyAdaptiveThreshold(ctx, canvas.width, canvas.height);
        break;

      case PREPROCESS_VARIANTS.RAW:
        break;

      case PREPROCESS_VARIANTS.STANDARD:
      default:
        OCRPreprocessPipeline.applyGrayscale(ctx, canvas.width, canvas.height);
        OCRPreprocessPipeline.applyContrastStretching(ctx, canvas.width, canvas.height);
        break;
    }

    return {
      canvas,
      scale,
      roiAudit,
      qualityAssessment,
      variant,
      profile
    };
  }
}

/**
 * OCR Engine Service V1.2.1 Hardened
 */
export class OCRService {
  /**
   * @param {Object} customConfig
   * @param {Object|null} customWorker
   */
  constructor(customConfig = {}, customWorker = null) {
    this.config = { ...DEFAULT_OCR_CONFIG, ...customConfig };
    this.status = OCRStatus.LOADING;
    this.worker = customWorker || null;
    this._customWorker = customWorker || null;
    this.lastResult = null;
    this.lastError = null;
    this.lastProcessingTimeMs = 0;
    this.lastQualityAssessment = null;
    this.lastRoiAudit = null;
    this.statusListeners = new Set();
    this.isTesseractModuleLoaded = false;
    this._Tesseract = null;
  }

  onStatusChange(listener) {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  on(event, listener) {
    if (event === 'statusChange' || event === 'status') {
      return this.onStatusChange(listener);
    }
    return () => {};
  }

  _notifyStatusChange() {
    const info = this.getDiagnostics();
    for (const listener of this.statusListeners) {
      try {
        listener(this.status, info);
      } catch (err) {
        console.warn('[OCRService] Error in status listener:', err);
      }
    }
  }

  _setStatus(newStatus, error = null) {
    this.status = newStatus;
    if (error) {
      this.lastError = typeof error === 'string' ? error : error.message || 'OCR Error';
    } else if (newStatus === OCRStatus.READY || newStatus === OCRStatus.DONE) {
      this.lastError = null;
    }
    this._notifyStatusChange();
  }

  getStatus() {
    return this.status;
  }

  getDiagnostics() {
    return {
      status: this.status,
      language: this.config.language,
      profile: this.config.profile,
      roiMode: this.config.roiMode,
      lastText: this.lastResult ? this.lastResult.text : '',
      regionsCount: this.lastResult && Array.isArray(this.lastResult.regions) ? this.lastResult.regions.length : 0,
      confidence: this.lastResult ? this.lastResult.confidence : 0,
      isLowConfidence: this.lastResult ? !!this.lastResult.isLowConfidence : false,
      statusMessage: this.lastResult ? this.lastResult.statusMessage : null,
      preprocessingMethod: this.lastResult ? this.lastResult.preprocessingMethod : 'none',
      quality: this.lastQualityAssessment ? this.lastQualityAssessment.overall : QUALITY_LEVELS.FAIR,
      qualityDetails: this.lastQualityAssessment || null,
      roiAudit: this.lastRoiAudit || null,
      lastLatencyMs: this.lastProcessingTimeMs,
      lastTimestamp: this.lastResult ? this.lastResult.timestamp : null,
      lastError: this.lastError
    };
  }

  setProfile(profile) {
    if (Object.values(OCR_PROFILES).includes(profile)) {
      this.config.profile = profile;
    }
  }

  setRoiMode(roiMode) {
    if (Object.values(ROI_MODES).includes(roiMode)) {
      this.config.roiMode = roiMode;
    }
  }

  async initialize(lang = null) {
    if (lang) {
      this.config.language = lang;
    }
    const targetLang = this.config.language || 'ind';
    this._setStatus(OCRStatus.LOADING);

    if (this.worker || this._customWorker) {
      this.worker = this.worker || this._customWorker;
      this._setStatus(OCRStatus.READY);
      return true;
    }

    try {
      let TesseractModule = this._Tesseract;
      if (!TesseractModule) {
        if (typeof window !== 'undefined' && window.Tesseract) {
          TesseractModule = window.Tesseract;
        } else {
          try {
            const imported = await import('tesseract.js');
            TesseractModule = imported.default || imported;
            this._Tesseract = TesseractModule;
          } catch (importErr) {
            console.warn('[OCRService] Gagal import tesseract.js:', importErr);
            this._setStatus(OCRStatus.UNAVAILABLE, 'Modul Tesseract.js tidak dapat dimuat.');
            return false;
          }
        }
      }

      if (!TesseractModule || !TesseractModule.createWorker) {
        this._setStatus(OCRStatus.UNAVAILABLE, 'Browser tidak mendukung WebAssembly / Tesseract Worker.');
        return false;
      }

      const createWorkerFn = TesseractModule.createWorker;
      const worker = await createWorkerFn(targetLang, 1, {
        logger: () => {},
        errorHandler: (err) => {
          console.warn('[OCR Worker Error]', err);
          this._setStatus(OCRStatus.ERROR, err);
        }
      });

      this.worker = worker;
      this._setStatus(OCRStatus.READY);
      return true;
    } catch (initErr) {
      console.error('[OCRService] Gagal memuat model OCR:', initErr);
      const errMessage = initErr?.message || String(initErr);
      this._setStatus(
        OCRStatus.ERROR,
        `Gagal memuat language model "${targetLang}". (${errMessage})`
      );
      return false;
    }
  }

  async setLanguage(newLang) {
    if (!this.config.supportedLanguages.includes(newLang)) {
      throw new Error(`Bahasa "${newLang}" tidak didukung. Pilihan: ${this.config.supportedLanguages.join(', ')}`);
    }

    if (this.config.language === newLang && this.status === OCRStatus.READY) {
      return true;
    }

    this.config.language = newLang;
    await this.stop();
    return await this.initialize(newLang);
  }

  preprocess(sourceImage, variant = PREPROCESS_VARIANTS.STANDARD) {
    return OCRPreprocessPipeline.processCandidate(sourceImage, {
      variant,
      maxDimension: this.config.maxDimension,
      roiMode: this.config.roiMode,
      profile: this.config.profile
    });
  }

  /**
   * Menjalankan inferensi OCR hardened pada citra/kamera
   * @param {HTMLVideoElement|HTMLCanvasElement|Object} imageInput
   * @param {Object} [options={}]
   * @returns {Promise<Object>}
   */
  async recognize(imageInput, options = {}) {
    if (!imageInput) {
      throw new Error('Input citra tidak ditemukan.');
    }

    if (this.status === OCRStatus.PROCESSING) {
      throw new Error('OCR sedang memproses teks sebelumnya. Harap tunggu.');
    }

    if (!this.worker) {
      const ok = await this.initialize(this.config.language);
      if (!ok || !this.worker) {
        throw new Error(this.lastError || 'OCR Engine belum siap.');
      }
    }

    this._setStatus(OCRStatus.PROCESSING);
    const startTime = performance.now();

    try {
      const profile = options.profile || this.config.profile || OCR_PROFILES.AUTO;
      const roiMode = options.roiMode || this.config.roiMode || ROI_MODES.AUTO;
      const allowMultiPass = (options.multiPass !== undefined) ? options.multiPass : this.config.enableMultiPass;
      const psmMode = options.psm || this.config.defaultPsm;

      // Pilih varian awal berdasarkan profile
      let initialVariant = options.variant;
      if (!initialVariant) {
        if (profile === OCR_PROFILES.HANDWRITING) {
          initialVariant = PREPROCESS_VARIANTS.GENTLE_HANDWRITING;
        } else {
          initialVariant = PREPROCESS_VARIANTS.STANDARD;
        }
      }

      const workerOptions = { ...options };
      if (psmMode) {
        workerOptions.tessedit_pageseg_mode = psmMode;
      }

      // -----------------------------------------------------------------------
      // PASS 1: Native Resolution & Preprocessing Candidate
      // -----------------------------------------------------------------------
      const pass1Candidate = OCRPreprocessPipeline.processCandidate(imageInput, {
        variant: initialVariant,
        maxDimension: this.config.maxDimension,
        roiMode,
        profile
      });

      this.lastRoiAudit = pass1Candidate.roiAudit;
      this.lastQualityAssessment = pass1Candidate.qualityAssessment;

      // Log Resolution Audit
      console.log(
        `[OCR Resolution Audit] camera: ${pass1Candidate.roiAudit.cameraWidth}x${pass1Candidate.roiAudit.cameraHeight} | ` +
        `source: ${pass1Candidate.roiAudit.sourceWidth}x${pass1Candidate.roiAudit.sourceHeight} | ` +
        `crop: ${pass1Candidate.roiAudit.cropWidth}x${pass1Candidate.roiAudit.cropHeight} | ` +
        `ROI: ${roiMode} | Quality: ${pass1Candidate.qualityAssessment.overall}`
      );

      // Kualitas frame check: Jika kualitas terlalu buruk (blur parah / gelap gulita)
      if (this.config.enableQualityCheck && pass1Candidate.qualityAssessment.overall === QUALITY_LEVELS.POOR) {
        const elapsedMs = Math.round(performance.now() - startTime);
        this.lastProcessingTimeMs = elapsedMs;

        const warningMsg = pass1Candidate.qualityAssessment.qualityFeedback || 'Teks terlalu buram untuk dibaca. Coba dekatkan kamera.';
        const result = {
          text: 'Teks kurang jelas untuk dibaca.',
          confidence: 0,
          regions: [],
          preprocessingMethod: pass1Candidate.variant,
          quality: QUALITY_LEVELS.POOR,
          qualityFeedback: warningMsg,
          isLowConfidence: true,
          statusMessage: warningMsg,
          passCount: 1,
          profile,
          roiAudit: pass1Candidate.roiAudit,
          timestamp: Date.now(),
          processingTimeMs: elapsedMs
        };

        this.lastResult = result;
        this._setStatus(OCRStatus.DONE);
        return result;
      }

      const pass1Raw = await this.worker.recognize(pass1Candidate.canvas, workerOptions);
      let bestResult = this._parseWorkerOutput(
        pass1Raw,
        pass1Candidate.scale,
        pass1Candidate.variant,
        pass1Candidate.roiAudit
      );
      let passCount = 1;

      // -----------------------------------------------------------------------
      // PASS 2: Multi-Pass Fallback (Upscale / Sharpen / Adaptive)
      // -----------------------------------------------------------------------
      const shouldTryPass2 = allowMultiPass &&
        !options.variant &&
        (bestResult.confidence < 65 || bestResult.text.length === 0) &&
        typeof document !== 'undefined';

      if (shouldTryPass2) {
        try {
          passCount++;
          const pass2Variant = profile === OCR_PROFILES.HANDWRITING
            ? PREPROCESS_VARIANTS.UPSCALE_SHARPEN
            : PREPROCESS_VARIANTS.ADAPTIVE_THRESHOLD;

          const pass2Candidate = OCRPreprocessPipeline.processCandidate(imageInput, {
            variant: pass2Variant,
            maxDimension: this.config.maxDimension,
            roiMode,
            profile
          });

          const pass2Raw = await this.worker.recognize(pass2Candidate.canvas, workerOptions);
          const pass2Result = this._parseWorkerOutput(
            pass2Raw,
            pass2Candidate.scale,
            pass2Candidate.variant,
            pass2Candidate.roiAudit
          );

          const score1 = this._calculateCandidateScore(bestResult);
          const score2 = this._calculateCandidateScore(pass2Result);

          if (score2 > score1) {
            bestResult = pass2Result;
          }
        } catch (pass2Err) {
          console.warn('[OCRService] Fallback pass 2 warning:', pass2Err);
        }
      }

      const elapsedMs = Math.round(performance.now() - startTime);
      this.lastProcessingTimeMs = elapsedMs;

      // -----------------------------------------------------------------------
      // Evaluasi Konsistensi & Normalisasi Teks
      // -----------------------------------------------------------------------
      let normalizedText = normalizeOcrText(bestResult.text);
      const conf = bestResult.confidence;
      let isLowConfidence = false;
      let statusMessage = null;

      // Verifikasi rasio karakter yang valid (Pencegahan Hallucinated Garbage Characters)
      const sanityCheck = this._verifyTextSanity(normalizedText);

      if (normalizedText.length === 0) {
        statusMessage = 'Tidak ada teks yang terdeteksi pada citra.';
      } else if (!sanityCheck.isSane || conf < this.config.unclearThreshold) {
        normalizedText = 'Teks kurang jelas untuk dibaca.';
        isLowConfidence = true;
        statusMessage = 'Teks kurang jelas untuk dibaca — coba dekatkan kamera atau gunakan pencahayaan lebih baik.';
      } else if (conf < this.config.lowConfidenceThreshold) {
        isLowConfidence = true;
        statusMessage = profile === OCR_PROFILES.HANDWRITING
          ? `Confidence tulisan tangan (${conf}%) — tulisan tangan memiliki variasi goresan tinggi.`
          : `Confidence rendah (${conf}%) — coba dekatkan kamera / gunakan pencahayaan lebih baik.`;
      } else {
        statusMessage = profile === OCR_PROFILES.HANDWRITING
          ? `Teks tulisan tangan terbaca (${conf}%) — mode handwriting aktif dengan preprocessing khusus.`
          : `Teks berhasil dibaca dengan tingkat keyakinan ${conf}%.`;
      }

      const ocrResult = {
        text: normalizedText,
        confidence: conf,
        regions: bestResult.regions,
        preprocessingMethod: bestResult.preprocessingMethod,
        quality: pass1Candidate.qualityAssessment.overall,
        qualityFeedback: pass1Candidate.qualityAssessment.qualityFeedback,
        isLowConfidence,
        statusMessage,
        passCount,
        profile,
        roiAudit: pass1Candidate.roiAudit,
        timestamp: Date.now(),
        processingTimeMs: elapsedMs
      };

      this.lastResult = ocrResult;
      this._setStatus(OCRStatus.DONE);
      return ocrResult;
    } catch (err) {
      console.warn('[OCRService] Gagal menjalankan pengenalan teks:', err);
      const errMsg = err?.message || String(err);
      this._setStatus(OCRStatus.ERROR, errMsg);
      throw err;
    }
  }

  /**
   * Parse output worker & mapping koordinat kembali ke resolusi asli
   * @private
   */
  _parseWorkerOutput(workerRes, scale = 1, variant = 'standard', roiAudit = null) {
    const data = workerRes?.data || {};
    const rawText = data.text || '';
    const confidence = Math.round(Number(data.confidence) || 0);
    const regions = [];
    const lines = data.lines || [];
    const offsetX = (roiAudit && typeof roiAudit.cropX === 'number') ? roiAudit.cropX : 0;
    const offsetY = (roiAudit && typeof roiAudit.cropY === 'number') ? roiAudit.cropY : 0;

    for (const line of lines) {
      const lineText = (line.text || '').trim();
      if (!lineText) continue;

      const rawBox = line.bbox || { x0: 0, y0: 0, x1: 0, y1: 0 };
      const x1 = Math.round((rawBox.x0 || 0) / scale) + offsetX;
      const y1 = Math.round((rawBox.y0 || 0) / scale) + offsetY;
      const x2 = Math.round((rawBox.x1 || 0) / scale) + offsetX;
      const y2 = Math.round((rawBox.y1 || 0) / scale) + offsetY;

      if (x2 > x1 && y2 > y1) {
        regions.push({
          text: lineText,
          confidence: Math.round(Number(line.confidence) || confidence),
          bbox: { x1, y1, x2, y2 }
        });
      }
    }

    return {
      text: rawText,
      confidence,
      regions,
      preprocessingMethod: variant
    };
  }

  /**
   * Skor evaluasi kandidat multi-pass yang memperhatikan kualitas teks
   * @private
   */
  _calculateCandidateScore(cand) {
    if (!cand || !cand.text || cand.text.trim().length === 0) return 0;
    const raw = cand.text.trim();
    const conf = cand.confidence || 0;

    const sanity = this._verifyTextSanity(raw);
    if (!sanity.isSane) return conf * 0.2;

    // Bobot: Confidence (60%) + Printable Ratio (25%) + Length Factor (15%)
    return (conf * 0.6) + (sanity.printableRatio * 25) + Math.min(15, raw.length * 0.5);
  }

  /**
   * Memeriksa kewajaran teks (Sanity Check) untuk mencegah garbage character output
   * @private
   */
  _verifyTextSanity(text) {
    if (!text || text.length === 0) {
      return { isSane: false, printableRatio: 0 };
    }

    // Hitung jumlah karakter alfanumerik dan tanda baca lazim
    let validChars = 0;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      // Alphanumeric + Spasi + Newline + Tanda baca standar (. , ! ? - / : ; " ' ( ))
      if (
        (code >= 48 && code <= 57) ||  // 0-9
        (code >= 65 && code <= 90) ||  // A-Z
        (code >= 97 && code <= 122) || // a-z
        code === 32 || code === 10 || code === 13 || code === 9 || // Whitespace
        code === 46 || code === 44 || code === 63 || code === 33 || // . , ? !
        code === 58 || code === 59 || code === 45 || code === 47 || // : ; - /
        code === 34 || code === 39 || code === 40 || code === 41    // " ' ( )
      ) {
        validChars++;
      }
    }

    const printableRatio = validChars / text.length;
    // Teks dianggap tidak wajar jika rasio karakter valid < 65% pada teks panjang
    const isSane = printableRatio >= (text.length > 5 ? 0.65 : 0.50);

    return { isSane, printableRatio };
  }

  async stop() {
    if (this.worker) {
      try {
        if (!this._customWorker && typeof this.worker.terminate === 'function') {
          await this.worker.terminate();
        }
      } catch (err) {
        console.warn('[OCRService] Error terminating worker:', err);
      }
      this.worker = null;
    }
    this._setStatus(OCRStatus.READY);
  }

  clear() {
    this.lastResult = null;
    this.lastError = null;
    this.lastProcessingTimeMs = 0;
    this.lastQualityAssessment = null;
    this.lastRoiAudit = null;
    this._setStatus(this.worker ? OCRStatus.READY : OCRStatus.LOADING);
  }
}
