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
   * Membuka dan mengaktifkan stream kamera.
   * @param {string|null} deviceId ID perangkat spesifik (opsional)
   * @param {Object} options Resolusi ideal { width, height }
   */
  async start(deviceId = null, options = { width: 1280, height: 720 }) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      const err = new Error('Browser Anda tidak mendukung kamera Web API (getUserMedia).');
      this.state.status = 'error';
      this._notifyState();
      this._notifyError(err);
      throw err;
    }

    // Hentikan stream lama jika sedang berjalan
    this.stop();

    this.state.status = 'connecting';
    this._notifyState();

    const videoConstraints = {
      width: { ideal: options.width },
      height: { ideal: options.height },
      facingMode: deviceId ? undefined : { ideal: 'user' }
    };

    if (deviceId) {
      videoConstraints.deviceId = { exact: deviceId };
    }

    const constraints = {
      video: videoConstraints,
      audio: false
    };

    try {
      this.stream = await navigator.mediaDevices.getUserMedia(constraints);
      this.state.permission = 'granted';
      this.state.status = 'connected';
      this.currentDeviceId = deviceId;

      const videoTrack = this.stream.getVideoTracks()[0];
      if (videoTrack) {
        const settings = videoTrack.getSettings();
        this.state.activeDeviceLabel = videoTrack.label || 'Kamera Utama';
        this.state.resolution = {
          width: settings.width || options.width,
          height: settings.height || options.height
        };
      }

      if (this.videoElement) {
        this.videoElement.srcObject = this.stream;
        await this.videoElement.play().catch(() => {});
      }

      this._notifyState();
      // Refresh list devices agar label kamera ter-update setelah dapat izin
      await this.getDevices();

      return this.stream;
    } catch (err) {
      this.state.status = 'error';

      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        this.state.permission = 'denied';
        err.friendlyMessage = 'Akses kamera ditolak oleh pengguna atau browser.';
      } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
        err.friendlyMessage = 'Kamera tidak terdeteksi pada perangkat Anda.';
      } else if (err.name === 'NotReadableError' || err.name === 'TrackStartError') {
        err.friendlyMessage = 'Kamera sedang digunakan oleh aplikasi lain.';
      } else {
        err.friendlyMessage = err.message || 'Gagal mengakses kamera.';
      }

      this._notifyState();
      this._notifyError(err);
      throw err;
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
