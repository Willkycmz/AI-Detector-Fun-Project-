"""
Unit Tests for VisionX Audit Evaluator (test_evaluator.py)
"""

import unittest
import numpy as np
from app.evaluator import box_iou_batch, nms_numpy, compute_ap, VisionXAuditEvaluator, VISIONX_CLASSES


class TestEvaluator(unittest.TestCase):
    def test_box_iou_batch_exact(self):
        box_a = np.array([[0, 0, 10, 10]], dtype=np.float32)
        box_b = np.array([[0, 0, 10, 10]], dtype=np.float32)
        iou = box_iou_batch(box_a, box_b)
        self.assertAlmostEqual(float(iou[0, 0]), 1.0, places=4)

    def test_box_iou_batch_disjoint(self):
        box_a = np.array([[0, 0, 10, 10]], dtype=np.float32)
        box_b = np.array([[20, 20, 30, 30]], dtype=np.float32)
        iou = box_iou_batch(box_a, box_b)
        self.assertAlmostEqual(float(iou[0, 0]), 0.0, places=4)

    def test_box_iou_batch_partial(self):
        box_a = np.array([[0, 0, 10, 10]], dtype=np.float32)  # area 100
        box_b = np.array([[5, 0, 15, 10]], dtype=np.float32)  # area 100, inter 50, union 150
        iou = box_iou_batch(box_a, box_b)
        self.assertAlmostEqual(float(iou[0, 0]), 50.0 / 150.0, places=4)

    def test_nms_numpy(self):
        boxes = np.array([
            [10, 10, 50, 50],
            [12, 12, 52, 52],  # high overlap with 1st
            [100, 100, 150, 150]  # distinct
        ], dtype=np.float32)
        scores = np.array([0.9, 0.8, 0.7], dtype=np.float32)
        keep = nms_numpy(boxes, scores, iou_threshold=0.5)
        self.assertEqual(keep, [0, 2])

    def test_compute_ap(self):
        recalls = np.array([0.2, 0.4, 0.6, 0.8, 1.0])
        precisions = np.array([1.0, 0.8, 0.8, 0.5, 0.5])
        ap = compute_ap(recalls, precisions)
        self.assertGreaterEqual(ap, 0.0)
        self.assertLessEqual(ap, 1.0)


if __name__ == '__main__':
    unittest.main()
