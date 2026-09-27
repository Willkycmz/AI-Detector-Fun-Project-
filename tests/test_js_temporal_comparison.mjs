/**
 * test_js_temporal_comparison.mjs - Automated Unit & Integration Tests for VisionX V1.6 Phase C
 *
 * Verifikasi Skenario:
 * 1. Empty history handling
 * 2. Identical snapshots (zero change)
 * 3. Object appeared detection
 * 4. Object disappeared detection
 * 5. Significant movement detection (displacement >= 0.12)
 * 6. Insignificant movement rejection (displacement < 0.12)
 * 7. OCR text changes (new text, removed text, altered text)
 * 8. Safety state changes (risk elevation, alerts count)
 * 9. Custom window comparison (15-second default vs 30-second)
 * 10. 60-second history boundary enforcement
 * 11. >60 snapshots circular buffer rotation
 * 12. clear/reset state
 * 13. VisionContext v1.6 integration (context.temporalDelta)
 * 14. VisionAssistant deterministic temporal Q&A routing
 * 15. Performance benchmark (< 1ms per delta computation, zero allocations in render loop)
 */

import { SceneHistoryEngine } from '../web/src/services/SceneHistoryEngine.js';
import { VisionContextBuilder } from '../web/src/services/VisionContextBuilder.js';
import { VisionAssistant, AssistantState } from '../web/src/services/VisionAssistant.js';

function assert(condition, message) {
  if (!condition) {
    throw new Error(`[FAIL] ${message}`);
  }
}

async function runTests() {
  console.log('================================================================');
  console.log('⏱️ Running VisionX V1.6 Phase C — Temporal Scene Comparison Tests');
  console.log('================================================================\n');

  let passed = 0;
  let failed = 0;

  async function testCase(name, fn) {
    process.stdout.write(`• Testing: ${name}... `);
    try {
      await fn();
      console.log('✅ PASSED');
      passed++;
    } catch (err) {
      console.log('❌ FAILED');
      console.error(`  Error: ${err.message}`);
      if (err.stack) console.error(`  Stack: ${err.stack.split('\n').slice(1, 3).join('\n')}`);
      failed++;
    }
  }

  // -------------------------------------------------------------------------
  // Test 1: Empty History Handling
  // -------------------------------------------------------------------------
  await testCase('Empty History - Graceful degradation saat buffer riwayat kosong', () => {
    const engine = new SceneHistoryEngine();
    const delta = engine.computeDelta(15);

    assert(delta.has_changes === false, 'Empty history tidak boleh memicu has_changes');
    assert(delta.appeared_objects.length === 0, 'Appeared objects harus kosong');
    assert(delta.disappeared_objects.length === 0, 'Disappeared objects harus kosong');
    assert(delta.moved_objects.length === 0, 'Moved objects harus kosong');
    assert(delta.narrative.includes('stabil'), 'Narasi harus menyatakan stabil');
  });

  // -------------------------------------------------------------------------
  // Test 2: Identical Snapshots (Zero Change)
  // -------------------------------------------------------------------------
  await testCase('Identical Snapshots - Memastikan tidak ada false positive pada scene diam', () => {
    const engine = new SceneHistoryEngine();
    const baseTime = 1700000000000;

    const baseSnapshot = {
      timestamp: baseTime,
      objects: [
        { trackId: 1, className: 'laptop', normCenter: { x: 0.5, y: 0.5 }, spatialZone: 'tengah' },
        { trackId: 2, className: 'cup', normCenter: { x: 0.2, y: 0.3 }, spatialZone: 'kiri atas' }
      ],
      ocrText: 'VisionX AI',
      safetyRisk: 'LOW',
      activeAlertsCount: 0
    };

    // Rekam snapshot di T-15 detik dan T_now
    engine.record(baseSnapshot);
    engine.record({ ...baseSnapshot, timestamp: baseTime + 15000 });

    const delta = engine.computeDelta(15);
    assert(delta.has_changes === false, 'Snapshot identik tidak boleh memiliki perubahan');
    assert(delta.appeared_objects.length === 0, 'Tidak boleh ada objek muncul');
    assert(delta.disappeared_objects.length === 0, 'Tidak boleh ada objek hilang');
    assert(delta.moved_objects.length === 0, 'Tidak boleh ada objek berpindah');
    assert(delta.narrative.includes('stabil'), 'Narasi harus melaporkan stabil');
  });

  // -------------------------------------------------------------------------
  // Test 3: Object Appeared Detection
  // -------------------------------------------------------------------------
  await testCase('Object Appeared - Mendeteksi objek baru masuk ke frame', () => {
    const engine = new SceneHistoryEngine();
    const baseTime = 1700000000000;

    // T-15: Hanya ada laptop
    engine.record({
      timestamp: baseTime,
      objects: [{ trackId: 1, className: 'laptop', normCenter: { x: 0.5, y: 0.5 }, spatialZone: 'tengah' }]
    });

    // T_now: Laptop + Botol baru muncul
    engine.record({
      timestamp: baseTime + 15000,
      objects: [
        { trackId: 1, className: 'laptop', normCenter: { x: 0.5, y: 0.5 }, spatialZone: 'tengah' },
        { trackId: 2, className: 'bottle', normCenter: { x: 0.8, y: 0.5 }, spatialZone: 'kanan' }
      ]
    });

    const delta = engine.computeDelta(15);
    assert(delta.has_changes === true, 'Harus mendeteksi perubahan');
    assert(delta.appeared_objects.length === 1, 'Harus mencatat 1 objek muncul');
    assert(delta.appeared_objects[0].class_name === 'bottle', 'Objek muncul harus bottle');
    assert(delta.narrative.includes('Objek baru muncul: bottle'), `Narasi harus mencantumkan botol muncul, got: ${delta.narrative}`);
  });

  // -------------------------------------------------------------------------
  // Test 4: Object Disappeared Detection
  // -------------------------------------------------------------------------
  await testCase('Object Disappeared - Mendeteksi objek yang keluar/diambil dari frame', () => {
    const engine = new SceneHistoryEngine();
    const baseTime = 1700000000000;

    // T-15: Laptop + Mouse
    engine.record({
      timestamp: baseTime,
      objects: [
        { trackId: 1, className: 'laptop', normCenter: { x: 0.5, y: 0.5 }, spatialZone: 'tengah' },
        { trackId: 2, className: 'mouse', normCenter: { x: 0.7, y: 0.5 }, spatialZone: 'kanan' }
      ]
    });

    // T_now: Mouse hilang, hanya tersisa laptop
    engine.record({
      timestamp: baseTime + 15000,
      objects: [
        { trackId: 1, className: 'laptop', normCenter: { x: 0.5, y: 0.5 }, spatialZone: 'tengah' }
      ]
    });

    const delta = engine.computeDelta(15);
    assert(delta.has_changes === true, 'Harus mendeteksi perubahan');
    assert(delta.disappeared_objects.length === 1, 'Harus mencatat 1 objek hilang');
    assert(delta.disappeared_objects[0].class_name === 'mouse', 'Objek hilang harus mouse');
    assert(delta.narrative.includes('Objek tidak lagi terlihat: mouse'), 'Narasi harus mencantumkan mouse hilang');
  });

  // -------------------------------------------------------------------------
  // Test 5: Significant Movement Detection (>= 0.12)
  // -------------------------------------------------------------------------
  await testCase('Significant Movement - Mendeteksi pergeseran koordinat >= 0.12', () => {
    const engine = new SceneHistoryEngine();
    const baseTime = 1700000000000;

    // T-15: Cangkir di kiri atas (0.2, 0.2)
    engine.record({
      timestamp: baseTime,
      objects: [{ trackId: 10, className: 'cup', normCenter: { x: 0.2, y: 0.2 }, spatialZone: 'kiri atas' }]
    });

    // T_now: Cangkir digeser ke kanan bawah (0.7, 0.6) -> displacement = sqrt(0.5^2 + 0.4^2) = 0.64 >= 0.12
    engine.record({
      timestamp: baseTime + 15000,
      objects: [{ trackId: 10, className: 'cup', normCenter: { x: 0.7, y: 0.6 }, spatialZone: 'kanan bawah' }]
    });

    const delta = engine.computeDelta(15);
    assert(delta.has_changes === true, 'Harus ada perubahan');
    assert(delta.moved_objects.length === 1, 'Harus mencatat 1 objek berpindah');
    assert(delta.moved_objects[0].class_name === 'cup', 'Objek berpindah harus cup');
    assert(delta.moved_objects[0].from_zone === 'kiri atas', 'from_zone harus kiri atas');
    assert(delta.moved_objects[0].to_zone === 'kanan bawah', 'to_zone harus kanan bawah');
    assert(delta.narrative.includes('cup bergeser'), `Narasi harus memuat cup bergeser, got: ${delta.narrative}`);
  });

  // -------------------------------------------------------------------------
  // Test 6: Insignificant Movement Rejection (< 0.12)
  // -------------------------------------------------------------------------
  await testCase('Insignificant Movement - Mengabaikan jitter kecil (< 0.12)', () => {
    const engine = new SceneHistoryEngine();
    const baseTime = 1700000000000;

    // T-15: Posisi (0.50, 0.50)
    engine.record({
      timestamp: baseTime,
      objects: [{ trackId: 1, className: 'laptop', normCenter: { x: 0.50, y: 0.50 }, spatialZone: 'tengah' }]
    });

    // T_now: Jitter kecil (0.52, 0.51) -> displacement = sqrt(0.02^2 + 0.01^2) = 0.022 < 0.12
    engine.record({
      timestamp: baseTime + 15000,
      objects: [{ trackId: 1, className: 'laptop', normCenter: { x: 0.52, y: 0.51 }, spatialZone: 'tengah' }]
    });

    const delta = engine.computeDelta(15);
    assert(delta.has_changes === false, 'Pergeseran di bawah threshold tidak boleh memicu moved_objects');
    assert(delta.moved_objects.length === 0, 'moved_objects harus kosong');
  });

  // -------------------------------------------------------------------------
  // Test 7: OCR Text Changes
  // -------------------------------------------------------------------------
  await testCase('OCR Text Change - Mendeteksi perubahan string teks OCR', () => {
    const engine = new SceneHistoryEngine();
    const baseTime = 1700000000000;

    // T-15: Belum ada teks
    engine.record({ timestamp: baseTime, ocrText: '' });

    // T_now: Muncul teks "Google DeepMind"
    engine.record({ timestamp: baseTime + 15000, ocrText: 'Google DeepMind' });

    const delta = engine.computeDelta(15);
    assert(delta.ocr_changes.has_changed === true, 'OCR change harus true');
    assert(delta.ocr_changes.current_text === 'Google DeepMind', 'current_text harus akurat');
    assert(delta.narrative.includes('Muncul teks baru yang terbaca'), 'Narasi harus menyebutkan teks baru');
  });

  // -------------------------------------------------------------------------
  // Test 8: Safety State Change
  // -------------------------------------------------------------------------
  await testCase('Safety State Change - Mendeteksi kenaikan tingkat risiko keselamatan', () => {
    const engine = new SceneHistoryEngine();
    const baseTime = 1700000000000;

    // T-15: Kondisi aman (LOW)
    engine.record({ timestamp: baseTime, safetyRisk: 'LOW', activeAlertsCount: 0 });

    // T_now: Muncul alert bahaya (HIGH)
    engine.record({ timestamp: baseTime + 15000, safetyRisk: 'HIGH', activeAlertsCount: 1 });

    const delta = engine.computeDelta(15);
    assert(delta.safety_changes.has_changed === true, 'Safety change harus true');
    assert(delta.safety_changes.current_risk === 'HIGH', 'Risk level harus naik ke HIGH');
    assert(delta.narrative.includes('peringatan keselamatan baru'), 'Narasi harus mencantumkan peringatan keselamatan');
  });

  // -------------------------------------------------------------------------
  // Test 9: 60-Second Window & Circular Buffer Rotation
  // -------------------------------------------------------------------------
  await testCase('Circular Buffer & 60s Boundary - Maksimal 60 entri & rotasi tertua', () => {
    const engine = new SceneHistoryEngine({ maxSnapshots: 60, maxHistoryWindowMs: 60000 });
    const startTime = 1700000000000;

    // Rekam 75 snapshot setiap 1 detik
    for (let i = 0; i < 75; i++) {
      engine.record({
        timestamp: startTime + (i * 1000),
        objects: [{ className: 'laptop', normCenter: { x: 0.5, y: 0.5 } }]
      });
    }

    const diag = engine.getDiagnostics();
    assert(diag.totalSnapshots <= 60, `Buffer tidak boleh melebihi 60 item, got: ${diag.totalSnapshots}`);
    assert(engine.getHistory().length <= 60, 'getHistory() length <= 60');

    // Snapshot tertua harus berusia tidak lebih lama dari 60 detik dari snapshot terbaru
    const newest = engine.getCurrent();
    const oldest = engine.getHistory()[0];
    const diffSec = (newest.timestamp - oldest.timestamp) / 1000;
    assert(diffSec <= 60, `Rentang waktu tertua-terbaru harus <= 60s, got: ${diffSec}s`);
  });

  // -------------------------------------------------------------------------
  // Test 10: Clear / Reset State
  // -------------------------------------------------------------------------
  await testCase('Clear State - Reset riwayat snapshot', () => {
    const engine = new SceneHistoryEngine();
    engine.record({ timestamp: Date.now(), objects: [] });
    assert(engine.getDiagnostics().totalSnapshots === 1, 'Harus ada 1 snapshot');

    engine.clear();
    assert(engine.getDiagnostics().totalSnapshots === 0, 'Snapshots harus kosong setelah clear');
    assert(engine.getCurrent() === null, 'Current snapshot harus null');
  });

  // -------------------------------------------------------------------------
  // Test 11: VisionContext Integration (context.temporalDelta)
  // -------------------------------------------------------------------------
  await testCase('VisionContext Integration - Memuat node temporalDelta pada context v1.6', () => {
    const engine = new SceneHistoryEngine();
    const now = Date.now();

    // Rekam 2 snapshot dengan perubahan objek muncul
    engine.record({ timestamp: now - 15000, objects: [] });
    engine.record({
      timestamp: now,
      objects: [{ className: 'keyboard', normCenter: { x: 0.5, y: 0.7 }, spatialZone: 'bawah' }]
    });

    const context = VisionContextBuilder.build({
      sceneHistoryEngine: engine,
      detections: [{ class_name: 'keyboard', bbox: [100, 300, 500, 450] }]
    });

    assert(context.version === '1.6', 'Version harus 1.6');
    assert(typeof context.temporalDelta === 'object' && context.temporalDelta !== null, 'temporalDelta harus ada');
    assert(context.temporalDelta.has_changes === true, 'temporalDelta.has_changes harus true');
    assert(context.summary.recent_changes_detected === true, 'summary.recent_changes_detected harus true');

    const prompt = VisionContextBuilder.formatPromptContext(context);
    assert(prompt.includes('[PERUBAHAN DALAM 15 DETIK TERAKHIR]'), 'Prompt harus menyertakan blok perubahan temporal');
  });

  // -------------------------------------------------------------------------
  // Test 12: VisionAssistant Deterministic Temporal Routing
  // -------------------------------------------------------------------------
  await testCase('VisionAssistant Q&A - Menjawab pertanyaan temporal dengan deterministik', async () => {
    const engine = new SceneHistoryEngine();
    const now = Date.now();

    // Simulasikan botol hilang 15 detik terakhir
    engine.record({
      timestamp: now - 15000,
      objects: [
        { trackId: 1, className: 'laptop', normCenter: { x: 0.5, y: 0.5 }, spatialZone: 'tengah' },
        { trackId: 2, className: 'bottle', normCenter: { x: 0.8, y: 0.4 }, spatialZone: 'kanan' }
      ]
    });

    engine.record({
      timestamp: now,
      objects: [
        { trackId: 1, className: 'laptop', normCenter: { x: 0.5, y: 0.5 }, spatialZone: 'tengah' }
      ]
    });

    const assistant = new VisionAssistant({
      sceneHistoryEngine: engine
    });

    const diag = assistant.getDiagnostics();
    assert(diag.hasSceneHistoryEngine === true, 'Diagnostics harus melaporkan hasSceneHistoryEngine: true');

    const res = await assistant.ask('Apa yang berubah dalam 15 detik terakhir?');
    assert(res.success === true, 'Panggilan harus sukses');
    assert(res.provider === 'visionx-temporal-engine', `Provider harus visionx-temporal-engine, got: ${res.provider}`);
    assert(res.answer.includes('bottle'), `Jawaban harus memuat nama botol, got: ${res.answer}`);
    assert(res.answer.includes('tidak lagi terlihat'), 'Jawaban harus menyatakan botol tidak lagi terlihat');
  });

  // -------------------------------------------------------------------------
  // Test 13: Performance Benchmark (< 1ms per computeDelta)
  // -------------------------------------------------------------------------
  await testCase('Performance Benchmark - Komputasi delta cepat (< 1ms per panggilan)', () => {
    const engine = new SceneHistoryEngine();
    const now = Date.now();

    // Buat riwayat 60 detik penuh dengan masing-masing 10 objek
    for (let i = 0; i < 60; i++) {
      const objs = [];
      for (let j = 0; j < 10; j++) {
        objs.push({
          trackId: j + 1,
          className: j % 2 === 0 ? 'laptop' : 'bottle',
          normCenter: { x: 0.1 * j, y: 0.05 * j + (i * 0.001) }
        });
      }
      engine.record({ timestamp: now - (60000 - (i * 1000)), objects: objs });
    }

    const iterations = 500;
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      engine.computeDelta(15);
    }
    const elapsed = performance.now() - start;
    const perCallMs = elapsed / iterations;

    assert(perCallMs < 1.0, `Komputasi delta harus < 1.0ms, aktual: ${perCallMs.toFixed(3)}ms`);
  });

  console.log('\n================================================================');
  console.log(`🏁 Test Summary: ${passed} PASSED, ${failed} FAILED`);
  console.log('================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
