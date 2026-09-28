/**
 * test_browser_v17_phase_a.mjs - Real Browser E2E Test for VisionX V1.7 Phase A
 * Tests Home / Landing View & Lazy Camera Initialization in Headless Chrome via CDP.
 */

import { spawn } from 'child_process';
import http from 'http';

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DEBUG_PORT = 9228;
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
  console.log('🌐 Starting Real Browser E2E Test for VisionX V1.7 Phase A');
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

    console.log('✅ Application loaded. Starting Phase A Browser E2E Verification...');

    // 1. Verify Startup Home State
    const startupState = await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const app = window.visionXApp;
        const homeView = document.getElementById('homeView');
        const stageCard = document.getElementById('stageCard');
        const controlsCard = document.getElementById('controlsCard');
        return {
          currentMode: app.currentMode,
          homeVisible: homeView && !homeView.classList.contains('hidden'),
          stageCardHidden: stageCard && stageCard.classList.contains('hidden'),
          controlsCardHidden: controlsCard && controlsCard.classList.contains('hidden'),
          cameraStatus: app.cameraService?.state?.status,
          hasStream: !!app.cameraService?.stream,
          videoSrcObject: !!document.getElementById('videoElement')?.srcObject
        };
      })()`,
      returnByValue: true
    });

    console.log('Step 1 (Startup Home State):', startupState.result.value);
    const s1 = startupState.result.value;
    if (s1.currentMode !== 'home') throw new Error(`Expected currentMode 'home', got: ${s1.currentMode}`);
    if (!s1.homeVisible) throw new Error('Expected #homeView to be visible on startup');
    if (!s1.stageCardHidden) throw new Error('Expected #stageCard to be hidden on startup');
    if (!s1.controlsCardHidden) throw new Error('Expected #controlsCard to be hidden on startup');
    if (s1.cameraStatus !== 'disconnected') throw new Error(`Expected camera disconnected, got: ${s1.cameraStatus}`);
    if (s1.hasStream) throw new Error('Expected no active stream on startup');
    if (s1.videoSrcObject) throw new Error('Expected videoElement srcObject to be null on startup');
    console.log('  ✅ Step 1 PASSED: Home is active entry, zero active camera stream');

    // 2. Click Detection Card & Verify Transition
    console.log('Step 2: Navigating to Detection Mode...');
    const detectNavRes = await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        window.visionXApp.setMode('detection');
        const homeView = document.getElementById('homeView');
        const stageCard = document.getElementById('stageCard');
        const controlsCard = document.getElementById('controlsCard');
        return {
          currentMode: window.visionXApp.currentMode,
          homeHidden: homeView && homeView.classList.contains('hidden'),
          stageCardVisible: stageCard && !stageCard.classList.contains('hidden'),
          controlsCardVisible: controlsCard && !controlsCard.classList.contains('hidden')
        };
      })()`,
      returnByValue: true
    });

    console.log('Step 2 (Detection View State):', detectNavRes.result.value);
    const s2 = detectNavRes.result.value;
    if (s2.currentMode !== 'detection') throw new Error(`Expected currentMode 'detection', got: ${s2.currentMode}`);
    if (!s2.homeHidden) throw new Error('Expected #homeView to be hidden in detection');
    if (!s2.stageCardVisible) throw new Error('Expected #stageCard to be visible in detection');
    if (!s2.controlsCardVisible) throw new Error('Expected #controlsCard to be visible in detection');
    console.log('  ✅ Step 2 PASSED: Detection viewport displayed');

    // 3. Switch to Dataset Manager
    console.log('Step 3: Navigating to Dataset Manager...');
    const managerNavRes = await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        window.visionXApp.setMode('manager');
        const homeView = document.getElementById('homeView');
        const stageCard = document.getElementById('stageCard');
        const heroButtons = document.querySelector('.hero-camera-buttons');
        const managerControls = document.getElementById('managerControls');
        return {
          currentMode: window.visionXApp.currentMode,
          stageCardHidden: stageCard && stageCard.classList.contains('hidden'),
          heroButtonsHidden: heroButtons && heroButtons.classList.contains('hidden'),
          managerControlsVisible: managerControls && !managerControls.classList.contains('hidden'),
          cameraStatus: window.visionXApp.cameraService?.state?.status,
          hasStream: !!window.visionXApp.cameraService?.stream
        };
      })()`,
      returnByValue: true
    });

    console.log('Step 3 (Dataset Manager State):', managerNavRes.result.value);
    const s3 = managerNavRes.result.value;
    if (s3.currentMode !== 'manager') throw new Error(`Expected currentMode 'manager', got: ${s3.currentMode}`);
    if (!s3.stageCardHidden) throw new Error('Expected stageCard to be hidden in manager');
    if (!s3.heroButtonsHidden) throw new Error('Expected hero camera buttons to be hidden in manager');
    if (!s3.managerControlsVisible) throw new Error('Expected manager controls to be visible');
    if (s3.cameraStatus !== 'disconnected') throw new Error('Expected camera to be disconnected in manager');
    if (s3.hasStream) throw new Error('Expected camera stream to be stopped in manager');
    console.log('  ✅ Step 3 PASSED: Dataset Manager has zero camera stage & camera is stopped');

    // 4. Open Chat Assistant via openChatAssistant()
    console.log('Step 4: Opening Chat Assistant from Home/Manager...');
    const chatNavRes = await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        window.visionXApp.openChatAssistant();
        const askPanel = document.getElementById('askVisionPanel');
        return {
          currentMode: window.visionXApp.currentMode,
          isAskOpen: askPanel && askPanel.classList.contains('open'),
          cameraStatus: window.visionXApp.cameraService?.state?.status,
          hasStream: !!window.visionXApp.cameraService?.stream
        };
      })()`,
      returnByValue: true
    });

    console.log('Step 4 (Chat Assistant State):', chatNavRes.result.value);
    const s4 = chatNavRes.result.value;
    if (s4.currentMode !== 'detection') throw new Error(`Expected detection mode for chat, got: ${s4.currentMode}`);
    if (!s4.isAskOpen) throw new Error('Expected askVisionPanel to be open');
    if (s4.cameraStatus !== 'disconnected') throw new Error('Opening Chat must NOT start camera');
    if (s4.hasStream) throw new Error('Opening Chat must NOT have active stream');
    console.log('  ✅ Step 4 PASSED: Chat Assistant opened cleanly without starting camera');

    // 5. Navigate to Identity Lab
    console.log('Step 5: Navigating to Identity Lab...');
    const identityNavRes = await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        window.visionXApp.setMode('identity');
        const identityControls = document.getElementById('identityControls');
        return {
          currentMode: window.visionXApp.currentMode,
          identityControlsVisible: identityControls && !identityControls.classList.contains('hidden'),
          cameraStatus: window.visionXApp.cameraService?.state?.status,
          hasStream: !!window.visionXApp.cameraService?.stream
        };
      })()`,
      returnByValue: true
    });

    console.log('Step 5 (Identity Lab State):', identityNavRes.result.value);
    const s5 = identityNavRes.result.value;
    if (s5.currentMode !== 'identity') throw new Error(`Expected currentMode 'identity', got: ${s5.currentMode}`);
    if (!s5.identityControlsVisible) throw new Error('Expected identity controls to be visible');
    if (s5.cameraStatus !== 'disconnected') throw new Error('Identity entry must NOT start camera');
    if (s5.hasStream) throw new Error('Identity entry must NOT have active stream');
    console.log('  ✅ Step 5 PASSED: Identity Lab entered without camera request');

    // 6. Return to Home
    console.log('Step 6: Returning to Home...');
    const homeNavRes = await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        window.visionXApp.setMode('home');
        const homeView = document.getElementById('homeView');
        const stageCard = document.getElementById('stageCard');
        return {
          currentMode: window.visionXApp.currentMode,
          homeVisible: homeView && !homeView.classList.contains('hidden'),
          stageCardHidden: stageCard && stageCard.classList.contains('hidden'),
          cameraStatus: window.visionXApp.cameraService?.state?.status
        };
      })()`,
      returnByValue: true
    });

    console.log('Step 6 (Return to Home State):', homeNavRes.result.value);
    const s6 = homeNavRes.result.value;
    if (s6.currentMode !== 'home') throw new Error(`Expected currentMode 'home', got: ${s6.currentMode}`);
    if (!s6.homeVisible) throw new Error('Expected home view to be visible');
    if (!s6.stageCardHidden) throw new Error('Expected stage card to be hidden');
    if (s6.cameraStatus !== 'disconnected') throw new Error('Camera must be disconnected on Home');
    console.log('  ✅ Step 6 PASSED: Successfully returned to Home');

    console.log('\n================================================================');
    console.log('🎉 REAL BROWSER E2E TESTS PASSED SUCCESSFULLY!');
    console.log('================================================================\n');

  } finally {
    if (cdp) cdp.close();
    chromeProc.kill();
    if (viteProc) viteProc.kill();
  }
}

run().catch((err) => {
  console.error('❌ E2E TEST FAILED:', err);
  process.exit(1);
});
