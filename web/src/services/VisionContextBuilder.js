/**
 * VisionContextBuilder.js - VisionX V1.0 Multimodal Context Synthesizer
 *
 * Mengumpulkan, memetakan, dan menyusun data kontekstual dari seluruh subsistem vision
 * (YOLO detections, TrackingEngine, OCRService, IdentityService, Camera metadata)
 * menjadi objek JSON terstruktur yang kaya untuk konsumsi Vision LLM / AI Assistant.
 *
 * Desain:
 * - Bersih, murni fungsional dan modular (tanpa efek samping ke visual rendering loop)
 * - Mampu menangani deteksi kosong, multi-objek, teks OCR, dan status identitas
 * - Menghitung posisi spasial relatif (e.g. "kiri atas", "tengah", "kanan bawah")
 * - Mengembalikan JSON terstruktur dan prompt teks ringkas untuk LLM
 */

import { SpatialRelationEngine } from './SpatialRelationEngine.js';
import { SceneUnderstandingEngine } from './SceneUnderstandingEngine.js';

export class VisionContextBuilder {
  /**
   * Menentukan posisi relatif objek dalam frame kamera
   * @param {Array<number>} bbox [x1, y1, x2, y2]
   * @param {number} frameWidth
   * @param {number} frameHeight
   * @returns {string} Contoh: "kiri atas", "tengah", "kanan bawah"
   */
  static getRelativePosition(bbox, frameWidth = 640, frameHeight = 480) {
    if (!bbox || bbox.length < 4 || frameWidth <= 0 || frameHeight <= 0) {
      return 'tengah';
    }

    const [x1, y1, x2, y2] = bbox;
    const cx = (x1 + x2) / 2;
    const cy = (y1 + y2) / 2;

    const normX = cx / frameWidth;
    const normY = cy / frameHeight;

    let hPos = 'tengah';
    if (normX < 0.35) hPos = 'kiri';
    else if (normX > 0.65) hPos = 'kanan';

    let vPos = 'tengah';
    if (normY < 0.35) vPos = 'atas';
    else if (normY > 0.65) vPos = 'bawah';

    if (hPos === 'tengah' && vPos === 'tengah') {
      return 'tengah';
    }
    return `${hPos} ${vPos}`.trim();
  }

  /**
   * Menerjemahkan arah pergerakan dari vektor kecepatan
   * @param {number} vx
   * @param {number} vy
   * @returns {string}
   */
  static getMovementDescription(vx = 0, vy = 0) {
    const speed = Math.hypot(vx, vy);
    if (speed < 0.05) return 'diam / stabil';

    const directions = [];
    if (vx > 0.05) directions.push('kanan');
    else if (vx < -0.05) directions.push('kiri');

    if (vy > 0.05) directions.push('bawah');
    else if (vy < -0.05) directions.push('atas');

    return directions.length > 0 ? `bergerak ke arah ${directions.join(' ')}` : 'stabil';
  }

  /**
   * Membangun objek context JSON terstruktur lengkap
   * @param {Object} params
   * @param {Array} [params.detections=[]] Array hasil inferensi YOLO [{ class_name, confidence, bbox }]
   * @param {Object|null} [params.trackingEngine=null] Instance TrackingEngine aktif
   * @param {Object|null} [params.ocrResult=null] Hasil OCRService terbaru { text, confidence, regions }
   * @param {Object|null} [params.identityState=null] Status profil identitas developer
   * @param {Object|null} [params.objectMemory=null] Instance ObjectMemory aktif (V1.1)
   * @param {Object|null} [params.personalObjectRegistry=null] Instance PersonalObjectRegistry aktif (V1.2)
   * @param {Object|null} [params.safetyEngine=null] Instance SafetyEngine aktif (V1.6)
   * @param {Object|null} [params.alertManager=null] Instance AlertManager aktif (V1.6)
   * @param {Object|null} [params.sceneHistoryEngine=null] Instance SceneHistoryEngine aktif (V1.6 Phase C)
   * @param {Object|null} [params.cameraInfo=null] Metadata kamera { width, height, isConnected, label }
   * @param {string} [params.currentMode='detection'] Mode aplikasi saat ini
   * @returns {Object} JSON Context Terstruktur
   */
  static build({
    detections = [],
    trackingEngine = null,
    ocrResult = null,
    identityState = null,
    objectMemory = null,
    personalObjectRegistry = null,
    safetyEngine = null,
    alertManager = null,
    sceneHistoryEngine = null,
    cameraInfo = null,
    currentMode = 'detection'
  } = {}) {
    const timestamp = new Date().toISOString();
    const frameW = cameraInfo?.width || 640;
    const frameH = cameraInfo?.height || 480;

    // 1. Ekstraksi Detections
    const safeDetections = Array.isArray(detections) ? detections : [];
    const formattedDetections = safeDetections.map((d, index) => {
      const bbox = Array.isArray(d.bbox) ? d.bbox : [0, 0, 0, 0];
      const cx = bbox.length === 4 ? Math.round((bbox[0] + bbox[2]) / 2) : 0;
      const cy = bbox.length === 4 ? Math.round((bbox[1] + bbox[3]) / 2) : 0;
      const w = bbox.length === 4 ? Math.round(bbox[2] - bbox[0]) : 0;
      const h = bbox.length === 4 ? Math.round(bbox[3] - bbox[1]) : 0;

      return {
        id: d.id || d.track_id || `det_${index + 1}`,
        class_name: d.class_name || d.name || 'unknown',
        confidence: typeof d.confidence === 'number' ? Math.round(d.confidence * 100) / 100 : null,
        bbox: [Math.round(bbox[0]), Math.round(bbox[1]), Math.round(bbox[2]), Math.round(bbox[3])],
        center: { x: cx, y: cy },
        size: { width: w, height: h },
        relative_position: VisionContextBuilder.getRelativePosition(bbox, frameW, frameH)
      };
    });

    // Ringkasan kelas objek
    const classCountMap = {};
    for (const d of formattedDetections) {
      classCountMap[d.class_name] = (classCountMap[d.class_name] || 0) + 1;
    }
    const detectedClasses = Object.keys(classCountMap);

    // 2. Ekstraksi Tracking Information
    let trackingInfo = {
      is_enabled: false,
      active_tracks_count: 0,
      tracks: []
    };

    if (trackingEngine && typeof trackingEngine.getTracks === 'function') {
      const activeTracks = trackingEngine.getTracks().filter(t => t.isConfirmed && !t.isLost);
      trackingInfo = {
        is_enabled: !!trackingEngine.isEnabled,
        active_tracks_count: activeTracks.length,
        tracks: activeTracks.map(t => {
          const vx = t.velocity?.vx || 0;
          const vy = t.velocity?.vy || 0;
          return {
            track_id: t.trackId,
            class_name: t.className,
            confidence: Math.round((t.confidence || 0) * 100) / 100,
            status: t.isLost ? 'LOST' : 'ACTIVE',
            movement: VisionContextBuilder.getMovementDescription(vx, vy),
            speed: Math.round(Math.hypot(vx, vy) * 100) / 100,
            history_length: Array.isArray(t.history) ? t.history.length : 0,
            relative_position: VisionContextBuilder.getRelativePosition(t.bbox, frameW, frameH)
          };
        })
      };
    }

    // 3. Ekstraksi OCR Text Result
    const rawOcrText = typeof ocrResult?.text === 'string' ? ocrResult.text.trim() : '';
    const ocrInfo = {
      has_text: rawOcrText.length > 0,
      text: rawOcrText,
      confidence: typeof ocrResult?.confidence === 'number' ? ocrResult.confidence : null,
      language: ocrResult?.language || 'ind',
      region_count: Array.isArray(ocrResult?.regions) ? ocrResult.regions.length : 0,
      regions: Array.isArray(ocrResult?.regions)
        ? ocrResult.regions.map(r => ({
            text: r.text,
            confidence: r.confidence,
            bbox: r.bbox || null
          }))
        : []
    };

    // 4. Ekstraksi Identity State
    let identityInfo = {
      is_enabled: false,
      is_developer_verified: false,
      status: 'UNAVAILABLE',
      profile_name: 'VisionX Developer',
      similarity_score: 0,
      matches_count: 0
    };

    if (identityState) {
      identityInfo = {
        is_enabled: true,
        is_developer_verified: !!identityState.isDeveloper,
        status: identityState.status || (identityState.isDeveloper ? 'DEVELOPER_VERIFIED' : 'UNKNOWN_PERSON'),
        profile_name: identityState.profileName || 'VisionX Developer',
        similarity_score: typeof identityState.similarity === 'number' ? Math.round(identityState.similarity * 100) / 100 : 0,
        matches_count: identityState.matchesCount || (identityState.isDeveloper ? 1 : 0)
      };
    }

    // 5. Ekstraksi Object Memory (V1.1)
    let memoryInfo = {
      is_enabled: false,
      total_records: 0,
      active_count: 0,
      known_objects: [],
      recent_events: [],
      last_seen: {}
    };

    if (objectMemory && typeof objectMemory.getStats === 'function') {
      const stats = objectMemory.getStats();
      const activeObjs = objectMemory.getActiveObjects();
      const recentEvts = objectMemory.getRecentEvents(8);

      const lastSeenMap = {};
      for (const obj of objectMemory.getAllObjects()) {
        if (!lastSeenMap[obj.className] || obj.lastSeen > (lastSeenMap[obj.className].last_seen_time || 0)) {
          lastSeenMap[obj.className] = {
            track_id: obj.trackId,
            zone: obj.lastSpatialPosition,
            last_seen_iso: obj.lastSeenIso,
            last_seen_time: obj.lastSeen,
            state: obj.state
          };
        }
      }

      memoryInfo = {
        is_enabled: true,
        total_records: stats.totalRecords,
        active_count: stats.activeCount,
        recent_events: recentEvts.map(e => ({
          type: e.type,
          description: e.description,
          time: e.timeString
        })),
        known_objects: activeObjs.map(o => ({
          track_id: o.trackId,
          class_name: o.className,
          zone: o.lastSpatialPosition,
          state: o.state
        })),
        last_seen: lastSeenMap
      };
    }

    // 5.5. Ekstraksi Personalized Objects (V1.2)
    const personalizedList = [];
    if (objectMemory && typeof objectMemory.getPersonalizedObjects === 'function') {
      for (const obj of objectMemory.getPersonalizedObjects()) {
        personalizedList.push({
          track_id: obj.trackId,
          class_name: obj.className,
          personalized_name: obj.personalizedName,
          identity_status: obj.identityStatus,
          match_confidence: obj.matchConfidence,
          relative_position: obj.lastSpatialPosition,
          is_active: obj.state === 'ACTIVE'
        });
      }
    }

    // 5.6. Ekstraksi Safety & Alert Engine (V1.6 Phase A)
    let safetyInfo = {
      is_enabled: false,
      risk_level: 'NORMAL',
      active_alerts_count: 0,
      active_alerts: [],
      monitored_tracks_count: 0,
      recent_safety_events: []
    };

    if (safetyEngine && typeof safetyEngine.getDiagnostics === 'function') {
      const diag = safetyEngine.getDiagnostics();
      const isEngineEnabled = diag?.enabled ?? safetyEngine.config?.enabled ?? true;
      const recentEvents = typeof safetyEngine.getEventHistory === 'function'
        ? safetyEngine.getEventHistory().slice(0, 5)
        : [];

      let alerts = [];
      let isAlertsEnabled = true;
      if (alertManager && typeof alertManager.getAlerts === 'function') {
        alerts = alertManager.getAlerts();
        isAlertsEnabled = alertManager.config?.safetyAlertsEnabled ?? true;
      }

      const activeAlerts = (isAlertsEnabled && Array.isArray(alerts)) ? alerts : [];

      // Kalkulasi composite risk level berdasarkan alert aktif dan event terbaru
      let compositeRisk = 'LOW';
      if (!isEngineEnabled) {
        compositeRisk = 'UNKNOWN';
      } else if (activeAlerts.some(a => a.severity === 'CRITICAL') || recentEvents.some(e => e.severity === 'CRITICAL')) {
        compositeRisk = 'CRITICAL';
      } else if (activeAlerts.some(a => a.severity === 'HIGH') || recentEvents.some(e => e.severity === 'HIGH')) {
        compositeRisk = 'HIGH';
      } else if (activeAlerts.some(a => a.severity === 'NORMAL') || recentEvents.some(e => e.severity === 'NORMAL')) {
        compositeRisk = 'NORMAL';
      } else if (activeAlerts.length > 0 || recentEvents.length > 0) {
        compositeRisk = 'NORMAL';
      } else {
        compositeRisk = 'LOW';
      }

      safetyInfo = {
        is_enabled: !!isEngineEnabled,
        risk_level: compositeRisk,
        active_alerts_count: activeAlerts.length,
        active_alerts: activeAlerts.slice(0, 5).map(a => ({
          id: a.id,
          type: a.type,
          severity: a.severity,
          object_name: a.objectName,
          title: a.title,
          message: a.message,
          last_zone: a.lastZone,
          is_personal: !!a.isPersonal,
          timestamp: a.timestamp
        })),
        monitored_tracks_count: diag?.activeMonitoredTracks || 0,
        recent_safety_events: recentEvents.map(e => ({
          type: e.type,
          severity: e.severity,
          object_name: e.objectName,
          last_zone: e.lastZone,
          timestamp: e.timestamp
        }))
      };
    }

    // 5.7. Ekstraksi Relasi Spasial 2D & Scene Understanding (V1.6 Phase B)
    const spatialRelations = SpatialRelationEngine.computeRelations(formattedDetections, frameW, frameH);
    const sceneUnderstanding = SceneUnderstandingEngine.synthesize({
      detections: formattedDetections,
      spatialRelations,
      frameWidth: frameW,
      frameHeight: frameH
    });

    // 5.8. Ekstraksi Temporal Scene Delta (V1.6 Phase C)
    let temporalDelta = null;
    if (sceneHistoryEngine && typeof sceneHistoryEngine.computeDelta === 'function') {
      temporalDelta = sceneHistoryEngine.computeDelta(15);
    }

    // 6. Rakit Keseluruhan Context
    return {
      version: '1.6',
      timestamp,
      app_mode: currentMode,
      camera: {
        is_active: !!(cameraInfo?.isConnected ?? true),
        width: frameW,
        height: frameH,
        label: cameraInfo?.label || 'Webcam'
      },
      summary: {
        total_objects: formattedDetections.length,
        classes_present: detectedClasses,
        class_counts: classCountMap,
        tracked_objects_count: trackingInfo.active_tracks_count,
        has_ocr_text: ocrInfo.has_text,
        identity_verified: identityInfo.is_developer_verified,
        memory_records_count: memoryInfo.total_records,
        personalized_objects_count: personalizedList.length,
        safety_risk_level: safetyInfo.risk_level,
        active_alerts_count: safetyInfo.active_alerts_count,
        clutter_level: sceneUnderstanding.clutter_level,
        focal_object: sceneUnderstanding.focal_object ? sceneUnderstanding.focal_object.class_name : null,
        recent_changes_detected: temporalDelta ? temporalDelta.has_changes : false
      },
      detections: formattedDetections,
      tracking: trackingInfo,
      ocr: ocrInfo,
      identity: identityInfo,
      memory: memoryInfo,
      personalizedObjects: personalizedList,
      safety: safetyInfo,
      sceneUnderstanding: sceneUnderstanding,
      temporalDelta: temporalDelta
    };
  }

  /**
   * Mengubah objek context menjadi format prompt natural untuk LLM
   * @param {Object} context Output dari VisionContextBuilder.build()
   * @returns {string} Prompt sistem kontekstual
   */
  static formatPromptContext(context) {
    if (!context) return 'Konteks visual tidak tersedia.';

    const lines = [];
    lines.push(`[WAKTU PENGAMBILAN]: ${context.timestamp || new Date().toLocaleString()}`);
    lines.push(`[RESOLUSI KAMERA]: ${context.camera?.width || 640}x${context.camera?.height || 480}`);

    // Ringkasan Objek
    const count = context.summary?.total_objects || 0;
    if (count === 0) {
      lines.push('[OBJEK TERDETEKSI]: Tidak ada objek terdeteksi di kamera.');
    } else {
      const classSummaries = Object.entries(context.summary?.class_counts || {})
        .map(([cls, qty]) => `${cls}: ${qty}`)
        .join(', ');
      lines.push(`[OBJEK TERDETEKSI (${count})]: ${classSummaries}`);

      const detDetails = (context.detections || [])
        .map(d => `- ${d.class_name} (akurasi ${(d.confidence * 100).toFixed(0)}%, posisi: ${d.relative_position})`)
        .join('\n');
      lines.push(detDetails);
    }

    // Tracking
    if (context.tracking?.is_enabled && context.tracking.active_tracks_count > 0) {
      const trackLines = context.tracking.tracks
        .map(t => `- Track #${t.track_id} [${t.class_name}] ${t.movement} (${t.relative_position})`)
        .join('\n');
      lines.push(`[TRACKING AKTIF]:\n${trackLines}`);
    }

    // OCR Teks
    if (context.ocr?.has_text) {
      lines.push(`[TEKS DIBACA OLEH OCR]: "${context.ocr.text}" (Akurasi: ${context.ocr.confidence || 0}%)`);
    }

    // Identitas
    if (context.identity?.is_enabled) {
      if (context.identity.is_developer_verified) {
        lines.push(`[PENGENALAN WAJAH]: Terverifikasi sebagai ${context.identity.profile_name} (Kemiripan: ${(context.identity.similarity_score * 100).toFixed(1)}%)`);
      } else if (context.identity.status === 'UNKNOWN_PERSON') {
        lines.push('[PENGENALAN WAJAH]: Terdeteksi wajah orang lain / tidak dikenal.');
      }
    }

    // Memori Objek
    if (context.memory?.is_enabled && context.memory.total_records > 0) {
      const lastSeenSummary = Object.entries(context.memory.last_seen || {})
        .map(([cls, item]) => `${cls}: di area ${item.zone} (${item.state})`)
        .join(', ');
      lines.push(`[MEMORI OBJEK SESI]: ${lastSeenSummary}`);
    }

    // Barang Personal (V1.2)
    if (Array.isArray(context.personalizedObjects) && context.personalizedObjects.length > 0) {
      const pSummary = context.personalizedObjects
        .map(p => `"${p.personalized_name}" (${p.class_name} #${p.track_id}, ${p.relative_position})`)
        .join(', ');
      lines.push(`[BARANG PERSONAL TERIDENTIFIKASI]: ${pSummary}`);
    }

    // Peringatan Keselamatan & Alert (V1.6 Phase A)
    if (context.safety?.is_enabled) {
      if (context.safety.active_alerts_count > 0) {
        const alertLines = context.safety.active_alerts
          .map(a => `- [${a.severity}] ${a.title}: ${a.message}`)
          .join('\n');
        lines.push(`[PERINGATAN KESELAMATAN AKTIF (${context.safety.active_alerts_count}, TINGKAT RISIKO: ${context.safety.risk_level})]:\n${alertLines}`);
      } else {
        lines.push(`[STATUS KESELAMATAN]: Aman / Terkendali (Tingkat risiko: ${context.safety.risk_level})`);
      }
    }

    // Situasi & Relasi Spasial 2D (V1.6 Phase B)
    if (context.sceneUnderstanding?.spatial_narrative) {
      lines.push(`[ANALISIS SITUASI & SPASIAL (Kepadatan: ${context.sceneUnderstanding.clutter_level})]: ${context.sceneUnderstanding.spatial_narrative}`);
    }

    // Perubahan Temporal (V1.6 Phase C)
    if (context.temporalDelta?.narrative) {
      lines.push(`[PERUBAHAN DALAM 15 DETIK TERAKHIR]: ${context.temporalDelta.narrative}`);
    }

    return lines.join('\n');
  }
}
