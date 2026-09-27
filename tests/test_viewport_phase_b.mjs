/**
 * test_viewport_phase_b.mjs - Phase B Multi-Viewport Navigation Architecture Validation Suite
 * Tests 6 required viewports for VisionX V1.5 Navigation Architecture:
 * Mobile: 375x667, 390x844, 412x915
 * Tablet: 768x1024
 * Desktop: 1280x1024, 1440x900
 */

import { spawn } from 'child_process';
import http from 'http';

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DEBUG_PORT = 9224;
const TARGET_URL = 'http://localhost:5173/';

const VIEWPORTS = [
  { name: 'Mobile Compact (iPhone SE)', width: 375, height: 667, mobile: true, isMobileNav: true },
  { name: 'Mobile Standard (iPhone 13/14)', width: 390, height: 844, mobile: true, isMobileNav: true },
  { name: 'Mobile Large (Pixel 7 / Android)', width: 412, height: 915, mobile: true, isMobileNav: true },
  { name: 'Tablet Portrait (iPad)', width: 768, height: 1024, mobile: true, isMobileNav: false },
  { name: 'Desktop Standard', width: 1280, height: 1024, mobile: false, isMobileNav: false },
  { name: 'Desktop Widescreen', width: 1440, height: 900, mobile: false, isMobileNav: false },
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
  console.log('📱 Starting VisionX V1.5 Phase B Navigation Validation Test');
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

      // Evaluate navigation metrics and breakpoint assertions
      const evalMetrics = await send('Runtime.evaluate', {
        expression: `(() => {
          const docEl = document.documentElement;
          const body = document.body;
          const container = document.querySelector('.app-container');
          const stage = document.querySelector('.stage-card');
          const header = document.querySelector('.app-header');
          const topTabsContainer = document.querySelector('.mode-switcher-container');
          const bottomNav = document.querySelector('.bottom-nav-bar');
          const bottomNavItems = Array.from(document.querySelectorAll('.bottom-nav-item'));
          
          const scrollWidth = docEl.scrollWidth;
          const innerWidth = window.innerWidth;
          const hasHorizontalOverflow = scrollWidth > innerWidth;

          const bottomNavDisplay = bottomNav ? window.getComputedStyle(bottomNav).display : 'none';
          const topTabsDisplay = topTabsContainer ? window.getComputedStyle(topTabsContainer).display : 'none';

          // Test button clickability & hit-testing
          const startBtn = document.getElementById('btnStart');
          let startClickable = false;
          if (startBtn) {
            startBtn.scrollIntoView({ block: 'start', behavior: 'instant' });
            const rect = startBtn.getBoundingClientRect();
            const hitEl = document.elementFromPoint(
              rect.left + rect.width / 2,
              rect.top + rect.height / 2
            );
            startClickable = !!(hitEl && (hitEl === startBtn || startBtn.contains(hitEl)));
          }

          // Test switching through all 5 primary modes via navigationManager and verify sync
          const modes = ['detection', 'read_text', 'collection', 'manager', 'identity'];
          const switchTests = [];
          
          for (const m of modes) {
            window.visionXApp.navigationManager.setActiveMode(m);
            const activeNav = window.visionXApp.navigationManager.getActiveMode();
            const appMode = window.visionXApp.currentMode;
            
            // Check active class on bottom nav item
            const activeBottomItem = document.querySelector('.bottom-nav-item[data-mode="' + m + '"]');
            const bottomItemHasActiveClass = activeBottomItem ? activeBottomItem.classList.contains('active') : false;
            const bottomItemAriaSelected = activeBottomItem ? activeBottomItem.getAttribute('aria-selected') === 'true' : false;

            switchTests.push({
              mode: m,
              activeNav,
              appMode,
              synced: (activeNav === m && appMode === m),
              bottomItemHasActiveClass,
              bottomItemAriaSelected,
              noOverflow: docEl.scrollWidth <= window.innerWidth
            });
          }

          // Reset back to detection
          window.visionXApp.navigationManager.setActiveMode('detection');

          // Header badges audit on mobile
          const secondaryBadgeHidden = (() => {
            const b = document.getElementById('activeModelBadge');
            return b ? window.getComputedStyle(b).display === 'none' : true;
          })();

          return {
            scrollWidth,
            innerWidth,
            hasHorizontalOverflow,
            bottomNavDisplay,
            topTabsDisplay,
            bottomNavItemsCount: bottomNavItems.length,
            startClickable,
            secondaryBadgeHidden,
            switchTests
          };
        })()`,
        returnByValue: true
      });

      const res = evalMetrics.result.value;
      const passedOverflow = !res.hasHorizontalOverflow;
      const passedStart = res.startClickable;
      const passedSync = res.switchTests.every(t => t.synced && t.bottomItemHasActiveClass && t.bottomItemAriaSelected && t.noOverflow);

      // Verify breakpoint rule
      let passedBreakpoint = false;
      if (vp.isMobileNav) {
        passedBreakpoint = (res.bottomNavDisplay === 'flex') && (res.topTabsDisplay === 'none') && (res.secondaryBadgeHidden === true);
      } else {
        passedBreakpoint = (res.bottomNavDisplay === 'none') && (res.topTabsDisplay === 'flex');
      }

      if (passedOverflow && passedStart && passedSync && passedBreakpoint) {
        console.log(`   ✅ Breakpoint Nav: BottomNav (${res.bottomNavDisplay}) | TopTabs (${res.topTabsDisplay})`);
        console.log(`   ✅ Mobile Badges Simplified: ${res.secondaryBadgeHidden}`);
        console.log(`   ✅ 5 Primary Modes Navigation Sync Verified: 5/5 pass`);
        console.log(`   ✅ No Overflow: scrollWidth (${res.scrollWidth}px) <= innerWidth (${res.innerWidth}px)`);
        console.log(`   ✅ Hero Start Button Clickable: ${res.startClickable}`);
      } else {
        allPassed = false;
        console.error(`   ❌ FAILURE in ${vp.name}:`, {
          passedOverflow,
          passedStart,
          passedSync,
          passedBreakpoint,
          res
        });
      }
      console.log('');
    }

    console.log('================================================================');
    if (allPassed && consoleErrors.length === 0) {
      console.log('🎉 ALL 6 VIEWPORTS PASSED PHASE B NAVIGATION ARCHITECTURE AUDIT!');
      console.log('Zero console errors, 100% 5-mode sync, bottom/top nav perfectly responsive.');
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
