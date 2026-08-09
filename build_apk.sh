#!/usr/bin/env bash
# Builds the UltraPortrait debug APK locally.
#
# Requirements:
#   - JDK 17+
#   - Android SDK (set ANDROID_HOME or ANDROID_SDK_ROOT, or edit local.properties)
#
# Usage:
#   ./build_apk.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [[ -z "${ANDROID_HOME:-}" && -z "${ANDROID_SDK_ROOT:-}" && ! -f local.properties ]]; then
  echo "error: Android SDK not found." >&2
  echo "Set ANDROID_HOME (or ANDROID_SDK_ROOT), or create local.properties with:" >&2
  echo "  sdk.dir=/path/to/Android/sdk" >&2
  exit 1
fi

chmod +x ./gradlew

./gradlew assembleDebug --stacktrace

APK_PATH="app/build/outputs/apk/debug/app-debug.apk"

if [[ -f "$APK_PATH" ]]; then
  echo ""
  echo "Build succeeded: $APK_PATH"
  echo "Install on a connected device with:"
  echo "  adb install -r $APK_PATH"
else
  echo "error: build finished but $APK_PATH was not produced." >&2
  exit 1
fi
