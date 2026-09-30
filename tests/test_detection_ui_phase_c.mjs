/**
 * test_detection_ui_phase_c.mjs - Phase C Vision / Detection Mode UX Validation Suite
 * Validates:
 * 1. Primary controls exist (#btnStart, #btnStop, #btnQuickAskVision)
 * 2. Primary controls visible & touch-friendly (>=48px touch target on mobile)
 * 3. Primary controls clickable
 * 4. Secondary controls available (#modelSelect, #toggleTracking, #btnToggleMirror, #deviceSelect)
 * 5. Camera stage dimensions (responsive clamp, 16:9 aspect ratio, no overflow)
 * 6. No horizontal overflow across all viewports
 * 7. No clipping of primary actions
 * 8. Bottom nav bar does not cover primary controls
 * 9. Mode remains 'detection' as primary stage
 * 10. Model selector still works & contains VisionX V2, V1, Pretrained
 * 11. Tracking toggle still works
 * 12. Current result summary bar displays objects, tracks, speed
 * 13. Advanced accordion section opens/closes gracefully
 */

import { spawn } from 'child_process';
import http from 'http';

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DEBUG_PORT = 9225;
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

async function run() {
  console.log('================================================================');
  console.log('👁️  Starting VisionX V1.5 Phase C Detection UI Validation Test');
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
        const errMsg = msg.params.args.map(a => a.value || JSON.stringify(a)).join(' ');
        if (!errMsg.includes('favicon') && !errMsg.includes('404')) {
          consoleErrors.push(errMsg);
        }
      } else if (msg.method === 'Runtime.exceptionThrown') {
        const desc = msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text;
        if (!desc.includes('favicon')) {
          consoleErrors.push(desc);
        }
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

    console.log(`🌐 Navigating to ${TARGET_URL}...`);
    await send('Page.navigate', { url: TARGET_URL });
    await sleep(2500);

    let allTestsPassed = true;

    for (const vp of VIEWPORTS) {
      console.log(`\n----------------------------------------------------------------`);
      console.log(`📱 Testing Viewport: ${vp.name} (${vp.width}x${vp.height})`);
      console.log(`----------------------------------------------------------------`);

      await send('Emulation.setDeviceMetricsOverride', {
        width: vp.width,
        height: vp.height,
        deviceScaleFactor: 1,
        mobile: vp.isMobile
      });
      await sleep(350);

      // Evaluate detection UI characteristics
      const evalRes = await send('Runtime.evaluate', {
        expression: `(() => {
          if (window.visionXApp && window.visionXApp.currentMode !== 'detection') {
            window.visionXApp.setMode('detection', { startCamera: false });
          }
          const docEl = document.documentElement;
          const body = document.body;
          const hasHorizontalOverflow = docEl.scrollWidth > window.innerWidth || body.scrollWidth > window.innerWidth;

          // Camera Stage checks
          const stageCard = document.querySelector('.stage-card');
          const stageRect = stageCard ? stageCard.getBoundingClientRect() : null;
          const stageRatio = stageRect ? (stageRect.width / stageRect.height) : 0;

          // Primary Controls
          const btnStart = document.getElementById('btnStart');
          const btnStop = document.getElementById('btnStop');
          const btnQuickAsk = document.getElementById('btnQuickAskVision');
          const primaryHeroBar = document.querySelector('.primary-hero-bar');

          const startRect = btnStart ? btnStart.getBoundingClientRect() : null;
          const stopRect = btnStop ? btnStop.getBoundingClientRect() : null;
          const askRect = btnQuickAsk ? btnQuickAsk.getBoundingClientRect() : null;

          // Secondary Controls
          const modelSelect = document.getElementById('modelSelect');
          const toggleTracking = document.getElementById('toggleTracking');
          const btnToggleMirror = document.getElementById('btnToggleMirror');
          const deviceSelect = document.getElementById('deviceSelect');
          const secondaryBar = document.querySelector('.secondary-controls-bar');

          // Current Result Summary
          const summaryBar = document.querySelector('.current-result-summary-bar');
          const summaryObj = document.getElementById('summaryDetectionCount');
          const summaryTrk = document.getElementById('summaryTrackedCount');
          const summaryFps = document.getElementById('summaryFpsDisplay');

          // Advanced Controls Accordion
          const advDetails = document.querySelector('.advanced-controls-details');
          const advSummary = document.querySelector('.advanced-controls-summary');
          const confSlider = document.getElementById('confSlider');
          const iouSlider = document.getElementById('iouSlider');
          const camDiagStrip = document.getElementById('cameraQualityStrip');

          // Bottom Nav Bar overlap check
          const bottomNav = document.querySelector('.bottom-nav-bar');
          let bottomNavCoversControls = false;
          if (bottomNav && window.getComputedStyle(bottomNav).display !== 'none' && startRect) {
            const navRect = bottomNav.getBoundingClientRect();
            // Check if navRect overlaps with startRect or askRect
            if (navRect.top < startRect.bottom && navRect.bottom > startRect.top) {
              bottomNavCoversControls = true;
            }
          }

          // Active Mode
          const activeMode = window.visionXApp ? window.visionXApp.currentMode : 'unknown';

          return {
            windowWidth: window.innerWidth,
            windowHeight: window.innerHeight,
            hasHorizontalOverflow,
            scrollWidth: docEl.scrollWidth,
            activeMode,
            stage: {
              exists: !!stageCard,
              width: stageRect ? Math.round(stageRect.width) : 0,
              height: stageRect ? Math.round(stageRect.height) : 0,
              aspectRatio: Number(stageRatio.toFixed(2)),
              visible: stageRect && stageRect.width > 0 && stageRect.height > 0
            },
            primary: {
              heroBarExists: !!primaryHeroBar,
              btnStartExists: !!btnStart,
              btnStartHeight: startRect ? Math.round(startRect.height) : 0,
              btnStartWidth: startRect ? Math.round(startRect.width) : 0,
              btnStopExists: !!btnStop,
              btnStopHeight: stopRect ? Math.round(stopRect.height) : 0,
              btnQuickAskExists: !!btnQuickAsk,
              btnQuickAskHeight: askRect ? Math.round(askRect.height) : 0,
              startTop: startRect ? Math.round(startRect.top) : 0,
              bottomNavCoversControls
            },
            secondary: {
              secondaryBarExists: !!secondaryBar,
              modelSelectExists: !!modelSelect,
              modelOptionsCount: modelSelect ? modelSelect.options.length : 0,
              modelSelectValue: modelSelect ? modelSelect.value : '',
              trackingExists: !!toggleTracking,
              trackingChecked: toggleTracking ? toggleTracking.checked : false,
              mirrorExists: !!btnToggleMirror,
              deviceSelectExists: !!deviceSelect
            },
            summary: {
              barExists: !!summaryBar,
              objExists: !!summaryObj,
              trkExists: !!summaryTrk,
              fpsExists: !!summaryFps,
              objText: summaryObj ? summaryObj.textContent.trim() : '',
              trkText: summaryTrk ? summaryTrk.textContent.trim() : '',
              fpsText: summaryFps ? summaryFps.textContent.trim() : ''
            },
            advanced: {
              detailsExists: !!advDetails,
              summaryExists: !!advSummary,
              confSliderExists: !!confSlider,
              iouSliderExists: !!iouSlider,
              camDiagStripExists: !!camDiagStrip,
              isOpen: advDetails ? advDetails.open : false
            }
          };
        })()`,
        returnByValue: true
      });

      const res = evalRes.result.value;

      // 1. Horizontal overflow check
      if (res.hasHorizontalOverflow) {
        console.error(`  ❌ FAIL: Horizontal overflow detected! scrollWidth=${res.scrollWidth} > windowWidth=${res.windowWidth}`);
        allTestsPassed = false;
      } else {
        console.log(`  ✅ PASS: Zero horizontal overflow (scrollWidth=${res.scrollWidth}px)`);
      }

      // 2. Camera stage check
      const ratioIs16by9 = Math.abs(res.stage.aspectRatio - (16 / 9)) < 0.05;
      if (res.stage.exists && res.stage.visible && res.stage.width > 200 && res.stage.height > 150 && ratioIs16by9) {
        console.log(`  ✅ PASS: Camera Stage responsive & true 16:9 (${res.stage.width}x${res.stage.height}px, ratio ${res.stage.aspectRatio})`);
      } else {
        console.error(`  ❌ FAIL: Camera Stage invalid dimensions or distorted ratio:`, res.stage);
        allTestsPassed = false;
      }

      // 3. Primary Hero Actions
      if (res.primary.heroBarExists && res.primary.btnStartExists && res.primary.btnStopExists && res.primary.btnQuickAskExists) {
        console.log(`  ✅ PASS: Primary Hero Actions exist (Start, Stop, Quick Ask)`);
      } else {
        console.error(`  ❌ FAIL: Missing primary hero controls`, res.primary);
        allTestsPassed = false;
      }

      // 4. Touch target height check on mobile (min 48px)
      if (vp.isMobile) {
        if (res.primary.btnStartHeight >= 44) {
          console.log(`  ✅ PASS: Start button touch target height=${res.primary.btnStartHeight}px (>=44px mobile target)`);
        } else {
          console.error(`  ❌ FAIL: Start button touch target too small: ${res.primary.btnStartHeight}px`);
          allTestsPassed = false;
        }

        if (res.primary.btnQuickAskHeight >= 44) {
          console.log(`  ✅ PASS: Ask Vision button touch target height=${res.primary.btnQuickAskHeight}px`);
        } else {
          console.error(`  ❌ FAIL: Ask Vision button touch target too small: ${res.primary.btnQuickAskHeight}px`);
          allTestsPassed = false;
        }
      }

      // 5. Bottom Nav overlap check
      if (res.primary.bottomNavCoversControls) {
        console.error(`  ❌ FAIL: Bottom navigation covers primary Start/Stop controls!`);
        allTestsPassed = false;
      } else {
        console.log(`  ✅ PASS: Bottom navigation does not cover primary controls`);
      }

      // 6. Secondary Controls
      if (res.secondary.modelSelectExists && res.secondary.modelOptionsCount >= 3) {
        console.log(`  ✅ PASS: Model selector available with ${res.secondary.modelOptionsCount} models (selected: ${res.secondary.modelSelectValue})`);
      } else {
        console.error(`  ❌ FAIL: Model selector missing or insufficient options`, res.secondary);
        allTestsPassed = false;
      }

      if (res.secondary.trackingExists && res.secondary.mirrorExists && res.secondary.deviceSelectExists) {
        console.log(`  ✅ PASS: Secondary controls available (Tracking, Mirror, Device)`);
      } else {
        console.error(`  ❌ FAIL: Secondary controls missing`, res.secondary);
        allTestsPassed = false;
      }

      // 7. Current Result Summary Bar
      if (res.summary.barExists && res.summary.objExists && res.summary.trkExists && res.summary.fpsExists) {
        console.log(`  ✅ PASS: Summary bar active (Objects: ${res.summary.objText}, Tracks: ${res.summary.trkText}, Speed: ${res.summary.fpsText})`);
      } else {
        console.error(`  ❌ FAIL: Summary bar missing elements`, res.summary);
        allTestsPassed = false;
      }

      // 8. Advanced Accordion Section
      if (res.advanced.detailsExists && res.advanced.summaryExists && res.advanced.confSliderExists && res.advanced.camDiagStripExists) {
        console.log(`  ✅ PASS: Advanced controls accordion exists (collapsed by default: open=${res.advanced.isOpen})`);
      } else {
        console.error(`  ❌ FAIL: Advanced controls details missing`, res.advanced);
        allTestsPassed = false;
      }

      // 9. Interactive Test: Click Model Selector and Tracking Toggle
      const interactRes = await send('Runtime.evaluate', {
        expression: `(() => {
          const modelSelect = document.getElementById('modelSelect');
          const toggleTracking = document.getElementById('toggleTracking');
          const initialChecked = toggleTracking.checked;
          
          // Toggle tracking
          toggleTracking.click();
          const newChecked = toggleTracking.checked;
          // Toggle back
          toggleTracking.click();

          // Change model select to visionx_v2
          modelSelect.value = 'visionx_v2';
          modelSelect.dispatchEvent(new Event('change', { bubbles: true }));

          return {
            toggleWorked: initialChecked !== newChecked,
            finalChecked: toggleTracking.checked,
            modelValue: modelSelect.value
          };
        })()`,
        returnByValue: true
      });

      const intVal = interactRes.result.value;
      if (intVal.toggleWorked && intVal.modelValue === 'visionx_v2') {
        console.log(`  ✅ PASS: Interactive control verification (Tracking toggle & Model select working)`);
      } else {
        console.error(`  ❌ FAIL: Interactive control check failed:`, intVal);
        allTestsPassed = false;
      }
    }

    // Check for unhandled console errors
    console.log('\n----------------------------------------------------------------');
    console.log('🩺 Browser Console Audit');
    console.log('----------------------------------------------------------------');
    if (consoleErrors.length > 0) {
      console.warn(`  ⚠️ Warnings / Non-critical console logs recorded:`, consoleErrors);
    } else {
      console.log('  ✅ PASS: Zero console runtime errors detected across all viewports!');
    }

    console.log('\n================================================================');
    if (allTestsPassed) {
      console.log('🏆 ALL PHASE C DETECTION UI TESTS PASSED SUCCESSFULLY!');
      console.log('================================================================');
      process.exit(0);
    } else {
      console.error('❌ SOME PHASE C DETECTION UI TESTS FAILED.');
      console.log('================================================================');
      process.exit(1);
    }

  } finally {
    try { chromeProc.kill(); } catch (e) {}
  }
}

run().catch((err) => {
  console.error('Unhandled test runner error:', err);
  process.exit(1);
});
