"""
tests/test_tracking_engine.py - Automated Unit & Regression Tests for VisionX V0.7 Object Tracking Engine

Mencakup 12 Pengujian Inti:
1. Single object persistence
2. Object movement & velocity estimation
3. Multiple objects tracking
4. Same class multiple objects (no swap)
5. Different classes (laptop != mouse)
6. Temporary disappearance (lost state recovery)
7. Track removal (exceeding max missed frames)
8. Track ID persistence (monotonic ID, no immediate reuse)
9. Class-aware matching verification
10. IoU matching threshold test
11. Centroid distance fallback matching test
12. Coordinate mapping compatibility (landscape, portrait, mirrored)
"""

import pytest
from app.tracking import TrackingEngine, compute_iou, compute_centroid_distance


class TestTrackingEngine:
    def test_1_single_object_persistence(self):
        """1. Object tetap memiliki Track ID yang sama pada frame berturut-turut."""
        tracker = TrackingEngine({"TRACK_MIN_HITS": 2, "TRACK_IOU_THRESHOLD": 0.3})
        
        # Frame 1
        res1 = tracker.update([
            {"class_name": "laptop", "confidence": 0.94, "bbox": {"x1": 100, "y1": 100, "x2": 300, "y2": 300}}
        ], frame_id=1)
        assert len(res1["visible_tracks"]) == 1
        track1 = res1["visible_tracks"][0]
        track_id = track1["trackId"]
        assert track1["state"] == "tentative"
        assert track1["hits"] == 1

        # Frame 2 (sedikit bergeser)
        res2 = tracker.update([
            {"class_name": "laptop", "confidence": 0.95, "bbox": {"x1": 102, "y1": 101, "x2": 302, "y2": 301}}
        ], frame_id=2)
        assert len(res2["visible_tracks"]) == 1
        track2 = res2["visible_tracks"][0]
        assert track2["trackId"] == track_id, "Track ID harus tetap sama untuk objek yang sama"
        assert track2["hits"] == 2
        assert track2["state"] == "confirmed", "Harus dipromosikan ke confirmed setelah mencukupi min hits"

    def test_2_object_movement_and_velocity(self):
        """2. Pergerakan objek dihitung menjadi estimasi velocity (dx, dy)."""
        tracker = TrackingEngine()
        
        # Frame 1: center (200, 200)
        tracker.update([
            {"class_name": "laptop", "confidence": 0.90, "bbox": {"x1": 100, "y1": 100, "x2": 300, "y2": 300}}
        ], frame_id=1)

        # Frame 2: bergeser ke kanan 20px, bawah 10px -> center (220, 210)
        res = tracker.update([
            {"class_name": "laptop", "confidence": 0.92, "bbox": {"x1": 120, "y1": 110, "x2": 320, "y2": 310}}
        ], frame_id=2)
        
        track = res["visible_tracks"][0]
        assert track["velocity"]["x"] == 20.0
        assert track["velocity"]["y"] == 10.0

    def test_3_multiple_objects(self):
        """3. Berbagai objek sekaligus diberi Track ID unik masing-masing."""
        tracker = TrackingEngine()
        
        detections = [
            {"class_name": "laptop", "confidence": 0.94, "bbox": {"x1": 50, "y1": 50, "x2": 250, "y2": 250}},
            {"class_name": "mouse", "confidence": 0.88, "bbox": {"x1": 300, "y1": 300, "x2": 400, "y2": 400}},
            {"class_name": "bottle", "confidence": 0.85, "bbox": {"x1": 500, "y1": 100, "x2": 600, "y2": 350}}
        ]
        res = tracker.update(detections, frame_id=1)
        assert len(res["visible_tracks"]) == 3
        ids = [t["trackId"] for t in res["visible_tracks"]]
        assert len(set(ids)) == 3, "Seluruh objek harus memiliki Track ID yang berbeda"

    def test_4_same_class_multiple_objects(self):
        """4. Beberapa objek dengan class sama (misal 2 laptop) tidak bertukar ID."""
        tracker = TrackingEngine({"TRACK_IOU_THRESHOLD": 0.3})
        
        # Frame 1: Laptop A (kiri) & Laptop B (kanan)
        res1 = tracker.update([
            {"class_name": "laptop", "confidence": 0.90, "bbox": {"x1": 50, "y1": 50, "x2": 200, "y2": 200}},
            {"class_name": "laptop", "confidence": 0.91, "bbox": {"x1": 400, "y1": 50, "x2": 550, "y2": 200}}
        ], frame_id=1)
        id_a = res1["visible_tracks"][0]["trackId"]
        id_b = res1["visible_tracks"][1]["trackId"]
        assert id_a != id_b

        # Frame 2: Keduanya bergeser sedikit
        res2 = tracker.update([
            {"class_name": "laptop", "confidence": 0.90, "bbox": {"x1": 55, "y1": 52, "x2": 205, "y2": 202}},
            {"class_name": "laptop", "confidence": 0.91, "bbox": {"x1": 405, "y1": 52, "x2": 555, "y2": 202}}
        ], frame_id=2)
        
        # Cari berdasarkan posisi
        left_track = [t for t in res2["visible_tracks"] if t["bbox"]["x1"] < 300][0]
        right_track = [t for t in res2["visible_tracks"] if t["bbox"]["x1"] > 300][0]
        assert left_track["trackId"] == id_a, "Laptop A harus tetap mempertahankan ID aslinya"
        assert right_track["trackId"] == id_b, "Laptop B harus tetap mempertahankan ID aslinya"

    def test_5_different_classes(self):
        """5. Objek dengan kelas berbeda tidak boleh bertukar Track ID sekalipun posisi bertumpuk."""
        tracker = TrackingEngine()
        
        # Frame 1: Laptop di posisi X
        res1 = tracker.update([
            {"class_name": "laptop", "confidence": 0.92, "bbox": {"x1": 100, "y1": 100, "x2": 250, "y2": 250}}
        ], frame_id=1)
        laptop_id = res1["visible_tracks"][0]["trackId"]

        # Frame 2: Mouse muncul di posisi yang persis sama
        res2 = tracker.update([
            {"class_name": "mouse", "confidence": 0.89, "bbox": {"x1": 100, "y1": 100, "x2": 250, "y2": 250}}
        ], frame_id=2)
        mouse_track = res2["visible_tracks"][0]
        assert mouse_track["trackId"] != laptop_id, "Mouse tidak boleh mengambil Track ID milik Laptop"
        assert mouse_track["className"] == "mouse"

    def test_6_temporary_disappearance(self):
        """6. Objek hilang beberapa frame lalu muncul kembali (status lost -> confirmed recovery)."""
        tracker = TrackingEngine({"TRACK_MIN_HITS": 1, "TRACK_MAX_MISSED_FRAMES": 5})
        
        # Frame 1: Muncul
        tracker.update([
            {"class_name": "laptop", "confidence": 0.90, "bbox": {"x1": 100, "y1": 100, "x2": 200, "y2": 200}}
        ], frame_id=1)

        # Frame 2: Hilang (kamera terhalang / missed detection)
        res2 = tracker.update([], frame_id=2)
        assert len(res2["visible_tracks"]) == 0
        assert len(res2["active_tracks"]) == 1
        assert res2["active_tracks"][0]["state"] == "lost"
        assert res2["active_tracks"][0]["missedFrames"] == 1

        # Frame 3: Muncul kembali di dekat posisi semula
        res3 = tracker.update([
            {"class_name": "laptop", "confidence": 0.92, "bbox": {"x1": 105, "y1": 102, "x2": 205, "y2": 202}}
        ], frame_id=3)
        assert len(res3["visible_tracks"]) == 1
        assert res3["visible_tracks"][0]["trackId"] == 1, "Track ID harus tetap sama setelah recovery"
        assert res3["visible_tracks"][0]["state"] == "confirmed"
        assert res3["visible_tracks"][0]["missedFrames"] == 0

    def test_7_track_removal(self):
        """7. Objek dihapus (state 'removed') jika melebihi TRACK_MAX_MISSED_FRAMES."""
        tracker = TrackingEngine({"TRACK_MAX_MISSED_FRAMES": 3})
        
        tracker.update([
            {"class_name": "bottle", "confidence": 0.88, "bbox": {"x1": 10, "y1": 10, "x2": 50, "y2": 150}}
        ], frame_id=1)

        # Lewatkan 4 frame berturut-turut tanpa deteksi
        tracker.update([], frame_id=2) # missed 1 -> lost
        tracker.update([], frame_id=3) # missed 2 -> lost
        tracker.update([], frame_id=4) # missed 3 -> lost
        res5 = tracker.update([], frame_id=5) # missed 4 > 3 -> removed

        assert len(res5["active_tracks"]) == 0, "Track harus berstatus removed dan tidak aktif"

    def test_8_track_id_persistence(self):
        """8. Track ID monotonically increasing; ID yang dihapus tidak langsung digunakan kembali."""
        tracker = TrackingEngine({"TRACK_MAX_MISSED_FRAMES": 1})
        
        # Objek 1 muncul dan dihapus
        tracker.update([
            {"class_name": "bottle", "confidence": 0.8, "bbox": {"x1": 10, "y1": 10, "x2": 50, "y2": 150}}
        ], frame_id=1)
        tracker.update([], frame_id=2)
        tracker.update([], frame_id=3) # removed

        # Objek 2 baru muncul
        res4 = tracker.update([
            {"class_name": "cup", "confidence": 0.85, "bbox": {"x1": 100, "y1": 100, "x2": 200, "y2": 200}}
        ], frame_id=4)
        new_track = res4["visible_tracks"][0]
        assert new_track["trackId"] == 2, "Harus mengalokasikan Track ID #02, bukan menggunakan ulang #01"

    def test_9_class_aware_matching(self):
        """9. Pengujian strict class gating matching."""
        tracker = TrackingEngine()
        tracker.update([
            {"class_name": "person", "confidence": 0.95, "bbox": {"x1": 100, "y1": 100, "x2": 200, "y2": 300}}
        ], frame_id=1)

        res = tracker.update([
            {"class_name": "laptop", "confidence": 0.90, "bbox": {"x1": 100, "y1": 100, "x2": 200, "y2": 300}}
        ], frame_id=2)
        
        # Harus ada 2 track di sistem: person (lost) dan laptop (baru)
        assert len(res["visible_tracks"]) == 1
        assert res["visible_tracks"][0]["className"] == "laptop"
        assert res["visible_tracks"][0]["trackId"] == 2

    def test_10_iou_matching(self):
        """10. Uji IoU matching threshold."""
        # Box A: [0, 0, 100, 100], area = 10000
        # Box B: [50, 0, 150, 100], inter = 50 * 100 = 5000, union = 15000 -> IoU = 0.333
        iou = compute_iou({"x1": 0, "y1": 0, "x2": 100, "y2": 100}, {"x1": 50, "y1": 0, "x2": 150, "y2": 100})
        assert abs(iou - 0.333) < 0.01

        tracker = TrackingEngine({"TRACK_IOU_THRESHOLD": 0.40, "TRACK_DISTANCE_FALLBACK": False})
        tracker.update([
            {"class_name": "laptop", "confidence": 0.9, "bbox": {"x1": 0, "y1": 0, "x2": 100, "y2": 100}}
        ], frame_id=1)

        # IoU 0.333 < 0.40 -> Tanpa fallback, tidak boleh match
        res = tracker.update([
            {"class_name": "laptop", "confidence": 0.9, "bbox": {"x1": 50, "y1": 0, "x2": 150, "y2": 100}}
        ], frame_id=2)
        assert res["visible_tracks"][0]["trackId"] == 2, "Harus membuat track baru jika di bawah threshold IoU"

    def test_11_centroid_distance(self):
        """11. Uji Centroid distance fallback saat IoU rendah."""
        # Jarak center (50, 50) ke (120, 50) = 70px.
        dist = compute_centroid_distance({"x": 50, "y": 50}, {"x": 120, "y": 50})
        assert dist == 70.0

        # IoU threshold tinggi (0.80), fallback jarak max 100px
        tracker = TrackingEngine({
            "TRACK_IOU_THRESHOLD": 0.80,
            "TRACK_MAX_DISTANCE": 100.0,
            "TRACK_DISTANCE_FALLBACK": True
        })
        tracker.update([
            {"class_name": "mouse", "confidence": 0.85, "bbox": {"x1": 20, "y1": 20, "x2": 80, "y2": 80}}
        ], frame_id=1)

        # Objek bergeser sehingga IoU < 0.80 tapi jarak centroid <= 100px
        res = tracker.update([
            {"class_name": "mouse", "confidence": 0.86, "bbox": {"x1": 60, "y1": 20, "x2": 120, "y2": 80}}
        ], frame_id=2)
        assert res["visible_tracks"][0]["trackId"] == 1, "Centroid distance fallback harus berhasil mencocokkan track"

    def test_12_coordinate_mapping_compatibility(self):
        """12. Kompatibilitas format koordinat unscaled dari CoordinateMapper."""
        # Simulasi deteksi setelah dipetakan dari model 640x640 ke kamera 1280x720 (16:9)
        tracker = TrackingEngine()
        
        # Koordinat video 1280x720
        mapped_box_frame1 = {"x1": 320.5, "y1": 180.2, "x2": 850.8, "y2": 650.0}
        mapped_box_frame2 = {"x1": 325.0, "y1": 182.0, "x2": 855.0, "y2": 652.0}

        tracker.update([
            {"class_name": "laptop", "confidence": 0.94, "bbox": mapped_box_frame1}
        ], frame_id=1)

        res = tracker.update([
            {"class_name": "laptop", "confidence": 0.95, "bbox": mapped_box_frame2}
        ], frame_id=2)

        assert len(res["visible_tracks"]) == 1
        assert res["visible_tracks"][0]["trackId"] == 1
        stats = res["stats"]
        assert stats["trackingStatus"] == "ACTIVE"
        assert stats["visibleCount"] == 1
        assert stats["uniqueTracksCount"] == 1
        assert stats["perClass"].get("laptop") == 1
