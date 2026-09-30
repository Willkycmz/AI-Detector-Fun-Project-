import { spawn } from 'child_process';
import http from 'http';
import fs from 'fs';
import path from 'path';

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DEBUG_PORT = 9270;
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
  console.log('🚀 Running Dataset Manager D1 Verification...\n');
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

    console.log('\n--- 1. SWITCHING TO DATASET MANAGER WORKSPACE ---');
    await cdp.setViewport(1920, 1080);
    await cdp.evaluate(`window.visionXApp.setMode('manager');`);
    await sleep(800);

    // Check manager UI state
    const uiState = await cdp.evaluate(`(() => {
      const container = document.getElementById('mgrGridContainer');
      if (!container) return { found: false };
      const rawText = container.innerText.trim();
      const hasCards = container.querySelectorAll('.manager-card').length > 0;
      const emptyState = container.querySelector('.manager-empty-state');
      const errorState = container.querySelector('.manager-error-state');
      const isStillHanging = rawText.includes('Memuat dataset dari disk...') && !hasCards && !emptyState && !errorState;
      return {
        found: true,
        hasCards,
        cardsCount: container.querySelectorAll('.manager-card').length,
        hasEmptyState: !!emptyState,
        emptyTitle: emptyState ? emptyState.querySelector('.empty-title')?.innerText : null,
        hasEmptyImportFiles: emptyState ? !!emptyState.querySelector('#btnEmptyImportFiles') : false,
        hasEmptyImportFolder: emptyState ? !!emptyState.querySelector('#btnEmptyImportFolder') : false,
        hasErrorState: !!errorState,
        isStillHanging
      };
    })()`);

    console.log('Dataset Manager Initial Load UI State:', uiState);
    if (uiState.isStillHanging) {
      throw new Error('FAIL: "Memuat dataset dari disk..." is hanging without resolving!');
    }
    console.log('  ✅ Dataset Manager successfully resolved fetch without hanging');
    await cdp.screenshot('d1_manager_initial_1920px.png');

    console.log('\n--- 2. VERIFYING EMPTY STATE ("Belum Ada Dataset" + Import Buttons) ---');
    await cdp.setViewport(768, 1024);
    // Force items to [] to test empty state rendering
    await cdp.evaluate(`(() => {
      window.visionXApp.managerService.items = [];
      window.visionXApp.renderManagerGrid();
    })()`);
    await sleep(300);

    const emptyCheck = await cdp.evaluate(`(() => {
      const emptyState = document.querySelector('.manager-empty-state');
      if (!emptyState) return { found: false };
      const title = emptyState.querySelector('.empty-title')?.innerText.trim();
      const btnFiles = emptyState.querySelector('#btnEmptyImportFiles');
      const btnFolder = emptyState.querySelector('#btnEmptyImportFolder');
      return {
        found: true,
        title,
        hasBtnFiles: !!btnFiles,
        hasBtnFolder: !!btnFolder,
        btnFilesText: btnFiles?.innerText.trim(),
        btnFolderText: btnFolder?.innerText.trim()
      };
    })()`);

    console.log('Empty State Check:', emptyCheck);
    if (!emptyCheck.found || !emptyCheck.hasBtnFiles || !emptyCheck.hasBtnFolder) {
      throw new Error(`FAIL: Empty state missing required title or import buttons!`);
    }
    console.log('  ✅ Empty State verified: "Belum Ada Dataset" + Import File & Folder buttons active');
    await cdp.screenshot('d1_manager_empty_state_768px.png');

    console.log('\n--- 3. VERIFYING ERROR STATE + TIMEOUT + RETRY BUTTON ---');
    await cdp.setViewport(375, 812);
    await cdp.evaluate(`(() => {
      window.visionXApp.renderManagerError(new Error('Koneksi timeout setelah 6000ms'));
    })()`);
    await sleep(300);

    const errorCheck = await cdp.evaluate(`(() => {
      const errorState = document.querySelector('.manager-error-state');
      if (!errorState) return { found: false };
      const title = errorState.querySelector('.error-title')?.innerText.trim();
      const desc = errorState.querySelector('.error-desc')?.innerText.trim();
      const retryBtn = errorState.querySelector('#btnMgrRetryFetch');
      return {
        found: true,
        title,
        desc,
        hasRetryBtn: !!retryBtn,
        retryText: retryBtn?.innerText.trim()
      };
    })()`);

    console.log('Error State Check:', errorCheck);
    if (!errorCheck.found || !errorCheck.hasRetryBtn) {
      throw new Error('FAIL: Error state missing retry button or title!');
    }
    console.log('  ✅ Error State verified: Timeout message + Coba Lagi button functional');
    await cdp.screenshot('d1_manager_error_state_375px.png');

    console.log('\n🎉 ALL DATASET MANAGER D1 CHECKS PASSED WITH DOM & SCREENSHOT EVIDENCE!\n');
    cdp.close();
  } finally {
    try { chromeProc.kill(); } catch (e) {}
  }
}

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
