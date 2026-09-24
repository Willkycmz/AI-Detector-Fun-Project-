/**
 * InferenceService - Real Ultralytics YOLOv8 ONNX Inference Engine for Browser
 * 
 * Mendukung Multi-Model Switching:
 * 1. VisionX V1 Custom Model (models/visionx_v1.onnx) - 7 Classes:
 *    ['person', 'bottle', 'cup', 'laptop', 'mouse', 'keyboard', 'cell_phone']
 * 2. Pretrained YOLOv8n Model (models/yolov8n.onnx) - 80 COCO Classes
 * 
 * Mengimplementasikan:
 * - Letterbox Preprocessing (640x640, RGB, aspect ratio preserved, gray padding 114)
 * - Planar Float32Array [1, 3, 640, 640] normalized [0, 1]
 * - Dynamic output tensor decoding ([1, 11, 8400] vs [1, 84, 8400])
 * - Non-Maximum Suppression (NMS) berbasis IoU
 * - Frame ID & timestamp sequencing
 * - Safe model switching & load timing metrics
 */

// Gunakan window.ort dari ort.min.js untuk menghindari module-loader bundling issues
const getOrt = () => window.ort || (typeof globalThis !== 'undefined' ? globalThis.ort : null);

if (typeof window !== 'undefined' && window.ort && window.ort.env && window.ort.env.wasm) {
  window.ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/';
  window.ort.env.wasm.numThreads = 1;
}

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
    this.isModelLoaded = false;
    this.isLoading = false;
    this.loadTimeMs = 0;

    this.confThreshold = 0.45;
    this.iouThreshold = 0.45;

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
   * Memuat model aktif saat ini
   */
  async loadModel(onProgress = null) {
    if (this.isModelLoaded && this.session) {
      return true;
    }

    if (this.isLoading) {
      console.warn('[VisionX] Model sedang dimuat, menunggu...');
      return false;
    }

    this.isLoading = true;
    const startLoadTime = performance.now();

    try {
      console.log(`[VisionX] Memuat model [${this.modelConfig.name}] dari: ${this.modelPath}`);
      if (onProgress) onProgress(`Memuat model ${this.modelConfig.shortName}...`);

      const ortInstance = getOrt();
      if (!ortInstance) {
        throw new Error('ONNX Runtime Web (ort) belum dimuat.');
      }

      if (ortInstance.env && ortInstance.env.wasm) {
        ortInstance.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/';
        ortInstance.env.wasm.numThreads = 1;
      }

      // Bersihkan sesi lama jika ada
      if (this.session) {
        try {
          if (typeof this.session.release === 'function') {
            await this.session.release();
          }
        } catch (e) {
          console.warn('[VisionX] Gagal merilis session lama:', e);
        }
        this.session = null;
      }

      this.session = await ortInstance.InferenceSession.create(this.modelPath, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all'
      });

      this.isModelLoaded = true;
      this.loadTimeMs = Math.round(performance.now() - startLoadTime);
      console.log(`[VisionX] Model [${this.modelConfig.name}] siap dalam ${this.loadTimeMs} ms!`);
      if (onProgress) onProgress(`${this.modelConfig.shortName} Aktif (${this.loadTimeMs}ms)`);
      return true;
    } catch (err) {
      console.error(`[VisionX] Gagal memuat model [${this.modelConfig.name}]:`, err);
      this.isModelLoaded = false;
      this.session = null;
      throw err;
    } finally {
      this.isLoading = false;
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
      return { success: true, loadTimeMs: this.loadTimeMs, modelConfig: this.modelConfig };
    }

    console.log(`[VisionX] Mengganti model aktif ke: ${modelId}`);
    this.activeModelId = modelId;
    this.modelConfig = MODEL_PRESETS[modelId];
    this.modelPath = this.modelConfig.path;
    this.classes = this.modelConfig.classes;
    this.numClasses = this.modelConfig.numClasses;
    this.modelName = this.modelConfig.name;
    this.isModelLoaded = false;

    await this.loadModel(onProgress);

    return {
      success: true,
      loadTimeMs: this.loadTimeMs,
      modelConfig: this.modelConfig
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
    if (!this.isActive || !this.session || !this.isModelLoaded) {
      return { detections: [], rawDetections: [], frameId: 0, inferenceTimeMs: 0, modelId: this.activeModelId };
    }

    if (this.isInferencing) {
      return null;
    }

    const frameId = ++this.currentFrameId;
    const startTime = performance.now();
    this.isInferencing = true;

    try {
      const { inputTensor, scale, padX, padY, vw, vh } = this._preprocess(video);

      // Jalankan inferensi ONNX
      const feeds = { images: inputTensor };
      const outputMap = await this.session.run(feeds);

      if (frameId < this.latestCompletedFrameId) {
        return null;
      }
      this.latestCompletedFrameId = frameId;

      const outputTensor = outputMap.output0 || Object.values(outputMap)[0];
      const outputData = outputTensor.data;
      
      // Dynamic tensor dimension detection
      // Format YOLOv8: [1, 4 + numClasses, numAnchors]
      const dims = outputTensor.dims || [1, 4 + this.numClasses, 8400];
      const numChannels = dims[1];
      const numAnchors = dims[2] || 8400;
      const numClasses = numChannels - 4;
      const activeClasses = this.classes;

      const rawCandidates = [];

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

        // Confidence Filtering
        if (maxScore >= this.confThreshold && maxClassId >= 0 && maxClassId < activeClasses.length) {
          const cx = outputData[0 * numAnchors + i];
          const cy = outputData[1 * numAnchors + i];
          const w = outputData[2 * numAnchors + i];
          const h = outputData[3 * numAnchors + i];

          // Unpad & Scale back ke koordinat video
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

      return {
        detections: finalDetections,
        rawDetections: rawCandidates,
        frameId,
        inferenceTimeMs,
        modelId: this.activeModelId,
        modelName: this.modelConfig.name,
        loadTimeMs: this.loadTimeMs
      };
    } catch (err) {
      console.error('[VisionX] Kesalahan saat inferensi:', err);
      return { detections: [], rawDetections: [], frameId, inferenceTimeMs: 0, modelId: this.activeModelId };
    } finally {
      this.isInferencing = false;
    }
  }
}
