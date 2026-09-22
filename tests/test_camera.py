"""
Unit tests for CameraStream and camera error handling.
"""

import unittest
import numpy as np
from app.camera import CameraStream, CameraNotFoundError


class TestCameraStream(unittest.TestCase):

    def test_synthetic_stream(self):
        """Uji apakah mode synthetic frame dapat mengalirkan frame dengan baik."""
        cam = CameraStream(source="synthetic", width=320, height=240)
        cam.start()
        self.assertTrue(cam.is_opened())

        ret, frame = cam.read()
        self.assertTrue(ret)
        self.assertIsNotNone(frame)
        self.assertIsInstance(frame, np.ndarray)
        self.assertEqual(frame.shape, (240, 320, 3))

        cam.release()

    def test_invalid_camera_source_raises_error(self):
        """Uji penanganan error ketika sumber file video atau indeks tidak ada."""
        invalid_source = "non_existent_video_file_99999.mp4"
        cam = CameraStream(source=invalid_source)
        with self.assertRaises(CameraNotFoundError):
            cam.start()

    def test_context_manager(self):
        """Uji penggunaan context manager pada CameraStream."""
        with CameraStream(source="synthetic", width=160, height=120) as cam:
            self.assertTrue(cam.is_opened())
            ret, frame = cam.read()
            self.assertTrue(ret)
            self.assertEqual(frame.shape, (120, 160, 3))


if __name__ == "__main__":
    unittest.main()
