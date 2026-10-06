from ultralytics import YOLO

model = YOLO("models/visionx_v3/weights/best.pt")
results = model.val(data="datasets/processed_v2/dataset.yaml", split="val", verbose=False)

print("--- VAL METRICS SUMMARY ---")
print(f"Overall mAP50: {results.box.map50:.4f}")
print(f"Overall mAP50-95: {results.box.map:.4f}")
print(f"Overall Precision: {results.box.mp:.4f}")
print(f"Overall Recall: {results.box.mr:.4f}")

classes = results.names
print("-" * 65)
print(f"{'ID':<3} | {'Class':<14} | {'Precision':<10} | {'Recall':<10} | {'mAP50':<10} | {'mAP50-95':<10}")
print("-" * 65)
for i, name in classes.items():
    p = results.box.p[i] if i < len(results.box.p) else 0.0
    r = results.box.r[i] if i < len(results.box.r) else 0.0
    ap50 = results.box.ap50[i] if i < len(results.box.ap50) else 0.0
    ap = results.box.ap[i] if i < len(results.box.ap) else 0.0
    print(f"{i:<3} | {name:<14} | {p:<10.3f} | {r:<10.3f} | {ap50:<10.3f} | {ap:<10.3f}")
print("-" * 65)
