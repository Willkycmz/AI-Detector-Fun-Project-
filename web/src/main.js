/**
 * main.js - Application Controller untuk VisionX Web Interface (V0.6)
 * Mengorkestrasi:
 * - CameraService (Webcam stream, multi-device, auto-resolution)
 * - YOLOInferenceService (Model selector: VisionX V1 7 Classes <-> Pretrained YOLOv8n 80 Classes)
 * - DetectionRenderer (Realtime bounding boxes, synchronized canvas overlays, neon palette)
 * - DatasetCaptureService (Clean camera raw frames capture & local disk saving)
 * - DatasetManagerService (Module 1: Disk filesystem browser, search, filter, Recycle Bin soft-delete, restore, permanent delete)
 * - IdentityService (Module 2: Identity Lab, face detection, SFace 128-d embeddings, similarity matching, safety protocols)
 * - Mode Switcher (Detection <-> Collection <-> Dataset Manager <-> Identity Lab)
 */

import { CameraService } from './services/CameraService.js';
import { YOLOInferenceService, MODEL_PRESETS, VISIONX_V1_CLASSES } from './services/InferenceService.js';
import { DetectionRenderer } from './services/DetectionRenderer.js';
import { DatasetCaptureService, validateClassName, SUPPORTED_IMPORT_EXTENSIONS } from './services/DatasetCaptureService.js';
import { DatasetManagerService } from './services/DatasetManagerService.js';
import { IdentityService } from './services/IdentityService.js';
import { CoordinateMapper } from './services/CoordinateMapper.js';
import { FrameSource } from './services/FrameSource.js';
import { FaceDetector } from './services/FaceDetector.js';
import { FaceRecognizer } from './services/FaceRecognizer.js';
import { DetectionFusion } from './services/DetectionFusion.js';
import { UnifiedRenderer } from './services/UnifiedRenderer.js';
import { TrackingEngine } from './services/TrackingEngine.js';
import { VoiceEngine, SpeechPriority, VoiceMode, VoiceState, DEFAULT_VOICE_CONFIG } from './services/VoiceEngine.js';
import { EventEngine } from './services/EventEngine.js';
import { MessageFormatter } from './services/MessageFormatter.js';
import { OCRService, OCRStatus, OCR_PROFILES, ROI_MODES, ImageQualityAssessor } from './services/OCRService.js';
import { VisionContextBuilder } from './services/VisionContextBuilder.js';
import { BackendAIProvider } from './services/AIProvider.js';
import { VisionAssistant, AssistantState } from './services/VisionAssistant.js';
import { ObjectMemory } from './services/ObjectMemory.js';
import { PersonalObjectRegistry } from './services/PersonalObjectRegistry.js';
import { PersonalObjectRecognizer } from './services/PersonalObjectRecognizer.js';
import { ObjectEnrollment } from './services/ObjectEnrollment.js';
import { SafetyEngine } from './services/SafetyEngine.js';
import { AlertManager, AlertState } from './services/AlertManager.js';
import { NavigationManager } from './ui/NavigationManager.js';
import { BottomSheetManager } from './ui/BottomSheetManager.js';
import { ThemeManager } from './ui/ThemeManager.js';
import { ContextualPanelManager } from './ui/ContextualPanelManager.js';
import { SceneHistoryEngine } from './services/SceneHistoryEngine.js';
import { tunnelService } from './services/TunnelService.js';
import { CameraModal } from './ui/CameraModal.js';
import { ChatController } from './ui/ChatController.js';
import { APP_VERSION } from './version.js';
import { ENDPOINTS } from './services/apiConfig.js';
import { authService } from './services/AuthService.js';
import { setApiEventHandlers } from './services/ApiClient.js';

class VisionXWebApp {
  constructor() {
    // 1. Kumpulkan seluruh referensi elemen DOM
    this.collectElements();

    // 2. Inisialisasi state aplikasi & rendering
    this.currentMode = 'home'; // 'home' | 'detection' | 'collection' | 'manager' | 'identity' | 'read_text'
    this.isStartingCamera = false;
    this.hasLoadedCameraDevices = false;
    this._cameraSessionId = 0;
    this.animationFrameId = null;
    this.prevTime = performance.now();
    this.fpsSmooth = 0;
    this.alphaFps = 0.9;
    this.isProcessingFrame = false;
    this.isDebugVisible = false;

    // Face Recognition Layer State (V0.6.2 Unified Vision)
    this.isProcessingFace = false;
    this.lastFaceCheckTime = 0;
    this.currentFaceDetections = [];
    this.currentIdentityFaces = [];
    this.currentFrameId = 0;
    this.faceOffscreenCanvas = document.createElement('canvas');
    this.faceOffscreenCtx = this.faceOffscreenCanvas.getContext('2d');

    // Multimodal Vision Context Caches (V1.0)
    this.lastDetections = [];
    this.lastIdentityState = null;

    // Multi-Select State (Collection Mode)
    this.isSelectMode = false;
    this.selectedItems = new Set();
    this.pendingDeleteAction = null;
    this.pendingFolderImportFiles = null;

    // 3. Inisialisasi Core Vision Services
    this.cameraService = new CameraService();
    this.frameSource = new FrameSource(this.cameraService);
    this.inferenceService = new YOLOInferenceService('visionx_v2');
    this.captureService = new DatasetCaptureService();
    this.managerService = new DatasetManagerService();
    this.identityService = new IdentityService();
    this.faceDetector = new FaceDetector(this.identityService, this.frameSource);
    this.faceRecognizer = new FaceRecognizer(this.identityService, this.frameSource);
    this.trackingEngine = new TrackingEngine();
    this.renderer = null;
    this.tunnelService = tunnelService;

    // 4. Inisialisasi Voice Assistant Engine (V0.8) - Terisolasi agar kegagalan tidak memblokir UI
    this.voiceEngine = null;
    this.eventEngine = null;
    try {
      let savedVoiceConfig = {};
      try {
        const storedVoice = localStorage.getItem('visionx_voice_config');
        if (storedVoice) savedVoiceConfig = JSON.parse(storedVoice);
      } catch (e) {
        console.warn('[VisionX] Failed reading voice config from localStorage', e);
      }
      this.voiceEngine = new VoiceEngine(savedVoiceConfig);
      this.eventEngine = new EventEngine(this.voiceEngine, {
        cooldownMs: this.voiceEngine.config.cooldownMs,
        batchWindowMs: this.voiceEngine.config.batchWindowMs
      });
      this.voiceEngine.onStateChange((state) => this.handleVoiceStateChange(state));
    } catch (voiceInitErr) {
      console.warn('[VisionX] Peringatan inisialisasi VoiceEngine (terisolasi):', voiceInitErr);
    }

    // OCR & Read Text Engine (V0.9) - Terisolasi agar kegagalan tidak memblokir UI
    this.ocrService = null;
    this.currentOcrResult = null;
    this.currentOcrRegions = [];
    this.isAutoReadOcr = false;
    this.autoReadCooldownMs = 3000;
    this.lastAutoReadScanTime = 0;
    this.lastSpokenOcrHash = '';
    try {
      this.ocrService = new OCRService({ defaultLanguage: 'ind', cooldownMs: 2000 });
      this.ocrService.on('statusChange', (status, info) => this.handleOcrStatusChange(status));
    } catch (ocrInitErr) {
      console.warn('[VisionX] Peringatan inisialisasi OCRService (terisolasi):', ocrInitErr);
    }

    // 4b. Inisialisasi Object Memory Engine (V1.1) - Terisolasi agar kegagalan tidak memblokir UI
    this.objectMemory = null;
    try {
      this.objectMemory = new ObjectMemory();
      this.objectMemory.onMemoryUpdate(() => this.updateObjectMemoryUI());
    } catch (memErr) {
      console.warn('[VisionX] Peringatan inisialisasi ObjectMemory (terisolasi):', memErr);
    }

    // 4c. Inisialisasi Personal Object Services (V1.2) - Local-First & Zero Retraining
    this.personalObjectRegistry = null;
    this.personalObjectRecognizer = null;
    this.objectEnrollment = null;
    this.tempEnrollmentReferences = [];
    try {
      this.personalObjectRegistry = new PersonalObjectRegistry();
      this.personalObjectRecognizer = new PersonalObjectRecognizer(this.personalObjectRegistry);
      this.objectEnrollment = new ObjectEnrollment(this.personalObjectRegistry);
      this.personalObjectRegistry.onRegistryUpdate(() => this.updatePersonalObjectsUI());
    } catch (poInitErr) {
      console.warn('[VisionX] Peringatan inisialisasi PersonalObject services (terisolasi):', poInitErr);
    }

    // 4d. Inisialisasi AI Vision Assistant & Auth Handler (Phase 2)
    this.visionAssistant = null;
    this.pendingAuthResolve = null;
    this.pendingAuthReject = null;
    this.authTabMode = 'login'; // 'login' | 'register' | 'forgot_password'

    // Centralized API Event Handlers (F4: 401 & 403 interceptors)
    setApiEventHandlers({
      onAuthRequired: () => {
        this.promptAuthModal();
      },
      onForbidden: (msg) => {
        this.showError(msg || 'Akses ditolak: Fitur ini khusus Developer.');
        this.showDeveloperNotice();
      }
    });

    // Supabase Auth State Change Listener (F1, F3, F5, F6)
    authService.onAuthStateChange((event, session, role) => {
      this.updateAuthStatusUI();
      if (this.navigationManager) {
        this.navigationManager.updateRoleVisibility(role);
      }
      if (this.chatController) {
        this.chatController.setUserId(authService.getUserId());
        this.chatController.updateAuthStatus();
      }
      if (['collection', 'manager', 'identity'].includes(this.currentMode) && role !== 'developer') {
        this.setMode('home');
      }
    });

    try {
      const backendAIProvider = new BackendAIProvider({
        onAuthRequired: () => this.promptAuthModal()
      });
      this.visionAssistant = new VisionAssistant({
        aiProvider: backendAIProvider,
        voiceEngine: this.voiceEngine,
        objectMemory: this.objectMemory,
        personalObjectRegistry: this.personalObjectRegistry,
        snapshotFn: () => this.captureCameraSnapshot(),
        contextFn: () => this.buildCurrentVisionContext(),
        autoSpeak: false
      });
      this.visionAssistant.onStateChange((statePayload) => this.handleAssistantStateChange(statePayload));
      this.visionAssistant.on('streamChunk', ({ chunk, fullText }) => {
        if (this.elements.askVisionResponseArea) {
          this.elements.askVisionResponseArea.classList.remove('hidden');
        }
        if (this.elements.askVisionResponseText) {
          this.elements.askVisionResponseText.textContent = fullText;
        }
      });
    } catch (assistantInitErr) {
      console.warn('[VisionX] Peringatan inisialisasi VisionAssistant (terisolasi):', assistantInitErr);
    }

    // 4e. Inisialisasi Safety Engine (V1.3 Event-Driven Environmental Safety)
    this.safetyEngine = null;
    try {
      this.safetyEngine = new SafetyEngine();
    } catch (safetyErr) {
      console.warn('[VisionX] Peringatan inisialisasi SafetyEngine (terisolasi):', safetyErr);
    }

    // 4f. Inisialisasi Alert Manager (V1.3.1 Realtime Safety Alert Manager)
    this.alertManager = null;
    try {
      let savedSafetyConfig = {};
      try {
        const stored = localStorage.getItem('visionx_safety_alert_config');
        if (stored) savedSafetyConfig = JSON.parse(stored);
      } catch (e) {
        console.warn('[VisionX] Failed reading safety alert config from localStorage', e);
      }
      this.alertManager = new AlertManager(this.voiceEngine, savedSafetyConfig);
      this.alertManager.onAlertUpdate(() => this.updateSafetyAlertsUI());
      if (this.safetyEngine) {
        this.safetyEngine.onSafetyEvent((evt) => {
          if (this.alertManager) {
            this.alertManager.processEvent(evt);
          }
        });
      }
    } catch (alertErr) {
      console.warn('[VisionX] Peringatan inisialisasi AlertManager (terisolasi):', alertErr);
    }

    // 4g. Inisialisasi Scene History Engine (V1.6 Phase C - 1 Hz background sampler)
    this.sceneHistoryEngine = null;
    this.historySamplerInterval = null;
    try {
      this.sceneHistoryEngine = new SceneHistoryEngine();
      if (this.visionAssistant) {
        this.visionAssistant.sceneHistoryEngine = this.sceneHistoryEngine;
      }
      this.startSceneHistorySampler();
    } catch (sheInitErr) {
      console.warn('[VisionX] Peringatan inisialisasi SceneHistoryEngine (terisolasi):', sheInitErr);
    }

    // 5. Hubungkan Video & Overlay Canvas
    try {
      if (this.elements.video) {
        this.cameraService.attachVideoElement(this.elements.video);
        this.frameSource.attachVideoElement(this.elements.video);
      }
      if (this.elements.canvas) {
        this.renderer = new UnifiedRenderer(this.elements.canvas);
      }
    } catch (attachErr) {
      console.warn('[VisionX] Gagal attach video/canvas overlay:', attachErr);
    }

    // 6. Pasang SELURUH event listener tombol UI SEGERA (interaktivitas terjamin sebelum async ops)
    this.bindEvents();

    // 7. Mulai inisialisasi asinkron (load model, populate devices, render UI)
    this.init();
  }

  collectElements() {
    // DOM Elements
    this.elements = {
      // Home & Main Layout Containers (V1.7)
      homeView: document.getElementById('homeView'),
      stageCard: document.getElementById('stageCard'),
      controlsCard: document.getElementById('controlsCard'),
      brandLogo: document.getElementById('brandLogo'),
      btnNavHome: document.getElementById('btnNavHome'),
      heroCameraButtons: document.querySelector('.hero-camera-buttons'),
      primaryHeroBar: document.querySelector('.primary-hero-bar'),
      currentResultSummaryBar: document.querySelector('.current-result-summary-bar'),
      secondaryControlsBar: document.querySelector('.secondary-controls-bar'),

      // Stage & Video
      video: document.getElementById('videoElement'),
      canvas: document.getElementById('canvasOverlay'),
      placeholder: document.getElementById('cameraPlaceholder'),
      shutterFlash: document.getElementById('shutterFlash'),
      stageWatermark: document.getElementById('stageWatermark'),
      watermarkMode: document.getElementById('watermarkMode'),
      watermarkExtra: document.getElementById('watermarkExtra'),

      // Header & Badges
      headerModeSwitcher: document.getElementById('headerModeSwitcher'),
      headerBadges: document.querySelector('.header-badges'),
      btnModeDetect: document.getElementById('btnModeDetect'),
      btnModeCollect: document.getElementById('btnModeCollect'),
      btnModeManager: document.getElementById('btnModeManager'),
      btnModeIdentity: document.getElementById('btnModeIdentity'),
      modeBadge: document.getElementById('modeBadge'),
      modeStatusText: document.getElementById('modeStatusText'),
      cameraBadge: document.getElementById('cameraBadge'),
      cameraStatusText: document.getElementById('cameraStatusText'),
      activeModelBadge: document.getElementById('activeModelBadge'),
      activeModelBadgeText: document.getElementById('activeModelBadgeText'),
      voiceBadge: document.getElementById('voiceBadge'),
      voiceBadgeText: document.getElementById('voiceBadgeText'),
      inferenceBadge: document.getElementById('inferenceBadge'),
      inferenceStatusText: document.getElementById('inferenceStatusText'),
      detectionCountBadge: document.getElementById('detectionCountBadge'),
      detectionCountValue: document.getElementById('detectionCountValue'),
      trackedCountBadge: document.getElementById('trackedCountBadge'),
      trackedCountValue: document.getElementById('trackedCountValue'),
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
      btnQuickAskVision: document.getElementById('btnQuickAskVision'),
      summaryDetectionCount: document.getElementById('summaryDetectionCount'),
      summaryTrackedCount: document.getElementById('summaryTrackedCount'),
      summaryFpsDisplay: document.getElementById('summaryFpsDisplay'),
      btnToggleMirror: document.getElementById('btnToggleMirror'),
      mirrorBtnText: document.getElementById('mirrorBtnText'),
      deviceSelect: document.getElementById('deviceSelect'),

      // Detection Mode Controls
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
      toggleFaceRecognition: document.getElementById('toggleFaceRecognition'),
      toggleTracking: document.getElementById('toggleTracking'),
      toggleDebug: document.getElementById('toggleDebug'),

      // Voice Assistant Panel (V0.8)
      voicePanel: document.getElementById('voicePanel'),
      toggleVoice: document.getElementById('toggleVoice'),
      toggleVoiceStateLabel: document.getElementById('toggleVoiceStateLabel'),
      voiceModeSelect: document.getElementById('voiceModeSelect'),
      voiceVolumeSlider: document.getElementById('voiceVolumeSlider'),
      voiceVolumeVal: document.getElementById('voiceVolumeVal'),
      voiceSpeedSlider: document.getElementById('voiceSpeedSlider'),
      voiceSpeedVal: document.getElementById('voiceSpeedVal'),
      btnVoiceReplay: document.getElementById('btnVoiceReplay'),
      btnVoiceStop: document.getElementById('btnVoiceStop'),
      btnVoiceClearQueue: document.getElementById('btnVoiceClearQueue'),
      voiceStatusBadge: document.getElementById('voiceStatusBadge'),
      voiceStatusText: document.getElementById('voiceStatusText'),
      voiceLastMsgText: document.getElementById('voiceLastMsgText'),

      // Debug Panel & Live Diagnostics
      debugPanel: document.getElementById('debugPanel'),
      debugModelName: document.getElementById('debugModelName'),
      debugLoadTime: document.getElementById('debugLoadTime'),
      debugLatency: document.getElementById('debugLatency'),
      debugObjectCount: document.getElementById('debugObjectCount'),
      debugFrameId: document.getElementById('debugFrameId'),
      debugTableBody: document.getElementById('debugTableBody'),
      diagModelState: document.getElementById('diagModelState'),
      diagTrackingStatus: document.getElementById('diagTrackingStatus'),
      diagVisibleTracks: document.getElementById('diagVisibleTracks'),
      diagTotalActiveTracks: document.getElementById('diagTotalActiveTracks'),
      diagNewTracks: document.getElementById('diagNewTracks'),
      diagLostTracks: document.getElementById('diagLostTracks'),
      diagTrackSummary: document.getElementById('diagTrackSummary'),
      diagVoiceEnabled: document.getElementById('diagVoiceEnabled'),
      diagVoiceState: document.getElementById('diagVoiceState'),
      diagVoiceQueue: document.getElementById('diagVoiceQueue'),
      diagVoiceAnnouncements: document.getElementById('diagVoiceAnnouncements'),
      diagVoiceLastMessage: document.getElementById('diagVoiceLastMessage'),
      diagFaceDetectStatus: document.getElementById('diagFaceDetectStatus'),
      diagFaceRecogStatus: document.getElementById('diagFaceRecogStatus'),
      diagFaceDetectionsCount: document.getElementById('diagFaceDetectionsCount'),
      diagIdentityMatchesCount: document.getElementById('diagIdentityMatchesCount'),
      diagCoordTransform: document.getElementById('diagCoordTransform'),
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
      diagFinalDetections: document.getElementById('diagFinalDetections'),
      diagTensorMinMax: document.getElementById('diagTensorMinMax'),
      btnRunGoldenTest: document.getElementById('btnRunGoldenTest'),

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

      // Import Toolbar (Collection Mode)
      inputImportImages: document.getElementById('inputImportImages'),
      btnTriggerImportImages: document.getElementById('btnTriggerImportImages'),
      inputImportFolder: document.getElementById('inputImportFolder'),
      btnTriggerImportFolder: document.getElementById('btnTriggerImportFolder'),

      // Gallery & Multi-Delete (Collection Mode)
      recentCapturesList: document.getElementById('recentCapturesList'),
      recentCapturesCount: document.getElementById('recentCapturesCount'),
      btnToggleSelectMode: document.getElementById('btnToggleSelectMode'),
      selectionControls: document.getElementById('selectionControls'),
      btnSelectAll: document.getElementById('btnSelectAll'),
      btnClearSelection: document.getElementById('btnClearSelection'),
      btnDeleteSelected: document.getElementById('btnDeleteSelected'),
      deleteSelectedText: document.getElementById('deleteSelectedText'),

      // Module 1 — Dataset Manager Elements (V0.6)
      managerControls: document.getElementById('managerControls'),
      mgrStatTotalImages: document.getElementById('mgrStatTotalImages'),
      mgrStatTotalSize: document.getElementById('mgrStatTotalSize'),
      mgrStatTotalClasses: document.getElementById('mgrStatTotalClasses'),
      mgrStatTrashCount: document.getElementById('mgrStatTrashCount'),
      mgrTrashBadgeCount: document.getElementById('mgrTrashBadgeCount'),
      btnMgrViewActive: document.getElementById('btnMgrViewActive'),
      btnMgrViewTrash: document.getElementById('btnMgrViewTrash'),
      mgrSelectClass: document.getElementById('mgrSelectClass'),
      mgrSelectSource: document.getElementById('mgrSelectSource'),
      mgrSearchInput: document.getElementById('mgrSearchInput'),
      inputMgrImportFiles: document.getElementById('inputMgrImportFiles'),
      inputMgrImportFolder: document.getElementById('inputMgrImportFolder'),
      btnMgrImportFiles: document.getElementById('btnMgrImportFiles'),
      btnMgrImportFolder: document.getElementById('btnMgrImportFolder'),
      btnMgrSelectAll: document.getElementById('btnMgrSelectAll'),
      btnMgrClearSelect: document.getElementById('btnMgrClearSelect'),
      btnMgrTrashSelected: document.getElementById('btnMgrTrashSelected'),
      mgrSelectedCountTrash: document.getElementById('mgrSelectedCountTrash'),
      btnMgrRestoreSelected: document.getElementById('btnMgrRestoreSelected'),
      mgrSelectedCountRestore: document.getElementById('mgrSelectedCountRestore'),
      btnMgrPermanentDeleteSelected: document.getElementById('btnMgrPermanentDeleteSelected'),
      mgrSelectedCountPerm: document.getElementById('mgrSelectedCountPerm'),
      btnMgrRefresh: document.getElementById('btnMgrRefresh'),
      mgrGridContainer: document.getElementById('mgrGridContainer'),

      // Dataset Manager Preview Modal
      mgrPreviewModal: document.getElementById('mgrPreviewModal'),
      mgrPreviewImg: document.getElementById('mgrPreviewImg'),
      mgrPreviewCloseBtn: document.getElementById('mgrPreviewCloseBtn'),
      mgrPreviewCloseFooterBtn: document.getElementById('mgrPreviewCloseFooterBtn'),
      mgrMetaFilename: document.getElementById('mgrMetaFilename'),
      mgrMetaClass: document.getElementById('mgrMetaClass'),
      mgrMetaSource: document.getElementById('mgrMetaSource'),
      mgrMetaDimensions: document.getElementById('mgrMetaDimensions'),
      mgrMetaSize: document.getElementById('mgrMetaSize'),
      mgrMetaDate: document.getElementById('mgrMetaDate'),
      mgrMetaStatus: document.getElementById('mgrMetaStatus'),
      mgrMetaPath: document.getElementById('mgrMetaPath'),

      // Module 2 — Identity Lab Elements (V0.6)
      identityControls: document.getElementById('identityControls'),
      idLabProfileName: document.getElementById('idLabProfileName'),
      idLabRefCount: document.getElementById('idLabRefCount'),
      idLabThresholdSlider: document.getElementById('idLabThresholdSlider'),
      idLabThresholdVal: document.getElementById('idLabThresholdVal'),
      inputIdLabImport: document.getElementById('inputIdLabImport'),
      btnIdLabImport: document.getElementById('btnIdLabImport'),
      btnIdLabCaptureCam: document.getElementById('btnIdLabCaptureCam'),
      idLabGalleryCount: document.getElementById('idLabGalleryCount'),
      idLabRefGallery: document.getElementById('idLabRefGallery'),
      idLabDecisionBadge: document.getElementById('idLabDecisionBadge'),
      idLabSimilarityScore: document.getElementById('idLabSimilarityScore'),
      idLabSimilarityBar: document.getElementById('idLabSimilarityBar'),
      idLabThresholdMarker: document.getElementById('idLabThresholdMarker'),
      idLabMatchDetail: document.getElementById('idLabMatchDetail'),

      // Shared Modals
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
      folderModalConfirmBtn: document.getElementById('folderModalConfirmBtn'),

      // Read Text Mode Elements (V0.9 / V1.2.1 Hardening)
      btnModeReadText: document.getElementById('btnModeReadText'),
      ocrBadge: document.getElementById('ocrBadge'),
      ocrBadgeText: document.getElementById('ocrBadgeText'),
      readTextControls: document.getElementById('readTextControls'),
      btnTriggerOcr: document.getElementById('btnTriggerOcr'),
      btnReScanOcr: document.getElementById('btnReScanOcr'),
      btnStopOcr: document.getElementById('btnStopOcr'),
      btnSpeakOcr: document.getElementById('btnSpeakOcr'),
      ocrLangSelect: document.getElementById('ocrLangSelect'),
      ocrProfileSelect: document.getElementById('ocrProfileSelect'),
      ocrRoiSelect: document.getElementById('ocrRoiSelect'),
      toggleAutoReadOcr: document.getElementById('toggleAutoReadOcr'),
      autoReadStateLabel: document.getElementById('autoReadStateLabel'),
      ocrStatusBadge: document.getElementById('ocrStatusBadge'),
      ocrStatusText: document.getElementById('ocrStatusText'),
      ocrTelemetryStatus: document.getElementById('ocrTelemetryStatus'),
      ocrTelemetryLatency: document.getElementById('ocrTelemetryLatency'),
      ocrTelemetryRegions: document.getElementById('ocrTelemetryRegions'),
      ocrTelemetryConfidence: document.getElementById('ocrTelemetryConfidence'),
      ocrTelemetryQuality: document.getElementById('ocrTelemetryQuality'),
      ocrTelemetryResolution: document.getElementById('ocrTelemetryResolution'),
      ocrTelemetryTime: document.getElementById('ocrTelemetryTime'),
      ocrCharWordCount: document.getElementById('ocrCharWordCount'),
      btnCopyOcrText: document.getElementById('btnCopyOcrText'),
      btnClearOcrText: document.getElementById('btnClearOcrText'),
      ocrResultBox: document.getElementById('ocrResultBox'),
      ocrResultPlaceholder: document.getElementById('ocrResultPlaceholder'),
      ocrResultContent: document.getElementById('ocrResultContent'),
      ocrTelemetryMethod: document.getElementById('ocrTelemetryMethod'),
      ocrWarningBanner: document.getElementById('ocrWarningBanner'),
      ocrWarningText: document.getElementById('ocrWarningText'),

      // Camera Diagnostics Strip (V1.2.1)
      camDiagResolution: document.getElementById('camDiagResolution'),
      camDiagFps: document.getElementById('camDiagFps'),
      camDiagBrightness: document.getElementById('camDiagBrightness'),
      camDiagSharpness: document.getElementById('camDiagSharpness'),
      camDiagOcrInput: document.getElementById('camDiagOcrInput'),

      // OCR Diagnostics (V0.9)
      diagOcrStatus: document.getElementById('diagOcrStatus'),
      diagOcrLatency: document.getElementById('diagOcrLatency'),
      diagOcrRegions: document.getElementById('diagOcrRegions'),
      diagOcrTime: document.getElementById('diagOcrTime'),

      // AI Vision Assistant (V1.0 - ASK VISIONX)
      askVisionPanel: document.getElementById('askVisionPanel'),
      aiAssistantStatusBadge: document.getElementById('aiAssistantStatusBadge'),
      aiAssistantStatusText: document.getElementById('aiAssistantStatusText'),
      askVisionForm: document.getElementById('askVisionForm'),
      askVisionInput: document.getElementById('askVisionInput'),
      btnAskVisionSubmit: document.getElementById('btnAskVisionSubmit'),
      askVisionLoading: document.getElementById('askVisionLoading'),
      askVisionError: document.getElementById('askVisionError'),
      askVisionErrorMessage: document.getElementById('askVisionErrorMessage'),
      askVisionResponseArea: document.getElementById('askVisionResponseArea'),
      askVisionResponseText: document.getElementById('askVisionResponseText'),
      btnReadAloudResponse: document.getElementById('btnReadAloudResponse'),
      btnStopSpeechResponse: document.getElementById('btnStopSpeechResponse'),
      btnClearResponse: document.getElementById('btnClearResponse'),
      btnResetConversation: document.getElementById('btnResetConversation'),
      visionConversationThread: document.getElementById('visionConversationThread'),
      askVisionMeta: document.getElementById('askVisionMeta'),
      quickPromptChips: document.querySelectorAll('.quick-prompt-chip'),

      // Milestone 1 & Phase 2 Auth Elements (Supabase + Legacy)
      gatewayAuthBar: document.getElementById('gatewayAuthBar'),
      authStatusDot: document.getElementById('authStatusDot'),
      authStatusLabel: document.getElementById('authStatusLabel'),
      btnAuthToggle: document.getElementById('btnAuthToggle'),
      visionxAuthModal: document.getElementById('visionxAuthModal'),
      authModalTitle: document.getElementById('authModalTitle'),
      authModalTabs: document.getElementById('authModalTabs'),
      tabAuthLogin: document.getElementById('tabAuthLogin'),
      tabAuthRegister: document.getElementById('tabAuthRegister'),
      authModalDescription: document.getElementById('authModalDescription'),
      authModalEmailGroup: document.getElementById('authModalEmailGroup'),
      authModalEmailInput: document.getElementById('authModalEmailInput'),
      authModalPasswordGroup: document.getElementById('authModalPasswordGroup'),
      authModalPasswordInput: document.getElementById('authModalPasswordInput'),
      authModalLinksRow: document.getElementById('authModalLinksRow'),
      btnAuthForgotPassword: document.getElementById('btnAuthForgotPassword'),
      btnAuthBackToLogin: document.getElementById('btnAuthBackToLogin'),
      authModalNotice: document.getElementById('authModalNotice'),
      authModalNoticeMessage: document.getElementById('authModalNoticeMessage'),
      authModalError: document.getElementById('authModalError'),
      authModalErrorMessage: document.getElementById('authModalErrorMessage'),
      btnCloseAuthModal: document.getElementById('btnCloseAuthModal'),
      btnCancelAuthModal: document.getElementById('btnCancelAuthModal'),
      btnSubmitAuthModal: document.getElementById('btnSubmitAuthModal'),
      authSubmitBtnText: document.getElementById('authSubmitBtnText'),

      // Header User Avatar & Dropdown (Phase 2 F3)
      userAvatarContainer: document.getElementById('userAvatarContainer'),
      headerUserAvatar: document.getElementById('headerUserAvatar'),
      headerAvatarLetter: document.getElementById('headerAvatarLetter'),
      headerAvatarLabel: document.getElementById('headerAvatarLabel'),
      userAvatarDropdown: document.getElementById('userAvatarDropdown'),
      dropdownUserEmail: document.getElementById('dropdownUserEmail'),
      dropdownUserRoleBadge: document.getElementById('dropdownUserRoleBadge'),
      btnOpenSettingsModal: document.getElementById('btnOpenSettingsModal'),
      btnHeaderSignOut: document.getElementById('btnHeaderSignOut'),

      // App Settings Modal (I4)
      appSettingsModal: document.getElementById('appSettingsModal'),
      btnCloseSettingsModal: document.getElementById('btnCloseSettingsModal'),
      settingsTabBtns: document.querySelectorAll('.settings-tab-btn'),
      settingsTabPanels: document.querySelectorAll('.settings-tab-panel'),
      settingsAvatarLetter: document.getElementById('settingsAvatarLetter'),
      settingsUserEmail: document.getElementById('settingsUserEmail'),
      settingsUserRole: document.getElementById('settingsUserRole'),
      btnSettingsAuthAction: document.getElementById('btnSettingsAuthAction'),
      btnSettingsClearAllHistory: document.getElementById('btnSettingsClearAllHistory'),
      tabBtnDeveloper: document.getElementById('tabBtnDeveloper'),
      btnSettingsOpenDatasetMgr: document.getElementById('btnSettingsOpenDatasetMgr'),
      btnSettingsOpenIdentityLab: document.getElementById('btnSettingsOpenIdentityLab'),

      // Privacy Popover (I1)
      btnPrivacyPopoverToggle: document.getElementById('btnPrivacyPopoverToggle'),
      privacyPopover: document.getElementById('privacyPopover'),
      btnClosePrivacyPopover: document.getElementById('btnClosePrivacyPopover'),
      btnPrivacyGoToSettings: document.getElementById('btnPrivacyGoToSettings'),

      // Developer Route Guard Modal (Phase 2 F5)
      developerNoticeModal: document.getElementById('developerNoticeModal'),
      devNoticeTitle: document.getElementById('devNoticeTitle'),
      btnCloseDevNotice: document.getElementById('btnCloseDevNotice'),
      devNoticeMessage: document.getElementById('devNoticeMessage'),
      btnDevNoticeHome: document.getElementById('btnDevNoticeHome'),
      btnDevNoticeLogin: document.getElementById('btnDevNoticeLogin'),

      // Object Memory Panel (V1.1)
      objectMemoryPanel: document.getElementById('objectMemoryPanel'),
      memoryRecordsCount: document.getElementById('memoryRecordsCount'),
      btnClearObjectMemory: document.getElementById('btnClearObjectMemory'),
      memoryActiveBadge: document.getElementById('memoryActiveBadge'),
      memoryCurrentObjectsList: document.getElementById('memoryCurrentObjectsList'),
      memoryEventsCount: document.getElementById('memoryEventsCount'),
      memoryRecentEventsList: document.getElementById('memoryRecentEventsList'),
      memoryTotalObjectsVal: document.getElementById('memoryTotalObjectsVal'),
      memoryLastEventTimeVal: document.getElementById('memoryLastEventTimeVal'),

      // Personal Objects Panel (V1.2)
      personalObjectsPanel: document.getElementById('personalObjectsPanel'),
      personalObjectsCount: document.getElementById('personalObjectsCount'),
      btnToggleEnrollForm: document.getElementById('btnToggleEnrollForm'),
      enrollmentFormSection: document.getElementById('enrollmentFormSection'),
      enrollObjectNameInput: document.getElementById('enrollObjectNameInput'),
      enrollBaseClassSelect: document.getElementById('enrollBaseClassSelect'),
      btnCaptureRefCam: document.getElementById('btnCaptureRefCam'),
      inputRefFile: document.getElementById('inputRefFile'),
      refAngleSelect: document.getElementById('refAngleSelect'),
      enrollRefPreviewGallery: document.getElementById('enrollRefPreviewGallery'),
      btnSaveEnrolledObject: document.getElementById('btnSaveEnrolledObject'),
      btnCancelEnroll: document.getElementById('btnCancelEnroll'),
      personalMatchThresholdSlider: document.getElementById('personalMatchThresholdSlider'),
      personalThresholdVal: document.getElementById('personalThresholdVal'),
      personalObjectsList: document.getElementById('personalObjectsList'),

      // Safety Alerts Panel (V1.3.1)
      safetyAlertsPanel: document.getElementById('safetyAlertsPanel'),
      safetyAlertsCount: document.getElementById('safetyAlertsCount'),
      btnClearSafetyAlerts: document.getElementById('btnClearSafetyAlerts'),
      toggleSafetyAlerts: document.getElementById('toggleSafetyAlerts'),
      toggleVoiceSafetyAlerts: document.getElementById('toggleVoiceSafetyAlerts'),
      togglePersistentAlerts: document.getElementById('togglePersistentAlerts'),
      sliderAlertCooldown: document.getElementById('sliderAlertCooldown'),
      alertCooldownVal: document.getElementById('alertCooldownVal'),
      safetyAlertsList: document.getElementById('safetyAlertsList'),

      headerBreadcrumbTitle: document.getElementById('headerBreadcrumbTitle'),
      headerServerStatusPill: document.getElementById('headerServerStatusPill'),
      headerServerStatusText: document.getElementById('headerServerStatusText'),
      headerStatusPopover: document.getElementById('headerStatusPopover'),
      btnCloseStatusPopover: document.getElementById('btnCloseStatusPopover'),
      mobileStatusDot: document.getElementById('mobileStatusDot'),
      mobileHeaderModeTitle: document.getElementById('mobileHeaderModeTitle'),
      appSidebar: document.getElementById('appSidebar'),
      mobileDrawerBackdrop: document.getElementById('mobileDrawerBackdrop') || document.getElementById('sidebarBackdrop'),
      btnToggleSidebar: document.getElementById('btnToggleSidebar') || document.getElementById('btnMobileMenu'),
      btnMobileMenuToggle: document.getElementById('btnMobileMenuToggle') || document.getElementById('btnMobileMenu'),
      btnCloseSidebar: document.getElementById('btnCloseSidebar'),
      btnSidebarNewChat: document.getElementById('btnSidebarNewChat') || document.getElementById('btnNewChat'),
      btnMobileNewChat: document.getElementById('btnMobileNewChat'),
      btnSidebarHome: document.getElementById('btnSidebarHome') || document.getElementById('btnSidebarChat'),
      btnSidebarDetect: document.getElementById('btnSidebarDetect'),
      btnSidebarReadText: document.getElementById('btnSidebarReadText'),
      btnSidebarCollection: document.getElementById('btnSidebarCollection') || document.getElementById('btnSidebarCollect'),
      btnSidebarManager: document.getElementById('btnSidebarManager'),
      btnSidebarIdentity: document.getElementById('btnSidebarIdentity'),
      btnSidebarSafety: document.getElementById('btnSidebarSafety'),
      btnSidebarMemory: document.getElementById('btnSidebarMemory'),
      btnSidebarPersonal: document.getElementById('btnSidebarPersonal'),
      btnSidebarAuth: document.getElementById('btnSidebarAuth') || document.getElementById('sidebarAuthStatusRow'),
      sidebarAuthStatus: document.getElementById('sidebarAuthStatus'),
      sidebarServerStatus: document.getElementById('sidebarServerStatus'),
      sidebarUserCard: document.getElementById('sidebarUserCard'),
      btnUserSettings: document.getElementById('btnUserSettings'),

      // Right Panel System Status Controls
      chatRightPanel: document.getElementById('chatRightPanel'),
      btnToggleRightPanel: document.getElementById('btnToggleRightPanel'),
      btnExpandRightPanel: document.getElementById('btnExpandRightPanel'),

      // Milestone 2 & 3 — Camera Modal Elements
      cameraModal: document.getElementById('cameraModal'),
      btnModalClose: document.getElementById('btnModalClose') || document.getElementById('btnCloseCameraModal'),
      modalVideo: document.getElementById('modalVideo') || document.getElementById('cameraModalVideo'),
      modalCanvas: document.getElementById('modalCanvas') || document.getElementById('cameraModalCanvas'),
      modalShutterFlash: document.getElementById('modalShutterFlash') || document.getElementById('cameraModalShutterFlash'),
      btnModalCapture: document.getElementById('btnModalCapture') || document.getElementById('btnModalTakeSnapshot'),
      cameraModalStateNotice: document.getElementById('cameraModalStateNotice') || document.getElementById('cameraModalStatusMessage'),
      cameraModalError: document.getElementById('cameraModalError'),
      cameraModalErrorText: document.getElementById('cameraModalErrorText'),

      // Milestone 2 & 3 — Chat-First Container Elements
      chatContainer: document.getElementById('chatContainer'),
      chatWelcomeScreen: document.getElementById('chatWelcomeScreen'),
      chatThread: document.getElementById('chatThread'),
      chatInputContainer: document.getElementById('chatInputContainer'),
      chatInput: document.getElementById('chatInput') || document.getElementById('chatMessageInput'),
      btnOpenCameraModal: document.getElementById('btnOpenCameraModal') || document.getElementById('btnOpenCamModal'),
      btnChatSend: document.getElementById('btnChatSend') || document.getElementById('btnSendChatMessage'),
      btnChatStop: document.getElementById('btnChatStop') || document.getElementById('btnStopGeneration'),
      chatSnapshotContainer: document.getElementById('chatSnapshotContainer') || document.getElementById('snapshotPreviewContainer'),
      chatSnapshotThumb: document.getElementById('chatSnapshotThumb') || document.getElementById('snapshotThumbnail'),
      chatSnapshotRemove: document.getElementById('chatSnapshotRemove') || document.getElementById('btnRemoveSnapshot'),
      chatPrivacyNotice: document.getElementById('chatPrivacyNotice'),
      chatAuthBanner: document.getElementById('chatAuthBanner'),
      btnChatAuthLogin: document.getElementById('btnChatAuthLogin'),
      chatStatusIndicator: document.getElementById('chatStatusIndicator'),
      chatStatusText: document.getElementById('chatStatusText'),
      sidebarChatHistory: document.getElementById('sidebarChatHistory'),
      recentActivityList: document.getElementById('recentActivityList'),
      rightPanelBackendStatus: document.getElementById('rightPanelBackendStatus'),
      rightPanelAiStatus: document.getElementById('rightPanelAiStatus'),
      rightPanelModelStatus: document.getElementById('rightPanelModelStatus')
    };
  }

  async init() {
    try {
      // Inisialisasi V1.5 UI Helper Modules (Theme, Navigation, Bottom Sheet)
      this.themeManager = new ThemeManager();
      this.bottomSheetManager = new BottomSheetManager();
      this.navigationManager = new NavigationManager({
        initialMode: 'home',
        onModeChange: (mode) => this.setMode(mode)
      });
      this.navigationManager.updateRoleVisibility(authService.getRole());
      this.contextualPanelManager = new ContextualPanelManager();

      // M9: Insecure Context Warning check
      if (typeof window !== 'undefined' && window.isSecureContext === false) {
        this.showCameraInsecureWarning('Kamera butuh HTTPS. Buka lewat alamat HTTPS atau localhost.');
      }

      // Synchronize APP_VERSION across all version tags in UI
      document.querySelectorAll('.version-tag, .badge-v1-tag, [data-version]').forEach(el => {
        el.textContent = `v${APP_VERSION}`;
      });

      // Inisialisasi CameraModal & ChatController SEGERA (Chat-First UI instan tanpa menunggu model ONNX)
      try {
        this.cameraModal = new CameraModal({
          cameraService: this.cameraService,
          inferenceService: this.inferenceService,
          modalElement: this.elements.cameraModal,
          videoElement: this.elements.modalVideo,
          canvasElement: this.elements.modalCanvas,
          captureBtn: this.elements.btnModalCapture,
          closeBtn: this.elements.btnModalClose,
          shutterElement: this.elements.modalShutterFlash,
          stateNoticeElement: this.elements.cameraModalStateNotice,
          errorElement: this.elements.cameraModalError,
          errorTextElement: this.elements.cameraModalErrorText,
          onSnapshot: (snapshotData) => {
            if (this.chatController) {
              this.chatController.setSnapshot(snapshotData.dataUrl, snapshotData.detections);
            }
          }
        });

        const aiProvider = this.visionAssistant ? this.visionAssistant.aiProvider : new BackendAIProvider({
          onAuthRequired: () => this.promptAuthModal()
        });

        this.chatController = new ChatController({
          aiProvider: aiProvider,
          contextFn: () => this.buildCurrentVisionContext(),
          onAuthRequired: () => this.promptAuthModal(),
          onError: (msg) => this.showError(msg),
          onCameraModalRequested: () => {
            if (this.cameraModal) {
              this.cameraModal.open();
            }
          },
          elements: {
            welcomeScreen: this.elements.chatWelcomeScreen,
            threadContainer: this.elements.chatThread,
            inputElement: this.elements.chatInput,
            sendBtn: this.elements.btnChatSend,
            stopBtn: this.elements.btnChatStop,
            cameraBtn: this.elements.btnOpenCameraModal,
            snapshotContainer: this.elements.chatSnapshotContainer,
            snapshotThumb: this.elements.chatSnapshotThumb,
            snapshotRemoveBtn: this.elements.chatSnapshotRemove,
            privacyNotice: this.elements.chatPrivacyNotice,
            authBanner: this.elements.chatAuthBanner,
            authLoginBtn: this.elements.btnChatAuthLogin,
            statusIndicator: this.elements.chatStatusIndicator,
            statusText: this.elements.chatStatusText,
            historyListContainer: this.elements.sidebarChatHistory,
            recentActivityList: this.elements.recentActivityList,
            rightPanelBackendStatus: this.elements.rightPanelBackendStatus,
            rightPanelAiStatus: this.elements.rightPanelAiStatus,
            rightPanelModelStatus: this.elements.rightPanelModelStatus
          }
        });
        this.chatController.setUserId(authService.getUserId());
      } catch (chatInitErr) {
        console.warn('[VisionX] Peringatan inisialisasi ChatController/CameraModal:', chatInitErr);
      }

      // Inisialisasi input nama kelas dari localStorage
      if (this.elements.inputClassName) {
        this.elements.inputClassName.value = this.captureService.currentClass;
      }
      this.updateCollectionUI();
      this.syncVoiceUIFromConfig();
      this.updateAuthStatusUI();

      // Muat dataset disk untuk galeri sesi capture
      try {
        await this.captureService.loadExistingDataset();
        this.renderRecentCaptures();
        this.updateCollectionUI();
      } catch (galleryErr) {
        console.warn('[VisionX] Peringatan inisialisasi galeri (non-blocking):', galleryErr);
      }

      // Muat default model YOLO (VisionX V2 Real-World Improved)
      const initialModelId = (this.elements.modelSelect && this.elements.modelSelect.value) || 'visionx_v2';
      await this.loadSelectedModel(initialModelId);

      // Inisialisasi UI Personal Objects (V1.2)
      this.updatePersonalObjectsUI();

      // Inisialisasi UI Safety Alerts (V1.3.1)
      this.syncSafetyAlertsUIFromConfig();
      this.updateSafetyAlertsUI();

      // Prefetch data Identity Lab & Dataset Manager di background
      this.identityService.getProfile().catch(() => {});
      this.managerService.fetchStats().catch(() => {});

      // Set initial view ke Home (Landing state) hanya jika belum berpindah mode
      if (this.currentMode === 'home') {
        this.setMode('home');
      }
    } catch (fatalErr) {
      console.error('[VisionX Fatal] Peringatan inisialisasi background:', fatalErr);
      this.updateInferenceUI('error', 'Init Error: ' + fatalErr.message);
      this.showError('Gagal memuat beberapa komponen: ' + fatalErr.message);
    }
  }

  /**
   * Bind semua event listener UI
   */
  bindEvents() {
    // Status Popover Trigger
    if (this.elements.headerServerStatusPill && this.elements.headerStatusPopover) {
      this.elements.headerServerStatusPill.addEventListener('click', (e) => {
        e.stopPropagation();
        this.elements.headerStatusPopover.classList.toggle('hidden');
      });
      if (this.elements.btnCloseStatusPopover) {
        this.elements.btnCloseStatusPopover.addEventListener('click', (e) => {
          e.stopPropagation();
          this.elements.headerStatusPopover.classList.add('hidden');
        });
      }
      document.addEventListener('click', (e) => {
        if (!this.elements.headerStatusPopover.classList.contains('hidden')) {
          if (!this.elements.headerStatusPopover.contains(e.target) && !this.elements.headerServerStatusPill.contains(e.target)) {
            this.elements.headerStatusPopover.classList.add('hidden');
          }
        }
      });
    }

    // Reuse the system status details from the desktop header on mobile.
    if (this.elements.mobileStatusDot && this.elements.headerStatusPopover) {
      this.elements.mobileStatusDot.addEventListener('click', (e) => {
        e.stopPropagation();
        this.elements.headerStatusPopover.classList.add('mobile-status-popover');
        if (this.elements.headerStatusPopover.parentElement !== document.body) {
          document.body.appendChild(this.elements.headerStatusPopover);
        }
        this.elements.headerStatusPopover.classList.toggle('hidden');
      });
    }

    // Home Triggers (Desktop Nav Tab & Brand Logo)
    if (this.elements.btnNavHome) {
      this.elements.btnNavHome.addEventListener('click', () => this.setMode('home'));
    }
    if (this.elements.brandLogo) {
      this.elements.brandLogo.addEventListener('click', () => this.setMode('home'));
      this.elements.brandLogo.addEventListener('keydown', (e) => {
        if (e.target === this.elements.brandLogo && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          this.setMode('home');
        }
      });
    }

    // Milestone 2 Sidebar & Drawer Events
    if (this.elements.btnSidebarNewChat) {
      this.elements.btnSidebarNewChat.addEventListener('click', () => {
        this.setMode('home');
        if (this.chatController) {
          this.chatController.newChat();
        }
        this.closeMobileDrawer();
      });
    }

    const sidebarNavItems = document.querySelectorAll('.sidebar-nav-item[data-mode]');
    sidebarNavItems.forEach((item) => {
      item.addEventListener('click', (e) => {
        e.preventDefault();
        const mode = item.getAttribute('data-mode');
        if (mode) {
          this.setMode(mode);
          this.closeMobileDrawer();
        }
      });
    });

    if (this.elements.btnMobileMenuToggle) {
      this.elements.btnMobileMenuToggle.addEventListener('click', () => {
        this.toggleMobileDrawer();
      });
    }

    if (this.elements.btnToggleSidebar) {
      this.elements.btnToggleSidebar.addEventListener('click', () => {
        this.toggleMobileDrawer();
      });
    }

    if (this.elements.mobileDrawerBackdrop) {
      this.elements.mobileDrawerBackdrop.addEventListener('click', () => {
        this.closeMobileDrawer();
      });
    }

    if (this.elements.btnCloseSidebar) {
      this.elements.btnCloseSidebar.addEventListener('click', () => {
        this.closeMobileDrawer();
      });
    }

    if (this.elements.btnMobileNewChat) {
      this.elements.btnMobileNewChat.addEventListener('click', () => {
        this.setMode('home');
        if (this.chatController) {
          this.chatController.newChat();
        }
        this.closeMobileDrawer();
      });
    }

    if (this.elements.btnToggleRightPanel && this.elements.chatRightPanel) {
      this.elements.btnToggleRightPanel.addEventListener('click', () => {
        this.elements.chatRightPanel.classList.add('collapsed');
        if (this.elements.btnExpandRightPanel) {
          this.elements.btnExpandRightPanel.classList.remove('hidden');
        }
      });
    }

    if (this.elements.btnExpandRightPanel && this.elements.chatRightPanel) {
      this.elements.btnExpandRightPanel.addEventListener('click', () => {
        this.elements.chatRightPanel.classList.remove('collapsed');
        this.elements.btnExpandRightPanel.classList.add('hidden');
      });
    }

    if (this.elements.btnSidebarSafety) {
      this.elements.btnSidebarSafety.addEventListener('click', () => {
        this.setMode('detection');
        if (this.contextualPanelManager) {
          this.contextualPanelManager.openPanel('safety');
        }
        this.closeMobileDrawer();
      });
    }

    if (this.elements.btnSidebarMemory) {
      this.elements.btnSidebarMemory.addEventListener('click', () => {
        this.setMode('detection');
        if (this.contextualPanelManager) {
          this.contextualPanelManager.openPanel('memory');
        }
        this.closeMobileDrawer();
      });
    }

    if (this.elements.btnSidebarPersonal) {
      this.elements.btnSidebarPersonal.addEventListener('click', () => {
        this.setMode('detection');
        if (this.contextualPanelManager) {
          this.contextualPanelManager.openPanel('personal');
        }
        this.closeMobileDrawer();
      });
    }

    if (this.elements.sidebarUserCard || this.elements.btnUserSettings) {
      const userCardHandler = () => {
        this.setMode('identity');
        this.closeMobileDrawer();
      };
      if (this.elements.sidebarUserCard) this.elements.sidebarUserCard.addEventListener('click', userCardHandler);
      if (this.elements.btnUserSettings) this.elements.btnUserSettings.addEventListener('click', (e) => {
        e.stopPropagation();
        userCardHandler();
      });
    }

    const btnNotifications = document.getElementById('btnNotifications');
    if (btnNotifications) {
      btnNotifications.addEventListener('click', () => {
        this.showSuccess('Sistem VisionX beroperasi normal (Gateway Online).');
      });
    }

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (this.elements.appSidebar && this.elements.appSidebar.classList.contains('open')) {
          this.closeMobileDrawer();
        }
      }
    });

    if (this.elements.btnSidebarAuth) {
      this.elements.btnSidebarAuth.addEventListener('click', () => {
        if (this.visionAssistant?.aiProvider?.isAuthenticated?.()) {
          this.visionAssistant.aiProvider.clearToken();
          this.updateAuthStatusUI();
          this.showSuccess('Sesi gateway berhasil keluar.');
        } else {
          this.openAuthModal();
        }
      });
    }

    // Home Landing Page Cards Navigation
    if (this.elements.homeView) {
      const homeCards = this.elements.homeView.querySelectorAll('[data-nav-target]');
      homeCards.forEach((card) => {
        const target = card.dataset.navTarget;
        const handleNav = (e) => {
          e.preventDefault();
          if (target === 'chat') {
            this.openChatAssistant();
          } else if (target) {
            this.setMode(target);
          }
        };
        card.addEventListener('click', handleNav);
        card.addEventListener('keydown', (e) => {
          if (e.target === card && (e.key === 'Enter' || e.key === ' ')) {
            handleNav(e);
          }
        });
      });
    }

    // Mode Switcher Tabs (5 Modes)
    if (this.elements.btnModeDetect) this.elements.btnModeDetect.addEventListener('click', () => this.setMode('detection'));
    if (this.elements.btnModeCollect) this.elements.btnModeCollect.addEventListener('click', () => this.setMode('collection'));
    if (this.elements.btnModeManager) this.elements.btnModeManager.addEventListener('click', () => this.setMode('manager'));
    if (this.elements.btnModeIdentity) this.elements.btnModeIdentity.addEventListener('click', () => this.setMode('identity'));
    if (this.elements.btnModeReadText) {
      this.elements.btnModeReadText.addEventListener('click', () => this.setMode('read_text'));
    }

    // OCR & Read Text Controls (V0.9 / V1.2.1 Hardening)
    if (this.elements.btnTriggerOcr) {
      this.elements.btnTriggerOcr.addEventListener('click', () => this.handleTriggerOcr(false, false));
    }
    if (this.elements.btnReScanOcr) {
      this.elements.btnReScanOcr.addEventListener('click', () => this.handleTriggerOcr(false, true));
    }
    if (this.elements.btnStopOcr) {
      this.elements.btnStopOcr.addEventListener('click', () => this.handleStopOcr());
    }
    if (this.elements.btnSpeakOcr) {
      this.elements.btnSpeakOcr.addEventListener('click', () => this.handleSpeakOcr());
    }
    if (this.elements.ocrLangSelect) {
      this.elements.ocrLangSelect.addEventListener('change', (e) => this.handleOcrLanguageChange(e.target.value));
    }
    if (this.elements.ocrProfileSelect) {
      this.elements.ocrProfileSelect.addEventListener('change', (e) => this.handleOcrProfileChange(e.target.value));
    }
    if (this.elements.ocrRoiSelect) {
      this.elements.ocrRoiSelect.addEventListener('change', (e) => this.handleOcrRoiChange(e.target.value));
    }
    if (this.elements.toggleAutoReadOcr) {
      this.elements.toggleAutoReadOcr.addEventListener('change', (e) => this.handleToggleAutoReadOcr(e.target.checked));
    }
    if (this.elements.btnCopyOcrText) {
      this.elements.btnCopyOcrText.addEventListener('click', () => this.handleCopyOcrText());
    }
    if (this.elements.btnClearOcrText) {
      this.elements.btnClearOcrText.addEventListener('click', () => this.handleClearOcrText());
    }

    // Ask VisionX Assistant Events (V1.0)
    if (this.elements.askVisionForm) {
      this.elements.askVisionForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const query = this.elements.askVisionInput ? this.elements.askVisionInput.value : '';
        this.handleAskVisionSubmit(query);
      });
    }

    if (this.elements.quickPromptChips) {
      this.elements.quickPromptChips.forEach((chip) => {
        chip.addEventListener('click', () => {
          const prompt = chip.getAttribute('data-prompt');
          if (prompt) {
            if (this.elements.askVisionInput) {
              this.elements.askVisionInput.value = prompt;
            }
            this.handleAskVisionSubmit(prompt);
          }
        });
      });
    }

    if (this.elements.btnReadAloudResponse) {
      this.elements.btnReadAloudResponse.addEventListener('click', () => {
        if (this.visionAssistant) {
          this.visionAssistant.speakResponse();
        }
      });
    }

    if (this.elements.btnStopSpeechResponse) {
      this.elements.btnStopSpeechResponse.addEventListener('click', () => {
        if (this.visionAssistant) {
          this.visionAssistant.stopSpeech();
        }
      });
    }

    if (this.elements.btnClearResponse) {
      this.elements.btnClearResponse.addEventListener('click', () => {
        this.handleClearAssistantResponse();
      });
    }

    if (this.elements.btnResetConversation) {
      this.elements.btnResetConversation.addEventListener('click', () => {
        this.handleClearAssistantResponse();
      });
    }

    // Phase 2 Auth & Gateway Events
    if (this.elements.btnAuthToggle) {
      this.elements.btnAuthToggle.addEventListener('click', () => {
        if (authService.isAuthenticated()) {
          authService.signOut();
          this.updateAuthStatusUI();
          this.showSuccess('Sesi berhasil keluar.');
        } else {
          this.openAuthModal();
        }
      });
    }

    // Modal Tabs & Switching
    if (this.elements.tabAuthLogin) {
      this.elements.tabAuthLogin.addEventListener('click', () => this.switchAuthTab('login'));
    }
    if (this.elements.tabAuthRegister) {
      this.elements.tabAuthRegister.addEventListener('click', () => this.switchAuthTab('register'));
    }
    if (this.elements.btnAuthForgotPassword) {
      this.elements.btnAuthForgotPassword.addEventListener('click', () => this.switchAuthTab('forgot_password'));
    }
    if (this.elements.btnAuthBackToLogin) {
      this.elements.btnAuthBackToLogin.addEventListener('click', () => this.switchAuthTab('login'));
    }

    // Inputs Enter Key Handling
    if (this.elements.authModalEmailInput) {
      this.elements.authModalEmailInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (this.authTabMode === 'forgot_password') {
            this.handleAuthSubmit();
          } else {
            this.elements.authModalPasswordInput?.focus();
          }
        }
      });
    }
    if (this.elements.authModalPasswordInput) {
      this.elements.authModalPasswordInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this.handleAuthSubmit();
        }
      });
    }

    // Modal Action Buttons
    if (this.elements.btnCloseAuthModal) {
      this.elements.btnCloseAuthModal.addEventListener('click', () => this.closeAuthModal());
    }
    if (this.elements.btnCancelAuthModal) {
      this.elements.btnCancelAuthModal.addEventListener('click', () => this.closeAuthModal());
    }
    if (this.elements.btnSubmitAuthModal) {
      this.elements.btnSubmitAuthModal.addEventListener('click', () => this.handleAuthSubmit());
    }

    // Header User Avatar & Dropdown Menu (F3 & I4)
    if (this.elements.headerUserAvatar) {
      this.elements.headerUserAvatar.addEventListener('click', (e) => {
        e.stopPropagation();
        this.elements.userAvatarDropdown?.classList.toggle('hidden');
      });
    }
    if (this.elements.btnOpenSettingsModal) {
      this.elements.btnOpenSettingsModal.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.elements.userAvatarDropdown?.classList.add('hidden');
        this.openSettingsModal('account');
      });
    }
    if (this.elements.btnHeaderSignOut) {
      this.elements.btnHeaderSignOut.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.elements.userAvatarDropdown?.classList.add('hidden');
        if (authService.isAuthenticated()) {
          await authService.signOut();
          this.updateAuthStatusUI();
          this.showSuccess('Anda telah keluar.');
        } else {
          this.openAuthModal();
        }
      });
    }
    document.addEventListener('click', (e) => {
      if (
        this.elements.userAvatarDropdown &&
        !this.elements.userAvatarDropdown.classList.contains('hidden') &&
        !this.elements.userAvatarContainer?.contains(e.target)
      ) {
        this.elements.userAvatarDropdown.classList.add('hidden');
      }
      if (
        this.elements.privacyPopover &&
        !this.elements.privacyPopover.classList.contains('hidden') &&
        !this.elements.privacyPopover.contains(e.target) &&
        !this.elements.btnPrivacyPopoverToggle?.contains(e.target)
      ) {
        this.elements.privacyPopover.classList.add('hidden');
      }
    });

    // Privacy Popover Listeners (I1)
    if (this.elements.btnPrivacyPopoverToggle) {
      this.elements.btnPrivacyPopoverToggle.addEventListener('click', (e) => {
        e.stopPropagation();
        this.elements.privacyPopover?.classList.toggle('hidden');
      });
    }
    if (this.elements.btnClosePrivacyPopover) {
      this.elements.btnClosePrivacyPopover.addEventListener('click', (e) => {
        e.stopPropagation();
        this.elements.privacyPopover?.classList.add('hidden');
      });
    }
    if (this.elements.btnPrivacyGoToSettings) {
      this.elements.btnPrivacyGoToSettings.addEventListener('click', (e) => {
        e.stopPropagation();
        this.elements.privacyPopover?.classList.add('hidden');
        this.openSettingsModal('privacy');
      });
    }

    // App Settings Modal Listeners (I4)
    if (this.elements.btnCloseSettingsModal) {
      this.elements.btnCloseSettingsModal.addEventListener('click', () => {
        this.closeSettingsModal();
      });
    }

    const btnMobileProfile = document.getElementById('btnMobileProfile');
    if (btnMobileProfile) {
      btnMobileProfile.addEventListener('click', (e) => {
        e.preventDefault();
        this.openSettingsModal('account');
      });
    }
    if (this.elements.appSettingsModal) {
      this.elements.appSettingsModal.addEventListener('click', (e) => {
        if (e.target === this.elements.appSettingsModal) {
          this.closeSettingsModal();
        }
      });
    }
    if (this.elements.settingsTabBtns) {
      this.elements.settingsTabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
          const tabName = btn.dataset.tab;
          if (tabName) this.switchSettingsTab(tabName);
        });
      });
    }
    if (this.elements.btnSettingsAuthAction) {
      this.elements.btnSettingsAuthAction.addEventListener('click', async () => {
        if (authService.isAuthenticated()) {
          this.closeSettingsModal();
          await authService.signOut();
          this.updateAuthStatusUI();
          this.showSuccess('Anda telah keluar.');
        } else {
          this.closeSettingsModal();
          this.openAuthModal();
        }
      });
    }
    if (this.elements.btnSettingsClearAllHistory) {
      this.elements.btnSettingsClearAllHistory.addEventListener('click', async () => {
        this.closeSettingsModal();
        if (this.chatController) {
          await this.chatController.clearAllHistory();
        }
      });
    }
    if (this.elements.btnSettingsOpenDatasetMgr) {
      this.elements.btnSettingsOpenDatasetMgr.addEventListener('click', () => {
        this.closeSettingsModal();
        this.setMode('collection');
      });
    }
    if (this.elements.btnSettingsOpenIdentityLab) {
      this.elements.btnSettingsOpenIdentityLab.addEventListener('click', () => {
        this.closeSettingsModal();
        this.setMode('identity');
      });
    }

    // Developer Notice Modal Buttons (F5)
    if (this.elements.btnCloseDevNotice) {
      this.elements.btnCloseDevNotice.addEventListener('click', () => this.closeDeveloperNotice());
    }
    if (this.elements.btnDevNoticeHome) {
      this.elements.btnDevNoticeHome.addEventListener('click', () => {
        this.closeDeveloperNotice();
        this.setMode('home');
      });
    }
    if (this.elements.btnDevNoticeLogin) {
      this.elements.btnDevNoticeLogin.addEventListener('click', () => {
        this.closeDeveloperNotice();
        this.openAuthModal();
      });
    }

    // Object Memory Events (V1.1)
    if (this.elements.btnClearObjectMemory) {
      this.elements.btnClearObjectMemory.addEventListener('click', () => {
        if (this.objectMemory) {
          this.objectMemory.clear();
          this.updateObjectMemoryUI();
          this.showSuccess('Memori sesi objek berhasil dikosongkan.');
        }
      });
    }

    // Personal Objects Controls (V1.2)
    if (this.elements.btnToggleEnrollForm) {
      this.elements.btnToggleEnrollForm.addEventListener('click', () => {
        if (this.elements.enrollmentFormSection) {
          this.elements.enrollmentFormSection.classList.toggle('hidden');
        }
      });
    }

    if (this.elements.btnCancelEnroll) {
      this.elements.btnCancelEnroll.addEventListener('click', () => {
        if (this.elements.enrollmentFormSection) {
          this.elements.enrollmentFormSection.classList.add('hidden');
        }
        this.tempEnrollmentReferences = [];
        this.renderEnrollRefGallery();
      });
    }

    if (this.elements.btnCaptureRefCam) {
      this.elements.btnCaptureRefCam.addEventListener('click', async () => {
        await this.handleCaptureEnrollRefCam();
      });
    }

    if (this.elements.inputRefFile) {
      this.elements.inputRefFile.addEventListener('change', async (e) => {
        await this.handleUploadEnrollRefFile(e.target.files);
      });
    }

    if (this.elements.btnSaveEnrolledObject) {
      this.elements.btnSaveEnrolledObject.addEventListener('click', async () => {
        await this.handleSaveEnrolledObject();
      });
    }

    if (this.elements.personalMatchThresholdSlider) {
      this.elements.personalMatchThresholdSlider.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        if (this.elements.personalThresholdVal) {
          this.elements.personalThresholdVal.textContent = val.toFixed(2);
        }
        if (this.personalObjectRecognizer) {
          this.personalObjectRecognizer.config.defaultThreshold = val;
        }
      });
    }

    // Safety Alert Manager Controls (V1.3.1)
    if (this.elements.btnClearSafetyAlerts) {
      this.elements.btnClearSafetyAlerts.addEventListener('click', () => {
        if (this.alertManager) {
          this.alertManager.clearAlerts();
          this.showSuccess('Riwayat alert keselamatan dibersihkan.');
        }
      });
    }

    if (this.elements.toggleSafetyAlerts) {
      this.elements.toggleSafetyAlerts.addEventListener('change', (e) => {
        if (this.alertManager) {
          this.alertManager.updateConfig({ safetyAlertsEnabled: e.target.checked });
        }
      });
    }

    if (this.elements.toggleVoiceSafetyAlerts) {
      this.elements.toggleVoiceSafetyAlerts.addEventListener('change', (e) => {
        if (this.alertManager) {
          this.alertManager.updateConfig({ voiceSafetyAlertsEnabled: e.target.checked });
        }
      });
    }

    if (this.elements.togglePersistentAlerts) {
      this.elements.togglePersistentAlerts.addEventListener('change', (e) => {
        if (this.alertManager) {
          this.alertManager.updateConfig({ persistentAlertsEnabled: e.target.checked });
        }
      });
    }

    if (this.elements.sliderAlertCooldown) {
      this.elements.sliderAlertCooldown.addEventListener('input', (e) => {
        const sec = parseInt(e.target.value, 10);
        if (this.elements.alertCooldownVal) {
          this.elements.alertCooldownVal.textContent = `${sec}s`;
        }
        if (this.alertManager) {
          const ms = sec * 1000;
          this.alertManager.updateConfig({
            defaultCooldownMs: ms,
            personalLeftCooldownMs: ms,
            anomalyCooldownMs: ms
          });
        }
      });
    }

    // Camera Start / Stop
    if (this.elements.btnStart) this.elements.btnStart.addEventListener('click', () => this.handleStartCamera());
    if (this.elements.btnStop) this.elements.btnStop.addEventListener('click', () => this.handleStopCamera());

    // Phase C: Realtime Summary Strip Synchronization (Decoupled DOM sync)
    const syncSummary = () => {
      if (this.elements.summaryDetectionCount && this.elements.detectionCountValue) {
        this.elements.summaryDetectionCount.textContent = this.elements.detectionCountValue.textContent;
      }
      if (this.elements.summaryTrackedCount && this.elements.trackedCountValue) {
        this.elements.summaryTrackedCount.textContent = this.elements.trackedCountValue.textContent;
      }
      if (this.elements.summaryFpsDisplay && this.elements.fpsValue) {
        const fpsNum = parseFloat(this.elements.fpsValue.textContent);
        this.elements.summaryFpsDisplay.textContent = isNaN(fpsNum) || fpsNum <= 0
          ? (this.cameraService.state.status === 'connected' ? 'Live' : 'Ready')
          : `${fpsNum.toFixed(1)} FPS`;
      }
    };
    try {
      const summaryObserver = new MutationObserver(() => syncSummary());
      if (this.elements.detectionCountValue) {
        summaryObserver.observe(this.elements.detectionCountValue, { childList: true, characterData: true, subtree: true });
      }
      if (this.elements.trackedCountValue) {
        summaryObserver.observe(this.elements.trackedCountValue, { childList: true, characterData: true, subtree: true });
      }
      if (this.elements.fpsValue) {
        summaryObserver.observe(this.elements.fpsValue, { childList: true, characterData: true, subtree: true });
      }
    } catch (obsErr) {
      console.warn('[VisionX] Summary observer initialization skipped:', obsErr);
    }

    // Toggle Mirror Camera (container wrapper scale-x-[-1])
    if (this.elements.btnToggleMirror) {
      this.elements.btnToggleMirror.addEventListener('click', () => {
        const isMirrored = this.frameSource.toggleMirror();
        const stageContainer = document.getElementById('stageVideoContainer') || this.elements.video?.parentElement;
        if (stageContainer) {
          stageContainer.classList.toggle('scale-x-[-1]', isMirrored);
          stageContainer.classList.toggle('mirrored', isMirrored);
        }
        if (this.elements.mirrorBtnText) {
          this.elements.mirrorBtnText.textContent = isMirrored ? 'Mirrored' : 'Cermin';
        }
        this.elements.btnToggleMirror.classList.toggle('active', isMirrored);
        if (this.renderer) {
          this.renderer.isMirrored = isMirrored;
        }
        this.updateDiagnosticsUI();
      });
    }

    // Toggle Face Recognition Layer
    if (this.elements.toggleFaceRecognition) {
      this.elements.toggleFaceRecognition.addEventListener('change', (e) => {
        const enabled = e.target.checked;
        this.faceDetector.setEnabled(enabled);
        this.faceRecognizer.setEnabled(enabled);
        this.updateDiagnosticsUI();
      });
    }

    // Toggle Object Tracking Engine (V0.7)
    if (this.elements.toggleTracking) {
      this.elements.toggleTracking.addEventListener('change', (e) => {
        this.trackingEngine.isEnabled = e.target.checked;
        this.updateDiagnosticsUI();
      });
    }

    // Voice Assistant Engine Controls (V0.8)
    if (this.elements.toggleVoice) {
      this.elements.toggleVoice.addEventListener('change', (e) => {
        this.setVoiceEnabled(e.target.checked);
      });
    }

    if (this.elements.voiceModeSelect) {
      this.elements.voiceModeSelect.addEventListener('change', (e) => {
        this.setVoiceMode(e.target.value);
      });
    }

    if (this.elements.voiceVolumeSlider) {
      this.elements.voiceVolumeSlider.addEventListener('input', (e) => {
        this.setVoiceVolume(parseFloat(e.target.value));
      });
    }

    if (this.elements.voiceSpeedSlider) {
      this.elements.voiceSpeedSlider.addEventListener('input', (e) => {
        this.setVoiceSpeed(parseFloat(e.target.value));
      });
    }

    if (this.elements.btnVoiceReplay) {
      this.elements.btnVoiceReplay.addEventListener('click', () => {
        if (this.voiceEngine) this.voiceEngine.replayLastMessage();
      });
    }

    if (this.elements.btnVoiceStop) {
      this.elements.btnVoiceStop.addEventListener('click', () => {
        if (this.voiceEngine) this.voiceEngine.stop();
      });
    }

    if (this.elements.btnVoiceClearQueue) {
      this.elements.btnVoiceClearQueue.addEventListener('click', () => {
        if (this.voiceEngine) {
          this.voiceEngine.clearQueue();
          this.showSuccessBanner('Antrean suara dikosongkan.');
        }
      });
    }

    // Switch device kamera
    this.elements.deviceSelect.addEventListener('change', (e) => {
      const selectedId = e.target.value || null;
      if (this.cameraService.state.status === 'connected') {
        this.handleStartCamera(selectedId);
      }
    });

    // Model Selector Change
    this.elements.modelSelect.addEventListener('change', async (e) => {
      await this.loadSelectedModel(e.target.value);
    });

    // Toggle Inferensi AI
    this.elements.toggleInference.addEventListener('change', (e) => {
      this.inferenceService.isActive = e.target.checked;
      const modelName = this.inferenceService.modelConfig.shortName;
      this.updateInferenceUI(e.target.checked, e.target.checked ? `${modelName} Aktif` : 'Inference Inactive');
    });

    // Sliders Threshold
    this.elements.confSlider.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      this.inferenceService.confThreshold = val;
      this.elements.confVal.textContent = val.toFixed(2);
    });
    this.elements.iouSlider.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      this.inferenceService.iouThreshold = val;
      this.elements.iouVal.textContent = val.toFixed(2);
    });

    // Toggle Debug Mode
    this.elements.toggleDebug.addEventListener('change', (e) => {
      this.isDebugVisible = e.target.checked;
      if (this.currentMode === 'detection') {
        this.elements.debugPanel.classList.toggle('hidden', !this.isDebugVisible);
      }
    });

    // Golden Test Trigger (V0.6.1 Diagnostic)
    if (this.elements.btnRunGoldenTest) {
      this.elements.btnRunGoldenTest.addEventListener('click', () => this.runGoldenTest());
    }

    // Collection Mode Class Input & Buttons
    this.elements.btnSetClass.addEventListener('click', () => this.handleSetClass());
    this.elements.inputClassName.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.handleSetClass();
      }
    });
    this.elements.sourceSelect.addEventListener('change', (e) => {
      this.captureService.setSource(e.target.value);
      this.updateCollectionUI();
    });
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
    this.elements.btnSelectDir.addEventListener('click', () => this.handleSelectDirectory());

    // Import Toolbar (Collection)
    this.elements.btnTriggerImportImages.addEventListener('click', () => this.elements.inputImportImages.click());
    this.elements.inputImportImages.addEventListener('change', (e) => this.handleImportImages(e.target.files));
    this.elements.btnTriggerImportFolder.addEventListener('click', () => this.elements.inputImportFolder.click());
    this.elements.inputImportFolder.addEventListener('change', (e) => this.handleFolderSelected(e.target.files));

    // Multi-Select Gallery (Collection)
    this.elements.btnToggleSelectMode.addEventListener('click', () => this.toggleSelectMode());
    this.elements.btnSelectAll.addEventListener('click', () => this.selectAllCaptures());
    this.elements.btnClearSelection.addEventListener('click', () => this.clearSelection());
    this.elements.btnDeleteSelected.addEventListener('click', () => this.handleDeleteSelectedPrompt());

    // ========================================================================
    // MODULE 1 — DATASET MANAGER EVENT LISTENERS (V0.6)
    // ========================================================================
    this.elements.btnMgrViewActive.addEventListener('click', () => {
      this.elements.btnMgrViewActive.classList.add('active');
      this.elements.btnMgrViewTrash.classList.remove('active');
      this.elements.btnMgrTrashSelected.classList.remove('hidden');
      this.elements.btnMgrRestoreSelected.classList.add('hidden');
      this.elements.btnMgrPermanentDeleteSelected.classList.add('hidden');
      this.managerService.currentView = 'active';
      this.managerService.clearSelection();
      this.loadManagerData();
    });

    this.elements.btnMgrViewTrash.addEventListener('click', () => {
      this.elements.btnMgrViewTrash.classList.add('active');
      this.elements.btnMgrViewActive.classList.remove('active');
      this.elements.btnMgrTrashSelected.classList.add('hidden');
      this.elements.btnMgrRestoreSelected.classList.remove('hidden');
      this.elements.btnMgrPermanentDeleteSelected.classList.remove('hidden');
      this.managerService.currentView = 'trash';
      this.managerService.clearSelection();
      this.loadManagerData();
    });

    this.elements.mgrSelectClass.addEventListener('change', (e) => {
      this.managerService.selectedClass = e.target.value;
      this.managerService.fetchList().then(() => this.renderManagerGrid());
    });

    this.elements.mgrSelectSource.addEventListener('change', (e) => {
      this.managerService.selectedSource = e.target.value;
      this.managerService.fetchList().then(() => this.renderManagerGrid());
    });

    this.elements.mgrSearchInput.addEventListener('input', (e) => {
      this.managerService.searchQuery = e.target.value;
      this.managerService.fetchList().then(() => this.renderManagerGrid());
    });

    this.elements.btnMgrRefresh.addEventListener('click', () => this.loadManagerData());

    this.elements.btnMgrSelectAll.addEventListener('click', () => {
      this.managerService.selectAll();
      this.updateManagerSelectionUI();
      this.renderManagerGrid();
    });

    this.elements.btnMgrClearSelect.addEventListener('click', () => {
      this.managerService.clearSelection();
      this.updateManagerSelectionUI();
      this.renderManagerGrid();
    });

    this.elements.btnMgrTrashSelected.addEventListener('click', async () => {
      const count = this.managerService.selectedIds.size;
      if (count === 0) return;
      try {
        this.showSuccess(`Memindahkan ${count} item ke Recycle Bin...`, 1500);
        await this.managerService.trashSelected();
        this.showSuccess(`${count} item berhasil dipindahkan ke Recycle Bin.`);
        await this.loadManagerData();
      } catch (err) {
        this.showError('Gagal memindahkan ke trash: ' + err.message);
      }
    });

    this.elements.btnMgrRestoreSelected.addEventListener('click', async () => {
      const count = this.managerService.selectedIds.size;
      if (count === 0) return;
      try {
        this.showSuccess(`Merestore ${count} item ke dataset aktif...`, 1500);
        await this.managerService.restoreSelected();
        this.showSuccess(`${count} item berhasil di-restore ke dataset aktif.`);
        await this.loadManagerData();
      } catch (err) {
        this.showError('Gagal merestore: ' + err.message);
      }
    });

    this.elements.btnMgrPermanentDeleteSelected.addEventListener('click', async () => {
      const count = this.managerService.selectedIds.size;
      if (count === 0) return;
      if (!confirm(`Hapus permanen ${count} gambar dari disk? Tindakan ini tidak dapat dibatalkan.`)) return;
      try {
        this.showSuccess(`Menghapus permanen ${count} item dari disk...`, 1500);
        await this.managerService.deletePermanentSelected();
        this.showSuccess(`${count} item berhasil dihapus permanen dari disk.`);
        await this.loadManagerData();
      } catch (err) {
        this.showError('Gagal menghapus permanen: ' + err.message);
      }
    });

    this.elements.btnMgrImportFiles.addEventListener('click', () => this.elements.inputMgrImportFiles.click());
    this.elements.inputMgrImportFiles.addEventListener('change', async (e) => {
      if (!e.target.files || e.target.files.length === 0) return;
      try {
        const res = await this.managerService.importFileItems(e.target.files, 'object');
        this.showSuccess(`Berhasil mengimpor ${res.count} file ke dataset.`);
        this.loadManagerData();
        e.target.value = '';
      } catch (err) {
        this.showError('Gagal impor: ' + err.message);
      }
    });

    this.elements.btnMgrImportFolder.addEventListener('click', () => this.elements.inputMgrImportFolder.click());
    this.elements.inputMgrImportFolder.addEventListener('change', async (e) => {
      if (!e.target.files || e.target.files.length === 0) return;
      try {
        const res = await this.managerService.importFileItems(e.target.files, 'object');
        this.showSuccess(`Berhasil mengimpor ${res.count} file folder ke dataset.`);
        this.loadManagerData();
        e.target.value = '';
      } catch (err) {
        this.showError('Gagal impor folder: ' + err.message);
      }
    });

    // Preview Modal Events
    this.elements.mgrPreviewCloseBtn.addEventListener('click', () => this.elements.mgrPreviewModal.classList.add('hidden'));
    this.elements.mgrPreviewCloseFooterBtn.addEventListener('click', () => this.elements.mgrPreviewModal.classList.add('hidden'));

    // ========================================================================
    // MODULE 2 — IDENTITY LAB EVENT LISTENERS (V0.6)
    // ========================================================================
    this.elements.idLabThresholdSlider.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      this.identityService.threshold = val;
      this.elements.idLabThresholdVal.textContent = val.toFixed(2);
      if (this.elements.idLabThresholdMarker) {
        this.elements.idLabThresholdMarker.style.left = `${val * 100}%`;
      }
    });

    this.elements.btnIdLabImport.addEventListener('click', () => this.elements.inputIdLabImport.click());
    this.elements.inputIdLabImport.addEventListener('change', async (e) => {
      if (!e.target.files || e.target.files.length === 0) return;
      const files = Array.from(e.target.files);
      let successCount = 0;
      let lastErrMsg = '';
      for (const file of files) {
        try {
          const reader = new FileReader();
          const dataUrl = await new Promise((res, rej) => {
            reader.onload = () => res(reader.result);
            reader.onerror = rej;
            reader.readAsDataURL(file);
          });
          const res = await this.identityService.addReference(dataUrl, file.name);
          if (res && (res.success || res.saved || res.enrolled)) {
            successCount++;
          }
        } catch (err) {
          lastErrMsg = err.message || '';
          console.warn('[Identity Lab Import]', err);
        }
      }
      if (successCount > 0) {
        this.showSuccess(`Berhasil menambahkan ${successCount} foto referensi wajah.`);
      } else {
        this.showError(`Gagal menambahkan foto referensi: ${lastErrMsg || 'Periksa koneksi server atau format gambar.'}`);
      }
      await this.loadIdentityData();
      e.target.value = '';
    });

    this.elements.btnIdLabCaptureCam.addEventListener('click', async () => {
      if (this.cameraService.state.status !== 'connected') {
        try {
          await this.handleStartCamera();
          for (let i = 0; i < 20; i++) {
            if (this.elements.video && this.elements.video.readyState >= 2) break;
            await new Promise(r => setTimeout(r, 100));
          }
        } catch (camErr) {
          console.warn('[Identity Lab Camera Start]', camErr);
        }
      }
      if (this.cameraService.state.status !== 'connected' || !this.elements.video || this.elements.video.readyState < 2) {
        this.showError('Nyalakan kamera terlebih dahulu untuk mengambil foto wajah referensi.');
        return;
      }
      const video = this.elements.video;
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      this.faceOffscreenCanvas.width = vw;
      this.faceOffscreenCanvas.height = vh;
      this.faceOffscreenCtx.drawImage(video, 0, 0, vw, vh);
      const dataUrl = this.faceOffscreenCanvas.toDataURL('image/jpeg', 0.95);
      const filename = `developer_cam_${Date.now()}.jpg`;

      try {
        const res = await this.identityService.addReference(dataUrl, filename);
        if (res && (res.success || res.saved || res.enrolled)) {
          this.showSuccess(`Foto referensi webcam tersimpan: ${filename}`);
        } else {
          this.showError('Gagal menambahkan foto referensi: ' + (res?.error || 'Gagal menyimpan ke disk'));
        }
        await this.loadIdentityData();
      } catch (err) {
        this.showError('Gagal menambahkan foto referensi: ' + err.message);
      }
    });

    // Modals Shared
    this.elements.modalCloseBtn.addEventListener('click', () => this.closeConfirmModal());
    this.elements.modalCancelBtn.addEventListener('click', () => this.closeConfirmModal());
    this.elements.modalConfirmBtn.addEventListener('click', () => {
      if (this.pendingDeleteAction) this.pendingDeleteAction();
      this.closeConfirmModal();
    });

    this.elements.folderModalCloseBtn.addEventListener('click', () => this.closeFolderModal());
    this.elements.folderModalCancelBtn.addEventListener('click', () => this.closeFolderModal());
    this.elements.folderModalConfirmBtn.addEventListener('click', () => this.executeFolderImport());

    // Service Listeners
    this.cameraService.on('stateChange', (state) => this.handleCameraStateChange(state));
    this.cameraService.on('error', (err) => this.handleCameraError(err));
    this.cameraService.on('devicesChange', (devices) => this.populateDeviceSelect(devices));
    this.captureService.on('classChange', () => this.updateCollectionUI());
    this.captureService.on('countChange', () => this.updateCollectionUI());
    this.captureService.on('directoryChange', (dirInfo) => this.handleDirectoryChange(dirInfo));

    window.addEventListener('keydown', (e) => this.handleGlobalKeydown(e));
    this.initFoundationUI();
  }

  /**
   * Membuka Chat Assistant dari Home tanpa mengaktifkan kamera otomatis
   */
  openChatAssistant() {
    this.setMode('detection', { startCamera: false });
    if (this.contextualPanelManager) {
      this.contextualPanelManager.openTool('ask');
    }
    const askInput = document.getElementById('askVisionInput');
    if (askInput) {
      setTimeout(() => {
        askInput.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        askInput.focus();
      }, 80);
    }
    if (this.chatController) {
      this.chatController.focusInput();
    }
  }

  /**
   * Toggle off-canvas drawer sidebar untuk tampilan mobile
   */
  toggleMobileDrawer() {
    if (this.elements.appSidebar) {
      const isOpen = this.elements.appSidebar.classList.toggle('drawer-open');
      this.elements.appSidebar.classList.toggle('open', isOpen);
      if (this.elements.mobileDrawerBackdrop) {
        this.elements.mobileDrawerBackdrop.classList.toggle('active', isOpen);
        this.elements.mobileDrawerBackdrop.classList.toggle('hidden', !isOpen);
      }
    }
  }

  /**
   * Menutup off-canvas drawer sidebar untuk tampilan mobile
   */
  closeMobileDrawer() {
    if (this.elements.appSidebar) {
      this.elements.appSidebar.classList.remove('open');
      this.elements.appSidebar.classList.remove('drawer-open');
    }
    if (this.elements.mobileDrawerBackdrop) {
      this.elements.mobileDrawerBackdrop.classList.remove('active');
      this.elements.mobileDrawerBackdrop.classList.add('hidden');
    }
    // Focus restoration to hamburger button (Requirement)
    const hamburger = document.getElementById('btnMobileMenu') || this.elements.btnMobileMenuToggle;
    if (hamburger && typeof hamburger.focus === 'function') {
      hamburger.focus();
    }
  }

  /**
   * Mengatur visibilitas bilah kontrol kamera global sesuai mode aktif (V1.7 Phase B).
   * Pada mode 'manager' dan 'home', seluruh bilah kamera (.primary-hero-bar, .hero-camera-buttons,
   * .current-result-summary-bar, .secondary-controls-bar) disembunyikan.
   * Pada mode kamera ('detection', 'collection', 'identity', 'read_text'), bilah kamera dipulihkan.
   */
  syncModeUIBars(mode) {
    const isManager = (mode === 'manager');
    const isHome = (mode === 'home');
    const hideCameraBars = isManager || isHome;

    if (this.elements.primaryHeroBar) {
      this.elements.primaryHeroBar.classList.toggle('hidden', hideCameraBars);
    }
    if (this.elements.heroCameraButtons) {
      this.elements.heroCameraButtons.classList.toggle('hidden', hideCameraBars);
    }
    if (this.elements.currentResultSummaryBar) {
      this.elements.currentResultSummaryBar.classList.toggle('hidden', hideCameraBars);
    }
    if (this.elements.secondaryControlsBar) {
      this.elements.secondaryControlsBar.classList.toggle('hidden', hideCameraBars);
    }
  }

  /**
   * Mengganti Mode aplikasi: 'home' | 'detection' | 'collection' | 'manager' | 'identity' | 'read_text'
   * Milestone 6: Uses data-active-workspace attribute on #workspaceContainer for clean workspace switching.
   */
  setMode(mode, options = {}) {
    if (!['home', 'detection', 'collection', 'manager', 'identity', 'read_text'].includes(mode)) return;

    // Proteksi Rute & Navigasi: Collection, Dataset Manager, Identity Lab HANYA untuk role 'developer' (F5)
    if (['collection', 'manager', 'identity'].includes(mode) && !authService.isDeveloper()) {
      this.showDeveloperNotice(mode);
      return;
    }

    const prevMode = this.currentMode;
    this.currentMode = mode;

    if (this.navigationManager && this.navigationManager.getActiveMode() !== mode) {
      this.navigationManager.setActiveMode(mode, { triggerCallback: false });
    }

    // --- Milestone 6: Set workspace via data attribute (CSS handles all visibility) ---
    const workspaceContainer = document.getElementById('workspaceContainer');
    if (workspaceContainer) {
      workspaceContainer.setAttribute('data-active-workspace', mode);
    }

    // Reset tab styles
    [this.elements.btnNavHome, this.elements.btnModeDetect, this.elements.btnModeCollect, this.elements.btnModeManager, this.elements.btnModeIdentity, this.elements.btnModeReadText]
      .forEach(btn => {
        if (btn) {
          btn.classList.remove('active');
          btn.setAttribute('aria-selected', 'false');
        }
      });

    // Update sidebar navigation active states
    document.querySelectorAll('.sidebar-nav-item').forEach(item => {
      item.classList.remove('active');
      if (item.getAttribute('data-mode') === mode) {
        item.classList.add('active');
      }
    });

    // Close camera modal when switching modes
    if (this.cameraModal && this.cameraModal.isOpen) {
      this.cameraModal.close();
    }

    // Reset contextual panels when switching modes to prevent lingering panels
    if (this.contextualPanelManager && options.closeContextualPanels !== false) {
      this.contextualPanelManager.closeAll();
    }

    // Update header breadcrumb title
    const breadcrumbs = {
      home: 'Asisten AI',
      detection: 'Deteksi Objek',
      read_text: 'Pembaca Teks (OCR)',
      collection: 'Koleksi Dataset',
      manager: 'Dataset Manager',
      identity: 'Identity Lab'
    };
    if (this.elements.headerBreadcrumbTitle) {
      this.elements.headerBreadcrumbTitle.textContent = breadcrumbs[mode] || 'Asisten AI';
    }
    if (this.elements.mobileHeaderModeTitle) {
      this.elements.mobileHeaderModeTitle.textContent = breadcrumbs[mode] || 'Asisten AI';
    }
    if (this.elements.btnMobileNewChat) {
      const showMobileNewChat = mode === 'home';
      this.elements.btnMobileNewChat.classList.toggle('hidden', !showMobileNewChat);
      this.elements.btnMobileNewChat.setAttribute('aria-hidden', showMobileNewChat ? 'false' : 'true');
    }

    // --- Global Mode attribute on container & body for CSS scoping ---
    const appContainer = document.querySelector('.app-container');
    if (appContainer) {
      appContainer.setAttribute('data-mode', mode);
    }
    document.body.setAttribute('data-mode', mode);

    // --- Header badges visibility ---
    const isToolMode = mode !== 'home';
    if (this.elements.headerBadges) this.elements.headerBadges.classList.toggle('hidden', !isToolMode);

    // Mode badge update
    if (this.elements.modeBadge) {
      const modeClasses = {
        home: 'badge badge-mode-home',
        detection: 'badge badge-mode-detect',
        collection: 'badge badge-mode-collect',
        manager: 'badge badge-mode-manager',
        identity: 'badge badge-mode-identity',
        read_text: 'badge badge-mode-readtext'
      };
      this.elements.modeBadge.className = modeClasses[mode] || 'badge badge-mode-home';
      if (this.elements.modeStatusText) {
        this.elements.modeStatusText.textContent = breadcrumbs[mode] || 'Home';
      }
    }

    // --- Mode-specific logic ---
    if (mode === 'home') {
      this._cameraSessionId++;
      // Stop camera when going to Home/Chat
      if (this.cameraService && (this.cameraService.state.status === 'connected' || this.cameraService.state.status === 'connecting' || this.isStartingCamera)) {
        this.handleStopCamera();
      }

      if (this.elements.btnNavHome) {
        this.elements.btnNavHome.classList.add('active');
        this.elements.btnNavHome.setAttribute('aria-selected', 'true');
      }

      if (this.elements.homeView) this.elements.homeView.classList.remove('hidden');
      if (this.elements.stageCard) this.elements.stageCard.classList.add('hidden');
      if (this.elements.controlsCard) this.elements.controlsCard.classList.add('hidden');
      if (this.elements.detectionControls) this.elements.detectionControls.classList.add('hidden');
      if (this.elements.collectionControls) this.elements.collectionControls.classList.add('hidden');
      if (this.elements.managerControls) this.elements.managerControls.classList.add('hidden');
      if (this.elements.identityControls) this.elements.identityControls.classList.add('hidden');
      if (this.elements.readTextControls) this.elements.readTextControls.classList.add('hidden');
      this.syncModeUIBars('home');

      // Hide technical badges in Chat workspace
      if (this.elements.activeModelBadge) this.elements.activeModelBadge.classList.add('hidden');
      if (this.elements.inferenceBadge) this.elements.inferenceBadge.classList.add('hidden');
      if (this.elements.detectionCountBadge) this.elements.detectionCountBadge.classList.add('hidden');
      if (this.elements.classBadge) this.elements.classBadge.classList.add('hidden');
      if (this.elements.countBadge) this.elements.countBadge.classList.add('hidden');
      if (this.elements.ocrBadge) this.elements.ocrBadge.classList.add('hidden');
      return;
    }

    // --- Tool workspace modes ---
    if (mode === 'detection') {
      if (this.elements.btnModeDetect) {
        this.elements.btnModeDetect.classList.add('active');
        this.elements.btnModeDetect.setAttribute('aria-selected', 'true');
      }

      if (this.elements.homeView) this.elements.homeView.classList.add('hidden');
      if (this.elements.stageCard) this.elements.stageCard.classList.remove('hidden');
      if (this.elements.controlsCard) this.elements.controlsCard.classList.remove('hidden');
      if (this.elements.detectionControls) this.elements.detectionControls.classList.remove('hidden');
      if (this.elements.collectionControls) this.elements.collectionControls.classList.add('hidden');
      if (this.elements.managerControls) this.elements.managerControls.classList.add('hidden');
      if (this.elements.identityControls) this.elements.identityControls.classList.add('hidden');
      if (this.elements.readTextControls) this.elements.readTextControls.classList.add('hidden');
      if (this.isDebugVisible && this.elements.debugPanel) this.elements.debugPanel.classList.remove('hidden');
      this.syncModeUIBars('detection');

      this.elements.activeModelBadge.classList.remove('hidden');
      this.elements.inferenceBadge.classList.remove('hidden');
      this.elements.detectionCountBadge.classList.remove('hidden');
      this.elements.classBadge.classList.add('hidden');
      this.elements.countBadge.classList.add('hidden');

      if (this.elements.stageWatermark) {
        this.elements.stageWatermark.className = 'stage-watermark';
        this.elements.watermarkMode.textContent = 'DETECTION';
        this.elements.watermarkExtra.textContent = '';
      }

      this.updateCameraToggleButtonVisibility();

      // Lazy camera start
      if (options.startCamera !== false) {
        if (this.cameraService && this.cameraService.state.status !== 'connected' && this.cameraService.state.status !== 'connecting') {
          this.handleStartCamera();
        }
      }
    } else if (mode === 'collection') {
      if (this.elements.btnModeCollect) {
        this.elements.btnModeCollect.classList.add('active');
        this.elements.btnModeCollect.setAttribute('aria-selected', 'true');
      }

      if (this.elements.homeView) this.elements.homeView.classList.add('hidden');
      if (this.elements.stageCard) this.elements.stageCard.classList.remove('hidden');
      if (this.elements.controlsCard) this.elements.controlsCard.classList.remove('hidden');
      if (this.elements.collectionControls) this.elements.collectionControls.classList.remove('hidden');
      if (this.elements.detectionControls) this.elements.detectionControls.classList.add('hidden');
      if (this.elements.managerControls) this.elements.managerControls.classList.add('hidden');
      if (this.elements.identityControls) this.elements.identityControls.classList.add('hidden');
      if (this.elements.readTextControls) this.elements.readTextControls.classList.add('hidden');
      this.syncModeUIBars('collection');

      this.elements.activeModelBadge.classList.add('hidden');
      this.elements.inferenceBadge.classList.add('hidden');
      this.elements.detectionCountBadge.classList.add('hidden');
      this.elements.classBadge.classList.remove('hidden');
      this.elements.countBadge.classList.remove('hidden');

      if (this.renderer) this.renderer.clear();

      if (this.elements.stageWatermark) {
        this.elements.stageWatermark.className = 'stage-watermark collect-mode';
        this.elements.watermarkMode.textContent = 'COLLECTION';
        this.elements.watermarkExtra.textContent = `[${this.captureService.currentClass}]`;
      }
      this.updateCollectionUI();

      // Lazy camera start
      if (options.startCamera !== false) {
        if (this.cameraService && this.cameraService.state.status !== 'connected' && this.cameraService.state.status !== 'connecting') {
          this.handleStartCamera();
        }
      }
    } else if (mode === 'manager') {
      this._cameraSessionId++;

      if (this.cameraService && (this.cameraService.state.status === 'connected' || this.cameraService.state.status === 'connecting' || this.isStartingCamera)) {
        this.handleStopCamera();
      }

      this.elements.btnModeManager.classList.add('active');
      this.elements.btnModeManager.setAttribute('aria-selected', 'true');

      if (this.elements.homeView) this.elements.homeView.classList.add('hidden');
      if (this.elements.stageCard) this.elements.stageCard.classList.add('hidden');
      if (this.elements.controlsCard) this.elements.controlsCard.classList.remove('hidden');
      if (this.elements.managerControls) this.elements.managerControls.classList.remove('hidden');
      if (this.elements.detectionControls) this.elements.detectionControls.classList.add('hidden');
      if (this.elements.collectionControls) this.elements.collectionControls.classList.add('hidden');
      if (this.elements.identityControls) this.elements.identityControls.classList.add('hidden');
      if (this.elements.readTextControls) this.elements.readTextControls.classList.add('hidden');
      this.syncModeUIBars('manager');

      this.elements.activeModelBadge.classList.add('hidden');
      this.elements.inferenceBadge.classList.add('hidden');
      this.elements.detectionCountBadge.classList.add('hidden');
      this.elements.classBadge.classList.add('hidden');
      this.elements.countBadge.classList.add('hidden');

      if (this.renderer) this.renderer.clear();
      this.loadManagerData();
    } else if (mode === 'identity') {
      this.elements.btnModeIdentity.classList.add('active');
      this.elements.btnModeIdentity.setAttribute('aria-selected', 'true');

      if (this.elements.homeView) this.elements.homeView.classList.add('hidden');
      if (this.elements.stageCard) this.elements.stageCard.classList.remove('hidden');
      if (this.elements.controlsCard) this.elements.controlsCard.classList.remove('hidden');
      if (this.elements.identityControls) this.elements.identityControls.classList.remove('hidden');
      if (this.elements.detectionControls) this.elements.detectionControls.classList.add('hidden');
      if (this.elements.collectionControls) this.elements.collectionControls.classList.add('hidden');
      if (this.elements.managerControls) this.elements.managerControls.classList.add('hidden');
      if (this.elements.readTextControls) this.elements.readTextControls.classList.add('hidden');
      this.syncModeUIBars('identity');

      this.elements.activeModelBadge.classList.add('hidden');
      this.elements.inferenceBadge.classList.add('hidden');
      this.elements.detectionCountBadge.classList.add('hidden');
      this.elements.classBadge.classList.add('hidden');
      this.elements.countBadge.classList.add('hidden');

      if (this.renderer) this.renderer.clear();

      if (this.elements.stageWatermark) {
        this.elements.stageWatermark.className = 'stage-watermark';
        this.elements.watermarkMode.textContent = 'IDENTITY';
        this.elements.watermarkExtra.textContent = '[VisionX Developer]';
      }
      this.loadIdentityData();
    } else if (mode === 'read_text') {
      if (this.elements.btnModeReadText) {
        this.elements.btnModeReadText.classList.add('active');
        this.elements.btnModeReadText.setAttribute('aria-selected', 'true');
      }

      if (this.elements.homeView) this.elements.homeView.classList.add('hidden');
      if (this.elements.stageCard) this.elements.stageCard.classList.remove('hidden');
      if (this.elements.controlsCard) this.elements.controlsCard.classList.remove('hidden');
      if (this.elements.readTextControls) this.elements.readTextControls.classList.remove('hidden');
      if (this.elements.detectionControls) this.elements.detectionControls.classList.add('hidden');
      if (this.elements.collectionControls) this.elements.collectionControls.classList.add('hidden');
      if (this.elements.managerControls) this.elements.managerControls.classList.add('hidden');
      if (this.elements.identityControls) this.elements.identityControls.classList.add('hidden');
      this.syncModeUIBars('read_text');

      this.elements.activeModelBadge.classList.remove('hidden');
      this.elements.inferenceBadge.classList.remove('hidden');
      this.elements.detectionCountBadge.classList.remove('hidden');
      this.elements.classBadge.classList.add('hidden');
      this.elements.countBadge.classList.add('hidden');
      if (this.elements.ocrBadge) this.elements.ocrBadge.classList.remove('hidden');

      if (this.elements.stageWatermark) {
        this.elements.stageWatermark.className = 'stage-watermark';
        this.elements.watermarkMode.textContent = 'READ TEXT';
        this.elements.watermarkExtra.textContent = '[OCR & TTS]';
      }

      this.updateCameraToggleButtonVisibility();

      // Lazy camera start
      if (options.startCamera !== false) {
        if (this.cameraService && this.cameraService.state.status !== 'connected' && this.cameraService.state.status !== 'connecting') {
          this.handleStartCamera();
        }
      }
    }

    // Update foundation UI elements (slider fill, camera buttons)
    this.updateAllSliders();
    this.updateCameraDependentButtons(this.cameraService?.state?.status === 'connected');
  }

  // ==========================================================================
  // MODULE 1 — DATASET MANAGER RENDERING & ACTIONS (V0.6)
  // ==========================================================================
  async loadManagerData() {
    const container = this.elements.mgrGridContainer;
    if (container) {
      container.innerHTML = `
        <div class="empty-gallery-text" style="grid-column: 1/-1; padding: 36px 16px;">
          <div class="spinner-small" style="margin: 0 auto 10px auto;"></div>
          Memuat dataset dari disk...
        </div>
      `;
    }

    try {
      try {
        const stats = await this.managerService.fetchStats();
        if (stats) {
          if (this.elements.mgrStatTotalImages) this.elements.mgrStatTotalImages.textContent = stats.totalImages || 0;
          if (this.elements.mgrStatTotalSize) this.elements.mgrStatTotalSize.textContent = stats.formattedTotalSize || '0 MB';
          if (this.elements.mgrStatTotalClasses) this.elements.mgrStatTotalClasses.textContent = stats.classesCount || 0;
          if (this.elements.mgrStatTrashCount) this.elements.mgrStatTrashCount.textContent = stats.trashCount || 0;
          if (this.elements.mgrTrashBadgeCount) this.elements.mgrTrashBadgeCount.textContent = stats.trashCount || 0;

          // Populate class filter dropdown
          const selClass = this.elements.mgrSelectClass;
          if (selClass) {
            const currentVal = selClass.value;
            let opts = '<option value="all">Semua Kelas</option>';
            Object.keys(stats.classCounts || {}).forEach(cls => {
              opts += `<option value="${cls}">${cls} (${stats.classCounts[cls]})</option>`;
            });
            selClass.innerHTML = opts;
            if (currentVal) selClass.value = currentVal;
          }
        }
      } catch (statsErr) {
        console.warn('[VisionX] Warning: stats fetch failed, continuing to fetch list:', statsErr);
      }

      await this.managerService.fetchList();

      if (this.elements.mgrStatTrashCount && this.managerService.stats.trashCount !== undefined) {
        this.elements.mgrStatTrashCount.textContent = this.managerService.stats.trashCount;
      }
      if (this.elements.mgrTrashBadgeCount && this.managerService.stats.trashCount !== undefined) {
        this.elements.mgrTrashBadgeCount.textContent = this.managerService.stats.trashCount;
      }
      if (this.elements.mgrStatTotalImages && this.managerService.stats.totalImages !== undefined) {
        this.elements.mgrStatTotalImages.textContent = this.managerService.stats.totalImages;
      }

      this.renderManagerGrid();
      this.updateManagerSelectionUI();
    } catch (e) {
      console.error('[VisionX] Gagal memuat data manager:', e);
      this.renderManagerError(e);
    }
  }

  renderManagerError(err) {
    const container = this.elements.mgrGridContainer;
    if (!container) return;
    const isTimeout = err?.name === 'TimeoutError' || err?.message?.toLowerCase().includes('timeout');
    const msg = isTimeout 
      ? 'Koneksi ke backend dataset timeout (waktu habis).' 
      : (err?.message || 'Gagal memuat dataset dari disk.');

    container.innerHTML = `
      <div class="manager-error-state" style="grid-column: 1/-1;">
        <svg class="error-icon" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#DC2626" stroke-width="2">
          <circle cx="12" cy="12" r="10"></circle>
          <line x1="12" y1="8" x2="12" y2="12"></line>
          <line x1="12" y1="16" x2="12.01" y2="16"></line>
        </svg>
        <h4 class="error-title">Gagal Memuat Dataset dari Disk</h4>
        <p class="error-desc">${msg}</p>
        <button type="button" id="btnMgrRetryFetch" class="btn btn-sm btn-outline">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="23 4 23 10 17 10"></polyline>
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>
          </svg>
          Coba Lagi
        </button>
      </div>
    `;

    const retryBtn = container.querySelector('#btnMgrRetryFetch');
    if (retryBtn) {
      retryBtn.addEventListener('click', () => this.loadManagerData());
    }
  }

  updateManagerSelectionUI() {
    const count = this.managerService.selectedIds.size;
    this.elements.mgrSelectedCountTrash.textContent = count;
    this.elements.mgrSelectedCountRestore.textContent = count;
    this.elements.mgrSelectedCountPerm.textContent = count;

    this.elements.btnMgrTrashSelected.disabled = count === 0;
    this.elements.btnMgrRestoreSelected.disabled = count === 0;
    this.elements.btnMgrPermanentDeleteSelected.disabled = count === 0;
  }

  renderManagerGrid() {
    const container = this.elements.mgrGridContainer;
    const items = this.managerService.items;

    if (!items || items.length === 0) {
      const isTrash = this.managerService.currentView === 'trash';
      container.innerHTML = `
        <div class="manager-empty-state" style="grid-column: 1/-1;">
          <svg class="empty-icon" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
            <line x1="12" y1="11" x2="12" y2="17"></line>
            <line x1="9" y1="14" x2="15" y2="14"></line>
          </svg>
          <h4 class="empty-title">${isTrash ? 'Recycle Bin Kosong' : 'Belum Ada Dataset'}</h4>
          <p class="empty-desc">
            ${isTrash 
              ? 'Tidak ada item yang telah di-soft delete di Recycle Bin.' 
              : 'Belum ada dataset gambar pada disk. Impor foto dari komputer atau gunakan kamera di Collection Mode untuk memulai.'}
          </p>
          ${!isTrash ? `
            <div class="empty-actions">
              <button type="button" id="btnEmptyImportFiles" class="btn btn-sm btn-primary">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                  <polyline points="17 8 12 3 7 8"></polyline>
                  <line x1="12" y1="3" x2="12" y2="15"></line>
                </svg>
                Import File
              </button>
              <button type="button" id="btnEmptyImportFolder" class="btn btn-sm btn-secondary">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
                </svg>
                Import Folder
              </button>
            </div>
          ` : ''}
        </div>
      `;

      if (!isTrash) {
        const btnFiles = container.querySelector('#btnEmptyImportFiles');
        const btnFolder = container.querySelector('#btnEmptyImportFolder');
        if (btnFiles && this.elements.inputMgrImportFiles) {
          btnFiles.addEventListener('click', () => this.elements.inputMgrImportFiles.click());
        }
        if (btnFolder && this.elements.inputMgrImportFolder) {
          btnFolder.addEventListener('click', () => this.elements.inputMgrImportFolder.click());
        }
      }
      return;
    }

    // Pastikan container memiliki layout grid modern 2 kolom di mobile dan 4 kolom di desktop
    container.className = 'manager-grid-container grid grid-cols-2 md:grid-cols-4 gap-4';

    let html = '';
    items.forEach(it => {
      const isSelected = this.managerService.selectedIds.has(it.id);
      const selClass = isSelected ? 'selected' : '';
      const isTrash = it.isTrash;

      html += `
        <div class="manager-card relative bg-slate-900 border border-slate-800 rounded-xl overflow-hidden group hover:border-cyan-500/50 transition flex flex-col ${selClass}" data-id="${it.id}">
          <!-- Thumbnail Wrapper (Atas): Rasio 16:9 ('h-40 w-full bg-slate-950 overflow-hidden relative') -->
          <div class="manager-card-thumb-wrapper h-40 w-full bg-slate-950 overflow-hidden relative cursor-pointer" data-action="preview" data-id="${it.id}">
            <img src="${it.url}" alt="${it.filename}" class="manager-card-thumb w-full h-full object-cover" loading="lazy" onerror="this.onerror=null;this.parentElement.classList.add('img-broken');" />
            <div class="card-thumb-gradient"></div>

            <!-- Checkbox: melayang di pojok kiri atas thumbnail dengan background pelindung -->
            <div class="absolute top-2 left-2 z-10">
              <label class="card-checkbox-label flex items-center justify-center p-1 rounded-md bg-slate-950/80 backdrop-blur border border-slate-700/60 cursor-pointer shadow-sm hover:border-cyan-400" title="Pilih item">
                <input type="checkbox" class="manager-card-checkbox accent-cyan-400 w-4 h-4 rounded cursor-pointer" data-id="${it.id}" ${isSelected ? 'checked' : ''} />
              </label>
            </div>

            <!-- Badge Ukuran File: melayang di pojok kanan atas thumbnail -->
            <div class="absolute top-2 right-2 bg-slate-950/80 backdrop-blur px-2 py-0.5 rounded text-[10px] text-slate-300 font-mono border border-slate-800/80 shadow-sm z-10 pointer-events-none">
              ${it.formattedSize}
            </div>

            <!-- Badge Kategori Kelas: melayang di pojok kiri bawah thumbnail -->
            <div class="absolute bottom-2 left-2 z-10 pointer-events-none">
              <span class="px-1.5 py-0.5 rounded bg-cyan-950/80 border border-cyan-800/60 text-[10px] text-cyan-300 font-medium">
                ${it.className}
              </span>
            </div>
          </div>

          <!-- Metadata & Footer (Bawah): Padding 'p-3 flex flex-col gap-1.5' -->
          <div class="manager-card-body p-3 flex flex-col gap-1.5 flex-1 justify-between">
            <div>
              <span class="manager-card-filename dataset-item-name truncate text-xs font-medium text-slate-200 block" title="${it.filename}">
                ${it.filename}
              </span>
              <div class="manager-card-meta flex items-center justify-between text-[11px] text-slate-400 mt-1">
                <span>${it.source === 'own_capture' ? '📸 Kamera' : '💾 Impor'}</span>
                <span class="font-mono text-[10px]">${it.timestamp || ''}</span>
              </div>
            </div>

            <!-- Action Buttons Row: Tombol 'Trash' dan 'Detail' diletakkan rapi di baris paling bawah -->
            <div class="manager-card-actions flex items-center gap-2 mt-2 pt-2 border-t border-slate-800/80">
              <button type="button" class="btn-card-action btn-card-detail flex-1 py-1 px-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white text-xs font-medium transition text-center" data-action="preview" data-id="${it.id}" title="Detail metadata">
                Detail
              </button>
              ${!isTrash ? `
                <button type="button" class="btn-card-action btn-card-trash flex-1 py-1 px-2 rounded-lg bg-red-950/40 hover:bg-red-900/60 border border-red-800/40 hover:border-red-700 text-red-400 hover:text-red-300 text-xs font-medium transition flex items-center justify-center gap-1" data-action="trash" data-id="${it.id}" data-filename="${it.filename}" title="Pindah ke Recycle Bin">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="3 6 5 6 21 6"></polyline>
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                  </svg>
                  <span>Trash</span>
                </button>
              ` : `
                <button type="button" class="btn-card-action btn-card-restore flex-1 py-1 px-2 rounded-lg bg-emerald-950/40 hover:bg-emerald-900/60 border border-emerald-800/40 hover:border-emerald-700 text-emerald-400 hover:text-emerald-300 text-xs font-medium transition flex items-center justify-center gap-1" data-action="restore" data-id="${it.id}" data-filename="${it.filename}" title="Restore ke dataset">
                  Restore
                </button>
                <button type="button" class="btn-card-action btn-card-perm flex-1 py-1 px-2 rounded-lg bg-red-950/60 hover:bg-red-900/80 border border-red-800/60 hover:border-red-600 text-red-400 hover:text-red-200 text-xs font-medium transition flex items-center justify-center gap-1" data-action="perm-delete" data-id="${it.id}" data-filename="${it.filename}" title="Hapus Permanen">
                  Hapus
                </button>
              `}
            </div>
          </div>
        </div>
      `;
    });

    container.innerHTML = html;

    // Attach click listeners to cards
    container.querySelectorAll('.manager-card-checkbox').forEach(cb => {
      cb.addEventListener('change', (e) => {
        const id = e.target.dataset.id;
        this.managerService.toggleSelect(id);
        this.updateManagerSelectionUI();
        const card = container.querySelector(`.manager-card[data-id="${id}"]`);
        if (card) card.classList.toggle('selected', e.target.checked);
      });
    });

    container.querySelectorAll('[data-action="preview"]').forEach(el => {
      el.addEventListener('click', (e) => {
        if (e.target.closest('.manager-card-checkbox') || e.target.closest('.card-checkbox-label')) return;
        const id = el.dataset.id;
        const item = this.managerService.items.find(i => i.id === id);
        if (item) this.openManagerPreview(item);
      });
    });

    container.querySelectorAll('[data-action="trash"]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        const item = this.managerService.items.find(i => i.id === id);
        const fname = btn.dataset.filename || item?.filename || id;
        try {
          this.showSuccess('Memindahkan ke Recycle Bin...', 1000);
          await this.managerService.trashSelected([item || { filename: fname, id }]);
          this.showSuccess(`"${fname}" dipindahkan ke Recycle Bin.`);
          await this.loadManagerData();
        } catch (err) {
          this.showError('Gagal memindahkan ke trash: ' + err.message);
        }
      });
    });

    container.querySelectorAll('[data-action="restore"]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        const item = this.managerService.items.find(i => i.id === id);
        const fname = btn.dataset.filename || item?.filename || id;
        try {
          this.showSuccess('Merestore gambar...', 1000);
          await this.managerService.restoreSelected([item || { filename: fname, trashFilename: fname, id }]);
          this.showSuccess(`"${fname}" berhasil di-restore.`);
          await this.loadManagerData();
        } catch (err) {
          this.showError('Gagal merestore gambar: ' + err.message);
        }
      });
    });

    container.querySelectorAll('[data-action="perm-delete"]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        const item = this.managerService.items.find(i => i.id === id);
        const fname = btn.dataset.filename || item?.filename || id;
        if (!confirm(`Hapus permanen "${fname}" dari disk? Tindakan ini tidak dapat dibatalkan.`)) return;
        try {
          this.showSuccess('Menghapus permanen...', 1000);
          await this.managerService.deletePermanentSelected([item || { filename: fname, trashFilename: fname, id }]);
          this.showSuccess(`"${fname}" berhasil dihapus permanen.`);
          await this.loadManagerData();
        } catch (err) {
          this.showError('Gagal menghapus permanen: ' + err.message);
        }
      });
    });
  }

  openManagerPreview(item) {
    this.elements.mgrPreviewImg.src = item.url;
    this.elements.mgrMetaFilename.textContent = item.filename;
    this.elements.mgrMetaClass.textContent = item.className;
    this.elements.mgrMetaSource.textContent = item.source;
    this.elements.mgrMetaDimensions.textContent = item.resolution || '-';
    this.elements.mgrMetaSize.textContent = item.formattedSize || '-';
    this.elements.mgrMetaDate.textContent = item.timestamp || '-';
    this.elements.mgrMetaStatus.textContent = item.isTrash ? 'In Recycle Bin' : 'Active Dataset';
    this.elements.mgrMetaPath.textContent = item.url;
    this.elements.mgrPreviewModal.classList.remove('hidden');
  }

  // ==========================================================================
  // MODULE 2 — IDENTITY LAB RENDERING & ACTIONS (V0.6)
  // ==========================================================================
  async loadIdentityData() {
    try {
      const profile = await this.identityService.getProfile();
      if (profile) {
        this.elements.idLabProfileName.textContent = profile.profile_name || 'VisionX Developer';
        this.elements.idLabRefCount.textContent = `${profile.reference_count} foto`;
        this.elements.idLabGalleryCount.textContent = profile.reference_count;
        this.elements.idLabThresholdVal.textContent = parseFloat(profile.threshold).toFixed(2);
        this.elements.idLabThresholdSlider.value = profile.threshold;
        if (this.elements.idLabThresholdMarker) {
          this.elements.idLabThresholdMarker.style.left = `${profile.threshold * 100}%`;
        }

        const statusEl = document.getElementById('idLabStatusDisplay');
        if (statusEl) {
          const count = profile.reference_count || 0;
          if (count === 0) {
            statusEl.textContent = 'Belum terdaftar';
            statusEl.className = 'text-muted';
          } else {
            statusEl.textContent = 'Active Matching';
            statusEl.className = 'text-success';
          }
        }
      }

      const refs = await this.identityService.getReferences();
      this.renderIdentityRefGallery(refs);
    } catch (e) {
      console.error('[VisionX] Gagal memuat data Identity Lab:', e);
    }
  }

  renderIdentityRefGallery(refs = []) {
    const container = this.elements.idLabRefGallery;
    if (!refs || refs.length === 0) {
      container.innerHTML = `<div class="empty-gallery-text" style="grid-column: 1/-1;">Belum ada foto referensi wajah terdaftar.</div>`;
      return;
    }

    let html = '';
    refs.forEach(r => {
      html += `
        <div class="id-ref-card" data-filename="${r.filename}">
          <button type="button" class="btn-delete-ref" data-filename="${r.filename}" title="Hapus foto referensi ini">
            &times;
          </button>
          <img src="${r.url}" alt="${r.filename}" class="id-ref-thumb" loading="lazy" />
          <div class="id-ref-meta">
            <span title="${r.filename}">${r.filename}</span>
            <span>${r.formatted_size}</span>
          </div>
        </div>
      `;
    });
    container.innerHTML = html;

    container.querySelectorAll('.btn-delete-ref').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const fn = btn.dataset.filename;
        if (confirm(`Hapus foto referensi "${fn}" dari profil pengembang?`)) {
          try {
            await this.identityService.deleteReference(fn);
            this.showSuccess(`Foto referensi "${fn}" berhasil dihapus.`);
            this.loadIdentityData();
          } catch (err) {
            this.showError('Gagal menghapus: ' + err.message);
          }
        }
      });
    });
  }

  // ==========================================================================
  // REALTIME RENDER LOOP & DETECTION / FACE INFERENCE
  // ==========================================================================
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
    if (!this.frameSource || !this.frameSource.isReady()) return;
    const video = this.elements.video;

    const currTime = performance.now();
    const delta = (currTime - this.prevTime) / 1000;
    this.prevTime = currTime;

    if (delta > 0) {
      const currentFps = 1.0 / delta;
      this.fpsSmooth = this.fpsSmooth === 0 ? currentFps : (this.alphaFps * this.fpsSmooth + (1 - this.alphaFps) * currentFps);
      this.elements.fpsValue.textContent = this.fpsSmooth.toFixed(1);
    }

    const dims = this.frameSource.getDimensions();
    const vw = dims.width;
    const vh = dims.height;
    if (vw > 0 && vh > 0) {
      this.renderer.resize(vw, vh);
    }

    if (this.currentMode === 'detection' || this.currentMode === 'read_text') {
      const letterboxedFrame = this.frameSource.getLetterboxedFrame(640);
      if (!letterboxedFrame) return;

      let objectDetections = [];
      let yoloResult = null;

      // 1. YOLO Object Detection (Realtime rate)
      if (this.inferenceService.isActive && !this.isProcessingFrame) {
        this.isProcessingFrame = true;
        try {
          yoloResult = await this.inferenceService.detect(video, this.frameSource.isMirrored);
          if (yoloResult && Array.isArray(yoloResult.detections)) {
            objectDetections = yoloResult.detections;
            this.lastDetections = objectDetections;
          } else {
            this.lastDetections = [];
          }
        } catch (yoloErr) {
          console.warn('[VisionX] YOLO Inference error:', yoloErr.message);
          this.lastDetections = [];
        } finally {
          this.isProcessingFrame = false;
        }
      } else if (!this.inferenceService.isActive) {
        this.lastDetections = [];
      }

      const activeFrameId = yoloResult?.frameId || ++this.currentFrameId;

      // 1.5. TrackingEngine (V0.7): Persistent Track IDs & Velocity
      let trackedObjects = objectDetections;
      let trackingOutput = null;
      const isTrackingActive = this.elements.toggleTracking ? this.elements.toggleTracking.checked : true;
      this.trackingEngine.isEnabled = isTrackingActive;

      if (isTrackingActive && this.inferenceService.isActive) {
        // Hanya update tracker saat ada siklus inferensi aktual yang selesai
        if (yoloResult !== null) {
          trackingOutput = this.trackingEngine.update(objectDetections, activeFrameId);
          this.lastTrackingOutput = trackingOutput;
        } else if (this.lastTrackingOutput) {
          trackingOutput = this.lastTrackingOutput;
        } else {
          trackingOutput = this.trackingEngine.update([], activeFrameId);
          this.lastTrackingOutput = trackingOutput;
        }
        trackedObjects = trackingOutput.visibleTracks;

        // 1.55. Personalized Recognition (V1.2): Non-blocking & Throttled Visual Similarity
        try {
          if (this.personalObjectRecognizer && trackingOutput) {
            const tracksToProcess = trackingOutput.allTracks || trackingOutput.activeTracks || trackingOutput.visibleTracks;
            this.personalObjectRecognizer.processTracks(tracksToProcess, video || this.elements.canvas);
          }
        } catch (poErr) {
          console.warn('[VisionX] Personal recognition error:', poErr);
        }

        // 1.6. Voice Assistant Engine (V0.8): Spoken accessibility feedback
        try {
          if (this.eventEngine && this.voiceEngine && this.voiceEngine.config.enabled) {
            this.eventEngine.processTracks(trackingOutput.allTracks || trackingOutput.activeTracks);
          }
        } catch (voiceErr) {
          console.warn('[VisionX] Voice event processing error:', voiceErr);
        }

        // 1.7. Object Memory Engine (V1.1): Temporal & Spatial Tracking Lifecycle
        try {
          if (this.objectMemory) {
            this.objectMemory.update(trackingOutput.allTracks || trackingOutput.activeTracks, {
              frameWidth: vw,
              frameHeight: vh
            });
            this.updateObjectMemoryUI();
          }
        } catch (memErr) {
          console.warn('[VisionX] Object memory update error:', memErr);
        }

        // 1.8. Safety Engine (V1.3): Spatio-Temporal Safety Rule Evaluation
        try {
          if (this.safetyEngine) {
            this.safetyEngine.evaluate({
              activeTracks: trackingOutput.allTracks || trackingOutput.activeTracks || [],
              memoryEvents: this.objectMemory ? this.objectMemory.getRecentEvents() : [],
              personalRecognizer: this.personalObjectRecognizer,
              timestamp: Date.now()
            });
          }
        } catch (safetyErr) {
          console.warn('[VisionX] SafetyEngine evaluation error:', safetyErr);
        }
      }

      // 2. Face Detection & Recognition (Decoupled & Non-blocking)
      let faceDetections = [];
      let identityResult = null;
      const isFaceLayerActive = this.elements.toggleFaceRecognition ? this.elements.toggleFaceRecognition.checked : true;

      if (isFaceLayerActive) {
        try {
          this.faceDetector.setEnabled(true);
          this.faceRecognizer.setEnabled(true);

          // Face Detection runs at realtime rate
          faceDetections = await this.faceDetector.detect(letterboxedFrame);

          // Face Recognition runs at lower rate, reusing latest identity
          identityResult = await this.faceRecognizer.recognize(faceDetections, letterboxedFrame);
          if (identityResult) {
            this.lastIdentityState = identityResult;
          }
        } catch (faceErr) {
          console.warn('[VisionX] Face engine error:', faceErr.message);
        }
      } else {
        this.faceDetector.setEnabled(false);
        this.faceRecognizer.setEnabled(false);
      }

      // 3. DetectionFusion: Combine Tracked Objects + Face Detections
      const unifiedDetections = DetectionFusion.fuse(
        trackedObjects,
        faceDetections,
        identityResult || this.faceRecognizer.getLatestIdentity(),
        {
          enableObjects: this.inferenceService.isActive,
          enableFace: isFaceLayerActive
        }
      );

      // 4. UnifiedRenderer: Render to Canvas with OCR Text Regions Overlay
      const activeInferenceLatency = yoloResult?.inferenceTimeMs || this.faceDetector.lastLatencyMs || 0;

      this.renderer.renderUnified(unifiedDetections, {
        frameId: activeFrameId,
        inferenceTimeMs: activeInferenceLatency,
        modelName: this.inferenceService.modelConfig.shortName
      }, this.currentOcrRegions, this.frameSource?.isMirrored);

      // 5. Update UI, Counters, & Live Diagnostics
      this.elements.detectionCountValue.textContent = unifiedDetections.length;
      if (this.elements.trackedCountValue && trackingOutput) {
        this.elements.trackedCountValue.textContent = trackingOutput.stats.totalActiveCount;
      }
      this.highlightDetectedChips(unifiedDetections);
      this.updateDiagnosticsUI(trackingOutput);

      // 5.5 Update Camera Quality Strip (V1.2.1)
      if (this.elements.camDiagResolution) {
        this.elements.camDiagResolution.textContent = `${vw}×${vh}`;
      }
      if (this.elements.camDiagFps) {
        this.elements.camDiagFps.textContent = this.fpsSmooth.toFixed(1);
      }

      if (this.isDebugVisible) {
        this.updateDebugTable(unifiedDetections, activeFrameId, activeInferenceLatency);
      }

      // 6. Read Text Mode Auto Read Background Loop (Non-blocking)
      if (this.currentMode === 'read_text' && this.isAutoReadOcr) {
        const now = performance.now();
        if (now - this.lastAutoReadScanTime > this.autoReadCooldownMs && this.ocrService.getStatus() === OCRStatus.READY) {
          this.lastAutoReadScanTime = now;
          this.handleTriggerOcr(true); // Background auto scan
        }
      }
    } else if (this.currentMode === 'identity') {
      // Live test di Identity Lab studio (management tab)
      await this.processIdentityLabLiveTest(video, vw, vh);
    } else {
      this.renderer.clear();
    }
  }


  async processIdentityLabLiveTest(video, vw, vh) {
    // 1. Dapatkan letterboxed frame standar (640x640)
    const letterboxedFrame = this.frameSource ? this.frameSource.getLetterboxedFrame(640) : null;
    if (!letterboxedFrame) {
      if (this.renderer) this.renderer.clear();
      return;
    }

    // 2. Render deteksi wajah aktif pada canvas setiap frame untuk mencegah kedipan visual (smooth 60fps)
    if (this.currentIdentityFaces && this.currentIdentityFaces.length > 0) {
      this.renderer.renderUnified(this.currentIdentityFaces, null, [], this.frameSource?.isMirrored);
    } else {
      this.renderer.clear();
    }

    // 3. Throttle background request agar tidak membebani server/inferensi
    const now = performance.now();
    if (now - this.lastFaceCheckTime < 180 || this.isProcessingFace) return;
    this.isProcessingFace = true;
    this.lastFaceCheckTime = now;

    try {
      const { canvas, params, isMirrored } = letterboxedFrame;
      const dataUrl = canvas.toDataURL('image/jpeg', 0.80);

      const res = await this.identityService.matchFace(dataUrl, this.identityService.threshold);
      if (res && res.detected && Array.isArray(res.faces) && res.faces.length > 0) {
        const pm = res.primary_match || res.faces[0];
        const isMatch = Boolean(pm.matched);
        const simPercent = Math.max(0, Math.min(100, (pm.similarity || 0) * 100));

        // Update Panel UI Identity Lab
        if (this.elements.idLabDecisionBadge) {
          this.elements.idLabDecisionBadge.textContent = isMatch ? 'Person — Developer VisionX' : 'Person';
          this.elements.idLabDecisionBadge.className = `identity-badge ${isMatch ? 'badge-developer' : 'badge-unknown'}`;
        }
        if (this.elements.idLabSimilarityScore) {
          this.elements.idLabSimilarityScore.textContent = `${simPercent.toFixed(1)}%`;
        }
        if (this.elements.idLabSimilarityBar) {
          this.elements.idLabSimilarityBar.style.width = `${simPercent}%`;
          this.elements.idLabSimilarityBar.style.background = isMatch
            ? 'linear-gradient(90deg, #10b981, #059669)'
            : 'linear-gradient(90deg, #f59e0b, #d97706)';
        }
        if (this.elements.idLabMatchDetail) {
          const threshPercent = (this.identityService.threshold * 100).toFixed(0);
          this.elements.idLabMatchDetail.textContent = isMatch
            ? `MATCH TERVERIFIKASI: Skor ${simPercent.toFixed(1)}% ≥ Threshold (${threshPercent}%) • Developer VisionX`
            : `TIDAK COCOK: Skor ${simPercent.toFixed(1)}% < Threshold (${threshPercent}%) • Ditandai Person`;
        }

        // 4. Transformasi koordinat model 640x640 ke resolusi video asli via CoordinateMapper
        const mappedFaces = res.faces.map((f, idx) => {
          const rawBox = f.bbox || {
            x1: f.box[0],
            y1: f.box[1],
            x2: f.box[0] + f.box[2],
            y2: f.box[1] + f.box[3]
          };
          const videoBbox = CoordinateMapper.modelToVideo(rawBox, params, isMirrored);
          const faceMatch = Boolean(f.matched);
          const faceScore = f.score_percent || `${Math.round((f.similarity || 0) * 100)}%`;
          const customLabel = faceMatch
            ? `Person — Developer VisionX (${faceScore})`
            : 'Person';

          return {
            type: 'face',
            id: `identity_face_${idx + 1}`,
            bbox: videoBbox,
            label: customLabel,
            confidence: f.confidence || 0.9,
            identityStatus: faceMatch ? 'REGISTERED' : 'UNREGISTERED',
            isDeveloper: faceMatch,
            similarity: f.similarity || 0,
            score_percent: faceScore,
            timestamp: Date.now()
          };
        });

        this.currentIdentityFaces = mappedFaces;
        this.renderer.renderUnified(this.currentIdentityFaces, null, [], this.frameSource?.isMirrored);
      } else {
        // Tidak ada wajah terdeteksi pada frame ini
        this.currentIdentityFaces = [];
        this.renderer.clear();

        if (this.elements.idLabDecisionBadge) {
          this.elements.idLabDecisionBadge.textContent = 'STANDBY / NO FACE';
          this.elements.idLabDecisionBadge.className = 'identity-badge badge-neutral';
        }
        if (this.elements.idLabSimilarityScore) {
          this.elements.idLabSimilarityScore.textContent = '0.0%';
        }
        if (this.elements.idLabSimilarityBar) {
          this.elements.idLabSimilarityBar.style.width = '0%';
        }
        if (this.elements.idLabMatchDetail) {
          this.elements.idLabMatchDetail.textContent = 'Arahkan wajah ke kamera untuk menguji pencocokan identitas secara realtime.';
        }
      }
    } catch (e) {
      console.warn('[VisionX Identity Lab] Live test error:', e);
    } finally {
      this.isProcessingFace = false;
    }
  }

  // ==========================================================================
  // SHARED METHODS & CAMERA CONTROLS
  // ==========================================================================
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

  updateModelUI(config, loadTimeMs = 0) {
    const badge = this.elements.activeModelBadge;
    const badgeText = this.elements.activeModelBadgeText;
    badge.className = 'badge ' + (config.isCustom ? 'badge-model-custom' : 'badge-model-pretrained');
    badgeText.textContent = config.name;

    if (this.elements.modelArchTag) this.elements.modelArchTag.textContent = 'Arch: YOLOv8n';
    if (this.elements.modelClassesTag) this.elements.modelClassesTag.textContent = `Classes: ${config.numClasses}`;
    if (this.elements.modelLoadTimeTag) this.elements.modelLoadTimeTag.textContent = `Load: ${loadTimeMs || '--'} ms`;
    if (this.elements.debugModelName) this.elements.debugModelName.textContent = config.name;
    if (this.elements.debugLoadTime) this.elements.debugLoadTime.textContent = `${loadTimeMs || '--'} ms`;

    this.renderTargetClassChips(config);
  }

  renderTargetClassChips(config) {
    const container = this.elements.targetChipsContainer;
    if (!container) return;

    if (config.isCustom) {
      let chipsHtml = `<span class="chips-label">${config.shortName} Classes (${config.classes.length}):</span>`;
      config.classes.forEach(cls => {
        chipsHtml += `<span class="class-chip" data-chip-class="${cls}">${cls}</span>`;
      });
      container.innerHTML = chipsHtml;
      container.classList.remove('hidden');
    } else {
      let chipsHtml = `<span class="chips-label">COCO Classes (80 total):</span>`;
      const sampleCoco = ['person', 'bottle', 'cup', 'laptop', 'mouse', 'keyboard', 'cell phone', 'car', 'chair', '...'];
      sampleCoco.forEach(cls => {
        chipsHtml += `<span class="class-chip" data-chip-class="${cls}">${cls}</span>`;
      });
      container.innerHTML = chipsHtml;
      container.classList.remove('hidden');
    }
  }

  highlightDetectedChips(detections) {
    const activeClasses = new Set(
      (detections || []).filter(d => d.type === 'object').map(d => d.class_name)
    );
    const chips = this.elements.targetChipsContainer.querySelectorAll('.class-chip');
    chips.forEach(chip => {
      const cls = chip.dataset.chipClass;
      chip.classList.toggle('active-detected', activeClasses.has(cls));
    });
  }

  updateDebugTable(detections, frameId, inferenceTimeMs) {
    const tbody = this.elements.debugTableBody;
    this.elements.debugLatency.textContent = `${inferenceTimeMs || 0} ms`;
    this.elements.debugFrameId.textContent = `#${frameId || 0}`;
    this.elements.debugObjectCount.textContent = detections ? detections.length : 0;

    if (!detections || detections.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" class="text-center text-muted">Belum ada objek/wajah terdeteksi pada frame ini.</td></tr>';
      return;
    }

    let rows = '';
    detections.forEach((d, idx) => {
      const confPercent = ((d.confidence || 0) * 100).toFixed(1) + '%';
      const b = d.bbox || d;
      const boxStr = `[${Math.round(b.x1)}, ${Math.round(b.y1)}, ${Math.round(b.x2)}, ${Math.round(b.y2)}]`;
      
      const trackIdStr = d.trackIdFormatted || (d.trackId ? `#${String(d.trackId).padStart(2, '0')}` : '--');
      const velStr = d.velocity
        ? `${d.velocity.x >= 0 ? '+' : ''}${d.velocity.x}, ${d.velocity.y >= 0 ? '+' : ''}${d.velocity.y}`
        : '0, 0';
      const hitsMissedStr = `${d.hits || 1} / ${d.missedFrames || 0}`;
      const stateStr = d.state || (d.type === 'face' ? (d.identityStatus === 'REGISTERED' ? 'dev' : 'unknown') : 'confirmed');

      const typeBadge = d.type === 'face'
        ? (d.identityStatus === 'REGISTERED' ? '<span style="color:#10b981;font-weight:700;">[DEV]</span>' : '<span style="color:#f59e0b;font-weight:700;">[UNKNOWN]</span>')
        : '<span style="color:#38bdf8;font-weight:700;">[OBJ]</span>';

      rows += `
        <tr>
          <td>${idx + 1}</td>
          <td><strong style="color:#38bdf8;">${trackIdStr}</strong></td>
          <td><strong>${d.class_name || d.label}</strong> ${typeBadge}</td>
          <td>${confPercent}</td>
          <td><code>${boxStr}</code></td>
          <td><code>${velStr}</code></td>
          <td>${hitsMissedStr}</td>
          <td><span style="font-size:11px; font-weight:600; text-transform:uppercase; color:${stateStr === 'confirmed' || stateStr === 'dev' ? '#10b981' : stateStr === 'lost' ? '#f59e0b' : '#38bdf8'};">${stateStr}</span></td>
        </tr>
      `;
    });
    tbody.innerHTML = rows;
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
    setTimeout(() => flash.classList.remove('active'), 80);
  }

  async handleImportImages(files) {
    if (!files || files.length === 0) return;
    try {
      const targetClass = this.captureService.currentClass;
      const source = this.captureService.currentSource;
      const result = await this.captureService.importImages(files, targetClass, source);
      this.renderRecentCaptures();
      this.updateCollectionUI();
      this.showSuccess(`Berhasil mengimpor ${result.imported} gambar ke kelas "${targetClass}".`);
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
      this.showError('Tidak ditemukan file gambar yang didukung (.jpg, .jpeg, .png, .webp).');
      this.elements.inputImportFolder.value = '';
      return;
    }

    this.pendingFolderImportFiles = validImages;
    this.elements.folderModalSummary.textContent = `Ditemukan ${validImages.length} file gambar valid di folder.`;
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
      this.showSuccess(`Impor folder selesai: ${result.imported} gambar berhasil diimpor.`);
    } catch (err) {
      this.showError('Gagal impor folder: ' + err.message);
    } finally {
      this.closeFolderModal();
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

    container.className = 'recent-captures-list grid grid-cols-2 md:grid-cols-4 gap-4';

    let html = '';
    list.forEach(item => {
      const isSelected = this.selectedItems.has(item.filename);
      const selectedClass = isSelected ? 'selected' : '';
      const sourceBadge = item.source === 'own_capture' ? '📸' : '💾';
      const imgUrl = item.previewUrl || item.dataUrl || item.url || '';
      const sizeText = item.formattedSize || (item.sizeBytes ? `${(item.sizeBytes / 1024).toFixed(1)} KB` : '-');

      html += `
        <div class="gallery-item-card manager-card relative bg-slate-900 border border-slate-800 rounded-xl overflow-hidden group hover:border-cyan-500/50 transition flex flex-col ${selectedClass}" data-filename="${item.filename}">
          <!-- Thumbnail Wrapper (Atas): Rasio 16:9 ('h-40 w-full bg-slate-950 overflow-hidden relative') -->
          <div class="manager-card-thumb-wrapper h-40 w-full bg-slate-950 overflow-hidden relative cursor-pointer">
            <img src="${imgUrl}" alt="${item.filename}" class="manager-card-thumb w-full h-full object-cover" loading="lazy" onerror="this.onerror=null;this.parentElement.classList.add('img-broken');" />
            <div class="card-thumb-gradient"></div>

            ${this.isSelectMode ? `
              <div class="absolute top-2 left-2 z-10">
                <label class="card-checkbox-label flex items-center justify-center p-1 rounded-md bg-slate-950/80 backdrop-blur border border-slate-700/60 cursor-pointer shadow-sm hover:border-cyan-400" title="Pilih item">
                  <input type="checkbox" class="gallery-checkbox accent-cyan-400 w-4 h-4 rounded cursor-pointer" ${isSelected ? 'checked' : ''} data-filename="${item.filename}" />
                </label>
              </div>
            ` : ''}

            <!-- Badge Ukuran File: melayang di pojok kanan atas -->
            <div class="absolute top-2 right-2 bg-slate-950/80 backdrop-blur px-2 py-0.5 rounded text-[10px] text-slate-300 font-mono border border-slate-800/80 shadow-sm z-10 pointer-events-none">
              ${sizeText}
            </div>

            <!-- Badge Kategori Kelas: melayang di pojok kiri bawah -->
            <div class="absolute bottom-2 left-2 z-10 pointer-events-none">
              <span class="px-1.5 py-0.5 rounded bg-cyan-950/80 border border-cyan-800/60 text-[10px] text-cyan-300 font-medium">
                ${item.className}
              </span>
            </div>
          </div>

          <!-- Metadata & Footer (Bawah): Padding 'p-3 flex flex-col gap-1.5' -->
          <div class="manager-card-body p-3 flex flex-col gap-1.5 flex-1 justify-between">
            <div>
              <span class="manager-card-filename truncate text-xs font-medium text-slate-200 block" title="${item.filename}">
                ${item.filename}
              </span>
              <div class="manager-card-meta flex items-center justify-between text-[11px] text-slate-400 mt-1">
                <span>${sourceBadge} ${item.source}</span>
                <span class="font-mono text-[10px]">${item.timestamp || ''}</span>
              </div>
            </div>

            ${!this.isSelectMode ? `
              <div class="manager-card-actions flex items-center gap-2 mt-2 pt-2 border-t border-slate-800/80">
                <button type="button" class="btn-card-action btn-delete-single flex-1 py-1 px-2 rounded-lg bg-red-950/40 hover:bg-red-900/60 border border-red-800/40 hover:border-red-700 text-red-400 hover:text-red-300 text-xs font-medium transition flex items-center justify-center gap-1" data-filename="${item.filename}" data-class="${item.className}" title="Hapus gambar ini">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="3 6 5 6 21 6"></polyline>
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                  </svg>
                  <span>Trash</span>
                </button>
              </div>
            ` : ''}
          </div>
        </div>
      `;
    });
    container.innerHTML = html;

    if (this.isSelectMode) {
      container.querySelectorAll('.gallery-item-card').forEach(card => {
        card.addEventListener('click', () => {
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
    if (!this.isSelectMode) this.selectedItems.clear();
    this.updateMultiSelectUI();
    this.renderRecentCaptures();
  }

  toggleItemSelection(filename) {
    if (this.selectedItems.has(filename)) this.selectedItems.delete(filename);
    else this.selectedItems.add(filename);
    this.updateMultiSelectUI();
    this.renderRecentCaptures();
  }

  selectAllCaptures() {
    this.captureService.getRecentCaptures().forEach(item => this.selectedItems.add(item.filename));
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
        await this.captureService.deleteMultiple(filenames);
        this.selectedItems.clear();
        this.isSelectMode = false;
        this.updateMultiSelectUI();
        this.renderRecentCaptures();
        this.updateCollectionUI();
        this.showSuccess(`${count} gambar berhasil dihapus.`);
      } catch (err) {
        this.showError('Gagal hapus massal: ' + err.message);
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
      if (ok) this.showSuccess('Folder datasets/raw berhasil terhubung langsung!');
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

  handleGlobalKeydown(e) {
    if (e.key === 'Escape') {
      const modalClosed = this.closeTopmostModal();
      if (modalClosed) {
        e.preventDefault();
        return;
      }
    }
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;

    // Sub-phase B.2: Abaikan shortcut kamera saat mode aktif adalah Dataset Manager
    if (this.currentMode === 'manager') {
      if (e.code === 'Space' || e.key === 'c' || e.key === 'C' || e.key === 'm' || e.key === 'M') {
        return;
      }
    }

    if (e.code === 'Space' || e.key === 'c' || e.key === 'C') {
      e.preventDefault();
      if (this.currentMode === 'collection') this.handleCapture();
    } else if (e.key === 'm' || e.key === 'M') {
      const nextMode = this.currentMode === 'detection' ? 'collection' : 'detection';
      this.setMode(nextMode);
    } else if (e.key === 'v' || e.key === 'V') {
      e.preventDefault();
      const nextState = !this.voiceEngine.config.enabled;
      this.setVoiceEnabled(nextState);
      this.showSuccessBanner(nextState ? 'Voice Assistant diaktifkan (V)' : 'Voice Assistant dimatikan (V)');
    } else if (e.key === 'r' || e.key === 'R') {
      e.preventDefault();
      if (this.currentMode !== 'read_text') {
        this.setMode('read_text');
      }
      this.handleTriggerOcr();
    }
  }

  async loadCameraDevices() {
    if (this.hasLoadedCameraDevices) return;
    try {
      const devices = await this.cameraService.getAvailableDevices();
      this.populateDeviceSelect(devices);
      this.hasLoadedCameraDevices = true;
    } catch (err) {
      console.warn('[VisionX] Tidak dapat mengambil daftar kamera:', err);
    }
  }

  populateDeviceSelect(devices) {
    if (!this.elements.deviceSelect) return;
    const select = this.elements.deviceSelect;
    const currentVal = select.value;
    select.innerHTML = '<option value="">Default / Auto Camera</option>';

    devices.forEach((dev, idx) => {
      const opt = document.createElement('option');
      opt.value = dev.deviceId;
      opt.textContent = dev.label || `Camera ${idx + 1}`;
      if (dev.deviceId === currentVal) opt.selected = true;
      select.appendChild(opt);
    });
  }

  async handleStartCamera(deviceId = null) {
    if (this.isStartingCamera) return;
    if (this.currentMode === 'manager' || this.currentMode === 'home') return;
    if (this.cameraService && this.cameraService.state.status === 'connected') return;

    if (typeof window !== 'undefined' && window.isSecureContext === false) {
      this.showCameraInsecureWarning('Kamera butuh HTTPS. Buka lewat alamat HTTPS atau localhost.');
      return;
    }

    this.isStartingCamera = true;
    const sessionId = ++this._cameraSessionId;

    try {
      if (!this.hasLoadedCameraDevices) {
        await this.loadCameraDevices();
      }
      if (sessionId !== this._cameraSessionId || this.currentMode === 'manager' || this.currentMode === 'home') {
        return;
      }

      const targetDevice = deviceId || (this.elements.deviceSelect && this.elements.deviceSelect.value) || null;
      await this.cameraService.start(targetDevice);

      // Guard against race condition: check if session changed or user moved to manager/home while start was in-flight
      if (sessionId !== this._cameraSessionId || this.currentMode === 'manager' || this.currentMode === 'home') {
        console.warn('[VisionX] Camera start resolved after mode changed; stopping newly opened stream immediately.');
        if (this.cameraService) {
          this.cameraService.stop();
        }
        return;
      }

      this.startRenderLoop();
    } catch (err) {
      console.error('[VisionX] Gagal memulai kamera:', err);
      const isSecure = (typeof window !== 'undefined' && window.isSecureContext !== false);
      let errorMsg = err && (err.friendlyMessage || err.message);
      if (!isSecure || (err && err.category === 'INSECURE_CONTEXT')) {
        errorMsg = 'Kamera butuh HTTPS. Buka lewat alamat HTTPS atau localhost.';
      }
      this.showCameraInsecureWarning(errorMsg || 'Kamera butuh HTTPS. Buka lewat alamat HTTPS atau localhost.');
    } finally {
      this.isStartingCamera = false;
    }
  }

  showCameraInsecureWarning(message) {
    if (typeof document === 'undefined') return;
    let banner = document.getElementById('insecureCameraBanner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'insecureCameraBanner';
      banner.className = 'insecure-camera-banner';
      banner.setAttribute('role', 'alert');
      banner.innerHTML = `
        <div class="insecure-banner-content">
          <span class="insecure-banner-icon">⚠️</span>
          <span class="insecure-banner-text"></span>
          <button type="button" class="btn-close-banner" aria-label="Tutup Peringatan">✕</button>
        </div>
      `;
      const closeBtn = banner.querySelector('.btn-close-banner');
      if (closeBtn) {
        closeBtn.addEventListener('click', () => {
          banner.classList.add('hidden');
        });
      }
      document.body.appendChild(banner);
    }
    const textEl = banner.querySelector('.insecure-banner-text');
    if (textEl) textEl.textContent = message;
    banner.classList.remove('hidden');
    setTimeout(() => {
      if (banner && !banner.classList.contains('hidden')) {
        banner.classList.add('hidden');
      }
    }, 6000);
  }

  updateCameraToggleButtonVisibility(overrideStatus = null) {
    const status = overrideStatus || this._lastCameraStatus || (this.cameraService && this.cameraService.state && this.cameraService.state.status) || 'idle';
    const isCameraActive = status === 'connected';
    const isConnecting = status === 'connecting';

    if (this.elements.btnStart) {
      if (isCameraActive) {
        this.elements.btnStart.classList.add('hidden');
        this.elements.btnStart.disabled = true;
      } else {
        this.elements.btnStart.classList.remove('hidden');
        this.elements.btnStart.disabled = isConnecting;
      }
    }

    if (this.elements.btnStop) {
      if (isCameraActive) {
        this.elements.btnStop.classList.remove('hidden');
        this.elements.btnStop.disabled = false;
      } else {
        this.elements.btnStop.classList.add('hidden');
        this.elements.btnStop.disabled = true;
      }
    }
  }

  handleStopCamera() {
    this._cameraSessionId++; // Invalidate any in-flight camera start session
    this._lastCameraStatus = 'disconnected';
    this.stopRenderLoop();
    if (this.cameraService) {
      this.cameraService.stop();
    }
    if (this.renderer) {
      this.renderer.clear();
    }
    if (this.elements.fpsValue) this.elements.fpsValue.textContent = '0.0';
    this.fpsSmooth = 0;
    if (this.elements.detectionCountValue) this.elements.detectionCountValue.textContent = '0';
    this.updateDebugTable([], 0, 0);
    this.updateCameraToggleButtonVisibility('disconnected');
  }

  handleCameraStateChange(state) {
    const { status, resolution } = state;
    this._lastCameraStatus = status;
    const badge = this.elements.cameraBadge;
    const text = this.elements.cameraStatusText;

    badge.className = 'badge';
    if (status === 'connected') {
      badge.classList.add('badge-connected');
      text.textContent = `Camera Connected (${resolution?.width || 1280}x${resolution?.height || 720})`;
      this.resetCameraPlaceholder();
      this.elements.placeholder.classList.add('hidden');
    } else if (status === 'connecting') {
      badge.classList.add('badge-connecting');
      text.textContent = 'Meminta Akses Kamera...';
    } else if (status === 'error') {
      badge.classList.add('badge-error');
      text.textContent = 'Kamera Error';
      this.elements.placeholder.classList.remove('hidden');
    } else {
      badge.classList.add('badge-disconnected');
      text.textContent = 'Kamera Terputus';
      this.resetCameraPlaceholder();
      this.elements.placeholder.classList.remove('hidden');
    }

    this.updateCameraToggleButtonVisibility(status);
    this.updateCameraDependentButtons(status === 'connected');
  }

  handleCameraError(err) {
    const mainMsg = err.friendlyMessage || err.message || 'Gagal mengakses kamera.';
    const suggestion = err.actionSuggestion ? `\n💡 Solusi: ${err.actionSuggestion}` : '';
    this.showError(`${mainMsg}${suggestion}`, { duration: 9000 });
    this.renderCameraErrorPlaceholder(err);
  }

  renderCameraErrorPlaceholder(err) {
    const placeholder = this.elements.placeholder;
    if (!placeholder) return;

    placeholder.classList.add('is-error');
    const mainMsg = err.friendlyMessage || err.message || 'Gagal mengakses kamera.';
    const suggestion = err.actionSuggestion || 'Periksa izin kamera pada browser Anda dan coba lagi.';
    const category = err.category || 'ERROR';
    const canRetry = err.canRetry !== false;

    placeholder.innerHTML = `
      <div class="camera-error-container">
        <svg class="placeholder-icon error-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
          <circle cx="12" cy="12" r="10"></circle>
          <line x1="12" y1="8" x2="12" y2="12"></line>
          <line x1="12" y1="16" x2="12.01" y2="16"></line>
        </svg>
        <span class="camera-error-badge">${category}</span>
        <div class="placeholder-title error-title">${mainMsg}</div>
        <div class="placeholder-desc error-desc">${suggestion}</div>
        <div class="placeholder-actions">
          ${canRetry ? `
            <button id="btnPlaceholderRetry" class="btn btn-hero btn-placeholder-retry" type="button">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
                <polyline points="23 4 23 10 17 10"></polyline>
                <polyline points="1 20 1 14 7 14"></polyline>
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
              </svg>
              <span>Coba Lagi (Retry)</span>
            </button>
          ` : ''}
          <button id="btnPlaceholderDismiss" class="btn btn-placeholder-dismiss" type="button">
            Tutup Pesan
          </button>
        </div>
      </div>
    `;

    const btnRetry = placeholder.querySelector('#btnPlaceholderRetry');
    if (btnRetry) {
      btnRetry.addEventListener('click', () => {
        this.resetCameraPlaceholder();
        this.handleStartCamera();
      });
    }

    const btnDismiss = placeholder.querySelector('#btnPlaceholderDismiss');
    if (btnDismiss) {
      btnDismiss.addEventListener('click', () => {
        this.resetCameraPlaceholder();
      });
    }
  }

  resetCameraPlaceholder() {
    const placeholder = this.elements.placeholder;
    if (!placeholder) return;
    placeholder.classList.remove('is-error');
    placeholder.innerHTML = `
      <svg class="placeholder-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path>
        <circle cx="12" cy="13" r="4"></circle>
      </svg>
      <div class="placeholder-title">Kamera Belum Aktif</div>
      <div class="placeholder-desc">Tekan tombol <strong>Start Camera</strong> untuk memulai streaming video, deteksi YOLOv8, atau pengumpulan dataset.</div>
    `;
  }

  showError(msg, options = {}) {
    const duration = options.duration || 6000;
    this.elements.errorMessage.innerHTML = String(msg).replace(/\n/g, '<br/>');
    this.elements.errorBanner.classList.remove('hidden');
    this.elements.successBanner.classList.add('hidden');
    if (this._errorBannerTimeout) clearTimeout(this._errorBannerTimeout);
    this._errorBannerTimeout = setTimeout(() => this.elements.errorBanner.classList.add('hidden'), duration);
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
      if (this.renderer && this.currentMode === 'detection') this.renderer.clear();
    } else {
      badge.classList.add('badge-disconnected');
      text.textContent = textMessage || 'Inference Inactive';
      if (this.renderer && this.currentMode === 'detection') this.renderer.clear();
    }
  }

  updateDiagnosticsUI(trackingOutput = null) {
    const d = this.inferenceService.diagnostics;
    const status = this.inferenceService.status || d.status || 'idle';
    if (this.elements.diagModelState) {
      this.elements.diagModelState.textContent = status.toUpperCase();
      this.elements.diagModelState.className = `diag-val ${status}`;
    }

    // Tracking Engine Diagnostics (V0.7)
    if (this.elements.diagTrackingStatus) {
      const isTrackActive = this.trackingEngine && this.trackingEngine.isEnabled;
      this.elements.diagTrackingStatus.textContent = isTrackActive ? 'ACTIVE' : 'STANDBY';
      this.elements.diagTrackingStatus.className = `diag-val ${isTrackActive ? 'ready' : 'standby'}`;
    }

    if (this.trackingEngine) {
      const stats = trackingOutput ? trackingOutput.stats : this.trackingEngine.getStats();
      if (this.elements.diagVisibleTracks) {
        this.elements.diagVisibleTracks.textContent = stats.visibleCount;
      }
      if (this.elements.diagTotalActiveTracks) {
        this.elements.diagTotalActiveTracks.textContent = stats.totalActiveCount;
      }
      if (this.elements.diagNewTracks) {
        this.elements.diagNewTracks.textContent = stats.newCount;
      }
      if (this.elements.diagLostTracks) {
        this.elements.diagLostTracks.textContent = stats.lostCount;
      }
      if (this.elements.diagTrackSummary) {
        const classEntries = Object.entries(stats.perClass || {});
        const classStr = classEntries.length > 0
          ? classEntries.map(([cls, cnt]) => `${cls}: ${cnt}`).join(', ')
          : 'None';
        this.elements.diagTrackSummary.textContent = `Unique: ${stats.uniqueTracksCount} | ${classStr}`;
      }
    }

    // Unified Vision Engine Diagnostics
    if (this.elements.diagFaceDetectStatus) {
      const fStatus = this.faceDetector ? this.faceDetector.status : 'disabled';
      this.elements.diagFaceDetectStatus.textContent = fStatus.toUpperCase();
      this.elements.diagFaceDetectStatus.className = `diag-val ${fStatus === 'ready' || fStatus === 'detecting' ? 'ready' : fStatus}`;
    }

    if (this.elements.diagFaceRecogStatus) {
      const rStatus = this.faceRecognizer ? this.faceRecognizer.status : 'disabled';
      this.elements.diagFaceRecogStatus.textContent = rStatus.toUpperCase();
      this.elements.diagFaceRecogStatus.className = `diag-val ${rStatus === 'ready' || rStatus === 'matching' ? 'ready' : rStatus}`;
    }

    if (this.elements.diagFaceDetectionsCount) {
      this.elements.diagFaceDetectionsCount.textContent = this.faceDetector ? this.faceDetector.totalDetectionsCount : 0;
    }

    if (this.elements.diagIdentityMatchesCount) {
      this.elements.diagIdentityMatchesCount.textContent = this.faceRecognizer ? this.faceRecognizer.identityMatchesCount : 0;
    }

    if (this.elements.diagCoordTransform) {
      const dims = this.frameSource ? this.frameSource.getDimensions() : { width: 0, height: 0 };
      const isMirrored = this.frameSource ? this.frameSource.isMirrored : false;
      this.elements.diagCoordTransform.textContent = CoordinateMapper.getTransformStatus(dims, isMirrored);
    }

    if (this.elements.diagLoadStarted) {
      this.elements.diagLoadStarted.textContent = `${this.inferenceService.loadTimeMs || '--'} ms`;
    }
    if (this.elements.diagModelSize && d.modelSizeFormatted) this.elements.diagModelSize.textContent = d.modelSizeFormatted;
    if (this.elements.diagSessionInit && d.sessionInitialized) this.elements.diagSessionInit.textContent = d.sessionInitialized;
    if (this.elements.diagInputShape && d.modelInputShape) this.elements.diagInputShape.textContent = d.modelInputShape;
    if (this.elements.diagOutputShape && d.modelOutputShape) this.elements.diagOutputShape.textContent = d.modelOutputShape;
    if (this.elements.diagFirstInferLatency) {
      const yoloLat = d.lastInferenceLatencyMs || 0;
      const faceLat = this.faceDetector ? this.faceDetector.lastLatencyMs : 0;
      this.elements.diagFirstInferLatency.textContent = `YOLO: ${yoloLat}ms | Face: ${faceLat}ms`;
    }
    if (this.elements.diagRawPreds) this.elements.diagRawPreds.textContent = d.lastRawPredictionsCount;
    if (this.elements.diagAfterConf) this.elements.diagAfterConf.textContent = d.lastAfterConfidenceCount;
    if (this.elements.diagAfterNms) this.elements.diagAfterNms.textContent = d.lastAfterNmsCount;
    if (this.elements.diagFinalDetections) this.elements.diagFinalDetections.textContent = d.finalDetectionsCount ?? d.lastAfterNmsCount;
    if (this.elements.diagTensorMinMax) {
      this.elements.diagTensorMinMax.textContent = (d.tensorMin !== null && d.tensorMax !== null)
        ? `[${d.tensorMin.toFixed(2)}, ${d.tensorMax.toFixed(2)}]`
        : '-- / --';
    }

    // Voice Assistant Engine Diagnostics (V0.8)
    if (this.voiceEngine) {
      const vState = this.voiceEngine.getState();
      if (this.elements.diagVoiceEnabled) {
        this.elements.diagVoiceEnabled.textContent = vState.enabled ? 'ENABLED' : 'DISABLED';
        this.elements.diagVoiceEnabled.className = `diag-val ${vState.enabled ? 'ready' : 'standby'}`;
      }
      if (this.elements.diagVoiceState) {
        this.elements.diagVoiceState.textContent = vState.state;
        const cls = vState.state === 'SPEAKING' ? 'badge-speaking ready' : (vState.state === 'READY' ? 'ready' : 'standby');
        this.elements.diagVoiceState.className = `diag-val ${cls}`;
      }
      if (this.elements.diagVoiceQueue) {
        this.elements.diagVoiceQueue.textContent = vState.queueLength;
      }
      if (this.elements.diagVoiceAnnouncements) {
        this.elements.diagVoiceAnnouncements.textContent = vState.totalAnnouncements;
      }
      if (this.elements.diagVoiceLastMessage) {
        this.elements.diagVoiceLastMessage.textContent = vState.lastMessage || '-';
      }
    }

    // OCR Engine Diagnostics (V0.9)
    if (this.ocrService) {
      const ocrDiag = this.ocrService.getDiagnostics();
      if (this.elements.diagOcrStatus) {
        this.elements.diagOcrStatus.textContent = ocrDiag.status;
        this.elements.diagOcrStatus.className = `diag-val ${ocrDiag.status === 'READY' ? 'ready' : ocrDiag.status === 'PROCESSING' ? 'loading' : ocrDiag.status === 'ERROR' ? 'error' : 'standby'}`;
      }
      if (this.elements.diagOcrLatency) {
        this.elements.diagOcrLatency.textContent = `${ocrDiag.lastLatencyMs || 0} ms`;
      }
      if (this.elements.diagOcrRegions) {
        this.elements.diagOcrRegions.textContent = ocrDiag.lastRegionCount !== undefined ? ocrDiag.lastRegionCount : 0;
      }
      if (this.elements.diagOcrTime) {
        this.elements.diagOcrTime.textContent = ocrDiag.lastTimestamp ? new Date(ocrDiag.lastTimestamp).toLocaleTimeString() : '--:--:--';
      }
    }
  }

  /**
   * =========================================================================
   * VOICE ASSISTANT ENGINE (V0.8) HANDLERS & HELPERS
   * =========================================================================
   */
  syncVoiceUIFromConfig() {
    if (!this.voiceEngine) return;
    const cfg = this.voiceEngine.config;

    if (this.elements.toggleVoice) {
      this.elements.toggleVoice.checked = cfg.enabled;
    }
    if (this.elements.toggleVoiceStateLabel) {
      this.elements.toggleVoiceStateLabel.textContent = cfg.enabled ? '● Enabled' : '○ Disabled';
      this.elements.toggleVoiceStateLabel.className = `toggle-state-text ${cfg.enabled ? '' : 'disabled'}`;
    }
    if (this.elements.voiceModeSelect) {
      this.elements.voiceModeSelect.value = cfg.mode || 'OBJECT_ALERTS';
    }
    if (this.elements.voiceVolumeSlider) {
      this.elements.voiceVolumeSlider.value = cfg.volume !== undefined ? cfg.volume : 1.0;
    }
    if (this.elements.voiceVolumeVal) {
      this.elements.voiceVolumeVal.textContent = `${Math.round((cfg.volume !== undefined ? cfg.volume : 1.0) * 100)}%`;
    }
    if (this.elements.voiceSpeedSlider) {
      this.elements.voiceSpeedSlider.value = cfg.rate !== undefined ? cfg.rate : 1.0;
    }
    if (this.elements.voiceSpeedVal) {
      this.elements.voiceSpeedVal.textContent = `${(cfg.rate !== undefined ? cfg.rate : 1.0).toFixed(1)}x`;
    }

    this.handleVoiceStateChange(this.voiceEngine.getState());
  }

  setVoiceEnabled(enabled) {
    if (!this.voiceEngine) return;
    this.voiceEngine.setEnabled(enabled);
    if (this.elements.toggleVoice) {
      this.elements.toggleVoice.checked = enabled;
    }
    if (this.elements.toggleVoiceStateLabel) {
      this.elements.toggleVoiceStateLabel.textContent = enabled ? '● Enabled' : '○ Disabled';
      this.elements.toggleVoiceStateLabel.className = `toggle-state-text ${enabled ? '' : 'disabled'}`;
    }
    this.saveVoiceConfig();
    this.updateDiagnosticsUI();
  }

  setVoiceMode(mode) {
    if (!this.voiceEngine) return;
    this.voiceEngine.setMode(mode);
    this.saveVoiceConfig();
    this.updateDiagnosticsUI();
  }

  setVoiceVolume(volume) {
    if (!this.voiceEngine) return;
    this.voiceEngine.setVolume(volume);
    if (this.elements.voiceVolumeVal) {
      this.elements.voiceVolumeVal.textContent = `${Math.round(volume * 100)}%`;
    }
    this.saveVoiceConfig();
  }

  setVoiceSpeed(rate) {
    if (!this.voiceEngine) return;
    this.voiceEngine.setRate(rate);
    if (this.elements.voiceSpeedVal) {
      this.elements.voiceSpeedVal.textContent = `${rate.toFixed(1)}x`;
    }
    this.saveVoiceConfig();
  }

  saveVoiceConfig() {
    if (!this.voiceEngine) return;
    try {
      const cfg = {
        enabled: this.voiceEngine.config.enabled,
        mode: this.voiceEngine.config.mode,
        volume: this.voiceEngine.config.volume,
        rate: this.voiceEngine.config.rate,
        pitch: this.voiceEngine.config.pitch,
        cooldownMs: this.voiceEngine.config.cooldownMs,
        batchWindowMs: this.voiceEngine.config.batchWindowMs
      };
      localStorage.setItem('visionx_voice_config', JSON.stringify(cfg));
    } catch (e) {
      console.warn('[VisionX] Failed writing voice config to localStorage', e);
    }
  }

  handleVoiceStateChange(vState) {
    // Update badge di header
    if (this.elements.voiceBadge && this.elements.voiceBadgeText) {
      if (!vState.isAvailable) {
        this.elements.voiceBadge.className = 'badge badge-error';
        this.elements.voiceBadgeText.textContent = 'Voice: Tidak Tersedia';
      } else if (!vState.enabled || vState.mode === 'OFF') {
        this.elements.voiceBadge.className = 'badge badge-disconnected';
        this.elements.voiceBadgeText.textContent = 'Voice: Nonaktif';
      } else if (vState.state === 'SPEAKING') {
        this.elements.voiceBadge.className = 'badge badge-speaking ready';
        this.elements.voiceBadgeText.textContent = 'Voice: Berbicara';
      } else if (vState.state === 'PAUSED') {
        this.elements.voiceBadge.className = 'badge badge-paused';
        this.elements.voiceBadgeText.textContent = 'Voice: Dijeda';
      } else {
        this.elements.voiceBadge.className = 'badge badge-ready';
        this.elements.voiceBadgeText.textContent = 'Voice: Siap';
      }
    }

    // Update status badge di panel kontrol
    if (this.elements.voiceStatusBadge && this.elements.voiceStatusText) {
      if (!vState.isAvailable) {
        this.elements.voiceStatusBadge.className = 'badge badge-error';
        this.elements.voiceStatusText.textContent = 'Tidak Tersedia';
      } else if (!vState.enabled || vState.mode === 'OFF') {
        this.elements.voiceStatusBadge.className = 'badge badge-disconnected';
        this.elements.voiceStatusText.textContent = 'Nonaktif';
      } else if (vState.state === 'SPEAKING') {
        this.elements.voiceStatusBadge.className = 'badge badge-speaking ready';
        this.elements.voiceStatusText.textContent = 'Berbicara...';
      } else if (vState.state === 'PAUSED') {
        this.elements.voiceStatusBadge.className = 'badge badge-paused';
        this.elements.voiceStatusText.textContent = 'Dijeda';
      } else {
        this.elements.voiceStatusBadge.className = 'badge badge-ready';
        this.elements.voiceStatusText.textContent = 'Siap';
      }
    }

    // Update text pesan terakhir
    if (this.elements.voiceLastMsgText) {
      this.elements.voiceLastMsgText.textContent = vState.lastMessage && vState.lastMessage !== '-'
        ? `"${vState.lastMessage}"`
        : 'Belum ada pengumuman suara.';
    }

    // Toggle Tombol Speech Response di Ask VisionX Panel
    if (this.elements.btnStopSpeechResponse && this.elements.btnReadAloudResponse) {
      if (vState.state === 'SPEAKING') {
        this.elements.btnStopSpeechResponse.classList.remove('hidden');
        this.elements.btnReadAloudResponse.classList.add('hidden');
      } else {
        this.elements.btnStopSpeechResponse.classList.add('hidden');
        this.elements.btnReadAloudResponse.classList.remove('hidden');
      }
    }
  }

  // ==========================================================================
  // V0.9 — OCR & READ TEXT MODE HANDLERS
  // ==========================================================================

  handleOcrStatusChange(statusOrInfo) {
    const status = typeof statusOrInfo === 'string' ? statusOrInfo : (statusOrInfo && statusOrInfo.status ? statusOrInfo.status : 'READY');

    if (this.elements.ocrStatusBadge && this.elements.ocrStatusText) {
      this.elements.ocrStatusText.textContent = status;
      this.elements.ocrStatusBadge.className = 'badge ' + (
        status === 'READY' ? 'badge-ready' :
        status === 'PROCESSING' || status === 'LOADING' ? 'badge-connecting' :
        status === 'ERROR' ? 'badge-error' :
        status === 'DONE' ? 'badge-ready' : 'badge-disconnected'
      );
    }

    if (this.elements.ocrTelemetryStatus) {
      this.elements.ocrTelemetryStatus.textContent = status;
      this.elements.ocrTelemetryStatus.className = 'telemetry-value ' + (
        status === 'READY' || status === 'DONE' ? 'status-ready' :
        status === 'PROCESSING' || status === 'LOADING' ? 'status-processing' :
        status === 'ERROR' ? 'status-error' : ''
      );
    }

    if (this.elements.ocrBadge && this.elements.ocrBadgeText) {
      const ocrStatusLabel = {
        'READY': 'Siap',
        'DONE': 'Selesai',
        'PROCESSING': 'Memproses',
        'LOADING': 'Memuat',
        'ERROR': 'Error',
        'OFF': 'Nonaktif'
      }[status] || status;
      this.elements.ocrBadgeText.textContent = `OCR: ${ocrStatusLabel}`;
      this.elements.ocrBadge.className = 'badge ' + (
        status === 'READY' || status === 'DONE' ? 'badge-ready' :
        status === 'PROCESSING' || status === 'LOADING' ? 'badge-connecting' :
        status === 'ERROR' ? 'badge-error' : 'badge-disconnected'
      );
    }

    if (this.elements.btnTriggerOcr) {
      this.elements.btnTriggerOcr.disabled = (status === 'PROCESSING' || status === 'LOADING');
    }

    this.updateDiagnosticsUI();
  }

  async handleTriggerOcr(isAuto = false, isReScan = false) {
    if (!this.ocrService) {
      if (!isAuto) this.showError('Layanan OCR tidak tersedia.');
      return;
    }

    // 1. Verifikasi kamera aktif
    if (this.cameraService.state.status !== 'connected' || !this.elements.video || this.elements.video.readyState < 2) {
      if (!isAuto) {
        this.showError('Nyalakan kamera terlebih dahulu sebelum membaca teks.');
        if (this.voiceEngine && this.voiceEngine.config.enabled) {
          this.voiceEngine.speak('Kamera belum aktif.', { priority: SpeechPriority.NORMAL });
        }
      }
      return;
    }

    // 2. Cegah scan jika OCR sedang sibuk
    if (this.ocrService.getStatus() === OCRStatus.PROCESSING) {
      return;
    }

    // 3. Suara feedback awal aksesibilitas
    if (!isAuto && this.voiceEngine && this.voiceEngine.config.enabled) {
      const promptText = isReScan ? 'Memindai ulang teks.' : 'Memproses teks.';
      this.voiceEngine.speak(promptText, { priority: SpeechPriority.NORMAL });
    }

    const currentLang = this.elements.ocrLangSelect ? this.elements.ocrLangSelect.value : 'ind';
    const profile = this.elements.ocrProfileSelect ? this.elements.ocrProfileSelect.value : OCR_PROFILES.AUTO;
    const roiMode = this.elements.ocrRoiSelect ? this.elements.ocrRoiSelect.value : ROI_MODES.AUTO;

    try {
      // 4. Jalankan OCR secara asinkron dengan profile & ROI terpilih
      const result = await this.ocrService.recognize(this.elements.video, {
        language: currentLang,
        profile,
        roiMode
      });
      this.currentOcrResult = result;
      this.currentOcrRegions = result.regions || [];

      // 5. Update UI hasil baca teks
      this.updateOcrUI(result);

      if (result.text && result.text.trim().length > 0 && result.text !== 'Teks kurang jelas untuk dibaca.') {
        const cleanText = result.text.trim();

        // Voice feedback: "Berhasil membaca teks."
        if (!isAuto && this.voiceEngine && this.voiceEngine.config.enabled) {
          this.voiceEngine.speak('Berhasil membaca teks.', { priority: SpeechPriority.NORMAL });
        }

        // Jika Auto Read aktif, bacakan teks dengan duplicate text suppression
        if (this.isAutoReadOcr) {
          const textHash = cleanText.toLowerCase();
          if (textHash !== this.lastSpokenOcrHash) {
            this.lastSpokenOcrHash = textHash;
            if (this.voiceEngine && this.voiceEngine.config.enabled) {
              this.voiceEngine.speak(cleanText, { priority: SpeechPriority.NORMAL });
            }
          }
        }
      } else if (result.text === 'Teks kurang jelas untuk dibaca.') {
        if (!isAuto && this.voiceEngine && this.voiceEngine.config.enabled) {
          this.voiceEngine.speak('Teks kurang jelas untuk dibaca.', { priority: SpeechPriority.NORMAL });
        }
      } else {
        // Teks tidak ditemukan
        if (!isAuto && this.voiceEngine && this.voiceEngine.config.enabled) {
          this.voiceEngine.speak('Teks tidak ditemukan.', { priority: SpeechPriority.NORMAL });
        }
      }
    } catch (err) {
      console.warn('[VisionX OCR Error]', err);
      if (this.elements.ocrTelemetryStatus) {
        this.elements.ocrTelemetryStatus.textContent = 'ERROR';
        this.elements.ocrTelemetryStatus.className = 'telemetry-value status-error';
      }
      if (!isAuto) {
        this.showError(`Gagal membaca teks: ${err.message}`);
        if (this.voiceEngine && this.voiceEngine.config.enabled) {
          this.voiceEngine.speak('Terjadi kesalahan membaca teks.', { priority: SpeechPriority.NORMAL });
        }
      }
    }
  }

  handleOcrProfileChange(profile) {
    if (this.ocrService) {
      this.ocrService.setProfile(profile);
    }
    if (profile === 'HANDWRITING') {
      this.showSuccess('Profil Handwriting aktif: menggunakan preprocessing khusus tulisan tangan.');
    } else if (profile === 'PRINTED') {
      this.showSuccess('Profil Printed Text aktif: dioptimalkan untuk teks cetak & buku.');
    } else {
      this.showSuccess('Profil Auto aktif: adaptif terhadap kualitas input.');
    }
  }

  handleOcrRoiChange(roiMode) {
    if (this.ocrService) {
      this.ocrService.setRoiMode(roiMode);
    }
  }

  handleStopOcr() {
    if (this.ocrService) {
      this.ocrService.stop();
    }
    this.currentOcrRegions = [];
    if (this.voiceEngine) {
      this.voiceEngine.stop();
    }
    this.showSuccess('Pembacaan teks dihentikan.');
  }

  handleSpeakOcr() {
    if (!this.currentOcrResult || !this.currentOcrResult.text || this.currentOcrResult.text.trim().length === 0) {
      if (this.voiceEngine && this.voiceEngine.config.enabled) {
        this.voiceEngine.speak('Belum ada teks untuk dibacakan.', { priority: SpeechPriority.HIGH });
      }
      this.showError('Belum ada teks OCR untuk dibacakan.');
      return;
    }

    if (this.voiceEngine) {
      this.voiceEngine.speak(this.currentOcrResult.text, { priority: SpeechPriority.HIGH });
    }
  }

  async handleOcrLanguageChange(lang) {
    if (!this.ocrService) return;
    try {
      await this.ocrService.setLanguage(lang);
      this.showSuccess(`Bahasa OCR diubah ke: ${lang === 'ind' ? 'Bahasa Indonesia' : 'English'}`);
    } catch (err) {
      this.showError(`Gagal mengubah bahasa OCR: ${err.message}`);
    }
  }

  handleToggleAutoReadOcr(enabled) {
    this.isAutoReadOcr = enabled;
    if (this.elements.autoReadStateLabel) {
      this.elements.autoReadStateLabel.textContent = enabled ? 'ON' : 'OFF';
      this.elements.autoReadStateLabel.className = `toggle-state-text ${enabled ? '' : 'disabled'}`;
    }
    if (this.elements.toggleAutoReadOcr) {
      this.elements.toggleAutoReadOcr.checked = enabled;
    }

    if (this.voiceEngine && this.voiceEngine.config.enabled) {
      this.voiceEngine.speak(
        enabled ? 'Membaca otomatis diaktifkan.' : 'Membaca otomatis dimatikan.',
        { priority: SpeechPriority.NORMAL }
      );
    }
  }

  handleCopyOcrText() {
    if (!this.currentOcrResult || !this.currentOcrResult.text) {
      this.showError('Tidak ada teks untuk disalin.');
      return;
    }

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(this.currentOcrResult.text)
        .then(() => this.showSuccess('Teks OCR berhasil disalin ke clipboard!'))
        .catch(() => this.fallbackCopyText(this.currentOcrResult.text));
    } else {
      this.fallbackCopyText(this.currentOcrResult.text);
    }
  }

  fallbackCopyText(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    this.showSuccess('Teks OCR berhasil disalin ke clipboard!');
  }

  handleClearOcrText() {
    this.currentOcrResult = null;
    this.currentOcrRegions = [];
    this.lastSpokenOcrHash = '';

    if (this.elements.ocrResultContent) {
      this.elements.ocrResultContent.textContent = '';
      this.elements.ocrResultContent.classList.add('hidden');
    }
    if (this.elements.ocrResultPlaceholder) {
      this.elements.ocrResultPlaceholder.textContent = 'Belum ada teks dipindai. Arahkan kamera ke teks lalu tekan tombol "Read Text" atau tombol keyboard R.';
      this.elements.ocrResultPlaceholder.classList.remove('hidden');
    }
    if (this.elements.ocrResultBox) {
      this.elements.ocrResultBox.classList.add('empty');
    }
    if (this.elements.ocrCharWordCount) {
      this.elements.ocrCharWordCount.textContent = '0 kata • 0 karakter';
    }
    if (this.elements.ocrTelemetryLatency) this.elements.ocrTelemetryLatency.textContent = '0 ms';
    if (this.elements.ocrTelemetryRegions) this.elements.ocrTelemetryRegions.textContent = '0 boxes';
    if (this.elements.ocrTelemetryConfidence) this.elements.ocrTelemetryConfidence.textContent = '--';
    if (this.elements.ocrTelemetryQuality) {
      this.elements.ocrTelemetryQuality.textContent = 'GOOD';
      this.elements.ocrTelemetryQuality.className = 'telemetry-value status-ready';
    }
    if (this.elements.ocrTelemetryResolution) this.elements.ocrTelemetryResolution.textContent = '--';
    if (this.elements.ocrTelemetryTime) this.elements.ocrTelemetryTime.textContent = '--:--:--';
    if (this.elements.ocrTelemetryMethod) this.elements.ocrTelemetryMethod.textContent = 'STANDARD';
    if (this.elements.ocrWarningBanner) this.elements.ocrWarningBanner.classList.add('hidden');
  }

  updateOcrUI(result) {
    const text = (result && result.text) ? result.text.trim() : '';
    const wordCount = text.length > 0 ? text.split(/\s+/).length : 0;
    const charCount = text.length;

    // Telemetry bar
    if (this.elements.ocrTelemetryLatency) {
      this.elements.ocrTelemetryLatency.textContent = `${result.processingTimeMs || 0} ms`;
    }
    if (this.elements.ocrTelemetryRegions) {
      this.elements.ocrTelemetryRegions.textContent = `${result.regions ? result.regions.length : 0} boxes`;
    }
    if (this.elements.ocrTelemetryConfidence) {
      this.elements.ocrTelemetryConfidence.textContent = result.confidence !== null ? `${result.confidence}%` : '--';
    }
    if (this.elements.ocrTelemetryQuality) {
      const q = result.quality || 'GOOD';
      this.elements.ocrTelemetryQuality.textContent = q;
      this.elements.ocrTelemetryQuality.className = `telemetry-value ${q === 'GOOD' ? 'status-ready' : q === 'FAIR' ? 'status-processing' : 'status-error'}`;
    }
    if (this.elements.ocrTelemetryResolution && result.roiAudit) {
      this.elements.ocrTelemetryResolution.textContent = `${result.roiAudit.cropWidth}×${result.roiAudit.cropHeight}`;
    }
    if (this.elements.camDiagOcrInput && result.roiAudit) {
      this.elements.camDiagOcrInput.textContent = `${result.roiAudit.cropWidth}×${result.roiAudit.cropHeight}`;
    }
    if (this.elements.ocrTelemetryTime) {
      this.elements.ocrTelemetryTime.textContent = result.timestamp ? new Date(result.timestamp).toLocaleTimeString() : '--:--:--';
    }
    if (this.elements.ocrTelemetryMethod) {
      this.elements.ocrTelemetryMethod.textContent = (result.preprocessingMethod || 'STANDARD').toUpperCase();
    }

    // Warning Banner if Low Confidence / Handwriting profile notice
    if (this.elements.ocrWarningBanner && this.elements.ocrWarningText) {
      if (result.isLowConfidence || (result.profile === 'HANDWRITING' && result.confidence < 75)) {
        this.elements.ocrWarningBanner.classList.remove('hidden');
        this.elements.ocrWarningText.textContent = result.statusMessage || `Confidence (${result.confidence}%) — coba dekatkan kamera / gunakan pencahayaan lebih baik.`;
      } else {
        this.elements.ocrWarningBanner.classList.add('hidden');
      }
    }

    // Counts
    if (this.elements.ocrCharWordCount) {
      this.elements.ocrCharWordCount.textContent = `${wordCount} kata • ${charCount} karakter`;
    }

    // Result card display
    if (text.length > 0) {
      if (this.elements.ocrResultPlaceholder) this.elements.ocrResultPlaceholder.classList.add('hidden');
      if (this.elements.ocrResultContent) {
        this.elements.ocrResultContent.textContent = text;
        this.elements.ocrResultContent.classList.remove('hidden');
      }
      if (this.elements.ocrResultBox) this.elements.ocrResultBox.classList.remove('empty');
    } else {
      if (this.elements.ocrResultPlaceholder) {
        this.elements.ocrResultPlaceholder.textContent = 'Tidak ditemukan teks pada frame ini.';
        this.elements.ocrResultPlaceholder.classList.remove('hidden');
      }
      if (this.elements.ocrResultContent) {
        this.elements.ocrResultContent.textContent = '';
        this.elements.ocrResultContent.classList.add('hidden');
      }
      if (this.elements.ocrResultBox) this.elements.ocrResultBox.classList.add('empty');
    }

    this.updateDiagnosticsUI();
  }

  /**
   * Menjalankan Golden Test (coco_train_000415_1b9b81.jpg) langsung di browser ONNX Runtime
   */
  async runGoldenTest() {
    if (!this.inferenceService.isModelLoaded) {
      this.showError('Model belum siap untuk Golden Test.');
      return;
    }

    try {
      this.showSuccess('Menjalankan Golden Test citra terverifikasi...');
      const img = new Image();
      img.crossOrigin = 'anonymous';
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => reject(new Error('Gagal memuat file golden test /test/golden_test.jpg'));
        img.src = '/test/golden_test.jpg?' + Date.now();
      });

      // Sesuaikan ukuran renderer dengan ukuran citra golden test
      this.renderer.resize(img.naturalWidth, img.naturalHeight);

      // Jalankan deteksi
      const result = await this.inferenceService.detect(img);
      if (result) {
        const { detections, frameId, inferenceTimeMs } = result;
        this.renderer.render(detections, {
          frameId,
          inferenceTimeMs,
          modelName: this.inferenceService.modelConfig.shortName
        });

        this.elements.detectionCountValue.textContent = detections.length;
        this.highlightDetectedChips(detections);
        this.updateDiagnosticsUI();
        this.updateDebugTable(detections, frameId, inferenceTimeMs);

        console.log(
          `[VisionX Golden Test] Berhasil mendeteksi ${detections.length} objek:`,
          detections.map(d => `${d.class_name} (${(d.confidence * 100).toFixed(1)}%)`)
        );

        const summary = detections.map(d => `${d.class_name} (${(d.confidence * 100).toFixed(0)}%)`).join(', ');
        this.showSuccess(`Golden Test Sukses: ${detections.length} objek terdeteksi [${summary}] (${inferenceTimeMs}ms)`);
      }
    } catch (err) {
      console.error('[VisionX Golden Test Error]', err);
      this.showError('Golden test gagal: ' + err.message);
    }
  }

  // =========================================================================
  // V1.0 AI Vision Assistant Controller Methods
  // =========================================================================

  /**
   * Mengambil snapshot frame kamera saat ini secara on-demand
   * @returns {string|null} Data URL JPEG snapshot atau null jika kamera belum aktif
   */
  captureCameraSnapshot() {
    if (!this.elements.video || this.elements.video.readyState < 2) {
      return null;
    }
    try {
      const video = this.elements.video;
      const w = video.videoWidth || 640;
      const h = video.videoHeight || 480;
      const snapCanvas = document.createElement('canvas');
      snapCanvas.width = w;
      snapCanvas.height = h;
      const ctx = snapCanvas.getContext('2d');
      if (this.frameSource && this.frameSource.isMirrored) {
        ctx.translate(w, 0);
        ctx.scale(-1, 1);
      }
      ctx.drawImage(video, 0, 0, w, h);
      return snapCanvas.toDataURL('image/jpeg', 0.85);
    } catch (err) {
      console.warn('[VisionX] Gagal membuat snapshot kamera untuk AI Assistant:', err);
      return null;
    }
  }

  /**
   * Mengompilasi VisionContext visual saat ini dari subsistem VisionX
   * @returns {Object} JSON Context dari VisionContextBuilder
   */
  buildCurrentVisionContext() {
    const video = this.elements.video;
    const cameraInfo = {
      width: video?.videoWidth || 640,
      height: video?.videoHeight || 480,
      isConnected: this.cameraService?.state?.status === 'connected',
      label: this.cameraService?.currentDeviceId || 'Default Camera'
    };

    return VisionContextBuilder.build({
      detections: this.lastDetections || [],
      trackingEngine: this.trackingEngine,
      ocrResult: this.currentOcrResult,
      identityState: this.lastIdentityState || (this.faceRecognizer ? this.faceRecognizer.getLatestIdentity() : null),
      objectMemory: this.objectMemory,
      personalObjectRegistry: this.personalObjectRegistry,
      safetyEngine: this.safetyEngine,
      alertManager: this.alertManager,
      sceneHistoryEngine: this.sceneHistoryEngine,
      cameraInfo,
      currentMode: this.currentMode
    });
  }

  /**
   * Memulai 1 Hz background scene history sampler (terisolasi di luar processFrame)
   */
  startSceneHistorySampler() {
    if (this.historySamplerInterval) return;
    this.historySamplerInterval = setInterval(() => {
      if (!this.sceneHistoryEngine) return;
      try {
        if (this.currentMode === 'detection' || this.currentMode === 'read_text') {
          const ctx = this.buildCurrentVisionContext();
          if (ctx) {
            const snapshot = SceneHistoryEngine.createSnapshotFromContext(ctx);
            this.sceneHistoryEngine.record(snapshot);
          }
        }
      } catch (sampleErr) {
        console.warn('[VisionX] Scene history sampling error:', sampleErr);
      }
    }, 1000);
  }

  /**
   * Menghentikan background sampler saat teardown
   */
  stopSceneHistorySampler() {
    if (this.historySamplerInterval) {
      clearInterval(this.historySamplerInterval);
      this.historySamplerInterval = null;
    }
  }

  /**
   * Menangani submit pertanyaan ke VisionX Assistant
   * @param {string} prompt Pertanyaan pengguna
   */
  async handleAskVisionSubmit(prompt) {
    const query = String(prompt || '').trim();
    if (!query) {
      if (this.elements.askVisionInput) this.elements.askVisionInput.focus();
      return;
    }

    if (!this.visionAssistant) {
      this.showAssistantError('AI Assistant belum diinisialisasi.');
      return;
    }

    // Kosongkan input dan pertahankan fokus keyboard untuk percakapan bertingkat
    if (this.elements.askVisionInput) {
      this.elements.askVisionInput.value = '';
      this.elements.askVisionInput.focus();
    }

    try {
      await this.visionAssistant.ask(query);
    } catch (err) {
      console.warn('[VisionX] Peringatan handleAskVisionSubmit:', err);
    } finally {
      if (this.elements.askVisionInput) {
        this.elements.askVisionInput.focus();
      }
    }
  }

  /**
   * Menangani perubahan state VisionAssistant (LOADING, SUCCESS, ERROR, IDLE)
   * @param {Object} statePayload
   */
  handleAssistantStateChange(statePayload) {
    const { state, isLoading, lastResult, lastError, latencyMs } = statePayload;

    // 1. Update status badge
    if (this.elements.aiAssistantStatusBadge && this.elements.aiAssistantStatusText) {
      if (state === AssistantState.LOADING) {
        this.elements.aiAssistantStatusBadge.className = 'badge badge-speaking';
        this.elements.aiAssistantStatusText.textContent = 'Menganalisis...';
      } else if (state === AssistantState.ERROR) {
        this.elements.aiAssistantStatusBadge.className = 'badge badge-error';
        this.elements.aiAssistantStatusText.textContent = 'Error';
      } else if (state === AssistantState.SUCCESS) {
        this.elements.aiAssistantStatusBadge.className = 'badge badge-ready';
        this.elements.aiAssistantStatusText.textContent = 'Menjawab';
      } else {
        this.elements.aiAssistantStatusBadge.className = 'badge badge-ready';
        this.elements.aiAssistantStatusText.textContent = 'AI Ready';
      }
    }

    // 2. Update Submit Button & Input loading states
    if (this.elements.btnAskVisionSubmit) {
      this.elements.btnAskVisionSubmit.disabled = isLoading;
      const textSpan = this.elements.btnAskVisionSubmit.querySelector('.btn-ask-text');
      if (textSpan) {
        textSpan.textContent = isLoading ? '...' : 'Tanya';
      }
    }
    if (this.elements.askVisionInput) {
      this.elements.askVisionInput.disabled = isLoading;
    }

    // 3. Update Loading indicator
    if (this.elements.askVisionLoading) {
      this.elements.askVisionLoading.classList.toggle('hidden', !isLoading);
    }

    // 4. Update Error banner
    if (this.elements.askVisionError) {
      if (state === AssistantState.ERROR && lastError) {
        this.elements.askVisionError.classList.remove('hidden');
        if (this.elements.askVisionErrorMessage) {
          this.elements.askVisionErrorMessage.textContent = typeof lastError === 'string' ? lastError : lastError.message || 'Terjadi kesalahan.';
        }
      } else {
        this.elements.askVisionError.classList.add('hidden');
      }
    }

    // 5. Update Response Area & Multi-turn Conversation Thread (Phase D)
    if (state === AssistantState.SUCCESS && lastResult) {
      if (this.elements.askVisionResponseArea) {
        this.elements.askVisionResponseArea.classList.remove('hidden');
      }
      if (this.elements.askVisionResponseText) {
        this.elements.askVisionResponseText.textContent = lastResult.answer;
      }
      if (this.elements.askVisionMeta) {
        this.elements.askVisionMeta.textContent = `Provider: ${lastResult.provider} • Latency: ${latencyMs}ms • Snapshot on-demand`;
      }
      this.renderConversationThread();
    }
  }

  /**
   * Render thread percakapan multi-turn di UI (Phase D)
   */
  renderConversationThread() {
    if (!this.elements.visionConversationThread || !this.visionAssistant?.conversationManager) return;
    const turns = this.visionAssistant.conversationManager.getAllTurns();
    if (turns.length === 0) {
      this.elements.visionConversationThread.classList.add('hidden');
      this.elements.visionConversationThread.innerHTML = '';
      return;
    }

    this.elements.visionConversationThread.classList.remove('hidden');
    this.elements.visionConversationThread.innerHTML = '';

    for (const turn of turns) {
      const bubble = document.createElement('div');
      bubble.className = `chat-bubble ${turn.role === 'user' ? 'chat-user' : 'chat-assistant'}`;

      const content = document.createElement('div');
      content.className = 'chat-bubble-content';
      content.textContent = turn.content;
      bubble.appendChild(content);

      const meta = document.createElement('div');
      meta.className = 'chat-bubble-meta';

      const roleSpan = document.createElement('span');
      roleSpan.textContent = turn.role === 'user' ? '👤 Anda' : '🤖 VisionX';
      meta.appendChild(roleSpan);

      const timeSpan = document.createElement('span');
      timeSpan.textContent = new Date(turn.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      meta.appendChild(timeSpan);

      bubble.appendChild(meta);
      this.elements.visionConversationThread.appendChild(bubble);
    }

    // Auto-scroll HANYA container thread percakapan (bukan seluruh window)
    this.elements.visionConversationThread.scrollTop = this.elements.visionConversationThread.scrollHeight;
  }

  showAssistantError(msg) {
    if (this.elements.askVisionError) {
      this.elements.askVisionError.classList.remove('hidden');
      if (this.elements.askVisionErrorMessage) {
        this.elements.askVisionErrorMessage.textContent = msg;
      }
    }
  }

  handleClearAssistantResponse() {
    if (this.visionAssistant) {
      this.visionAssistant.clear();
    }
    if (this.elements.visionConversationThread) {
      this.elements.visionConversationThread.innerHTML = '';
      this.elements.visionConversationThread.classList.add('hidden');
    }
    if (this.elements.askVisionResponseArea) {
      this.elements.askVisionResponseArea.classList.add('hidden');
    }
    if (this.elements.askVisionError) {
      this.elements.askVisionError.classList.add('hidden');
    }
    if (this.elements.askVisionInput) {
      this.elements.askVisionInput.value = '';
      this.elements.askVisionInput.focus();
    }
  }

  /**
   * =========================================================================
   * Supabase & Gateway Authentication Methods (Phase 2)
   * =========================================================================
   */
  updateAuthStatusUI() {
    const isAuthed = authService.isAuthenticated();
    const role = authService.getRole();
    const user = authService.getUser();
    const email = user?.email || (isAuthed ? 'developer@visionx.local' : 'Tamu');

    // 1. Update Header User Avatar & Pill (F3)
    if (this.elements.headerUserAvatar) {
      if (isAuthed) {
        this.elements.headerUserAvatar.classList.remove('unauthenticated');
        if (this.elements.headerAvatarLetter) {
          this.elements.headerAvatarLetter.textContent = (email[0] || 'U').toUpperCase();
        }
        if (this.elements.headerAvatarLabel) {
          this.elements.headerAvatarLabel.textContent = '';
        }
      } else {
        this.elements.headerUserAvatar.classList.add('unauthenticated');
        if (this.elements.headerAvatarLetter) {
          this.elements.headerAvatarLetter.textContent = 'V';
        }
        if (this.elements.headerAvatarLabel) {
          this.elements.headerAvatarLabel.textContent = 'Masuk';
        }
      }
    }

    // 2. Update Header Dropdown Info (F3)
    if (this.elements.dropdownUserEmail) {
      this.elements.dropdownUserEmail.textContent = email;
    }
    if (this.elements.dropdownUserRoleBadge) {
      const isDev = (role === 'developer');
      this.elements.dropdownUserRoleBadge.textContent = isDev ? 'Developer' : 'Pengguna';
      this.elements.dropdownUserRoleBadge.className = `dropdown-role-badge ${isDev ? 'developer' : 'user'}`;
    }

    // 3. Update Existing Gateway UI Indicators
    if (this.elements.authStatusDot) {
      this.elements.authStatusDot.className = `status-dot ${isAuthed ? 'active' : 'unauthed'}`;
    }
    if (this.elements.authStatusLabel) {
      this.elements.authStatusLabel.textContent = isAuthed
        ? `Aktif (${role === 'developer' ? 'Developer' : 'User'})`
        : 'Belum Masuk';
    }
    if (this.elements.btnAuthToggle) {
      this.elements.btnAuthToggle.textContent = isAuthed ? 'Keluar' : '🔑 Masuk Akun';
    }
    if (this.elements.sidebarAuthStatus) {
      this.elements.sidebarAuthStatus.textContent = isAuthed ? (role === 'developer' ? 'Developer' : 'Pengguna') : 'Belum Masuk';
      this.elements.sidebarAuthStatus.className = `status-value ${isAuthed ? 'online' : 'offline'}`;
    }
    if (this.elements.btnSidebarAuth) {
      this.elements.btnSidebarAuth.textContent = isAuthed ? 'Keluar' : '🔑 Masuk Akun';
    }

    // 4. Update Navigation role visibility (F5)
    if (this.navigationManager) {
      this.navigationManager.updateRoleVisibility(role);
    }

    // 5. Update Chat Controller (F6)
    if (this.chatController) {
      this.chatController.setUserId(authService.getUserId());
      this.chatController.updateAuthStatus();
    }

    // 6. Update Settings Modal UI (I4)
    this.updateSettingsModalUI();
  }

  // --- APP SETTINGS MODAL LIFECYCLE (I4) ---
  openSettingsModal(defaultTab = 'account') {
    if (!this.elements.appSettingsModal) return;
    this.updateSettingsModalUI();
    this.switchSettingsTab(defaultTab);
    this.elements.appSettingsModal.classList.remove('hidden');
  }

  closeSettingsModal() {
    if (!this.elements.appSettingsModal) return;
    this.elements.appSettingsModal.classList.add('hidden');
  }

  switchSettingsTab(tabName) {
    const btns = this.elements.settingsTabBtns || document.querySelectorAll('.settings-tab-btn');
    const panels = this.elements.settingsTabPanels || document.querySelectorAll('.settings-tab-panel');

    btns.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tabName);
    });

    const targetPanelId = `settingsTab${tabName.charAt(0).toUpperCase() + tabName.slice(1)}`;
    panels.forEach(panel => {
      panel.classList.toggle('active', panel.id === targetPanelId);
    });
  }

  updateSettingsModalUI() {
    const isAuthed = authService.isAuthenticated();
    const role = authService.getRole();
    const user = authService.getUser();
    const email = user?.email || (isAuthed ? 'developer@visionx.local' : 'Tamu (Belum Masuk)');
    const isDev = (role === 'developer');

    if (this.elements.settingsAvatarLetter) {
      this.elements.settingsAvatarLetter.textContent = (email[0] || 'U').toUpperCase();
    }
    if (this.elements.settingsUserEmail) {
      this.elements.settingsUserEmail.textContent = email;
    }
    if (this.elements.settingsUserRole) {
      this.elements.settingsUserRole.textContent = isDev ? 'Developer' : (isAuthed ? 'Pengguna' : 'Tamu');
      this.elements.settingsUserRole.className = `settings-role-badge ${isDev ? 'developer' : (isAuthed ? 'user' : 'guest')}`;
    }
    if (this.elements.btnSettingsAuthAction) {
      this.elements.btnSettingsAuthAction.textContent = isAuthed ? 'Keluar Akun' : 'Masuk Akun';
      this.elements.btnSettingsAuthAction.className = isAuthed ? 'btn btn-outline btn-sm' : 'btn btn-primary btn-sm';
    }
    if (this.elements.tabBtnDeveloper) {
      this.elements.tabBtnDeveloper.classList.toggle('hidden', !isDev);
    }
  }

  switchAuthTab(tab) {
    this.authTabMode = tab; // 'login' | 'register' | 'forgot_password'

    if (this.elements.authModalError) this.elements.authModalError.classList.add('hidden');
    if (this.elements.authModalNotice) this.elements.authModalNotice.classList.add('hidden');

    if (tab === 'login') {
      this.elements.tabAuthLogin?.classList.add('active');
      this.elements.tabAuthRegister?.classList.remove('active');
      if (this.elements.authModalTitle) this.elements.authModalTitle.textContent = '🔐 Masuk ke VisionX';
      if (this.elements.authModalDescription) {
        this.elements.authModalDescription.textContent = 'Masuk ke akun VisionX Anda untuk menggunakan AI Vision Assistant dan sinkronisasi percakapan.';
      }
      if (this.elements.authModalTabs) this.elements.authModalTabs.classList.remove('hidden');
      if (this.elements.authModalPasswordGroup) this.elements.authModalPasswordGroup.classList.remove('hidden');
      if (this.elements.btnAuthForgotPassword) this.elements.btnAuthForgotPassword.classList.remove('hidden');
      if (this.elements.btnAuthBackToLogin) this.elements.btnAuthBackToLogin.classList.add('hidden');
      if (this.elements.authSubmitBtnText) this.elements.authSubmitBtnText.textContent = 'Masuk';
      setTimeout(() => this.elements.authModalEmailInput?.focus(), 50);
    } else if (tab === 'register') {
      this.elements.tabAuthLogin?.classList.remove('active');
      this.elements.tabAuthRegister?.classList.add('active');
      if (this.elements.authModalTitle) this.elements.authModalTitle.textContent = '📝 Daftar Akun VisionX';
      if (this.elements.authModalDescription) {
        this.elements.authModalDescription.textContent = 'Buat akun baru untuk mulai menggunakan seluruh fitur VisionX.';
      }
      if (this.elements.authModalTabs) this.elements.authModalTabs.classList.remove('hidden');
      if (this.elements.authModalPasswordGroup) this.elements.authModalPasswordGroup.classList.remove('hidden');
      if (this.elements.btnAuthForgotPassword) this.elements.btnAuthForgotPassword.classList.add('hidden');
      if (this.elements.btnAuthBackToLogin) this.elements.btnAuthBackToLogin.classList.add('hidden');
      if (this.elements.authSubmitBtnText) this.elements.authSubmitBtnText.textContent = 'Daftar Akun';
      setTimeout(() => this.elements.authModalEmailInput?.focus(), 50);
    } else if (tab === 'forgot_password') {
      if (this.elements.authModalTitle) this.elements.authModalTitle.textContent = '🔑 Lupa Password';
      if (this.elements.authModalDescription) {
        this.elements.authModalDescription.textContent = 'Masukkan alamat email akun Anda. Kami akan mengirimkan tautan untuk mengatur ulang kata sandi.';
      }
      if (this.elements.authModalTabs) this.elements.authModalTabs.classList.add('hidden');
      if (this.elements.authModalPasswordGroup) this.elements.authModalPasswordGroup.classList.add('hidden');
      if (this.elements.btnAuthForgotPassword) this.elements.btnAuthForgotPassword.classList.add('hidden');
      if (this.elements.btnAuthBackToLogin) this.elements.btnAuthBackToLogin.classList.remove('hidden');
      if (this.elements.authSubmitBtnText) this.elements.authSubmitBtnText.textContent = 'Kirim Tautan Reset';
      setTimeout(() => this.elements.authModalEmailInput?.focus(), 50);
    }
  }

  openAuthModal() {
    if (this.elements.visionxAuthModal) {
      this.elements.visionxAuthModal.classList.remove('hidden');
      if (this.elements.authModalError) this.elements.authModalError.classList.add('hidden');
      if (this.elements.authModalNotice) this.elements.authModalNotice.classList.add('hidden');
      this.switchAuthTab('login');
    }
  }

  closeAuthModal() {
    if (this.elements.visionxAuthModal) {
      this.elements.visionxAuthModal.classList.add('hidden');
      if (this.pendingAuthReject) {
        this.pendingAuthReject(new Error('Login dibatalkan oleh pengguna.'));
        this.pendingAuthResolve = null;
        this.pendingAuthReject = null;
      }
    }
  }

  promptAuthModal() {
    return new Promise((resolve, reject) => {
      this.pendingAuthResolve = resolve;
      this.pendingAuthReject = reject;
      this.openAuthModal();
    });
  }

  async handleAuthSubmit() {
    const email = this.elements.authModalEmailInput?.value?.trim() || '';
    const password = this.elements.authModalPasswordInput?.value || '';

    if (!email) {
      this._showAuthError('Silakan masukkan alamat email Anda.');
      this.elements.authModalEmailInput?.focus();
      return;
    }

    if (this.authTabMode !== 'forgot_password' && !password) {
      this._showAuthError('Silakan masukkan password.');
      this.elements.authModalPasswordInput?.focus();
      return;
    }

    if (this.authTabMode !== 'forgot_password' && password.length < 6) {
      this._showAuthError('Password minimal harus 6 karakter.');
      this.elements.authModalPasswordInput?.focus();
      return;
    }

    if (this.elements.btnSubmitAuthModal) {
      this.elements.btnSubmitAuthModal.disabled = true;
      if (this.elements.authSubmitBtnText) {
        this.elements.authSubmitBtnText.textContent = 'Memproses...';
      }
    }

    try {
      if (this.authTabMode === 'login') {
        await authService.signIn({ email, password });
        this.updateAuthStatusUI();
        if (this.elements.visionxAuthModal) {
          this.elements.visionxAuthModal.classList.add('hidden');
        }
        this.showSuccess('Berhasil masuk.');
        if (this.pendingAuthResolve) {
          this.pendingAuthResolve(true);
          this.pendingAuthResolve = null;
          this.pendingAuthReject = null;
        }
      } else if (this.authTabMode === 'register') {
        const result = await authService.signUp({ email, password });
        if (result?.session) {
          this.updateAuthStatusUI();
          if (this.elements.visionxAuthModal) {
            this.elements.visionxAuthModal.classList.add('hidden');
          }
          this.showSuccess('Pendaftaran berhasil! Anda telah masuk.');
          if (this.pendingAuthResolve) {
            this.pendingAuthResolve(true);
            this.pendingAuthResolve = null;
            this.pendingAuthReject = null;
          }
        } else {
          this._showAuthNotice('Pendaftaran berhasil! Cek email Anda untuk konfirmasi pendaftaran.');
        }
      } else if (this.authTabMode === 'forgot_password') {
        await authService.resetPassword(email);
        this._showAuthNotice('Tautan reset kata sandi telah dikirim. Silakan periksa inbox/spam email Anda.');
      }
    } catch (err) {
      let friendlyMsg = err.message || 'Terjadi kesalahan saat memproses permintaan.';
      if (friendlyMsg.includes('Invalid login credentials')) {
        friendlyMsg = 'Email atau password salah. Silakan periksa kembali.';
      } else if (friendlyMsg.includes('Email not confirmed')) {
        friendlyMsg = 'Email belum dikonfirmasi. Silakan cek tautan konfirmasi di inbox email Anda.';
      } else if (friendlyMsg.includes('User already registered')) {
        friendlyMsg = 'Alamat email ini sudah terdaftar. Silakan pilih tab Masuk.';
      }
      this._showAuthError(friendlyMsg);
    } finally {
      if (this.elements.btnSubmitAuthModal) {
        this.elements.btnSubmitAuthModal.disabled = false;
        if (this.elements.authSubmitBtnText) {
          this.elements.authSubmitBtnText.textContent =
            this.authTabMode === 'login' ? 'Masuk' :
            this.authTabMode === 'register' ? 'Daftar Akun' : 'Kirim Tautan Reset';
        }
      }
    }
  }

  _showAuthError(msg) {
    if (this.elements.authModalError && this.elements.authModalErrorMessage) {
      this.elements.authModalError.classList.remove('hidden');
      this.elements.authModalErrorMessage.textContent = msg;
    }
    if (this.elements.authModalNotice) {
      this.elements.authModalNotice.classList.add('hidden');
    }
  }

  _showAuthNotice(msg) {
    if (this.elements.authModalNotice && this.elements.authModalNoticeMessage) {
      this.elements.authModalNotice.classList.remove('hidden');
      this.elements.authModalNoticeMessage.textContent = msg;
    }
    if (this.elements.authModalError) {
      this.elements.authModalError.classList.add('hidden');
    }
  }

  showDeveloperNotice(targetMode = null) {
    if (this.elements.developerNoticeModal) {
      this.elements.developerNoticeModal.classList.remove('hidden');
      if (this.elements.devNoticeMessage) {
        const modeNames = {
          collection: 'Koleksi Dataset',
          manager: 'Dataset Manager',
          identity: 'Identity Lab'
        };
        const name = modeNames[targetMode] || 'Fitur ini';
        this.elements.devNoticeMessage.textContent = `${name} khusus untuk akun Developer`;
      }
    }
  }

  closeDeveloperNotice() {
    if (this.elements.developerNoticeModal) {
      this.elements.developerNoticeModal.classList.add('hidden');
    }
  }

  /**
   * Update visualisasi panel Object Memory di UI secara realtime (V1.1)
   */
  updateObjectMemoryUI() {
    if (!this.objectMemory) return;

    const stats = this.objectMemory.getStats();
    const activeObjects = this.objectMemory.getActiveObjects();
    const recentEvents = this.objectMemory.getRecentEvents(8);

    // 1. Update counter badges
    if (this.elements.memoryRecordsCount) {
      this.elements.memoryRecordsCount.textContent = stats.totalRecords;
    }
    if (this.elements.memoryActiveBadge) {
      this.elements.memoryActiveBadge.textContent = `${activeObjects.length} aktif`;
    }
    if (this.elements.memoryEventsCount) {
      this.elements.memoryEventsCount.textContent = `${stats.totalEvents} event`;
    }
    if (this.elements.memoryTotalObjectsVal) {
      this.elements.memoryTotalObjectsVal.textContent = stats.totalRecords;
    }
    if (this.elements.memoryLastEventTimeVal) {
      this.elements.memoryLastEventTimeVal.textContent = stats.lastEventTime || '--:--:--';
    }

    // 2. Render Current Objects Chips
    if (this.elements.memoryCurrentObjectsList) {
      if (activeObjects.length === 0) {
        this.elements.memoryCurrentObjectsList.innerHTML = '<span class="memory-empty-text">Tidak ada objek yang sedang terlihat aktif.</span>';
      } else {
        const chipsHtml = activeObjects.map(obj => `
          <div class="memory-object-chip" title="Posisi: ${obj.lastSpatialPosition}">
            <span class="chip-id">#${obj.trackId}</span>
            <span class="chip-name">${obj.className}</span>
            <span class="chip-zone">(${obj.lastSpatialPosition})</span>
          </div>
        `).join('');
        this.elements.memoryCurrentObjectsList.innerHTML = chipsHtml;
      }
    }

    // 3. Render Recent Events Log
    if (this.elements.memoryRecentEventsList) {
      if (recentEvents.length === 0) {
        this.elements.memoryRecentEventsList.innerHTML = '<span class="memory-empty-text">Belum ada rekaman aktivitas event objek.</span>';
      } else {
        const eventsHtml = recentEvents.map(evt => {
          let tagClass = 'tag-updated';
          let tagText = 'UPDATE';
          let iconSvg = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/></svg>`;

          if (evt.type === 'OBJECT_ENTERED') {
            tagClass = 'tag-entered';
            tagText = 'ENTER';
            iconSvg = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>`;
          } else if (evt.type === 'OBJECT_LEFT') {
            tagClass = 'tag-left';
            tagText = 'LEFT';
            iconSvg = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`;
          } else if (evt.type === 'OBJECT_RETURNED') {
            tagClass = 'tag-returned';
            tagText = 'RETURN';
            iconSvg = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/></svg>`;
          }

          return `
            <div class="memory-event-item">
              <span class="memory-event-icon-badge ${tagClass}" title="${tagText}">${iconSvg}</span>
              <span class="memory-event-time">${evt.timeString || ''}</span>
              <span class="memory-event-tag ${tagClass}">${tagText}</span>
              <span class="memory-event-desc">${evt.description || ''}</span>
            </div>
          `;
        }).join('');
        this.elements.memoryRecentEventsList.innerHTML = eventsHtml;
      }
    }
  }

  // =========================================================================
  // V1.2 Personal Objects UI & Handlers
  // =========================================================================

  async handleCaptureEnrollRefCam() {
    if (!this.objectEnrollment) return;
    const video = this.elements.video;
    if (!video || video.readyState < 2) {
      this.showError('Kamera belum aktif. Silakan mulai kamera terlebih dahulu.');
      return;
    }

    try {
      const angle = this.elements.refAngleSelect ? this.elements.refAngleSelect.value : 'front';
      const ref = await this.objectEnrollment.processReferenceImage({
        angle,
        sourceElement: video
      });

      this.tempEnrollmentReferences.push(ref);
      this.renderEnrollRefGallery();
      this.showSuccess(`Foto referensi (${angle}) berhasil ditambahkan (${this.tempEnrollmentReferences.length} foto).`);
    } catch (err) {
      this.showError('Gagal mengambil referensi kamera: ' + err.message);
    }
  }

  async handleUploadEnrollRefFile(files) {
    if (!this.objectEnrollment || !files || files.length === 0) return;
    const file = files[0];
    const angle = this.elements.refAngleSelect ? this.elements.refAngleSelect.value : 'front';

    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });

      const ref = await this.objectEnrollment.processReferenceImage({
        angle,
        dataUrl
      });

      this.tempEnrollmentReferences.push(ref);
      this.renderEnrollRefGallery();
      this.showSuccess(`Foto referensi (${angle}) berhasil diunggah (${this.tempEnrollmentReferences.length} foto).`);
    } catch (err) {
      this.showError('Gagal memproses file foto: ' + err.message);
    }
  }

  renderEnrollRefGallery() {
    if (!this.elements.enrollRefPreviewGallery) return;

    if (this.tempEnrollmentReferences.length === 0) {
      this.elements.enrollRefPreviewGallery.innerHTML = '<span class="empty-ref-text">Belum ada foto referensi (minimal 1, disarankan 3 sudut).</span>';
      return;
    }

    this.elements.enrollRefPreviewGallery.innerHTML = this.tempEnrollmentReferences.map((ref, idx) => `
      <div class="ref-thumb-chip">
        <span>#${idx + 1} (${ref.angle})</span>
        <button type="button" class="ref-remove-btn" onclick="window.visionXApp.removeEnrollRef(${idx})" title="Hapus foto">✕</button>
      </div>
    `).join('');
  }

  removeEnrollRef(index) {
    if (index >= 0 && index < this.tempEnrollmentReferences.length) {
      this.tempEnrollmentReferences.splice(index, 1);
      this.renderEnrollRefGallery();
    }
  }

  async handleSaveEnrolledObject() {
    if (!this.objectEnrollment) return;
    const nameInput = this.elements.enrollObjectNameInput;
    const baseClassSelect = this.elements.enrollBaseClassSelect;

    const name = nameInput ? nameInput.value.trim() : '';
    const baseClass = baseClassSelect ? baseClassSelect.value : 'laptop';

    if (!name) {
      this.showError('Nama personal objek tidak boleh kosong.');
      if (nameInput) nameInput.focus();
      return;
    }

    if (this.tempEnrollmentReferences.length === 0) {
      this.showError('Ambil minimal 1 foto referensi objek dari kamera atau upload file.');
      return;
    }

    try {
      const enrolled = await this.objectEnrollment.enrollObject({
        name,
        baseClass,
        references: this.tempEnrollmentReferences,
        threshold: this.personalObjectRecognizer ? this.personalObjectRecognizer.config.defaultThreshold : 0.75
      });

      this.showSuccess(`Objek personal "${enrolled.name}" (${enrolled.baseClass}) berhasil didaftarkan!`);

      // Reset form
      if (nameInput) nameInput.value = '';
      this.tempEnrollmentReferences = [];
      this.renderEnrollRefGallery();
      if (this.elements.enrollmentFormSection) {
        this.elements.enrollmentFormSection.classList.add('hidden');
      }

      this.updatePersonalObjectsUI();
    } catch (err) {
      this.showError('Gagal mendaftarkan objek: ' + err.message);
    }
  }

  deletePersonalObject(id) {
    if (!this.personalObjectRegistry) return;
    const obj = this.personalObjectRegistry.getById(id);
    if (!obj) return;

    if (confirm(`Hapus objek personal "${obj.name}" dari memori lokal?`)) {
      this.personalObjectRegistry.delete(id);
      if (this.personalObjectRecognizer) {
        this.personalObjectRecognizer.resetCache();
      }
      this.updatePersonalObjectsUI();
      this.showSuccess(`Objek "${obj.name}" berhasil dihapus.`);
    }
  }

  togglePersonalObjectEnabled(id) {
    if (!this.personalObjectRegistry) return;
    const obj = this.personalObjectRegistry.getById(id);
    if (!obj) return;

    const nextState = !obj.enabled;
    this.personalObjectRegistry.setEnabled(id, nextState);
    if (this.personalObjectRecognizer) {
      this.personalObjectRecognizer.resetCache();
    }
    this.updatePersonalObjectsUI();
  }

  updatePersonalObjectsUI() {
    if (!this.personalObjectRegistry) return;

    const objects = this.personalObjectRegistry.getAll();
    const stats = this.personalObjectRegistry.getStats();

    // 1. Update counter
    if (this.elements.personalObjectsCount) {
      this.elements.personalObjectsCount.textContent = stats.totalObjects;
    }

    // 2. Render cards
    if (this.elements.personalObjectsList) {
      if (objects.length === 0) {
        this.elements.personalObjectsList.innerHTML = `
          <div class="personal-empty-state">
            <span>Belum ada objek personal terdaftar. Klik "+ Register Object" untuk mendaftarkan barang Anda.</span>
          </div>
        `;
        return;
      }

      this.elements.personalObjectsList.innerHTML = objects.map(obj => {
        const isEn = obj.enabled;
        const refCount = obj.references?.length || 0;
        return `
          <div class="personal-object-card ${isEn ? 'enabled' : 'disabled'}">
            <div class="card-top-row">
              <div class="card-name-group">
                <span class="card-personal-name">★ ${obj.name}</span>
                <span class="card-base-class">Base YOLO: ${obj.baseClass}</span>
              </div>
              <div class="card-actions">
                <button type="button" class="btn btn-sm ${isEn ? 'btn-secondary' : 'btn-outline'}"
                  onclick="window.visionXApp.togglePersonalObjectEnabled('${obj.id}')"
                  title="${isEn ? 'Nonaktifkan' : 'Aktifkan'}">
                  ${isEn ? 'Active' : 'Disabled'}
                </button>
                <button type="button" class="btn btn-sm btn-outline text-danger"
                  onclick="window.visionXApp.deletePersonalObject('${obj.id}')"
                  title="Hapus objek" aria-label="Hapus objek">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="3 6 5 6 21 6"></polyline>
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                  </svg>
                </button>
              </div>
            </div>
            <div class="card-footer">
              <span>${refCount} foto referensi</span>
              <span>Threshold: ${(obj.threshold || 0.75).toFixed(2)}</span>
            </div>
          </div>
        `;
      }).join('');
    }
  }

  // ==========================================================================
  // SAFETY ALERT MANAGER (V1.3.1 UI METHODS)
  // ==========================================================================
  dismissSafetyAlert(alertId) {
    if (!this.alertManager) return;
    this.alertManager.dismissAlert(alertId);
  }

  syncSafetyAlertsUIFromConfig() {
    if (!this.alertManager) return;
    const cfg = this.alertManager.config;

    if (this.elements.toggleSafetyAlerts) {
      this.elements.toggleSafetyAlerts.checked = Boolean(cfg.safetyAlertsEnabled);
    }
    if (this.elements.toggleVoiceSafetyAlerts) {
      this.elements.toggleVoiceSafetyAlerts.checked = Boolean(cfg.voiceSafetyAlertsEnabled);
    }
    if (this.elements.togglePersistentAlerts) {
      this.elements.togglePersistentAlerts.checked = Boolean(cfg.persistentAlertsEnabled);
    }
    if (this.elements.sliderAlertCooldown) {
      const sec = Math.round((cfg.defaultCooldownMs || 10000) / 1000);
      this.elements.sliderAlertCooldown.value = sec;
      if (this.elements.alertCooldownVal) {
        this.elements.alertCooldownVal.textContent = `${sec}s`;
      }
    }
  }

  updateSafetyAlertsUI() {
    if (!this.alertManager) return;

    const alerts = this.alertManager.getAlerts();

    // 1. Update counter
    if (this.elements.safetyAlertsCount) {
      this.elements.safetyAlertsCount.textContent = alerts.length;
    }

    // 2. Render alert cards
    if (this.elements.safetyAlertsList) {
      if (alerts.length === 0) {
        this.elements.safetyAlertsList.innerHTML = `
          <div class="safety-alerts-empty">
            <span>Belum ada peringatan keselamatan aktif. Objek Anda dalam kondisi aman.</span>
          </div>
        `;
        return;
      }

      this.elements.safetyAlertsList.innerHTML = alerts.map(alert => {
        const severityClass = `severity-${(alert.severity || 'NORMAL').toLowerCase()}`;
        const badgeClass = `badge-${(alert.severity || 'NORMAL').toLowerCase()}`;
        const timeStr = new Date(alert.timestamp).toLocaleTimeString('id-ID', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit'
        });

        const isLeft = (alert.type && alert.type.includes('LEFT')) || (alert.message && alert.message.includes('tidak lagi terlihat'));
        const eventTypeClass = isLeft ? 'event-type-left' : 'event-type-update';
        const eventIconSvg = isLeft
          ? `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`
          : `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;

        return `
          <div class="safety-alert-card ${severityClass} ${eventTypeClass}" data-alert-id="${alert.id}">
            <div class="alert-card-header">
              <div class="alert-header-left">
                <span class="alert-type-icon ${eventTypeClass}">${eventIconSvg}</span>
                <span class="alert-severity-badge ${badgeClass}">${alert.severity || 'NORMAL'}</span>
                <span class="alert-card-title">${alert.title || alert.objectName || 'Objek'}</span>
              </div>
              <div class="alert-card-actions">
                <span class="alert-card-time">${timeStr}</span>
                <button type="button" class="btn-dismiss-alert" onclick="window.visionXApp.dismissSafetyAlert('${alert.id}')" title="Dismiss alert" aria-label="Hapus peringatan">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                </button>
              </div>
            </div>
            <div class="alert-card-body">
              ${alert.message}
            </div>
            <div class="alert-card-footer">
              <span class="alert-footer-chip">Event: <strong>${alert.type || 'ALERT'}</strong></span>
              <span class="alert-footer-chip">Zona: <strong>${alert.lastZone || '-'}</strong></span>
            </div>
          </div>
        `;
      }).join('');
    }
  }

  // ==========================================================================
  // UI FOUNDATION METHODS (F5 Buttons, F6 Modals, F7 Sliders)
  // ==========================================================================
  initFoundationUI() {
    // Universal modal backdrop click handler
    document.addEventListener('click', (e) => {
      const backdrop = e.target.closest('.modal-backdrop, .modal-overlay, .camera-modal-backdrop');
      if (backdrop && e.target === backdrop) {
        this.closeModalElement(backdrop);
      }
    });

    // Universal modal close button click handler
    document.addEventListener('click', (e) => {
      const closeBtn = e.target.closest('.modal-close-icon, .btn-modal-close, [data-modal-close]');
      if (closeBtn) {
        const modal = closeBtn.closest('.modal-backdrop, .modal-overlay, .camera-modal-backdrop');
        if (modal) {
          this.closeModalElement(modal);
        }
      }
    });

    // Universal slider track fill updater
    document.addEventListener('input', (e) => {
      if (e.target && e.target.matches('input[type="range"]')) {
        this.updateSliderProgress(e.target);
      }
    });
    document.addEventListener('change', (e) => {
      if (e.target && e.target.matches('input[type="range"]')) {
        this.updateSliderProgress(e.target);
      }
    });

    // Initialize all sliders, camera buttons, and modal scroll lock observer
    this.updateAllSliders();
    this.updateCameraDependentButtons(this.cameraService?.state?.status === 'connected');
    this.observeModalScrollLock();
  }

  closeTopmostModal() {
    if (this.cameraModal && this.cameraModal.isOpen) {
      this.cameraModal.close();
      this.syncModalScrollLock();
      return true;
    }
    const visibleModals = Array.from(document.querySelectorAll('.modal-backdrop:not(.hidden), .modal-overlay:not(.hidden), .camera-modal-backdrop:not(.hidden)'));
    if (visibleModals.length > 0) {
      const topModal = visibleModals[visibleModals.length - 1];
      this.closeModalElement(topModal);
      return true;
    }
    return false;
  }

  closeModalElement(modal) {
    if (!modal) return;
    if (modal.id === 'confirmModal') {
      this.closeConfirmModal();
    } else if (modal.id === 'folderImportModal') {
      this.closeFolderModal();
    } else if (modal.id === 'mgrPreviewModal') {
      if (this.elements.mgrPreviewModal) {
        this.elements.mgrPreviewModal.classList.add('hidden');
      } else {
        modal.classList.add('hidden');
      }
    } else if (modal.id === 'cameraModal' && this.cameraModal) {
      this.cameraModal.close();
    } else {
      modal.classList.add('hidden');
    }
    this.syncModalScrollLock();
  }

  syncModalScrollLock() {
    const hasOpenModal = !!document.querySelector('.modal-backdrop:not(.hidden), .modal-overlay:not(.hidden), .camera-modal-backdrop:not(.hidden)');
    document.body.classList.toggle('modal-scroll-lock', hasOpenModal);
  }

  observeModalScrollLock() {
    const observer = new MutationObserver(() => {
      this.syncModalScrollLock();
    });
    document.querySelectorAll('.modal-backdrop, .modal-overlay, .camera-modal-backdrop').forEach(el => {
      observer.observe(el, { attributes: true, attributeFilter: ['class', 'style'] });
    });
  }

  updateSliderProgress(slider) {
    if (!slider) return;
    const min = parseFloat(slider.min) || 0;
    const max = parseFloat(slider.max) || 100;
    const val = parseFloat(slider.value) || 0;
    const range = max - min;
    const pct = range === 0 ? 50 : Math.max(0, Math.min(100, ((val - min) / range) * 100));
    slider.style.setProperty('--slider-percent', `${pct}%`);
  }

  updateAllSliders() {
    document.querySelectorAll('input[type="range"]').forEach(slider => {
      this.updateSliderProgress(slider);
    });
  }

  updateCameraDependentButtons(isConnected) {
    const items = [
      { btn: this.elements.btnCapture, helper: document.getElementById('btnCaptureHelper') },
      { btn: this.elements.btnTriggerOcr, helper: document.getElementById('btnOcrHelper') },
      { btn: this.elements.btnIdLabCaptureCam, helper: document.getElementById('idLabCaptureHelper') }
    ];

    items.forEach(({ btn, helper }) => {
      if (btn) {
        if (!isConnected) {
          btn.setAttribute('disabled', 'disabled');
          btn.classList.add('disabled');
        } else {
          btn.removeAttribute('disabled');
          btn.classList.remove('disabled');
        }
      }
      if (helper) {
        if (!isConnected) {
          helper.classList.remove('hidden');
          helper.style.display = 'inline-flex';
        } else {
          helper.classList.add('hidden');
          helper.style.display = 'none';
        }
      }
    });
  }
}

// Inisialisasi Aplikasi Saat DOM Siap
window.addEventListener('DOMContentLoaded', () => {
  window.visionXApp = new VisionXWebApp();

  // PWA Service Worker: Hanya aktif di production (bukan localhost) agar tidak caching file dev
  if ('serviceWorker' in navigator && window.location.protocol.startsWith('http')) {
    if (window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
      navigator.serviceWorker.register('./sw.js').catch((err) => {
        console.warn('[VisionX] SW register warning:', err);
      });
    } else {
      // Di localhost: bersihkan service worker lama & cache browser agar perubahan langsung muncul
      navigator.serviceWorker.getRegistrations().then((regs) => {
        for (const reg of regs) reg.unregister();
      });
      if ('caches' in window) {
        caches.keys().then((keys) => {
          for (const key of keys) caches.delete(key);
        });
      }
    }
  }
});
