import { spawn } from 'child_process';
import http from 'http';
import fs from 'fs';
import path from 'path';

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DEBUG_PORT = 9268;
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

class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.id = 0;
    this.pending = new Map();
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    return new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
      this.ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.id && this.pending.has(data.id)) {
          const { res, rej } = this.pending.get(data.id);
          this.pending.delete(data.id);
          if (data.error) rej(data.error);
          else res(data.result);
        }
      };
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expr) {
    const res = await this.send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true
    });
    if (res.exceptionDetails) {
      throw new Error(`Eval failed: ${JSON.stringify(res.exceptionDetails)}`);
    }
    return res.result ? res.result.value : undefined;
  }

  async setViewport(width, height) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: width <= 768
    });
    await this.send('Emulation.setVisibleSize', { width, height });
    await sleep(200);
  }

  async screenshot(filename) {
    const res = await this.send('Page.captureScreenshot', { format: 'png' });
    const buffer = Buffer.from(res.data, 'base64');
    const outPath = path.join(ARTIFACTS_DIR, filename);
    fs.writeFileSync(outPath, buffer);
    console.log(`  📸 Saved screenshot: ${outPath} (${buffer.length} bytes)`);
    return outPath;
  }

  close() {
    if (this.ws) this.ws.close();
  }
}

async function run() {
  console.log('🚀 Running Camera B1 Verification (Vision & Read Text)...\n');
  const chromeProc = spawn(CHROME_PATH, [
    '--headless=new',
    `--remote-debugging-port=${DEBUG_PORT}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    'http://localhost:5173/'
  ], { stdio: 'ignore' });

  try {
    let targets = null;
    for (let i = 0; i < 30; i++) {
      await sleep(300);
      try {
        targets = await fetchJson(`http://127.0.0.1:${DEBUG_PORT}/json`);
        if (targets && targets.length > 0) break;
      } catch (e) {}
    }

    if (!targets || !targets.length) {
      throw new Error('Chrome remote debugging did not respond');
    }

    const pageTarget = targets.find(t => t.type === 'page');
    const cdp = new CdpClient(pageTarget.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    console.log('⚡ Connected to CDP. Waiting for app ready...');
    await sleep(1500);

    // Wait for visionXApp to be ready
    for (let i = 0; i < 30; i++) {
      const ready = await cdp.evaluate(`Boolean(window.visionXApp)`);
      if (ready) break;
      await sleep(200);
    }

    // Helper to query camera buttons visibility
    const checkButtons = async () => {
      return await cdp.evaluate(`(() => {
        const start = document.getElementById('btnStart');
        const stop = document.getElementById('btnStop');
        if (!start || !stop) return { found: false };
        const startStyle = window.getComputedStyle(start);
        const stopStyle = window.getComputedStyle(stop);
        const startVisible = startStyle.display !== 'none' && !start.classList.contains('hidden');
        const stopVisible = stopStyle.display !== 'none' && !stop.classList.contains('hidden');
        return {
          found: true,
          startVisible,
          stopVisible,
          startText: start.innerText.trim(),
          stopText: stop.innerText.trim(),
          startDisabled: start.disabled,
          stopDisabled: stop.disabled
        };
      })()`);
    };

    console.log('\n--- 1. TESTING VISION MODE (Camera OFF -> ON -> OFF) ---');
    await cdp.setViewport(1920, 1080);
    await cdp.evaluate(`window.visionXApp.setMode('detection', { startCamera: false });`);
    await sleep(500);

    let state = await checkButtons();
    console.log('Vision (Camera OFF):', state);
    if (!state.startVisible || state.stopVisible) {
      throw new Error(`FAIL: Camera OFF must show ONLY Mulai Kamera! Got: start=${state.startVisible}, stop=${state.stopVisible}`);
    }
    console.log('  ✅ Vision Camera OFF: Mulai Kamera visible, Hentikan Kamera hidden');
    await cdp.screenshot('b1_vision_camera_off_1920px.png');

    // Simulate Camera ON
    await cdp.evaluate(`window.visionXApp.handleCameraStateChange({ status: 'connected', resolution: { width: 1280, height: 720 } });`);
    await sleep(300);
    state = await checkButtons();
    console.log('Vision (Camera ON):', state);
    if (state.startVisible || !state.stopVisible) {
      throw new Error(`FAIL: Camera ON must show ONLY Hentikan Kamera! Got: start=${state.startVisible}, stop=${state.stopVisible}`);
    }
    console.log('  ✅ Vision Camera ON: Mulai Kamera hidden, Hentikan Kamera visible');
    await cdp.screenshot('b1_vision_camera_on_1920px.png');

    // Simulate Camera OFF
    await cdp.evaluate(`window.visionXApp.handleCameraStateChange({ status: 'disconnected', resolution: { width: 0, height: 0 } });`);
    await sleep(300);
    state = await checkButtons();
    if (!state.startVisible || state.stopVisible) {
      throw new Error(`FAIL: Camera OFF must show ONLY Mulai Kamera again!`);
    }
    console.log('  ✅ Vision Camera OFF again: Mulai Kamera visible, Hentikan Kamera hidden');

    console.log('\n--- 2. TESTING READ TEXT MODE (Camera OFF -> ON) at 768px & 375px ---');
    await cdp.setViewport(768, 1024);
    await cdp.evaluate(`window.visionXApp.setMode('read_text', { startCamera: false });`);
    await sleep(500);

    state = await checkButtons();
    console.log('Read Text (Camera OFF, 768px):', state);
    if (!state.startVisible || state.stopVisible) {
      throw new Error(`FAIL: Read Text Camera OFF must show ONLY Mulai Kamera! Got: start=${state.startVisible}, stop=${state.stopVisible}`);
    }
    console.log('  ✅ Read Text (768px) Camera OFF: Mulai Kamera visible, Hentikan Kamera hidden');
    await cdp.screenshot('b1_readtext_camera_off_768px.png');

    await cdp.setViewport(375, 812);
    // Simulate Camera ON
    await cdp.evaluate(`window.visionXApp.handleCameraStateChange({ status: 'connected', resolution: { width: 1280, height: 720 } });`);
    await sleep(300);
    state = await checkButtons();
    console.log('Read Text (Camera ON, 375px):', state);
    if (state.startVisible || !state.stopVisible) {
      throw new Error(`FAIL: Read Text Camera ON must show ONLY Hentikan Kamera! Got: start=${state.startVisible}, stop=${state.stopVisible}`);
    }
    console.log('  ✅ Read Text (375px) Camera ON: Mulai Kamera hidden, Hentikan Kamera visible');
    await cdp.screenshot('b1_readtext_camera_on_375px.png');

    console.log('\n🎉 ALL CAMERA B1 CHECKS PASSED WITH DOM & SCREENSHOT EVIDENCE!\n');
    cdp.close();
  } finally {
    try { chromeProc.kill(); } catch (e) {}
  }
}

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
