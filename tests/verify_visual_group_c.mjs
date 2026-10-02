import { spawn } from 'child_process';
import fs from 'fs';
import http from 'http';
import path from 'path';

const phase = process.argv[2] || 'after';
const ROOT = 'C:\\Users\\advan\\Documents\\VisionX';
const OUTPUT_DIR = path.join(ROOT, 'artifacts', 'visual-audit', 'group-c');
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DEBUG_PORT = phase === 'before' ? 9351 : 9352;
const TARGET_URL = 'http://127.0.0.1:5173/';
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fetchJson = (url) => new Promise((resolve, reject) => {
  http.get(url, (response) => {
    let body = '';
    response.on('data', (chunk) => { body += chunk; });
    response.on('end', () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } });
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

const vite = spawn('cmd.exe', ['/d', '/s', '/c', 'npm run dev -- --host 127.0.0.1 --port 5173 --strictPort'], {
  cwd: path.join(ROOT, 'web'), stdio: 'ignore', windowsHide: true
});
const chrome = spawn(CHROME_PATH, [
  '--headless=new', `--remote-debugging-port=${DEBUG_PORT}`, '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', '--hide-scrollbars', `--user-data-dir=${path.join(OUTPUT_DIR, `.chrome-${phase}`)}`, 'about:blank'
], { stdio: 'ignore' });

let client;
try {
  let targets;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try { targets = await fetchJson(`http://127.0.0.1:${DEBUG_PORT}/json`); if (targets?.length) break; } catch {}
    await sleep(250);
  }
  if (!targets?.length) throw new Error('Chrome CDP tidak tersedia');
  client = new CDPClient(targets.find((target) => target.type === 'page').webSocketDebuggerUrl);
  await client.connect();
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try { const response = await fetchJson(`http://127.0.0.1:5173/manifest.webmanifest`); if (response) break; } catch {}
    await sleep(250);
  }
  await client.send('Page.navigate', { url: TARGET_URL });
  let appReady = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const ready = await client.evaluate(`(() => {
      const app = document.querySelector('.app-container');
      const stylesheetLoaded = [...document.styleSheets].some(sheet => sheet.href?.endsWith('/src/style.css'));
      return Boolean(document.getElementById('workspaceContainer') && app && stylesheetLoaded && getComputedStyle(app).display !== 'block');
    })()`);
    if (ready) { appReady = true; break; }
    await sleep(250);
  }
  if (!appReady) {
    const state = await client.evaluate(`({ url: location.href, readyState: document.readyState, stylesheets: [...document.styleSheets].map(sheet => sheet.href), chatDisplay: getComputedStyle(document.querySelector('.chat-container')).display })`);
    throw new Error(`Aplikasi/CSS tidak siap: ${JSON.stringify(state)}`);
  }
  await client.evaluate(`(() => {
    document.getElementById('workspaceContainer')?.setAttribute('data-active-workspace', 'home');
    document.getElementById('visionxAuthModal')?.classList.add('hidden');
  })()`);

  if (phase === 'before') {
    await client.evaluate(`(() => {
      const style = document.createElement('style');
      style.id = 'audit-before-overrides';
      style.textContent = '.auth-link-btn{padding:0;min-height:0}.chat-welcome-screen{margin:20px auto 20px!important}.welcome-hero-logo{width:48px!important;height:48px!important}.chat-input-dock .btn-stop-gen{display:none!important}';
      document.head.appendChild(style);
    })()`);
  }

  const metrics = { phase, bug09: {}, bug10: {}, bug11: {}, bug12: {}, screenshots: [] };
  for (const width of [1920, 1280, 390]) {
    await client.viewport(width, width === 390 ? 844 : 900);
    metrics.bug09[width] = await client.evaluate(`(() => {
      const modal = document.getElementById('visionxAuthModal');
      modal?.classList.remove('hidden');
      const button = document.getElementById('btnAuthForgotPassword');
      const rect = button?.getBoundingClientRect();
      const text = button?.textContent?.trim() || '';
      const visible = Boolean(button && rect && rect.width > 0 && rect.height > 0);
      return { height: Math.round(rect?.height || 0), width: Math.round(rect?.width || 0), text, textIntact: text === 'Lupa Password?', visible };
    })()`);
    metrics.screenshots.push(await client.screenshot(`bug09_auth_${width}`));
    await client.evaluate(`document.getElementById('visionxAuthModal')?.classList.add('hidden')`);
  }

  metrics.bug10 = await client.evaluate(`(() => {
    const name = 'dataset_gambar_produk_dengan_nama_sangat_panjang_2026.jpg';
    const host = document.createElement('div'); host.id = 'auditDatasetFixture';
    host.style.cssText = 'width:220px;position:fixed;left:24px;top:100px;z-index:9999';
    host.innerHTML = '<div class="manager-card"><div class="manager-card-thumb-wrapper" style="height:120px;background:#0f172a"></div><div class="manager-card-body"><span class="manager-card-filename dataset-item-name" title="' + name + '">' + name + '</span><div class="manager-card-meta"><span>💾 Impor</span><span>2026</span></div></div></div>';
    document.body.appendChild(host);
    const item = host.querySelector('.dataset-item-name');
    const style = getComputedStyle(item);
    const result = { name, title: item.title, titleMatches: item.title === name, ellipsis: style.textOverflow === 'ellipsis' && style.overflow === 'hidden' && style.whiteSpace === 'nowrap', contained: item.scrollWidth >= item.clientWidth };
    return result;
  })()`);
  await client.viewport(1920, 900); metrics.screenshots.push(await client.screenshot('bug10_dataset_1920'));
  await client.viewport(1280, 900); metrics.screenshots.push(await client.screenshot('bug10_dataset_1280'));
  await client.evaluate(`document.getElementById('auditDatasetFixture')?.remove()`);

  await client.viewport(390, 844);
  metrics.bug11.mobile = await client.evaluate(`(() => {
    const hero = document.querySelector('.chat-welcome-screen');
    const prompts = document.querySelector('.quick-prompts-section');
    const logo = document.querySelector('.welcome-hero-logo');
    const hr = hero?.getBoundingClientRect(); const pr = prompts?.getBoundingClientRect(); const lr = logo?.getBoundingClientRect();
    return { promptsVisibleWithoutScroll: Boolean(pr && pr.top < innerHeight && pr.bottom > 0), promptTop: Math.round(pr?.top || 0), logoWidth: Math.round(lr?.width || 0), heroMarginTop: parseFloat(getComputedStyle(hero).marginTop), heroMarginBottom: parseFloat(getComputedStyle(hero).marginBottom) };
  })()`);
  metrics.screenshots.push(await client.screenshot('bug11_home_390'));
  for (const width of [1920, 1280]) {
    await client.viewport(width, 900);
    metrics.bug11[width] = await client.evaluate(`(() => { const h=document.querySelector('.chat-welcome-screen'); const l=document.querySelector('.welcome-hero-logo'); return { marginTop: parseFloat(getComputedStyle(h).marginTop), marginBottom: parseFloat(getComputedStyle(h).marginBottom), logoWidth: Math.round(l?.getBoundingClientRect().width || 0) }; })()`);
    metrics.screenshots.push(await client.screenshot(`home_${width}`));
  }

  await client.viewport(390, 844);
  metrics.bug12 = await client.evaluate(`(() => {
    const stop = document.getElementById('btnStopGeneration');
    const send = document.getElementById('btnSendChatMessage');
    const composer = document.getElementById('chatInputContainer');
    const read = () => ({ stop: { width: stop.getBoundingClientRect().width, height: stop.getBoundingClientRect().height, visibility: getComputedStyle(stop).visibility, position: getComputedStyle(stop).position, tabIndex: stop.tabIndex }, send: { left: send.getBoundingClientRect().left, top: send.getBoundingClientRect().top }, composer: { left: composer.getBoundingClientRect().left, top: composer.getBoundingClientRect().top } });
    const idle = read();
    stop.classList.add('is-streaming'); stop.setAttribute('aria-hidden', 'false'); stop.tabIndex = 0;
    const active = read();
    return { verification: 'DOM manipulation per acceptance note', idle, active, sendShift: { left: Math.abs(active.send.left-idle.send.left), top: Math.abs(active.send.top-idle.send.top) }, composerShift: { left: Math.abs(active.composer.left-idle.composer.left), top: Math.abs(active.composer.top-idle.composer.top) }, stableWithin2px: Math.abs(active.send.left-idle.send.left)<=2 && Math.abs(active.send.top-idle.send.top)<=2 && Math.abs(active.composer.left-idle.composer.left)<=2 && Math.abs(active.composer.top-idle.composer.top)<=2, idleNotFocusable: idle.stop.tabIndex === -1 && idle.stop.visibility === 'hidden', activeVisibleAndFocusable: active.stop.tabIndex === 0 && active.stop.visibility === 'visible' };
  })()`);
  metrics.screenshots.push(await client.screenshot('bug12_composer_390'));
  await client.evaluate(`(() => { const stop=document.getElementById('btnStopGeneration'); stop?.classList.remove('is-streaming'); stop?.setAttribute('aria-hidden', 'true'); if (stop) stop.tabIndex=-1; })()`);

  const metricsPath = path.join(OUTPUT_DIR, `${phase}_metrics.json`);
  fs.writeFileSync(metricsPath, JSON.stringify(metrics, null, 2));
  console.log(JSON.stringify({ metricsPath, metrics }, null, 2));
} finally {
  client?.socket?.close();
  chrome.kill();
  vite.kill();
}