/**
 * JavaScript Unit & Regression Test for VisionX V0.6.2 Unified Vision Engine
 */

import { CoordinateMapper } from '../web/src/services/CoordinateMapper.js';
import { DetectionFusion } from '../web/src/services/DetectionFusion.js';

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

console.log('--- Running JS Unified Vision Engine Unit Tests ---');

// 1. CoordinateMapper 16:9 Letterbox
const p16_9 = CoordinateMapper.computeLetterboxParams(1280, 720, 640);
assert(p16_9.scale === 0.5, '16:9 scale must be 0.5');
assert(p16_9.padX === 0, '16:9 padX must be 0');
assert(p16_9.padY === 140, '16:9 padY must be 140');
assert(p16_9.aspectLabel === '16:9', '16:9 aspectLabel');
console.log('✓ Test 1: 16:9 Letterbox params');

// 2. CoordinateMapper 4:3
const p4_3 = CoordinateMapper.computeLetterboxParams(640, 480, 640);
assert(p4_3.scale === 1.0, '4:3 scale must be 1.0');
assert(p4_3.padX === 0, '4:3 padX must be 0');
assert(p4_3.padY === 80, '4:3 padY must be 80');
assert(p4_3.aspectLabel === '4:3', '4:3 aspectLabel');
console.log('✓ Test 2: 4:3 Letterbox params');

// 3. CoordinateMapper 9:16 Portrait
const pPortrait = CoordinateMapper.computeLetterboxParams(720, 1280, 640);
assert(pPortrait.scale === 0.5, '9:16 scale must be 0.5');
assert(pPortrait.padX === 140, '9:16 padX must be 140');
assert(pPortrait.padY === 0, '9:16 padY must be 0');
assert(pPortrait.aspectLabel.includes('Portrait'), '9:16 aspectLabel');
console.log('✓ Test 3: 9:16 Portrait params');

// 4. ModelToVideo & VideoToModel Roundtrip
const origBox = { x1: 200, y1: 100, x2: 600, y2: 500 };
const modelBox = CoordinateMapper.videoToModel(origBox, p16_9);
const restoredBox = CoordinateMapper.modelToVideo(modelBox, p16_9);
assert(Math.abs(restoredBox.x1 - origBox.x1) <= 2, 'Roundtrip X1');
assert(Math.abs(restoredBox.y1 - origBox.y1) <= 2, 'Roundtrip Y1');
assert(Math.abs(restoredBox.x2 - origBox.x2) <= 2, 'Roundtrip X2');
assert(Math.abs(restoredBox.y2 - origBox.y2) <= 2, 'Roundtrip Y2');
console.log('✓ Test 4: Model <-> Video roundtrip');

// 5. Mirrored Front Camera
const unmirrored = CoordinateMapper.modelToVideo({ x1: 50, y1: 50, x2: 150, y2: 150 }, p16_9, false);
const mirrored = CoordinateMapper.modelToVideo({ x1: 50, y1: 50, x2: 150, y2: 150 }, p16_9, true);
assert(mirrored.x1 === 1280 - unmirrored.x2, 'Mirrored X1 must be 1280 - unmirrored.x2');
assert(mirrored.x2 === 1280 - unmirrored.x1, 'Mirrored X2 must be 1280 - unmirrored.x1');
assert(mirrored.width === unmirrored.width, 'Mirrored width preserved');
console.log('✓ Test 5: Mirrored front camera transform');

// 6. DetectionFusion: Objects + Developer Face
const objects = [
  { class_name: 'laptop', confidence: 0.94, bbox: { x1: 100, y1: 200, x2: 500, y2: 500 } },
  { class_name: 'mouse', confidence: 0.88, bbox: { x1: 520, y1: 400, x2: 620, y2: 480 } }
];
const faces = [
  { bbox: { x1: 600, y1: 100, x2: 800, y2: 350 }, confidence: 0.91 }
];
const devIdentity = {
  matched: true,
  label: 'VISIONX DEVELOPER 91%',
  similarity: 0.91,
  score_percent: '91%',
  identityStatus: 'REGISTERED'
};

const fused = DetectionFusion.fuse(objects, faces, devIdentity);
assert(fused.length === 3, 'Fused count must be 3');
assert(fused[0].type === 'object', 'Item 0 type is object');
assert(fused[0].label === 'Laptop 94%', 'Laptop label');
assert(fused[1].label === 'Mouse 88%', 'Mouse label');
assert(fused[2].type === 'face', 'Item 2 type is face');
assert(fused[2].label === 'VISIONX DEVELOPER 91%', 'Dev face label');
assert(fused[2].identityStatus === 'REGISTERED', 'Dev face identityStatus');
console.log('✓ Test 6: Objects + Developer Face fusion');

// 7. DetectionFusion: Unknown Face
const unknownIdentity = {
  matched: false,
  label: 'PERSON • UNKNOWN',
  similarity: 0.40,
  score_percent: '40%',
  identityStatus: 'UNREGISTERED'
};
const fusedUnknown = DetectionFusion.fuse(objects, faces, unknownIdentity);
assert(fusedUnknown[2].type === 'face', 'Unknown face type');
assert(fusedUnknown[2].label === 'PERSON • UNKNOWN', 'Unknown face label');
assert(fusedUnknown[2].identityStatus === 'UNREGISTERED', 'Unknown face identityStatus');
console.log('✓ Test 7: Unknown Face fusion');

// 8. Toggle Face Recognition Off
const fusedToggleOff = DetectionFusion.fuse(objects, faces, devIdentity, { enableFace: false, enableObjects: true });
assert(fusedToggleOff.length === 2, 'Toggle off only returns objects');
assert(fusedToggleOff.every(it => it.type === 'object'), 'All items are objects when face disabled');
console.log('✓ Test 8: Toggle face recognition off');

// 9. Independent Failure Isolation (YOLO disabled / fails)
const fusedYoloOff = DetectionFusion.fuse([], faces, devIdentity, { enableFace: true, enableObjects: false });
assert(fusedYoloOff.length === 1, 'Face continues working when YOLO fails/disabled');
assert(fusedYoloOff[0].type === 'face', 'Face detection preserved');
console.log('✓ Test 9: Independent failure isolation');

// 10. Transform Status Formatting
const statusStr = CoordinateMapper.getTransformStatus({ width: 1280, height: 720 }, true);
assert(statusStr.includes('16:9'), 'Status includes 16:9');
assert(statusStr.includes('Mirrored: Active'), 'Status includes mirrored');
console.log('✓ Test 10: Transform status formatting');

console.log('--- ALL 10 JS TESTS PASSED SUCCESSFULLY! ---');
