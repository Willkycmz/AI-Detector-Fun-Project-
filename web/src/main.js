/**
 * main.js - Application Controller untuk VisionX Web Interface (V0.5.1)
 * Mengorkestrasi:
 * - CameraService (Webcam stream, multi-device, auto-resolution)
 * - YOLOInferenceService (Model selector: VisionX V1 7 Classes <-> Pretrained YOLOv8n 80 Classes)
 * - DetectionRenderer (Realtime bounding boxes, synchronized canvas overlays, neon palette)
 * - DatasetCaptureService (Capture, Single Delete, Multi-Delete, Import Image & Folder, Hashing)
 * - FPS Counter & Live Debug Inspector
 * - Mode Switcher (Detection <-> Collection)
 */

import { CameraService } from './services/CameraService.js';
import { YOLOInferenceService, MODEL_PRESETS, VISIONX_V1_CLASSES } from './services/InferenceService.js';
import { DetectionRenderer } from './services/DetectionRenderer.js';
import { DatasetCaptureService, validateClassName, SUPPORTED_IMPORT_EXTENSIONS } from './services/DatasetCaptureService.js';

class VisionXWebApp {
  constructor() {
    // Services
    this.cameraService = new CameraService();
    // Default aktif ke Custom VisionX V1 (7 classes)
    this.inferenceService = new YOLOInferenceService('visionx_v1');
    this.captureService = new DatasetCaptureService();
    this.renderer = null;

    // State
    this.currentMode = 'detection'; // 'detection' | 'collection'
    this.animationFrameId = null;
    this.prevTime = performance.now();
    this.fpsSmooth = 0;
    this.alphaFps = 0.9;
    this.isProcessingFrame = false;
    this.isDebugVisible = true;

    // Multi-Select State
    this.isSelectMode = false;
    this.selectedItems = new Set();
    this.pendingDeleteAction = null;
    this.pendingFolderImportFiles = null;

    // DOM Elements
    this.elements = {
      // Stage & Video
      video: document.getElementById('videoElement'),
      canvas: document.getElementById('canvasOverlay'),
      placeholder: document.getElementById('cameraPlaceholder'),
      shutterFlash: document.getElementById('shutterFlash'),
      stageWatermark: document.getElementById('stageWatermark'),
      watermarkMode: document.getElementById('watermarkMode'),
      watermarkExtra: document.getElementById('watermarkExtra'),

      // Header & Badges
      btnModeDetect: document.getElementById('btnModeDetect'),
      btnModeCollect: document.getElementById('btnModeCollect'),
      modeBadge: document.getElementById('modeBadge'),
      modeStatusText: document.getElementById('modeStatusText'),
      cameraBadge: document.getElementById('cameraBadge'),
      cameraStatusText: document.getElementById('cameraStatusText'),
      activeModelBadge: document.getElementById('activeModelBadge'),
      activeModelBadgeText: document.getElementById('activeModelBadgeText'),
      inferenceBadge: document.getElementById('inferenceBadge'),
      inferenceStatusText: document.getElementById('inferenceStatusText'),
      detectionCountBadge: document.getElementById('detectionCountBadge'),
      detectionCountValue: document.getElementById('detectionCountValue'),
      classBadge: document.getElementById('classBadge'),
      badgeClassName: document.getElementById('badgeClassName'),
      countBadge: document.getElementById('countBadge'),
      badgeImageCount: document.getElementById('badgeImageCount'),
      fpsValue: document.getElementById('fpsValue'),
      errorBanner: document.getElementById('errorBanner'),
      errorMessage: document.getElementById('errorMessage'),
      successBanner: document.getElementById('successBanner'),
      successMessage: document.getElementById('successMessage'),

      // Global Camera Controls
      btnStart: document.getElementById('btnStart'),
      btnStop: document.getElementById('btnStop'),
      deviceSelect: document.getElementById('deviceSelect'),

      // Detection Mode Controls (V0.5.1)
      detectionControls: document.getElementById('detectionControls'),
      modelSelect: document.getElementById('modelSelect'),
      modelArchTag: document.getElementById('modelArchTag'),
      modelClassesTag: document.getElementById('modelClassesTag'),
      modelLoadTimeTag: document.getElementById('modelLoadTimeTag'),
      targetChipsContainer: document.getElementById('targetChipsContainer'),
      toggleInference: document.getElementById('toggleInference'),
      confSlider: document.getElementById('confSlider'),
      confVal: document.getElementById('confVal'),
      iouSlider: document.getElementById('iouSlider'),
      iouVal: document.getElementById('iouVal'),
      toggleDebug: document.getElementById('toggleDebug'),

      // Debug Panel & Live Diagnostics (V0.5.1 Audit)
      debugPanel: document.getElementById('debugPanel'),
      debugModelName: document.getElementById('debugModelName'),
      debugLoadTime: document.getElementById('debugLoadTime'),
      debugLatency: document.getElementById('debugLatency'),
      debugObjectCount: document.getElementById('debugObjectCount'),
      debugFrameId: document.getElementById('debugFrameId'),
      debugTableBody: document.getElementById('debugTableBody'),
      diagModelState: document.getElementById('diagModelState'),
      diagLoadStarted: document.getElementById('diagLoadStarted'),
      diagFetchStarted: document.getElementById('diagFetchStarted'),
      diagFetchCompleted: document.getElementById('diagFetchCompleted'),
      diagModelSize: document.getElementById('diagModelSize'),
      diagSessionInit: document.getElementById('diagSessionInit'),
      diagInputShape: document.getElementById('diagInputShape'),
      diagOutputShape: document.getElementById('diagOutputShape'),
      diagFirstInferStart: document.getElementById('diagFirstInferStart'),
      diagFirstInferComplete: document.getElementById('diagFirstInferComplete'),
      diagFirstInferLatency: document.getElementById('diagFirstInferLatency'),
      diagRawPreds: document.getElementById('diagRawPreds'),
      diagAfterConf: document.getElementById('diagAfterConf'),
      diagAfterNms: document.getElementById('diagAfterNms'),

      // Collection Mode Controls
      collectionControls: document.getElementById('collectionControls'),
      inputClassName: document.getElementById('inputClassName'),
      btnSetClass: document.getElementById('btnSetClass'),
      classValidationHint: document.getElementById('classValidationHint'),
      sourceSelect: document.getElementById('sourceSelect'),
      activeClassDisplay: document.getElementById('activeClassDisplay'),
      activeCountDisplay: document.getElementById('activeCountDisplay'),
      btnCapture: document.getElementById('btnCapture'),
      btnSelectDir: document.getElementById('btnSelectDir'),
      dirStatusText: document.getElementById('dirStatusText'),
      storagePathDisplay: document.getElementById('storagePathDisplay'),
      classPills: document.querySelectorAll('.class-pill'),

      // Import Toolbar
      inputImportImages: document.getElementById('inputImportImages'),
      btnTriggerImportImages: document.getElementById('btnTriggerImportImages'),
      inputImportFolder: document.getElementById('inputImportFolder'),
      btnTriggerImportFolder: document.getElementById('btnTriggerImportFolder'),

      // Gallery & Multi-Delete
      recentCapturesList: document.getElementById('recentCapturesList'),
      recentCapturesCount: document.getElementById('recentCapturesCount'),
      btnToggleSelectMode: document.getElementById('btnToggleSelectMode'),
      selectionControls: document.getElementById('selectionControls'),
      btnSelectAll: document.getElementById('btnSelectAll'),
      btnClearSelection: document.getElementById('btnClearSelection'),
      btnDeleteSelected: document.getElementById('btnDeleteSelected'),
      deleteSelectedText: document.getElementById('deleteSelectedText'),

      // Modals
      confirmModal: document.getElementById('confirmModal'),
      modalTitle: document.getElementById('modalTitle'),
      modalDescription: document.getElementById('modalDescription'),
      modalItemPreview: document.getElementById('modalItemPreview'),
      modalCloseBtn: document.getElementById('modalCloseBtn'),
      modalCancelBtn: document.getElementById('modalCancelBtn'),
      modalConfirmBtn: document.getElementById('modalConfirmBtn'),

      folderImportModal: document.getElementById('folderImportModal'),
      folderModalSummary: document.getElementById('folderModalSummary'),
      folderTargetClass: document.getElementById('folderTargetClass'),
      folderTargetSource: document.getElementById('folderTargetSource'),
      folderModalCloseBtn: document.getElementById('folderModalCloseBtn'),
      folderModalCancelBtn: document.getElementById('folderModalCancelBtn'),
      folderModalConfirmBtn: document.getElementById('folderModalConfirmBtn')
    };

    this.init();
  }

  async init() {
    try {
      // 1. Attach video ke CameraService
      this.cameraService.attachVideoElement(this.elements.video);

      // 2. Inisialisasi DetectionRenderer
      this.renderer = new DetectionRenderer(this.elements.canvas);

      // 3. Bind Event Listeners
      this.bindEvents();

      // 4. Update initial collection UI & load dataset from disk
      if (this.elements.inputClassName) {
        this.elements.inputClassName.value = this.captureService.currentClass;
      }
      this.updateCollectionUI();
      try {
        await this.captureService.loadExistingDataset();
        this.renderRecentCaptures();
        this.updateCollectionUI();
      } catch (galleryErr) {
        console.warn('[VisionX] Peringatan inisialisasi galeri (non-blocking):', galleryErr);
      }

      // 5. Muat default model (VisionX V1 Custom 7 Classes)
      await this.loadSelectedModel('visionx_v1');

      // 6. Populate camera devices list
      await this.loadCameraDevices();
    } catch (fatalErr) {
      console.error('[VisionX Fatal] Gagal inisialisasi aplikasi:', fatalErr);
      this.updateInferenceUI('error', 'Init Error: ' + fatalErr.message);
      this.showError('Gagal memuat aplikasi: ' + fatalErr.message);
    }
  }

  /**
   * Memuat model ONNX yang dipilih dan memperbarui semua tampilan UI
   */
  async loadSelectedModel(modelId) {
    const config = MODEL_PRESETS[modelId] || MODEL_PRESETS.visionx_v1;
    this.updateInferenceUI('loading', `Memuat ${config.shortName}...`);
    this.updateDiagnosticsUI();

    try {
      const res = await this.inferenceService.switchModel(modelId, (msg) => {
        this.updateInferenceUI('loading', msg);
        this.updateDiagnosticsUI();
      });

      this.updateModelUI(config, res.loadTimeMs);
      this.updateInferenceUI('ready', `${config.shortName} Ready (${res.loadTimeMs}ms)`);
      this.updateDiagnosticsUI();
      this.showSuccess(`Model [${config.name}] siap digunakan (${res.loadTimeMs} ms)`);
    } catch (err) {
      console.error(`[VisionX] Gagal memuat model [${modelId}]:`, err);
      this.updateInferenceUI('error', `Error: ${err.message || 'Gagal memuat model'}`);
      this.updateDiagnosticsUI();
      this.showError(`Gagal memuat ${config.name}: ` + (err.message || 'File ONNX tidak ditemukan'));
    }
  }

  /**
   * Sinkronisasi UI dengan model yang aktif
   */
  updateModelUI(config, loadTimeMs = 0) {
    // Update badge di header
    const badge = this.elements.activeModelBadge;
    const badgeText = this.elements.activeModelBadgeText;
    badge.className = 'badge ' + (config.isCustom ? 'badge-model-custom' : 'badge-model-pretrained');
    badgeText.textContent = config.isCustom ? 'VisionX V1 (Custom 7 Classes)' : 'Pretrained YOLO (COCO 80 Classes)';

    // Update tags di control panel
    if (this.elements.modelArchTag) {
      this.elements.modelArchTag.textContent = 'Arch: YOLOv8n';
    }
    if (this.elements.modelClassesTag) {
      this.elements.modelClassesTag.textContent = `Classes: ${config.numClasses}`;
    }
    if (this.elements.modelLoadTimeTag) {
      this.elements.modelLoadTimeTag.textContent = `Load: ${loadTimeMs || this.inferenceService.loadTimeMs || '--'} ms`;
    }

    // Update debug panel meta
    if (this.elements.debugModelName) {
      this.elements.debugModelName.textContent = config.name;
    }
    if (this.elements.debugLoadTime) {
      this.elements.debugLoadTime.textContent = `${loadTimeMs || this.inferenceService.loadTimeMs || 0} ms`;
    }

    // Render target class chips
    this.renderTargetClassChips(config);
    this.updateDiagnosticsUI();
  }

  /**
   * Render chip kelas target di bawah selector model
   */
  renderTargetClassChips(config) {
    const container = this.elements.targetChipsContainer;
    if (!container) return;

    if (config.isCustom) {
      // Tampilkan 7 kelas VisionX
      let chipsHtml = `<span class="chips-label">VisionX V1 Classes (${config.classes.length}):</span>`;
      config.classes.forEach(cls => {
        chipsHtml += `<span class="class-chip" data-chip-class="${cls}">${cls}</span>`;
      });
      container.innerHTML = chipsHtml;
      container.classList.remove('hidden');
    } else {
      // COCO ada 80 kelas, tampilkan ringkasan + kelas utama
      let chipsHtml = `<span class="chips-label">COCO Classes (80 total):</span>`;
      const sampleCoco = ['person', 'bottle', 'cup', 'laptop', 'mouse', 'keyboard', 'cell phone', 'car', 'chair', '...'];
      sampleCoco.forEach(cls => {
        chipsHtml += `<span class="class-chip" data-chip-class="${cls}">${cls}</span>`;
      });
      container.innerHTML = chipsHtml;
      container.classList.remove('hidden');
    }
  }

  bindEvents() {
    // Mode Switcher Tabs
    this.elements.btnModeDetect.addEventListener('click', () => this.setMode('detection'));
    this.elements.btnModeCollect.addEventListener('click', () => this.setMode('collection'));

    // Camera Start / Stop
    this.elements.btnStart.addEventListener('click', () => this.handleStartCamera());
    this.elements.btnStop.addEventListener('click', () => this.handleStopCamera());

    // Switch device kamera
    this.elements.deviceSelect.addEventListener('change', (e) => {
      const selectedId = e.target.value || null;
      if (this.cameraService.state.status === 'connected') {
        this.handleStartCamera(selectedId);
      }
    });

    // Model Selector Change (V0.5.1)
    this.elements.modelSelect.addEventListener('change', async (e) => {
      const selectedModelId = e.target.value;
      await this.loadSelectedModel(selectedModelId);
    });

    // Toggle Inferensi AI
    this.elements.toggleInference.addEventListener('change', (e) => {
      this.inferenceService.isActive = e.target.checked;
      const modelName = this.inferenceService.modelConfig.shortName;
      this.updateInferenceUI(e.target.checked, e.target.checked ? `${modelName} Aktif` : 'Inference Inactive');
    });

    // Confidence Slider
    this.elements.confSlider.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      this.inferenceService.confThreshold = val;
      this.elements.confVal.textContent = val.toFixed(2);
    });

    // IoU Slider
    this.elements.iouSlider.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      this.inferenceService.iouThreshold = val;
      this.elements.iouVal.textContent = val.toFixed(2);
    });

    // Toggle Debug Mode
    this.elements.toggleDebug.addEventListener('change', (e) => {
      this.isDebugVisible = e.target.checked;
      if (this.currentMode === 'detection') {
        if (this.isDebugVisible) {
          this.elements.debugPanel.classList.remove('hidden');
        } else {
          this.elements.debugPanel.classList.add('hidden');
        }
      }
    });

    // Collection Mode: Class Name Input & Buttons
    this.elements.btnSetClass.addEventListener('click', () => this.handleSetClass());
    this.elements.inputClassName.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.handleSetClass();
      }
    });

    // Source Selector
    this.elements.sourceSelect.addEventListener('change', (e) => {
      this.captureService.setSource(e.target.value);
      this.updateCollectionUI();
    });

    // Quick Class Pills
    this.elements.classPills.forEach(pill => {
      pill.addEventListener('click', () => {
        const cls = pill.dataset.class;
        if (cls) {
          this.elements.inputClassName.value = cls;
          this.handleSetClass(cls);
        }
      });
    });

    // Capture Button
    this.elements.btnCapture.addEventListener('click', () => this.handleCapture());

    // Storage Directory Picker (File System Access API)
    this.elements.btnSelectDir.addEventListener('click', () => this.handleSelectDirectory());

    // Import Image Files
    this.elements.btnTriggerImportImages.addEventListener('click', () => {
      this.elements.inputImportImages.click();
    });
    this.elements.inputImportImages.addEventListener('change', (e) => this.handleImportImages(e.target.files));

    // Import Folder
    this.elements.btnTriggerImportFolder.addEventListener('click', () => {
      this.elements.inputImportFolder.click();
    });
    this.elements.inputImportFolder.addEventListener('change', (e) => this.handleFolderSelected(e.target.files));

    // Multi-Select & Delete Actions
    this.elements.btnToggleSelectMode.addEventListener('click', () => this.toggleSelectMode());
    this.elements.btnSelectAll.addEventListener('click', () => this.selectAllCaptures());
    this.elements.btnClearSelection.addEventListener('click', () => this.clearSelection());
    this.elements.btnDeleteSelected.addEventListener('click', () => this.handleDeleteSelectedPrompt());

    // Confirmation Modal Listeners
    this.elements.modalCloseBtn.addEventListener('click', () => this.closeConfirmModal());
    this.elements.modalCancelBtn.addEventListener('click', () => this.closeConfirmModal());
    this.elements.modalConfirmBtn.addEventListener('click', () => {
      if (this.pendingDeleteAction) {
        this.pendingDeleteAction();
      }
      this.closeConfirmModal();
    });

    // Folder Import Modal Listeners
    this.elements.folderModalCloseBtn.addEventListener('click', () => this.closeFolderModal());
    this.elements.folderModalCancelBtn.addEventListener('click', () => this.closeFolderModal());
    this.elements.folderModalConfirmBtn.addEventListener('click', () => this.executeFolderImport());

    // Camera Service Listeners
    this.cameraService.on('stateChange', (state) => this.handleCameraStateChange(state));
    this.cameraService.on('error', (err) => this.handleCameraError(err));
    this.cameraService.on('devicesChange', (devices) => this.populateDeviceSelect(devices));

    // Dataset Capture Service Listeners
    this.captureService.on('classChange', () => this.updateCollectionUI());
    this.captureService.on('countChange', () => this.updateCollectionUI());
    this.captureService.on('directoryChange', (dirInfo) => this.handleDirectoryChange(dirInfo));

    // Keyboard Shortcuts (Space, C, N, M)
    window.addEventListener('keydown', (e) => this.handleGlobalKeydown(e));
  }

  /**
   * Mengganti Mode aplikasi: 'detection' atau 'collection'
   */
  setMode(mode) {
    if (mode !== 'detection' && mode !== 'collection') return;
    this.currentMode = mode;

    if (mode === 'detection') {
      this.elements.btnModeDetect.classList.add('active');
      this.elements.btnModeDetect.setAttribute('aria-selected', 'true');
      this.elements.btnModeCollect.classList.remove('active');
      this.elements.btnModeCollect.setAttribute('aria-selected', 'false');

      this.elements.modeBadge.className = 'badge badge-mode-detect';
      this.elements.modeStatusText.textContent = 'Detection Mode';

      this.elements.activeModelBadge.classList.remove('hidden');
      this.elements.inferenceBadge.classList.remove('hidden');
      this.elements.detectionCountBadge.classList.remove('hidden');
      this.elements.classBadge.classList.add('hidden');
      this.elements.countBadge.classList.add('hidden');

      this.elements.detectionControls.classList.remove('hidden');
      this.elements.collectionControls.classList.add('hidden');
      if (this.isDebugVisible) {
        this.elements.debugPanel.classList.remove('hidden');
      }

      this.elements.stageWatermark.className = 'stage-watermark';
      this.elements.watermarkMode.textContent = 'DETECTION';
      this.elements.watermarkExtra.textContent = '';
    } else {
      this.elements.btnModeCollect.classList.add('active');
      this.elements.btnModeCollect.setAttribute('aria-selected', 'true');
      this.elements.btnModeDetect.classList.remove('active');
      this.elements.btnModeDetect.setAttribute('aria-selected', 'false');

      this.elements.modeBadge.className = 'badge badge-mode-collect';
      this.elements.modeStatusText.textContent = 'Collection Mode';

      this.elements.activeModelBadge.classList.add('hidden');
      this.elements.inferenceBadge.classList.add('hidden');
      this.elements.detectionCountBadge.classList.add('hidden');
      this.elements.classBadge.classList.remove('hidden');
      this.elements.countBadge.classList.remove('hidden');

      this.elements.detectionControls.classList.add('hidden');
      this.elements.collectionControls.classList.remove('hidden');
      this.elements.debugPanel.classList.add('hidden');

      if (this.renderer) {
        this.renderer.clear();
      }

      this.elements.stageWatermark.className = 'stage-watermark collect-mode';
      this.elements.watermarkMode.textContent = 'COLLECTION';
      this.elements.watermarkExtra.textContent = `[${this.captureService.currentClass}]`;

      this.updateCollectionUI();
    }
  }

  handleSetClass(targetName = null) {
    const rawName = targetName || this.elements.inputClassName.value;
    const hint = this.elements.classValidationHint;

    try {
      const sanitized = this.captureService.setClass(rawName);
      this.elements.inputClassName.value = sanitized;
      hint.textContent = `Kelas aktif: "${sanitized}". Siap mengambil/mengimpor dataset.`;
      hint.className = 'validation-hint';
      this.updateCollectionUI();
    } catch (err) {
      hint.textContent = err.message;
      hint.className = 'validation-hint error';
    }
  }

  updateCollectionUI() {
    const currentClass = this.captureService.currentClass;
    const currentSource = this.captureService.currentSource;
    const count = this.captureService.getCount();

    this.elements.badgeClassName.textContent = currentClass;
    this.elements.badgeImageCount.textContent = count;
    this.elements.activeClassDisplay.textContent = currentClass;
    this.elements.activeCountDisplay.textContent = count;

    const folderPrefix = currentSource.startsWith('own') ? 'own' : `external/${currentSource}`;
    this.elements.storagePathDisplay.textContent = `datasets/raw/${folderPrefix}/${currentClass}/`;

    if (this.currentMode === 'collection') {
      this.elements.watermarkExtra.textContent = `[${currentClass}]`;
    }
  }

  async handleCapture() {
    if (this.cameraService.state.status !== 'connected') {
      this.showError('Nyalakan kamera terlebih dahulu sebelum mengambil gambar dataset.');
      return;
    }

    try {
      this.triggerShutterFlash();
      const result = await this.captureService.captureFrame(this.elements.video);
      this.renderRecentCaptures();
      this.updateCollectionUI();
      this.showSuccess(`Saved successfully\nClass: ${result.className}\nFile: ${result.filename}\nResolution: ${result.resolution}\nSize: ${result.formattedSize}`);
    } catch (err) {
      console.error('[VisionX] Gagal capture dataset:', err);
      this.showError(err.message || 'Gagal mengambil gambar.');
    }
  }

  triggerShutterFlash() {
    const flash = this.elements.shutterFlash;
    flash.classList.add('active');
    setTimeout(() => {
      flash.classList.remove('active');
    }, 80);
  }

  async handleImportImages(files) {
    if (!files || files.length === 0) return;

    try {
      const targetClass = this.captureService.currentClass;
      const source = this.captureService.currentSource;

      const result = await this.captureService.importImages(files, targetClass, source);
      this.renderRecentCaptures();
      this.updateCollectionUI();

      let msg = `Berhasil mengimpor ${result.imported} gambar ke kelas "${targetClass}".`;
      if (result.duplicates > 0) msg += ` (${result.duplicates} duplikat dilewati).`;
      if (result.skipped > 0) msg += ` (${result.skipped} format tidak didukung).`;

      this.showSuccess(msg);
      this.elements.inputImportImages.value = '';
    } catch (err) {
      this.showError('Gagal mengimpor citra: ' + (err.message || err));
    }
  }

  handleFolderSelected(files) {
    if (!files || files.length === 0) return;

    const validImages = Array.from(files).filter(f => {
      const ext = '.' + f.name.split('.').pop().toLowerCase();
      return SUPPORTED_IMPORT_EXTENSIONS.includes(ext);
    });

    if (validImages.length === 0) {
      this.showError('Tidak ditemukan file gambar yang didukung (.jpg, .jpeg, .png, .webp) di folder tersebut.');
      this.elements.inputImportFolder.value = '';
      return;
    }

    this.pendingFolderImportFiles = validImages;
    this.elements.folderModalSummary.textContent = `Ditemukan ${validImages.length} file gambar valid di folder yang dipilih.`;
    this.elements.folderTargetClass.value = this.captureService.currentClass;
    this.elements.folderTargetSource.value = this.captureService.currentSource;

    this.elements.folderImportModal.classList.remove('hidden');
  }

  closeFolderModal() {
    this.elements.folderImportModal.classList.add('hidden');
    this.pendingFolderImportFiles = null;
    this.elements.inputImportFolder.value = '';
  }

  async executeFolderImport() {
    if (!this.pendingFolderImportFiles || this.pendingFolderImportFiles.length === 0) {
      this.closeFolderModal();
      return;
    }

    const targetClass = this.elements.folderTargetClass.value.trim() || this.captureService.currentClass;
    const targetSource = this.elements.folderTargetSource.value;

    try {
      const result = await this.captureService.importFolder(this.pendingFolderImportFiles, targetClass, targetSource);
      this.renderRecentCaptures();
      this.updateCollectionUI();

      let msg = `Impor folder selesai: ${result.imported} gambar berhasil diimpor ke "${targetClass}".`;
      if (result.duplicates > 0) msg += ` (${result.duplicates} duplikat diabaikan).`;
      this.showSuccess(msg);
    } catch (err) {
      this.showError('Gagal impor folder: ' + err.message);
    } finally {
      this.closeFolderModal();
    }
  }

  promptDeleteSingle(filename, className) {
    this.elements.modalTitle.textContent = 'Konfirmasi Hapus Gambar';
    this.elements.modalDescription.textContent = `Apakah Anda yakin ingin menghapus gambar "${filename}" dari kelas "${className}"?`;
    this.elements.modalItemPreview.textContent = filename;
    this.elements.modalItemPreview.classList.remove('hidden');

    this.pendingDeleteAction = async () => {
      try {
        await this.captureService.deleteItem(filename, className);
        this.selectedItems.delete(filename);
        this.renderRecentCaptures();
        this.updateCollectionUI();
        this.updateMultiSelectUI();
        this.showSuccess(`Gambar "${filename}" berhasil dihapus.`);
      } catch (err) {
        this.showError('Gagal menghapus file: ' + err.message);
      }
    };

    this.elements.confirmModal.classList.remove('hidden');
  }

  toggleSelectMode() {
    this.isSelectMode = !this.isSelectMode;
    if (!this.isSelectMode) {
      this.selectedItems.clear();
    }
    this.updateMultiSelectUI();
    this.renderRecentCaptures();
  }

  toggleItemSelection(filename) {
    if (this.selectedItems.has(filename)) {
      this.selectedItems.delete(filename);
    } else {
      this.selectedItems.add(filename);
    }
    this.updateMultiSelectUI();
    this.renderRecentCaptures();
  }

  selectAllCaptures() {
    const list = this.captureService.getRecentCaptures();
    list.forEach(item => this.selectedItems.add(item.filename));
    this.updateMultiSelectUI();
    this.renderRecentCaptures();
  }

  clearSelection() {
    this.selectedItems.clear();
    this.updateMultiSelectUI();
    this.renderRecentCaptures();
  }

  handleDeleteSelectedPrompt() {
    const count = this.selectedItems.size;
    if (count === 0) return;

    this.elements.modalTitle.textContent = 'Konfirmasi Hapus Massal';
    this.elements.modalDescription.textContent = `Apakah Anda yakin ingin menghapus ${count} gambar yang dipilih dari dataset?`;
    this.elements.modalItemPreview.textContent = `${count} gambar terpilih`;
    this.elements.modalItemPreview.classList.remove('hidden');

    this.pendingDeleteAction = async () => {
      try {
        const filenames = Array.from(this.selectedItems);
        const result = await this.captureService.deleteMultiple(filenames);
        this.selectedItems.clear();
        this.renderRecentCaptures();
        this.updateCollectionUI();
        this.updateMultiSelectUI();
        this.showSuccess(`Berhasil menghapus ${result.deleted} gambar dari dataset.`);
      } catch (err) {
        this.showError('Gagal menghapus massal: ' + err.message);
      }
    };

    this.elements.confirmModal.classList.remove('hidden');
  }

  closeConfirmModal() {
    this.elements.confirmModal.classList.add('hidden');
    this.pendingDeleteAction = null;
  }

  updateMultiSelectUI() {
    const btnToggle = this.elements.btnToggleSelectMode;
    const selectionControls = this.elements.selectionControls;
    const btnDelete = this.elements.btnDeleteSelected;
    const count = this.selectedItems.size;

    if (this.isSelectMode) {
      btnToggle.textContent = 'Selesai Pilih';
      btnToggle.classList.add('btn-secondary');
      btnToggle.classList.remove('btn-outline');
      selectionControls.classList.remove('hidden');
    } else {
      btnToggle.textContent = 'Pilih Banyak';
      btnToggle.classList.remove('btn-secondary');
      btnToggle.classList.add('btn-outline');
      selectionControls.classList.add('hidden');
    }

    this.elements.deleteSelectedText.textContent = `Hapus Terpilih (${count})`;
    btnDelete.disabled = count === 0;
  }

  async handleSelectDirectory() {
    try {
      const ok = await this.captureService.requestDirectoryAccess();
      if (ok) {
        this.showSuccess('Folder datasets/raw berhasil terhubung langsung!');
      }
    } catch (err) {
      this.showError('Akses direktori dibatalkan atau tidak didukung browser ini.');
    }
  }

  handleDirectoryChange(dirInfo) {
    if (dirInfo.hasDirectoryHandle && dirInfo.dirName) {
      this.elements.dirStatusText.textContent = `Terhubung ke: ${dirInfo.dirName}/ (Auto Disk Sync)`;
      this.elements.btnSelectDir.classList.add('btn-success');
    } else {
      this.elements.dirStatusText.textContent = 'Auto Disk Sync (datasets/raw/own/)';
      this.elements.btnSelectDir.classList.remove('btn-success');
    }
  }

  renderRecentCaptures() {
    const list = this.captureService.getRecentCaptures();
    const container = this.elements.recentCapturesList;
    this.elements.recentCapturesCount.textContent = `${list.length} item`;

    if (list.length === 0) {
      container.innerHTML = `<div class="empty-gallery-text">Belum ada gambar pada sesi ini. Tekan tombol Capture, SPACE, atau Impor Citra.</div>`;
      return;
    }

    let html = '';
    list.forEach(item => {
      const isSelected = this.selectedItems.has(item.filename);
      const selectedClass = isSelected ? 'selected' : '';
      const sourceBadge = item.source === 'own_capture' ? '📸' : '💾';
      const imgUrl = item.previewUrl || item.dataUrl || item.url || '';
      const dimensions = (item.width && item.height) ? `${item.width}x${item.height}` : (item.resolution && item.resolution !== 'undefinedxundefined' ? item.resolution : '-');
      const sizeText = item.formattedSize || (item.sizeBytes ? `${(item.sizeBytes / 1024).toFixed(1)} KB` : '-');
      const displayClass = item.className || '-';
      const displayFilename = item.filename || '-';
      const displaySource = item.source || '-';
      const displayTime = item.timestamp || '-';

      html += `
        <div class="gallery-item-card ${selectedClass}" data-filename="${displayFilename}">
          ${this.isSelectMode ? `
            <div class="item-checkbox-wrapper">
              <input type="checkbox" class="gallery-checkbox" ${isSelected ? 'checked' : ''} data-filename="${displayFilename}" />
            </div>
          ` : ''}
          <img src="${imgUrl}" alt="${displayFilename}" class="gallery-thumbnail" loading="lazy" onerror="this.style.opacity='0.4';" />
          <div class="gallery-item-info">
            <span class="gallery-item-class" title="Kelas">${displayClass}</span>
            <span class="gallery-item-name" title="${displayFilename}">${displayFilename}</span>
            <div class="gallery-item-meta">
              <span title="Sumber Data">${sourceBadge} ${displaySource}</span>
              <span title="Dimensi">${dimensions}</span>
            </div>
            <div class="gallery-item-submeta">
              <span title="Ukuran">${sizeText}</span>
              <span title="Waktu">${displayTime}</span>
            </div>
          </div>
          ${!this.isSelectMode ? `
            <button type="button" class="btn-delete-single" data-filename="${displayFilename}" data-class="${displayClass}" title="Hapus gambar ini">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="3 6 5 6 21 6"></polyline>
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
              </svg>
            </button>
          ` : ''}
        </div>
      `;
    });

    container.innerHTML = html;

    // Attach listeners
    if (this.isSelectMode) {
      container.querySelectorAll('.gallery-item-card').forEach(card => {
        card.addEventListener('click', (e) => {
          const fn = card.dataset.filename;
          if (fn) this.toggleItemSelection(fn);
        });
      });
    } else {
      container.querySelectorAll('.btn-delete-single').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const fn = btn.dataset.filename;
          const cls = btn.dataset.class;
          if (fn && cls) this.promptDeleteSingle(fn, cls);
        });
      });
    }
  }

  handleGlobalKeydown(e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') {
      return;
    }

    if (e.code === 'Space' || e.key === 'c' || e.key === 'C') {
      e.preventDefault();
      if (this.currentMode === 'collection') {
        this.handleCapture();
      }
    } else if (e.key === 'm' || e.key === 'M') {
      const nextMode = this.currentMode === 'detection' ? 'collection' : 'detection';
      this.setMode(nextMode);
    }
  }

  async loadCameraDevices() {
    try {
      const devices = await this.cameraService.getAvailableDevices();
      this.populateDeviceSelect(devices);
    } catch (err) {
      console.warn('[VisionX] Tidak dapat mengambil daftar kamera:', err);
    }
  }

  populateDeviceSelect(devices) {
    const select = this.elements.deviceSelect;
    const currentVal = select.value;
    select.innerHTML = '<option value="">Default / Auto Camera</option>';

    devices.forEach((dev, idx) => {
      const opt = document.createElement('option');
      opt.value = dev.deviceId;
      opt.textContent = dev.label || `Camera ${idx + 1}`;
      if (dev.deviceId === currentVal) {
        opt.selected = true;
      }
      select.appendChild(opt);
    });
  }

  async handleStartCamera(deviceId = null) {
    const targetDevice = deviceId || this.elements.deviceSelect.value || null;
    try {
      await this.cameraService.start(targetDevice);
      this.startRenderLoop();
    } catch (err) {
      console.error('[VisionX] Gagal memulai kamera:', err);
    }
  }

  handleStopCamera() {
    this.stopRenderLoop();
    this.cameraService.stop();
    this.renderer.clear();
    this.elements.fpsValue.textContent = '0.0';
    this.fpsSmooth = 0;
    this.elements.detectionCountValue.textContent = '0';
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
    this.elements.errorMessage.innerHTML = String(msg).replace(/\n/g, '<br/>');
    this.elements.errorBanner.classList.remove('hidden');
    this.elements.successBanner.classList.add('hidden');
    setTimeout(() => this.elements.errorBanner.classList.add('hidden'), 6000);
  }

  showSuccess(msg) {
    this.elements.successMessage.innerHTML = String(msg).replace(/\n/g, '<br/>');
    this.elements.successBanner.classList.remove('hidden');
    this.elements.errorBanner.classList.add('hidden');
    setTimeout(() => this.elements.successBanner.classList.add('hidden'), 5000);
  }

  updateInferenceUI(state, textMessage = null) {
    const badge = this.elements.inferenceBadge;
    const text = this.elements.inferenceStatusText;

    badge.className = 'badge';
    if (state === 'ready') {
      badge.classList.add('badge-ready');
      text.textContent = textMessage || 'Model Ready';
    } else if (state === 'loading') {
      badge.classList.add('badge-loading');
      text.textContent = textMessage || 'Loading Model...';
    } else if (state === 'error') {
      badge.classList.add('badge-error');
      text.textContent = textMessage || 'Model Error';
      if (this.renderer && this.currentMode === 'detection') {
        this.renderer.clear();
      }
    } else {
      badge.classList.add('badge-disconnected');
      text.textContent = textMessage || 'Inference Inactive';
      if (this.renderer && this.currentMode === 'detection') {
        this.renderer.clear();
      }
    }
  }

  updateDiagnosticsUI() {
    const d = this.inferenceService.diagnostics;
    const status = this.inferenceService.status;

    if (this.elements.diagModelState) {
      this.elements.diagModelState.textContent = status.toUpperCase();
      this.elements.diagModelState.className = `diag-val ${status}`;
    }
    if (this.elements.diagLoadStarted && d.modelLoadingStarted) {
      this.elements.diagLoadStarted.textContent = d.modelLoadingStarted;
    }
    if (this.elements.diagFetchStarted && d.modelFetchStarted) {
      this.elements.diagFetchStarted.textContent = d.modelFetchStarted;
    }
    if (this.elements.diagFetchCompleted && d.modelFetchCompleted) {
      this.elements.diagFetchCompleted.textContent = d.modelFetchCompleted;
    }
    if (this.elements.diagModelSize && d.modelSizeFormatted) {
      this.elements.diagModelSize.textContent = d.modelSizeFormatted;
    }
    if (this.elements.diagSessionInit && d.sessionInitialized) {
      this.elements.diagSessionInit.textContent = d.sessionInitialized;
    }
    if (this.elements.diagInputShape && d.modelInputShape) {
      this.elements.diagInputShape.textContent = d.modelInputShape;
    }
    if (this.elements.diagOutputShape && d.modelOutputShape) {
      this.elements.diagOutputShape.textContent = d.modelOutputShape;
    }
    if (this.elements.diagFirstInferStart && d.firstInferenceStarted) {
      this.elements.diagFirstInferStart.textContent = d.firstInferenceStarted;
    }
    if (this.elements.diagFirstInferComplete && d.firstInferenceCompleted) {
      this.elements.diagFirstInferComplete.textContent = d.firstInferenceCompleted;
    }
    if (this.elements.diagFirstInferLatency && d.firstInferenceLatencyMs !== null) {
      this.elements.diagFirstInferLatency.textContent = `${d.firstInferenceLatencyMs} ms`;
    }
    if (this.elements.diagRawPreds) {
      this.elements.diagRawPreds.textContent = d.lastRawPredictionsCount;
    }
    if (this.elements.diagAfterConf) {
      this.elements.diagAfterConf.textContent = d.lastAfterConfidenceCount;
    }
    if (this.elements.diagAfterNms) {
      this.elements.diagAfterNms.textContent = d.lastAfterNmsCount;
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

    const currTime = performance.now();
    const delta = (currTime - this.prevTime) / 1000;
    this.prevTime = currTime;

    if (delta > 0) {
      const currentFps = 1.0 / delta;
      this.fpsSmooth = this.fpsSmooth === 0 ? currentFps : (this.alphaFps * this.fpsSmooth + (1 - this.alphaFps) * currentFps);
      this.elements.fpsValue.textContent = this.fpsSmooth.toFixed(1);
    }

    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (vw > 0 && vh > 0) {
      this.renderer.resize(vw, vh);
    }

    if (this.currentMode === 'detection') {
      if (this.inferenceService.isActive && !this.isProcessingFrame) {
        this.isProcessingFrame = true;
        try {
          const result = await this.inferenceService.detect(video);
          if (result) {
            const { detections, frameId, inferenceTimeMs } = result;
            this.renderer.render(detections, {
              frameId,
              inferenceTimeMs,
              modelName: this.inferenceService.modelConfig.shortName
            });

            // Update badge object count
            this.elements.detectionCountValue.textContent = detections.length;

            // Highlight class chips on active detection
            this.highlightDetectedChips(detections);

            // Update diagnostics UI in real time
            this.updateDiagnosticsUI();

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
    } else {
      this.renderer.clear();
    }
  }

  highlightDetectedChips(detections) {
    const activeClasses = new Set(detections.map(d => d.class_name));
    const chips = this.elements.targetChipsContainer.querySelectorAll('.class-chip');
    chips.forEach(chip => {
      const cls = chip.dataset.chipClass;
      if (activeClasses.has(cls)) {
        chip.classList.add('active-detected');
      } else {
        chip.classList.remove('active-detected');
      }
    });
  }

  updateDebugTable(detections = [], frameId = 0, latencyMs = 0) {
    this.elements.debugFrameId.textContent = `#${frameId}`;
    this.elements.debugLatency.textContent = `${latencyMs} ms`;
    if (this.elements.debugObjectCount) {
      this.elements.debugObjectCount.textContent = detections.length;
    }

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
      const color = this.renderer.getColor(det.class_name);

      rowsHtml += `
        <tr>
          <td><strong>${idx + 1}</strong></td>
          <td><span style="color: ${color.border}; font-weight: 700;">${det.class_name}</span></td>
          <td><span style="color: #10b981; font-weight: 600;">${confBadge}</span></td>
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
