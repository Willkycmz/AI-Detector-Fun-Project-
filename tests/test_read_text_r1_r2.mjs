import { spawn } from 'child_process';
import http from 'http';
import fs from 'fs';
import path from 'path';

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DEBUG_PORT = 9274;
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
  console.log('🚀 Running Read Text R1 & R2 Verification...\n');
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

    console.log('\n--- 1. SWITCHING TO READ TEXT WORKSPACE (1920px) ---');
    await cdp.setViewport(1920, 1080);
    await cdp.evaluate(`window.visionXApp.setMode('read_text', { startCamera: false });`);
    await sleep(500);

    // Verify R2: Header book icon alignment with title
    const r2Check = await cdp.evaluate(`(() => {
      const icon = document.querySelector('.read-text-title-group .inline-book-icon');
      const titleTexts = document.querySelector('.read-text-title-group .read-text-title-texts');
      const title = document.querySelector('.read-text-title');
      if (!icon || !titleTexts || !title) return { found: false };
      const iconRect = icon.getBoundingClientRect();
      const textRect = titleTexts.getBoundingClientRect();
      const isAlignedHorizontally = iconRect.right <= textRect.left + 16 && Math.abs(iconRect.top - textRect.top) < 25;
      return {
        found: true,
        titleText: title.innerText.trim(),
        iconWidth: Math.round(iconRect.width),
        iconHeight: Math.round(iconRect.height),
        isAlignedHorizontally
      };
    })()`);

    console.log('R2 Header Icon Alignment:', r2Check);
    if (!r2Check.found || !r2Check.isAlignedHorizontally) {
      throw new Error('FAIL: Header book icon is not horizontally aligned with the title!');
    }
    console.log('  ✅ R2: Book icon is cleanly aligned horizontally with title');

    // Verify R1: Card "Pengaturan OCR" & grid layout
    const r1Desktop = await cdp.evaluate(`(() => {
      const card = document.querySelector('.ocr-settings-card');
      const grid = document.querySelector('.ocr-settings-grid');
      const lang = document.getElementById('ocrLangSelect');
      const profile = document.getElementById('ocrProfileSelect');
      const roi = document.getElementById('ocrRoiSelect');
      const auto = document.getElementById('toggleAutoReadOcr');
      if (!card || !grid || !lang || !profile || !roi || !auto) return { found: false };

      const cardTitle = card.querySelector('.card-title')?.innerText.trim();
      const gridStyle = window.getComputedStyle(grid);
      const langRect = lang.getBoundingClientRect();
      const profileRect = profile.getBoundingClientRect();
      const roiRect = roi.getBoundingClientRect();
      const autoRect = auto.closest('.ocr-auto-toggle-wrapper').getBoundingClientRect();

      // On 1920px, all 4 fields should be in a single row (similar top/Y coordinate)
      const maxDeltaY = Math.max(
        Math.abs(langRect.top - profileRect.top),
        Math.abs(langRect.top - roiRect.top),
        Math.abs(langRect.top - autoRect.top)
      );

      return {
        found: true,
        cardTitle,
        display: gridStyle.display,
        columns: gridStyle.gridTemplateColumns.split(' ').length,
        singleRowAt1920: maxDeltaY < 15,
        maxDeltaY
      };
    })()`);

    console.log('R1 Desktop 1920px Check:', r1Desktop);
    if (!r1Desktop.found || r1Desktop.cardTitle !== 'Pengaturan OCR' || !r1Desktop.singleRowAt1920) {
      throw new Error('FAIL: OCR settings not arranged in a neat single row inside Card Pengaturan OCR!');
    }
    console.log('  ✅ R1: Pengaturan OCR card with 4-item unified grid row verified at 1920px');
    await cdp.screenshot('r1_r2_readtext_1920px.png');

    console.log('\n--- 2. VERIFYING READ TEXT AT 768px (Tablet 2x2 Grid) ---');
    await cdp.setViewport(768, 1024);
    const r1Tablet = await cdp.evaluate(`(() => {
      const grid = document.querySelector('.ocr-settings-grid');
      const gridStyle = window.getComputedStyle(grid);
      const cols = gridStyle.gridTemplateColumns.split(' ').length;
      return { cols };
    })()`);
    console.log('Tablet 768px Grid Columns:', r1Tablet);
    if (r1Tablet.cols !== 2) {
      throw new Error(`FAIL: Expected 2 grid columns at 768px, got ${r1Tablet.cols}`);
    }
    console.log('  ✅ 768px: Grid neatly wraps to 2 columns on tablet');
    await cdp.screenshot('r1_r2_readtext_768px.png');

    console.log('\n--- 3. VERIFYING READ TEXT AT 375px (Mobile 1 Column Clean Stack) ---');
    await cdp.setViewport(375, 812);
    const r1Mobile = await cdp.evaluate(`(() => {
      const grid = document.querySelector('.ocr-settings-grid');
      const gridStyle = window.getComputedStyle(grid);
      const cols = gridStyle.gridTemplateColumns.split(' ').length;
      return { cols };
    })()`);
    console.log('Mobile 375px Grid Columns:', r1Mobile);
    if (r1Mobile.cols !== 1) {
      throw new Error(`FAIL: Expected 1 grid column at 375px, got ${r1Mobile.cols}`);
    }
    console.log('  ✅ 375px: Grid neatly adapts to single column on mobile');
    await cdp.screenshot('r1_r2_readtext_375px.png');

    console.log('\n🎉 ALL READ TEXT R1 & R2 CHECKS PASSED WITH DOM & SCREENSHOT EVIDENCE!\n');
    cdp.close();
  } finally {
    try { chromeProc.kill(); } catch (e) {}
  }
}

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
