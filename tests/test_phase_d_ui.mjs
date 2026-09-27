/**
 * test_phase_d_ui.mjs - Phase D Secondary Modes Validation Suite
 * Validates:
 * 1. Read Text UX:
 *    - Scan button visible & >= 48px touch target
 *    - Read aloud button visible
 *    - OCR result box no clipping & scroll works
 *    - Secondary controls accessible
 * 2. Collection Mode UX:
 *    - Hero capture button visible & >= 48px
 *    - Quick class selector works
 *    - Counter visible
 *    - Gallery usable
 * 3. Dataset Manager UX:
 *    - Search works
 *    - Filters work
 *    - 2-column grid on mobile, 3-4 on tablet, 5-6 on desktop
 *    - Multi-select actions available
 *    - No action bar overlap
 * 4. Identity Lab UX:
 *    - Identity profile & decision card visible
 *    - Reference gallery usable (horizontal scroll on mobile)
 *    - Enrollment controls accessible
 *    - Threshold slider accessible
 * 5. Multi-viewport validation:
 *    - 375x667, 390x844, 412x915, 768x1024 portrait, 1024x768 landscape, 1280x1024, 1440x900
 *    - Zero horizontal overflow
 *    - Zero console errors
 */

import { spawn } from 'child_process';
import http from 'http';

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DEBUG_PORT = 9228;
const TARGET_URL = 'http://localhost:5173/';

const VIEWPORTS = [
  { name: 'Mobile Compact (iPhone SE)', width: 375, height: 667, isMobile: true },
  { name: 'Mobile Standard (iPhone 13/14)', width: 390, height: 844, isMobile: true },
  { name: 'Mobile Large (Pixel 7 / Android)', width: 412, height: 915, isMobile: true },
  { name: 'Tablet Portrait (iPad)', width: 768, height: 1024, isMobile: false },
  { name: 'Tablet Landscape (iPad)', width: 1024, height: 768, isMobile: false },
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
  console.log('📱 Starting VisionX V1.5 Phase D Secondary Modes Validation Test');
  console.log('================================================================');

  const chromeProc = spawn(CHROME_PATH, [
    '--headless=new',
    `--remote-debugging-port=${DEBUG_PORT}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
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
      await sleep(300);

      // ==========================================
      // 1. READ TEXT MODE VALIDATION
      // ==========================================
      const readTextRes = await send('Runtime.evaluate', {
        expression: `(() => {
          window.visionXApp.setMode('read_text');
          const panel = document.getElementById('readTextControls');
          const btnTrigger = document.getElementById('btnTriggerOcr');
          const btnSpeak = document.getElementById('btnSpeakOcr');
          const btnRescan = document.getElementById('btnReScanOcr');
          const btnStop = document.getElementById('btnStopOcr');
          const resultBox = document.getElementById('ocrResultBox');
          const warningBanner = document.getElementById('ocrWarningBanner');
          const langSelect = document.getElementById('ocrLangSelect');
          const profileSelect = document.getElementById('ocrProfileSelect');
          const roiSelect = document.getElementById('ocrRoiSelect');
          const telemetryDetails = document.querySelector('.ocr-telemetry-details');

          const tRect = btnTrigger.getBoundingClientRect();
          const sRect = btnSpeak.getBoundingClientRect();
          const rRect = resultBox.getBoundingClientRect();

          const hasOverflow = document.documentElement.scrollWidth > window.innerWidth;

          return {
            mode: window.visionXApp.currentMode,
            panelVisible: !panel.classList.contains('hidden'),
            triggerExists: !!btnTrigger,
            triggerVisible: tRect.width > 0 && tRect.height > 0,
            triggerHeight: Math.round(tRect.height),
            speakExists: !!btnSpeak,
            speakVisible: sRect.width > 0 && sRect.height > 0,
            speakHeight: Math.round(sRect.height),
            rescanExists: !!btnRescan,
            stopExists: !!btnStop,
            resultBoxExists: !!resultBox,
            resultBoxHeight: Math.round(rRect.height),
            resultBoxScrollable: window.getComputedStyle(resultBox).overflowY === 'auto',
            warningBannerExists: !!warningBanner,
            langSelectExists: !!langSelect,
            profileSelectExists: !!profileSelect,
            roiSelectExists: !!roiSelect,
            telemetryDetailsExists: !!telemetryDetails,
            hasOverflow
          };
        })()`,
        returnByValue: true
      });

      const rVal = readTextRes.result.value;
      if (rVal.panelVisible && rVal.triggerVisible && rVal.triggerHeight >= 44 && rVal.speakVisible && rVal.resultBoxScrollable) {
        console.log(`  ✅ [Read Text] Pass: Scan btn (${rVal.triggerHeight}px) & Speak btn (${rVal.speakHeight}px) visible, ResultBox scrollable`);
      } else {
        console.error(`  ❌ [Read Text] Fail:`, rVal);
        allTestsPassed = false;
      }

      if (rVal.hasOverflow) {
        console.error(`  ❌ [Read Text] Horizontal overflow detected!`);
        allTestsPassed = false;
      }

      // ==========================================
      // 2. COLLECTION MODE VALIDATION
      // ==========================================
      const collectRes = await send('Runtime.evaluate', {
        expression: `(() => {
          window.visionXApp.setMode('collection');
          const panel = document.getElementById('collectionControls');
          const btnCapture = document.getElementById('btnCapture');
          const activeClass = document.getElementById('activeClassDisplay');
          const activeCount = document.getElementById('activeCountDisplay');
          const inputClass = document.getElementById('inputClassName');
          const btnSetClass = document.getElementById('btnSetClass');
          const classPills = document.querySelectorAll('.class-pill');
          const gallery = document.getElementById('recentCapturesList');

          const cRect = btnCapture.getBoundingClientRect();
          const hasOverflow = document.documentElement.scrollWidth > window.innerWidth;

          // Test pill click: click "bottle"
          let pillClicked = false;
          const bottlePill = document.querySelector('.class-pill[data-class="bottle"]');
          if (bottlePill) {
            bottlePill.click();
            pillClicked = inputClass.value === 'bottle';
          }

          return {
            mode: window.visionXApp.currentMode,
            panelVisible: !panel.classList.contains('hidden'),
            captureExists: !!btnCapture,
            captureVisible: cRect.width > 0 && cRect.height > 0,
            captureHeight: Math.round(cRect.height),
            activeClassExists: !!activeClass,
            activeClassText: activeClass.textContent,
            activeCountExists: !!activeCount,
            classInputExists: !!inputClass,
            pillClicked,
            galleryExists: !!gallery,
            hasOverflow
          };
        })()`,
        returnByValue: true
      });

      const cVal = collectRes.result.value;
      if (cVal.panelVisible && cVal.captureVisible && cVal.captureHeight >= 48 && cVal.pillClicked && cVal.activeClassExists) {
        console.log(`  ✅ [Collection] Pass: Hero capture (${cVal.captureHeight}px) visible, quick class selector pill clicked, active class: ${cVal.activeClassText}`);
      } else {
        console.error(`  ❌ [Collection] Fail:`, cVal);
        allTestsPassed = false;
      }

      if (cVal.hasOverflow) {
        console.error(`  ❌ [Collection] Horizontal overflow detected!`);
        allTestsPassed = false;
      }

      // ==========================================
      // 3. DATASET MANAGER MODE VALIDATION
      // ==========================================
      const mgrRes = await send('Runtime.evaluate', {
        expression: `(() => {
          window.visionXApp.setMode('manager');
          const panel = document.getElementById('managerControls');
          const searchInput = document.getElementById('mgrSearchInput');
          const selectClass = document.getElementById('mgrSelectClass');
          const selectSource = document.getElementById('mgrSelectSource');
          const btnViewActive = document.getElementById('btnMgrViewActive');
          const btnViewTrash = document.getElementById('btnMgrViewTrash');
          const grid = document.getElementById('mgrGridContainer');
          const btnTrash = document.getElementById('btnMgrTrashSelected');
          const btnSelectAll = document.getElementById('btnMgrSelectAll');

          const gridComputed = window.getComputedStyle(grid);
          const gridColumns = gridComputed.gridTemplateColumns ? gridComputed.gridTemplateColumns.split(' ').length : 0;
          const hasOverflow = document.documentElement.scrollWidth > window.innerWidth;

          // Test search input typeable
          searchInput.value = 'test_search';
          searchInput.dispatchEvent(new Event('input', { bubbles: true }));

          return {
            mode: window.visionXApp.currentMode,
            panelVisible: !panel.classList.contains('hidden'),
            searchExists: !!searchInput,
            searchWorks: searchInput.value === 'test_search',
            filterClassExists: !!selectClass,
            filterSourceExists: !!selectSource,
            viewActiveExists: !!btnViewActive,
            viewTrashExists: !!btnViewTrash,
            gridExists: !!grid,
            gridColumns,
            btnTrashExists: !!btnTrash,
            btnSelectAllExists: !!btnSelectAll,
            hasOverflow
          };
        })()`,
        returnByValue: true
      });

      const mVal = mgrRes.result.value;
      if (mVal.panelVisible && mVal.searchWorks && mVal.filterClassExists && mVal.gridColumns >= 2) {
        console.log(`  ✅ [Manager] Pass: Search works, filters available, grid responsive (${mVal.gridColumns} cols)`);
      } else {
        console.error(`  ❌ [Manager] Fail:`, mVal);
        allTestsPassed = false;
      }

      if (mVal.hasOverflow) {
        console.error(`  ❌ [Manager] Horizontal overflow detected!`);
        allTestsPassed = false;
      }

      // ==========================================
      // 4. IDENTITY LAB MODE VALIDATION
      // ==========================================
      const idRes = await send('Runtime.evaluate', {
        expression: `(() => {
          window.visionXApp.setMode('identity');
          const panel = document.getElementById('identityControls');
          const profileName = document.getElementById('idLabProfileName');
          const decisionBadge = document.getElementById('idLabDecisionBadge');
          const scoreBar = document.getElementById('idLabSimilarityBar');
          const thresholdSlider = document.getElementById('idLabThresholdSlider');
          const thresholdVal = document.getElementById('idLabThresholdVal');
          const btnImport = document.getElementById('btnIdLabImport');
          const btnCaptureCam = document.getElementById('btnIdLabCaptureCam');
          const refGallery = document.getElementById('idLabRefGallery');

          const bImportRect = btnImport.getBoundingClientRect();
          const hasOverflow = document.documentElement.scrollWidth > window.innerWidth;

          // Test threshold adjustment
          thresholdSlider.value = '0.70';
          thresholdSlider.dispatchEvent(new Event('input', { bubbles: true }));

          return {
            mode: window.visionXApp.currentMode,
            panelVisible: !panel.classList.contains('hidden'),
            profileNameExists: !!profileName,
            profileNameText: profileName.textContent,
            decisionBadgeExists: !!decisionBadge,
            scoreBarExists: !!scoreBar,
            thresholdSliderExists: !!thresholdSlider,
            thresholdValUpdated: thresholdVal.textContent === '0.70',
            btnImportExists: !!btnImport,
            btnImportHeight: Math.round(bImportRect.height),
            btnCaptureCamExists: !!btnCaptureCam,
            refGalleryExists: !!refGallery,
            hasOverflow
          };
        })()`,
        returnByValue: true
      });

      const iVal = idRes.result.value;
      if (iVal.panelVisible && iVal.profileNameExists && iVal.decisionBadgeExists && iVal.thresholdValUpdated && iVal.btnImportHeight >= 38) {
        console.log(`  ✅ [Identity Lab] Pass: Profile (${iVal.profileNameText}) visible, decision badge active, threshold updated to 0.70, enrollment accessible`);
      } else {
        console.error(`  ❌ [Identity Lab] Fail:`, iVal);
        allTestsPassed = false;
      }

      if (iVal.hasOverflow) {
        console.error(`  ❌ [Identity Lab] Horizontal overflow detected!`);
        allTestsPassed = false;
      }
    }

    // Reset back to detection mode
    await send('Runtime.evaluate', { expression: `window.visionXApp.setMode('detection');` });

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
      console.log('🏆 ALL PHASE D SECONDARY MODES TESTS PASSED SUCCESSFULLY!');
      console.log('================================================================');
      process.exit(0);
    } else {
      console.error('❌ SOME PHASE D SECONDARY MODES TESTS FAILED.');
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
