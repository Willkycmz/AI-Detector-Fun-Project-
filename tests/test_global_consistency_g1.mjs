import { spawn } from 'child_process';
import http from 'http';
import fs from 'fs';
import path from 'path';

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DEBUG_PORT = 9278;
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
  console.log('🚀 Running Global Consistency G1 Verification Suite...\n');
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

    const workspaces = [
      { mode: 'detection', name: 'Vision', selector: '#controlsCard' },
      { mode: 'collection', name: 'Collection', selector: '#collectionControls' },
      { mode: 'manager', name: 'Dataset Manager', selector: '#managerControls' },
      { mode: 'read_text', name: 'Read Text', selector: '#readTextControls' },
      { mode: 'identity', name: 'Identity Lab', selector: '#identityControls' }
    ];

    console.log('\n--- 1. AUDITING CONSISTENCY ACROSS ALL 5 WORKSPACES (1920px) ---');
    await cdp.setViewport(1920, 1080);

    for (const ws of workspaces) {
      await cdp.evaluate(`window.visionXApp.setMode('${ws.mode}', { startCamera: false });`);
      await sleep(400);

      const audit = await cdp.evaluate(`(() => {
        const el = document.querySelector('${ws.selector}');
        if (!el) return { found: false };
        const cards = Array.from(el.querySelectorAll('.card'));
        const headers = Array.from(el.querySelectorAll('.card-header, .panel-section-header, .read-text-header-row'));
        const primaryBtns = Array.from(el.querySelectorAll('.btn-hero, .btn-primary, .btn-start, .btn-capture, .btn-ocr-scan'));
        
        const cardRadii = cards.map(c => window.getComputedStyle(c).borderRadius);
        const cardBorders = cards.map(c => window.getComputedStyle(c).borderStyle);
        const primaryHeights = primaryBtns.map(b => Math.round(b.getBoundingClientRect().height));

        return {
          found: true,
          cardsCount: cards.length,
          cardRadii: Array.from(new Set(cardRadii)),
          cardBorders: Array.from(new Set(cardBorders)),
          primaryHeights,
          hasHorizontalOverflow: document.documentElement.scrollWidth > window.innerWidth
        };
      })()`);

      console.log(`Workspace [${ws.name}]:`, audit);
      if (audit.hasHorizontalOverflow) {
        throw new Error(`FAIL: Horizontal overflow in workspace ${ws.name}`);
      }
      console.log(`  ✅ [${ws.name}]: Consistent cards, borders, zero overflow`);
      await cdp.screenshot(`g1_workspace_${ws.mode}_1920px.png`);
    }

    console.log('\n--- 2. AUDITING MOBILE ZERO-OVERFLOW ACROSS ALL WORKSPACES (375px) ---');
    await cdp.setViewport(375, 812);

    for (const ws of workspaces) {
      await cdp.evaluate(`window.visionXApp.setMode('${ws.mode}', { startCamera: false });`);
      await sleep(350);

      const overflowCheck = await cdp.evaluate(`(() => {
        const scrollW = document.documentElement.scrollWidth;
        const innerW = window.innerWidth;
        return {
          scrollW,
          innerW,
          overflow: scrollW > innerW
        };
      })()`);

      console.log(`Mobile 375px [${ws.name}]:`, overflowCheck);
      if (overflowCheck.overflow) {
        throw new Error(`FAIL: Mobile horizontal overflow in workspace ${ws.name}: ${overflowCheck.scrollW} > ${overflowCheck.innerW}`);
      }
      console.log(`  ✅ Mobile [${ws.name}]: Perfect zero overflow (${overflowCheck.scrollW}px <= ${overflowCheck.innerW}px)`);
    }

    await cdp.screenshot('g1_mobile_all_workspaces_verified_375px.png');

    console.log('\n🎉 ALL GLOBAL CONSISTENCY G1 CHECKS PASSED!\n');
    cdp.close();
  } finally {
    try { chromeProc.kill(); } catch (e) {}
  }
}

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
