/**
 * main.js - Application Controller untuk VisionX Web Interface
 * Mengorkestrasi CameraService, Real YOLOv8 ONNX Inference, DetectionRenderer, FPS Counter,
 * dan Raw Detection Debug Inspector.
 */

import { CameraService } from './services/CameraService.js';
import { YOLOInferenceService } from './services/InferenceService.js';
import { DetectionRenderer } from './services/DetectionRenderer.js';

class VisionXWebApp {
  constructor() {
    // Services
    this.cameraService = new CameraService();
    this.inferenceService = new YOLOInferenceService('/models/yolov8n.onnx');
    this.renderer = null;

    // DOM Elements
    this.elements = {
      video: document.getElementById('videoElement'),
      canvas: document.getElementById('canvasOverlay'),
      placeholder: document.getElementById('cameraPlaceholder'),
      btnStart: document.getElementById('btnStart'),
      btnStop: document.getElementById('btnStop'),
      deviceSelect: document.getElementById('deviceSelect'),
      toggleInference: document.getElementById('toggleInference'),
      confSlider: document.getElementById('confSlider'),
      confVal: document.getElementById('confVal'),
      iouSlider: document.getElementById('iouSlider'),
      iouVal: document.getElementById('iouVal'),
      toggleDebug: document.getElementById('toggleDebug'),
      debugPanel: document.getElementById('debugPanel'),
      debugModelName: document.getElementById('debugModelName'),
      debugLatency: document.getElementById('debugLatency'),
      debugFrameId: document.getElementById('debugFrameId'),
      debugTableBody: document.getElementById('debugTableBody'),
      cameraBadge: document.getElementById('cameraBadge'),
      cameraStatusText: document.getElementById('cameraStatusText'),
      inferenceBadge: document.getElementById('inferenceBadge'),
      inferenceStatusText: document.getElementById('inferenceStatusText'),
      fpsValue: document.getElementById('fpsValue'),
      errorBanner: document.getElementById('errorBanner'),
      errorMessage: document.getElementById('errorMessage')
    };

    // Animation & FPS tracking
    this.animationFrameId = null;
    this.prevTime = performance.now();
    this.fpsSmooth = 0;
    this.alphaFps = 0.9;
    this.isProcessingFrame = false;
    this.isDebugVisible = true;

    this.init();
  }

  async init() {
    // Attach video ke camera service
    this.cameraService.attachVideoElement(this.elements.video);

    // Inisialisasi DetectionRenderer
    this.renderer = new DetectionRenderer(this.elements.canvas);

    // Bind event listeners
    this.bindEvents();

    // Muat model ONNX YOLOv8
    this.updateInferenceUI(false, 'Memuat model YOLOv8 ONNX (~12MB)...');
    try {
      await this.inferenceService.loadModel((msg) => {
        this.updateInferenceUI(false, msg);
      });
      this.updateInferenceUI(this.inferenceService.isActive, 'YOLOv8n ONNX Active');
      this.elements.debugModelName.textContent = 'YOLOv8n ONNX (WASM)';
    } catch (err) {
      console.error('[VisionX] Gagal memuat model ONNX:', err);
      this.updateInferenceUI(false, 'Gagal memuat model ONNX');
      this.showError('Gagal memuat model YOLOv8 ONNX: ' + (err.message || 'File tidak ditemukan'));
    }

    // Populate camera devices list
    await this.loadCameraDevices();
  }

  bindEvents() {
    // Tombol Start
    this.elements.btnStart.addEventListener('click', () => this.handleStartCamera());

    // Tombol Stop
    this.elements.btnStop.addEventListener('click', () => this.handleStopCamera());

    // Switch device kamera
    this.elements.deviceSelect.addEventListener('change', (e) => {
      const selectedId = e.target.value || null;
      if (this.cameraService.state.status === 'connected') {
        this.handleStartCamera(selectedId);
      }
    });

    // Toggle Inferensi AI
    this.elements.toggleInference.addEventListener('change', (e) => {
      this.inferenceService.isActive = e.target.checked;
      this.updateInferenceUI(e.target.checked, e.target.checked ? 'YOLOv8n ONNX Active' : 'Inference Inactive');
    });

    // Confidence Threshold Slider
    this.elements.confSlider.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      this.inferenceService.confThreshold = val;
      this.elements.confVal.textContent = val.toFixed(2);
    });

    // IoU Threshold Slider
    this.elements.iouSlider.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      this.inferenceService.iouThreshold = val;
      this.elements.iouVal.textContent = val.toFixed(2);
    });

    // Toggle Debug Mode
    this.elements.toggleDebug.addEventListener('change', (e) => {
      this.isDebugVisible = e.target.checked;
      if (this.isDebugVisible) {
        this.elements.debugPanel.classList.remove('hidden');
      } else {
        this.elements.debugPanel.classList.add('hidden');
      }
    });

    // Camera Service Listeners
    this.cameraService.on('stateChange', (state) => this.handleCameraStateChange(state));
    this.cameraService.on('error', (err) => this.handleCameraError(err));
    this.cameraService.on('devicesChange', (devices) => this.populateDeviceSelect(devices));
  }

  async loadCameraDevices() {
    try {
      const devices = await this.cameraService.getDevices();
      this.populateDeviceSelect(devices);
    } catch (err) {
      console.warn('Bisa jadi izin kamera belum diberikan:', err);
    }
  }

  populateDeviceSelect(devices = []) {
    const select = this.elements.deviceSelect;
    const currentVal = select.value;

    select.innerHTML = '<option value="">Default / Auto Camera</option>';

    devices.forEach((dev, idx) => {
      const option = document.createElement('option');
      option.value = dev.deviceId;
      option.textContent = dev.label || `Kamera ${idx + 1} (${dev.deviceId.slice(0, 6)}...)`;
      select.appendChild(option);
    });

    if (currentVal && Array.from(select.options).some(opt => opt.value === currentVal)) {
      select.value = currentVal;
    }
  }

  async handleStartCamera(deviceId = null) {
    this.hideError();
    const targetDeviceId = deviceId || this.elements.deviceSelect.value || null;

    try {
      await this.cameraService.start(targetDeviceId);
      this.startRenderLoop();
    } catch (err) {
      // Error sudah ditangani di handleCameraError
    }
  }

  handleStopCamera() {
    this.stopRenderLoop();
    this.cameraService.stop();
    this.renderer.clear();
    this.elements.fpsValue.textContent = '0.0';
    this.fpsSmooth = 0;
    this.updateDebugTable([], 0, 0);
  }

  handleCameraStateChange(state) {
    const { status, resolution } = state;
    const badge = this.elements.cameraBadge;
    const text = this.elements.cameraStatusText;

    badge.className = 'badge';

    if (status === 'connected') {
      badge.classList.add('badge-connected');
      text.textContent = `Camera Connected (${resolution.width}x${resolution.height})`;
      this.elements.placeholder.classList.add('hidden');
      this.elements.btnStart.disabled = true;
      this.elements.btnStop.disabled = false;
    } else if (status === 'connecting') {
      badge.classList.add('badge-connecting');
      text.textContent = 'Requesting Camera Access...';
      this.elements.btnStart.disabled = true;
      this.elements.btnStop.disabled = true;
    } else if (status === 'error') {
      badge.classList.add('badge-error');
      text.textContent = 'Camera Error';
      this.elements.placeholder.classList.remove('hidden');
      this.elements.btnStart.disabled = false;
      this.elements.btnStop.disabled = true;
    } else {
      badge.classList.add('badge-disconnected');
      text.textContent = 'Camera Disconnected';
      this.elements.placeholder.classList.remove('hidden');
      this.elements.btnStart.disabled = false;
      this.elements.btnStop.disabled = true;
    }
  }

  handleCameraError(err) {
    const msg = err.friendlyMessage || err.message || 'Gagal mengakses kamera.';
    this.showError(msg);
  }

  showError(msg) {
    this.elements.errorMessage.textContent = msg;
    this.elements.errorBanner.classList.remove('hidden');
  }

  hideError() {
    this.elements.errorBanner.classList.add('hidden');
  }

  updateInferenceUI(active, textMessage = null) {
    const badge = this.elements.inferenceBadge;
    const text = this.elements.inferenceStatusText;

    badge.className = 'badge';
    if (active) {
      badge.classList.add('badge-connected');
      text.textContent = textMessage || 'YOLOv8n ONNX Active';
    } else {
      badge.classList.add('badge-disconnected');
      text.textContent = textMessage || 'Inference Inactive';
      if (this.renderer) {
        this.renderer.clear();
      }
    }
  }

  startRenderLoop() {
    if (this.animationFrameId) return;

    this.prevTime = performance.now();
    const renderFrame = async () => {
      await this.processFrame();
      this.animationFrameId = requestAnimationFrame(renderFrame);
    };

    this.animationFrameId = requestAnimationFrame(renderFrame);
  }

  stopRenderLoop() {
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  }

  async processFrame() {
    const video = this.elements.video;

    if (!video || video.readyState < 2 || video.paused || video.ended) {
      return;
    }

    // Hitung smoothed FPS
    const currTime = performance.now();
    const delta = (currTime - this.prevTime) / 1000;
    this.prevTime = currTime;

    if (delta > 0) {
      const currentFps = 1.0 / delta;
      this.fpsSmooth = this.fpsSmooth === 0 ? currentFps : (this.alphaFps * this.fpsSmooth + (1 - this.alphaFps) * currentFps);
      this.elements.fpsValue.textContent = this.fpsSmooth.toFixed(1);
    }

    // Sinkronisasi ukuran canvas overlay dengan video resolution
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (vw > 0 && vh > 0) {
      this.renderer.resize(vw, vh);
    }

    // Jalankan inferensi jika aktif dan tidak sedang proses frame lain
    if (this.inferenceService.isActive && !this.isProcessingFrame) {
      this.isProcessingFrame = true;
      try {
        const result = await this.inferenceService.detect(video);
        if (result) {
          const { detections, rawDetections, frameId, inferenceTimeMs } = result;

          // Render canvas overlay
          this.renderer.render(detections, { frameId, inferenceTimeMs });

          // Update Debug Panel
          if (this.isDebugVisible) {
            this.updateDebugTable(detections, frameId, inferenceTimeMs);
          }
        }
      } catch (err) {
        console.error('[VisionX] Inference error in loop:', err);
      } finally {
        this.isProcessingFrame = false;
      }
    }
  }

  updateDebugTable(detections = [], frameId = 0, latencyMs = 0) {
    this.elements.debugFrameId.textContent = `#${frameId}`;
    this.elements.debugLatency.textContent = `${latencyMs} ms`;

    const tbody = this.elements.debugTableBody;

    if (!detections || detections.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="6" class="text-center text-muted" style="padding: 18px 10px;">
            Tidak ada objek terdeteksi (0 bounding box). Latar bersih / objek di bawah threshold ${this.inferenceService.confThreshold}.
          </td>
        </tr>
      `;
      return;
    }

    let rowsHtml = '';
    detections.forEach((det, idx) => {
      const timeStr = new Date(det.timestamp || Date.now()).toLocaleTimeString();
      const confBadge = (det.confidence * 100).toFixed(1) + '%';
      rowsHtml += `
        <tr>
          <td><strong>${idx + 1}</strong></td>
          <td><span style="color: #38bdf8; font-weight: 600;">${det.class_name}</span></td>
          <td><span style="color: #10b981;">${confBadge}</span></td>
          <td>[${det.x1}, ${det.y1}, ${det.x2}, ${det.y2}]</td>
          <td>#${det.frameId}</td>
          <td>${timeStr}</td>
        </tr>
      `;
    });

    tbody.innerHTML = rowsHtml;
  }
}

// Inisialisasi aplikasi saat DOM siap
document.addEventListener('DOMContentLoaded', () => {
  window.app = new VisionXWebApp();
});
