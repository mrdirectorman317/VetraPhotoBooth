package com.example.ultraportrait.ai

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import android.content.Context
import android.graphics.Bitmap
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.nio.FloatBuffer

/**
 * Wraps ONNX Runtime to execute Depth Anything V2 (ViT-S) on-device.
 *
 * Inference is requested on the NNAPI execution provider so it is offloaded to the
 * Snapdragon NPU/DSP where the driver supports it; ONNX Runtime silently falls back
 * to CPU execution for any unsupported ops, so this stays correct on devices/emulators
 * without an NNAPI HAL implementation for the full graph.
 */
class DepthEngine(private val context: Context) {

    companion object {
        private const val TAG = "DepthEngine"
        private const val MODEL_ASSET_PATH = "models/depth_anything_v2_vits.onnx"
        const val INPUT_SIZE = 518

        private val IMAGENET_MEAN = floatArrayOf(0.485f, 0.456f, 0.406f)
        private val IMAGENET_STD = floatArrayOf(0.229f, 0.224f, 0.225f)
    }

    private var environment: OrtEnvironment? = null
    private var session: OrtSession? = null
    private var inputName: String = "pixel_values"

    val isInitialized: Boolean
        get() = session != null

    /** Loads the model from assets and creates an NNAPI-backed session. Call once, off the main thread. */
    suspend fun initialize() = withContext(Dispatchers.IO) {
        if (isInitialized) return@withContext

        val modelBytes = context.assets.open(MODEL_ASSET_PATH).use { it.readBytes() }

        val env = OrtEnvironment.getEnvironment()
        val options = OrtSession.SessionOptions().apply {
            setIntraOpNumThreads(4)
            setMemoryPatternOptimization(true)
            try {
                addNnapi()
                Log.i(TAG, "NNAPI execution provider enabled")
            } catch (t: Throwable) {
                Log.w(TAG, "NNAPI unavailable, falling back to CPU execution provider", t)
            }
        }

        val newSession = env.createSession(modelBytes, options)
        inputName = newSession.inputNames.firstOrNull() ?: inputName

        environment = env
        session = newSession
        Log.i(TAG, "DepthEngine initialized, input=$inputName")
    }

    /**
     * Runs depth estimation on [bitmap] and returns a normalized (0..1, near..far) depth map
     * at [INPUT_SIZE] x [INPUT_SIZE] resolution, row-major.
     */
    suspend fun estimateDepth(bitmap: Bitmap): FloatArray = withContext(Dispatchers.Default) {
        val activeSession = session ?: throw IllegalStateException("DepthEngine.initialize() was not called or failed")
        val env = environment ?: throw IllegalStateException("DepthEngine.initialize() was not called or failed")

        val resized = if (bitmap.width == INPUT_SIZE && bitmap.height == INPUT_SIZE) {
            bitmap
        } else {
            Bitmap.createScaledBitmap(bitmap, INPUT_SIZE, INPUT_SIZE, true)
        }

        val inputBuffer = bitmapToChwFloatBuffer(resized)
        val inputTensor = OnnxTensor.createTensor(
            env,
            inputBuffer,
            longArrayOf(1, 3, INPUT_SIZE.toLong(), INPUT_SIZE.toLong())
        )

        inputTensor.use { tensor ->
            activeSession.run(mapOf(inputName to tensor)).use { results ->
                val rawOutput = results[0].value
                val depthPlane = extractDepthPlane(rawOutput)
                normalize(depthPlane)
            }
        }
    }

    /** Converts an ARGB bitmap into a CHW, ImageNet-normalized float buffer for model input. */
    private fun bitmapToChwFloatBuffer(bitmap: Bitmap): FloatBuffer {
        val pixels = IntArray(INPUT_SIZE * INPUT_SIZE)
        bitmap.getPixels(pixels, 0, INPUT_SIZE, 0, 0, INPUT_SIZE, INPUT_SIZE)

        val buffer = FloatBuffer.allocate(3 * INPUT_SIZE * INPUT_SIZE)
        val channelSize = INPUT_SIZE * INPUT_SIZE

        val rPlane = FloatArray(channelSize)
        val gPlane = FloatArray(channelSize)
        val bPlane = FloatArray(channelSize)

        for (i in pixels.indices) {
            val pixel = pixels[i]
            rPlane[i] = (((pixel shr 16) and 0xFF) / 255f - IMAGENET_MEAN[0]) / IMAGENET_STD[0]
            gPlane[i] = (((pixel shr 8) and 0xFF) / 255f - IMAGENET_MEAN[1]) / IMAGENET_STD[1]
            bPlane[i] = ((pixel and 0xFF) / 255f - IMAGENET_MEAN[2]) / IMAGENET_STD[2]
        }

        buffer.put(rPlane)
        buffer.put(gPlane)
        buffer.put(bPlane)
        buffer.rewind()
        return buffer
    }

    /** Depth Anything V2 outputs a single-channel [1, H, W] (or [1, 1, H, W]) map; flatten to HxW. */
    @Suppress("UNCHECKED_CAST")
    private fun extractDepthPlane(rawOutput: Any): FloatArray {
        return when (rawOutput) {
            is Array<*> -> flattenNested(rawOutput)
            is FloatArray -> rawOutput
            else -> throw IllegalStateException("Unexpected ONNX output shape: ${rawOutput::class}")
        }
    }

    private fun flattenNested(array: Array<*>): FloatArray {
        val out = ArrayList<Float>(INPUT_SIZE * INPUT_SIZE)
        fun recurse(node: Any?) {
            when (node) {
                is FloatArray -> node.forEach { out.add(it) }
                is Array<*> -> node.forEach { recurse(it) }
                else -> Unit
            }
        }
        recurse(array)
        return out.toFloatArray()
    }

    private fun normalize(depth: FloatArray): FloatArray {
        var min = Float.MAX_VALUE
        var max = -Float.MAX_VALUE
        for (v in depth) {
            if (v < min) min = v
            if (v > max) max = v
        }
        val range = (max - min).takeIf { it > 1e-6f } ?: 1f
        return FloatArray(depth.size) { i -> (depth[i] - min) / range }
    }

    fun close() {
        session?.close()
        session = null
        environment = null
    }
}
