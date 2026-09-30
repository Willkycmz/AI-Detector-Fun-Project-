import { spawn } from 'child_process';
import http from 'http';
import fs from 'fs';

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DEBUG_PORT = 9265;

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
  const chromeProc = spawn(CHROME_PATH, [
    '--headless=new',
    `--remote-debugging-port=${DEBUG_PORT}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    'http://localhost:5173/'
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

    const pageTarget = targets.find(t => t.type === 'page');
    const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
    await new Promise(resolve => ws.onopen = resolve);

    let msgId = 1;
    const pendingCalls = new Map();
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && pendingCalls.has(msg.id)) {
        const { resolve, reject } = pendingCalls.get(msg.id);
        pendingCalls.delete(msg.id);
        if (msg.error) reject(msg.error);
        else resolve(msg.result);
      }
    };

    function sendCommand(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = msgId++;
        pendingCalls.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    }

    await sendCommand('Page.enable');
    await sendCommand('Runtime.enable');
    await sendCommand('DOM.enable');

    await sleep(1000);

    // Kirim pesan turn pengguna dan turn asisten via conversationManager untuk melihat tampilan percakapan dua arah
    await sendCommand('Runtime.evaluate', {
      expression: `
        (() => {
          const controller = window.visionXApp.chatController;
          controller.conversationManager.clear();
          controller.conversationManager.appendUserMessage('Halo VisionX! Tolong jelaskan deteksi objek di sekitar.');
          controller.conversationManager.appendAssistantMessage('Halo! Saya telah mendeteksi 2 objek di depan kamera: 1 botol di sisi kiri (confidence 92%) dan 1 cangkir di sisi kanan (confidence 88%). Area aman dan tidak ada indikasi bahaya.');
          controller.renderThread();
        })()
      `,
      returnByValue: true
    });

    await sleep(1000);

    // Ambil screenshot
    const resShot = await sendCommand('Page.captureScreenshot', { format: 'png' });
    const buffer = Buffer.from(resShot.data, 'base64');
    const shotPath = 'C:\\Users\\advan\\.gemini\\antigravity-ide\\brain\\4bea7b7f-e8b1-47cb-8961-d89973239123\\debug_chat_conversation_bubbles.png';
    fs.writeFileSync(shotPath, buffer);
    console.log('Saved screenshot to:', shotPath);

    ws.close();
  } finally {
    chromeProc.kill();
  }
}

run().catch(console.error);
