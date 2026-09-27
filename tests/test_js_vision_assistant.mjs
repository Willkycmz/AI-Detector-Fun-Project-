/**
 * test_js_vision_assistant.mjs - Automated Unit & Regression Tests for VisionX V1.0 AI Vision Assistant
 *
 * Verifikasi Skenario Inti Sesuai Spesifikasi:
 * 1. Context generation (struktur JSON multimodal lengkap)
 * 2. Empty detections handling (graceful, objek kosong, ringkasan kontekstual)
 * 3. Multiple tracked objects (penentuan posisi spasial relatif, pergerakan, dan arah)
 * 4. OCR context integration (teks terbaca, skor confidence, region bounding box)
 * 5. Identity context integration (status developer recognized/unknown, safety protocol)
 * 6. AIProvider abstraction contract & MockAIProvider
 * 7. Assistant loading state transition
 * 8. Assistant error state handling (empty question, provider failure)
 * 9. Assistant success state transition & answer propagation
 * 10. On-demand snapshot policy (snapshot hanya dieksekusi saat user bertanya)
 * 11. VoiceEngine audio forwarding on response
 */

import { VisionContextBuilder } from '../web/src/services/VisionContextBuilder.js';
import { AIProvider, MockAIProvider, BackendAIProvider } from '../web/src/services/AIProvider.js';
import { VisionAssistant, AssistantState } from '../web/src/services/VisionAssistant.js';

function assert(condition, message) {
  if (!condition) {
    throw new Error(`[FAIL] ${message}`);
  }
}

// Mock VoiceEngine untuk testing integrasi audio tanpa dependensi browser Web Speech API
class MockVoiceEngine {
  constructor() {
    this.spokenMessages = [];
    this.isSpeaking = false;
    this.config = { enabled: true };
  }

  speak(text, options = {}) {
    this.spokenMessages.push({ text, options, timestamp: Date.now() });
    this.isSpeaking = true;
    return true;
  }

  stop() {
    this.isSpeaking = false;
  }

  getLastMessage() {
    return this.spokenMessages.length > 0
      ? this.spokenMessages[this.spokenMessages.length - 1].text
      : null;
  }
}

// Mock TrackingEngine
class MockTrackingEngine {
  constructor(tracks = []) {
    this.isEnabled = true;
    this.tracks = tracks;
  }

  getTracks() {
    return this.tracks;
  }
}

async function runTests() {
  console.log('================================================================');
  console.log('🤖 Running VisionX V1.0 AI Vision Assistant Test Suite');
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
  // Test 1: Context Generation
  // -------------------------------------------------------------------------
  await testCase('Context Generation - Membangun struktur JSON multimodal lengkap', () => {
    const context = VisionContextBuilder.build({
      cameraInfo: { width: 1280, height: 720, isConnected: true, label: 'HD Webcam' },
      currentMode: 'detection'
    });

    assert(context !== null && typeof context === 'object', 'Context harus berupa objek');
    assert(context.version.startsWith('1.'), 'Version context harus 1.x (V1.0/V1.1)');
    assert(context.timestamp, 'Context harus memiliki timestamp');
    assert(Array.isArray(context.detections), 'detections harus berupa array');
    assert(typeof context.summary === 'object', 'Context harus memiliki objek summary');
    assert(context.camera && context.camera.width === 1280, 'Camera metadata harus terpetakan');
  });

  // -------------------------------------------------------------------------
  // Test 2: Empty Detections
  // -------------------------------------------------------------------------
  await testCase('Empty Detections - Penanganan deteksi kosong secara anggun', () => {
    const context = VisionContextBuilder.build({
      detections: [],
      trackingEngine: null,
      ocrResult: null,
      identityState: null
    });

    assert(context.summary.total_objects === 0, 'Total objects harus 0');
    assert(context.detections.length === 0, 'detections harus kosong');
    assert(context.summary.classes_present.length === 0, 'classes_present harus kosong');
    
    // Uji format prompt
    const promptText = VisionContextBuilder.formatPromptContext(context);
    assert(typeof promptText === 'string', 'Prompt text harus berupa string');
    assert(promptText.includes('Tidak ada objek') || promptText.includes('Total: 0'), 'Prompt text harus menyatakan objek kosong');
  });

  // -------------------------------------------------------------------------
  // Test 3: Multiple Tracked Objects & Spatial Positioning
  // -------------------------------------------------------------------------
  await testCase('Multiple Tracked Objects - Pemetaan spasial dan kecepatan tracking', () => {
    const sampleDetections = [
      { class_name: 'cup', confidence: 0.92, bbox: [50, 40, 180, 200] }, // kiri atas
      { class_name: 'bottle', confidence: 0.88, bbox: [250, 180, 390, 320] }, // tengah
      { class_name: 'phone', confidence: 0.79, bbox: [500, 350, 620, 460] } // kanan bawah
    ];

    const mockTracks = [
      {
        trackId: 101,
        className: 'cup',
        confidence: 0.92,
        isConfirmed: true,
        isLost: false,
        velocity: { vx: 0.25, vy: -0.15 }, // kanan atas
        age: 12
      },
      {
        trackId: 102,
        className: 'bottle',
        confidence: 0.88,
        isConfirmed: true,
        isLost: false,
        velocity: { vx: 0.01, vy: 0.01 }, // stabil
        age: 20
      }
    ];

    const trackingEngine = new MockTrackingEngine(mockTracks);

    const context = VisionContextBuilder.build({
      detections: sampleDetections,
      trackingEngine,
      cameraInfo: { width: 640, height: 480 }
    });

    assert(context.summary.total_objects === 3, 'Total objects harus 3');
    assert(context.summary.classes_present.includes('cup'), 'Harus mendeteksi cup');
    assert(context.summary.classes_present.includes('bottle'), 'Harus mendeteksi bottle');
    assert(context.summary.classes_present.includes('phone'), 'Harus mendeteksi phone');

    // Cek posisi spasial
    const cupObj = context.detections.find(o => o.class_name === 'cup');
    assert(cupObj && cupObj.relative_position.includes('kiri'), 'Posisi cup harus di kiri');

    const bottleObj = context.detections.find(o => o.class_name === 'bottle');
    assert(bottleObj && bottleObj.relative_position === 'tengah', 'Posisi bottle harus di tengah');

    const phoneObj = context.detections.find(o => o.class_name === 'phone');
    assert(phoneObj && phoneObj.relative_position.includes('kanan'), 'Posisi phone harus di kanan');

    // Cek tracking info
    assert(context.tracking.active_tracks_count === 2, 'Active tracks harus 2');
    const trackCup = context.tracking.tracks.find(t => t.track_id === 101);
    assert(trackCup && trackCup.movement.includes('kanan'), 'Movement tracking cup harus ke kanan');
  });

  // -------------------------------------------------------------------------
  // Test 4: OCR Context Integration
  // -------------------------------------------------------------------------
  await testCase('OCR Context - Integrasi teks OCR, confidence, dan region', () => {
    const sampleOcr = {
      text: 'VISIONX AI V1.0 PROTOCOL',
      confidence: 94.5,
      language: 'ind',
      regions: [
        { text: 'VISIONX AI', confidence: 96, bbox: [20, 30, 200, 70] },
        { text: 'V1.0 PROTOCOL', confidence: 93, bbox: [20, 80, 210, 120] }
      ]
    };

    const context = VisionContextBuilder.build({
      ocrResult: sampleOcr
    });

    assert(context.ocr.has_text === true, 'has_text harus true');
    assert(context.ocr.text === 'VISIONX AI V1.0 PROTOCOL', 'Teks OCR harus tepat');
    assert(context.ocr.confidence === 94.5, 'Confidence OCR harus tepat');
    assert(context.ocr.region_count === 2, 'Region count harus 2');
    assert(context.summary.has_ocr_text === true, 'Summary has_ocr_text harus true');
  });

  // -------------------------------------------------------------------------
  // Test 5: Identity Context Integration
  // -------------------------------------------------------------------------
  await testCase('Identity Context - Integrasi status developer match & protocol', () => {
    const sampleIdentity = {
      detected: true,
      recognized: true,
      isDeveloper: true,
      profileName: 'VisionX Developer',
      similarity: 0.88,
      status: 'DEVELOPER_VERIFIED'
    };

    const context = VisionContextBuilder.build({
      identityState: sampleIdentity
    });

    assert(context.identity.is_enabled === true, 'is_enabled harus true');
    assert(context.identity.is_developer_verified === true, 'is_developer_verified harus true');
    assert(context.identity.profile_name === 'VisionX Developer', 'Nama harus VisionX Developer');
    assert(context.summary.identity_verified === true, 'Summary identity_verified harus true');
  });

  // -------------------------------------------------------------------------
  // Test 6: AIProvider Abstraction Contract & MockAIProvider
  // -------------------------------------------------------------------------
  await testCase('AIProvider Abstraction - Interface and MockAIProvider execution', async () => {
    const baseProvider = new AIProvider();
    let throwsOnBase = false;
    try {
      await baseProvider.askVision({ image: null, context: {}, question: 'Halo' });
    } catch (e) {
      throwsOnBase = true;
    }
    assert(throwsOnBase, 'Base AIProvider.askVision() harus melempar error implementasi');

    const mockProvider = new MockAIProvider({
      mockAnswer: 'Ini respons pengujian AI.'
    });

    const res = await mockProvider.askVision({
      image: 'data:image/jpeg;base64,sample',
      context: { detections: [{ class_name: 'cup' }] },
      question: 'Apa ini?'
    });

    assert(res.answer === 'Ini respons pengujian AI.', 'Mock provider harus mengembalikan jawaban yang diatur');
    assert(res.provider.includes('mock'), 'Provider name harus mengandung mock');
    assert(typeof res.latencyMs === 'number', 'Latency harus diukur');
  });

  // -------------------------------------------------------------------------
  // Test 7: VisionAssistant State Transitions (Loading -> Success)
  // -------------------------------------------------------------------------
  await testCase('VisionAssistant - Transisi state Loading ke Success', async () => {
    const mockProvider = new MockAIProvider({
      mockAnswer: 'Saya melihat cangkir di sebelah kiri.',
      delayMs: 20
    });

    let snapshotCount = 0;
    const assistant = new VisionAssistant({
      aiProvider: mockProvider,
      snapshotFn: () => {
        snapshotCount++;
        return 'data:image/jpeg;base64,test-snapshot';
      },
      contextFn: () => VisionContextBuilder.build({ detections: [{ class_name: 'cup', bbox: [50, 50, 100, 100] }] })
    });

    assert(assistant.state === AssistantState.IDLE, 'State awal harus IDLE');

    const statesTracked = [];
    assistant.onStateChange((payload) => {
      statesTracked.push(payload.state);
    });

    const askPromise = assistant.ask('Apa yang ada di meja?');
    assert(assistant.state === AssistantState.LOADING, 'State saat eksekusi harus LOADING');
    assert(assistant.isLoading === true, 'isLoading harus true');

    const res = await askPromise;

    assert(res.success === true, 'Hasil ask harus sukses');
    assert(res.answer === 'Saya melihat cangkir di sebelah kiri.', 'Jawaban harus sesuai');
    assert(assistant.state === AssistantState.SUCCESS, 'State akhir harus SUCCESS');
    assert(assistant.isLoading === false, 'isLoading harus false');
    assert(statesTracked.includes(AssistantState.LOADING), 'Harus melalui state LOADING');
    assert(statesTracked.includes(AssistantState.SUCCESS), 'Harus melalui state SUCCESS');
    assert(snapshotCount === 1, 'Snapshot harus dipanggil tepat 1 kali');
  });

  // -------------------------------------------------------------------------
  // Test 8: VisionAssistant Error State Handling
  // -------------------------------------------------------------------------
  await testCase('VisionAssistant - Penanganan Error State secara terisolasi', async () => {
    // Provider yang gagal
    class FailingProvider extends AIProvider {
      async askVision() {
        throw new Error('Koneksi timeout ke server AI');
      }
      get name() { return 'FailingProvider'; }
    }

    const assistant = new VisionAssistant({
      aiProvider: new FailingProvider()
    });

    let errorEventReceived = null;
    assistant.on('error', (payload) => {
      errorEventReceived = payload;
    });

    const res = await assistant.ask('Pertanyaan yang gagal');

    assert(res.success === false, 'Hasil ask harus bernilai success: false');
    assert(res.error.includes('Koneksi timeout'), 'Pesan error harus terpropagasi');
    assert(assistant.state === AssistantState.ERROR, 'State harus ERROR');
    assert(assistant.lastError.includes('Koneksi timeout'), 'lastError harus tercatat');
    assert(errorEventReceived !== null, 'Event error harus di-emit');
    assert(assistant.isLoading === false, 'isLoading harus false setelah error');
  });

  // -------------------------------------------------------------------------
  // Test 9: On-demand Snapshot Execution Policy
  // -------------------------------------------------------------------------
  await testCase('Snapshot Policy - Snapshot HANYA diambil saat user bertanya (bukan streaming)', async () => {
    let snapshotInvocations = 0;
    const mockProvider = new MockAIProvider({ mockAnswer: 'Jawaban snapshot.' });

    const assistant = new VisionAssistant({
      aiProvider: mockProvider,
      snapshotFn: () => {
        snapshotInvocations++;
        return 'data:image/jpeg;base64,camera-frame-data';
      }
    });

    // Saat diam (idle), snapshot tidak boleh dipanggil
    assert(snapshotInvocations === 0, 'Snapshot tidak boleh dipanggil saat idle');

    // Pertanyaan pertama
    await assistant.ask('Pertanyaan 1');
    assert(snapshotInvocations === 1, 'Snapshot harus dipanggil tepat 1 kali untuk pertanyaan 1');

    // Pertanyaan kedua
    await assistant.ask('Pertanyaan 2');
    assert(snapshotInvocations === 2, 'Snapshot harus dipanggil tepat 2 kali setelah 2 pertanyaan');
  });

  // -------------------------------------------------------------------------
  // Test 10: VoiceEngine Audio Forwarding
  // -------------------------------------------------------------------------
  await testCase('VoiceEngine Integration - Meneruskan jawaban AI ke sintesis suara', async () => {
    const mockVoice = new MockVoiceEngine();
    const mockProvider = new MockAIProvider({
      mockAnswer: 'Halo! Saya mendeteksi botol di tengah frame.'
    });

    const assistant = new VisionAssistant({
      aiProvider: mockProvider,
      voiceEngine: mockVoice,
      autoSpeak: true
    });

    await assistant.ask('Apa di depan?');

    assert(mockVoice.spokenMessages.length === 1, 'VoiceEngine harus dipanggil 1 kali');
    assert(mockVoice.getLastMessage() === 'Halo! Saya mendeteksi botol di tengah frame.', 'Kalimat yang dibacakan harus sama dengan jawaban AI');

    // Uji speakResponse() eksplisit (tombol 'Bacakan')
    assistant.speakResponse('Uji pembacaan ulang.');
    assert(mockVoice.spokenMessages.length === 2, 'speakResponse manual harus memanggil VoiceEngine');
    assert(mockVoice.getLastMessage() === 'Uji pembacaan ulang.', 'Teks manual harus terbaca');

    // Uji stopSpeech()
    assistant.stopSpeech();
    assert(mockVoice.isSpeaking === false, 'stopSpeech harus menghentikan suara');
  });

  // -------------------------------------------------------------------------
  // Test 11: Empty Question Validation
  // -------------------------------------------------------------------------
  await testCase('Validation - Menolak pertanyaan kosong atau whitespace', async () => {
    const assistant = new VisionAssistant();
    let threw = false;

    try {
      await assistant.ask('   ');
    } catch (e) {
      threw = true;
      assert(e.message.includes('tidak boleh kosong'), 'Pesan error harus spesifik');
    }

    assert(threw, 'Pertanyaan whitespace harus melempar error');
    assert(assistant.state === AssistantState.ERROR, 'State harus ERROR');
  });

  console.log('\n================================================================');
  console.log(`🏁 Test Summary: ${passed} PASSED, ${failed} FAILED`);
  console.log('================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Fatal Test Runner Error:', err);
  process.exit(1);
});
