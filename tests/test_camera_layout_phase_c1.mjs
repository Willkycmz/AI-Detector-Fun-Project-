/**
 * test_camera_layout_phase_c1.mjs - Phase C.1 Camera Aspect Ratio Audit & Validation Suite
 * Audits computed browser dimensions for:
 * 1. Stage Card (.stage-card)
 * 2. Video Element (#videoElement)
 * 3. Canvas Overlay (#canvasOverlay)
 * 4. Video Source Dimensions (internal and rendered)
 * Across all 6 viewports:
 * - 375x667 (Mobile Compact)
 * - 390x844 (Mobile Standard)
 * - 412x915 (Mobile Large)
 * - 768x1024 (Tablet Portrait)
 * - 1280x1024 (Desktop Standard)
 * - 1440x900 (Desktop Widescreen)
 */

import { spawn } from 'child_process';
import http from 'http';

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DEBUG_PORT = 9227;
const TARGET_URL = 'http://localhost:5173/';

const VIEWPORTS = [
  { name: 'Mobile Compact (iPhone SE)', width: 375, height: 667, isMobile: true },
  { name: 'Mobile Standard (iPhone 13/14)', width: 390, height: 844, isMobile: true },
  { name: 'Mobile Large (Pixel 7 / Android)', width: 412, height: 915, isMobile: true },
  { name: 'Tablet Portrait (iPad)', width: 768, height: 1024, isMobile: false },
  { name: 'Desktop Standard', width: 1280, height: 1024, isMobile: false },
  { name: 'Desktop Widescreen', width: 1440, height: 900, isMobile: false },
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

export async function auditCameraLayout() {
  console.log('================================================================');
  console.log('📷 Starting VisionX V1.5 Phase C.1 Camera Layout Audit');
  console.log('================================================================');

  const chromeProc = spawn(CHROME_PATH, [
    '--headless=new',
    `--remote-debugging-port=${DEBUG_PORT}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    'about:blank'
  ], { stdio: 'ignore' });

  const auditResults = [];

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
      }
    };

    function send(method, params = {}) {
      const id = msgId++;
      return new Promise((resolve, reject) => {
        pendingCalls.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    }

    await send('Page.enable');
    await send('Runtime.enable');
    await send('DOM.enable');

    await send('Page.navigate', { url: TARGET_URL });
    await sleep(2500);

    for (const vp of VIEWPORTS) {
      await send('Emulation.setDeviceMetricsOverride', {
        width: vp.width,
        height: vp.height,
        deviceScaleFactor: 1,
        mobile: vp.isMobile
      });
      await sleep(350);

      const evalRes = await send('Runtime.evaluate', {
        expression: `(() => {
          const stageCard = document.querySelector('.stage-card');
          const video = document.getElementById('videoElement');
          const canvas = document.getElementById('canvasOverlay');
          const btnStart = document.getElementById('btnStart');
          const bottomNav = document.querySelector('.bottom-nav-bar');

          const sRect = stageCard ? stageCard.getBoundingClientRect() : { width: 0, height: 0, top: 0, left: 0 };
          const vRect = video ? video.getBoundingClientRect() : { width: 0, height: 0, top: 0, left: 0 };
          const cRect = canvas ? canvas.getBoundingClientRect() : { width: 0, height: 0, top: 0, left: 0 };
          const startRect = btnStart ? btnStart.getBoundingClientRect() : { top: 0, bottom: 0 };

          const vComputed = video ? window.getComputedStyle(video) : {};
          const cComputed = canvas ? window.getComputedStyle(canvas) : {};

          // Calculate aspect ratios
          const stageRatio = sRect.height > 0 ? (sRect.width / sRect.height) : 0;
          const videoRatio = vRect.height > 0 ? (vRect.width / vRect.height) : 0;
          const canvasRatio = cRect.height > 0 ? (cRect.width / cRect.height) : 0;

          // Target 16:9 ratio is 1.7777778
          const targetRatio = 16 / 9;
          const ratioDiff = Math.abs(stageRatio - targetRatio);
          const is16by9 = ratioDiff < 0.05;

          // Letterboxing check: if stage is much wider than 16:9, or video is letterboxed
          const letterboxingOccurs = ratioDiff >= 0.08 || Math.abs(vRect.width - sRect.width) > 4;

          const docEl = document.documentElement;
          const hasHorizontalOverflow = docEl.scrollWidth > window.innerWidth;

          let bottomNavCovers = false;
          if (bottomNav && window.getComputedStyle(bottomNav).display !== 'none') {
            const navRect = bottomNav.getBoundingClientRect();
            if (navRect.top < startRect.bottom && navRect.bottom > startRect.top) {
              bottomNavCovers = true;
            }
          }

          return {
            viewport: '${vp.name}',
            windowWidth: window.innerWidth,
            windowHeight: window.innerHeight,
            stage: {
              width: Math.round(sRect.width * 10) / 10,
              height: Math.round(sRect.height * 10) / 10,
              ratio: Math.round(stageRatio * 100) / 100,
              is16by9
            },
            video: {
              width: Math.round(vRect.width * 10) / 10,
              height: Math.round(vRect.height * 10) / 10,
              ratio: Math.round(videoRatio * 100) / 100,
              objectFit: vComputed.objectFit || 'contain'
            },
            canvas: {
              width: Math.round(cRect.width * 10) / 10,
              height: Math.round(cRect.height * 10) / 10,
              ratio: Math.round(canvasRatio * 100) / 100,
              objectFit: cComputed.objectFit || 'contain'
            },
            letterboxingOccurs,
            hasHorizontalOverflow,
            bottomNavCovers,
            primaryReachable: startRect.top < window.innerHeight
          };
        })()`,
        returnByValue: true
      });

      auditResults.push(evalRes.result.value);
    }

    return auditResults;
  } finally {
    try { chromeProc.kill(); } catch (e) {}
  }
}

async function main() {
  const results = await auditCameraLayout();
  console.log('\n📊 AUDIT RESULTS:');
  console.table(results.map(r => ({
    Viewport: r.viewport,
    Window: `${r.windowWidth}x${r.windowHeight}`,
    Stage: `${r.stage.width}x${r.stage.height} (ratio ${r.stage.ratio})`,
    '16:9?': r.stage.is16by9 ? '✅ YES' : '❌ NO',
    Video: `${r.video.width}x${r.video.height}`,
    Canvas: `${r.canvas.width}x${r.canvas.height}`,
    ObjectFit: r.video.objectFit,
    Letterboxing: r.letterboxingOccurs ? '⚠️ YES' : '✅ NO',
    Overflow: r.hasHorizontalOverflow ? '❌ YES' : '✅ NO'
  })));

  const allPreserved = results.every(r => r.stage.is16by9 && !r.letterboxingOccurs && !r.hasHorizontalOverflow);
  if (allPreserved) {
    console.log('\n🎉 ALL VIEWPORTS MEET 16:9 CAMERA RATIO & USABILITY CRITERIA!');
    process.exit(0);
  } else {
    console.log('\n⚠️ Some viewports have ratio discrepancies or letterboxing (Baseline captured).');
    process.exit(2);
  }
}

if (process.argv[1]?.endsWith('test_camera_layout_phase_c1.mjs')) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
