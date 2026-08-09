package com.example.ultraportrait.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

private val AccentCyan = Color(0xFF00E5FF)
private val AccentAmber = Color(0xFFFFC107)

private val DarkColors = darkColorScheme(
    primary = AccentCyan,
    secondary = AccentAmber,
    background = Color(0xFF0B0B0F),
    surface = Color(0xFF16161C),
    onPrimary = Color.Black,
    onBackground = Color.White,
    onSurface = Color.White
)

private val LightColors = lightColorScheme(
    primary = AccentCyan,
    secondary = AccentAmber
)

@Composable
fun UltraPortraitTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit
) {
    val colors = if (darkTheme) DarkColors else LightColors
    MaterialTheme(
        colorScheme = colors,
        content = content
    )
}
