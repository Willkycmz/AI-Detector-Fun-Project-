/**
 * SpatialRelationEngine.js - VisionX V1.6 Phase B Deterministic 2D Spatial Relationship Engine
 *
 * Menganalisis topologi spasial 2D antar objek yang terdeteksi dalam frame kamera.
 * 
 * ATURAN GEOMETRI KRITIS (2D RGB Pipeline):
 * - Karena input adalah citra 2D RGB (tanpa sensor kedalaman LiDAR/Depth), engine ini
 *   TIDAK mengasumsikan atau mengklaim relasi depth 3D faktual seperti IN_FRONT_OF atau BEHIND.
 * - Hubungan yang dievaluasi murni geometris 2D deterministik pada bidang kanvas:
 *   1. LEFT_OF: Objek A berada di sebelah kiri objek B pada sumbu horizontal X.
 *   2. RIGHT_OF: Objek A berada di sebelah kanan objek B pada sumbu horizontal X.
 *   3. ABOVE: Objek A berada di atas objek B pada sumbu vertikal Y.
 *   4. BELOW: Objek A berada di bawah objek B pada sumbu vertikal Y.
 *   5. NEAR: Jarak batas atau Euclidean centroid antar dua objek berada dalam ambang kedekatan.
 *   6. OVERLAPPING: Kotak pembatas (bounding box) A dan B berpotongan secara 2D.
 *   7. CONTAINED_BY: Kotak pembatas A sebagian besar / seluruhnya berada di dalam kotak pembatas B.
 *
 * Bersifat murni fungsional, terisolasi, tanpa state internal, dan dioptimasi dengan
 * batasan pasangan (bounded pairwise) untuk performa tinggi (< 1 ms).
 */

export const SpatialRelationType = {
  LEFT_OF: 'LEFT_OF',
  RIGHT_OF: 'RIGHT_OF',
  ABOVE: 'ABOVE',
  BELOW: 'BELOW',
  NEAR: 'NEAR',
  OVERLAPPING: 'OVERLAPPING',
  CONTAINED_BY: 'CONTAINED_BY'
};

export const DEFAULT_SPATIAL_THRESHOLDS = {
  maxObjectsToCompare: 12,       // Batas maksimal objek untuk mencegah ledakan O(N^2)
  nearThresholdNormalized: 0.22, // Rasio jarak Euclidean terhadap diagonal frame untuk kategori NEAR
  containmentThreshold: 0.85,    // Minimal 85% area A berada di dalam B untuk CONTAINED_BY
  overlapMinIoU: 0.04,           // Minimal IoU untuk dinyatakan OVERLAPPING
  overlapMinIntersectionRatio: 0.10, // Minimal 10% dari area objek terkecil beririsan
  directionalSeparationRatio: 0.45,  // Rasio dominasi aksial untuk membedakan horizontal vs vertikal
  minAxisSeparationNormalized: 0.04  // Minimal pergeseran 4% lebar/tinggi frame untuk arah
};

export class SpatialRelationEngine {
  /**
   * Mengevaluasi hubungan spasial 2D untuk semua pasangan objek yang terdeteksi
   * @param {Array<Object>} detections List objek terdeteksi dengan properti bbox [x1, y1, x2, y2]
   * @param {number} frameWidth Lebar frame kamera (default: 640)
   * @param {number} frameHeight Tinggi frame kamera (default: 480)
   * @param {Object} [customThresholds={}] Ambang batas konfigurasi opsional
   * @returns {Array<Object>} List relasi spasial terstruktur antar pasangan objek
   */
  static computeRelations(detections = [], frameWidth = 640, frameHeight = 480, customThresholds = {}) {
    if (!Array.isArray(detections) || detections.length < 2) {
      return [];
    }

    const fw = Math.max(1, frameWidth);
    const fh = Math.max(1, frameHeight);
    const frameDiag = Math.hypot(fw, fh);
    const cfg = { ...DEFAULT_SPATIAL_THRESHOLDS, ...customThresholds };

    // Ambil maksimal N objek teratas (diurutkan berdasarkan confidence atau area)
    const objects = [...detections]
      .filter(d => Array.isArray(d.bbox) && d.bbox.length === 4)
      .slice(0, cfg.maxObjectsToCompare)
      .map((d, idx) => {
        const [x1, y1, x2, y2] = d.bbox;
        const w = Math.max(0, x2 - x1);
        const h = Math.max(0, y2 - y1);
        const area = w * h;
        const cx = x1 + w / 2;
        const cy = y1 + h / 2;
        return {
          id: d.id || d.track_id || `obj_${idx + 1}`,
          className: d.class_name || d.name || 'object',
          bbox: [x1, y1, x2, y2],
          cx,
          cy,
          w,
          h,
          area
        };
      });

    const relations = [];

    // Evaluasi pairwise N * (N - 1)
    for (let i = 0; i < objects.length; i++) {
      for (let j = 0; j < objects.length; j++) {
        if (i === j) continue;

        const a = objects[i];
        const b = objects[j];

        const pairRelations = SpatialRelationEngine.evaluatePair(a, b, fw, fh, frameDiag, cfg);
        if (pairRelations.length > 0) {
          relations.push({
            sourceId: a.id,
            sourceClass: a.className,
            targetId: b.id,
            targetClass: b.className,
            relations: pairRelations
          });
        }
      }
    }

    return relations;
  }

  /**
   * Mengevaluasi hubungan dari objek A ke objek B secara 2D
   * @param {Object} a Objek A
   * @param {Object} b Objek B
   * @param {number} fw Lebar frame
   * @param {number} fh Tinggi frame
   * @param {number} frameDiag Diagonal frame
   * @param {Object} cfg Konfigurasi threshold
   * @returns {Array<string>} Relasi aktif (e.g. ['LEFT_OF', 'NEAR'])
   */
  static evaluatePair(a, b, fw, fh, frameDiag, cfg) {
    const active = [];

    const [aX1, aY1, aX2, aY2] = a.bbox;
    const [bX1, bY1, bX2, bY2] = b.bbox;

    // 1. Kalkulasi Irisan (Intersection) 2D
    const interX1 = Math.max(aX1, bX1);
    const interY1 = Math.max(aY1, bY1);
    const interX2 = Math.min(aX2, bX2);
    const interY2 = Math.min(aY2, bY2);

    const interW = Math.max(0, interX2 - interX1);
    const interH = Math.max(0, interY2 - interY1);
    const interArea = interW * interH;

    // 2. Evaluasi CONTAINED_BY
    // A berada di dalam B jika area irisan mencakup >= 85% area A dan area B lebih besar
    let isContained = false;
    if (a.area > 0 && b.area > a.area && interArea > 0) {
      const containmentRatio = interArea / a.area;
      if (containmentRatio >= cfg.containmentThreshold) {
        active.push(SpatialRelationType.CONTAINED_BY);
        isContained = true;
      }
    }

    // 3. Evaluasi OVERLAPPING
    // Jika ada irisan nyata tetapi bukan containment penuh
    if (!isContained && interArea > 0) {
      const unionArea = a.area + b.area - interArea;
      const iou = unionArea > 0 ? interArea / unionArea : 0;
      const minAreaRatio = Math.min(a.area, b.area) > 0 ? interArea / Math.min(a.area, b.area) : 0;

      if (iou >= cfg.overlapMinIoU || minAreaRatio >= cfg.overlapMinIntersectionRatio) {
        active.push(SpatialRelationType.OVERLAPPING);
      }
    }

    // 4. Evaluasi Jarak (NEAR)
    // Jarak euclidean antara centroid, dinormalisasi terhadap diagonal layar
    const centroidDist = Math.hypot(a.cx - b.cx, a.cy - b.cy);
    const normDist = centroidDist / frameDiag;

    // Jarak tepi-ke-tepi (edge-to-edge gap)
    const gapX = Math.max(0, Math.max(aX1, bX1) - Math.min(aX2, bX2));
    const gapY = Math.max(0, Math.max(aY1, bY1) - Math.min(aY2, bY2));
    const edgeDistNorm = Math.hypot(gapX, gapY) / frameDiag;

    if (normDist <= cfg.nearThresholdNormalized || edgeDistNorm <= (cfg.nearThresholdNormalized * 0.6)) {
      active.push(SpatialRelationType.NEAR);
    }

    // 5. Evaluasi Arah Horizontal: LEFT_OF vs RIGHT_OF
    const deltaX = b.cx - a.cx;
    const deltaY = b.cy - a.cy;
    const absDx = Math.abs(deltaX);
    const absDy = Math.abs(deltaY);
    const normDx = absDx / fw;

    if (normDx >= cfg.minAxisSeparationNormalized) {
      // Prioritaskan horizontal jika dx dominan atau tepi kotak tidak tumpang tindih secara horizontal
      if (absDx >= absDy * cfg.directionalSeparationRatio || aX2 <= bX1 || bX2 <= aX1) {
        if (deltaX > 0) {
          active.push(SpatialRelationType.LEFT_OF);
        } else {
          active.push(SpatialRelationType.RIGHT_OF);
        }
      }
    }

    // 6. Evaluasi Arah Vertikal: ABOVE vs BELOW
    const normDy = absDy / fh;
    if (normDy >= cfg.minAxisSeparationNormalized) {
      if (absDy >= absDx * cfg.directionalSeparationRatio || aY2 <= bY1 || bY2 <= aY1) {
        if (deltaY > 0) {
          active.push(SpatialRelationType.ABOVE);
        } else {
          active.push(SpatialRelationType.BELOW);
        }
      }
    }

    return active;
  }

  /**
   * Helper untuk menerjemahkan relasi ke deskripsi teks Bahasa Indonesia
   * @param {string} relationType
   * @returns {string}
   */
  static formatRelationId(relationType) {
    switch (relationType) {
      case SpatialRelationType.LEFT_OF: return 'di sebelah kiri';
      case SpatialRelationType.RIGHT_OF: return 'di sebelah kanan';
      case SpatialRelationType.ABOVE: return 'di sebelah atas';
      case SpatialRelationType.BELOW: return 'di sebelah bawah';
      case SpatialRelationType.NEAR: return 'berdekatan dengan';
      case SpatialRelationType.OVERLAPPING: return 'bertumpukan/beririsan dengan';
      case SpatialRelationType.CONTAINED_BY: return 'berada di dalam area';
      default: return relationType;
    }
  }
}
