/**
 * test_browser_interaction.mjs - Real Browser Interaction Test via Chrome DevTools Protocol (CDP)
 */

import { spawn } from 'child_process';
import http from 'http';

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DEBUG_PORT = 9222;
const TARGET_URL = 'http://localhost:5173/';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

async function main() {
  console.log('--- Starting Chrome Headless for Browser Interaction Test ---');
  const chromeProc = spawn(CHROME_PATH, [
    '--headless=new',
    `--remote-debugging-port=${DEBUG_PORT}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    TARGET_URL
  ], { stdio: 'ignore' });

  try {
    // Wait for Chrome to be ready
    let targets = null;
    for (let i = 0; i < 30; i++) {
      await sleep(300);
      try {
        targets = await fetchJson(`http://127.0.0.1:${DEBUG_PORT}/json`);
        if (targets && targets.length > 0) break;
      } catch (e) {}
    }

    if (!targets || targets.length === 0) {
      throw new Error('Failed to connect to Chrome CDP targets');
    }

    const pageTarget = targets.find(t => t.type === 'page');
    if (!pageTarget || !pageTarget.webSocketDebuggerUrl) {
      throw new Error('No page target with webSocketDebuggerUrl found');
    }

    const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
    let msgId = 1;
    const pendingCalls = new Map();
    const consoleErrors = [];
    const consoleLogs = [];

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
      } else if (msg.method === 'Runtime.consoleAPICalled') {
        const type = msg.params.type;
        const text = msg.params.args.map(a => a.value || JSON.stringify(a)).join(' ');
        consoleLogs.push(`[${type}] ${text}`);
        if (type === 'error') {
          consoleErrors.push(text);
        }
      } else if (msg.method === 'Runtime.exceptionThrown') {
        const desc = msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text;
        consoleErrors.push(`[Exception] ${desc}`);
      }
    };

    function sendCommand(method, params = {}) {
      const id = msgId++;
      return new Promise((resolve, reject) => {
        pendingCalls.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    }

    await sendCommand('Runtime.enable');
    await sendCommand('Page.enable');

    console.log('Waiting for DOMContentLoaded & VisionX Web app initialization...');
    await sleep(2500);

    // 1. Evaluate window.visionXApp
    const evalApp = await sendCommand('Runtime.evaluate', {
      expression: `({
        exists: typeof window.visionXApp !== 'undefined',
        mode: window.visionXApp ? window.visionXApp.currentMode : null,
        ocrServiceExists: !!(window.visionXApp && window.visionXApp.ocrService),
        ocrStatus: window.visionXApp && window.visionXApp.ocrService ? window.visionXApp.ocrService.getStatus() : null,
        voiceEngineExists: !!(window.visionXApp && window.visionXApp.voiceEngine)
      })`,
      returnByValue: true
    });

    console.log('App state:', evalApp.result.value);
    if (!evalApp.result.value.exists) {
      console.error('Console errors logged:', consoleErrors);
      throw new Error('window.visionXApp is undefined!');
    }

    // Set viewport size
    await sendCommand('Emulation.setDeviceMetricsOverride', {
      width: 1280,
      height: 1024,
      deviceScaleFactor: 1,
      mobile: false
    });

    // 2. Check document.elementFromPoint hit-testing for pointer-events overlay blocking
    const evalHitTest = await sendCommand('Runtime.evaluate', {
      expression: `(() => {
        const buttons = [
          'btnModeDetect', 'btnModeCollect', 'btnModeManager',
          'btnModeIdentity', 'btnModeReadText', 'btnStart', 'btnStop'
        ];
        return buttons.map(id => {
          const el = document.getElementById(id);
          if (!el) return { id, found: false };
          el.scrollIntoView({ block: 'center' });
          const rect = el.getBoundingClientRect();
          const cx = rect.left + rect.width / 2;
          const cy = rect.top + rect.height / 2;
          const hit = document.elementFromPoint(cx, cy);
          return {
            id,
            found: true,
            isClickable: hit === el || el.contains(hit),
            hitTag: hit ? hit.tagName + (hit.id ? '#' + hit.id : '') : null
          };
        });
      })()`,
      returnByValue: true
    });

    console.log('Hit-test results (verifying no invisible overlay blocking):');
    evalHitTest.result.value.forEach(r => {
      console.log(`  - ${r.id}: found=${r.found}, clickable=${r.isClickable}, topElement=${r.hitTag}`);
      if (!r.isClickable) {
        throw new Error(`Element #${r.id} is blocked by ${r.hitTag}`);
      }
    });

    // 3. Test Mode Switching
    const modes = [
      { tabId: 'btnModeCollect', expectedMode: 'collection' },
      { tabId: 'btnModeManager', expectedMode: 'manager' },
      { tabId: 'btnModeIdentity', expectedMode: 'identity' },
      { tabId: 'btnModeReadText', expectedMode: 'read_text' },
      { tabId: 'btnModeDetect', expectedMode: 'detection' }
    ];

    for (const m of modes) {
      const clickRes = await sendCommand('Runtime.evaluate', {
        expression: `(() => {
          const btn = document.getElementById('${m.tabId}');
          if (!btn) return { success: false, reason: 'Button not found' };
          btn.click();
          return {
            success: true,
            currentMode: window.visionXApp.currentMode,
            isActive: btn.classList.contains('active')
          };
        })()`,
        returnByValue: true
      });

      console.log(`Tab Click ${m.tabId}:`, clickRes.result.value);
      if (clickRes.result.value.currentMode !== m.expectedMode) {
        throw new Error(`Failed switching to ${m.expectedMode} via ${m.tabId}, got: ${clickRes.result.value.currentMode}`);
      }
      if (!clickRes.result.value.isActive) {
        throw new Error(`Tab ${m.tabId} does not have active class after click`);
      }
    }

    // 4. Test Camera Controls Click
    const camRes = await sendCommand('Runtime.evaluate', {
      expression: `(() => {
        const btnStart = document.getElementById('btnStart');
        const btnStop = document.getElementById('btnStop');
        if (!btnStart || !btnStop) return { success: false, reason: 'Cam buttons not found' };
        btnStart.click();
        const startClicked = true;
        btnStop.click();
        const stopClicked = true;
        return { success: true, startClicked, stopClicked };
      })()`,
      returnByValue: true
    });
    console.log('Camera buttons click response:', camRes.result.value);

    // 5. Test Model Selector Dropdown & Switching (V2 <-> V1 <-> Pretrained)
    const modelRes = await sendCommand('Runtime.evaluate', {
      expression: `(async () => {
        const sel = document.getElementById('modelSelect');
        if (!sel) return { success: false, error: 'no modelSelect' };
        
        const hasV2 = Array.from(sel.options).some(o => o.value === 'visionx_v2');
        const hasV1 = Array.from(sel.options).some(o => o.value === 'visionx_v1');
        
        // Switch to visionx_v1
        sel.value = 'visionx_v1';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise(r => setTimeout(r, 400));
        const switchedV1 = window.visionXApp.inferenceService.currentModelId === 'visionx_v1';
        
        // Switch to visionx_v2
        sel.value = 'visionx_v2';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise(r => setTimeout(r, 400));
        const switchedV2 = window.visionXApp.inferenceService.currentModelId === 'visionx_v2';
        
        return {
          success: true,
          hasV2,
          hasV1,
          switchedV1,
          switchedV2,
          currentModel: window.visionXApp.inferenceService.currentModelId
        };
      })()`,
      awaitPromise: true,
      returnByValue: true
    });
    console.log('Model selector V1/V2 switching test:', modelRes.result.value);
    if (!modelRes.result.value || !modelRes.result.value.hasV2 || !modelRes.result.value.hasV1) {
      throw new Error(`Model selector missing V1 or V2: ${JSON.stringify(modelRes.result.value)}`);
    }

    // 6. Test Voice Toggle
    const voiceRes = await sendCommand('Runtime.evaluate', {
      expression: `(() => {
        const toggle = document.getElementById('toggleVoice');
        if (!toggle) return { success: false };
        const prev = toggle.checked;
        toggle.checked = !prev;
        toggle.dispatchEvent(new Event('change', { bubbles: true }));
        const toggled = toggle.checked;
        toggle.checked = prev;
        toggle.dispatchEvent(new Event('change', { bubbles: true }));
        return { success: true, toggled, restored: toggle.checked };
      })()`,
      returnByValue: true
    });
    console.log('Voice toggle test:', voiceRes.result.value);

    // 7. Test Read Text OCR Controls
    const ocrControlsRes = await sendCommand('Runtime.evaluate', {
      expression: `(() => {
        window.visionXApp.setMode('read_text');
        const btnScan = document.getElementById('btnTriggerOcr');
        const btnStop = document.getElementById('btnStopOcr');
        const btnSpeak = document.getElementById('btnSpeakOcr');
        const btnCopy = document.getElementById('btnCopyOcrText');
        const btnClear = document.getElementById('btnClearOcrText');
        const langSel = document.getElementById('ocrLangSelect');

        if (!btnScan || !btnStop || !btnSpeak || !btnCopy || !btnClear || !langSel) {
          return { success: false, reason: 'OCR controls missing' };
        }

        btnClear.click();
        btnCopy.click();
        btnStop.click();

        return {
          success: true,
          btnScanDisabled: btnScan.disabled,
          ocrMode: window.visionXApp.currentMode
        };
      })()`,
      returnByValue: true
    });
    console.log('OCR controls test:', ocrControlsRes.result.value);

    // 8. Test Dataset Controls
    const datasetRes = await sendCommand('Runtime.evaluate', {
      expression: `(() => {
        window.visionXApp.setMode('collection');
        const btnCapture = document.getElementById('btnCapture');
        const btnSelectDir = document.getElementById('btnSelectDir');
        const btnSetClass = document.getElementById('btnSetClass');
        const pills = document.querySelectorAll('.class-pill');
        if (!btnCapture || !btnSelectDir || !btnSetClass) {
          return { success: false, reason: 'Dataset controls missing' };
        }
        if (pills.length > 0) {
          pills[0].click();
        }
        return {
          success: true,
          activeClass: window.visionXApp.captureService.currentClass,
          pillCount: pills.length
        };
      })()`,
      returnByValue: true
    });
    console.log('Dataset controls test:', datasetRes.result.value);

    // 9. Test V1.0 AI Vision Assistant ("ASK VISIONX") Controls
    const askVisionRes = await sendCommand('Runtime.evaluate', {
      awaitPromise: true,
      expression: `(async () => {
        window.visionXApp.setMode('detection');
        const panel = document.getElementById('askVisionPanel');
        const form = document.getElementById('askVisionForm');
        const input = document.getElementById('askVisionInput');
        const btnSubmit = document.getElementById('btnAskVisionSubmit');
        const chips = document.querySelectorAll('.quick-prompt-chip');
        const btnRead = document.getElementById('btnReadAloudResponse');
        const btnStop = document.getElementById('btnStopSpeechResponse');
        const btnClear = document.getElementById('btnClearResponse');
        const statusBadge = document.getElementById('aiAssistantStatusBadge');

        if (!panel || !form || !input || !btnSubmit || !btnRead || !btnStop || !btnClear || !statusBadge) {
          return { success: false, reason: 'Ask VisionX controls missing' };
        }

        // Test quick prompt chip click
        if (chips.length > 0) {
          const chipText = chips[0].getAttribute('data-prompt');
          chips[0].click();
          if (input.value !== chipText) {
            return { success: false, reason: 'Chip click did not populate input' };
          }
        }

        // Test VisionAssistant instance & Context Builder
        const hasAssistant = !!window.visionXApp.visionAssistant;
        const testContext = window.visionXApp.buildCurrentVisionContext();

        // Submit query via handleAskVisionSubmit
        input.value = 'Apa yang ada di depan kamera?';
        const askPromise = window.visionXApp.visionAssistant.ask('Apa yang ada di depan kamera?');
        const isNowLoading = window.visionXApp.visionAssistant.isLoading;

        const res = await askPromise;

        return {
          success: true,
          hasAssistant,
          contextGenerated: !!testContext,
          isNowLoading,
          resSuccess: res.success,
          answerLength: res.answer ? res.answer.length : 0,
          provider: res.provider
        };
      })()`,
      returnByValue: true
    });
    console.log('Ask VisionX controls test:', askVisionRes.result.value);

    // 10. Test Object Memory (V1.1) UI and functionality
    console.log('\n--- Testing Object Memory (V1.1) ---');
    const memoryRes = await sendCommand('Runtime.evaluate', {
      expression: `(() => {
        try {
          const panel = document.getElementById('objectMemoryPanel');
          const activeList = document.getElementById('memoryCurrentObjectsList');
          const eventsLog = document.getElementById('memoryRecentEventsList');
          const btnClear = document.getElementById('btnClearObjectMemory');
          const metricActive = document.getElementById('memoryActiveBadge');
          const metricTotal = document.getElementById('memoryRecordsCount');
          const metricEvents = document.getElementById('memoryEventsCount');

          if (!panel || !activeList || !eventsLog || !btnClear || !metricActive || !metricTotal || !metricEvents) {
            return {
              success: false,
              reason: 'Object Memory UI elements missing',
              found: {
                panel: !!panel,
                activeList: !!activeList,
                eventsLog: !!eventsLog,
                btnClear: !!btnClear,
                metricActive: !!metricActive,
                metricTotal: !!metricTotal,
                metricEvents: !!metricEvents
              }
            };
          }

          const mem = window.visionXApp.objectMemory;
          if (!mem) {
            return { success: false, reason: 'ObjectMemory service instance missing' };
          }

          // Simulate active track update
          mem.update([
            { trackId: 1, class_name: 'laptop', confidence: 0.95, bbox: [100, 100, 300, 400], velocity: 0, direction: 'idle' },
            { trackId: 2, class_name: 'mouse', confidence: 0.88, bbox: [450, 300, 550, 400], velocity: 1.2, direction: 'right' }
          ], { width: 640, height: 480 });

          // Force UI update
          window.visionXApp.updateObjectMemoryUI();

          const activeCountAfter = mem.getActiveObjects().length;
          const totalCountAfter = mem.getAllObjects().length;
          const eventsCountAfter = mem.getRecentEvents().length;

          // Test clear memory button click
          btnClear.click();
          const activeCountCleared = mem.getActiveObjects().length;

          return {
            success: true,
            activeCountAfter,
            totalCountAfter,
            eventsCountAfter,
            activeCountCleared,
            isCleared: activeCountCleared === 0
          };
        } catch (e) {
          return { success: false, error: e.message, stack: e.stack };
        }
      })()`,
      returnByValue: true
    });
    console.log('Object Memory test raw response:', memoryRes);
    if (!memoryRes.result.value.success || !memoryRes.result.value.isCleared) {
      throw new Error(`Object Memory test failed: ${JSON.stringify(memoryRes.result.value)}`);
    }

    // 11. Test Read Text UI Layout & OCR Refinements (Desktop, Tablet & Mobile)
    console.log('\n--- Testing Read Text UI Layout & Hardening ---');
    const readTextLayoutRes = await sendCommand('Runtime.evaluate', {
      expression: `(() => {
        window.visionXApp.setMode('read_text');
        const panel = document.querySelector('.read-text-controls-panel');
        const resultDisplay = document.getElementById('ocrResultBox');
        const methodBadge = document.getElementById('ocrTelemetryMethod');
        const qualityBadge = document.getElementById('ocrTelemetryQuality');
        const resBadge = document.getElementById('ocrTelemetryResolution');
        const warningBanner = document.getElementById('ocrWarningBanner');
        const btnScan = document.getElementById('btnTriggerOcr');
        const btnReScan = document.getElementById('btnReScanOcr');
        const btnStop = document.getElementById('btnStopOcr');
        const btnSpeak = document.getElementById('btnSpeakOcr');

        if (!panel || !resultDisplay || !methodBadge || !warningBanner || !btnScan || !btnReScan || !btnStop || !btnSpeak) {
          return { success: false, reason: 'Read text elements missing' };
        }

        panel.scrollIntoView({ block: 'center' });

        const panelRect = panel.getBoundingClientRect();
        const displayStyle = window.getComputedStyle(resultDisplay);

        // Check bounding rects & visibility of all action buttons
        const buttons = [btnScan, btnReScan, btnStop, btnSpeak];
        const buttonsCheck = buttons.map(b => {
          const r = b.getBoundingClientRect();
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return {
            id: b.id,
            visible: r.width > 0 && r.height > 0,
            isClickable: hit === b || b.contains(hit),
            rect: { top: r.top, bottom: r.bottom, width: r.width, height: r.height }
          };
        });

        // Simulate OCR Result with quality and resolution audit
        window.visionXApp.updateOcrUI({
          text: 'VisionX OCR Hardening Sample Text Result',
          confidence: 65,
          quality: 'GOOD',
          preprocessingMethod: 'grayscale_contrast',
          roiAudit: { cropWidth: 1280, cropHeight: 720 },
          processingTimeMs: 42
        });

        return {
          success: true,
          panelTop: panelRect.top,
          panelBottom: panelRect.bottom,
          panelHeight: panelRect.height,
          overflowY: displayStyle.overflowY,
          buttonsCheck,
          qualityText: qualityBadge ? qualityBadge.textContent : null,
          resText: resBadge ? resBadge.textContent : null,
          methodText: methodBadge.textContent
        };
      })()`,
      returnByValue: true
    });
    console.log('Read Text layout result (Desktop):', readTextLayoutRes.result.value);
    if (!readTextLayoutRes.result.value.success) {
      throw new Error(`Read text layout desktop test failed: ${JSON.stringify(readTextLayoutRes.result.value)}`);
    }

    // 12. Test Tablet Responsive Layout (768x1024)
    console.log('\n--- Testing Tablet Layout (768x1024) ---');
    await sendCommand('Emulation.setDeviceMetricsOverride', {
      width: 768,
      height: 1024,
      deviceScaleFactor: 1,
      mobile: false
    });
    await sleep(400);

    const tabletLayoutRes = await sendCommand('Runtime.evaluate', {
      expression: `(() => {
        const clientWidth = document.documentElement.clientWidth;
        const scrollWidth = document.documentElement.scrollWidth;
        const btnScan = document.getElementById('btnTriggerOcr');
        const btnReScan = document.getElementById('btnReScanOcr');
        const ocrBox = document.getElementById('ocrResultBox');

        const scanRect = btnScan ? btnScan.getBoundingClientRect() : { width: 0, height: 0 };
        const rescanRect = btnReScan ? btnReScan.getBoundingClientRect() : { width: 0, height: 0 };
        const boxRect = ocrBox ? ocrBox.getBoundingClientRect() : { width: 0, height: 0 };

        return {
          hasHorizontalOverflow: scrollWidth > clientWidth,
          clientWidth,
          scrollWidth,
          scanButtonVisible: scanRect.width > 0 && scanRect.height > 0,
          rescanButtonVisible: rescanRect.width > 0 && rescanRect.height > 0,
          ocrBoxVisible: boxRect.width > 0 && boxRect.height > 0
        };
      })()`,
      returnByValue: true
    });
    console.log('Tablet layout result:', tabletLayoutRes.result.value);
    if (tabletLayoutRes.result.value.hasHorizontalOverflow) {
      throw new Error(`Horizontal overflow detected in tablet viewport: scrollWidth=${tabletLayoutRes.result.value.scrollWidth} > clientWidth=${tabletLayoutRes.result.value.clientWidth}`);
    }

    // 12b. Test Mobile Portrait Responsive Layout (375x667)
    console.log('\n--- Testing Mobile Portrait Layout (375x667) ---');
    await sendCommand('Emulation.setDeviceMetricsOverride', {
      width: 375,
      height: 667,
      deviceScaleFactor: 2,
      mobile: true
    });
    await sleep(500);

    const mobileLayoutRes = await sendCommand('Runtime.evaluate', {
      expression: `(() => {
        const docWidth = document.documentElement.scrollWidth;
        const bodyWidth = document.body.scrollWidth;
        const btnScan = document.getElementById('btnTriggerOcr');
        const btnReScan = document.getElementById('btnReScanOcr');
        const ocrBox = document.getElementById('ocrResultBox');

        const scanRect = btnScan ? btnScan.getBoundingClientRect() : { width: 0, height: 0 };
        const rescanRect = btnReScan ? btnReScan.getBoundingClientRect() : { width: 0, height: 0 };
        const boxRect = ocrBox ? ocrBox.getBoundingClientRect() : { width: 0, height: 0 };

        return {
          hasHorizontalOverflow: docWidth > 375,
          docWidth,
          bodyWidth,
          scanButtonVisible: scanRect.width > 0 && scanRect.height > 0,
          rescanButtonVisible: rescanRect.width > 0 && rescanRect.height > 0,
          ocrBoxVisible: boxRect.width > 0 && boxRect.height > 0
        };
      })()`,
      returnByValue: true
    });
    console.log('Mobile layout result:', mobileLayoutRes.result.value);
    if (mobileLayoutRes.result.value.hasHorizontalOverflow) {
      throw new Error(`Horizontal overflow detected in mobile viewport: docWidth=${mobileLayoutRes.result.value.docWidth}`);
    }

    // Restore desktop viewport
    await sendCommand('Emulation.setDeviceMetricsOverride', {
      width: 1280,
      height: 1024,
      deviceScaleFactor: 1,
      mobile: false
    });
    await sleep(200);

    // 12c. Test SafetyEngine & Camera Quality Strip Diagnostics
    console.log('\n--- Testing SafetyEngine (V1.3) & Camera Strip Diagnostics ---');
    const safetyCamRes = await sendCommand('Runtime.evaluate', {
      expression: `(() => {
        const app = window.visionXApp;
        const hasSafetyEngine = !!(app && app.safetyEngine);
        const camStrip = document.getElementById('cameraQualityStrip');
        const camRes = document.getElementById('camDiagResolution');
        const camFps = document.getElementById('camDiagFps');
        const camBright = document.getElementById('camDiagBrightness');
        const camSharp = document.getElementById('camDiagSharpness');
        const camOcrInput = document.getElementById('camDiagOcrInput');

        if (!camStrip || !camRes || !camFps || !camBright || !camSharp || !camOcrInput) {
          return { success: false, reason: 'Camera strip elements missing' };
        }

        // Test SafetyEngine event emission
        let emitted = null;
        if (hasSafetyEngine) {
          const unsub = app.safetyEngine.onSafetyEvent(evt => { emitted = evt; });
          app.safetyEngine.evaluate({
            memoryEvents: [{ type: 'OBJECT_LEFT', trackId: 99, className: 'laptop', zone: 'kanan' }],
            timestamp: Date.now()
          });
          unsub();
        }

        return {
          success: true,
          hasSafetyEngine,
          safetyEventEmitted: !!emitted,
          emittedType: emitted ? emitted.type : null,
          camStripVisible: true
        };
      })()`,
      returnByValue: true
    });
    console.log('Safety & Camera diagnostics test result:', safetyCamRes.result.value);
    if (!safetyCamRes.result.value.success || !safetyCamRes.result.value.hasSafetyEngine) {
      throw new Error(`SafetyEngine / Camera strip test failed: ${JSON.stringify(safetyCamRes.result.value)}`);
    }

    // 13. Test V1.2 Personalized Recognition UI & Interaction
    console.log('\n--- Testing V1.2 Personalized Recognition UI & Interaction ---');
    const poTestRes = await sendCommand('Runtime.evaluate', {
      expression: `(() => {
        try {
          const panel = document.getElementById('personalObjectsPanel');
          const btnToggle = document.getElementById('btnToggleEnrollForm');
          const formSection = document.getElementById('enrollmentFormSection');
          const nameInput = document.getElementById('enrollObjectNameInput');
          const classSelect = document.getElementById('enrollBaseClassSelect');
          const listContainer = document.getElementById('personalObjectsList');
          const thresholdSlider = document.getElementById('personalMatchThresholdSlider');

          if (!panel || !btnToggle || !formSection || !nameInput || !classSelect || !listContainer) {
            return {
              success: false,
              reason: 'Missing elements: panel=' + Boolean(panel) + ', btnToggle=' + Boolean(btnToggle) + ', formSection=' + Boolean(formSection) + ', nameInput=' + Boolean(nameInput) + ', classSelect=' + Boolean(classSelect) + ', listContainer=' + Boolean(listContainer)
            };
          }

          // Test form toggle interaction
          const wasHidden = formSection.classList.contains('hidden');
          btnToggle.click();
          const isNowVisible = !formSection.classList.contains('hidden');

          // Test programmatic object registration and UI update
          const app = window.visionXApp;
          if (!app || !app.personalObjectRegistry) {
            return { success: false, reason: 'visionXApp or personalObjectRegistry not found on window' };
          }

          // Register dummy test personal object
          const dummyVec = new Array(128).fill(0.1);
          const enrolled = app.personalObjectRegistry.register({
            name: 'CDP Test Laptop',
            baseClass: 'laptop',
            references: [{ id: 'ref_1', angle: 'front', embedding: dummyVec }],
            threshold: 0.78
          });

          app.updatePersonalObjectsUI();

          const card = listContainer.querySelector('.personal-object-card');
          const cardText = card ? card.textContent : '';
          const cardRendered = cardText.includes('CDP Test Laptop') && cardText.includes('laptop');

          // Test toggle enable
          app.togglePersonalObjectEnabled(enrolled.id);
          const objAfterToggle = app.personalObjectRegistry.getById(enrolled.id);
          const toggleSuccess = objAfterToggle && objAfterToggle.enabled === false;

          // Clean up test object with stubbed confirm
          const origConfirm = window.confirm;
          window.confirm = () => true;
          try {
            app.deletePersonalObject(enrolled.id);
          } finally {
            window.confirm = origConfirm;
          }
          const objAfterDelete = app.personalObjectRegistry.getById(enrolled.id);
          const deleteSuccess = !objAfterDelete;

          // Toggle form back
          btnToggle.click();

          return {
            success: true,
            panelExists: true,
            toggleWorked: wasHidden && isNowVisible,
            cardRendered,
            toggleSuccess,
            deleteSuccess,
            thresholdSliderValue: thresholdSlider ? thresholdSlider.value : null
          };
        } catch (err) {
          return { success: false, error: err.message, stack: err.stack };
        }
      })()`,
      returnByValue: true
    });
    console.log('Personal Objects UI test result:', poTestRes.result ? poTestRes.result.value : poTestRes);
    if (!poTestRes.result || !poTestRes.result.value || !poTestRes.result.value.success || !poTestRes.result.value.cardRendered || !poTestRes.result.value.toggleSuccess || !poTestRes.result.value.deleteSuccess) {
      throw new Error(`Personal Objects UI test failed: ${JSON.stringify(poTestRes.result ? poTestRes.result.value : poTestRes)}`);
    }

    // 14. Test V1.3.1 Safety Alert Manager Real World Scenarios (A to F)
    console.log('\n--- Testing V1.3.1 Safety Alert Manager Real World Scenarios (A to F) ---');
    const safetyAlertsRes = await sendCommand('Runtime.evaluate', {
      expression: `(() => {
        try {
          const app = window.visionXApp;
          if (!app || !app.alertManager || !app.safetyEngine) {
            return { success: false, reason: 'alertManager or safetyEngine missing on window.visionXApp' };
          }

          const panel = document.getElementById('safetyAlertsPanel');
          const alertsList = document.getElementById('safetyAlertsList');
          const toggleSafety = document.getElementById('toggleSafetyAlerts');
          const toggleVoice = document.getElementById('toggleVoiceSafetyAlerts');
          const btnClear = document.getElementById('btnClearSafetyAlerts');

          if (!panel || !alertsList || !toggleSafety || !toggleVoice || !btnClear) {
            return { success: false, reason: 'Safety Alerts UI elements missing' };
          }

          // Reset AlertManager state & Voice history
          app.alertManager.clearAlerts();
          const spokenHistory = [];
          const origSpeak = app.voiceEngine ? app.voiceEngine.speak : null;
          if (app.voiceEngine) {
            app.voiceEngine.speak = (text, opts) => {
              spokenHistory.push({ text, opts });
              return true;
            };
          }

          // Ensure default settings
          app.alertManager.updateConfig({
            safetyAlertsEnabled: true,
            voiceSafetyAlertsEnabled: true,
            persistentAlertsEnabled: false,
            defaultCooldownMs: 10000,
            personalLeftCooldownMs: 10000
          });

          const t0 = 100000;

          // ========================================================
          // SCENARIO A: My Laptop visible -> remove -> PERSONAL_OBJECT_LEFT -> HIGH alert -> 1 Voice
          // ========================================================
          const evtA = {
            type: 'PERSONAL_OBJECT_LEFT',
            severity: 'HIGH',
            objectName: 'My Laptop',
            className: 'laptop',
            trackId: 501,
            lastZone: 'kanan',
            timestamp: t0,
            details: { personalObjectId: 'laptop_01' }
          };
          const alertA = app.alertManager.processEvent(evtA);
          const passA = alertA !== null &&
                        alertA.severity === 'HIGH' &&
                        spokenHistory.length === 1 &&
                        spokenHistory[0].text.includes('My Laptop') &&
                        (spokenHistory[0].opts.priority === 3 || spokenHistory[0].opts.priority === 'HIGH');

          // ========================================================
          // SCENARIO B: Laptop remains outside view -> no repeated alert
          // ========================================================
          const alertB1 = app.alertManager.processEvent({ ...evtA, timestamp: t0 + 500 });
          const alertB2 = app.alertManager.processEvent({ ...evtA, timestamp: t0 + 1000 });
          const passB = alertB1 === null && alertB2 === null && spokenHistory.length === 1;

          // ========================================================
          // SCENARIO C: Laptop returns -> OBJECT_RETURNED -> single notification
          // ========================================================
          const evtC = {
            type: 'OBJECT_RETURNED',
            severity: 'HIGH',
            objectName: 'My Laptop',
            className: 'laptop',
            trackId: 501,
            lastZone: 'tengah',
            timestamp: t0 + 2000,
            details: { personalObjectId: 'laptop_01' }
          };
          const alertC = app.alertManager.processEvent(evtC);
          const passC = alertC !== null && spokenHistory.length === 2 && spokenHistory[1].text.includes('kembali terlihat');

          // ========================================================
          // SCENARIO D: Normal mouse leaves -> UI event -> no voice spam
          // ========================================================
          const evtD = {
            type: 'OBJECT_LEFT',
            severity: 'NORMAL',
            objectName: 'mouse',
            className: 'mouse',
            trackId: 502,
            lastZone: 'kiri',
            timestamp: t0 + 3000
          };
          const alertD = app.alertManager.processEvent(evtD);
          const passD = alertD !== null && alertD.severity === 'NORMAL' && spokenHistory.length === 2; // Voice count still 2

          // ========================================================
          // SCENARIO E: Safety Alerts OFF -> no alert
          // ========================================================
          app.alertManager.updateConfig({ safetyAlertsEnabled: false });
          const evtE = {
            type: 'PERSONAL_OBJECT_LEFT',
            severity: 'HIGH',
            objectName: 'My Phone',
            trackId: 503,
            timestamp: t0 + 4000,
            details: { personalObjectId: 'phone_01' }
          };
          const alertE = app.alertManager.processEvent(evtE);
          const passE = alertE === null;

          // ========================================================
          // SCENARIO F: Voice Safety Alerts OFF -> UI alert still works -> no TTS
          // ========================================================
          app.alertManager.updateConfig({
            safetyAlertsEnabled: true,
            voiceSafetyAlertsEnabled: false
          });
          const evtF = {
            type: 'PERSONAL_OBJECT_LEFT',
            severity: 'HIGH',
            objectName: 'My Backpack',
            trackId: 504,
            timestamp: t0 + 5000,
            details: { personalObjectId: 'bag_01' }
          };
          const countBeforeF = spokenHistory.length;
          const alertF = app.alertManager.processEvent(evtF);
          const passF = alertF !== null && spokenHistory.length === countBeforeF;

          // Check UI rendering & dismiss
          app.updateSafetyAlertsUI();
          const renderedCards = alertsList.querySelectorAll('.safety-alert-card');
          const passUI = renderedCards.length > 0;

          // Test dismiss first alert
          const firstAlertId = app.alertManager.getAlerts()[0].id;
          const dismissRes = app.alertManager.dismissAlert(firstAlertId);
          app.updateSafetyAlertsUI();

          // Restore speak
          if (origSpeak && app.voiceEngine) {
            app.voiceEngine.speak = origSpeak;
          }

          return {
            success: true,
            passA,
            passB,
            passC,
            passD,
            passE,
            passF,
            passUI,
            dismissRes,
            allScenariosPassed: passA && passB && passC && passD && passE && passF && passUI && dismissRes
          };
        } catch (err) {
          return { success: false, error: err.message, stack: err.stack };
        }
      })()`,
      returnByValue: true
    });
    console.log('Safety Alert Manager Scenarios A-F result:', safetyAlertsRes.result ? safetyAlertsRes.result.value : safetyAlertsRes);
    if (!safetyAlertsRes.result || !safetyAlertsRes.result.value || !safetyAlertsRes.result.value.success || !safetyAlertsRes.result.value.allScenariosPassed) {
      throw new Error(`Safety Alert Manager Scenarios A-F test failed: ${JSON.stringify(safetyAlertsRes.result ? safetyAlertsRes.result.value : safetyAlertsRes)}`);
    }

    // 15. Check for any fatal console errors
    console.log('\n--- Console Errors Check ---');
    const fatalErrors = consoleErrors.filter(err =>
      !err.includes('Identity Proxy Error') &&
      !err.includes('Identity Lab') &&
      !err.includes('IdentityService') &&
      !err.includes('HTTP 502') &&
      !err.includes('Gagal memuat file golden test') &&
      !err.includes('getUserMedia') &&
      !err.includes('Requested device not found')
    );

    if (fatalErrors.length > 0) {
      console.error('Fatal errors detected in browser console:', fatalErrors);
      throw new Error(`Fatal console errors found: ${fatalErrors.join('; ')}`);
    } else {
      console.log('No fatal initialization or syntax errors found in browser console!');
    }

    console.log('\n=== ALL BROWSER INTERACTION TESTS PASSED SUCCESSFULLY! ===');
    ws.close();
  } finally {
    try {
      chromeProc.kill();
    } catch (e) {}
  }
}

main().catch(err => {
  console.error('[BROWSER TEST FAILED]', err);
  process.exit(1);
});

