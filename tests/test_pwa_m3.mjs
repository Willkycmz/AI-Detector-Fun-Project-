/**
 * test_pwa_m3.mjs - VisionX Milestone 3 Test Suite
 * PWA Manifest, Service Worker, Metadata & Version Verification
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { APP_VERSION } from '../web/src/version.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const webDir = path.resolve(__dirname, '../web');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✓ ${message}`);
    passed++;
  } else {
    console.error(`  ✗ FAILED: ${message}`);
    failed++;
  }
}

async function runTests() {
  console.log('================================================================');
  console.log('📱 Running VisionX Milestone 3 — PWA, Metadata & Version Tests');
  console.log('================================================================');

  // Test 1: APP_VERSION standardized
  assert(APP_VERSION === '2.0.0', `APP_VERSION is standardized to '2.0.0' (got ${APP_VERSION})`);

  // Test 2: manifest.webmanifest exists and is valid
  const manifestPath = path.join(webDir, 'public/manifest.webmanifest');
  assert(fs.existsSync(manifestPath), 'manifest.webmanifest exists in web/public');

  const manifestContent = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert(manifestContent.name === 'VisionX - AI Vision Assistant', 'Manifest has proper app name');
  assert(manifestContent.display === 'standalone', 'Manifest display is standalone');
  assert(manifestContent.theme_color === '#070b14', 'Manifest theme_color matches dark cyber background');
  assert(Array.isArray(manifestContent.icons) && manifestContent.icons.length > 0, 'Manifest contains app icons');

  // Test 3: Service worker exists
  const swPath = path.join(webDir, 'public/sw.js');
  assert(fs.existsSync(swPath), 'sw.js service worker exists in web/public');
  const swContent = fs.readFileSync(swPath, 'utf8');
  assert(swContent.includes('addEventListener(\'fetch\''), 'Service worker registers fetch listener');
  assert(swContent.includes('/api'), 'Service worker explicitly exempts API requests from interference');

  // Test 4: CNAME preservation
  const cnamePath = path.join(webDir, 'public/CNAME');
  assert(fs.existsSync(cnamePath), 'CNAME file exists in web/public');
  const cnameContent = fs.readFileSync(cnamePath, 'utf8').trim();
  assert(cnameContent === 'app.visionx.my.id', 'CNAME contains app.visionx.my.id');

  // Test 5: Metadata in index.html
  const indexPath = path.join(webDir, 'index.html');
  const indexHtml = fs.readFileSync(indexPath, 'utf8');
  assert(indexHtml.includes('<link rel="manifest"'), 'index.html references web manifest');
  assert(indexHtml.includes('name="theme-color"'), 'index.html includes theme-color meta tag');
  assert(indexHtml.includes('name="viewport"'), 'index.html includes viewport meta tag');
  assert(indexHtml.includes('property="og:title"'), 'index.html includes Open Graph title');
  assert(indexHtml.includes('property="og:description"'), 'index.html includes Open Graph description');

  console.log('================================================================');
  console.log(`📊 PWA Suite Results: ${passed} passed, ${failed} failed`);
  console.log('================================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests();
