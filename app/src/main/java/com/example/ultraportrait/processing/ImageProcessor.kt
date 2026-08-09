package com.example.ultraportrait.processing

import android.content.ContentValues
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapShader
import android.graphics.ColorSpace
import android.graphics.HardwareRenderer
import android.graphics.PixelFormat
import android.graphics.PointF
import android.graphics.RenderEffect
import android.graphics.RenderNode
import android.graphics.RuntimeShader
import android.graphics.Shader
import android.hardware.HardwareBuffer
import android.media.ImageReader
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import android.util.Log
import androidx.annotation.RequiresApi
import com.example.ultraportrait.ai.DepthEngine
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.text.SimpleDateFormat
import java.util.Locale

/**
 * Runs the neural depth pass and the AGSL optical-bokeh shader over a full-resolution
 * (up to 200MP) capture, then persists the result to the Gallery via MediaStore.
 */
@RequiresApi(Build.VERSION_CODES.TIRAMISU)
class ImageProcessor(
    private val context: Context,
    private val depthEngine: DepthEngine
) {

    companion object {
        private const val TAG = "ImageProcessor"
        private const val SHADER_ASSET_PATH = "shaders/bokeh.agsl"
        private const val DEFAULT_FOCUS_RANGE = 0.06f
    }

    private val shaderSource: String by lazy {
        context.assets.open(SHADER_ASSET_PATH).bufferedReader().use { it.readText() }
    }

    /**
     * @param source Full-resolution capture straight off the sensor.
     * @param focusPointNormalized Tap-to-focus point in 0..1 image-space UV coordinates.
     * @param maxBlurRadiusPx Max optical-disc blur radius in source pixels, driven by the aperture slider.
     */
    suspend fun renderBokeh(
        source: Bitmap,
        focusPointNormalized: PointF,
        maxBlurRadiusPx: Float
    ): Bitmap = withContext(Dispatchers.Default) {
        if (!depthEngine.isInitialized) {
            depthEngine.initialize()
        }

        val depthInput = Bitmap.createScaledBitmap(
            source, DepthEngine.INPUT_SIZE, DepthEngine.INPUT_SIZE, true
        )
        val depthMap = depthEngine.estimateDepth(depthInput)
        val depthSize = DepthEngine.INPUT_SIZE

        val focalDepth = sampleDepthAt(depthMap, depthSize, focusPointNormalized)
        val depthBitmap = depthArrayToBitmap(depthMap, depthSize)

        val runtimeShader = RuntimeShader(shaderSource).apply {
            setInputShader(
                "depthMap",
                BitmapShader(depthBitmap, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP)
            )
            setFloatUniform("imageResolution", source.width.toFloat(), source.height.toFloat())
            setFloatUniform("depthResolution", depthSize.toFloat(), depthSize.toFloat())
            setFloatUniform("focalDepth", focalDepth)
            setFloatUniform("focusRange", DEFAULT_FOCUS_RANGE)
            setFloatUniform("maxBlurRadius", maxBlurRadiusPx)
        }

        val effect = RenderEffect.createRuntimeShaderEffect(runtimeShader, "image")
        val result = renderWithEffect(source, effect)

        depthBitmap.recycle()
        depthInput.recycle()
        result
    }

    private fun sampleDepthAt(depthMap: FloatArray, size: Int, uv: PointF): Float {
        val x = (uv.x.coerceIn(0f, 1f) * (size - 1)).toInt()
        val y = (uv.y.coerceIn(0f, 1f) * (size - 1)).toInt()
        return depthMap[y * size + x]
    }

    private fun depthArrayToBitmap(depthMap: FloatArray, size: Int): Bitmap {
        val pixels = IntArray(size * size)
        for (i in depthMap.indices) {
            val v = (depthMap[i].coerceIn(0f, 1f) * 255f).toInt()
            pixels[i] = (0xFF shl 24) or (v shl 16) or (v shl 8) or v
        }
        return Bitmap.createBitmap(pixels, size, size, Bitmap.Config.ARGB_8888)
    }

    /**
     * Renders [effect] (which reads the drawn content as its "image" input, per
     * [RenderEffect.createRuntimeShaderEffect]) into an offscreen [RenderNode] and
     * rasterizes it via [HardwareRenderer] into a software [Bitmap].
     */
    private fun renderWithEffect(source: Bitmap, effect: RenderEffect): Bitmap {
        val width = source.width
        val height = source.height

        val renderNode = RenderNode("bokehPass").apply {
            setPosition(0, 0, width, height)
            val canvas = beginRecording()
            canvas.drawBitmap(source, 0f, 0f, null)
            endRecording()
            setRenderEffect(effect)
        }

        val reader = ImageReader.newInstance(
            width,
            height,
            PixelFormat.RGBA_8888,
            1,
            HardwareBuffer.USAGE_GPU_COLOR_OUTPUT or HardwareBuffer.USAGE_GPU_SAMPLED_IMAGE
        )

        val hardwareRenderer = HardwareRenderer()
        try {
            hardwareRenderer.setContentRoot(renderNode)
            hardwareRenderer.setSurface(reader.surface)
            hardwareRenderer.createRenderRequest()
                .setWaitForPresent(true)
                .syncAndDraw()

            val image = reader.acquireNextImage()
                ?: throw IllegalStateException("HardwareRenderer produced no output image")

            val hardwareBuffer = image.hardwareBuffer
                ?: throw IllegalStateException("Rendered image has no HardwareBuffer")

            val hwBitmap = Bitmap.wrapHardwareBuffer(hardwareBuffer, ColorSpace.get(ColorSpace.Named.SRGB))
                ?: throw IllegalStateException("Failed to wrap HardwareBuffer as Bitmap")

            val softwareBitmap = hwBitmap.copy(Bitmap.Config.ARGB_8888, false)

            hwBitmap.recycle()
            hardwareBuffer.close()
            image.close()

            return softwareBitmap
        } finally {
            hardwareRenderer.destroy()
            reader.close()
        }
    }

    /** Saves [bitmap] as a JPEG in the Pictures/UltraPortrait gallery collection. */
    suspend fun saveToGallery(bitmap: Bitmap): Uri = withContext(Dispatchers.IO) {
        val resolver = context.contentResolver
        val timestamp = SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(java.util.Date())
        val filename = "UltraPortrait_$timestamp.jpg"

        val values = ContentValues().apply {
            put(MediaStore.Images.Media.DISPLAY_NAME, filename)
            put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg")
            put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/UltraPortrait")
            put(MediaStore.Images.Media.IS_PENDING, 1)
        }

        val collection = MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
        val uri = resolver.insert(collection, values)
            ?: throw IllegalStateException("MediaStore rejected insert for $filename")

        resolver.openOutputStream(uri)?.use { out ->
            val jpegBytes = ByteArrayOutputStream().apply {
                bitmap.compress(Bitmap.CompressFormat.JPEG, 95, this)
            }.toByteArray()
            out.write(jpegBytes)
        } ?: throw IllegalStateException("Failed to open output stream for $uri")

        values.clear()
        values.put(MediaStore.Images.Media.IS_PENDING, 0)
        resolver.update(uri, values, null, null)

        Log.i(TAG, "Saved ${bitmap.width}x${bitmap.height} image to $uri")
        uri
    }
}
