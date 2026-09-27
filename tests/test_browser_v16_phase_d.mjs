/**
 * test_browser_v16_phase_d.mjs - Real Browser E2E Test for VisionX V1.6 Phase D
 * Tests Multi-Turn Conversational Vision, Context Continuity, UI Thread, and Zero Errors.
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
    this.events = new Map();
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
        } else if (data.method && this.events.has(data.method)) {
          for (const handler of this.events.get(data.method)) {
            handler(data.params);
          }
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

  on(method, handler) {
    if (!this.events.has(method)) {
      this.events.set(method, new Set());
    }
    this.events.get(method).add(handler);
  }

  close() {
    if (this.ws) this.ws.close();
  }
}

async function run() {
  console.log('================================================================');
  console.log('🌐 Starting Browser E2E Test for VisionX V1.6 Phase D');
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
    console.log('Starting Vite server...');
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

    cdp.on('Runtime.consoleAPICalled', (params) => {
      if (params.type === 'error') {
        const msg = params.args.map(a => a.value || a.description || '').join(' ');
        consoleErrors.push(msg);
      }
    });

    cdp.on('Runtime.exceptionThrown', (params) => {
      consoleErrors.push(params.exceptionDetails?.text || 'Uncaught exception');
    });

    console.log('Waiting for VisionX web application to initialize...');
    let appReady = false;
    for (let i = 0; i < 40; i++) {
      await sleep(300);
      const evalRes = await cdp.send('Runtime.evaluate', {
        expression: 'typeof window.visionXApp !== "undefined" && window.visionXApp.visionAssistant?.conversationManager !== undefined',
        returnByValue: true
      });
      if (evalRes?.result?.value === true) {
        appReady = true;
        break;
      }
    }

    if (!appReady) {
      throw new Error('window.visionXApp or conversationManager did not initialize within 12 seconds');
    }

    console.log('✅ Application loaded with ConversationManager verified in browser!');

    // 1. Initial State Setup
    console.log('\nSetting up initial scene at T0 (laptop, bottle, cup)...');
    await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const app = window.visionXApp;
        app.lastDetections = [
          { id: 'lap1', track_id: 101, class_name: 'laptop', confidence: 0.95, bbox: [180, 140, 460, 360], relative_position: 'tengah' },
          { id: 'bot1', track_id: 102, class_name: 'bottle', confidence: 0.92, bbox: [480, 160, 550, 320], relative_position: 'kanan' },
          { id: 'cup1', track_id: 103, class_name: 'cup', confidence: 0.88, bbox: [60, 180, 140, 260], relative_position: 'kiri' }
        ];

        // Record into scene history at T-15s
        if (app.sceneHistoryEngine) {
          app.sceneHistoryEngine.clear();
          const t0 = Date.now() - 15000;
          app.sceneHistoryEngine.record({
            timestamp: t0,
            objects: [
              { trackId: 101, className: 'laptop', normCenter: { x: 0.50, y: 0.52 }, spatialZone: 'tengah' },
              { trackId: 102, className: 'bottle', normCenter: { x: 0.80, y: 0.50 }, spatialZone: 'kanan' },
              { trackId: 103, className: 'cup', normCenter: { x: 0.15, y: 0.46 }, spatialZone: 'kiri' }
            ],
            ocrText: 'HALO DUNIA',
            safetyRisk: 'LOW',
            activeAlertsCount: 0
          });
        }

        // Open Ask Vision Panel if closed
        if (app.contextualPanelManager) {
          app.contextualPanelManager.openPanel('ask');
        }
        return true;
      })()`,
      returnByValue: true
    });

    // -----------------------------------------------------------------------
    // Q1: "Apa yang ada di depan kamera?"
    // -----------------------------------------------------------------------
    console.log('Sending Q1: "Apa yang ada di depan kamera?"');
    const q1Res = await cdp.send('Runtime.evaluate', {
      expression: `(async () => {
        const app = window.visionXApp;
        const res = await app.visionAssistant.ask('Apa yang ada di depan kamera?');
        const cm = app.visionAssistant.conversationManager;
        const thread = document.getElementById('visionConversationThread');
        return {
          answer: res.answer,
          totalTurns: cm.getAllTurns().length,
          threadChildrenCount: thread ? thread.children.length : 0,
          isThreadVisible: thread && !thread.classList.contains('hidden')
        };
      })()`,
      awaitPromise: true,
      returnByValue: true
    });

    const q1Data = q1Res.result.value;
    console.log('Q1 Answer:', q1Data.answer);
    if (!q1Data.answer.includes('laptop') || !q1Data.answer.includes('bottle') || !q1Data.answer.includes('cup')) {
      throw new Error(`Q1 Answer should mention laptop, bottle, and cup: ${q1Data.answer}`);
    }
    if (q1Data.totalTurns !== 2) throw new Error(`Expected 2 turns after Q1, got ${q1Data.totalTurns}`);
    if (q1Data.threadChildrenCount !== 2) throw new Error(`Expected 2 thread bubbles, got ${q1Data.threadChildrenCount}`);
    if (!q1Data.isThreadVisible) throw new Error('Conversation thread should be visible');
    console.log('✅ Q1 verified successfully!');

    // -----------------------------------------------------------------------
    // Q2: "Yang mana paling besar?"
    // -----------------------------------------------------------------------
    console.log('\nSending Q2: "Yang mana paling besar?"');
    const q2Res = await cdp.send('Runtime.evaluate', {
      expression: `(async () => {
        const app = window.visionXApp;
        const res = await app.visionAssistant.ask('Yang mana paling besar?');
        const cm = app.visionAssistant.conversationManager;
        const thread = document.getElementById('visionConversationThread');
        return {
          answer: res.answer,
          totalTurns: cm.getAllTurns().length,
          threadChildrenCount: thread ? thread.children.length : 0
        };
      })()`,
      awaitPromise: true,
      returnByValue: true
    });

    const q2Data = q2Res.result.value;
    console.log('Q2 Answer:', q2Data.answer);
    if (!q2Data.answer.toLowerCase().includes('laptop')) {
      throw new Error(`Q2 Answer should identify laptop as largest: ${q2Data.answer}`);
    }
    if (q2Data.totalTurns !== 4) throw new Error(`Expected 4 turns after Q2, got ${q2Data.totalTurns}`);
    if (q2Data.threadChildrenCount !== 4) throw new Error(`Expected 4 thread bubbles, got ${q2Data.threadChildrenCount}`);
    console.log('✅ Q2 verified successfully!');

    // -----------------------------------------------------------------------
    // Q3: "Di mana posisinya?"
    // -----------------------------------------------------------------------
    console.log('\nSending Q3: "Di mana posisinya?"');
    const q3Res = await cdp.send('Runtime.evaluate', {
      expression: `(async () => {
        const app = window.visionXApp;
        const res = await app.visionAssistant.ask('Di mana posisinya?');
        const cm = app.visionAssistant.conversationManager;
        const thread = document.getElementById('visionConversationThread');
        return {
          answer: res.answer,
          totalTurns: cm.getAllTurns().length,
          threadChildrenCount: thread ? thread.children.length : 0
        };
      })()`,
      awaitPromise: true,
      returnByValue: true
    });

    const q3Data = q3Res.result.value;
    console.log('Q3 Answer:', q3Data.answer);
    if (!q3Data.answer.toLowerCase().includes('tengah')) {
      throw new Error(`Q3 Answer should position laptop at tengah (center): ${q3Data.answer}`);
    }
    if (q3Data.totalTurns !== 6) throw new Error(`Expected 6 turns after Q3, got ${q3Data.totalTurns}`);
    if (q3Data.threadChildrenCount !== 6) throw new Error(`Expected 6 thread bubbles, got ${q3Data.threadChildrenCount}`);
    console.log('✅ Q3 verified successfully!');

    // -----------------------------------------------------------------------
    // Q4: "Apa yang berubah sejak tadi?"
    // -----------------------------------------------------------------------
    console.log('\nInjecting scene change (cup removed, bottle moved, book appeared) and sending Q4...');
    const q4Res = await cdp.send('Runtime.evaluate', {
      expression: `(async () => {
        const app = window.visionXApp;
        // Inject current changed state
        const tn = Date.now();
        if (app.sceneHistoryEngine) {
          app.sceneHistoryEngine.record({
            timestamp: tn,
            objects: [
              { trackId: 101, className: 'laptop', normCenter: { x: 0.50, y: 0.52 }, spatialZone: 'tengah' },
              { trackId: 102, className: 'bottle', normCenter: { x: 0.80, y: 0.85 }, spatialZone: 'kanan' },
              { trackId: 104, className: 'book', normCenter: { x: 0.20, y: 0.35 }, spatialZone: 'kiri' }
            ],
            ocrText: 'DOKUMEN PENTING',
            safetyRisk: 'LOW',
            activeAlertsCount: 0
          });
        }

        const res = await app.visionAssistant.ask('Apa yang berubah sejak tadi?');
        const cm = app.visionAssistant.conversationManager;
        const thread = document.getElementById('visionConversationThread');
        return {
          answer: res.answer,
          totalTurns: cm.getAllTurns().length,
          threadChildrenCount: thread ? thread.children.length : 0
        };
      })()`,
      awaitPromise: true,
      returnByValue: true
    });

    const q4Data = q4Res.result.value;
    console.log('Q4 Answer:', q4Data.answer);
    if (!q4Data.answer.toLowerCase().includes('book') && !q4Data.answer.toLowerCase().includes('buku')) {
      throw new Error(`Q4 Answer should mention appeared book: ${q4Data.answer}`);
    }
    if (!q4Data.answer.toLowerCase().includes('cup') && !q4Data.answer.toLowerCase().includes('cangkir')) {
      throw new Error(`Q4 Answer should mention disappeared cup: ${q4Data.answer}`);
    }
    if (q4Data.totalTurns !== 8) throw new Error(`Expected 8 turns after Q4, got ${q4Data.totalTurns}`);
    if (q4Data.threadChildrenCount !== 8) throw new Error(`Expected 8 thread bubbles, got ${q4Data.threadChildrenCount}`);
    console.log('✅ Q4 verified successfully!');

    // -----------------------------------------------------------------------
    // Q5: Reset conversation action
    // -----------------------------------------------------------------------
    console.log('\nTesting Reset Conversation button...');
    const resetRes = await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const app = window.visionXApp;
        const resetBtn = document.getElementById('btnResetConversation');
        if (resetBtn) {
          resetBtn.click();
        } else {
          app.handleClearAssistantResponse();
        }
        const cm = app.visionAssistant.conversationManager;
        const thread = document.getElementById('visionConversationThread');
        return {
          totalTurns: cm.getAllTurns().length,
          isThreadHidden: thread ? thread.classList.contains('hidden') : true,
          threadBubbleCount: thread ? thread.children.length : 0
        };
      })()`,
      returnByValue: true
    });

    const resetData = resetRes.result.value;
    console.log('Reset State:', resetData);
    if (resetData.totalTurns !== 0) throw new Error(`Expected 0 turns after reset, got ${resetData.totalTurns}`);
    if (!resetData.isThreadHidden) throw new Error('Conversation thread should be hidden after reset');
    if (resetData.threadBubbleCount !== 0) throw new Error('Thread bubbles should be cleared');
    console.log('✅ Reset conversation verified!');

    // -----------------------------------------------------------------------
    // Q6: Fallback when referenced context is unavailable after reset
    // -----------------------------------------------------------------------
    console.log('\nTesting retrospective fallback on empty session ("Apa yang tadi dibahas?")...');
    const fallbackRes = await cdp.send('Runtime.evaluate', {
      expression: `(async () => {
        const app = window.visionXApp;
        const res = await app.visionAssistant.ask('Apa yang tadi dibahas?');
        return res.answer;
      })()`,
      awaitPromise: true,
      returnByValue: true
    });

    const fallbackAnswer = fallbackRes.result.value;
    console.log('Fallback Answer:', fallbackAnswer);
    if (!fallbackAnswer.includes('Belum ada konteks percakapan atau objek sebelumnya')) {
      throw new Error(`Expected deterministic fallback on empty history, got: ${fallbackAnswer}`);
    }
    console.log('✅ Deterministic fallback verified!');

    // -----------------------------------------------------------------------
    // Layout and Accessibility: Check no horizontal overflow
    // -----------------------------------------------------------------------
    console.log('\nChecking horizontal overflow and layout bounds...');
    const overflowRes = await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const thread = document.getElementById('visionConversationThread');
        const body = document.body;
        const doc = document.documentElement;

        return {
          threadHasHorizontalScroll: thread ? (thread.scrollWidth > thread.clientWidth + 2) : false,
          pageHasHorizontalScroll: doc.scrollWidth > window.innerWidth
        };
      })()`,
      returnByValue: true
    });

    const overflowData = overflowRes.result.value;
    console.log('Overflow check:', overflowData);
    if (overflowData.threadHasHorizontalScroll) {
      throw new Error('Conversation thread has horizontal scroll overflow');
    }
    if (overflowData.pageHasHorizontalScroll) {
      throw new Error('Page has horizontal scroll overflow');
    }
    console.log('✅ No horizontal overflow verified!');

    // -----------------------------------------------------------------------
    // Console Errors Check
    // -----------------------------------------------------------------------
    console.log('\nChecking console errors...');
    if (consoleErrors.length > 0) {
      console.warn('Console errors detected:', consoleErrors);
      // Filter out non-fatal dev warnings
      const fatalErrors = consoleErrors.filter(e => !e.includes('favicon') && !e.includes('identity_service'));
      if (fatalErrors.length > 0) {
        throw new Error('Fatal console errors occurred: ' + fatalErrors.join('; '));
      }
    }
    console.log('✅ Zero fatal console errors verified!');

    console.log('\n================================================================');
    console.log('🎉 ALL BROWSER E2E TESTS PASSED SUCCESSFULLY FOR V1.6 PHASE D!');
    console.log('================================================================\n');

  } finally {
    if (cdp) cdp.close();
    chromeProc.kill('SIGKILL');
    if (viteProc) {
      viteProc.kill('SIGKILL');
    }
  }
}

run().catch((err) => {
  console.error('❌ Browser E2E Test Failed:', err);
  process.exit(1);
});
