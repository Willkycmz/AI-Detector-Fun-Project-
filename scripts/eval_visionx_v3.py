from ultralytics import YOLO

def main():
    model = YOLO("models/visionx_v3/weights/best.pt")
    print("Evaluating models/visionx_v3/weights/best.pt...")

    metrics = model.val(
        data="datasets/processed_v2/dataset.yaml",
        split="val",
        batch=16,
        imgsz=640,
        device="cpu",
        verbose=False
    )

    print("\n" + "=" * 65)
    print(" VISIONX V3 - FINAL VALIDATION REPORT (14 CLASSES)")
    print("=" * 65)
    
    mp = metrics.results_dict.get("metrics/precision(B)", 0)
    mr = metrics.results_dict.get("metrics/recall(B)", 0)
    map50 = metrics.results_dict.get("metrics/mAP50(B)", 0)
    map95 = metrics.results_dict.get("metrics/mAP50-95(B)", 0)

    print(f"Overall Precision : {mp:.4f} ({mp*100:.1f}%)")
    print(f"Overall Recall    : {mr:.4f} ({mr*100:.1f}%)")
    print(f"Overall mAP50     : {map50:.4f} ({map50*100:.1f}%)")
    print(f"Overall mAP50-95  : {map95:.4f} ({map95*100:.1f}%)")
    print("-" * 65)
    print(f"{'ID':2} | {'Class Name':14} | {'Precision':10} | {'Recall':8} | {'mAP50':8} | {'mAP50-95':9}")
    print("-" * 65)

    for i, cname in model.names.items():
        if i < len(metrics.box.p):
            p = metrics.box.p[i]
            r = metrics.box.r[i]
            ap50 = metrics.box.ap50[i]
            ap95 = metrics.box.ap[i]
            print(f"{i:2d} | {cname:14s} | {p:10.4f} | {r:8.4f} | {ap50:8.4f} | {ap95:9.4f}")
        else:
            print(f"{i:2d} | {cname:14s} | {0.0:10.4f} | {0.0:8.4f} | {0.0:8.4f} | {0.0:9.4f}")
    print("-" * 65)

if __name__ == "__main__":
    main()
