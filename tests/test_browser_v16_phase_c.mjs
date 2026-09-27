/**
 * test_browser_v16_phase_c.mjs - Real Browser E2E Test for VisionX V1.6 Phase C
 * Tests temporal scene comparison and deterministic delta Q&A in live Chrome runtime.
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
  console.log('🌐 Starting Browser E2E Test for VisionX V1.6 Phase C');
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
        expression: 'typeof window.visionXApp !== "undefined" && window.visionXApp.sceneHistoryEngine !== undefined',
        returnByValue: true
      });
      if (evalRes?.result?.value === true) {
        appReady = true;
        break;
      }
    }

    if (!appReady) {
      throw new Error('window.visionXApp or sceneHistoryEngine did not initialize within 12 seconds');
    }

    console.log('✅ Application loaded with SceneHistoryEngine verified in browser!');

    // 1. Verify SceneHistoryEngine diagnostics and background sampler
    const diagEval = await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const engine = window.visionXApp.sceneHistoryEngine;
        return engine.getDiagnostics();
      })()`,
      returnByValue: true
    });
    const initialDiag = diagEval.result.value;
    console.log('Initial SceneHistoryEngine Diagnostics in Browser:', initialDiag);
    if (typeof initialDiag.totalSnapshots !== 'number') {
      throw new Error('SceneHistoryEngine diagnostics missing totalSnapshots');
    }

    // 2. Simulate T0 baseline scene (15 seconds ago)
    console.log('\nSimulating Scene T0 (15 seconds ago: laptop, bottle, cup)...');
    const t0Eval = await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const app = window.visionXApp;
        const engine = app.sceneHistoryEngine;
        engine.clear();

        const t0 = Date.now() - 15000;
        const baselineSnapshot = {
          timestamp: t0,
          objects: [
            { id: 'lap1', trackId: 101, className: 'laptop', normalizedBbox: { x1: 0.28, y1: 0.29, x2: 0.72, y2: 0.75 }, centroid: { x: 0.50, y: 0.52 }, zone: 'tengah', confidence: 0.95 },
            { id: 'bot1', trackId: 102, className: 'bottle', normalizedBbox: { x1: 0.75, y1: 0.33, x2: 0.86, y2: 0.67 }, centroid: { x: 0.80, y: 0.50 }, zone: 'kanan', confidence: 0.91 },
            { id: 'cup1', trackId: 103, className: 'cup', normalizedBbox: { x1: 0.09, y1: 0.38, x2: 0.22, y2: 0.54 }, centroid: { x: 0.15, y: 0.46 }, zone: 'kiri', confidence: 0.88 }
          ],
          ocrText: 'HALO DUNIA',
          safetyState: { riskLevel: 'NORMAL', activeAlertsCount: 0, criticalAlerts: [] },
          clutterLevel: 'MODERATE',
          focalObject: { className: 'laptop', zone: 'tengah' }
        };

        engine.record(baselineSnapshot);
        return engine.getDiagnostics();
      })()`,
      returnByValue: true
    });
    console.log('T0 Recorded. Engine Diagnostics:', t0Eval.result.value);

    // 3. Simulate T+N changed scene (now)
    // cup removed (disappeared), bottle moved to bottom-right, book appeared, OCR text changed, safety escalated to HIGH
    console.log('Simulating Scene T+N (now: cup disappeared, bottle moved, book appeared, OCR changed, safety HIGH)...');
    const tnEval = await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const app = window.visionXApp;
        const engine = app.sceneHistoryEngine;

        const tn = Date.now();
        const changedSnapshot = {
          timestamp: tn,
          objects: [
            { id: 'lap1', trackId: 101, className: 'laptop', normalizedBbox: { x1: 0.28, y1: 0.29, x2: 0.72, y2: 0.75 }, centroid: { x: 0.50, y: 0.52 }, zone: 'tengah', confidence: 0.95 },
            { id: 'bot1', trackId: 102, className: 'bottle', normalizedBbox: { x1: 0.75, y1: 0.67, x2: 0.86, y2: 0.98 }, centroid: { x: 0.80, y: 0.82 }, zone: 'kanan', confidence: 0.93 },
            { id: 'bk1', trackId: 104, className: 'book', normalizedBbox: { x1: 0.15, y1: 0.20, x2: 0.31, y2: 0.52 }, centroid: { x: 0.23, y: 0.36 }, zone: 'kiri', confidence: 0.89 }
          ],
          ocrText: 'DOKUMEN PENTING',
          safetyState: { riskLevel: 'HIGH', activeAlertsCount: 1, criticalAlerts: ['cup tertinggal'] },
          clutterLevel: 'MODERATE',
          focalObject: { className: 'laptop', zone: 'tengah' }
        };

        engine.record(changedSnapshot);

        // Also inject into app current state so buildCurrentVisionContext() matches
        app.lastDetections = [
          { id: 'lap1', track_id: 101, class_name: 'laptop', confidence: 0.95, bbox: [180, 140, 460, 360], relative_position: 'tengah' },
          { id: 'bot1', track_id: 102, class_name: 'bottle', confidence: 0.93, bbox: [480, 320, 550, 470], relative_position: 'kanan' },
          { id: 'bk1', track_id: 104, class_name: 'book', confidence: 0.89, bbox: [100, 100, 200, 250], relative_position: 'kiri' }
        ];

        const delta = engine.computeDelta(15);
        return {
          diagnostics: engine.getDiagnostics(),
          delta: {
            hasChanges: delta.hasChanges,
            appearedCount: delta.appeared.length,
            appearedClasses: delta.appeared.map(o => o.className),
            disappearedCount: delta.disappeared.length,
            disappearedClasses: delta.disappeared.map(o => o.className),
            movedCount: delta.moved.length,
            movedClasses: delta.moved.map(m => m.className),
            ocrChanged: delta.ocr.hasChanged,
            ocrPrevious: delta.ocr.previousText,
            ocrCurrent: delta.ocr.currentText,
            safetyChanged: delta.safety.hasChanged,
            safetyPrevious: delta.safety.previousRisk,
            safetyCurrent: delta.safety.currentRisk,
            narrative: delta.narrative
          }
        };
      })()`,
      returnByValue: true
    });

    if (tnEval.exceptionDetails) {
      throw new Error('Runtime error in T+N evaluate: ' + JSON.stringify(tnEval.exceptionDetails));
    }
    const tnData = tnEval.result?.value;
    if (!tnData) {
      throw new Error('tnEval returned no value: ' + JSON.stringify(tnEval));
    }
    console.log('T+N Computed Delta in Browser:', tnData.delta);

    // Assertions on deterministic delta in browser
    if (!tnData.delta.hasChanges) throw new Error('Expected hasChanges to be true');
    if (tnData.delta.appearedCount !== 1 || tnData.delta.appearedClasses[0] !== 'book') {
      throw new Error(`Expected appeared [book], got: ${JSON.stringify(tnData.delta.appearedClasses)}`);
    }
    if (tnData.delta.disappearedCount !== 1 || tnData.delta.disappearedClasses[0] !== 'cup') {
      throw new Error(`Expected disappeared [cup], got: ${JSON.stringify(tnData.delta.disappearedClasses)}`);
    }
    if (tnData.delta.movedCount !== 1 || tnData.delta.movedClasses[0] !== 'bottle') {
      throw new Error(`Expected moved [bottle], got: ${JSON.stringify(tnData.delta.movedClasses)}`);
    }
    if (!tnData.delta.ocrChanged) throw new Error('Expected ocrChanged to be true');
    if (!tnData.delta.safetyChanged) throw new Error('Expected safetyChanged to be true');
    if (tnData.delta.safetyCurrent !== 'HIGH') throw new Error(`Expected safetyCurrent 'HIGH', got: ${tnData.delta.safetyCurrent}`);

    console.log('✅ Deterministic Delta verified directly in browser runtime!');

    // 4. Test VisionAssistant Q&A: "Apa yang berubah dalam 15 detik terakhir?"
    console.log('\nTesting VisionAssistant Q&A: "Apa yang berubah dalam 15 detik terakhir?"');
    const askGeneralEval = await cdp.send('Runtime.evaluate', {
      expression: `(async () => {
        const app = window.visionXApp;
        const res = await app.visionAssistant.ask('Apa yang berubah dalam 15 detik terakhir?');
        return {
          success: res.success,
          answer: res.answer,
          provider: res.provider,
          state: app.visionAssistant.state
        };
      })()`,
      awaitPromise: true,
      returnByValue: true
    });

    const askGeneral = askGeneralEval.result.value;
    console.log('VisionAssistant Answer:', askGeneral.answer);
    if (!askGeneral.success) throw new Error('VisionAssistant.ask failed');
    if (askGeneral.state !== 'SUCCESS') throw new Error(`Expected state SUCCESS, got: ${askGeneral.state}`);
    if (!askGeneral.answer.toLowerCase().includes('buku') && !askGeneral.answer.toLowerCase().includes('book')) {
      throw new Error(`Answer should mention appeared book: ${askGeneral.answer}`);
    }
    if (!askGeneral.answer.toLowerCase().includes('cangkir') && !askGeneral.answer.toLowerCase().includes('cup')) {
      throw new Error(`Answer should mention disappeared cup: ${askGeneral.answer}`);
    }
    if (!askGeneral.answer.toLowerCase().includes('botol') && !askGeneral.answer.toLowerCase().includes('bottle')) {
      throw new Error(`Answer should mention moved bottle: ${askGeneral.answer}`);
    }
    console.log('✅ General temporal question verified!');

    // 5. Test VisionAssistant Q&A: "Barang apa yang baru muncul?"
    console.log('\nTesting VisionAssistant Q&A: "Barang apa yang baru muncul?"');
    const askAppearedEval = await cdp.send('Runtime.evaluate', {
      expression: `(async () => {
        const app = window.visionXApp;
        const res = await app.visionAssistant.ask('Barang apa yang baru muncul?');
        return {
          success: res.success,
          answer: res.answer,
          state: app.visionAssistant.state
        };
      })()`,
      awaitPromise: true,
      returnByValue: true
    });
    const askAppeared = askAppearedEval.result.value;
    console.log('VisionAssistant Answer:', askAppeared.answer);
    if (!askAppeared.answer.toLowerCase().includes('buku') && !askAppeared.answer.toLowerCase().includes('book')) {
      throw new Error(`Appeared answer should mention book: ${askAppeared.answer}`);
    }
    console.log('✅ Specific appeared question verified!');

    // 6. Test VisionAssistant Q&A: "Apa yang hilang?"
    console.log('\nTesting VisionAssistant Q&A: "Apa yang hilang?"');
    const askDisappearedEval = await cdp.send('Runtime.evaluate', {
      expression: `(async () => {
        const app = window.visionXApp;
        const res = await app.visionAssistant.ask('Apa yang hilang?');
        return {
          success: res.success,
          answer: res.answer,
          state: app.visionAssistant.state
        };
      })()`,
      awaitPromise: true,
      returnByValue: true
    });
    const askDisappeared = askDisappearedEval.result.value;
    console.log('VisionAssistant Answer:', askDisappeared.answer);
    if (!askDisappeared.answer.toLowerCase().includes('cangkir') && !askDisappeared.answer.toLowerCase().includes('cup')) {
      throw new Error(`Disappeared answer should mention cup: ${askDisappeared.answer}`);
    }
    console.log('✅ Specific disappeared question verified!');

    // 7. Test VisionAssistant Q&A: "Apakah benda berpindah?"
    console.log('\nTesting VisionAssistant Q&A: "Apakah benda berpindah?"');
    const askMovedEval = await cdp.send('Runtime.evaluate', {
      expression: `(async () => {
        const app = window.visionXApp;
        const res = await app.visionAssistant.ask('Apakah benda berpindah?');
        return {
          success: res.success,
          answer: res.answer,
          state: app.visionAssistant.state
        };
      })()`,
      awaitPromise: true,
      returnByValue: true
    });
    const askMoved = askMovedEval.result.value;
    console.log('VisionAssistant Answer:', askMoved.answer);
    if (!askMoved.answer.toLowerCase().includes('botol') && !askMoved.answer.toLowerCase().includes('bottle')) {
      throw new Error(`Moved answer should mention bottle: ${askMoved.answer}`);
    }
    console.log('✅ Specific moved question verified!');

    console.log('\n================================================================');
    console.log('🎉 ALL BROWSER E2E TESTS PASSED SUCCESSFULLY FOR V1.6 PHASE C!');
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
