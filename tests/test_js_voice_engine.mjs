/**
 * test_js_voice_engine.mjs - Automated Unit & Regression Tests for VisionX V0.8 Voice Assistant Engine
 *
 * Verifikasi 12 Skenario Inti Sesuai Spesifikasi:
 * 1. speak
 * 2. queue
 * 3. stop
 * 4. clear queue
 * 5. enable/disable
 * 6. cooldown
 * 7. duplicate suppression
 * 8. object entered event
 * 9. object returned event
 * 10. multiple objects batching
 * 11. priority queue
 * 12. voice failure isolation
 */

import { VoiceEngine, SpeechPriority, VoiceMode, VoiceState } from '../web/src/services/VoiceEngine.js';
import { EventEngine, ObjectEventType } from '../web/src/services/EventEngine.js';
import { MessageFormatter } from '../web/src/services/MessageFormatter.js';

function assert(condition, message) {
  if (!condition) {
    throw new Error(`[FAIL] ${message}`);
  }
}

/**
 * Mock SpeechSynthesis dan SpeechSynthesisUtterance untuk pengujian deterministik di Node.js
 */
class MockUtterance {
  constructor(text) {
    this.text = text;
    this.volume = 1.0;
    this.rate = 1.0;
    this.pitch = 1.0;
    this.lang = 'id-ID';
    this.onend = null;
    this.onerror = null;
  }
}

class MockSpeechSynthesis {
  constructor() {
    this.spokenUtterances = [];
    this.currentUtterance = null;
    this.isCanceled = false;
    this.isPaused = false;
  }

  speak(utterance) {
    this.spokenUtterances.push(utterance);
    this.currentUtterance = utterance;
  }

  cancel() {
    this.isCanceled = true;
    if (this.currentUtterance && this.currentUtterance.onerror) {
      this.currentUtterance.onerror({ error: 'canceled' });
    }
    this.currentUtterance = null;
  }

  pause() {
    this.isPaused = true;
  }

  resume() {
    this.isPaused = false;
  }

  getVoices() {
    return [
      { name: 'Indonesian Male', lang: 'id-ID' },
      { name: 'Google Bahasa Indonesia', lang: 'id-ID' }
    ];
  }

  // Helper pengujian: selesaikan utterance yang sedang aktif
  finishCurrent() {
    if (this.currentUtterance && this.currentUtterance.onend) {
      const u = this.currentUtterance;
      this.currentUtterance = null;
      u.onend();
    }
  }
}

console.log('--- Running JS Voice Assistant Engine V0.8 Automated Tests ---');

// =========================================================================
// TEST 1: speak
// =========================================================================
{
  const mockSynth = new MockSpeechSynthesis();
  const engine = new VoiceEngine({ enabled: true }, mockSynth, MockUtterance);

  assert(engine.isAvailable === true, 'Test 1: VoiceEngine is available');
  assert(engine.state === VoiceState.READY, 'Test 1: Initial state is READY');

  const success = engine.speak('Laptop terdeteksi.');
  assert(success === true, 'Test 1: speak() returns true');

  // Async queue processing
  await Promise.resolve();

  assert(mockSynth.spokenUtterances.length === 1, 'Test 1: Synth called speak once');
  assert(mockSynth.spokenUtterances[0].text === 'Laptop terdeteksi.', 'Test 1: Utterance text matches');
  assert(engine.state === VoiceState.SPEAKING, 'Test 1: State is SPEAKING');
  assert(engine.lastMessage === 'Laptop terdeteksi.', 'Test 1: lastMessage updated');

  mockSynth.finishCurrent();
  assert(engine.state === VoiceState.READY, 'Test 1: State returns to READY after finish');
  console.log('✓ Test 1: speak functionality verified');
}

// =========================================================================
// TEST 2: queue
// =========================================================================
{
  const mockSynth = new MockSpeechSynthesis();
  const engine = new VoiceEngine({ enabled: true }, mockSynth, MockUtterance);

  engine.speak('Pesan pertama.');
  engine.speak('Pesan kedua.');
  engine.speak('Pesan ketiga.');

  await Promise.resolve();

  // Pesan pertama sedang berbicara, sisa 2 di antrean
  assert(engine.isSpeaking === true, 'Test 2: Engine is currently speaking');
  assert(engine.queue.length === 2, 'Test 2: Queue has 2 pending items');
  assert(mockSynth.spokenUtterances.length === 1, 'Test 2: Only first utterance spoken so far');
  assert(mockSynth.spokenUtterances[0].text === 'Pesan pertama.', 'Test 2: First utterance text');

  // Selesaikan pesan 1
  mockSynth.finishCurrent();
  assert(mockSynth.spokenUtterances.length === 2, 'Test 2: Second utterance spoken');
  assert(mockSynth.spokenUtterances[1].text === 'Pesan kedua.', 'Test 2: Second utterance text');
  assert(engine.queue.length === 1, 'Test 2: Queue has 1 pending item');

  // Selesaikan pesan 2
  mockSynth.finishCurrent();
  assert(mockSynth.spokenUtterances.length === 3, 'Test 2: Third utterance spoken');
  assert(mockSynth.spokenUtterances[2].text === 'Pesan ketiga.', 'Test 2: Third utterance text');
  assert(engine.queue.length === 0, 'Test 2: Queue is now empty');

  // Selesaikan pesan 3
  mockSynth.finishCurrent();
  assert(engine.isSpeaking === false, 'Test 2: Engine finished speaking');
  assert(engine.state === VoiceState.READY, 'Test 2: State is READY');
  console.log('✓ Test 2: Sequential queue processing verified');
}

// =========================================================================
// TEST 3: stop
// =========================================================================
{
  const mockSynth = new MockSpeechSynthesis();
  const engine = new VoiceEngine({ enabled: true }, mockSynth, MockUtterance);

  engine.speak('Pesan aktif.');
  engine.speak('Pesan antrean.');
  await Promise.resolve();

  assert(engine.isSpeaking === true, 'Test 3: Speaking before stop');
  assert(engine.queue.length === 1, 'Test 3: Queue has 1 item before stop');

  engine.stop();

  assert(mockSynth.isCanceled === true, 'Test 3: Synth cancel was called');
  assert(engine.isSpeaking === false, 'Test 3: isSpeaking reset to false');
  assert(engine.queue.length === 0, 'Test 3: Queue cleared on stop');
  assert(engine.state === VoiceState.READY, 'Test 3: State reset to READY');
  console.log('✓ Test 3: stop interrupts speech & clears queue');
}

// =========================================================================
// TEST 4: clear queue
// =========================================================================
{
  const mockSynth = new MockSpeechSynthesis();
  const engine = new VoiceEngine({ enabled: true }, mockSynth, MockUtterance);

  engine.speak('Pesan aktif yang sedang berlangsung.');
  engine.speak('Antrean 1.');
  engine.speak('Antrean 2.');
  await Promise.resolve();

  assert(engine.queue.length === 2, 'Test 4: Queue initially has 2 items');
  engine.clearQueue();

  assert(engine.queue.length === 0, 'Test 4: clearQueue emptied the queue');
  assert(engine.isSpeaking === true, 'Test 4: Active speech is untouched by clearQueue');

  mockSynth.finishCurrent();
  assert(engine.isSpeaking === false, 'Test 4: Finished after active speech completed');
  assert(mockSynth.spokenUtterances.length === 1, 'Test 4: No queued items were spoken');
  console.log('✓ Test 4: clearQueue leaves active speech intact and purges pending');
}

// =========================================================================
// TEST 5: enable/disable
// =========================================================================
{
  const mockSynth = new MockSpeechSynthesis();
  const engine = new VoiceEngine({ enabled: true }, mockSynth, MockUtterance);

  engine.speak('Pesan 1.');
  await Promise.resolve();
  assert(engine.isSpeaking === true, 'Test 5: Speaking initially');

  engine.setEnabled(false);
  assert(engine.config.enabled === false, 'Test 5: config.enabled is false');
  assert(engine.state === VoiceState.DISABLED, 'Test 5: state is DISABLED');
  assert(engine.isSpeaking === false, 'Test 5: Speaking canceled when disabled');

  const speakResult = engine.speak('Pesan ditolak.');
  assert(speakResult === false, 'Test 5: speak() rejected while disabled');
  await Promise.resolve();
  assert(mockSynth.spokenUtterances.length === 1, 'Test 5: No new utterances spoken');

  engine.setEnabled(true);
  assert(engine.config.enabled === true, 'Test 5: config.enabled restored');
  assert(engine.state === VoiceState.READY, 'Test 5: state is READY');

  engine.speak('Pesan diterima kembali.');
  await Promise.resolve();
  assert(mockSynth.spokenUtterances.length === 2, 'Test 5: Utterance accepted when re-enabled');
  mockSynth.finishCurrent();
  console.log('✓ Test 5: enable/disable toggling verified');
}

// =========================================================================
// TEST 6: cooldown
// =========================================================================
{
  const mockSynth = new MockSpeechSynthesis();
  const voice = new VoiceEngine({ enabled: true }, mockSynth, MockUtterance);
  const eventEngine = new EventEngine(voice, { cooldownMs: 5000, batchWindowMs: 0 });

  const t0 = 100000;
  // Frame 1: Objek terkonfirmasi masuk
  eventEngine.processTracks([{ trackId: 1, className: 'laptop', state: 'confirmed', missedFrames: 0 }], t0);
  await Promise.resolve();
  assert(mockSynth.spokenUtterances.length === 1, 'Test 6: First announcement made');
  assert(mockSynth.spokenUtterances[0].text === 'Laptop terdeteksi.', 'Test 6: First text matches');
  mockSynth.finishCurrent();

  // Objek hilang pada t0 + 1000
  eventEngine.processTracks([{ trackId: 1, className: 'laptop', state: 'lost', missedFrames: 1 }], t0 + 1000);

  // Objek kembali pada t0 + 2000 (baru 2 detik, padahal cooldown 5 detik)
  eventEngine.processTracks([{ trackId: 1, className: 'laptop', state: 'confirmed', missedFrames: 0 }], t0 + 2000);
  await Promise.resolve();
  assert(mockSynth.spokenUtterances.length === 1, 'Test 6: Announcement suppressed within 5s cooldown');

  // Objek kembali lagi pada t0 + 6000 (sudah 6 detik, melewati cooldown 5s)
  eventEngine.processTracks([{ trackId: 1, className: 'laptop', state: 'lost', missedFrames: 1 }], t0 + 4000);
  eventEngine.processTracks([{ trackId: 1, className: 'laptop', state: 'confirmed', missedFrames: 0 }], t0 + 6001);
  await Promise.resolve();
  assert(mockSynth.spokenUtterances.length === 2, 'Test 6: Announcement allowed after cooldown expired');
  assert(mockSynth.spokenUtterances[1].text === 'Laptop kembali terdeteksi.', 'Test 6: Return text matches');
  mockSynth.finishCurrent();
  console.log('✓ Test 6: 5-second announcement cooldown verified');
}

// =========================================================================
// TEST 7: duplicate suppression
// =========================================================================
{
  const mockSynth = new MockSpeechSynthesis();
  const voice = new VoiceEngine({ enabled: true }, mockSynth, MockUtterance);
  const eventEngine = new EventEngine(voice, { cooldownMs: 5000, batchWindowMs: 0 });

  let time = 1000;
  // Frame 1: Laptop #01 terdeteksi
  eventEngine.processTracks([{ trackId: 1, className: 'laptop', state: 'confirmed', missedFrames: 0 }], time);
  await Promise.resolve();
  assert(mockSynth.spokenUtterances.length === 1, 'Test 7: Laptop announced on first appearance');
  mockSynth.finishCurrent();

  // Frame 2 sampai 100: Laptop #01 tetap terlihat di setiap frame
  for (let frame = 2; frame <= 100; frame++) {
    time += 33; // ~30 fps
    eventEngine.processTracks([{ trackId: 1, className: 'laptop', state: 'confirmed', missedFrames: 0 }], time);
  }
  await Promise.resolve();

  // Tetap HANYA 1 kali ucapan, JANGAN diulang di 100 frame
  assert(mockSynth.spokenUtterances.length === 1, 'Test 7: Absolutely no duplicate speech across 100 frames');
  console.log('✓ Test 7: Duplicate suppression across 100 frames verified');
}

// =========================================================================
// TEST 8: object entered event
// =========================================================================
{
  const mockSynth = new MockSpeechSynthesis();
  const voice = new VoiceEngine({ enabled: true }, mockSynth, MockUtterance);
  const eventEngine = new EventEngine(voice, { batchWindowMs: 0 });

  let recordedEvent = null;
  eventEngine.onEvent((ev) => {
    if (ev.type === ObjectEventType.OBJECT_ENTERED) {
      recordedEvent = ev;
    }
  });

  eventEngine.processTracks([{ trackId: 4, className: 'bottle', state: 'confirmed', missedFrames: 0 }], 2000);
  await Promise.resolve();

  assert(recordedEvent !== null, 'Test 8: OBJECT_ENTERED event emitted');
  assert(recordedEvent.trackId === 4, 'Test 8: Event trackId matches 4');
  assert(recordedEvent.className === 'bottle', 'Test 8: Event className is bottle');
  assert(mockSynth.spokenUtterances.length === 1, 'Test 8: Voice synthesis triggered');
  assert(mockSynth.spokenUtterances[0].text === 'Botol terdeteksi.', 'Test 8: Translated to Indonesian "Botol terdeteksi."');
  mockSynth.finishCurrent();
  console.log('✓ Test 8: OBJECT_ENTERED event & Indonesian translation verified');
}

// =========================================================================
// TEST 9: object returned event
// =========================================================================
{
  const mockSynth = new MockSpeechSynthesis();
  const voice = new VoiceEngine({ enabled: true }, mockSynth, MockUtterance);
  const eventEngine = new EventEngine(voice, { cooldownMs: 5000, batchWindowMs: 0 });

  let returnEvent = null;
  eventEngine.onEvent((ev) => {
    if (ev.type === ObjectEventType.OBJECT_RETURNED) {
      returnEvent = ev;
    }
  });

  const t0 = 50000;
  // Muncul pertama
  eventEngine.processTracks([{ trackId: 2, className: 'mouse', state: 'confirmed', missedFrames: 0 }], t0);
  await Promise.resolve();
  mockSynth.finishCurrent();

  // Hilang
  eventEngine.processTracks([{ trackId: 2, className: 'mouse', state: 'lost', missedFrames: 2 }], t0 + 1000);

  // Kembali setelah 6 detik
  eventEngine.processTracks([{ trackId: 2, className: 'mouse', state: 'confirmed', missedFrames: 0 }], t0 + 7000);
  await Promise.resolve();

  assert(returnEvent !== null, 'Test 9: OBJECT_RETURNED event emitted');
  assert(returnEvent.trackId === 2, 'Test 9: Track ID matches 2');
  assert(returnEvent.className === 'mouse', 'Test 9: Class name is mouse');
  assert(mockSynth.spokenUtterances[1].text === 'Mouse kembali terdeteksi.', 'Test 9: Spoken "Mouse kembali terdeteksi."');
  mockSynth.finishCurrent();
  console.log('✓ Test 9: OBJECT_RETURNED event verified');
}

// =========================================================================
// TEST 10: multiple objects batching
// =========================================================================
{
  const mockSynth = new MockSpeechSynthesis();
  const voice = new VoiceEngine({ enabled: true }, mockSynth, MockUtterance);
  const eventEngine = new EventEngine(voice, { batchWindowMs: 0 });

  // 3 objek masuk bersamaan dalam satu frame
  const multipleTracks = [
    { trackId: 10, className: 'laptop', state: 'confirmed', missedFrames: 0 },
    { trackId: 11, className: 'mouse', state: 'confirmed', missedFrames: 0 },
    { trackId: 12, className: 'bottle', state: 'confirmed', missedFrames: 0 }
  ];

  eventEngine.processTracks(multipleTracks, 10000);
  await Promise.resolve();

  assert(mockSynth.spokenUtterances.length === 1, 'Test 10: Exactly 1 batched utterance instead of 3 separate speeches');
  const spokenText = mockSynth.spokenUtterances[0].text;
  assert(
    spokenText === '3 objek terdeteksi: laptop, mouse, dan botol.',
    `Test 10: Batched text exact match: "${spokenText}"`
  );
  mockSynth.finishCurrent();

  // Uji formatting 2 objek
  const pairText = MessageFormatter.formatMultipleObjects(['laptop', 'mouse']);
  assert(pairText === '2 objek terdeteksi: laptop dan mouse.', 'Test 10: 2 objects formatting');

  console.log('✓ Test 10: Multiple objects batching into natural sentence verified');
}

// =========================================================================
// TEST 11: priority queue
// =========================================================================
{
  const mockSynth = new MockSpeechSynthesis();
  const engine = new VoiceEngine({ enabled: true }, mockSynth, MockUtterance);

  // Mulai pesan pertama (sedang berbicara)
  engine.speak('Pesan aktif awal.', { priority: SpeechPriority.NORMAL });
  await Promise.resolve();

  // Masukkan pesan-pesan ke antrean dengan urutan kedatangan: LOW -> NORMAL -> HIGH -> CRITICAL
  engine.speak('Pesan Low.', { priority: SpeechPriority.LOW });
  engine.speak('Pesan Normal.', { priority: SpeechPriority.NORMAL });
  engine.speak('Pesan High.', { priority: SpeechPriority.HIGH });

  // Periksa urutan di antrean internal
  assert(engine.queue.length === 3, 'Test 11: Queue has 3 items');
  assert(engine.queue[0].priority === SpeechPriority.HIGH, 'Test 11: HIGH priority moved to front of queue');
  assert(engine.queue[1].priority === SpeechPriority.NORMAL, 'Test 11: NORMAL priority in middle');
  assert(engine.queue[2].priority === SpeechPriority.LOW, 'Test 11: LOW priority at back');

  // Ketika CRITICAL masuk saat low/normal sedang berbicara, CRITICAL menyela ucapan
  engine.speak('BAHAYA CRITICAL!', { priority: SpeechPriority.CRITICAL });
  await Promise.resolve();

  // CRITICAL langsung diproses sebagai pesan berikutnya
  assert(engine.lastMessage === 'BAHAYA CRITICAL!', 'Test 11: CRITICAL immediately becomes active');
  console.log('✓ Test 11: Priority queue ordering (CRITICAL > HIGH > NORMAL > LOW) verified');
}

// =========================================================================
// TEST 12: voice failure isolation
// =========================================================================
{
  // Simulasikan browser tanpa Web Speech API (synth = null)
  const unavailableEngine = new VoiceEngine({ enabled: true }, null, null);

  assert(unavailableEngine.isAvailable === false, 'Test 12: Engine reports isAvailable = false');
  assert(unavailableEngine.state === VoiceState.UNAVAILABLE, 'Test 12: State is UNAVAILABLE');

  // Pemanggilan API tidak boleh throw error apapun
  let didThrow = false;
  try {
    const resSpeak = unavailableEngine.speak('Tes saat suara tidak ada.');
    assert(resSpeak === false, 'Test 12: speak() returns false without error');
    unavailableEngine.stop();
    unavailableEngine.pause();
    unavailableEngine.resume();
    unavailableEngine.clearQueue();
    unavailableEngine.setEnabled(false);
    unavailableEngine.setRate(1.5);
    unavailableEngine.setVolume(0.8);
    const voices = unavailableEngine.getVoices();
    assert(Array.isArray(voices) && voices.length === 0, 'Test 12: getVoices() returns empty array');
  } catch (err) {
    didThrow = true;
  }
  assert(didThrow === false, 'Test 12: No exceptions thrown when Web Speech API is absent');

  // Integrasi EventEngine dengan VoiceEngine yang unavailable: tracking & event tetap berjalan 100%
  const eventEngine = new EventEngine(unavailableEngine, { batchWindowMs: 0 });
  let events = [];
  try {
    events = eventEngine.processTracks([{ trackId: 99, className: 'laptop', state: 'confirmed', missedFrames: 0 }]);
  } catch (err) {
    assert(false, `Test 12: EventEngine threw error with unavailable voice: ${err.message}`);
  }
  assert(events.length === 1, 'Test 12: Tracking & detection events operate normally despite voice failure');
  console.log('✓ Test 12: Voice failure completely isolated from vision pipeline');
}

console.log('--- ALL 12 JS VOICE ASSISTANT TESTS PASSED SUCCESSFULLY! ---');
