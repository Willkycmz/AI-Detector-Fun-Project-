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
      firstInferenceStarted: null,
      firstInferenceCompleted: null,
      firstInferenceLatencyMs: null,
      lastInferenceLatencyMs: 0,
      lastRawPredictionsCount: 0,
      lastAfterConfidenceCount: 0,
      lastAfterNmsCount: 0
    };

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
      this.errorMessage = null;

      console.log(`[VisionX Diagnostic] Model ready in ${this.loadTimeMs} ms!`);
      if (onProgress) onProgress(`Model Ready (${this.loadTimeMs}ms)`);
      return true;
    } catch (err) {
      this.status = 'error';
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
   */
  _preprocess(video) {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const targetDim = 640;

    const scale = Math.min(targetDim / vw, targetDim / vh);
    const nw = Math.round(vw * scale);
    const nh = Math.round(vh * scale);
    const padX = (targetDim - nw) / 2;
    const padY = (targetDim - nh) / 2;

    const ctx = this.preprocessCtx;
    ctx.fillStyle = '#727272';
    ctx.fillRect(0, 0, targetDim, targetDim);

    ctx.drawImage(video, padX, padY, nw, nh);

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
      scale,
      padX,
      padY,
      vw,
      vh
    };
  }

  /**
   * Menjalankan inferensi realtime pada frame video
   */
  async detect(video) {
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
      const { inputTensor, scale, padX, padY, vw, vh } = this._preprocess(video);

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
      const numChannels = dims[1];
      const numAnchors = dims[2] || 8400;
      const numClasses = numChannels - 4;
      const activeClasses = this.classes;

      const rawCandidates = [];
      let totalRawCount = 0;

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

        if (maxScore > 0.1) {
          totalRawCount++;
        }

        // Confidence Filtering
        if (maxScore >= this.confThreshold && maxClassId >= 0 && maxClassId < activeClasses.length) {
          const cx = outputData[0 * numAnchors + i];
          const cy = outputData[1 * numAnchors + i];
          const w = outputData[2 * numAnchors + i];
          const h = outputData[3 * numAnchors + i];

          // Unpad & Scale back ke koordinat video asli
          const cxOrig = (cx - padX) / scale;
          const cyOrig = (cy - padY) / scale;
          const wOrig = w / scale;
          const hOrig = h / scale;

          const x1 = Math.max(0, Math.min(vw, cxOrig - wOrig / 2));
          const y1 = Math.max(0, Math.min(vh, cyOrig - hOrig / 2));
          const x2 = Math.max(0, Math.min(vw, cxOrig + wOrig / 2));
          const y2 = Math.max(0, Math.min(vh, cyOrig + hOrig / 2));

          if (x2 > x1 && y2 > y1) {
            rawCandidates.push({
              class_id: maxClassId,
              class_name: activeClasses[maxClassId] || `class_${maxClassId}`,
              confidence: parseFloat(maxScore.toFixed(4)),
              x1: Math.round(x1),
              y1: Math.round(y1),
              x2: Math.round(x2),
              y2: Math.round(y2),
              frameId,
              timestamp: Date.now()
            });
          }
        }
      }

      // Non-Maximum Suppression (NMS)
      const finalDetections = applyNMS(rawCandidates, this.iouThreshold);
      const inferenceTimeMs = Math.round(performance.now() - startTime);

      if (isFirstInference) {
        this.diagnostics.firstInferenceCompleted = new Date().toLocaleTimeString();
        this.diagnostics.firstInferenceLatencyMs = inferenceTimeMs;
        console.log(`[VisionX Diagnostic] First inference completed successfully! Latency: ${inferenceTimeMs} ms, Detected: ${finalDetections.length}`);
      }

      this.diagnostics.lastInferenceLatencyMs = inferenceTimeMs;
      this.diagnostics.lastRawPredictionsCount = totalRawCount;
      this.diagnostics.lastAfterConfidenceCount = rawCandidates.length;
      this.diagnostics.lastAfterNmsCount = finalDetections.length;

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
