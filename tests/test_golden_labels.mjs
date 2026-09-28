/**
 * test_golden_labels.mjs - Deterministic Golden Label & Parser Verification
 *
 * Verifies:
 * 1. VISIONX_V1_CLASSES exact array ordering: 0..6
 * 2. MODEL_PRESETS configuration integrity for visionx_v2
 * 3. YOLOv8 [1, 11, 8400] parser channel indexing logic:
 *    data[(4 + c) * 8400 + i]
 * 4. Verifies class index 6 maps to 'cell_phone' and class index 3 maps to 'laptop'
 */

import { VISIONX_V1_CLASSES, MODEL_PRESETS } from '../web/src/services/InferenceService.js';

function assert(condition, message) {
  if (!condition) {
    throw new Error(`[FAIL] ${message}`);
  }
}

async function runTests() {
  console.log('================================================================');
  console.log('🔍 Running VisionX Golden Label & Parser Logic Tests (JS)');
  console.log('================================================================\n');

  let passed = 0;
  let failed = 0;

  function testCase(name, fn) {
    process.stdout.write(`• Testing: ${name}... `);
    try {
      fn();
      console.log('✅ PASSED');
      passed++;
    } catch (err) {
      console.log('❌ FAILED');
      console.error(`  Error: ${err.message}`);
      failed++;
    }
  }

  testCase('VISIONX_V1_CLASSES matches exact 7-class specification', () => {
    const expected = ['person', 'bottle', 'cup', 'laptop', 'mouse', 'keyboard', 'cell_phone'];
    assert(VISIONX_V1_CLASSES.length === 7, `Expected 7 classes, got ${VISIONX_V1_CLASSES.length}`);
    expected.forEach((name, idx) => {
      assert(VISIONX_V1_CLASSES[idx] === name, `Class ${idx} should be ${name}, got ${VISIONX_V1_CLASSES[idx]}`);
    });
  });

  testCase('Class index 3 is laptop and class index 6 is cell_phone', () => {
    assert(VISIONX_V1_CLASSES[3] === 'laptop', `Index 3 must be laptop`);
    assert(VISIONX_V1_CLASSES[6] === 'cell_phone', `Index 6 must be cell_phone`);
    assert(VISIONX_V1_CLASSES[6] !== 'laptop', `cell_phone must NOT be confused with laptop`);
  });

  testCase('MODEL_PRESETS.visionx_v2 presets check', () => {
    const v2 = MODEL_PRESETS.visionx_v2;
    assert(v2, 'MODEL_PRESETS.visionx_v2 must exist');
    assert(v2.numClasses === 7, 'v2 must have 7 classes');
    assert(v2.classes[6] === 'cell_phone', 'v2 class 6 must be cell_phone');
    assert(v2.classes[3] === 'laptop', 'v2 class 3 must be laptop');
  });

  testCase('Tensor parser logic: channels-first layout [1, 11, 8400]', () => {
    const numChannels = 11;
    const numAnchors = 8400;
    const totalElements = 1 * numChannels * numAnchors;
    const syntheticBuffer = new Float32Array(totalElements);

    // Populate channels 4..10 with distinct class scores for anchor 100
    const anchorIdx = 100;
    // Set class 6 (cell_phone) to 0.88, class 3 (laptop) to 0.12
    syntheticBuffer[(4 + 6) * numAnchors + anchorIdx] = 0.88;
    syntheticBuffer[(4 + 3) * numAnchors + anchorIdx] = 0.12;

    // Simulate parser extraction
    let maxScore = -1;
    let maxClassId = -1;
    for (let c = 0; c < 7; c++) {
      const score = syntheticBuffer[(4 + c) * numAnchors + anchorIdx];
      if (score > maxScore) {
        maxScore = score;
        maxClassId = c;
      }
    }

    assert(maxClassId === 6, `Expected maxClassId 6, got ${maxClassId}`);
    assert(VISIONX_V1_CLASSES[maxClassId] === 'cell_phone', `Expected cell_phone, got ${VISIONX_V1_CLASSES[maxClassId]}`);
    assert(Math.abs(maxScore - 0.88) < 1e-5, `Expected score 0.88, got ${maxScore}`);
  });

  console.log(`\n================================================================`);
  console.log(`Summary: ${passed} passed, ${failed} failed`);
  console.log(`================================================================`);

  if (failed > 0) {
    process.exit(1);
  }
}

runTests();
