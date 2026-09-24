/**
 * main.js - Application Controller untuk VisionX Web Interface (V0.4.1)
 * Mengorkestrasi CameraService, Real YOLOv8 ONNX Inference, DetectionRenderer,
 * DatasetCaptureService (Capture, Single Delete, Multi-Delete, Import Image & Folder, Hashing),
 * FPS Counter, dan Mode Switcher (Detection <-> Collection).
 */

import { CameraService } from './services/CameraService.js';
import { YOLOInferenceService } from './services/InferenceService.js';
import { DetectionRenderer } from './services/DetectionRenderer.js';
import { DatasetCaptureService, validateClassName, SUPPORTED_IMPORT_EXTENSIONS } from './services/DatasetCaptureService.js';

class VisionXWebApp {
  constructor() {
    // Services
    this.cameraService = new CameraService();
    this.inferenceService = new YOLOInferenceService('/models/yolov8n.onnx');
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
    this.selectedItems = new Set(); // Set of filenames
    this.pendingDeleteAction = null; // Callback for confirmation modal
    this.pendingFolderImportFiles = null; // Files for folder import modal

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
      inferenceBadge: document.getElementById('inferenceBadge'),
      inferenceStatusText: document.getElementById('inferenceStatusText'),
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

      // Detection Mode Controls
      detectionControls: document.getElementById('detectionControls'),
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

      // Collection Mode Controls (V0.4.1)
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
    // 1. Attach video ke CameraService
    this.cameraService.attachVideoElement(this.elements.video);

    // 2. Inisialisasi DetectionRenderer
    this.renderer = new DetectionRenderer(this.elements.canvas);

    // 3. Bind Event Listeners
    this.bindEvents();

    // 4. Update initial collection UI & render gallery
    this.updateCollectionUI();
    this.renderRecentCaptures();

    // 5. Muat model ONNX YOLOv8
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

    // 6. Populate camera devices list
    await this.loadCameraDevices();
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

    // Toggle Inferensi AI
    this.elements.toggleInference.addEventListener('change', (e) => {
      this.inferenceService.isActive = e.target.checked;
      this.updateInferenceUI(e.target.checked, e.target.checked ? 'YOLOv8n ONNX Active' : 'Inference Inactive');
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

      this.elements.inferenceBadge.classList.remove('hidden');
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

      this.elements.inferenceBadge.classList.add('hidden');
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
      this.showSuccess(`Gambar tersimpan: ${result.filename}`);
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

  /**
   * Mengimpor satu/beberapa file citra
   */
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

  /**
   * Menampilkan dialog pre-import folder
   */
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

  /**
   * Konfirmasi & eksekusi hapus satu file
   */
  promptDeleteSingle(filename, className) {
    this.elements.modalTitle.textContent = 'Konfirmasi Hapus Gambar';
    this.elements.modalDescription.textContent = `Apakah Anda yakin ingin menghapus gambar "${filename}" dari kelas "${className}"?`;
    this.elements.modalItemPreview.textContent = filename;
    this.elements.modalItemPreview.classList.remove('hidden');

    this.pendingDeleteAction = async () => {
      try {
        await this.captureService.deleteImage(filename, className);
        this.selectedItems.delete(filename);
        this.renderRecentCaptures();
        this.updateCollectionUI();
        this.showSuccess(`Gambar "${filename}" berhasil dihapus.`);
      } catch (err) {
        this.showError('Gagal menghapus gambar: ' + err.message);
      }
    };

    this.elements.confirmModal.classList.remove('hidden');
  }

  /**
   * Konfirmasi & eksekusi Multi-Delete
   */
  handleDeleteSelectedPrompt() {
    const count = this.selectedItems.size;
    if (count === 0) return;

    this.elements.modalTitle.textContent = `Hapus ${count} Gambar Terpilih`;
    this.elements.modalDescription.textContent = `Apakah Anda yakin ingin menghapus ${count} gambar yang dipilih dari dataset? Tindakan ini tidak dapat dibatalkan.`;
    this.elements.modalItemPreview.textContent = `${count} item dipilih untuk dihapus.`;
    this.elements.modalItemPreview.classList.remove('hidden');

    this.pendingDeleteAction = async () => {
      try {
        const itemsToDelete = Array.from(this.selectedItems).map(filename => {
          const item = this.captureService.recentCaptures.find(c => c.filename === filename);
          return { filename, className: item ? item.className : this.captureService.currentClass };
        });

        const deletedCount = await this.captureService.deleteMultipleImages(itemsToDelete);
        this.selectedItems.clear();
        this.updateSelectedCountUI();
        this.renderRecentCaptures();
        this.updateCollectionUI();
        this.showSuccess(`Berhasil menghapus ${deletedCount} gambar dari dataset.`);
      } catch (err) {
        this.showError('Gagal menghapus gambar terpilih: ' + err.message);
      }
    };

    this.elements.confirmModal.classList.remove('hidden');
  }

  closeConfirmModal() {
    this.elements.confirmModal.classList.add('hidden');
    this.pendingDeleteAction = null;
  }

  toggleSelectMode() {
    this.isSelectMode = !this.isSelectMode;
    if (this.isSelectMode) {
      this.elements.btnToggleSelectMode.textContent = 'Mode Normal';
      this.elements.selectionControls.classList.remove('hidden');
    } else {
      this.elements.btnToggleSelectMode.textContent = 'Pilih Banyak';
      this.elements.selectionControls.classList.add('hidden');
      this.selectedItems.clear();
      this.updateSelectedCountUI();
    }
    this.renderRecentCaptures();
  }

  selectAllCaptures() {
    this.captureService.recentCaptures.forEach(c => this.selectedItems.add(c.filename));
    this.updateSelectedCountUI();
    this.renderRecentCaptures();
  }

  clearSelection() {
    this.selectedItems.clear();
    this.updateSelectedCountUI();
    this.renderRecentCaptures();
  }

  updateSelectedCountUI() {
    const count = this.selectedItems.size;
    this.elements.deleteSelectedText.textContent = `Hapus Terpilih (${count})`;
    this.elements.btnDeleteSelected.disabled = (count === 0);
  }

  /**
   * Render kartu preview galeri hasil capture / impor
   */
  renderRecentCaptures() {
    const list = this.elements.recentCapturesList;
    const captures = this.captureService.recentCaptures;

    this.elements.recentCapturesCount.textContent = `${captures.length} item`;

    if (!captures || captures.length === 0) {
      list.innerHTML = `
        <div class="empty-gallery-text">
          Belum ada gambar yang diambil/diimpor pada sesi ini. Tekan tombol Capture, SPACE, atau Impor.
        </div>
      `;
      return;
    }

    let html = '';
    captures.forEach((item) => {
      const isSelected = this.selectedItems.has(item.filename);
      const sizeKb = (item.sizeBytes / 1024).toFixed(1);
      const sourceTag = item.source ? item.source.replace('own_', '') : 'capture';

      html += `
        <div class="capture-card ${isSelected ? 'selected' : ''}" data-filename="${item.filename}" data-class="${item.className}">
          ${this.isSelectMode ? `
            <input type="checkbox" class="card-select-checkbox" data-filename="${item.filename}" ${isSelected ? 'checked' : ''} />
          ` : `
            <button class="card-delete-btn" data-filename="${item.filename}" data-class="${item.className}" title="Hapus gambar ini">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          `}
          <img src="${item.previewUrl}" alt="${item.filename}" class="capture-thumb" />
          <div class="capture-meta">
            <span class="capture-filename" title="${item.filename}">${item.filename}</span>
            <span class="capture-source-tag">${sourceTag} &bull; ${item.className}</span>
            <span class="capture-time">${item.timestamp} &bull; ${sizeKb} KB</span>
          </div>
        </div>
      `;
    });

    list.innerHTML = html;

    // Pasang click listener untuk single delete dan checkbox selection
    list.querySelectorAll('.card-delete-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const fn = btn.dataset.filename;
        const cls = btn.dataset.class;
        this.promptDeleteSingle(fn, cls);
      });
    });

    if (this.isSelectMode) {
      list.querySelectorAll('.card-select-checkbox').forEach(cb => {
        cb.addEventListener('change', (e) => {
          const fn = cb.dataset.filename;
          if (e.target.checked) {
            this.selectedItems.add(fn);
          } else {
            this.selectedItems.delete(fn);
          }
          this.updateSelectedCountUI();
          const card = cb.closest('.capture-card');
          if (card) {
            card.classList.toggle('selected', e.target.checked);
          }
        });
      });
    }
  }

  async handleSelectDirectory() {
    try {
      const dirName = await this.captureService.selectDirectory();
      if (dirName) {
        this.elements.dirStatusText.textContent = `Tersambung ke folder: ${dirName}`;
        this.elements.dirStatusText.classList.add('connected');
        this.showSuccess(`Folder direktori "${dirName}" berhasil dihubungkan.`);
      }
    } catch (err) {
      console.warn('[VisionX] Directory picker dibatalkan:', err);
    }
  }

  handleDirectoryChange(info) {
    if (info && info.dirName) {
      this.elements.dirStatusText.textContent = `Tersambung ke folder: ${info.dirName}`;
      this.elements.dirStatusText.classList.add('connected');
    }
  }

  handleGlobalKeydown(e) {
    const activeEl = document.activeElement;
    const isTyping = activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA');

    if ((e.key === 'm' || e.key === 'M') && !isTyping) {
      e.preventDefault();
      this.setMode(this.currentMode === 'detection' ? 'collection' : 'detection');
      return;
    }

    if ((e.key === 'n' || e.key === 'N') && !isTyping) {
      e.preventDefault();
      if (this.currentMode !== 'collection') {
        this.setMode('collection');
      }
      this.elements.inputClassName.focus();
      this.elements.inputClassName.select();
      return;
    }

    if (this.currentMode === 'collection' && !isTyping) {
      if (e.code === 'Space' || e.key === 'c' || e.key === 'C') {
        e.preventDefault();
        this.handleCapture();
      }
    }
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
    this.hideBanners();
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
    this.elements.successBanner.classList.add('hidden');
    setTimeout(() => this.elements.errorBanner.classList.add('hidden'), 6000);
  }

  showSuccess(msg) {
    this.elements.successMessage.textContent = msg;
    this.elements.successBanner.classList.remove('hidden');
    this.elements.errorBanner.classList.add('hidden');
    setTimeout(() => this.elements.successBanner.classList.add('hidden'), 4500);
  }

  hideBanners() {
    this.elements.errorBanner.classList.add('hidden');
    this.elements.successBanner.classList.add('hidden');
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
      if (this.renderer && this.currentMode === 'detection') {
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
            this.renderer.render(detections, { frameId, inferenceTimeMs });

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
