package com.example.ultraportrait.ui

import android.Manifest
import android.graphics.Bitmap
import android.graphics.PointF
import android.os.Build
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CameraAlt
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Slider
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.example.ultraportrait.ai.DepthEngine
import com.example.ultraportrait.camera.CameraManager
import com.example.ultraportrait.processing.ImageProcessor
import com.example.ultraportrait.ui.theme.UltraPortraitTheme
import com.google.accompanist.permissions.ExperimentalPermissionsApi
import com.google.accompanist.permissions.isGranted
import com.google.accompanist.permissions.rememberPermissionState
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            Toast.makeText(
                this,
                "UltraPortrait's AGSL bokeh pipeline requires Android 13+ (RuntimeShader).",
                Toast.LENGTH_LONG
            ).show()
        }

        setContent {
            UltraPortraitTheme {
                Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                    UltraPortraitScreen()
                }
            }
        }
    }
}

private const val MIN_F_NUMBER = 1.2f
private const val MAX_F_NUMBER = 16f
private const val REFERENCE_RADIUS_FRACTION = 0.022f

private fun apertureToMaxBlurRadiusPx(fNumber: Float, imageWidthPx: Int): Float {
    val radiusFraction = REFERENCE_RADIUS_FRACTION * (MIN_F_NUMBER / fNumber)
    return (radiusFraction * imageWidthPx).coerceIn(0f, imageWidthPx * 0.05f)
}

@OptIn(ExperimentalPermissionsApi::class)
@Composable
fun UltraPortraitScreen() {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val scope = rememberCoroutineScope()

    val cameraPermissionState = rememberPermissionState(Manifest.permission.CAMERA)

    val cameraManager = remember { CameraManager(context) }
    val depthEngine = remember { DepthEngine(context) }
    val imageProcessor = remember { ImageProcessor(context, depthEngine) }
    val previewView = remember { PreviewView(context) }

    var fNumber by remember { mutableFloatStateOf(2.8f) }
    var focusPoint by remember { mutableStateOf(PointF(0.5f, 0.5f)) }
    var isProcessing by remember { mutableStateOf(false) }
    var statusMessage by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) {
        if (!cameraPermissionState.status.isGranted) {
            cameraPermissionState.launchPermissionRequest()
        }
    }

    LaunchedEffect(cameraPermissionState.status.isGranted) {
        if (cameraPermissionState.status.isGranted) {
            runCatching {
                cameraManager.bindToLifecycle(lifecycleOwner, previewView)
            }.onFailure {
                statusMessage = "Failed to start camera: ${it.message}"
            }
            runCatching { depthEngine.initialize() }.onFailure {
                statusMessage = "Depth model unavailable: ${it.message}. Bokeh will be skipped."
            }
        }
    }

    Box(modifier = Modifier.fillMaxSize()) {
        if (cameraPermissionState.status.isGranted) {
            AndroidView(
                factory = { previewView },
                modifier = Modifier
                    .fillMaxSize()
                    .pointerInput(Unit) {
                        detectTapGestures { offset: Offset ->
                            val nx = (offset.x / size.width).coerceIn(0f, 1f)
                            val ny = (offset.y / size.height).coerceIn(0f, 1f)
                            focusPoint = PointF(nx, ny)
                            cameraManager.tapToFocus(previewView, nx, ny)
                        }
                    }
            )
        } else {
            Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text("Camera permission is required to shoot with UltraPortrait.")
                    Button(onClick = { cameraPermissionState.launchPermissionRequest() }) {
                        Text("Grant camera access")
                    }
                }
            }
        }

        FocusReticle(focusPoint)

        Column(
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .fillMaxWidth()
                .background(Color.Black.copy(alpha = 0.55f))
                .padding(20.dp),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            statusMessage?.let {
                Text(it, color = Color.White, modifier = Modifier.padding(bottom = 8.dp))
            }

            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text("f/${"%.1f".format(fNumber)}", color = Color.White)
                Slider(
                    value = fNumber,
                    onValueChange = { fNumber = it },
                    valueRange = MIN_F_NUMBER..MAX_F_NUMBER,
                    modifier = Modifier
                        .weight(1f)
                        .padding(horizontal = 12.dp)
                )
            }

            Button(
                enabled = cameraPermissionState.status.isGranted && !isProcessing,
                onClick = {
                    scope.launch {
                        isProcessing = true
                        statusMessage = null
                        try {
                            val captured: Bitmap = cameraManager.captureHighResolution()
                            val maxBlurRadiusPx = apertureToMaxBlurRadiusPx(fNumber, captured.width)

                            val finalBitmap = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                                imageProcessor.renderBokeh(captured, focusPoint, maxBlurRadiusPx)
                            } else {
                                captured
                            }

                            val uri = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                                imageProcessor.saveToGallery(finalBitmap)
                            } else {
                                null
                            }

                            statusMessage = if (uri != null) {
                                "Saved ${finalBitmap.width}x${finalBitmap.height} to Gallery"
                            } else {
                                "Capture complete"
                            }
                        } catch (t: Throwable) {
                            statusMessage = "Capture failed: ${t.message}"
                        } finally {
                            isProcessing = false
                        }
                    }
                },
                modifier = Modifier
                    .padding(top = 16.dp)
                    .size(76.dp),
                shape = CircleShape,
                contentPadding = PaddingValues(0.dp)
            ) {
                if (isProcessing) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(28.dp),
                        color = MaterialTheme.colorScheme.onPrimary,
                        strokeWidth = 3.dp
                    )
                } else {
                    Icon(Icons.Filled.CameraAlt, contentDescription = "Capture 200MP portrait")
                }
            }
        }

        if (isProcessing) {
            Box(
                modifier = Modifier
                    .align(Alignment.TopCenter)
                    .padding(top = 24.dp)
                    .background(Color.Black.copy(alpha = 0.6f), shape = CircleShape)
                    .padding(horizontal = 16.dp, vertical = 8.dp)
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(16.dp),
                        color = Color.White,
                        strokeWidth = 2.dp
                    )
                    Text(
                        "Rendering neural depth + bokeh…",
                        color = Color.White,
                        modifier = Modifier.padding(start = 8.dp)
                    )
                }
            }
        }
    }
}

@Composable
private fun FocusReticle(focusPoint: PointF) {
    BoxWithConstraints(modifier = Modifier.fillMaxSize()) {
        val reticleSize = 56.dp
        val xOffset = (maxWidth * focusPoint.x) - (reticleSize / 2)
        val yOffset = (maxHeight * focusPoint.y) - (reticleSize / 2)

        Box(
            modifier = Modifier
                .offset(x = xOffset, y = yOffset)
                .size(reticleSize)
                .border(2.dp, Color.White.copy(alpha = 0.85f), CircleShape)
        )
    }
}
