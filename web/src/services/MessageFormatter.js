/**
 * MessageFormatter.js - Natural Indonesian Speech Formatter for VisionX V0.8
 *
 * Mengonversi event deteksi dan tracking visual menjadi frasa bahasa Indonesia
 * yang ringkas, alami, dan ramah aksesibilitas (Screen reader / audio guidance).
 *
 * Aturan:
 * - Tidak memasukkan Track ID ke dalam kalimat yang diucapkan (misal: "Laptop terdeteksi", BUKAN "Laptop pagar nol satu").
 * - Menggunakan terminologi bahasa Indonesia yang lazim (e.g. bottle -> botol, person -> orang, cell_phone -> ponsel).
 * - Menangani batching jamak secara gramatikal ("3 objek terdeteksi: laptop, mouse, dan botol.").
 */

export const CLASS_TRANSLATIONS = {
  person: 'orang',
  bottle: 'botol',
  cup: 'cangkir',
  laptop: 'laptop',
  mouse: 'mouse',
  keyboard: 'keyboard',
  cell_phone: 'ponsel',
  'cell phone': 'ponsel',
  book: 'buku',
  chair: 'kursi',
  backpack: 'tas ransel',
  car: 'mobil',
  bicycle: 'sepeda',
  motorcycle: 'motor',
  dog: 'anjing',
  cat: 'kucing',
  tv: 'televisi',
  clock: 'jam'
};

export class MessageFormatter {
  /**
   * Terjemahkan nama class YOLO ke bahasa Indonesia yang ramah didengar
   * @param {string} className
   * @returns {string}
   */
  static translateClassName(className) {
    if (!className) return 'objek';
    const clean = String(className).toLowerCase().trim().replace(/[-_]/g, ' ');
    const directKey = String(className).toLowerCase().trim();
    if (CLASS_TRANSLATIONS[directKey]) {
      return CLASS_TRANSLATIONS[directKey];
    }
    if (CLASS_TRANSLATIONS[clean]) {
      return CLASS_TRANSLATIONS[clean];
    }
    return clean;
  }

  /**
   * Huruf pertama kapital
   * @param {string} text
   * @returns {string}
   */
  static capitalize(text) {
    if (!text) return '';
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  /**
   * Format pengumuman objek baru pertama kali terdeteksi
   * Contoh: "Laptop terdeteksi."
   * @param {string} className
   * @returns {string}
   */
  static formatObjectEntered(className) {
    const translated = MessageFormatter.translateClassName(className);
    return `${MessageFormatter.capitalize(translated)} terdeteksi.`;
  }

  /**
   * Format pengumuman objek yang sempat hilang lalu kembali terdeteksi setelah cooldown
   * Contoh: "Laptop kembali terdeteksi."
   * @param {string} className
   * @returns {string}
   */
  static formatObjectReturned(className) {
    const translated = MessageFormatter.translateClassName(className);
    return `${MessageFormatter.capitalize(translated)} kembali terdeteksi.`;
  }

  /**
   * Format pengumuman beberapa objek yang masuk bersamaan (batching)
   * Contoh: "3 objek terdeteksi: laptop, mouse, dan botol."
   * @param {Array<string|Object>} items Array of class names or objects with className
   * @returns {string}
   */
  static formatMultipleObjects(items = []) {
    if (!items || items.length === 0) return '';
    
    // Normalisasi input string / object
    const classNames = items.map(item => {
      if (typeof item === 'string') return item;
      return item.className || item.class_name || item.name || 'objek';
    });

    if (classNames.length === 1) {
      return MessageFormatter.formatObjectEntered(classNames[0]);
    }

    const totalCount = classNames.length;

    // Hitung frekuensi setiap kelas
    const counts = new Map();
    for (const name of classNames) {
      const translated = MessageFormatter.translateClassName(name);
      counts.set(translated, (counts.get(translated) || 0) + 1);
    }

    // Bangun daftar kata
    // Jika semua kelas unik (misal 3 objek: laptop, mouse, botol) -> "laptop, mouse, dan botol"
    // Jika ada yang jamak (misal 2 laptop, 1 mouse) -> "2 laptop dan mouse"
    const clauses = [];
    const allUnique = counts.size === totalCount;

    for (const [translatedName, count] of counts.entries()) {
      if (allUnique) {
        clauses.push(translatedName);
      } else {
        if (count > 1) {
          clauses.push(`${count} ${translatedName}`);
        } else {
          clauses.push(translatedName);
        }
      }
    }

    let joinedList = '';
    if (clauses.length === 1) {
      joinedList = clauses[0];
    } else if (clauses.length === 2) {
      joinedList = `${clauses[0]} dan ${clauses[1]}`;
    } else {
      const last = clauses.pop();
      joinedList = `${clauses.join(', ')}, dan ${last}`;
    }

    return `${totalCount} objek terdeteksi: ${joinedList}.`;
  }
}
