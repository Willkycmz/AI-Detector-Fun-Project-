/**
 * ChatController.js - VisionX Milestones 2 & 3
 * Conversational AI Agent-First Controller with IndexedDB Persistence
 *
 * Mengelola antarmuka utama Chat-First:
 * - Welcome experience & quick prompt dispatch.
 * - Message thread rendering (user & assistant bubbles, timestamps, thumbnails).
 * - Progressive SSE streaming dengan cursor animasi tanpa memblokir thread.
 * - In-memory snapshot preview container & removal.
 * - Grounding pipeline visual terverifikasi (7 golden classes, SceneHistory, OCR, Safety).
 * - Penanganan state asinkron: IDLE, SENDING, STREAMING, SUCCESS, ERROR, CANCELLED.
 * - Penanganan error ramah pengguna (401 session expired, 413 payload limit, 429 rate limit, 500 server error).
 * - IndexedDB chat storage (create session, list sessions, switch session, delete session, clear all).
 * - Status indicators (Backend, AI Provider, Vision Model) & Recent Activity tracking.
 */

import { ConversationManager } from '../services/ConversationManager.js';
import { VisionContextBuilder } from '../services/VisionContextBuilder.js';
import { ChatStorageService } from '../services/ChatStorageService.js';
import { GOLDEN_CLASSES } from './CameraModal.js';

export const ChatState = {
  IDLE: 'IDLE',
  SENDING: 'SENDING',
  STREAMING: 'STREAMING',
  SUCCESS: 'SUCCESS',
  ERROR: 'ERROR',
  CANCELLED: 'CANCELLED'
};

export class ChatController {
  /**
   * @param {Object} options
   * @param {import('../services/AIProvider.js').AIProvider} options.aiProvider
   * @param {ConversationManager} [options.conversationManager]
   * @param {ChatStorageService} [options.storageService]
   * @param {Function} [options.contextFn] Pembangun fresh VisionContext
   * @param {import('../services/SceneHistoryEngine.js').SceneHistoryEngine} [options.sceneHistoryEngine]
   * @param {import('../services/VoiceEngine.js').VoiceEngine} [options.voiceEngine]
   * @param {Function} [options.onRequireAuth] Callback pembuka modal Login PIN
   * @param {Function} [options.onOpenCameraModal] Callback pembuka Camera Modal
   */
  constructor({
    aiProvider,
    conversationManager = null,
    storageService = null,
    contextFn = null,
    sceneHistoryEngine = null,
    voiceEngine = null,
    onRequireAuth = null,
    onAuthRequired = null,
    onOpenCameraModal = null,
    onCameraModalRequested = null,
    elements = null
  } = {}) {
    this.aiProvider = aiProvider;
    this.conversationManager = conversationManager || new ConversationManager({ maxTurns: 10, defaultWindow: 6 });
    this.storageService = storageService || new ChatStorageService();
    this.contextFn = contextFn || (() => VisionContextBuilder.build());
    this.sceneHistoryEngine = sceneHistoryEngine || null;
    this.voiceEngine = voiceEngine || null;
    this.onRequireAuth = onRequireAuth || onAuthRequired || null;
    this.onOpenCameraModal = onOpenCameraModal || onCameraModalRequested || null;

    this.state = ChatState.IDLE;
    this.activeSnapshot = null; // { dataUrl, detections, width, height }
    this.abortController = null;
    this.activeStreamingMessageId = null;

    this.activeSessionId = this.conversationManager.sessionId || `sess_${Date.now()}`;
    this.activeSessionTitle = 'Percakapan Baru';
    this.recentActivities = [
      { id: 'act_1', icon: '💬', desc: 'Percakapan baru dimulai', time: '2 menit lalu' },
      { id: 'act_2', icon: '📷', desc: 'Snapshot kamera diambil', time: '5 menit lalu' },
      { id: 'act_3', icon: '🔍', desc: 'Deteksi objek aktif', time: '6 menit lalu' },
      { id: 'act_4', icon: '🤖', desc: 'Respon asisten AI', time: '8 menit lalu' }
    ];

    // DOM Elements Cache
    this.elements = {};
    this._listeners = new Map();

    if (elements) {
      this.initDOM(elements);
    }
  }

  get currentSnapshot() {
    return this.activeSnapshot ? this.activeSnapshot.dataUrl : null;
  }

  get pendingSnapshot() {
    return this.activeSnapshot;
  }

  on(event, callback) {
    if (!this._listeners.has(event)) {
      this._listeners.set(event, new Set());
    }
    this._listeners.get(event).add(callback);
    return () => this._listeners.get(event)?.delete(callback);
  }

  _emit(event, data) {
    const callbacks = this._listeners.get(event);
    if (callbacks) {
      for (const cb of callbacks) {
        try {
          cb(data);
        } catch (err) {
          console.warn(`[ChatController] Event error '${event}':`, err);
        }
      }
    }
  }

  _setState(newState, error = null) {
    this.state = newState;
    this._emit('stateChange', { state: this.state, error });
    this._updateUIState();
  }

  /**
   * Menghubungkan elemen DOM Chat ke controller
   */
  initDOM(elements = {}) {
    if (!elements) return;
    this.elements = {
      threadContainer: elements.threadContainer,
      welcomeScreen: elements.welcomeScreen,
      inputElement: elements.inputElement,
      sendButton: elements.sendButton || elements.sendBtn,
      cameraButton: elements.cameraButton || elements.cameraBtn,
      stopButton: elements.stopButton || elements.stopBtn,
      newChatButton: elements.newChatButton,
      clearButton: elements.clearButton,
      snapshotPreviewContainer: elements.snapshotPreviewContainer || elements.snapshotContainer,
      snapshotThumbnail: elements.snapshotThumbnail || elements.snapshotThumb,
      snapshotRemoveButton: elements.snapshotRemoveButton || elements.snapshotRemoveBtn,
      snapshotInfoText: elements.snapshotInfoText,
      privacyNotice: elements.privacyNotice,
      authBanner: elements.authBanner,
      authLoginBtn: elements.authLoginBtn,
      statusIndicator: elements.statusIndicator,
      statusText: elements.statusText,
      authStatusBadge: elements.authStatusBadge,
      authStatusText: elements.authStatusText,
      serverStatusBadge: elements.serverStatusBadge,
      serverStatusText: elements.serverStatusText,
      historyListContainer: elements.historyListContainer || (typeof document !== 'undefined' ? document.getElementById('sidebarChatHistory') : null),
      recentActivityList: elements.recentActivityList || (typeof document !== 'undefined' ? document.getElementById('recentActivityList') : null),
      rightPanelBackendStatus: elements.rightPanelBackendStatus || (typeof document !== 'undefined' ? document.getElementById('rightPanelBackendStatus') : null),
      rightPanelAiStatus: elements.rightPanelAiStatus || (typeof document !== 'undefined' ? document.getElementById('rightPanelAiStatus') : null),
      rightPanelModelStatus: elements.rightPanelModelStatus || (typeof document !== 'undefined' ? document.getElementById('rightPanelModelStatus') : null)
    };

    this._bindEvents();
    this.renderThread();
    this.updateAuthStatus();
    this.renderRecentActivities();

    // Inisialisasi IndexedDB dan muat riwayat sesi di background
    this.initPersistence().catch((err) => {
      console.warn('[ChatController] Non-fatal initPersistence warning:', err);
    });
  }

  _bindEvents() {
    const {
      inputElement,
      sendButton,
      cameraButton,
      stopButton,
      newChatButton,
      clearButton,
      snapshotRemoveButton,
      welcomeScreen
    } = this.elements;

    // Kirim pesan via Enter (Shift+Enter untuk newline)
    if (inputElement) {
      inputElement.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          this.sendMessage();
        }
      });
      // Auto-resize textarea jika multi-line
      inputElement.addEventListener('input', () => {
        if (inputElement.tagName === 'TEXTAREA') {
          inputElement.style.height = 'auto';
          inputElement.style.height = Math.min(inputElement.scrollHeight, 140) + 'px';
        }
      });
    }

    if (sendButton) {
      sendButton.addEventListener('click', (e) => {
        e.preventDefault();
        this.sendMessage();
      });
    }

    if (cameraButton) {
      cameraButton.addEventListener('click', (e) => {
        e.preventDefault();
        if (typeof this.onOpenCameraModal === 'function') {
          this.onOpenCameraModal();
        }
      });
    }

    if (stopButton) {
      stopButton.addEventListener('click', (e) => {
        e.preventDefault();
        this.stopGeneration();
      });
    }

    if (newChatButton) {
      newChatButton.addEventListener('click', (e) => {
        e.preventDefault();
        this.newChat();
      });
    }

    if (clearButton) {
      clearButton.addEventListener('click', (e) => {
        e.preventDefault();
        this.newChat();
      });
    }

    if (snapshotRemoveButton) {
      snapshotRemoveButton.addEventListener('click', (e) => {
        e.preventDefault();
        this.removeSnapshot();
      });
    }

    // Quick Prompts dalam Welcome Screen
    if (welcomeScreen) {
      welcomeScreen.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-prompt]');
        if (btn) {
          const prompt = btn.getAttribute('data-prompt');
          if (prompt) {
            this.sendQuickPrompt(prompt);
          }
        }
      });
    }
  }

  /**
   * Inisialisasi IndexedDB dan muat riwayat sesi obrolan
   */
  async initPersistence() {
    try {
      await this.storageService.init();
      const sessions = await this.storageService.getSessions();
      if (sessions && sessions.length > 0) {
        this.renderHistoryList(sessions);
        if (this.conversationManager.isEmpty()) {
          await this.loadSession(sessions[0].id);
        }
      } else {
        // Buat record sesi aktif awal di storage
        await this.storageService.createSession(this.activeSessionId, 'Percakapan Baru');
        this.renderHistoryList([{ id: this.activeSessionId, title: 'Percakapan Baru', updatedAt: Date.now() }]);
      }
    } catch (err) {
      console.warn('[ChatController] initPersistence warning:', err);
    }
  }

  /**
   * Render daftar riwayat obrolan di sidebar
   * @param {Array<Object>} sessions
   */
  renderHistoryList(sessions = []) {
    const container = this.elements.historyListContainer;
    if (!container) return;

    container.innerHTML = '';
    if (!sessions || sessions.length === 0) {
      const emptyDiv = document.createElement('div');
      emptyDiv.className = 'chat-history-empty';
      emptyDiv.textContent = 'Belum ada riwayat percakapan.';
      container.appendChild(emptyDiv);
      return;
    }

    sessions.forEach((s) => {
      const item = document.createElement('div');
      const isActive = (s.id === this.activeSessionId);
      item.className = `chat-history-item ${isActive ? 'active' : ''}`;
      item.setAttribute('role', 'button');
      item.setAttribute('tabindex', '0');
      item.setAttribute('data-session-id', s.id);
      item.setAttribute('aria-label', `Muat obrolan: ${s.title}`);

      const timeText = this._formatRelativeTime(s.updatedAt || s.createdAt);

      item.innerHTML = `
        <span class="item-icon">💬</span>
        <div class="item-info">
          <span class="item-label">${this._escapeAndFormatText(s.title || 'Percakapan')}</span>
          <span class="item-time">${timeText}</span>
        </div>
        <button type="button" class="btn-delete-session" data-delete-id="${s.id}" title="Hapus percakapan" aria-label="Hapus percakapan">🗑️</button>
      `;

      // Klik sesi untuk load
      item.addEventListener('click', (e) => {
        if (e.target.closest('.btn-delete-session')) return;
        this.loadSession(s.id);
      });

      // Tombol hapus sesi
      const delBtn = item.querySelector('.btn-delete-session');
      if (delBtn) {
        delBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.deleteSession(s.id);
        });
      }

      container.appendChild(item);
    });

    // Tombol "Hapus semua data" di bawah list riwayat
    const clearWrap = document.createElement('div');
    clearWrap.className = 'history-clear-all-wrap';
    clearWrap.innerHTML = `
      <button type="button" class="btn-clear-all-chats" id="btnClearAllHistory" aria-label="Hapus semua riwayat percakapan">
        <span>Hapus semua data</span>
      </button>
    `;
    const btnClearAll = clearWrap.querySelector('#btnClearAllHistory');
    if (btnClearAll) {
      btnClearAll.addEventListener('click', () => this.clearAllHistory());
    }
    container.appendChild(clearWrap);
  }

  /**
   * Memuat sesi yang dipilih dari IndexedDB ke thread chat
   * @param {string} sessionId
   */
  async loadSession(sessionId) {
    if (!sessionId) return;
    this.stopGeneration();
    this.activeSessionId = sessionId;

    try {
      const sess = await this.storageService.getSession(sessionId);
      if (sess) {
        this.activeSessionTitle = sess.title;
      }
      const messages = await this.storageService.getMessages(sessionId);
      const turns = messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        timestamp: m.timestamp,
        snapshotRef: m.snapshotThumbnail || null,
        provider: m.metadata?.provider,
        latencyMs: m.metadata?.latencyMs
      }));

      this.conversationManager.loadTurns(turns, sessionId);
      this.renderThread();
      this.removeSnapshot();

      // Refresh list session state
      const sessions = await this.storageService.getSessions();
      this.renderHistoryList(sessions);
    } catch (err) {
      console.warn('[ChatController] Gagal memuat sesi:', err);
    }
  }

  /**
   * Menghapus sesi tertentu dari IndexedDB
   * @param {string} sessionId
   */
  async deleteSession(sessionId) {
    if (!sessionId) return;
    try {
      await this.storageService.deleteSession(sessionId);
      if (this.activeSessionId === sessionId) {
        this.newChat();
      } else {
        const sessions = await this.storageService.getSessions();
        this.renderHistoryList(sessions);
      }
    } catch (err) {
      console.warn('[ChatController] Gagal menghapus sesi:', err);
    }
  }

  /**
   * Menghapus seluruh riwayat percakapan dengan konfirmasi
   */
  async clearAllHistory() {
    let confirmed = true;
    if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
      confirmed = window.confirm('Apakah Anda yakin ingin menghapus semua riwayat percakapan? Tindakan ini tidak dapat dibatalkan.');
    }
    if (!confirmed) return;

    try {
      await this.storageService.clearAllData();
      this.newChat();
      this.renderHistoryList([]);
    } catch (err) {
      console.warn('[ChatController] Gagal menghapus semua data:', err);
    }
  }

  /**
   * Menetapkan snapshot yang baru saja diambil dari CameraModal
   * @param {Object|string} snapshotData { dataUrl, detections, width, height } atau dataUrl string
   * @param {Array} [detections=null]
   */
  setSnapshot(snapshotData, detections = null) {
    if (!snapshotData) return;

    let dataUrl = '';
    let dets = [];
    let width = 640;
    let height = 480;

    if (typeof snapshotData === 'string') {
      dataUrl = snapshotData;
      dets = Array.isArray(detections) ? detections : [];
    } else if (typeof snapshotData === 'object' && snapshotData.dataUrl) {
      dataUrl = snapshotData.dataUrl;
      dets = Array.isArray(snapshotData.detections) ? snapshotData.detections : (detections || []);
      width = snapshotData.width || 640;
      height = snapshotData.height || 480;
    } else {
      return;
    }

    this.activeSnapshot = { dataUrl, detections: dets, width, height };

    const {
      snapshotPreviewContainer,
      snapshotThumbnail,
      snapshotInfoText,
      privacyNotice,
      inputElement
    } = this.elements;

    const doc = typeof document !== 'undefined' ? document : null;
    const container = snapshotPreviewContainer || doc?.getElementById('snapshotPreviewContainer');
    if (container) {
      container.classList.remove('hidden');
    }

    const thumb = snapshotThumbnail || doc?.getElementById('snapshotThumbnail');
    if (thumb) {
      thumb.src = dataUrl;
    }

    if (privacyNotice) {
      privacyNotice.classList.remove('hidden');
    }

    if (snapshotInfoText) {
      const objCount = dets.length;
      snapshotInfoText.textContent = `Snapshot siap (${width}×${height}) • ${objCount} objek`;
    }

    this.logActivity('Camera snapshot', 'Barusan');

    // Fokuskan input pesan agar user siap mengetik pertanyaan
    if (inputElement) {
      inputElement.focus();
    }
  }

  /**
   * Menghapus snapshot aktif dari input form
   */
  removeSnapshot() {
    this.activeSnapshot = null;
    const { snapshotPreviewContainer, snapshotThumbnail, snapshotInfoText, privacyNotice } = this.elements;

    const doc = typeof document !== 'undefined' ? document : null;
    const container = snapshotPreviewContainer || doc?.getElementById('snapshotPreviewContainer');
    if (container) {
      container.classList.add('hidden');
    }
    const thumb = snapshotThumbnail || doc?.getElementById('snapshotThumbnail');
    if (thumb) {
      thumb.src = '';
    }
    if (privacyNotice) {
      privacyNotice.classList.add('hidden');
    }
    if (snapshotInfoText) {
      snapshotInfoText.textContent = '';
    }
  }

  /**
   * Alias untuk removeSnapshot
   */
  clearSnapshot() {
    this.removeSnapshot();
  }

  /**
   * Memulai sesi obrolan baru
   */
  newChat() {
    this.stopGeneration();
    this.conversationManager.clear();
    this.activeSessionId = this.conversationManager.sessionId;
    this.activeSessionTitle = 'Percakapan Baru';
    this.removeSnapshot();
    this.renderThread();
    this._setState(ChatState.IDLE);

    if (this.elements.inputElement) {
      this.elements.inputElement.value = '';
      this.elements.inputElement.focus();
    }

    this.storageService.getSessions().then((s) => this.renderHistoryList(s)).catch(() => {});
    this.logActivity('New chat started', 'Barusan');
  }

  /**
   * Mengirim pertanyaan cepat dari Welcome chip
   * @param {string} promptText
   */
  sendQuickPrompt(promptText) {
    if (this.elements.inputElement) {
      this.elements.inputElement.value = promptText;
    }
    return this.sendMessage(promptText);
  }

  /**
   * Alias untuk pengiriman pesan dari tombol kirim
   */
  handleSend() {
    return this.sendMessage();
  }

  /**
   * Mengirim pesan chat pengguna ke VisionX AI Gateway
   * @param {string|Object|null} [options=null]
   */
  async sendMessage(options = null) {
    if (this.state === ChatState.SENDING || this.state === ChatState.STREAMING) {
      return;
    }

    let overrideText = null;
    if (typeof options === 'string') {
      overrideText = options;
    } else if (options && typeof options === 'object') {
      if (options.text !== undefined) overrideText = options.text;
      if (options.image) {
        this.setSnapshot(options.image, options.detections);
      }
    }

    const inputVal = (overrideText !== null)
      ? String(overrideText)
      : (this.elements.inputElement ? this.elements.inputElement.value : '');

    let text = inputVal.trim();

    // Jika mengirim tanpa teks tapi ada snapshot, gunakan default deterministik
    if (!text && this.activeSnapshot) {
      text = 'Analisis gambar ini.';
    }

    if (!text) {
      if (this.elements.inputElement) this.elements.inputElement.focus();
      return;
    }

    this.abortController = new AbortController();
    const currentAbortController = this.abortController;

    // Bersihkan field input
    if (this.elements.inputElement) {
      this.elements.inputElement.value = '';
      if (this.elements.inputElement.tagName === 'TEXTAREA') {
        this.elements.inputElement.style.height = 'auto';
      }
    }

    // Ambil snapshot referensi saat ini dan reset form preview
    const snapshotToSend = this.activeSnapshot ? { ...this.activeSnapshot } : null;
    this.removeSnapshot();

    // 1. Tambahkan pesan pengguna ke ConversationManager segera untuk zero-latency UI
    const snapshotThumbnailUrl = snapshotToSend?.dataUrl || null;
    const userTurn = this.conversationManager.appendUserMessage(
      text,
      null,
      snapshotThumbnailUrl
    );

    // 2. Render pesan pengguna segera di DOM
    this.renderThread();
    this.scrollToBottom();

    // 3. Ekstrak fresh visual context saat ini
    let currentContext = null;
    try {
      currentContext = await Promise.resolve(this.contextFn());
      if (userTurn && currentContext) {
        userTurn.context = currentContext;
      }
    } catch (_) {
      currentContext = VisionContextBuilder.build();
    }

    if (currentAbortController.signal.aborted) {
      this._setState(ChatState.CANCELLED);
      return;
    }

    // 4. Pastikan session dan judul tersimpan di IndexedDB
    try {
      const existingSession = await this.storageService.getSession(this.activeSessionId);
      const derivedTitle = text.length > 32 ? text.substring(0, 32) + '...' : text;

      if (!existingSession) {
        this.activeSessionTitle = derivedTitle;
        await this.storageService.createSession(this.activeSessionId, derivedTitle);
      } else if (existingSession.title === 'Percakapan Baru' || !existingSession.title) {
        this.activeSessionTitle = derivedTitle;
        await this.storageService.updateSession(this.activeSessionId, { title: derivedTitle });
      }

      await this.storageService.saveMessage({
        id: userTurn.id,
        sessionId: this.activeSessionId,
        role: 'user',
        content: userTurn.content,
        timestamp: userTurn.timestamp,
        snapshotThumbnail: snapshotThumbnailUrl
      });

      this.storageService.getSessions().then((s) => this.renderHistoryList(s)).catch(() => {});
    } catch (storageErr) {
      console.warn('[ChatController] Storage user save error (non-blocking):', storageErr);
    }

    // 5. Siapkan streaming assistant turn
    this._setState(ChatState.SENDING);

    const assistantTurnId = `turn_a_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
    this.activeStreamingMessageId = assistantTurnId;

    this._appendStreamingAssistantBubble(assistantTurnId);
    this.scrollToBottom();

    this._setState(ChatState.STREAMING);

    const startTime = performance.now();
    let accumulatedText = '';

    try {
      // Periksa apakah ini query perbandingan temporal deterministik (SceneHistoryEngine)
      const qLow = text.toLowerCase();
      if (!snapshotToSend && this.sceneHistoryEngine && this._isTemporalQuestion(qLow)) {
        const delta = this.sceneHistoryEngine.computeDelta(15);
        if (delta && delta.narrative) {
          accumulatedText = delta.narrative;
          this._simulateLocalStream(assistantTurnId, accumulatedText);
          const latencyMs = Math.round(performance.now() - startTime);

          this.conversationManager.appendAssistantMessage(accumulatedText, {
            provider: 'visionx-temporal-engine',
            latencyMs,
            context: currentContext
          });

          this._finalizeAssistantBubble(assistantTurnId, accumulatedText, 'visionx-temporal-engine', latencyMs);
          this._setState(ChatState.SUCCESS);

          // Simpan assistant turn ke storage
          await this.storageService.saveMessage({
            id: assistantTurnId,
            sessionId: this.activeSessionId,
            role: 'assistant',
            content: accumulatedText,
            timestamp: Date.now(),
            metadata: { provider: 'visionx-temporal-engine', latencyMs }
          }).catch(() => {});

          this.logActivity('Chat response', 'Barusan');
          return;
        }
      }

      // Format deteksi YOLO terverifikasi untuk dikirimkan
      let verifiedDetections = null;
      if (snapshotToSend && Array.isArray(snapshotToSend.detections)) {
        verifiedDetections = snapshotToSend.detections;
      } else if (currentContext && Array.isArray(currentContext.detections)) {
        verifiedDetections = currentContext.detections.map(d => ({
          class_name: String(d.class_name || d.className || 'object').toLowerCase(),
          confidence: Number(typeof d.confidence === 'number' ? d.confidence.toFixed(2) : 0),
          relative_position: d.relative_position || d.spatialZone || 'tengah'
        }));
      }

      // Ambil riwayat percakapan terkini (sliding window 6 turns)
      const recentTurns = this.conversationManager.getRecentTurns(6);

      // Kirim ke AI Gateway dengan SSE progresif
      const response = await this.aiProvider.askVision({
        image: snapshotToSend?.dataUrl || null,
        context: currentContext,
        question: text,
        detections: verifiedDetections,
        conversationHistory: recentTurns,
        signal: currentAbortController.signal,
        onChunk: (chunk, fullText) => {
          accumulatedText = fullText;
          this._updateStreamingBubbleText(assistantTurnId, accumulatedText);
          this.scrollToBottom();
        }
      });

      const latencyMs = Math.round(performance.now() - startTime);
      const finalText = accumulatedText || response.answer || 'Tidak ada respons yang diterima.';

      // Simpan turn asisten ke ConversationManager
      this.conversationManager.appendAssistantMessage(finalText, {
        provider: response.provider || 'visionx-gateway',
        latencyMs,
        context: currentContext
      });

      this._finalizeAssistantBubble(assistantTurnId, finalText, response.provider || 'visionx-gateway', latencyMs);
      this._setState(ChatState.SUCCESS);

      // Simpan assistant turn ke IndexedDB
      await this.storageService.saveMessage({
        id: assistantTurnId,
        sessionId: this.activeSessionId,
        role: 'assistant',
        content: finalText,
        timestamp: Date.now(),
        metadata: { provider: response.provider || 'visionx-gateway', latencyMs }
      }).catch(() => {});

      this.storageService.getSessions().then((s) => this.renderHistoryList(s)).catch(() => {});
      this.logActivity('Chat response', 'Barusan');

      // Opsional bersuara jika VoiceEngine aktif
      if (this.voiceEngine && this.voiceEngine.isEnabled && this.voiceEngine.speak) {
        this.voiceEngine.speak(finalText);
      }
    } catch (err) {
      const latencyMs = Math.round(performance.now() - startTime);
      console.warn('[ChatController] Error saat proses chat:', err);

      let isCancelled = (err.name === 'AbortError') || (err.message && err.message.includes('dihentikan oleh pengguna'));
      let friendlyError = this.createFriendlyError(err);

      if (err.status === 401 || (err.message && (err.message.includes('Autentikasi') || err.message.includes('401') || err.message.includes('kedaluwarsa') || err.message.includes('Unauthorized')))) {
        this.updateAuthStatus(false);
        if (this.elements.authBanner) {
          this.elements.authBanner.classList.remove('hidden');
        }
        if (typeof this.onRequireAuth === 'function') {
          this.onRequireAuth();
        }
      }

      this.conversationManager.appendAssistantMessage(friendlyError, {
        provider: 'system-error',
        latencyMs
      });

      if (isCancelled) {
        this._setState(ChatState.CANCELLED);
        this._renderErrorAssistantBubble(assistantTurnId, accumulatedText + ' [Pemberhentian oleh pengguna]');
      } else {
        this._setState(ChatState.ERROR, friendlyError);
        this._renderErrorAssistantBubble(assistantTurnId, friendlyError, true);
      }
    } finally {
      this.abortController = null;
      this.activeStreamingMessageId = null;
    }
  }

  /**
   * Menghentikan generasi streaming yang sedang berjalan
   */
  stopGeneration() {
    if (this.abortController) {
      try {
        this.abortController.abort();
      } catch (_) {}
      this.abortController = null;
    }
    this._setState(ChatState.CANCELLED);
  }

  /**
   * Mengonversi error teknis menjadi pesan deskriptif Bahasa Indonesia yang informatif
   * @param {Error|Object|string} err
   * @returns {string}
   */
  createFriendlyError(err) {
    if (!err) return 'Terjadi gangguan saat memproses jawaban.';
    const msg = typeof err === 'string' ? err : (err.message || '');
    const status = err.status || 0;

    if (status === 401 || msg.includes('401') || msg.includes('Autentikasi') || msg.includes('Unauthorized') || msg.includes('kedaluwarsa')) {
      return 'Sesi autentikasi telah kedaluwarsa atau tidak valid (HTTP 401). Silakan login kembali dengan PIN akses VisionX.';
    }
    if (status === 413 || msg.includes('413') || msg.includes('terlalu besar') || msg.includes('melebihi batas')) {
      return 'Ukuran gambar atau payload melebihi batas (HTTP 413).';
    }
    if (status === 429 || msg.includes('429') || msg.includes('Rate limit') || msg.includes('terkunci') || msg.includes('frekuensi')) {
      return 'Batas frekuensi permintaan tercapai (HTTP 429). Harap tunggu beberapa saat sebelum bertanya lagi.';
    }
    if (status === 500 || msg.includes('500') || msg.includes('internal') || msg.includes('kendala')) {
      return 'Terjadi kendala pada gateway VisionX (HTTP 500). Silakan coba sesaat lagi.';
    }
    if (msg.includes('timeout')) {
      return 'Waktu permintaan AI habis (Timeout). Periksa koneksi backend Anda.';
    }
    if (msg.includes('Failed to fetch') || msg.includes('NetworkError') || msg.includes('offline') || msg.includes('jaringan') || msg.includes('tidak terhubung')) {
      return 'Gagal terhubung ke backend server VisionX. Pastikan server online dan koneksi jaringan stabil.';
    }
    return msg || 'Terjadi gangguan saat memproses jawaban.';
  }

  /**
   * Render seluruh thread pesan dari ConversationManager ke DOM
   */
  renderThread() {
    const { threadContainer, welcomeScreen } = this.elements;
    if (!threadContainer) return;

    const turns = this.conversationManager.getAllTurns();

    if (turns.length === 0) {
      if (welcomeScreen) {
        welcomeScreen.classList.remove('hidden');
      }
      threadContainer.innerHTML = '';
      return;
    }

    if (welcomeScreen) {
      welcomeScreen.classList.add('hidden');
    }

    threadContainer.innerHTML = '';

    turns.forEach((turn) => {
      const bubble = this._createMessageBubble(turn);
      threadContainer.appendChild(bubble);
    });

    this.scrollToBottom();
  }

  /**
   * Membuat elemen DOM bubble percakapan
   * @private
   */
  _createMessageBubble(turn) {
    const isUser = (turn.role === 'user');
    const item = document.createElement('div');
    item.className = `chat-message-item ${isUser ? 'message-user' : 'message-assistant'}`;
    item.id = turn.id;

    const timeStr = this._formatTime(turn.timestamp);

    let snapshotHtml = '';
    if (turn.snapshotRef) {
      const src = (typeof turn.snapshotRef === 'string') ? turn.snapshotRef : turn.snapshotRef.dataUrl;
      if (src) {
        snapshotHtml = `
          <div class="message-snapshot-wrapper">
            <img src="${src}" alt="Snapshot kamera" class="message-snapshot-img" />
          </div>
        `;
      }
    }

    let metaHtml = '';
    if (!isUser) {
      const provider = turn.provider || 'visionx-gateway';
      const lat = turn.latencyMs ? `${turn.latencyMs}ms` : '';
      metaHtml = `
        <div class="message-meta-row">
          <span class="message-provider-tag">${provider}</span>
          ${lat ? `<span class="message-latency-tag">⚡ ${lat}</span>` : ''}
          <button type="button" class="btn-bubble-action btn-copy-msg" title="Salin pesan" data-msg-id="${turn.id}">📋</button>
          <button type="button" class="btn-bubble-action btn-speak-msg" title="Bacakan suara" data-msg-id="${turn.id}">🔊</button>
        </div>
      `;
    }

    item.innerHTML = `
      <div class="message-bubble-header">
        <span class="message-sender">${isUser ? '👤 Anda' : '🤖 VisionX AI'}</span>
        <span class="message-timestamp">${timeStr}</span>
      </div>
      ${snapshotHtml}
      <div class="message-content">${this._escapeAndFormatText(turn.content)}</div>
      ${metaHtml}
    `;

    // Pasang listener copy & speak
    const copyBtn = item.querySelector('.btn-copy-msg');
    if (copyBtn) {
      copyBtn.addEventListener('click', () => {
        if (navigator.clipboard) {
          navigator.clipboard.writeText(turn.content);
          copyBtn.textContent = '✅';
          setTimeout(() => copyBtn.textContent = '📋', 1500);
        }
      });
    }

    const speakBtn = item.querySelector('.btn-speak-msg');
    if (speakBtn) {
      speakBtn.addEventListener('click', () => {
        if (this.voiceEngine && this.voiceEngine.speak) {
          this.voiceEngine.speak(turn.content);
        }
      });
    }

    return item;
  }

  /**
   * Membuat bubble asisten streaming yang diperbarui progresif
   * @private
   */
  _appendStreamingAssistantBubble(turnId) {
    const { threadContainer, welcomeScreen } = this.elements;
    if (welcomeScreen) welcomeScreen.classList.add('hidden');

    const item = document.createElement('div');
    item.className = 'chat-message-item message-assistant streaming-active';
    item.id = turnId;

    item.innerHTML = `
      <div class="message-bubble-header">
        <span class="message-sender">🤖 VisionX AI</span>
        <span class="message-timestamp">${this._formatTime(Date.now())}</span>
      </div>
      <div class="message-content" id="${turnId}_content">
        <span class="streaming-cursor"></span>
      </div>
      <div class="message-meta-row" id="${turnId}_meta">
        <span class="message-streaming-status">Sedang mengetik...</span>
      </div>
    `;

    threadContainer.appendChild(item);
    return item;
  }

  /**
   * Update teks bubble saat chunk SSE masuk
   * @private
   */
  _updateStreamingBubbleText(turnId, text) {
    const contentEl = document.getElementById(`${turnId}_content`);
    if (contentEl) {
      contentEl.innerHTML = `${this._escapeAndFormatText(text)}<span class="streaming-cursor"></span>`;
    }
  }

  /**
   * Finalisasi bubble asisten setelah [DONE]
   * @private
   */
  _finalizeAssistantBubble(turnId, finalText, provider, latencyMs) {
    const bubble = document.getElementById(turnId);
    if (!bubble) return;

    bubble.classList.remove('streaming-active');
    const contentEl = document.getElementById(`${turnId}_content`);
    if (contentEl) {
      contentEl.innerHTML = this._escapeAndFormatText(finalText);
    }

    const metaEl = document.getElementById(`${turnId}_meta`);
    if (metaEl) {
      metaEl.innerHTML = `
        <span class="message-provider-tag">${provider || 'visionx-gateway'}</span>
        <span class="message-latency-tag">⚡ ${latencyMs}ms</span>
        <button type="button" class="btn-bubble-action btn-copy-msg" title="Salin pesan">📋</button>
        <button type="button" class="btn-bubble-action btn-speak-msg" title="Bacakan suara">🔊</button>
      `;

      const copyBtn = metaEl.querySelector('.btn-copy-msg');
      if (copyBtn) {
        copyBtn.addEventListener('click', () => {
          if (navigator.clipboard) {
            navigator.clipboard.writeText(finalText);
            copyBtn.textContent = '✅';
            setTimeout(() => copyBtn.textContent = '📋', 1500);
          }
        });
      }

      const speakBtn = metaEl.querySelector('.btn-speak-msg');
      if (speakBtn) {
        speakBtn.addEventListener('click', () => {
          if (this.voiceEngine && this.voiceEngine.speak) {
            this.voiceEngine.speak(finalText);
          }
        });
      }
    }
  }

  /**
   * Render pesan error di bubble asisten
   * @private
   */
  _renderErrorAssistantBubble(turnId, errorMessage, isFatal = false) {
    const bubble = document.getElementById(turnId);
    if (!bubble) return;

    bubble.classList.remove('streaming-active');
    bubble.classList.add('message-error-bubble');

    const contentEl = document.getElementById(`${turnId}_content`);
    if (contentEl) {
      contentEl.innerHTML = `
        <div class="chat-inline-error">
          <span class="error-badge">⚠️ Gagal</span>
          <p class="error-text">${this._escapeAndFormatText(errorMessage)}</p>
        </div>
      `;
    }

    const metaEl = document.getElementById(`${turnId}_meta`);
    if (metaEl) {
      metaEl.innerHTML = `<span class="message-error-tag">Error</span>`;
    }
  }

  /**
   * Simulasi streaming lokal untuk respon deterministik
   * @private
   */
  _simulateLocalStream(turnId, fullText) {
    const contentEl = document.getElementById(`${turnId}_content`);
    if (contentEl) {
      contentEl.innerHTML = this._escapeAndFormatText(fullText);
    }
  }

  /**
   * Scroll otomatis ke pesan terbawah
   */
  scrollToBottom() {
    const scrollArea = (typeof document !== 'undefined') ? document.getElementById('chatScrollArea') : null;
    if (scrollArea) {
      scrollArea.scrollTop = scrollArea.scrollHeight;
    }
    const { threadContainer } = this.elements;
    if (threadContainer) {
      threadContainer.scrollTop = threadContainer.scrollHeight;
    }
  }

  /**
   * Catat aktivitas ke recent activity panel
   */
  logActivity(desc, time = 'Barusan') {
    let icon = '💬';
    const low = desc.toLowerCase();
    if (low.includes('camera') || low.includes('snapshot')) icon = '📷';
    else if (low.includes('detection') || low.includes('objek')) icon = '🔍';
    else if (low.includes('chat') || low.includes('response')) icon = '🤖';

    this.recentActivities.unshift({
      id: `act_${Date.now()}`,
      icon,
      desc,
      time
    });
    if (this.recentActivities.length > 8) {
      this.recentActivities.pop();
    }
    this.renderRecentActivities();
  }

  /**
   * Render daftar Recent Activity di panel kanan
   */
  renderRecentActivities() {
    const listEl = this.elements.recentActivityList;
    if (!listEl) return;
    listEl.innerHTML = '';
    this.recentActivities.slice(0, 4).forEach((act) => {
      const row = document.createElement('div');
      row.className = 'activity-item-row';
      row.innerHTML = `
        <span class="activity-icon">${act.icon}</span>
        <div class="activity-details">
          <span class="activity-desc">${this._escapeAndFormatText(act.desc)}</span>
          <span class="activity-time">${act.time}</span>
        </div>
      `;
      listEl.appendChild(row);
    });
  }

  /**
   * Sinkronkan status autentikasi ke UI sidebar / badge
   */
  updateAuthStatus(isAuth = null) {
    const active = (isAuth !== null) ? isAuth : (this.aiProvider && this.aiProvider.isAuthenticated && this.aiProvider.isAuthenticated());
    const { authStatusBadge, authStatusText } = this.elements;

    if (authStatusBadge) {
      authStatusBadge.className = `badge ${active ? 'badge-auth-active' : 'badge-auth-inactive'}`;
    }
    if (authStatusText) {
      authStatusText.textContent = active ? 'Terautentikasi' : 'Login Diperlukan';
    }
  }

  /**
   * Sinkronkan status server gateway ke UI
   */
  updateServerStatus(isOnline, label = null) {
    const defaultLabel = isOnline ? 'Server aktif' : 'Server offline';
    const finalLabel = label || defaultLabel;
    const { serverStatusBadge, serverStatusText, rightPanelBackendStatus } = this.elements;
    if (serverStatusBadge) {
      serverStatusBadge.className = `badge ${isOnline ? 'badge-server-online' : 'badge-server-offline'}`;
    }
    if (serverStatusText) {
      serverStatusText.textContent = finalLabel;
    }
    if (rightPanelBackendStatus) {
      rightPanelBackendStatus.textContent = finalLabel;
    }
    if (typeof document !== 'undefined') {
      const headerPill = document.getElementById('headerServerStatusPill');
      const headerText = document.getElementById('headerServerStatusText');
      if (headerText) {
        headerText.textContent = finalLabel;
      }
      if (headerPill) {
        const dot = headerPill.querySelector('.status-dot');
        if (dot) {
          dot.className = `status-dot ${isOnline ? 'green' : 'red'}`;
        }
      }
    }
  }

  _updateUIState() {
    const { sendButton, stopButton, inputElement } = this.elements;
    const isBusy = (this.state === ChatState.SENDING || this.state === ChatState.STREAMING);

    if (sendButton) {
      sendButton.disabled = isBusy;
    }
    if (stopButton) {
      stopButton.classList.toggle('hidden', !isBusy);
    }
    if (inputElement && !isBusy) {
      inputElement.disabled = false;
    }
  }

  _isTemporalQuestion(query) {
    return query.includes('berubah') ||
           query.includes('tadi') ||
           query.includes('sebelumnya') ||
           query.includes('baru muncul') ||
           query.includes('hilang') ||
           query.includes('pindah');
  }

  _formatTime(timestamp) {
    if (!timestamp) return '';
    try {
      const d = new Date(timestamp);
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch (_) {
      return '';
    }
  }

  _formatRelativeTime(timestamp) {
    if (!timestamp) return 'Barusan';
    const diffMs = Date.now() - Number(timestamp);
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 1) return 'Barusan';
    if (diffMins === 1) return '1 menit lalu';
    if (diffMins < 60) return `${diffMins} menit lalu`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours} jam lalu`;
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays === 1) return 'Kemarin';
    return `${diffDays} hari lalu`;
  }

  _escapeAndFormatText(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    let safe = div.innerHTML;

    // Format markdown bold **teks**
    safe = safe.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    // Format line breaks
    safe = safe.replace(/\n/g, '<br/>');
    return safe;
  }
}
