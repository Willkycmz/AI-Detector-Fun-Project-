"""
Regression tests for VisionX V0.6.1 Custom YOLO ONNX Inference Pipeline.
Verifies:
- ONNX model input/output tensor shapes [1, 3, 640, 640] -> [1, 11, 8400]
- Custom model 7 classes vs COCO 80 classes separation
- Class mapping consistency
- Golden test detection accuracy (laptop, mouse, keyboard)
- Synchronization between repository models and web/public assets
"""

import unittest
import os
import hashlib
import numpy as np
import cv2
import onnxruntime as ort

VISIONX_V1_CLASSES = [
    'person',
    'bottle',
    'cup',
    'laptop',
    'mouse',
    'keyboard',
    'cell_phone'
]

COCO_CLASSES_COUNT = 80


class TestVisionXV1InferenceRegression(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.model_path = os.path.join("models", "visionx_v1", "best.onnx")
        cls.web_model_path = os.path.join("web", "public", "models", "visionx_v1.onnx")
        cls.golden_image_path = os.path.join(
            "datasets", "processed", "images", "test", "coco_train_000415_1b9b81.jpg"
        )
        cls.session = ort.InferenceSession(cls.model_path)

    def test_model_files_exist_and_synchronized(self):
        """Pastikan best.onnx dan web asset visionx_v1.onnx ada dan identik."""
        self.assertTrue(os.path.exists(self.model_path), f"File {self.model_path} tidak ditemukan")
        self.assertTrue(os.path.exists(self.web_model_path), f"File {self.web_model_path} tidak ditemukan")
        
        h_model = hashlib.sha256(open(self.model_path, 'rb').read()).hexdigest()
        h_web = hashlib.sha256(open(self.web_model_path, 'rb').read()).hexdigest()
        self.assertEqual(h_model, h_web, "File best.onnx dan web/public/models/visionx_v1.onnx harus identik")

    def test_input_and_output_tensor_shapes(self):
        """Verifikasi bahwa model input tetap [1, 3, 640, 640] dan output tetap [1, 11, 8400]."""
        inputs = self.session.get_inputs()
        self.assertEqual(len(inputs), 1)
        self.assertEqual(inputs[0].shape, [1, 3, 640, 640])

        outputs = self.session.get_outputs()
        self.assertEqual(len(outputs), 1)
        self.assertEqual(outputs[0].shape, [1, 11, 8400])

    def test_custom_vs_coco_channel_separation(self):
        """Verifikasi pemisahan channel custom 7 kelas (11 channel) vs COCO (84 channel)."""
        output_channels = self.session.get_outputs()[0].shape[1]
        self.assertEqual(output_channels, 11, "Custom model harus memiliki 11 channel (4 box + 7 classes)")
        
        num_classes = output_channels - 4
        self.assertEqual(num_classes, len(VISIONX_V1_CLASSES))
        self.assertNotEqual(num_classes, COCO_CLASSES_COUNT, "Decoder custom tidak boleh memakai 80 kelas COCO")

    def test_golden_image_inference_detection(self):
        """Verifikasi inferensi pada golden test image mendeteksi laptop, mouse, dan keyboard."""
        self.assertTrue(os.path.exists(self.golden_image_path), f"Citra {self.golden_image_path} tidak ditemukan")
        img = cv2.imread(self.golden_image_path)
        h, w = img.shape[:2]

        # Letterbox 640x640 padding 114
        scale = min(640 / w, 640 / h)
        nw, nh = int(round(w * scale)), int(round(h * scale))
        pad_x, pad_y = (640 - nw) // 2, (640 - nh) // 2
        resized = cv2.resize(img, (nw, nh))
        canvas = np.full((640, 640, 3), 114, dtype=np.uint8)
        canvas[pad_y:pad_y + nh, pad_x:pad_x + nw] = resized
        rgb = cv2.cvtColor(canvas, cv2.COLOR_BGR2RGB)
        blob = (rgb.astype(np.float32) / 255.0).transpose(2, 0, 1)[None, ...]

        out = self.session.run(None, {'images': blob})[0][0] # shape (11, 8400)
        self.assertEqual(out.shape, (11, 8400))

        # Decode
        candidates = []
        for i in range(8400):
            scores = out[4:, i]
            max_c = int(np.argmax(scores))
            max_s = float(scores[max_c])
            if max_s >= 0.45: # default confidence threshold
                cx, cy, bw, bh = out[0:4, i]
                cx_orig = (cx - pad_x) / scale
                cy_orig = (cy - pad_y) / scale
                bw_orig = bw / scale
                bh_orig = bh / scale
                x1 = max(0, cx_orig - bw_orig / 2)
                y1 = max(0, cy_orig - bh_orig / 2)
                x2 = min(w, cx_orig + bw_orig / 2)
                y2 = min(h, cy_orig + bh_orig / 2)
                candidates.append((VISIONX_V1_CLASSES[max_c], max_s, [x1, y1, x2, y2]))

        self.assertGreater(len(candidates), 0, "Harus menghasilkan kandidat box sebelum NMS")

        # NMS
        boxes = [[b[0], b[1], b[2] - b[0], b[3] - b[1]] for _, _, b in candidates]
        scores = [s for _, s, _ in candidates]
        indices = cv2.dnn.NMSBoxes(boxes, scores, 0.45, 0.45)
        
        detected_classes = {candidates[i][0] for i in indices}
        self.assertIn('laptop', detected_classes, "Golden test harus mendeteksi 'laptop'")
        self.assertIn('mouse', detected_classes, "Golden test harus mendeteksi 'mouse'")
        self.assertIn('keyboard', detected_classes, "Golden test harus mendeteksi 'keyboard'")


if __name__ == '__main__':
    unittest.main()
