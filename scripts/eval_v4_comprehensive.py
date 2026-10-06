import os
import json
from pathlib import Path
from ultralytics import YOLO

PROJECT_ROOT = Path(__file__).resolve().parent.parent
MODEL_PATH = PROJECT_ROOT / "models" / "visionx_v4" / "weights" / "best.pt"
DATASET_YAML = PROJECT_ROOT / "datasets" / "processed_v3" / "dataset.yaml"

# V3 Baseline metrics (from V3 validation on processed_v2)
V3_BASELINE_MAP50 = {
    0: 72.2,   # person
    1: 49.6,   # bottle
    2: 54.1,   # cup
    3: 70.2,   # laptop
    4: 94.9,   # mouse
    5: 44.9,   # keyboard
    6: 86.8,   # cell_phone
    7: 99.5,   # dompet
    8: 98.5,   # kacamata
    9: 89.9,   # sendal
    10: 99.5,  # tisue
    11: 99.5,  # uang_100rb
    12: 0.0,   # cooler_hp
    13: 0.0,   # kunci_cakram
}

def evaluate_split(model, split_name):
    print(f"\nEvaluating VisionX V4 on '{split_name}' split...")
    metrics = model.val(
        data=str(DATASET_YAML),
        split=split_name,
        imgsz=640,
        batch=16,
        device="cpu",
        verbose=False
    )
    
    overall_p = metrics.box.mp
    overall_r = metrics.box.mr
    overall_map50 = metrics.box.map50
    overall_map95 = metrics.box.map
    
    # Initialize all 21 classes with default 0.0
    per_class = {}
    for c, cname in model.names.items():
        per_class[c] = {
            "name": cname,
            "instances": 0,
            "precision": 0.0,
            "recall": 0.0,
            "map50": 0.0,
            "map50_95": 0.0
        }
        
    ap_classes = metrics.box.ap_class_index
    for i, c in enumerate(ap_classes):
        p, r, ap50, ap95 = metrics.box.class_result(i)
        instances = int(metrics.nt_per_class[c]) if metrics.nt_per_class is not None else 0
        per_class[c] = {
            "name": model.names[c],
            "instances": instances,
            "precision": p * 100,
            "recall": r * 100,
            "map50": ap50 * 100,
            "map50_95": ap95 * 100
        }
        
    return {
        "overall": {
            "precision": overall_p * 100,
            "recall": overall_r * 100,
            "map50": overall_map50 * 100,
            "map50_95": overall_map95 * 100
        },
        "per_class": per_class
    }

def print_table(title, split_data):
    print("\n" + "=" * 105)
    print(f" {title}")
    print("=" * 105)
    overall = split_data["overall"]
    print(f"Overall Precision : {overall['precision']:.2f}%")
    print(f"Overall Recall    : {overall['recall']:.2f}%")
    print(f"Overall mAP50     : {overall['map50']:.2f}%")
    print(f"Overall mAP50-95  : {overall['map50_95']:.2f}%")
    print("-" * 105)
    print(f"{'ID':2} | {'Class Name':14} | {'Instances':9} | {'Precision':10} | {'Recall':8} | {'mAP50':8} | {'mAP50-95':9} | {'V3 mAP50':8} | {'Delta':7} | {'Status'}")
    print("-" * 105)
    
    for i in range(21):
        info = split_data["per_class"][i]
        cname = info["name"]
        inst = info.get("instances", 0)
        p = info["precision"]
        r = info["recall"]
        ap50 = info["map50"]
        ap95 = info["map50_95"]
        
        v3_str = f"{V3_BASELINE_MAP50[i]:.1f}%" if i in V3_BASELINE_MAP50 else "N/A (New)"
        
        if i in V3_BASELINE_MAP50 and V3_BASELINE_MAP50[i] > 0:
            diff = ap50 - V3_BASELINE_MAP50[i]
            diff_str = f"{diff:+.1f}%"
            if diff < -10.0:
                status = "REGRESI SIGNIFICANT"
            elif diff < -3.0:
                status = "Turun Ringan"
            elif diff > +5.0:
                status = "NAIK PESAT"
            else:
                status = "Stabil"
        elif i in [12, 13]:
            diff_str = "-"
            status = "0 Sampel (Preserved)"
        else:
            diff_str = "Baru"
            status = "Kelas Baru V4"
            
        print(f"{i:2d} | {cname:14s} | {inst:9d} | {p:9.1f}% | {r:7.1f}% | {ap50:7.1f}% | {ap95:8.1f}% | {v3_str:8s} | {diff_str:7s} | {status}")
    print("-" * 105)

def main():
    print("Loading model from:", MODEL_PATH)
    model = YOLO(str(MODEL_PATH))
    
    # 1. Val Split
    val_data = evaluate_split(model, "val")
    
    # 2. Test Split
    test_data = evaluate_split(model, "test")
    
    # Print Tables
    print_table("VISIONX V4 - VALIDATION SPLIT (1,510 Images)", val_data)
    print_table("VISIONX V4 - TEST SPLIT (1,508 Images)", test_data)
    
    # Save results to json for reference
    out_json = PROJECT_ROOT / "outputs" / "v4_evaluation_results.json"
    out_json.write_text(json.dumps({"val": val_data, "test": test_data}, indent=2), encoding="utf-8")
    print(f"\nSaved raw evaluation metrics to {out_json}")

if __name__ == "__main__":
    main()
