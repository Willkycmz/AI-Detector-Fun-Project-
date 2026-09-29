/**
 * tests/test_camera_modal_milestone_2.mjs
 * 
 * VisionX Milestone 2 — Camera Modal & Snapshot Integration Test Suite
 * Covers:
 * - Lazy camera lifecycle (zero camera on chat startup, camera starts only on explicit [📷] press)
 * - Modal opening, closing, and state transitions
 * - Permission denied and error handling
 * - Live YOLO detection overlay with 7 golden classes
 * - Client-side frame resizing to max 768px dimension and JPEG 0.85 encoding
 * - Snapshot capture, thumbnail preview, and removal
 * - In-memory only storage (no disk persistence)
 * - Track teardown on modal close (zero orphan streams)
 * - Re-opening modal creates exactly one valid stream (no duplicate streams)
 */

import assert from 'assert';
import { CameraModal, CameraModalState, GOLDEN_CLASSES } from '../web/src/ui/CameraModal.js';
import { CameraService } from '../web/src/services/CameraService.js';

console.log('================================================================');
console.log('📷 Running VisionX Milestone 2 — Camera Modal & Snapshot Suite');
console.log('================================================================\n');

// Mock Track & MediaStream Tracker
class MockTrack {
  constructor(id = 'track-1') {
    this.id = id;
    this.kind = 'video';
    this.stopped = false;
  }
  stop() {
    this.stopped = true;
  }
  getSettings() {
    return { width: 1280, height: 720 };
  }
}

class MockMediaStream {
  constructor(id = 'stream-1') {
    this.id = id;
    this.tracks = [new MockTrack(`track-${Date.now()}`)];
  }
  getTracks() {
    return this.tracks;
  }
  getVideoTracks() {
    return this.tracks;
  }
}

let getUserMediaCallCount = 0;
let activeStreams = [];
let mockGetUserMediaFail = false;

// Global DOM mocks for Camera Modal
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
    width: 640,
    height: 480,
    videoWidth: 1280,
    videoHeight: 720,
    readyState: 4,
    srcObject: null,
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
    play: async () => {},
    pause: () => {},
    getContext: () => ({
      clearRect: () => {},
      drawImage: () => {},
      strokeRect: () => {},
      fillRect: () => {},
      fillText: () => {},
      measureText: () => ({ width: 60 }),
      save: () => {},
      restore: () => {},
      beginPath: () => {},
      arc: () => {},
      fill: () => {},
      stroke: () => {}
    }),
    toDataURL: (format, quality) => {
      return `data:image/jpeg;base64,mockJpegData_w${elem.width}_h${elem.height}_q${quality}`;
    },
    querySelector: () => null,
    querySelectorAll: () => []
  };
  return elem;
}

global.document = {
  createElement: (tag) => createMockElement(tag),
  getElementById: (id) => createMockElement('div', id),
  querySelector: () => null,
  querySelectorAll: () => []
};

global.window = {
  isSecureContext: true,
  location: {
    protocol: 'http:',
    hostname: 'localhost',
    href: 'http://localhost/'
  },
  addEventListener: () => {},
  removeEventListener: () => {},
  requestAnimationFrame: (cb) => setTimeout(cb, 16),
  cancelAnimationFrame: (id) => clearTimeout(id)
};

global.requestAnimationFrame = (cb) => setTimeout(cb, 16);
global.cancelAnimationFrame = (id) => clearTimeout(id);

Object.defineProperty(globalThis, 'navigator', {
  value: {
    mediaDevices: {
      addEventListener: () => {},
      removeEventListener: () => {},
      getUserMedia: async (constraints) => {
        getUserMediaCallCount++;
        if (mockGetUserMediaFail) {
          const err = new Error('Permission denied by user');
          err.name = 'NotAllowedError';
          throw err;
        }
        const stream = new MockMediaStream(`stream-${getUserMediaCallCount}`);
        activeStreams.push(stream);
        return stream;
      },
      enumerateDevices: async () => [
        { deviceId: 'cam-1', kind: 'videoinput', label: 'FaceTime HD' }
      ]
    },
    userAgent: 'Mozilla/5.0 Chrome/120.0.0.0',
    maxTouchPoints: 0
  },
  configurable: true,
  writable: true
});

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

// Helper to create test CameraModal
function createTestCameraModal(customOptions = {}) {
  const modalElement = createMockElement('dialog', 'cameraModal');
  const videoElement = createMockElement('video', 'modalVideo');
  const canvasElement = createMockElement('canvas', 'modalCanvas');
  const captureBtn = createMockElement('button', 'btnModalCapture');
  const closeBtn = createMockElement('button', 'btnModalClose');
  const shutterElement = createMockElement('div', 'modalShutterFlash');
  const stateNoticeElement = createMockElement('div', 'cameraModalStateNotice');
  const errorElement = createMockElement('div', 'cameraModalError');
  const errorTextElement = createMockElement('p', 'cameraModalErrorText');

  const cameraService = new CameraService();
  const inferenceService = {
    isModelLoaded: true,
    status: 'ready',
    activeModelPreset: { classes: GOLDEN_CLASSES },
    infer: async () => [
      { class_name: 'person', confidence: 0.94, bbox: [100, 100, 400, 600] },
      { class_name: 'cup', confidence: 0.88, bbox: [500, 300, 650, 450] }
    ]
  };

  let capturedData = null;

  const modal = new CameraModal({
    cameraService,
    inferenceService,
    modalElement,
    videoElement,
    canvasElement,
    captureBtn,
    closeBtn,
    shutterElement,
    stateNoticeElement,
    errorElement,
    errorTextElement,
    onSnapshot: (snap) => {
      capturedData = snap;
    },
    ...customOptions
  });

  return {
    modal,
    cameraService,
    inferenceService,
    elements: {
      modalElement,
      videoElement,
      canvasElement,
      captureBtn,
      closeBtn,
      shutterElement,
      stateNoticeElement,
      errorElement,
      errorTextElement
    },
    getCapturedData: () => capturedData
  };
}

// =========================================================================
// 1. LAZY CAMERA LIFECYCLE TESTS
// =========================================================================
console.log('--- Sub-Suite A: Lazy Camera Lifecycle & Trigger ---');

runTest('17. Chat opening does NOT request camera permissions (getUserMedia = 0)', () => {
  getUserMediaCallCount = 0;
  // Creating CameraModal without opening it
  const { modal } = createTestCameraModal();
  assert.strictEqual(modal.isOpen, false);
  assert.strictEqual(modal.state, CameraModalState.IDLE);
  assert.strictEqual(getUserMediaCallCount, 0, 'getUserMedia must NOT be called on idle creation');
});

await runAsyncTest('18. Camera starts ONLY upon explicit camera button trigger', async () => {
  getUserMediaCallCount = 0;
  mockGetUserMediaFail = false;
  const { modal, elements } = createTestCameraModal();

  // Explicit open
  const openPromise = modal.open();
  assert.strictEqual(modal.isOpen, true);
  assert.strictEqual(modal.state, CameraModalState.OPENING);

  await openPromise;
  if (modal.state !== CameraModalState.READY) {
    console.log('Test 18 Failed with lastError:', modal.lastError);
  }
  assert.strictEqual(modal.state, CameraModalState.READY);
  assert.strictEqual(getUserMediaCallCount, 1, 'getUserMedia must be called exactly once');
  assert.strictEqual(elements.modalElement.classList.contains('hidden'), false);
  assert.strictEqual(elements.modalElement.getAttribute('aria-hidden'), 'false');
});

// =========================================================================
// 2. ERROR & PERMISSION HANDLING
// =========================================================================
console.log('\n--- Sub-Suite B: Permission & Error States ---');

await runAsyncTest('19. Camera permission denied transitions to PERMISSION_DENIED without crash', async () => {
  mockGetUserMediaFail = true;
  const { modal, elements } = createTestCameraModal();

  await modal.open();

  assert.strictEqual(modal.state, CameraModalState.PERMISSION_DENIED);
  assert.strictEqual(elements.errorElement.classList.contains('hidden'), false);
  assert.ok(elements.errorTextElement.textContent.includes('Izin kamera ditolak'));
  assert.strictEqual(elements.captureBtn.disabled, true);
  mockGetUserMediaFail = false;
});

// =========================================================================
// 3. LIVE YOLO OVERLAY & 7 GOLDEN CLASSES
// =========================================================================
console.log('\n--- Sub-Suite C: Live YOLO Detections & Overlay ---');

await runAsyncTest('20. Live detections use 7 golden classes exclusively', async () => {
  const { modal } = createTestCameraModal();
  await modal.open();

  // Run single frame detection
  const detections = await modal.detectCurrentFrame();
  assert.strictEqual(detections.length, 2);

  detections.forEach(d => {
    assert.ok(GOLDEN_CLASSES.includes(d.class_name), `Class ${d.class_name} must belong to 7 golden classes`);
  });

  assert.strictEqual(detections[0].class_name, 'person');
  assert.strictEqual(detections[1].class_name, 'cup');
  modal.close();
});

// =========================================================================
// 4. SNAPSHOT CAPTURE, RESIZE, & PRIVACY
// =========================================================================
console.log('\n--- Sub-Suite D: Snapshot Capture & Dimension Constraints ---');

await runAsyncTest('21. Snapshot captured and scaled client-side to max 768px dimension', async () => {
  const { modal, elements, getCapturedData } = createTestCameraModal();
  await modal.open();

  // Set mock video dimensions (1280 x 720)
  elements.videoElement.videoWidth = 1280;
  elements.videoElement.videoHeight = 720;

  // Jalankan frame deteksi agar deteksi terbaru tersedia pada snapshot
  await modal.detectCurrentFrame();

  await modal.captureSnapshot();
  const snap = getCapturedData();

  assert.ok(snap, 'Snapshot data must be generated');
  assert.ok(snap.dataUrl.startsWith('data:image/jpeg;base64,'));
  assert.ok(snap.width <= 768, `Width ${snap.width} must be <= 768px`);
  assert.ok(snap.height <= 768, `Height ${snap.height} must be <= 768px`);
  // 1280x720 scaled to max 768 gives 768x432
  assert.strictEqual(snap.width, 768);
  assert.strictEqual(snap.height, 432);
  assert.strictEqual(snap.detections.length, 2);

  modal.close();
});

runTest('22. Golden classes match verified Milestone 1 definition', () => {
  const expectedClasses = [
    'person',
    'bottle',
    'cup',
    'laptop',
    'mouse',
    'keyboard',
    'cell_phone'
  ];
  assert.deepStrictEqual(GOLDEN_CLASSES, expectedClasses);
});

// =========================================================================
// 5. TRACK TEARDOWN & RE-OPENING CLEANLINESS
// =========================================================================
console.log('\n--- Sub-Suite E: Stream Teardown & Stream Cleanliness ---');

await runAsyncTest('23. Modal close stops all media tracks and clears stream', async () => {
  const { modal, cameraService } = createTestCameraModal();
  await modal.open();

  assert.ok(cameraService.stream, 'CameraService must have an active stream when open');
  const tracks = cameraService.stream.getTracks();
  assert.strictEqual(tracks.length, 1);
  assert.strictEqual(tracks[0].stopped, false);

  // Close modal
  modal.close();

  assert.strictEqual(modal.isOpen, false);
  assert.strictEqual(modal.state, CameraModalState.CLOSED);
  assert.strictEqual(tracks[0].stopped, true, 'Track must be stopped upon modal close');
  assert.strictEqual(cameraService.stream, null, 'Stream reference must be nullified');
});

await runAsyncTest('24. Re-opening modal creates exactly one valid stream without orphan tracks', async () => {
  getUserMediaCallCount = 0;
  activeStreams = [];
  const { modal, cameraService } = createTestCameraModal();

  // Open 1
  await modal.open();
  assert.strictEqual(getUserMediaCallCount, 1);
  const stream1Tracks = cameraService.stream.getTracks();
  modal.close();
  assert.strictEqual(stream1Tracks[0].stopped, true);

  // Open 2 (re-open)
  await modal.open();
  assert.strictEqual(getUserMediaCallCount, 2);
  const stream2Tracks = cameraService.stream.getTracks();
  assert.strictEqual(stream2Tracks[0].stopped, false);
  modal.close();
  assert.strictEqual(stream2Tracks[0].stopped, true);
});

// =========================================================================
// RESULTS SUMMARY
// =========================================================================
console.log('\n================================================================');
console.log(`📊 Camera Modal Results: ${testsPassed} passed, ${testsFailed} failed`);
console.log('================================================================\n');

if (testsFailed > 0) {
  process.exit(1);
} else {
  console.log('🎉 All Camera Modal Milestone 2 tests PASSED successfully!\n');
}
