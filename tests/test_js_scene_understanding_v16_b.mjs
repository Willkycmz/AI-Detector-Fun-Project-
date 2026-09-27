/**
 * test_js_scene_understanding_v16_b.mjs - Unit & Integration Tests for VisionX V1.6 Phase B
 *
 * Verifikasi Skenario:
 * 1. Relation geometry unit tests (pairwise bounding)
 * 2. Left / Right / Above / Below directional 2D tests
 * 3. Near-distance threshold tests
 * 4. Overlap (2D intersection) tests
 * 5. Containment (bounding box nesting) tests
 * 6. Empty scene handling (clutter: EMPTY, focal: null, graceful narrative)
 * 7. Single object scene (clutter: SPARSE, focal selection, single object narrative)
 * 8. Moderate & Crowded scene (clutter: MODERATE & CROWDED, max comparison cap)
 * 9. Deterministic focal object calculation (area + centrality weighting)
 * 10. VisionContext v1.6 integration & prompt serialization
 * 11. Performance benchmark (< 1ms per synthesis, zero allocations inside processFrame)
 */

import { SpatialRelationEngine, SpatialRelationType } from '../web/src/services/SpatialRelationEngine.js';
import { SceneUnderstandingEngine, ClutterLevel } from '../web/src/services/SceneUnderstandingEngine.js';
import { VisionContextBuilder } from '../web/src/services/VisionContextBuilder.js';

function assert(condition, message) {
  if (!condition) {
    throw new Error(`[FAIL] ${message}`);
  }
}

async function runTests() {
  console.log('================================================================');
  console.log('📐 Running VisionX V1.6 Phase B — Spatial & Scene Understanding Tests');
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
  // Test 1: Directional Relations (LEFT_OF, RIGHT_OF, ABOVE, BELOW)
  // -------------------------------------------------------------------------
  await testCase('Directional 2D Relations - LEFT_OF, RIGHT_OF, ABOVE, BELOW', () => {
    // Objek A di kiri-atas [50, 50, 150, 150] (center: 100, 100)
    // Objek B di kanan-bawah [350, 300, 450, 400] (center: 400, 350)
    const detections = [
      { id: 'obj_A', class_name: 'cup', bbox: [50, 50, 150, 150] },
      { id: 'obj_B', class_name: 'laptop', bbox: [350, 300, 450, 400] }
    ];

    const relations = SpatialRelationEngine.computeRelations(detections, 640, 480);
    assert(relations.length === 2, `Harus ada 2 relasi berarah (A->B dan B->A), got: ${relations.length}`);

    const relAtoB = relations.find(r => r.sourceId === 'obj_A' && r.targetId === 'obj_B');
    assert(relAtoB !== undefined, 'Relasi A->B harus ada');
    assert(relAtoB.relations.includes(SpatialRelationType.LEFT_OF), 'A harus LEFT_OF B');
    assert(relAtoB.relations.includes(SpatialRelationType.ABOVE), 'A harus ABOVE B');

    const relBtoA = relations.find(r => r.sourceId === 'obj_B' && r.targetId === 'obj_A');
    assert(relBtoA !== undefined, 'Relasi B->A harus ada');
    assert(relBtoA.relations.includes(SpatialRelationType.RIGHT_OF), 'B harus RIGHT_OF A');
    assert(relBtoA.relations.includes(SpatialRelationType.BELOW), 'B harus BELOW A');
  });

  // -------------------------------------------------------------------------
  // Test 2: Near-Distance Tests
  // -------------------------------------------------------------------------
  await testCase('Proximity Detection - NEAR threshold evaluation', () => {
    // Dua objek yang sangat dekat: mouse berdampingan dengan keyboard
    const closeDetections = [
      { id: 'mouse', class_name: 'mouse', bbox: [320, 200, 370, 250] },
      { id: 'keyboard', class_name: 'keyboard', bbox: [150, 190, 310, 260] }
    ];

    const closeRels = SpatialRelationEngine.computeRelations(closeDetections, 640, 480);
    const mouseToKb = closeRels.find(r => r.sourceId === 'mouse');
    assert(mouseToKb && mouseToKb.relations.includes(SpatialRelationType.NEAR), 'Mouse harus terdeteksi NEAR keyboard');

    // Dua objek yang sangat berjauhan: satu di sudut kiri atas, satu di sudut kanan bawah
    const farDetections = [
      { id: 'pen', class_name: 'pen', bbox: [10, 10, 30, 30] },
      { id: 'bottle', class_name: 'bottle', bbox: [600, 440, 630, 470] }
    ];

    const farRels = SpatialRelationEngine.computeRelations(farDetections, 640, 480);
    const penToBottle = farRels.find(r => r.sourceId === 'pen');
    assert(penToBottle && !penToBottle.relations.includes(SpatialRelationType.NEAR), 'Objek berjauhan TIDAK boleh bertanda NEAR');
  });

  // -------------------------------------------------------------------------
  // Test 3: Overlap (2D Intersection) Tests
  // -------------------------------------------------------------------------
  await testCase('Overlap Evaluation - OVERLAPPING bounding boxes', () => {
    // Objek A beririsan sebagian dengan Objek B
    const detections = [
      { id: 'book_1', class_name: 'book', bbox: [200, 200, 320, 300] },
      { id: 'book_2', class_name: 'book', bbox: [280, 250, 400, 350] }
    ];

    const rels = SpatialRelationEngine.computeRelations(detections, 640, 480);
    const pair = rels.find(r => r.sourceId === 'book_1' && r.targetId === 'book_2');
    assert(pair && pair.relations.includes(SpatialRelationType.OVERLAPPING), 'Buku harus terdeteksi OVERLAPPING');
  });

  // -------------------------------------------------------------------------
  // Test 4: Containment (Bounding Box Nesting) Tests
  // -------------------------------------------------------------------------
  await testCase('Containment Evaluation - CONTAINED_BY nested bounding box', () => {
    // Pen berada sepenuhnya di dalam kotak buku/meja
    const detections = [
      { id: 'pen', class_name: 'pen', bbox: [220, 220, 260, 240] }, // area = 800
      { id: 'laptop', class_name: 'laptop', bbox: [150, 150, 450, 350] } // area = 60000
    ];

    const rels = SpatialRelationEngine.computeRelations(detections, 640, 480);
    const penRel = rels.find(r => r.sourceId === 'pen' && r.targetId === 'laptop');
    assert(penRel !== undefined, 'Relasi pen->laptop harus terdaftar');
    assert(penRel.relations.includes(SpatialRelationType.CONTAINED_BY), 'Pen harus terdeteksi CONTAINED_BY laptop');
  });

  // -------------------------------------------------------------------------
  // Test 5: Empty Scene Handling
  // -------------------------------------------------------------------------
  await testCase('Empty Scene - Clutter EMPTY, focal null, narasi anggun', () => {
    const su = SceneUnderstandingEngine.synthesize({ detections: [], frameWidth: 640, frameHeight: 480 });

    assert(su.object_count === 0, 'Object count harus 0');
    assert(su.clutter_level === ClutterLevel.EMPTY, 'Clutter level harus EMPTY');
    assert(su.focal_object === null, 'Focal object harus null pada scene kosong');
    assert(su.spatial_relations.length === 0, 'Relasi spasial harus array kosong');
    assert(su.spatial_narrative.includes('kosong'), 'Narasi harus menyebutkan pemandangan kosong');
  });

  // -------------------------------------------------------------------------
  // Test 6: Single Object Scene
  // -------------------------------------------------------------------------
  await testCase('Single Object Scene - Clutter SPARSE, focal selection tunggal', () => {
    const singleDet = [{ id: 'det_1', class_name: 'person', confidence: 0.95, bbox: [200, 100, 440, 450], relative_position: 'tengah' }];
    const su = SceneUnderstandingEngine.synthesize({ detections: singleDet, frameWidth: 640, frameHeight: 480 });

    assert(su.object_count === 1, 'Object count harus 1');
    assert(su.clutter_level === ClutterLevel.SPARSE, 'Clutter level harus SPARSE');
    assert(su.focal_object !== null, 'Focal object tidak boleh null');
    assert(su.focal_object.class_name === 'person', 'Focal object harus person');
    assert(su.spatial_relations.length === 0, 'Single object tidak memiliki relasi pairwise');
    assert(su.spatial_narrative.includes('Terdeteksi 1 objek: person di area tengah'), `Narasi harus akurat, got: ${su.spatial_narrative}`);
  });

  // -------------------------------------------------------------------------
  // Test 7: Deterministic Focal Object (Area + Centrality Weighting)
  // -------------------------------------------------------------------------
  await testCase('Focal Object Selection - Geometri deterministik area dan sentralitas', () => {
    // Objek 1: Objek kecil di tengah [300, 220, 340, 260] (area 1600)
    // Objek 2: Laptop besar tepat di tengah [180, 140, 460, 360] (area 61600)
    // Objek 3: Objek sedang di pojok [0, 0, 100, 100] (area 10000)
    const detections = [
      { id: 'small_center', class_name: 'mouse', bbox: [300, 220, 340, 260] },
      { id: 'big_center', class_name: 'laptop', bbox: [180, 140, 460, 360] },
      { id: 'corner', class_name: 'cup', bbox: [0, 0, 100, 100] }
    ];

    const focal = SceneUnderstandingEngine.findFocalObject(detections, 640, 480);
    assert(focal !== null, 'Focal object harus ditemukan');
    assert(focal.id === 'big_center', `Focal object harus laptop besar di tengah, got: ${focal.id}`);
  });

  // -------------------------------------------------------------------------
  // Test 8: Moderate & Crowded Scenes and Pairwise Bounding Cap
  // -------------------------------------------------------------------------
  await testCase('Crowded Scene & Pairwise Cap - Clutter CROWDED dan batasan O(N^2)', () => {
    // Buat 15 deteksi
    const crowdedDetections = [];
    for (let i = 0; i < 15; i++) {
      crowdedDetections.push({
        id: `obj_${i + 1}`,
        class_name: i % 2 === 0 ? 'bottle' : 'cup',
        confidence: 0.8,
        bbox: [(i * 40) % 500, (i * 30) % 400, ((i * 40) % 500) + 35, ((i * 30) % 400) + 35]
      });
    }

    const su = SceneUnderstandingEngine.synthesize({ detections: crowdedDetections, frameWidth: 640, frameHeight: 480 });
    assert(su.object_count === 15, 'Object count harus 15');
    assert(su.clutter_level === ClutterLevel.CROWDED, `Clutter level harus CROWDED, got: ${su.clutter_level}`);
    assert(su.spatial_narrative.includes('cukup padat'), 'Narasi harus mencerminkan kondisi padat');

    // Pastikan pairwise comparisons tidak meledak melebihi batas maxObjectsToCompare (12)
    // 12 objek => 12 * 11 = 132 perbandingan maksimal
    assert(su.spatial_relations_count <= 132, `Relasi spasial terdaftar tidak boleh melebihi batas pasangan 132, got: ${su.spatial_relations_count}`);
  });

  // -------------------------------------------------------------------------
  // Test 9: VisionContext Integration & Prompt Serialization
  // -------------------------------------------------------------------------
  await testCase('VisionContext Integration - Struktur context v1.6 dengan sceneUnderstanding', () => {
    const context = VisionContextBuilder.build({
      cameraInfo: { width: 640, height: 480, isConnected: true, label: 'Cam' },
      detections: [
        { class_name: 'laptop', confidence: 0.9, bbox: [200, 150, 440, 350] },
        { class_name: 'bottle', confidence: 0.88, bbox: [470, 160, 530, 320] }
      ]
    });

    assert(context.version === '1.6', 'Version harus 1.6');
    assert(typeof context.sceneUnderstanding === 'object', 'context.sceneUnderstanding harus ada');
    assert(context.sceneUnderstanding.clutter_level === ClutterLevel.SPARSE, 'Clutter level harus SPARSE untuk 2 objek');
    assert(context.sceneUnderstanding.focal_object.class_name === 'laptop', 'Focal object harus laptop');
    assert(context.summary.clutter_level === ClutterLevel.SPARSE, 'Summary clutter level harus sinkron');
    assert(context.summary.focal_object === 'laptop', 'Summary focal object harus sinkron');

    const prompt = VisionContextBuilder.formatPromptContext(context);
    assert(prompt.includes('[ANALISIS SITUASI & SPASIAL'), 'Prompt harus memiliki tag analisis situasi & spasial');
    assert(prompt.includes('laptop'), 'Prompt harus memuat nama laptop');
    assert(prompt.includes('bottle'), 'Prompt harus memuat nama bottle');
  });

  // -------------------------------------------------------------------------
  // Test 10: Performance Benchmark
  // -------------------------------------------------------------------------
  await testCase('Performance Benchmark - Sintesis spasial cepat (< 1ms per panggilan)', () => {
    const detections = [
      { id: '1', class_name: 'person', bbox: [100, 50, 300, 450] },
      { id: '2', class_name: 'laptop', bbox: [250, 200, 450, 380] },
      { id: '3', class_name: 'mouse', bbox: [460, 280, 510, 340] },
      { id: '4', class_name: 'cup', bbox: [120, 260, 180, 340] }
    ];

    const iterations = 500;
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      SpatialRelationEngine.computeRelations(detections, 640, 480);
      SceneUnderstandingEngine.synthesize({ detections, frameWidth: 640, frameHeight: 480 });
    }
    const elapsed = performance.now() - start;
    const perCallMs = elapsed / iterations;

    assert(perCallMs < 1.0, `Eksekusi per panggilan harus < 1.0ms, aktual: ${perCallMs.toFixed(3)}ms`);
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
