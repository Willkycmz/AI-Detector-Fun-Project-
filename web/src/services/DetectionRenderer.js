/**
 * DetectionRenderer - Menggambar visualisasi bounding box, label kelas, dan confidence
 * di atas HTMLCanvasElement yang berada tepat di atas HTMLVideoElement.
 */

export class DetectionRenderer {
  constructor(canvasElement) {
    this.canvas = canvasElement;
    this.ctx = canvasElement.getContext('2d');
    
    // Palet warna neon modern (RGB)
    this.colorPalette = [
      { border: '#06b6d4', bg: 'rgba(6, 182, 212, 0.20)', tag: '#0891b2' },  // Cyan
      { border: '#10b981', bg: 'rgba(16, 185, 129, 0.20)', tag: '#059669' }, // Emerald
      { border: '#a855f7', bg: 'rgba(168, 85, 247, 0.20)', tag: '#7c3aed' }, // Purple
      { border: '#f59e0b', bg: 'rgba(245, 158, 11, 0.20)', tag: '#d97706' }, // Amber
      { border: '#ec4899', bg: 'rgba(236, 72, 153, 0.20)', tag: '#db2777' }, // Pink
      { border: '#3b82f6', bg: 'rgba(59, 130, 246, 0.20)', tag: '#2563eb' }  // Blue
    ];
  }

  /**
   * Menyesuaikan ukuran canvas agar presisi dengan ukuran elemen video.
   */
  resize(width, height) {
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  /**
   * Membersihkan seluruh isi canvas.
   */
  clear() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /**
   * Mengambil warna konsisten berdasarkan string nama kelas.
   */
  getColor(className) {
    let hash = 0;
    for (let i = 0; i < className.length; i++) {
      hash = className.charCodeAt(i) + ((hash << 5) - hash);
    }
    const index = Math.abs(hash) % this.colorPalette.length;
    return this.colorPalette[index];
  }

  /**
   * Menggambar hasil deteksi ke canvas.
   * @param {Array} detections List DetectionResult [{ class_name, confidence, x1, y1, x2, y2 }]
   * @param {Object} debugInfo Info debug opsional { frameId, inferenceTimeMs }
   */
  render(detections = [], debugInfo = null) {
    // 1. Selalu bersihkan canvas di awal render
    this.clear();

    const ctx = this.ctx;

    // 2. Gambar debug watermark jika ada
    if (debugInfo && debugInfo.frameId) {
      ctx.fillStyle = 'rgba(15, 23, 42, 0.65)';
      ctx.fillRect(10, 10, 210, 28);
      ctx.fillStyle = '#38bdf8';
      ctx.font = '600 12px Inter, sans-serif';
      ctx.fillText(`Frame #${debugInfo.frameId} | ${debugInfo.inferenceTimeMs}ms`, 18, 28);
    }

    if (!detections || detections.length === 0) {
      return;
    }

    for (const det of detections) {
      const { class_name, confidence, x1, y1, x2, y2 } = det;
      const color = this.getColor(class_name);
      const w = x2 - x1;
      const h = y2 - y1;

      // Kotak transparan halus
      ctx.fillStyle = color.bg;
      ctx.fillRect(x1, y1, w, h);

      // Garis kotak utama
      ctx.strokeStyle = color.border;
      ctx.lineWidth = 2;
      ctx.strokeRect(x1, y1, w, h);

      // Corner Accents (Sudut modern kontras)
      const cornerLen = Math.min(20, w / 4, h / 4);
      if (cornerLen > 3) {
        ctx.strokeStyle = color.border;
        ctx.lineWidth = 4;

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

      // Label Tag Nama Kelas & Confidence
      const confPercent = Math.round(confidence * 100);
      const labelText = `${class_name} ${confPercent}%`;

      ctx.font = '600 13px Inter, system-ui, -apple-system, sans-serif';
      const textMetrics = ctx.measureText(labelText);
      const paddingX = 8;
      const tagW = textMetrics.width + paddingX * 2;
      const tagH = 22;

      let tagX = x1;
      let tagY = y1 - tagH;
      if (tagY < 0) tagY = y1;

      // Background Tag
      ctx.fillStyle = color.border;
      if (ctx.roundRect) {
        ctx.beginPath();
        ctx.roundRect(tagX, tagY, tagW, tagH, [4, 4, 0, 0]);
        ctx.fill();
      } else {
        ctx.fillRect(tagX, tagY, tagW, tagH);
      }

      // Teks Tag
      ctx.fillStyle = '#ffffff';
      ctx.fillText(labelText, tagX + paddingX, tagY + 15);
    }
  }
}
