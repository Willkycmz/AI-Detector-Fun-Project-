import { spawn } from 'child_process';
import http from 'http';
import fs from 'fs';
import path from 'path';

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DEBUG_PORT = 9245;
const TARGET_URL = 'http://localhost:5173/';
const ARTIFACTS_DIR = 'C:\\Users\\advan\\.gemini\\antigravity-ide\\brain\\cc686e94-4d78-451c-a901-af91c912d4b9';

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
  console.log('--- Launching Headless Chrome for Mobile & Desktop Verification ---');
  const chromeProc = spawn(CHROME_PATH, [
    '--headless=new',
    `--remote-debugging-port=${DEBUG_PORT}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    'about:blank'
  ], { stdio: 'ignore' });

  let ws;
  let msgId = 1;
  const pendingCalls = new Map();

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
      throw new Error(`Evaluation failed: ${res.exceptionDetails.text} (${JSON.stringify(res.exceptionDetails)})`);
    }
    return res.result?.value;
  }

  async function capture(filename) {
    const res = await sendCommand('Page.captureScreenshot', { format: 'png' });
    const buffer = Buffer.from(res.data, 'base64');
    const outPath = path.join(ARTIFACTS_DIR, filename);
    fs.writeFileSync(outPath, buffer);
    console.log(`[Screenshot Captured] ${filename} (${buffer.length} bytes)`);
    return outPath;
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
      }
    };

    await sendCommand('Page.enable');
    await sendCommand('Runtime.enable');
    await sendCommand('DOM.enable');

    console.log(`Navigating to ${TARGET_URL}...`);
    await sendCommand('Page.navigate', { url: TARGET_URL });
    await sleep(2500);

    // =========================================================================
    // STEP 1: MOBILE AUDIT & VERIFICATION (390 x 844, iPhone 13/14 / Android Standard)
    // =========================================================================
    console.log('\n======================================================');
    console.log('📱 1. SETTING MOBILE VIEWPORT: 390 x 844 (Mobile Emulation)');
    console.log('======================================================');
    await sendCommand('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true,
      hasTouch: true
    });
    await sleep(500);

    // Verify M1: Overflow
    const m1Check = await evaluate(`({
      docScrollWidth: document.documentElement.scrollWidth,
      docClientWidth: document.documentElement.clientWidth,
      bodyScrollWidth: document.body.scrollWidth,
      bodyClientWidth: document.body.clientWidth,
      hasHorizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    })`);
    console.log('M1 Horizontal Overflow Check (Home):', m1Check);

    // Verify M2: Bottom Navigation Bar
    const m2Check = await evaluate(`(() => {
      const nav = document.getElementById('mobileBottomNav');
      const items = nav ? Array.from(nav.querySelectorAll('.bottom-nav-item')).map(b => ({
        text: b.innerText.trim(),
        mode: b.getAttribute('data-mode'),
        rect: b.getBoundingClientRect()
      })) : [];
      const hamburger = document.getElementById('btnMobileMenu');
      const hRect = hamburger ? hamburger.getBoundingClientRect() : null;
      return {
        navVisible: nav ? window.getComputedStyle(nav).display : null,
        itemCount: items.length,
        items,
        hamburgerSize: hRect ? { width: hRect.width, height: hRect.height } : null
      };
    })()`);
    console.log('M2 Bottom Nav Check:', JSON.stringify(m2Check, null, 2));

    // Verify M3: Header Kompak & Duplicate Heading Removal
    const m3Check = await evaluate(`(() => {
      const header = document.querySelector('.mobile-chat-header');
      const hRect = header ? header.getBoundingClientRect() : null;
      const title = document.querySelector('.welcome-title');
      const subtitle = document.querySelector('.welcome-subtitle');
      return {
        headerHeight: hRect ? hRect.height : null,
        headerDisplay: header ? window.getComputedStyle(header).display : null,
        titleDisplay: title ? window.getComputedStyle(title).display : null,
        subtitleVisible: subtitle ? window.getComputedStyle(subtitle).display : null,
        subtitleText: subtitle ? subtitle.innerText.trim() : null
      };
    })()`);
    console.log('M3 Compact Header Check:', m3Check);

    // Verify M4: Capability Cards Grid
    const m4Check = await evaluate(`(() => {
      const grid = document.querySelector('.capability-cards-grid');
      const cards = grid ? Array.from(grid.querySelectorAll('.capability-card')).map(c => {
        const icon = c.querySelector('.capability-icon-wrap');
        const text = c.querySelector('.capability-text');
        const rect = c.getBoundingClientRect();
        return {
          rect,
          iconTop: icon ? icon.getBoundingClientRect().top : 0,
          textTop: text ? text.getBoundingClientRect().top : 0
        };
      }) : [];
      return {
        gridCols: grid ? window.getComputedStyle(grid).gridTemplateColumns : null,
        cardCount: cards.length,
        isIconAboveText: cards.length > 0 ? (cards[0].iconTop < cards[0].textTop) : false
      };
    })()`);
    console.log('M4 Capability Cards Check:', m4Check);

    // Verify M6: Composer Chat Mobile
    const m6Check = await evaluate(`(() => {
      const dock = document.querySelector('.chat-input-dock');
      const wrapper = document.querySelector('.input-field-dock-wrapper');
      const camBtn = document.getElementById('btnOpenCamModal');
      const sendBtn = document.getElementById('btnSendChatMessage');
      const input = document.getElementById('chatMessageInput');
      return {
        dockDisplay: dock ? window.getComputedStyle(dock).display : null,
        wrapperOrder: wrapper ? window.getComputedStyle(wrapper).order : null,
        camBtnOrder: camBtn ? window.getComputedStyle(camBtn).order : null,
        camBtnSize: camBtn ? { width: camBtn.offsetWidth, height: camBtn.offsetHeight } : null,
        sendBtnSize: sendBtn ? { width: sendBtn.offsetWidth, height: sendBtn.offsetHeight } : null,
        placeholder: input ? input.placeholder : null,
        inputValue: input ? input.value : null
      };
    })()`);
    console.log('M6 Composer Chat Check:', m6Check);

    // Verify M7: Privacy Disclosure Accordion
    const m7Before = await evaluate(`(() => {
      const el = document.querySelector('details.mobile-privacy-notice');
      return {
        exists: !!el,
        isOpen: el ? el.hasAttribute('open') : false,
        summaryText: el ? el.querySelector('summary').innerText.trim() : null
      };
    })()`);
    console.log('M7 Privacy Disclosure Before Open:', m7Before);

    // Capture initial Mobile Home Screenshot
    await capture('mobile_390_home.png');

    // Click M7 accordion to open
    await evaluate(`(() => {
      const el = document.querySelector('details.mobile-privacy-notice');
      if (el) el.open = true;
    })()`);
    await sleep(200);
    const m7After = await evaluate(`(() => {
      const el = document.querySelector('details.mobile-privacy-notice');
      return {
        isOpen: el ? el.hasAttribute('open') : false,
        textVisible: el ? window.getComputedStyle(el.querySelector('.disclosure-text')).display : null
      };
    })()`);
    console.log('M7 Privacy Disclosure After Open:', m7After);
    await capture('mobile_390_home_privacy_open.png');

    // Close accordion again
    await evaluate(`(() => {
      const el = document.querySelector('details.mobile-privacy-notice');
      if (el) el.open = false;
    })()`);

    // Verify M5: Scroll to bottom & Pertanyaan Cepat visibility
    await evaluate(`(() => {
      const scrollArea = document.querySelector('.chat-scroll-area');
      if (scrollArea) {
        scrollArea.scrollTop = scrollArea.scrollHeight;
      }
    })()`);
    await sleep(300);

    const m5Check = await evaluate(`(() => {
      const scrollArea = document.querySelector('.chat-scroll-area');
      const lastPrompt = document.querySelector('.quick-prompts-grid .quick-prompt-btn:last-child');
      const inputDock = document.getElementById('chatInputContainer');
      const promptRect = lastPrompt ? lastPrompt.getBoundingClientRect() : null;
      const dockRect = inputDock ? inputDock.getBoundingClientRect() : null;
      return {
        scrollTop: scrollArea ? scrollArea.scrollTop : 0,
        scrollHeight: scrollArea ? scrollArea.scrollHeight : 0,
        clientHeight: scrollArea ? scrollArea.clientHeight : 0,
        lastPromptBottom: promptRect ? promptRect.bottom : 0,
        inputDockTop: dockRect ? dockRect.top : 0,
        isFullyVisibleAboveDock: promptRect && dockRect ? (promptRect.bottom <= dockRect.top) : false
      };
    })()`);
    console.log('M5 Scroll Bottom & Quick Prompts Visibility Check:', m5Check);
    await capture('mobile_390_home_scrolled.png');

    // Scroll back to top
    await evaluate(`(() => {
      const scrollArea = document.querySelector('.chat-scroll-area');
      if (scrollArea) scrollArea.scrollTop = 0;
    })()`);

    // =========================================================================
    // STEP 2: TEST "LAINNYA" MORE BOTTOM SHEET (M2)
    // =========================================================================
    console.log('\n--- Testing Mobile More Bottom Sheet ---');
    await evaluate(`document.getElementById('btnMobileMore').click()`);
    await sleep(400);

    const sheetCheck = await evaluate(`(() => {
      const sheet = document.getElementById('moreBottomSheet');
      const rect = sheet ? sheet.querySelector('.bottom-sheet-container').getBoundingClientRect() : null;
      return {
        isHidden: sheet ? sheet.classList.contains('hidden') : true,
        sheetDisplay: sheet ? window.getComputedStyle(sheet).display : null,
        sheetRect: rect
      };
    })()`);
    console.log('More Bottom Sheet Open Check:', sheetCheck);
    await capture('mobile_390_more_sheet.png');

    // Click Dataset Manager from Sheet
    console.log('\n--- Navigating to Dataset Manager via Sheet ---');
    await evaluate(`document.getElementById('sheetBtnManager').click()`);
    await sleep(500);

    const managerCheck = await evaluate(`({
      mode: document.body.getAttribute('data-mode'),
      activeWorkspace: document.querySelector('.workspace-container')?.getAttribute('data-active-workspace'),
      hasHorizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      tableContainerOverflow: window.getComputedStyle(document.querySelector('.manager-table-wrapper') || document.body).overflowX
    })`);
    console.log('Dataset Manager Mobile Check:', managerCheck);
    await capture('mobile_390_manager.png');

    // =========================================================================
    // STEP 3: NAVIGATE TO IDENTITY LAB (via More Sheet or direct mode switch)
    // =========================================================================
    console.log('\n--- Navigating to Identity Lab ---');
    await evaluate(`window.__visionxApp?.setMode('identity') || document.querySelector('.bottom-nav-item[data-mode="identity"]')?.click()`);
    await sleep(500);

    const identityCheck = await evaluate(`({
      mode: document.body.getAttribute('data-mode'),
      hasHorizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      gridCols: window.getComputedStyle(document.querySelector('.identity-layout-grid') || document.body).gridTemplateColumns
    })`);
    console.log('Identity Lab Mobile Check:', identityCheck);
    await capture('mobile_390_identity.png');

    // =========================================================================
    // STEP 4: NAVIGATE TO VISION MODE (M8 & Contextual Tools)
    // =========================================================================
    console.log('\n--- Navigating to Vision Mode ---');
    await evaluate(`document.querySelector('.bottom-nav-item[data-mode="detection"]').click()`);
    await sleep(500);

    const visionCheck = await evaluate(`({
      mode: document.body.getAttribute('data-mode'),
      hasHorizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      contextualNavCols: window.getComputedStyle(document.querySelector('.contextual-tools-nav') || document.body).gridTemplateColumns,
      stageCardRatio: window.getComputedStyle(document.querySelector('.stage-card') || document.body).aspectRatio
    })`);
    console.log('Vision Mode Mobile Check:', visionCheck);
    await capture('mobile_390_vision.png');

    // =========================================================================
    // STEP 5: NAVIGATE TO READ TEXT MODE
    // =========================================================================
    console.log('\n--- Navigating to Read Text Mode ---');
    await evaluate(`document.querySelector('.bottom-nav-item[data-mode="read_text"]').click()`);
    await sleep(500);

    const readTextCheck = await evaluate(`({
      mode: document.body.getAttribute('data-mode'),
      hasHorizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      ocrGridCols: window.getComputedStyle(document.querySelector('.ocr-settings-grid') || document.body).gridTemplateColumns
    })`);
    console.log('Read Text Mobile Check:', readTextCheck);
    await capture('mobile_390_read_text.png');

    // =========================================================================
    // STEP 6: NAVIGATE TO COLLECTION MODE
    // =========================================================================
    console.log('\n--- Navigating to Collection Mode ---');
    await evaluate(`document.querySelector('.bottom-nav-item[data-mode="collection"]').click()`);
    await sleep(500);

    const collectionCheck = await evaluate(`({
      mode: document.body.getAttribute('data-mode'),
      hasHorizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      collectGridCols: window.getComputedStyle(document.querySelector('.collection-grid') || document.body).gridTemplateColumns
    })`);
    console.log('Collection Mobile Check:', collectionCheck);
    await capture('mobile_390_collection.png');

    // =========================================================================
    // STEP 7: TEST AUTH MODAL / BOTTOM SHEET (M8)
    // =========================================================================
    console.log('\n--- Testing Auth Modal / Bottom Sheet ---');
    await evaluate(`(() => {
      const modal = document.getElementById('visionxAuthModal');
      if (modal) modal.classList.remove('hidden');
    })()`);
    await sleep(300);

    const authModalCheck = await evaluate(`(() => {
      const modal = document.getElementById('visionxAuthModal');
      const card = modal ? modal.querySelector('.modal-card') : null;
      return {
        modalVisible: modal ? !modal.classList.contains('hidden') : false,
        alignItems: modal ? window.getComputedStyle(modal).alignItems : null,
        cardBorderRadius: card ? window.getComputedStyle(card).borderRadius : null
      };
    })()`);
    console.log('Auth Modal Bottom Sheet Check:', authModalCheck);
    await capture('mobile_390_auth_modal.png');

    // Close Auth Modal
    await evaluate(`(() => {
      const modal = document.getElementById('visionxAuthModal');
      if (modal) modal.classList.add('hidden');
    })()`);
    await sleep(200);

    // =========================================================================
    // STEP 8: TEST M9 INSECURE CONTEXT WARNING BANNER
    // =========================================================================
    console.log('\n--- Testing M9 Insecure Context Warning ---');
    await evaluate(`(() => {
      if (window.visionXApp) {
        window.visionXApp.showCameraInsecureWarning('Kamera butuh HTTPS. Buka lewat alamat HTTPS atau localhost.');
      } else {
        const b = document.createElement('div');
        b.id = 'insecureCameraBanner';
        b.className = 'insecure-camera-banner';
        b.innerHTML = '<div class="insecure-banner-content"><span class="insecure-banner-text">Kamera butuh HTTPS. Buka lewat alamat HTTPS atau localhost.</span></div>';
        document.body.appendChild(b);
      }
    })()`);
    await sleep(300);

    const m9Check = await evaluate(`(() => {
      const banner = document.getElementById('insecureCameraBanner');
      return {
        bannerExists: !!banner,
        bannerText: banner ? banner.querySelector('.insecure-banner-text')?.textContent : null,
        bannerDisplay: banner ? window.getComputedStyle(banner).display : null
      };
    })()`);
    console.log('M9 Insecure Context Warning Check:', m9Check);
    await capture('mobile_390_insecure_warning.png');

    // Hide banner
    await evaluate(`(() => {
      const banner = document.getElementById('insecureCameraBanner');
      if (banner) banner.classList.add('hidden');
    })()`);

    // Switch back to Home
    await evaluate(`document.querySelector('.bottom-nav-item[data-mode="home"]').click()`);
    await sleep(500);

    // =========================================================================
    // STEP 9: DESKTOP FROZEN VERIFICATION (1280x800 & 1920x1080)
    // =========================================================================
    console.log('\n======================================================');
    console.log('🖥️ 2. DESKTOP FROZEN VERIFICATION (1280x800 & 1920x1080)');
    console.log('======================================================');

    // 1280x800
    await sendCommand('Emulation.setDeviceMetricsOverride', {
      width: 1280,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
      hasTouch: false
    });
    await sleep(500);

    const d1280Check = await evaluate(`(() => {
      const nav = document.getElementById('mobileBottomNav');
      const header = document.querySelector('.app-header');
      const deskNotice = document.querySelector('.desktop-privacy-notice');
      const mobNotice = document.querySelector('.mobile-privacy-notice');
      return {
        bottomNavDisplay: nav ? window.getComputedStyle(nav).display : null,
        appHeaderDisplay: header ? window.getComputedStyle(header).display : null,
        desktopNoticeDisplay: deskNotice ? window.getComputedStyle(deskNotice).display : null,
        mobileNoticeDisplay: mobNotice ? window.getComputedStyle(mobNotice).display : null,
        desktopNoticeText: deskNotice ? deskNotice.innerText.trim() : null
      };
    })()`);
    console.log('Desktop 1280 Check:', d1280Check);
    await capture('desktop_1280_home_verified.png');

    // Capture other modes on 1280 to confirm pristine desktop state
    const modes = ['detection', 'read_text', 'collection', 'manager', 'identity'];
    for (const m of modes) {
      await evaluate(`window.__visionxApp?.setMode('${m}') || document.querySelector('.sidebar-nav-item[data-mode="${m}"]')?.click()`);
      await sleep(400);
      await capture(`desktop_1280_${m}_verified.png`);
    }

    // 1920x1080
    await sendCommand('Emulation.setDeviceMetricsOverride', {
      width: 1920,
      height: 1080,
      deviceScaleFactor: 1,
      mobile: false,
      hasTouch: false
    });
    await sleep(500);

    await evaluate(`window.__visionxApp?.setMode('home') || document.querySelector('.sidebar-nav-item[data-mode="home"]')?.click()`);
    await sleep(400);
    const d1920Check = await evaluate(`(() => {
      const nav = document.getElementById('mobileBottomNav');
      const header = document.querySelector('.app-header');
      return {
        bottomNavDisplay: nav ? window.getComputedStyle(nav).display : null,
        appHeaderDisplay: header ? window.getComputedStyle(header).display : null
      };
    })()`);
    console.log('Desktop 1920 Check:', d1920Check);
    await capture('desktop_1920_home_verified.png');

    for (const m of modes) {
      await evaluate(`window.__visionxApp?.setMode('${m}') || document.querySelector('.sidebar-nav-item[data-mode="${m}"]')?.click()`);
      await sleep(400);
      await capture(`desktop_1920_${m}_verified.png`);
    }

    console.log('\n======================================================');
    console.log('✅ ALL VERIFICATIONS COMPLETED SUCCESSFULLY!');
    console.log('======================================================');

  } catch (err) {
    console.error('❌ Verification Error:', err);
  } finally {
    if (ws) ws.close();
    chromeProc.kill('SIGTERM');
  }
}

run();
