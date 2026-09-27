/**
 * ObjectEnrollment.js - VisionX V1.2 Object Enrollment Service
 *
 * Mengelola alur pendaftaran objek personal milik user:
 * - Validasi kelas dasar terhadap daftar kelas YOLO yang didukung
 * - Validasi nama personal agar tidak ambigu / duplikat
 * - Perekaman gambar referensi dari berbagai sudut (front, top, side, etc.)
 * - Ekstraksi visual embedding lokal untuk setiap gambar referensi
 * - Penyimpanan referensi secara lokal (zero cloud upload)
 */

import { PersonalObjectRecognizer } from './PersonalObjectRecognizer.js';

export const SUPPORTED_YOLO_CLASSES = [
  'person', 'bottle', 'cup', 'laptop', 'mouse', 'keyboard', 'cell_phone',
  'bicycle', 'car', 'motorcycle', 'backpack', 'umbrella', 'handbag', 'book',
  'chair', 'couch', 'tv', 'clock', 'scissors', 'pen', 'earphone', 'charger'
];

export class ObjectEnrollment {
  /**
   * @param {Object} personalObjectRegistry Instance PersonalObjectRegistry
   */
  constructor(personalObjectRegistry) {
    this.registry = personalObjectRegistry;
    this.supportedClasses = new Set(SUPPORTED_YOLO_CLASSES.map(c => c.toLowerCase()));
  }

  /**
   * Validasi dan normalisasi nama base class YOLO
   * @param {string} baseClass
   * @returns {string} Normalized base class
   */
  validateBaseClass(baseClass) {
    const raw = String(baseClass || '').toLowerCase().trim();
    if (!raw) {
      throw new Error('Base class YOLO harus ditentukan.');
    }

    // Normalisasi spasi / underscore (e.g. "cell phone" -> "cell_phone")
    let normalized = raw.replace(/\s+/g, '_');
    if (!this.supportedClasses.has(normalized)) {
      // Coba tanpa underscore
      const withoutUnderscore = raw.replace(/_/g, ' ');
      if (this.supportedClasses.has(withoutUnderscore)) {
        normalized = withoutUnderscore;
      } else {
        throw new Error(
          `Kelas "${baseClass}" tidak termasuk dalam daftar kelas YOLO yang didukung VisionX. ` +
          `Pilihan: ${Array.from(this.supportedClasses).slice(0, 10).join(', ')}...`
        );
      }
    }

    return normalized;
  }

  /**
   * Validasi nama objek personal
   * @param {string} name
   * @param {string|null} [excludeId=null]
   * @returns {string}
   */
  validateObjectName(name, excludeId = null) {
    const clean = String(name || '').trim();
    if (!clean) {
      throw new Error('Nama objek personal tidak boleh kosong.');
    }
    if (clean.length < 2) {
      throw new Error('Nama objek personal minimal 2 karakter.');
    }

    const existing = this.registry.findByName(clean);
    if (existing && existing.id !== excludeId) {
      throw new Error(`Objek dengan nama "${clean}" sudah terdaftar.`);
    }

    return clean;
  }

  /**
   * Memproses gambar referensi (upload atau capture) menjadi reference item dengan visual embedding
   * @param {Object} params
   * @param {string} [params.angle='front'] Sudut pengambilan (e.g. 'front', 'top', 'side')
   * @param {string} [params.dataUrl=null] Data URL citra base64
   * @param {HTMLCanvasElement|HTMLImageElement|null} [params.sourceElement=null] Elemen gambar atau canvas
   * @param {Array<number>} [params.precomputedEmbedding=null] Embedding langsung (untuk unit test)
   * @returns {Object} Reference item { id, angle, dataUrl, embedding, createdAt }
   */
  async processReferenceImage({
    angle = 'front',
    dataUrl = null,
    sourceElement = null,
    precomputedEmbedding = null
  }) {
    let embedding = precomputedEmbedding;

    // Jika belum ada embedding, ekstrak dari sourceElement atau dataUrl
    if (!Array.isArray(embedding) || embedding.length === 0) {
      if (sourceElement) {
        embedding = PersonalObjectRecognizer.extractEmbeddingFromCanvas(sourceElement);
      } else if (dataUrl && typeof document !== 'undefined') {
        embedding = await new Promise((resolve) => {
          const img = new Image();
          img.crossOrigin = 'anonymous';
          img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = 64;
            canvas.height = 64;
            const ctx = canvas.getContext('2d');
            if (ctx) {
              ctx.drawImage(img, 0, 0, 64, 64);
              const imgData = ctx.getImageData(0, 0, 64, 64);
              resolve(PersonalObjectRecognizer.extractEmbeddingFromPixels(imgData.data, 64, 64));
            } else {
              resolve(new Array(128).fill(0));
            }
          };
          img.onerror = () => resolve(new Array(128).fill(0));
          img.src = dataUrl;
        });
      }
    }

    if (!Array.isArray(embedding) || embedding.length === 0) {
      embedding = new Array(128).fill(0);
    }

    const refId = `ref_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    return {
      id: refId,
      angle: String(angle || 'front').trim(),
      dataUrl: dataUrl || null,
      embedding,
      createdAt: Date.now()
    };
  }

  /**
   * Mendaftarkan objek personal lengkap dengan referensi visualnya
   * @param {Object} params
   * @param {string} params.name Nama personal (e.g. "My Laptop")
   * @param {string} params.baseClass Base class YOLO (e.g. "laptop")
   * @param {Array<Object>} [params.references=[]] Array reference items
   * @param {number} [params.threshold=0.75]
   * @param {boolean} [params.enabled=true]
   * @returns {Promise<Object>}
   */
  async enrollObject({
    name,
    baseClass,
    references = [],
    threshold = 0.75,
    enabled = true
  }) {
    const validName = this.validateObjectName(name);
    const validBaseClass = this.validateBaseClass(baseClass);

    if (!Array.isArray(references) || references.length === 0) {
      throw new Error('Minimal harus menyertakan 1 gambar referensi visual objek.');
    }

    // Registrasi ke registry lokal
    const record = this.registry.register({
      name: validName,
      baseClass: validBaseClass,
      references,
      threshold: typeof threshold === 'number' ? threshold : 0.75,
      enabled
    });

    return record;
  }

  /**
   * Tambah foto referensi baru dari sudut berbeda ke objek yang sudah terdaftar
   * @param {string} objectId
   * @param {Object} refParams
   */
  async addReferenceToExisting(objectId, refParams) {
    const obj = this.registry.getById(objectId);
    if (!obj) {
      throw new Error(`Objek #${objectId} tidak ditemukan.`);
    }

    const processedRef = await this.processReferenceImage(refParams);
    return this.registry.addReference(objectId, processedRef);
  }

  /**
   * Mengambil daftar kelas YOLO yang didukung untuk dropdown UI
   */
  getSupportedClasses() {
    return Array.from(this.supportedClasses).sort();
  }
}
