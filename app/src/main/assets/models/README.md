# Depth model asset

Place `depth_anything_v2_vits.onnx` in this directory before building a release
you intend to run depth estimation with.

The model is intentionally **not** committed to this repository (ONNX weights
for Depth Anything V2 (ViT-S) are ~100MB and are distributed separately under
their own license). Download it from the official Depth Anything V2 release
and export/convert it to ONNX with a static `1x3x518x518` input, e.g.:

```
python export_onnx.py --encoder vits --input-size 518 --output depth_anything_v2_vits.onnx
```

Then copy it here:

```
cp depth_anything_v2_vits.onnx app/src/main/assets/models/
```

`DepthEngine.kt` loads this file by name from the app's assets at runtime via
`assets.open("models/depth_anything_v2_vits.onnx")`. If the file is missing,
`DepthEngine.initialize()` throws `IllegalStateException` and the app falls
back to an un-blurred capture (see `ImageProcessor.kt`).
