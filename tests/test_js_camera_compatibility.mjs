/**
 * tests/test_js_camera_compatibility.mjs
 *
 * Automated Test Suite for VisionX Camera Compatibility Bugfix:
 *
 * Test 1: Desktop Chrome simulation -> Optimal constraint selection & facingMode 'user'
 * Test 2: Mobile device simulation -> Default facingMode 'environment'
 * Test 3: Multi-tier fallback execution:
 *         Tier 1 fails (OverconstrainedError) -> Gracefully succeeds on Tier 2 (640x480)
 * Test 4: Deep multi-tier fallback:
 *         Tier 1 & Tier 2 fail -> Gracefully succeeds on Tier 3 (any video stream)
 * Test 5: Insecure Context detection -> Throws SecurityError with actionable HTTPS instructions
 * Test 6: Permission Denied error classification -> category: PERMISSION_DENIED, actionable instructions, canRetry: true
 * Test 7: Camera Busy error classification (NotReadableError) -> category: CAMERA_BUSY, actionable instructions
 * Test 8: Device Not Found error classification (NotFoundError) -> category: DEVICE_NOT_FOUND, actionable instructions
 * Test 9: Video element attributes: playsinline, webkit-playsinline, and muted set for mobile Safari compatibility
 */

import { CameraService } from '../web/src/services/CameraService.js';

function assert(condition, message) {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${message}`);
    throw new Error(message);
  }
}

console.log('================================================================');
console.log('📷 Running VisionX Camera Compatibility Bugfix Tests');
console.log('================================================================\n');

let passedTests = 0;

// Mock Helper for navigator.mediaDevices
function createMockMediaDevices(options = {}) {
  const {
    tierToSucceed = 1,
    shouldDenyPermission = false,
    simulateBusy = false,
    simulateNotFound = false
  } = options;

  let attemptCount = 0;

  return {
    addEventListener: () => {},
    removeEventListener: () => {},
    enumerateDevices: async () => [
      { kind: 'videoinput', deviceId: 'cam-rear-01', label: 'Rear Camera (Back)' },
      { kind: 'videoinput', deviceId: 'cam-front-02', label: 'Front Camera (Selfie)' }
    ],
    getUserMedia: async (constraints) => {
      attemptCount++;

      if (shouldDenyPermission) {
        const err = new Error('Permission denied by user');
        err.name = 'NotAllowedError';
        throw err;
      }

      if (simulateBusy) {
        const err = new Error('Could not start video source (camera busy)');
        err.name = 'NotReadableError';
        throw err;
      }

      if (simulateNotFound) {
        const err = new Error('Requested device not found');
        err.name = 'NotFoundError';
        throw err;
      }

      // Check current tier based on constraints
      const isTier1 = constraints.video && constraints.video.width && constraints.video.width.ideal === 1280;
      const isTier2 = constraints.video && constraints.video.width && constraints.video.width.ideal === 640;
      const isTier3 = constraints.video === true;

      const currentTier = isTier1 ? 1 : isTier2 ? 2 : isTier3 ? 3 : 1;

      if (currentTier < tierToSucceed) {
        const err = new Error(`Constraint not satisfied for Tier ${currentTier}`);
        err.name = 'OverconstrainedError';
        throw err;
      }

      // Successful mock stream
      const track = {
        label: 'Mock Camera Track',
        kind: 'video',
        getSettings: () => ({
          width: isTier2 ? 640 : isTier1 ? 1280 : 320,
          height: isTier2 ? 480 : isTier1 ? 720 : 240
        }),
        stop: () => {}
      };

      return {
        getVideoTracks: () => [track],
        getTracks: () => [track]
      };
    },
    getAttemptCount: () => attemptCount
  };
}

function mockNavigator(props = {}) {
  Object.defineProperty(globalThis, 'navigator', {
    value: {
      userAgent: props.userAgent || '',
      maxTouchPoints: props.maxTouchPoints || 0,
      mediaDevices: props.mediaDevices || undefined
    },
    writable: true,
    configurable: true
  });
}

// -----------------------------------------------------------------------------
// Test 1: Desktop Chrome simulation -> Optimal constraint selection & facingMode 'user'
// -----------------------------------------------------------------------------
console.log('--- Test 1: Desktop Chrome constraint generation ---');
{
  // Simulate Desktop userAgent
  mockNavigator({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    maxTouchPoints: 0
  });

  const isMobile = CameraService.isMobileDevice();
  assert(isMobile === false, 'Desktop Chrome should NOT be flagged as mobile device');

  const tiers = CameraService.getConstraintTiers(null, { width: 1280, height: 720 });
  assert(tiers.length === 3, 'Should generate 3 constraint tiers');
  assert(tiers[0].constraints.video.facingMode.ideal === 'user', 'Desktop tier 1 default facingMode should be "user"');
  assert(tiers[0].constraints.video.width.ideal === 1280, 'Desktop tier 1 width should be 1280');

  console.log('✅ Test 1 Passed: Desktop Chrome selects ideal: "user" and 1280x720');
  passedTests++;
}

// -----------------------------------------------------------------------------
// Test 2: Mobile device simulation -> Default facingMode 'environment'
// -----------------------------------------------------------------------------
console.log('\n--- Test 2: Mobile device constraint generation ---');
{
  // Simulate Android Chrome userAgent
  mockNavigator({
    userAgent: 'Mozilla/5.0 (Linux; Android 13; SM-A536B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.144 Mobile Safari/537.36',
    maxTouchPoints: 5
  });

  const isMobile = CameraService.isMobileDevice();
  assert(isMobile === true, 'Android device should be recognized as mobile');

  const tiers = CameraService.getConstraintTiers(null, { width: 1280, height: 720 });
  assert(tiers[0].constraints.video.facingMode.ideal === 'environment', 'Mobile tier 1 default facingMode should be "environment"');
  assert(tiers[1].constraints.video.facingMode.ideal === 'environment', 'Mobile tier 2 facingMode should be "environment"');
  assert(tiers[1].constraints.video.width.ideal === 640, 'Mobile tier 2 width should be 640');

  console.log('✅ Test 2 Passed: Mobile device defaults to ideal: "environment" for rear camera');
  passedTests++;
}

// -----------------------------------------------------------------------------
// Test 3: Multi-tier fallback execution: Tier 1 fails -> Gracefully succeeds on Tier 2
// -----------------------------------------------------------------------------
console.log('\n--- Test 3: Multi-tier fallback: Tier 1 (1280x720) fails -> Tier 2 (640x480) succeeds ---');
{
  globalThis.window = {
    isSecureContext: true,
    location: { protocol: 'https:', hostname: 'app.visionx.ai', href: 'https://app.visionx.ai/' }
  };
  const mockMedia = createMockMediaDevices({ tierToSucceed: 2 });
  mockNavigator({ mediaDevices: mockMedia });

  const mockVideo = {
    setAttribute: (name, val) => {},
    srcObject: null,
    muted: false,
    play: async () => {}
  };

  const cameraService = new CameraService();
  cameraService.attachVideoElement(mockVideo);

  const stream = await cameraService.start();
  assert(stream !== null, 'Stream should be successfully opened via fallback');
  assert(cameraService.state.status === 'connected', 'Camera status should be connected');
  assert(cameraService.state.resolution.width === 640, `Resolution width should be 640 (got ${cameraService.state.resolution.width})`);
  assert(cameraService.state.resolution.height === 480, `Resolution height should be 480 (got ${cameraService.state.resolution.height})`);
  assert(mockMedia.getAttemptCount() === 2, `Should attempt exactly 2 tiers before succeeding (got ${mockMedia.getAttemptCount()})`);

  console.log('✅ Test 3 Passed: OverconstrainedError on Tier 1 successfully fell back to Tier 2 (640x480)');
  passedTests++;
}

// -----------------------------------------------------------------------------
// Test 4: Deep multi-tier fallback: Tier 1 & Tier 2 fail -> Gracefully succeeds on Tier 3
// -----------------------------------------------------------------------------
console.log('\n--- Test 4: Deep multi-tier fallback: Tier 1 & 2 fail -> Tier 3 ({ video: true }) succeeds ---');
{
  const mockMedia = createMockMediaDevices({ tierToSucceed: 3 });
  mockNavigator({ mediaDevices: mockMedia });

  const cameraService = new CameraService();
  const stream = await cameraService.start();
  assert(stream !== null, 'Stream should be successfully opened via Tier 3 fallback');
  assert(cameraService.state.status === 'connected', 'Camera status should be connected');
  assert(mockMedia.getAttemptCount() === 3, `Should attempt 3 tiers before succeeding (got ${mockMedia.getAttemptCount()})`);

  console.log('✅ Test 4 Passed: Strict device constraints gracefully degraded to Tier 3 minimal stream');
  passedTests++;
}

// -----------------------------------------------------------------------------
// Test 5: Insecure Context detection -> Throws SecurityError with actionable HTTPS instructions
// -----------------------------------------------------------------------------
console.log('\n--- Test 5: Insecure Context detection (HTTP on LAN IP) ---');
{
  globalThis.window = {
    isSecureContext: false,
    location: { protocol: 'http:', hostname: '192.168.1.105', href: 'http://192.168.1.105:5173/' }
  };

  const check = CameraService.checkSecureContext();
  assert(check.isSecure === false, 'LAN HTTP address must be flagged as insecure');
  assert(check.errorReason.includes('Insecure Context'), 'Error reason must clearly state Insecure Context');
  assert(check.actionableInstruction.includes('chrome://flags'), 'Instruction must provide actionable flags or tunnel advice');

  const cameraService = new CameraService();
  let threwExpected = false;
  try {
    await cameraService.start();
  } catch (err) {
    threwExpected = true;
    assert(err.name === 'SecurityError', `Error name should be SecurityError, got ${err.name}`);
    assert(err.category === 'INSECURE_CONTEXT', `Category should be INSECURE_CONTEXT, got ${err.category}`);
    assert(err.canRetry === false, 'Cannot simply retry insecure context without fixing URL/flags');
  }
  assert(threwExpected, 'Starting camera on insecure context must throw actionable SecurityError');

  console.log('✅ Test 5 Passed: Insecure Context accurately caught with clear HTTPS instructions');
  passedTests++;
}

// -----------------------------------------------------------------------------
// Test 6: Permission Denied error classification -> category: PERMISSION_DENIED
// -----------------------------------------------------------------------------
console.log('\n--- Test 6: Permission Denied actionable classification ---');
{
  globalThis.window = {
    isSecureContext: true,
    location: { protocol: 'https:', hostname: 'app.visionx.ai', href: 'https://app.visionx.ai/' }
  };
  mockNavigator({ mediaDevices: createMockMediaDevices({ shouldDenyPermission: true }) });

  const cameraService = new CameraService();
  let caughtError = null;
  try {
    await cameraService.start();
  } catch (err) {
    caughtError = err;
  }

  assert(caughtError !== null, 'Camera start must throw on permission denied');
  assert(caughtError.category === 'PERMISSION_DENIED', `Expected PERMISSION_DENIED, got ${caughtError.category}`);
  assert(caughtError.canRetry === true, 'Permission error should allow retry button');
  assert(caughtError.actionSuggestion.includes('Pengaturan'), 'Action suggestion must guide user on how to enable camera');
  assert(cameraService.state.permission === 'denied', 'CameraService state.permission must be set to denied');

  console.log('✅ Test 6 Passed: Permission Denied produces actionable guidance & enables retry');
  passedTests++;
}

// -----------------------------------------------------------------------------
// Test 7: Camera Busy error classification (NotReadableError)
// -----------------------------------------------------------------------------
console.log('\n--- Test 7: Camera Busy (NotReadableError) classification ---');
{
  mockNavigator({ mediaDevices: createMockMediaDevices({ simulateBusy: true }) });

  const cameraService = new CameraService();
  let caughtError = null;
  try {
    await cameraService.start();
  } catch (err) {
    caughtError = err;
  }

  assert(caughtError !== null, 'Camera start must throw on camera busy');
  assert(caughtError.category === 'CAMERA_BUSY', `Expected CAMERA_BUSY, got ${caughtError.category}`);
  assert(caughtError.actionSuggestion.includes('aplikasi lain'), 'Must advise closing other apps');

  console.log('✅ Test 7 Passed: NotReadableError classified as CAMERA_BUSY with app closing tip');
  passedTests++;
}

// -----------------------------------------------------------------------------
// Test 8: Device Not Found error classification (NotFoundError)
// -----------------------------------------------------------------------------
console.log('\n--- Test 8: Device Not Found (NotFoundError) classification ---');
{
  mockNavigator({ mediaDevices: createMockMediaDevices({ simulateNotFound: true }) });

  const cameraService = new CameraService();
  let caughtError = null;
  try {
    await cameraService.start();
  } catch (err) {
    caughtError = err;
  }

  assert(caughtError !== null, 'Camera start must throw on device not found');
  assert(caughtError.category === 'DEVICE_NOT_FOUND', `Expected DEVICE_NOT_FOUND, got ${caughtError.category}`);
  assert(caughtError.friendlyMessage.includes('tidak ditemukan'), 'Friendly message should state camera not found');

  console.log('✅ Test 8 Passed: NotFoundError classified as DEVICE_NOT_FOUND with hardware advice');
  passedTests++;
}

// -----------------------------------------------------------------------------
// Test 9: Video element attributes: playsinline, webkit-playsinline, and muted
// -----------------------------------------------------------------------------
console.log('\n--- Test 9: Mobile Safari critical video element attributes ---');
{
  mockNavigator({ mediaDevices: createMockMediaDevices({ tierToSucceed: 1 }) });

  const attributesSet = {};
  const mockVideo = {
    setAttribute: (name, val) => {
      attributesSet[name] = val;
    },
    srcObject: null,
    muted: false,
    play: async () => {}
  };

  const cameraService = new CameraService();
  cameraService.attachVideoElement(mockVideo);
  await cameraService.start();

  assert(attributesSet['playsinline'] === 'true', 'Video must have playsinline set to true for iOS Safari');
  assert(attributesSet['webkit-playsinline'] === 'true', 'Video must have webkit-playsinline set to true for older iOS Safari');
  assert(mockVideo.muted === true, 'Video must be muted to satisfy mobile autoplay policies');

  console.log('✅ Test 9 Passed: playsinline, webkit-playsinline, and muted properly configured');
  passedTests++;
}

console.log('\n================================================================');
console.log(`🎉 ALL ${passedTests} CAMERA COMPATIBILITY TESTS PASSED!`);
console.log('================================================================\n');
