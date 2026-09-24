"""
VisionX Audit & Object Detection Evaluator
==========================================
Implementasi audit evaluasi deteksi objek standar (COCO / PASCAL VOC matching):
- 1-to-1 Bounding Box matching berbasis IoU (IoU >= threshold).
- Duplicate predictions dialokasikan sebagai False Positive (FP).
- Ground Truth tanpa matching dialokasikan sebagai False Negative (FN).
- Menghitung Precision, Recall, F1, mAP@50, mAP@50-95, serta confusion matrix.
- Mendukung model PyTorch (.pt) dan ONNX (.onnx).
"""

import os
import sys
import glob
import time
import math
import numpy as np
import cv2
from pathlib import Path
from typing import Dict, List, Tuple, Any, Optional

VISIONX_CLASSES = ['person', 'bottle', 'cup', 'laptop', 'mouse', 'keyboard', 'cell_phone']


def box_iou_batch(boxes_a: np.ndarray, boxes_b: np.ndarray) -> np.ndarray:
    """
    Menghitung pairwise IoU antara dua set bounding box [x1, y1, x2, y2].
    boxes_a: (N, 4)
    boxes_b: (M, 4)
    Returns: (N, M) matrix IoU
    """
    if len(boxes_a) == 0 or len(boxes_b) == 0:
        return np.zeros((len(boxes_a), len(boxes_b)), dtype=np.float32)

    # Intersections
    xA = np.maximum(boxes_a[:, None, 0], boxes_b[None, :, 0])
    yA = np.maximum(boxes_a[:, None, 1], boxes_b[None, :, 1])
    xB = np.minimum(boxes_a[:, None, 2], boxes_b[None, :, 2])
    yB = np.minimum(boxes_a[:, None, 3], boxes_b[None, :, 3])

    inter_w = np.maximum(0.0, xB - xA)
    inter_h = np.maximum(0.0, yB - yA)
    inter_area = inter_w * inter_h

    # Areas
    area_a = (boxes_a[:, 2] - boxes_a[:, 0]) * (boxes_a[:, 3] - boxes_a[:, 1])
    area_b = (boxes_b[:, 2] - boxes_b[:, 0]) * (boxes_b[:, 3] - boxes_b[:, 1])

    union = area_a[:, None] + area_b[None, :] - inter_area
    iou = np.where(union > 0, inter_area / union, 0.0)
    return iou


def nms_numpy(boxes: np.ndarray, scores: np.ndarray, iou_threshold: float = 0.45) -> List[int]:
    """Non-Maximum Suppression standar pada bounding boxes [x1, y1, x2, y2]."""
    if len(boxes) == 0:
        return []

    x1 = boxes[:, 0]
    y1 = boxes[:, 1]
    x2 = boxes[:, 2]
    y2 = boxes[:, 3]
    areas = (x2 - x1) * (y2 - y1)
    order = scores.argsort()[::-1]

    keep = []
    while order.size > 0:
        i = order[0]
        keep.append(i)
        if order.size == 1:
            break

        xx1 = np.maximum(x1[i], x1[order[1:]])
        yy1 = np.maximum(y1[i], y1[order[1:]])
        xx2 = np.minimum(x2[i], x2[order[1:]])
        yy2 = np.minimum(y2[i], y2[order[1:]])

        w = np.maximum(0.0, xx2 - xx1)
        h = np.maximum(0.0, yy2 - yy1)
        inter = w * h
        ovr = inter / (areas[i] + areas[order[1:]] - inter)

        inds = np.where(ovr <= iou_threshold)[0]
        order = order[inds + 1]

    return keep


def compute_ap(recalls: np.ndarray, precisions: np.ndarray) -> float:
    """
    Menghitung Average Precision (AP) menggunakan all-points / COCO continuous interpolation.
    """
    mrec = np.concatenate(([0.0], recalls, [1.0]))
    mpre = np.concatenate(([1.0], precisions, [0.0]))

    # Compute the precision envelope
    for i in range(len(mpre) - 2, -1, -1):
        mpre[i] = max(mpre[i], mpre[i + 1])

    # Integrate area under curve
    i = np.where(mrec[1:] != mrec[:-1])[0]
    ap = np.sum((mrec[i + 1] - mrec[i]) * mpre[i + 1])
    return float(ap)


class VisionXAuditEvaluator:
    def __init__(
        self,
        model_path: str,
        classes: List[str] = VISIONX_CLASSES,
        conf_threshold: float = 0.25,
        iou_nms_threshold: float = 0.45,
        iou_eval_threshold: float = 0.50
    ):
        self.model_path = model_path
        self.classes = classes
        self.num_classes = len(classes)
        self.conf_threshold = conf_threshold
        self.iou_nms_threshold = iou_nms_threshold
        self.iou_eval_threshold = iou_eval_threshold
        self.is_onnx = str(model_path).endswith('.onnx')
        self._init_session()

    def _init_session(self):
        if self.is_onnx:
            import onnxruntime as ort
            self.session = ort.InferenceSession(self.model_path, providers=['CPUExecutionProvider'])
        else:
            from ultralytics import YOLO
            self.model = YOLO(self.model_path)

    def preprocess(self, img_bgr: np.ndarray) -> Tuple[np.ndarray, float, int, int, int, int]:
        h0, w0 = img_bgr.shape[:2]
        target_dim = 640
        scale = min(target_dim / w0, target_dim / h0)
        nw, nh = int(round(w0 * scale)), int(round(h0 * scale))
        resized = cv2.resize(img_bgr, (nw, nh))

        pad_x = (target_dim - nw) // 2
        pad_y = (target_dim - nh) // 2
        canvas = np.full((target_dim, target_dim, 3), 114, dtype=np.uint8)
        canvas[pad_y:pad_y + nh, pad_x:pad_x + nw] = resized

        blob = canvas.astype(np.float32) / 255.0
        blob = np.transpose(blob, (2, 0, 1))  # HWC -> CHW
        blob = np.expand_dims(blob, 0)
        blob = blob[:, ::-1, :, :]  # BGR to RGB
        return blob, scale, pad_x, pad_y, w0, h0

    def infer_onnx(self, blob: np.ndarray, scale: float, pad_x: int, pad_y: int, w0: int, h0: int, conf_thresh: float) -> Tuple[List[Dict], int]:
        outputs = self.session.run(None, {'images': blob})
        output = outputs[0][0]  # Shape: [11, 8400]
        num_anchors = output.shape[1]

        raw_pred_count = 0
        boxes_per_class: Dict[int, List[List[float]]] = {c: [] for c in range(self.num_classes)}
        scores_per_class: Dict[int, List[float]] = {c: [] for c in range(self.num_classes)}

        for i in range(num_anchors):
            scores = output[4:4 + self.num_classes, i]
            max_idx = int(np.argmax(scores))
            max_score = float(scores[max_idx])

            if max_score >= conf_thresh:
                raw_pred_count += 1
                cx = output[0, i]
                cy = output[1, i]
                w = output[2, i]
                h = output[3, i]

                cx_orig = (cx - pad_x) / scale
                cy_orig = (cy - pad_y) / scale
                w_orig = w / scale
                h_orig = h / scale

                x1 = max(0.0, min(float(w0), cx_orig - w_orig / 2.0))
                y1 = max(0.0, min(float(h0), cy_orig - h_orig / 2.0))
                x2 = max(0.0, min(float(w0), cx_orig + w_orig / 2.0))
                y2 = max(0.0, min(float(h0), cy_orig + h_orig / 2.0))

                if x2 > x1 and y2 > y1:
                    boxes_per_class[max_idx].append([x1, y1, x2, y2])
                    scores_per_class[max_idx].append(max_score)

        # Apply NMS per class
        final_preds = []
        for c in range(self.num_classes):
            c_boxes = np.array(boxes_per_class[c], dtype=np.float32)
            c_scores = np.array(scores_per_class[c], dtype=np.float32)
            if len(c_boxes) > 0:
                keep_indices = nms_numpy(c_boxes, c_scores, self.iou_nms_threshold)
                for ki in keep_indices:
                    final_preds.append({
                        'class_id': c,
                        'class_name': self.classes[c],
                        'confidence': float(c_scores[ki]),
                        'box': c_boxes[ki].tolist()  # [x1, y1, x2, y2]
                    })

        return final_preds, raw_pred_count

    def load_ground_truths(self, label_path: str, img_w: int, img_h: int) -> List[Dict]:
        gt_boxes = []
        if os.path.exists(label_path):
            with open(label_path, 'r', encoding='utf-8') as f:
                for line in f:
                    parts = line.strip().split()
                    if len(parts) >= 5:
                        cid = int(parts[0])
                        if cid < self.num_classes:
                            cx = float(parts[1]) * img_w
                            cy = float(parts[2]) * img_h
                            w = float(parts[3]) * img_w
                            h = float(parts[4]) * img_h
                            x1 = max(0.0, min(float(img_w), cx - w / 2.0))
                            y1 = max(0.0, min(float(img_h), cy - h / 2.0))
                            x2 = max(0.0, min(float(img_w), cx + w / 2.0))
                            y2 = max(0.0, min(float(img_h), cy + h / 2.0))
                            gt_boxes.append({
                                'class_id': cid,
                                'class_name': self.classes[cid],
                                'box': [x1, y1, x2, y2],
                                'matched': False
                            })
        return gt_boxes

    def evaluate_test_set(
        self,
        images_dir: str = 'datasets/processed/images/test',
        labels_dir: str = 'datasets/processed/labels/test',
        eval_conf: float = 0.25,
        iou_threshold: float = 0.50
    ) -> Dict[str, Any]:
        """
        Menjalankan audit matching bounding box pada seluruh citra test set.
        """
        img_paths = sorted(glob.glob(os.path.join(images_dir, '*.jpg')))
        
        # Data struktur untuk per-class evaluation
        all_gt_count = {c: 0 for c in range(self.num_classes)}
        all_predictions_by_class: Dict[int, List[Dict]] = {c: [] for c in range(self.num_classes)}
        total_raw_anchors = 0
        total_post_nms_preds = 0

        # Confusion matrix: (num_classes + 1) x (num_classes + 1), baris = GT, kolom = Pred
        # Indeks num_classes adalah background (unmatched)
        confusion_matrix = np.zeros((self.num_classes + 1, self.num_classes + 1), dtype=np.int32)

        # Per-class summary counters at operational threshold
        per_class_summary = {
            c: {
                'gt': 0,
                'raw_predictions': 0,
                'post_nms_predictions': 0,
                'tp': 0,
                'fp': 0,
                'fn': 0,
                'confidences': []
            } for c in range(self.num_classes)
        }

        # IoU thresholds for mAP50-95
        iou_thresholds = np.linspace(0.50, 0.95, 10)
        # Store for full mAP curve: predictions list with (conf, tp_flags_per_iou, class_id)
        map_records_per_class: Dict[int, List[Dict]] = {c: [] for c in range(self.num_classes)}

        for img_path in img_paths:
            img_name = os.path.basename(img_path)
            label_name = os.path.splitext(img_name)[0] + '.txt'
            label_path = os.path.join(labels_dir, label_name)

            img = cv2.imread(img_path)
            h0, w0 = img.shape[:2]

            gt_boxes = self.load_ground_truths(label_path, w0, h0)
            for gt in gt_boxes:
                all_gt_count[gt['class_id']] += 1
                per_class_summary[gt['class_id']]['gt'] += 1

            # Infer (menggunakan conf rendah 0.001 untuk AP calculation, lalu filter untuk summary)
            blob, scale, pad_x, pad_y, _, _ = self.preprocess(img)
            preds_all, raw_count = self.infer_onnx(blob, scale, pad_x, pad_y, w0, h0, conf_thresh=0.001)
            total_raw_anchors += raw_count

            # Filter predictions at operational eval_conf for direct TP/FP counting
            preds_eval = [p for p in preds_all if p['confidence'] >= eval_conf]
            total_post_nms_preds += len(preds_eval)

            # MATCHING ALGORITHM FOR OPERATIONAL CONFIDENCE (e.g. 0.25 or 0.45)
            # Group GT and Preds by class for this image
            for c in range(self.num_classes):
                c_gts = [g for g in gt_boxes if g['class_id'] == c]
                c_preds = [p for p in preds_eval if p['class_id'] == c]
                
                per_class_summary[c]['post_nms_predictions'] += len(c_preds)

                # Sort predictions descending by confidence
                c_preds.sort(key=lambda x: x['confidence'], reverse=True)

                gt_matched = [False] * len(c_gts)
                gt_boxes_np = np.array([g['box'] for g in c_gts], dtype=np.float32)

                for pred in c_preds:
                    per_class_summary[c]['confidences'].append(pred['confidence'])
                    pred_box_np = np.array([pred['box']], dtype=np.float32)

                    if len(gt_boxes_np) > 0:
                        ious = box_iou_batch(pred_box_np, gt_boxes_np)[0]
                        best_gt_idx = int(np.argmax(ious))
                        best_iou = float(ious[best_gt_idx])

                        if best_iou >= iou_threshold and not gt_matched[best_gt_idx]:
                            # TRUE POSITIVE (Matched 1-to-1)
                            gt_matched[best_gt_idx] = True
                            per_class_summary[c]['tp'] += 1
                            confusion_matrix[c, c] += 1
                        else:
                            # FALSE POSITIVE (Duplicate box or low IoU)
                            per_class_summary[c]['fp'] += 1
                            confusion_matrix[self.num_classes, c] += 1  # background -> pred c
                    else:
                        # FALSE POSITIVE (No GT in image)
                        per_class_summary[c]['fp'] += 1
                        confusion_matrix[self.num_classes, c] += 1

                # Unmatched GTs are FALSE NEGATIVES
                for idx, matched in enumerate(gt_matched):
                    if not matched:
                        per_class_summary[c]['fn'] += 1
                        confusion_matrix[c, self.num_classes] += 1  # GT c -> background

            # MATCHING ALGORITHM FOR FULL PR CURVE & mAP (across all IoU thresholds 0.50:0.05:0.95)
            for c in range(self.num_classes):
                c_gts = [g for g in gt_boxes if g['class_id'] == c]
                c_preds = [p for p in preds_all if p['class_id'] == c]
                c_preds.sort(key=lambda x: x['confidence'], reverse=True)

                gt_boxes_np = np.array([g['box'] for g in c_gts], dtype=np.float32)
                # For each IoU threshold, keep track of which GTs were matched
                gt_matched_per_iou = {iou_t: [False] * len(c_gts) for iou_t in iou_thresholds}

                for pred in c_preds:
                    pred_box_np = np.array([pred['box']], dtype=np.float32)
                    tp_flags = []

                    if len(gt_boxes_np) > 0:
                        ious = box_iou_batch(pred_box_np, gt_boxes_np)[0]
                        best_gt_idx = int(np.argmax(ious))
                        best_iou = float(ious[best_gt_idx])

                        for iou_t in iou_thresholds:
                            if best_iou >= iou_t and not gt_matched_per_iou[iou_t][best_gt_idx]:
                                gt_matched_per_iou[iou_t][best_gt_idx] = True
                                tp_flags.append(1)
                            else:
                                tp_flags.append(0)
                    else:
                        tp_flags = [0] * len(iou_thresholds)

                    map_records_per_class[c].append({
                        'confidence': pred['confidence'],
                        'tp_flags': tp_flags  # length 10
                    })

        # Calculate AP50 and AP50-95 per class
        ap50_per_class = {}
        ap50_95_per_class = {}

        for c in range(self.num_classes):
            n_gt = all_gt_count[c]
            records = map_records_per_class[c]
            records.sort(key=lambda x: x['confidence'], reverse=True)

            if n_gt == 0:
                ap50_per_class[c] = 0.0
                ap50_95_per_class[c] = 0.0
                continue

            if len(records) == 0:
                ap50_per_class[c] = 0.0
                ap50_95_per_class[c] = 0.0
                continue

            ap_at_ious = []
            for iou_idx, iou_t in enumerate(iou_thresholds):
                tp_array = np.array([r['tp_flags'][iou_idx] for r in records])
                fp_array = 1 - tp_array

                cum_tp = np.cumsum(tp_array)
                cum_fp = np.cumsum(fp_array)

                precisions = cum_tp / (cum_tp + cum_fp + 1e-16)
                recalls = cum_tp / (n_gt + 1e-16)

                ap = compute_ap(recalls, precisions)
                ap_at_ious.append(ap)

            ap50_per_class[c] = ap_at_ious[0]  # IoU 0.50
            ap50_95_per_class[c] = float(np.mean(ap_at_ious))

        # Overall Aggregates
        mean_ap50 = float(np.mean(list(ap50_per_class.values())))
        mean_ap50_95 = float(np.mean(list(ap50_95_per_class.values())))

        # Aggregate Precision and Recall at operational conf
        total_tp = sum(per_class_summary[c]['tp'] for c in range(self.num_classes))
        total_fp = sum(per_class_summary[c]['fp'] for c in range(self.num_classes))
        total_fn = sum(per_class_summary[c]['fn'] for c in range(self.num_classes))
        total_gt = sum(all_gt_count.values())

        macro_p = []
        macro_r = []
        for c in range(self.num_classes):
            tp = per_class_summary[c]['tp']
            fp = per_class_summary[c]['fp']
            fn = per_class_summary[c]['fn']
            p = tp / (tp + fp) if (tp + fp) > 0 else 0.0
            r = tp / (tp + fn) if (tp + fn) > 0 else 0.0
            macro_p.append(p)
            macro_r.append(r)

        return {
            'total_images': len(img_paths),
            'total_ground_truth': total_gt,
            'total_raw_anchors': total_raw_anchors,
            'total_post_nms_predictions': total_post_nms_preds,
            'confidence_threshold': eval_conf,
            'iou_nms_threshold': self.iou_nms_threshold,
            'iou_eval_threshold': iou_threshold,
            'mAP50': mean_ap50,
            'mAP50_95': mean_ap50_95,
            'macro_precision': float(np.mean(macro_p)),
            'macro_recall': float(np.mean(macro_r)),
            'overall_precision': total_tp / (total_tp + total_fp) if (total_tp + total_fp) > 0 else 0.0,
            'overall_recall': total_tp / (total_tp + total_fn) if (total_tp + total_fn) > 0 else 0.0,
            'per_class': {
                self.classes[c]: {
                    'class_id': c,
                    'gt_count': all_gt_count[c],
                    'post_nms_preds': per_class_summary[c]['post_nms_predictions'],
                    'tp': per_class_summary[c]['tp'],
                    'fp': per_class_summary[c]['fp'],
                    'fn': per_class_summary[c]['fn'],
                    'precision': per_class_summary[c]['tp'] / (per_class_summary[c]['tp'] + per_class_summary[c]['fp']) if (per_class_summary[c]['tp'] + per_class_summary[c]['fp']) > 0 else 0.0,
                    'recall': per_class_summary[c]['tp'] / (per_class_summary[c]['tp'] + per_class_summary[c]['fn']) if (per_class_summary[c]['tp'] + per_class_summary[c]['fn']) > 0 else 0.0,
                    'f1': (2 * per_class_summary[c]['tp']) / (2 * per_class_summary[c]['tp'] + per_class_summary[c]['fp'] + per_class_summary[c]['fn']) if (2 * per_class_summary[c]['tp'] + per_class_summary[c]['fp'] + per_class_summary[c]['fn']) > 0 else 0.0,
                    'ap50': ap50_per_class[c],
                    'ap50_95': ap50_95_per_class[c],
                    'avg_conf': float(np.mean(per_class_summary[c]['confidences'])) if per_class_summary[c]['confidences'] else 0.0
                } for c in range(self.num_classes)
            },
            'confusion_matrix': confusion_matrix.tolist()
        }


def print_audit_report(results: Dict[str, Any], title: str = "VISIONX AUDIT REPORT"):
    print("=" * 90)
    print(f"=== {title} ===")
    print("=" * 90)
    print(f"Total Test Images      : {results['total_images']}")
    print(f"Total Ground Truth BBoxes : {results['total_ground_truth']}")
    print(f"Confidence Threshold   : {results['confidence_threshold']}")
    print(f"IoU Matching Threshold : {results['iou_eval_threshold']}")
    print(f"IoU NMS Threshold      : {results['iou_nms_threshold']}")
    print("-" * 90)
    print(f"mAP@50                 : {results['mAP50']:.4f} ({results['mAP50']*100:.2f}%)")
    print(f"mAP@50-95              : {results['mAP50_95']:.4f} ({results['mAP50_95']*100:.2f}%)")
    print(f"Macro Precision        : {results['macro_precision']:.4f} ({results['macro_precision']*100:.2f}%)")
    print(f"Macro Recall           : {results['macro_recall']:.4f} ({results['macro_recall']*100:.2f}%)")
    print("=" * 90)

    print(f"{'Class':<12} | {'GT':<5} | {'Preds':<6} | {'TP':<5} | {'FP':<5} | {'FN':<5} | {'Prec':<7} | {'Recall':<7} | {'AP50':<7} | {'AP50-95':<7}")
    print("-" * 90)
    for cname, stats in results['per_class'].items():
        print(
            f"{cname:<12} | "
            f"{stats['gt_count']:<5} | "
            f"{stats['post_nms_preds']:<6} | "
            f"{stats['tp']:<5} | "
            f"{stats['fp']:<5} | "
            f"{stats['fn']:<5} | "
            f"{stats['precision']:<7.4f} | "
            f"{stats['recall']:<7.4f} | "
            f"{stats['ap50']:<7.4f} | "
            f"{stats['ap50_95']:<7.4f}"
        )
    print("=" * 90)


if __name__ == '__main__':
    onnx_path = 'web/public/models/visionx_v1.onnx'
    evaluator = VisionXAuditEvaluator(onnx_path)

    # 1. Operational Threshold 0.25 (Standard YOLO Default)
    print("\n[AUDIT 1] Standard Default Confidence Threshold (0.25):")
    res_25 = evaluator.evaluate_test_set(eval_conf=0.25, iou_threshold=0.50)
    print_audit_report(res_25, "AUDIT RESULT (CONF = 0.25, IoU = 0.50)")

    # 2. Operational Threshold 0.45 (VisionX Web Default)
    print("\n[AUDIT 2] VisionX Web Default Confidence Threshold (0.45):")
    res_45 = evaluator.evaluate_test_set(eval_conf=0.45, iou_threshold=0.50)
    print_audit_report(res_45, "AUDIT RESULT (CONF = 0.45, IoU = 0.50)")
