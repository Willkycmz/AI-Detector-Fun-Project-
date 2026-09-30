/**
 * DetectionFusion.js - Unified Multi-Modal Vision Fusion Engine (V0.6.2)
 *
 * Menggabungkan output dari ObjectDetector (YOLO) dan FaceDetector + FaceRecognizer
 * menjadi satu set deteksi terpadu dengan struktur standar:
 *
 * {
 *   type: "object" | "face",
 *   bbox: { x1, y1, x2, y2 },
 *   label: string,
 *   confidence: number,
 *   identityStatus: "REGISTERED" | "UNREGISTERED" | "OBJECT"
 * }
 *
 * Aturan Label Identitas:
 * - REGISTERED: label = "VISIONX DEVELOPER <score_percent>"
 * - UNREGISTERED: label = "PERSON • UNKNOWN"
 * - Tidak pernah menyimpulkan nama untuk orang yang tidak terdaftar.
 *
 * Isolasi Kegagalan:
 * - Kegagalan pada face recognition TIDAK menghentikan deteksi YOLO.
 * - Kegagalan pada YOLO TIDAK menghentikan deteksi wajah.
 */

import { CoordinateMapper } from './CoordinateMapper.js';

export class DetectionFusion {
  /**
   * Menggabungkan deteksi objek dan deteksi wajah menjadi satu daftar terpadu.
   * @param {Array} objectDetections List deteksi dari ObjectDetector (YOLO)
   * @param {Array} faceDetections List deteksi kotak wajah dari FaceDetector
   * @param {Object} identityResult Hasil identitas terakhir dari FaceRecognizer
   * @param {Object} options Opsi { enableFace: boolean, enableObjects: boolean }
   * @returns {Array} List UnifiedDetection [{ type, bbox, label, confidence, identityStatus, ... }]
   */
  static fuse(
    objectDetections = [],
    faceDetections = [],
    identityResult = null,
    options = { enableFace: true, enableObjects: true }
  ) {
    const unified = [];

    // 1. Proses Deteksi Objek (YOLO)
    if (options.enableObjects && Array.isArray(objectDetections)) {
      for (const det of objectDetections) {
        if (!det) continue;

        const rawBox = det.bbox || { x1: det.x1, y1: det.y1, x2: det.x2, y2: det.y2 };
        const bbox = CoordinateMapper.normalizeBbox(rawBox);
        const className = det.class_name || det.className || 'object';
        const conf = Number(det.confidence) || 0;
        const confPercent = Math.round(conf * 100);

        // Contoh dengan tracking: "Laptop #04", tanpa tracking: "Laptop 94%"
        const trackId = det.trackId;
        const trackIdFormatted = det.trackIdFormatted || (trackId ? `#${String(trackId).padStart(2, '0')}` : null);
        const formattedClassName = className.charAt(0).toUpperCase() + className.slice(1).replace('_', ' ');
        const label = trackIdFormatted
          ? `${formattedClassName} ${trackIdFormatted}`
          : `${formattedClassName} ${confPercent}%`;

        unified.push({
          type: 'object',
          bbox,
          label,
          confidence: conf,
          identityStatus: 'OBJECT',
          class_name: className,
          trackId: trackId || null,
          trackIdFormatted: trackIdFormatted || null,
          velocity: det.velocity || { x: 0, y: 0 },
          state: det.state || 'confirmed',
          hits: det.hits || 1,
          ageFrames: det.ageFrames || 1,
          missedFrames: det.missedFrames || 0,
          rawDetection: det
        });
      }
    }

    // 2. Proses Deteksi Wajah (YuNet + SFace) sebagai layer tambahan di atas objek YOLO
    if (options.enableFace && Array.isArray(faceDetections) && faceDetections.length > 0) {
      const activeIdentity = identityResult || {
        matched: false,
        label: 'Person',
        identityStatus: 'UNREGISTERED',
        score_percent: ''
      };

      for (let i = 0; i < faceDetections.length; i++) {
        const face = faceDetections[i];
        if (!face) continue;

        const bbox = CoordinateMapper.normalizeBbox(face.bbox || face.box);
        const isMatched = Boolean(activeIdentity.matched);
        const identityStatus = isMatched ? 'REGISTERED' : 'UNREGISTERED';

        let label = 'Person';
        let faceConf = face.confidence || 0.9;

        if (isMatched) {
          const scoreStr = activeIdentity.score_percent || `${Math.round((activeIdentity.similarity || 0.91) * 100)}%`;
          label = activeIdentity.label || `Person — Developer VisionX (${scoreStr})`.trim();
          faceConf = activeIdentity.similarity || faceConf;

          // Asosiasikan dengan objek YOLO 'person' bila bounding box beririsan/mencakup wajah
          for (const u of unified) {
            if (u.type === 'object' && (u.class_name === 'person' || (u.label && u.label.startsWith('Person')))) {
              const p = u.bbox;
              if (bbox.x1 >= p.x1 - 30 && bbox.x2 <= p.x2 + 30 &&
                  bbox.y1 >= p.y1 - 30 && bbox.y2 <= p.y2 + 30) {
                u.isDeveloper = true;
                u.developerVerified = true;
              }
            }
          }
        } else {
          label = activeIdentity.label || 'Person';
        }

        unified.push({
          type: 'face',
          bbox,
          label,
          confidence: faceConf,
          identityStatus,
          isDeveloper: isMatched,
          rawFace: face
        });
      }
    }

    return unified;
  }
}
