import onnxruntime as ort
import numpy as np

print("Checking ONNX Runtime with models/visionx_v3/visionx_v3.onnx...")
session = ort.InferenceSession("models/visionx_v3/visionx_v3.onnx")

inputs = session.get_inputs()
outputs = session.get_outputs()

print(f"Input name: {inputs[0].name}, shape: {inputs[0].shape}, type: {inputs[0].type}")
print(f"Output name: {outputs[0].name}, shape: {outputs[0].shape}, type: {outputs[0].type}")

dummy_input = np.random.randn(1, 3, 640, 640).astype(np.float32)
out = session.run([outputs[0].name], {inputs[0].name: dummy_input})[0]

print(f"Inference success! Output tensor shape: {out.shape}")
print(f"Bbox coords (first 4): [cx, cy, w, h]")
print(f"Class count: {out.shape[1] - 4} (expected 14)")
print(f"Anchor grid count: {out.shape[2]} (expected 8400)")

assert out.shape == (1, 18, 8400), f"Unexpected shape {out.shape}"
print("ALL ONNX RUNTIME CHECKS PASSED PERFECTLY!")
