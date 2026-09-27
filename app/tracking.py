"""
app/tracking.py - Deterministic Object Tracking Engine (VisionX V0.7)

Menyediakan persistent Track ID untuk hasil deteksi objek YOLO.
Mengimplementasikan:
- Class-aware matching
- IoU overlap matching
- Centroid distance fallback
- State machine: tentative -> confirmed -> lost -> removed
- Velocity estimation (dx, dy in px/frame)
- Monotonic track ID allocation
"""

import math
from typing import Dict, List, Optional, Any


DEFAULT_TRACKING_CONFIG = {
    "TRACK_IOU_THRESHOLD": 0.30,
    "TRACK_MAX_MISSED_FRAMES": 15,
    "TRACK_MIN_HITS": 3,
    "TRACK_MAX_DISTANCE": 150.0,
    "TRACK_DISTANCE_FALLBACK": True
}


def compute_iou(box_a: Dict[str, float], box_b: Dict[str, float]) -> float:
    xa = max(box_a["x1"], box_b["x1"])
    ya = max(box_a["y1"], box_b["y1"])
    xb = min(box_a["x2"], box_b["x2"])
    yb = min(box_a["y2"], box_b["y2"])

    inter_w = max(0.0, xb - xa)
    inter_h = max(0.0, yb - ya)
    inter_area = inter_w * inter_h

    if inter_area <= 0:
        return 0.0

    area_a = max(0.0, (box_a["x2"] - box_a["x1"]) * (box_a["y2"] - box_a["y1"]))
    area_b = max(0.0, (box_b["x2"] - box_b["x1"]) * (box_b["y2"] - box_b["y1"]))
    union_area = area_a + area_b - inter_area

    return inter_area / union_area if union_area > 0 else 0.0


def compute_centroid_distance(ca: Dict[str, float], cb: Dict[str, float]) -> float:
    dx = ca["x"] - cb["x"]
    dy = ca["y"] - cb["y"]
    return math.sqrt(dx * dx + dy * dy)


class TrackingEngine:
    def __init__(self, config: Optional[Dict[str, Any]] = None):
        self.config = {**DEFAULT_TRACKING_CONFIG, **(config or {})}
        self.tracks: List[Dict[str, Any]] = []
        self.next_track_id = 1
        self.current_frame_id = 0
        self.total_allocated_tracks = 0
        self.is_enabled = True

    def reset(self):
        self.tracks = []
        self.next_track_id = 1
        self.current_frame_id = 0
        self.total_allocated_tracks = 0

    def update(self, detections: List[Dict[str, Any]], frame_id: Optional[int] = None) -> Dict[str, Any]:
        if frame_id is not None:
            self.current_frame_id = frame_id
        else:
            self.current_frame_id += 1
        current_frame = self.current_frame_id

        if not self.is_enabled:
            return {
                "visible_tracks": [],
                "active_tracks": [],
                "stats": self.get_stats([], [])
            }

        # Normalisasi deteksi
        normalized_dets = []
        for idx, det in enumerate(detections or []):
            raw_box = det.get("bbox") or {
                "x1": det.get("x1", 0),
                "y1": det.get("y1", 0),
                "x2": det.get("x2", 0),
                "y2": det.get("y2", 0)
            }
            x1 = min(raw_box["x1"], raw_box["x2"])
            x2 = max(raw_box["x1"], raw_box["x2"])
            y1 = min(raw_box["y1"], raw_box["y2"])
            y2 = max(raw_box["y1"], raw_box["y2"])

            if x2 <= x1 or y2 <= y1:
                continue

            cls_name = str(det.get("class_name") or det.get("className") or "object").lower()
            conf = float(det.get("confidence", 0.0))
            center = {"x": (x1 + x2) / 2.0, "y": (y1 + y2) / 2.0}

            normalized_dets.append({
                "index": idx,
                "class_name": cls_name,
                "confidence": conf,
                "bbox": {"x1": x1, "y1": y1, "x2": x2, "y2": y2},
                "center": center,
                "raw_detection": det
            })

        active_tracks = [t for t in self.tracks if t["state"] != "removed"]

        # Kelompokkan per class
        dets_by_class: Dict[str, List[Dict[str, Any]]] = {}
        for d in normalized_dets:
            dets_by_class.setdefault(d["class_name"], []).append(d)

        tracks_by_class: Dict[str, List[Dict[str, Any]]] = {}
        for t in active_tracks:
            tracks_by_class.setdefault(t["className"], []).append(t)

        matched_track_ids = set()
        matched_det_indices = set()
        all_classes = set(dets_by_class.keys()).union(tracks_by_class.keys())

        for cls in all_classes:
            cls_dets = dets_by_class.get(cls, [])
            cls_tracks = tracks_by_class.get(cls, [])

            if not cls_dets or not cls_tracks:
                continue

            # 1. IoU Greedy Matching
            iou_candidates = []
            for track in cls_tracks:
                for det in cls_dets:
                    iou = compute_iou(track["bbox"], det["bbox"])
                    if iou >= self.config["TRACK_IOU_THRESHOLD"]:
                        iou_candidates.append((iou, track, det))

            iou_candidates.sort(key=lambda x: x[0], reverse=True)

            for iou, track, det in iou_candidates:
                if track["trackId"] not in matched_track_ids and det["index"] not in matched_det_indices:
                    matched_track_ids.add(track["trackId"])
                    matched_det_indices.add(det["index"])
                    self._apply_match(track, det, current_frame)

            # 2. Centroid Distance Fallback
            if self.config.get("TRACK_DISTANCE_FALLBACK", True):
                rem_tracks = [t for t in cls_tracks if t["trackId"] not in matched_track_ids]
                rem_dets = [d for d in cls_dets if d["index"] not in matched_det_indices]

                dist_candidates = []
                for track in rem_tracks:
                    for det in rem_dets:
                        dist = compute_centroid_distance(track["center"], det["center"])
                        if dist <= self.config["TRACK_MAX_DISTANCE"]:
                            dist_candidates.append((dist, track, det))

                dist_candidates.sort(key=lambda x: x[0])

                for dist, track, det in dist_candidates:
                    if track["trackId"] not in matched_track_ids and det["index"] not in matched_det_indices:
                        matched_track_ids.add(track["trackId"])
                        matched_det_indices.add(det["index"])
                        self._apply_match(track, det, current_frame)

        # 3. Unmatched active tracks -> missed
        for track in active_tracks:
            if track["trackId"] not in matched_track_ids:
                track["missedFrames"] += 1
                track["ageFrames"] += 1
                track["velocity"] = {"x": 0.0, "y": 0.0}

                if track["missedFrames"] > self.config["TRACK_MAX_MISSED_FRAMES"]:
                    track["state"] = "removed"
                else:
                    track["state"] = "lost"

        # 4. Unmatched detections -> new track
        for det in normalized_dets:
            if det["index"] not in matched_det_indices:
                new_track = self._create_new_track(det, current_frame)
                self.tracks.append(new_track)

        # Bounded track cleanup
        if len(self.tracks) > 150:
            keep_active = [t for t in self.tracks if t["state"] != "removed"]
            recent_removed = [t for t in self.tracks if t["state"] == "removed"][-50:]
            self.tracks = keep_active + recent_removed

        visible = [t for t in self.tracks if t["state"] != "removed" and t["missedFrames"] == 0]
        active = [t for t in self.tracks if t["state"] != "removed"]

        return {
            "visible_tracks": visible,
            "active_tracks": active,
            "all_tracks": self.tracks,
            "stats": self.get_stats(visible, active)
        }

    def _apply_match(self, track: Dict[str, Any], det: Dict[str, Any], current_frame: int):
        prev_center = track["center"]
        new_center = det["center"]

        track["velocity"] = {
            "x": round(new_center["x"] - prev_center["x"], 2),
            "y": round(new_center["y"] - prev_center["y"], 2)
        }
        track["bbox"] = dict(det["bbox"])
        track["center"] = new_center
        track["confidence"] = det["confidence"]
        track["lastSeen"] = current_frame
        track["ageFrames"] += 1
        track["hits"] += 1
        track["missedFrames"] = 0

        if track["state"] == "tentative":
            if track["hits"] >= self.config["TRACK_MIN_HITS"]:
                track["state"] = "confirmed"
        elif track["state"] == "lost":
            track["state"] = "confirmed"

    def _create_new_track(self, det: Dict[str, Any], current_frame: int) -> Dict[str, Any]:
        track_id = self.next_track_id
        self.next_track_id += 1
        self.total_allocated_tracks += 1

        state = "confirmed" if self.config["TRACK_MIN_HITS"] <= 1 else "tentative"

        return {
            "trackId": track_id,
            "trackIdFormatted": f"#{track_id:02d}",
            "className": det["class_name"],
            "confidence": det["confidence"],
            "bbox": dict(det["bbox"]),
            "center": dict(det["center"]),
            "firstSeen": current_frame,
            "lastSeen": current_frame,
            "ageFrames": 1,
            "hits": 1,
            "missedFrames": 0,
            "velocity": {"x": 0.0, "y": 0.0},
            "state": state
        }

    def get_stats(self, visible: Optional[List[Dict[str, Any]]] = None, active: Optional[List[Dict[str, Any]]] = None) -> Dict[str, Any]:
        vis = visible if visible is not None else [t for t in self.tracks if t["state"] != "removed" and t["missedFrames"] == 0]
        act = active if active is not None else [t for t in self.tracks if t["state"] != "removed"]

        new_count = sum(1 for t in act if t["state"] == "tentative")
        lost_count = sum(1 for t in act if t["state"] == "lost")

        per_class = {}
        for t in vis:
            cls = t["className"]
            per_class[cls] = per_class.get(cls, 0) + 1

        return {
            "trackingStatus": "ACTIVE" if self.is_enabled else "STANDBY",
            "visibleCount": len(vis),
            "totalActiveCount": len(act),
            "newCount": new_count,
            "lostCount": lost_count,
            "uniqueTracksCount": self.total_allocated_tracks,
            "perClass": per_class
        }
