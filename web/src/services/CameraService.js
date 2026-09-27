/**
 * CameraService - Abstraction untuk Web MediaDevices API
 * Mengelola stream kamera browser, enumerasi perangkat, penanganan izin, dan cleanup track.
 */

export class CameraService {
  constructor() {
    this.stream = null;
    this.videoElement = null;
    this.currentDeviceId = null;
    this.listeners = {
      stateChange: [],
      error: [],
      devicesChange: []
    };
    this.state = {
      status: 'disconnected', // 'disconnected' | 'connecting' | 'connected' | 'error'
      permission: 'prompt',   // 'prompt' | 'granted' | 'denied'
      activeDeviceLabel: '',
      resolution: { width: 0, height: 0 }
    };

    // Listen device change events (e.g. plugging USB camera)
    if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
      navigator.mediaDevices.addEventListener('devicechange', () => this.refreshDevices());
    }
  }

  /**
   * Mengatur elemen HTMLVideoElement tempat stream dirender.
   */
  attachVideoElement(videoEl) {
    this.videoElement = videoEl;
  }

  /**
   * Menambahkan event listener.
   */
  on(event, callback) {
    if (this.listeners[event]) {
      this.listeners[event].push(callback);
    }
  }

  _notifyState() {
    this.listeners.stateChange.forEach((cb) => cb({ ...this.state }));
  }

  _notifyError(error) {
    this.listeners.error.forEach((cb) => cb(error));
  }

  /**
   * Mendapatkan daftar perangkat kamera video input yang tersedia.
   */
  async getDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
      throw new Error('MediaDevices API tidak didukung pada browser ini.');
    }

    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoDevices = devices.filter((d) => d.kind === 'videoinput');
      this.listeners.devicesChange.forEach((cb) => cb(videoDevices));
      return videoDevices;
    } catch (err) {
      console.error('Gagal membaca daftar perangkat kamera:', err);
      return [];
    }
  }

  /**
   * Alias untuk getDevices() agar kompatibel dengan pemanggil di main.js
   */
  async getAvailableDevices() {
    return this.getDevices();
  }

  /**
   * Mengecek apakah lingkungan eksekusi saat ini adalah Secure Context (HTTPS atau localhost).
   * Web MediaDevices API (getUserMedia) diblokir oleh browser di insecure context (HTTP non-localhost).
   * @returns {{ isSecure: boolean, protocol: string, hostname: string, errorReason: string|null, actionableInstruction: string|null }}
   */
  static checkSecureContext() {
    if (typeof window === 'undefined') {
      return { isSecure: true, protocol: 'node', hostname: 'localhost', errorReason: null, actionableInstruction: null };
    }

    const isSecure = Boolean(
      window.isSecureContext ||
      window.location.protocol === 'https:' ||
      window.location.hostname === 'localhost' ||
      window.location.hostname === '127.0.0.1' ||
      window.location.hostname === '[::1]'
    );

    if (!isSecure) {
      const currentUrl = window.location.href;
      return {
        isSecure: false,
        protocol: window.location.protocol,
        hostname: window.location.hostname,
        errorReason: 'Insecure Context: Browser memblokir kamera di HTTP non-localhost.',
        actionableInstruction: `Akses browser melalui HTTPS atau localhost. Jika mengakses IP lokal HP (${window.location.hostname}), aktifkan flag "Insecure origins treated as secure" di chrome://flags/#unsafely-treat-insecure-origin-as-secure atau gunakan HTTPS tunnel (misal ngrok/mkcert).`
      };
    }

    return {
      isSecure: true,
      protocol: window.location.protocol,
      hostname: window.location.hostname,
      errorReason: null,
      actionableInstruction: null
    };
  }

  /**
   * Mendeteksi apakah perangkat kemungkinan besar adalah mobile/tablet.
   * Digunakan untuk memilih facingMode default yang tepat ('environment' untuk HP, 'user' untuk laptop/PC).
   */
  static isMobileDevice() {
    if (typeof navigator === 'undefined') return false;
    const ua = navigator.userAgent || '';
    const mobileRegex = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i;
    const isTouch = typeof navigator.maxTouchPoints === 'number' && navigator.maxTouchPoints > 1;
    return mobileRegex.test(ua) || (isTouch && /Macintosh/i.test(ua));
  }

  /**
   * Menghasilkan daftar tingkatan constraint kamera berurutan (fallback tiers).
   * Tier 1: Optimal requested resolution + ideal deviceId / facingMode
   * Tier 2: Standard 640x480 resolution (kompatibel hampir semua sensor HP)
   * Tier 3: Minimal fallback (browser default video stream)
   */
  static getConstraintTiers(deviceId = null, options = { width: 1280, height: 720 }) {
    const isMobile = CameraService.isMobileDevice();
    const defaultFacing = isMobile ? 'environment' : 'user';

    // Tier 1: Optimal
    const tier1Video = {
      width: { ideal: options.width || 1280 },
      height: { ideal: options.height || 720 }
    };
    if (deviceId) {
      tier1Video.deviceId = { ideal: deviceId };
    } else {
      tier1Video.facingMode = { ideal: defaultFacing };
    }

    // Tier 2: Relaxed 640x480 (sangat ramah mobile & low-end webcam)
    const tier2Video = {
      width: { ideal: 640 },
      height: { ideal: 480 }
    };
    if (deviceId) {
      tier2Video.deviceId = { ideal: deviceId };
    } else {
      tier2Video.facingMode = { ideal: defaultFacing };
    }

    // Tier 3: Bare minimum (biarkan browser memilih stream video apa pun yang tersedia)
    const tier3Video = true;

    return [
      { tier: 1, name: 'Optimal (HD/Requested)', constraints: { video: tier1Video, audio: false } },
      { tier: 2, name: 'Standard (640x480 Fallback)', constraints: { video: tier2Video, audio: false } },
      { tier: 3, name: 'Minimal (Any Video Stream)', constraints: { video: tier3Video, audio: false } }
    ];
  }

  /**
   * Mengklasifikasikan error dari getUserMedia ke format actionable yang jelas.
   * @param {Error} err Error asli dari browser
   * @returns {Error} Error yang diperkaya dengan kode, deskripsi ramah, dan saran tindakan
   */
  static classifyCameraError(err) {
    const errorName = err.name || '';
    const errorMsg = err.message || '';
    let category = 'UNKNOWN';
    let friendlyMessage = 'Gagal mengakses kamera.';
    let actionSuggestion = 'Pastikan kamera terhubung dan browser memiliki izin akses.';
    let canRetry = true;

    // 1. Permission Denied
    if (errorName === 'NotAllowedError' || errorName === 'PermissionDeniedError' || /permission/i.test(errorMsg)) {
      category = 'PERMISSION_DENIED';
      friendlyMessage = 'Akses kamera ditolak oleh pengguna atau sistem.';
      actionSuggestion = 'Buka Pengaturan Situs / ikon gembok di address bar browser Anda, pilih "Izinkan" untuk Kamera, lalu klik Coba Lagi.';
    }
    // 2. Device Not Found
    else if (errorName === 'NotFoundError' || errorName === 'DevicesNotFoundError' || /not found/i.test(errorMsg)) {
      category = 'DEVICE_NOT_FOUND';
      friendlyMessage = 'Kamera tidak ditemukan pada perangkat Anda.';
      actionSuggestion = 'Pastikan modul kamera atau webcam USB terhubung dengan benar dan tidak dinonaktifkan di sistem.';
      canRetry = true;
    }
    // 3. Hardware Busy / In Use
    else if (errorName === 'NotReadableError' || errorName === 'TrackStartError' || /in use|busy/i.test(errorMsg)) {
      category = 'CAMERA_BUSY';
      friendlyMessage = 'Kamera sedang digunakan oleh aplikasi lain atau terkunci oleh sistem.';
      actionSuggestion = 'Tutup aplikasi lain yang sedang memakai kamera (seperti Zoom, WhatsApp, Meet, atau tab browser lain), lalu coba lagi.';
    }
    // 4. Overconstrained / Hardware Mismatch
    else if (errorName === 'OverconstrainedError' || errorName === 'ConstraintNotSatisfiedError') {
      category = 'OVERCONSTRAINED';
      friendlyMessage = 'Kamera tidak mendukung resolusi atau mode yang diminta.';
      actionSuggestion = 'Kamera perangkat memiliki batasan perangkat keras. Sistem akan mencoba membuka dengan resolusi dasar.';
    }
    // 5. Insecure Context / Security
    else if (errorName === 'SecurityError') {
      category = 'INSECURE_CONTEXT';
      friendlyMessage = 'Akses kamera diblokir karena halaman tidak menggunakan HTTPS.';
      actionSuggestion = 'Akses website menggunakan https:// atau localhost. Browser memblokir kamera di jaringan HTTP biasa.';
      canRetry = false;
    }
    // 6. Abort / System Interrupted
    else if (errorName === 'AbortError') {
      category = 'ABORTED';
      friendlyMessage = 'Inisialisasi kamera dibatalkan oleh perangkat keras atau browser.';
      actionSuggestion = 'Muat ulang halaman atau periksa izin hardware perangkat Anda.';
    }
    // 7. General fallback
    else {
      friendlyMessage = errorMsg || 'Gagal mengakses kamera.';
      actionSuggestion = 'Pastikan browser mendukung WebRTC dan berikan izin saat diminta.';
    }

    err.category = category;
    err.friendlyMessage = friendlyMessage;
    err.actionSuggestion = actionSuggestion;
    err.canRetry = canRetry;
    return err;
  }

  /**
   * Membuka dan mengaktifkan stream kamera dengan fallback multi-tier.
   * @param {string|null} deviceId ID perangkat spesifik (opsional)
   * @param {Object} options Resolusi ideal { width, height }
   */
  async start(deviceId = null, options = { width: 1280, height: 720 }) {
    // 1. Periksa Secure Context terlebih dahulu
    const secureCheck = CameraService.checkSecureContext();
    if (!secureCheck.isSecure) {
      const secErr = new Error(secureCheck.errorReason);
      secErr.name = 'SecurityError';
      secErr.friendlyMessage = secureCheck.errorReason;
      secErr.actionSuggestion = secureCheck.actionableInstruction;
      secErr.category = 'INSECURE_CONTEXT';
      secErr.canRetry = false;

      this.state.status = 'error';
      this._notifyState();
      this._notifyError(secErr);
      throw secErr;
    }

    // 2. Periksa ketersediaan MediaDevices API
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      const navErr = new Error('Browser Anda tidak mendukung kamera Web API (getUserMedia).');
      navErr.name = 'NotSupportedError';
      navErr.friendlyMessage = 'Browser Anda tidak mendukung kamera Web API (getUserMedia).';
      navErr.actionSuggestion = 'Gunakan browser modern versi terbaru (Chrome, Safari, Edge, atau Firefox).';
      navErr.category = 'NOT_SUPPORTED';
      navErr.canRetry = false;

      this.state.status = 'error';
      this._notifyState();
      this._notifyError(navErr);
      throw navErr;
    }

    // Hentikan stream lama jika sedang berjalan
    this.stop();

    this.state.status = 'connecting';
    this._notifyState();

    // 3. Coba membuka stream dengan multi-tier fallback
    const tiers = CameraService.getConstraintTiers(deviceId, options);
    let lastError = null;
    let successfulTier = null;

    for (const tierInfo of tiers) {
      try {
        this.stream = await navigator.mediaDevices.getUserMedia(tierInfo.constraints);
        successfulTier = tierInfo;
        break; // Berhasil membuka stream!
      } catch (tierErr) {
        lastError = tierErr;
        console.warn(`[CameraService] Fallback: Tier ${tierInfo.tier} (${tierInfo.name}) gagal:`, tierErr.name, tierErr.message);

        // Jika user secara eksplisit menolak izin (NotAllowedError / PermissionDeniedError),
        // jangan lanjutkan fallback tier karena user memang menolak izin.
        if (tierErr.name === 'NotAllowedError' || tierErr.name === 'PermissionDeniedError') {
          break;
        }
      }
    }

    // 4. Jika seluruh tier gagal
    if (!this.stream) {
      this.state.status = 'error';
      const classifiedErr = CameraService.classifyCameraError(lastError || new Error('Gagal menginisialisasi kamera.'));
      if (classifiedErr.category === 'PERMISSION_DENIED') {
        this.state.permission = 'denied';
      }

      this._notifyState();
      this._notifyError(classifiedErr);
      throw classifiedErr;
    }

    // 5. Berhasil terkoneksi
    try {
      this.state.permission = 'granted';
      this.state.status = 'connected';
      this.currentDeviceId = deviceId;

      const videoTrack = this.stream.getVideoTracks()[0];
      if (videoTrack) {
        const settings = typeof videoTrack.getSettings === 'function' ? videoTrack.getSettings() : {};
        this.state.activeDeviceLabel = videoTrack.label || 'Kamera Utama';
        this.state.resolution = {
          width: settings.width || options.width,
          height: settings.height || options.height
        };
      }

      if (this.videoElement) {
        // Pengaturan kritis untuk iOS Safari & Android mobile
        this.videoElement.setAttribute('playsinline', 'true');
        this.videoElement.setAttribute('webkit-playsinline', 'true');
        this.videoElement.muted = true;
        this.videoElement.srcObject = this.stream;
        await this.videoElement.play().catch((playErr) => {
          console.warn('[CameraService] Video play() memerlukan interaksi pengguna:', playErr);
        });
      }

      this._notifyState();
      // Refresh list devices agar label kamera ter-update setelah dapat izin
      await this.getDevices();

      return this.stream;
    } catch (postInitErr) {
      console.error('[CameraService] Error pasca inisialisasi video track:', postInitErr);
      this.state.status = 'error';
      const classifiedErr = CameraService.classifyCameraError(postInitErr);
      this._notifyState();
      this._notifyError(classifiedErr);
      throw classifiedErr;
    }
  }

  /**
   * Menghentikan stream kamera dan membebaskan hardware.
   */
  stop() {
    if (this.stream) {
      this.stream.getTracks().forEach((track) => {
        track.stop();
      });
      this.stream = null;
    }

    if (this.videoElement) {
      this.videoElement.srcObject = null;
    }

    this.state.status = 'disconnected';
    this.state.resolution = { width: 0, height: 0 };
    this._notifyState();
  }

  /**
   * Mengisi ulang daftar perangkat kamera.
   */
  async refreshDevices() {
    return await this.getDevices();
  }
}
