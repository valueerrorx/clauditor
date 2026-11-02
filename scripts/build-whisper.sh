#!/usr/bin/env bash
# Builds portable, statically linked whisper-cli binaries from the whisper.cpp
# sources vendored in nodejs-whisper and stages them into vendor/whisper/.
# electron-builder ships that folder as extraResources, so the packaged app
# needs neither cmake nor a compiler on the user's machine.
#
# Portability: GGML_NATIVE=OFF so CI-specific CPU flags don't leak in. On x86_64
# two variants are built - "avx2" (x86-64-v3, fast, any CPU since ~2013) and
# "generic" (SSE only) - and the app picks one at runtime via /proc/cpuinfo.
# (GGML_BACKEND_DL + CPU_ALL_VARIANTS would be nicer but segfaults in 1.7.5.)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/node_modules/nodejs-whisper/cpp/whisper.cpp"
OUT="$ROOT/vendor/whisper"

[ -f "$SRC/CMakeLists.txt" ] || { echo "whisper.cpp sources not found at $SRC (run npm install)"; exit 1; }

if [ -x "$OUT/generic/whisper-cli" ] && [ "${FORCE:-0}" != "1" ]; then
  echo "vendor/whisper already built (FORCE=1 to rebuild)"
  exit 0
fi

build_variant() {
  local name="$1"; shift
  local build="$ROOT/vendor/whisper-build/$name"
  cmake -S "$SRC" -B "$build" \
    -DCMAKE_BUILD_TYPE=Release \
    -DBUILD_SHARED_LIBS=OFF \
    -DGGML_NATIVE=OFF \
    -DGGML_OPENMP=OFF \
    -DWHISPER_BUILD_TESTS=OFF \
    -DWHISPER_BUILD_SERVER=OFF \
    -DWHISPER_SDL2=OFF \
    -DWHISPER_CURL=OFF \
    -DCMAKE_EXE_LINKER_FLAGS="-static-libstdc++ -static-libgcc" \
    "$@"
  cmake --build "$build" --config Release -j"$(nproc)" --target whisper-cli
  mkdir -p "$OUT/$name"
  cp "$build/bin/whisper-cli" "$OUT/$name/"
  strip "$OUT/$name/whisper-cli" || true
}

rm -rf "$OUT"
if [ "$(uname -m)" = "x86_64" ]; then
  # with NATIVE=OFF ggml enables AVX2/FMA/F16C by default, so switch them off explicitly
  build_variant generic -DGGML_SSE42=ON -DGGML_AVX=OFF -DGGML_AVX2=OFF -DGGML_FMA=OFF -DGGML_F16C=OFF -DGGML_BMI2=OFF
  build_variant avx2 -DGGML_SSE42=ON -DGGML_AVX=ON -DGGML_AVX2=ON -DGGML_FMA=ON -DGGML_F16C=ON -DGGML_BMI2=ON
else
  build_variant generic
fi

echo "--- staged into $OUT"
find "$OUT" -type f -exec ls -la {} \;
for b in "$OUT"/*/whisper-cli; do echo "$b:"; ldd "$b" || true; done
