"""
VisionX Milestone 1 - Deterministic Golden Detection Evaluation
===============================================================
Verifies:
1. Model tensor shapes: input [1, 3, 640, 640] -> output [1, 11, 8400]
2. Channel layout: 4 bbox values + 7 class scores (no YOLOv5 objectness)
3. Correct channels-first indexing: data[(4 + c) * 8400 + i] vs invalid data[i * 11 + 4 + c]
4. Class mapping: index 0..6 -> ['person', 'bottle', 'cup', 'laptop', 'mouse', 'keyboard', 'cell_phone']
5. Real-image golden evaluations for all 7 classes verifying class index -> class name
"""

import os
import unittest
import numpy as np
import cv2
import onnx
import onnxruntime as ort

VISIONX_CLASSES = [
    'person',
    'bottle',
    'cup',
    'laptop',
    'mouse',
    'keyboard',
    'cell_phone'
]

GOLDEN_IMAGES = {
    'person': 'datasets/processed_v2/images/test/coco_train_000372_ada83f.jpg',
    'bottle': 'datasets/processed_v2/images/test/coco_train_000423_901723.jpg',
    'cup': 'datasets/processed_v2/images/test/coco_train_000172_e69399.jpg',
    'laptop': 'datasets/processed_v2/images/test/coco_train_000442_c97f69.jpg',
    'mouse': 'datasets/processed_v2/images/test/coco_train_000421_8e1b6c.jpg',
    'keyboard': 'datasets/processed_v2/images/test/coco_train_000395_b673e2.jpg',
    'cell_phone': 'datasets/raw/own/images/own_v2_cell_phone_001.jpg'
}


class TestGoldenDetections(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.model_path = os.path.join("models", "visionx_v2", "best.onnx")
        cls.web_model_path = os.path.join("web", "public", "models", "visionx_v2.onnx")
        
        assert os.path.exists(cls.model_path), f"Model path not found: {cls.model_path}"
        assert os.path.exists(cls.web_model_path), f"Web model path not found: {cls.web_model_path}"
        
        cls.session = ort.InferenceSession(cls.model_path)
        cls.onnx_model = onnx.load(cls.model_path)

    def test_01_model_metadata_and_class_ordering(self):
        """Verifikasi bahwa metadata ONNX memiliki 7 kelas dalam urutan yang tepat."""
        meta_dict = {}
        for prop in self.onnx_model.metadata_props:
            meta_dict[prop.key] = prop.value
        
        self.assertIn('names', meta_dict, "Metadata ONNX harus menyertakan properti 'names'")
        # e.g. {0: 'person', 1: 'bottle', 2: 'cup', 3: 'laptop', 4: 'mouse', 5: 'keyboard', 6: 'cell_phone'}
        names_str = meta_dict['names']
        for idx, expected_name in enumerate(VISIONX_CLASSES):
            self.assertIn(f"{idx}: '{expected_name}'", names_str, f"Kelas {idx} harus '{expected_name}'")

    def test_02_output_tensor_shape(self):
        """Verifikasi bahwa output tensor berbentuk [1, 11, 8400]."""
        outputs = self.session.get_outputs()
        self.assertEqual(len(outputs), 1)
        shape = outputs[0].shape
        self.assertEqual(shape[0], 1, "Batch size harus 1")
        self.assertEqual(shape[1], 11, "Harus 11 channel: 4 bbox + 7 classes")
        self.assertEqual(shape[2], 8400, "Harus 8400 anchor predictions")

    def test_03_channels_first_indexing_integrity(self):
        """
        Membuktikan secara deterministik bahwa indexing tensor [1, 11, 8400]
        adalah data[(4 + c) * 8400 + i], dan membuktikan kegagalan data[i * 11 + 4 + c].
        """
        # Buat synthetic tensor dengan nilai channel yang unik
        num_channels = 11
        num_anchors = 8400
        synthetic_data = np.zeros((1, num_channels, num_anchors), dtype=np.float32)
        
        # Channel 0..3 adalah box coords, Channel 4..10 adalah class 0..6
        for c in range(7):
            channel_idx = 4 + c
            synthetic_data[0, channel_idx, :] = float(channel_idx) * 0.1
            
        flat_data = synthetic_data.flatten()
        
        # Uji anchor sembarang i=42
        test_anchor = 42
        for c in range(7):
            correct_val = flat_data[(4 + c) * num_anchors + test_anchor]
            self.assertAlmostEqual(correct_val, (4 + c) * 0.1, places=5)
            
            # Buktikan bahwa indexing lama (i * 11 + 4 + c) menghasilkan nilai yang salah
            # Pada flatten C-order untuk [1, 11, 8400], index i*11+4+c membaca channel 0 untuk anchor lain
            wrong_idx = test_anchor * num_channels + 4 + c
            wrong_val = flat_data[wrong_idx]
            self.assertNotEqual(correct_val, wrong_val)

    def _infer_image(self, img_path):
        self.assertTrue(os.path.exists(img_path), f"File {img_path} tidak ditemukan")
        img = cv2.imread(img_path)
        self.assertIsNotNone(img, f"Gagal membaca gambar {img_path}")
        h, w = img.shape[:2]

        scale = min(640 / w, 640 / h)
        nw, nh = int(round(w * scale)), int(round(h * scale))
        pad_x, pad_y = (640 - nw) // 2, (640 - nh) // 2
        resized = cv2.resize(img, (nw, nh))
        canvas = np.full((640, 640, 3), 114, dtype=np.uint8)
        canvas[pad_y:pad_y + nh, pad_x:pad_x + nw] = resized
        rgb = cv2.cvtColor(canvas, cv2.COLOR_BGR2RGB)
        blob = (rgb.astype(np.float32) / 255.0).transpose(2, 0, 1)[None, ...]

        out = self.session.run(None, {'images': blob})[0][0]  # Shape: (11, 8400)
        
        # Decode candidates
        candidates = []
        for i in range(8400):
            scores = out[4:11, i]
            max_c = int(np.argmax(scores))
            max_s = float(scores[max_c])
            if max_s >= 0.25:
                cx, cy, bw, bh = out[0:4, i]
                cx_orig = (cx - pad_x) / scale
                cy_orig = (cy - pad_y) / scale
                bw_orig = bw / scale
                bh_orig = bh / scale
                x1 = max(0.0, cx_orig - bw_orig / 2.0)
                y1 = max(0.0, cy_orig - bh_orig / 2.0)
                x2 = min(float(w), cx_orig + bw_orig / 2.0)
                y2 = min(float(h), cy_orig + bh_orig / 2.0)
                candidates.append({
                    'class_id': max_c,
                    'class_name': VISIONX_CLASSES[max_c],
                    'confidence': max_s,
                    'box': [x1, y1, x2, y2]
                })

        # NMS
        if not candidates:
            return []
            
        boxes = [[c['box'][0], c['box'][1], c['box'][2] - c['box'][0], c['box'][3] - c['box'][1]] for c in candidates]
        scores = [c['confidence'] for c in candidates]
        indices = cv2.dnn.NMSBoxes(boxes, scores, 0.25, 0.45)
        
        final_detections = []
        if len(indices) > 0:
            for idx in indices.flatten():
                final_detections.append(candidates[idx])
        return final_detections

    def test_04_golden_all_7_classes(self):
        """Memverifikasi deteksi deterministik pada citra golden untuk seluruh 7 kelas."""
        for expected_class, img_path in GOLDEN_IMAGES.items():
            with self.subTest(class_name=expected_class):
                detections = self._infer_image(img_path)
                self.assertGreater(len(detections), 0, f"Harus ada deteksi untuk {expected_class} pada {img_path}")
                detected_classes = [d['class_name'] for d in detections]
                self.assertIn(
                    expected_class,
                    detected_classes,
                    f"Kelas {expected_class} harus terdeteksi di {img_path}. Terdeteksi: {detected_classes}"
                )

    def test_05_cell_phone_not_detected_as_laptop(self):
        """
        Memverifikasi spesifik kasus regresi:
        smartphone/cell_phone pada own_v2_cell_phone_001.jpg TIDAK dideteksi sebagai laptop.
        """
        img_path = GOLDEN_IMAGES['cell_phone']
        detections = self._infer_image(img_path)
        self.assertGreater(len(detections), 0)
        
        top_detection = sorted(detections, key=lambda d: d['confidence'], reverse=True)[0]
        self.assertEqual(top_detection['class_name'], 'cell_phone')
        self.assertEqual(top_detection['class_id'], 6)
        self.assertNotEqual(top_detection['class_name'], 'laptop')


if __name__ == '__main__':
    unittest.main()
