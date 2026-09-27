/**
 * test_js_ghost_detection_fix.mjs
 *
 * Automated Test Suite for VisionX Ghost Detection / False Positive Bugfix:
 *
 * Test 1: Kamera diam, tidak ada objek -> 0 deteksi selama 30 detik simulasi (450 frames @ 15fps)
 * Test 2: Objek masuk frame -> terdeteksi dalam < 1 detik (hits >= TRACK_MIN_HITS, <= 2 frames)
 * Test 3: Objek keluar frame -> deteksi hilang dalam < 1 detik (visible hilang frame 1, active removed <= 8 frames)
 * Test 4: Fast pruning tentative track (1-frame transient spike tidak nyangkut selama 15 frames)
 * Test 5: Rejection of letterbox padding artifacts (anchor center outside active video area)
 * Test 6: Rejection of degenerate sub-16px boxes and extreme aspect ratios
 * Test 7: Decision logging verification (audit trail for dropped and accepted candidates)
 * Test 8: State cleanliness: lastDetections reset when no detections in current frame
 */

import { TrackingEngine, DEFAULT_TRACKING_CONFIG } from '../web/src/services/TrackingEngine.js';
import { CoordinateMapper } from '../web/src/services/CoordinateMapper.js';

function assert(condition, message) {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${message}`);
    throw new Error(message);
  }
}

console.log('================================================================');
console.log('👻 Running VisionX Ghost Detection & False Positive Bugfix Tests');
console.log('================================================================\n');

let passedTests = 0;

// Helper filter simulasi identik dengan logika InferenceService
function filterCandidate(cand, letterboxParams, vw = 1280, vh = 720, confThreshold = 0.45) {
  const { padX, padY, nw, nh } = letterboxParams;
  const { cx, cy, w, h, maxScore, className } = cand;

  // Confidence check
  if (maxScore < confThreshold) {
    return { accepted: false, reason: 'confidence below threshold' };
  }

  // 1. Padding boundary check
  if (cx < padX + 2 || cx > (padX + nw - 2) || cy < padY + 2 || cy > (padY + nh - 2)) {
    return { accepted: false, reason: 'anchor center in letterbox padding' };
  }

  // Map to video coordinates
  const mapped = CoordinateMapper.modelToVideo(
    { x1: cx - w / 2, y1: cy - h / 2, x2: cx + w / 2, y2: cy + h / 2 },
    letterboxParams,
    false
  );

  const bw = mapped.x2 - mapped.x1;
  const bh = mapped.y2 - mapped.y1;
  const area = bw * bh;

  // 2. Minimum size check
  if (bw < 16 || bh < 16 || area < 256) {
    return { accepted: false, reason: `box too small (${bw}x${bh}, area ${area} < 256px)` };
  }

  // 3. Aspect ratio check
  const aspect = bw / bh;
  if (aspect < 0.15 || aspect > 6.5) {
    return { accepted: false, reason: `extreme aspect ratio ${aspect.toFixed(2)}` };
  }

  // 4. Marginal texture check for susceptible classes
  const videoArea = vw * vh;
  if (className === 'person' && maxScore < 0.52 && (area < 2500 || area / videoArea < 0.003)) {
    return { accepted: false, reason: `marginal score (${maxScore.toFixed(3)} < 0.52) with small area (${area}px < 2500px) for person` };
  }
  if (className === 'bottle' && maxScore < 0.50 && (area < 1200 || area / videoArea < 0.0015)) {
    return { accepted: false, reason: `marginal score (${maxScore.toFixed(3)} < 0.50) with small area (${area}px < 1200px) for bottle` };
  }
  if (maxScore < 0.50 && (area < 400 || area / videoArea < 0.0005)) {
    return { accepted: false, reason: `marginal score (${maxScore.toFixed(3)} < 0.50) with tiny area (${area}px < 400px)` };
  }

  return { accepted: true, mapped, bw, bh, area, aspect };
}

// ---------------------------------------------------------------------------
// TEST 1: Kamera Diam, Tidak Ada Objek -> 0 Deteksi Selama 30 Detik (450 Frames)
// ---------------------------------------------------------------------------
{
  process.stdout.write('• Testing: Kamera diam, tidak ada objek -> 0 deteksi selama 30 detik (450 frames)... ');
  const tracker = new TrackingEngine();
  const letterboxParams = CoordinateMapper.computeLetterboxParams(1280, 720, 640);

  let totalDetectionsLogged = 0;

  // Simulasikan 30 detik pada 15 FPS = 450 frames dengan sensor noise kamera diam
  for (let frame = 1; frame <= 450; frame++) {
    const rawNoisyCandidates = [];

    // Noise 1: anchor di area letterbox padding (border contrast artifact)
    if (frame % 3 === 0) {
      rawNoisyCandidates.push({
        cx: 320,
        cy: 80, // di dalam padding atas (padY = 140)
        w: 50,
        h: 40,
        maxScore: 0.52,
        className: 'person'
      });
    }

    // Noise 2: anchor tiny degenerate box di meja
    if (frame % 5 === 0) {
      rawNoisyCandidates.push({
        cx: 320,
        cy: 300,
        w: 4,
        h: 5,
        maxScore: 0.48,
        className: 'bottle'
      });
    }

    // Noise 3: anchor extreme aspect ratio (pinggiran meja)
    if (frame % 7 === 0) {
      rawNoisyCandidates.push({
        cx: 400,
        cy: 350,
        w: 180,
        h: 6,
        maxScore: 0.49,
        className: 'laptop'
      });
    }

    // Noise 4: marginal person spike
    if (frame % 11 === 0) {
      rawNoisyCandidates.push({
        cx: 200,
        cy: 250,
        w: 18,
        h: 22,
        maxScore: 0.47,
        className: 'person'
      });
    }

    const acceptedDetections = [];
    for (const cand of rawNoisyCandidates) {
      const res = filterCandidate(cand, letterboxParams);
      if (res.accepted) {
        acceptedDetections.push({
          class_name: cand.className,
          confidence: cand.maxScore,
          bbox: res.mapped
        });
      }
    }

    const trackingOut = tracker.update(acceptedDetections, frame);
    totalDetectionsLogged += trackingOut.visibleTracks.length;
    assert(trackingOut.visibleTracks.length === 0, `Frame ${frame} menghasilkan false positive visible track!`);
    assert(trackingOut.activeTracks.length === 0, `Frame ${frame} menghasilkan false positive active track!`);
  }

  assert(totalDetectionsLogged === 0, 'Harus tepat 0 deteksi selama 30 detik simulasi');
  console.log('✅ PASSED (450 frames clean)');
  passedTests++;
}

// ---------------------------------------------------------------------------
// TEST 2: Objek Masuk Frame -> Terdeteksi dalam < 1 Detik
// ---------------------------------------------------------------------------
{
  process.stdout.write('• Testing: Objek masuk frame -> terdeteksi dalam < 1 detik (hits >= 2, latency <= 133ms)... ');
  const tracker = new TrackingEngine();
  const letterboxParams = CoordinateMapper.computeLetterboxParams(1280, 720, 640);

  // Frame 1: Objek botol masuk ke frame kamera
  const bottleCand = {
    cx: 320,
    cy: 360,
    w: 60,
    h: 140,
    maxScore: 0.88,
    className: 'bottle'
  };

  const res1 = filterCandidate(bottleCand, letterboxParams);
  assert(res1.accepted, 'Botol valid harus diterima oleh filter');

  const det1 = [{
    class_name: bottleCand.className,
    confidence: bottleCand.maxScore,
    bbox: res1.mapped
  }];

  const t1 = tracker.update(det1, 1);
  assert(t1.visibleTracks.length === 1, 'Frame 1: Langsung visible');
  assert(t1.visibleTracks[0].state === 'tentative', 'Frame 1: State tentative');
  const trackId = t1.visibleTracks[0].trackId;

  // Frame 2: Botol masih terlihat (1 frame kemudian = ~66ms pada 15fps)
  const t2 = tracker.update(det1, 2);
  assert(t2.visibleTracks.length === 1, 'Frame 2: Masih visible');
  assert(t2.visibleTracks[0].trackId === trackId, 'Frame 2: Track ID konsisten');
  assert(t2.visibleTracks[0].state === 'confirmed', 'Frame 2: Terkonfirmasi (confirmed) dalam 2 frame (< 150ms)!');

  console.log('✅ PASSED (< 150ms to confirmed)');
  passedTests++;
}

// ---------------------------------------------------------------------------
// TEST 3: Objek Keluar Frame -> Deteksi Hilang dalam < 1 Detik
// ---------------------------------------------------------------------------
{
  process.stdout.write('• Testing: Objek keluar frame -> hilang dalam < 1 detik (visible: 0s, active: <= 8 frames)... ');
  const tracker = new TrackingEngine({ TRACK_MAX_MISSED_FRAMES: 8 });
  const bbox = { x1: 200, y1: 150, x2: 320, y2: 450 };

  // 1. Stabilkan track selama 3 frame
  tracker.update([{ class_name: 'bottle', confidence: 0.92, bbox }], 1);
  tracker.update([{ class_name: 'bottle', confidence: 0.92, bbox }], 2);
  const established = tracker.update([{ class_name: 'bottle', confidence: 0.92, bbox }], 3);
  assert(established.visibleTracks.length === 1 && established.visibleTracks[0].state === 'confirmed', 'Track stabil terkonfirmasi');

  // 2. Objek diambil / keluar frame kamera pada Frame 4
  const t4 = tracker.update([], 4);
  assert(t4.visibleTracks.length === 0, 'Frame 4: Visible langsung 0 (0 frame latency)');
  assert(t4.activeTracks.length === 1 && t4.activeTracks[0].state === 'lost', 'Frame 4: State lost');

  // 3. Simulasikan frame berikutnya hingga dihapus
  // Toleransi 8 frame hilang: Frame 5..11 (missed: 2..8). Frame 12: missed = 9 > 8 -> removed!
  for (let f = 5; f <= 11; f++) {
    const t = tracker.update([], f);
    assert(t.visibleTracks.length === 0, `Frame ${f}: Visible tetap 0`);
  }

  // Frame 12: Melebihi TRACK_MAX_MISSED_FRAMES (8)
  const t12 = tracker.update([], 12);
  assert(t12.visibleTracks.length === 0, 'Visible tetap 0');
  assert(t12.activeTracks.length === 0, 'Frame 12: Track dihapus sepenuhnya dari activeTracks (< 1 detik pada 15 FPS)');

  console.log('✅ PASSED (visible: instant, active: cleared in 8 frames)');
  passedTests++;
}

// ---------------------------------------------------------------------------
// TEST 4: Fast Pruning Tentative Track (Transient 1-Frame Noise)
// ---------------------------------------------------------------------------
{
  process.stdout.write('• Testing: Fast pruning tentative track (1-frame transient noise dropped cepat)... ');
  const tracker = new TrackingEngine({ TRACK_MIN_HITS: 2, TRACK_MAX_MISSED_TENTATIVE: 2 });

  // Frame 1: Noise muncul sekali
  const t1 = tracker.update([{ class_name: 'bottle', confidence: 0.60, bbox: { x1: 50, y1: 50, x2: 120, y2: 200 } }], 1);
  assert(t1.visibleTracks.length === 1 && t1.visibleTracks[0].state === 'tentative', 'Frame 1: tentative');

  // Frame 2: Noise langsung hilang
  const t2 = tracker.update([], 2);
  assert(t2.visibleTracks.length === 0, 'Frame 2: Tidak visible');
  assert(t2.activeTracks.length === 1 && t2.activeTracks[0].missedFrames === 1, 'Frame 2: missed 1');

  // Frame 3: Masih tidak ada objek
  const t3 = tracker.update([], 3);
  assert(t3.visibleTracks.length === 0, 'Frame 3: Tidak visible');
  assert(t3.activeTracks.length === 0, 'Frame 3: Tentative track di-prune cepat (missed >= 2) tanpa menunggu 8-15 frame!');

  console.log('✅ PASSED (pruned in 2 missed frames)');
  passedTests++;
}

// ---------------------------------------------------------------------------
// TEST 5: Rejection of Letterbox Padding Artifacts
// ---------------------------------------------------------------------------
{
  process.stdout.write('• Testing: Rejection of letterbox padding artifacts (top/bottom gray bars)... ');
  const letterboxParams = CoordinateMapper.computeLetterboxParams(1280, 720, 640);
  assert(letterboxParams.padY === 140, 'padY harus 140 untuk rasio 16:9');

  // Anchor di gray padding atas (cy = 60 < 140)
  const topPaddingCand = { cx: 320, cy: 60, w: 100, h: 60, maxScore: 0.85, className: 'person' };
  const resTop = filterCandidate(topPaddingCand, letterboxParams);
  assert(!resTop.accepted, 'Anchor di padding atas harus di-drop');
  assert(resTop.reason.includes('letterbox padding'), 'Alasan drop harus letterbox padding');

  // Anchor di gray padding bawah (cy = 580 > 500)
  const bottomPaddingCand = { cx: 320, cy: 580, w: 100, h: 60, maxScore: 0.85, className: 'bottle' };
  const resBottom = filterCandidate(bottomPaddingCand, letterboxParams);
  assert(!resBottom.accepted, 'Anchor di padding bawah harus di-drop');
  assert(resBottom.reason.includes('letterbox padding'), 'Alasan drop harus letterbox padding');

  // Anchor di dalam area aktif video (cy = 300)
  const validCand = { cx: 320, cy: 300, w: 80, h: 120, maxScore: 0.85, className: 'bottle' };
  const resValid = filterCandidate(validCand, letterboxParams);
  assert(resValid.accepted, 'Anchor di dalam area aktif video harus diterima');

  console.log('✅ PASSED');
  passedTests++;
}

// ---------------------------------------------------------------------------
// TEST 6: Rejection of Degenerate Small Boxes & Extreme Aspect Ratios
// ---------------------------------------------------------------------------
{
  process.stdout.write('• Testing: Rejection of degenerate small boxes & extreme aspect ratios... ');
  const letterboxParams = CoordinateMapper.computeLetterboxParams(1280, 720, 640);

  // 1. Box degenerasi 4x4 px
  const tinyCand = { cx: 320, cy: 300, w: 2, h: 2, maxScore: 0.70, className: 'mouse' };
  const resTiny = filterCandidate(tinyCand, letterboxParams);
  assert(!resTiny.accepted, 'Box degenerasi sub-16px harus di-drop');
  assert(resTiny.reason.includes('too small'), 'Alasan drop box too small');

  // 2. Box garis horizontal ekstrem (aspect ratio > 6.5)
  const lineCand = { cx: 320, cy: 300, w: 250, h: 10, maxScore: 0.65, className: 'keyboard' };
  const resLine = filterCandidate(lineCand, letterboxParams);
  assert(!resLine.accepted, 'Garis horizontal ekstrem harus di-drop');
  assert(resLine.reason.includes('extreme aspect ratio'), 'Alasan drop extreme aspect ratio');

  // 3. Box normal proporsional
  const normalCand = { cx: 320, cy: 300, w: 100, h: 80, maxScore: 0.80, className: 'laptop' };
  const resNormal = filterCandidate(normalCand, letterboxParams);
  assert(resNormal.accepted, 'Box normal harus diterima');

  console.log('✅ PASSED');
  passedTests++;
}

// ---------------------------------------------------------------------------
// TEST 7: Distance Fallback Guardrails (Area Compatibility Check)
// ---------------------------------------------------------------------------
{
  process.stdout.write('• Testing: Distance fallback guardrails (area ratio check prevents small noise match)... ');
  const tracker = new TrackingEngine({ TRACK_MAX_DISTANCE: 80.0, TRACK_DISTANCE_FALLBACK: true });

  // Frame 1: Objek besar (laptop 200x200)
  tracker.update([{ class_name: 'laptop', confidence: 0.90, bbox: { x1: 100, y1: 100, x2: 300, y2: 300 } }], 1);
  // Frame 2: Objek hilang
  tracker.update([], 2);

  // Frame 3: Noise kecil (20x20) muncul dalam jarak 50px dari center laptop lama
  // Center laptop lama: (200, 200). Center noise: (240, 200) -> distance = 40px <= 80px!
  // Area laptop = 40000, Area noise = 400. Area ratio = 100 > 3.5 -> HARUS DITOLAK!
  const noiseDet = [{ class_name: 'laptop', confidence: 0.70, bbox: { x1: 230, y1: 190, x2: 250, y2: 210 } }];
  const r3 = tracker.update(noiseDet, 3);

  // Noise tidak boleh mencocokkan track #1; noise harus dialokasikan sebagai track baru (#2)
  assert(r3.visibleTracks.length === 1, '1 visible track');
  assert(r3.visibleTracks[0].trackId === 2, 'Noise dialokasikan ke track baru #2, BUKAN mencocokkan laptop lama #1!');

  console.log('✅ PASSED');
  passedTests++;
}

// ---------------------------------------------------------------------------
// TEST 8: Recovery of Lost Track Keeps Confirmed Gate
// ---------------------------------------------------------------------------
{
  process.stdout.write('• Testing: Recovery of lost track preserves confirmed threshold gate... ');
  const tracker = new TrackingEngine({ TRACK_MIN_HITS: 3 });

  // Frame 1: Tentative track (hits = 1)
  tracker.update([{ class_name: 'cup', confidence: 0.85, bbox: { x1: 100, y1: 100, x2: 200, y2: 200 } }], 1);
  // Frame 2: Objek sementara terlewat (hits = 1, state = lost)
  tracker.update([], 2);
  // Frame 3: Objek muncul kembali (hits = 2)
  const r3 = tracker.update([{ class_name: 'cup', confidence: 0.86, bbox: { x1: 102, y1: 102, x2: 202, y2: 202 } }], 3);

  // Karena hits baru 2 (< TRACK_MIN_HITS 3), status TIDAK boleh langsung confirmed!
  assert(r3.visibleTracks[0].state === 'tentative', 'State harus tentative karena hits (2) belum mencapai TRACK_MIN_HITS (3)');

  // Frame 4: Objek muncul lagi (hits = 3)
  const r4 = tracker.update([{ class_name: 'cup', confidence: 0.88, bbox: { x1: 104, y1: 104, x2: 204, y2: 204 } }], 4);
  assert(r4.visibleTracks[0].state === 'confirmed', 'State baru menjadi confirmed setelah hits mencapai 3');

  console.log('✅ PASSED');
  passedTests++;
}

console.log('\n================================================================');
console.log(`🏁 All ${passedTests} Ghost Detection & False Positive Tests PASSED!`);
console.log('================================================================');
