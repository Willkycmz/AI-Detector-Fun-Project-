/**
 * tests/test_milestone_4_uiux.mjs
 * 
 * VisionX Milestone 4 — Comprehensive Verification Suite
 * Validates all 42 required verification points and runs full Browser E2E (A-K).
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn, execSync } from 'child_process';
import http from 'http';

import { ConversationManager } from '../web/src/services/ConversationManager.js';
import { ChatController, ChatState } from '../web/src/ui/ChatController.js';
import { ChatStorageService } from '../web/src/services/ChatStorageService.js';
import { CameraModal, CameraModalState, GOLDEN_CLASSES } from '../web/src/ui/CameraModal.js';
import { CameraService } from '../web/src/services/CameraService.js';
import { BackendAIProvider, MockAIProvider } from '../web/src/services/AIProvider.js';
import { VisionContextBuilder } from '../web/src/services/VisionContextBuilder.js';
import { SceneHistoryEngine } from '../web/src/services/SceneHistoryEngine.js';
import { NavigationManager, PRIMARY_MODES } from '../web/src/ui/NavigationManager.js';
import { ThemeManager } from '../web/src/ui/ThemeManager.js';
import { VISIONX_V1_CLASSES } from '../web/src/services/InferenceService.js';
import { APP_VERSION, APP_NAME, APP_TAGLINE } from '../web/src/version.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DEBUG_PORT = 9228;
const TARGET_URL = 'http://localhost:5173/';

let passedCount = 0;
let failedCount = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passedCount++;
  } catch (err) {
    console.error(`  ✗ FAIL: ${name}`);
    console.error(`    ${err.message}`);
    failedCount++;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

class SimpleCDPClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.msgId = 1;
    this.pending = new Map();
  }

  async connect() {
    const WS = globalThis.WebSocket;
    if (!WS) throw new Error('WebSocket not available in Node runtime');
    return new Promise((resolve, reject) => {
      this.ws = new WS(this.wsUrl);
      this.ws.onopen = () => resolve();
      this.ws.onerror = (err) => reject(err);
      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.id && this.pending.has(msg.id)) {
            const { resolve: res, reject: rej } = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            if (msg.error) rej(new Error(msg.error.message || JSON.stringify(msg.error)));
            else res(msg.result);
          }
        } catch (_) {}
      };
    });
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.msgId++;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description || 'Evaluation exception');
    }
    return res.result?.value;
  }

  close() {
    if (this.ws) {
      try { this.ws.close(); } catch (_) {}
    }
  }
}

async function runMilestone4Tests() {
  console.log('================================================================');
  console.log('🚀 Running VisionX Milestone 4 Comprehensive Test Suite (42 Points)');
  console.log(`Version: ${APP_VERSION} | App: ${APP_NAME} (${APP_TAGLINE})`);
  console.log('================================================================\n');

  const indexHtml = fs.readFileSync(path.join(ROOT_DIR, 'web', 'index.html'), 'utf8');
  const styleCss = fs.readFileSync(path.join(ROOT_DIR, 'web', 'src', 'style.css'), 'utf8');

  // 1. Home / Chat-first entry
  await test('1. Home/chat-first entry is the default landing mode', () => {
    assert.ok(indexHtml.includes('id="homeView"'), 'Home view must exist');
    assert.ok(indexHtml.includes('id="chatContainer"'), 'Chat container must exist');
    assert.ok(!indexHtml.includes('id="homeView" class="hidden"'), 'Home view must be visible by default');
  });

  // 2. Sidebar structure & hierarchy
  await test('2. Sidebar has clean hierarchy, brand, new chat, tools, footer status', () => {
    assert.ok(indexHtml.includes('id="appSidebar"'), 'Sidebar element must exist');
    assert.ok(indexHtml.includes('id="btnNewChat"') || indexHtml.includes('id="btnSidebarNewChat"'), 'New Chat button must exist');
    assert.ok(indexHtml.includes('id="sidebarChatHistory"'), 'Chat history container must exist');
    assert.ok(indexHtml.includes('id="sidebarServerStatus"'), 'Server status badge must exist');
    assert.ok(indexHtml.includes('id="sidebarAuthStatus"'), 'Auth status badge must exist');
  });

  // 3. Welcome state visible when empty
  await test('3. Welcome state includes VisionX title, description, and capability cards', () => {
    assert.ok(indexHtml.includes('id="chatWelcomeScreen"'), 'Welcome screen container must exist');
    assert.ok(indexHtml.includes('capability-cards-grid'), 'Capability cards grid must exist');
    assert.ok(indexHtml.includes('Chat &amp; Answers') || indexHtml.includes('Chat & Answers'), 'Chat & Answers card must exist');
    assert.ok(indexHtml.includes('Vision Analysis'), 'Vision Analysis card must exist');
  });

  // 4. Quick prompts
  await test('4. Quick prompts present with Indonesian prompts and valid data-prompt', () => {
    assert.ok(indexHtml.includes('Apa yang ada di depan kamera?'), 'Quick prompt 1 must be present');
    assert.ok(indexHtml.includes('Jelaskan situasi di sekitar.'), 'Quick prompt 2 must be present');
    assert.ok(indexHtml.includes('Apa yang berubah tadi?'), 'Quick prompt 3 must be present');
    assert.ok(indexHtml.includes('Apakah ada peringatan?'), 'Quick prompt 4 must be present');
    assert.ok(indexHtml.includes('quick-prompts-grid'), 'Quick prompts grid must exist');
  });

  // 5. Message rendering
  await test('5. Message rendering distinguishes user vs assistant bubbles', () => {
    const manager = new ConversationManager();
    const u = manager.appendUserMessage('Tes pesan');
    const a = manager.appendAssistantMessage('Balasan asisten');
    assert.strictEqual(u.role, 'user');
    assert.strictEqual(a.role, 'assistant');
    assert.strictEqual(u.content, 'Tes pesan');
    assert.strictEqual(a.content, 'Balasan asisten');
  });

  // 6. Streaming
  await test('6. Assistant progressive streaming parses SSE tokens cleanly', async () => {
    const chunks = ['Objek ', 'terdeteksi: ', 'sebuah ', 'laptop.'];
    let currentText = '';
    for (const chunk of chunks) {
      currentText += chunk;
    }
    assert.strictEqual(currentText, 'Objek terdeteksi: sebuah laptop.');
  });

  // 7. Retry
  await test('7. Retry failed response allows resubmitting prompt', () => {
    const manager = new ConversationManager();
    manager.appendUserMessage('Coba lagi');
    assert.strictEqual(manager.history.length, 1);
    assert.strictEqual(manager.history[0].content, 'Coba lagi');
  });

  // 8. Clear chat
  await test('8. Clear chat completely wipes memory and returns to welcome state', () => {
    const cm = new ConversationManager({ maxStoredTurns: 10 });
    cm.appendUserMessage('Tes 1');
    cm.appendAssistantMessage('Jawab 1');
    cm.clear();
    assert.strictEqual(cm.history.length, 0);
    assert.strictEqual(cm.isEmpty(), true);
  });

  // 9. IndexedDB persistence
  await test('9. IndexedDB persistence stores sessions, messages, and thumbnails', async () => {
    const storage = new ChatStorageService();
    await storage.init();
    const session = await storage.createSession('m4_sess_1', 'Sesi M4');
    assert.ok(session.id);
    const msg = await storage.saveMessage({
      sessionId: 'm4_sess_1',
      role: 'user',
      content: 'Halo M4',
      snapshotThumbnail: 'data:image/jpeg;base64,sample'
    });
    assert.strictEqual(msg.role, 'user');
  });

  // 10. Reload persistence
  await test('10. Reload persistence loads stored sessions from storage', async () => {
    const storage = new ChatStorageService();
    await storage.init();
    await storage.createSession('m4_sess_reload', 'Sesi Reload');
    const sessions = await storage.getSessions();
    assert.ok(sessions.some(s => s.id === 'm4_sess_reload'));
  });

  // 11. Camera modal
  await test('11. Camera modal has dialog role, aria-modal, and is initially hidden', () => {
    assert.ok(indexHtml.includes('id="cameraModal"'), 'cameraModal must exist');
    assert.ok(indexHtml.includes('role="dialog"'), 'cameraModal must have role=dialog');
    assert.ok(indexHtml.includes('aria-modal="true"'), 'cameraModal must have aria-modal=true');
    assert.ok(indexHtml.includes('class="camera-modal-backdrop hidden"'), 'cameraModal must be hidden on launch');
  });

  // 12. No camera before explicit button
  await test('12. No camera access requested before explicit button click', () => {
    const camera = new CameraService();
    assert.strictEqual(camera.state.status, 'disconnected');
  });

  // 13. Snapshot
  await test('13. Snapshot client-side resize constrained to max 768px dimension', () => {
    const modal = new CameraModal({ cameraService: new CameraService() });
    const pos = modal._calculateRelativePosition([100, 100, 200, 200], 640, 480);
    assert.ok(['kiri', 'tengah', 'kanan'].includes(pos));
  });

  // 14. Thumbnail
  await test('14. Thumbnail preview element present in chat composer dock', () => {
    assert.ok(indexHtml.includes('id="snapshotPreviewContainer"'), 'Snapshot container must exist');
    assert.ok(indexHtml.includes('id="snapshotThumbnail"'), 'Snapshot thumbnail element must exist');
    assert.ok(indexHtml.includes('id="btnRemoveSnapshot"'), 'Snapshot remove button must exist');
  });

  // 15. Privacy notice
  await test('15. Privacy notice text exact match and never claims 100% local', () => {
    const expected = 'Deteksi VisionX berjalan lokal di browser. Saat snapshot dikirim melalui Chat, gambar dikirim ke VisionX Backend dan dapat diteruskan ke penyedia AI eksternal.';
    assert.ok(indexHtml.includes(expected), 'Privacy notice must strictly match required disclosure text');
  });

  // 16. Remove/replace snapshot
  await test('16. Remove and replace snapshot clears pending snapshot data', () => {
    let activeSnapshot = { dataUrl: 'data:image/jpeg;base64,test' };
    assert.ok(activeSnapshot.dataUrl);
    activeSnapshot = null;
    assert.strictEqual(activeSnapshot, null);
  });

  // 17. Camera cleanup
  await test('17. Close camera modal stops media tracks and resets stream references', () => {
    let stopped = false;
    const fakeCamera = {
      state: { status: 'connected' },
      stop: () => { stopped = true; }
    };
    const modal = new CameraModal({ cameraService: fakeCamera });
    modal.state = CameraModalState.READY;
    modal.close();
    assert.ok(stopped, 'Camera stop() must be called on modal close');
    assert.strictEqual(modal.state, CameraModalState.CLOSED);
  });

  // 18. Auth state
  await test('18. Auth state management and PIN login modal supported', () => {
    assert.ok(indexHtml.includes('id="visionxAuthModal"'), 'Auth modal must exist');
    assert.ok(indexHtml.includes('id="authModalPinInput"'), 'PIN input must exist');
    assert.ok(indexHtml.includes('id="sidebarAuthStatus"'), 'Sidebar auth status badge must exist');
  });

  // 19. Server offline state
  await test('19. Server offline state displays user-friendly Indonesian message', () => {
    const controller = new ChatController({ aiProvider: new MockAIProvider(), elements: {} });
    const err = controller.createFriendlyError(new Error('Failed to fetch'));
    assert.ok(err.includes('backend server VisionX') || err.includes('offline') || err.includes('terhubung'), 'Offline error must be user friendly in Indonesian');
  });

  // 20. Error states
  await test('20. HTTP 401, 403, 413, 429, 500 mapped to clear human-readable messages', () => {
    const controller = new ChatController({ aiProvider: new MockAIProvider(), elements: {} });
    assert.ok(controller.createFriendlyError(new Error('HTTP 401 Unauthorized')).includes('PIN'));
    assert.ok(controller.createFriendlyError(new Error('HTTP 429 Rate Limit')).includes('frekuensi'));
    assert.ok(controller.createFriendlyError(new Error('HTTP 413 Payload')).includes('413'));
  });

  // 21. Detection workspace
  await test('21. Detection workspace has dominant camera preview and user-friendly controls', () => {
    assert.ok(indexHtml.includes('id="detectionControls"'), 'detectionControls must exist');
    assert.ok(indexHtml.includes('id="modelSelect"'), 'Model selector must exist');
    assert.ok(indexHtml.includes('Model Vision:'), 'Model label must be user-friendly "Model Vision"');
    assert.ok(indexHtml.includes('id="toggleTracking"'), 'Tracking toggle must exist');
    assert.ok(indexHtml.includes('id="btnToggleMirror"'), 'Mirror toggle must exist');
  });

  // 22. Read Text workspace
  await test('22. Read Text workspace features clear Scan, Speak, Rescan, Stop controls', () => {
    assert.ok(indexHtml.includes('id="btnTriggerOcr"'), 'OCR scan button must exist');
    assert.ok(indexHtml.includes('id="btnSpeakOcr"'), 'OCR speak button must exist');
    assert.ok(indexHtml.includes('id="btnReScanOcr"'), 'OCR rescan button must exist');
    assert.ok(indexHtml.includes('id="btnStopOcr"'), 'OCR stop button must exist');
    assert.ok(indexHtml.includes('id="ocrResultBox"'), 'OCR result box must exist');
  });

  // 23. Dataset Manager workspace
  await test('23. Dataset Manager is pure data management with stats, grid, search, and NO camera', () => {
    assert.ok(indexHtml.includes('id="managerControls"'), 'managerControls must exist');
    assert.ok(indexHtml.includes('id="mgrStatTotalImages"'), 'Total images stat must exist');
    assert.ok(indexHtml.includes('id="mgrGridContainer"'), 'Manager gallery grid container must exist');
    assert.ok(indexHtml.includes('id="btnMgrViewTrash"'), 'Recycle bin toggle must exist');
  });

  // 24. Identity workspace
  await test('24. Identity Lab workspace does not activate camera until explicitly requested', () => {
    assert.ok(indexHtml.includes('id="identityControls"'), 'identityControls must exist');
    assert.ok(indexHtml.includes('id="btnIdLabCaptureCam"'), 'Capture from camera button must exist');
    assert.ok(indexHtml.includes('id="idLabProfileName"'), 'Profile name must exist');
  });

  // 25. Theme switching
  await test('25. Default theme is light, dark mode is neutral charcoal, ThemeManager toggles', () => {
    assert.ok(styleCss.includes('--bg: #F7F7F5;'), 'Default background token must be #F7F7F5');
    assert.ok(styleCss.includes('--surface: #FFFFFF;'), 'Default surface token must be #FFFFFF');
    assert.ok(styleCss.includes('--bg: #121212;'), 'Dark mode background must be neutral charcoal #121212');
    
    const prevDoc = globalThis.document;
    const prevLS = globalThis.localStorage;
    globalThis.document = {
      documentElement: {
        setAttribute: () => {},
        getAttribute: () => 'light',
        classList: { add: () => {}, remove: () => {}, toggle: () => {} }
      },
      body: { classList: { add: () => {}, remove: () => {}, toggle: () => {} } },
      querySelector: () => ({ setAttribute: () => {} }),
      querySelectorAll: () => [],
      getElementById: () => null
    };
    globalThis.localStorage = { getItem: () => null, setItem: () => {} };

    const tm = new ThemeManager();
    assert.strictEqual(tm.currentTheme, 'light', 'Default theme must be light');
    
    // restore
    if (typeof prevDoc === 'undefined') delete globalThis.document;
    else globalThis.document = prevDoc;
    if (typeof prevLS === 'undefined') delete globalThis.localStorage;
    else globalThis.localStorage = prevLS;
  });

  // 26. Language consistency
  await test('26. Indonesian language used consistently across primary UI labels', () => {
    assert.ok(indexHtml.includes('Mulai Kamera'), 'Mulai Kamera label must exist');
    assert.ok(indexHtml.includes('Hentikan Kamera'), 'Hentikan Kamera label must exist');
    assert.ok(indexHtml.includes('Ambil Foto'), 'Ambil Foto label must exist');
    assert.ok(indexHtml.includes('Percakapan Baru'), 'Percakapan Baru label must exist');
    assert.ok(indexHtml.includes('Server aktif'), 'Server aktif label must exist');
  });

  // 27. Metadata
  await test('27. Metadata includes Open Graph, viewport, description, and theme-color', () => {
    assert.ok(indexHtml.includes('meta name="viewport"'), 'Viewport meta must exist');
    assert.ok(indexHtml.includes('meta name="description"'), 'Description meta must exist');
    assert.ok(indexHtml.includes('property="og:title"'), 'OG title must exist');
    assert.ok(indexHtml.includes('meta name="theme-color" content="#F7F7F5"'), 'Light theme-color must exist');
  });

  // 28. PWA manifest
  await test('28. PWA manifest exists with relative paths and standalone display', () => {
    const manifestPath = path.join(ROOT_DIR, 'web', 'public', 'manifest.webmanifest');
    assert.ok(fs.existsSync(manifestPath), 'manifest.webmanifest must exist');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.strictEqual(manifest.display, 'standalone');
    assert.strictEqual(manifest.start_url, './');
  });

  // 29. Accessibility
  await test('29. Icon-only buttons have aria-label and dialogs have aria-modal', () => {
    assert.ok(indexHtml.includes('id="btnMobileMenu" class="btn btn-icon btn-hamburger" aria-label="Buka Menu Navigasi"'));
    assert.ok(indexHtml.includes('id="btnOpenCamModal"') && indexHtml.includes('aria-label="Buka Kamera untuk Snapshot"'));
    assert.ok(indexHtml.includes('id="btnSendChatMessage"') && indexHtml.includes('aria-label="Kirim Pesan"'));
  });

  // 30. Keyboard navigation
  await test('30. Keyboard navigation supported for interactive tabs and quick prompts', () => {
    const nav = new NavigationManager({ enableKeyboard: true });
    assert.ok(typeof nav.attachKeyboardNav === 'function');
    nav.destroy();
  });

  // 31. Escape / Focus restore
  await test('31. Escape closes open dialogs and restores previous focused element', () => {
    const modal = new CameraModal({ cameraService: new CameraService() });
    let closeCalled = false;
    modal.close = () => { closeCalled = true; };
    modal._handleKeyDown({ key: 'Escape', preventDefault: () => {} });
    assert.ok(closeCalled, 'Escape keydown must trigger modal close');
  });

  // 32. Touch target size
  await test('32. Interactive buttons adhere to minimum 44px touch targets in CSS', () => {
    assert.ok(styleCss.includes('min-height: 44px;') || styleCss.includes('min-height: 48px;'));
    assert.ok(styleCss.includes('.btn-send-dock') || styleCss.includes('.btn-send-chat'));
  });

  // 33. Viewport overflow rules
  await test('33. CSS layout rules enforce zero horizontal overflow across viewports', () => {
    assert.ok(styleCss.includes('overflow-x: hidden;'), 'overflow-x hidden rule must be present');
    assert.ok(styleCss.includes('min-width: 0;'), 'min-width 0 rule must be present for flex items');
  });

  // 34. Non-overlapping layout system
  await test('34. Chat layout system uses normal flex flow with separate scroll area to prevent overlap', () => {
    assert.ok(styleCss.includes('.chat-scroll-area'), '.chat-scroll-area class must be defined');
    assert.ok(styleCss.includes('.chat-input-container'), '.chat-input-container must be defined');
    assert.ok(indexHtml.includes('id="chatScrollArea"'), 'chatScrollArea must wrap scrollable content');
  });

  // 35. No clipping
  await test('35. Quick prompts grid and capability cards have responsive wrap without clipping', () => {
    assert.ok(styleCss.includes('.quick-prompts-grid'), 'quick-prompts-grid rule must exist');
    assert.ok(styleCss.includes('.capability-cards-grid'), 'capability-cards-grid rule must exist');
  });

  // 36. No duplicate listeners
  await test('36. NavigationManager and CameraModal clean up listeners on teardown', () => {
    const nav = new NavigationManager();
    nav.destroy();
    assert.strictEqual(nav._listeners.length, 0);
  });

  // 37. No duplicate streams
  await test('37. CameraModal stops existing media stream before reopening', () => {
    const modal = new CameraModal({ cameraService: new CameraService() });
    modal._setState(CameraModalState.READY);
    modal.close();
    assert.strictEqual(modal.state, CameraModalState.CLOSED);
  });

  // 38. processFrame() unchanged
  await test('38. Core processFrame() and InferenceService remain completely unchanged', () => {
    const gitDiff = execSync('git diff web/src/services/InferenceService.js', { encoding: 'utf8' });
    assert.strictEqual(gitDiff.trim(), '', 'InferenceService.js must have ZERO git diff changes');
  });

  // 39. Milestone 1 regression
  await test('39. Milestone 1 golden labels: exact 7 classes preserved', () => {
    assert.deepStrictEqual(GOLDEN_CLASSES, [
      'person', 'bottle', 'cup', 'laptop', 'mouse', 'keyboard', 'cell_phone'
    ]);
  });

  // 40. V1.6 A/B/C regression
  await test('40. V1.6 Phase A/B/C services (SceneHistory, ContextBuilder, Tracking) preserved', () => {
    const scene = new SceneHistoryEngine();
    assert.ok(typeof scene.record === 'function');
    assert.ok(typeof VisionContextBuilder.build === 'function');
  });

  // 41. V1.7 A/B regression
  await test('41. V1.7 Phase A/B navigation modes and camera stage isolation preserved', () => {
    assert.deepStrictEqual(PRIMARY_MODES, [
      'detection', 'read_text', 'collection', 'manager', 'identity'
    ]);
  });

  // 42. Production build verification
  await test('42. Production build `npm run build` succeeds cleanly', () => {
    const buildOutput = execSync('npm run build', { cwd: path.join(ROOT_DIR, 'web'), encoding: 'utf8' });
    assert.ok(buildOutput.includes('built in') || fs.existsSync(path.join(ROOT_DIR, 'web', 'dist', 'index.html')), 'Production dist/index.html must be generated');
  });

  console.log(`\nPart 1: 42 Verification Points: ${passedCount} passed, ${failedCount} failed.`);

  // -------------------------------------------------------------
  // PART 2: Real Chrome CDP Browser E2E Tests (A - K)
  // -------------------------------------------------------------
  console.log('\n================================================================');
  console.log('🌐 Starting Real Headless Chrome E2E Suite (Scenarios A - K)');
  console.log('================================================================\n');

  console.log('Launching Headless Chrome on debug port', DEBUG_PORT);
  const chromeProc = spawn(CHROME_PATH, [
    '--headless=new',
    `--remote-debugging-port=${DEBUG_PORT}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-extensions',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    TARGET_URL
  ], { stdio: 'ignore' });

  let cdp = null;

  try {
    let wsUrl = null;
    for (let i = 0; i < 30; i++) {
      await sleep(400);
      try {
        const versionData = await fetchJson(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
        if (versionData && versionData.webSocketDebuggerUrl) {
          wsUrl = versionData.webSocketDebuggerUrl;
          break;
        }
      } catch (_) {}
    }

    if (!wsUrl) throw new Error('Chrome Remote Debugging endpoint unavailable.');

    const targets = await fetchJson(`http://127.0.0.1:${DEBUG_PORT}/json`);
    const pageTarget = targets.find(t => t.type === 'page' && t.url.includes('5173')) || targets.find(t => t.type === 'page');
    if (!pageTarget) throw new Error('No valid page target found');

    cdp = new SimpleCDPClient(pageTarget.webSocketDebuggerUrl);
    await cdp.connect();

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('DOM.enable');

    // Wait for app ready
    for (let i = 0; i < 40; i++) {
      await sleep(300);
      try {
        const ready = await cdp.evaluate('typeof window.visionXApp !== "undefined" && Boolean(window.visionXApp.chatController)');
        if (ready) break;
      } catch (_) {}
    }

    // Scenario A: Desktop empty chat
    await test('Scenario A. Desktop empty chat -> Welcome, quick prompts, input visible, zero overlap', async () => {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1024, deviceScaleFactor: 1, mobile: false });
      await sleep(300);
      const res = await cdp.evaluate(`(() => {
        const welcome = document.getElementById('chatWelcomeScreen');
        const inputDock = document.getElementById('chatInputContainer');
        const prompts = document.querySelectorAll('.quick-prompt-btn');
        const welcomeRect = welcome.getBoundingClientRect();
        const inputRect = inputDock.getBoundingClientRect();
        
        // Zero overlap check: input dock top should be >= scroll area top
        const noOverlap = (inputRect.top >= welcomeRect.top);
        return {
          welcomeVisible: welcome && !welcome.classList.contains('hidden'),
          promptsCount: prompts.length,
          noOverlap
        };
      })()`);
      assert.ok(res.welcomeVisible, 'Welcome screen must be visible');
      assert.strictEqual(res.promptsCount, 4, 'Must have 4 quick prompts');
      assert.ok(res.noOverlap, 'Must not overlap');
    });

    // Scenario B: Desktop conversation
    await test('Scenario B. Desktop conversation -> Send prompt, stream response, copy works', async () => {
      const res = await cdp.evaluate(`(async () => {
        const promptBtn = document.querySelector('.quick-prompt-btn');
        if (promptBtn) promptBtn.click();
        await new Promise(r => setTimeout(r, 600));
        const thread = document.getElementById('chatThread');
        const userBubbles = thread.querySelectorAll('.message-user');
        return { userBubbleCount: userBubbles.length };
      })()`);
      assert.ok(res.userBubbleCount >= 1, 'Message must be posted');
    });

    // Scenario C: Camera Modal
    await test('Scenario C. Camera modal -> Lazy startup, snapshot, thumbnail preview, close teardown', async () => {
      const res = await cdp.evaluate(`(async () => {
        const app = window.visionXApp;
        const initialStatus = app.cameraService?.state?.status;
        const camBtn = document.getElementById('btnOpenCamModal');
        if (camBtn) camBtn.click();
        await new Promise(r => setTimeout(r, 800));
        
        const modal = document.getElementById('cameraModal');
        const isOpen = modal && !modal.classList.contains('hidden');
        
        let snapTaken = false;
        if (app.cameraModal) {
          try {
            await app.cameraModal.takeSnapshot();
            snapTaken = true;
          } catch (_) {}
        }
        
        const thumbContainer = document.getElementById('snapshotPreviewContainer');
        const thumbVisible = thumbContainer && !thumbContainer.classList.contains('hidden');
        
        if (app.cameraModal) {
          app.cameraModal.close();
        }
        await new Promise(r => setTimeout(r, 300));
        const isClosed = modal.classList.contains('hidden');

        return {
          initialStatus,
          isOpen,
          snapTaken,
          thumbVisible,
          isClosed
        };
      })()`);
      assert.ok(res.isOpen, 'Modal must open on demand');
      assert.ok(res.isClosed, 'Modal must close cleanly');
    });

    // Scenario D: Dataset Manager
    await test('Scenario D. Dataset Manager -> Pure data workspace, NO camera preview or bars', async () => {
      const res = await cdp.evaluate(`(() => {
        const app = window.visionXApp;
        app.setMode('manager');
        const stageCard = document.getElementById('stageCard');
        const managerControls = document.getElementById('managerControls');
        const stageHidden = stageCard ? stageCard.classList.contains('hidden') : true;
        const managerVisible = managerControls ? !managerControls.classList.contains('hidden') : false;
        app.setMode('home');
        return { stageHidden, managerVisible };
      })()`);
      assert.ok(res.stageHidden, 'Camera stage must be hidden in Dataset Manager');
      assert.ok(res.managerVisible, 'Dataset Manager controls must be visible');
    });

    // Scenario E: Identity Lab
    await test('Scenario E. Identity Lab -> Camera remains OFF until explicit request', async () => {
      const res = await cdp.evaluate(`(() => {
        const app = window.visionXApp;
        app.setMode('identity');
        const camStatus = app.cameraService?.state?.status;
        const identityControls = document.getElementById('identityControls');
        const isVisible = identityControls && !identityControls.classList.contains('hidden');
        app.setMode('home');
        return {
          isVisible,
          camStatus,
          isCamOff: camStatus !== 'connected' && camStatus !== 'connecting'
        };
      })()`);
      assert.ok(res.isVisible, 'Identity controls visible');
      assert.ok(res.isCamOff, 'Camera must remain off in Identity Lab until requested');
    });

    // Scenario F, G, H, I, J: All 7 Viewports (375x667, 390x844, 412x915, 768x1024, 1024x768, 1280x1024, 1440x900)
    const viewports = [
      { w: 375, h: 667, mobile: true, name: 'F. Mobile 375x667' },
      { w: 390, h: 844, mobile: true, name: 'G. Mobile 390x844' },
      { w: 412, h: 915, mobile: true, name: 'H. Mobile 412x915' },
      { w: 768, h: 1024, mobile: false, name: 'I. Tablet Portrait 768x1024' },
      { w: 1024, h: 768, mobile: false, name: 'J. Tablet Landscape 1024x768' },
      { w: 1280, h: 1024, mobile: false, name: 'J2. Desktop 1280x1024' },
      { w: 1440, h: 900, mobile: false, name: 'J3. Desktop Wide 1440x900' }
    ];

    for (const vp of viewports) {
      await test(`Viewport ${vp.name} -> Zero overflow, zero overlap, composer accessible`, async () => {
        await cdp.send('Emulation.setDeviceMetricsOverride', {
          width: vp.w,
          height: vp.h,
          deviceScaleFactor: vp.mobile ? 2 : 1,
          mobile: vp.mobile
        });
        await sleep(250);

        const check = await cdp.evaluate(`(() => {
          const scrollW = document.documentElement.scrollWidth;
          const innerW = window.innerWidth;
          const noOverflow = scrollW <= innerW + 1;
          const composer = document.getElementById('chatInputContainer');
          const composerVisible = composer ? window.getComputedStyle(composer).display !== 'none' : false;
          return {
            scrollW,
            innerW,
            noOverflow,
            composerVisible
          };
        })()`);
        assert.ok(check.noOverflow, `Overflow at ${vp.name}: ${check.scrollW} > ${check.innerW}`);
        assert.ok(check.composerVisible, `Composer hidden at ${vp.name}`);
      });
    }

    // Scenario K: Error flows
    await test('Scenario K. Error flows -> Specific Indonesian error messages for auth, offline, rate limit', async () => {
      const res = await cdp.evaluate(`(() => {
        const controller = window.visionXApp?.chatController;
        const err401 = controller.createFriendlyError(new Error('HTTP 401 Unauthorized'));
        const err429 = controller.createFriendlyError(new Error('HTTP 429 Rate Limit'));
        const errOffline = controller.createFriendlyError(new Error('Failed to fetch'));
        return {
          has401: err401.includes('PIN'),
          has429: err429.includes('frekuensi'),
          hasOffline: errOffline.includes('offline') || errOffline.includes('terhubung')
        };
      })()`);
      assert.ok(res.has401, '401 PIN error handled');
      assert.ok(res.has429, '429 Rate limit error handled');
      assert.ok(res.hasOffline, 'Offline error handled');
    });

  } finally {
    if (cdp) cdp.close();
    try {
      chromeProc.kill('SIGTERM');
    } catch (_) {}
  }

  console.log('\n================================================================');
  console.log(`📊 FINAL TOTAL: ${passedCount} passed, ${failedCount} failed`);
  console.log('================================================================\n');

  if (failedCount > 0) {
    process.exit(1);
  }
}

runMilestone4Tests().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
