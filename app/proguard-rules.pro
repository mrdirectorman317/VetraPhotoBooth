# ONNX Runtime uses JNI; keep its Java bindings intact.
-keep class ai.onnxruntime.** { *; }
-dontwarn ai.onnxruntime.**
