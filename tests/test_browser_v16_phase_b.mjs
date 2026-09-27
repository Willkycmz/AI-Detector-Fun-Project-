/**
 * test_browser_v16_phase_b.mjs - Real Browser E2E Test for VisionX V1.6 Phase B
 * Tests 2D spatial relationships and scene understanding in live Chrome runtime.
 */

import { spawn } from 'child_process';
import http from 'http';

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DEBUG_PORT = 9226;
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
  console.log('🌐 Starting Browser E2E Test for VisionX V1.6 Phase B');
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

    console.log('✅ Application loaded. Testing Phase B Empty Scene Understanding...');

    // 1. Check empty scene context in browser
    const emptyCtxEval = await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const app = window.visionXApp;
        app.lastDetections = [];
        const ctx = app.buildCurrentVisionContext();
        return {
          clutter: ctx.sceneUnderstanding?.clutter_level,
          hasFocal: !!ctx.sceneUnderstanding?.focal_object,
          relationsCount: ctx.sceneUnderstanding?.spatial_relations_count,
          narrative: ctx.sceneUnderstanding?.spatial_narrative
        };
      })()`,
      returnByValue: true
    });

    const emptyData = emptyCtxEval.result.value;
    console.log('Empty Scene Context in Browser:', emptyData);
    if (emptyData.clutter !== 'EMPTY') throw new Error(`Expected clutter 'EMPTY', got: ${emptyData.clutter}`);
    if (emptyData.hasFocal) throw new Error('Empty scene should not have a focal object');
    if (emptyData.relationsCount !== 0) throw new Error('Empty scene should have 0 relations');

    console.log('✅ Empty scene understanding verified in browser!');

    // 2. Inject multi-object detections and test 2D spatial relationships
    console.log('Testing multi-object 2D spatial relationships in browser...');
    const multiCtxEval = await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const app = window.visionXApp;
        app.lastDetections = [
          { id: 'lap1', class_name: 'laptop', confidence: 0.94, bbox: [180, 140, 460, 360], relative_position: 'tengah' },
          { id: 'bot1', class_name: 'bottle', confidence: 0.91, bbox: [480, 160, 550, 320], relative_position: 'kanan' },
          { id: 'cup1', class_name: 'cup', confidence: 0.86, bbox: [60, 180, 140, 260], relative_position: 'kiri' }
        ];
        const ctx = app.buildCurrentVisionContext();
        const su = ctx.sceneUnderstanding;
        const relations = su.spatial_relations;

        // Cari relasi bot1 terhadap lap1
        const botToLap = relations.find(r => r.sourceId === 'bot1' && r.targetId === 'lap1');
        // Cari relasi cup1 terhadap lap1
        const cupToLap = relations.find(r => r.sourceId === 'cup1' && r.targetId === 'lap1');

        return {
          clutter: su.clutter_level,
          focalClass: su.focal_object?.class_name,
          focalScore: su.focal_object?.focal_score,
          relationsCount: su.spatial_relations_count,
          botIsRightOfLap: botToLap ? botToLap.relations.includes('RIGHT_OF') : false,
          cupIsLeftOfLap: cupToLap ? cupToLap.relations.includes('LEFT_OF') : false,
          narrative: su.spatial_narrative,
          summaryClutter: ctx.summary.clutter_level,
          summaryFocal: ctx.summary.focal_object
        };
      })()`,
      returnByValue: true
    });

    const multiData = multiCtxEval.result.value;
    console.log('Multi-Object Spatial Context in Browser:', multiData);
    if (multiData.clutter !== 'MODERATE') throw new Error(`Expected clutter 'MODERATE', got: ${multiData.clutter}`);
    if (multiData.focalClass !== 'laptop') throw new Error(`Expected focal object 'laptop', got: ${multiData.focalClass}`);
    if (!multiData.botIsRightOfLap) throw new Error('Bottle must be detected RIGHT_OF laptop');
    if (!multiData.cupIsLeftOfLap) throw new Error('Cup must be detected LEFT_OF laptop');
    if (multiData.summaryClutter !== 'MODERATE') throw new Error('summary.clutter_level out of sync');
    if (multiData.summaryFocal !== 'laptop') throw new Error('summary.focal_object out of sync');

    console.log('✅ Multi-object 2D spatial relationships and focal object verified in browser!');

    // 3. Test VisionAssistant Q&A asking for situation / spatial layout in browser
    console.log('Testing VisionAssistant asking spatial situation question in browser...');
    const askEval = await cdp.send('Runtime.evaluate', {
      expression: `(async () => {
        const app = window.visionXApp;
        const res = await app.visionAssistant.ask('Bagaimana situasi dan posisi objek sekitar?');
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

    const askData = askEval.result.value;
    console.log('VisionAssistant Spatial Response in Browser:', askData);
    if (!askData.success) throw new Error('Assistant ask call failed');
    if (!askData.answer.includes('laptop')) {
      throw new Error(`Answer should mention laptop, got: ${askData.answer}`);
    }
    if (askData.state !== 'SUCCESS') throw new Error(`Expected state SUCCESS, got: ${askData.state}`);

    console.log('✅ VisionAssistant spatial question Q&A verified in browser runtime!');

    console.log('\n================================================================');
    console.log('🎉 ALL BROWSER E2E TESTS PASSED SUCCESSFULLY FOR V1.6 PHASE B!');
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
