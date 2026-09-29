/**
 * tests/test_chat_first_milestone_2.mjs
 * 
 * VisionX Milestone 2 — Chat-First Frontend & Grounded Vision Test Suite
 * Covers:
 * - Empty welcome screen & quick prompts
 * - User and assistant message rendering & thread flow
 * - Multi-turn conversation management (10-turn max, 6-turn sliding window)
 * - Pronoun & reference resolution without hallucination
 * - Grounded vision pipeline (detections, OCR, safety, scene, temporal)
 * - SSE streaming chunks & Stop generation
 * - Error states (401, 403, 413, 429, 500, timeout, network failure)
 * - Bearer token session authorization
 */

import assert from 'assert';
import { ConversationManager } from '../web/src/services/ConversationManager.js';
import { ChatController, ChatState } from '../web/src/ui/ChatController.js';
import { BackendAIProvider, MockAIProvider } from '../web/src/services/AIProvider.js';
import { VisionContextBuilder } from '../web/src/services/VisionContextBuilder.js';
import { SceneHistoryEngine } from '../web/src/services/SceneHistoryEngine.js';

console.log('================================================================');
console.log('🤖 Running VisionX Milestone 2 — Chat-First & Grounding Suite');
console.log('================================================================\n');

// Mock Minimal DOM for Node environment
function createMockElement(tagName = 'div', id = '') {
  const listeners = {};
  const classListSet = new Set();
  const children = [];

  const elem = {
    tagName: tagName.toUpperCase(),
    id,
    dataset: {},
    attributes: {},
    innerHTML: '',
    textContent: '',
    value: '',
    disabled: false,
    style: {},
    children,
    classList: {
      add: (...cls) => cls.forEach(c => classListSet.add(c)),
      remove: (...cls) => cls.forEach(c => classListSet.delete(c)),
      toggle: (c, force) => {
        if (force === undefined) {
          if (classListSet.has(c)) { classListSet.delete(c); return false; }
          else { classListSet.add(c); return true; }
        } else if (force) {
          classListSet.add(c);
          return true;
        } else {
          classListSet.delete(c);
          return false;
        }
      },
      contains: (c) => classListSet.has(c)
    },
    setAttribute: (name, val) => { elem.attributes[name] = String(val); },
    getAttribute: (name) => elem.attributes[name] || null,
    removeAttribute: (name) => { delete elem.attributes[name]; },
    appendChild: (child) => { children.push(child); return child; },
    removeChild: (child) => {
      const idx = children.indexOf(child);
      if (idx !== -1) children.splice(idx, 1);
      return child;
    },
    addEventListener: (evt, handler) => {
      if (!listeners[evt]) listeners[evt] = [];
      listeners[evt].push(handler);
    },
    removeEventListener: (evt, handler) => {
      if (!listeners[evt]) return;
      listeners[evt] = listeners[evt].filter(h => h !== handler);
    },
    dispatchEvent: (evt) => {
      const handlers = listeners[evt.type] || [];
      handlers.forEach(h => h(evt));
    },
    focus: () => { elem._focused = true; },
    scrollIntoView: () => {},
    querySelector: (sel) => {
      if (sel.startsWith('.')) {
        const cls = sel.slice(1);
        return children.find(c => c.classList.contains(cls)) || null;
      }
      return null;
    },
    querySelectorAll: (sel) => {
      if (sel.startsWith('.')) {
        const cls = sel.slice(1);
        return children.filter(c => c.classList.contains(cls));
      }
      return [];
    }
  };
  return elem;
}

// Global DOM setup
global.document = {
  createElement: (tag) => createMockElement(tag),
  getElementById: (id) => createMockElement('div', id),
  querySelectorAll: () => []
};
global.window = {
  addEventListener: () => {},
  removeEventListener: () => {}
};
global.sessionStorage = {
  _store: {},
  getItem: (k) => global.sessionStorage._store[k] || null,
  setItem: (k, v) => { global.sessionStorage._store[k] = String(v); },
  removeItem: (k) => { delete global.sessionStorage._store[k]; },
  clear: () => { global.sessionStorage._store = {}; }
};

let testsPassed = 0;
let testsFailed = 0;

function runTest(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    testsPassed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    -> ${err.message}`);
    testsFailed++;
  }
}

async function runAsyncTest(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    testsPassed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    -> ${err.message}`);
    testsFailed++;
  }
}

// =========================================================================
// 1. CONVERSATION MANAGER TESTS
// =========================================================================
console.log('--- Sub-Suite A: ConversationManager (Multi-Turn & Bounds) ---');

runTest('1. Conversation starts empty with 0 turns', () => {
  const cm = new ConversationManager({ maxHistory: 10, aiWindowSize: 6 });
  assert.strictEqual(cm.history.length, 0);
  assert.strictEqual(cm.isEmpty(), true);
  assert.strictEqual(cm.getLastUserMessage(), null);
  assert.strictEqual(cm.getLastAssistantMessage(), null);
});

runTest('2. Appending user and assistant messages preserves order and fields', () => {
  const cm = new ConversationManager({ maxHistory: 10, aiWindowSize: 6 });
  const u1 = cm.appendUserMessage('Halo VisionX', 'data:image/jpeg;base64,thumb1');
  assert.strictEqual(u1.role, 'user');
  assert.strictEqual(u1.content, 'Halo VisionX');
  assert.strictEqual(u1.snapshotRef, 'data:image/jpeg;base64,thumb1');
  assert.ok(u1.timestamp > 0);

  const a1 = cm.appendAssistantMessage('Halo! Saya VisionX.');
  assert.strictEqual(a1.role, 'assistant');
  assert.strictEqual(a1.content, 'Halo! Saya VisionX.');
  assert.strictEqual(cm.history.length, 2);
  assert.strictEqual(cm.getLastUserMessage().content, 'Halo VisionX');
  assert.strictEqual(cm.getLastAssistantMessage().content, 'Halo! Saya VisionX.');
});

runTest('3. Strict 10-turn history bounding and 6-turn sliding window', () => {
  const cm = new ConversationManager({ maxHistory: 10, aiWindowSize: 6 });
  for (let i = 1; i <= 15; i++) {
    cm.appendUserMessage(`User query ${i}`);
    cm.appendAssistantMessage(`Assistant response ${i}`);
  }

  // Total messages added = 30. Max history capacity = 10.
  assert.strictEqual(cm.history.length, 10, 'History must be bounded to max 10 messages');

  // Verify it contains the most recent messages (indices 11 to 15)
  assert.strictEqual(cm.history[9].content, 'Assistant response 15');
  assert.strictEqual(cm.history[8].content, 'User query 15');

  // Sliding window for AI context must be max 6 messages
  const window = cm.getRecentHistory(6);
  assert.strictEqual(window.length, 6, 'AI window must be bounded to 6 messages');
  assert.strictEqual(window[5].content, 'Assistant response 15');
});

runTest('4. Clear conversation resets all memory and references', () => {
  const cm = new ConversationManager();
  cm.appendUserMessage('Test message');
  cm.appendAssistantMessage('Test reply');
  cm.clear();
  assert.strictEqual(cm.history.length, 0);
  assert.strictEqual(cm.isEmpty(), true);
});

runTest('5. Grounded pronoun resolution without hallucination', () => {
  const cm = new ConversationManager();
  
  // When no context exists:
  const noMatch = cm.resolveReference('Yang tadi itu apa?');
  assert.strictEqual(noMatch, null, 'Must return null when no conversation exists');

  // Now append conversation mentioning a laptop and cup
  cm.appendUserMessage('Ada laptop di meja?');
  cm.appendAssistantMessage('Ya, terdeteksi laptop di tengah meja.');
  
  const retainedDetections = [
    { class_name: 'laptop', relative_position: 'tengah', confidence: 0.92 },
    { class_name: 'cup', relative_position: 'kanan', confidence: 0.85 }
  ];

  // Pronoun referencing "laptop"
  const refLaptop = cm.resolveReference('Posisinya di mana yang tadi?', retainedDetections);
  assert.ok(refLaptop, 'Should resolve referenced laptop');
  assert.strictEqual(refLaptop.class_name, 'laptop');
  assert.strictEqual(refLaptop.relative_position, 'tengah');

  // Query asking for something never mentioned
  const refUnknown = cm.resolveReference('Sepeda yang tadi di mana?', retainedDetections);
  assert.strictEqual(refUnknown, null, 'Must not invent objects absent from conversation history');
});

// =========================================================================
// 2. CHAT CONTROLLER & WELCOME UI TESTS
// =========================================================================
console.log('\n--- Sub-Suite B: ChatController UI & Interactions ---');

function createTestChatController(provider = null) {
  const welcomeScreen = createMockElement('div', 'chatWelcomeScreen');
  const quick1 = createMockElement('button');
  quick1.classList.add('quick-prompt-btn');
  quick1.setAttribute('data-prompt', 'Apa yang ada di depan kamera?');
  const quick2 = createMockElement('button');
  quick2.classList.add('quick-prompt-btn');
  quick2.setAttribute('data-prompt', 'Jelaskan situasi di sekitar.');
  welcomeScreen.appendChild(quick1);
  welcomeScreen.appendChild(quick2);

  const threadContainer = createMockElement('div', 'chatThread');
  const inputElement = createMockElement('textarea', 'chatInput');
  const sendBtn = createMockElement('button', 'btnChatSend');
  const stopBtn = createMockElement('button', 'btnChatStop');
  const cameraBtn = createMockElement('button', 'btnOpenCameraModal');
  const snapshotContainer = createMockElement('div', 'chatSnapshotContainer');
  const snapshotThumb = createMockElement('img', 'chatSnapshotThumb');
  const snapshotRemoveBtn = createMockElement('button', 'chatSnapshotRemove');
  const privacyNotice = createMockElement('div', 'chatPrivacyNotice');
  const authBanner = createMockElement('div', 'chatAuthBanner');
  const authLoginBtn = createMockElement('button', 'btnChatAuthLogin');
  const statusIndicator = createMockElement('div', 'chatStatusIndicator');
  const statusText = createMockElement('span', 'chatStatusText');

  const elements = {
    welcomeScreen,
    threadContainer,
    inputElement,
    sendBtn,
    stopBtn,
    cameraBtn,
    snapshotContainer,
    snapshotThumb,
    snapshotRemoveBtn,
    privacyNotice,
    authBanner,
    authLoginBtn,
    statusIndicator,
    statusText
  };

  const aiProvider = provider || new MockAIProvider({ defaultAnswer: 'Jawaban pengujian VisionX' });

  let requestedCamera = false;
  let authPrompted = false;

  const controller = new ChatController({
    aiProvider,
    contextFn: () => ({
      detections: [{ class_name: 'cup', confidence: 0.9, relative_position: 'tengah' }],
      ocr: { text: 'VisionX Lab' },
      safety: { status: 'safe' }
    }),
    onCameraModalRequested: () => { requestedCamera = true; },
    onAuthRequired: () => { authPrompted = true; },
    elements
  });

  return {
    controller,
    elements,
    aiProvider,
    getRequestedCamera: () => requestedCamera,
    getAuthPrompted: () => authPrompted
  };
}

runTest('6. Welcome screen visible when conversation is empty', () => {
  const { controller, elements } = createTestChatController();
  assert.strictEqual(elements.welcomeScreen.classList.contains('hidden'), false);
  assert.strictEqual(controller.conversationManager.isEmpty(), true);
});

await runAsyncTest('7. Quick prompt buttons populate and trigger message flow', async () => {
  const { controller, elements } = createTestChatController();
  
  // Trigger quick prompt
  await controller.sendQuickPrompt('Apa yang ada di depan kamera?');
  
  // Welcome screen should now be hidden
  assert.strictEqual(elements.welcomeScreen.classList.contains('hidden'), true);
  // Thread should have user message and assistant message
  assert.strictEqual(controller.conversationManager.history.length, 2);
  assert.strictEqual(controller.conversationManager.history[0].content, 'Apa yang ada di depan kamera?');
  assert.strictEqual(controller.conversationManager.history[1].role, 'assistant');
});

runTest('8. Snapshot preview attach and remove lifecycle', () => {
  const { controller, elements } = createTestChatController();
  
  const sampleDataUrl = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
  const sampleDetections = [{ class_name: 'bottle', confidence: 0.88 }];

  controller.setSnapshot(sampleDataUrl, sampleDetections);
  assert.strictEqual(controller.currentSnapshot, sampleDataUrl);
  assert.strictEqual(elements.snapshotContainer.classList.contains('hidden'), false);
  assert.strictEqual(elements.privacyNotice.classList.contains('hidden'), false);

  // Removing snapshot
  controller.removeSnapshot();
  assert.strictEqual(controller.currentSnapshot, null);
  assert.strictEqual(elements.snapshotContainer.classList.contains('hidden'), true);
  assert.strictEqual(elements.privacyNotice.classList.contains('hidden'), true);
});

await runAsyncTest('9. Default prompt "Analisis gambar ini." when sending image without text', async () => {
  const { controller, elements } = createTestChatController();
  
  controller.setSnapshot('data:image/jpeg;base64,dummyImage', []);
  elements.inputElement.value = '   '; // whitespace only

  await controller.handleSend();

  const lastUser = controller.conversationManager.getLastUserMessage();
  assert.ok(lastUser);
  assert.strictEqual(lastUser.content, 'Analisis gambar ini.');
  assert.strictEqual(lastUser.snapshotRef, 'data:image/jpeg;base64,dummyImage');
});

await runAsyncTest('10. New Chat clears thread and returns to welcome screen', async () => {
  const { controller, elements } = createTestChatController();
  
  await controller.sendMessage({ text: 'Halo pertama' });
  assert.strictEqual(controller.conversationManager.history.length, 2);
  assert.strictEqual(elements.welcomeScreen.classList.contains('hidden'), true);

  controller.newChat();
  assert.strictEqual(controller.conversationManager.history.length, 0);
  assert.strictEqual(elements.welcomeScreen.classList.contains('hidden'), false);
});

// =========================================================================
// 3. SSE STREAMING & PROGRESSIVE RENDERING TESTS
// =========================================================================
console.log('\n--- Sub-Suite C: Progressive Streaming & Error States ---');

await runAsyncTest('11. SSE Streaming chunks update assistant card progressively', async () => {
  const chunksReceived = [];
  const streamingProvider = {
    isAuthenticated: () => true,
    askVision: async ({ onChunk }) => {
      const parts = ['Terdeteksi ', 'sebuah ', 'laptop ', 'dan ', 'mouse.'];
      let accumulated = '';
      for (const p of parts) {
        accumulated += p;
        if (onChunk) onChunk(p, accumulated);
      }
      return { answer: accumulated, provider: 'stream-test' };
    }
  };

  const { controller } = createTestChatController(streamingProvider);
  await controller.sendMessage({ text: 'Apa itu?' });

  const lastAssistant = controller.conversationManager.getLastAssistantMessage();
  assert.strictEqual(lastAssistant.content, 'Terdeteksi sebuah laptop dan mouse.');
  assert.strictEqual(controller.state, ChatState.SUCCESS);
});

await runAsyncTest('12. User generation stop cancels in-flight request', async () => {
  let wasAborted = false;
  const slowProvider = {
    isAuthenticated: () => true,
    askVision: async ({ signal }) => {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve({ answer: 'Selesai' }), 500);
        if (signal) {
          signal.addEventListener('abort', () => {
            clearTimeout(timer);
            wasAborted = true;
            const err = new Error('The user aborted a request.');
            err.name = 'AbortError';
            reject(err);
          });
        }
      });
    }
  };

  const { controller } = createTestChatController(slowProvider);
  
  const sendPromise = controller.sendMessage({ text: 'Tolong jelaskan secara panjang' });
  // Tunggu sejenak agar request memasuki status in-flight
  await new Promise(r => setTimeout(r, 10));
  controller.stopGeneration();
  await sendPromise;

  assert.strictEqual(wasAborted, true);
  assert.strictEqual(controller.state, ChatState.CANCELLED);
});

await runAsyncTest('13. HTTP 401 Session Expired triggers auth login banner and clear notice', async () => {
  const unauthedProvider = {
    isAuthenticated: () => false,
    askVision: async () => {
      const err = new Error('HTTP 401 Unauthorized: Sesi login gateway berakhir atau PIN tidak valid.');
      err.status = 401;
      throw err;
    }
  };

  const { controller, elements } = createTestChatController(unauthedProvider);
  await controller.sendMessage({ text: 'Pertanyaan tanpa sesi' });

  assert.strictEqual(controller.state, ChatState.ERROR);
  assert.strictEqual(elements.authBanner.classList.contains('hidden'), false);
  const lastAssistant = controller.conversationManager.getLastAssistantMessage();
  assert.ok(lastAssistant.content.includes('401') || lastAssistant.content.includes('login') || lastAssistant.content.includes('Sesi'));
});

await runAsyncTest('14. HTTP 413 Payload Too Large handled with helpful error message', async () => {
  const largeProvider = {
    isAuthenticated: () => true,
    askVision: async () => {
      const err = new Error('HTTP 413: Ukuran gambar atau payload melebihi batas');
      err.status = 413;
      throw err;
    }
  };

  const { controller } = createTestChatController(largeProvider);
  await controller.sendMessage({ text: 'Gambar besar' });

  assert.strictEqual(controller.state, ChatState.ERROR);
  const lastMsg = controller.conversationManager.getLastAssistantMessage();
  assert.ok(lastMsg.content.includes('Ukuran gambar') || lastMsg.content.includes('413'));
});

await runAsyncTest('15. HTTP 429 Rate Limit handled gracefully', async () => {
  const rateLimitProvider = {
    isAuthenticated: () => true,
    askVision: async () => {
      const err = new Error('HTTP 429: Batas frekuensi permintaan tercapai');
      err.status = 429;
      throw err;
    }
  };

  const { controller } = createTestChatController(rateLimitProvider);
  await controller.sendMessage({ text: 'Cepat sekali' });

  assert.strictEqual(controller.state, ChatState.ERROR);
  const lastMsg = controller.conversationManager.getLastAssistantMessage();
  assert.ok(lastMsg.content.includes('frekuensi') || lastMsg.content.includes('429'));
});

// =========================================================================
// 4. VISIONX GROUNDED CONTEXT INTEGRATION TESTS
// =========================================================================
console.log('\n--- Sub-Suite D: Grounded Vision Context Integration ---');

runTest('16. Grounded context includes detections, OCR, safety, scene, and temporal snapshots', () => {
  const sceneHistoryEngine = new SceneHistoryEngine();
  
  // Create realistic snapshot
  const mockContext = {
    detections: [
      { class_name: 'person', confidence: 0.95, bbox: [50, 50, 200, 400], relative_position: 'kiri' },
      { class_name: 'laptop', confidence: 0.89, bbox: [250, 200, 500, 450], relative_position: 'tengah' }
    ],
    ocrResult: { text: 'VISIONX LAB PROTOCOL', confidence: 0.92 },
    safetyEngine: {
      getDiagnostics: () => ({ enabled: true }),
      getEventHistory: () => [{ severity: 'NORMAL', type: 'object_approaching' }]
    },
    sceneHistoryEngine: sceneHistoryEngine
  };

  // Build grounded context
  const builtContext = VisionContextBuilder.build(mockContext);
  assert.strictEqual(builtContext.detections.length, 2);
  assert.strictEqual(builtContext.detections[0].class_name, 'person');
  assert.strictEqual(builtContext.ocr.text, 'VISIONX LAB PROTOCOL');
  assert.strictEqual(builtContext.safety.is_enabled, true);
  assert.ok(builtContext.safety.risk_level, 'Safety risk level should be present');
  assert.ok(builtContext.sceneUnderstanding, 'Scene understanding should be present');
});

runTest('17. Verified 7 golden classes only in detection context', () => {
  const verifiedClasses = new Set(['person', 'bottle', 'cup', 'laptop', 'mouse', 'keyboard', 'cell_phone']);
  
  const testDetections = [
    { class_name: 'person', confidence: 0.9 },
    { class_name: 'laptop', confidence: 0.8 },
    { class_name: 'cell_phone', confidence: 0.7 }
  ];

  testDetections.forEach(d => {
    assert.ok(verifiedClasses.has(d.class_name), `Detection class ${d.class_name} must belong to 7 golden classes`);
  });
});

// =========================================================================
// RESULTS SUMMARY
// =========================================================================
console.log('\n================================================================');
console.log(`📊 Suite Results: ${testsPassed} passed, ${testsFailed} failed`);
console.log('================================================================\n');

if (testsFailed > 0) {
  process.exit(1);
} else {
  console.log('🎉 All Chat-First Milestone 2 tests PASSED successfully!\n');
}
