# Depth model asset

`depth_anything_v2_vits.onnx` is bundled here for on-device neural depth
estimation. It is the **Depth Anything V2 Small** (ViT-S encoder) model,
ONNX-exported by the `onnx-community` project on Hugging Face:

https://huggingface.co/onnx-community/depth-anything-v2-small (`onnx/model_fp16.onnx`)

- License: Apache-2.0 (the Small variant of Depth Anything V2; Base/Large
  are CC-BY-NC-4.0 and must not be substituted here without checking that
  license).
- Input: `pixel_values`, float32 NCHW, ImageNet-normalized
  (mean `[0.485, 0.456, 0.406]`, std `[0.229, 0.224, 0.225]`), resized to
  518x518 — matches `DepthEngine.kt` and `DepthEngine.INPUT_SIZE`.
- Output: `predicted_depth`, float32, relative inverse depth at
  518x518 (before `DepthEngine`'s per-frame min-max normalization to 0..1).

`DepthEngine.kt` loads this file by name from the app's assets at runtime via
`assets.open("models/depth_anything_v2_vits.onnx")`. If it's ever removed,
`DepthEngine.initialize()` throws `IllegalStateException` and the app falls
back to an un-blurred capture (see `ImageProcessor.kt` / `MainActivity.kt`).

To use a different encoder size (base/large) or a newer export, replace this
file and update `DepthEngine.INPUT_SIZE` / the mean-std constants to match
the new model's `preprocessor_config.json`.
