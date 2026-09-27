/**
 * CoordinateMapper.js - Shared Unified Coordinate Transformation Engine (V0.6.2)
 *
 * Mengelola transformasi koordinat yang terstandarisasi untuk semua sistem visi VisionX:
 * raw camera coordinates
 *   → preprocessing transform (letterbox padding & scaling)
 *   → video coordinates
 *   → canvas coordinates
 *   → display coordinates
 *
 * Memastikan YOLO dan YuNet menggunakan logika transformasi yang sama persis tanpa perbedaan desimal.
 * Mendukung:
 * - Rasio aspek 16:9 (webcam standar 1280x720, 1920x1080)
 * - Rasio aspek 4:3 (kamera 640x480, 1280x960)
 * - Portrait phone video (9:16, 720x1280, 1080x1920)
 * - Mirrored front camera (pencerminan horizontal x1 <-> x2)
 * - Letterboxed / pillarboxed video container dengan object-fit: contain
 */

export class CoordinateMapper {
  /**
   * Menghitung parameter letterbox standar YOLO/YuNet (skala terpadu & padding).
   * @param {number} srcW Lebar citra sumber (video/kamera)
   * @param {number} srcH Tinggi citra sumber (video/kamera)
   * @param {number} targetDim Dimensi kotak persegi target model (default: 640)
   * @returns {Object} { scale, padX, padY, nw, nh, targetDim, srcW, srcH, aspectRatio, aspectLabel }
   */
  static computeLetterboxParams(srcW, srcH, targetDim = 640) {
    const w = Math.max(1, Number(srcW) || 640);
    const h = Math.max(1, Number(srcH) || 640);

    const scale = Math.min(targetDim / w, targetDim / h);
    const nw = Math.round(w * scale);
    const nh = Math.round(h * scale);
    const padX = (targetDim - nw) / 2;
    const padY = (targetDim - nh) / 2;

    const aspect = w / h;
    let aspectLabel = '16:9';
    if (Math.abs(aspect - 16 / 9) < 0.1) {
      aspectLabel = '16:9';
    } else if (Math.abs(aspect - 4 / 3) < 0.1) {
      aspectLabel = '4:3';
    } else if (Math.abs(aspect - 9 / 16) < 0.1) {
      aspectLabel = '9:16 (Portrait)';
    } else if (aspect < 1) {
      aspectLabel = `Portrait (${aspect.toFixed(2)})`;
    } else {
      aspectLabel = `Landscape (${aspect.toFixed(2)})`;
    }

    return {
      scale,
      padX,
      padY,
      nw,
      nh,
      targetDim,
      srcW: w,
      srcH: h,
      aspectRatio: aspect,
      aspectLabel
    };
  }

  /**
   * Menstandarisasi berbagai format bounding box menjadi format konsisten { x1, y1, x2, y2 }.
   * Format yang didukung:
   * - { x1, y1, x2, y2 }
   * - { x, y, width, height } atau { x, y, w, h }
   * - [x1, y1, x2, y2]
   * - [x, y, w, h] (bila isXYWH = true)
   */
  static normalizeBbox(box, isXYWH = false) {
    if (!box) {
      return { x1: 0, y1: 0, x2: 0, y2: 0 };
    }

    if (Array.isArray(box)) {
      if (box.length >= 4) {
        if (isXYWH) {
          const x = Number(box[0]) || 0;
          const y = Number(box[1]) || 0;
          const w = Number(box[2]) || 0;
          const h = Number(box[3]) || 0;
          return { x1: x, y1: y, x2: x + w, y2: y + h };
        }
        return {
          x1: Number(box[0]) || 0,
          y1: Number(box[1]) || 0,
          x2: Number(box[2]) || 0,
          y2: Number(box[3]) || 0
        };
      }
      return { x1: 0, y1: 0, x2: 0, y2: 0 };
    }

    if (typeof box === 'object') {
      if ('x1' in box && 'y1' in box && 'x2' in box && 'y2' in box) {
        return {
          x1: Number(box.x1) || 0,
          y1: Number(box.y1) || 0,
          x2: Number(box.x2) || 0,
          y2: Number(box.y2) || 0
        };
      }
      if ('x' in box && 'y' in box) {
        const w = Number(box.width ?? box.w) || 0;
        const h = Number(box.height ?? box.h) || 0;
        const x = Number(box.x) || 0;
        const y = Number(box.y) || 0;
        return { x1: x, y1: y, x2: x + w, y2: y + h };
      }
    }

    return { x1: 0, y1: 0, x2: 0, y2: 0 };
  }

  /**
   * Mengonversi koordinat ruang model preprocessed (letterbox 640x640) kembali ke ruang video asli.
   * Dipakai bersama oleh YOLO dan YuNet.
   * @param {Object|Array} box Bounding box dalam ruang model preprocessed
   * @param {Object} letterboxParams Parameter dari computeLetterboxParams
   * @param {boolean} isMirrored Apakah video dicerminkan secara horizontal
   * @param {boolean} isXYWH Apakah input berupa format [x, y, w, h] (seperti output cv2.FaceDetectorYN)
   * @returns {Object} { x1, y1, x2, y2, width, height }
   */
  static modelToVideo(box, letterboxParams, isMirrored = false, isXYWH = false) {
    const norm = this.normalizeBbox(box, isXYWH);
    const { scale, padX, padY, srcW, srcH } = letterboxParams;

    // Unpad & Scale back
    let x1 = (norm.x1 - padX) / scale;
    let y1 = (norm.y1 - padY) / scale;
    let x2 = (norm.x2 - padX) / scale;
    let y2 = (norm.y2 - padY) / scale;

    // Pastikan berada di dalam batas resolusi sumber
    x1 = Math.max(0, Math.min(srcW, x1));
    y1 = Math.max(0, Math.min(srcH, y1));
    x2 = Math.max(0, Math.min(srcW, x2));
    y2 = Math.max(0, Math.min(srcH, y2));

    // Jika kamera mirrored (misal selfie mode), balikkan koordinat X
    if (isMirrored) {
      const origX1 = x1;
      x1 = srcW - x2;
      x2 = srcW - origX1;
    }

    const rx1 = Math.round(Math.min(x1, x2));
    const ry1 = Math.round(Math.min(y1, y2));
    const rx2 = Math.round(Math.max(x1, x2));
    const ry2 = Math.round(Math.max(y1, y2));

    return {
      x1: rx1,
      y1: ry1,
      x2: rx2,
      y2: ry2,
      width: rx2 - rx1,
      height: ry2 - ry1
    };
  }

  /**
   * Mengonversi koordinat video asli ke ruang model letterbox.
   */
  static videoToModel(box, letterboxParams, isMirrored = false) {
    const norm = this.normalizeBbox(box);
    const { scale, padX, padY, srcW, targetDim } = letterboxParams;

    let x1 = norm.x1;
    let x2 = norm.x2;

    if (isMirrored) {
      const origX1 = x1;
      x1 = srcW - x2;
      x2 = srcW - origX1;
    }

    let mx1 = x1 * scale + padX;
    let my1 = norm.y1 * scale + padY;
    let mx2 = x2 * scale + padX;
    let my2 = norm.y2 * scale + padY;

    mx1 = Math.max(0, Math.min(targetDim, mx1));
    my1 = Math.max(0, Math.min(targetDim, my1));
    mx2 = Math.max(0, Math.min(targetDim, mx2));
    my2 = Math.max(0, Math.min(targetDim, my2));

    return {
      x1: Math.round(mx1),
      y1: Math.round(my1),
      x2: Math.round(mx2),
      y2: Math.round(my2),
      width: Math.round(mx2 - mx1),
      height: Math.round(my2 - my1)
    };
  }

  /**
   * Mengonversi koordinat video ke koordinat canvas overlay.
   * Jika canvas memiliki ukuran piksel yang sama dengan video (standar VisionX),
   * koordinat akan langsung 1:1.
   */
  static videoToCanvas(box, videoDim, canvasDim, isMirrored = false) {
    const norm = this.normalizeBbox(box);
    const vw = Math.max(1, videoDim.width || videoDim.w || 640);
    const vh = Math.max(1, videoDim.height || videoDim.h || 640);
    const cw = Math.max(1, canvasDim.width || canvasDim.w || vw);
    const ch = Math.max(1, canvasDim.height || canvasDim.h || vh);

    const scaleX = cw / vw;
    const scaleY = ch / vh;

    let x1 = norm.x1 * scaleX;
    let y1 = norm.y1 * scaleY;
    let x2 = norm.x2 * scaleX;
    let y2 = norm.y2 * scaleY;

    if (isMirrored) {
      const origX1 = x1;
      x1 = cw - x2;
      x2 = cw - origX1;
    }

    return {
      x1: Math.round(x1),
      y1: Math.round(y1),
      x2: Math.round(x2),
      y2: Math.round(y2),
      width: Math.round(x2 - x1),
      height: Math.round(y2 - y1)
    };
  }

  /**
   * Menghitung koordinat display CSS relatif terhadap container video (misal .stage-card),
   * memperhitungkan CSS `object-fit: contain` dan padding letterbox horizontal/vertikal.
   */
  static videoToDisplay(box, videoDim, containerRect, isMirrored = false) {
    const norm = this.normalizeBbox(box);
    const vw = Math.max(1, videoDim.width || 640);
    const vh = Math.max(1, videoDim.height || 640);
    const cw = Math.max(1, containerRect.width || vw);
    const ch = Math.max(1, containerRect.height || vh);

    const scale = Math.min(cw / vw, ch / vh);
    const renderW = vw * scale;
    const renderH = vh * scale;
    const offsetX = (cw - renderW) / 2;
    const offsetY = (ch - renderH) / 2;

    let x1 = offsetX + norm.x1 * scale;
    let y1 = offsetY + norm.y1 * scale;
    let x2 = offsetX + norm.x2 * scale;
    let y2 = offsetY + norm.y2 * scale;

    if (isMirrored) {
      const origX1 = x1;
      x1 = offsetX + (vw - norm.x2) * scale;
      x2 = offsetX + (vw - (origX1 - offsetX) / scale) * scale;
    }

    return {
      x1: Math.round(x1),
      y1: Math.round(y1),
      x2: Math.round(x2),
      y2: Math.round(y2),
      width: Math.round(x2 - x1),
      height: Math.round(y2 - y1),
      scale,
      offsetX,
      offsetY,
      renderW,
      renderH
    };
  }

  /**
   * Menghasilkan teks deskriptif status transformasi koordinat untuk live diagnostics.
   */
  static getTransformStatus(videoDim, isMirrored = false) {
    const w = videoDim?.width || 0;
    const h = videoDim?.height || 0;
    if (w === 0 || h === 0) return 'Standby / Kamera Belum Aktif';

    const params = this.computeLetterboxParams(w, h, 640);
    const mirrorStr = isMirrored ? ' | Mirrored: Active' : '';
    const padStr = params.padX > 0 ? `padX=${Math.round(params.padX)}` : `padY=${Math.round(params.padY)}`;

    return `${params.aspectLabel} (${w}x${h}) → 640x640 [${padStr}, scale=${params.scale.toFixed(3)}]${mirrorStr}`;
  }
}
