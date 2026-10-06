/**
 * UnifiedRenderer.js - Unified Realtime Vision Canvas Renderer (V0.6.2)
 *
 * Menggambar deteksi terpadu (Objects & Faces) pada HTMLCanvasElement yang tepat di atas HTMLVideoElement:
 *
 * Aturan Rendering & Gaya Visual:
 * - Objek YOLO: Warna kelas spesifik (neon palette) dengan corner brackets
 * - Wajah Developer: Cyan / Emerald styling (#10b981 / #06b6d4), biometric HUD reticle,
 *                    label "VISIONX DEVELOPER <score_percent>"
 * - Wajah Unknown: Neutral / Amber styling (#f59e0b / #94a3b8), warning brackets,
 *                  label "PERSON • UNKNOWN"
 * - Tidak bergantung pada warna saja; teks label secara eksplisit mendefinisikan state identitas.
 */

import { CoordinateMapper } from './CoordinateMapper.js';

export class UnifiedRenderer {
  constructor(canvasElement) {
    this.canvas = canvasElement;
    this.ctx = canvasElement.getContext('2d');
    this.isMirrored = false;

    // Mapping warna spesifik 21 kelas VisionX V4
    this.customClassColors = {
      'person':       { border: '#38bdf8', bg: 'rgba(56, 189, 248, 0.20)', tag: '#0284c7' }, // Sky Blue
      'bottle':       { border: '#10b981', bg: 'rgba(16, 185, 129, 0.20)', tag: '#059669' }, // Emerald Green
      'cup':          { border: '#f59e0b', bg: 'rgba(245, 158, 11, 0.20)', tag: '#d97706' }, // Amber Gold
      'laptop':       { border: '#a855f7', bg: 'rgba(168, 85, 247, 0.20)', tag: '#7c3aed' }, // Purple
      'mouse':        { border: '#ec4899', bg: 'rgba(236, 72, 153, 0.20)', tag: '#db2777' }, // Rose Pink
      'keyboard':     { border: '#f97316', bg: 'rgba(249, 115, 22, 0.20)', tag: '#ea580c' }, // Orange
      'cell_phone':   { border: '#06b6d4', bg: 'rgba(6, 182, 212, 0.20)', tag: '#0891b2' }, // Cyan
      'dompet':       { border: '#8b5cf6', bg: 'rgba(139, 92, 246, 0.20)', tag: '#6d28d9' }, // Violet
      'kacamata':     { border: '#14b8a6', bg: 'rgba(20, 184, 166, 0.20)', tag: '#0f766e' }, // Teal
      'sendal':       { border: '#84cc16', bg: 'rgba(132, 204, 22, 0.20)', tag: '#65a30d' }, // Lime
      'tisue':        { border: '#38bdf8', bg: 'rgba(148, 163, 184, 0.20)', tag: '#475569' }, // Slate Blue
      'uang_100rb':   { border: '#ef4444', bg: 'rgba(239, 68, 68, 0.25)', tag: '#b91c1c' }, // Red (100rb)
      'cooler_hp':    { border: '#0284c7', bg: 'rgba(2, 132, 199, 0.20)', tag: '#0369a1' }, // Deep Sky
      'kunci_cakram': { border: '#eab308', bg: 'rgba(234, 179, 8, 0.20)', tag: '#ca8a04' }, // Gold
      'car':          { border: '#3b82f6', bg: 'rgba(59, 130, 246, 0.20)', tag: '#1d4ed8' }, // Blue (Car)
      'motorcycle':   { border: '#f97316', bg: 'rgba(249, 115, 22, 0.20)', tag: '#c2410c' }, // Amber Orange (Motorcycle)
      'backpack':     { border: '#ec4899', bg: 'rgba(236, 72, 153, 0.20)', tag: '#be185d' }, // Pink (Backpack)
      'umbrella':     { border: '#06b6d4', bg: 'rgba(6, 182, 212, 0.20)', tag: '#0e7490' }, // Cyan (Umbrella)
      'book':         { border: '#10b981', bg: 'rgba(16, 185, 129, 0.20)', tag: '#047857' }, // Emerald (Book)
      'helm':         { border: '#22c55e', bg: 'rgba(34, 197, 94, 0.25)', tag: '#15803d' },  // Safety Green (Helm)
      'tanpa_helm':   { border: '#ef4444', bg: 'rgba(239, 68, 68, 0.30)', tag: '#b91c1c' }   // Warning Red (Tanpa Helm)
    };

    // Palet warna fallback untuk kelas COCO lainnya
    this.colorPalette = [
      { border: '#06b6d4', bg: 'rgba(6, 182, 212, 0.20)', tag: '#0891b2' },
      { border: '#10b981', bg: 'rgba(16, 185, 129, 0.20)', tag: '#059669' },
      { border: '#a855f7', bg: 'rgba(168, 85, 247, 0.20)', tag: '#7c3aed' },
      { border: '#f59e0b', bg: 'rgba(245, 158, 11, 0.20)', tag: '#d97706' },
      { border: '#ec4899', bg: 'rgba(236, 72, 153, 0.20)', tag: '#db2777' },
      { border: '#3b82f6', bg: 'rgba(59, 130, 246, 0.20)', tag: '#2563eb' }
    ];
  }

  resize(width, height) {
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  clear() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  getObjectColor(className) {
    if (this.customClassColors[className]) {
      return this.customClassColors[className];
    }
    let hash = 0;
    for (let i = 0; i < (className || '').length; i++) {
      hash = className.charCodeAt(i) + ((hash << 5) - hash);
    }
    const idx = Math.abs(hash) % this.colorPalette.length;
    return this.colorPalette[idx];
  }

  /**
   * Menggambar list UnifiedDetection [{ type, bbox, label, confidence, identityStatus, ... }]
   */
  renderUnified(unifiedDetections = [], debugInfo = null, ocrRegions = [], isMirrored = null) {
    if (isMirrored !== null) {
      this.isMirrored = Boolean(isMirrored);
    }
    this.clear();
    const ctx = this.ctx;

    // Watermark debug opsional di pojok kiri atas canvas
    if (debugInfo && debugInfo.frameId) {
      ctx.save();
      if (this.isMirrored) {
        const midX = 10 + 260 / 2;
        ctx.translate(midX, 0);
        ctx.scale(-1, 1);
        ctx.translate(-midX, 0);
      }
      ctx.fillStyle = 'rgba(15, 23, 42, 0.75)';
      ctx.fillRect(10, 10, 260, 28);
      ctx.fillStyle = '#38bdf8';
      ctx.font = '600 12px Inter, sans-serif';
      const label = `Frame #${debugInfo.frameId} | ${debugInfo.inferenceTimeMs || 0}ms (${unifiedDetections.length} targets)`;
      ctx.fillText(label, 18, 28);
      ctx.restore();
    }

    // Gambar OCR Text Regions jika tersedia (V0.9 OCR + Read Text Mode)
    if (Array.isArray(ocrRegions) && ocrRegions.length > 0) {
      for (const region of ocrRegions) {
        this.renderOcrTextRegion(ctx, region);
      }
    }

    if (!unifiedDetections || unifiedDetections.length === 0) {
      return;
    }

    // Urutkan: gambar objek terlebih dahulu, kemudian wajah di layer paling atas agar tidak tertutup
    const sorted = [...unifiedDetections].sort((a, b) => {
      if (a.type === 'face' && b.type !== 'face') return 1;
      if (a.type !== 'face' && b.type === 'face') return -1;
      return 0;
    });

    for (const item of sorted) {
      if (item.type === 'face') {
        this.renderFaceItem(ctx, item);
      } else {
        this.renderObjectItem(ctx, item);
      }
    }
  }

  /**
   * Menggambar Bounding Box Hasil OCR Teks (V0.9)
   * Berbeda dengan YOLO (Corner brackets) dan Face (Biometric reticle),
   * OCR menggunakan dashed border amber (#f59e0b) dan badge tag teks.
   */
  renderOcrTextRegion(ctx, region) {
    if (!region || !region.bbox) return;
    const { x1, y1, x2, y2 } = CoordinateMapper.normalizeBbox(region.bbox);
    const w = x2 - x1;
    const h = y2 - y1;
    if (w <= 0 || h <= 0) return;

    ctx.save();
    // Fill background semi-transparan amber
    ctx.fillStyle = 'rgba(245, 158, 11, 0.12)';
    ctx.fillRect(x1, y1, w, h);

    // Dashed amber border
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 2.0;
    ctx.setLineDash([5, 4]);
    ctx.strokeRect(x1, y1, w, h);
    ctx.setLineDash([]); // reset dash

    // Badge label
    const textStr = String(region.text || '').trim();
    const confStr = region.confidence ? ` (${region.confidence}%)` : '';
    const label = `🔤 ${textStr}${confStr}`;

    ctx.font = '700 11px Inter, system-ui, -apple-system, sans-serif';
    const textMetrics = ctx.measureText(label);
    const tagW = Math.min(textMetrics.width + 16, Math.max(w, 80));
    const tagH = 20;

    let tagX = x1;
    let tagY = y1 - tagH - 2;
    if (tagY < 0) tagY = y2 + 2;

    ctx.fillStyle = 'rgba(180, 83, 9, 0.90)';
    if (ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(tagX, tagY, tagW, tagH, [4, 4, 4, 4]);
      ctx.fill();
    } else {
      ctx.fillRect(tagX, tagY, tagW, tagH);
    }

    ctx.fillStyle = '#fffbeb';
    ctx.save();
    ctx.beginPath();
    ctx.rect(tagX, tagY, tagW, tagH);
    ctx.clip();
    ctx.fillText(label, tagX + 6, tagY + 14);
    ctx.restore();

    ctx.restore();
  }

  /**
   * Menggambar Bounding Box Objek YOLO
   */
  renderObjectItem(ctx, item) {
    const { bbox, label, class_name } = item;
    const { x1, y1, x2, y2 } = CoordinateMapper.normalizeBbox(bbox);
    const w = x2 - x1;
    const h = y2 - y1;
    if (w <= 0 || h <= 0) return;

    const color = this.getObjectColor(class_name);

    // Kotak semi-transparan
    ctx.fillStyle = color.bg;
    ctx.fillRect(x1, y1, w, h);

    // Border solid
    ctx.strokeStyle = color.border;
    ctx.lineWidth = 2.2;
    ctx.strokeRect(x1, y1, w, h);

    // Corner brackets
    const cornerLen = Math.min(20, w / 4, h / 4);
    if (cornerLen > 4) {
      ctx.strokeStyle = color.border;
      ctx.lineWidth = 4.0;

      // Top-Left
      ctx.beginPath();
      ctx.moveTo(x1, y1 + cornerLen);
      ctx.lineTo(x1, y1);
      ctx.lineTo(x1 + cornerLen, y1);
      ctx.stroke();

      // Top-Right
      ctx.beginPath();
      ctx.moveTo(x2 - cornerLen, y1);
      ctx.lineTo(x2, y1);
      ctx.lineTo(x2, y1 + cornerLen);
      ctx.stroke();

      // Bottom-Left
      ctx.beginPath();
      ctx.moveTo(x1, y2 - cornerLen);
      ctx.lineTo(x1, y2);
      ctx.lineTo(x1 + cornerLen, y2);
      ctx.stroke();

      // Bottom-Right
      ctx.beginPath();
      ctx.moveTo(x2 - cornerLen, y2);
      ctx.lineTo(x2, y2);
      ctx.lineTo(x2, y2 - cornerLen);
      ctx.stroke();
    }

    // Format nama kelas dan confidence (V1.2 Personalized Recognition Integration)
    let formattedClassName = class_name ? (class_name.charAt(0).toUpperCase() + class_name.slice(1).replace('_', ' ')) : 'Object';
    const isPersonalized = item.identityStatus === 'PERSONALIZED' && Boolean(item.personalizedName);
    const isPossibleMatch = item.identityStatus === 'UNKNOWN_MATCH';

    if (isPersonalized) {
      formattedClassName = `★ ${item.personalizedName}`;
    } else if (isPossibleMatch) {
      formattedClassName = `${formattedClassName} • possible match`;
    }

    const conf = Number(item.confidence) || 0;
    let confPercent = `${Math.round(conf * 100)}%`;
    if (isPersonalized && item.matchConfidence) {
      confPercent = `${confPercent} • Match: ${Math.round(item.matchConfidence * 100)}%`;
    }

    const trackIdFormatted = item.trackIdFormatted || (item.trackId ? `#${String(item.trackId).padStart(2, '0')}` : null);

    // Render tag di atas box (atau di dalam jika mepet batas atas)
    if (trackIdFormatted) {
      // V0.7 Visual Overlay: Class Name + Distinct Track ID Pill + Confidence
      ctx.font = isPersonalized ? '800 12px Inter, system-ui, sans-serif' : '700 12px Inter, system-ui, -apple-system, sans-serif';
      const classMetrics = ctx.measureText(formattedClassName);
      
      ctx.font = '800 11px JetBrains Mono, monospace, sans-serif';
      const idMetrics = ctx.measureText(trackIdFormatted);

      ctx.font = '600 11px Inter, system-ui, -apple-system, sans-serif';
      const confMetrics = ctx.measureText(confPercent);

      const paddingX = 8;
      const row1W = classMetrics.width + 8 + idMetrics.width + 8;
      const row2W = confMetrics.width;
      const tagW = Math.max(row1W, row2W) + paddingX * 2;
      const tagH = 34; // 2 baris (Nama & ID di atas, Confidence di bawah)

      let tagX = x1;
      let tagY = y1 - tagH;
      if (tagY < 0) tagY = y1;

      // Background tag HUD (Glassmorphism gelap dengan accent garis kelas)
      if (this.isMirrored) {
        ctx.save();
        const midX = tagX + tagW / 2;
        ctx.translate(midX, 0);
        ctx.scale(-1, 1);
        ctx.translate(-midX, 0);
      }

      ctx.fillStyle = isPersonalized ? 'rgba(15, 23, 42, 0.96)' : 'rgba(15, 23, 42, 0.92)';
      if (ctx.roundRect) {
        ctx.beginPath();
        ctx.roundRect(tagX, tagY, tagW, tagH, [4, 4, 0, 0]);
        ctx.fill();
      } else {
        ctx.fillRect(tagX, tagY, tagW, tagH);
      }

      // Garis aksen kiri (Emas neon jika personalized, jika tidak pakai warna kelas)
      ctx.fillStyle = isPersonalized ? '#fbbf24' : color.border;
      ctx.fillRect(tagX, tagY, isPersonalized ? 4 : 3, tagH);

      // Baris 1: Class / Personalized Name
      ctx.font = isPersonalized ? '800 12px Inter, system-ui, sans-serif' : '700 12px Inter, system-ui, -apple-system, sans-serif';
      ctx.fillStyle = isPersonalized ? '#fbbf24' : '#f8fafc';
      ctx.fillText(formattedClassName, tagX + paddingX + 3, tagY + 14);

      // Visual Track ID Pill (Berbeda dari Class Name)
      const idPillX = tagX + paddingX + 3 + classMetrics.width + 6;
      const idPillY = tagY + 3;
      const idPillW = idMetrics.width + 8;
      const idPillH = 15;

      ctx.fillStyle = 'rgba(56, 189, 248, 0.20)';
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 1;
      if (ctx.roundRect) {
        ctx.beginPath();
        ctx.roundRect(idPillX, idPillY, idPillW, idPillH, 3);
        ctx.fill();
        ctx.stroke();
      } else {
        ctx.fillRect(idPillX, idPillY, idPillW, idPillH);
        ctx.strokeRect(idPillX, idPillY, idPillW, idPillH);
      }

      ctx.font = '800 10px JetBrains Mono, monospace, sans-serif';
      ctx.fillStyle = '#38bdf8';
      ctx.fillText(trackIdFormatted, idPillX + 4, idPillY + 11);

      // Baris 2: Confidence (94%)
      ctx.font = '600 11px Inter, system-ui, -apple-system, sans-serif';
      ctx.fillStyle = color.border;
      ctx.fillText(confPercent, tagX + paddingX + 3, tagY + 28);

      if (this.isMirrored) {
        ctx.restore();
      }

      // Velocity trail halus jika objek bergerak
      if (item.velocity && (Math.abs(item.velocity.x) > 1.5 || Math.abs(item.velocity.y) > 1.5)) {
        const cx = (x1 + x2) / 2;
        const cy = (y1 + y2) / 2;
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + item.velocity.x * 2, cy + item.velocity.y * 2);
        ctx.stroke();
      }
    } else {
      // Fallback single-line jika tanpa tracking (Kompatibilitas lama)
      ctx.font = '700 13px Inter, system-ui, -apple-system, sans-serif';
      const textMetrics = ctx.measureText(label);
      const paddingX = 8;
      const tagW = textMetrics.width + paddingX * 2;
      const tagH = 22;

      let tagX = x1;
      let tagY = y1 - tagH;
      if (tagY < 0) tagY = y1;

      if (this.isMirrored) {
        ctx.save();
        const midX = tagX + tagW / 2;
        ctx.translate(midX, 0);
        ctx.scale(-1, 1);
        ctx.translate(-midX, 0);
      }

      ctx.fillStyle = color.border;
      if (ctx.roundRect) {
        ctx.beginPath();
        ctx.roundRect(tagX, tagY, tagW, tagH, [4, 4, 0, 0]);
        ctx.fill();
      } else {
        ctx.fillRect(tagX, tagY, tagW, tagH);
      }

      ctx.fillStyle = '#0f172a';
      ctx.fillText(label, tagX + paddingX, tagY + 15);

      if (this.isMirrored) {
        ctx.restore();
      }
    }
  }

  /**
   * Menggambar Bounding Box Wajah (Developer vs Unknown)
   */
  renderFaceItem(ctx, item) {
    const { bbox, label, identityStatus } = item;
    const { x1, y1, x2, y2 } = CoordinateMapper.normalizeBbox(bbox);
    const w = x2 - x1;
    const h = y2 - y1;
    if (w <= 0 || h <= 0) return;

    const isDeveloper = identityStatus === 'REGISTERED';

    // Gaya visual distinct sesuai spesifikasi:
    // Developer: cyan/emerald (#10b981 / #06b6d4)
    // Unknown: neutral/amber (#f59e0b / #94a3b8)
    const style = isDeveloper
      ? {
          border: '#10b981',
          accent: '#06b6d4',
          bg: 'rgba(16, 185, 129, 0.22)',
          tagBg: 'linear-gradient(135deg, #10b981, #059669)',
          textBg: '#059669',
          textColor: '#ffffff',
          badgeText: 'DEV'
        }
      : {
          border: '#f59e0b',
          accent: '#94a3b8',
          bg: 'rgba(245, 158, 11, 0.18)',
          tagBg: 'linear-gradient(135deg, #f59e0b, #d97706)',
          textBg: '#d97706',
          textColor: '#ffffff',
          badgeText: 'UNKNOWN'
        };

    // Fill transparan
    ctx.fillStyle = style.bg;
    ctx.fillRect(x1, y1, w, h);

    // Garis kotak utama
    ctx.strokeStyle = style.border;
    ctx.lineWidth = 2.8;

    if (!isDeveloper) {
      // Kotak garis putus-putus untuk wajah tak dikenal
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(x1, y1, w, h);
      ctx.setLineDash([]);
    } else {
      // Kotak solid bersinar untuk Developer
      ctx.strokeRect(x1, y1, w, h);
    }

    // Biometric Reticle Corner Accents
    const reticleLen = Math.min(24, w / 3, h / 3);
    if (reticleLen > 5) {
      ctx.strokeStyle = style.border;
      ctx.lineWidth = 4.2;

      // Top-Left Reticle
      ctx.beginPath();
      ctx.moveTo(x1, y1 + reticleLen);
      ctx.lineTo(x1, y1);
      ctx.lineTo(x1 + reticleLen, y1);
      ctx.stroke();

      // Top-Right Reticle
      ctx.beginPath();
      ctx.moveTo(x2 - reticleLen, y1);
      ctx.lineTo(x2, y1);
      ctx.lineTo(x2, y1 + reticleLen);
      ctx.stroke();

      // Bottom-Left Reticle
      ctx.beginPath();
      ctx.moveTo(x1, y2 - reticleLen);
      ctx.lineTo(x1, y2);
      ctx.lineTo(x1 + reticleLen, y2);
      ctx.stroke();

      // Bottom-Right Reticle
      ctx.beginPath();
      ctx.moveTo(x2 - reticleLen, y2);
      ctx.lineTo(x2, y2);
      ctx.lineTo(x2, y2 - reticleLen);
      ctx.stroke();
    }

    // Label Tag
    ctx.font = '800 13px Inter, system-ui, -apple-system, sans-serif';
    const textMetrics = ctx.measureText(label);
    const paddingX = 10;
    const tagW = textMetrics.width + paddingX * 2 + 18; // ruang untuk status dot
    const tagH = 26;

    let tagX = x1;
    let tagY = y1 - tagH;
    if (tagY < 0) tagY = y1 + h; // pindah ke bawah jika terpotong layar

    // Background Badge Tag
    if (this.isMirrored) {
      ctx.save();
      const midX = tagX + tagW / 2;
      ctx.translate(midX, 0);
      ctx.scale(-1, 1);
      ctx.translate(-midX, 0);
    }

    ctx.fillStyle = style.textBg;
    if (ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(tagX, tagY, tagW, tagH, [6, 6, 6, 6]);
      ctx.fill();
    } else {
      ctx.fillRect(tagX, tagY, tagW, tagH);
    }

    // Indicator Dot
    ctx.fillStyle = isDeveloper ? '#6ee7b7' : '#fef08a';
    ctx.beginPath();
    ctx.arc(tagX + 12, tagY + tagH / 2, 4.5, 0, Math.PI * 2);
    ctx.fill();

    // Teks Label
    ctx.fillStyle = style.textColor;
    ctx.fillText(label, tagX + 22, tagY + 17);

    if (this.isMirrored) {
      ctx.restore();
    }
  }

  // Kompatibilitas dengan pemanggil lama render(detections, debugInfo)
  render(detections = [], debugInfo = null) {
    const unified = detections.map(d => {
      if (d.type) return d;
      return {
        type: 'object',
        bbox: { x1: d.x1, y1: d.y1, x2: d.x2, y2: d.y2 },
        label: `${d.class_name || 'object'} ${Math.round((d.confidence || 0) * 100)}%`,
        confidence: d.confidence || 0,
        identityStatus: 'OBJECT',
        class_name: d.class_name
      };
    });
    this.renderUnified(unified, debugInfo);
  }
}
