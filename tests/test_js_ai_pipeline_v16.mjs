/**
 * test_js_ai_pipeline_v16.mjs - Automated Unit & Regression Tests for VisionX V1.6 Phase A
 *
 * Skenario Verifikasi:
 * 1. Context Schema Validation (v1.6) & Backward Compatibility
 * 2. Safety Engine & Alert Manager Multimodal Fusion
 * 3. Composite Risk Level Calculation (LOW -> NORMAL -> HIGH -> CRITICAL)
 * 4. Safety Null / Disabled Graceful Fallback
 * 5. Natural Prompt Context Generation with Safety & Hazard Status
 * 6. AIProvider (Mock) Safety Intent Grounding
 * 7. VisionAssistant End-to-End Orchestration with Safety Injection
 * 8. Performance Benchmark & Zero Side-Effect Purity
 */

import { VisionContextBuilder } from '../web/src/services/VisionContextBuilder.js';
import { SafetyEngine, SafetyEventType, SafetySeverity } from '../web/src/services/SafetyEngine.js';
import { AlertManager } from '../web/src/services/AlertManager.js';
import { MockAIProvider } from '../web/src/services/AIProvider.js';
import { VisionAssistant, AssistantState } from '../web/src/services/VisionAssistant.js';

function assert(condition, message) {
  if (!condition) {
    throw new Error(`[FAIL] ${message}`);
  }
}

async function runTests() {
  console.log('================================================================');
  console.log('🛡️ Running VisionX V1.6 Phase A — AI Context & Safety Fusion Tests');
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
  // Test 1: Context Schema Validation (v1.6) & Additive Fields
  // -------------------------------------------------------------------------
  await testCase('Context Schema Validation (v1.6) - Struktur JSON & backward compatibility', () => {
    const context = VisionContextBuilder.build({
      cameraInfo: { width: 1280, height: 720, isConnected: true, label: 'Webcam' },
      currentMode: 'detection'
    });

    assert(context.version === '1.6', `Version harus '1.6', got: ${context.version}`);
    assert(context.version.startsWith('1.'), 'Version harus kompatibel dengan 1.x');
    assert(typeof context.safety === 'object' && context.safety !== null, 'Context harus memiliki field safety');
    assert(context.safety.is_enabled === false, 'Default safety harus is_enabled: false jika engine tidak disertakan');
    assert(context.safety.risk_level === 'NORMAL', 'Default risk_level harus NORMAL jika engine kosong');
    assert(Array.isArray(context.safety.active_alerts), 'active_alerts harus berupa array');
    assert(context.summary.safety_risk_level === 'NORMAL', 'summary.safety_risk_level harus sinkron');
    assert(context.summary.active_alerts_count === 0, 'summary.active_alerts_count harus 0');
  });

  // -------------------------------------------------------------------------
  // Test 2: Multimodal Fusion dengan SafetyEngine & AlertManager Aktif
  // -------------------------------------------------------------------------
  await testCase('Safety Fusion - Ekstraksi event keselamatan dan active alerts', () => {
    const safetyEngine = new SafetyEngine();
    const alertManager = new AlertManager(null, { defaultCooldownMs: 0 });

    // Simulasikan event barang personal keluar dari pandangan kamera
    const events = safetyEngine.evaluate({
      activeTracks: [],
      memoryEvents: [{
        type: 'OBJECT_LEFT',
        trackId: 101,
        className: 'bottle',
        zone: 'kiri atas',
        isPersonal: true,
        personalObjectId: 'my_bottle_01',
        personalObjectName: 'My Hydro Flask'
      }],
      timestamp: Date.now()
    });

    assert(events.length > 0, 'SafetyEngine harus memproduksi event');
    const safetyEvent = events[0];
    assert(safetyEvent.type === SafetyEventType.PERSONAL_OBJECT_LEFT, 'Event harus PERSONAL_OBJECT_LEFT');

    // Proses event ke AlertManager
    const alert = alertManager.processEvent(safetyEvent);
    assert(alert !== null, 'AlertManager harus menghasilkan alert');

    // Build VisionContext v1.6
    const context = VisionContextBuilder.build({
      safetyEngine,
      alertManager,
      detections: [{ class_name: 'laptop', confidence: 0.92, bbox: [100, 100, 300, 300] }]
    });

    assert(context.safety.is_enabled === true, 'Safety context harus is_enabled: true');
    assert(context.safety.active_alerts_count === 1, 'Harus mencatat 1 active alert');
    assert(context.safety.risk_level === 'HIGH', `Tingkat risiko harus HIGH karena barang personal tertinggal, got: ${context.safety.risk_level}`);
    assert(context.summary.active_alerts_count === 1, 'Summary harus mencatat 1 alert');
    assert(context.summary.safety_risk_level === 'HIGH', 'Summary risk level harus HIGH');

    const serializedAlert = context.safety.active_alerts[0];
    assert(serializedAlert.is_personal === true, 'Alert harus bertanda personal');
    assert(serializedAlert.severity === SafetySeverity.HIGH, 'Severity harus HIGH');
    assert(serializedAlert.object_name === 'My Hydro Flask', 'Object name harus terpetakan akurat');
    assert(serializedAlert.last_zone === 'kiri atas', 'Zona spasial harus cocok');
  });

  // -------------------------------------------------------------------------
  // Test 3: Composite Risk Level Hierarchy (LOW -> NORMAL -> HIGH -> CRITICAL)
  // -------------------------------------------------------------------------
  await testCase('Composite Risk Level - Evaluasi hierarki tingkat risiko', () => {
    const safetyEngine = new SafetyEngine();
    const alertManager = new AlertManager(null, { defaultCooldownMs: 0 });

    // Skenario A: Tidak ada alert atau event -> LOW
    const ctxLow = VisionContextBuilder.build({ safetyEngine, alertManager });
    assert(ctxLow.safety.risk_level === 'LOW', `Tanpa alert, level risiko harus LOW, got: ${ctxLow.safety.risk_level}`);

    // Skenario B: Normal object left -> NORMAL
    const evtNormal = safetyEngine.evaluate({
      activeTracks: [],
      memoryEvents: [{ type: 'OBJECT_LEFT', trackId: 2, className: 'cup', zone: 'tengah', isPersonal: false }],
      timestamp: Date.now()
    });
    alertManager.processEvent(evtNormal[0]);
    const ctxNormal = VisionContextBuilder.build({ safetyEngine, alertManager });
    assert(ctxNormal.safety.risk_level === 'NORMAL', `Event normal harus menghasilkan risiko NORMAL, got: ${ctxNormal.safety.risk_level}`);

    // Skenario C: Anomali duplikasi track / Personal Left -> HIGH
    const evtHigh = safetyEngine.evaluate({
      activeTracks: [
        { trackId: 1, personalObjectId: 'p1', personalObjectName: 'Dompet' },
        { trackId: 2, personalObjectId: 'p1', personalObjectName: 'Dompet' }
      ],
      timestamp: Date.now()
    });
    alertManager.processEvent(evtHigh[0]);
    const ctxHigh = VisionContextBuilder.build({ safetyEngine, alertManager });
    assert(ctxHigh.safety.risk_level === 'HIGH', `Anomali duplikasi harus menghasilkan risiko HIGH, got: ${ctxHigh.safety.risk_level}`);
  });

  // -------------------------------------------------------------------------
  // Test 4: Graceful Degradation / Fallback Saat Safety Disabled atau Null
  // -------------------------------------------------------------------------
  await testCase('Graceful Fallback - Penanganan safetyEngine disabled atau null', () => {
    // 4a. null engine
    const ctxNull = VisionContextBuilder.build({ safetyEngine: null, alertManager: null });
    assert(ctxNull.safety.is_enabled === false, 'Harus false saat null');
    assert(ctxNull.safety.active_alerts.length === 0, 'Alerts harus array kosong');

    // 4b. disabled engine
    const disabledEngine = new SafetyEngine({ enabled: false });
    const ctxDisabled = VisionContextBuilder.build({ safetyEngine: disabledEngine });
    assert(ctxDisabled.safety.is_enabled === false, 'Harus false saat engine disabled');
    assert(ctxDisabled.safety.risk_level === 'UNKNOWN', 'Risk level UNKNOWN saat engine disabled');

    // 4c. safetyEngine aktif tetapi alertManager null
    const activeEngine = new SafetyEngine();
    const ctxNoAlerts = VisionContextBuilder.build({ safetyEngine: activeEngine, alertManager: null });
    assert(ctxNoAlerts.safety.is_enabled === true, 'Harus true jika safetyEngine aktif');
    assert(ctxNoAlerts.safety.active_alerts_count === 0, 'Active alerts count harus 0');
  });

  // -------------------------------------------------------------------------
  // Test 5: Format Prompt Context dengan Status Keselamatan
  // -------------------------------------------------------------------------
  await testCase('Prompt Formatting - Serialisasi string konteks keselamatan untuk LLM', () => {
    const safetyEngine = new SafetyEngine();
    const alertManager = new AlertManager(null, { defaultCooldownMs: 0 });

    // Saat aman tanpa alert
    const ctxSafe = VisionContextBuilder.build({ safetyEngine, alertManager });
    const promptSafe = VisionContextBuilder.formatPromptContext(ctxSafe);
    assert(promptSafe.includes('[STATUS KESELAMATAN]: Aman / Terkendali'), 'Prompt harus menyatakan status aman');

    // Saat ada alert aktif
    const evt = safetyEngine.evaluate({
      activeTracks: [],
      memoryEvents: [{ type: 'OBJECT_LEFT', trackId: 5, className: 'laptop', zone: 'kanan atas', isPersonal: true, personalObjectName: 'Laptop Kerja' }],
      timestamp: Date.now()
    });
    alertManager.processEvent(evt[0]);

    const ctxHazard = VisionContextBuilder.build({ safetyEngine, alertManager });
    const promptHazard = VisionContextBuilder.formatPromptContext(ctxHazard);
    assert(promptHazard.includes('[PERINGATAN KESELAMATAN AKTIF'), 'Prompt harus memuat blok peringatan keselamatan aktif');
    assert(promptHazard.includes('Laptop Kerja'), 'Prompt harus menyebutkan nama objek yang tertinggal');
    assert(promptHazard.includes('HIGH'), 'Prompt harus mencantumkan severity HIGH');
  });

  // -------------------------------------------------------------------------
  // Test 6: AIProvider (Mock) Menjawab Pertanyaan Safety
  // -------------------------------------------------------------------------
  await testCase('AIProvider Mock - Grounded response untuk pertanyaan keselamatan', async () => {
    const mockProvider = new MockAIProvider();
    const safetyEngine = new SafetyEngine();
    const alertManager = new AlertManager(null, { defaultCooldownMs: 0 });

    // Tanya saat situasi aman
    const ctxAman = VisionContextBuilder.build({ safetyEngine, alertManager });
    const resAman = await mockProvider.askVision({
      image: null,
      context: ctxAman,
      question: 'Apakah kondisi sekitar aman?'
    });
    assert(resAman.answer.includes('terpantau aman'), `Jawaban harus menyatakan aman, got: ${resAman.answer}`);

    // Tanya saat ada peringatan aktif
    const evt = safetyEngine.evaluate({
      activeTracks: [],
      memoryEvents: [{ type: 'OBJECT_LEFT', trackId: 7, className: 'phone', zone: 'kiri bawah', isPersonal: true, personalObjectName: 'iPhone Saya' }],
      timestamp: Date.now()
    });
    alertManager.processEvent(evt[0]);

    const ctxBahaya = VisionContextBuilder.build({ safetyEngine, alertManager });
    const resBahaya = await mockProvider.askVision({
      image: null,
      context: ctxBahaya,
      question: 'Apakah ada bahaya atau barang yang tertinggal?'
    });
    assert(resBahaya.answer.includes('Perhatian: Tingkat risiko saat ini HIGH'), `Jawaban harus melaporkan tingkat risiko HIGH, got: ${resBahaya.answer}`);
    assert(resBahaya.answer.includes('iPhone Saya'), 'Jawaban harus menyebutkan iPhone Saya');
  });

  // -------------------------------------------------------------------------
  // Test 7: VisionAssistant End-to-End dengan Injeksi Safety
  // -------------------------------------------------------------------------
  await testCase('VisionAssistant - Orkestrasi end-to-end terintegrasi Safety', async () => {
    const safetyEngine = new SafetyEngine();
    const alertManager = new AlertManager(null, { defaultCooldownMs: 0 });
    const mockAI = new MockAIProvider();

    const assistant = new VisionAssistant({
      aiProvider: mockAI,
      safetyEngine,
      alertManager,
      contextFn: () => VisionContextBuilder.build({ safetyEngine, alertManager })
    });

    const diag = assistant.getDiagnostics();
    assert(diag.hasSafetyEngine === true, 'Diagnostics harus melaporkan hasSafetyEngine: true');
    assert(diag.hasAlertManager === true, 'Diagnostics harus melaporkan hasAlertManager: true');

    const response = await assistant.ask('Bagaimana status keselamatan kamera?');
    assert(response.success === true, 'Respons harus berhasil');
    assert(response.answer.includes('terpantau aman'), 'Respons harus grounded pada status aman');
    assert(assistant.state === AssistantState.SUCCESS, 'State harus SUCCESS');
  });

  // -------------------------------------------------------------------------
  // Test 8: Performance Benchmark & Purity
  // -------------------------------------------------------------------------
  await testCase('Performance & Purity - Pembangunan konteks cepat & bebas side-effects', () => {
    const safetyEngine = new SafetyEngine();
    const alertManager = new AlertManager();

    const iterations = 500;
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      VisionContextBuilder.build({
        safetyEngine,
        alertManager,
        detections: [
          { class_name: 'person', confidence: 0.9, bbox: [50, 50, 200, 400] },
          { class_name: 'laptop', confidence: 0.85, bbox: [250, 200, 450, 350] }
        ]
      });
    }
    const elapsed = performance.now() - start;
    const perCallMs = elapsed / iterations;

    assert(perCallMs < 1.0, `Pembangunan context harus < 1.0ms per panggilan, aktual: ${perCallMs.toFixed(3)}ms`);
    // State safetyEngine tidak boleh berubah akibat pembacaan context
    assert(safetyEngine.getEventHistory().length === 0, 'SafetyEngine event history harus tetap bersih');
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
