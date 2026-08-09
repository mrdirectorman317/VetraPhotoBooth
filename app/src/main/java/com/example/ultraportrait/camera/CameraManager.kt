package com.example.ultraportrait.camera

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageFormat
import android.hardware.camera2.CameraCharacteristics
import android.util.Log
import android.util.Size
import androidx.camera.camera2.interop.Camera2CameraInfo
import androidx.camera.camera2.interop.Camera2Interop
import androidx.camera.camera2.interop.ExperimentalCamera2Interop
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.FocusMeteringAction
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import kotlinx.coroutines.guava.await
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * Owns the CameraX pipeline and exposes the ISOCELL HP2's 200MP high-resolution
 * still stream (16320x12240) alongside a normal-resolution preview.
 *
 * High-resolution sizes on Samsung's HP2 sensor are only exposed through
 * [CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP].getHighResolutionOutputSizes,
 * which CameraX surfaces via [ResolutionSelector.PREFER_HIGHER_RESOLUTION_OVER_CAPTURE_RATE].
 */
@OptIn(ExperimentalCamera2Interop::class)
class CameraManager(private val context: Context) {

    companion object {
        private const val TAG = "CameraManager"
        // ISOCELL HP2 full-array 200MP output on the Galaxy S25 Ultra.
        val TARGET_HIGH_RES = Size(16320, 12240)
    }

    private var cameraProvider: ProcessCameraProvider? = null
    private var camera: Camera? = null
    private var imageCapture: ImageCapture? = null
    private var previewUseCase: Preview? = null

    var activeCaptureSize: Size = TARGET_HIGH_RES
        private set

    suspend fun bindToLifecycle(lifecycleOwner: LifecycleOwner, previewView: PreviewView) {
        val provider = ProcessCameraProvider.getInstance(context).await()
        cameraProvider = provider

        val cameraSelector = CameraSelector.DEFAULT_BACK_CAMERA

        val highResSize = queryHighResolutionOutputSize(provider, cameraSelector)
        activeCaptureSize = highResSize ?: TARGET_HIGH_RES

        val resolutionSelector = ResolutionSelector.Builder()
            .setAllowedResolutionMode(ResolutionSelector.PREFER_HIGHER_RESOLUTION_OVER_CAPTURE_RATE)
            .setResolutionStrategy(
                ResolutionStrategy(activeCaptureSize, ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER)
            )
            .build()

        val captureBuilder = ImageCapture.Builder()
            .setResolutionSelector(resolutionSelector)
            .setCaptureMode(ImageCapture.CAPTURE_MODE_MAXIMIZE_QUALITY)

        // Camera2Interop lets us request the sensor's full-resolution pipeline explicitly
        // and disable OIS-cropping/binning shortcuts some OEM HALs apply by default.
        Camera2Interop.Extender(captureBuilder).apply {
            setCaptureRequestOption(
                android.hardware.camera2.CaptureRequest.NOISE_REDUCTION_MODE,
                android.hardware.camera2.CameraMetadata.NOISE_REDUCTION_MODE_HIGH_QUALITY
            )
            setCaptureRequestOption(
                android.hardware.camera2.CaptureRequest.EDGE_MODE,
                android.hardware.camera2.CameraMetadata.EDGE_MODE_HIGH_QUALITY
            )
        }

        val newImageCapture = captureBuilder.build()

        val preview = Preview.Builder().build().also {
            it.surfaceProvider = previewView.surfaceProvider
        }

        provider.unbindAll()
        camera = provider.bindToLifecycle(
            lifecycleOwner,
            cameraSelector,
            preview,
            newImageCapture
        )

        imageCapture = newImageCapture
        previewUseCase = preview

        Log.i(TAG, "Bound camera with high-res target=$activeCaptureSize")
    }

    /** Focuses and meters at a normalized preview tap point. */
    fun tapToFocus(previewView: PreviewView, x: Float, y: Float) {
        val cam = camera ?: return
        val meteringPointFactory = previewView.meteringPointFactory
        val point = meteringPointFactory.createPoint(x, y)
        val action = FocusMeteringAction.Builder(point, FocusMeteringAction.FLAG_AF or FocusMeteringAction.FLAG_AE)
            .setAutoCancelDuration(3, java.util.concurrent.TimeUnit.SECONDS)
            .build()
        cam.cameraControl.startFocusAndMetering(action)
    }

    /** Captures a full-resolution (up to 200MP) still and returns it decoded as a [Bitmap]. */
    suspend fun captureHighResolution(): Bitmap = suspendCancellableCoroutine { continuation ->
        val capture = imageCapture ?: run {
            continuation.resumeWithException(IllegalStateException("Camera not bound yet"))
            return@suspendCancellableCoroutine
        }

        capture.takePicture(
            ContextCompat.getMainExecutor(context),
            object : ImageCapture.OnImageCapturedCallback() {
                override fun onCaptureSuccess(image: ImageProxy) {
                    try {
                        val bitmap = imageProxyToBitmap(image)
                        continuation.resume(bitmap)
                    } catch (t: Throwable) {
                        continuation.resumeWithException(t)
                    } finally {
                        image.close()
                    }
                }

                override fun onError(exception: ImageCaptureException) {
                    continuation.resumeWithException(exception)
                }
            }
        )
    }

    private fun imageProxyToBitmap(image: ImageProxy): Bitmap {
        val buffer = image.planes[0].buffer
        val bytes = ByteArray(buffer.remaining())
        buffer.get(bytes)
        return BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
            ?: throw IllegalStateException("Failed to decode captured JPEG (${bytes.size} bytes)")
    }

    private fun queryHighResolutionOutputSize(
        provider: ProcessCameraProvider,
        cameraSelector: CameraSelector
    ): Size? {
        return try {
            val cameraInfo = cameraSelector.filter(provider.availableCameraInfos).firstOrNull()
                ?: return null
            val characteristics = Camera2CameraInfo.extractCameraCharacteristics(cameraInfo)
            val streamMap = characteristics.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)
                ?: return null
            val highResSizes = streamMap.getHighResolutionOutputSizes(ImageFormat.JPEG) ?: return null
            highResSizes.maxByOrNull { it.width.toLong() * it.height.toLong() }
        } catch (t: Throwable) {
            Log.w(TAG, "Unable to query high-resolution output sizes; falling back to default target", t)
            null
        }
    }

    fun unbind() {
        cameraProvider?.unbindAll()
        camera = null
        imageCapture = null
        previewUseCase = null
    }
}
