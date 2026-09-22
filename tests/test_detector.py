"""
Unit tests for YOLOObjectDetector and Visualizer.
"""

import unittest
import numpy as np
from app.detector import YOLOObjectDetector, Visualizer, Detection, ModelLoadError


class TestDetectorAndVisualizer(unittest.TestCase):

    def test_invalid_model_path_raises_error(self):
        """Uji apakah penanganan error bekerja saat path model tidak valid."""
        with self.assertRaises(ModelLoadError):
            YOLOObjectDetector(model_path="path/to/non_existent_weights_xyz.pt")

    def test_visualizer_draw(self):
        """Uji rendering visualizer bounding box dan FPS badge."""
        dummy_frame = np.zeros((480, 640, 3), dtype=np.uint8)
        dummy_detections = [
            Detection(
                bbox=(50, 50, 200, 200),
                confidence=0.88,
                class_id=0,
                class_name="person"
            ),
            Detection(
                bbox=(250, 100, 400, 300),
                confidence=0.75,
                class_id=67,
                class_name="cell phone"
            )
        ]

        annotated = Visualizer.draw(
            frame=dummy_frame,
            detections=dummy_detections,
            fps=30.5,
            show_boxes=True,
            show_labels=True,
            show_fps=True
        )

        self.assertIsInstance(annotated, np.ndarray)
        self.assertEqual(annotated.shape, (480, 640, 3))
        # Pastikan frame berubah setelah anotasi digambar
        self.assertFalse(np.array_equal(annotated, dummy_frame))

    def test_visualizer_get_color(self):
        """Uji konsistensi warna visualizer."""
        c1 = Visualizer.get_color(0)
        c2 = Visualizer.get_color(0)
        self.assertEqual(c1, c2)
        self.assertEqual(len(c1), 3)


if __name__ == "__main__":
    unittest.main()
