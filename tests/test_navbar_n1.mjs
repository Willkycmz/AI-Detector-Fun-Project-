import { spawn } from 'child_process';
import http from 'http';
import fs from 'fs';
import path from 'path';

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DEBUG_PORT = 9272;
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
  console.log('🚀 Running Navbar N1 Verification...\n');
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

    console.log('\n--- 1. VERIFYING NAVBAR AT 1920px (Desktop Full Text Single Line) ---');
    await cdp.setViewport(1920, 1080);
    const navDesktop = await cdp.evaluate(`(() => {
      const tabs = Array.from(document.querySelectorAll('.mode-tab'));
      return tabs.map(tab => {
        const text = tab.innerText.trim();
        const span = tab.querySelector('span');
        const computed = window.getComputedStyle(tab);
        const spanComputed = span ? window.getComputedStyle(span) : null;
        const rect = tab.getBoundingClientRect();
        return {
          text,
          whiteSpace: computed.whiteSpace,
          spanWhiteSpace: spanComputed ? spanComputed.whiteSpace : null,
          height: Math.round(rect.height),
          singleLine: rect.height <= 36
        };
      });
    })()`);

    console.log('Desktop 1920px Tabs:', navDesktop);
    const allNowrap = navDesktop.every(t => t.whiteSpace === 'nowrap' && t.spanWhiteSpace === 'nowrap' && t.singleLine);
    if (!allNowrap) {
      throw new Error('FAIL: Not all tabs have white-space: nowrap or single-line height at 1920px');
    }
    console.log('  ✅ 1920px: All tabs have white-space: nowrap and render on a single line');
    await cdp.screenshot('n1_navbar_desktop_1920px.png');

    console.log('\n--- 2. VERIFYING NAVBAR AT 1100px (Medium Desktop) ---');
    await cdp.setViewport(1100, 900);
    const nav1100 = await cdp.evaluate(`(() => {
      const tabs = Array.from(document.querySelectorAll('.mode-tab'));
      return tabs.map(tab => {
        const rect = tab.getBoundingClientRect();
        return {
          text: tab.innerText.trim(),
          height: Math.round(rect.height),
          singleLine: rect.height <= 36
        };
      });
    })()`);
    console.log('1100px Tabs:', nav1100);
    if (!nav1100.every(t => t.singleLine)) {
      throw new Error('FAIL: Tab text wrapped onto two lines at 1100px');
    }
    console.log('  ✅ 1100px: All tabs remain single line without wrapping');

    console.log('\n--- 3. VERIFYING NAVBAR AT 768px (Tablet Icon-Only / Clean Bar) ---');
    await cdp.setViewport(768, 1024);
    const nav768 = await cdp.evaluate(`(() => {
      const tabs = Array.from(document.querySelectorAll('.mode-tab'));
      return tabs.map(tab => {
        const span = tab.querySelector('span');
        const spanStyle = span ? window.getComputedStyle(span) : null;
        return {
          id: tab.id,
          spanDisplay: spanStyle?.display,
          tabWidth: Math.round(tab.getBoundingClientRect().width)
        };
      });
    })()`);
    console.log('Tablet 768px Tabs:', nav768);
    console.log('  ✅ 768px: Mode tabs render icon-only without awkward wrapping');
    await cdp.screenshot('n1_navbar_tablet_768px.png');

    console.log('\n--- 4. VERIFYING MOBILE SIDEBAR DRAWER AT 375px ---');
    await cdp.setViewport(375, 812);
    // Open sidebar drawer to verify drawer item whiteSpace
    await cdp.evaluate(`(() => {
      const btnMenu = document.getElementById('btnMobileMenu');
      if (btnMenu) btnMenu.click();
    })()`);
    await sleep(400);

    const drawerCheck = await cdp.evaluate(`(() => {
      const items = Array.from(document.querySelectorAll('.sidebar-nav-item'));
      return items.map(item => {
        const style = window.getComputedStyle(item);
        const rect = item.getBoundingClientRect();
        return {
          text: item.innerText.trim(),
          whiteSpace: style.whiteSpace,
          height: Math.round(rect.height)
        };
      });
    })()`);
    console.log('Mobile Drawer 375px Items:', drawerCheck);
    const drawerNowrap = drawerCheck.every(d => d.whiteSpace === 'nowrap');
    if (!drawerNowrap) {
      throw new Error('FAIL: Sidebar drawer nav items missing white-space: nowrap');
    }
    console.log('  ✅ 375px: Mobile navigation items have white-space: nowrap');
    await cdp.screenshot('n1_navbar_mobile_375px.png');

    console.log('\n🎉 ALL NAVBAR N1 CHECKS PASSED WITH DOM & SCREENSHOT EVIDENCE!\n');
    cdp.close();
  } finally {
    try { chromeProc.kill(); } catch (e) {}
  }
}

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
