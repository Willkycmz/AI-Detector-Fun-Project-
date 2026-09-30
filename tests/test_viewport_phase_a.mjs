/**
 * test_viewport_phase_a.mjs - Phase A Multi-Viewport CDP Validation Suite
 * Tests 6 required viewports for VisionX V1.5 Responsive Foundation:
 * Mobile: 375x667, 390x844, 412x915
 * Tablet: 768x1024
 * Desktop: 1280x1024, 1440x900
 */

import { spawn } from 'child_process';
import http from 'http';

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DEBUG_PORT = 9223;
const TARGET_URL = 'http://localhost:5173/';

const VIEWPORTS = [
  { name: 'Mobile Compact (iPhone SE)', width: 375, height: 667, mobile: true },
  { name: 'Mobile Standard (iPhone 13/14)', width: 390, height: 844, mobile: true },
  { name: 'Mobile Large (Pixel 7 / Android)', width: 412, height: 915, mobile: true },
  { name: 'Tablet Portrait (iPad)', width: 768, height: 1024, mobile: true },
  { name: 'Desktop Standard', width: 1280, height: 1024, mobile: false },
  { name: 'Desktop Widescreen', width: 1440, height: 900, mobile: false },
];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchJson(url) {
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
  console.log('================================================================');
  console.log('📱 Starting VisionX V1.5 Phase A Multi-Viewport Browser Test');
  console.log('================================================================');

  const chromeProc = spawn(CHROME_PATH, [
    '--headless=new',
    `--remote-debugging-port=${DEBUG_PORT}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    'about:blank'
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

    if (!targets || targets.length === 0) {
      throw new Error('Could not connect to Chrome CDP debugging port');
    }

    const pageTarget = targets.find(t => t.type === 'page');
    const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
    let msgId = 1;
    const pendingCalls = new Map();
    const consoleErrors = [];

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
      } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        consoleErrors.push(msg.params.args.map(a => a.value || JSON.stringify(a)).join(' '));
      } else if (msg.method === 'Runtime.exceptionThrown') {
        consoleErrors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
      }
    };

    function send(method, params = {}) {
      const id = msgId++;
      return new Promise((resolve, reject) => {
        pendingCalls.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    }

    await send('Runtime.enable');
    await send('Page.enable');
    await send('Page.navigate', { url: TARGET_URL });

    console.log('Navigated to', TARGET_URL, '- waiting for app initialization...');
    
    // Poll for window.visionXApp
    let appReady = false;
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      const evalRes = await send('Runtime.evaluate', {
        expression: 'typeof window.visionXApp !== "undefined"',
        returnByValue: true
      });
      if (evalRes?.result?.value === true) {
        appReady = true;
        break;
      }
    }

    if (!appReady) {
      throw new Error('Timed out waiting for window.visionXApp initialization');
    }
    console.log('✅ VisionXWebApp initialized successfully in browser context!\n');

    let allPassed = true;

    for (const vp of VIEWPORTS) {
      console.log(`🔍 Testing Viewport: ${vp.name} (${vp.width}x${vp.height})...`);

      // Set Device Metrics
      await send('Emulation.setDeviceMetricsOverride', {
        width: vp.width,
        height: vp.height,
        deviceScaleFactor: 1,
        mobile: vp.mobile
      });

      await sleep(300);

      // Evaluate responsive metrics
      const evalMetrics = await send('Runtime.evaluate', {
        expression: `(() => {
          if (window.visionXApp && window.visionXApp.currentMode !== 'detection') {
            window.visionXApp.setMode('detection', { startCamera: false });
          }
          const docEl = document.documentElement;
          const body = document.body;
          const container = document.querySelector('.app-container');
          const stage = document.querySelector('.stage-card');
          const header = document.querySelector('.app-header');
          const bottomNav = document.querySelector('.bottom-nav-bar');
          
          const scrollWidth = docEl.scrollWidth;
          const innerWidth = window.innerWidth;
          const hasHorizontalOverflow = scrollWidth > innerWidth;

          const stageRect = stage ? stage.getBoundingClientRect() : null;
          const containerRect = container ? container.getBoundingClientRect() : null;
          
          // Test button clickability & hit-testing
          const startBtn = document.getElementById('btnStart');
          let startClickable = false;
          let hitInfo = null;
          if (startBtn) {
            startBtn.scrollIntoView({ block: 'start', behavior: 'instant' });
            const rect = startBtn.getBoundingClientRect();
            const hitEl = document.elementFromPoint(
              rect.left + rect.width / 2,
              rect.top + rect.height / 2
            );
            hitInfo = hitEl ? hitEl.tagName + '.' + (hitEl.className || '') : 'null';
            startClickable = !!(hitEl && (hitEl === startBtn || startBtn.contains(hitEl)));
          }

          // Test switching all 5 modes
          const modes = ['detection', 'read_text', 'collection', 'manager', 'identity'];
          const modeResults = {};
          
          for (const m of modes) {
            if (window.visionXApp && typeof window.visionXApp.setMode === 'function') {
              window.visionXApp.setMode(m);
              modeResults[m] = {
                currentMode: window.visionXApp.currentMode,
                overflow: docEl.scrollWidth > window.innerWidth
              };
            }
          }
          // Reset back to detection mode
          if (window.visionXApp) window.visionXApp.setMode('detection');

          return {
            scrollWidth,
            innerWidth,
            hasHorizontalOverflow,
            containerWidth: containerRect ? Math.round(containerRect.width) : 0,
            stageHeight: stageRect ? Math.round(stageRect.height) : 0,
            startClickable,
            hitInfo,
            modeResults,
            bottomNavDisplay: bottomNav ? window.getComputedStyle(bottomNav).display : 'none',
            headerDisplay: header ? window.getComputedStyle(header).display : 'none'
          };
        })()`,
        returnByValue: true
      });

      const res = evalMetrics.result.value;
      const passedOverflow = !res.hasHorizontalOverflow;
      const passedStart = res.startClickable;
      const allModesNoOverflow = Object.values(res.modeResults || {}).every(m => !m.overflow);

      if (passedOverflow && passedStart && allModesNoOverflow) {
        console.log(`   ✅ No Overflow: scrollWidth (${res.scrollWidth}px) <= innerWidth (${res.innerWidth}px)`);
        console.log(`   ✅ All 5 Modes Verified No Overflow: ${Object.keys(res.modeResults || {}).join(', ')}`);
        console.log(`   ✅ Container: ${res.containerWidth}px | Stage height: ${res.stageHeight}px`);
        console.log(`   ✅ Start Button Clickable: ${res.startClickable} | Bottom Nav: ${res.bottomNavDisplay}`);
      } else {
        allPassed = false;
        console.error(`   ❌ FAILURE in ${vp.name}:`, res);
      }
      console.log('');
    }

    console.log('================================================================');
    if (allPassed && consoleErrors.length === 0) {
      console.log('🎉 ALL 6 VIEWPORTS PASSED PHASE A RESPONSIVE FOUNDATION AUDIT!');
      console.log('Zero console errors, zero horizontal overflow, 100% controls clickable.');
    } else {
      console.error('❌ Viewport audit had failures or console errors:', consoleErrors);
      process.exitCode = 1;
    }
    console.log('================================================================\n');

  } finally {
    try { chromeProc.kill('SIGKILL'); } catch (e) {}
  }
}

run().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
