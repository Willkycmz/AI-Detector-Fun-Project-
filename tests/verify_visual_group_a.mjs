import { spawn } from 'child_process';
import fs from 'fs';
import http from 'http';
import path from 'path';

const phase = process.argv[2] || 'before';
const ROOT = 'C:\\Users\\advan\\Documents\\VisionX';
const OUTPUT_DIR = path.join(ROOT, 'artifacts', 'visual-audit', 'group-a');
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DEBUG_PORT = phase === 'before' ? 9331 : 9332;
const TARGET_URL = 'http://127.0.0.1:5173/';

fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fetchJson = (url) => new Promise((resolve, reject) => {
  http.get(url, (response) => {
    let body = '';
    response.on('data', (chunk) => { body += chunk; });
    response.on('end', () => {
      try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
    });
  }).on('error', reject);
});

class CDPClient {
  constructor(webSocketUrl) {
    this.webSocketUrl = webSocketUrl;
    this.id = 0;
    this.pending = new Map();
  }

  async connect() {
    this.socket = new WebSocket(this.webSocketUrl);
    await new Promise((resolve, reject) => {
      this.socket.onopen = resolve;
      this.socket.onerror = reject;
      this.socket.onmessage = ({ data }) => {
        const message = JSON.parse(data);
        if (!message.id || !this.pending.has(message.id)) return;
        const { resolve: done, reject: fail } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) fail(new Error(message.error.message));
        else done(message.result);
      };
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result?.value;
  }

  async viewport(width, height) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: width < 768
    });
    await sleep(250);
  }

  async screenshot(name) {
    const result = await this.send('Page.captureScreenshot', { format: 'png' });
    const output = path.join(OUTPUT_DIR, `${phase}_${name}.png`);
    fs.writeFileSync(output, Buffer.from(result.data, 'base64'));
    return output;
  }
}

const chrome = spawn(CHROME_PATH, [
  '--headless=new',
  `--remote-debugging-port=${DEBUG_PORT}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  '--hide-scrollbars',
  '--user-data-dir=' + path.join(OUTPUT_DIR, `.chrome-${phase}`),
  'about:blank'
], { stdio: 'ignore' });

let client;
try {
  let targets;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      targets = await fetchJson(`http://127.0.0.1:${DEBUG_PORT}/json`);
      if (targets?.length) break;
    } catch {}
    await sleep(250);
  }
  if (!targets?.length) throw new Error('Chrome CDP tidak tersedia');

  const page = targets.find((target) => target.type === 'page');
  client = new CDPClient(page.webSocketDebuggerUrl);
  await client.connect();
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Page.navigate', { url: TARGET_URL });

  let ready = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await sleep(250);
    try {
      ready = await client.evaluate('Boolean(window.visionXApp && document.getElementById("headerUserAvatar"))');
      if (ready) break;
    } catch {}
  }
  if (!ready) throw new Error('VisionX tidak siap');

  await client.evaluate(`(() => {
    localStorage.setItem('visionx_theme_preference', 'light');
    window.visionXApp.themeManager?.applyTheme('light');
    document.getElementById('errorBanner')?.classList.add('hidden');
    document.getElementById('successBanner')?.classList.add('hidden');
  })()`);

  const metrics = { phase };

  for (const width of [1920, 1280]) {
    await client.viewport(width, width === 1920 ? 1080 : 900);
    metrics[`avatar_${width}`] = await client.evaluate(`(() => {
      const dropdown = document.getElementById('userAvatarDropdown');
      const notice = document.getElementById('developerNoticeModal');
      dropdown?.classList.add('hidden');
      notice?.classList.add('hidden');
      document.getElementById('headerUserAvatar')?.click();
      return {
        dropdownOpen: dropdown ? !dropdown.classList.contains('hidden') : false,
        developerModalOpen: notice ? !notice.classList.contains('hidden') : false
      };
    })()`);
    await sleep(200);
    await client.screenshot(`bug01_avatar_${width}`);
    await client.evaluate(`document.getElementById('developerNoticeModal')?.classList.add('hidden');`);
  }

  await client.viewport(1280, 900);
  metrics.tabs1280 = await client.evaluate(`(() => {
    ['btnModeCollect', 'btnModeManager', 'btnModeIdentity'].forEach((id) => document.getElementById(id)?.classList.remove('hidden'));
    const group = document.querySelector('.mode-toggle-group')?.getBoundingClientRect();
    const actions = document.querySelector('.header-actions')?.getBoundingClientRect();
    const tabs = Array.from(document.querySelectorAll('.mode-tab:not(.hidden)')).map((tab) => ({
      id: tab.id,
      labelVisible: getComputedStyle(tab.querySelector('span')).display !== 'none',
      right: Math.round(tab.getBoundingClientRect().right)
    }));
    return {
      tabs,
      groupRight: Math.round(group?.right || 0),
      actionsLeft: Math.round(actions?.left || 0),
      overlap: Boolean(group && actions && group.right > actions.left)
    };
  })()`);
  await client.screenshot('bug02_tabs_1280');

  await client.viewport(390, 844);
  metrics.mobileHeader = await client.evaluate(`(() => {
    window.visionXApp.setMode('home');
    const theme = document.getElementById('btnMobileThemeToggle');
    const profile = document.getElementById('btnMobileProfile');
    return {
      themeButtonVisible: Boolean(theme && theme.getBoundingClientRect().width),
      profileButtonVisible: Boolean(profile && profile.getBoundingClientRect().width)
    };
  })()`);
  await client.screenshot('bug03_mobile_header_390');

  metrics.mobileSheet = await client.evaluate(`(() => {
    document.getElementById('btnMobileMore')?.classList.remove('hidden');
    document.getElementById('btnMobileMore')?.click();
    return { open: !document.getElementById('moreBottomSheet')?.classList.contains('hidden') };
  })()`);
  await sleep(200);
  await client.screenshot('bug04_bottom_sheet_390');

  metrics.sheetManagerNavigation = await client.evaluate(`(() => {
    const app = window.visionXApp;
    const originalSetMode = app.setMode.bind(app);
    let requestedMode = null;
    app.setMode = (mode, options) => { requestedMode = mode; return true; };
    document.getElementById('sheetBtnManager')?.click();
    app.setMode = originalSetMode;
    return {
      requestedMode,
      sheetClosed: document.getElementById('moreBottomSheet')?.classList.contains('hidden')
    };
  })()`);
  metrics.sheetIdentityNavigation = await client.evaluate(`(() => {
    const app = window.visionXApp;
    const originalSetMode = app.setMode.bind(app);
    let requestedMode = null;
    app.setMode = (mode, options) => { requestedMode = mode; return true; };
    document.getElementById('btnMobileMore')?.click();
    document.getElementById('sheetBtnIdentity')?.click();
    app.setMode = originalSetMode;
    return {
      requestedMode,
      sheetClosed: document.getElementById('moreBottomSheet')?.classList.contains('hidden')
    };
  })()`);

  const metricsPath = path.join(OUTPUT_DIR, `${phase}_metrics.json`);
  fs.writeFileSync(metricsPath, JSON.stringify(metrics, null, 2));
  console.log(JSON.stringify({ metricsPath, metrics }, null, 2));
} finally {
  client?.socket?.close();
  chrome.kill();
}