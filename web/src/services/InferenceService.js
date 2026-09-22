/**
 * InferenceService - Real Ultralytics YOLOv8 ONNX Inference Engine for Browser
 * 
 * Mengimplementasikan:
 * 1. Letterbox Preprocessing (640x640, RGB, aspect ratio preserved, gray padding 114)
 * 2. Planar Float32Array [1, 3, 640, 640] normalized [0, 1]
 * 3. ONNX Runtime Web session execution
 * 4. Post-processing: Box decoding, unpadding, scaling ke video dimensions
 * 5. Non-Maximum Suppression (NMS) berbasis IoU
 * 6. Frame ID & timestamp sequencing untuk mencegah frame lama menimpa frame baru
 */

// Gunakan window.ort dari ort.min.js untuk menghindari module-loader bundling issues
const getOrt = () => window.ort || (typeof globalThis !== 'undefined' ? globalThis.ort : null);

if (typeof window !== 'undefined' && window.ort && window.ort.env && window.ort.env.wasm) {
  window.ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/';
  window.ort.env.wasm.numThreads = 1;
}

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
  // Urutkan candidates berdasarkan confidence descending
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

      // NMS per class (atau lintas kelas jika desired, standar YOLO per class)
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
  constructor(modelPath = '/models/yolov8n.onnx') {
    this.modelPath = modelPath;
    this.session = null;
    this.isActive = true;
    this.isModelLoaded = false;
    this.modelName = 'YOLOv8n (ONNX Runtime Web)';
    this.confThreshold = 0.45;
    this.iouThreshold = 0.45;

    // Frame sequence tracking (mencegah out-of-order execution)
    this.currentFrameId = 0;
    this.latestCompletedFrameId = 0;
    this.isInferencing = false;

    // Canvas internal untuk preprocessing letterbox
    this.preprocessCanvas = document.createElement('canvas');
    this.preprocessCanvas.width = 640;
    this.preprocessCanvas.height = 640;
    this.preprocessCtx = this.preprocessCanvas.getContext('2d', { willReadFrequently: true });
  }

  async loadModel(onProgress = null) {
    if (this.isModelLoaded && this.session) {
      return true;
    }

    try {
      console.log(`[VisionX] Memuat model ONNX dari: ${this.modelPath}`);
      if (onProgress) onProgress('Memuat model ONNX YOLOv8...');

      const ortInstance = getOrt();
      if (!ortInstance) {
        throw new Error('ONNX Runtime Web (ort) belum dimuat.');
      }

      if (ortInstance.env && ortInstance.env.wasm) {
        ortInstance.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/';
        ortInstance.env.wasm.numThreads = 1;
      }

      this.session = await ortInstance.InferenceSession.create(this.modelPath, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all'
      });

      this.isModelLoaded = true;
      console.log('[VisionX] Model ONNX YOLOv8 berhasil dimuat di browser!');
      if (onProgress) onProgress('Model YOLOv8 siap!');
      return true;
    } catch (err) {
      console.error('[VisionX] Gagal memuat model ONNX:', err);
      this.isModelLoaded = false;
      throw err;
    }
  }

  /**
   * Letterbox Preprocessing
   * Menjaga aspect ratio video, meresize ke 640x640 dengan padding abu-abu (114).
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
    // Latar abu-abu standar YOLO (114, 114, 114)
    ctx.fillStyle = '#727272';
    ctx.fillRect(0, 0, targetDim, targetDim);

    // Gambar video ke canvas letterbox
    ctx.drawImage(video, padX, padY, nw, nh);

    const imgData = ctx.getImageData(0, 0, targetDim, targetDim);
    const pixels = imgData.data; // RGBA uint8

    // Bentuk Float32Array planar [1, 3, 640, 640]
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
   * Menjalankan inferensi pada video frame secara realtime.
   * Dilengkapi frame ID sequencing untuk mencegah race condition.
   */
  async detect(video) {
    if (!this.isActive || !this.session || !this.isModelLoaded) {
      return { detections: [], rawDetections: [], frameId: 0, inferenceTimeMs: 0 };
    }

    // Jika inferensi sebelumnya masih berjalan, skip frame ini (drop frame)
    // agar pipeline tidak menumpuk dan latency tetap 0
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

      // Check frame order: jika ada frame yang lebih baru sudah selesai, buang hasil ini
      if (frameId < this.latestCompletedFrameId) {
        console.warn(`[VisionX] Mengabaikan hasil frame usang #${frameId} (latest: #${this.latestCompletedFrameId})`);
        return null;
      }
      this.latestCompletedFrameId = frameId;

      const outputTensor = outputMap.output0 || Object.values(outputMap)[0];
      const outputData = outputTensor.data; // Shape: [1, 84, 8400]

      const numChannels = 84;
      const numAnchors = 8400;
      const rawCandidates = [];

      // Parse 8400 anchors
      for (let i = 0; i < numAnchors; i++) {
        // Cari class dengan score tertinggi di antara 80 kelas COCO
        let maxScore = -1;
        let maxClassId = -1;

        for (let c = 0; c < 80; c++) {
          const score = outputData[(4 + c) * numAnchors + i];
          if (score > maxScore) {
            maxScore = score;
            maxClassId = c;
          }
        }

        // Confidence Filtering
        if (maxScore >= this.confThreshold) {
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

          // Validasi box
          if (x2 > x1 && y2 > y1) {
            rawCandidates.push({
              class_id: maxClassId,
              class_name: COCO_CLASSES[maxClassId] || `class_${maxClassId}`,
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
        inferenceTimeMs
      };
    } catch (err) {
      console.error('[VisionX] Kesalahan saat inferensi:', err);
      return { detections: [], rawDetections: [], frameId, inferenceTimeMs: 0 };
    } finally {
      this.isInferencing = false;
    }
  }
}
