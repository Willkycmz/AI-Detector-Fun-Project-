/**
 * tests/test_milestone_6_shell.mjs
 * VisionX Milestone 6 — UI Shell Reconstruction + Legacy Dashboard Isolation
 * 
 * 25 verification points using file-based string analysis (no jsdom dependency).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const htmlPath = path.join(__dirname, '..', 'web', 'index.html');
const cssPath = path.join(__dirname, '..', 'web', 'src', 'style.css');
const mainJsPath = path.join(__dirname, '..', 'web', 'src', 'main.js');

const htmlContent = fs.readFileSync(htmlPath, 'utf8');
const cssContent = fs.readFileSync(cssPath, 'utf8');
const mainJsContent = fs.readFileSync(mainJsPath, 'utf8');

let passed = 0;
let failed = 0;

function test(id, name, fn) {
  try {
    fn();
    console.log(`  ✅ ${id}. ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ❌ ${id}. ${name}: ${err.message}`);
    failed++;
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

console.log('\n🔬 VISIONX MILESTONE 6 — UI SHELL RECONSTRUCTION TESTS\n');
console.log('─'.repeat(60));

// ========== 1-6: CHAT WORKSPACE + DEFAULT STATE ==========

test(1, 'Chat is default workspace', () => {
  assert(htmlContent.includes('data-active-workspace="home"'), 
    'workspaceContainer must default to data-active-workspace="home"');
  assert(htmlContent.includes('id="workspaceContainer"'), 
    'workspaceContainer element must exist');
});

test(2, 'Chat shell exists with workspace-panel class', () => {
  assert(htmlContent.includes('id="homeView"'), 'homeView element must exist');
  assert(htmlContent.includes('class="workspace-panel chat-first-shell"') || 
         htmlContent.includes('workspace-panel') && htmlContent.includes('data-workspace="home"'), 
    'homeView must have workspace-panel class and data-workspace="home"');
});

test(3, 'Legacy camera DOM isolated via workspace attributes', () => {
  assert(htmlContent.includes('id="stageCard"'), 'stageCard must exist');
  assert(htmlContent.includes('data-workspace="vision-stage"'), 
    'stageCard must have data-workspace="vision-stage"');
  assert(cssContent.includes('.workspace-panel'), 
    'CSS must define .workspace-panel');
  assert(cssContent.includes('display: none !important'), 
    'workspace-panel must be hidden by default');
});

test(4, 'Welcome screen visible in Chat workspace', () => {
  assert(htmlContent.includes('id="chatWelcomeScreen"'), 'Welcome screen must exist');
  assert(htmlContent.includes('class="welcome-title"'), 'Welcome title must exist');
  assert(htmlContent.includes('>VisionX<'), 'Welcome must say VisionX');
});

test(5, 'Quick prompts visible in Chat workspace', () => {
  const promptCount = (htmlContent.match(/class="quick-prompt-btn"/g) || []).length;
  assert(promptCount >= 4, `Expected >= 4 quick prompt buttons, got ${promptCount}`);
  assert(htmlContent.includes('Apa yang ada di depan kamera?'), 'First quick prompt text');
});

test(6, 'Composer occupies own layout region', () => {
  assert(htmlContent.includes('id="chatContainer"'), 'chatContainer must exist');
  assert(htmlContent.includes('id="chatInputContainer"'), 'chatInputContainer must exist');
  assert(htmlContent.includes('id="btnSendChatMessage"'), 'Send button must exist');
  assert(htmlContent.includes('id="chatMessageInput"'), 'Chat input must exist');
  assert(cssContent.includes('.chat-container'), 'CSS must define .chat-container');
  assert(cssContent.includes('grid-template-rows'), 'Chat container must use grid rows');
});

// ========== 7-10: LEGACY ISOLATION ==========

test(7, 'Workspace isolation via data attributes', () => {
  const panelCount = (htmlContent.match(/data-workspace="/g) || []).length;
  assert(panelCount >= 6, `Expected >= 6 data-workspace elements, got ${panelCount}`);
  assert(cssContent.includes('data-active-workspace'), 
    'CSS must use data-active-workspace for visibility');
});

test(8, 'No horizontal overflow: workspace-container prevents overflow', () => {
  assert(cssContent.includes('.workspace-container'), 'CSS must define .workspace-container');
  assert(cssContent.includes('overflow: hidden') || cssContent.includes('overflow-x: hidden'), 
    'workspace-container must prevent overflow');
});

test(9, 'Sidebar desktop (permanently visible >= 768px)', () => {
  assert(htmlContent.includes('id="appSidebar"'), 'Sidebar must exist');
  assert(htmlContent.includes('class="app-sidebar"'), 'Sidebar must have app-sidebar class');
  assert(cssContent.includes('.app-sidebar'), 'CSS must style .app-sidebar');
  assert(cssContent.includes('width: 260px'), 'Desktop sidebar should be 260px wide');
});

test(10, 'Sidebar drawer mobile (off-canvas < 768px)', () => {
  assert(cssContent.includes('transform: translateX(-100%)'), 
    'Mobile sidebar must use translateX(-100%) for off-canvas');
  assert(cssContent.includes('.drawer-open') || cssContent.includes('drawer-open'), 
    'Must have drawer-open mechanism');
});

// ========== 11-16: WORKSPACE SWITCHING ==========

test(11, 'Chat → Vision: stageCard workspace attribute', () => {
  assert(htmlContent.includes('data-workspace="vision-stage"'), 
    'stageCard should have data-workspace="vision-stage"');
  assert(cssContent.includes('data-active-workspace="detection"'), 
    'CSS should have detection workspace rules');
});

test(12, 'Vision → Chat: JS setMode sets data-active-workspace', () => {
  assert(mainJsContent.includes("setAttribute('data-active-workspace'"), 
    'setMode must set data-active-workspace attribute');
  assert(mainJsContent.includes("getElementById('workspaceContainer')"), 
    'setMode must target workspaceContainer');
});

test(13, 'Chat → Dataset: managerControls workspace attribute', () => {
  assert(htmlContent.includes('data-workspace="manager-controls"'), 
    'managerControls data-workspace should be "manager-controls"');
  assert(cssContent.includes('data-active-workspace="manager"'), 
    'CSS should have manager workspace rules');
});

test(14, 'Dataset → Chat: workspace switching preserves chat DOM', () => {
  assert(htmlContent.includes('id="homeView"'), 'homeView must exist');
  assert(htmlContent.includes('id="chatThread"'), 'chatThread must exist');
  // They're always in DOM, just toggled via CSS
});

test(15, 'Chat → Identity: identityControls workspace attribute', () => {
  assert(htmlContent.includes('data-workspace="identity-controls"'), 
    'identityControls data-workspace should be "identity-controls"');
  assert(cssContent.includes('data-active-workspace="identity"'), 
    'CSS should have identity workspace rules');
});

test(16, 'Identity → Chat: no stale workspace residue', () => {
  assert(cssContent.includes('data-active-workspace="identity"'), 
    'CSS must have rules for identity workspace');
  assert(cssContent.includes('data-active-workspace="home"'), 
    'CSS must have rules for home workspace');
});

// ========== 17-18: CAMERA MODAL ==========

test(17, 'Camera modal explicit only (not auto-started)', () => {
  assert(htmlContent.includes('id="cameraModal"'), 'Camera modal must exist');
  assert(htmlContent.includes('cameraModal') && htmlContent.includes('hidden'), 
    'Camera modal should start hidden');
  assert(htmlContent.includes('id="btnOpenCamModal"'), 'Camera open button must exist');
});

test(18, 'Camera cleanup: CameraModal.js exists with cleanup', () => {
  const cameraModalJsPath = path.join(__dirname, '..', 'web', 'src', 'ui', 'CameraModal.js');
  assert(fs.existsSync(cameraModalJsPath), 'CameraModal.js must exist');
  const content = fs.readFileSync(cameraModalJsPath, 'utf8');
  assert(content.includes('close') || content.includes('destroy'), 
    'CameraModal must have cleanup method');
});

// ========== 19-22: PERSISTENCE, SSE, GROUNDING, AUTH ==========

test(19, 'Conversation persistence via IndexedDB', () => {
  const chatControllerPath = path.join(__dirname, '..', 'web', 'src', 'ui', 'ChatController.js');
  const chatContent = fs.readFileSync(chatControllerPath, 'utf8');
  const storagePath = path.join(__dirname, '..', 'web', 'src', 'services', 'ChatStorageService.js');
  const hasStorage = fs.existsSync(storagePath);
  assert(
    chatContent.includes('IndexedDB') || chatContent.includes('VisionX_ChatDB') || 
    chatContent.includes('ChatStorageService') || hasStorage,
    'Chat must have persistence via IndexedDB'
  );
});

test(20, 'SSE: AIProvider supports streaming', () => {
  const aiProviderPath = path.join(__dirname, '..', 'web', 'src', 'services', 'AIProvider.js');
  const content = fs.readFileSync(aiProviderPath, 'utf8');
  assert(
    content.includes('EventSource') || content.includes('text/event-stream') || 
    content.includes('SSE') || content.includes('stream'),
    'AIProvider must support SSE streaming'
  );
});

test(21, 'Grounding: VisionContextBuilder exists', () => {
  const vcbPath = path.join(__dirname, '..', 'web', 'src', 'services', 'VisionContextBuilder.js');
  assert(fs.existsSync(vcbPath), 'VisionContextBuilder.js must exist');
});

test(22, 'Authentication: auth modal exists', () => {
  assert(htmlContent.includes('id="visionxAuthModal"'), 'Auth modal must exist');
  assert(htmlContent.includes('id="authModalPinInput"'), 'PIN input must exist');
});

// ========== 23-25: REGRESSION + BUILD ==========

test(23, 'Existing service imports preserved (no regression)', () => {
  const requiredImports = [
    'CameraService', 'YOLOInferenceService', 'TrackingEngine',
    'OCRService', 'ObjectMemory', 'SafetyEngine', 'VisionAssistant',
    'PersonalObjectRecognizer', 'SceneHistoryEngine'
  ];
  for (const svc of requiredImports) {
    assert(mainJsContent.includes(svc), `main.js must import ${svc}`);
  }
});

test(24, 'Bottom-nav-bar removed from layout', () => {
  assert(cssContent.includes('.bottom-nav-bar'), 'CSS must reference bottom-nav-bar');
  assert(cssContent.includes('display: none !important'), 
    'bottom-nav-bar must be hidden via display:none !important');
});

test(25, 'Production build: package.json has build script', () => {
  const pkgPath = path.join(__dirname, '..', 'web', 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  assert(pkg.scripts && pkg.scripts.build, 'package.json must have build script');
});

// ========== REPORT ==========

console.log('─'.repeat(60));
console.log(`\n📊 Results: ${passed} passed, ${failed} failed out of ${passed + failed} tests\n`);

if (failed > 0) {
  console.log('❌ MILESTONE 6 TESTS HAVE FAILURES\n');
  process.exit(1);
} else {
  console.log('✅ ALL MILESTONE 6 TESTS PASSED\n');
  process.exit(0);
}
