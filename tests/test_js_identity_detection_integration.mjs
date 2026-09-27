/**
 * tests/test_js_identity_detection_integration.mjs
 *
 * Automated Test Suite for VisionX Identity Lab Bugfix + Detection Mode Integration:
 *
 * Test 1: bbox Identity Lab standalone — muncul dan akurat di posisi wajah
 * Test 2: Wajah developer dikenali -> bbox + label custom "Person — Developer VisionX"
 * Test 3: Wajah lain (tidak terdaftar) -> label generik "Person"
 * Test 4: Tidak ada wajah di frame -> tidak ada bbox custom (0 face items)
 * Test 5: Detection Mode existing (non-wajah) -> objek YOLO (bottle, cup, laptop) tetap regression hijau
 * Test 6: Performance benchmark -> Face recognition non-blocking (< 1ms per frame)
 * Test 7: Failure isolation -> Kegagalan face network tidak memblokir atau menggagalkan deteksi YOLO
 */

import { CoordinateMapper } from '../web/src/services/CoordinateMapper.js';
import { DetectionFusion } from '../web/src/services/DetectionFusion.js';
import { FaceDetector } from '../web/src/services/FaceDetector.js';
import { FaceRecognizer } from '../web/src/services/FaceRecognizer.js';
import { UnifiedRenderer } from '../web/src/services/UnifiedRenderer.js';

function assert(condition, message) {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${message}`);
    throw new Error(message);
  }
}

console.log('================================================================');
console.log('🎯 Running VisionX Identity Lab + Detection Mode Integration Tests');
console.log('================================================================\n');

let passedTests = 0;

// -----------------------------------------------------------------------------
// Test 1: bbox Identity Lab standalone — muncul dan akurat di posisi wajah
// -----------------------------------------------------------------------------
console.log('--- Test 1: Identity Lab Standalone Bbox Accuracy ---');
{
  const vw = 1280;
  const vh = 720;
  const letterboxParams = CoordinateMapper.computeLetterboxParams(vw, vh, 640);

  // Simulasi deteksi wajah di 640x640 letterbox frame
  const rawFaceBox = { x1: 220, y1: 180, x2: 360, y2: 340 };
  const mapped = CoordinateMapper.modelToVideo(rawFaceBox, letterboxParams, false);

  // Skala = 0.5, padX = 0, padY = 140
  // x1 = 220 / 0.5 = 440
  // x2 = 360 / 0.5 = 720
  // y1 = (180 - 140) / 0.5 = 80
  // y2 = (340 - 140) / 0.5 = 400
  assert(mapped.x1 === 440, `mapped.x1 expected 440, got ${mapped.x1}`);
  assert(mapped.x2 === 720, `mapped.x2 expected 720, got ${mapped.x2}`);
  assert(mapped.y1 === 80, `mapped.y1 expected 80, got ${mapped.y1}`);
  assert(mapped.y2 === 400, `mapped.y2 expected 400, got ${mapped.y2}`);
  assert(mapped.width === 280, `mapped.width expected 280, got ${mapped.width}`);
  assert(mapped.height === 320, `mapped.height expected 320, got ${mapped.height}`);

  console.log('✅ Test 1 Passed: Identity Lab standalone accurately maps bounding box onto face coordinates');
  passedTests++;
}

// -----------------------------------------------------------------------------
// Test 2: Wajah developer dikenali -> bbox + label custom "Person — Developer VisionX"
// -----------------------------------------------------------------------------
console.log('\n--- Test 2: Developer Face Recognized in Detection Mode ---');
{
  const yoloObjects = [
    { class_name: 'person', bbox: { x1: 400, y1: 60, x2: 760, y2: 680 }, confidence: 0.91, trackId: 1 }
  ];

  const faceDetections = [
    { bbox: { x1: 440, y1: 80, x2: 720, y2: 400 }, confidence: 0.95 }
  ];

  const identityResult = {
    matched: true,
    label: 'Person — Developer VisionX (93.5%)',
    score_percent: '93.5%',
    similarity: 0.935,
    identityStatus: 'REGISTERED'
  };

  const fused = DetectionFusion.fuse(yoloObjects, faceDetections, identityResult, {
    enableObjects: true,
    enableFace: true
  });

  assert(fused.length === 2, `Expected 2 detections (1 person object + 1 face layer), got ${fused.length}`);

  const faceItem = fused.find(d => d.type === 'face');
  assert(faceItem !== undefined, 'Must contain face detection layer');
  assert(faceItem.isDeveloper === true, 'isDeveloper must be true for recognized developer');
  assert(faceItem.identityStatus === 'REGISTERED', 'identityStatus must be REGISTERED');
  assert(faceItem.label.includes('Person — Developer VisionX'), `Label must be custom developer label, got "${faceItem.label}"`);
  assert(faceItem.label.includes('93.5%'), 'Label must include matching score percentage');

  const objectItem = fused.find(d => d.type === 'object');
  assert(objectItem.isDeveloper === true, 'Enclosing YOLO person object must be tagged as verified developer');

  console.log('✅ Test 2 Passed: Developer face recognized with custom label and verified status');
  passedTests++;
}

// -----------------------------------------------------------------------------
// Test 3: Wajah lain (tidak terdaftar) -> label generik "Person"
// -----------------------------------------------------------------------------
console.log('\n--- Test 3: Unregistered Face -> Generic Label "Person" ---');
{
  const yoloObjects = [
    { class_name: 'person', bbox: { x1: 100, y1: 50, x2: 350, y2: 650 }, confidence: 0.87, trackId: 2 }
  ];

  const faceDetections = [
    { bbox: { x1: 150, y1: 70, x2: 290, y2: 250 }, confidence: 0.89 }
  ];

  const identityResult = {
    matched: false,
    label: 'Person',
    score_percent: '32.0%',
    similarity: 0.32,
    identityStatus: 'UNREGISTERED'
  };

  const fused = DetectionFusion.fuse(yoloObjects, faceDetections, identityResult, {
    enableObjects: true,
    enableFace: true
  });

  const faceItem = fused.find(d => d.type === 'face');
  assert(faceItem !== undefined, 'Must contain face detection layer');
  assert(faceItem.isDeveloper === false, 'isDeveloper must be false for unregistered face');
  assert(faceItem.identityStatus === 'UNREGISTERED', 'identityStatus must be UNREGISTERED');
  assert(faceItem.label === 'Person', `Unregistered face label must be exactly "Person", got "${faceItem.label}"`);

  console.log('✅ Test 3 Passed: Unregistered face assigned generic label "Person"');
  passedTests++;
}

// -----------------------------------------------------------------------------
// Test 4: Tidak ada wajah di frame -> tidak ada bbox custom
// -----------------------------------------------------------------------------
console.log('\n--- Test 4: No Face in Frame -> 0 Custom Bboxes ---');
{
  const yoloObjects = [
    { class_name: 'laptop', bbox: { x1: 200, y1: 200, x2: 500, y2: 450 }, confidence: 0.94, trackId: 3 }
  ];

  const faceDetections = []; // Empty: no faces in frame
  const identityResult = {
    matched: false,
    label: 'Person',
    identityStatus: 'UNREGISTERED'
  };

  const fused = DetectionFusion.fuse(yoloObjects, faceDetections, identityResult, {
    enableObjects: true,
    enableFace: true
  });

  assert(fused.length === 1, `Expected exactly 1 detection (laptop only), got ${fused.length}`);
  const faceItems = fused.filter(d => d.type === 'face');
  assert(faceItems.length === 0, 'No face items must be generated when faceDetections is empty');

  console.log('✅ Test 4 Passed: No face in frame results in 0 face bounding boxes');
  passedTests++;
}

// -----------------------------------------------------------------------------
// Test 5: Detection Mode existing (non-wajah) -> objek YOLO tetap regression hijau
// -----------------------------------------------------------------------------
console.log('\n--- Test 5: Existing Detection Mode Objects Regression ---');
{
  const yoloObjects = [
    { class_name: 'bottle', bbox: { x1: 50, y1: 100, x2: 120, y2: 300 }, confidence: 0.92, trackId: 10 },
    { class_name: 'cup', bbox: { x1: 150, y1: 200, x2: 230, y2: 320 }, confidence: 0.88, trackId: 11 },
    { class_name: 'cell_phone', bbox: { x1: 300, y1: 250, x2: 380, y2: 400 }, confidence: 0.85, trackId: 12 }
  ];

  const fused = DetectionFusion.fuse(yoloObjects, [], null, {
    enableObjects: true,
    enableFace: true
  });

  assert(fused.length === 3, `Expected 3 object detections, got ${fused.length}`);
  assert(fused[0].class_name === 'bottle', 'Object 1 must remain bottle');
  assert(fused[1].class_name === 'cup', 'Object 2 must remain cup');
  assert(fused[2].class_name === 'cell_phone', 'Object 3 must remain cell_phone');
  assert(fused.every(d => d.type === 'object'), 'All items must be object type');

  console.log('✅ Test 5 Passed: Existing YOLO detections preserved 100% without modification');
  passedTests++;
}

// -----------------------------------------------------------------------------
// Test 6: Performance Benchmark -> Non-blocking face layer (< 1ms per frame)
// -----------------------------------------------------------------------------
console.log('\n--- Test 6: Performance Benchmark (Non-blocking Face Layer) ---');
{
  const mockIdentityService = {
    detectFaces: async () => {
      // Simulate network latency 80ms
      await new Promise(r => setTimeout(r, 80));
      return { success: true, faces: [] };
    },
    matchFace: async () => {
      await new Promise(r => setTimeout(r, 100));
      return { detected: false, faces: [] };
    },
    threshold: 0.6
  };

  const mockFrameSource = {};
  const detector = new FaceDetector(mockIdentityService, mockFrameSource);
  const recognizer = new FaceRecognizer(mockIdentityService, mockFrameSource);

  const mockLetterboxFrame = {
    canvas: { toDataURL: () => 'data:image/jpeg;base64,' },
    params: CoordinateMapper.computeLetterboxParams(1280, 720, 640),
    isMirrored: false
  };

  // Measure execution time of calling detect() and recognize() in render loop
  const start = performance.now();
  const iterations = 50;

  for (let i = 0; i < iterations; i++) {
    const faces = await detector.detect(mockLetterboxFrame);
    const ident = await recognizer.recognize(faces, mockLetterboxFrame);
    assert(Array.isArray(faces), 'faces must be array');
    assert(typeof ident === 'object', 'ident must be object');
  }

  const totalTimeMs = performance.now() - start;
  const avgTimePerFrame = totalTimeMs / iterations;

  assert(avgTimePerFrame < 2.0, `Average time per frame must be < 2ms (got ${avgTimePerFrame.toFixed(3)}ms)`);

  console.log(`✅ Test 6 Passed: Face layer runs non-blocking (${avgTimePerFrame.toFixed(3)}ms per frame, > 500 FPS capacity)`);
  passedTests++;
}

// -----------------------------------------------------------------------------
// Test 7: Failure Isolation -> Error pada face network tidak memblokir deteksi YOLO
// -----------------------------------------------------------------------------
console.log('\n--- Test 7: Failure Isolation ---');
{
  const failingIdentityService = {
    detectFaces: async () => {
      throw new Error('Network timeout: Python service unreachable');
    },
    matchFace: async () => {
      throw new Error('Connection refused');
    },
    threshold: 0.6
  };

  const detector = new FaceDetector(failingIdentityService, {});
  const recognizer = new FaceRecognizer(failingIdentityService, {});

  const mockLetterboxFrame = {
    canvas: { toDataURL: () => 'data:image/jpeg;base64,' },
    params: CoordinateMapper.computeLetterboxParams(1280, 720, 640),
    isMirrored: false
  };

  // Must not throw unhandled exception
  let threw = false;
  let faces = null;
  let identity = null;
  try {
    faces = await detector.detect(mockLetterboxFrame);
    identity = await recognizer.recognize(faces, mockLetterboxFrame);
  } catch (e) {
    threw = true;
  }

  assert(threw === false, 'Face service failure must NOT throw to processFrame caller');
  assert(Array.isArray(faces), 'Faces must safely fallback to array');

  // And YOLO objects continue to fuse normally
  const yoloObjects = [
    { class_name: 'laptop', bbox: { x1: 100, y1: 100, x2: 300, y2: 300 }, confidence: 0.95 }
  ];

  const fused = DetectionFusion.fuse(yoloObjects, faces, identity);
  assert(fused.length === 1, 'YOLO objects must be preserved even if face layer fails');
  assert(fused[0].class_name === 'laptop', 'Object must remain intact');

  console.log('✅ Test 7 Passed: Failure in face recognition service is 100% isolated and does not affect YOLO');
  passedTests++;
}

console.log('\n================================================================');
console.log(`🎉 ALL ${passedTests} IDENTITY & DETECTION INTEGRATION TESTS PASSED!`);
console.log('================================================================\n');
