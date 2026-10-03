/**
 * test_js_group_a_cross_nms.mjs
 *
 * Automated Test Suite for Group A:
 * 1. Cross-Class NMS verification (suppresses lower-confidence overlapping boxes across different classes)
 * 2. Same-Class NMS verification (preserves standard IoU 0.45 suppression)
 * 3. Multi-object preservation (different classes with IoU < 0.50 are preserved)
 * 4. Default threshold verification (confThreshold = 0.30, crossClassIouThreshold = 0.50)
 */

if (typeof document === 'undefined') {
  global.document = {
    createElement: () => ({
      getContext: () => ({
        fillRect: () => {},
        drawImage: () => {},
        getImageData: () => ({ data: new Uint8ClampedArray(640 * 640 * 4) })
      })
    })
  };
}

import { applyNMS, YOLOInferenceService } from '../web/src/services/InferenceService.js';

function assert(condition, message) {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${message}`);
    throw new Error(message);
  }
}

console.log('================================================================');
console.log('🧪 Running VisionX Group A: Cross-Class NMS & Threshold Tests');
console.log('================================================================\n');

let passedTests = 0;

// Test 1: Cross-class duplicate box elimination
console.log('• Testing: Cross-class duplicate suppression (IoU > 0.50)...');
{
  const candidates = [
    { class_id: 6, class_name: 'cell_phone', confidence: 0.75, x1: 100, y1: 100, x2: 200, y2: 300 },
    { class_id: 3, class_name: 'laptop', confidence: 0.60, x1: 102, y1: 98, x2: 204, y2: 302 }
  ];
  const result = applyNMS(candidates, 0.45, 0.50);
  assert(result.length === 1, `Expected 1 detection, got ${result.length}`);
  assert(result[0].class_name === 'cell_phone', `Expected cell_phone to win, got ${result[0].class_name}`);
  assert(result[0].confidence === 0.75, `Expected winning conf 0.75, got ${result[0].confidence}`);
  console.log('  ✅ PASSED: cell_phone (0.75) suppressed overlapping laptop (0.60)');
  passedTests++;
}

// Test 2: Multi-object preservation (different classes with low/no overlap)
console.log('• Testing: Multi-object preservation (IoU < 0.50 preserved)...');
{
  const candidates = [
    { class_id: 0, class_name: 'person', confidence: 0.90, x1: 50, y1: 50, x2: 400, y2: 600 },
    { class_id: 6, class_name: 'cell_phone', confidence: 0.70, x1: 200, y1: 300, x2: 260, y2: 400 } // phone held by person, small IoU
  ];
  const result = applyNMS(candidates, 0.45, 0.50);
  assert(result.length === 2, `Expected 2 detections, got ${result.length}`);
  assert(result.some(d => d.class_name === 'person'), 'Expected person to be preserved');
  assert(result.some(d => d.class_name === 'cell_phone'), 'Expected cell_phone to be preserved');
  console.log('  ✅ PASSED: Person and Phone both preserved');
  passedTests++;
}

// Test 3: Same-class NMS suppression
console.log('• Testing: Same-class NMS suppression (IoU > 0.45)...');
{
  const candidates = [
    { class_id: 1, class_name: 'bottle', confidence: 0.88, x1: 100, y1: 100, x2: 150, y2: 250 },
    { class_id: 1, class_name: 'bottle', confidence: 0.55, x1: 105, y1: 102, x2: 148, y2: 248 }
  ];
  const result = applyNMS(candidates, 0.45, 0.50);
  assert(result.length === 1, `Expected 1 detection, got ${result.length}`);
  assert(result[0].confidence === 0.88, `Expected conf 0.88, got ${result[0].confidence}`);
  console.log('  ✅ PASSED: Lower-confidence bottle suppressed');
  passedTests++;
}

// Test 4: Default Service Parameters
console.log('• Testing: YOLOInferenceService default parameters...');
{
  const service = new YOLOInferenceService('visionx_v2');
  assert(service.confThreshold === 0.30, `Expected default confThreshold 0.30, got ${service.confThreshold}`);
  assert(service.iouThreshold === 0.45, `Expected default iouThreshold 0.45, got ${service.iouThreshold}`);
  assert(service.crossClassIouThreshold === 0.50, `Expected crossClassIouThreshold 0.50, got ${service.crossClassIouThreshold}`);
  console.log('  ✅ PASSED: Default confThreshold=0.30, iouThreshold=0.45, crossClassIouThreshold=0.50');
  passedTests++;
}

console.log('\n================================================================');
console.log(`🏁 All ${passedTests} Group A Tests PASSED!`);
console.log('================================================================\n');
