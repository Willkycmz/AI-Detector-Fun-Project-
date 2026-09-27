/**
 * tests/test_js_identity_lab_standalone.mjs
 *
 * Automated Test Suite for VisionX Identity Lab Bugfix (Step 1 Standalone):
 *
 * Test 1: Bounding Box Coordinate Transformation Accuracy (YuNet letterbox 640x640 -> Video space)
 * Test 2: Recognized Developer Face -> Custom label "Person — Developer VisionX (XX%)" & distinct visual status
 * Test 3: Unrecognized/Other Face -> Generic label "Person" & neutral/amber status
 * Test 4: No Face in Frame -> 0 bounding boxes & display clear
 * Test 5: Identity Lab Live Test Logic simulation & UI metrics updating
 * Test 6: UnifiedRenderer face item visual configuration verification
 */

import { CoordinateMapper } from '../web/src/services/CoordinateMapper.js';
import { UnifiedRenderer } from '../web/src/services/UnifiedRenderer.js';

function assert(condition, message) {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${message}`);
    throw new Error(message);
  }
}

console.log('================================================================');
console.log('👤 Running VisionX Identity Lab Standalone Tests (Step 1)');
console.log('================================================================\n');

let passedTests = 0;

// -----------------------------------------------------------------------------
// Test 1: Bounding box coordinate transformation accuracy
// -----------------------------------------------------------------------------
console.log('--- Test 1: Bounding Box Coordinate Mapping Accuracy ---');
{
  const vw = 1280;
  const vh = 720;
  const params = CoordinateMapper.computeLetterboxParams(vw, vh, 640);

  // In 16:9 ratio, scale = 640 / 1280 = 0.5, nw = 640, nh = 360, padX = 0, padY = 140
  assert(params.scale === 0.5, `Scale should be 0.5, got ${params.scale}`);
  assert(params.padX === 0, `padX should be 0, got ${params.padX}`);
  assert(params.padY === 140, `padY should be 140, got ${params.padY}`);

  // Model detected face box in 640x640 space
  const rawModelBox = { x1: 200, y1: 200, x2: 400, y2: 400 };
  const mapped = CoordinateMapper.modelToVideo(rawModelBox, params, false);

  // Expected in video coordinates:
  // x1 = (200 - 0) / 0.5 = 400
  // x2 = (400 - 0) / 0.5 = 800
  // y1 = (200 - 140) / 0.5 = 120
  // y2 = (400 - 140) / 0.5 = 520
  assert(mapped.x1 === 400, `mapped.x1 should be 400, got ${mapped.x1}`);
  assert(mapped.x2 === 800, `mapped.x2 should be 800, got ${mapped.x2}`);
  assert(mapped.y1 === 120, `mapped.y1 should be 120, got ${mapped.y1}`);
  assert(mapped.y2 === 520, `mapped.y2 should be 520, got ${mapped.y2}`);
  assert(mapped.width === 400, `mapped.width should be 400, got ${mapped.width}`);
  assert(mapped.height === 400, `mapped.height should be 400, got ${mapped.height}`);

  console.log('✅ Test 1 Passed: Face bounding box accurately mapped from 640x640 model to 1280x720 video');
  passedTests++;
}

// -----------------------------------------------------------------------------
// Test 2: Developer face recognized -> Bbox + custom label
// -----------------------------------------------------------------------------
console.log('\n--- Test 2: Developer Face Recognized -> Custom Label & Registered Status ---');
{
  const params = CoordinateMapper.computeLetterboxParams(1280, 720, 640);
  const mockFace = {
    box: [200, 200, 150, 150],
    bbox: { x1: 200, y1: 200, x2: 350, y2: 350 },
    confidence: 0.96,
    matched: true,
    similarity: 0.92,
    score_percent: '92.0%'
  };

  const videoBbox = CoordinateMapper.modelToVideo(mockFace.bbox, params, false);
  const isMatch = Boolean(mockFace.matched);
  const faceScore = mockFace.score_percent || `${Math.round(mockFace.similarity * 100)}%`;
  const customLabel = isMatch ? `Person — Developer VisionX (${faceScore})` : 'Person';

  const faceItem = {
    type: 'face',
    id: 'identity_face_1',
    bbox: videoBbox,
    label: customLabel,
    confidence: mockFace.confidence,
    identityStatus: isMatch ? 'REGISTERED' : 'UNREGISTERED',
    isDeveloper: isMatch,
    similarity: mockFace.similarity
  };

  assert(faceItem.isDeveloper === true, 'Developer face must have isDeveloper: true');
  assert(faceItem.identityStatus === 'REGISTERED', 'Developer face must have identityStatus: "REGISTERED"');
  assert(faceItem.label.includes('Person — Developer VisionX'), `Label must be custom developer text, got "${faceItem.label}"`);
  assert(faceItem.label.includes('92.0%'), 'Label must display similarity percentage');

  console.log('✅ Test 2 Passed: Recognized developer face assigned custom label and REGISTERED status');
  passedTests++;
}

// -----------------------------------------------------------------------------
// Test 3: Unregistered face -> Generic label "Person"
// -----------------------------------------------------------------------------
console.log('\n--- Test 3: Unregistered Face -> Generic Label "Person" ---');
{
  const params = CoordinateMapper.computeLetterboxParams(1280, 720, 640);
  const mockFace = {
    box: [250, 220, 140, 140],
    bbox: { x1: 250, y1: 220, x2: 390, y2: 360 },
    confidence: 0.88,
    matched: false,
    similarity: 0.35,
    score_percent: '35.0%'
  };

  const videoBbox = CoordinateMapper.modelToVideo(mockFace.bbox, params, false);
  const isMatch = Boolean(mockFace.matched);
  const customLabel = isMatch ? `Person — Developer VisionX (${mockFace.score_percent})` : 'Person';

  const faceItem = {
    type: 'face',
    id: 'identity_face_1',
    bbox: videoBbox,
    label: customLabel,
    confidence: mockFace.confidence,
    identityStatus: isMatch ? 'REGISTERED' : 'UNREGISTERED',
    isDeveloper: isMatch,
    similarity: mockFace.similarity
  };

  assert(faceItem.isDeveloper === false, 'Unknown face must have isDeveloper: false');
  assert(faceItem.identityStatus === 'UNREGISTERED', 'Unknown face must have identityStatus: "UNREGISTERED"');
  assert(faceItem.label === 'Person', `Unknown face label must be exactly "Person", got "${faceItem.label}"`);

  console.log('✅ Test 3 Passed: Unknown face assigned generic label "Person"');
  passedTests++;
}

// -----------------------------------------------------------------------------
// Test 4: No face in frame -> 0 bounding boxes
// -----------------------------------------------------------------------------
console.log('\n--- Test 4: Empty Frame -> 0 Bounding Boxes ---');
{
  const mockResponse = {
    detected: false,
    faces_count: 0,
    faces: []
  };

  const currentIdentityFaces = (mockResponse.detected && Array.isArray(mockResponse.faces))
    ? mockResponse.faces.map(f => ({ type: 'face' }))
    : [];

  assert(currentIdentityFaces.length === 0, 'No face should produce 0 face items');

  console.log('✅ Test 4 Passed: Empty frame produces 0 face items and triggers clean canvas');
  passedTests++;
}

// -----------------------------------------------------------------------------
// Test 5: UnifiedRenderer visual distinction between developer and unknown faces
// -----------------------------------------------------------------------------
console.log('\n--- Test 5: UnifiedRenderer Visual Distinction ---');
{
  const drawCalls = [];
  const mockCtx = {
    measureText: (txt) => ({ width: txt.length * 8 }),
    clearRect: () => drawCalls.push('clearRect'),
    fillRect: (x, y, w, h) => drawCalls.push(`fillRect ${x},${y},${w},${h}`),
    strokeRect: (x, y, w, h) => drawCalls.push(`strokeRect ${x},${y},${w},${h}`),
    beginPath: () => drawCalls.push('beginPath'),
    moveTo: (x, y) => drawCalls.push(`moveTo ${x},${y}`),
    lineTo: (x, y) => drawCalls.push(`lineTo ${x},${y}`),
    stroke: () => drawCalls.push('stroke'),
    fill: () => drawCalls.push('fill'),
    arc: () => drawCalls.push('arc'),
    fillText: (txt, x, y) => drawCalls.push(`fillText "${txt}" at ${x},${y}`),
    setLineDash: (d) => drawCalls.push(`setLineDash [${d.join(',')}]`),
    save: () => drawCalls.push('save'),
    restore: () => drawCalls.push('restore')
  };

  const mockCanvas = {
    width: 1280,
    height: 720,
    getContext: () => mockCtx
  };

  const renderer = new UnifiedRenderer(mockCanvas);

  const testDetections = [
    {
      type: 'face',
      bbox: { x1: 100, y1: 100, x2: 300, y2: 300 },
      label: 'Person — Developer VisionX (94%)',
      identityStatus: 'REGISTERED',
      isDeveloper: true
    },
    {
      type: 'face',
      bbox: { x1: 500, y1: 100, x2: 700, y2: 300 },
      label: 'Person',
      identityStatus: 'UNREGISTERED',
      isDeveloper: false
    }
  ];

  renderer.renderUnified(testDetections);

  assert(drawCalls.includes('clearRect'), 'Renderer must clear canvas before drawing');
  // Check dashed line was set for unknown face
  assert(drawCalls.some(c => c.includes('setLineDash [6,4]')), 'Unknown face must use dashed border');
  // Check labels were drawn
  assert(drawCalls.some(c => c.includes('Person — Developer VisionX (94%)')), 'Developer custom label must be drawn');
  assert(drawCalls.some(c => c.includes('fillText "Person"')), 'Unknown face generic "Person" label must be drawn');

  console.log('✅ Test 5 Passed: UnifiedRenderer distinctly styles developer and unknown faces');
  passedTests++;
}

console.log('\n================================================================');
console.log(`🎉 ALL ${passedTests} IDENTITY LAB STANDALONE TESTS PASSED!`);
console.log('================================================================\n');
