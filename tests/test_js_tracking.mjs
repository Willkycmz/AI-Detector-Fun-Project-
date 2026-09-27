/**
 * test_js_tracking.mjs - JavaScript Unit & Regression Tests for VisionX V0.7 TrackingEngine
 *
 * Verifikasi 12 Skenario:
 * 1. Single object persistence
 * 2. Object movement & velocity
 * 3. Multiple objects tracking
 * 4. Same class multiple objects
 * 5. Different classes
 * 6. Temporary disappearance
 * 7. Track removal
 * 8. Track ID persistence
 * 9. Class-aware matching
 * 10. IoU matching
 * 11. Centroid distance
 * 12. Coordinate mapping compatibility
 */

import { TrackingEngine } from '../web/src/services/TrackingEngine.js';
import { CoordinateMapper } from '../web/src/services/CoordinateMapper.js';

function assert(cond, msg) {
  if (!cond) {
    throw new Error(`[FAIL] ${msg}`);
  }
}

console.log('--- Running JS TrackingEngine V0.7 Automated Tests ---');

// 1. Single object persistence
{
  const tracker = new TrackingEngine({ TRACK_MIN_HITS: 2, TRACK_IOU_THRESHOLD: 0.3 });
  const r1 = tracker.update([{ class_name: 'laptop', confidence: 0.94, bbox: { x1: 100, y1: 100, x2: 300, y2: 300 } }], 1);
  assert(r1.visibleTracks.length === 1, 'Test 1: 1 visible track');
  assert(r1.visibleTracks[0].state === 'tentative', 'Test 1: tentative state');
  const id = r1.visibleTracks[0].trackId;

  const r2 = tracker.update([{ class_name: 'laptop', confidence: 0.95, bbox: { x1: 102, y1: 101, x2: 302, y2: 301 } }], 2);
  assert(r2.visibleTracks.length === 1, 'Test 1: 1 visible track frame 2');
  assert(r2.visibleTracks[0].trackId === id, 'Test 1: Persistent Track ID');
  assert(r2.visibleTracks[0].state === 'confirmed', 'Test 1: Promoted to confirmed');
  console.log('✓ Test 1: Single object persistence');
}

// 2. Object movement & velocity
{
  const tracker = new TrackingEngine();
  tracker.update([{ class_name: 'laptop', confidence: 0.90, bbox: { x1: 100, y1: 100, x2: 300, y2: 300 } }], 1);
  const r2 = tracker.update([{ class_name: 'laptop', confidence: 0.92, bbox: { x1: 120, y1: 110, x2: 320, y2: 310 } }], 2);
  const t = r2.visibleTracks[0];
  assert(t.velocity.x === 20.0, 'Test 2: velocity X is 20');
  assert(t.velocity.y === 10.0, 'Test 2: velocity Y is 10');
  console.log('✓ Test 2: Object movement & velocity estimation');
}

// 3. Multiple objects tracking
{
  const tracker = new TrackingEngine();
  const dets = [
    { class_name: 'laptop', confidence: 0.94, bbox: { x1: 50, y1: 50, x2: 250, y2: 250 } },
    { class_name: 'mouse', confidence: 0.88, bbox: { x1: 300, y1: 300, x2: 400, y2: 400 } },
    { class_name: 'bottle', confidence: 0.85, bbox: { x1: 500, y1: 100, x2: 600, y2: 350 } }
  ];
  const r = tracker.update(dets, 1);
  assert(r.visibleTracks.length === 3, 'Test 3: 3 visible tracks');
  const ids = new Set(r.visibleTracks.map(t => t.trackId));
  assert(ids.size === 3, 'Test 3: 3 unique track IDs');
  console.log('✓ Test 3: Multiple objects tracking');
}

// 4. Same class multiple objects
{
  const tracker = new TrackingEngine();
  const r1 = tracker.update([
    { class_name: 'laptop', confidence: 0.90, bbox: { x1: 50, y1: 50, x2: 200, y2: 200 } },
    { class_name: 'laptop', confidence: 0.91, bbox: { x1: 400, y1: 50, x2: 550, y2: 200 } }
  ], 1);
  const idA = r1.visibleTracks[0].trackId;
  const idB = r1.visibleTracks[1].trackId;

  const r2 = tracker.update([
    { class_name: 'laptop', confidence: 0.90, bbox: { x1: 55, y1: 52, x2: 205, y2: 202 } },
    { class_name: 'laptop', confidence: 0.91, bbox: { x1: 405, y1: 52, x2: 555, y2: 202 } }
  ], 2);
  const leftT = r2.visibleTracks.find(t => t.bbox.x1 < 300);
  const rightT = r2.visibleTracks.find(t => t.bbox.x1 > 300);
  assert(leftT.trackId === idA, 'Test 4: Left laptop retains ID');
  assert(rightT.trackId === idB, 'Test 4: Right laptop retains ID');
  console.log('✓ Test 4: Same class multiple objects');
}

// 5. Different classes
{
  const tracker = new TrackingEngine();
  const r1 = tracker.update([{ class_name: 'laptop', confidence: 0.92, bbox: { x1: 100, y1: 100, x2: 250, y2: 250 } }], 1);
  const laptopId = r1.visibleTracks[0].trackId;

  const r2 = tracker.update([{ class_name: 'mouse', confidence: 0.89, bbox: { x1: 100, y1: 100, x2: 250, y2: 250 } }], 2);
  assert(r2.visibleTracks[0].trackId !== laptopId, 'Test 5: Mouse does NOT get Laptop track ID');
  console.log('✓ Test 5: Different classes gating');
}

// 6. Temporary disappearance
{
  const tracker = new TrackingEngine({ TRACK_MIN_HITS: 1, TRACK_MAX_MISSED_FRAMES: 5 });
  tracker.update([{ class_name: 'laptop', confidence: 0.90, bbox: { x1: 100, y1: 100, x2: 200, y2: 200 } }], 1);
  const r2 = tracker.update([], 2);
  assert(r2.visibleTracks.length === 0, 'Test 6: No visible track when missing');
  assert(r2.activeTracks[0].state === 'lost', 'Test 6: State transitions to lost');

  const r3 = tracker.update([{ class_name: 'laptop', confidence: 0.92, bbox: { x1: 105, y1: 102, x2: 205, y2: 202 } }], 3);
  assert(r3.visibleTracks.length === 1, 'Test 6: Recovered track is visible');
  assert(r3.visibleTracks[0].trackId === 1, 'Test 6: Retained Track #01');
  assert(r3.visibleTracks[0].state === 'confirmed', 'Test 6: State recovered to confirmed');
  console.log('✓ Test 6: Temporary disappearance recovery');
}

// 7. Track removal
{
  const tracker = new TrackingEngine({ TRACK_MAX_MISSED_FRAMES: 3 });
  tracker.update([{ class_name: 'bottle', confidence: 0.88, bbox: { x1: 10, y1: 10, x2: 50, y2: 150 } }], 1);
  tracker.update([], 2);
  tracker.update([], 3);
  tracker.update([], 4);
  const r5 = tracker.update([], 5);
  assert(r5.activeTracks.length === 0, 'Test 7: Track removed after exceeding max missed frames');
  console.log('✓ Test 7: Track removal');
}

// 8. Track ID persistence
{
  const tracker = new TrackingEngine({ TRACK_MAX_MISSED_FRAMES: 1 });
  tracker.update([{ class_name: 'bottle', confidence: 0.8, bbox: { x1: 10, y1: 10, x2: 50, y2: 150 } }], 1);
  tracker.update([], 2);
  tracker.update([], 3); // removed

  const r4 = tracker.update([{ class_name: 'cup', confidence: 0.85, bbox: { x1: 100, y1: 100, x2: 200, y2: 200 } }], 4);
  assert(r4.visibleTracks[0].trackId === 2, 'Test 8: Next track allocated ID #02, no reuse');
  console.log('✓ Test 8: Track ID persistence');
}

// 9. Class-aware matching
{
  const tracker = new TrackingEngine();
  tracker.update([{ class_name: 'person', confidence: 0.95, bbox: { x1: 100, y1: 100, x2: 200, y2: 300 } }], 1);
  const r2 = tracker.update([{ class_name: 'laptop', confidence: 0.90, bbox: { x1: 100, y1: 100, x2: 200, y2: 300 } }], 2);
  assert(r2.visibleTracks.length === 1 && r2.visibleTracks[0].className === 'laptop', 'Test 9: Class-aware split');
  assert(r2.visibleTracks[0].trackId === 2, 'Test 9: New class gets new track ID');
  console.log('✓ Test 9: Class-aware matching');
}

// 10. IoU matching
{
  const iou = TrackingEngine.computeIoU({ x1: 0, y1: 0, x2: 100, y2: 100 }, { x1: 50, y1: 0, x2: 150, y2: 100 });
  assert(Math.abs(iou - 0.333) < 0.01, 'Test 10: IoU calculation');
  const tracker = new TrackingEngine({ TRACK_IOU_THRESHOLD: 0.40, TRACK_DISTANCE_FALLBACK: false });
  tracker.update([{ class_name: 'laptop', confidence: 0.9, bbox: { x1: 0, y1: 0, x2: 100, y2: 100 } }], 1);
  const r2 = tracker.update([{ class_name: 'laptop', confidence: 0.9, bbox: { x1: 50, y1: 0, x2: 150, y2: 100 } }], 2);
  assert(r2.visibleTracks[0].trackId === 2, 'Test 10: IoU threshold rejection');
  console.log('✓ Test 10: IoU matching threshold');
}

// 11. Centroid distance
{
  const dist = TrackingEngine.computeCentroidDistance({ x: 50, y: 50 }, { x: 120, y: 50 });
  assert(dist === 70, 'Test 11: Distance calculation');
  const tracker = new TrackingEngine({
    TRACK_IOU_THRESHOLD: 0.80,
    TRACK_MAX_DISTANCE: 100.0,
    TRACK_DISTANCE_FALLBACK: true
  });
  tracker.update([{ class_name: 'mouse', confidence: 0.85, bbox: { x1: 20, y1: 20, x2: 80, y2: 80 } }], 1);
  const r2 = tracker.update([{ class_name: 'mouse', confidence: 0.86, bbox: { x1: 60, y1: 20, x2: 120, y2: 80 } }], 2);
  assert(r2.visibleTracks[0].trackId === 1, 'Test 11: Centroid distance fallback match');
  console.log('✓ Test 11: Centroid distance matching');
}

// 12. Coordinate mapping compatibility
{
  const tracker = new TrackingEngine();
  const box1 = { x1: 320.5, y1: 180.2, x2: 850.8, y2: 650.0 };
  const box2 = { x1: 325.0, y1: 182.0, x2: 855.0, y2: 652.0 };
  tracker.update([{ class_name: 'laptop', confidence: 0.94, bbox: box1 }], 1);
  const r2 = tracker.update([{ class_name: 'laptop', confidence: 0.95, bbox: box2 }], 2);
  assert(r2.visibleTracks[0].trackId === 1, 'Test 12: Float coordinate tracking');
  assert(r2.stats.trackingStatus === 'ACTIVE', 'Test 12: Status is ACTIVE');
  assert(r2.stats.perClass.laptop === 1, 'Test 12: Counting laptop is 1');
  console.log('✓ Test 12: Coordinate mapping compatibility');
}

console.log('--- ALL 12 JS TRACKING TESTS PASSED SUCCESSFULLY! ---');
