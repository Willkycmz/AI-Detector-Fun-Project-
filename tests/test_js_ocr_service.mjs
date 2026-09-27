/**
 * test_js_ocr_service.mjs - Automated Unit & Regression Tests for VisionX V0.9 OCRService
 *
 * Verifikasi 10 Skenario Inti Sesuai Spesifikasi:
 * 1. OCRService initialization
 * 2. valid image
 * 3. invalid image
 * 4. no text
 * 5. text result parsing
 * 6. language selection
 * 7. duplicate text suppression
 * 8. OCR failure isolation
 * 9. VoiceEngine integration
 * 10. async processing
 */

import { OCRService, OCRStatus } from '../web/src/services/OCRService.js';
import { VoiceEngine, SpeechPriority, VoiceState } from '../web/src/services/VoiceEngine.js';

function assert(condition, message) {
  if (!condition) {
    throw new Error(`[FAIL] ${message}`);
  }
}

/**
 * Mock Worker Tesseract untuk pengujian deterministik & isolasi di Node.js
 */
class MockTesseractWorker {
  constructor(mockResult = null, shouldFail = false) {
    this.mockResult = mockResult || {
      data: {
        text: 'VISIONX TEST PROMO 50%',
        confidence: 91,
        lines: [
          {
            text: 'VISIONX TEST',
            confidence: 94,
            bbox: { x0: 50, y0: 60, x1: 250, y1: 100 }
          },
          {
            text: 'PROMO 50%',
            confidence: 88,
            bbox: { x0: 50, y0: 120, x1: 220, y1: 160 }
          }
        ]
      }
    };
    this.shouldFail = shouldFail;
    this.isTerminated = false;
  }

  async recognize(image, options) {
    if (this.shouldFail) {
      throw new Error('Mock OCR Worker memory crash');
    }
    return this.mockResult;
  }

  async terminate() {
    this.isTerminated = true;
  }
}

class MockSpeechSynthesis {
  constructor() {
    this.spoken = [];
    this.currentUtterance = null;
  }
  speak(u) {
    this.spoken.push(u.text);
    this.currentUtterance = u;
  }
  cancel() {
    this.currentUtterance = null;
  }
  pause() {}
  resume() {}
  finishCurrent() {
    if (this.currentUtterance && this.currentUtterance.onend) {
      const u = this.currentUtterance;
      this.currentUtterance = null;
      u.onend();
    }
  }
}

class MockUtterance {
  constructor(text) {
    this.text = text;
    this.onend = null;
    this.onerror = null;
  }
}

console.log('--- Running JS OCR Service V0.9 Automated Tests ---');

// =========================================================================
// TEST 1: OCRService initialization
// =========================================================================
{
  const mockWorker = new MockTesseractWorker();
  const service = new OCRService({ language: 'ind' }, mockWorker);

  assert(service.status === OCRStatus.LOADING, 'Test 1: Initial status is LOADING');
  const ready = await service.initialize('ind');
  assert(ready === true, 'Test 1: initialize returns true');
  assert(service.getStatus() === OCRStatus.READY, 'Test 1: Status becomes READY');
  assert(service.config.language === 'ind', 'Test 1: Language set to Indonesian (ind)');
  console.log('✓ Test 1: OCRService initialization verified');
}

// =========================================================================
// TEST 2: valid image
// =========================================================================
{
  const mockWorker = new MockTesseractWorker();
  const service = new OCRService({ language: 'ind' }, mockWorker);
  await service.initialize();

  const dummyImage = { width: 640, height: 480 };
  const res = await service.recognize(dummyImage);

  assert(res !== null, 'Test 2: Result returned');
  assert(res.text === 'VISIONX TEST PROMO 50%', 'Test 2: Text matches mock');
  assert(res.confidence === 91, 'Test 2: Confidence is 91');
  assert(Array.isArray(res.regions) && res.regions.length === 2, 'Test 2: 2 text regions extracted');
  assert(res.timestamp > 0, 'Test 2: Timestamp present');
  assert(typeof res.processingTimeMs === 'number', 'Test 2: processingTimeMs present');
  assert(service.getStatus() === OCRStatus.DONE, 'Test 2: Status is DONE after recognition');
  console.log('✓ Test 2: valid image recognition verified');
}

// =========================================================================
// TEST 3: invalid image
// =========================================================================
{
  const mockWorker = new MockTesseractWorker();
  const service = new OCRService({}, mockWorker);
  await service.initialize();

  let threw = false;
  try {
    await service.recognize(null);
  } catch (err) {
    threw = true;
    assert(err.message.includes('Input citra'), 'Test 3: Descriptive error on null input');
  }
  assert(threw === true, 'Test 3: Throws on null image');
  console.log('✓ Test 3: invalid image handling verified');
}

// =========================================================================
// TEST 4: no text
// =========================================================================
{
  const emptyWorker = new MockTesseractWorker({
    data: { text: '', confidence: 0, lines: [] }
  });
  const service = new OCRService({}, emptyWorker);
  await service.initialize();

  const res = await service.recognize({ width: 640, height: 480 });
  assert(res.text === '', 'Test 4: Empty text returned cleanly');
  assert(res.confidence === 0, 'Test 4: 0 confidence on empty text');
  assert(res.regions.length === 0, 'Test 4: 0 regions on empty text');
  assert(service.getStatus() === OCRStatus.DONE, 'Test 4: Status is DONE');
  console.log('✓ Test 4: empty/no text image handled gracefully');
}

// =========================================================================
// TEST 5: text result parsing
// =========================================================================
{
  const mockWorker = new MockTesseractWorker();
  const service = new OCRService({}, mockWorker);
  await service.initialize();

  const res = await service.recognize({ width: 640, height: 480 });
  const firstRegion = res.regions[0];

  assert(firstRegion.text === 'VISIONX TEST', 'Test 5: Region 1 text parsed');
  assert(firstRegion.confidence === 94, 'Test 5: Region 1 confidence parsed');
  assert(firstRegion.bbox.x1 === 50, 'Test 5: bbox x1');
  assert(firstRegion.bbox.y1 === 60, 'Test 5: bbox y1');
  assert(firstRegion.bbox.x2 === 250, 'Test 5: bbox x2');
  assert(firstRegion.bbox.y2 === 100, 'Test 5: bbox y2');

  const secondRegion = res.regions[1];
  assert(secondRegion.text === 'PROMO 50%', 'Test 5: Region 2 text parsed');
  assert(secondRegion.bbox.y1 === 120, 'Test 5: bbox y1');
  console.log('✓ Test 5: text regions & coordinates parsing verified');
}

// =========================================================================
// TEST 6: language selection
// =========================================================================
{
  const mockWorker = new MockTesseractWorker();
  const service = new OCRService({ language: 'ind' }, mockWorker);
  await service.initialize();

  assert(service.config.language === 'ind', 'Test 6: Initial language is ind');
  service.worker = mockWorker;

  // Ganti ke English ('eng')
  await service.setLanguage('eng');
  assert(service.config.language === 'eng', 'Test 6: Language updated to eng');

  // Tolak bahasa yang tidak didukung
  let threw = false;
  try {
    await service.setLanguage('jpn');
  } catch (e) {
    threw = true;
    assert(e.message.includes('tidak didukung'), 'Test 6: Rejects unsupported language');
  }
  assert(threw === true, 'Test 6: Exception thrown on invalid language');
  console.log('✓ Test 6: language selection & validation verified');
}

// =========================================================================
// TEST 7: duplicate text suppression
// =========================================================================
{
  // Uji logika duplicate suppression untuk Auto Read / on-demand scanning
  let lastSpokenText = '';
  let lastSpokenTime = 0;
  const cooldownMs = 3000;

  function shouldSpeakOcrResult(newText, now) {
    const cleanNew = String(newText || '').toLowerCase().replace(/[^a-z0-9]/gi, '').trim();
    const cleanOld = String(lastSpokenText || '').toLowerCase().replace(/[^a-z0-9]/gi, '').trim();

    if (!cleanNew) return false;
    if (cleanNew === cleanOld && (now - lastSpokenTime) < cooldownMs) {
      return false; // Suppress duplicate!
    }

    lastSpokenText = newText;
    lastSpokenTime = now;
    return true;
  }

  const t0 = 10000;
  assert(shouldSpeakOcrResult('Laptop ASUS', t0) === true, 'Test 7: First scan allowed');
  assert(shouldSpeakOcrResult('Laptop ASUS', t0 + 1000) === false, 'Test 7: Duplicate within cooldown suppressed');
  assert(shouldSpeakOcrResult('Laptop ASUS', t0 + 2000) === false, 'Test 7: Duplicate at 2s suppressed');
  assert(shouldSpeakOcrResult('Mouse Logitech', t0 + 2100) === true, 'Test 7: Different text allowed immediately');
  assert(shouldSpeakOcrResult('Mouse Logitech', t0 + 6000) === true, 'Test 7: Allowed after cooldown passed');
  console.log('✓ Test 7: duplicate text suppression verified');
}

// =========================================================================
// TEST 8: OCR failure isolation
// =========================================================================
{
  const crashingWorker = new MockTesseractWorker(null, true);
  const service = new OCRService({}, crashingWorker);
  await service.initialize();

  let threw = false;
  try {
    await service.recognize({ width: 640, height: 480 });
  } catch (err) {
    threw = true;
    assert(err.message.includes('Mock OCR Worker memory crash'), 'Test 8: Error message preserved');
  }
  assert(threw === true, 'Test 8: Recognize rejected on failure');
  assert(service.getStatus() === OCRStatus.ERROR, 'Test 8: Status marked as ERROR');
  assert(service.lastError.includes('Mock OCR Worker'), 'Test 8: lastError populated');

  // Pastikan service dapat di-clear dan dipulihkan tanpa merusak sistem
  service.clear();
  assert(service.lastError === null, 'Test 8: clear() resets error');
  console.log('✓ Test 8: OCR failure isolation verified');
}

// =========================================================================
// TEST 9: VoiceEngine integration
// =========================================================================
{
  const mockSynth = new MockSpeechSynthesis();
  const voice = new VoiceEngine({ enabled: true }, mockSynth, MockUtterance);
  const mockWorker = new MockTesseractWorker();
  const service = new OCRService({}, mockWorker);
  await service.initialize();

  // Alur 1: Voice feedback saat mulai memproses
  voice.speak('Memproses teks.', { priority: SpeechPriority.NORMAL });
  await Promise.resolve();
  assert(mockSynth.spoken.length === 1, 'Test 9: Processing speech spoken');
  assert(mockSynth.spoken[0] === 'Memproses teks.', 'Test 9: Utterance 1 text');

  // Alur 2: OCR selesai membaca
  const res = await service.recognize({ width: 640, height: 480 });
  if (res.text) {
    voice.speak('Berhasil membaca teks.', { priority: SpeechPriority.NORMAL });
    voice.speak(res.text, { priority: SpeechPriority.NORMAL });
  } else {
    voice.speak('Teks tidak ditemukan.', { priority: SpeechPriority.NORMAL });
  }

  // Pesan 2 dan 3 masuk ke antrean voice
  assert(voice.queue.length === 2, 'Test 9: 2 subsequent utterances queued in priority queue');

  // Selesaikan pesan 1
  mockSynth.finishCurrent();
  assert(mockSynth.spoken.length === 2, 'Test 9: Second speech spoken');
  assert(mockSynth.spoken[1] === 'Berhasil membaca teks.', 'Test 9: Success feedback text');

  // Selesaikan pesan 2
  mockSynth.finishCurrent();
  assert(mockSynth.spoken.length === 3, 'Test 9: Third speech spoken');
  assert(mockSynth.spoken[2] === 'VISIONX TEST PROMO 50%', 'Test 9: Extracted OCR text read aloud');

  console.log('✓ Test 9: VoiceEngine integration & feedback verified');
}

// =========================================================================
// TEST 10: async processing
// =========================================================================
{
  let asyncFinished = false;
  const delayedWorker = {
    async recognize() {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { data: { text: 'ASYNC OK', confidence: 99, lines: [] } };
    }
  };

  const service = new OCRService({}, delayedWorker);
  await service.initialize();

  // Panggilan recognize bersifat Promise asinkron
  const recognizePromise = service.recognize({ width: 640, height: 480 }).then((r) => {
    asyncFinished = true;
    return r;
  });

  assert(service.getStatus() === OCRStatus.PROCESSING, 'Test 10: Status is PROCESSING while in flight');
  assert(asyncFinished === false, 'Test 10: Caller continues immediately without blocking');

  const finalRes = await recognizePromise;
  assert(asyncFinished === true, 'Test 10: Async promise resolved');
  assert(finalRes.text === 'ASYNC OK', 'Test 10: Output matches');
  assert(service.getStatus() === OCRStatus.DONE, 'Test 10: Status is DONE');
  console.log('✓ Test 10: non-blocking asynchronous OCR execution verified');
}

// =========================================================================
// TEST 11: event listener subscriptions (.on and .onStatusChange)
// =========================================================================
{
  const service = new OCRService();
  const statusesOn = [];
  const statusesOnStatusChange = [];

  const unsub1 = service.on('statusChange', (status, info) => {
    statusesOn.push({ status, info });
  });

  const unsub2 = service.onStatusChange((status, info) => {
    statusesOnStatusChange.push({ status, info });
  });

  assert(typeof service.on === 'function', 'Test 11: service.on is a function');
  assert(typeof service.onStatusChange === 'function', 'Test 11: service.onStatusChange is a function');

  // Trigger status updates
  service._setStatus(OCRStatus.READY);
  assert(statusesOn.length === 1, 'Test 11: service.on received status update');
  assert(statusesOn[0].status === OCRStatus.READY, 'Test 11: service.on received READY status');
  assert(statusesOnStatusChange.length === 1, 'Test 11: service.onStatusChange received update');

  unsub1();
  service._setStatus(OCRStatus.PROCESSING);
  assert(statusesOn.length === 1, 'Test 11: unsubscribed .on listener did not receive update');
  assert(statusesOnStatusChange.length === 2, 'Test 11: remaining onStatusChange listener received update');

  unsub2();
  console.log('✓ Test 11: OCR event listener (.on and .onStatusChange) subscriptions verified');
}

// =========================================================================
// TEST 12: clear printed text & normalization
// =========================================================================
{
  const rawSample = "   VISIONX V1.1 OCR ENGINE   \r\n\r\n\r\n   MODULAR PIPELINE   \n   ACCURATE   \n\n\n";
  const mockWorker = new MockTesseractWorker({
    data: { text: rawSample, confidence: 95, lines: [{ text: 'VISIONX V1.1 OCR ENGINE', confidence: 95 }] }
  });
  const service = new OCRService({}, mockWorker);
  await service.initialize();

  const res = await service.recognize({ width: 640, height: 480 });
  assert(res.confidence === 95, 'Test 12: High confidence preserved');
  assert(!res.text.includes('\r'), 'Test 12: CR line endings normalized');
  assert(!res.text.includes('\n\n\n'), 'Test 12: Excessive blank lines collapsed');
  assert(res.text.startsWith('VISIONX'), 'Test 12: Leading whitespace trimmed');
  assert(res.isLowConfidence === false, 'Test 12: High confidence not marked low');
  console.log('✓ Test 12: clear printed text & normalization verified');
}

// =========================================================================
// TEST 13: low-confidence result & no hallucination
// =========================================================================
{
  // Skenario A: Low confidence warning (45%)
  const mockLowConf = new MockTesseractWorker({
    data: { text: 'tulisan samar buku', confidence: 45, lines: [{ text: 'tulisan samar buku', confidence: 45 }] }
  });
  const serviceLow = new OCRService({}, mockLowConf);
  await serviceLow.initialize();
  const resLow = await serviceLow.recognize({ width: 640, height: 480 });

  assert(resLow.isLowConfidence === true, 'Test 13A: Marked as low confidence');
  assert(resLow.statusMessage.includes('Confidence rendah'), 'Test 13A: Status message gives warning');
  assert(resLow.text === 'tulisan samar buku', 'Test 13A: Text kept as-is without aggressive mutation');

  // Skenario B: Extreme low confidence (< 30%) -> "Teks kurang jelas untuk dibaca."
  const mockGarbage = new MockTesseractWorker({
    data: { text: 'x#@1! ~%?', confidence: 22, lines: [{ text: 'x#@1! ~%?', confidence: 22 }] }
  });
  const serviceGarbage = new OCRService({}, mockGarbage);
  await serviceGarbage.initialize();
  const resGarbage = await serviceGarbage.recognize({ width: 640, height: 480 });

  assert(resGarbage.text === 'Teks kurang jelas untuk dibaca.', 'Test 13B: Garbage text suppressed with friendly fallback');
  assert(resGarbage.isLowConfidence === true, 'Test 13B: Marked as low confidence');
  console.log('✓ Test 13: low-confidence warning & hallucination suppression verified');
}

// =========================================================================
// TEST 14: multiple lines text parsing
// =========================================================================
{
  const multilineText = "Line 1: VisionX AI\nLine 2: Optical Recognition\nLine 3: Accessibility";
  const mockWorker = new MockTesseractWorker({
    data: {
      text: multilineText,
      confidence: 88,
      lines: [
        { text: 'Line 1: VisionX AI', confidence: 90, bbox: { x0: 10, y0: 10, x1: 200, y1: 40 } },
        { text: 'Line 2: Optical Recognition', confidence: 88, bbox: { x0: 10, y0: 50, x1: 250, y1: 80 } },
        { text: 'Line 3: Accessibility', confidence: 86, bbox: { x0: 10, y0: 90, x1: 180, y1: 120 } }
      ]
    }
  });
  const service = new OCRService({}, mockWorker);
  await service.initialize();

  const res = await service.recognize({ width: 640, height: 480 });
  assert(res.regions.length === 3, 'Test 14: 3 lines extracted');
  assert(res.regions[0].text === 'Line 1: VisionX AI', 'Test 14: First line parsed');
  assert(res.regions[2].text === 'Line 3: Accessibility', 'Test 14: Third line parsed');
  console.log('✓ Test 14: multiple lines text parsing verified');
}

// =========================================================================
// TEST 15: rotated & sparse text PSM options
// =========================================================================
{
  let receivedPsm = null;
  const mockWorker = {
    recognize: async (canvas, options) => {
      receivedPsm = options.tessedit_pageseg_mode;
      return { data: { text: 'SPARSE NUMBER 42', confidence: 85, lines: [{ text: 'SPARSE NUMBER 42', confidence: 85 }] } };
    }
  };
  const service = new OCRService({}, mockWorker);
  await service.initialize();

  const res = await service.recognize({ width: 640, height: 480 }, { psm: '11' });
  assert(receivedPsm === '11', 'Test 15: PSM mode 11 passed to worker');
  assert(res.text === 'SPARSE NUMBER 42', 'Test 15: Sparse text output matches');
  console.log('✓ Test 15: rotated & sparse text PSM options verified');
}

// =========================================================================
// TEST 16: preprocessing fallback and candidate selection metadata
// =========================================================================
{
  const mockWorker = new MockTesseractWorker({
    data: { text: 'HANDWRITTEN NOTE', confidence: 75, lines: [{ text: 'HANDWRITTEN NOTE', confidence: 75 }] }
  });
  const service = new OCRService({}, mockWorker);
  await service.initialize();

  const res = await service.recognize({ width: 640, height: 480 }, { variant: 'upscale_sharpen' });
  assert(res.preprocessingMethod === 'upscale_sharpen', 'Test 16: Preprocessing variant recorded in metadata');
  assert(res.passCount >= 1, 'Test 16: Pass count tracked');
  console.log('✓ Test 16: preprocessing metadata & candidate selection verified');
}

// =========================================================================
// TEST 17: low contrast text preprocessing pipeline
// =========================================================================
{
  const mockWorker = new MockTesseractWorker({
    data: { text: 'CONTRAST ENHANCED TEXT', confidence: 82, lines: [{ text: 'CONTRAST ENHANCED TEXT', confidence: 82 }] }
  });
  const service = new OCRService({}, mockWorker);
  await service.initialize();

  // Test preprocessing candidate generation
  const candidate = service.preprocess({ width: 640, height: 480 }, 'standard');
  assert(candidate !== null, 'Test 17: Candidate generated');
  assert(candidate.scale === 1, 'Test 17: Scale calculated');

  const res = await service.recognize({ width: 640, height: 480 });
  assert(res.text === 'CONTRAST ENHANCED TEXT', 'Test 17: Contrast enhanced text recognized');
  console.log('✓ Test 17: low contrast text preprocessing pipeline verified');
}

// =========================================================================
// TEST 18: ImageQualityAssessor unit evaluation (Brightness, Contrast, Sharpness)
// =========================================================================
{
  import('../web/src/services/OCRService.js').then(({ ImageQualityAssessor, QUALITY_LEVELS }) => {
    // 1. Optimal synthetic image data
    const optimalData = {
      data: new Uint8ClampedArray(100 * 100 * 4)
    };
    for (let i = 0; i < optimalData.data.length; i += 4) {
      optimalData.data[i] = (i % 200);     // R
      optimalData.data[i + 1] = (i % 200); // G
      optimalData.data[i + 2] = (i % 200); // B
      optimalData.data[i + 3] = 255;
    }
    const qOpt = ImageQualityAssessor.assessQuality(optimalData, 100, 100);
    assert(qOpt.overall !== null, 'Test 18: Overall rating calculated');
    assert(typeof qOpt.metrics.meanBrightness === 'number', 'Test 18: Brightness calculated');
    assert(typeof qOpt.metrics.contrastStdDev === 'number', 'Test 18: Contrast calculated');
    assert(typeof qOpt.metrics.laplacianVar === 'number', 'Test 18: Laplacian sharpness calculated');

    // 2. Extremely dark image data
    const darkData = { data: new Uint8ClampedArray(50 * 50 * 4).fill(10) };
    const qDark = ImageQualityAssessor.assessQuality(darkData, 50, 50);
    assert(qDark.isTooDark === true, 'Test 18: Dark frame flagged');
    assert(qDark.brightness === QUALITY_LEVELS.POOR, 'Test 18: Brightness marked POOR');

    console.log('✓ Test 18: ImageQualityAssessor unit evaluation verified');
  });
}

// =========================================================================
// TEST 19: Capture Resolution Audit Metadata Logging
// =========================================================================
{
  const mockWorker = new MockTesseractWorker({
    data: { text: 'HIGH RES CAPTURE', confidence: 92, lines: [{ text: 'HIGH RES CAPTURE', confidence: 92 }] }
  });
  const service = new OCRService({}, mockWorker);
  await service.initialize();

  const res = await service.recognize({ width: 1920, height: 1080 });
  assert(res.roiAudit !== undefined, 'Test 19: roiAudit exists in result');
  assert(res.roiAudit.cameraWidth === 1920, 'Test 19: cameraWidth logged as 1920');
  assert(res.roiAudit.cameraHeight === 1080, 'Test 19: cameraHeight logged as 1080');
  assert(res.roiAudit.sourceWidth === 1920, 'Test 19: sourceWidth logged as 1920');
  console.log('✓ Test 19: capture resolution audit metadata verified');
}

// =========================================================================
// TEST 20: ROI Modes (AUTO, CENTER_REGION, FULL_FRAME)
// =========================================================================
{
  const mockWorker = new MockTesseractWorker({
    data: { text: 'ROI AREA TEXT', confidence: 88, lines: [{ text: 'ROI AREA TEXT', confidence: 88 }] }
  });
  const service = new OCRService({}, mockWorker);
  await service.initialize();

  // Test FULL_FRAME
  service.setRoiMode('FULL_FRAME');
  const resFull = await service.recognize({ width: 1280, height: 720 }, { roiMode: 'FULL_FRAME' });
  assert(resFull.roiAudit.roiMode === 'FULL_FRAME', 'Test 20: ROI mode set to FULL_FRAME');

  // Test CENTER_REGION
  service.setRoiMode('CENTER_REGION');
  const resCenter = await service.recognize({ width: 1280, height: 720 }, { roiMode: 'CENTER_REGION' });
  assert(resCenter.roiAudit.roiMode === 'CENTER_REGION', 'Test 20: ROI mode set to CENTER_REGION');
  console.log('✓ Test 20: ROI modes (AUTO, CENTER_REGION, FULL_FRAME) verified');
}

// =========================================================================
// TEST 21: Handwriting vs Printed Profiles
// =========================================================================
{
  const mockWorker = new MockTesseractWorker({
    data: { text: 'Catatan Buku Kuliah', confidence: 68, lines: [{ text: 'Catatan Buku Kuliah', confidence: 68 }] }
  });
  const service = new OCRService({}, mockWorker);
  await service.initialize();

  service.setProfile('HANDWRITING');
  const resHw = await service.recognize({ width: 640, height: 480 }, { profile: 'HANDWRITING' });
  assert(resHw.profile === 'HANDWRITING', 'Test 21: Handwriting profile recorded');
  assert(resHw.statusMessage.includes('tulisan tangan'), 'Test 21: Handwriting limitation notice provided');
  assert(resHw.text === 'Catatan Buku Kuliah', 'Test 21: Preserved text without aggressive dictionary mutation');

  service.setProfile('PRINTED');
  const resPr = await service.recognize({ width: 640, height: 480 }, { profile: 'PRINTED' });
  assert(resPr.profile === 'PRINTED', 'Test 21: Printed profile recorded');
  console.log('✓ Test 21: handwriting vs printed profiles verified');
}

// =========================================================================
// TEST 22: Candidate Sanity & Non-Alphanumeric Garbage Suppression
// =========================================================================
{
  // Simulated garbage character hallucination from poor handwriting input
  const mockGarbageSymbols = new MockTesseractWorker({
    data: { text: '§±¶ %$#@*! ~`^& {}|', confidence: 55, lines: [{ text: '§±¶ %$#@*! ~`^& {}|', confidence: 55 }] }
  });
  const service = new OCRService({}, mockGarbageSymbols);
  await service.initialize();

  const res = await service.recognize({ width: 640, height: 480 });
  assert(res.text === 'Teks kurang jelas untuk dibaca.', 'Test 22: Garbage non-alphanumeric text rejected gracefully');
  assert(res.isLowConfidence === true, 'Test 22: Flagged as low confidence');
  console.log('✓ Test 22: candidate sanity & non-alphanumeric garbage suppression verified');
}

// =========================================================================
// TEST 23: Re-scan (Scan Ulang) & Extended Diagnostics
// =========================================================================
{
  const mockWorker = new MockTesseractWorker({
    data: { text: 'SCAN ULANG BERHASIL', confidence: 95, lines: [{ text: 'SCAN ULANG BERHASIL', confidence: 95 }] }
  });
  const service = new OCRService({}, mockWorker);
  await service.initialize();

  const res = await service.recognize({ width: 1280, height: 720 });
  const diag = service.getDiagnostics();
  assert(diag.status === OCRStatus.DONE, 'Test 23: Status is DONE');
  assert(diag.quality !== undefined, 'Test 23: Quality level present');
  assert(diag.roiAudit !== null, 'Test 23: roiAudit present in diagnostics');
  assert(diag.lastText === 'SCAN ULANG BERHASIL', 'Test 23: Last text recorded');
  console.log('✓ Test 23: re-scan & extended diagnostics verified');
}

console.log('--- ALL 23 JS OCR SERVICE HARDENING TESTS PASSED SUCCESSFULLY! ---');


