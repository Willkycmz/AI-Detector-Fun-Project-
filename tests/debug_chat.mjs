import { spawn } from 'child_process';
import http from 'http';
import fs from 'fs';

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DEBUG_PORT = 9264;

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

    // Kirim pesan panjang di chat input
    await sendCommand('Runtime.evaluate', {
      expression: `
        const input = document.getElementById('chatMessageInput');
        input.value = 'Halo VisionX! Ini adalah pesan pengujian dengan teks yang sangat panjang untuk memeriksa apakah bubble chat membungkus kata dengan benar dan tidak terpotong di tepi kanan layar atau menimpa elemen lain.';
        document.getElementById('btnSendChatMessage').click();
      `,
      returnByValue: true
    });

    await sleep(1000);

    // Sekarang klik Batal pada auth modal
    await sendCommand('Runtime.evaluate', {
      expression: `
        const btnCancel = document.getElementById('btnCancelAuthModal');
        if (btnCancel) btnCancel.click();
      `,
      returnByValue: true
    });

    await sleep(1500);

    // Ambil screenshot
    const resShot = await sendCommand('Page.captureScreenshot', { format: 'png' });
    const buffer = Buffer.from(resShot.data, 'base64');
    const shotPath = 'C:\\Users\\advan\\.gemini\\antigravity-ide\\brain\\4bea7b7f-e8b1-47cb-8961-d89973239123\\debug_chat_after_cancel.png';
    fs.writeFileSync(shotPath, buffer);
    console.log('Saved screenshot to:', shotPath);

    const layout = await sendCommand('Runtime.evaluate', {
      expression: `
        (() => {
          const userMsg = document.querySelector('.message-user');
          const asstMsg = document.querySelector('.message-assistant');
          const thread = document.getElementById('chatThread');
          return {
            windowWidth: window.innerWidth,
            userMsgHTML: userMsg ? userMsg.outerHTML : null,
            asstMsgHTML: asstMsg ? asstMsg.outerHTML : null
          };
        })()
      `,
      returnByValue: true
    });

    console.log('LAYOUT DETAILS:\n', JSON.stringify(layout.result.value, null, 2));

    ws.close();
  } finally {
    chromeProc.kill();
  }
}

run().catch(console.error);
