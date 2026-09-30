/**
 * tests/verify_live_site.mjs
 * Live verification for https://app.visionx.my.id and https://visionx.my.id
 */

import { spawn } from 'child_process';
import http from 'http';
import fs from 'fs';
import path from 'path';

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DEBUG_PORT = 9240;
const LIVE_URL = 'https://app.visionx.my.id/';
const LANDING_URL = 'https://visionx.my.id/';
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
  console.log('\n================================================================');
  console.log('🚀 Starting VisionX Live Production Verification');
  console.log('================================================================\n');

  const chromeProc = spawn(CHROME_PATH, [
    '--headless=new',
    `--remote-debugging-port=${DEBUG_PORT}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    'about:blank'
  ], { stdio: 'ignore' });

  let ws;
  let msgId = 1;
  const pendingCalls = new Map();
  const networkErrors = [];

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
      } else if (msg.method === 'Network.responseReceived') {
        const { response } = msg.params;
        if (response.status >= 400 && !response.url.includes('favicon')) {
          networkErrors.push({ url: response.url, status: response.status });
        }
      }
    };

    await sendCommand('Page.enable');
    await sendCommand('Runtime.enable');
    await sendCommand('Network.enable');

    // 1. Check https://app.visionx.my.id/
    console.log(`Navigating to ${LIVE_URL}...`);
    await sendCommand('Emulation.setDeviceMetricsOverride', {
      width: 1280,
      height: 1024,
      deviceScaleFactor: 1,
      mobile: false
    });
    await sendCommand('Page.navigate', { url: LIVE_URL });
    await sleep(4000);

    const liveState = await evaluate(`(() => {
      const title = document.title;
      const workspace = document.getElementById('workspaceContainer');
      const activeWs = workspace ? workspace.getAttribute('data-active-workspace') : null;
      const theme = document.documentElement.getAttribute('data-theme');
      const stageCard = document.getElementById('stageCard');
      const homeView = document.getElementById('homeView');
      const stageVisible = stageCard ? (window.getComputedStyle(stageCard).display !== 'none') : false;
      const homeVisible = homeView ? (window.getComputedStyle(homeView).display !== 'none') : false;
      const hasORT = typeof ort !== 'undefined';
      return {
        title,
        activeWs,
        theme,
        stageVisible,
        homeVisible,
        hasORT
      };
    })()`);

    console.log('Live App State (https://app.visionx.my.id):', liveState);

    // Capture screenshot of live desktop
    const liveShot = await sendCommand('Page.captureScreenshot', { format: 'png' });
    const liveShotPath = path.join(ARTIFACTS_DIR, 'm6_live_production_1280x1024.png');
    fs.writeFileSync(liveShotPath, Buffer.from(liveShot.data, 'base64'));
    console.log(`Saved live desktop screenshot: ${liveShotPath}`);

    // Check for HTTP 405 or 404 network errors
    const http405 = networkErrors.filter(e => e.status === 405);
    console.log(`Network status: ${networkErrors.length} errors, HTTP 405: ${http405.length}`);

    // 2. Check https://visionx.my.id/
    console.log(`\nNavigating to ${LANDING_URL}...`);
    await sendCommand('Page.navigate', { url: LANDING_URL });
    await sleep(3000);
    const landingState = await evaluate(`(() => {
      return {
        title: document.title,
        url: window.location.href
      };
    })()`);
    console.log('Landing state (https://visionx.my.id):', landingState);

    console.log('\n✅ LIVE VERIFICATION COMPLETED SUCCESSFULLY!');
  } finally {
    if (ws) ws.close();
    chromeProc.kill();
  }
}

run().catch(err => {
  console.error('\n❌ LIVE VERIFICATION FAILED:', err);
  process.exit(1);
});
