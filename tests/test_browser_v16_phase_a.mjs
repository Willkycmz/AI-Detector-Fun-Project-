/**
 * test_browser_v16_phase_a.mjs - Real Browser E2E Test for VisionX V1.6 Phase A
 * Tests window.visionXApp.buildCurrentVisionContext() inside a real Headless Chrome instance.
 */

import { spawn } from 'child_process';
import http from 'http';

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DEBUG_PORT = 9225;
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
  console.log('🌐 Starting Browser E2E Test for VisionX V1.6 Phase A');
  console.log('================================================================');

  let viteProc = null;
  // Check if Vite is running
  let isRunning = false;
  try {
    const res = await fetchJson('http://localhost:5173/');
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
    // Wait for server to come up
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

    console.log('✅ Application loaded. Executing V1.6 Phase A Context Verification...');

    // 1. Verify buildCurrentVisionContext() structure in browser
    const ctxEval = await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const app = window.visionXApp;
        const ctx = app.buildCurrentVisionContext();
        return {
          version: ctx.version,
          hasSafetyNode: !!ctx.safety,
          safetyEnabled: ctx.safety?.is_enabled,
          riskLevel: ctx.safety?.risk_level,
          activeAlertsCount: ctx.safety?.active_alerts_count,
          summaryRisk: ctx.summary?.safety_risk_level,
          summaryAlertsCount: ctx.summary?.active_alerts_count,
          hasSafetyEngine: !!app.safetyEngine,
          hasAlertManager: !!app.alertManager,
          hasVisionAssistant: !!app.visionAssistant
        };
      })()`,
      returnByValue: true
    });

    const ctxData = ctxEval.result.value;
    console.log('Browser Context Evaluation Result:', ctxData);

    if (ctxData.version !== '1.6') throw new Error(`Expected context version '1.6', got: ${ctxData.version}`);
    if (!ctxData.hasSafetyNode) throw new Error('Context does not have .safety node');
    if (ctxData.safetyEnabled !== true) throw new Error('Expected safety.is_enabled === true');
    if (typeof ctxData.riskLevel !== 'string') throw new Error('safety.risk_level must be a string');
    if (ctxData.summaryRisk !== ctxData.riskLevel) throw new Error('Summary risk level out of sync');
    if (!ctxData.hasSafetyEngine) throw new Error('app.safetyEngine is missing');
    if (!ctxData.hasAlertManager) throw new Error('app.alertManager is missing');

    console.log('✅ Context schema v1.6 & safety properties verified in real browser runtime!');

    // 2. Simulate safety alert and check context dynamic reaction
    console.log('Testing live safety alert generation in browser runtime...');
    const alertEval = await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const app = window.visionXApp;
        const testEvent = {
          type: 'PERSONAL_OBJECT_LEFT',
          severity: 'HIGH',
          objectName: 'Tas Kulit',
          className: 'backpack',
          trackId: 88,
          lastZone: 'kanan bawah',
          timestamp: Date.now(),
          details: { isPersonal: true }
        };
        app.alertManager.processEvent(testEvent);
        const updatedCtx = app.buildCurrentVisionContext();
        return {
          alertsCount: updatedCtx.safety.active_alerts_count,
          riskLevel: updatedCtx.safety.risk_level,
          alertTitle: updatedCtx.safety.active_alerts[0]?.title,
          alertZone: updatedCtx.safety.active_alerts[0]?.last_zone
        };
      })()`,
      returnByValue: true
    });

    const alertData = alertEval.result.value;
    console.log('Live Alert Context Result:', alertData);
    if (alertData.alertsCount < 1) throw new Error('Context did not update with active alert');
    if (alertData.riskLevel !== 'HIGH') throw new Error(`Expected risk level 'HIGH', got: ${alertData.riskLevel}`);
    if (!alertData.alertTitle) throw new Error('Alert title missing');

    console.log('✅ Live alert reflection in buildCurrentVisionContext() verified!');

    // 3. Test VisionAssistant Q&A asking safety in browser
    console.log('Testing VisionAssistant asking safety question via MockAI in browser...');
    const askEval = await cdp.send('Runtime.evaluate', {
      expression: `(async () => {
        const app = window.visionXApp;
        const res = await app.visionAssistant.ask('Apakah ada bahaya atau barang tertinggal?');
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
    console.log('VisionAssistant Safety Response:', askData);
    if (!askData.success) throw new Error('Assistant ask call failed');
    if (!askData.answer.includes('Tas Kulit') && !askData.answer.includes('HIGH')) {
      console.warn('Answer did not contain expected alert details, received:', askData.answer);
    }
    if (askData.state !== 'SUCCESS') throw new Error(`Expected assistant state SUCCESS, got: ${askData.state}`);

    console.log('✅ VisionAssistant browser Q&A round-trip verified!');

    console.log('\n================================================================');
    console.log('🎉 ALL BROWSER E2E TESTS PASSED SUCCESSFULLY FOR V1.6 PHASE A!');
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
