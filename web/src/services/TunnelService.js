/**
 * VisionX - Tunnel & Cloudflare API Service
 * Mengelola pengiriman gambar/dataset dari Web App ke endpoint server Flask di HP Termux.
 * 
 * Skema Server Flask:
 * - File field: 'image' (multipart/form-data)
 * - Data field: 'info' (string keterangan deteksi/label)
 */

import { ENDPOINTS } from './apiConfig.js';

export const DEFAULT_ENDPOINT_URL = ENDPOINTS.UPLOAD;

class TunnelService {
  constructor() {
    this.endpointUrl = DEFAULT_ENDPOINT_URL;
  }

  /**
   * Mengambil URL endpoint aktif.
   * @returns {string}
   */
  getEndpointUrl() {
    return this.endpointUrl;
  }

  /**
   * Mengatur URL endpoint khusus secara dinamis.
   * @param {string} url
   */
  setEndpointUrl(url) {
    if (url && typeof url === 'string') {
      this.endpointUrl = url.trim();
    }
  }

  /**
   * Mengonversi canvas, data URL base64, atau Blob menjadi Blob JPEG.
   * @param {Blob|File|HTMLCanvasElement|string} imageSource
   * @returns {Promise<Blob>}
   */
  async toBlob(imageSource) {
    if (imageSource instanceof Blob) {
      return imageSource;
    }

    if (imageSource instanceof HTMLCanvasElement) {
      return new Promise((resolve, reject) => {
        imageSource.toBlob((blob) => {
          if (blob) {
            resolve(blob);
          } else {
            reject(new Error('Gagal mengekstrak Blob dari canvas'));
          }
        }, 'image/jpeg', 0.85);
      });
    }

    if (typeof imageSource === 'string' && imageSource.startsWith('data:')) {
      const res = await fetch(imageSource);
      return await res.blob();
    }

    throw new TypeError('Format sumber gambar tidak didukung untuk upload');
  }

  /**
   * Mengirim gambar dan info ke endpoint Cloudflare Tunnel.
   *
   * @param {Object} options
   * @param {Blob|File|HTMLCanvasElement|string} options.image - Gambar sumber
   * @param {string} [options.info='VisionX Web Detection'] - Keterangan/label deteksi
   * @param {string} [options.endpointUrl] - Override URL jika diinginkan
   * @returns {Promise<{success: boolean, status: number|null, data: any, error: string|null}>}
   */
  async uploadImage({ image, info = 'VisionX Web Detection', endpointUrl = null }) {
    const targetUrl = endpointUrl || this.endpointUrl;

    try {
      const imageBlob = await this.toBlob(image);

      const formData = new FormData();
      // Skema server Flask: 'image' dan 'info'
      formData.append('image', imageBlob, 'web_capture.jpg');
      formData.append('info', String(info));

      const response = await fetch(targetUrl, {
        method: 'POST',
        body: formData,
      });

      let responseData = null;
      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        responseData = await response.json();
      } else {
        responseData = await response.text();
      }

      if (response.ok) {
        return {
          success: true,
          status: response.status,
          data: responseData,
          error: null,
        };
      }

      return {
        success: false,
        status: response.status,
        data: responseData,
        error: `HTTP ${response.status}: ${response.statusText}`,
      };
    } catch (err) {
      return {
        success: false,
        status: null,
        data: null,
        error: err.message || 'Network error saat menghubungi tunnel',
      };
    }
  }

  /**
   * Menguji konektivitas ke Cloudflare Tunnel dengan frame sintetis ringan.
   * @param {string} [endpointUrl]
   * @returns {Promise<{success: boolean, reachable: boolean, status: number|null, message: string}>}
   */
  async testConnection(endpointUrl = null) {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(0, 0, 64, 64);
      ctx.fillStyle = '#38bdf8';
      ctx.fillText('VX', 16, 36);
    }

    const result = await this.uploadImage({
      image: canvas,
      info: 'VisionX Ping / Connectivity Test',
      endpointUrl,
    });

    if (result.success) {
      return {
        success: true,
        reachable: true,
        status: result.status,
        message: 'Koneksi ke endpoint Cloudflare Tunnel berhasil dan menerima data!',
      };
    }

    // Jika HTTP 502/504 dari Cloudflare, berarti Cloudflare Tunnel domain aktif tapi server Termux sedang tidur/offline
    if (result.status === 502 || result.status === 504) {
      return {
        success: false,
        reachable: true,
        status: result.status,
        message: 'Domain Cloudflare Tunnel aktif, namun server Termux (HP) sedang offline atau belum dinyalakan.',
      };
    }

    return {
      success: false,
      reachable: false,
      status: result.status,
      message: result.error || 'Gagal terhubung ke endpoint tunnel',
    };
  }
}

export const tunnelService = new TunnelService();
export default tunnelService;
