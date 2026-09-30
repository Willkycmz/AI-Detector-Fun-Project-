import { spawn } from 'child_process';
import http from 'http';
import fs from 'fs';
import path from 'path';

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DEBUG_PORT = 9255;
const TARGET_URL = 'http://localhost:5173/';
const ARTIFACTS_DIR = 'C:\\Users\\advan\\.gemini\\antigravity-ide\\brain\\4bea7b7f-e8b1-47cb-8961-d89973239123';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function run() {
  console.log('🚀 Running Point 1 Contextual Panel Exclusivity Test in Real Browser...\n');
  const chromeProc = spawn(CHROME_PATH, [
    '--headless=new',
    `--remote-debugging-port=${DEBUG_PORT}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    'about:blank'
  ], { stdio: 'ignore' });

  let ws;
  let msgId = 1;
  const pendingCalls = new Map();

  function sendCommand(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = msgId++;
      pendingCalls.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async function evaluate(expression) {
    const res = await sendCommand('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    });
    if (res.exceptionDetails) {
      throw new Error(`Evaluation failed: ${res.exceptionDetails.text}`);
    }
    return res.result?.value;
  }

  async function capture(filename) {
    const res = await sendCommand('Page.captureScreenshot', { format: 'png' });
    const buffer = Buffer.from(res.data, 'base64');
    fs.writeFileSync(path.join(ARTIFACTS_DIR, filename), buffer);
    console.log(`  📸 Saved screenshot: ${filename}`);
  }

  try {
    let targets = null;
    for (let i = 0; i < 30; i++) {
      await sleep(300);
      try {
        targets = await fetchJson(`http://127.0.0.1:${DEBUG_PORT}/json`);
        if (targets && targets.length > 0) break;
      } catch (e) {}
    }

    const pageTarget = targets.find(t => t.type === 'page');
    ws = new WebSocket(pageTarget.webSocketDebuggerUrl);

    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && pendingCalls.has(msg.id)) {
        const { resolve, reject } = pendingCalls.get(msg.id);
        pendingCalls.delete(msg.id);
        if (msg.error) reject(msg.error);
        else resolve(msg.result);
      }
    };

    await sendCommand('Page.enable');
    await sendCommand('Runtime.enable');
    await sendCommand('DOM.enable');

    await sendCommand('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false
    });

    await sendCommand('Page.navigate', { url: TARGET_URL });
    await sleep(2500);

    // Switch to Detection Mode
    await evaluate(`window.visionXApp.setMode('detection', { startCamera: false });`);
    await sleep(600);

    const tools = [
      { id: 'ask', btn: 'toolBtnAsk', panel: 'askVisionPanel', name: 'Ask AI' },
      { id: 'voice', btn: 'toolBtnVoice', panel: 'voicePanel', name: 'Voice' },
      { id: 'memory', btn: 'toolBtnMemory', panel: 'objectMemoryPanel', name: 'Memory' },
      { id: 'personal', btn: 'toolBtnPersonal', panel: 'personalObjectsPanel', name: 'Personal' },
      { id: 'safety', btn: 'toolBtnSafety', panel: 'safetyAlertsPanel', name: 'Safety' },
      { id: 'settings', btn: 'toolBtnSettings', panel: 'settingsPanel', name: 'Settings' }
    ];

    const getOpenPanels = async () => {
      return await evaluate(`(() => {
        const panelIds = [
          'askVisionPanel', 'voicePanel', 'objectMemoryPanel',
          'personalObjectsPanel', 'safetyAlertsPanel', 'settingsPanel'
        ];
        return panelIds.filter(id => {
          const el = document.getElementById(id);
          if (!el) return false;
          const style = window.getComputedStyle(el);
          return style.display !== 'none' && el.classList.contains('open');
        });
      })()`);
    };

    // Test sequence: Click each tool and assert EXACTLY 1 panel open
    for (const tool of tools) {
      await evaluate(`document.getElementById('${tool.btn}').click();`);
      await sleep(250);
      const openPanels = await getOpenPanels();
      if (openPanels.length !== 1 || openPanels[0] !== tool.panel) {
        throw new Error(`Failed exclusivity for ${tool.name}: expected [${tool.panel}], got: [${openPanels.join(', ')}]`);
      }
      console.log(`  ✅ Exclusivity verified for ${tool.name}: only #${tool.panel} is active`);
    }

    // Capture screenshot with one panel open (Ask AI)
    await evaluate(`document.getElementById('toolBtnAsk').click();`);
    await sleep(300);
    await capture('point1_detection_single_panel_open.png');

    // Test toggle close
    await evaluate(`document.getElementById('toolBtnAsk').click();`);
    await sleep(250);
    const openAfterToggle = await getOpenPanels();
    if (openAfterToggle.length !== 0) {
      throw new Error(`Toggle close failed: expected 0 open panels, got: [${openAfterToggle.join(', ')}]`);
    }
    console.log(`  ✅ Toggle close verified: clicking active tool cleanly closes it (0 panels open)`);

    await capture('point1_detection_all_panels_closed.png');

    console.log('\n🎉 POINT 1 VERIFICATION FULLY PASSED: 100% strict 1-panel exclusivity!\n');
  } finally {
    if (ws) ws.close();
    chromeProc.kill('SIGTERM');
  }
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
