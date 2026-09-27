/**
 * SceneUnderstandingEngine.js - VisionX V1.6 Phase B Deterministic Scene Understanding Engine
 *
 * Mengolah daftar deteksi visual dan relasi spasial 2D untuk menghasilkan sintesis
 * pemahaman situasi keseluruhan:
 * 1. Menghitung jumlah objek visual aktif.
 * 2. Mengidentifikasi objek dominan/fokal (Focal Object) menggunakan geometri deterministik (skor area + sentralitas).
 * 3. Menentukan tingkat kepadatan visual (Clutter Level: EMPTY / SPARSE / MODERATE / CROWDED).
 * 4. Menyusun narasi deskriptif spasial deterministik dalam Bahasa Indonesia tanpa halusinasi.
 * 5. Menangani skenario ruang kosong (empty scene) dan objek tunggal (single object) secara elegan.
 *
 * Murni fungsional, zero state, dan tidak dijalankan per-frame agar performa 60 FPS tetap terjaga.
 */

import { SpatialRelationEngine, SpatialRelationType } from './SpatialRelationEngine.js';

export const ClutterLevel = {
  EMPTY: 'EMPTY',
  SPARSE: 'SPARSE',
  MODERATE: 'MODERATE',
  CROWDED: 'CROWDED'
};

export class SceneUnderstandingEngine {
  /**
   * Menentukan tingkat kepadatan visual (clutter level)
   * @param {number} objectCount
   * @returns {string} ClutterLevel
   */
  static getClutterLevel(objectCount) {
    if (objectCount === 0) return ClutterLevel.EMPTY;
    if (objectCount <= 2) return ClutterLevel.SPARSE;
    if (objectCount <= 6) return ClutterLevel.MODERATE;
    return ClutterLevel.CROWDED;
  }

  /**
   * Mengidentifikasi objek fokal / utama secara deterministik berdasarkan ukuran dan posisi
   * Objek di tengah layar dan berukuran lebih besar memiliki skor fokal lebih tinggi.
   * Skor = (Area / FrameArea) * 0.6 + (1 - JarakCentroidKePusat / MaxJarak) * 0.4
   * @param {Array<Object>} detections
   * @param {number} frameWidth
   * @param {number} frameHeight
   * @returns {Object|null} Objek fokal terbaik atau null jika kosong
   */
  static findFocalObject(detections = [], frameWidth = 640, frameHeight = 480) {
    if (!Array.isArray(detections) || detections.length === 0) {
      return null;
    }

    const fw = Math.max(1, frameWidth);
    const fh = Math.max(1, frameHeight);
    const frameArea = fw * fh;
    const centerX = fw / 2;
    const centerY = fh / 2;
    const maxCenterDist = Math.hypot(centerX, centerY);

    let bestScore = -1;
    let bestObj = null;

    for (const d of detections) {
      const bbox = Array.isArray(d.bbox) && d.bbox.length === 4 ? d.bbox : [0, 0, 0, 0];
      const w = Math.max(0, bbox[2] - bbox[0]);
      const h = Math.max(0, bbox[3] - bbox[1]);
      const area = w * h;
      const cx = bbox[0] + w / 2;
      const cy = bbox[1] + h / 2;

      const areaRatio = Math.min(1.0, area / frameArea);
      const centerDist = Math.hypot(cx - centerX, cy - centerY);
      const centralityScore = Math.max(0, 1.0 - (centerDist / maxCenterDist));

      // Confidence weighting (0.5 to 1.0)
      const conf = typeof d.confidence === 'number' ? Math.max(0.5, Math.min(1.0, d.confidence)) : 0.8;

      const focalScore = (areaRatio * 0.6 + centralityScore * 0.4) * conf;

      if (focalScore > bestScore) {
        bestScore = focalScore;
        bestObj = {
          id: d.id || d.track_id,
          class_name: d.class_name || d.name || 'object',
          confidence: d.confidence,
          bbox: d.bbox,
          relative_position: d.relative_position || 'tengah',
          focal_score: Math.round(focalScore * 100) / 100
        };
      }
    }

    return bestObj;
  }

  /**
   * Menyusun narasi spasial deterministik dalam Bahasa Indonesia
   * @param {Object} params
   * @param {Array<Object>} params.detections
   * @param {Object|null} params.focalObject
   * @param {Array<Object>} params.spatialRelations
   * @param {string} params.clutterLevel
   * @returns {string} Narasi kalimat utuh
   */
  static generateSpatialNarrative({ detections = [], focalObject = null, spatialRelations = [], clutterLevel = ClutterLevel.EMPTY }) {
    const count = detections.length;

    // 1. Kasus Kosong
    if (count === 0) {
      return 'Tidak ada objek yang terdeteksi di kamera. Pemandangan kosong.';
    }

    // 2. Kasus Objek Tunggal
    if (count === 1) {
      const obj = detections[0];
      const name = obj.class_name || 'objek';
      const pos = obj.relative_position || 'tengah';
      return `Terdeteksi 1 objek: ${name} di area ${pos}.`;
    }

    // 3. Kasus Multi-Objek (2 atau lebih)
    const focalName = focalObject ? focalObject.class_name : 'objek';
    const focalPos = focalObject ? focalObject.relative_position : 'tengah';

    let narrativeIntro = '';
    if (clutterLevel === ClutterLevel.SPARSE) {
      narrativeIntro = `Pemandangan lapang dengan ${count} objek, di mana ${focalName} menjadi fokus utama di area ${focalPos}.`;
    } else if (clutterLevel === ClutterLevel.MODERATE) {
      narrativeIntro = `Terdeteksi ${count} objek dengan ${focalName} di area ${focalPos} sebagai objek utama.`;
    } else {
      narrativeIntro = `Pemandangan cukup padat (${count} objek terdeteksi), didominasi oleh ${focalName} di area ${focalPos}.`;
    }

    // Ekstraksi relasi signifikan seputar objek fokal atau antar pasangan objek terdekat
    const relationPhrases = [];
    const usedPairs = new Set();

    if (Array.isArray(spatialRelations) && spatialRelations.length > 0) {
      // Prioritaskan relasi yang melibatkan focal object terlebih dahulu
      const focalRelations = spatialRelations.filter(r => focalObject && (r.sourceId === focalObject.id || r.targetId === focalObject.id));
      const otherRelations = spatialRelations.filter(r => !focalObject || (r.sourceId !== focalObject.id && r.targetId !== focalObject.id));
      const ordered = [...focalRelations, ...otherRelations];

      for (const rel of ordered) {
        const pairKey = `${rel.sourceId}_${rel.targetId}`;
        const reverseKey = `${rel.targetId}_${rel.sourceId}`;
        if (usedPairs.has(pairKey) || usedPairs.has(reverseKey)) continue;

        // Ambil relasi terpenting: CONTAINED_BY > OVERLAPPING > (Directional + NEAR)
        const activeRel = rel.relations || [];
        if (activeRel.includes(SpatialRelationType.CONTAINED_BY)) {
          relationPhrases.push(`${rel.sourceClass} berada di dalam ${rel.targetClass}`);
          usedPairs.add(pairKey);
        } else if (activeRel.includes(SpatialRelationType.OVERLAPPING)) {
          relationPhrases.push(`${rel.sourceClass} bertumpukan dengan ${rel.targetClass}`);
          usedPairs.add(pairKey);
        } else {
          // Gabungkan directional dengan NEAR jika ada
          const dirs = [];
          if (activeRel.includes(SpatialRelationType.LEFT_OF)) dirs.push('sebelah kiri');
          else if (activeRel.includes(SpatialRelationType.RIGHT_OF)) dirs.push('sebelah kanan');
          if (activeRel.includes(SpatialRelationType.ABOVE)) dirs.push('sebelah atas');
          else if (activeRel.includes(SpatialRelationType.BELOW)) dirs.push('sebelah bawah');

          const isNear = activeRel.includes(SpatialRelationType.NEAR);
          if (dirs.length > 0) {
            const dirStr = dirs.join(' ');
            if (isNear) {
              relationPhrases.push(`${rel.sourceClass} berada di ${dirStr} dan berdekatan dengan ${rel.targetClass}`);
            } else {
              relationPhrases.push(`${rel.sourceClass} berada di ${dirStr} ${rel.targetClass}`);
            }
            usedPairs.add(pairKey);
          } else if (isNear) {
            relationPhrases.push(`${rel.sourceClass} berdekatan dengan ${rel.targetClass}`);
            usedPairs.add(pairKey);
          }
        }

        if (relationPhrases.length >= 3) break; // Batasi maksimal 3 kalimat hubungan agar ringkas
      }
    }

    if (relationPhrases.length > 0) {
      return `${narrativeIntro} Hubungan spasial: ${relationPhrases.join('; ')}.`;
    }

    return narrativeIntro;
  }

  /**
   * Mensintesis pemahaman pemandangan visual lengkap
   * @param {Object} params
   * @param {Array<Object>} [params.detections=[]]
   * @param {Array<Object>} [params.spatialRelations=[]]
   * @param {number} [params.frameWidth=640]
   * @param {number} [params.frameHeight=480]
   * @returns {Object} Structured Scene Understanding Data
   */
  static synthesize({ detections = [], spatialRelations = null, frameWidth = 640, frameHeight = 480 } = {}) {
    const fw = Math.max(1, frameWidth);
    const fh = Math.max(1, frameHeight);
    const safeDetections = Array.isArray(detections) ? detections : [];
    const count = safeDetections.length;

    // 1. Relasi Spasial (komputasi otomatis jika belum diberikan)
    const relations = Array.isArray(spatialRelations)
      ? spatialRelations
      : SpatialRelationEngine.computeRelations(safeDetections, fw, fh);

    // 2. Tingkat Kepadatan
    const clutterLevel = SceneUnderstandingEngine.getClutterLevel(count);

    // 3. Objek Fokal
    const focalObject = SceneUnderstandingEngine.findFocalObject(safeDetections, fw, fh);

    // 4. Narasi Spasial
    const spatialNarrative = SceneUnderstandingEngine.generateSpatialNarrative({
      detections: safeDetections,
      focalObject,
      spatialRelations: relations,
      clutterLevel
    });

    return {
      object_count: count,
      clutter_level: clutterLevel,
      focal_object: focalObject,
      spatial_narrative: spatialNarrative,
      spatial_relations_count: relations.length,
      spatial_relations: relations
    };
  }
}
