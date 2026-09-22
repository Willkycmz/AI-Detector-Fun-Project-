"""
VisionX - Realtime Object Detection Entry Point
Aplikasi Computer Vision modular untuk deteksi objek realtime via webcam atau video stream.
"""

import sys
import time
import logging
from pathlib import Path
import cv2

# Pastikan root direktori project ada di sys.path
PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

try:
    from app.config import parse_arguments, AppConfig
    from app.camera import CameraStream, CameraNotFoundError, FrameReadError
    from app.detector import YOLOObjectDetector, Visualizer, ModelLoadError
    from app.collector import DatasetCollector, InvalidClassNameError, DatasetSaveError
except ImportError:
    from config import parse_arguments, AppConfig
    from camera import CameraStream, CameraNotFoundError, FrameReadError
    from detector import YOLOObjectDetector, Visualizer, ModelLoadError
    from collector import DatasetCollector, InvalidClassNameError, DatasetSaveError

# Konfigurasi logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%H:%M:%S"
)
logger = logging.getLogger("VisionX")


def run_pipeline(config: AppConfig) -> int:
    """
    Menjalankan loop utama pengolahan video realtime VisionX:
    Mendukung mode deteksi objek (V0.1) dan mode pengumpulan dataset (V0.2).
    """
    logger.info("=" * 60)
    logger.info("Memulai VisionX - Computer Vision System (V0.2)")
    logger.info(f"Mode Awal: {config.mode.upper()} | Source: {config.source}")
    if config.mode == "detect":
        logger.info(f"Model: {config.model_path} | Conf={config.confidence_threshold}")
    else:
        logger.info(f"Koleksi Kelas: {config.class_name} | Simpan ke: {config.save_dir}")
    logger.info("Kontrol: [SPACE/C] Foto  [N] Ganti Kelas  [M] Ganti Mode  [Q] Keluar")
    logger.info("=" * 60)

    # 1. Inisialisasi Detektor YOLO (opsional jika hanya menjalankan mode koleksi)
    detector = None
    try:
        detector = YOLOObjectDetector(
            model_path=config.model_path,
            conf_threshold=config.confidence_threshold,
            iou_threshold=config.iou_threshold,
            device=config.device
        )
    except ModelLoadError as e:
        if config.mode == "detect":
            logger.error(f"[FATAL] Gagal menginisialisasi model: {e}")
            return 1
        logger.warning(f"Model YOLO tidak aktif ({e}). Mode koleksi tetap dapat berjalan.")

    # 2. Inisialisasi Dataset Collector
    try:
        collector = DatasetCollector(
            base_dir=config.save_dir,
            current_class=config.class_name
        )
    except Exception as e:
        logger.error(f"[FATAL] Gagal menginisialisasi dataset collector: {e}")
        return 4

    # 3. Inisialisasi Stream Kamera
    try:
        camera = CameraStream(
            source=config.source,
            width=config.frame_width,
            height=config.frame_height
        )
        camera.start()
    except CameraNotFoundError as e:
        logger.error(f"[FATAL] Gagal mengakses kamera: {e}")
        return 2

    # State runtime
    current_mode = config.mode
    is_typing_class = False
    class_input_buffer = ""
    class_input_error = None
    flash_message = None
    flash_expire_time = 0.0

    # Perhitungan FPS
    prev_time = time.perf_counter()
    fps_smooth = 0.0
    alpha_fps = 0.9
    consecutive_failed_reads = 0
    max_allowed_failures = 30

    cv2.namedWindow(config.window_title, cv2.WINDOW_NORMAL)

    try:
        while True:
            # 4. Baca Frame Realtime
            ret, frame = camera.read()
            if not ret or frame is None:
                consecutive_failed_reads += 1
                logger.warning(
                    f"Gagal membaca frame ({consecutive_failed_reads}/{max_allowed_failures})..."
                )
                if consecutive_failed_reads >= max_allowed_failures:
                    raise FrameReadError(
                        "Koneksi stream terputus. Tidak dapat menerima frame dari kamera."
                    )
                time.sleep(0.05)
                continue

            consecutive_failed_reads = 0

            # CRITICAL: Pisahkan citra asli murni untuk penyimpanan dataset
            raw_frame = frame.copy()

            # 5. Kalkulasi FPS
            curr_time = time.perf_counter()
            delta = curr_time - prev_time
            prev_time = curr_time

            if delta > 0:
                current_fps = 1.0 / delta
                fps_smooth = current_fps if fps_smooth == 0.0 else (
                    alpha_fps * fps_smooth + (1.0 - alpha_fps) * current_fps
                )

            # 6. Pemrosesan Visual Sesuai Mode
            if current_mode == "detect":
                # Mode Deteksi Objek Realtime (V0.1)
                if detector is not None:
                    detections = detector.detect(frame)
                    rendered_frame = Visualizer.draw(
                        frame=frame,
                        detections=detections,
                        fps=fps_smooth if config.show_fps else None,
                        show_boxes=config.show_boxes,
                        show_labels=config.show_labels,
                        show_fps=config.show_fps
                    )
                else:
                    rendered_frame = frame.copy()
                    cv2.putText(
                        rendered_frame,
                        "Model belum dimuat. Tekan [M] untuk mode koleksi.",
                        (20, 40),
                        cv2.FONT_HERSHEY_SIMPLEX,
                        0.6,
                        (0, 0, 255),
                        2
                    )
            else:
                # Mode Pengumpulan Dataset (V0.2)
                flash_text = flash_message if time.time() < flash_expire_time else None
                rendered_frame = Visualizer.draw_collection_hud(
                    frame=frame,
                    class_name=collector.current_class,
                    count=collector.get_count(),
                    fps=fps_smooth if config.show_fps else None,
                    flash_message=flash_text
                )

            # Jika sedang dalam dialog penggantian kelas
            if is_typing_class:
                rendered_frame = Visualizer.draw_class_input_modal(
                    frame=rendered_frame,
                    input_text=class_input_buffer,
                    error_msg=class_input_error
                )

            # 7. Render ke Jendela GUI
            cv2.imshow(config.window_title, rendered_frame)

            # 8. Penanganan Input Keyboard
            wait_delay = 20 if is_typing_class else 1
            key = cv2.waitKey(wait_delay) & 0xFF

            if is_typing_class:
                # Modal pengetikan nama kelas
                if key in (13, 10):  # Tombol ENTER
                    try:
                        collector.set_class(class_input_buffer)
                        is_typing_class = False
                        flash_message = f"Kelas diubah ke: {collector.current_class}"
                        flash_expire_time = time.time() + 2.5
                        logger.info(f"Berhasil berganti kelas ke: '{collector.current_class}'")
                    except InvalidClassNameError as err:
                        class_input_error = str(err)
                elif key == 27:  # Tombol ESC -> Batalkan dialog
                    is_typing_class = False
                    class_input_buffer = ""
                    class_input_error = None
                elif key == 8:  # Backspace
                    class_input_buffer = class_input_buffer[:-1]
                elif 32 <= key <= 126:
                    char = chr(key)
                    if char in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_- ":
                        class_input_buffer += char
                        class_input_error = None
                continue

            # Kontrol keyboard normal
            # Keluar dari aplikasi: 'q', 'Q', atau ESC
            if key in (ord('q'), ord('Q'), 27):
                logger.info("Pengguna menekan tombol keluar. Menghentikan program...")
                break

            # Ganti mode: 'm' atau 'M'
            if key in (ord('m'), ord('M')):
                current_mode = "collect" if current_mode == "detect" else "detect"
                logger.info(f"Mode dialihkan ke: {current_mode.upper()}")

            # Ambil foto dataset: SPACE atau 'c' / 'C'
            if key in (32, ord('c'), ord('C')):
                # Otomatis alihkan ke mode koleksi jika mengambil foto dari mode deteksi
                current_mode = "collect"
                try:
                    # Simpan raw_frame murni (bebas anotasi)
                    saved_path = collector.save_image(raw_frame)
                    flash_message = f"Tersimpan: {saved_path.name}"
                    flash_expire_time = time.time() + 2.5
                except DatasetSaveError as err:
                    logger.error(f"Gagal menyimpan gambar: {err}")
                    flash_message = f"Gagal: {err}"
                    flash_expire_time = time.time() + 3.0

            # Buka dialog ganti kelas: 'n' atau 'N'
            if key in (ord('n'), ord('N')):
                is_typing_class = True
                class_input_buffer = ""
                class_input_error = None

            # Jika jendela GUI ditutup manual oleh pengguna dengan tombol X
            if cv2.getWindowProperty(config.window_title, cv2.WND_PROP_VISIBLE) < 1:
                logger.info("Jendela preview ditutup. Menghentikan program...")
                break

    except FrameReadError as e:
        logger.error(f"[ERROR] Masalah pembacaan frame: {e}")
        return 3
    except KeyboardInterrupt:
        logger.info("Menerima sinyal interupsi (Ctrl+C). Menghentikan...")
    finally:
        camera.release()
        cv2.destroyAllWindows()
        logger.info("Semua resource kamera dan window telah dibersihkan secara aman.")

    return 0


def main() -> None:
    config = parse_arguments()
    exit_code = run_pipeline(config)
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
