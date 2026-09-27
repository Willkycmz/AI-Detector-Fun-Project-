/**
 * DetectionRenderer.js - Backwards Compatibility Wrapper (V0.6.2)
 * Mewarisi UnifiedRenderer untuk mendukung API lama render() dan renderFaceDetections()
 * serta API terpadu renderUnified().
 */

import { UnifiedRenderer } from './UnifiedRenderer.js';

export class DetectionRenderer extends UnifiedRenderer {
  constructor(canvasElement) {
    super(canvasElement);
  }

  /**
   * Menjaga kompatibilitas dengan pemanggil lama renderFaceDetections
   */
  renderFaceDetections(faceDetections = []) {
    if (!faceDetections || faceDetections.length === 0) return;
    for (const f of faceDetections) {
      const isDev = f.matched || (f.label && f.label.includes('DEVELOPER'));
      this.renderFaceItem(this.ctx, {
        type: 'face',
        bbox: f.bbox || f.box,
        label: f.label || (isDev ? `VISIONX DEVELOPER ${f.score_percent || ''}`.trim() : 'PERSON • UNKNOWN'),
        identityStatus: isDev ? 'REGISTERED' : 'UNREGISTERED'
      });
    }
  }
}

export { UnifiedRenderer };
