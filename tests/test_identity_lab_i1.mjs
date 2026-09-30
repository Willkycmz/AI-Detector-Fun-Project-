import { spawn } from 'child_process';
import http from 'http';
import fs from 'fs';
import path from 'path';

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DEBUG_PORT = 9276;
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
    await sleep(250);
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
  console.log('🚀 Running Identity Lab I1 Audit & Verification...\n');
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

    for (let i = 0; i < 30; i++) {
      const ready = await cdp.evaluate(`Boolean(window.visionXApp)`);
      if (ready) break;
      await sleep(200);
    }

    console.log('\n--- 1. SWITCHING TO IDENTITY LAB WORKSPACE (1920px) ---');
    await cdp.setViewport(1920, 1080);
    await cdp.evaluate(`window.visionXApp.setMode('identity', { startCamera: false });`);
    await sleep(500);

    const audit1920 = await cdp.evaluate(`(() => {
      const banner = document.querySelector('.privacy-safety-banner');
      const profileCard = document.querySelector('.profile-card');
      const galleryCard = document.querySelector('.reference-gallery-card');
      const testCard = document.querySelector('.live-test-card');
      const slider = document.getElementById('idLabThresholdSlider');
      const btnImport = document.getElementById('btnIdLabImport');
      const btnCapture = document.getElementById('btnIdLabCaptureCam');
      const grid = document.querySelector('.identity-layout-grid');

      const gridStyle = grid ? window.getComputedStyle(grid) : null;
      const bannerStyle = banner ? window.getComputedStyle(banner) : null;
      const sliderStyle = slider ? window.getComputedStyle(slider) : null;
      const btnImportRect = btnImport ? btnImport.getBoundingClientRect() : null;

      const cols = gridStyle ? gridStyle.gridTemplateColumns.split(' ').length : 0;

      return {
        foundAll: !!(banner && profileCard && galleryCard && testCard && slider && btnImport && btnCapture && grid),
        cols,
        bannerHasBorder: !!bannerStyle?.borderLeftColor,
        sliderWidth: slider?.getBoundingClientRect().width,
        btnImportHeight: btnImportRect ? Math.round(btnImportRect.height) : 0,
        hasHorizontalOverflow: document.documentElement.scrollWidth > window.innerWidth
      };
    })()`);

    console.log('Identity Lab Audit at 1920px:', audit1920);
    if (!audit1920.foundAll || audit1920.cols !== 2 || audit1920.btnImportHeight < 36) {
      throw new Error(`FAIL: Identity Lab components missing or unstyled!`);
    }
    console.log('  ✅ 1920px: All cards, slider, buttons, and 2-column layout styled and verified');
    await cdp.screenshot('i1_identity_lab_1920px.png');

    console.log('\n--- 2. VERIFYING TABLET RESPONSIVENESS (768px) ---');
    await cdp.setViewport(768, 1024);
    const audit768 = await cdp.evaluate(`(() => {
      const grid = document.querySelector('.identity-layout-grid');
      const gridStyle = window.getComputedStyle(grid);
      const cols = gridStyle.gridTemplateColumns.split(' ').length;
      return {
        cols,
        hasHorizontalOverflow: document.documentElement.scrollWidth > window.innerWidth
      };
    })()`);
    console.log('Tablet 768px Layout:', audit768);
    if (audit768.cols !== 1 || audit768.hasHorizontalOverflow) {
      throw new Error(`FAIL: 768px expected 1-column layout without overflow!`);
    }
    console.log('  ✅ 768px: Responsively collapses to single column with zero overflow');
    await cdp.screenshot('i1_identity_lab_768px.png');

    console.log('\n--- 3. VERIFYING MOBILE RESPONSIVENESS (375px) ---');
    await cdp.setViewport(375, 812);
    const audit375 = await cdp.evaluate(`(() => {
      const grid = document.querySelector('.identity-layout-grid');
      const gridStyle = window.getComputedStyle(grid);
      const cols = gridStyle.gridTemplateColumns.split(' ').length;
      return {
        cols,
        hasHorizontalOverflow: document.documentElement.scrollWidth > window.innerWidth
      };
    })()`);
    console.log('Mobile 375px Layout:', audit375);
    if (audit375.cols !== 1 || audit375.hasHorizontalOverflow) {
      throw new Error(`FAIL: 375px overflow detected!`);
    }
    console.log('  ✅ 375px: Neatly responsive on mobile screen with zero horizontal overflow');
    await cdp.screenshot('i1_identity_lab_375px.png');

    console.log('\n🎉 ALL IDENTITY LAB I1 CHECKS PASSED WITH DOM & SCREENSHOT EVIDENCE!\n');
    cdp.close();
  } finally {
    try { chromeProc.kill(); } catch (e) {}
  }
}

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
