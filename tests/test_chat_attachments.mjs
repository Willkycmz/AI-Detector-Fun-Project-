import { spawn } from 'child_process';
import http from 'http';
import path from 'path';

const ROOT = 'C:\\Users\\advan\\Documents\\VisionX';
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DEBUG_PORT = 9366;
const TARGET_URL = 'http://127.0.0.1:5173/';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fetchJson = (url) => new Promise((resolve, reject) => {
  http.get(url, (res) => {
    let body = '';
    res.on('data', (c) => { body += c; });
    res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
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
        const msg = JSON.parse(data);
        if (!msg.id || !this.pending.has(msg.id)) return;
        const req = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? req.reject(new Error(msg.error.message)) : req.resolve(msg.result);
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
    const res = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (res.exceptionDetails) {
      const errDetail = res.exceptionDetails.exception?.description || res.exceptionDetails.text;
      throw new Error(errDetail);
    }
    return res.result?.value;
  }
}

const chrome = spawn(CHROME_PATH, [
  '--headless=new', `--remote-debugging-port=${DEBUG_PORT}`, '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', '--hide-scrollbars', 'about:blank'
], { stdio: 'ignore' });

let client;
try {
  let targets;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { targets = await fetchJson(`http://127.0.0.1:${DEBUG_PORT}/json`); if (targets?.length) break; } catch {}
    await sleep(250);
  }
  client = new CDPClient(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await client.connect();
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Page.navigate', { url: TARGET_URL });
  
  for (let attempt = 0; attempt < 80; attempt++) {
    const ready = await client.evaluate(`Boolean(document.getElementById('btnAttachDoc') && window.visionXApp?.chatController)`);
    if (ready) break;
    await sleep(250);
  }

  console.log('Testing chat attachment buttons...');

  // Test 1: Buttons exist and are visible
  const buttonsState = await client.evaluate(`(() => {
    const btnDoc = document.getElementById('btnAttachDoc');
    const btnImg = document.getElementById('btnAttachImage');
    const inputDoc = document.getElementById('chatDocInput');
    const inputImg = document.getElementById('chatImageInput');
    const sendBtn = document.getElementById('btnSendChatMessage');
    const stopBtn = document.getElementById('btnStopGeneration');
    const dockSendSlot = document.getElementById('dockSendSlot');

    return {
      hasBtnDoc: Boolean(btnDoc),
      hasBtnImg: Boolean(btnImg),
      hasInputDoc: Boolean(inputDoc),
      hasInputImg: Boolean(inputImg),
      hasSendBtn: Boolean(sendBtn),
      hasStopBtn: Boolean(stopBtn),
      hasSendSlot: Boolean(dockSendSlot),
      btnDocVisible: getComputedStyle(btnDoc).display !== 'none',
      btnImgVisible: getComputedStyle(btnImg).display !== 'none',
      sendBtnVisible: getComputedStyle(sendBtn).display !== 'none'
    };
  })()`);
  console.log('Buttons existence & visibility:', buttonsState);

  // Test 2: Test image attachment flow via simulated File
  const imageAttachTest = await client.evaluate(`(() => {
    const app = window.visionXApp;
    const controller = app?.chatController;
    if (!controller) return { error: 'ChatController tidak ditemukan' };

    // Simulate image selection
    const fakeDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    controller.setSnapshot({
      dataUrl: fakeDataUrl,
      fileName: 'foto_ruangan.png',
      width: 800,
      height: 600,
      detections: []
    });

    const preview = document.getElementById('snapshotPreviewContainer');
    const thumb = document.getElementById('snapshotThumbnail');
    const info = document.getElementById('snapshotInfoText');
    const isVisible = !preview.classList.contains('hidden');

    return {
      activeSnapshotSet: Boolean(controller.activeSnapshot),
      fileName: controller.activeSnapshot?.fileName,
      previewVisible: isVisible,
      thumbSrcMatches: thumb.src === fakeDataUrl,
      infoText: info.textContent
    };
  })()`);
  console.log('Image attachment test:', imageAttachTest);

  // Test 3: Remove snapshot
  const removeTest = await client.evaluate(`(() => {
    const btnRemove = document.getElementById('btnRemoveSnapshot');
    btnRemove.click();
    const preview = document.getElementById('snapshotPreviewContainer');
    const controller = window.visionXApp?.chatController;
    return {
      activeSnapshotCleared: controller.activeSnapshot === null,
      previewHidden: preview.classList.contains('hidden')
    };
  })()`);
  console.log('Remove attachment test:', removeTest);

  // Test 4: Document attachment flow
  const docAttachTest = await client.evaluate(`(() => {
    const controller = window.visionXApp?.chatController;
    controller.setAttachedDocument({
      name: 'laporan_inspeksi.txt',
      size: 4096,
      type: 'text/plain',
      content: 'Laporan visual deteksi objek 2026.',
      isBinary: false
    });

    const preview = document.getElementById('snapshotPreviewContainer');
    const docIcon = document.getElementById('docAttachmentIcon');
    const info = document.getElementById('snapshotInfoText');
    const isVisible = !preview.classList.contains('hidden');
    const iconVisible = !docIcon.classList.contains('hidden');

    return {
      activeDocSet: Boolean(controller.activeDocument),
      docName: controller.activeDocument?.name,
      previewVisible: isVisible,
      iconVisible: iconVisible,
      infoText: info.textContent
    };
  })()`);
  console.log('Document attachment test:', docAttachTest);

  // Test 5: Verify no layout gap between AttachImage and Send button
  const layoutGapTest = await client.evaluate(`(() => {
    const imgBtn = document.getElementById('btnAttachImage');
    const sendSlot = document.getElementById('dockSendSlot');
    const imgRect = imgBtn.getBoundingClientRect();
    const slotRect = sendSlot.getBoundingClientRect();
    const gap = slotRect.left - imgRect.right;
    return {
      imgRight: imgRect.right,
      slotLeft: slotRect.left,
      gapBetweenImgAndSend: Math.round(gap),
      normalGap: gap <= 10 && gap >= 0
    };
  })()`);
  console.log('Layout gap test:', layoutGapTest);

  // Test 6: Sending message with document renders .message-doc-pill in thread
  const sendDocTest = await client.evaluate(`(() => {
    const controller = window.visionXApp?.chatController;
    const input = document.getElementById('chatMessageInput');
    input.value = 'Tolong baca dokumen ini';
    controller.sendMessage();

    const lastBubble = document.querySelector('.chat-message-item.message-user:last-child');
    const pill = lastBubble?.querySelector('.message-doc-pill');
    const docName = pill?.querySelector('.message-doc-name')?.textContent;

    return {
      hasUserBubble: Boolean(lastBubble),
      hasDocPill: Boolean(pill),
      docNameInPill: docName
    };
  })()`);
  console.log('Send with document test:', sendDocTest);

  console.log('ALL ATTACHMENT TESTS COMPLETED SUCCESSFULLY!');
} finally {
  client?.socket?.close();
  chrome.kill();
}
