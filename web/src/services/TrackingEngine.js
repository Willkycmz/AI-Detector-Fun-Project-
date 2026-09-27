/**
 * TrackingEngine.js - Deterministic Object Tracking Engine (VisionX V0.7)
 *
 * Menerima hasil deteksi objek dari YOLO (setelah dipetakan oleh CoordinateMapper)
 * dan memberikan persistent Track ID yang stabil secara temporal.
 *
 * Fitur Utama:
 * - Class-aware matching: Objek hanya dicocokkan dengan track dari class yang sama (Laptop != Mouse).
 * - Multi-criteria association: IoU overlap primer + centroid distance fallback.
 * - Track Lifecycle State Machine:
 *     [New Detection] -> 'tentative' -> (hits >= TRACK_MIN_HITS) -> 'confirmed'
 *     [Missed Frame]  -> 'lost'      -> (missed > TRACK_MAX_MISSED_FRAMES) -> 'removed'
 *     [Recovered]     -> 'confirmed'
 * - Velocity estimation: Perubahan center (dx, dy) dalam pixel/frame.
 * - Monotonic Track ID: Track ID tidak langsung digunakan kembali untuk mencegah kebingungan histori.
 * - Ringan & deterministik: Tanpa model neural tambahan, tidak memperlambat loop realtime.
 */

import { CoordinateMapper } from './CoordinateMapper.js';

export const DEFAULT_TRACKING_CONFIG = {
  TRACK_IOU_THRESHOLD: 0.30,       // Minimum IoU untuk mencocokkan bounding box
  TRACK_MAX_MISSED_FRAMES: 8,      // Toleransi frame hilang sebelum track dihapus (< 1 detik pada ~10-15 FPS)
  TRACK_MAX_MISSED_TENTATIVE: 2,   // Toleransi frame hilang untuk track tentative sebelum di-prune (mencegah ghost track)
  TRACK_MIN_HITS: 2,               // Jumlah hit berturut-turut untuk promosi ke confirmed
  TRACK_MAX_DISTANCE: 80.0,        // Jarak centroid maksimum (pixel) untuk fallback matching
  TRACK_DISTANCE_FALLBACK: true    // Izinkan pencocokan jarak jika IoU di bawah threshold
};

export class TrackingEngine {
  /**
   * @param {Object} customConfig Opsi konfigurasi opsional untuk threshold tracking
   */
  constructor(customConfig = {}) {
    this.config = { ...DEFAULT_TRACKING_CONFIG, ...customConfig };
    this.tracks = [];          // List of TrackedObject
    this.nextTrackId = 1;      // Monotonically increasing ID counter (1, 2, 3...)
    this.currentFrameId = 0;
    this.totalAllocatedTracks = 0;
    this.isEnabled = true;
  }

  /**
   * Update konfigurasi runtime
   */
  updateConfig(newConfig = {}) {
    this.config = { ...this.config, ...newConfig };
  }

  /**
   * Reset seluruh track state
   */
  reset() {
    this.tracks = [];
    this.nextTrackId = 1;
    this.currentFrameId = 0;
    this.totalAllocatedTracks = 0;
  }

  /**
   * Hitung Intersection over Union (IoU) antara dua bounding box
   * @param {Object} boxA { x1, y1, x2, y2 }
   * @param {Object} boxB { x1, y1, x2, y2 }
   * @returns {number} IoU antara 0.0 dan 1.0
   */
  static computeIoU(boxA, boxB) {
    if (!boxA || !boxB) return 0;
    const xA = Math.max(boxA.x1, boxB.x1);
    const yA = Math.max(boxA.y1, boxB.y1);
    const xB = Math.min(boxA.x2, boxB.x2);
    const yB = Math.min(boxA.y2, boxB.y2);

    const interW = Math.max(0, xB - xA);
    const interH = Math.max(0, yB - yA);
    const interArea = interW * interH;

    if (interArea <= 0) return 0;

    const areaA = Math.max(0, (boxA.x2 - boxA.x1) * (boxA.y2 - boxA.y1));
    const areaB = Math.max(0, (boxB.x2 - boxB.x1) * (boxB.y2 - boxB.y1));
    const unionArea = areaA + areaB - interArea;

    return unionArea > 0 ? interArea / unionArea : 0;
  }

  /**
   * Hitung Jarak Euclidean antara dua titik centroid
   * @param {Object} cA { x, y }
   * @param {Object} cB { x, y }
   * @returns {number}
   */
  static computeCentroidDistance(cA, cB) {
    if (!cA || !cB) return Infinity;
    const dx = cA.x - cB.x;
    const dy = cA.y - cB.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /**
   * Hitung centroid dari bounding box
   */
  static getCenter(bbox) {
    return {
      x: (bbox.x1 + bbox.x2) / 2,
      y: (bbox.y1 + bbox.y2) / 2
    };
  }

  /**
   * Update tracker dengan hasil deteksi YOLO di frame aktif
   * @param {Array} detections List deteksi [{ class_name, confidence, bbox: {x1, y1, x2, y2} }]
   * @param {number|null} frameId Nomor frame atau timestamp
   * @returns {Object} { visibleTracks, activeTracks, stats }
   */
  update(detections = [], frameId = null) {
    if (frameId !== null && frameId !== undefined) {
      this.currentFrameId = frameId;
    } else {
      this.currentFrameId++;
    }
    const currentFrame = this.currentFrameId;

    if (!this.isEnabled) {
      return {
        visibleTracks: [],
        activeTracks: [],
        stats: this.getStats()
      };
    }

    // Normalisasi format deteksi masukan
    const normalizedDetections = (detections || []).map((det, index) => {
      const rawBox = det.bbox || { x1: det.x1, y1: det.y1, x2: det.x2, y2: det.y2 };
      const bbox = CoordinateMapper.normalizeBbox(rawBox);
      const className = String(det.class_name || det.className || 'object').toLowerCase();
      const confidence = Number(det.confidence) || 0;
      const center = TrackingEngine.getCenter(bbox);

      return {
        index,
        className,
        confidence,
        bbox,
        center,
        rawDetection: det
      };
    }).filter(d => (d.bbox.x2 - d.bbox.x1) > 0 && (d.bbox.y2 - d.bbox.y1) > 0);

    // Ambil track yang masih aktif (belum berstatus 'removed')
    const activeTracks = this.tracks.filter(t => t.state !== 'removed');

    // Kelompokkan deteksi dan track berdasarkan className untuk CLASS-AWARE MATCHING
    const detectionsByClass = new Map();
    for (const det of normalizedDetections) {
      if (!detectionsByClass.has(det.className)) {
        detectionsByClass.set(det.className, []);
      }
      detectionsByClass.get(det.className).push(det);
    }

    const tracksByClass = new Map();
    for (const track of activeTracks) {
      if (!tracksByClass.has(track.className)) {
        tracksByClass.set(track.className, []);
      }
      tracksByClass.get(track.className).push(track);
    }

    const matchedTrackIds = new Set();
    const matchedDetectionIndices = new Set();

    // Himpunan semua class unik yang muncul pada deteksi atau track aktif
    const allClasses = new Set([...detectionsByClass.keys(), ...tracksByClass.keys()]);

    for (const cls of allClasses) {
      const clsDetections = detectionsByClass.get(cls) || [];
      const clsTracks = tracksByClass.get(cls) || [];

      if (clsDetections.length === 0 || clsTracks.length === 0) {
        continue;
      }

      // LANGKAH 1: Greedy Matching berdasarkan IoU (prioritas utama)
      const iouCandidates = [];
      for (const track of clsTracks) {
        for (const det of clsDetections) {
          const iou = TrackingEngine.computeIoU(track.bbox, det.bbox);
          if (iou >= this.config.TRACK_IOU_THRESHOLD) {
            iouCandidates.push({ track, det, iou });
          }
        }
      }

      // Urutkan kandidat dari IoU terbesar ke terkecil
      iouCandidates.sort((a, b) => b.iou - a.iou);

      for (const cand of iouCandidates) {
        if (!matchedTrackIds.has(cand.track.trackId) && !matchedDetectionIndices.has(cand.det.index)) {
          matchedTrackIds.add(cand.track.trackId);
          matchedDetectionIndices.add(cand.det.index);
          this._applyMatch(cand.track, cand.det, currentFrame);
        }
      }

      // LANGKAH 2: Centroid Distance Fallback untuk deteksi & track yang belum cocok
      if (this.config.TRACK_DISTANCE_FALLBACK) {
        const remainingTracks = clsTracks.filter(t => !matchedTrackIds.has(t.trackId));
        const remainingDets = clsDetections.filter(d => !matchedDetectionIndices.has(d.index));

        if (remainingTracks.length > 0 && remainingDets.length > 0) {
          const distCandidates = [];
          for (const track of remainingTracks) {
            for (const det of remainingDets) {
              const dist = TrackingEngine.computeCentroidDistance(track.center, det.center);
              if (dist <= this.config.TRACK_MAX_DISTANCE) {
                // Verifikasi kompatibilitas area agar noise kecil tidak memicu matching track besar
                const areaTrack = Math.max(1, (track.bbox.x2 - track.bbox.x1) * (track.bbox.y2 - track.bbox.y1));
                const areaDet = Math.max(1, (det.bbox.x2 - det.bbox.x1) * (det.bbox.y2 - det.bbox.y1));
                const areaRatio = Math.max(areaTrack, areaDet) / Math.min(areaTrack, areaDet);
                if (areaRatio <= 3.5) {
                  distCandidates.push({ track, det, dist });
                } else {
                  console.log(`[VisionX Tracker] Distance match rejected: area ratio mismatch ${areaRatio.toFixed(2)} > 3.5 between track #${track.trackId} and det #${det.index}`);
                }
              }
            }
          }

          // Urutkan dari jarak terdekat
          distCandidates.sort((a, b) => a.dist - b.dist);

          for (const cand of distCandidates) {
            if (!matchedTrackIds.has(cand.track.trackId) && !matchedDetectionIndices.has(cand.det.index)) {
              matchedTrackIds.add(cand.track.trackId);
              matchedDetectionIndices.add(cand.det.index);
              this._applyMatch(cand.track, cand.det, currentFrame);
            }
          }
        }
      }
    }

    // LANGKAH 3: Update track aktif yang TIDAK terdeteksi pada frame ini (Missed)
    const maxMissedTentative = this.config.TRACK_MAX_MISSED_TENTATIVE ?? 2;
    for (const track of activeTracks) {
      if (!matchedTrackIds.has(track.trackId)) {
        track.missedFrames++;
        track.ageFrames++;
        track.velocity = { x: 0, y: 0 };

        // Transisi siklus hidup: Prune cepat jika track belum pernah terkonfirmasi (hits < TRACK_MIN_HITS)
        const isUnconfirmed = track.hits < this.config.TRACK_MIN_HITS;
        if (isUnconfirmed && track.missedFrames >= maxMissedTentative) {
          track.state = 'removed';
          console.log(`[VisionX Tracker] Pruned tentative track #${track.trackId} (${track.className}): transient spike not confirmed after ${track.missedFrames} missed frames`);
        } else if (track.missedFrames > this.config.TRACK_MAX_MISSED_FRAMES) {
          track.state = 'removed';
          console.log(`[VisionX Tracker] Removed track #${track.trackId} (${track.className}): exceeded max missed frames (${track.missedFrames} > ${this.config.TRACK_MAX_MISSED_FRAMES})`);
        } else {
          track.state = 'lost';
          console.log(`[VisionX Tracker] Track #${track.trackId} (${track.className}) marked lost (missedFrames: ${track.missedFrames})`);
        }
      }
    }

    // LANGKAH 4: Inisialisasi Track baru untuk deteksi yang belum cocok
    for (const det of normalizedDetections) {
      if (!matchedDetectionIndices.has(det.index)) {
        const newTrack = this._createNewTrack(det, currentFrame);
        this.tracks.push(newTrack);
      }
    }

    // Prune tracks yang sudah removed agar memori tetap bounded (simpan 50 histori terakhir)
    if (this.tracks.length > 150) {
      const keepActive = this.tracks.filter(t => t.state !== 'removed');
      const recentRemoved = this.tracks.filter(t => t.state === 'removed').slice(-50);
      this.tracks = [...keepActive, ...recentRemoved];
    }

    // Ambil track yang terlihat di frame saat ini (missedFrames === 0 dan belum removed)
    const visibleTracks = this.tracks.filter(t => t.state !== 'removed' && t.missedFrames === 0);
    const currentActiveTracks = this.tracks.filter(t => t.state !== 'removed');

    return {
      visibleTracks,
      activeTracks: currentActiveTracks,
      allTracks: this.tracks,
      stats: this.getStats(visibleTracks, currentActiveTracks)
    };
  }

  /**
   * Terapkan update pencocokan ke track yang ada
   */
  _applyMatch(track, detection, currentFrame) {
    const prevCenter = { x: track.center.x, y: track.center.y };
    const newCenter = { x: detection.center.x, y: detection.center.y };

    // Estimasi velocity dalam pixel/frame
    track.velocity = {
      x: parseFloat((newCenter.x - prevCenter.x).toFixed(2)),
      y: parseFloat((newCenter.y - prevCenter.y).toFixed(2))
    };

    track.bbox = { ...detection.bbox };
    track.center = newCenter;
    track.confidence = detection.confidence;
    track.lastSeen = currentFrame;
    track.ageFrames++;
    track.hits++;
    track.missedFrames = 0;

    // Transisi status siklus hidup
    if (track.state === 'tentative') {
      if (track.hits >= this.config.TRACK_MIN_HITS) {
        track.state = 'confirmed';
        console.log(`[VisionX Tracker] Track #${track.trackId} (${track.className}) promoted to confirmed (hits: ${track.hits})`);
      }
    } else if (track.state === 'lost') {
      // Hanya kembalikan ke confirmed jika sebelumnya memang sudah pernah confirmed (hits >= TRACK_MIN_HITS)
      if (track.hits >= this.config.TRACK_MIN_HITS) {
        track.state = 'confirmed';
      } else {
        track.state = 'tentative';
      }
      console.log(`[VisionX Tracker] Track #${track.trackId} (${track.className}) recovered from lost -> ${track.state}`);
    }
  }

  /**
   * Buat instance TrackedObject baru
   */
  _createNewTrack(detection, currentFrame) {
    const trackId = this.nextTrackId++;
    this.totalAllocatedTracks++;

    const isDirectlyConfirmed = this.config.TRACK_MIN_HITS <= 1;
    const state = isDirectlyConfirmed ? 'confirmed' : 'tentative';
    console.log(`[VisionX Tracker] New track allocated: #${trackId} (${detection.className}, state: ${state}, conf: ${detection.confidence})`);

    return {
      trackId,
      trackIdFormatted: `#${String(trackId).padStart(2, '0')}`,
      className: detection.className,
      confidence: detection.confidence,
      bbox: { ...detection.bbox },
      center: { ...detection.center },
      firstSeen: currentFrame,
      lastSeen: currentFrame,
      ageFrames: 1,
      hits: 1,
      missedFrames: 0,
      velocity: { x: 0, y: 0 },
      state
    };
  }

  /**
   * Mengembalikan semua track aktif terstandarisasi untuk integrasi VisionContextBuilder
   */
  getTracks() {
    return this.tracks.map(t => ({
      ...t,
      isConfirmed: t.state === 'confirmed',
      isLost: t.state === 'lost' || t.missedFrames > 0,
      velocity: {
        vx: t.velocity?.x || 0,
        vy: t.velocity?.y || 0
      }
    }));
  }

  /**
   * Ambil statistik tracking untuk diagnostics & overlay counting
   */
  getStats(visibleTracks = null, activeTracks = null) {
    const visible = visibleTracks || this.tracks.filter(t => t.state !== 'removed' && t.missedFrames === 0);
    const active = activeTracks || this.tracks.filter(t => t.state !== 'removed');

    let newCount = 0;
    let lostCount = 0;
    const perClass = {};

    for (const t of active) {
      if (t.state === 'tentative') newCount++;
      if (t.state === 'lost') lostCount++;
    }

    for (const t of visible) {
      perClass[t.className] = (perClass[t.className] || 0) + 1;
    }

    return {
      trackingStatus: this.isEnabled ? 'ACTIVE' : 'STANDBY',
      visibleCount: visible.length,
      totalActiveCount: active.length,
      newCount,
      lostCount,
      uniqueTracksCount: this.totalAllocatedTracks,
      perClass
    };
  }
}
