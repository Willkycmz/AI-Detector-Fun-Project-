import { spawn } from 'child_process';
import http from 'http';
import fs from 'fs';
import path from 'path';

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DEBUG_PORT = 9240;
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
  const chromeProc = spawn(CHROME_PATH, [
    '--headless=new',
    `--remote-debugging-port=${DEBUG_PORT}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
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
    console.log(`Saved screenshot: ${filename}`);
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

    await evaluate(`
      localStorage.setItem('visionx_theme_preference', 'light');
      if (window.visionXApp && window.visionXApp.themeManager) {
        window.visionXApp.themeManager.applyTheme('light');
      }
      // dismiss toasts
      const eb = document.getElementById('errorBanner');
      const sb = document.getElementById('successBanner');
      if (eb) eb.classList.add('hidden');
      if (sb) sb.classList.add('hidden');
    `);
    await sleep(500);

    // 1. Home
    await capture('audit_mode_home.png');

    // 2. Detection
    await evaluate(`window.visionXApp.setMode('detection', { startCamera: false });`);
    await sleep(600);
    await capture('audit_mode_detection.png');

    // 3. Read Text
    await evaluate(`window.visionXApp.setMode('read_text', { startCamera: false });`);
    await sleep(600);
    await capture('audit_mode_read_text.png');

    // 4. Collection
    await evaluate(`window.visionXApp.setMode('collection', { startCamera: false });`);
    await sleep(600);
    await capture('audit_mode_collection.png');

    // 5. Manager
    await evaluate(`window.visionXApp.setMode('manager');`);
    await sleep(800);
    await capture('audit_mode_manager.png');

    // 6. Identity
    await evaluate(`window.visionXApp.setMode('identity', { startCamera: false });`);
    await sleep(600);
    await capture('audit_mode_identity.png');

    // 7. Mobile Home (390x844)
    await sendCommand('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true
    });
    await evaluate(`window.visionXApp.setMode('home');`);
    await sleep(500);
    await capture('audit_mobile_home.png');

    // 8. Mobile Detection (390x844)
    await evaluate(`window.visionXApp.setMode('detection', { startCamera: false });`);
    await sleep(500);
    await capture('audit_mobile_detection.png');

    // 9. Mobile Manager (390x844)
    await evaluate(`window.visionXApp.setMode('manager');`);
    await sleep(500);
    await capture('audit_mobile_manager.png');

    console.log('ALL SCREENSHOTS CAPTURED');
  } finally {
    if (ws) ws.close();
    chromeProc.kill('SIGTERM');
  }
}

run().catch(console.error);
