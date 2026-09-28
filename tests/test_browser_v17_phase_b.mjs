/**
 * test_browser_v17_phase_b.mjs - Real Browser E2E Test for VisionX V1.7 Phase B
 * Tests Dataset Manager Cleanup, Camera UI Isolation, and Lifecycle Teardown in Headless Chrome via CDP.
 */

import { spawn } from 'child_process';
import http from 'http';

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DEBUG_PORT = 9229;
const TARGET_URL = 'http://localhost:5173/';

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
    return new Promise((resolve, reject) => {
      this.ws = new WS(this.wsUrl);
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
      this.ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.id && this.pending.has(data.id)) {
          const { resolve, reject } = this.pending.get(data.id);
          this.pending.delete(data.id);
          if (data.error) reject(new Error(data.error.message));
          else resolve(data.result);
        }
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

  close() {
    if (this.ws) this.ws.close();
  }
}

async function run() {
  console.log('================================================================');
  console.log('🌐 Starting Real Browser E2E Test for VisionX V1.7 Phase B');
  console.log('================================================================');

  let viteProc = null;
  let isRunning = false;
  try {
    await fetchJson('http://localhost:5173/');
    isRunning = true;
  } catch (_) {
    isRunning = false;
  }

  if (!isRunning) {
    console.log('Starting Vite server for E2E testing...');
    viteProc = spawn('npx', ['vite', '--port', '5173'], {
      cwd: 'c:\\Users\\advan\\Documents\\VisionX\\web',
      shell: true,
      stdio: 'ignore'
    });
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      try {
        const ping = await new Promise((res, rej) => {
          const req = http.get('http://localhost:5173/', (r) => res(r.statusCode));
          req.on('error', rej);
        });
        if (ping === 200) {
          console.log('Vite server ready!');
          break;
        }
      } catch (_) {}
    }
  }

  console.log('Launching Headless Chrome on debug port', DEBUG_PORT);
  const chromeProc = spawn(CHROME_PATH, [
    '--headless=new',
    `--remote-debugging-port=${DEBUG_PORT}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    TARGET_URL
  ], { stdio: 'ignore' });

  let cdp = null;
  const consoleErrors = [];

  try {
    let targets = null;
    for (let i = 0; i < 30; i++) {
      await sleep(300);
      try {
        targets = await fetchJson(`http://127.0.0.1:${DEBUG_PORT}/json`);
        if (targets && targets.length > 0) break;
      } catch (e) {}
    }

    if (!targets || targets.length === 0) {
      throw new Error('Could not connect to Chrome CDP targets');
    }

    const pageTarget = targets.find(t => t.type === 'page');
    if (!pageTarget || !pageTarget.webSocketDebuggerUrl) {
      throw new Error('No page target found');
    }

    cdp = new SimpleCDPClient(pageTarget.webSocketDebuggerUrl);
    await cdp.connect();

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    console.log('Waiting for VisionX web application to initialize...');
    let appReady = false;
    for (let i = 0; i < 40; i++) {
      await sleep(300);
      const evalRes = await cdp.send('Runtime.evaluate', {
        expression: 'typeof window.visionXApp !== "undefined" && window.visionXApp.cameraService !== null',
        returnByValue: true
      });
      if (evalRes?.result?.value === true) {
        appReady = true;
        break;
      }
    }

    if (!appReady) {
      throw new Error('window.visionXApp did not initialize within 12 seconds');
    }

    console.log('✅ Application loaded. Starting Phase B Browser E2E Verification...');

    // 1. Enter Detection & verify camera UI bars are present
    console.log('\n[Scenario 1] Home → Detection');
    const s1Res = await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        window.visionXApp.setMode('detection', { startCamera: false });
        const stage = document.getElementById('stageCard');
        const primaryBar = document.querySelector('.primary-hero-bar');
        const summaryBar = document.querySelector('.current-result-summary-bar');
        const secondaryBar = document.querySelector('.secondary-controls-bar');
        return {
          currentMode: window.visionXApp.currentMode,
          stageVisible: stage && !stage.classList.contains('hidden'),
          primaryBarVisible: primaryBar && !primaryBar.classList.contains('hidden'),
          summaryBarVisible: summaryBar && !summaryBar.classList.contains('hidden'),
          secondaryBarVisible: secondaryBar && !secondaryBar.classList.contains('hidden')
        };
      })()`,
      returnByValue: true
    });
    console.log('Detection State:', s1Res.result.value);
    const s1 = s1Res.result.value;
    if (s1.currentMode !== 'detection') throw new Error('Expected detection mode');
    if (!s1.stageVisible) throw new Error('Expected stageCard to be visible in detection');
    if (!s1.primaryBarVisible) throw new Error('Expected primary-hero-bar to be visible in detection');
    if (!s1.summaryBarVisible) throw new Error('Expected current-result-summary-bar to be visible in detection');
    if (!s1.secondaryBarVisible) throw new Error('Expected secondary-controls-bar to be visible in detection');
    console.log('  ✅ Scenario 1 PASSED: Detection camera bars visible');

    // 2. Detection → Manager: Verify Complete Camera UI Isolation
    console.log('\n[Scenario 2] Detection → Dataset Manager');
    const s2Res = await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        window.visionXApp.setMode('manager');
        const stage = document.getElementById('stageCard');
        const primaryBar = document.querySelector('.primary-hero-bar');
        const summaryBar = document.querySelector('.current-result-summary-bar');
        const secondaryBar = document.querySelector('.secondary-controls-bar');
        const heroButtons = document.querySelector('.hero-camera-buttons');
        const mgrControls = document.getElementById('managerControls');
        const video = document.getElementById('videoElement');

        return {
          currentMode: window.visionXApp.currentMode,
          stageHidden: stage && stage.classList.contains('hidden'),
          primaryBarHidden: primaryBar && primaryBar.classList.contains('hidden'),
          summaryBarHidden: summaryBar && summaryBar.classList.contains('hidden'),
          secondaryBarHidden: secondaryBar && secondaryBar.classList.contains('hidden'),
          heroButtonsHidden: heroButtons && heroButtons.classList.contains('hidden'),
          mgrControlsVisible: mgrControls && !mgrControls.classList.contains('hidden'),
          mgrRole: mgrControls && mgrControls.getAttribute('role'),
          mgrAria: mgrControls && mgrControls.getAttribute('aria-label'),
          cameraStatus: window.visionXApp.cameraService?.state?.status,
          hasStream: !!window.visionXApp.cameraService?.stream,
          videoSrcObject: !!video?.srcObject
        };
      })()`,
      returnByValue: true
    });
    console.log('Manager Isolation State:', s2Res.result.value);
    const s2 = s2Res.result.value;
    if (s2.currentMode !== 'manager') throw new Error('Expected manager mode');
    if (!s2.stageHidden) throw new Error('Expected stageCard to be hidden in Manager');
    if (!s2.primaryBarHidden) throw new Error('Expected primary-hero-bar to be hidden in Manager');
    if (!s2.summaryBarHidden) throw new Error('Expected current-result-summary-bar to be hidden in Manager');
    if (!s2.secondaryBarHidden) throw new Error('Expected secondary-controls-bar to be hidden in Manager');
    if (!s2.heroButtonsHidden) throw new Error('Expected hero-camera-buttons to be hidden in Manager');
    if (!s2.mgrControlsVisible) throw new Error('Expected managerControls to be visible in Manager');
    if (s2.mgrRole !== 'region') throw new Error('Expected managerControls role="region"');
    if (s2.mgrAria !== 'Dataset Manager Workspace') throw new Error('Expected managerControls aria-label="Dataset Manager Workspace"');
    if (s2.cameraStatus !== 'disconnected') throw new Error('Expected camera status to be disconnected in Manager');
    if (s2.hasStream) throw new Error('Expected cameraService stream to be null in Manager');
    if (s2.videoSrcObject) throw new Error('Expected video.srcObject to be null in Manager');
    console.log('  ✅ Scenario 2 PASSED: Pure dataset workspace with zero camera UI and disconnected stream');

    // 3. Dataset Manager Operations (Search, Filter, Tabs, Selection) with Camera Remaining OFF
    console.log('\n[Scenario 3] Manager Data Operations & Camera Off Guarantee');
    const s3Res = await cdp.send('Runtime.evaluate', {
      expression: `(async () => {
        const app = window.visionXApp;
        const searchInput = document.getElementById('mgrSearchInput');
        const classSelect = document.getElementById('mgrSelectClass');
        const sourceSelect = document.getElementById('mgrSelectSource');
        const btnTrashView = document.getElementById('btnMgrViewTrash');
        const btnActiveView = document.getElementById('btnMgrViewActive');
        const btnSelectAll = document.getElementById('btnMgrSelectAll');
        const btnClearSelect = document.getElementById('btnMgrClearSelect');

        // Test search input
        if (searchInput) {
          searchInput.value = 'test_filter';
          searchInput.dispatchEvent(new Event('input', { bubbles: true }));
        }

        // Test class select
        if (classSelect) {
          classSelect.value = 'all';
          classSelect.dispatchEvent(new Event('change', { bubbles: true }));
        }

        // Test source select
        if (sourceSelect) {
          sourceSelect.value = 'all';
          sourceSelect.dispatchEvent(new Event('change', { bubbles: true }));
        }

        // Test view switch to trash and back
        if (btnTrashView) btnTrashView.click();
        const trashActive = btnTrashView && btnTrashView.classList.contains('active');
        if (btnActiveView) btnActiveView.click();
        const activeActive = btnActiveView && btnActiveView.classList.contains('active');

        // Test select all & clear
        if (btnSelectAll) btnSelectAll.click();
        const selectAllSize = app.managerService?.selectedIds?.size;
        if (btnClearSelect) btnClearSelect.click();
        const clearSize = app.managerService?.selectedIds?.size;

        return {
          trashActive,
          activeActive,
          clearSize,
          cameraStatus: app.cameraService?.state?.status,
          hasStream: !!app.cameraService?.stream,
          videoSrcObject: !!document.getElementById('videoElement')?.srcObject
        };
      })()`,
      awaitPromise: true,
      returnByValue: true
    });
    console.log('Manager Operations State:', s3Res.result.value);
    const s3 = s3Res.result.value;
    if (!s3.trashActive) throw new Error('Expected Trash view switch to work');
    if (!s3.activeActive) throw new Error('Expected Active view switch to work');
    if (s3.clearSize !== 0) throw new Error('Expected selection to clear');
    if (s3.cameraStatus !== 'disconnected') throw new Error('Camera must remain disconnected during dataset operations');
    if (s3.hasStream) throw new Error('Camera stream must remain null during dataset operations');
    if (s3.videoSrcObject) throw new Error('video.srcObject must remain null during dataset operations');
    console.log('  ✅ Scenario 3 PASSED: All Manager operations succeeded with camera remaining OFF');

    // 4. Keyboard Shortcuts Isolation in Manager
    console.log('\n[Scenario 4] Keyboard Shortcuts Isolation in Manager');
    const s4Res = await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const app = window.visionXApp;
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', bubbles: true }));
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true }));
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }));

        return {
          currentMode: app.currentMode,
          cameraStatus: app.cameraService?.state?.status,
          hasStream: !!app.cameraService?.stream
        };
      })()`,
      returnByValue: true
    });
    console.log('Keyboard Isolation State:', s4Res.result.value);
    const s4 = s4Res.result.value;
    if (s4.currentMode !== 'manager') throw new Error('Keypress m must not change mode from manager');
    if (s4.cameraStatus !== 'disconnected') throw new Error('Keypress must not start camera in manager');
    if (s4.hasStream) throw new Error('Keypress must not create stream in manager');
    console.log('  ✅ Scenario 4 PASSED: Camera shortcuts properly ignored in Manager');

    // 5. Rapid Asynchronous Race Condition Test (Detection → Manager Immediate Navigation)
    console.log('\n[Scenario 5] Rapid Detection → Manager Race Condition');
    const s5Res = await cdp.send('Runtime.evaluate', {
      expression: `(async () => {
        const app = window.visionXApp;
        // Trigger mode transition to detection which invokes handleStartCamera
        app.setMode('detection');
        // Immediately within milliseconds switch to manager
        app.setMode('manager');

        // Wait 600ms for any async start promise to settle
        await new Promise(r => setTimeout(r, 600));

        return {
          currentMode: app.currentMode,
          cameraStatus: app.cameraService?.state?.status,
          hasStream: !!app.cameraService?.stream,
          videoSrcObject: !!document.getElementById('videoElement')?.srcObject
        };
      })()`,
      awaitPromise: true,
      returnByValue: true
    });
    console.log('Race Condition State:', s5Res.result.value);
    const s5 = s5Res.result.value;
    if (s5.currentMode !== 'manager') throw new Error('Expected final mode to be manager');
    if (s5.cameraStatus !== 'disconnected') throw new Error('Stream resurrected after manager transition!');
    if (s5.hasStream) throw new Error('Active stream resurrected after manager transition!');
    if (s5.videoSrcObject) throw new Error('video.srcObject resurrected after manager transition!');
    console.log('  ✅ Scenario 5 PASSED: In-flight camera start was aborted without resurrection');

    // 6. Manager → Detection: Verify Camera Restoration
    console.log('\n[Scenario 6] Manager → Detection Camera Restoration');
    const s6Res = await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        window.visionXApp.setMode('detection', { startCamera: false });
        const stage = document.getElementById('stageCard');
        const primaryBar = document.querySelector('.primary-hero-bar');
        const summaryBar = document.querySelector('.current-result-summary-bar');
        const secondaryBar = document.querySelector('.secondary-controls-bar');
        const mgrControls = document.getElementById('managerControls');

        return {
          currentMode: window.visionXApp.currentMode,
          stageVisible: stage && !stage.classList.contains('hidden'),
          primaryBarVisible: primaryBar && !primaryBar.classList.contains('hidden'),
          summaryBarVisible: summaryBar && !summaryBar.classList.contains('hidden'),
          secondaryBarVisible: secondaryBar && !secondaryBar.classList.contains('hidden'),
          mgrControlsHidden: mgrControls && mgrControls.classList.contains('hidden')
        };
      })()`,
      returnByValue: true
    });
    console.log('Restoration State:', s6Res.result.value);
    const s6 = s6Res.result.value;
    if (s6.currentMode !== 'detection') throw new Error('Expected detection mode');
    if (!s6.stageVisible) throw new Error('stageCard must be unhidden when returning to detection');
    if (!s6.primaryBarVisible) throw new Error('primaryHeroBar must be unhidden when returning to detection');
    if (!s6.summaryBarVisible) throw new Error('summaryBar must be unhidden when returning to detection');
    if (!s6.secondaryBarVisible) throw new Error('secondaryBar must be unhidden when returning to detection');
    if (!s6.mgrControlsHidden) throw new Error('managerControls must be hidden when returning to detection');
    console.log('  ✅ Scenario 6 PASSED: Camera controls & stage cleanly restored');

    console.log('\n================================================================');
    console.log('🏆 REAL BROWSER E2E TESTS FOR PHASE B PASSED 100%!');
    console.log('================================================================\n');

  } finally {
    if (cdp) cdp.close();
    chromeProc.kill();
    if (viteProc) viteProc.kill();
  }
}

run().catch(err => {
  console.error('\n❌ Browser E2E Test FAILED:', err);
  process.exit(1);
});
