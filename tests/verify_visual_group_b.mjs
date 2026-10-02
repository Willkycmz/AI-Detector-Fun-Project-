import { spawn } from 'child_process';
import fs from 'fs';
import http from 'http';
import path from 'path';

const phase = process.argv[2] || 'before';
const ROOT = 'C:\\Users\\advan\\Documents\\VisionX';
const OUTPUT_DIR = path.join(ROOT, 'artifacts', 'visual-audit', 'group-b');
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DEBUG_PORT = phase === 'before' ? 9341 : 9342;
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
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); }
  async connect() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.socket.onopen = resolve;
      this.socket.onerror = reject;
      this.socket.onmessage = ({ data }) => {
        const message = JSON.parse(data);
        if (!message.id || !this.pending.has(message.id)) return;
        const request = this.pending.get(message.id);
        this.pending.delete(message.id);
        message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result);
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
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result?.value;
  }
  async viewport(width, height) {
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 768 });
    await sleep(250);
  }
  async screenshot(name) {
    const result = await this.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(OUTPUT_DIR, `${phase}_${name}.png`);
    fs.writeFileSync(file, Buffer.from(result.data, 'base64'));
    return file;
  }
}

const vite = spawn('cmd.exe', ['/d', '/s', '/c', 'npm run dev -- --host 127.0.0.1'], {
  cwd: path.join(ROOT, 'web'), stdio: 'ignore', windowsHide: true
});
const chrome = spawn(CHROME_PATH, [
  '--headless=new', `--remote-debugging-port=${DEBUG_PORT}`, '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', '--hide-scrollbars', `--user-data-dir=${path.join(OUTPUT_DIR, `.chrome-${phase}`)}`, 'about:blank'
], { stdio: 'ignore' });

let client;
try {
  let targets;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { targets = await fetchJson(`http://127.0.0.1:${DEBUG_PORT}/json`); if (targets?.length) break; } catch {}
    await sleep(250);
  }
  if (!targets?.length) throw new Error('Chrome CDP tidak tersedia');
  const page = targets.find((target) => target.type === 'page');
  client = new CDPClient(page.webSocketDebuggerUrl);
  await client.connect();
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Page.navigate', { url: TARGET_URL });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await sleep(250);
    if (await client.evaluate('Boolean(window.visionXApp && document.getElementById("btnMobileNewChat"))')) break;
  }
  await client.evaluate(`(() => {
    localStorage.setItem('visionx_theme_preference', 'light');
    window.visionXApp.themeManager?.applyTheme('light');
    document.getElementById('errorBanner')?.classList.add('hidden');
    document.getElementById('successBanner')?.classList.add('hidden');
  })()`);
  await client.viewport(390, 844);
  const metrics = { phase };

  metrics.bug05 = await client.evaluate(`(() => {
    window.visionXApp.setMode('detection');
    document.getElementById('toolBtnAsk')?.click();
    const view = document.getElementById('contextual-tools-view');
    const nav = document.querySelector('.bottom-nav-bar');
    const panel = view?.firstElementChild;
    const workspace = document.getElementById('workspaceContainer');
    if (workspace) workspace.scrollTop = workspace.scrollHeight;
    const vr = view?.getBoundingClientRect(); const nr = nav?.getBoundingClientRect();
    const pr = panel?.getBoundingClientRect();
    const paddingBottom = parseFloat(getComputedStyle(view).paddingBottom) || 0;
    const navHeight = nr?.height || 0;
    return {
      viewBottom: Math.round(vr?.bottom || 0),
      navTop: Math.round(nr?.top || 0),
      clearance: Math.round((nr?.top || 0) - (vr?.bottom || 0)),
      panelBottomClearance: Math.round((vr?.bottom || 0) - (pr?.bottom || 0)),
      paddingBottom: Math.round(paddingBottom),
      navHeight: Math.round(navHeight),
      hasSafeBottomClearance: paddingBottom >= navHeight,
      workspaceScrolledToBottom: Boolean(workspace && workspace.scrollTop > 0),
      scrollWidth: view?.scrollWidth || 0
    };
  })()`);
  await client.screenshot('bug05_contextual_tools_390');

  metrics.bug06 = await client.evaluate(`(() => {
    document.getElementById('btnMobileProfile')?.click();
    const nav = document.querySelector('.settings-tabs-nav');
    document.querySelector('#tabBtnDeveloper')?.classList.remove('hidden');
    const before = nav?.scrollLeft || 0;
    if (nav) nav.scrollLeft = nav.scrollWidth;
    const last = document.querySelector('.settings-tab-btn:last-child')?.getBoundingClientRect();
    const nr = nav?.getBoundingClientRect();
    return { overflowX: getComputedStyle(nav).overflowX, scrollWidth: nav?.scrollWidth || 0, clientWidth: nav?.clientWidth || 0, scrollLeftBefore: before, lastFullyVisible: Boolean(last && nr && last.left >= nr.left && last.right <= nr.right) };
  })()`);
  await client.screenshot('bug06_settings_tabs_390');

  metrics.bug07 = await client.evaluate(`(() => {
    document.getElementById('btnCloseSettingsModal')?.click();
    const dot = document.getElementById('mobileStatusDot');
    dot?.click();
    const pop = document.getElementById('headerStatusPopover');
    const r = pop?.getBoundingClientRect();
    return { isInteractive: dot?.tagName === 'BUTTON', popoverOpen: Boolean(pop && !pop.classList.contains('hidden')), popoverInViewport: Boolean(r && r.bottom > 0 && r.top < innerHeight), popoverTop: Math.round(r?.top || 0) };
  })()`);
  await client.screenshot('bug07_mobile_status_390');

  metrics.bug08 = await client.evaluate(`(() => {
    const app = window.visionXApp;
    const read = (mode) => { app.setMode(mode); return { mode, title: document.getElementById('mobileHeaderModeTitle')?.textContent || '', newChatVisible: Boolean(document.getElementById('btnMobileNewChat')?.getBoundingClientRect().width) }; };
    return { home: read('home'), detection: read('detection'), readText: read('read_text') };
  })()`);
  await client.screenshot('bug08_mobile_header_modes_390');

  const metricsPath = path.join(OUTPUT_DIR, `${phase}_metrics.json`);
  fs.writeFileSync(metricsPath, JSON.stringify(metrics, null, 2));
  console.log(JSON.stringify({ metricsPath, metrics }, null, 2));
} finally {
  client?.socket?.close();
  chrome.kill();
  vite.kill();
}