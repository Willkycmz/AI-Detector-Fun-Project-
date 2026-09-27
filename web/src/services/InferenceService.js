/**
 * InferenceService - Real Ultralytics YOLOv8 ONNX Inference Engine for Browser
 * 
 * V0.5.1 Diagnostics & State Management:
 * - Clear 3-state cycle: 'loading' -> 'ready' | 'error'
 * - Model binary fetch tracking with HTTP status, byte size, and timing
 * - Comprehensive diagnostics for every stage of the pipeline:
 *   Model loading started -> fetch started -> fetch completed -> session initialized
 *   -> input/output tensor shapes -> first inference -> NMS -> latency
 * - Local WASM configuration (no external CDN dependency)
 * - Safe error handling (never silently ignored)
 */

import { CoordinateMapper } from './CoordinateMapper.js';

// Dapatkan instance ort (utamakan window.ort dari ort.min.js lokal)
const getOrt = () => window.ort || (typeof globalThis !== 'undefined' ? globalThis.ort : null);

export const VISIONX_V1_CLASSES = [
  'person',
  'bottle',
  'cup',
  'laptop',
  'mouse',
  'keyboard',
  'cell_phone'
];

export const COCO_CLASSES = [
  'person', 'bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train', 'truck', 'boat', 'traffic light',
  'fire hydrant', 'stop sign', 'parking meter', 'bench', 'bird', 'cat', 'dog', 'horse', 'sheep', 'cow',
  'elephant', 'bear', 'zebra', 'giraffe', 'backpack', 'umbrella', 'handbag', 'tie', 'suitcase', 'frisbee',
  'skis', 'snowboard', 'sports ball', 'kite', 'baseball bat', 'baseball glove', 'skateboard', 'surfboard',
  'tennis racket', 'bottle', 'wine glass', 'cup', 'fork', 'knife', 'spoon', 'bowl', 'banana', 'apple',
  'sandwich', 'orange', 'broccoli', 'carrot', 'hot dog', 'pizza', 'donut', 'cake', 'chair', 'couch',
  'potted plant', 'bed', 'dining table', 'toilet', 'tv', 'laptop', 'mouse', 'remote', 'keyboard', 'cell phone',
  'microwave', 'oven', 'toaster', 'sink', 'refrigerator', 'book', 'clock', 'vase', 'scissors', 'teddy bear',
  'hair drier', 'toothbrush'
];

export const MODEL_PRESETS = {
  visionx_v2: {
    id: 'visionx_v2',
    name: 'VisionX V2 (Real-World Improved 7 Classes)',
    shortName: 'VisionX V2 Custom',
    badge: 'Custom V2',
    path: '/models/visionx_v2.onnx',
    classes: VISIONX_V1_CLASSES,
    numClasses: VISIONX_V1_CLASSES.length,
    isCustom: true,
    description: 'Model V2 ditingkatkan dengan real-world dataset & small object improvement'
  },
  visionx_v1: {
    id: 'visionx_v1',
    name: 'VisionX V1 (Custom 7 Classes)',
    shortName: 'VisionX V1 Custom',
    badge: 'Custom V1',
    path: '/models/visionx_v1.onnx',
    classes: VISIONX_V1_CLASSES,
    numClasses: VISIONX_V1_CLASSES.length,
    isCustom: true,
    description: 'Model hasil fine-tuning dataset VisionX (7 target classes)'
  },
  pretrained: {
    id: 'pretrained',
    name: 'Pretrained YOLOv8n (COCO 80 Classes)',
    shortName: 'YOLOv8n Pretrained',
    badge: 'Pretrained COCO',
    path: '/models/yolov8n.onnx',
    classes: COCO_CLASSES,
    numClasses: COCO_CLASSES.length,
    isCustom: false,
    description: 'Model standar YOLOv8n COCO (80 general classes)'
  }
};

/**
 * Menghitung Intersection over Union (IoU) antara dua bounding box [x1, y1, x2, y2].
 */
function computeIoU(boxA, boxB) {
  const xA = Math.max(boxA[0], boxB[0]);
  const yA = Math.max(boxA[1], boxB[1]);
  const xB = Math.min(boxA[2], boxB[2]);
  const yB = Math.min(boxA[3], boxB[3]);

  const interArea = Math.max(0, xB - xA) * Math.max(0, yB - yA);
  if (interArea <= 0) return 0;

  const boxAArea = (boxA[2] - boxA[0]) * (boxA[3] - boxA[1]);
  const boxBArea = (boxB[2] - boxB[0]) * (boxB[3] - boxB[1]);
  const unionArea = boxAArea + boxBArea - interArea;

  return unionArea > 0 ? interArea / unionArea : 0;
}

/**
 * Non-Maximum Suppression (NMS)
 */
function applyNMS(candidates, iouThreshold = 0.45) {
  candidates.sort((a, b) => b.confidence - a.confidence);

  const selected = [];
  const active = new Array(candidates.length).fill(true);

  for (let i = 0; i < candidates.length; i++) {
    if (!active[i]) continue;

    const current = candidates[i];
    selected.push(current);

    const boxA = [current.x1, current.y1, current.x2, current.y2];

    for (let j = i + 1; j < candidates.length; j++) {
      if (!active[j]) continue;

      if (current.class_id === candidates[j].class_id) {
        const boxB = [candidates[j].x1, candidates[j].y1, candidates[j].x2, candidates[j].y2];
        const iou = computeIoU(boxA, boxB);
        if (iou > iouThreshold) {
          active[j] = false;
        }
      }
    }
  }

  return selected;
}

export class YOLOInferenceService {
  constructor(defaultModelId = 'visionx_v1') {
    this.activeModelId = defaultModelId;
    this.modelConfig = MODEL_PRESETS[defaultModelId] || MODEL_PRESETS.visionx_v1;
    this.modelPath = this.modelConfig.path;
    this.classes = this.modelConfig.classes;
    this.numClasses = this.modelConfig.numClasses;
    this.modelName = this.modelConfig.name;

    this.session = null;
    this.isActive = true;
    
    // UI state: 'idle' | 'loading' | 'ready' | 'error'
    this.status = 'idle';
    this.errorMessage = null;
    this.loadTimeMs = 0;

    this.confThreshold = 0.45;
    this.iouThreshold = 0.45;

    // Tracking diagnostics lengkap
    this.diagnostics = {
      status: 'idle',
      modelLoadingStarted: null,
      modelFetchStarted: null,
      modelFetchCompleted: null,
      modelSizeBytes: 0,
      modelSizeFormatted: '-- MB',
      sessionInitialized: null,
      modelInputName: 'images',
      modelInputShape: '[1, 3, 640, 640]',
      modelOutputName: 'output0',
      modelOutputShape: `[1, ${4 + this.numClasses}, 8400]`,
      tensorMin: null,
      tensorMax: null,
      firstInferenceStarted: null,
      firstInferenceCompleted: null,
      firstInferenceLatencyMs: null,
      lastInferenceLatencyMs: 0,
      lastRawPredictionsCount: 0,
      lastAfterConfidenceCount: 0,
      lastAfterNmsCount: 0,
      finalDetectionsCount: 0,
      droppedByPadding: 0,
      droppedByMinSize: 0,
      droppedByAspectRatio: 0,
      droppedByMarginal: 0,
      acceptedCount: 0,
      filterRejectionLogs: []
    };

    // Diagnostic flags
    this.disableNms = false;
    this.diagnosticThreshold = 0.10;
    this.isDebugFilterLogging = false;

    // Frame sequence tracking
    this.currentFrameId = 0;
    this.latestCompletedFrameId = 0;
    this.isInferencing = false;

    // Preprocessing canvas
    this.preprocessCanvas = document.createElement('canvas');
    this.preprocessCanvas.width = 640;
    this.preprocessCanvas.height = 640;
    this.preprocessCtx = this.preprocessCanvas.getContext('2d', { willReadFrequently: true });
  }

  /**
   * Log keputusan filtering deteksi untuk auditibilitas dan observabilitas penuh
   */
  _logFilterDecision(decision, className, confidence, reason) {
    const logEntry = {
      timestamp: Date.now(),
      frameId: this.currentFrameId,
      decision,
      className,
      confidence: parseFloat(confidence.toFixed(4)),
      reason
    };

    if (!this.diagnostics.filterRejectionLogs) {
      this.diagnostics.filterRejectionLogs = [];
    }
    this.diagnostics.filterRejectionLogs.push(logEntry);
    if (this.diagnostics.filterRejectionLogs.length > 100) {
      this.diagnostics.filterRejectionLogs.shift();
    }

    if (this.isDebugFilterLogging || (decision === 'DROPPED' && this.currentFrameId % 30 === 1)) {
      console.log(`[VisionX Filter] ${decision}: class=${className}, conf=${confidence.toFixed(3)} — ${reason}`);
    }
  }

  getFilterStats() {
    return {
      droppedByPadding: this.diagnostics.droppedByPadding || 0,
      droppedByMinSize: this.diagnostics.droppedByMinSize || 0,
      droppedByAspectRatio: this.diagnostics.droppedByAspectRatio || 0,
      droppedByMarginal: this.diagnostics.droppedByMarginal || 0,
      acceptedCount: this.diagnostics.acceptedCount || 0,
      recentRejections: (this.diagnostics.filterRejectionLogs || []).slice(-20)
    };
  }

  get isModelLoaded() {
    return this.status === 'ready' && this.session !== null;
  }

  /**
   * Mengatur konfigurasi WASM runtime
   */
  _setupWasmEnv(ortInstance) {
    if (ortInstance && ortInstance.env && ortInstance.env.wasm) {
      // Prioritaskan file WASM lokal di /public/
      ortInstance.env.wasm.wasmPaths = '/';
      ortInstance.env.wasm.numThreads = 1;
      ortInstance.env.wasm.simd = true;
    }
  }

  /**
   * Memuat model aktif saat ini dengan tracking diagnostik penuh
   */
  async loadModel(onProgress = null) {
    if (this.status === 'loading') {
      console.warn('[VisionX] Model sedang dimuat, abaikan panggilan ganda.');
      return false;
    }

    this.status = 'loading';
    this.diagnostics.status = 'loading';
    this.errorMessage = null;
    this.diagnostics.modelLoadingStarted = new Date().toLocaleTimeString();
    const startLoadTime = performance.now();

    console.log(`[VisionX Diagnostic] Model loading started: ${this.modelConfig.name} (${this.modelPath})`);
    if (onProgress) onProgress(`Memuat model ${this.modelConfig.shortName}...`);

    try {
      // 1. Periksa ketersediaan library ONNX Runtime
      const ortInstance = getOrt();
      if (!ortInstance) {
        throw new Error('Library ONNX Runtime Web (ort) belum dimuat di browser window. Periksa /ort.min.js.');
      }
      this._setupWasmEnv(ortInstance);

      // 2. Bersihkan sesi lama jika ada
      if (this.session) {
        try {
          if (typeof this.session.release === 'function') {
            await this.session.release();
          }
        } catch (e) {
          console.warn('[VisionX] Peringatan rilis session lama:', e);
        }
        this.session = null;
      }

      // 3. Fetch model binary secara eksplisit untuk validasi HTTP network status & file size
      this.diagnostics.modelFetchStarted = new Date().toLocaleTimeString();
      console.log(`[VisionX Diagnostic] Model fetch started: ${this.modelPath}`);
      if (onProgress) onProgress(`Mengunduh file model ${this.modelConfig.shortName}...`);

      const response = await fetch(this.modelPath, { cache: 'no-cache' });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText} saat mengunduh file model dari '${this.modelPath}'. Pastikan file ada di web/public/models/.`);
      }

      const arrayBuffer = await response.arrayBuffer();
      this.diagnostics.modelFetchCompleted = new Date().toLocaleTimeString();
      this.diagnostics.modelSizeBytes = arrayBuffer.byteLength;
      this.diagnostics.modelSizeFormatted = (arrayBuffer.byteLength / (1024 * 1024)).toFixed(2) + ' MB';
      console.log(`[VisionX Diagnostic] Model fetch completed. Size: ${this.diagnostics.modelSizeFormatted}`);

      if (onProgress) onProgress(`Menginisialisasi ONNX Runtime Web WASM (${this.diagnostics.modelSizeFormatted})...`);

      // 4. Inisialisasi ONNX InferenceSession langsung dari buffer memori (Uint8Array)
      const modelBytes = new Uint8Array(arrayBuffer);
      this.session = await ortInstance.InferenceSession.create(modelBytes, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all'
      });

      this.diagnostics.sessionInitialized = new Date().toLocaleTimeString();
      console.log(`[VisionX Diagnostic] ONNX session initialized successfully!`);

      // 5. Ekstraksi Input & Output Tensor Shapes
      if (this.session.inputNames && this.session.inputNames.length > 0) {
        this.diagnostics.modelInputName = this.session.inputNames[0];
      }
      if (this.session.outputNames && this.session.outputNames.length > 0) {
        this.diagnostics.modelOutputName = this.session.outputNames[0];
      }
      this.diagnostics.modelOutputShape = `[1, ${4 + this.numClasses}, 8400]`;

      console.log(`[VisionX Diagnostic] Model input: ${this.diagnostics.modelInputName} | output: ${this.diagnostics.modelOutputName}`);

      this.loadTimeMs = Math.round(performance.now() - startLoadTime);
      this.status = 'ready';
      this.diagnostics.status = 'ready';
      this.errorMessage = null;

      console.log(`[VisionX Diagnostic] MODEL: READY (${this.loadTimeMs} ms) | INPUT: [1, 3, 640, 640] | OUTPUT: ${this.diagnostics.modelOutputShape}`);
      if (onProgress) onProgress(`Model Ready (${this.loadTimeMs}ms)`);
      return true;
    } catch (err) {
      this.status = 'error';
      this.diagnostics.status = 'error';
      this.errorMessage = err.message || 'Gagal memuat model';
      this.session = null;
      console.error(`[VisionX Diagnostic Error] Gagal memuat model [${this.modelConfig.name}]:`, err);
      if (onProgress) onProgress(`Model Error: ${this.errorMessage}`);
      throw err;
    }
  }

  /**
   * Beralih ke model lain (contoh: 'visionx_v1' <-> 'pretrained')
   */
  async switchModel(modelId, onProgress = null) {
    if (!MODEL_PRESETS[modelId]) {
      throw new Error(`Model preset tidak valid: ${modelId}`);
    }

    if (this.activeModelId === modelId && this.isModelLoaded && this.session) {
      return { success: true, loadTimeMs: this.loadTimeMs, modelConfig: this.modelConfig, diagnostics: this.diagnostics };
    }

    console.log(`[VisionX] Mengganti model aktif ke: ${modelId}`);
    this.activeModelId = modelId;
    this.modelConfig = MODEL_PRESETS[modelId];
    this.modelPath = this.modelConfig.path;
    this.classes = this.modelConfig.classes;
    this.numClasses = this.modelConfig.numClasses;
    this.modelName = this.modelConfig.name;
    this.status = 'idle';

    await this.loadModel(onProgress);

    return {
      success: true,
      loadTimeMs: this.loadTimeMs,
      modelConfig: this.modelConfig,
      diagnostics: this.diagnostics
    };
  }

  /**
   * Letterbox Preprocessing
   * Mendukung HTMLVideoElement, HTMLImageElement, atau HTMLCanvasElement
   */
  _preprocess(source, isMirrored = false) {
    const vw = source.videoWidth || source.naturalWidth || source.width || 640;
    const vh = source.videoHeight || source.naturalHeight || source.height || 640;
    const targetDim = 640;

    const letterboxParams = CoordinateMapper.computeLetterboxParams(vw, vh, targetDim);
    const { scale, padX, padY, nw, nh } = letterboxParams;

    const ctx = this.preprocessCtx;
    // YOLO standard letterbox padding 114 (#727272)
    ctx.fillStyle = 'rgb(114, 114, 114)';
    ctx.fillRect(0, 0, targetDim, targetDim);

    ctx.save();
    if (isMirrored) {
      ctx.translate(targetDim, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(source, padX, padY, nw, nh);
    ctx.restore();

    const imgData = ctx.getImageData(0, 0, targetDim, targetDim);
    const pixels = imgData.data;

    const floatArray = new Float32Array(1 * 3 * targetDim * targetDim);
    const planeSize = targetDim * targetDim;

    for (let i = 0; i < planeSize; i++) {
      const r = pixels[i * 4];
      const g = pixels[i * 4 + 1];
      const b = pixels[i * 4 + 2];

      floatArray[i] = r / 255.0;                   // R plane
      floatArray[planeSize + i] = g / 255.0;       // G plane
      floatArray[2 * planeSize + i] = b / 255.0;   // B plane
    }

    const ortInstance = getOrt();
    const inputTensor = new ortInstance.Tensor('float32', floatArray, [1, 3, targetDim, targetDim]);

    return {
      inputTensor,
      letterboxParams,
      scale,
      padX,
      padY,
      vw,
      vh
    };
  }

  /**
   * Menjalankan inferensi realtime pada frame video atau citra
   */
  async detect(source, isMirrored = false) {
    if (!this.isActive || !this.session || this.status !== 'ready') {
      return {
        detections: [],
        rawDetections: [],
        frameId: 0,
        inferenceTimeMs: 0,
        modelId: this.activeModelId,
        diagnostics: this.diagnostics
      };
    }

    if (this.isInferencing) {
      return null;
    }

    const isFirstInference = this.diagnostics.firstInferenceStarted === null;
    if (isFirstInference) {
      this.diagnostics.firstInferenceStarted = new Date().toLocaleTimeString();
      console.log('[VisionX Diagnostic] First inference started!');
    }

    const frameId = ++this.currentFrameId;
    const startTime = performance.now();
    this.isInferencing = true;

    try {
      const { inputTensor, letterboxParams, scale, padX, padY, vw, vh } = this._preprocess(source, isMirrored);

      // Jalankan inferensi ONNX
      const feeds = {};
      const inputName = this.diagnostics.modelInputName || 'images';
      feeds[inputName] = inputTensor;

      const outputMap = await this.session.run(feeds);

      if (frameId < this.latestCompletedFrameId) {
        return null;
      }
      this.latestCompletedFrameId = frameId;

      const outputTensor = outputMap[this.diagnostics.modelOutputName] || outputMap.output0 || Object.values(outputMap)[0];
      const outputData = outputTensor.data;
      
      const dims = outputTensor.dims || [1, 4 + this.numClasses, 8400];
      let numChannels = 4 + this.numClasses;
      let numAnchors = 8400;

      if (dims && dims.length >= 3) {
        if (dims[1] < dims[2]) {
          numChannels = dims[1];
          numAnchors = dims[2];
        } else {
          numChannels = dims[2];
          numAnchors = dims[1];
        }
      }

      const numClasses = numChannels - 4;
      const activeClasses = this.classes;

      // Verifikasi output custom model tetap [1, 11, 8400]
      if (this.modelConfig.isCustom && numChannels !== 11) {
        console.warn(`[VisionX Warning] Custom model V1 diharapkan 11 channel, terdeteksi: ${numChannels}`);
      } else if (!this.modelConfig.isCustom && numChannels !== 84) {
        console.warn(`[VisionX Warning] Pretrained COCO model diharapkan 84 channel, terdeteksi: ${numChannels}`);
      }

      // Hitung tensor output min / max untuk verifikasi diagnostik
      let tensorMin = Infinity;
      let tensorMax = -Infinity;
      for (let k = 0; k < outputData.length; k++) {
        const val = outputData[k];
        if (val < tensorMin) tensorMin = val;
        if (val > tensorMax) tensorMax = val;
      }

      const rawCandidates = [];
      let totalRawCount = 0;
      let droppedByPadding = 0;
      let droppedByMinSize = 0;
      let droppedByAspectRatio = 0;
      let droppedByMarginal = 0;
      let acceptedCount = 0;

      const activePadX = padX;
      const activePadY = padY;
      const activeNw = nw;
      const activeNh = nh;

      for (let i = 0; i < numAnchors; i++) {
        let maxScore = -1;
        let maxClassId = -1;

        for (let c = 0; c < numClasses; c++) {
          const score = outputData[(4 + c) * numAnchors + i];
          if (score > maxScore) {
            maxScore = score;
            maxClassId = c;
          }
        }

        // Hitung raw candidate dengan score > diagnosticThreshold (0.10)
        if (maxScore > (this.diagnosticThreshold || 0.10)) {
          totalRawCount++;
        }

        // Confidence Filtering menggunakan confThreshold yang aktif
        if (maxScore >= this.confThreshold && maxClassId >= 0 && maxClassId < activeClasses.length) {
          const cx = outputData[0 * numAnchors + i];
          const cy = outputData[1 * numAnchors + i];
          const w = outputData[2 * numAnchors + i];
          const h = outputData[3 * numAnchors + i];
          const className = activeClasses[maxClassId] || `class_${maxClassId}`;

          // 1. FILTER: Cek apakah anchor center berada di dalam area aktif video (bukan di letterbox padding)
          if (
            cx < activePadX + 2 ||
            cx > (activePadX + activeNw - 2) ||
            cy < activePadY + 2 ||
            cy > (activePadY + activeNh - 2)
          ) {
            droppedByPadding++;
            const reason = `anchor center (${cx.toFixed(1)}, ${cy.toFixed(1)}) in letterbox padding [padX=${activePadX}, padY=${activePadY}]`;
            this._logFilterDecision('DROPPED', className, maxScore, reason);
            continue;
          }

          // Unpad & Scale back ke ukuran citra/video asli menggunakan CoordinateMapper bersama
          const mapped = CoordinateMapper.modelToVideo(
            { x1: cx - w / 2, y1: cy - h / 2, x2: cx + w / 2, y2: cy + h / 2 },
            letterboxParams,
            false // Transformasi cermin sudah dihandle saat letterbox preprocess
          );

          const bw = mapped.x2 - mapped.x1;
          const bh = mapped.y2 - mapped.y1;
          const area = bw * bh;

          // 2. FILTER: Cek dimensi minimum (mencegah degenerasi sub-16px noise)
          if (bw < 16 || bh < 16 || area < 256) {
            droppedByMinSize++;
            const reason = `box too small (${bw}x${bh}, area ${area} < 256px)`;
            this._logFilterDecision('DROPPED', className, maxScore, reason);
            continue;
          }

          // 3. FILTER: Cek rasio aspek (menghilangkan garis pinggir meja, kabel, artefak tepi)
          const aspect = bw / bh;
          if (aspect < 0.15 || aspect > 6.5) {
            droppedByAspectRatio++;
            const reason = `extreme aspect ratio ${aspect.toFixed(2)} (allowed 0.15-6.5)`;
            this._logFilterDecision('DROPPED', className, maxScore, reason);
            continue;
          }

          // 4. FILTER: Sanitasi khusus untuk kelas yang rentan false-positive di stationary real-device (person & bottle)
          const videoArea = (vw || 640) * (vh || 480);
          if (className === 'person' && maxScore < 0.52 && (area < 2500 || area / videoArea < 0.003)) {
            droppedByMarginal++;
            const reason = `marginal score (${maxScore.toFixed(3)} < 0.52) with small area (${area}px < 2500px) for person`;
            this._logFilterDecision('DROPPED', className, maxScore, reason);
            continue;
          }
          if (className === 'bottle' && maxScore < 0.50 && (area < 1200 || area / videoArea < 0.0015)) {
            droppedByMarginal++;
            const reason = `marginal score (${maxScore.toFixed(3)} < 0.50) with small area (${area}px < 1200px) for bottle`;
            this._logFilterDecision('DROPPED', className, maxScore, reason);
            continue;
          }
          if (maxScore < 0.50 && (area < 400 || area / videoArea < 0.0005)) {
            droppedByMarginal++;
            const reason = `marginal score (${maxScore.toFixed(3)} < 0.50) with tiny area (${area}px < 400px)`;
            this._logFilterDecision('DROPPED', className, maxScore, reason);
            continue;
          }

          acceptedCount++;
          this._logFilterDecision('ACCEPTED', className, maxScore, `valid detection bbox=[${mapped.x1},${mapped.y1},${mapped.x2},${mapped.y2}] size=${bw}x${bh}`);

          rawCandidates.push({
            class_id: maxClassId,
            class_name: className,
            confidence: parseFloat(maxScore.toFixed(4)),
            bbox: { x1: mapped.x1, y1: mapped.y1, x2: mapped.x2, y2: mapped.y2 },
            x1: mapped.x1,
            y1: mapped.y1,
            x2: mapped.x2,
            y2: mapped.y2,
            frameId,
            timestamp: Date.now()
          });
        }
      }

      // Non-Maximum Suppression (NMS)
      const finalDetections = this.disableNms ? rawCandidates : applyNMS(rawCandidates, this.iouThreshold);
      const inferenceTimeMs = Math.round(performance.now() - startTime);

      // Update diagnostics tracking
      this.diagnostics.modelInputShape = '[1, 3, 640, 640]';
      this.diagnostics.modelOutputShape = `[1, ${numChannels}, ${numAnchors}]`;
      this.diagnostics.tensorMin = tensorMin;
      this.diagnostics.tensorMax = tensorMax;
      this.diagnostics.lastInferenceLatencyMs = inferenceTimeMs;
      this.diagnostics.lastRawPredictionsCount = totalRawCount;
      this.diagnostics.lastAfterConfidenceCount = rawCandidates.length;
      this.diagnostics.lastAfterNmsCount = finalDetections.length;
      this.diagnostics.finalDetectionsCount = finalDetections.length;
      this.diagnostics.droppedByPadding = droppedByPadding;
      this.diagnostics.droppedByMinSize = droppedByMinSize;
      this.diagnostics.droppedByAspectRatio = droppedByAspectRatio;
      this.diagnostics.droppedByMarginal = droppedByMarginal;
      this.diagnostics.acceptedCount = acceptedCount;

      // Diagnostic Logging per requirements
      if (isFirstInference || frameId % 30 === 1) {
        console.log(
          `[VisionX Diagnostic Log] MODEL: ${this.status.toUpperCase()} | ` +
          `INPUT: 640x640 | ` +
          `OUTPUT: [1,${numChannels},${numAnchors}] | ` +
          `TENSOR MIN/MAX: [${tensorMin.toFixed(4)}, ${tensorMax.toFixed(4)}] | ` +
          `RAW CANDIDATES: ${totalRawCount} | ` +
          `CONF PASS: ${rawCandidates.length} | ` +
          `DROPPED: [pad:${droppedByPadding}, size:${droppedByMinSize}, aspect:${droppedByAspectRatio}, marginal:${droppedByMarginal}] | ` +
          `NMS RESULT: ${finalDetections.length} | ` +
          `FINAL DETECTIONS: ${finalDetections.length}`
        );
      }

      if (isFirstInference) {
        this.diagnostics.firstInferenceCompleted = new Date().toLocaleTimeString();
        this.diagnostics.firstInferenceLatencyMs = inferenceTimeMs;
      }

      return {
        detections: finalDetections,
        rawDetections: rawCandidates,
        frameId,
        inferenceTimeMs,
        modelId: this.activeModelId,
        modelName: this.modelConfig.name,
        loadTimeMs: this.loadTimeMs,
        diagnostics: this.diagnostics
      };
    } catch (err) {
      console.error('[VisionX Diagnostic Error] Kesalahan saat inferensi:', err);
      return {
        detections: [],
        rawDetections: [],
        frameId,
        inferenceTimeMs: 0,
        modelId: this.activeModelId,
        diagnostics: this.diagnostics
      };
    } finally {
      this.isInferencing = false;
    }
  }
}

export { YOLOInferenceService as ObjectDetector };

